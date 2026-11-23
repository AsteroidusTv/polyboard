"""Read public market ownership, wallet results, and recent market activity."""
from collections import OrderedDict, defaultdict
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from math import isfinite
from secrets import token_urlsafe
from statistics import median
from threading import Lock
from time import monotonic, sleep, time

from precedents import (COMPARISON_TTL, SLUG, UPSTREAM, array, comparable_sample, epoch, recent_market,
                        resolved_winner, thumbnail)
from read_cache import ReadCache
from server import CONDITION, TOKEN, WALLET, data_page, data_request

COHORTS = {"25": 25, "50": 50, "100": 100, "1000": 1000, "all": 12000}
HISTORY_LIMIT = 100
RECENT_LIMIT = 20
DIRECTION_LIMIT = 40
BATCH_SIZE = 12
ROSTER_PAGE_SIZE = 12
REVIEW_LIMIT = 25
FINAL_STATUSES = ("CLOSED", "REDEEMABLE", "REDEEMABLE_LOST")
HOUR = 3600
SNAPSHOT_SECONDS = HOUR
SNAPSHOTS = OrderedDict()
SNAPSHOT_LOCK = Lock()
ROSTERS = ReadCache(48)
WALLET_HISTORY = ReadCache(1024)
HOLDER_BATCHES = ReadCache(192)
RESOLUTIONS = OrderedDict()
RESOLUTION_LOCK = Lock()
HISTORY_POOL = ThreadPoolExecutor(max_workers=12)
READ_POOL = ThreadPoolExecutor(max_workers=10)
POSITIONS_LOCK = Lock()
NEXT_POSITION_READ = 0.0
POSITION_INTERVAL = .125
POSITION_BURST = 4
POSITION_FIELDS = ("condition_id", "token_id", "last_event_at", "first_entry_at", "outcome_index",
                   "outcome", "realized_pnl", "total_pnl", "title", "icon", "image")


class ExpiredSnapshot(ValueError):
    pass


def number(value):
    try:
        result = float(value)
        return result if isfinite(result) else None
    except (ValueError, TypeError, OverflowError):
        return None


def address(value):
    return value.lower() if isinstance(value, str) and WALLET.fullmatch(value) else None


def position_outcome(row):
    index = row.get("outcome_index")
    return index if type(index) is int and index in (0, 1) else None


def market_details(slug):
    raw = recent_market(slug)
    if not raw:
        return None
    event = next(iter(raw.get("events") or []), {})
    group = event.get("slug") or slug
    condition = raw.get("conditionId") or ""
    labels = array(raw.get("outcomes"))
    tokens = [str(value) for value in array(raw.get("clobTokenIds"))]
    if (not CONDITION.fullmatch(condition) or len(labels) != 2 or len(tokens) != 2
            or not all(TOKEN.fullmatch(token) for token in tokens)):
        return None
    resolved = verified_winners({condition}).get(condition) if raw.get("closed") else None
    return {
        "slug": slug, "condition": condition, "title": str(raw.get("question") or slug),
        "event_title": event.get("title"), "image": thumbnail(raw, event), "labels": labels, "tokens": tokens,
        "url": "https://polymarket.com/event/" + group + ("/" + slug if group != slug else ""),
        "closed": bool(raw.get("closed")), "closes_at": epoch(raw.get("endDate")),
        "closed_at": epoch(raw.get("closedTime")), "resolved_at": resolved["resolved_at"] if resolved else None,
        "winner": resolved["winner"] if resolved else None, "description": str(raw.get("description") or "")[:2000],
    }


