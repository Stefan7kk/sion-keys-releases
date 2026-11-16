"""Offline contracts; live validation is recorded separately in the handoff."""
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from chord_engine import lyrics as L, worship_sources as W


class WorshipTests(unittest.TestCase):
    def test_source_specific_navigation_and_unquoted_links(self):
        fixtures = {
            "propovedi": '<a href="/001/">1. Мир като река</a><a href="/001/">Duplicate excerpt</a>',
            "tekstove": '<a href="/2012/01/01/song/">Аз виждам Бог</a><a href="/home/">Home</a>',
            "duhovni": '<a href="pesen.php?id=177">177</a><a href="pesen.php?id=177">Авва, Отче!</a>',
            "trinity": '<br>Авва Отче, нека съм (A) - <a href="180.html">175</a>',
            "holytrinity": '<a href=?id=1>1. АЗ ВИЖДАМ БОГ</a><a href=?sort=abv>АБВ</a>',
            "vitania": '<a href="/2021/01/blog-post_16.html">ЩЕ ИЗВИКАМ АЗ КЪМ ТЕБЕ</a>',
        }
        for source, html in fixtures.items():
            with self.subTest(source=source):
                rows = W.parse_index(source, html)
                self.assertEqual(len(rows), 1)
                self.assertTrue(W.matches_title(rows[0], rows[0]["title"].lower()))
                self.assertEqual(rows[0]["language"], "bg")
                self.assertTrue(rows[0]["linkOnly"])
                self.assertEqual(rows[0]["plain"], "")

    def test_robots_denial_and_unavailable_do_not_fetch_content(self):
        with patch.object(W, "read_url", return_value="User-agent: *\nDisallow: /") as read:
            self.assertEqual(W.fetch_index("propovedi")[2], "robots-disallowed")
            self.assertEqual(read.call_count, 1)
        with patch.object(W, "read_url", side_effect=OSError("offline")):
            self.assertEqual(W.fetch_index("propovedi")[2], "unavailable")

    def test_combined_search_cache_rejection_and_lrclib(self):
        rows = W.parse_index("holytrinity", '<a href=?id=1>1. АЗ ВИЖДАМ БОГ</a>')
        meta = {"title": rows[0]["title"], "artist": "", "duration": 0, "language": "bg"}
        with tempfile.TemporaryDirectory() as folder, patch.object(W, "fetch_indexes", return_value=[("holytrinity", rows, "ready")]), patch.object(L, "get_json", return_value=[]):
            db = Path(folder)/"lyrics.db"
            def call(action, **extra):
                return L.dispatch(db, dict(action=action, song="test", metadata=meta, **extra))
            result = call("search")
            self.assertEqual(result["candidates"][0]["id"], rows[0]["id"])
            self.assertIsNone(result["selected"])
            call("report", candidate=rows[0]["id"], reason="wrong-song")
            self.assertFalse(call("search")["candidates"])
            call("clear")
            self.assertFalse(call("cache")["candidates"])

    def test_osb_language_metadata_dedup_and_authorization(self):
        # Original fixture, not copied third-party lyrics.
        xml = '<song><title>İsa ışığı</title><author>Test writer</author><hymn_number>7</hymn_number><copyright>Test rights</copyright><lyrics> First line\n.C G\n Second line</lyrics></song>'
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            file = root / "tr.osb"
            with zipfile.ZipFile(file, "w") as z:
                z.writestr("unreliable-filename", xml)
            request = dict(action="import", song="test", metadata={"title":"İsa ışığı", "language":"auto"}, path=str(file), sourceId="worshipleader")
            db = root / "lyrics.db"
            with self.assertRaises(ValueError): L.dispatch(db, request)
            result = L.dispatch(db, request | {"authorized":True})
            candidate = result["candidates"][0]
            self.assertEqual(candidate["language"], "tr")
            self.assertEqual(candidate["songNumber"], "7")
            self.assertEqual(candidate["copyright"], "Test rights")
            self.assertNotIn(".C G", candidate["plain"])
            again = L.dispatch(db, request | {"authorized":True, "sourceId":"propovedi", "metadata":{"title":"İsa ışığı", "language":"tr"}})
            self.assertEqual(len(again["candidates"]), 1)
            self.assertEqual(len(again["candidates"][0]["sourceReferences"]), 2)


if __name__ == "__main__":
    unittest.main()
