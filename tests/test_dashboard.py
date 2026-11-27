import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event
from time import time
from unittest.mock import patch
from urllib.error import URLError

import market_catalog
import precedents
import review_server
import resolution_rules
import server
import watchlist
from public_api import market_exposure, snapshot
from trade_summary import build_trade_summary


def temperature(label, event):
    return {"title": label, "label": label, "event": event, "duration": 86400}


class PrecedentTests(unittest.TestCase):
    def test_selects_comparable_thresholds_without_reading_the_outcome(self):
        target = temperature("14°C", "upcoming")
        upper = temperature("20°C or higher", "yesterday")
        exact = temperature("14°C", "yesterday")
        next_day = temperature("13°C", "previous")
        rows = [(upper, "Same event series", 10, 0), (exact, "Same event series", 10, 1),
                (next_day, "Same event series", 9, 0)]
        chosen = precedents.comparison_sample(rows, target, 2, 0)
        self.assertEqual([entry[0] for entry in chosen], [exact, next_day])

    def test_one_sided_sample_does_not_count_as_predictive_evidence(self):
        cases = [{"event": str(i), "outcome": 0, "prices": {}}
                 for i in range(24)]
        base = {"cases": cases, "failed_quotes": 0, "horizons": [], "default_horizons": [3600]}
        with patch.object(precedents, "sample_price", return_value={"price": 0.0005, "favorite_correct": True}):
            report = precedents.study_prices(base | {"cases": [
                row | {"resolved_at": 10000} for row in cases
            ]}, [3600], None)
        result = report["horizons"][0]
        self.assertEqual((result["right"], result["majority"], result["net_correct"]), (24, 24, 0))
        self.assertIsNone(result["brier_skill"])
        self.assertEqual(report["status"], "one_sided")
        self.assertFalse(cases[0]["prices"])

    def test_unfinished_price_bucket_is_never_used(self):
        market = {"listed": 1, "closed_at": None, "yes_token": "42"}
        with patch.object(precedents, "prior_observation", side_effect=[(8999, 1, 60), (8960, 0.55, 20)]) as quote:
            sample = precedents.sample_price(None, market, 9900, 1, 900)
        self.assertEqual(sample["price"], 0.55)
        self.assertEqual(quote.call_args.args[2], 8998)


class PortfolioTests(unittest.TestCase):
    def test_open_trade_summary_preserves_remaining_shares_for_payout(self):
        position = {"token_id": "2", "status": "OPEN", "current_size": 6, "total_size": 10, "current_value": 2.4}
        result, = build_trade_summary([position], [], [])
        self.assertEqual(result["current_size"], 6)
        self.assertEqual(result["outstanding"], 2.4)

    def test_partial_sale_and_final_payout_do_not_count_twice(self):
        activity = [{"token_id": "2", "condition_id": "a", "type": kind, "side": side,
                     "size": shares, "usdc_size": amount, "price": amount / shares, "timestamp": index}
                    for index, (kind, side, shares, amount) in enumerate([
                        ("TRADE", "BUY", 10, 4.2), ("TRADE", "SELL", 4, 2.4), ("REDEEM", None, 6, 6)
                    ], 1)]
        result, = build_trade_summary([], [], activity)
        self.assertAlmostEqual(result["pnl"], 4.2)
        self.assertEqual((result["status"], result["exit_price"], result["settlement_price"]), ("won", 0.6, 1))

    def test_partial_history_keeps_available_position_with_reported_pnl(self):
        def wallet_rows(_wallet, resource, **filters):
            if resource == "activity":
                raise URLError("upstream down")
            if resource == "positions" and filters["status"] == "CLOSED":
                return [{"token_id": "2", "status": "CLOSED", "realized_pnl": 3}]
            return []

        with patch.object(server, "wallet_rows", side_effect=wallet_rows), patch.object(server, "fetch_wallet_pnl", return_value=[]):
            report = server.fetch_trade_summary("wallet")
        self.assertTrue(report["partial"])
        self.assertEqual(report["positions"][0]["pnl_source"], "polymarket")
        self.assertEqual(report["positions"][0]["pnl"], 3)

    def test_event_exposure_groups_different_conditions(self):
        positions = [{"condition_id": key, "event_slug": "election", "market": key,
                      "current_value_usd": 5, "cost_basis_usd": 4} for key in ("a", "b")]
        event, = market_exposure(positions, 10, by_event=True)
        self.assertEqual((event["market_count"], event["share_of_open_value_pct"]), (2, 100))
        self.assertEqual(len(market_exposure(positions, 10)), 2)

    def test_public_portfolio_keeps_positions_when_trades_are_unavailable(self):
        def unavailable(*args):
            raise URLError("trades feed unavailable")

        result, _ = snapshot("/portfolio", "wallet-with-unavailable-trades", 250, "",
                             lambda _wallet: [{"status": "OPEN", "title": "Market"}], unavailable)
        self.assertEqual(result["positions"][0]["market"], "Market")
        self.assertEqual(result["recent_trades"], [])
        self.assertFalse(result["recent_trades_available"])


