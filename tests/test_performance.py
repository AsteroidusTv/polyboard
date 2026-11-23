import unittest
from concurrent.futures import Future, ThreadPoolExecutor
from io import BytesIO
from threading import Event
from unittest.mock import Mock, patch

import holders
import market_images
import server
from read_cache import ReadCache


class ReadCacheTests(unittest.TestCase):
    def test_concurrent_requests_share_one_load(self):
        loading, waiting, release = Event(), Event(), Event()

        class ObservableFuture(Future):
            def result(self, timeout=None):
                waiting.set()
                return super().result(timeout)

        def load():
            loading.set()
            if not release.wait(5):
                self.fail("The test did not release the producer")
            return 42

        cache = ReadCache(4)
        loader = Mock(side_effect=load)
        with patch("read_cache.Future", ObservableFuture), ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(cache.read, "wallet", loader, ttl=10)
            try:
                self.assertTrue(loading.wait(5))
                second = pool.submit(cache.read, "wallet", loader, ttl=10)
                self.assertTrue(waiting.wait(5))
            finally:
                release.set()
            self.assertEqual(first.result(), (42, "MISS"))
            self.assertEqual(second.result(), (42, "SHARED"))
        loader.assert_called_once()

    def test_expiry_manual_refresh_and_incomplete_data(self):
        cache = ReadCache(1)
        loader = Mock(side_effect=[1, 2, 3, 4, ValueError("unavailable"), 5])
        with patch("read_cache.monotonic", return_value=100) as clock:
            self.assertEqual(cache.read("wallet", loader, ttl=5), (1, "MISS"))
            self.assertEqual(cache.read("wallet", loader, ttl=5), (1, "HIT"))
            self.assertEqual(cache.read("wallet", loader, ttl=5, refresh=True), (2, "REFRESH"))
            clock.return_value = 106
            self.assertEqual(cache.read("wallet", loader, ttl=5, cache_if=lambda _: False), (3, "MISS"))
            self.assertEqual(cache.read("wallet", loader, ttl=5), (4, "MISS"))
            with self.assertRaises(ValueError):
                cache.read("wallet", loader, ttl=5, refresh=True)
            self.assertEqual(cache.read("wallet", loader, ttl=5), (5, "MISS"))

    def test_html_versions_styles_and_scripts_but_leaves_sw_url_stable(self):
        html = b'<link href="/style.css"><script src="/watchlist-sw.js"></script><script src="/app.js"></script>'
        revised = server.version_links(html)
        for path in ("style.css", "app.js"):
            _, digest = server.static_file(path)
            self.assertIn(f'"/{path}?v={digest}"'.encode(), revised)
        self.assertIn(b'"/watchlist-sw.js"', revised)

    def test_wallet_timeline_and_summary_share_settlement_reads(self):
        calls = Mock(return_value=[])
        with (patch.object(server, "POSITION_SETTLEMENTS", ReadCache(20)),
              patch.object(server, "wallet_rows", calls),
              patch.object(server, "fetch_wallet_pnl", return_value=[])):
            wallet = "0x" + "1" * 40
            server.fetch_portfolio_events(wallet)
            server.fetch_trade_summary(wallet)
            settlement_calls = [call for call in calls.call_args_list if (
                call.args[1] == "positions" and call.kwargs.get("status") in server.ORDINARY_SETTLEMENTS or
                call.args[1] == "positions/combos" and call.kwargs.get("status") in server.COMBO_SETTLEMENTS)]
            self.assertEqual(len(settlement_calls), 5)
            server.fetch_trade_summary(wallet, refresh=True)
            self.assertEqual(calls.call_args_list.count(settlement_calls[0]), 2)


class HolderBatchTests(unittest.TestCase):
    def test_compact_roster_preserves_totals_and_snapshot_rows(self):
        rows = [{"wallet": rank} for rank in range(16)]
        snapshot = {"snapshot": "sample", "sides": [{"rows": rows, "shares": 40}, {"rows": [], "shares": 0}]}
        compact = holders.compact_roster(snapshot)
        first, second = compact["sides"]
        self.assertEqual((len(first["rows"]), first["holder_count"], first["shares"]), (12, 16, 40))
        self.assertEqual(second["holder_count"], 0)
        handler = Mock()
        with patch.object(holders, "get_snapshot", return_value=snapshot):
            holders.serve(handler, {"market": ["market"], "view": ["page"], "snapshot": ["sample"], "offset": ["12"]})
        handler.send_json.assert_called_once_with(200, {"offset": 12, "rows": rows[12:]}, None)

    def test_compact_profiles_leave_cached_detail_available(self):
        original = {"history": {"profit": 3}, "recent_positions": ["detail"],
                    "similar": {"right": 2, "rows": ["pick"]}}
        self.assertEqual(holders.compact_profile(original), {"history": {"profit": 3}, "similar": {"right": 2}})
        self.assertEqual(original["recent_positions"], ["detail"])
        self.assertEqual(original["similar"]["rows"], ["pick"])

    def test_initial_history_keeps_grading_and_defers_similar_lookup(self):
        wallet = "0x" + "1" * 40
        market = {"condition": "0x" + "a" * 64, "closed": False, "resolved_at": None, "closed_at": None}
        earlier = "0x" + "b" * 64
        position = {"condition_id": earlier, "token_id": "2", "last_event_at": 21, "first_entry_at": 11,
                    "outcome_index": 0, "outcome": "Yes", "realized_pnl": 5}
        winners = {earlier: {"resolved_at": 30, "winner": 0}}
        with (patch.object(holders, "wallet_history", return_value=([("CLOSED", position)], [True] * 3)) as history,
              patch.object(holders, "verified_winners", return_value=winners),
              patch.object(holders, "observed_buys", return_value={earlier: {0: 12}}),
              patch.object(holders, "comparable_markets", return_value={}) as similar):
            data = holders.performance(market, [{"wallet": wallet}], "focused", "history")
            profile, = data["profiles"]
            self.assertEqual(profile["recent"]["profit"], 1)
            self.assertEqual(profile["recent_direction"]["right"], 1)
            similar.assert_not_called()
            match = holders.performance(market, [{"wallet": wallet}], "focused", "similar")
            self.assertEqual(match["similar_markets"], 0)
            self.assertEqual(match["profiles"][0]["similar"]["right"], 0)
            history.assert_called_once_with(wallet)


class MarketImageTests(unittest.TestCase):
    def test_only_supported_polymarket_object_names_are_downloaded(self):
        self.assertIsNotNone(market_images.FILENAME.fullmatch("fr27-david-lisnard-04e491dec1.jpg"))
        for name in ("../private.jpg", "//elsewhere.test/photo.jpg", "image.svg", "image.jpg?other=1"):
            with patch.object(market_images.DOWNLOAD, "open") as download, self.assertRaises(ValueError):
                market_images.thumbnail(name)
            download.assert_not_called()

    @unittest.skipUnless(market_images.ENABLED, "Optional WebP conversion is unavailable")
    def test_resize_preserves_aspect_ratio_and_transparency(self):
        original = market_images.Image.new("RGBA", (512, 256), (24, 80, 180, 120))
        content = BytesIO()
        original.save(content, "PNG")
        with market_images.Image.open(BytesIO(market_images.resize(content.getvalue()))) as result:
            self.assertEqual(result.size, (128, 64))
            self.assertEqual(result.format, "WEBP")
            self.assertEqual(result.getpixel((32, 32))[3], 120)
