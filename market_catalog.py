"""Read-only browsing of Polymarket events and their open markets."""
from concurrent.futures import ThreadPoolExecutor
from calendar import month_abbr, month_name
from datetime import date, datetime, timezone
from math import isfinite
import re
from time import time

from precedents import (
    CONDITION, REFERENDUM, SLUG, SWISS_QUERIES, array, clean, epoch, gamma_by_slug, gamma_page,
    polymarket_link, search_event_page, swiss_referendum_search, thumbnail,
)


# Gamma's top-level tags. Related events can carry several categories.
CATEGORIES = {
    "politics": 2, "geopolitics": 100265, "elections": 144, "finance": 120,
    "economy": 100328, "tech": 1401, "pop-culture": 596, "sports": 1,
    "esports": 64, "crypto": 21, "weather": 84,
}
SORTS = {"trending": ("volume24hr", False), "new": ("createdAt", False),
         "ending": ("endDate", True), "liquidity": ("liquidity", False),
         "volume": ("volume", False)}
PAGE_SIZE = 18
PAGES_PER_REQUEST = 3
PREVIEW_MARKETS = 4
SEARCH_SUGGESTIONS = 6
TOKEN = re.compile(r"[0-9]{1,78}")
SEARCH_STOP = set("a an and at by does for from in is of on or the to what when which who will with".split())
MONTHS = {name.lower(): index for names in (month_abbr, month_name)
          for index, name in enumerate(names) if index}
MONTHS["sept"] = 9
DATE_OPTION = re.compile(
    r"(?P<month>[a-z]+)\.?(?:\s+(?P<day>\d{1,2})(?:st|nd|rd|th)?)?(?:[,\s]+(?P<year>\d{4}))?"
)
DAY_FIRST_OPTION = re.compile(r"(?P<day>\d{1,2})(?:st|nd|rd|th)?\s+(?P<month>[a-z]+)\.?(?:[,\s]+(?P<year>\d{4}))?")
LEVEL_OPTION = re.compile(r"(?:[↑↓<>≤≥]\s*|(?:above|below|under|over|at least)\s+)?\$?\s*"
                          r"(-?\d[\d,]*(?:\.\d+)?)\s*([kmb])?\s*(?:%|\+)?")
LEVEL_RANGE = re.compile(LEVEL_OPTION.pattern + r"\s*(?:-|–|—|\bto\b)\s*" + LEVEL_OPTION.pattern)
PRICE_IN_QUESTION = re.compile(r"\$\s*(\d[\d,]*(?:\.\d+)?)([kmb])?\b")
RATE_OPTION = re.compile(r"(\d+(?:\.\d+)?)\+?\s*bps\s+(decrease|increase|cut|hike)")


class CatalogError(ValueError):
    pass


def number(value):
    try:
        result = float(value)
    except (ValueError, TypeError):
        return None
    return result if isfinite(result) else None


def parse_filters(query):
    def field(key, default=""):
        return query.get(key, [default])[0].strip()

    q = field("q")
    category = field("category", "trending")
    excluded = set(filter(None, field("exclude").split(",")))
    sort = field("sort", "auto")
    side = field("side", "yes")
    band = field("band")
    ending = field("ends")
    cursor = field("cursor")
    if q and not 3 <= len(q) <= 700:
        raise CatalogError("Enter a market title or a Polymarket link.")
    if (category not in {"trending", "new", "live", *CATEGORIES} or excluded - CATEGORIES.keys()
            or sort not in {"auto", *SORTS} or side not in ("yes", "no")
            or (band and band not in {str(index) for index in range(10)})
            or ending not in ("", "1", "7", "30", "90", "custom") or len(cursor) > 2048):
        raise CatalogError("Select a valid category, filter, or page.")
    if sort == "auto":
        sort = "relevance" if q else "new" if category == "new" else "trending"
    try:
        liquidity = int(field("liquidity", "0"))
        spread = int(field("spread", "0"))
        after = int(field("after", "0")) if ending == "custom" else 0
        before = int(field("before", "0")) if ending == "custom" else 0
    except ValueError as error:
        raise CatalogError("Enter a valid date or amount.") from error
    if (not 0 <= liquidity <= 1_000_000 or not 0 <= spread <= 100 or
            not 0 <= after <= 4_102_444_800 or not 0 <= before <= 4_102_444_800 or
            (after and before and after >= before)):
        raise CatalogError("Check the date range and filter values.")
    now = int(time())
    if ending and ending != "custom":
        after, before = now, now + int(ending) * 86400
    return q, category, excluded, sort, side, int(band) if band else None, after, before, liquidity, spread, cursor


