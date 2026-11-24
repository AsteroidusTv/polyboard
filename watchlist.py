"""Store browser-scoped follows and check public Polymarket prices for crossings."""
import base64
import json
import logging
import os
import re
import secrets
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from decimal import Decimal, InvalidOperation
from http.cookies import CookieError, SimpleCookie
from pathlib import Path
from threading import Thread
from time import sleep, time
from urllib.error import URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

from precedents import SLUG, array, epoch, gamma_by_slug, recent_market, thumbnail

CHECK_INTERVAL = 60
FRESH_SECONDS = 3 * CHECK_INTERVAL
SESSION = re.compile(r"[A-Za-z0-9_-]{43}")
TOKEN = re.compile(r"[0-9]{1,78}")
KEY = re.compile(r"[A-Za-z0-9_-]+={0,2}")
COOKIE = "polymarket_watchlist"
SCHEMA = """
CREATE TABLE IF NOT EXISTS watches (
    session TEXT NOT NULL, slug TEXT NOT NULL, market TEXT NOT NULL, quotes TEXT NOT NULL,
    followed INTEGER NOT NULL, PRIMARY KEY (session, slug)
);
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, slug TEXT NOT NULL,
    token TEXT NOT NULL, direction TEXT NOT NULL, target TEXT NOT NULL, change TEXT,
    baseline TEXT, fired INTEGER,
    FOREIGN KEY (session, slug) REFERENCES watches ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, slug TEXT NOT NULL,
    payload TEXT NOT NULL, created INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0,
    push_after INTEGER, FOREIGN KEY (session, slug) REFERENCES watches ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS notices_by_browser ON notices(session, id DESC);
CREATE TABLE IF NOT EXISTS subscriptions (
    session TEXT PRIMARY KEY, data TEXT NOT NULL
);
"""


class WatchError(ValueError):
    pass


class RequestError(ValueError):
    pass


def midpoint_prices(tokens):
    request = Request("https://clob.polymarket.com/midpoints",
                      data=json.dumps([{"token_id": token} for token in tokens]).encode(),
                      headers={"Content-Type": "application/json", "Accept": "application/json",
                               "User-Agent": "PolymarketLocalDashboard/1.0"})
    with urlopen(request, timeout=8) as response:
        prices = json.load(response)
    result = {}
    for token in tokens:
        try:
            price = Decimal(str(prices.get(token)))
        except InvalidOperation:
            continue
        if price.is_finite() and 0 < price < 1:
            result[token] = str(price)
    return result


def market_details(slug):
    raw = gamma_by_slug("markets", slug)
    if not raw:
        raise WatchError("This market couldn’t be found.")
    if raw.get("closed") or raw.get("acceptingOrders") is not True:
        raise WatchError("This market is no longer accepting orders.")
    event = next(iter(raw.get("events") or []), {})
    tokens = [str(token) for token in array(raw.get("clobTokenIds"))]
    labels = array(raw.get("outcomes"))
    if len(tokens) != 2 or len(labels) != 2 or not all(TOKEN.fullmatch(token) for token in tokens):
        raise WatchError("Price alerts are unavailable for this market.")
    return {
        "slug": slug, "title": str(raw.get("question") or slug)[:500],
        "event_slug": event.get("slug"), "event_title": event.get("title"),
        "image": thumbnail(raw, event), "condition_id": raw.get("conditionId"),
        "end_at": epoch(raw.get("endDate")) or epoch(event.get("endDate")),
        "state": "open", "outcomes": [{"label": label, "token_id": token} for label, token in zip(labels, tokens)],
    }


def quote_batch(tokens):
    try:
        return midpoint_prices(tokens)
    except (URLError, TimeoutError, ValueError, AttributeError, TypeError):
        return {}


def watch_preview(slug):
    if not isinstance(slug, str) or not SLUG.fullmatch(slug):
        raise RequestError("Invalid market.")
    market = market_details(slug)
    prices = quote_batch([side["token_id"] for side in market["outcomes"]])
    now = int(time())
    quotes = {token: {"current": price, "baseline": price, "time": now, "points": [[now, float(price)]]}
              for token, price in prices.items()}
    return market, quotes


def crossed(previous, price, target, direction):
    if previous is None:
        return False
    before, now = Decimal(previous), Decimal(price)
    return before < target <= now if direction == "above" else before > target >= now


