import unittest
from unittest.mock import patch

import holders
from precedents import resolved_winner
from review_server import review_target

YES = "1"
NO = "2"
CONDITION_A = "0x" + "a" * 64
WALLET_A = "0x" + "1" * 40
WALLET_B = "0x" + "2" * 40


class HolderTests(unittest.TestCase):
    def test_merges_cursor_pages_by_outcome_and_deduplicates_wallets(self):
        market = {"condition": CONDITION_A, "tokens": [YES, NO], "labels": ["Yes", "No"]}

        def page(_, params, **kwargs):
            first = {"proxy_wallet": WALLET_A, "amount": 12, "name": "Private", "display_username_public": False}
            second = {"proxy_wallet": WALLET_B, "amount": 9, "name": "Public", "display_username_public": True}
            if params.get("cursor"):
                return [{"token_id": YES, "holders": [first]}, {"token_id": NO, "holders": [second]}], None
            return [{"token_id": YES, "holders": [first, second]}], "page2"

        sides, complete, partial = holders.holder_rows(market, 2000, page)
        self.assertTrue(complete)
        self.assertFalse(partial)
        self.assertEqual([row["name"] for row in sides[0]["rows"]], ["", "Public"])
        self.assertEqual([row["wallet"] for row in sides[1]["rows"]], [WALLET_B])

    def test_profit_and_correct_direction_are_independent(self):
        position = {"condition_id": CONDITION_A, "token_id": YES, "last_event_at": 21, "first_entry_at": 11,
                    "outcome_index": 0, "outcome": "Yes", "realized_pnl": 5}
        grouped = holders.positions_by_market([("CLOSED", position)])
        winners = {CONDITION_A: {"resolved_at": 30, "winner": 1}}
        self.assertEqual(holders.economic_record(grouped)["profit"], 1)
        self.assertEqual(holders.comparable_record(grouped, winners)["wrong"], 1)
        self.assertEqual(holders.comparable_record(grouped, winners, {})["excluded"], 1)
        self.assertEqual(holders.comparable_record(grouped, winners, {CONDITION_A: {0: 12}})["wrong"], 1)
        self.assertEqual(holders.comparable_record(grouped, winners, {CONDITION_A: {0: 12, 1: 13}})["excluded"], 1)
        both = holders.positions_by_market([("CLOSED", position), ("CLOSED", position | {
            "token_id": NO, "outcome_index": 1, "outcome": "No", "realized_pnl": -6,
        })])
        self.assertEqual(holders.economic_record(both)["loss"], 1)
        self.assertEqual(holders.comparable_record(both, winners)["excluded"], 1)
        self.assertEqual(holders.comparable_record(both, winners)["wrong"], 0)

    def test_keeps_market_thumbnails_in_wallet_activity(self):
        icon = "https://polymarket.example/market.png"
        fallback = "https://polymarket.example/event.png"
        position = {"condition_id": CONDITION_A, "token_id": YES, "last_event_at": 21, "first_entry_at": 11,
                    "outcome_index": 0, "outcome": "Yes", "realized_pnl": 5, "icon": icon}
        market, = holders.positions_by_market([("CLOSED", position)])
        self.assertEqual(market["image"], icon)
        winners = {CONDITION_A: {"resolved_at": 30, "winner": 0, "image": fallback}}
        picks = holders.comparable_record([market | {"image": ""}], winners)
        self.assertEqual(picks["rows"][0]["image"], fallback)
        with patch.object(holders, "data_page", return_value=([{"title": "Trade", "icon": icon}], None)):
            fill, = holders.recent_fills(WALLET_A, {"closed": False})
        self.assertEqual(fill["image"], icon)

    def test_historical_view_excludes_future_settlement_and_future_activities(self):
        position = {"condition_id": CONDITION_A, "token_id": YES, "last_event_at": 10,
                    "outcome_index": 0, "outcome": "Yes", "total_pnl": 5, "realized_pnl": 2}
        results = {CONDITION_A: {"resolved_at": 21, "winner": 0}}
        self.assertEqual(holders.positions_by_market([("REDEEMABLE", position)], 20, results), [])
        self.assertEqual(holders.positions_by_market([("CLOSED", position | {"last_event_at": 25})], 20, results), [])
        self.assertEqual(holders.positions_by_market([("CLOSED", position)], 20, results)[0]["pnl"], 2)

    def test_reads_scaled_and_legacy_settlements_and_rejects_split_payouts(self):
        self.assertEqual(resolved_winner({"status": "resolved", "payouts": [0, 1000000],
                                          "last_update_timestamp": "123"}), (123, 1))
        self.assertIsNone(resolved_winner({"status": "resolved", "payouts": [500000, 500000],
                                          "last_update_timestamp": "123"}))

        def api(resource, params, **kwargs):
            if resource == "resolutions":
                return {"data": [{"condition_id": CONDITION_A, "status": "resolved", "last_update_timestamp": "123"}]}
            return {"data": [{"condition_id": CONDITION_A, "outcome_index": outcome,
                              "resolved": True, "final_price": payout}
                             for outcome, payout in enumerate([0, 1])]}

        with patch.object(holders, "RESOLUTIONS", holders.OrderedDict()), patch.object(holders, "data_request", side_effect=api):
            self.assertEqual(holders.verified_winners({CONDITION_A})[CONDITION_A],
                             {"resolved_at": 123, "winner": 1})

    def test_flow_flag_requires_complete_and_usable_reference_windows(self):
        end = 150000
        rows = [{"timestamp": end - offset * 3600 - minute * 60, "price": .5, "size": size,
                 "outcome_index": index, "side": side}
                for offset, size, index, side in [(8, 100, 1, "BUY"), (2, 1000, 1, "SELL")]
                for minute in range(20)]
        active = holders.flow_signal(rows, end, True)
        self.assertTrue(active["flag"])
        self.assertEqual(active["lean"], 0)
        self.assertEqual(active["volume_multiple"], 30)
        self.assertEqual(holders.flow_signal(rows, end, False)["state"], "insufficient")
        self.assertEqual(holders.flow_signal(rows[-20:], end, True)["state"], "insufficient")

    def test_holder_review_key_is_contextual_and_wallet_independent(self):
        self.assertEqual(review_target("", "holders", "market", "broad:1000"), ("", "holders", "market", "broad:1000"))
        with self.assertRaises(ValueError):
            review_target("", "holders", "market", "broad:99999")
