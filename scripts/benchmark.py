"""Measure public dashboard requests and verify that they returned usable data."""

import argparse
import gzip
import json
import re
import sys
from datetime import datetime, timezone
from statistics import median
from time import perf_counter
from urllib.parse import urlencode
from urllib.request import Request, urlopen


DEFAULT_MARKET = "will-david-lisnard-win-the-2027-french-presidential-election"


def run(args):
    timings = {}
    coverage = {}
    base = args.url.rstrip("/")

    def measure(name, path, params=None, field=None):
        samples = []
        timings[name] = samples
        url = base + path + ("?" + urlencode(params) if params else "")
        for _ in range(args.samples):
            request = Request(url, headers={"Accept-Encoding": "gzip", "User-Agent": "PolyboardBenchmark/1.0"})
            started = perf_counter()
            with urlopen(request, timeout=45) as response:
                data = response.read()
                latency = round((perf_counter() - started) * 1000, 1)
                samples.append({"ms": latency, "bytes": len(data), "cache": response.headers.get("X-Polyboard-Cache")})
                if response.headers.get("Content-Encoding") == "gzip":
                    data = gzip.decompress(data)
            if field:
                data = json.loads(data)
                if not isinstance(data.get(field), list):
                    raise ValueError(f"{name} did not return a {field} list")
        return data

    html = measure("portfolio_page", "/")
    asset = re.search(rb'<script src="(/app\.js[^"]*)"', html)
    if not asset:
        raise ValueError("The portfolio script is missing")
    measure("portfolio_script", asset[1].decode())
    catalog = measure("market_catalog", "/api/markets", {"preview": 1}, "events")
    coverage["catalog_events"] = len(catalog["events"])
    if args.wallet:
        wallet = {"wallet": args.wallet}
        measure("wallet_positions", "/api/positions", wallet, "positions")
        measure("wallet_pnl", "/api/portfolio-history", wallet, "points")
        summary = measure("wallet_trade_summary", "/api/trade-summary", wallet, "positions")
        if summary.get("partial"):
            raise ValueError("Trade summary returned incomplete data")
        measure("wallet_executions", "/api/trades", wallet, "trades")
    roster = measure("holder_roster", "/api/holders", {"market": args.market, "limit": args.cohort, "compact": 1}, "sides")
    with_holders = next((i for i, group in enumerate(roster["sides"]) if group["rows"]), None)
    if with_holders is not None:
        group = roster["sides"][with_holders]
        total = group["holder_count"]
        if len(group["rows"]) != min(total, 12):
            raise ValueError("The initial holder list did not return one page")
        coverage["holders_in_sample"] = total
        if total > 12:
            offset = ((total - 1) // 12) * 12
            tail = measure("holder_page", "/api/holders", {"market": args.market, "snapshot": roster["snapshot"],
                           "view": "page", "side": with_holders, "offset": offset}, "rows")
            if len(tail["rows"]) != total - offset:
                raise ValueError("The last holder page was incomplete")
        profiles = measure("first_holder_batch", "/api/holders", {"market": args.market, "snapshot": roster["snapshot"],
                           "view": "performance", "side": with_holders, "part": "history", "take": 4, "compact": 1}, "profiles")
        expected = min(4, total)
        if len(profiles["profiles"]) != expected or not any(row["history_available"] for row in profiles["profiles"]):
            raise ValueError("The first holder batch did not return usable histories")
        coverage["holders_analyzed"] = expected
    else:
        coverage["holders_analyzed"] = 0
    filename = (roster["market"].get("image") or "").removeprefix("https://polymarket-upload.s3.us-east-2.amazonaws.com/")
    if b"<body data-market-thumbnails" in html and re.fullmatch(r"[\w-][\w.-]{0,190}\.(?:png|jpe?g|webp)", filename, re.I | re.ASCII):
        image = measure("market_thumbnail", "/media/market/v1/" + filename)
        if image[:4] != b"RIFF" or image[8:12] != b"WEBP":
            raise ValueError("The market thumbnail was not served as WebP")
    chart = measure("market_chart", "/api/market-history", {"token": roster["market"]["tokens"][0]}, "points")
    if chart.get("price_error"):
        raise ValueError("The market chart could not read prices")
    comparison = measure("market_precedents", "/api/precedents", {"market": args.precedent_market or args.market,
                         "horizons": "default"}, "cases")
    if comparison.get("failed_quotes"):
        raise ValueError("Market precedents returned missing upstream price responses")
    coverage["precedents"] = len(comparison["cases"])
    return {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "url": base, "market": args.market,
            "precedent_market": args.precedent_market or args.market, "coverage": coverage,
            "results": {name: {"first_ms": samples[0]["ms"],
                               "repeat_median_ms": median(s["ms"] for s in samples[1:]) if len(samples) > 1 else None,
                               "samples": samples} for name, samples in timings.items()}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8765")
    parser.add_argument("--market", default=DEFAULT_MARKET)
    parser.add_argument("--cohort", choices=("25", "50", "100", "1000", "all"), default="50")
    parser.add_argument("--precedent-market", help="Use a separate market with known historical comparisons")
    parser.add_argument("--wallet", help="Also verify positions, P&L and trade history for a public wallet")
    parser.add_argument("--samples", type=int, choices=range(1, 6), default=3)
    args = parser.parse_args()
    try:
        print(json.dumps(run(args), indent=2))
    except (OSError, ValueError, TypeError, KeyError, IndexError) as error:
        sys.exit(f"Benchmark failed: {error}")


if __name__ == "__main__":
    main()
