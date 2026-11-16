"""Lyrics IO contract tests: no copyrighted fixtures and no network required."""
from contextlib import closing
import json
import sqlite3
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from chord_engine import lyrics as L


class LyricsTests(unittest.TestCase):
    def setUp(self):
        self.sources = patch.object(L.worship, "fetch_indexes", return_value=[])
        self.sources.start()
        self.addCleanup(self.sources.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "lyrics.sqlite3"
        self.meta = {"title": "A test song", "artist": "Test artist", "duration": 60, "language": "auto"}

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, action, **args):
        return L.dispatch(self.db, {"action": action, "song": "youtube:test-id", "metadata": self.meta, **args})

    def import_song(self, title="A test song", text="Original test words\n\n[Chorus]\nSecond test line", language="en"):
        path = Path(self.tmp.name) / (title + ".txt")
        path.write_text(text, encoding="utf-8")
        return self.call("import", path=str(path), authorized=True, metadata={**self.meta, "language": language})

    def test_migration_restart_and_clear_preserve_authorized_import_and_preference(self):
        result = self.import_song()
        cid = result["selected"]
        self.assertTrue(cid.startswith("import:"))
        self.assertEqual(self.call("cache")["selected"], cid)
        self.call("clear")
        cached = self.call("cache")
        self.assertEqual(cached["selected"], cid)
        self.assertIn("[Chorus]", cached["candidates"][0]["plain"])
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 2)

    def test_new_language_preferences_survive_storage_and_tags_normalize(self):
        for requested in ("he", "fr", "ja"):
            self.assertEqual(L.safe_metadata({"language": requested})["language"], requested)
        self.assertEqual(L.safe_metadata({"language": "iw-IL"})["language"], "he")
        result = self.import_song(text="שרים ביחד", language="he")
        self.assertEqual(result["metadata"]["language"], "he")
        self.assertEqual(result["candidates"][0]["language"], "he")

    def test_migrate_windows_path_identity_without_losing_choices(self):
        cid = self.import_song()["selected"]
        old = r"local:C:\Music\TEST.mp3"
        canonical = "local:c:/music/test.mp3"
        with closing(sqlite3.connect(self.db)) as db:
            db.execute("INSERT INTO songs VALUES(?,?,?)", (old,json.dumps(self.meta),0))
            db.execute("INSERT INTO preferences VALUES(?,?,?)", (old,cid,"auto"))
            db.execute("PRAGMA user_version=1")
            db.commit()
        result = L.dispatch(self.db, {"action":"cache", "song":canonical, "metadata":self.meta})
        self.assertEqual(result["preferred"], cid)

    def test_report_survives_restart_and_cache_clear(self):
        cid = self.import_song()["selected"]
        self.call("report", candidate=cid, reason="wrong-version")
        self.call("clear")
        self.assertEqual(self.call("cache")["candidates"], [])
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute("SELECT reason FROM reports").fetchone()[0], "wrong-version")

    def test_provider_text_not_persisted_but_attribution_is(self):
        with patch.object(L, "get_json", return_value=[{"id": 42, "trackName": "A test song", "artistName": "Test artist", "duration": 60, "plainLyrics": "Original ephemeral test lyric", "syncedLyrics": "[00:01]Original ephemeral test lyric"}]):
            result = self.call("search")
        self.assertEqual(result["selected"], "lrclib:42")
        self.assertEqual(result["candidates"][0]["lines"][0]["at"], 1)
        self.call("choose", candidate="lrclib:42")
        cached = self.call("cache")
        self.assertEqual(cached["preferred"], "lrclib:42")
        self.assertFalse(cached["candidates"][0]["available"])
        with closing(sqlite3.connect(self.db)) as db:
            dump = "\n".join(db.iterdump())
        self.assertNotIn("ephemeral", dump)
        self.assertIn("provider-view-only", dump)

    def test_youtube_metadata_verifies_artist_even_if_title_is_already_known(self):
        title = "Yeshua | Jesus Image | Michael Koulianos"
        raw = {"title": title, "youtubeId": "ivUb1K0B0zE", "duration": 1147}
        with patch.object(L, "get_json", return_value={"title": title, "author_name": "Jesus Image"}) as get:
            result = L.metadata(raw)
        get.assert_called_once()
        self.assertEqual((result["title"], result["artist"], result["duration"]), ("Yeshua", "Jesus Image", 1147))
        with patch.object(L, "get_json", return_value={"title": title, "author_name": "Independent uploader"}):
            result = L.metadata(raw)
        self.assertEqual((result["title"], result["artist"]), (title, ""))

    def test_unicode_dedup_and_languages(self):
        for title, language in [("Мир като река", "bg"), ("İsa ışığı", "tr"), ("A test song", "en")]:
            result = self.import_song(title, "User-created test words", language)
            first = result["selected"]
            second = self.import_song(title, "User-created test words", language)["selected"]
            self.assertEqual(first, second)
        self.assertEqual(L.norm("İSA"), L.norm("isa"))
        self.assertNotEqual(L.norm("ışık"), L.norm("isik"))
        self.assertEqual(L.norm("МИР КАТО РЕКА"), "мир като река")

    def test_preferred_id_retrieved_even_when_filename_has_no_title(self):
        item = {"id": 42, "trackName": "A test song", "artistName": "Test artist", "duration": 60, "plainLyrics": "Original test words"}
        with patch.object(L, "get_json", return_value=[item]):
            self.call("search")
        self.call("choose", candidate="lrclib:42")
        with closing(sqlite3.connect(self.db)) as db:
            db.execute("UPDATE provider_state SET next_request=0")
            db.commit()
        with patch.object(L, "get_json", return_value=item) as fetch:
            result = self.call("search", metadata={**self.meta, "title": "track01", "artist": ""})
        self.assertEqual(fetch.call_args.args[0], "https://lrclib.net/api/get/42")
        self.assertEqual(result["selected"], "lrclib:42")

    def test_cache_expiry_and_budget_preserve_user_documents(self):
        cid = self.import_song()["selected"]
        db = L.connect(self.db)
        try:
            with db:
                for n in range(5):
                    L.put_candidate(db, {"id": f"lrclib:{n}", "title": "Test", "artist": "Artist", "provider": "LRCLIB", "language": "en", "version": "unspecified", "rights": "provider-view-only", "description": "x"*1000})
                with patch.object(L, "CACHE_LIMIT", 1500):
                    L.prune(db)
            self.assertLessEqual(db.execute("SELECT count(*) FROM candidates WHERE id LIKE 'lrclib:%'").fetchone()[0], 1)
            self.assertTrue(db.execute("SELECT 1 FROM documents WHERE id=?", (cid,)).fetchone())
            with db:
                db.execute("UPDATE candidates SET expires=0 WHERE id LIKE 'lrclib:%'")
                L.prune(db)
            self.assertEqual(db.execute("SELECT count(*) FROM candidates WHERE id LIKE 'lrclib:%'").fetchone()[0], 0)
        finally:
            db.close()

    def test_wrong_artist_language_and_live_not_strong(self):
        base = {"title": "A test song", "artist": "Other artist", "duration": 60, "language": "en", "version": "unspecified"}
        self.assertFalse(L.rank(base, self.meta)[1])
        base["artist"] = "Test artist"
        self.assertTrue(L.rank(base, self.meta)[1])
        self.assertFalse(L.rank(base, {**self.meta, "language": "bg"})[1])
        self.assertFalse(L.rank({**base, "version": "live"}, self.meta)[1])

    def test_duplicate_titles_do_not_auto_match(self):
        with patch.object(L, "get_json", return_value=[{"id": i, "trackName": "A test song", "artistName": artist, "duration": 60, "plainLyrics": "Test"} for i, artist in enumerate(["A", "B"])]):
            result = self.call("search", metadata={**self.meta, "artist": ""})
        self.assertIsNone(result["selected"])

    def test_failure_keeps_import(self):
        cid = self.import_song()["selected"]
        with patch.object(L, "get_json", side_effect=TimeoutError()):
            result = self.call("search")
        self.assertEqual(result["state"], "unavailable")
        self.assertEqual(result["selected"], cid)

    def test_youtube_title_separator_and_local_cooldown(self):
        meta = {**self.meta, "title": "Test song | Test artist", "artist": ""}
        with patch.object(L, "get_json", return_value=[]) as fetch:
            self.assertEqual(self.call("search", metadata=meta)["state"], "ready")
            request = urllib.parse.parse_qs(urllib.parse.urlparse(fetch.call_args.args[0]).query)
            self.assertEqual(request["q"], ["Test song Test artist"])
            result = self.call("search", metadata=meta)
            self.assertEqual(result["state"], "rate-limited")
            self.assertTrue(0 < result["retryAfterSeconds"] <= 8)
            self.assertEqual(fetch.call_count, 1)

    def test_retry_after_is_persisted(self):
        with patch.object(L, "get_json", side_effect=urllib.error.HTTPError("https://lrclib.net", 429, "Rate limited", {"Retry-After": "120"}, None)) as fetch:
            self.assertEqual(self.call("search")["state"], "rate-limited")
            self.assertEqual(self.call("search")["state"], "rate-limited")
            self.assertEqual(fetch.call_count, 1)

    def test_unknown_metadata_and_private_paths_not_sent(self):
        with patch.object(L, "get_json") as fetch:
            for title in ["", "track01.mp3", r"C:\Private\test.mp3", "https://somewhere/a"]:
                self.assertEqual(self.call("search", metadata={**self.meta, "title": title})["state"], "metadata-needed")
            fetch.assert_not_called()

    def test_inspecting_a_single_lyric_file_does_not_activate_it(self):
        source = Path(self.tmp.name) / "A test song.txt"
        source.write_text("Original test words\nSecond test line", encoding="utf-8")
        self.assertIn("Original test words", self.call("import", path=str(source), inspect=True)["staged"]["plain"])
        self.assertEqual(self.call("cache")["candidates"], [])
        self.assertEqual(self.call("import", path=str(source))["imported"], 1)

    def test_opensong_and_openlyrics_preserve_sections_ignore_chords(self):
        song = L.read_import(b'<song><title>Test</title><author>Artist</author><lyrics>[V1]\n.C  G\n First line\n\n[C]\n Chorus</lyrics></song>', "song", "en")[0]
        self.assertEqual(song["plain"], "[V1]\nFirst line\n\n[C]\nChorus")
        song = L.read_import(b'<song xmlns="http://openlyrics.info/namespace/2009/song"><properties><titles><title>Test</title></titles></properties><lyrics><verse name="v1"><lines>First line</lines></verse></lyrics></song>', "song.xml", "en")[0]
        self.assertIn("[v1]\nFirst line", song["plain"])

    def test_no_xml_entity_expansion(self):
        with self.assertRaises(ValueError):
            L.read_import(b'<!DOCTYPE song [<!ENTITY x "oops">]><song/>', "song.xml", "en")

    def test_import_retains_copyright_and_all_authors(self):
        song = L.read_import(b'<song><properties><titles><title>Test</title></titles><authors><author>Writer</author><author type="translation">Translator</author></authors><copyright>Copyright Test Writer</copyright></properties><lyrics><verse name="v1"><lines>Original test words</lines></verse></lyrics></song>', "song.xml", "en")[0]
        self.assertEqual(song["copyright"], "Copyright Test Writer")
        self.assertEqual(song["artist"], "Writer; Translator")

    def test_zip_is_never_extracted(self):
        path = Path(self.tmp.name) / "songs.zip"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("../escape.txt", "Original words")
        self.call("import", path=str(path), authorized=True)
        self.assertFalse((Path(self.tmp.name).parent / "escape.txt").exists())

    def test_lrc_offsets_multiple_tags_and_empty_lines(self):
        rows = L.parse_lrc("[offset:250]\n[00:01][00:03.5]test\n[00:05.00]")
        self.assertEqual([row["at"] for row in rows], [1.25, 3.75, 5.25])
        self.assertEqual(rows[-1]["text"], "")

    def test_future_schema_not_overwritten(self):
        with closing(sqlite3.connect(self.db)) as db:
            db.execute("PRAGMA user_version=99")
        with self.assertRaises(ValueError):
            self.call("cache")


if __name__ == "__main__":
    unittest.main()
