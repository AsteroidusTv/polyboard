"""Fetch the published resolution wording for a single Polymarket market."""
from datetime import datetime, timezone

from precedents import SLUG, epoch, gamma_by_slug


def resolution_details(slug):
    raw = gamma_by_slug("markets", slug)
    if not raw:
        return None
    event = next(iter(raw.get("events") or []), {})
    parent = event.get("slug") or slug
    if not SLUG.fullmatch(parent):
        parent = slug
    rules = (raw.get("description") or "").strip()
    return {
        "title": raw.get("question") or slug,
        "market_url": "https://polymarket.com/event/" + parent + ("/" + slug if parent != slug else ""),
        "resolution_source": raw.get("resolutionSource") or "",
        "scheduled_end": epoch(raw.get("endDate")),
        "rules": rules[:20000],
        "rules_truncated": len(rules) > 20000,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def supported_flags(report, rules):
    """Keep only flags backed by a verbatim quote from the published wording."""
    normalized = " ".join(rules.split())
    supported = []
    for flag in report.get("flags", []):
        quote = " ".join(flag["quote"].split())
        why = flag["why"].strip()
        if 8 <= len(quote) <= 360 and quote in normalized and 0 < len(why) <= 280:
            supported.append({"quote": quote, "why": why})
    return supported[:3]
