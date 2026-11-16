"""Independent, bounded lyrics IO. No audio/model imports or provider text disk cache.

LRCLIB permits API clients, but does not grant blanket lyric redistribution rights.
Its text lives only in the response. User-selected local songbooks are kept separately.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import subprocess
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from . import worship_sources as worship
from . import song_sheet
from .library_match import index_library, match_library

MAX_RESPONSE = 2_000_000
CACHE_LIMIT = 50 * 1024 * 1024
REASONS = {"wrong-song", "wrong-artist", "wrong-language", "wrong-version", "incomplete", "duplicate", "rights"}
LANGUAGES = set("auto en bg he tr es fr de pt it ru zh ja ko ar hi bn id ur vi th pl uk ro".split())


def lyrics_language(value) -> str:
    code = re.split("[-_]", str(value or "").strip().lower(), maxsplit=1)[0]
    code = "he" if code in ("heb", "iw") else code
    return code if code in LANGUAGES else "auto"


def clean(value: str) -> str:
    value = re.sub(r"\.(mp3|wav|flac|m4a|aac|ogg|opus|webm)$", "", value, flags=re.I)
    value = re.sub(r"^\d{1,3}\s*[._-]\s*", "", value)
    value = re.sub(r"[\[(](?:[^\])]*?)(?:official|lyric video|music video|visualizer)[^\])]*[\])]", "", value, flags=re.I)
    value = re.sub(r"[\[(]\s*(?:feat(?:uring)?\.?|ft\.?)\s+[^\])]*[\])]", "", value, flags=re.I)
    return re.sub(r"\s+", " ", value).strip()[:240]


def norm(value: str) -> str:
    # Casefold dotted I without merging Turkish dotless ı with i or deleting Cyrillic.
    value = unicodedata.normalize("NFC", value).casefold().replace("i\u0307", "i")
    return " ".join(re.findall(r"[^\W_]+", clean(value), re.UNICODE))


def version(value: str) -> str:
    return next((v for v in ("instrumental", "remix", "acoustic", "cover", "live") if re.search(r"\b" + v + r"\b", value, re.I)), "unspecified")


def number(value) -> float:
    try:
        result = float(value)
        return result if math.isfinite(result) and result > 0 else 0
    except (TypeError, ValueError):
        return 0


def parse_lrc(text: str) -> list[dict]:
    offset = re.search(r"\[offset:([+-]?\d+)\]", text, re.I)
    offset = int(offset[1]) / 1000 if offset else 0
    rows = []
    for line in text.splitlines():
        tags = list(re.finditer(r"\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]", line))
        if not tags:
            continue
        body = line[tags[-1].end():].strip()
        for tag in tags:
            rows.append({"at": max(0, int(tag[1])*60 + int(tag[2]) + float("0." + (tag[3] or "0")) + offset), "text": body})
    return sorted(rows, key=lambda row: row["at"])


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=5)
    db.row_factory = sqlite3.Row
    schema = db.execute("PRAGMA user_version").fetchone()[0]
    if schema > 2:
        db.close()
        raise ValueError("Lyrics database is newer than this app. No data was changed.")
    db.execute("PRAGMA journal_mode=WAL")
    with db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS songs(id TEXT PRIMARY KEY, metadata TEXT NOT NULL, searched REAL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY, title TEXT NOT NULL, metadata TEXT NOT NULL, expires REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS lyrics_title ON candidates(title);
        CREATE INDEX IF NOT EXISTS lyrics_expiry ON candidates(expires);
        CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, body TEXT NOT NULL, rights TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS matches(song TEXT NOT NULL, candidate TEXT NOT NULL, PRIMARY KEY(song,candidate));
        CREATE TABLE IF NOT EXISTS preferences(song TEXT PRIMARY KEY, candidate TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'auto');
        CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY, song TEXT NOT NULL, candidate TEXT NOT NULL, reason TEXT NOT NULL, created REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS reports_song ON reports(song,candidate);
        CREATE TABLE IF NOT EXISTS relationships(source TEXT, target TEXT, kind TEXT, PRIMARY KEY(source,target,kind));
        CREATE TABLE IF NOT EXISTS provider_state(provider TEXT PRIMARY KEY, next_request REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS provider_indexes(provider TEXT PRIMARY KEY, body TEXT NOT NULL, refreshed REAL NOT NULL, state TEXT NOT NULL);
        """)
        if schema < 2:
            for row in db.execute("SELECT id,metadata,searched FROM songs WHERE id LIKE 'local:%'").fetchall():
                original = row["id"]
                canonical = "local:" + original[6:].replace("\\", "/").lower()
                if original == canonical:
                    continue
                db.execute("INSERT OR IGNORE INTO songs VALUES(?,?,?)", (canonical, row["metadata"], row["searched"]))
                db.execute("INSERT OR IGNORE INTO matches SELECT ?,candidate FROM matches WHERE song=?", (canonical, original))
                db.execute("INSERT OR IGNORE INTO preferences SELECT ?,candidate,language FROM preferences WHERE song=?", (canonical, original))
                db.execute("UPDATE reports SET song=? WHERE song=?", (canonical, original))
                for table in ("matches", "preferences"):
                    db.execute(f"DELETE FROM {table} WHERE song=?", (original,))
                db.execute("DELETE FROM songs WHERE id=?", (original,))
            db.execute("PRAGMA user_version=2")
    return db