def valid_subscription(data):
    if not isinstance(data, dict):
        raise RequestError("Invalid push subscription.")
    endpoint = data.get("endpoint")
    keys = data.get("keys")
    if not isinstance(endpoint, str) or len(endpoint) > 2048 or not isinstance(keys, dict):
        raise RequestError("Invalid push subscription.")
    try:
        url = urlsplit(endpoint)
        host = url.hostname or ""
        allowed = host in {"fcm.googleapis.com", "updates.push.services.mozilla.com", "push.services.mozilla.com",
                           "web.push.apple.com"} or host.endswith((".notify.windows.com", ".push.apple.com"))
        if url.scheme != "https" or url.netloc != host or not allowed or not url.path or url.fragment:
            raise ValueError
        result = {}
        for key, size in (("p256dh", 65), ("auth", 16)):
            value = keys.get(key)
            if not isinstance(value, str) or not KEY.fullmatch(value) or len(value) > 88:
                raise ValueError
            decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
            if len(decoded) != size or (key == "p256dh" and decoded[0] != 4):
                raise ValueError
            result[key] = value
    except (ValueError, UnicodeError):
        raise RequestError("This browser’s push service is unsupported.") from None
    return {"endpoint": endpoint, "keys": result}


def database_dir():
    custom = os.environ.get("POLYMARKET_WATCHLIST_DIR") or os.environ.get("STATE_DIRECTORY")
    return Path(custom) if custom else Path.home() / ".local/state/polymarket-dashboard"