def linked_events(parts):
    if not parts:
        return []
    if parts[0] == "event" and len(parts) == 2:
        event = gamma_by_slug("events", parts[1])
        if event:
            return [event]
    market = gamma_by_slug("markets", parts[-1])
    if not market:
        return []
    event = next(iter(market.get("events") or []), {})
    if len(parts) == 3 and event.get("slug") != parts[1]:
        return []
    if event.get("slug"):
        event = gamma_by_slug("events", event["slug"]) or event
    return [{**event, "slug": event.get("slug") or parts[-1], "markets": [market]}]


def open_market(raw, event):
    if raw.get("closed") or raw.get("archived") or raw.get("active") is not True or raw.get("acceptingOrders") is not True:
        return None
    slug, title = raw.get("slug") or "", raw.get("question") or ""
    outcomes, tokens = array(raw.get("outcomes")), array(raw.get("clobTokenIds"))
    if (not SLUG.fullmatch(slug) or not title or len(outcomes) != 2 or len(tokens) != 2 or
            not all(isinstance(label, str) and label.strip() for label in outcomes) or
            not all(TOKEN.fullmatch(str(token)) for token in tokens)):
        return None
    prices = array(raw.get("outcomePrices"))
    binary = {label.lower() for label in outcomes} == {"yes", "no"}
    order = sorted(range(2), key=lambda index: outcomes[index].lower() != "yes") if binary else range(2)
    quotes = []
    for index in order:
        price = number(prices[index]) if index < len(prices) else None
        quotes.append({"label": outcomes[index], "price": price if price is not None and 0 <= price <= 1 else None})
    condition = (raw.get("conditionId") or "").lower()
    bid, ask = number(raw.get("bestBid")), number(raw.get("bestAsk"))
    end = epoch(raw.get("endDate")) or epoch(event.get("endDate"))
    label = (raw.get("groupItemTitle") or "").strip()
    return {
        "slug": slug, "title": title, "label": label or title, "outcomes": quotes, "image": thumbnail(raw),
        "token_id": str(tokens[order[0]]), "condition_id": condition if CONDITION.fullmatch(condition) else None,
        "compare": binary and bool(CONDITION.fullmatch(condition)),
        "end_at": end, "state": "open", "volume_24h": number(raw.get("volume24hr")) or 0,
        "liquidity": number(raw.get("liquidityNum") or raw.get("liquidity")) or 0,
        "spread": round((ask - bid) * 100, 6) if bid is not None and ask is not None and 0 < bid <= ask < 1 else None,
    }


def in_band(market, side, band):
    price = next((item["price"] for item in market["outcomes"] if clean(item["label"]) == side), None)
    return price is not None and (band / 10 <= price < (band + 1) / 10 or (band == 9 and price == 1))


def search_terms(text):
    words = set(re.findall(r"[a-z]+|\d+", clean(text)))
    return words - SEARCH_STOP or words


def matching_search_terms(text, sought, prefix):
    words = search_terms(text)
    matched = words & sought
    if prefix and prefix not in matched and any(word.startswith(prefix) for word in words):
        matched.add(prefix)
    return matched


def date_option(market):
    label = clean(market["label"]).strip().rstrip("?")
    # A label can be the date itself or a question ending in a deadline.
    label = re.split(r"\b(?:by|on|before|end of)\s+", label)[-1]
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", label):
        try:
            return date.fromisoformat(label)
        except ValueError:
            return None
    match = DATE_OPTION.fullmatch(label) or DAY_FIRST_OPTION.fullmatch(label)
    if not match or match["month"] not in MONTHS:
        return None
    month = MONTHS[match["month"]]
    day = int(match["day"] or 1)
    try:
        if match["year"]:
            return date(int(match["year"]), month, day)
        end = datetime.fromtimestamp(market["end_at"], timezone.utc) if market["end_at"] else None
        year = end.year if end else 2000
        if end and month == 12 and end.month == 1:
            year -= 1
        return date(year, month, day)
    except (ValueError, OverflowError, OSError):
        return None


