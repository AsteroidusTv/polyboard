"""Compare past binary markets using official resolution times."""
import json
import re
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from functools import lru_cache
from math import isfinite
from time import time
from typing import NamedTuple
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

from market_discovery import SLUG, STOP

MINUTE = 60
HOUR = 60 * MINUTE
DAY = 24 * HOUR
LONG_HORIZONS = (7 * DAY, 14 * DAY, 30 * DAY, 90 * DAY)
EXTENDED_HORIZONS = (5 * MINUTE, 10 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 6 * HOUR, 12 * HOUR,
                     DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 60 * DAY, 90 * DAY, 180 * DAY, 365 * DAY)
MAX_CASES = 24
MAX_MATCHES = 120
SWISS_QUERIES = ("Switzerland referendum", "Swiss referendum", "Swiss popular vote")
CONDITION = re.compile(r"0x[0-9a-f]{64}")
REFERENDUM = re.compile(r"\b(?:referend\w*|popular vote|ballot measure|ballot initiative|votation\w*)\b")
SWISS = re.compile(r"\b(?:swiss|switzerland|suisse|schweiz)\b")
VOTE_OUTCOME = re.compile(r"\b(?:pass(?:es)?|approve\w*|adopt\w*|accept\w*|reject\w*|margin of victory)\b")
VOTE_CALL = re.compile(r"\b(?:call|schedule|announce|hold) (?:a |an |the )?(?:(?:\w+) ){0,3}(?:referendum|popular vote)\b")
FORM_STOP = STOP - {"before", "by", "above", "below", "win", "pass", "reach", "vote"}
GENERIC_TAGS = {
    "all", "politics", "world", "world-affairs", "geopolitics", "sports", "crypto", "economy",
    "finance", "tech", "pop-culture", "recurring", "daily", "weekly", "monthly", "quarterly", "annual",
    "election", "elections", "global-elections", "world-elections", "main-election",
    "presidential-election", "presidential-elections",
}
TERRITORY = re.compile(r"^(?:will )?(.+?) (?:capture|retake|seize|liberate|take control of) (.+?) (?:by|before|in|on) (.+)$")
PLACE = re.compile(r"\b(?:city|town|village|region|district|province|capital|territory|temple|oblast)\b")
ELECTION_TYPE = re.compile(r"\b(presidential|parliamentary|legislative|gubernatorial|mayoral|senate) (?:elections?|races?)\b")
ELECTION_OTHER = re.compile(r"\b(?:nomination|primary|ballot|margin|percent|votes|seats|popular vote|electoral college|"
                            r"(?:first|second|1st|2nd) round|runoff|more than|less than)\b")
CEASEFIRE_OTHER = re.compile(r"\b(?:call for|extend|extension|violate|last|end|break|breach|hold|violation)\b")
CEASEFIRE_AGREEMENT = re.compile(r"\b(?:agree[sd]?|agreement|announce[sd]?|sign(?:s|ed)?)\b")
RELEASE = re.compile(r"\b(?:release[sd]?|launch(?:es|ed)?)\b")
DEADLINE = re.compile(r"\b(?:by|before|prior to|in|on) (?:(?:the )?end of |q[1-4]\b|20\d{2}\b|"
                      r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\d)")
THRESHOLD = re.compile(r"\b(above|below|over|under|reach|hit|dip to|drop to|fall to|rise to)\s+\$?\d")
BROADER_MATCHES = {"Other referendum", "Related question and topic", "Territorial control in another conflict",
                   "Same election type in another setting", "Other ceasefire markets"}
UPSTREAM = (URLError, TimeoutError, ValueError, TypeError, KeyError, AttributeError)


class QuestionForm(NamedTuple):
    kind: str
    subject: str
    query: str


def clean(value):
    return "".join(ch for ch in unicodedata.normalize("NFKD", (value or "").lower()) if not unicodedata.combining(ch))


def terms(text, stop=STOP):
    return list(dict.fromkeys(word for word in re.findall(r"[a-z]{2,}", clean(text)) if word not in stop))


def signature(text):
    return tuple(word for word in re.findall(r"[a-z]{2,}", clean(text)) if word not in FORM_STOP)