class Watchlist:
    def __init__(self, directory):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = directory / "watchlist.sqlite3"
        self.key_path = directory / "vapid.pem"
        self.public_key = None
        self.push = None
        self.status_checks = {}
        with self.connect() as db:
            db.execute("PRAGMA journal_mode = WAL")
            db.executescript(SCHEMA)

    @contextmanager
    def connect(self):
        with closing(sqlite3.connect(self.path, timeout=8)) as db, db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys = ON")
            yield db

    def enable_push(self, contact):
        if not contact:
            return
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from py_vapid import Vapid
        from pywebpush import webpush
        from requests import Session

        class PushSession(Session):
            def request(self, method, url, **kwargs):
                return super().request(method, url, **{**kwargs, "allow_redirects": False})

        try:
            with self.key_path.open("rb") as stream:
                private = serialization.load_pem_private_key(stream.read(), password=None)
        except FileNotFoundError:
            private = ec.generate_private_key(ec.SECP256R1())
            fd = os.open(self.key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                   serialization.NoEncryption()))
        point = private.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        vapid = Vapid(private_key=private)
        contact = contact.rstrip("/")
        vapid.sign({"aud": "https://fcm.googleapis.com", "sub": contact})
        self.public_key = base64.urlsafe_b64encode(point).decode().rstrip("=")

        def send(subscription, payload):
            with PushSession() as session:
                return webpush(subscription_info=subscription, data=json.dumps(payload),
                               vapid_private_key=vapid, vapid_claims={"sub": contact},
                               ttl=3600, timeout=8, requests_session=session)
        self.push = send

    def snapshot(self, db, session):
        rows = db.execute("SELECT * FROM watches WHERE session = ? ORDER BY followed DESC, rowid DESC", (session,))
        alerts = db.execute("SELECT id, slug, token, direction, target, change, baseline, fired FROM alerts "
                            "WHERE session = ? ORDER BY id", (session,)).fetchall()
        grouped = {}
        for alert in alerts:
            grouped.setdefault(alert["slug"], []).append(dict(alert))
        return_at = int(time())
        watched = [{**json.loads(row["market"]),
                    "quotes": {token: {**quote, "fresh": return_at - quote["time"] <= FRESH_SECONDS}
                               for token, quote in json.loads(row["quotes"]).items()},
                    "alerts": grouped.get(row["slug"], [])} for row in rows]
        notices = [{**json.loads(row["payload"]), "id": row["id"], "created": row["created"], "seen": bool(row["seen"])}
                   for row in db.execute("SELECT * FROM notices WHERE session = ? ORDER BY id DESC LIMIT 100", (session,))]
        subscribed = db.execute("SELECT 1 FROM subscriptions WHERE session = ?", (session,)).fetchone()
        return {"watches": watched, "notices": notices, "push_key": self.public_key, "push_enabled": bool(subscribed)}

    def read(self, session):
        with self.connect() as db:
            return self.snapshot(db, session)

    def mutate(self, session, data):
        action = data.get("action")
        slug = data.get("slug")
        if action in ("follow", "unfollow", "add-alert") and (not isinstance(slug, str) or not SLUG.fullmatch(slug)):
            raise RequestError("Invalid market.")
        new_alert = data.get("alert") if action == "follow" else None
        if new_alert is not None and not isinstance(new_alert, dict):
            raise RequestError("Invalid price alert.")
        market = quotes = None
        if action == "follow":
            with self.connect() as db:
                watched = db.execute("SELECT 1 FROM watches WHERE session = ? AND slug = ?", (session, slug)).fetchone()
                if watched and new_alert is None:
                    return self.snapshot(db, session)
                if not watched:
                    self.check_capacity(db, session)
            if not watched:
                market, quotes = watch_preview(slug)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if action == "follow":
                if not db.execute("SELECT 1 FROM watches WHERE session = ? AND slug = ?", (session, slug)).fetchone():
                    if market is None:
                        raise WatchError("This market was unfollowed. Try again to follow it.")
                    self.check_capacity(db, session)
                    db.execute("INSERT INTO watches VALUES (?, ?, ?, ?, ?)",
                               (session, slug, json.dumps(market), json.dumps(quotes), int(time())))
                if new_alert is not None:
                    self.add_alert(db, session, slug, new_alert)
            elif action == "unfollow":
                db.execute("DELETE FROM watches WHERE session = ? AND slug = ?", (session, slug))
            elif action == "add-alert":
                self.add_alert(db, session, slug, data)
            elif action in ("remove-alert", "rearm"):
                alert = self.identifier(data)
                if action == "remove-alert":
                    db.execute("DELETE FROM alerts WHERE session = ? AND id = ?", (session, alert))
                else:
                    db.execute("UPDATE alerts SET fired = NULL WHERE session = ? AND id = ?", (session, alert))
            elif action == "read":
                notice = data.get("id")
                if notice is None:
                    db.execute("UPDATE notices SET seen = 1 WHERE session = ?", (session,))
                else:
                    db.execute("UPDATE notices SET seen = 1 WHERE session = ? AND id = ?", (session, self.identifier(data)))
            elif action == "enable-push":
                if not self.push:
                    raise WatchError("Browser notifications are unavailable on this server.")
                if not db.execute("SELECT 1 FROM watches WHERE session = ? LIMIT 1", (session,)).fetchone():
                    raise WatchError("Follow a market before enabling browser notifications.")
                subscription = valid_subscription(data.get("subscription"))
                db.execute("INSERT OR REPLACE INTO subscriptions VALUES (?, ?)", (session, json.dumps(subscription)))
            elif action == "disable-push":
                db.execute("DELETE FROM subscriptions WHERE session = ?", (session,))
            else:
                raise RequestError("Unknown Watchlist action.")
            return self.snapshot(db, session)

    @staticmethod
    def check_capacity(db, session):
        if db.execute("SELECT count(*) FROM watches WHERE session = ?", (session,)).fetchone()[0] >= 50:
            raise WatchError("This browser’s Watchlist is full.")
        if db.execute("SELECT count(*) FROM watches").fetchone()[0] >= 1000:
            raise WatchError("The server’s Watchlist is full.")

    @staticmethod
    def identifier(data):
        number = data.get("id")
        if type(number) is not int or not 0 < number < 2**53:
            raise RequestError("Invalid alert or notification.")
        return number

    @staticmethod
    def add_alert(db, session, slug, data):
        watch = db.execute("SELECT market, quotes FROM watches WHERE session = ? AND slug = ?", (session, slug)).fetchone()
        if not watch:
            raise WatchError("Follow this market first.")
        market, quotes = json.loads(watch["market"]), json.loads(watch["quotes"])
        if market["state"] != "open":
            raise WatchError("This market is not currently trading.")
        token = data.get("token")
        if not any(side["token_id"] == token for side in market["outcomes"]):
            raise RequestError("Choose a valid outcome.")
        direction = data.get("direction")
        kind = data.get("kind")
        if direction not in ("above", "below") or kind not in ("price", "change"):
            raise RequestError("Choose a valid alert condition.")
        value = data.get("value")
        if not isinstance(value, str) or not re.fullmatch(r"\d{1,7}(?:\.\d{1,3})?", value):
            raise RequestError("Enter a positive number with up to three decimal places.")
        amount = Decimal(value)
        target, change, baseline = amount / 100, None, None
        if kind == "change":
            baseline = quotes.get(token, {}).get("baseline")
            if baseline is None or int(time()) - quotes[token]["time"] > FRESH_SECONDS:
                raise WatchError("Wait for a fresh market price to set an alert based on price change.")
            change = str(amount)
            target = Decimal(baseline) * (1 + (amount if direction == "above" else -amount) / 100)
        if amount <= 0 or not 0 < target < 1:
            raise RequestError("The target must be between 0¢ and 100¢.")
        if db.execute("SELECT count(*) FROM alerts WHERE session = ? AND slug = ?", (session, slug)).fetchone()[0] >= 8:
            raise WatchError("This market already has eight alerts.")
        if db.execute("SELECT 1 FROM alerts WHERE session = ? AND slug = ? AND token = ? AND direction = ? "
                      "AND target = ? AND fired IS NULL",
                      (session, slug, token, direction, str(target.normalize()))).fetchone():
            raise WatchError("An active alert already uses this threshold.")
        db.execute("INSERT INTO alerts(session, slug, token, direction, target, change, baseline) VALUES (?, ?, ?, ?, ?, ?, ?)",
                   (session, slug, token, direction, str(target.normalize()), change, baseline))

    def update_prices(self, db, watch, prices, now):
        session, slug = watch["session"], watch["slug"]
        market, quotes = json.loads(watch["market"]), json.loads(watch["quotes"])
        if market["state"] != "open":
            return
        active = db.execute("SELECT * FROM alerts WHERE session = ? AND slug = ? AND fired IS NULL",
                            (session, slug)).fetchall()
        push = db.execute("SELECT 1 FROM subscriptions WHERE session = ?", (session,)).fetchone()
        changed = False
        for side in market["outcomes"]:
            token = side["token_id"]
            price = prices.get(token)
            if price is None:
                continue
            changed = True
            quote = quotes.get(token, {"baseline": price, "points": []})
            previous = quote.get("current")
            points = [point for point in quote["points"] if point[0] >= now - 86400]
            if not points or now - points[-1][0] >= 600:
                points.append([now, float(price)])
            quotes[token] = {**quote, "current": price, "points": points, "time": now}
            for alert in active:
                if alert["token"] != token or not crossed(previous, price, Decimal(alert["target"]), alert["direction"]):
                    continue
                payload = {"slug": slug, "title": market["title"], "token": token, "outcome": side["label"],
                           "direction": alert["direction"], "target": alert["target"], "price": price}
                db.execute("UPDATE alerts SET fired = ? WHERE id = ?", (now, alert["id"]))
                db.execute("INSERT INTO notices(session, slug, payload, created, push_after) VALUES (?, ?, ?, ?, ?)",
                           (session, slug, json.dumps(payload), now, now if push else None))
                db.execute("DELETE FROM notices WHERE session = ? AND id NOT IN (SELECT id FROM notices "
                           "WHERE session = ? ORDER BY id DESC LIMIT 100)", (session, session))
        if changed:
            db.execute("UPDATE watches SET quotes = ? WHERE session = ? AND slug = ?", (json.dumps(quotes), session, slug))

    def check_markets(self, markets, now):
        self.status_checks = {slug: stamp for slug, stamp in self.status_checks.items() if slug in markets}
        due = sorted((slug for slug, market in markets.items() if market["state"] != "closed" and
                      now - self.status_checks.get(slug, 0) >= 300),
                     key=lambda slug: (self.status_checks.get(slug, 0), markets[slug].get("end_at") or float("inf")))[:12]

        def check(slug):
            try:
                raw = recent_market(slug)
            except (URLError, TimeoutError, ValueError):
                return None
            if not raw:
                return None
            state = "closed" if raw.get("closed") else "open" if raw.get("acceptingOrders") is True else "paused"
            return {**markets[slug], "state": state, "end_at": epoch(raw.get("endDate")) or markets[slug].get("end_at")}

        with ThreadPoolExecutor(max_workers=4) as pool:
            updates = list(pool.map(check, due))
        for slug, market in zip(due, updates):
            self.status_checks[slug] = now
            if market:
                markets[slug] = market
        return {slug: markets[slug] for slug, market in zip(due, updates) if market}

    def check_prices(self):
        with self.connect() as db:
            rows = db.execute("SELECT slug, market FROM watches GROUP BY slug").fetchall()
            markets = {row["slug"]: json.loads(row["market"]) for row in rows}
        if not markets:
            return
        updates = self.check_markets(markets, int(time()))
        tokens = list(dict.fromkeys(side["token_id"] for market in markets.values() if market["state"] == "open"
                                    for side in market["outcomes"]))
        prices = {}
        for offset in range(0, len(tokens), 100):
            prices.update(quote_batch(tokens[offset:offset + 100]))
        if not prices and not updates:
            return
        now = int(time())
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.executemany("UPDATE watches SET market = ? WHERE slug = ?",
                           ((json.dumps(market), slug) for slug, market in updates.items()))
            watches = db.execute("SELECT * FROM watches").fetchall()
            for watch in watches:
                self.update_prices(db, watch, prices, now)

    def flush_push(self):
        if not self.push:
            return
        now = int(time())
        with self.connect() as db:
            queued = db.execute("SELECT notices.id, notices.session, notices.payload, subscriptions.data "
                                "FROM notices JOIN subscriptions USING(session) "
                                "WHERE push_after <= ? AND created >= ? ORDER BY push_after, id LIMIT 10",
                                (now, now - 3600)).fetchall()
        for notice in queued:
            data = json.loads(notice["payload"])
            price = format((Decimal(data["price"]) * 100).normalize(), "f")
            payload = {"title": f'{data["outcome"]} hit {price}¢', "body": data["title"], "id": notice["id"]}
            status = None
            try:
                status = self.push(valid_subscription(json.loads(notice["data"])), payload).status_code
            except RequestError:
                status = 410
            except Exception as error:
                status = getattr(getattr(error, "response", None), "status_code", None)
            with self.connect() as db:
                if status in (404, 410):
                    db.execute("DELETE FROM subscriptions WHERE session = ? AND data = ?", (notice["session"], notice["data"]))
                retry = status in (None, 429) or 500 <= status < 600
                db.execute("UPDATE notices SET push_after = ? WHERE id = ?", (now + 300 if retry else None, notice["id"]))

    def start(self):
        def poll():
            while True:
                try:
                    self.check_prices()
                    self.flush_push()
                except Exception:
                    logging.exception("Watchlist polling failed")
                sleep(CHECK_INTERVAL)
        Thread(target=poll, name="watchlist", daemon=True).start()