class WatchlistTests(unittest.TestCase):
    def test_follow_with_alert_only_saves_when_alert_is_valid(self):
        market = {"slug": "market", "title": "Market", "state": "open", "outcomes": [{"token_id": "1", "label": "Yes"}]}
        alert = {"token": "1", "direction": "above", "kind": "change", "value": "150"}
        with TemporaryDirectory() as folder, patch.object(watchlist, "market_details", return_value=market):
            store = watchlist.Watchlist(Path(folder))
            with patch.object(watchlist, "quote_batch", return_value={"1": "0.40"}):
                watchlist.watch_preview("market")
                self.assertEqual(store.read("browser")["watches"], [])
                with self.assertRaises(watchlist.RequestError):
                    store.mutate("browser", {"action": "follow", "slug": "market", "alert": alert})
                self.assertEqual(store.read("browser")["watches"], [])
                result = store.mutate("browser", {"action": "follow", "slug": "market", "alert": {**alert, "value": "25"}})
            saved = result["watches"]
            self.assertEqual(len(saved), 1)
            self.assertEqual([(row["baseline"], row["target"]) for row in saved[0]["alerts"]], [("0.40", "0.5")])

    def test_journal_survives_unfollow_and_is_private_to_the_browser(self):
        market = {"slug": "market", "title": "Market", "state": "open",
                  "outcomes": [{"token_id": "1", "label": "Yes"}]}
        follow_id = "40dd2db9-358e-49f7-92f0-8b58d6780cc1"
        note = {"action": "journal", "slug": "market", "kind": "update",
                "note_id": "219cb41b-b26f-4c52-bdc2-592a9f40a00f", "body": "Thesis still holds."}
        alert = {"token": "1", "direction": "above", "kind": "price", "value": "50"}
        with TemporaryDirectory() as folder, patch.object(watchlist, "market_details", return_value=market), (
                patch.object(watchlist, "quote_batch", return_value={"1": "0.40"})):
            store = watchlist.Watchlist(Path(folder))
            follow = {"action": "follow", "slug": "market", "alert": alert,
                      "note": {"note_id": follow_id, "body": "  Wait for the official ruling.  "}}
            with self.assertRaises(watchlist.RequestError):
                store.mutate("browser", {**follow, "alert": {**alert, "value": "101"}})
            self.assertEqual(store.read_journal("browser", "market")["entries"], [])
            store.mutate("browser", follow)
            self.assertEqual(len(store.mutate("browser", follow)["watches"][0]["alerts"]), 1)
            store.mutate("browser", note)
            store.mutate("browser", note)
            store.mutate("browser", {"action": "unfollow", "slug": "market"})
            reopened = watchlist.Watchlist(Path(folder))
            entries = reopened.read_journal("browser", "market")["entries"]
            self.assertEqual([(entry["kind"], entry["body"]) for entry in entries], [
                ("follow", "Wait for the official ruling."), ("update", "Thesis still holds.")])
            self.assertEqual(reopened.read_journal("other-browser", "market")["entries"], [])
            self.assertEqual(reopened.read("browser")["watches"], [])

    def test_order_note_migrates_the_existing_market_journal(self):
        with TemporaryDirectory() as folder:
            path = Path(folder) / "watchlist.sqlite3"
            with sqlite3.connect(path) as db:
                db.execute("CREATE TABLE journal (session TEXT, note_id TEXT, market TEXT, kind TEXT, body TEXT, "
                           "created INTEGER, PRIMARY KEY (session, note_id))")
                db.execute("INSERT INTO journal VALUES (?, ?, ?, ?, ?, ?)",
                           ("browser", "original", "market", "follow", "Original reason", 1))
            store = watchlist.Watchlist(Path(folder))
            order_id = "0x" + "f" * 64
            data = {"action": "journal", "slug": "market", "kind": "trade", "body": "New reason", "order_id": order_id,
                    "note_id": "40dd2db9-358e-49f7-92f0-8b58d6780cc1"}
            with self.assertRaises(watchlist.RequestError):
                store.mutate("browser", {**data, "kind": "update"})
            entries = store.mutate("browser", data)["entries"]
            self.assertEqual([(note["body"], note["order_id"]) for note in entries],
                             [("Original reason", None), ("New reason", order_id)])

    def test_stale_quote_and_market_closure_keep_follow_without_firing(self):
        market = {"slug": "market", "title": "Market", "state": "open", "outcomes": [
            {"token_id": "1", "label": "Yes"}, {"token_id": "2", "label": "No"}
        ]}
        with TemporaryDirectory() as folder, patch.object(watchlist, "market_details", return_value=market):
            store = watchlist.Watchlist(Path(folder))
            with patch.object(watchlist, "time", return_value=time() - 240), patch.object(watchlist, "quote_batch", return_value={"1": "0.40"}):
                store.mutate("browser", {"action": "follow", "slug": "market"})
                store.mutate("browser", {"action": "add-alert", "slug": "market", "token": "1",
                                         "direction": "above", "kind": "price", "value": "50"})
            self.assertFalse(store.read("browser")["watches"][0]["quotes"]["1"]["fresh"])
            with patch.object(watchlist, "recent_market", return_value={"closed": True}), patch.object(watchlist, "quote_batch", return_value={"1": "0.60"}) as quote:
                store.check_prices()
            quote.assert_not_called()
            report = store.read("browser")
            self.assertEqual(report["watches"][0]["state"], "closed")
            self.assertIsNone(report["watches"][0]["alerts"][0]["fired"])
            self.assertEqual(report["notices"], [])

    def test_fresh_open_market_fires_once_on_crossing(self):
        market = {"slug": "market", "title": "Market", "state": "open", "outcomes": [{"token_id": "1", "label": "Yes"}]}
        with TemporaryDirectory() as folder, patch.object(watchlist, "market_details", return_value=market):
            store = watchlist.Watchlist(Path(folder))
            with patch.object(watchlist, "quote_batch", return_value={"1": "0.40"}):
                store.mutate("browser", {"action": "follow", "slug": "market"})
            store.mutate("browser", {"action": "add-alert", "slug": "market", "token": "1",
                                     "direction": "above", "kind": "price", "value": "50"})
            with patch.object(watchlist, "recent_market", return_value={"acceptingOrders": True}), patch.object(watchlist, "quote_batch", return_value={"1": "0.60"}):
                store.check_prices()
                store.check_prices()
            self.assertEqual(len(store.read("browser")["notices"]), 1)


