"""Serve a local, read-only dashboard backed by the public Polymarket Data API."""
import argparse
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from math import isfinite
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
DATA_API = "https://data-api.polymarket.com/v2"
WALLET = re.compile(r"0x[0-9a-fA-F]{40}")
CONDITION = re.compile(r"0x[0-9a-fA-F]{64}")
TOKEN = re.compile(r"[0-9]{1,78}")
FILES = {
    "/": ("index.html", "text/html"),
    "/robots.txt": ("robots.txt", "text/plain"),
    "/trades": ("trades.html", "text/html"),
    "/precedents": ("precedents.html", "text/html"),
    "/markets": ("markets.html", "text/html"),
    "/style.css": ("style.css", "text/css"),
    "/markets.css": ("markets.css", "text/css"),
    "/watchlist.css": ("watchlist.css", "text/css"),
    "/combo.svg": ("combo.svg", "image/svg+xml"),
    "/favicon.svg": ("favicon.svg", "image/svg+xml"),
    "/app.js": ("app.js", "text/javascript"),
    "/trades.js": ("trades.js", "text/javascript"),
    "/precedents.js": ("precedents.js", "text/javascript"),
    "/markets.js": ("markets.js", "text/javascript"),
    "/watchlist.js": ("watchlist.js", "text/javascript"),
    "/watchlist-sw.js": ("watchlist-sw.js", "text/javascript"),
    "/risk-check.js": ("risk-check.js", "text/javascript"),
    "/charts.js": ("charts.js", "text/javascript"),
    "/dashboard-widgets.js": ("dashboard-widgets.js", "text/javascript"),
    "/dashboard-settings.js": ("dashboard-settings.js", "text/javascript"),
}
TRADE_FIELDS = ("title", "icon", "side", "outcome", "price", "size", "timestamp",
                "token_id", "condition_id", "slug", "transaction_hash")
ACTIVITY_FIELDS = ("type", "side", "size", "price", "timestamp", "usdc_size", "transaction_hash")


def data_request(resource, params, timeout=10):
    request = Request(f"{DATA_API}/{resource}?{urlencode(params)}", headers={
        "Accept": "application/json",
        "User-Agent": "PolymarketLocalDashboard/1.0",
    })
    with urlopen(request, timeout=timeout) as response:
        return json.load(response)


def data_page(resource, params, timeout=10):
    page = data_request(resource, params, timeout)
    rows = page["data"]
    if rows is None:
        rows = []
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise ValueError("Unexpected Data API response")
    cursor = page["pagination"]["next_cursor"]
    if cursor is not None and (not isinstance(cursor, str) or not cursor):
        raise ValueError("Invalid pagination cursor")
    return rows, cursor


def data_pages(resource, params, timeout=10):
    params = params.copy()
    seen_cursors = set()
    while True:
        rows, cursor = data_page(resource, params, timeout)
        yield rows, cursor is None
        if cursor is None:
            return
        if cursor in seen_cursors:
            raise ValueError("Invalid pagination cursor")
        seen_cursors.add(cursor)
        params["cursor"] = cursor


def fetch_positions(wallet):
    params = {"user": wallet.lower(), "status": "OPEN", "limit": 100}
    return [row for rows, _ in data_pages("positions", params) for row in rows]


def fetch_trades(wallet, cursor):
    params = {"user": wallet.lower(), "limit": 100, "start": 1}
    if cursor:
        params["cursor"] = cursor
    rows, next_cursor = data_page("trades", params)
    return {"trades": [{key: row.get(key) for key in TRADE_FIELDS} for row in rows],
            "next_cursor": next_cursor}


def chart_points(rows, key):
    by_time = {}
    for row in rows:
        stamp, value = row.get("timestamp"), row.get(key)
        if type(stamp) is int and stamp > 0 and type(value) in (int, float) and isfinite(value):
            by_time[stamp] = value
    return sorted(by_time.items())


def fetch_wallet_pnl(wallet, timeout=10):
    params = {"user": wallet.lower(), "interval": "max", "fidelity": "1d"}
    result = data_request("user-pnl", params, timeout)["data"]
    return result["points"] if result else []


def fetch_portfolio_history(wallet):
    return {"points": chart_points(fetch_wallet_pnl(wallet), "position_pnl")}


def wallet_rows(wallet, resource, **filters):
    return [row for rows, _ in data_pages(resource, {"user": wallet.lower(), "limit": 100, **filters})
            for row in rows]