def question_form(title, event_title, label, tags):
    title = clean(title).strip().rstrip("?")
    context = title + " " + clean(event_title)
    territory = TERRITORY.fullmatch(title)
    if territory and DEADLINE.search(title):
        actor, place, _ = territory.groups()
        if "geopolitics" in tags and (
            any(tag.endswith("-map") for tag in tags) or "russia-capture" in tags or PLACE.search(place)
        ):
            return QuestionForm("territory", actor.removeprefix("the "), "capture")
    election = ELECTION_TYPE.search(context)
    if election and re.search(r"\bwins?\b", title) and not ELECTION_OTHER.search(context) and "%" not in title:
        kind = {"parliamentary": "legislative"}.get(election[1], election[1])
        if {"state-presidential-election", "swing-states"} & tags:
            kind += "-regional"
        return QuestionForm("election", kind, election[1] + " election")
    if "ceasefire" in title and DEADLINE.search(title) and not CEASEFIRE_OTHER.search(title):
        subject = signature(re.split(r"\b(?:effective )?ceasefire\b", title, 1)[0])
        kind = "ceasefire-agreement" if CEASEFIRE_AGREEMENT.search(title) else "ceasefire"
        return QuestionForm(kind, " ".join(sorted(subject)), "ceasefire")
    if RELEASE.search(title) and DEADLINE.search(title):
        return QuestionForm("release", "", "release")
    threshold = THRESHOLD.search(title)
    if threshold and ("crypto" in tags or "hit-price" in tags):
        direction = ("below" if label.lstrip().startswith("↓") or threshold[1] in ("below", "under", "dip to", "drop to", "fall to")
                     else "above" if label.lstrip().startswith("↑") or threshold[1] in ("above", "over", "rise to")
                     else "")
        subject = " ".join(terms(title[:threshold.start()]))
        return QuestionForm("threshold", subject + "|" + direction, subject + " price")
    return None


def epoch(value):
    if value is None:
        return None
    try:
        if str(value).isdigit():
            return int(value)
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return int(parsed.timestamp()) if parsed.tzinfo else None
    except (ValueError, OverflowError):
        return None


def array(value):
    try:
        value = json.loads(value) if isinstance(value, str) else value
    except ValueError:
        return []
    return value if isinstance(value, list) else []


@lru_cache(maxsize=192)
def gamma_page(path, query, bucket):
    req = Request("https://gamma-api.polymarket.com/" + path + "?" + urlencode(query),
                  headers={"Accept": "application/json", "User-Agent": "PolymarketLocalDashboard/1.0"})
    with urlopen(req, timeout=8) as response:
        return json.load(response)