def holder_rows(market, limit, fetch=data_page):
    tokens = market["tokens"]
    groups = {token: {} for token in tokens}
    params = {"condition": market["condition"], "limit": min(1000, limit)}
    seen = set()
    exhausted = failed = False
    for _ in range((limit + 999) // 1000):
        try:
            rows, cursor = fetch("holders", params, timeout=6)
        except UPSTREAM:
            if not any(groups.values()):
                raise
            failed = True
            break
        for group in rows:
            holders = groups.get(str(group.get("token_id")))
            if holders is None:
                continue
            for item in group.get("holders") or []:
                wallet, shares = address(item.get("proxy_wallet")), number(item.get("amount"))
                if not wallet or shares is None or shares <= 0 or wallet in holders:
                    continue
                # Honor the upstream public username preference.
                name = str(item.get("name") or "")[:96] if item.get("display_username_public") is True else ""
                holders[wallet] = {"wallet": wallet, "name": name, "shares": shares}
        exhausted = not cursor
        if exhausted or all(len(group) >= limit for group in groups.values()):
            break
        if cursor in seen:
            failed = True
            break
        seen.add(cursor)
        params["cursor"] = cursor
    sides = []
    for index, token in enumerate(tokens):
        sorted_rows = sorted(groups[token].values(), key=lambda row: (-row["shares"], row["wallet"]))[:limit]
        total = sum(row["shares"] for row in sorted_rows)
        sides.append({"index": index, "label": market["labels"][index], "rows": sorted_rows, "shares": total,
                      "top_five_pct": round(100 * sum(row["shares"] for row in sorted_rows[:5]) / total, 1)
                      if total and len(sorted_rows) >= 5 else None})
    return sides, exhausted, failed


def roster(market, cohort, now):
    def load():
        sides, complete, partial = holder_rows(market, COHORTS[cohort])
        data = {"snapshot": token_urlsafe(18), "as_of": now, "market": market, "cohort": cohort, "sides": sides,
                "complete": complete, "partial": partial, "cap": COHORTS[cohort]}
        with SNAPSHOT_LOCK:
            SNAPSHOTS[data["snapshot"]] = data
            while len(SNAPSHOTS) > 48:
                SNAPSHOTS.popitem(last=False)
        return data

    data, _ = ROSTERS.read((market["slug"], cohort), load, ttl=120, cache_if=lambda data: not data["partial"])
    # A busy instance can evict a roster while the shorter response cache still holds it.
    with SNAPSHOT_LOCK:
        registered = data["snapshot"] in SNAPSHOTS
    if not registered:
        data, _ = ROSTERS.read((market["slug"], cohort), load, ttl=120, refresh=True,
                               cache_if=lambda data: not data["partial"])
    return data


def get_snapshot(slug, token):
    with SNAPSHOT_LOCK:
        data = SNAPSHOTS.get(token)
        if not data or data["market"]["slug"] != slug or int(time()) - data["as_of"] >= SNAPSHOT_SECONDS:
            raise ExpiredSnapshot("This holder snapshot expired. Refresh the holder list to continue.")
        SNAPSHOTS.move_to_end(token)
        return data


def compact_roster(data):
    return {**data, "sides": [{**group, "holder_count": len(group["rows"]), "rows": group["rows"][:ROSTER_PAGE_SIZE]}
                               for group in data["sides"]]}


def compact_profile(profile):
    result = {key: value for key, value in profile.items() if key != "recent_positions"}
    if result.get("similar") is not None:
        result["similar"] = {key: value for key, value in result["similar"].items() if key != "rows"}
    return result


def lifecycle_page(wallet, status, conditions=()):
    global NEXT_POSITION_READ
    params = {"user": wallet, "status": status, "sort_by": "TIMESTAMP", "sort_direction": "DESC", "limit": HISTORY_LIMIT}
    if conditions:
        params["condition"] = ",".join(conditions)
    if status != "CLOSED":
        params.update(include_archived="true", filter_amount=0)
    try:
        # Both processes can use short bursts and sustain eight position reads per second each.
        with POSITIONS_LOCK:
            now = monotonic()
            next_read = max(now, NEXT_POSITION_READ)
            NEXT_POSITION_READ = next_read + POSITION_INTERVAL
        delay = next_read - now - POSITION_INTERVAL * (POSITION_BURST - 1)
        if delay > 0:
            sleep(delay)
        rows, cursor = data_page("positions", params, timeout=5)
        return [{key: row[key] for key in POSITION_FIELDS if key in row} for row in rows], cursor is None
    except UPSTREAM:
        return [], None


def stats(wallet):
    try:
        result = data_request("user-stats", {"user": wallet}, timeout=5)["data"] or {}
        pnl = result.get("all_time_pnl") or {}
        return {"realized_market_pnl": number(pnl.get("realized_market_pnl")),
                "distinct_markets": result.get("trades")}
    except UPSTREAM:
        return {}


def wallet_history(wallet):
    def load():
        jobs = [(status, READ_POOL.submit(lifecycle_page, wallet, status)) for status in FINAL_STATUSES]
        rows, coverage = [], []
        for status, job in jobs:
            data, complete = job.result()
            rows.extend((status, row) for row in data)
            coverage.append(complete)
        return rows, coverage

    return WALLET_HISTORY.read(wallet, load, ttl=300, cache_if=lambda result: None not in result[1])[0]


@lru_cache(maxsize=1024)
def comparable_positions(wallet, conditions, bucket):
    batches = [conditions[start:start + 20] for start in range(0, len(conditions), 20)]
    jobs = [(status, READ_POOL.submit(lifecycle_page, wallet, status, batch))
            for batch in batches for status in FINAL_STATUSES]
    rows, checks = [], []
    for status, job in jobs:
        data, complete = job.result()
        rows.extend((status, row) for row in data)
        checks.append(complete is True)
    return rows, all(checks)


def positions_by_market(rows, before=None, resolutions=None):
    grouped = defaultdict(dict)
    for status, row in rows:
        condition, token = row.get("condition_id"), str(row.get("token_id") or "")
        stamp = epoch(row.get("last_event_at"))
        if (not isinstance(condition, str) or not CONDITION.fullmatch(condition) or not TOKEN.fullmatch(token)
                or not stamp or before is not None and stamp >= before):
            continue
        if before is not None and status != "CLOSED":
            resolution = (resolutions or {}).get(condition)
            if resolution is None or resolution["resolved_at"] >= before:
                continue
        pnl = number(row.get("realized_pnl") if status == "CLOSED" else row.get("total_pnl"))
        record = {"at": stamp, "entry": epoch(row.get("first_entry_at")), "index": position_outcome(row),
                  "outcome": str(row.get("outcome") or ""), "pnl": pnl,
                  "title": str(row.get("title") or "Market")[:300], "image": thumbnail(row)}
        existing = grouped[condition].get(token)
        if existing is None or existing["at"] < stamp:
            grouped[condition][token] = record
    markets = []
    for condition, tokens in grouped.items():
        records = list(tokens.values())
        latest = max(records, key=lambda item: item["at"])
        pnl = sum(row["pnl"] for row in records) if all(row["pnl"] is not None for row in records) else None
        image = next((record["image"] for record in records if record["image"]), "")
        markets.append({"condition": condition, "at": latest["at"], "title": latest["title"],
                        "image": image, "pnl": pnl, "positions": records})
    return sorted(markets, key=lambda row: row["at"], reverse=True)


def economic_record(markets):
    known = [row["pnl"] for row in markets if row["pnl"] is not None]
    return {"profit": sum(pnl >= .005 for pnl in known), "loss": sum(pnl <= -.005 for pnl in known),
            "flat": sum(abs(pnl) < .005 for pnl in known), "markets": len(markets),
            "pnl": round(sum(known), 2) if known else None}


def comparable_record(markets, winners, evidence=None):
    matches = []
    mixed = 0
    for row in markets:
        if row["condition"] not in winners:
            continue
        case = winners[row["condition"]]
        entries = [item for item in row["positions"] if item["entry"] and item["entry"] < case["resolved_at"]]
        sides = {item["index"] for item in entries}
        if len(sides) != 1 or None in sides or len(entries) != len(row["positions"]):
            mixed += 1
            continue
        side = next(iter(sides))
        if evidence is not None:
            pre_resolution = {index for index, stamp in evidence.get(row["condition"], {}).items()
                              if stamp < case["resolved_at"]}
            if pre_resolution != {side}:
                mixed += 1
                continue
        matches.append({"title": row["title"], "image": row.get("image") or case.get("image", ""),
                        "at": case["resolved_at"], "outcome": entries[0]["outcome"],
                        "correct": side == case["winner"], "pnl": row["pnl"]})
    matches.sort(key=lambda row: row["at"], reverse=True)
    return {"right": sum(row["correct"] for row in matches), "wrong": sum(not row["correct"] for row in matches),
            "excluded": mixed, "rows": matches[:6]}


@lru_cache(maxsize=4096)
def observed_buys(wallet, conditions, bucket):
    buys = defaultdict(dict)
    for start in range(0, len(conditions), 20):
        params = {"user": wallet, "condition": ",".join(conditions[start:start + 20]),
                  "side": "BUY", "start": 1, "limit": 500, "taker_only": "false"}
        before = None
        for _ in range(2):
            try:
                rows, cursor = data_page("trades", params, timeout=5)
            except UPSTREAM:
                break
            for row in rows:
                condition, index, stamp = row.get("condition_id"), position_outcome(row), epoch(row.get("timestamp"))
                if condition in conditions and index is not None and stamp and row.get("side") == "BUY":
                    sides = buys[condition]
                    sides[index] = min(stamp, sides.get(index, stamp))
            if not cursor or cursor == before:
                break
            before = params["cursor"] = cursor
    return buys


def verified_winners(conditions):
    now = int(time())
    with RESOLUTION_LOCK:
        cached = {condition: result for condition in conditions
                  if (item := RESOLUTIONS.get(condition)) and item[0] > now
                  and (result := item[1]) is not None}
        missing = sorted(condition for condition in conditions if
                         not (RESOLUTIONS.get(condition) and RESOLUTIONS[condition][0] > now))

    def request(batch):
        try:
            rows = data_request("resolutions", {"condition": ",".join(batch)}, timeout=5)["data"] or []
        except UPSTREAM:
            return {}
        results = {row["condition_id"]: {"resolved_at": result[0], "winner": result[1]}
                   for row in rows if row.get("condition_id") and (result := resolved_winner(row))}
        legacy = {row["condition_id"]: stamp for row in rows if row.get("condition_id") in batch and
                  not row.get("payouts") and row.get("status") in ("resolved", "settled") and
                  (stamp := epoch(row.get("resolved_at")) or epoch(row.get("last_update_timestamp")))}
        keys = sorted(legacy)
        lookup_failed = set()
        for start in range(0, len(keys), 10):
            conditions = keys[start:start + 10]
            try:
                tokens = data_request("tokens", {"condition": ",".join(conditions)}, timeout=5)["data"] or []
            except UPSTREAM:
                lookup_failed.update(conditions)
                continue
            payouts = defaultdict(dict)
            for token in tokens:
                outcome = position_outcome(token)
                if token.get("resolved") is True and outcome is not None:
                    payouts[token.get("condition_id")][outcome] = number(token.get("final_price"))
            for condition in conditions:
                pair = payouts[condition]
                if {pair.get(0), pair.get(1)} == {0, 1}:
                    results[condition] = {"resolved_at": legacy[condition], "winner": 0 if pair[0] == 1 else 1}
        with RESOLUTION_LOCK:
            for key in batch:
                if key in lookup_failed:
                    continue
                value = results.get(key)
                RESOLUTIONS[key] = now + (86400 if value else 300), value
                RESOLUTIONS.move_to_end(key)
            while len(RESOLUTIONS) > 24000:
                RESOLUTIONS.popitem(last=False)
        return results

    if missing:
        batches = [missing[start:start + 20] for start in range(0, len(missing), 20)]
        for result in READ_POOL.map(request, batches):
            cached.update(result)
    return cached


def comparable_markets(market, scope):
    try:
        report = comparable_sample(market["slug"], scope, data_request, int(time() // COMPARISON_TTL))
        if not report or report.get("status") == "target_unverified":
            return None
        return {case["condition"]: {"resolved_at": case["resolved_at"], "image": thumbnail(case) or case.get("event_image"),
                                    "winner": case["yes_index"] if case["outcome"] else 1 - case["yes_index"]}
                for case in report["cases"]}
    except UPSTREAM:
        return None


def profile(wallet, market, comparables, bucket, include_history):
    if market["closed"] and not market["resolved_at"] and not market["closed_at"]:
        return {"wallet": wallet, "recent": economic_record([]), "history": economic_record([]),
                "history_complete": False, "history_available": False, "similar": None, "similar_complete": False,
                "recent_positions": [], "direction_positions": [], "comparable_positions": []}
    history, coverage = wallet_history(wallet)
    # For historical markets use only rows whose latest position activity predates settlement.
    dates = [stamp for stamp in (market["resolved_at"], market["closed_at"]) if stamp]
    cutoff = min(dates) if market["closed"] else None
    earlier_settlements = None
    if include_history and cutoff is not None:
        pending = [row for status, row in history if status != "CLOSED" and
                   (stamp := epoch(row.get("last_event_at"))) and stamp < cutoff]
        pending.sort(key=lambda row: epoch(row["last_event_at"]), reverse=True)
        conditions = {value for row in pending[:DIRECTION_LIMIT]
                      if isinstance(value := row.get("condition_id"), str) and CONDITION.fullmatch(value)}
        earlier_settlements = verified_winners(conditions)
    markets = ([row for row in positions_by_market(history, cutoff, earlier_settlements)
                if row["condition"] != market["condition"]] if include_history else [])
    similar_markets, similar_complete = [], comparables is not None
    if comparables:
        if all(mark is True for mark in coverage):
            rows, similar_complete = history, True
        else:
            rows, similar_complete = comparable_positions(wallet, tuple(sorted(comparables)), bucket)
        relevant = [(status, row) for status, row in rows if row.get("condition_id") in comparables]
        similar_markets = positions_by_market(relevant, cutoff, comparables)
    return {"wallet": wallet, "recent": economic_record(markets[:RECENT_LIMIT]), "history": economic_record(markets),
            "history_complete": cutoff is None and all(mark is True for mark in coverage),
            "history_available": any(mark is not None for mark in coverage), "history_partial": None in coverage,
            "comparable_positions": similar_markets,
            "similar_complete": similar_complete,
            "direction_positions": markets[:DIRECTION_LIMIT],
            "recent_positions": [{key: value for key, value in row.items() if key != "positions"}
                                 for row in markets[:8]]}


def performance(market, side_rows, scope, part="full", include_stats=False):
    bucket = int(time()) // 300
    comparables = comparable_markets(market, scope) if part != "history" else None
    if part == "similar" and not comparables:
        return {"profiles": [{"wallet": row["wallet"], "similar": comparable_record([], {}) if comparables is not None else None,
                              "similar_complete": comparables is not None} for row in side_rows],
                "similar_markets": 0 if comparables is not None else None}
    jobs = [HISTORY_POOL.submit(profile, row["wallet"], market, comparables, bucket, part != "similar")
            for row in side_rows]
    profiles = [job.result() for job in jobs]
    winners = verified_winners({case["condition"] for row in profiles for case in row["direction_positions"]})
    if market["closed"]:
        cutoff = min((stamp for stamp in (market["closed_at"], market["resolved_at"]) if stamp), default=0)
        winners = {key: value for key, value in winners.items() if value["resolved_at"] < cutoff}

    def directions(row):
        cases = row.pop("direction_positions")
        related = row.pop("comparable_positions")
        conditions = ({case["condition"] for case in cases if case["condition"] in winners} |
                      {case["condition"] for case in related})
        evidence = observed_buys(row["wallet"], tuple(sorted(conditions)), bucket) if conditions else {}
        if part != "similar":
            row["direction"] = comparable_record(cases, winners, evidence)
            row["recent_direction"] = comparable_record(cases[:RECENT_LIMIT], winners, evidence)
            row["direction_checked"] = len(cases)
        if part != "history":
            row["similar"] = comparable_record(related, comparables, evidence) if comparables is not None else None
        if include_stats and not market["closed"]:
            row.update(stats(row["wallet"]))
        if part == "similar":
            return {key: row[key] for key in ("wallet", "similar", "similar_complete")}
        if part == "history":
            row["direction"].pop("rows")
            row["recent_direction"].pop("rows")
        return row

    return {"profiles": list(HISTORY_POOL.map(directions, profiles)),
            "similar_markets": len(comparables) if comparables is not None else None}


def recent_fills(wallet, market):
    params = {"user": wallet, "limit": 10, "start": 1}
    if market["closed"]:
        dates = [stamp for stamp in (market["resolved_at"], market["closed_at"]) if stamp]
        if not dates:
            return []
        params["end"] = min(dates) - 1
    rows, _ = data_page("trades", params, timeout=6)
    return [{"title": str(row.get("title") or "Market")[:300], "image": thumbnail(row),
             "side": row.get("side"), "outcome": row.get("outcome"),
             "price": number(row.get("price")), "size": number(row.get("size")), "at": epoch(row.get("timestamp"))}
            for row in rows]


def flow_signal(fills, end, complete):
    buckets = [[], []]
    for row in fills:
        stamp, price, size = epoch(row.get("timestamp")), number(row.get("price")), number(row.get("size"))
        index, side = position_outcome(row), row.get("side")
        if (stamp is None or not end - 24 * HOUR <= stamp <= end or price is None or not 0 <= price <= 1
                or size is None or size <= 0 or index is None or side not in ("BUY", "SELL")):
            continue
        leans_first = (index == 0) == (side == "BUY")
        buckets[int(stamp > end - 6 * HOUR)].append(
            (stamp, price * size, leans_first, price if index == 0 else 1 - price, address(row.get("proxy_wallet"))))
    reference, latest = buckets
    observed = len(reference) + len(latest)
    result = {"state": "insufficient", "fills": observed, "complete": complete, "end": end}
    if not complete or min(len(reference), len(latest)) < 15:
        return result
    before = sum(row[1] for row in reference)
    turnover = sum(row[1] for row in latest)
    if before <= 0 or turnover <= 0:
        return result
    first_flow = sum(row[1] for row in latest if row[2])
    first_fraction = first_flow / turnover
    ratio = (turnover / 6) / (before / 18)
    last_prices = [row[3] for row in sorted(latest, key=lambda row: row[0])]
    first_move = round(100 * (median(last_prices[-5:]) - median(last_prices[:5])), 2)
    hours = defaultdict(float)
    wallets = defaultdict(float)
    for stamp, amount, _, _, wallet in latest:
        hours[stamp // HOUR * HOUR] += amount
        if wallet:
            wallets[wallet] += amount
    peak = max(hours, key=hours.get)
    concentration = round(100 * sum(sorted(wallets.values(), reverse=True)[:3]) / turnover, 1) if wallets else None
    return {**result, "state": "available", "recent_fills": len(latest), "recent_turnover": round(turnover, 2),
            "reference_fills": len(reference), "volume_multiple": round(ratio, 2),
            "lean": 0 if first_fraction >= .5 else 1, "directional_pct": round(max(first_fraction, 1-first_fraction)*100, 1),
            "peak_hour": peak, "top_three_turnover_pct": concentration,
            "first_price_move": first_move, "flag": ratio >= 3 and turnover >= 5000 and max(first_fraction, 1-first_fraction) >= .75}


@lru_cache(maxsize=64)
def market_activity(condition, end):
    params = {"condition": condition, "start": end - 24 * HOUR, "end": end, "limit": 1000}
    trades = []
    cursor = None
    seen = set()
    for _ in range(4):
        try:
            rows, cursor = data_page("trades", params, timeout=6)
        except UPSTREAM:
            return flow_signal(trades, end, False)
        trades.extend(rows)
        if not cursor:
            break
        if cursor in seen:
            break
        seen.add(cursor)
        params["cursor"] = cursor
    return flow_signal(trades, end, not cursor)


def signals(market, clock=None):
    now = int(time()) if clock is None else clock
    if market["closed"]:
        limits = [stamp for stamp in (market["closed_at"], market["resolved_at"]) if stamp]
        if not limits:
            return {"state": "no_cutoff"}
        return {**market_activity(market["condition"], min(limits)), "anchor": "close"}
    return {**market_activity(market["condition"], now // 60 * 60), "anchor": "now"}


def review_context(market, scope, cohort):
    comparison_limit = min(COHORTS[cohort], REVIEW_LIMIT)
    sides, complete, partial = holder_rows(market, comparison_limit)
    unique = {row["wallet"]: row for side in sides for row in side["rows"]}
    profiles = performance(market, unique.values(), scope)
    by_wallet = {row["wallet"]: row for row in profiles["profiles"]}
    summary = []
    for side in sides:
        rows = [by_wallet[row["wallet"]] for row in side["rows"]]
        summary.append({"label": side["label"], "wallets": len(rows), "sum_net_shares": side["shares"],
                        "top_five_pct_of_sample": side["top_five_pct"],
                        "wallets_with_history": sum(row["history_available"] for row in rows),
                        "wallets_with_complete_history": sum(row["history_complete"] for row in rows),
                        **{kind: {key: sum((row[kind] or {}).get(key, 0) for row in rows) for key in keys}
                           for kind, keys in (("recent", ("profit", "loss")), ("history", ("profit", "loss")),
                                              ("direction", ("right", "wrong")), ("recent_direction", ("right", "wrong")),
                                              ("similar", ("right", "wrong", "excluded")))}})
    info = {key: market[key] for key in ("title", "event_title", "url", "closed", "closes_at", "closed_at",
                                             "resolved_at", "description", "labels")}
    return {"market": info, "scope": scope, "requested": cohort, "wallets_per_side_cap": comparison_limit,
            "coverage_limited": not complete or partial, "sides": summary, "similar_markets": profiles["similar_markets"],
            "activity": signals(market), "as_of": int(time())}


def serve(handler, query):
    def first(key, default=""):
        return query.get(key, [default])[0]

    slug, view = first("market"), first("view", "list")
    scope, cohort = first("scope", "focused"), first("limit", "50")
    side, offset = first("side", "0"), first("offset", "0")
    part, take = first("part", "full"), first("take", str(BATCH_SIZE))
    compact = first("compact") == "1"
    if (part not in ("full", "history", "similar") or len(take) > 2 or not take.isascii()
            or not take.isdecimal() or not 1 <= int(take) <= BATCH_SIZE):
        handler.send_json(400, {"error": "Choose a valid holder analysis batch."})
        return
    if (not SLUG.fullmatch(slug) or view not in ("list", "page", "signals", "performance", "wallet")
            or scope not in ("focused", "broad") or cohort not in COHORTS or side not in ("0", "1")
            or not offset.isascii() or not offset.isdecimal() or len(offset) > 5):
        handler.send_json(400, {"error": "Choose a market and a valid holder sample."})
        return
    try:
        headers = None
        if view in ("page", "performance", "wallet"):
            data = get_snapshot(slug, first("snapshot"))
            rows = data["sides"][int(side)]["rows"]
            start = int(offset)
            if view == "performance":
                end = start + int(take)
                sample = rows[start:end]
                if start and not sample:
                    handler.send_json(404, {"error": "This page is outside the selected sample."})
                    return
                def ready(result):
                    return ((part == "history" or result["similar_markets"] is not None) and
                            all(not row.get("history_partial") and row.get("history_available", True)
                                for row in result["profiles"]))

                key = (data["snapshot"], side, start, end, part, scope if part != "history" else "")
                results, cache = HOLDER_BATCHES.read(key, lambda: performance(data["market"], sample, scope, part,
                                                                             include_stats=part == "full"),
                                                     ttl=120, cache_if=ready)
                if compact:
                    results = {**results, "profiles": [compact_profile(row) for row in results["profiles"]]}
                payload = {**results, "offset": start, "next_offset": end if end < len(rows) else None}
                headers = {"X-Polyboard-Cache": cache}
            elif start >= len(rows):
                handler.send_json(404, {"error": "This selection is outside the holder sample."})
                return
            elif view == "page":
                payload = {"rows": rows[start:start + ROSTER_PAGE_SIZE], "offset": start}
            else:
                wallet = rows[start]["wallet"]
                summary = READ_POOL.submit(stats, wallet) if not data["market"]["closed"] else None
                payload = {"fills": recent_fills(wallet, data["market"]), "stats": summary.result() if summary else {}}
        else:
            market = market_details(slug)
            if not market:
                handler.send_json(404, {"error": "This market does not have two supported outcome tokens."})
                return
            payload = roster(market, cohort, int(time())) if view == "list" else signals(market)
            if view == "list" and compact:
                payload = compact_roster(payload)
    except ExpiredSnapshot as error:
        handler.send_json(409, {"error": str(error)})
        return
    except UPSTREAM:
        handler.send_json(502, {"error": "Polymarket data couldn’t load. Try again shortly."})
        return
    handler.send_json(200, payload, headers)
