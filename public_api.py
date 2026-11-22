"""Public, read-only Polymarket snapshots for clients without JavaScript."""
import re
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from math import isfinite
from threading import Lock
from time import monotonic
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode

SOURCE = "Polymarket Data API v2"
CACHE_TTL = 45
CACHE_LIMIT = 128
WALLET = re.compile(r"0x[0-9a-fA-F]{40}")
POSITION_FIELDS = {
    "market": "title", "outcome": "outcome", "condition_id": "condition_id", "token_id": "token_id",
    "status": "status",
    "shares": "current_size", "avg_price": "avg_price", "current_price": "current_price",
    "cost_basis_usd": "entry_cost_usdc", "current_value_usd": "current_value",
    "unrealized_pnl_usd": "unrealized_pnl", "unrealized_pnl_pct": "percent_pnl",
    "realized_pnl_usd": "realized_pnl", "market_slug": "slug",
    "event_slug": "event_slug",
}
TRADE_FIELDS = {
    "market": "title", "outcome": "outcome", "condition_id": "condition_id", "token_id": "token_id",
    "side": "side", "price": "price", "shares": "size", "timestamp": "timestamp",
    "transaction_hash": "transaction_hash", "market_slug": "slug",
}
MONEY_TOTALS = ("cost_basis_usd", "current_value_usd", "unrealized_pnl_usd")
cache = OrderedDict()
cache_lock = Lock()


def utc(stamp):
    return stamp.isoformat(timespec="seconds").replace("+00:00", "Z")


def finite(value):
    return type(value) in (int, float) and isfinite(value)


def total(rows, key):
    values = [row[key] for row in rows]
    return round(sum(values), 6) if all(finite(value) for value in values) else None


def select(row, fields):
    return {key: row.get(source) for key, source in fields.items()}


def position_data(fetch_positions, wallet):
    positions = [select(row, POSITION_FIELDS) for row in fetch_positions(wallet)
                 if row.get("status") in ("OPEN", "MERGEABLE")]
    return {"count": len(positions), "totals": {key: total(positions, key) for key in MONEY_TOTALS},
            "positions": positions}


def trades_data(data_page, wallet, limit, cursor):
    params = {"user": wallet, "limit": limit, "start": 1}
    if cursor:
        params["cursor"] = cursor
    rows, next_cursor = data_page("trades", params)
    trades = [select(row, TRADE_FIELDS) for row in rows]
    for trade in trades:
        stamp = trade["timestamp"]
        trade["time_utc"] = utc(datetime.fromtimestamp(stamp, timezone.utc)) if finite(stamp) else None
        trade["gross_amount_usd"] = round(trade["price"] * trade["shares"], 6) if (
            finite(trade["price"]) and finite(trade["shares"])) else None
    return trades, next_cursor


def market_exposure(positions, current_value, by_event=False):
    groups = {}
    for row in positions:
        key = (row.get("event_slug") if by_event else None) or row["condition_id"] or row["market"] or row["token_id"]
        groups.setdefault(key, []).append(row)
    exposure = []
    for rows in groups.values():
        value = total(rows, "current_value_usd")
        identity = ({"event": rows[0].get("event_slug"), "market": rows[0]["market"],
                     "market_count": len({row["condition_id"] or row["token_id"] for row in rows})} if by_event
                    else {"market": rows[0]["market"], "condition_id": rows[0]["condition_id"]})
        exposure.append({**identity,
                         "position_count": len(rows), "current_value_usd": value,
                         "cost_basis_usd": total(rows, "cost_basis_usd"),
                         "share_of_open_value_pct": round(100 * value / current_value, 2)
                         if finite(value) and current_value and current_value > 0 else None})
    return sorted(exposure, key=lambda row: row["current_value_usd"] or 0, reverse=True)


def snapshot(path, wallet, limit, cursor, fetch_positions, data_page):
    key = (path, wallet, limit, cursor)
    now = monotonic()
    with cache_lock:
        cached = cache.get(key)
        if cached and cached[0] > now:
            cache.move_to_end(key)
            return cached[1], True

    if path == "/positions":
        payload = position_data(fetch_positions, wallet)
    elif path == "/trades":
        trades, next_cursor = trades_data(data_page, wallet, limit, cursor)
        payload = {"count": len(trades), "trades": trades, "next_cursor": next_cursor}
    else:
        with ThreadPoolExecutor(max_workers=2) as pool:
            positions = pool.submit(position_data, fetch_positions, wallet)
            recent = pool.submit(trades_data, data_page, wallet, 15, "")
            payload = positions.result()
            try:
                payload["recent_trades"] = recent.result()[0]
                payload["recent_trades_available"] = True
            except (URLError, TimeoutError, ValueError, TypeError, KeyError, OverflowError, AttributeError):
                payload["recent_trades"] = []
                payload["recent_trades_available"] = False
        payload["exposure_by_market"] = market_exposure(payload["positions"], payload["totals"]["current_value_usd"])
        payload["exposure_by_event"] = market_exposure(payload["positions"], payload["totals"]["current_value_usd"],
                                                      by_event=True)

    result = {"wallet": wallet, "source": SOURCE, "as_of_utc": utc(datetime.now(timezone.utc)), **payload}
    with cache_lock:
        cache[key] = monotonic() + CACHE_TTL, result
        cache.move_to_end(key)
        while len(cache) > CACHE_LIMIT:
            cache.popitem(last=False)
    return result, False


