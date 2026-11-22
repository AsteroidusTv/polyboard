"""Find candidates from Polymarket's public open-market catalogue."""
import gzip
import json
import math
import re
import unicodedata
from collections import Counter
from time import monotonic
from urllib.parse import urlencode
from urllib.request import Request, urlopen

CATALOG = "https://gamma-api.polymarket.com/markets/keyset"
MIN_LIQUIDITY = 500
SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,250}")
STOP = set("""a an and as at be before between by can from for in into is it more no of on or over
than that the then there this to under until what when where which who will with yes market win
wins winning won happen happens happen finish date week month year first second last end round
price reach hit higher lower above below up down total next january february march april may
june july august september october november december""".split())
TOPICS = {
    "elections": {"election", "presidential", "president", "parliament", "poll", "ballot", "candidate", "nomination", "vote", "elections", "party", "minister", "senate"},
    "geopolitics": {"war", "ceasefire", "russia", "ukraine", "iran", "israel", "strike", "military", "gaza", "hormuz", "nato", "troops", "sanctions", "capture", "peace", "hostage"},
    "economy": {"fed", "inflation", "gdp", "tariff", "recession", "employment", "rates", "unemployment", "cpi", "trade"},
    "science and technology": {"nasa", "mars", "moon", "spacex", "artemis", "launch", "space", "fda", "fusion", "robot", "openai", "agi", "satellite", "model", "ai"},
    "sports": {"nba", "nfl", "mlb", "nhl", "ufc", "fifa", "football", "tennis", "baseball", "goals", "vs", "league", "laliga", "championship"},
    "crypto": {"bitcoin", "btc", "ethereum", "eth", "sol", "solana", "crypto", "xrp", "dogecoin", "bnb", "fdv", "tge", "stablecoin"},
}


def words(text):
    normalized = unicodedata.normalize("NFKD", text.lower())
    normalized = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    return {word for word in re.findall(r"[a-z]{2,}", normalized) if word not in STOP}


def topics(terms):
    return {name for name, keywords in TOPICS.items() if terms & keywords}


def profile_scores(history):
    by_market = Counter(row[1] for row in history["fills_recent_first"])
    keywords, subject_counts = Counter(), Counter()
    for index, fills in by_market.items():
        title, slug = history["markets"][index]
        terms = words((title or "") + " " + (slug or ""))
        weight = 1 + math.log(fills)
        for term in terms:
            keywords[term] += weight
        for subject in topics(terms):
            subject_counts[subject] += weight
    return keywords, subject_counts


def gamma_number(value):
    number = float(value or 0)
    return max(0, number) if math.isfinite(number) else 0


def market_candidate(raw, known_slugs, keywords, subject_counts):
    slug = raw.get("slug")
    if not slug or not SLUG.fullmatch(slug) or slug in known_slugs:
        return None
    if raw.get("active") is not True or raw.get("acceptingOrders") is not True or raw.get("closed"):
        return None
    title = raw.get("question")
    if not title or not raw.get("id"):
        return None
    event = (raw.get("events") or [{}])[0]
    event_slug = event.get("slug") or slug
    if not SLUG.fullmatch(event_slug):
        return None
    event_title = event.get("title") or title
    terms = words(title + " " + slug + " " + event_title)
    family = words(event_title)
    subjects = topics(terms)
    crypto_range = "crypto" in subjects and bool(re.search(
        r"(up or down|between|price|\$[\d,.]+|\b[0-9]{1,2}:[0-9]{2}\b)", title, re.I
    ))
    if crypto_range:
        return None
    try:
        liquidity = gamma_number(raw.get("liquidityNum"))
        volume = gamma_number(raw.get("volume24hr"))
        bid, ask = gamma_number(raw.get("bestBid")), gamma_number(raw.get("bestAsk"))
        outcomes = json.loads(raw["outcomes"])
        yes_index = outcomes.index("Yes")
        token = str(json.loads(raw["clobTokenIds"])[yes_index])
    except (TypeError, ValueError, KeyError, IndexError):
        return None
    if liquidity < MIN_LIQUIDITY or not 0 < bid <= ask < 1 or ask - bid > .15 or not token.isdigit():
        return None
    affinity = sum(math.sqrt(keywords[word]) for word in terms if word in keywords) / math.sqrt(max(len(terms), 1))
    familiarity = max((subject_counts[name] for name in subjects), default=0)
    similarity = affinity + 0.25 * math.sqrt(familiarity)
    quality = math.log10(1 + liquidity) + .5 * math.log10(1 + volume) - 4 * (ask - bid)
    event_url = f"https://polymarket.com/event/{event_slug}"
    return {
        "market_id": str(raw["id"]), "title": title, "event": event_slug,
        "family": " ".join(sorted(family)) if len(family) > 1 else event_slug,
        "url": event_url + (f"/{slug}" if event_slug != slug else ""),
        "end_date": raw.get("endDate"), "liquidity_usd": round(liquidity, 2),
        "volume_24h_usd": round(volume, 2), "rules_excerpt": (raw.get("description") or "")[:1250],
        "yes_token": token, "topics": sorted(subjects),
        "similarity": similarity, "affinity": affinity, "quality": quality,
    }