def fetch_portfolio_events(wallet):
    from trade_summary import number, portfolio_settlements

    with ThreadPoolExecutor(max_workers=6) as executor:
        activity = executor.submit(wallet_rows, wallet, "activity", start=1, type="REDEEM,DEPOSIT")
        held = [executor.submit(wallet_rows, wallet, "positions", status=status,
                                include_archived="true", filter_amount=0)
                for status in ("REDEEMABLE", "REDEEMABLE_LOST")]
        combos = [executor.submit(wallet_rows, wallet, "positions/combos", status=status)
                  for status in ("REDEEMABLE", "RESOLVED_WIN", "RESOLVED_LOSS")]
        rows = activity.result()
        redeemed = [row for row in rows if row.get("type") == "REDEEM"]
        deposits = [{"timestamp": stamp, "amount": amount} for row in rows
                    if row.get("type") == "DEPOSIT" and type(stamp := row.get("timestamp")) is int and stamp > 0
                    and (amount := number(row.get("usdc_size"))) is not None and amount > 0]
        positions = [row for job in held for row in job.result()]
        combo_positions = [row for job in combos for row in job.result()]
        conditions = sorted({condition for row in [*positions, *redeemed]
                             if isinstance(condition := row.get("condition_id"), str) and CONDITION.fullmatch(condition)})

        def resolve(start):
            return data_request("resolutions", {"condition": ",".join(conditions[start:start + 20])})["data"] or []

        resolutions = {row["condition_id"]: row for rows in executor.map(resolve, range(0, len(conditions), 20))
                       for row in rows}
    return {"settlements": portfolio_settlements(positions, combo_positions, redeemed, resolutions),
            "deposits": deposits}


def latest_trading_fees(points):
    latest = max(points, key=lambda point: point["timestamp"], default=None)
    if latest is None:
        return None

    def amount(field):
        value = latest.get(field)
        return value if type(value) in (int, float) and isfinite(value) else None

    fees = amount("fees")
    refunds = amount("fees_refunded")
    paid = amount("fees_paid")
    charged = -fees if fees is not None else None
    net = -paid if paid is not None else None
    if net is None and charged is not None and refunds is not None:
        net = round(charged - refunds, 6)
    return {"charged_usd": charged, "refunded_usd": refunds,
            "net_paid_usd": net, "timestamp": latest["timestamp"]}


def fetch_market_history(token, condition=None, wallet=None):
    def prices():
        rows = [row for page, _ in data_pages("prices-history", {"token_id": token, "interval": "max"})
                for row in page]
        return chart_points(rows, "price")

    def resolution():
        return any(row.get("status", "").lower() == "resolved"
                   for row in data_request("resolutions", {"condition": condition})["data"])

    def executions():
        params = {"user": wallet.lower(), "condition": condition, "start": 1,
                  "type": "TRADE,REDEEM", "limit": 100}
        return [{key: row.get(key) for key in ACTIVITY_FIELDS}
                for page, _ in data_pages("activity", params) for row in page if row.get("token_id") == token]

    def optional(job):
        try:
            return job.result() if job else None
        except (URLError, TimeoutError, ValueError, TypeError, KeyError, AttributeError):
            return None

    with ThreadPoolExecutor(max_workers=3) as executor:
        history = executor.submit(prices)
        settled = executor.submit(resolution) if condition else None
        activity = executor.submit(executions) if condition and wallet else None
        raw_points = optional(history)
        return {"points": raw_points or [], "price_error": raw_points is None,
                "settled": optional(settled) is True, "executions": optional(activity)}


def fetch_trade_summary(wallet):
    from trade_summary import build_trade_summary

    position_statuses = ("REDEEMABLE", "REDEEMABLE_LOST", "OPEN", "CLOSED")
    combo_statuses = ("REDEEMABLE", "OPEN", "RESOLVED_WIN", "RESOLVED_LOSS")

    def fetch(resource, **filters):
        return wallet_rows(wallet, resource, **filters)

    def fetch_status(status):
        if status == "CLOSED":
            return fetch("positions", status=status)
        return fetch("positions", status=status, include_archived="true", filter_amount=0)

    with ThreadPoolExecutor(max_workers=6) as executor:
        activity = executor.submit(fetch, "activity", start=1)
        pnl = executor.submit(fetch_wallet_pnl, wallet, 4)
        positions = [executor.submit(fetch_status, status) for status in position_statuses]
        combos = [executor.submit(fetch, "positions/combos", status=status) for status in combo_statuses]
        summary = build_trade_summary(
            [row for job in positions for row in job.result()],
            [row for job in combos for row in job.result()],
            activity.result(),
        )
        try:
            fees = latest_trading_fees(pnl.result())
        except (URLError, TimeoutError, ValueError, TypeError, KeyError, AttributeError):
            fees = None
        return {"positions": summary, "trading_fees": fees}