def level_option(market):
    label = clean(market["label"]).strip()
    rate = RATE_OPTION.fullmatch(label)
    if rate:
        value = float(rate[1])
        return "rate", -value if rate[2] in ("cut", "decrease") else value
    if label == "no change":
        return "rate", 0
    level = LEVEL_OPTION.fullmatch(label) or LEVEL_RANGE.fullmatch(label)
    if not level and market["label"] == market["title"]:
        level = PRICE_IN_QUESTION.search(label)
    if level:
        value = number(level[1].replace(",", ""))
        if value is not None:
            return "level", value * {"k": 1_000, "m": 1_000_000, "b": 1_000_000_000}.get(level[2], 1)
    return None


def ordered_event_markets(markets):
    if len(markets) < 2:
        return markets
    catchalls = {"other", "none", "none of the above", "any other"}
    options = [market for market in markets if clean(market["label"]).strip() not in catchalls]
    rest = [market for market in markets if clean(market["label"]).strip() in catchalls]
    dates = [date_option(market) for market in options]
    if all(value is not None for value in dates) and len(set(dates)) > 1:
        return [market for _, market in sorted(zip(dates, options), key=lambda pair: pair[0])] + rest
    levels = [level_option(market) for market in options]
    if (len(set(levels)) > 1 and all(level is not None for level in levels)
            and len({level[0] for level in levels}) == 1):
        return [market for _, market in sorted(zip(levels, options), key=lambda pair: pair[0][1])] + rest
    return sorted(markets, key=yes_price, reverse=True)


def yes_price(market):
    return next((outcome["price"] for outcome in market["outcomes"]
                 if clean(outcome["label"]) == "yes" and outcome["price"] is not None), -1)


def event_card(event, category, excluded, side, band, after, before, liquidity, spread, sought, prefix, *, suggest=False):
    slug = event.get("slug") or ""
    tags = {tag.get("slug") for tag in event.get("tags") or []}
    if (not SLUG.fullmatch(slug) or event.get("closed") or tags & excluded or
            (category == "live" and event.get("live") is not True) or
            (category in CATEGORIES and category not in tags)):
        return None
    ranked = []
    title = event.get("title") or ""
    required = sought - matching_search_terms(title, sought, prefix) if sought else sought
    open_count = 0
    for raw in event.get("markets") or []:
        market = open_market(raw, event)
        if not market:
            continue
        open_count += 1
        end = market["end_at"]
        if (band is not None and not in_band(market, side, band) or
                after and (end is None or end < after) or before and (end is None or end >= before) or
                market["liquidity"] < liquidity or spread and (market["spread"] is None or market["spread"] > spread)):
            continue
        matches = matching_search_terms(market["title"] + " " + market["label"], sought, prefix) if sought else set()
        if required <= matches:
            ranked.append(((len(matches), market["volume_24h"], market["liquidity"]), market))
    if not ranked:
        return None
    ranked.sort(key=lambda item: item[0], reverse=True)
    markets = [market for _, market in ranked]
    if not suggest:
        markets = ordered_event_markets(markets)
    return {"slug": slug, "title": title or markets[0]["title"], "image": thumbnail(event, (event.get("markets") or [{}])[0]),
            "categories": [tag for tag in CATEGORIES if tag in tags], "markets": markets, "market_count": open_count,
            "end_at": min((row["end_at"] for row in markets if row["end_at"]), default=None),
            "volume_24h": number(event.get("volume24hr")) or sum(row["volume_24h"] for row in markets),
            "volume": number(event.get("volume")) or 0, "liquidity": number(event.get("liquidity")) or 0,
            "created_at": epoch(event.get("createdAt")) or 0}