def diversified(rows, score, total, per_topic):
    selected, counts = [], Counter()
    for market in sorted(rows, key=score, reverse=True):
        category = (market["topics"] or ["other"])[0]
        if counts[category] >= per_topic:
            continue
        counts[category] += 1
        selected.append(market)
        if len(selected) == total:
            break
    return selected


def scan_catalog(history, held_slugs, progress):
    keywords, subject_counts = profile_scores(history)
    known_slugs = held_slugs | {slug for _, slug in history["markets"] if slug}
    params = {"closed": "false", "limit": 100, "liquidity_num_min": MIN_LIQUIDITY}
    candidates, seen = {}, set()
    scanned, eligible = 0, 0
    deadline = monotonic() + 120
    complete = False
    while monotonic() < deadline:
        req = Request(CATALOG + "?" + urlencode(params), headers={
            "User-Agent": "PolymarketPortfolioReview/1.0", "Accept-Encoding": "gzip",
        })
        try:
            with urlopen(req, timeout=8) as response:
                body = response.read()
                batch = json.loads(gzip.decompress(body) if response.headers.get("Content-Encoding") == "gzip" else body)
            markets = batch["markets"]
            if not isinstance(markets, list):
                break
        except (OSError, ValueError, TypeError, KeyError):
            break
        scanned += len(markets)
        for raw in markets:
            candidate = market_candidate(raw, known_slugs, keywords, subject_counts)
            if not candidate:
                continue
            eligible += 1
            family = candidate["family"]
            previous = candidates.get(family)
            rank = lambda row: row["similarity"] + .35 * row["quality"]
            if previous is None or rank(candidate) > rank(previous):
                candidates[family] = candidate
        progress(markets_scanned=scanned)
        cursor = batch.get("next_cursor")
        if not cursor:
            complete = True
            break
        if cursor in seen:
            break
        seen.add(cursor)
        params["after_cursor"] = cursor
    if not scanned:
        raise ValueError("Polymarket market catalogue unavailable")
    similar = diversified((row for row in candidates.values() if row["similarity"] > 0),
                          lambda row: row["similarity"] + .35 * row["quality"], 24, 10)
    selected = {row["event"] for row in similar}
    exploratory = diversified((row for row in candidates.values()
                                 if row["event"] not in selected
                                 and not set(row["topics"]) & {"sports", "crypto"}
                                 and row["affinity"] <= 1.3),
                                lambda row: row["quality"] - row["similarity"], 12, 4)
    return {
        "catalog_complete": complete, "markets_scanned": scanned, "eligible_markets": eligible,
        "minimum_liquidity_usd": MIN_LIQUIDITY,
        "similar": similar, "exploratory": exploratory,
    }
