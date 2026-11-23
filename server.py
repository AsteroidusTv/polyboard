"""Serve a local, read-only dashboard backed by the public Polymarket Data API."""
import argparse
import json
import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from hashlib import blake2s
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from math import isfinite
from pathlib import Path
from time import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit

from http_reads import data_request
from read_cache import ReadCache

ROOT = Path(__file__).resolve().parent
WALLET = re.compile(r"0x[0-9a-fA-F]{40}")
CONDITION = re.compile(r"0x[0-9a-fA-F]{64}")
TOKEN = re.compile(r"[0-9]{1,78}")
FILES = {
    "/": ("index.html", "text/html"),
    "/robots.txt": ("robots.txt", "text/plain"),
    "/trades": ("trades.html", "text/html"),
    "/precedents": ("precedents.html", "text/html"),
    "/holders": ("holders.html", "text/html"),
    "/markets": ("markets.html", "text/html"),
    "/style.css": ("style.css", "text/css"),
    "/markets.css": ("markets.css", "text/css"),
    "/watchlist.css": ("watchlist.css", "text/css"),
    "/combo.svg": ("combo.svg", "image/svg+xml"),
    "/favicon.svg": ("favicon.svg", "image/svg+xml"),
    "/app.js": ("app.js", "text/javascript"),
    "/trades.js": ("trades.js", "text/javascript"),
    "/precedents.js": ("precedents.js", "text/javascript"),
    "/holders.js": ("holders.js", "text/javascript"),
    "/holders.css": ("holders.css", "text/css"),
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
STATIC_LINK = re.compile(rb'((?:src|href)=")(/[a-z0-9.-]+\.(?:css|js|svg))"')
CATALOG_FILTERS = ("q", "category", "exclude", "sort", "side", "band", "ends", "after", "before",
                   "liquidity", "spread", "cursor", "event", "preview")
RESPONSES = ReadCache(256)
WALLET_PNL = ReadCache(128)
POSITION_SETTLEMENTS = ReadCache(192)
MARKET_PRICES = ReadCache(128)
MARKET_RESOLUTIONS = ReadCache(512)
ORDINARY_SETTLEMENTS = ("REDEEMABLE", "REDEEMABLE_LOST")
COMBO_SETTLEMENTS = ("REDEEMABLE", "RESOLVED_WIN", "RESOLVED_LOSS")


@lru_cache(maxsize=96)
def file_snapshot(filename, stamp, size):
    content = (ROOT / filename).read_bytes()
    return content, fingerprint(content)


def fingerprint(content):
    return blake2s(content, digest_size=16).hexdigest()


def static_file(filename):
    info = (ROOT / filename).stat()
    return file_snapshot(filename, info.st_mtime_ns, info.st_size)


def version_links(content):
    def link(match):
        path = match[2].decode()
        if path not in FILES or path == "/watchlist-sw.js":
            return match[0]
        _, version = static_file(FILES[path][0])
        return match[1] + match[2] + b"?v=" + version.encode() + b'"'

    return STATIC_LINK.sub(link, content)


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
    params = {"user": wallet.lower(), "limit": 500, "start": 1}
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


def cached_wallet_pnl(wallet, timeout=10, refresh=False):
    params = {"user": wallet.lower(), "interval": "max", "fidelity": "1d"}

    def load():
        result = data_request("user-pnl", params, timeout)["data"]
        return result["points"] if result else []

    return WALLET_PNL.read(params["user"], load, ttl=30, refresh=refresh)


def fetch_wallet_pnl(wallet, timeout=10, refresh=False):
    return cached_wallet_pnl(wallet, timeout, refresh)[0]


def wallet_rows(wallet, resource, **filters):
    return [row for rows, _ in data_pages(resource, {"user": wallet.lower(), "limit": 100, **filters})
            for row in rows]


def wallet_settlements(wallet, resource, status, refresh):
    filters = {} if resource == "positions/combos" else {"include_archived": "true", "filter_amount": 0}

    def load():
        return wallet_rows(wallet, resource, status=status, **filters)

    return POSITION_SETTLEMENTS.read((wallet, resource, status), load, ttl=20, refresh=refresh)[0]


def fetch_portfolio_events(wallet, refresh=False):
    from trade_summary import number, portfolio_settlements

    with ThreadPoolExecutor(max_workers=6) as executor:
        activity = executor.submit(wallet_rows, wallet, "activity", start=1, type="REDEEM,DEPOSIT")
        held = [executor.submit(wallet_settlements, wallet, "positions", status, refresh)
                for status in ORDINARY_SETTLEMENTS]
        combos = [executor.submit(wallet_settlements, wallet, "positions/combos", status, refresh)
                  for status in COMBO_SETTLEMENTS]
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


def market_price_series(token):
    rows = (row for page, _ in data_pages("prices-history", {"token_id": token, "interval": "max"})
            for row in page)
    return chart_points(rows, "price")


def fetch_market_history(token, condition=None, wallet=None):
    def resolutions():
        def load():
            return any(row.get("status", "").lower() == "resolved"
                       for row in data_request("resolutions", {"condition": condition})["data"])

        return MARKET_RESOLUTIONS.read(condition, load, ttl=3600, cache_if=bool)[0]

    def prices():
        return MARKET_PRICES.read(token, lambda: market_price_series(token), ttl=30)[0]

    def executions():
        params = {"user": wallet.lower(), "condition": condition, "start": 1,
                  "type": "TRADE,REDEEM", "limit": 100}
        return [{key: row.get(key) for key in ACTIVITY_FIELDS}
                for page, _ in data_pages("activity", params) for row in page if row.get("token_id") == token]

    def optional(load):
        try:
            return load() if load else None
        except (URLError, TimeoutError, ValueError, TypeError, KeyError, AttributeError):
            return None

    if not condition:
        raw_points = optional(prices)
        return {"points": raw_points or [], "price_error": raw_points is None, "settled": False, "executions": None}

    with ThreadPoolExecutor(max_workers=3) as executor:
        history = executor.submit(prices)
        settled = executor.submit(resolutions)
        activity = executor.submit(executions) if wallet else None
        raw_points = optional(history.result)
        return {"points": raw_points or [], "price_error": raw_points is None,
                "settled": optional(settled.result) is True, "executions": optional(activity.result if activity else None)}


def fetch_trade_summary(wallet, refresh=False):
    from trade_summary import build_trade_summary

    position_statuses = (*ORDINARY_SETTLEMENTS, "OPEN", "CLOSED")
    combo_statuses = ("REDEEMABLE", "OPEN", "RESOLVED_WIN", "RESOLVED_LOSS")

    def fetch(resource, **filters):
        try:
            status = filters.get("status")
            if (resource == "positions" and status in ORDINARY_SETTLEMENTS or
                    resource == "positions/combos" and status in COMBO_SETTLEMENTS):
                return wallet_settlements(wallet, resource, status, refresh)
            return wallet_rows(wallet, resource, **filters)
        except (URLError, TimeoutError, ValueError, TypeError, KeyError, AttributeError):
            logging.warning("Trade summary source unavailable: %s %s", resource, filters.get("status") or "")
            return None

    def fetch_status(status):
        if status == "CLOSED":
            return fetch("positions", status=status)
        return fetch("positions", status=status, include_archived="true", filter_amount=0)

    with ThreadPoolExecutor(max_workers=6) as executor:
        activity = executor.submit(fetch, "activity", start=1)
        pnl = executor.submit(fetch_wallet_pnl, wallet, 4, refresh=refresh)
        positions = [executor.submit(fetch_status, status) for status in position_statuses]
        combos = [executor.submit(fetch, "positions/combos", status=status) for status in combo_statuses]
        position_groups = [job.result() for job in positions]
        combo_groups = [job.result() for job in combos]
        activity_rows = activity.result()
        sources = [*position_groups, *combo_groups, activity_rows]
        if all(group is None for group in sources):
            raise URLError("Trade history sources unavailable")
        summary = build_trade_summary([row for group in position_groups for row in group or []],
                                      [row for group in combo_groups for row in group or []], activity_rows or [])
        try:
            fees = latest_trading_fees(pnl.result())
        except (URLError, TimeoutError, ValueError, TypeError, KeyError, AttributeError):
            fees = None
        return {"positions": summary, "trading_fees": fees, "partial": any(group is None for group in sources)}


def complete_response(data):
    return not data.get("partial") and not data.get("price_error")


class Dashboard(BaseHTTPRequestHandler):
    watchlist = None

    def respond(self, status, body, mime="application/json", headers=None):
        self.send_response(status)
        self.send_header("Content-Type", f"{mime}; charset=utf-8")
        if status != 304:
            self.send_header("Content-Length", str(len(body)))
        for name, value in {"Cache-Control": "no-store", **(headers or {})}.items():
            self.send_header(name, value)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; img-src 'self' https:; "
                         "base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        self.end_headers()
        if self.command != "HEAD" and status != 304:
            self.wfile.write(body)

    def send_json(self, status, data, headers=None):
        self.respond(status, json.dumps(data, separators=(",", ":")).encode(), headers=headers)

    def send_cached_json(self, key, load, *, ttl, refresh=False, cache_if=complete_response):
        data, cache = RESPONSES.read(key, load, ttl=ttl, refresh=refresh, cache_if=cache_if)
        self.send_json(200, data, {"X-Polyboard-Cache": cache})

    def do_GET(self):
        url = urlsplit(self.path)
        query = parse_qs(url.query, keep_blank_values=True)
        if url.path == "/api/watchlist":
            from watchlist import serve

            serve(self, self.watchlist)
            return
        if url.path == "/api/holders":
            from holders import serve

            serve(self, query)
            return
        public_path = url.path.removeprefix("/api/public") if url.path.startswith("/api/public/") else ""
        if public_path in ("/positions", "/portfolio", "/trades") or url.path in ("/positions", "/portfolio") or (
            url.path == "/trades" and any(key in query for key in ("user", "format", "limit", "cursor"))
        ):
            from public_api import serve

            serve(self, public_path or url.path, query, fetch_positions, data_page,
                  prefix="/api/public" if public_path else "")
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
            content, version = static_file(filename)
            cache_control = "no-cache"
            if mime == "text/html":
                content = version_links(content)
                version = fingerprint(content)
            elif filename.endswith((".css", ".js", ".svg")) and filename != "watchlist-sw.js" and query.get("v") == [version]:
                cache_control = "public, max-age=31536000, immutable"
            tag = f'"{version}"'
            cached = {value.strip().removeprefix("W/") for value in self.headers.get("If-None-Match", "").split(",")}
            unchanged = tag in cached or "*" in cached
            self.respond(304 if unchanged else 200, b"" if unchanged else content, mime,
                         {"Cache-Control": cache_control, "ETag": tag})
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
        address = wallet.lower()
        refresh = query.get("fresh") == ["1"]
        key = (url.path, address)
        try:
            if catalog:
                from market_catalog import CatalogError, browse_markets

                try:
                    filters = tuple((name, tuple(query[name])) for name in CATALOG_FILTERS if name in query)
                    self.send_cached_json((url.path, filters), lambda: browse_markets(query), ttl=20)
                except CatalogError as error:
                    self.send_json(400, {"error": str(error)})
                return
            elif precedents:
                from precedents import SLUG, compare_markets, traded_conditions

                slug = query.get("market", [""])[0]
                scope = query.get("scope", ["focused"])[0]
                if not SLUG.fullmatch(slug) or scope not in ("focused", "broad"):
                    self.send_json(400, {"error": "Select a market and a valid comparison scope."})
                    return
                if query.get("activity") == ["1"] and wallet:
                    data = {"traded": sorted(traded_conditions(wallet.lower(), data_pages, int(time() // 60)))}
                else:
                    data = compare_markets(slug, scope, wallet, data_request, data_pages,
                                           extended=query.get("horizons") != ["default"])
                if data is None:
                    self.send_json(404, {"error": "Select a Polymarket market with a Yes/No outcome."})
                    return
            elif url.path == "/api/trades":
                self.send_cached_json((*key, cursor), lambda: fetch_trades(address, cursor), ttl=20, refresh=refresh)
                return
            elif url.path == "/api/trade-summary":
                self.send_cached_json(key, lambda: fetch_trade_summary(address, refresh=refresh), ttl=25, refresh=refresh)
                return
            elif url.path == "/api/portfolio-history":
                points, cache = cached_wallet_pnl(address, refresh=refresh)
                self.send_json(200, {"points": chart_points(points, "position_pnl")}, {"X-Polyboard-Cache": cache})
                return
            elif url.path == "/api/portfolio-events":
                self.send_cached_json(key, lambda: fetch_portfolio_events(address, refresh=refresh), ttl=20, refresh=refresh)
                return
            elif market_history:
                data = fetch_market_history(token, condition, wallet)
            else:
                self.send_cached_json(key, lambda: {"positions": fetch_positions(address)}, ttl=8, refresh=refresh)
                return
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