class Dashboard(BaseHTTPRequestHandler):
    watchlist = None

    def respond(self, status, body, mime="application/json", headers=None):
        self.send_response(status)
        self.send_header("Content-Type", f"{mime}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for name, value in {"Cache-Control": "no-store", **(headers or {})}.items():
            self.send_header(name, value)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; img-src 'self' https:; "
                         "base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, status, data, headers=None):
        self.respond(status, json.dumps(data).encode(), headers=headers)

    def do_GET(self):
        url = urlsplit(self.path)
        query = parse_qs(url.query, keep_blank_values=True)
        if url.path == "/api/watchlist":
            from watchlist import serve

            serve(self, self.watchlist)
            return
        if url.path in ("/positions", "/portfolio") or (
            url.path == "/trades" and any(key in query for key in ("user", "format", "limit", "cursor"))
        ):
            from public_api import serve

            serve(self, url.path, query, fetch_positions, data_page)
            return
        if url.path == "/precedents":
            from market_discovery import SLUG

            if not SLUG.fullmatch(query.get("market", [""])[0]):
                term = query.get("q", [""])[0].strip()
                event = query.get("event", [""])[0]
                if SLUG.fullmatch(event):
                    term = "https://polymarket.com/event/" + event
                destination = "/markets" + ("?" + urlencode({"q": term}) if 3 <= len(term) <= 700 else "")
                self.respond(302, b"", "text/plain", {"Location": destination})
                return
        if url.path in FILES:
            filename, mime = FILES[url.path]
            self.respond(200, (ROOT / filename).read_bytes(), mime)
            return
        if url.path == "/api/market-metadata":
            from precedents import SLUG, discovery_market_details

            slugs = list(dict.fromkeys(query.get("market", [])))
            if not 1 <= len(slugs) <= 8 or any(not SLUG.fullmatch(slug) for slug in slugs):
                self.send_json(400, {"error": "Select up to eight Polymarket markets."})
                return
            self.send_json(200, {"markets": discovery_market_details(slugs)})
            return
        precedents = url.path == "/api/precedents"
        catalog = url.path == "/api/markets"
        if not (precedents or catalog) and url.path not in ("/api/positions", "/api/trades", "/api/trade-summary",
                            "/api/market-history", "/api/portfolio-history", "/api/portfolio-events"):
            self.send_json(404, {"error": "Page not found."})
            return
        wallet = query.get("wallet", [""])[0]
        market_history = url.path == "/api/market-history"
        if (wallet or not (market_history or precedents or catalog)) and not WALLET.fullmatch(wallet):
            self.send_json(400, {"error": "Enter a valid public wallet address."})
            return
        cursor = query.get("cursor", [""])[0]
        if len(cursor) > 2048:
            self.send_json(400, {"error": "Invalid history cursor."})
            return
        token = query.get("token", [""])[0]
        condition = query.get("condition", [""])[0]
        if market_history and (not TOKEN.fullmatch(token) or (condition and not CONDITION.fullmatch(condition))):
            self.send_json(400, {"error": "Invalid market identifier."})
            return
        try:
            if catalog:
                from market_catalog import CatalogError, browse_markets

                try:
                    data = browse_markets(query)
                except CatalogError as error:
                    self.send_json(400, {"error": str(error)})
                    return
            elif precedents:
                from precedents import SLUG, compare_markets

                slug = query.get("market", [""])[0]
                scope = query.get("scope", ["focused"])[0]
                if not SLUG.fullmatch(slug) or scope not in ("focused", "broad"):
                    self.send_json(400, {"error": "Select a market and a valid comparison scope."})
                    return
                data = compare_markets(slug, scope, wallet, data_request, data_pages)
                if data is None:
                    self.send_json(404, {"error": "Select a Polymarket market with a Yes/No outcome."})
                    return
            elif url.path == "/api/trades":
                data = fetch_trades(wallet, cursor)
            elif url.path == "/api/trade-summary":
                data = fetch_trade_summary(wallet)
            elif url.path == "/api/portfolio-history":
                data = fetch_portfolio_history(wallet)
            elif url.path == "/api/portfolio-events":
                data = fetch_portfolio_events(wallet)
            elif market_history:
                data = fetch_market_history(token, condition, wallet)
            else:
                data = {"positions": fetch_positions(wallet)}
        except HTTPError as error:
            self.send_json(502, {"error": f"The Polymarket API returned an error ({error.code})."})
        except (URLError, TimeoutError):
            self.send_json(502, {"error": "Polymarket is unreachable. Try refreshing in a moment."})
        except (ValueError, TypeError, KeyError, AttributeError):
            self.send_json(502, {"error": "Polymarket returned an unreadable response."})
        else:
            self.send_json(200, data)

    do_HEAD = do_GET

    def do_POST(self):
        if urlsplit(self.path).path != "/api/watchlist":
            self.send_json(404, {"error": "Page not found."})
            return
        from watchlist import serve

        serve(self, self.watchlist, write=True)

    def log_request(self, code="-", size="-"):
        # Avoid writing queried wallet addresses to the terminal log.
        pass


if __name__ == "__main__":
    from watchlist import Watchlist, database_dir

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", args.port), Dashboard) as server:
        Dashboard.watchlist = Watchlist(database_dir())
        Dashboard.watchlist.enable_push(os.environ.get("POLYMARKET_PUSH_CONTACT"))
        Dashboard.watchlist.start()
        print(f"Polymarket dashboard · http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