def preview_card(card):
    markets = card["markets"]
    return {**card, "matching_market_count": len(markets), "markets": markets[:PREVIEW_MARKETS]}


def browse_markets(query):
    q, category, excluded, sort, side, band, after, before, liquidity, spread, cursor = parse_filters(query)
    event_slug = query.get("event", [""])[0]
    suggest = query.get("suggest") == ["1"]
    parts = polymarket_link(q) if q else None
    swiss = bool(parts is None and q and swiss_referendum_search(clean(q)))
    sought = search_terms(q) if q and parts is None and not swiss else set()
    last_word = re.search(r"[a-z]{3,}$", clean(q)) if sought else None
    prefix = last_word[0] if last_word and last_word[0] in sought else ""
    if suggest and (not q or event_slug or cursor):
        raise CatalogError("Enter a market title for suggestions.")
    if q and parts is None and not swiss and not sought:
        return {"events": [], "next_cursor": None}
    if category in excluded:
        return {"events": [], "next_cursor": None}
    if event_slug:
        if not SLUG.fullmatch(event_slug) or cursor:
            raise CatalogError("Select a valid event.")
        event = gamma_by_slug("events", event_slug)
        card = event and event_card(event, category, excluded, side, band, after, before, liquidity, spread, sought, prefix)
        return {"events": [card] if card else [], "next_cursor": None}
    if q and parts is None and cursor and (not cursor.isdecimal() or len(cursor) > 4 or int(cursor) < 1):
        raise CatalogError("Invalid search page.")
    order, ascending = SORTS.get(sort, SORTS["trending"])
    params = [("limit", PAGE_SIZE), ("closed", "false"), ("order", order), ("ascending", str(ascending).lower())]
    if category in CATEGORIES:
        params.append(("tag_id", CATEGORIES[category]))
    if category == "live":
        params.append(("live", "true"))
    params.extend(("exclude_tag_id", CATEGORIES[tag]) for tag in sorted(excluded))
    if sort == "ending":
        near_now = datetime.fromtimestamp(int(time()) // 900 * 900, timezone.utc)
        params.append(("end_date_min", near_now.isoformat()))
    cards = {}
    for _ in range(1 if suggest else PAGES_PER_REQUEST):
        if parts is not None:
            events, following = linked_events(parts), None
        elif q:
            page = int(cursor or "1")
            options = {"sort": order, "ascending": str(ascending).lower()} if sort != "relevance" else {}
            if suggest:
                options["limit_per_type"] = PAGE_SIZE
            def search(term):
                return search_event_page(term, page, status="active", keep_closed_markets=0, **options)

            if swiss and not suggest:
                with ThreadPoolExecutor(max_workers=4) as pool:
                    batches = list(pool.map(search, dict.fromkeys((q, *SWISS_QUERIES))))
                events = [event for rows, _ in batches for event in rows]
                more = any(has_more for _, has_more in batches)
            else:
                events, more = search(q)
            if swiss:
                events = [event for event in events if REFERENDUM.search(clean(event.get("title")))]
            following = str(page + 1) if more and page < 9999 else None
        else:
            request = params + ([("after_cursor", cursor)] if cursor else [])
            data = gamma_page("events/keyset", tuple(request), int(time() // 60))
            events, following = data["events"], data.get("next_cursor")
        for event in events:
            card = event_card(event, category, excluded, side, band, after, before, liquidity, spread, sought, prefix,
                              suggest=suggest)
            if card:
                cards.setdefault(card["slug"], card)
        if following == cursor:
            following = None
        cursor = following
        if not cursor or len(cards) >= 12:
            break
    result = list(cards.values())
    if sort == "ending":
        result.sort(key=lambda row: row["end_at"] or float("inf"))
    elif sort != "relevance":
        key = {"trending": "volume_24h", "new": "created_at"}.get(sort, sort)
        result.sort(key=lambda row: row[key], reverse=True)
    if suggest:
        return {"events": [{**card, "markets": card["markets"][:1]} for card in result[:SEARCH_SUGGESTIONS]],
                "next_cursor": None}
    if query.get("preview") == ["1"]:
        result = [preview_card(card) for card in result]
    return {"events": result, "next_cursor": cursor}