class MarketCatalogTests(unittest.TestCase):
    def test_event_order_uses_prices_dates_or_yes_probability(self):
        cases = [
            ([("↑ 75,000", 0.8), ("↓ $55,000", 0.05), ("$58k–$60k", 0.1), ("Below $50k", 0.15)],
             ["Below $50k", "↓ $55,000", "$58k–$60k", "↑ 75,000"]),
            ([("Jan 15, 2027", 0.8), ("by November 30, 2026", 0.1), ("31 Dec 2026", 0.5), ("Other", 0.9)],
             ["by November 30, 2026", "31 Dec 2026", "Jan 15, 2027", "Other"]),
            ([("Casey", 0.1), ("Morgan", 0.7), ("Taylor", 0.2), ("Unknown", None)],
             ["Morgan", "Taylor", "Casey", "Unknown"]),
        ]
        for choices, expected in cases:
            with self.subTest(expected=expected):
                rows = [{"slug": f"option-{index}", "question": "Will this option win?", "groupItemTitle": label,
                         "active": True, "acceptingOrders": True, "clobTokenIds": ["1", "2"],
                         "outcomes": ["No", "Yes"], "outcomePrices": [None if yes is None else 1 - yes, yes]}
                        for index, (label, yes) in enumerate(choices)]
                event = {"slug": "event", "title": "Choose an outcome", "markets": rows}
                with patch.object(market_catalog, "gamma_by_slug", return_value=event):
                    card, = market_catalog.browse_markets({"event": ["event"]})["events"]
                self.assertEqual([market["label"] for market in card["markets"]], expected)

    def test_search_preview_keeps_matching_submarket_and_drops_unrelated_results(self):
        def candidate(slug, title, price):
            return {"slug": slug, "question": title, "active": True, "acceptingOrders": True,
                    "outcomes": ["Yes", "No"], "clobTokenIds": ["1", "2"], "outcomePrices": [price, 1 - price]}

        event = {"slug": "election", "title": "Presidential election", "markets": [
            candidate("candidate-alvarez", "Will Candidate Álvarez win?", 0.01),
            candidate("candidate-brown", "Will Candidate Brown win?", 0.70),
        ]}
        with patch.object(market_catalog, "search_event_page", return_value=([event], False)):
            def search(query):
                return market_catalog.browse_markets({"q": [query], "preview": ["1"]})["events"]

            matches = search("Candidate Alvarez")
            self.assertEqual([market["slug"] for market in matches[0]["markets"]], ["candidate-alvarez"])
            self.assertEqual(matches[0]["matching_market_count"], 1)
            self.assertEqual(search("Candidate Alva"), matches)
            self.assertEqual(search("unrelated-candidate"), [])
            self.assertEqual(search("Presidential election")[0]["matching_market_count"], 2)

    def test_search_suggestions_use_one_page_and_return_one_market_per_event(self):
        market = {"slug": "rate-a", "question": "Rate A", "active": True, "acceptingOrders": True,
                  "outcomes": ["Yes", "No"], "clobTokenIds": ["1", "2"], "outcomePrices": [0.4, 0.6]}
        events = [{"slug": f"inflation-{index}", "title": f"Inflation {index}", "markets": [
            market, {**market, "slug": "rate-b", "question": "Rate B"},
        ]} for index in range(8)]
        with patch.object(market_catalog, "search_event_page", return_value=(events, True)) as upstream:
            preview = market_catalog.browse_markets({"q": ["Inflati"], "suggest": ["1"]})
        self.assertIsNone(preview["next_cursor"])
        self.assertEqual(len(preview["events"]), 6)
        self.assertTrue(all(len(event["markets"]) == 1 for event in preview["events"]))
        upstream.assert_called_once_with("Inflati", 1, status="active", keep_closed_markets=0,
                                        limit_per_type=market_catalog.PAGE_SIZE)