def safe_metadata(raw: dict) -> dict:
    return {"title": clean(str(raw.get("title") or "")), "artist": str(raw.get("artist") or "")[:200],
            "duration": number(raw.get("duration")), "language": lyrics_language(raw.get("language"))}


def metadata(raw: dict) -> dict:
    meta = safe_metadata(raw)
    if raw.get("path"):
        # The private path is used only by local ffprobe, never passed to a provider.
        path = Path(raw["path"])
        meta["title"] = clean(path.name)
        try:
            from .decode import find_ffmpeg
            probe = find_ffmpeg()[1]
            output = subprocess.run([probe, "-v", "error", "-show_entries", "format=duration:format_tags=title,artist,album_artist,language", "-of", "json", str(path)], capture_output=True, timeout=5, check=True)
            info = json.loads(output.stdout).get("format", {})
            tags = {key.lower(): value for key, value in info.get("tags", {}).items()}
            meta.update(title=clean(tags.get("title") or path.name), artist=tags.get("artist") or tags.get("album_artist") or "", duration=number(info.get("duration")))
            if meta["language"] == "auto":
                meta["language"] = lyrics_language(tags.get("language"))
        except (OSError, subprocess.SubprocessError, ValueError):
            pass
    elif (not meta["title"] or not raw.get("channel")) and re.fullmatch(r"[\w-]{11}", str(raw.get("youtubeId", ""))):
        endpoint = "https://www.youtube.com/oembed?" + urllib.parse.urlencode({"url": "https://www.youtube.com/watch?v=" + raw["youtubeId"], "format": "json"})
        try:
            data = get_json(endpoint)
            # A channel is not necessarily the recording artist; do not treat it as verified.
            meta["title"] = clean(data.get("title", "")) or meta["title"]
            meta["channel"] = data.get("author_name", "")[:200]
        except (OSError, ValueError):
            pass
    # A video title may append performers and production credits after the
    # verified channel credit. Remove those only when that credit agrees.
    if raw.get("youtubeId"):
        title, *credits = re.split(r"\s+\|\s+", meta["title"])
        channel = meta.get("channel") or str(raw.get("channel") or "")
        if credits and channel and norm(credits[0]) == norm(channel):
            meta["title"] = title
            meta["artist"] = meta["artist"] or credits[0]
        if channel:
            meta["channel"] = channel[:200]
    return meta