def session_cookie(handler):
    try:
        cookie = SimpleCookie(handler.headers.get("Cookie", "")).get(COOKIE)
        return cookie.value if cookie and SESSION.fullmatch(cookie.value) else ""
    except CookieError:
        return ""


def serve(handler, store, write=False):
    if store is None:
        handler.send_json(503, {"error": "The Watchlist is unavailable."})
        return
    session = session_cookie(handler)
    try:
        if not write:
            market = parse_qs(urlsplit(handler.path).query, keep_blank_values=True).get("market")
            if market is None:
                handler.send_json(200, store.read(session))
            else:
                details, quotes = watch_preview(market[0])
                handler.send_json(200, {**details, "quotes": quotes})
            return
        if handler.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none") or (
                handler.headers.get_content_type() != "application/json"):
            handler.send_json(403, {"error": "This request must come from the dashboard."})
            return
        length = handler.headers.get("Content-Length", "")
        if not re.fullmatch(r"[1-9][0-9]{0,3}", length) or int(length) > 8192:
            raise RequestError("Invalid Watchlist request.")
        data = json.loads(handler.rfile.read(int(length)))
        if not isinstance(data, dict):
            raise RequestError("Invalid Watchlist request.")
        browser = session or secrets.token_urlsafe(32)
        result = store.mutate(browser, data)
        headers = {}
        if not session and data.get("action") == "follow":
            secure = "; Secure" if handler.headers.get("X-Forwarded-Proto") == "https" else ""
            headers["Set-Cookie"] = f"{COOKIE}={browser}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000{secure}"
        handler.send_json(200, result, headers)
    except RequestError as error:
        handler.send_json(400, {"error": str(error)})
    except (json.JSONDecodeError, UnicodeDecodeError):
        handler.send_json(400, {"error": "Invalid Watchlist request."})
    except WatchError as error:
        handler.send_json(409, {"error": str(error)})
    except (URLError, TimeoutError):
        handler.send_json(502, {"error": "Polymarket is unreachable. Try again in a moment."})
    except (ValueError, TypeError, KeyError):
        handler.send_json(502, {"error": "Polymarket returned an unreadable response."})