def money(value):
    return f"{'-' if value < 0 else ''}${abs(value):,.2f}" if finite(value) else "unavailable"


def price(value):
    return f"{100 * value:.4g} cents" if finite(value) else "unavailable"


def percent(value):
    return f"{value:.2f}%" if finite(value) else "unavailable"


def count(value):
    return f"{value:,.4f}".rstrip("0").rstrip(".") if finite(value) else "unavailable"


def position_line(row):
    return (f"- {row['market'] or 'Unknown market'} [{row['outcome'] or 'unknown outcome'}]\n"
            f"  Shares {count(row['shares'])} | Avg {price(row['avg_price'])} | Current {price(row['current_price'])}\n"
            f"  Cost {money(row['cost_basis_usd'])} | Value {money(row['current_value_usd'])} | "
            f"Unrealized P&L {money(row['unrealized_pnl_usd'])} ({percent(row['unrealized_pnl_pct'])})")


def trade_line(row):
    return (f"- {row['time_utc'] or 'Unknown time'} | {row['side'] or 'Trade'} | {row['market'] or 'Unknown market'} "
            f"[{row['outcome'] or 'unknown outcome'}] | {count(row['shares'])} shares at {price(row['price'])} | "
            f"Gross {money(row['gross_amount_usd'])}")


def as_text(path, data):
    headings = {"/positions": "Open positions", "/trades": "Trade history", "/portfolio": "Portfolio summary"}
    lines = [headings[path], f"Wallet: {data['wallet']}", f"Source: {data['source']}", f"As of: {data['as_of_utc']}", ""]
    if "positions" in data:
        totals = data["totals"]
        lines.extend([f"Open positions: {data['count']}", f"Cost basis: {money(totals['cost_basis_usd'])}",
                      f"Current value: {money(totals['current_value_usd'])}",
                      f"Unrealized P&L: {money(totals['unrealized_pnl_usd'])}", ""])
        lines.extend(position_line(row) for row in data["positions"])
    if "exposure_by_market" in data:
        lines.extend(["", "Exposure by market (as a share of open value)"])
        lines.extend(f"- {row['market'] or 'Unknown market'} | Value {money(row['current_value_usd'])} | "
                     f"{percent(row['share_of_open_value_pct'])}" for row in data["exposure_by_market"])
        lines.extend(["", "Exposure by event (as a share of open value)"])
        lines.extend(f"- {row['event'] or row['market'] or 'Unknown event'} | {row['market_count']} market(s) | "
                     f"Value {money(row['current_value_usd'])} | {percent(row['share_of_open_value_pct'])}"
                     for row in data["exposure_by_event"])
        recent = len(data["recent_trades"]) if data["recent_trades_available"] else "temporarily unavailable"
        lines.extend(["", f"Recent trades: {recent}"])
        lines.extend(trade_line(row) for row in data["recent_trades"])
    if "trades" in data:
        lines.append(f"Trades on this page: {data['count']}")
        lines.extend(trade_line(row) for row in data["trades"])
        lines.extend(["", f"Next page: {data['next'] or 'none'}"])
    return "\n".join(lines).rstrip() + "\n"


def serve(handler, path, query, fetch_positions, data_page, prefix=""):
    def first(name, default=""):
        return query.get(name, [default])[0]

    output_format = first("format", "json")

    def fail(status, message):
        if output_format == "text":
            handler.respond(status, f"Error: {message}\n".encode(), "text/plain")
        else:
            handler.send_json(status, {"error": message})

    if output_format not in ("json", "text"):
        return fail(400, "Use format=json or format=text.")
    if path == "/trades" and "offset" in query:
        return fail(400, "Use the next page cursor instead of offset.")
    user = first("user").lower()
    if not WALLET.fullmatch(user):
        return fail(400, "Provide a public wallet address with ?user=0x followed by 40 hex digits.")
    cursor = first("cursor") if path == "/trades" else ""
    raw_limit = first("limit", "250") if path == "/trades" else "250"
    if not re.fullmatch(r"[0-9]{1,4}", raw_limit) or not 1 <= int(raw_limit) <= 1000:
        return fail(400, "Trade page limit must be between 1 and 1000.")
    if len(cursor) > 2048:
        return fail(400, "Invalid trade cursor. Use the cursor from the preceding page.")
    limit = int(raw_limit)
    try:
        data, hit = snapshot(path, user, limit, cursor, fetch_positions, data_page)
    except HTTPError as error:
        if error.code == 400:
            return fail(400, "Polymarket rejected the wallet address or cursor.")
        return fail(503 if error.code == 429 or error.code >= 500 else 502, "Polymarket is unavailable. Try again shortly.")
    except (URLError, TimeoutError):
        return fail(503, "Polymarket is unreachable. Try again shortly.")
    except (ValueError, TypeError, KeyError, OverflowError, AttributeError):
        return fail(502, "Polymarket returned an unreadable response.")

    if path == "/trades":
        next_cursor = data["next_cursor"]
        data = dict(data, next=prefix + "/trades?" + urlencode({"user": user, "cursor": next_cursor,
                                                      "limit": limit, "format": output_format}) if next_cursor else None)
    headers = {"Cache-Control": "public, max-age=30", "X-Cache": "HIT" if hit else "MISS"}
    if output_format == "text":
        handler.respond(200, as_text(path, data).encode(), "text/plain", headers=headers)
    else:
        handler.send_json(200, data, headers=headers)