def get_json(url: str):
    request = urllib.request.Request(url, headers={"User-Agent": "HearthKeys/0.1.0 (https://ko-fi.com/stefandimov1008)", "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=7) as response:
        data = response.read(MAX_RESPONSE + 1)
        if len(data) > MAX_RESPONSE:
            raise ValueError("Lyrics response too large")
        return json.loads(data)


def rank(candidate: dict, meta: dict) -> tuple[float, bool]:
    title, artist = norm(candidate["title"]), norm(candidate.get("artist", ""))
    requested, requested_artist = norm(meta["title"]), norm(meta.get("artist", ""))
    exact = requested == title
    combined = bool(artist) and requested in (title + " " + artist, artist + " " + title)
    artist_match = bool(artist) and (artist == requested_artist or combined)
    a, b = set(requested.split()), set(title.split())
    similarity = len(a & b) / max(1, len(a | b))
    duration = number(meta.get("duration"))
    close = bool(duration and number(candidate.get("duration")) and abs(duration - candidate["duration"]) <= 3)
    same_version = version(meta["title"]) == candidate.get("version", "unspecified")
    lang = meta.get("language", "auto")
    lang_ok = lang == "auto" or lyrics_language(candidate.get("language")) == lang
    score = (60 if exact or combined else similarity * 40) + (25 if artist_match else 0) + (15 if close else 0)
    if requested_artist and artist and not artist_match:
        score -= 35
    if not same_version:
        score -= 25
    if not lang_ok:
        score -= 30
    strong = lang_ok and same_version and (exact or combined) and (artist_match or close) and (not requested_artist or not artist or artist_match)
    return score, strong


def put_candidate(db, candidate, body=None):
    meta = {key: value for key, value in candidate.items() if key not in ("plain", "lines", "syncedLyrics", "chart")}
    db.execute("INSERT INTO candidates VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, metadata=excluded.metadata, expires=excluded.expires", (candidate["id"], norm(candidate["title"]), json.dumps(meta, ensure_ascii=False), time.time() + 7*86400))
    if body is not None and candidate.get("rights") == "user-authorized-local-import":
        db.execute("INSERT OR REPLACE INTO documents VALUES(?,?,?)", (candidate["id"], json.dumps(body, ensure_ascii=False), candidate["rights"]))


def snapshot(db, song, meta, fresh=None):
    rejected = {row[0] for row in db.execute("SELECT candidate FROM reports WHERE song=?", (song,))}
    pref = db.execute("SELECT candidate FROM preferences WHERE song=?", (song,)).fetchone()
    title = norm(meta["title"])
    alias = {"open the eyes of my heart": "open the eyes of my heart lord",
             "open the eyes of my heart lord": "open the eyes of my heart"}.get(title, "")
    rows = db.execute("""SELECT DISTINCT c.metadata,d.body FROM candidates c LEFT JOIN documents d ON d.id=c.id
        WHERE c.id IN (SELECT candidate FROM matches WHERE song=?) OR c.title=? OR c.id IN (SELECT candidate FROM preferences WHERE song=?)
        OR (d.id IS NOT NULL AND (instr(?,c.title)>0 OR c.title=?))""", (song, title, song, title, alias))
    candidates = []
    fresh = {c["id"]: c for c in fresh or []}
    for row in rows:
        c = json.loads(row["metadata"])
        if c["id"] in rejected:
            continue
        c.update(json.loads(row["body"]) if row["body"] else {"plain": "", "lines": []})
        c.update(fresh.get(c["id"], {}))
        c["score"], c["strong"] = rank(c, meta)
        c["available"] = bool(c["plain"] or c["lines"] or c.get("chart"))
        candidates.append(c)
    candidates.sort(key=lambda c: (not (pref and c["id"] == pref[0]),
                                   not bool(c.get("chart")), -c["score"], c["id"]))
    candidates = candidates[:60]
    # Bound the native JSON response without discarding identity/attribution.
    body_budget = 5_000_000
    for c in candidates:
        size = len(json.dumps({"plain": c["plain"], "lines": c["lines"], "chart": c.get("chart")}, ensure_ascii=True))
        if size > body_budget:
            c.update(plain="", lines=[], chart=None, available=False)
        else:
            body_budget -= size
    selected = next((c["id"] for c in candidates if pref and c["id"] == pref[0] and c["available"]), None)
    strong = [c for c in candidates if c["strong"] and c["available"]]
    if not selected and strong and len({norm(c.get("artist", "")) for c in strong}) == 1:
        selected = strong[0]["id"]
    return {"metadata": meta, "candidates": candidates[:60], "selected": selected, "preferred": pref[0] if pref else None}


def prune(db):
    protected = "SELECT candidate FROM preferences UNION SELECT candidate FROM reports UNION SELECT id FROM documents"
    db.execute(f"DELETE FROM candidates WHERE expires<? AND id NOT IN ({protected})", (time.time(),))
    total = db.execute(f"SELECT COALESCE(SUM(length(metadata)),0) FROM candidates WHERE id NOT IN ({protected})").fetchone()[0]
    if total > CACHE_LIMIT:
        for row in db.execute(f"SELECT id,length(metadata) FROM candidates WHERE id NOT IN ({protected}) ORDER BY expires").fetchall():
            db.execute("DELETE FROM candidates WHERE id=?", (row[0],))
            total -= row[1]
            if total <= CACHE_LIMIT:
                break
    db.execute("DELETE FROM matches WHERE candidate NOT IN (SELECT id FROM candidates)")


def search_lrclib(db, song, meta, refresh=False):
    query = clean(meta["title"])
    preferred = db.execute("SELECT candidate FROM preferences WHERE song=?", (song,)).fetchone()
    preferred_id = preferred[0].split(":", 1)[1] if preferred and re.fullmatch(r"lrclib:\d+", preferred[0]) and not refresh else None
    # Never send paths, URLs, empty/generic filenames, or raw input metadata.
    if not preferred_id and (not query or re.search(r"[/\\]|https?:|^[A-Za-z]:", query) or re.fullmatch(r"(?:track|audio|youtube[- ]audio|recording)[\s\d_-]*", query, re.I)):
        return snapshot(db, song, meta) | {"state": "metadata-needed"}
    with db:
        db.execute("INSERT OR IGNORE INTO provider_state VALUES('lrclib',0)")
        db.execute("BEGIN IMMEDIATE") if not db.in_transaction else None
        due = db.execute("SELECT next_request FROM provider_state WHERE provider='lrclib'").fetchone()[0]
        remaining = due - time.time()
        if remaining > 0:
            return snapshot(db, song, meta) | {"state": "rate-limited", "retryAfterSeconds": remaining}
        db.execute("UPDATE provider_state SET next_request=? WHERE provider='lrclib'", (time.time()+8,))
    fresh = []
    state = "ready"
    try:
        # A title/channel separator from YouTube is presentation metadata.
        terms = re.sub(r"\s+\|\s+", " ", query)
        endpoint = "https://lrclib.net/api/get/" + preferred_id if preferred_id else "https://lrclib.net/api/search?" + urllib.parse.urlencode({"q": terms + (" " + meta["artist"] if meta["artist"] else "")})
        data = get_json(endpoint)
        if preferred_id and isinstance(data, dict):
            data = [data]
        if not isinstance(data, list):
            raise ValueError("Invalid lyrics response")
        for item in data[:60]:
            if not isinstance(item, dict) or not isinstance(item.get("id"), int) or not item.get("trackName") or item.get("instrumental"):
                continue
            text = str(item.get("plainLyrics") or "")[:60000]
            lrc = str(item.get("syncedLyrics") or "")[:100000]
            # LRCLIB does not supply a language field. Do not invent a language from artist/country.
            c = {"id": "lrclib:"+str(item["id"]), "title": str(item["trackName"])[:240], "artist": str(item.get("artistName") or "")[:200],
                 "language": "unknown", "duration": number(item.get("duration")), "provider": "LRCLIB", "sourceUrl": "https://lrclib.net/api/get/"+str(item["id"]),
                 "version": version(item["trackName"]), "rights": "provider-view-only", "canExport": False, "plain": text, "lines": parse_lrc(lrc)}
            if preferred_id or rank(c, meta)[0] >= 10:
                fresh.append(c)
    except urllib.error.HTTPError as error:
        state = "rate-limited" if error.code == 429 else "unavailable"
        if error.code == 429:
            retry = max(60, number(error.headers.get("Retry-After")))
            with db:
                db.execute("UPDATE provider_state SET next_request=? WHERE provider='lrclib'", (time.time()+retry*1.2,))
    except (OSError, ValueError):
        state = "unavailable"
    with db:
        for c in fresh:
            put_candidate(db, c)
            db.execute("INSERT OR IGNORE INTO matches VALUES(?,?)", (song, c["id"]))
        db.execute("UPDATE songs SET searched=? WHERE id=?", (time.time(), song))
        prune(db)
    return snapshot(db, song, meta, fresh) | {"state": state}


def search(db, song, meta, refresh=False):
    query = clean(meta["title"])
    # Source indexes contain titles and exact links only. Their cached metadata is
    # reused across songs; explicit Retry does not hammer six websites again.
    eligible = meta.get("language") in ("auto", "bg") and query and not re.search(r"[/\\]|https?:|^[A-Za-z]:", query) and not re.fullmatch(r"(?:track|audio|youtube[- ]audio|recording)[\s\d_-]*", query, re.I)
    cached = {r["provider"]: r for r in db.execute("SELECT * FROM provider_indexes")}
    sources = [key for key in worship.SOURCES if key != "worshipleader"] if eligible else []
    cache_keys = {key: key if key != "vitania" else "vitania:" + hashlib.sha256(norm(query).encode()).hexdigest()[:24] for key in sources}
    due = [key for key in sources if cache_keys[key] not in cached or time.time()-cached[cache_keys[key]]["refreshed"] > (86400 if cached[cache_keys[key]]["state"] == "ready" else 3600)]
    # LRCLIB and the bounded metadata adapters run concurrently, off audio's path.
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(worship.fetch_indexes, due, query)
        result = search_lrclib(db, song, meta, refresh)
        fetched = pending.result()
    with db:
        for source, rows, state in fetched:
            key = cache_keys[source]
            body = json.dumps(rows, ensure_ascii=False) if rows else (cached[key]["body"] if key in cached else "[]")
            db.execute("INSERT OR REPLACE INTO provider_indexes VALUES(?,?,?,?)", (key, body, time.time(), state))
        db.execute("DELETE FROM provider_indexes WHERE refreshed<?", (time.time()-7*86400,))
        db.execute("DELETE FROM provider_indexes WHERE provider IN (SELECT provider FROM provider_indexes ORDER BY refreshed DESC LIMIT -1 OFFSET 100)")
        for row in db.execute("SELECT * FROM provider_indexes").fetchall():
            if row["provider"] not in cache_keys.values(): continue
            for candidate in json.loads(row["body"]):
                if worship.matches_title(candidate, query):
                    put_candidate(db, candidate)
                    db.execute("INSERT OR IGNORE INTO matches VALUES(?,?)", (song, candidate["id"]))
    fresh = [c for c in result["candidates"] if c.get("available")]
    response = snapshot(db, song, meta, fresh)
    response["state"] = result["state"]
    if "retryAfterSeconds" in result:
        response["retryAfterSeconds"] = result["retryAfterSeconds"]
    response["providers"] = {r["provider"]: r["state"] for r in db.execute("SELECT provider,state FROM provider_indexes")}
    return response


def read_import(data: bytes, filename: str, language: str) -> list[dict]:
    if len(data) > 1_000_000:
        raise ValueError("One song must be smaller than 1 MB")
    text = data.decode("utf-8-sig")
    if "<!DOCTYPE" in text.upper() or "<!ENTITY" in text.upper():
        raise ValueError("XML entities are not supported")
    songs = []
    if text.lstrip().startswith("<"):
        root = ET.fromstring(text)
        for node in root.iter():
            node.tag = node.tag.split("}")[-1]
        nodes = [root] if root.tag == "song" else list(root.findall(".//song"))
        for node in nodes:
            title = node.findtext("title") or node.findtext("properties/titles/title") or Path(filename).stem
            author = node.findtext("author") or "; ".join(
                author.text or "" for author in node.findall("properties/authors/author"))
            artist = node.findtext("artist") or ""
            copyright_notice = node.findtext("copyright") or node.findtext("properties/copyright") or ""
            lyrics = node.find("lyrics")
            if lyrics is None:
                continue
            rows = (song_sheet.openlyrics(lyrics, node.findtext("properties/verseOrder") or "")
                    if list(lyrics) else song_sheet.opensong(lyrics.text or "", node.findtext("presentation") or ""))
            item = {"title": title, "artist": artist or author, "artistRole": "performer" if artist else "writer",
                    "plain": "\n".join(row["text"] for row in rows).strip(), "lines": [],
                    "sourceFile": filename, "language": node.findtext("language") or language,
                    "copyright": copyright_notice, "songwriter": author, "chartKey": node.findtext("key") or node.findtext("properties/key") or "",
                    "songNumber": node.findtext("hymn_number") or node.findtext("number") or "",
                    "ccli": node.findtext("ccli") or node.findtext("properties/ccliNo") or "",
                    "sourceUrl": node.findtext("source_url") or ""}
            if any(row["chords"] for row in rows):
                item["chart"] = rows
            songs.append(item)
    else:
        lines = parse_lrc(text)
        if not lines and (Path(filename).suffix.lower() in (".cho", ".chordpro", ".crd", ".pro", ".chopro", ".chord")
                          or re.search(r"(?im)^\s*\{(?:t|title|soc|start_of_verse)\b", text)):
            rows, meta = song_sheet.chordpro(text)
            item = {"title": meta.get("title") or Path(filename).stem,
                    "artist": meta.get("artist") or meta.get("subtitle") or "",
                    "artistRole": "performer" if meta.get("artist") else "",
                    "songwriter": meta.get("composer") or meta.get("lyricist") or "",
                    "copyright": meta.get("copyright", ""), "chartKey": meta.get("key", ""),
                    "sourceFile": filename, "language": meta.get("language") or language,
                    "plain": "\n".join(row["text"] for row in rows).strip(), "lines": []}
            if any(row["chords"] for row in rows):
                item["chart"] = rows
            songs.append(item)
        else:
            item = {"title": Path(filename).stem, "artist": "", "plain": "\n".join(row["text"] for row in lines) if lines else text,
                    "lines": lines, "language": language, "sourceFile": filename}
            if not lines and Path(filename).suffix.lower() == ".txt":
                def chord_row(line):
                    return line.split() and all(song_sheet.CHORD.fullmatch(word) for word in line.split())
                raw = text.splitlines()
                if any(chord_row(line) and raw[i + 1].strip() and not chord_row(raw[i + 1])
                       and not song_sheet.SECTION.fullmatch(raw[i + 1].strip()) for i, line in enumerate(raw[:-1])):
                    rows = song_sheet.opensong("\n".join("." + line if chord_row(line) else line for line in raw))
                    item.update(chart=rows, plain="\n".join(row["text"] for row in rows).strip())
            songs.append(item)
    return songs


def dispatch(db_path: Path, request: dict) -> dict:
    action = request.get("action")
    if action == "metadata":
        return metadata(request.get("metadata", {}))
    db = connect(db_path)
    try:
        if action == "clear":
            with db:
                db.execute("DELETE FROM candidates WHERE id NOT IN (SELECT id FROM documents) AND id NOT IN (SELECT candidate FROM preferences) AND id NOT IN (SELECT candidate FROM reports)")
                db.execute("DELETE FROM matches WHERE candidate NOT IN (SELECT id FROM candidates)")
                db.execute("UPDATE songs SET searched=0")
                db.execute("DELETE FROM provider_indexes")
            db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            db.execute("VACUUM")
            return {"ok": True}
        if action == "stats":
            return {"bytes": sum(p.stat().st_size for p in (db_path, Path(str(db_path)+"-wal")) if p.exists()), "documents": db.execute("SELECT count(*) FROM documents").fetchone()[0]}
        song = str(request.get("song", ""))[:512]
        if song.startswith("local:"):
            song = "local:" + song[6:].replace("\\", "/").lower()
        if not song:
            raise ValueError("Missing song identity")
        meta = safe_metadata(request.get("metadata", {}))
        if action == "match-transcript":
            return match_library(db, request | {"song": song}, meta)
        with db:
            db.execute("INSERT INTO songs(id,metadata) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata", (song, json.dumps(meta, ensure_ascii=False)))
        if action == "search":
            return search(db, song, meta, request.get("refresh") is True)
        if action in ("choose", "report"):
            cid = str(request.get("candidate", ""))
            if not db.execute("SELECT 1 FROM candidates WHERE id=?", (cid,)).fetchone():
                raise ValueError("Unknown lyrics version")
            with db:
                if action == "choose":
                    db.execute("INSERT OR REPLACE INTO preferences VALUES(?,?,?)", (song, cid, meta["language"]))
                    db.execute("DELETE FROM reports WHERE song=? AND candidate=?", (song, cid))
                else:
                    reason = request.get("reason")
                    if reason not in REASONS:
                        raise ValueError("Invalid report reason")
                    db.execute("INSERT INTO reports(song,candidate,reason,created) VALUES(?,?,?,?)", (song, cid, reason, time.time()))
                    db.execute("DELETE FROM preferences WHERE song=? AND candidate=?", (song, cid))
            return {"ok": True, "localOnly": True}
        if action == "import":
            path = Path(request["path"])
            if path.stat().st_size > 20_000_000:
                raise ValueError("Import limit is 20 MB")
            songs = []
            import_source = str(request.get("sourceId", ""))
            import_language = meta["language"]
            if import_source == "worshipleader" and import_language == "auto":
                if path.stem.lower() in ("bg", "tr", "en"):
                    import_language = path.stem.lower()
                else:
                    raise ValueError("Choose the songbook language before importing this collection")
            if zipfile.is_zipfile(path):
                with zipfile.ZipFile(path) as archive:
                    entries = [e for e in archive.infolist() if not e.is_dir() and not e.filename.startswith("__MACOSX") and Path(e.filename).name != ".DS_Store"]
                    if len(entries) > 5000 or sum(e.file_size for e in entries) > 50_000_000:
                        raise ValueError("Import up to 5000 songs / 50 MB expanded at a time")
                    for entry in entries:
                        songs.extend(read_import(archive.read(entry), entry.filename, import_language))
            else:
                songs = read_import(path.read_bytes(), path.name, import_language)
            songs = [item for item in songs if item["plain"].strip() or item.get("chart")]
            if request.get("inspect") is True and len(songs) == 1:
                return {"staged": songs[0]}
            with db:
                for item in songs:
                    # Identity excludes provider/copyright, but preserves language and lyric
                    # formatting. Re-importing identical text keeps all source references.
                    identity = {k: unicodedata.normalize("NFC", str(item.get(k, ""))).strip() for k in ("title", "language", "plain", "artist")}
                    identity["lines"] = item["lines"]
                    if item.get("chart"):
                        identity["chart"] = item["chart"]
                    cid = "import:"+hashlib.sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
                    c = dict(item, id=cid, duration=0, provider="Local import", version="unspecified", rights="user-authorized-local-import", canExport=False, sourceUrl="")
                    if import_source in worship.SOURCES:
                        c.update(sourceId=import_source, provider=worship.SOURCES[import_source][0], sourceUrl=item.get("sourceUrl") or worship.SOURCES[import_source][1])
                    reference = {"provider": c["provider"], "url": c["sourceUrl"], "copyright": c.get("copyright", ""), "songNumber": c.get("songNumber", "")}
                    existing = db.execute("SELECT metadata FROM candidates WHERE id=?", (cid,)).fetchone()
                    refs = json.loads(existing[0]).get("sourceReferences", []) if existing else []
                    c["sourceReferences"] = refs if reference in refs else refs + [reference]
                    put_candidate(db, c, {key: item[key] for key in ("plain", "lines", "chart") if key in item})
                    if len(songs) == 1 or norm(c["title"]) == norm(meta["title"]):
                        db.execute("INSERT OR IGNORE INTO matches VALUES(?,?)", (song,cid))
                    if len(songs) == 1:
                        db.execute("INSERT OR REPLACE INTO preferences VALUES(?,?,?)", (song,cid,meta["language"]))
            if db.execute("SELECT 1 FROM sqlite_master WHERE name='worship_transcripts'").fetchone():
                index_library(db)
            return snapshot(db,song,meta) | {"imported": len(songs)}
        if action != "cache":
            raise ValueError("Unknown lyrics operation")
        with db:
            prune(db)
        return snapshot(db, song, meta)
    finally:
        db.close()