class ReviewTests(unittest.TestCase):
    def test_resolution_report_exposes_only_flags_quoting_the_official_rules(self):
        target = review_server.review_target("", "resolution", "market")
        self.assertEqual(target, ("", "resolution", "market", ""))
        with self.assertRaises(ValueError):
            review_server.review_target("", "resolution", "../market")
        raw = {"question": "Will it happen?", "events": [{"slug": "parent"}],
               "description": "Only official notices\nissued by June 1 count.",
               "endDate": "2026-06-01T00:00:00Z"}
        with patch.object(resolution_rules, "gamma_by_slug", return_value=raw):
            data = resolution_rules.resolution_details("market")
            self.assertEqual(data["market_url"], "https://polymarket.com/event/parent/market")
            self.assertIsNotNone(data["scheduled_end"])
            worker = review_server.Reviews("digest")
            job = {"state": "running", "started": review_server.monotonic(), "market": "market", "mode": "resolution"}
            worker.jobs[target] = job
            report = {"flags": [
                {"quote": "Only official notices issued by June 1 count.", "why": "An unofficial release does not count."},
                {"quote": "Any press report counts.", "why": "This quote was not in the rules."}
            ]}
            with patch.object(review_server, "analyze", return_value=report):
                worker.run(target, job)
        result = worker.status(*target)
        self.assertEqual(result["state"], "complete")
        self.assertEqual(result["report"]["flags"], report["flags"][:1])
        self.assertNotIn("rules", result["snapshot"])

    def test_queue_deduplicates_requests_and_completed_reports_survive_restart(self):
        release_first = Event()
        started = Event()
        finished = Event()
        finished_second = Event()

        class Worker(review_server.Reviews):
            def run(self, target, active):
                is_first = target[0] == "first"
                if is_first:
                    started.set()
                    release_first.wait(3)
                with self.lock:
                    active.update(state="complete", finished=review_server.monotonic())
                    self.persist(target, active)
                    self.start_next()
                (finished if is_first else finished_second).set()

        with TemporaryDirectory() as folder:
            path = Path(folder) / "jobs.sqlite3"
            worker = Worker("digest", path)
            worker.launch("first", "review")
            self.assertTrue(started.wait(3))
            self.assertEqual(worker.launch("second", "review")[1]["state"], "queued")
            self.assertEqual(worker.launch("second", "review")[1]["state"], "queued")
            self.assertEqual(len(worker.jobs), 2)
            self.assertEqual(review_server.Reviews("digest", path).status("second", "review")["state"], "failed")
            release_first.set()
            self.assertTrue(finished.wait(3))
            self.assertTrue(finished_second.wait(3))
            reopened = review_server.Reviews("digest", path)
            self.assertEqual(reopened.status("first", "review")["state"], "complete")
            self.assertEqual(reopened.status("second", "review")["state"], "complete")
