"""Transcript matching against the existing local songbook."""
import json
import re
import unicodedata
from difflib import SequenceMatcher


def words(text):
    folded = unicodedata.normalize("NFC", text.casefold())
    return re.findall(r"[^\W_]+", folded.replace("i\u0307", "i"), re.UNICODE)


def lyric_words(text):
    return words(" ".join(line for line in text.splitlines()
                          if not re.fullmatch(r"\s*\[[^\]]+\]\s*", line)))


def phrases(tokens):
    return {tuple(tokens[i:i + 3]) for i in range(len(tokens) - 2)
            if len(set(tokens[i:i + 3])) == 3 and sum(map(len, tokens[i:i + 3])) >= 9}


def index_library(db):
    with db:
        db.execute("""CREATE VIRTUAL TABLE IF NOT EXISTS worship_transcripts
                   USING fts5(id UNINDEXED, lyrics, tokenize='unicode61')""")
        db.execute("""INSERT INTO worship_transcripts
            SELECT d.id, json_extract(d.body,'$.plain') FROM documents d
            JOIN candidates c ON c.id=d.id
            WHERE d.id NOT IN (SELECT id FROM worship_transcripts)
            AND d.rights='user-authorized-local-import'
            AND json_extract(c.metadata,'$.sourceId')='worshipleader'
            AND coalesce(json_extract(d.body,'$.plain'),'') <> ''""")


def match_library(db, request, meta):
    transcript = str(request.get("transcript") or "")[:18000]
    tokens = lyric_words(transcript)[:1600]
    heard = phrases(tokens)
    if len(tokens) < 12 or len(heard) < 5:
        return {"match": None}
    # Index the already-imported texts once. Reuse the index on later requests.
    if not db.execute("SELECT 1 FROM sqlite_master WHERE name='worship_transcripts'").fetchone():
        index_library(db)
    detected = str(request.get("detectedLanguage") or "").lower().split("-")[0]
    title = " ".join(words(meta["title"]))
    artist = " ".join(words(meta["artist"]))
    ordered = sorted(heard, key=lambda phrase: (-sum(map(len, phrase)), phrase))[:32]
    query = " OR ".join('"' + " ".join(phrase) + '"' for phrase in ordered)
    rows = db.execute("""SELECT c.metadata, d.body FROM worship_transcripts f
        JOIN candidates c ON c.id=f.id JOIN documents d ON d.id=f.id
        WHERE worship_transcripts MATCH ?
        AND (?='' OR json_extract(c.metadata,'$.language')=?)
        AND NOT EXISTS (SELECT 1 FROM reports WHERE song=? AND candidate=c.id)
        ORDER BY rank LIMIT 40""", (query, detected, detected, request.get("song", "")))
    ranked = {}
    for row in rows:
        candidate, body = json.loads(row[0]), json.loads(row[1])
        text = body.get("plain", "")
        subject = lyric_words(text)[:1600]
        library = phrases(subject)
        matched = heard & library
        if len(matched) < 5:
            continue
        coverage = len(matched) / max(1, min(len(heard), len(library)))
        title_similarity = SequenceMatcher(None, title, " ".join(words(candidate["title"]))).ratio()
        artist_match = artist and artist == " ".join(words(candidate.get("artist", "")))
        if coverage < (0.24 if title_similarity >= .86 else .42):
            continue
        score = coverage + .22 * title_similarity + (.06 if artist_match else 0)
        signature = " ".join(subject)
        if signature not in ranked or score > ranked[signature][0]:
            ranked[signature] = (score, {"title": candidate["title"], "plain": text,
                "id": candidate["id"], "provider": candidate["provider"]})
    results = sorted(ranked.values(), key=lambda item: item[0], reverse=True)
    if not results or (len(results) > 1 and results[0][0] - results[1][0] < .10):
        return {"match": None}
    return {"match": results[0][1]}