def gamma(path, **params):
    return gamma_page(path, tuple(sorted(params.items())), int(time() // 600))


def thumbnail(*records):
    return next((value for row in records for key in ("icon", "image")
                 if isinstance(value := row.get(key), str) and value.startswith("https://")), "")


def horizon_offsets(duration):
    if not duration:
        return LONG_HORIZONS
    for largest, offsets in (
        (10 * MINUTE, (MINUTE, 2 * MINUTE, 3 * MINUTE, 4 * MINUTE)),
        (30 * MINUTE, (2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE)),
        (2 * HOUR, (5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR)),
        (8 * HOUR, (15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR)),
        (2 * DAY, (HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR)),
        (10 * DAY, (12 * HOUR, DAY, 3 * DAY, 5 * DAY)),
        (45 * DAY, (DAY, 3 * DAY, 7 * DAY, 14 * DAY)),
        (120 * DAY, (DAY, 7 * DAY, 14 * DAY, 30 * DAY)),
    ):
        if duration <= largest:
            return tuple(offset for offset in offsets if offset < duration) or (max(1, duration // 2),)
    return LONG_HORIZONS


def similar_duration(target, candidate):
    first, second = target["duration"], candidate["duration"]
    return not (first and second) or max(first, second) <= 3 * min(first, second)


def market_row(raw, event):
    outcomes = [str(value).lower() for value in array(raw.get("outcomes"))]
    tokens = array(raw.get("clobTokenIds"))
    condition = (raw.get("conditionId") or "").lower()
    slug = raw.get("slug") or ""
    event_slug = event.get("slug") or slug
    if (set(outcomes) != {"yes", "no"} or len(outcomes) != 2 or len(tokens) != 2 or
            not all((CONDITION.fullmatch(condition), SLUG.fullmatch(slug), SLUG.fullmatch(event_slug), raw.get("question")))):
        return None
    yes_index = outcomes.index("yes")
    token = str(tokens[yes_index])
    if not re.fullmatch(r"[0-9]{1,78}", token):
        return None
    series = next(iter(event.get("series") or []), {})
    tag_ids = {tag["slug"]: str(tag.get("id") or "") for tag in event.get("tags") or [] if tag.get("slug")}
    tags = set(tag_ids)
    title = raw["question"]
    event_title = event.get("title") or title
    context = clean(title + " " + event_title + " " + " ".join(sorted(tags)))
    vote = bool(REFERENDUM.search(context) and VOTE_OUTCOME.search(clean(title)) and not VOTE_CALL.search(clean(title)))
    outcome = None
    prices = array(raw.get("outcomePrices"))
    if raw.get("closed") is True and len(prices) == 2:
        try:
            values = [float(value) for value in prices]
            if sorted(values) == [0, 1]:
                outcome = int(values[yes_index])
        except (ValueError, TypeError):
            pass
    label = (raw.get("groupItemTitle") or "").strip() if len(event.get("markets") or []) > 1 else ""
    listed = epoch(raw.get("acceptingOrdersTimestamp")) or epoch(raw.get("startDate"))
    scheduled_end = epoch(raw.get("endDate")) or epoch(event.get("endDate"))
    scheduled_start = epoch(raw.get("eventStartTime")) or epoch(event.get("startTime"))
    form = question_form(title, event_title, label, tags)
    if form and form.kind == "election":
        scheduled_start = None  # The polling window is not the lifetime of the prediction market.
    start = scheduled_start if scheduled_start and scheduled_end and scheduled_start < scheduled_end else listed
    duration = scheduled_end - start if start and scheduled_end and scheduled_end > start else None
    return {
        "condition": condition, "slug": slug, "event": event_slug, "event_title": event_title, "title": title,
        "label": label or title, "image": thumbnail(raw, event), "event_image": thumbnail(event, raw),
        "url": f"https://polymarket.com/event/{event_slug}" + (f"/{slug}" if event_slug != slug else ""),
        "closed": raw.get("closed") is True, "yes_token": token, "yes_index": yes_index,
        "listed": listed, "closed_at": epoch(raw.get("closedTime")), "scheduled_end": scheduled_end, "duration": duration,
        "outcome": outcome, "series_id": str(series.get("id") or ""),
        "series": event.get("seriesSlug") or series.get("slug") or "", "tags": tags, "tag_ids": tag_ids,
        "form": form,
        "referendum": vote, "swiss_vote": vote and bool(SWISS.search(context)),
    }


def summary(row):
    return {key: row[key] for key in ("slug", "title", "label", "image", "event", "event_title", "event_image", "url", "closed")}


def search_event_page(query, page, *, status=None, **options):
    filters = {"events_status": status} if status else {}
    params = {"limit_per_type": 30, "keep_closed_markets": 1, **options}
    response = gamma("public-search", q=query, search_profiles="false", search_tags="false",
                     page=page, **filters, **params)
    return response.get("events") or [], bool((response.get("pagination") or {}).get("hasMore"))


def search_events(query, pages=1, *, status=None):
    events = []
    more = False
    for page in range(1, pages + 1):
        rows, more = search_event_page(query, page, status=status)
        events.extend(rows)
        if not more:
            break
    return events, more


def gamma_by_slug(resource, slug):
    try:
        return gamma(resource + "/slug/" + slug)
    except HTTPError as failure:
        if failure.code == 404:
            return None
        raise


def market_context(raw):
    closed = raw.get("closed") is True
    accepting = raw.get("acceptingOrders")
    prices = {}
    if not closed and accepting is True:
        for label, value in zip(array(raw.get("outcomes")), array(raw.get("outcomePrices"))):
            try:
                price = float(value)
            except (TypeError, ValueError):
                continue
            if 0 <= price <= 1:
                prices[str(label).lower()] = price
    rules = raw.get("description") or ""
    excerpt = rules.strip().split("\n\n", 1)[0].strip()
    if len(excerpt) > 460:
        excerpt = excerpt[:460].rsplit(" ", 1)[0] + "…"
    return {
        "state": "closed" if closed else "open" if accepting is True else "unavailable",
        "opened_at": epoch(raw.get("acceptingOrdersTimestamp")) or epoch(raw.get("startDate")),
        "scheduled_end": epoch(raw.get("endDate")),
        "closed_at": epoch(raw.get("closedTime")),
        "prices": prices, "rules_excerpt": excerpt,
    }


def recent_market(slug):
    return gamma_page("markets/slug/" + slug, (), int(time() // MINUTE))


def discovery_market_details(slugs):
    def load(slug):
        try:
            raw = recent_market(slug)
            event = next(iter(raw.get("events") or []), {})
            context = market_context(raw)
            market = market_row(raw, event)
            return {"icon": thumbnail(raw, event), "event_title": event.get("title"), "event_slug": event.get("slug"),
                    "state": context["state"], "indicative_prices": context["prices"],
                    **({"yes_token": market["yes_token"], "condition_id": market["condition"]} if market else {})}
        except UPSTREAM:
            return None

    with ThreadPoolExecutor(max_workers=6) as pool:
        return {slug: details for slug, details in zip(slugs, pool.map(load, slugs)) if details is not None}


def target_market(slug):
    raw = gamma_by_slug("markets", slug)
    if not raw:
        return None
    event = next(iter(raw.get("events") or []), {})
    event_slug = event.get("slug") or ""
    if SLUG.fullmatch(event_slug):
        full_event = gamma_by_slug("events", event_slug) or {}
        event = {**event, **full_event, "series": full_event.get("series") or event.get("series")}
    row = market_row(raw, event)
    if row:
        row["context"] = market_context(raw)
        if not row["context"]["scheduled_end"]:
            row["context"]["scheduled_end"] = row["scheduled_end"]
    return row


def polymarket_link(query):
    url = urlsplit(query)
    if not (url.scheme or url.netloc):
        return None
    parts = url.path.strip("/").split("/")
    if (url.scheme != "https" or url.netloc not in ("polymarket.com", "www.polymarket.com") or
            len(parts) not in (2, 3) or parts[0] not in ("event", "market") or
            not all(SLUG.fullmatch(part) for part in parts[1:])):
        return []
    return parts


def swiss_referendum_search(query):
    return bool(SWISS.search(query) and (REFERENDUM.search(query) or "vote" in query))


def match(target, candidate, scope):
    if candidate["event"] == target["event"] or not candidate["closed"]:
        return None
    if target["swiss_vote"] and candidate["swiss_vote"]:
        return "Swiss referendum"
    if target["referendum"] or candidate["referendum"]:
        if target["series"] and target["series"] == candidate["series"] and target["referendum"] and candidate["referendum"]:
            return "Same referendum series"
        if scope == "broad" and target["referendum"] and candidate["referendum"]:
            return "Other referendum"
        return None
    title = signature(target["title"])
    candidate_title = signature(candidate["title"])
    first, second = target["form"], candidate["form"]
    shared_tags = (target["tags"] & candidate["tags"]) - GENERIC_TAGS
    if first and second and first.kind == second.kind == "threshold" and first.subject != second.subject:
        return None
    if len(title) >= 2 and title == candidate_title:
        return "Recurring question"
    if (first or second) and (not first or not second or first.kind != second.kind):
        return None
    if target["series"] and target["series"] == candidate["series"] and len(set(title) & set(candidate_title)) >= 2:
        return "Same event series"
    if first and second:
        broad = scope == "broad"
        if first.kind == "territory":
            if any(tag.endswith("-map") for tag in shared_tags) or first.subject == second.subject and shared_tags:
                return "Territorial control in the same conflict"
            return "Territorial control in another conflict" if broad else None
        if first.kind == "election":
            if first.subject != second.subject:
                return None
            if shared_tags:
                return "Same election type and topic"
            return "Same election type in another setting" if broad else None
        if first.kind in ("ceasefire", "ceasefire-agreement"):
            if first.subject and first.subject == second.subject:
                return "Ceasefire involving the same parties"
            return "Other ceasefire markets" if broad else None
        if first.kind == "threshold" and first.subject == second.subject:
            return "Same asset and threshold direction"
        if first.kind == "release" and shared_tags:
            return "Release deadline in the same topic"
    if shared_tags:
        overlap = set(title) & set(candidate_title)
        if len(overlap) >= 3:
            similarity = len(overlap) / len(set(title) | set(candidate_title))
            if similarity >= .7:
                return "Similar wording and topic"
            if scope == "broad" and similarity >= .55:
                return "Related question and topic"
    return None


def candidate_markets(target, scope):
    queries = list(SWISS_QUERIES) if target["swiss_vote"] else [" ".join(terms(target["event_title"])[:6])]
    form = target["form"]
    if form:
        topic = form.subject if form.kind in ("territory", "ceasefire", "ceasefire-agreement") else ""
        if topic or form.kind == "threshold":
            queries.append(f"{topic} {form.query}".strip())
        if scope == "broad" or form.kind in ("election", "release"):
            queries.append(form.query)
    elif not target["referendum"]:
        queries.append(" ".join(terms(target["title"])[:4]))
    elif scope == "broad":
        queries.append("referendum")

    catalog = []
    if target["series_id"].isdigit():
        catalog.append({"series_id": target["series_id"]})
    if not target["swiss_vote"]:
        subject_terms = set(terms(target["event_title"] + " " + target["title"]))
        specific_tags = (tag for tag in target["tags"] - GENERIC_TAGS if target["tag_ids"][tag].isdigit())
        tags = sorted(specific_tags, key=lambda tag: (
            not (form and form.kind == "territory" and tag.endswith("-map")),
            -len(subject_terms.intersection(tag.split("-"))), tag,
        ))
        catalog.extend({"tag_id": target["tag_ids"][tag]} for tag in tags[:2])

    def catalog_page(filters):
        params = {"limit": 50, "closed": "true", "order": "endDate", "ascending": "false"}
        if target["closed"] and target["scheduled_end"]:
            end = max(target["scheduled_end"], target["closed_at"] or 0)
            params["end_date_max"] = datetime.fromtimestamp(end, timezone.utc).isoformat()
        rows = gamma("events", **params, **filters)
        return rows, len(rows) == 50

    events = {}
    more = False
    succeeded = False
    failure = None
    with ThreadPoolExecutor(max_workers=6) as pool:
        searches = [pool.submit(search_events, query, pages=3 if form or target["referendum"] else 2)
                    for query in dict.fromkeys(filter(None, queries))]
        searches.extend(pool.submit(catalog_page, filters) for filters in catalog)
        for job in searches:
            try:
                rows, partial = job.result()
            except UPSTREAM as error:
                more = True
                failure = error
                continue
            succeeded = True
            more |= partial
            for event in rows:
                for raw in event.get("markets") or []:
                    if raw.get("conditionId"):
                        events[raw["conditionId"]] = (raw, event)
    if not succeeded and failure:
        raise failure
    return (row for raw, event in events.values() if (row := market_row(raw, event))), more


def settlement(row, record):
    if (record.get("status") or "").lower() not in ("resolved", "settled"):
        return None
    resolved = epoch(record.get("resolved_at")) or epoch(record.get("last_update_timestamp"))
    if not resolved:
        return None
    outcome = row["outcome"]
    payouts = record.get("payouts")
    if isinstance(payouts, list) and len(payouts) == 2:
        if sorted(payouts) != [0, 1]:
            return None
        outcome = int(payouts[row["yes_index"]])
    if outcome not in (0, 1):
        return None
    return resolved, outcome


def market_unavailable(row, cutoff):
    if row["listed"] and row["listed"] > cutoff:
        return "Market was not open yet"
    if row["closed_at"] and row["closed_at"] <= cutoff:
        return "Market had already closed"
    return None


def extended_offsets(offsets, selected):
    return tuple(offset for offset in EXTENDED_HORIZONS if offset > offsets[-1] and any(
        not market_unavailable(row, resolved - offset) for row, _, resolved, _ in selected
    ))[:4]


@lru_cache(maxsize=8192)
def prior_observation(api, token, cutoff, bucket):
    records = api("prices-history", {"token_id": token, "as_of": cutoff})["data"] or []
    quote = records[-1] if records else {}
    return quote.get("timestamp"), quote.get("price"), quote.get("resolution_seconds", 0)


def sample_price(api, row, resolved, outcome, seconds):
    cutoff = resolved - seconds
    if reason := market_unavailable(row, cutoff):
        return {"cutoff": cutoff, "missing": reason}
    max_age = min(36 * HOUR, max(30, seconds // 2))
    as_of = cutoff
    bucket = int(time() // 1800)
    for _ in range(2):
        stamp, price, width = prior_observation(api, row["yes_token"], as_of, bucket)
        if not isinstance(stamp, int) or not isinstance(price, (int, float)) or not isfinite(price) or not 0 <= price <= 1:
            break
        if not isinstance(width, int) or width < 0 or stamp > cutoff or cutoff - stamp > max_age:
            break
        # An unfinished bucket may include prints after the cutoff.
        if stamp + width > cutoff:
            as_of = stamp - 1
            continue
        return {"cutoff": cutoff, "observed_at": stamp, "price": price,
                "favorite_correct": (price > .5) == bool(outcome) if price != .5 else None,
                "vs_even": round(100 * (price - .5), 4), "outcome_delta": round(100 * (outcome - price), 4)}
    return {"cutoff": cutoff, "missing": "No recent price before this cutoff"}


def score(cases, seconds):
    rows = [(case, case["prices"][str(seconds)]) for case in cases if "price" in case["prices"][str(seconds)]]
    count = len(rows)
    events = len({case["event"] for case, _ in rows})
    right = sum(quote["favorite_correct"] is True for _, quote in rows)
    wrong = sum(quote["favorite_correct"] is False for _, quote in rows)
    output = {"seconds": seconds, "count": count, "events": events, "average_error": None,
              "right": right, "wrong": wrong, "ties": count - right - wrong,
              "brier_skill": None, "favored_won": None, "calibration": []}
    if count < 5 or events < 3:
        return output
    error = sum(abs(case["outcome"] - quote["price"]) for case, quote in rows) / count
    brier = sum((case["outcome"] - quote["price"]) ** 2 for case, quote in rows) / count
    output.update(average_error=round(error * 100, 2), brier_skill=round(100 * (1 - brier / .25), 2),
                  favored_won=round(100 * right / (right + wrong), 1) if right + wrong else None)
    for low in range(0, 100, 20):
        band = [(case, quote) for case, quote in rows if low <= quote["price"] * 100 < low + 20 or
                (low == 80 and quote["price"] == 1)]
        events_in_band = len({case["event"] for case, _ in band})
        if len(band) >= 5 and events_in_band >= 3:
            yes_count = sum(case["outcome"] for case, _ in band)
            output["calibration"].append({"from": low, "to": low + 20, "count": len(band), "events": events_in_band,
                                          "mean_price": round(100 * sum(quote["price"] for _, quote in band) / len(band), 1),
                                          "yes_won": round(100 * yes_count / len(band), 1), "yes_count": yes_count})
    return output


def comparison_sample(entries, target, limit, broader_slots):
    # Complete one pass across distinct events before taking another threshold from any of them.
    focused, broader = [], []
    event_counts = {}

    def diversity(entry):
        row, reason, *_ = entry
        key = (reason in BROADER_MATCHES, row["event"])
        number = event_counts.get(key, 0)
        event_counts[key] = number + 1
        return number, not similar_duration(target, row)

    for entry in sorted(entries, key=diversity):
        group = broader if entry[1] in BROADER_MATCHES else focused
        group.append(entry)
    focused_count = min(len(focused), limit - min(len(broader), broader_slots))
    return focused[:focused_count] + broader[:limit - focused_count]


@lru_cache(maxsize=64)
def study(slug, scope, api, bucket):
    target = target_market(slug)
    if not target:
        return None
    defaults = horizon_offsets(target["duration"])
    overview = {**summary(target), "context": target["context"]}
    cutoff = int(time())
    if target["closed"]:
        rows = api("resolutions", {"condition": target["condition"]})["data"] or []
        record = next((row for row in rows if row["condition_id"] == target["condition"]), {})
        target_resolution = settlement(target, record)
        if not target_resolution:
            return {"target": overview, "cases": [], "horizons": [score([], offset) for offset in defaults],
                    "default_horizons": defaults,
                    "matched": 0, "unusable": 0, "truncated": False, "status": "target_unverified"}
        cutoff, outcome = target_resolution
        overview["resolution"] = {"at": cutoff, "outcome": "Yes" if outcome else "No"}

    markets, more = candidate_markets(target, scope)
    matches = []
    for row in markets:
        reason = match(target, row, scope)
        if reason and row["condition"] != target["condition"] and (not row["listed"] or row["listed"] < cutoff):
            matches.append((row, reason))

    matches.sort(key=lambda item: (similar_duration(target, item[0]), item[0]["closed_at"] or item[0]["listed"] or 0), reverse=True)
    more |= len(matches) > MAX_MATCHES
    candidates = comparison_sample(matches, target, MAX_MATCHES, 30)
    conditions = [row["condition"] for row, _ in candidates]

    def fetch_resolutions(start):
        return api("resolutions", {"condition": ",".join(conditions[start:start + 20])})["data"] or []

    with ThreadPoolExecutor(max_workers=6) as pool:
        resolutions = {row["condition_id"]: row for rows in pool.map(fetch_resolutions, range(0, len(conditions), 20))
                       for row in rows}
    eligible = []
    for row, reason in candidates:
        result = settlement(row, resolutions.get(row["condition"], {}))
        if result and result[0] < cutoff:
            eligible.append((row, reason, *result))
    # Keep the broader history when the comparable-duration sample spans too few events.
    duration_coverage = {
        is_broader: len({row["event"] for row, reason, *_ in eligible
                         if (reason in BROADER_MATCHES) == is_broader and similar_duration(target, row)})
        for is_broader in (False, True)
    }
    total_eligible = len(eligible)
    eligible = [entry for entry in eligible if target["swiss_vote"] or
                duration_coverage[entry[1] in BROADER_MATCHES] < 3 or similar_duration(target, entry[0])]
    excluded = total_eligible - len(eligible)
    eligible.sort(key=lambda entry: (similar_duration(target, entry[0]), entry[2]), reverse=True)
    selected = comparison_sample(eligible, target, MAX_CASES, 6)
    selected.sort(key=lambda entry: (entry[1] not in BROADER_MATCHES,
                                     similar_duration(target, entry[0]), entry[2]), reverse=True)
    offsets = defaults + extended_offsets(defaults, selected)
    cases = []
    failed = 0
    with ThreadPoolExecutor(max_workers=10) as pool:
        for row, reason, resolved, outcome in selected:
            case = {**summary(row), "condition": row["condition"], "event": row["event"],
                    "reason": reason, "broader": reason in BROADER_MATCHES,
                    "resolved_at": resolved, "outcome": outcome, "prices": {}}
            for offset in offsets:
                case["prices"][str(offset)] = pool.submit(sample_price, api, row, resolved, outcome, offset)
            cases.append(case)
        for case in cases:
            for day, job in case["prices"].items():
                try:
                    case["prices"][day] = job.result()
                except UPSTREAM:
                    failed += 1
                    case["prices"][day] = {"missing": "Polymarket price request failed"}
    horizons = [score(cases, offset) for offset in offsets]
    horizons = [row for row in horizons if row["seconds"] in defaults or row["count"] > 0]
    status = ("useful" if any(row["count"] >= 12 and row["events"] >= 5 for row in horizons)
              else "limited" if any(row["average_error"] is not None for row in horizons)
              else "insufficient" if cases else "no_cases")
    return {"target": overview, "cases": cases, "horizons": horizons, "default_horizons": defaults, "matched": len(eligible),
            "unusable": len(candidates) - len(eligible) - excluded, "other_duration": excluded,
            "truncated": more or len(eligible) > MAX_CASES,
            "failed_quotes": failed, "status": status}


def compare_markets(slug, scope, wallet, api, pages):
    result = study(slug, scope, api, int(time() // 1800))
    if not result:
        return None
    target = result["target"]
    context = target["context"]
    if not target["closed"]:
        try:
            fresh = market_context(recent_market(slug))
            context = {**fresh, "scheduled_end": fresh["scheduled_end"] or context["scheduled_end"]}
        except UPSTREAM:
            context = {**context, "prices": {}}
    traded = set()
    wallet_available = bool(wallet)
    if wallet and result["cases"]:
        try:
            for rows, _ in pages("trades", {"user": wallet.lower(), "limit": 1000, "start": 1}):
                traded.update(row.get("condition_id") for row in rows)
        except UPSTREAM:
            wallet_available = False
    return {**result, "target": {**target, "closed": context["state"] == "closed", "context": context},
            "scope": scope, "wallet_available": wallet_available,
            "cases": [{**row, "traded": row["condition"] in traded if wallet_available else None}
                      for row in result["cases"]]}
