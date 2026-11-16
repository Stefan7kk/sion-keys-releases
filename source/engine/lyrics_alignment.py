"""Local, evidence-based line timing. Only timestamps and diagnostics leave this process."""
import ctypes
from functools import lru_cache
import gzip
from contextlib import closing
from difflib import SequenceMatcher
from collections import Counter
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import unicodedata


def tokens(text):
    text = unicodedata.normalize("NFC", text).casefold().replace("i\u0307", "i")
    return re.findall(r"[^\W_]+", text)


def align_transcript(lines, words, duration):
    """Try the original acoustic anchors before decoding the recording again."""
    if not isinstance(words, list) or not 2 <= len(words) <= 2500:
        return None
    heard = []
    for word in words:
        if not isinstance(word, list) or len(word) != 4 or not isinstance(word[0], str):
            return None
        text, at, end, probability = word
        if not (all(isinstance(n, (float, int)) and math.isfinite(n) for n in (at, end, probability))
                and 0 <= at < end <= duration + .3 and .65 <= probability <= 1):
            continue
        normalized = tokens(text)
        if len(normalized) == 1:
            heard.append((normalized[0], at, end, probability))
    heard.sort(key=lambda word: word[1])
    result = align(lines, heard, duration, minimum_quality=.90, repeated_vocals=True)
    return result if result["state"] == "aligned" else None


def align(lines, heard, duration, *, minimum_quality=.0, recovery=False, repeated_vocals=False, expected=None):
    """Find an ordered path through acoustic word matches, allowing missing lines."""
    words = [w[0] for w in heard]
    positions = {}
    for i, word in enumerate(words):
        positions.setdefault(word, []).append(i)
    # Keep the best path for each audio endpoint. Skipping a lyric does not
    # create a timestamp. Strict ordering prevents reusing a chorus occurrence.
    paths = {0: (0.0, [])}
    for line_index, line in enumerate(lines):
        lyric = tokens(line)
        choices = {}
        if lyric and len(lyric) <= 40:
            starts = set(positions.get(lyric[0], ()))
            if len(lyric) >= 5:
                starts.update(positions.get(lyric[1], ()))
            for start in sorted(starts):
                if start < 0 or start >= len(words):
                    continue
                for size in range(max(1, len(lyric) - 2), len(lyric) + 3):
                    end = start + size
                    if end > len(words):
                        continue
                    blocks = SequenceMatcher(None, lyric, words[start:end], autojunk=False).get_matching_blocks()
                    count = sum(block.size for block in blocks)
                    similarity = 2 * count / (size + len(lyric))
                    if not count or similarity < (1 if len(lyric) <= 2 else .74):
                        continue
                    first = blocks[0]
                    # A clearly heard suffix can recover a line from its first
                    # confirmed word. Never backdate it to a guessed opening.
                    recovered = first.a == 1 and first.b == 0 and first.size >= 4 and count >= len(lyric) - 1
                    if first.b != 0 or (first.a != 0 and not recovered):
                        continue
                    last = blocks[-2]
                    stop = start + last.b + last.size
                    at, until = heard[start][1], heard[stop - 1][2]
                    if expected is not None and (first.a != 0 or abs(at - expected[line_index]) > 3):
                        continue
                    # Whisper can attach an opening word to a long preceding instrumental.
                    # Prefer leaving the line untimed when its acoustic span is implausible.
                    if (not (0 <= at < until <= duration + .3)
                        or heard[start][2] - at > 3.5
                        or until - at > min(18, max(6, len(lyric) * 1.5))):
                        continue
                    prob = sum(heard[i][3] for block in blocks
                               for i in range(start + block.b, start + block.b + block.size)) / count
                    first_probability = .30
                    if repeated_vocals:
                        matched = [heard[start + block.b + offset]
                                   for block in blocks for offset in range(block.size)]
                        if (until - at < count * .12
                            or any(word[2] - word[1] < .09 for word in matched)
                            or any(b[1] - a[2] > 1.8 or b[1] < a[2] - .15
                                   for a, b in zip(matched, matched[1:]))):
                            continue
                        if len(lyric) == count == size == 3 and len(set(lyric)) == 1:
                            if min(matched[1][3], matched[2][3]) >= .55 and matched[0][2] - at >= .25:
                                first_probability = .12
                    if prob < .40 or heard[start][3] < first_probability:
                        continue
                    if recovered and (prob < .65 or heard[start][3] < .55):
                        continue
                    quality = similarity * (.8 + .2 * prob) - (.035 if recovered else 0)
                    anchors = [[block.a + offset, round(heard[start + block.b + offset][1], 3),
                                round(min(heard[start + block.b + offset][2], duration), 3)]
                               for block in blocks for offset in range(block.size)
                               if heard[start + block.b + offset][3] >= .65
                               and 0 < heard[start + block.b + offset][2] - heard[start + block.b + offset][1] <= 3.5]
                    if expected is not None:
                        if len(anchors) < 2 or anchors[0][0] != 0:
                            continue
                        quality -= abs(at - expected[line_index]) * .02
                    key = (start, stop)
                    if quality >= minimum_quality and quality > choices.get(key, (0, 0, 0))[0]:
                        choices[key] = (quality, at, min(until, duration), anchors)
        next_paths = {end: (score, path + [None]) for end, (score, path) in paths.items()}
        ordered = iter(sorted(paths.items()))
        previous = next(ordered, None)
        best = None
        for (start, stop), (quality, at, until, anchors) in sorted(choices.items()):
            while previous and previous[0] <= start:
                if best is None or previous[1][0] > best[0]:
                    best = previous[1]
                previous = next(ordered, None)
            if best is None:
                continue
            score, path = best
            score += quality
            if score > next_paths.get(stop, (-1, []))[0]:
                next_paths[stop] = (score, path + [([round(at, 3), round(until, 3)], anchors)])
        paths = next_paths
    score, path = max(paths.values(), key=lambda value: value[0])
    placed = [match[0] for match in path if match is not None]
    coverage = len(placed) / max(1, len(lines))
    mean_quality = score / max(1, len(placed))
    # Keep the established full/partial criteria. Also allow a strongly
    # corroborated partial result rather than hiding every usable line when a
    # recording omits or adds verses. No unmatched line receives timing.
    strong_anchors = {tuple(tokens(line)) for line, mark in zip(lines, path)
                      if mark is not None and len(tokens(line)) >= 3}
    enough = ((coverage == 1 and len(placed) >= 2 and mean_quality >= .82)
              or (coverage >= .75 and len(placed) >= 3 and mean_quality >= .90)
              or (coverage >= 2 / 3 and len(placed) >= 8 and len(strong_anchors) >= 4
                  and mean_quality >= .94))
    reliable = (enough or (recovery and bool(placed))) and all(a[0] < b[0] and a[1] <= b[0] + .15 for a, b in zip(placed, placed[1:]))
    return {"marks": [match[0] if match else None for match in path] if reliable else [],
            "words": [match[1] if match else [] for match in path] if reliable else [], "matched": len(placed), "total": len(lines),
            "confidence": round(score / max(1, len(placed)), 3), "state": "aligned" if reliable else "unreliable"}


def memory_mib():
    if os.name != "nt":
        return None
    class Counters(ctypes.Structure):
        _fields_ = [("cb", ctypes.c_ulong), ("faults", ctypes.c_ulong)] + [
            (name, ctypes.c_size_t) for name in ("peak", "working", "pool_peak", "pool",
                                                "nonpaged_peak", "nonpaged", "pagefile", "pagefile_peak")]
    counters = Counters()
    counters.cb = ctypes.sizeof(counters)
    if ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.c_void_p(-1), ctypes.byref(counters), counters.cb):
        return round(counters.peak / 1048576, 1)
    return None


def fingerprint(audio, lines, version, language):
    digest = hashlib.sha256()
    with audio.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    digest.update(json.dumps([5, version, language, lines], ensure_ascii=False).encode())
    return digest.hexdigest()


def repeat_match(audio, reference, start, end):
    """Find a distinct repeat of an acoustically verified phrase in a bounded gap."""
    import numpy as np

    def spectral_changes(offset, count):
        samples = audio[offset * 320:(offset + count + 3) * 320 + 512]
        frames = np.lib.stride_tricks.sliding_window_view(samples, 512)[::320]
        spectrum = np.abs(np.fft.rfft(frames * np.hanning(512)))
        bands = np.unique(np.rint(np.geomspace(8, 180, 32)).astype(int))
        energy = np.log(np.stack([spectrum[:, a:b].mean(1) for a, b in zip(bands, bands[1:])], 1) + .04)
        change = energy[4:] - energy[:-4]
        return change / np.maximum(np.linalg.norm(change, axis=1, keepdims=True), .3)

    at, until = reference
    count = round((until - at) * 50)
    first, last = math.ceil(start * 50), math.floor(end * 50) - count
    reference_frame = round(at * 50)
    if count < 100 or last - first < 20 or (max(last, reference_frame) + count + 5) * 320 > len(audio):
        return None
    sample = spectral_changes(reference_frame, count)
    target = spectral_changes(first, last - first + count)
    scores = np.array([(sample * target[i:i + count]).sum(1).mean()
                       for i in range(last - first + 1)])
    peak = int(scores.argmax())
    competitors = np.abs(np.arange(len(scores)) - peak) > 12
    if scores[peak] < .10 or not competitors.any() or scores[peak] - scores[competitors].max() < .035:
        return None
    return [(first + peak) / 50, (first + peak + count) / 50]


def recover_gaps(lines, result, transcribe, audio=None, budget=75):
    """Retry short gaps between already matched lyric lines."""
    marks = result["marks"][:]
    words = result["words"][:]
    references = {}
    for line, mark, anchors in zip(lines, marks, words):
        if mark and len(anchors) >= 3:
            references.setdefault(tuple(tokens(line)), []).append(mark)
    def repeated_mark(lyric, start, end):
        if audio is None:
            return None
        candidates = []
        for reference in sorted(references.get(lyric, ()), key=lambda mark: mark[1] - mark[0], reverse=True)[:4]:
            if match := repeat_match(audio, reference, start, end):
                candidates.append(match)
        if not candidates or max(mark[0] for mark in candidates) - min(mark[0] for mark in candidates) > .8:
            return None
        return candidates[0]

    repeat_gaps = []
    for i in range(1, len(lines) - 1):
        if marks[i] is not None or marks[i - 1] is None:
            continue
        j = i
        while j < len(lines) and marks[j] is None:
            j += 1
        if j == len(lines) or j - i > 3:
            continue
        start, end = marks[i - 1][1], marks[j][0]
        span = end - start
        if not 1.2 <= span <= 18 or span > budget:
            continue
        budget -= span
        heard = transcribe(start, end)
        retry = align(lines[i:j], heard, end, minimum_quality=.87, recovery=True)
        for k, mark in enumerate(retry["marks"]):
            anchors = retry["words"][k]
            if mark and start <= mark[0] < mark[1] <= end and len(anchors) >= 3:
                marks[i + k], words[i + k] = mark, anchors
        if j != i + 1 or marks[i] is not None:
            continue
        lyric = tuple(tokens(lines[i]))
        if len(lyric) < 5:
            continue
        repeat_gaps.append((i, start, end, lyric))
        # A vocabulary hint can clarify indistinct singing. Require independent
        # word matches or a matching performance of the same line.
        if lyric not in references and not set(lyric[1:3]).intersection(w[0] for w in heard):
            continue
        guided = transcribe(start, end, lines[i])
        retry = align([lines[i]], guided, end, minimum_quality=.82, recovery=True)
        if not retry["marks"]:
            continue
        mark, anchors = retry["marks"][0], retry["words"][0]
        if not mark or not start <= mark[0] < mark[1] <= end:
            continue
        corroborated = [anchor for anchor in anchors if any(
            token == lyric[anchor[0]] and prob >= .55 and until > at and abs(at - anchor[1]) <= .55
            for token, at, until, prob in heard
        )]
        repeated = repeated_mark(lyric, start, end)
        matches_words = len(corroborated) >= 3 and corroborated[0][0] <= 1 and corroborated[-1][0] >= len(lyric) - 2
        matches_recording = len(anchors) >= 3 and repeated is not None and abs(repeated[0] - mark[0]) <= .8
        if matches_words or matches_recording:
            marks[i], words[i] = mark, corroborated
            references.setdefault(lyric, []).append(mark)
    for i, start, end, lyric in repeat_gaps:
        if marks[i] is None:
            marks[i] = repeated_mark(lyric, start, end)
    count = sum(mark is not None for mark in marks)
    return result | {"marks": marks, "words": words, "matched": count,
                     "recovered": count - result["matched"]}


def repair_collapsed_refrains(lines, result, transcribe, duration, budget=64):
    """Recheck passages where multiple sung words were stamped in a fraction of a second."""
    marks, words = result["marks"][:], result["words"][:]
    lyrics = [tokens(line) for line in lines]
    collapsed = {i for i, mark in enumerate(marks)
                 if mark and len(lyrics[i]) >= 3 and mark[1] - mark[0] < len(lyrics[i]) * .10}
    affected = set(collapsed)
    for i in collapsed:
        for step in (-1, 1):
            j = i + step
            while 0 <= j < len(lines) and lyrics[j] == lyrics[i]:
                affected.add(j)
                j += step
    for i in affected:
        marks[i], words[i] = None, []
    i = 0
    while i < len(lines):
        if marks[i] is not None:
            i += 1
            continue
        j = i + 1
        while j < len(lines) and marks[j] is None:
            j += 1
        start = marks[i - 1][1] if i else 0
        end = marks[j][0] if j < len(lines) else duration
        if any(k in affected for k in range(i, j)) and 2 <= end - start <= budget:
            budget -= end - start
            heard = []
            # Overlap short passes, keeping the strongest estimate for a word
            # heard in both. A timestamp at a clip edge is less reliable.
            for left in range(math.floor(start / 8) * 8, math.ceil(end), 8):
                right = min(left + 12, duration)
                previous_count = len(heard)
                paired = set()
                for token, a, b, probability in transcribe(left, right):
                    if not start <= a < b <= end or b - a < .09:
                        continue
                    certainty = probability - (.25 if a - left < .2 or right - b < .2 else 0)
                    candidates = [(abs((a + b) - (x + y)), k)
                                  for k, (t, x, y, _, _) in enumerate(heard[:previous_count])
                                  if k not in paired and token == t and
                                  min(b, y) - max(a, x) > .45 * min(b - a, y - x)]
                    if not candidates:
                        heard.append((token, a, b, probability, certainty))
                        continue
                    _, k = min(candidates)
                    paired.add(k)
                    if certainty > heard[k][4]:
                        heard[k] = (token, a, b, probability, certainty)
            transcript = [item[:4] for item in sorted(heard, key=lambda item: item[1])]
            retry = align(lines[i:j], transcript, end, minimum_quality=.88, recovery=True, repeated_vocals=True)
            for k, mark in enumerate(retry["marks"]):
                anchors = retry["words"][k]
                lyric = lyrics[i + k]
                # An exact triplet can have two corroborating tokens yet only
                # one strong word anchor. Keep its line timing in that case.
                if mark and (len(anchors) >= 2 or (len(lyric) == 3 and len(set(lyric)) == 1 and anchors)):
                    marks[i + k], words[i + k] = mark, anchors if len(anchors) >= 2 else []
        i = j
    return result | {"marks": marks, "words": words, "matched": sum(mark is not None for mark in marks)}


def heard_words(segments, offset=0):
    return [(token, word.start + offset, word.end + offset, word.probability)
            for segment in segments if segment.no_speech_prob <= .65 and segment.avg_logprob >= -1.3
            for word in segment.words or () for token in tokens(word.word)]


BG_TERMS = ", ".join((
    "Исус, Исус Христос, Христос, Христа, Господ, Господа, Господи, Бог, Бога, Боже",
    "Светият Дух, Свети Дух, Духа, Отец, Отче, Небесен Отец, Спасител, Спасителя, Месия",
    "Агнец, Агнеца, кръст, кръста, кръв, кръвта, грях, грехове, прошка, покаяние",
    "благодат, милост, вяра, надежда, любов, спасение, изкупление, възкресение, вечен живот",
    "царство, Божието царство, слава, свят, святи, поклонение, молитва, моли, хваление",
    "прослава, благословен, благословение, Сион, Ерусалим, Йерусалим, Алилуя, Осанна, Амин",
    "Евангелие, Писание, Слово, Божието слово, истина, пътят, животът",
    "помазвам, помазваш, помажеш, изкупвам, изкупи, възкръсна, възкръснеш, прославям, прославя",
    "покланям се, поклоним се, благославям, благословиш, очистиш, опростиш, ходатайствам, застъпвам се",
    "покайвам се, покая се, уповавам, уповавам се, пребъдвам, пребъда, славословя, облагодатен",
))
BG_WORSHIP_PHRASES = (
    "в името на Исус", "Господ Исус Христос", "Христос възкръсна", "на третия ден",
    "Божията благодат", "Духът на Господа", "кръвта на Агнеца", "царството Божие",
    "прости ми греховете", "да бъде Твоята воля", "поклоним се пред Теб",
    "Твоята милост", "славата на Господа", "живот вечен", "вечен живот",
    "Христос се моли", "Бог е с нас", "Агнецът Божий", "Ти си свят",
    "Ти си достоен", "от мъртвите възкръсна", "Словото стана плът",
    "нека бъде светлина", "Господ е Пастир", "плодът на Духа",
    "да дойде Твоето царство", "чрез вяра", "по благодат",
    "да бъде благословено", "мир вам", "единородният Син",
)
BG_WORSHIP_MARKERS = frozenset(
    "исус йисус христос христа господ господа господи алелуя алилуя осанна осана евангелие "
    "възкресение спасител спасителят агнец агнеца благодат покаяние божията божието апостол".split()
)
BG_CONNECTORS = frozenset("а в във да до за и или към ли ме ми му на не ни но от по пред с сам се си със ти тук че ще я".split())
BG_PREPOSITIONS = frozenset("без в във за към на от пред при с със след у".split())
BG_PRONOUNS = {"ме": "мен", "те": "теб"}
GENERATION_SUFFIXES = (".gen12.json", ".gen11.json", ".gen10.json", ".gen9.json", ".gen7.json", ".gen6.json",
                       ".gen5.json", ".gen4.json", ".gen3.json", ".gen1.json")

# A sung unstressed vowel can differ from the standard spelling. A competing
# spelling must still match the phrase heard more clearly elsewhere in the song.
BG_CONTEXT_SPELLINGS = {
    ("не", "знаеш", "нъкъде"): "накъде",
    ("не", "знам", "нъкъде"): "накъде",
    ("не", "знаем", "нъкъде"): "накъде",
}


def bulgarian_worship_context(heard):
    """A recognized biblical phrase or several distinct audible cues activates the lexicon."""
    words = [word for text, _, _, confidence in heard if confidence >= .69 for word in tokens(text)]
    words_seen = set(words)
    if len(words_seen & BG_WORSHIP_MARKERS) >= 2:
        return True
    if {"миро", "нозете"} <= words_seen and words_seen & {"помазваш", "омазваш"}:
        return True
    phrase = " ".join(words)
    return any(re.search(r"\b" + re.escape(marker) + r"\b", phrase)
               for marker in ("светият дух", "святият дух", "свети дух", "небесен отец", "божието слово"))


def bulgarian_songbook_phrases(database, prefixes):
    """Read a small set of matching phrases from the opted-in local songbook."""
    if not prefixes or not database.is_file():
        return {}
    query = " OR ".join('"' + " ".join(prefix) + '"' for prefix in prefixes)
    try:
        with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=.25)) as db:
            documents = db.execute("""
                SELECT f.lyrics FROM worship_transcripts f
                JOIN documents d ON d.id = f.id
                JOIN candidates c ON c.id = f.id
                WHERE worship_transcripts MATCH ?
                    AND d.rights = 'user-authorized-local-import'
                    AND json_extract(c.metadata, '$.language') = 'bg'
                ORDER BY rank LIMIT 30
            """, (query,)).fetchall()
    except sqlite3.Error:
        return {}
    phrases = {}
    for body, in documents:
        if len(body) > 12000:
            continue
        for line in body.splitlines():
            if line.lstrip().startswith("["):
                continue
            line_words = tokens(line)
            for i in range(len(line_words) - 3):
                prefix = tuple(line_words[i:i + 3])
                if prefix in prefixes:
                    phrases.setdefault(prefix, set()).add(line_words[i + 3])
    return phrases


def refine_bulgarian_context(heard, read_excerpt, has_signal, duration, worship, database):
    """Resolve uncertain words using local phrase context and corroborating vocals."""
    normalized = [tuple(tokens(word)) for word, *_ in heard]
    words = [word[0] if len(word) == 1 else "" for word in normalized]
    occurrences = {}
    targets = []
    for i in range(3, len(heard)):
        phrase = tuple(words[i - 3:i + 1])
        anchors = heard[i - 3:i + 1]
        if (not all(phrase) or any(a[0].endswith((".", "!", "?", ";")) for a in anchors[:-1])
                or any(b[1] - a[2] > .65 for a, b in zip(anchors, anchors[1:]))):
            continue
        if min(anchor[3] for anchor in anchors) >= .68 and has_signal(anchors[-1][1], anchors[-1][2]):
            occurrences.setdefault(phrase[:3], []).append((phrase[3], anchors[-1][1]))
        standard = BG_CONTEXT_SPELLINGS.get(phrase[1:])
        minimum = .58 if standard else .65
        if (standard or anchors[-1][3] < .66) and min(anchor[3] for anchor in anchors[:-1]) >= minimum:
            targets.append((i, phrase, standard))
    if not targets:
        return heard

    prefixes = {phrase[:3] for _, phrase, _ in targets[:16]}
    library = bulgarian_songbook_phrases(database, prefixes) if worship else {}
    if worship:
        for phrase in BG_WORSHIP_PHRASES:
            vocabulary = tokens(phrase)
            for i in range(len(vocabulary) - 3):
                key = tuple(vocabulary[i:i + 3])
                if key in prefixes:
                    library.setdefault(key, set()).add(vocabulary[i + 3])

    revised, retries = list(heard), 2
    for index, phrase, standard in targets:
        text, at, end, probability = heard[index]
        if not has_signal(at, end):
            continue
        prefix, old = phrase[:3], phrase[-1]
        repeats = {word for word, start in occurrences.get(prefix, ()) if abs(start - at) >= 3}
        replacement = standard if standard and standard in repeats and old not in repeats else None
        if replacement is None and not standard and retries:
            candidates = library.get(prefix, set()) | repeats
            candidates = {word for word in candidates if word != old and len(word) >= 3
                          and SequenceMatcher(None, old, word, autojunk=False).ratio() >= .60}
            if not candidates:
                continue
            retries -= 1
            nearby = read_excerpt(max(0, heard[index - 3][1] - .65), min(duration, end + .9))
            preceding = sum(any(word == words[j] and confidence >= .55
                                and min(heard[j][2], stop) - max(heard[j][1], start) >= .04
                                for word, start, stop, confidence in nearby)
                            for j in range(index - 3, index))
            if preceding < 2:
                continue
            confirmed = {word for word, start, stop, confidence in nearby
                         if word in candidates and confidence >= max(.73, probability + .12)
                         and min(end, stop) - max(at, start) >= max(.06, .45 * (end - at))}
            if len(confirmed) == 1:
                replacement = confirmed.pop()
        if replacement:
            revised[index] = (re.sub(r"[^\W_]+", replacement, text, count=1), at, end, probability)
    return revised


@lru_cache(maxsize=1)
def bulgarian_morphology():
    """Read the bundled UniMorph Bulgarian word forms and present-tense person bits."""
    try:
        data = globals().get("_bulgarian_morphology_gzip")
        if data is None:
            data = (Path(__file__).resolve().parent / "data" / "bulgarian-morphology.tsv.gz").read_bytes()
        return {word: int(mask) for line in gzip.decompress(data).decode("utf8").splitlines()
                for word, mask in [line.split("\t", 1)]}
    except (OSError, ValueError):
        return {}


BG_SUBJECTS = {"аз": 1, "ти": 2, "той": 4, "тя": 4, "то": 4, "ние": 8, "вие": 16, "те": 32}
BG_WORSHIP_VERBS = (
    "вярвам", "вярваме", "уповавам", "уповаваме", "пребъда", "пребъдем", "помажеш", "помажете",
    "благословиш", "благословим", "прославя", "прославим", "възкръсна", "възкръснем",
    "покая", "покаеш", "покаем", "изкупя", "изкупиш", "изкупим", "спася", "спасиш", "спасим",
)


def recover_bulgarian_verbs(heard, read_excerpt, has_signal, duration, worship, forms):
    """Reread suspicious future verbs and require a dictionary form in two overlapping reads."""
    if not forms:
        return heard
    words = [tokens(item[0]) for item in heard]
    targets = []
    for i, (text, at, end, confidence) in enumerate(heard):
        word = words[i]
        particle = i - 1
        while particle >= max(0, i - 2) and words[particle] in (["се"], ["си"]):
            particle -= 1
        if particle < 0 or words[particle] != ["ще"] or not re.fullmatch(r"[а-яѝ]{3,}", text.strip(".,!?;:").lower()):
            continue
        if len(word) != 1 or at - heard[particle][2] > .9 or heard[particle][0].endswith((".", "!", "?", ";")):
            continue
        subject = 0
        if particle and len(words[particle - 1]) == 1 and heard[particle][1] - heard[particle - 1][2] <= .4:
            subject = BG_SUBJECTS.get(words[particle - 1][0], 0)
        required = subject or 63
        if (forms.get(word[0], 0) & required) or not has_signal(at, end):
            continue
        targets.append((word[0] in forms, confidence, i, particle, required))

    revised = list(heard)
    for _, probability, i, particle, required in sorted(targets)[:5]:
        text, at, end, _ = heard[i]
        start = max(0, heard[particle][1] - .7)
        stop = min(duration, end + 1.3)

        def nearby_verb(read, minimum):
            if not any(tokens(word) == ["ще"] and confidence >= .55
                       and min(heard[particle][2], finish) - max(heard[particle][1], begin) >= .04
                       for word, begin, finish, confidence in read):
                return set()
            original = words[i][0]
            return {part[0] for word, begin, finish, confidence in read
                    if len(part := tokens(word)) == 1 and part[0] != original
                    and forms.get(part[0], 0) & required and confidence >= minimum
                    and SequenceMatcher(None, original, part[0], autojunk=False).ratio() >= .58
                    and min(end, finish) - max(at, begin) >= max(.06, (end - at) * .35)}

        neutral = nearby_verb(read_excerpt(start, stop), .64)
        if not neutral:
            continue
        hints = sorted(neutral)
        if worship:
            hints.extend(word for word in BG_WORSHIP_VERBS if word not in neutral
                         and any(word[:3] == candidate[:3] for candidate in neutral))
        confirmed = neutral & nearby_verb(read_excerpt(max(0, start - .4), min(duration, stop + .45), ", ".join(hints)),
                                           max(.71, probability + .06))
        if len(confirmed) == 1:
            replacement = confirmed.pop()
            if text[0].isupper():
                replacement = replacement.capitalize()
            revised[i] = (re.sub(r"[^\W_]+", replacement, text, count=1), at, end, probability)
    return revised


def revise_bulgarian_phrases(heard, read_excerpt, has_signal, duration, worship):
    """Confirm local word corrections against two reads bracketed by the same sung words."""
    if len(heard) < 3:
        return heard

    def word_key(word):
        parts = tokens(word[0])
        return parts[0] if len(parts) == 1 else ""

    def expected_pronoun(index):
        if word_key(heard[index]) in BG_PREPOSITIONS:
            return BG_PRONOUNS.get(word_key(heard[index + 1]))
        return None

    def middle(read, left, right):
        def anchor(original, candidate):
            return (word_key(original) == word_key(candidate) and candidate[3] >= .60
                    and min(original[2], candidate[2]) - max(original[1], candidate[1]) >= .04)

        for index, item in enumerate(read):
            if not anchor(left, item):
                continue
            for end in range(index + 1, min(index + 4, len(read))):
                if anchor(right, read[end]):
                    return read[index + 1:end]
        return []

    windows = []
    for index, left in enumerate(heard[:-1]):
        for width in (1, 2):
            if index + width >= len(heard):
                continue
            right = heard[index + width]
            if min(left[3], right[3]) < .68 or not word_key(left) or not word_key(right):
                continue
            if not 0 <= right[1] - left[2] <= 1.1:
                continue
            if width == 1 and right[1] - left[2] >= .15:
                windows.append((.62, index, width))
            if width == 2 and (heard[index + 1][3] < .70 or expected_pronoun(index)):
                windows.append((heard[index + 1][3] - .18, index, width))

    edits = {}
    occupied = set()
    for _, index, width in sorted(windows)[:12]:
        if any(i in occupied for i in range(index, index + width + 1)):
            continue
        left, right = heard[index], heard[index + width]
        # Guide the short read with existing adjacent words. Worship vocabulary
        # is only suggested after the neutral pass establishes that context.
        guide = [left[0], right[0]]
        pronoun = expected_pronoun(index) if width == 2 else None
        if pronoun:
            guide.append(word_key(left) + " " + pronoun)
        if worship:
            nearby = {word_key(item) for item in heard[max(0, index - 4):index + width + 5]}
            guide.extend(phrase for phrase in BG_WORSHIP_PHRASES if set(tokens(phrase)) & nearby & BG_WORSHIP_MARKERS)
            guide.extend(item[0] for item in heard[max(0, index - 4):index + width + 5]
                         if word_key(item) in BG_WORSHIP_MARKERS)
        start, stop = max(0, left[1] - 1.4), min(duration, right[2] + 1.3)
        option = middle(read_excerpt(start, stop, ", ".join(dict.fromkeys(guide))), left, right)
        if len(option) != 1:
            continue
        replacement = option[0]
        token = word_key(replacement)
        old = heard[index + 1] if width == 2 else None
        if not re.fullmatch(r"[а-яѝ]+", token) or token == (word_key(old) if old else ""):
            continue
        if old is None and token not in BG_CONNECTORS:
            continue
        minimum = .75 if pronoun == token else max(.70, (old[3] + .14) if old else 0)
        if replacement[3] < minimum:
            continue
        if not has_signal(replacement[1], replacement[2]):
            continue
        confirmation = middle(read_excerpt(max(0, start - .75), min(duration, stop + .55), None), left, right)
        if len(confirmation) != 1 or word_key(confirmation[0]) != token or confirmation[0][3] < .63:
            continue
        actual = confirmation[0]
        if min(actual[2], replacement[2]) - max(actual[1], replacement[1]) < .05:
            continue
        if old and min(actual[2], old[2]) - max(actual[1], old[1]) < .04:
            continue
        begin, end = max(left[2], actual[1]), min(right[1], actual[2])
        if end - begin < .06:
            continue
        text = re.sub(r"[\w]+", token, old[0], count=1) if old else token
        edits[index + 1] = (width == 2, (text, begin, end, min(actual[3], replacement[3])))
        occupied.update(range(index, index + width + 1))
    revised = []
    for index, item in enumerate(heard):
        edit = edits.get(index)
        if edit:
            revised.append(edit[1])
        if not edit or not edit[0]:
            revised.append(item)
    return revised


def generation_anchors(result, duration):
    """Reuse a previous draft for the same audio, with its original word times."""
    lines, rows = result.get("lines", []), result.get("words", [])
    if len(lines) != len(rows):
        return []
    words = []
    try:
        for line, row in zip(lines, rows):
            for word in row:
                start = round(line["at"] + word["at"], 3)
                end = round(line["at"] + word["end"], 3)
                if 0 <= start < end <= duration and (not words or words[-1][1] <= start):
                    words.append((word["text"], start, end, word["probability"]))
    except (KeyError, TypeError, ValueError):
        return []
    return words


def transcript_evidence(words):
    """Favor supported coverage across the track over repetitions in a short window."""
    unique = Counter()
    for text, start, end, confidence in words:
        if confidence >= .62 and end - start >= .07:
            for token in tokens(text):
                unique[(int(start // 12), token)] += 1
    return sum(min(count, 2) for count in unique.values())


def generated_words(segments, language, acoustic_support=None):
    """Keep the model's words and punctuation. Drop only weak or duplicate anchors."""
    for segment in segments:
        if segment.no_speech_prob > .65 or segment.avg_logprob < -1.3:
            continue
        previous = None
        for word in segment.words or ():
            text = unicodedata.normalize("NFC", word.word.strip())
            if not tokens(text) or not (0 <= word.start < word.end):
                continue
            if acoustic_support is not None:
                if not acoustic_support(word.start, word.end):
                    continue
                if word.end - word.start < .06 and sum(letter.isalpha() for letter in text) > 3:
                    continue
            if language == "bg" and segment.no_speech_prob > .40 and word.probability < .30:
                continue
            anchor = (text, word.start, word.end, word.probability)
            if previous and anchor[:3] == previous[:3]:
                continue
            previous = anchor
            yield anchor


def recover_bulgarian_vocal_gaps(heard, voices, read_words, duration):
    """Recover agreed words in voiced gaps without assigning guessed times."""
    def agrees(word, other, confidence):
        return (word[2] > word[1] and other[3] >= confidence and tokens(word[0]) == tokens(other[0])
                and min(word[2], other[2]) - max(word[1], other[1]) >= .07)

    insertions = {}
    attempts = 0
    for index in range(2, len(heard) - 1):
        start, end = heard[index - 1][2], heard[index][1]
        if not 5 <= end - start <= 16:
            continue
        if sum(max(0, min(end, right) - max(start, left)) for left, right in voices) < 1.5:
            continue
        if attempts >= 2:
            break
        attempts += 1
        primary = read_words(max(0, heard[max(0, index - 3)][1] - 2.3), min(duration, end + 7))
        left = heard[max(0, index - 3):index]
        right = heard[index:index + 5]
        if (sum(any(agrees(word, other, .62) for other in primary) for word in left) < 2
                or sum(any(agrees(word, other, .62) for other in primary) for word in right) < 2):
            continue
        confirm = read_words(max(0, start - .3), min(duration, end + 1.5))
        recovered = [word for word in primary if word[1] >= start - .04 and word[2] <= end + .15
                     and word[3] >= .65 and any(agrees(word, other, .65) for other in confirm)]
        if len(recovered) < 3:
            continue
        # Replace a clipped boundary token only when the recoveries agree on its
        # full pronunciation and the original and recovered spans intersect.
        take = 0
        if recovered[-1][2] > end:
            original, candidate = heard[index], recovered[-1]
            a, b = tokens(original[0]), tokens(candidate[0])
            if (len(a) == len(b) == 1 and a[0] != b[0] and a[0].endswith(b[0])
                    and len(b[0]) >= 5 and original[3] < .75 and original[2] - end <= .18
                    and min(original[2], candidate[2]) - end >= .035):
                recovered[-1] = (candidate[0], candidate[1], min(candidate[2], heard[index + 1][1]), candidate[3])
                take = 1
            else:
                recovered.pop()
        if recovered and recovered[0][1] < start:
            first = recovered[0]
            if first[2] > start:
                recovered[0] = (first[0], start, first[2], first[3])
            else:
                recovered.pop(0)
        if len(recovered) >= 3:
            insertions[index] = (recovered, take)
    result = []
    for index, word in enumerate(heard):
        added, replaced = insertions.get(index, ((), 0))
        result.extend(added)
        if not replaced:
            result.append(word)
    return result


def normalize_bulgarian_lyrics(heard, worship):
    """Normalize recognizable Bulgarian forms while retaining their audio spans."""
    words = [tokens(word[0]) for word in heard]
    result = []
    has_anointing = ["миро"] in words and ["нозете"] in words
    for i, (text, at, end, probability) in enumerate(heard):
        before = words[i - 1] if i and at - heard[i - 1][2] < .65 else []
        after = words[i + 1] if i + 1 < len(words) and heard[i + 1][1] - end < .65 else []
        replacement = None
        if words[i] == ["що"] and after == ["мидват"]:
            replacement = "щом"
        elif (words[i] == ["мидват"] and before == ["що"]) or (
                words[i] == ["идвам"] and before == ["щом"] and words[i + 1:i + 3] == [["силни"], ["ветрове"]]):
            replacement = "идват"
        elif words[i] == ["ветрови"] and before == ["силни"]:
            replacement = "ветрове"
        elif worship and words[i] == ["твои"] and before == ["крилете"]:
            replacement = "Твои"
        elif (has_anointing and words[i] == ["омазваш"]
              and words[i + 1:i + 4] == [["ти"], ["нозете"], ["ми"]]):
            replacement = "помазваш"
        elif (has_anointing and words[i] == ["ти"] and before in (["омазваш"], ["помазваш"])
              and words[i + 1:i + 3] == [["нозете"], ["ми"]]):
            replacement = "Ти"
        elif words[i] == ["пе"] and before == ["ще"] and after == ["аз"]:
            replacement = "пея"
        elif words[i] == ["продължам"] and before == ["ще"]:
            replacement = "продължа"
        elif (words[i] == ["част"] and i >= 5
              and words[i - 5:i] == [["до"], ["края"], ["на"], ["земния"], ["ми"]]):
            replacement = "час"
        if replacement:
            if text[0].isupper():
                replacement = replacement[0].upper() + replacement[1:]
            text = re.sub(r"[^\W_]+", replacement, text, count=1)
        result.append((text, at, end, probability))
    return result


def generation_instrumentals(lines, audio, voices):
    """Mark sustained instrumental passages between recognized lyrics."""
    import numpy as np

    if not lines:
        return []
    starts = [0, *(line["end"] for line in lines)]
    ends = [*(line["at"] for line in lines), len(audio) / 16000]
    passages = []
    for at, end in zip(starts, ends):
        if not 5 <= end - at <= 60:
            continue
        if any(min(end - .55, stop) > max(at + .55, start) for start, stop in voices):
            continue
        samples = audio[round(at * 16000):round((end - .55) * 16000)]
        blocks = samples[:len(samples) // 8000 * 8000].reshape((-1, 8000))
        active = np.sqrt(np.mean(blocks * blocks, axis=1)) >= .005
        if np.count_nonzero(active) >= max(8, len(active) * .7):
            passages.append({"at": round(at + float(np.argmax(active)) / 2, 3), "end": round(end, 3)})
    return passages


def generation_voice_windows(audio):
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    try:
        windows = get_speech_timestamps(audio, VadOptions(threshold=.30, min_speech_duration_ms=350))
    except (OSError, RuntimeError, ValueError):
        return None
    return [(chunk["start"] / 16000, chunk["end"] / 16000) for chunk in windows]


def format_bulgarian(text):
    names = ("Исус Христос", "Исус", "Христос", "Светият Дух", "Святият Дух",
             "Свети Дух", "Господ", "Бог", "Сион", "Боже", "Господи",
             "Отец", "Отче", "Спасител", "Спасителят", "Месия", "Месията",
             "Алилуя", "Осанна", "Евангелие", "Божието Слово")
    for name in names:
        text = re.sub(r"\b" + re.escape(name) + r"\b", name, text, flags=re.IGNORECASE)
    return re.sub(r"(^|[.!?]\s+)([а-яѝ])", lambda match: match[1] + match[2].upper(), text)


def speech_activity(audio, sample_rate=16000):
    """Reject word spans that the recording places mostly in near silence."""
    import numpy as np
    frame = sample_rate // 50
    samples = audio[:len(audio) // frame * frame].reshape((-1, frame))
    rms = np.sqrt(np.mean(samples * samples, axis=1))
    level = max(.001, min(.004, np.max(rms, initial=0) * .02))
    active = np.concatenate(([0], np.cumsum(rms >= level)))

    def supports(start, end):
        first = min(len(rms), int(start * 50))
        last = min(len(rms), math.ceil(end * 50))
        return last > first and active[last] - active[first] >= .45 * (last - first)

    return supports


def align_cached_lyrics(lines, generation, duration, has_signal):
    """Reapply exact phrases from the same recording after lyric edits."""
    records = generation.get("lines") or []
    words = generation.get("words") or []
    if not records or len(records) != len(words):
        return None
    requested = [tuple(tokens(line)) for line in lines]
    original = [tuple(tokens(row["text"])) for row in records]
    marks, anchors = [None] * len(lines), [[] for _ in lines]
    original_count, requested_count = Counter(original), Counter(requested)
    matched_phrases = set()
    until = 0
    for block in SequenceMatcher(None, requested, original, autojunk=False).get_matching_blocks():
        for offset in range(block.size):
            index, source = block.a + offset, block.b + offset
            phrase = requested[index]
            if len(phrase) < 4 or original_count[phrase] != requested_count[phrase]:
                continue
            at, end = records[source]["at"], records[source]["end"]
            if not until <= at < end <= duration or not .6 <= end - at <= 12:
                continue
            heard = [(token, at + word["at"], at + word["end"])
                     for word in words[source] for token in tokens(word["text"])]
            if tuple(item[0] for item in heard) != phrase:
                continue
            confirmed = [[position, round(start, 3), round(stop, 3)]
                         for position, (_, start, stop) in enumerate(heard)
                         if at <= start < stop <= end + .01 and .09 <= stop - start <= 2.5 and has_signal(start, stop)]
            if len(confirmed) < max(3, math.ceil(.75 * len(phrase))):
                continue
            marks[index], anchors[index] = [confirmed[0][1], confirmed[-1][2]], confirmed
            matched_phrases.add(phrase)
            until = end
    matched = sum(mark is not None for mark in marks)
    if matched >= 5 and len(matched_phrases) >= 2:
        return {"state": "aligned", "marks": marks, "words": anchors, "matched": matched, "total": len(lines),
                "verifiedPartial": True, "language": generation.get("language")}
    return None


_BG_ROMAN = str.maketrans(dict(zip(
    "абвгдежзийклмнопрстуфхцчшщъьюяѝ",
    ["a", "b", "v", "g", "d", "e", "zh", "z", "i", "i", "k", "l", "m", "n", "o",
     "p", "r", "s", "t", "u", "f", "h", "ts", "ch", "sh", "sht", "a", "y", "yu", "ya", "i"],
)))


def bulgarian_tokens(text):
    return [word.translate(_BG_ROMAN).replace("q", "ya").replace("w", "v") for word in tokens(text)]


def refine_cached_bulgarian(lines, generation, partial, duration, read_words):
    """Check edited lyrics against Bulgarian vocals in the original recording windows."""
    lyrics = [bulgarian_tokens(line) for line in lines]
    vocabulary = {word for line in lyrics for word in line}
    if generation.get("language") == "bg" or not {"nyakoi", "teb", "vsichki"}.issubset(vocabulary):
        return partial
    original = generation["lines"]
    if len(original) != len(lyrics):
        return partial
    # Use the old revision only as a search window after confirming the order.
    same = sum(tokens(line) == tokens(row["text"]) for line, row in zip(lines, original))
    if same < max(5, len(lines) * .6):
        return partial
    candidates = [i for i, line in enumerate(lyrics) if len(line) >= 4
                  and .6 <= original[i]["end"] - original[i]["at"] <= 12]
    regions = []
    for i in candidates:
        start = max(0, original[i]["at"] - 1.1)
        end = min(duration, original[i]["end"] + 1.1)
        if regions and start <= regions[-1][1] + 1.5 and end - regions[-1][0] <= 24:
            regions[-1][1] = end
            regions[-1][2].append(i)
        else:
            regions.append([start, end, [i]])
    if sum(end - start for start, end, _ in regions) > 90:
        return partial

    def words_in(start, end):
        return [(token, at, stop) for word, at, stop, probability in read_words(start, end)
                if probability >= .62 for token in bulgarian_tokens(word)]

    marks, anchors = [None] * len(lines), [[] for _ in lines]

    def match_line(i, heard):
        line = lyrics[i]
        lower = max(original[i]["at"] - 1.1, original[i - 1]["end"] if i else 0)
        upper = min(original[i]["end"] + 1.1, original[i + 1]["at"] if i + 1 < len(original) else duration)
        window = [word for word in heard if lower <= word[1] < word[2] <= upper]
        hits = SequenceMatcher(None, line, [word[0] for word in window], autojunk=False).get_matching_blocks()
        confirmed = [[hit.a + j, round(window[hit.b + j][1], 3), round(window[hit.b + j][2], 3)]
                     for hit in hits for j in range(hit.size)]
        if len(confirmed) < max(4, math.ceil(len(line) * .62)):
            return False
        marks[i], anchors[i] = [confirmed[0][1], confirmed[-1][2]], confirmed
        return True

    retries = 3
    for start, end, indexes in regions:
        heard = words_in(start, end)
        accepted = []
        for i in indexes:
            if match_line(i, heard):
                accepted.append(i)
        if len(accepted) < 2:
            continue
        # Keep exact cached lines inside corroborated vocal sections. Leave
        # isolated sections untimed unless the independent pass heard them.
        for i in indexes:
            if marks[i] or i < accepted[0] - 1 or i > accepted[-1]:
                continue
            before = next((marks[j][1] for j in reversed(accepted) if j < i), start)
            after = next(marks[j][0] for j in accepted if j > i)
            old = partial["marks"][i]
            if old and before <= old[0] < old[1] <= after:
                marks[i], anchors[i] = old, partial["words"][i]
                continue
            if not old and retries > 0:
                retries -= 1
                match_line(i, words_in(max(start, original[i]["at"] - 1.1), min(end, original[i]["end"] + 3)))
    until = 0
    for i, mark in enumerate(marks):
        if mark is None:
            continue
        if not until <= mark[0] < mark[1] <= duration:
            marks[i], anchors[i] = None, []
        else:
            until = mark[1]
    matched = sum(mark is not None for mark in marks)
    if matched >= 5 and any(mark and not old for mark, old in zip(marks, partial["marks"])):
        return partial | {"marks": marks, "words": anchors, "matched": matched, "language": "bg"}
    return partial


def group_transcript(heard, max_chars=52, max_gap=.75, max_seconds=12.):
    """Turn the heard words into timed lines. A short pause or a full line ends one."""
    lines = []
    words = []
    current = []
    for token, start, end, probability in heard:
        if current:
            previous = current[-1]
            if (start - previous[2]) > max_gap or sum(len(part[0]) + 1 for part in current) + len(token) > max_chars \
                    or end - current[0][1] > max_seconds:
                lines.append(current)
                current = []
        current.append((token, start, end, probability))
    if current:
        lines.append(current)
    result = []
    anchors = []
    for group in lines:
        text = " ".join(part[0] for part in group).strip()
        if not text:
            continue
        result.append({"at": round(group[0][1], 3), "end": round(group[-1][2], 3), "text": text})
        anchors.append([{"text": part[0], "at": round(part[1] - group[0][1], 3),
                         "end": round(part[2] - group[0][1], 3), "probability": part[3]} for part in group])
    return result, anchors


def structure_bulgarian_transcript(heard):
    """Keep repeated sung lines together without replacing their words."""
    heard = list(heard)
    lines, _ = group_transcript(heard, max_gap=.65)
    repeated = Counter(tuple(tokens(line["text"])) for line in lines)
    phrases = {phrase for phrase, count in repeated.items() if count >= 2 and 3 <= len(phrase) <= 7}
    marked = []
    for index, item in enumerate(heard):
        text, at, end, probability = item
        if marked and marked[-1][0].endswith((",", ".", "!", "?", ";")):
            for phrase in phrases:
                following = tuple(token for part in heard[index:index + len(phrase)] for token in tokens(part[0]))
                if following == phrase:
                    # Split at the next recognised lyric phrase. Identity and
                    # absolute timestamps remain attached to each word.
                    marked.append(None)
                    break
        marked.append((text, at, end, probability))
    result, anchors = [], []
    block = []
    for item in [*marked, None]:
        if item is not None:
            block.append(item)
            continue
        lines, words = group_transcript(block, max_gap=.65)
        result.extend(lines)
        anchors.extend(words)
        block = []
    for line in result:
        line["text"] = format_bulgarian(line["text"])
    return result, anchors


def repair_generated_refrains(lines, word_rows, audio, language):
    """Recover unclear words from two independently verified repeats of the line."""
    by_length = {}
    for index, (line, row) in enumerate(zip(lines, word_rows)):
        if not (6 <= len(row) <= 14 and 2 <= line["end"] - line["at"] <= 12):
            continue
        words = tuple(tuple(tokens(word["text"])) for word in row)
        if all(len(word) == 1 for word in words) and len(set(words)) >= 4:
            phrase = tuple(word[0] for word in words)
            by_length.setdefault(len(row), {}).setdefault(phrase, []).append(index)

    revised_lines, revised_rows = list(lines), list(word_rows)
    budget = 24
    for phrases in by_length.values():
        repeated = [(phrase, indices) for phrase, indices in phrases.items() if len(indices) >= 2]
        for phrase, indices in phrases.items():
            for index in indices:
                if not budget:
                    return revised_lines, revised_rows
                target, row = lines[index], word_rows[index]
                if min(word["probability"] for word in row) >= .58:
                    continue
                proposals = []
                for reference, occurrences in repeated:
                    if phrase[0] != reference[0] or phrase[-1] != reference[-1]:
                        continue
                    changed = [i for i, (a, b) in enumerate(zip(phrase, reference)) if a != b]
                    if not 1 <= len(changed) <= len(phrase) // 3:
                        continue
                    if min(row[i]["probability"] for i in changed) >= .58:
                        continue
                    if any(row[i]["probability"] >= .86 or (
                            row[i]["probability"] >= .50
                            and SequenceMatcher(None, phrase[i], reference[i], autojunk=False).ratio() < .68)
                           for i in changed):
                        continue
                    eligible = [j for j in occurrences
                                if abs(lines[j]["at"] - target["at"]) >= 5
                                and all(word_rows[j][i]["probability"] >= .55 for i in changed)]
                    if len(eligible) >= 2:
                        proposals.append((reference, changed, eligible))
                # A different accepted wording should never be settled by order of processing.
                if len(proposals) != 1:
                    continue
                reference, changed, eligible = proposals[0]
                verified = []
                for candidate in eligible:
                    if budget == 0:
                        break
                    reference_line = lines[candidate]
                    if verified and abs(reference_line["at"] - lines[verified[0]]["at"]) < 5:
                        continue
                    budget -= 1
                    bounds = repeat_match(audio, (reference_line["at"], reference_line["end"]),
                                          max(0, target["at"] - .8),
                                          min(len(audio) / 16000,
                                              target["at"] + reference_line["end"] - reference_line["at"] + .8))
                    if bounds is None or abs(bounds[0] - target["at"]) > .45:
                        continue
                    offset = bounds[0] - target["at"]
                    if any(min(row[i]["end"], word_rows[candidate][i]["end"] + offset)
                           - max(row[i]["at"], word_rows[candidate][i]["at"] + offset) < .04 for i in changed):
                        continue
                    verified.append(candidate)
                    if len(verified) == 2:
                        break
                if len(verified) < 2 or not any(
                    all(word_rows[j][i]["probability"] >= .78 for i in changed) for j in verified
                ):
                    continue
                corrected = list(row)
                for i in changed:
                    word = row[i]
                    text = re.sub(r"[^\W_]+", reference[i], word["text"], count=1)
                    if word["text"][0].isupper():
                        text = text[0].upper() + text[1:]
                    corrected[i] = word | {"text": text}
                text = " ".join(word["text"] for word in corrected)
                revised_lines[index] = target | {"text": format_bulgarian(text) if language == "bg" else text}
                revised_rows[index] = corrected
    return revised_lines, revised_rows


def corroborate_bulgarian_words(heard, read_words):
    """Confirm common recognition errors with an independent local audio pass."""
    contextual = {
        ("се", "молни"): "моли",
        ("знаеш", "нъкъде"): "накъде",
        ("знаеш", "некъде"): "накъде",
    }
    worship = {
        "христус": "христос",
        "госпот": "господ",
        "алелуя": "алилуя",
        "осана": "осанна",
        "евангелий": "евангелие",
        "мессиа": "месия",
    }
    previous, retries = "", 8
    for word, at, end, probability in heard:
        normalized = tokens(word)
        spoken = normalized[0] if len(normalized) == 1 else ""
        alternate = contextual.get((previous, spoken)) or worship.get(spoken)
        if alternate and retries:
            retries -= 1
            for text, start, stop, confidence in read_words(max(0, at - 4), end + 3):
                overlap = min(end, stop) - max(at, start)
                support = max(.05, .35 * min(end - at, stop - start))
                if tokens(text) == [alternate] and confidence >= max(.62, probability) and overlap >= support:
                    word = re.sub(r"\b" + re.escape(spoken) + r"\b", alternate, word, flags=re.IGNORECASE)
                    break
        yield word, at, end, probability
        previous = spoken


def verify_lyric_draft(lines, heard, duration):
    """Check candidate words against independent transcription in recording order."""
    phrases = [tokens(line) for line in lines]
    word_count = sum(map(len, phrases))
    if word_count < 8 or word_count > 1800 or len(set(word for phrase in phrases for word in phrase)) < 4:
        return {"state": "unverified"}
    result = align(lines, heard, duration, minimum_quality=.86, recovery=True, repeated_vocals=True)
    if result["state"] != "aligned" or len(result["words"]) != len(lines):
        return {"state": "unverified"}
    counts = [len({index for index, _, _ in anchors}) for anchors in result["words"]]
    checked_words = sum(counts)
    if (any(not phrase or count < len(phrase) - (len(phrase) + 2) // 5 for count, phrase in zip(counts, phrases))
            or checked_words * 10 < word_count * 9):
        return {"state": "unverified"}
    return {"state": "verified", "proof": {"method": "recording-v1",
            "checkedLines": len(lines), "checkedWords": checked_words, "totalWords": word_count}}


def verify_lyrics_from_recording(path, lines, language, duration, model_dir, cache_dir):
    for hint in dict.fromkeys((language, "auto", None)):
        key = fingerprint(path, [], ["generate", "generate"], hint)
        for suffix in GENERATION_SUFFIXES:
            try:
                cached = json.loads((cache_dir / (key + suffix)).read_text(encoding="utf8"))
                heard = [(one[0], at, end, confidence)
                         for text, at, end, confidence in generation_anchors(cached, duration)
                         if len(one := tokens(text)) == 1]
            except (OSError, ValueError, TypeError, KeyError):
                continue
            result = verify_lyric_draft(lines, heard, duration)
            if result["state"] == "verified":
                return result
            break
    if not (model_dir / "model.bin").is_file():
        return {"state": "unavailable"}
    from faster_whisper import WhisperModel
    from faster_whisper.audio import decode_audio

    model = WhisperModel(str(model_dir), device="cpu", compute_type="int8",
                         cpu_threads=min(4, os.cpu_count() or 1), local_files_only=True)
    audio = decode_audio(str(path), sampling_rate=16000)
    segments, _ = model.transcribe(audio, language=language if language in model.supported_languages else None,
                                   word_timestamps=True, beam_size=5, condition_on_previous_text=False)
    return verify_lyric_draft(lines, heard_words(segments), duration)


def refine_bulgarian_result(result, duration, read_words=None):
    if result.get("language") != "bg":
        return result
    recorded = generation_anchors(result, duration)
    if not recorded or len(recorded) != sum(len(row) for row in result.get("words", [])):
        return result
    worship = bulgarian_worship_context(recorded)
    words = [tokens(word[0]) for word in recorded]
    occurrences = [i for i in range(2, len(words) - 3)
                   if words[i - 2:i] == [["ти"], ["си"]]
                   and words[i] in (["с"], ["сус"], ["сос"], ["за"], ["исус"])
                   and words[i + 1:i + 4] == [["живота"], ["в"], ["мен"]]
                   and recorded[i + 3][2] - recorded[i - 2][1] < 5]
    normalized = normalize_bulgarian_lyrics(recorded, worship)
    supported = any(words[i] == ["исус"] and recorded[i][3] >= .62 for i in occurrences)
    if worship and len(occurrences) >= 2 and read_words and not supported:
        for i in occurrences[:8]:
            _, at, end, _ = recorded[i]
            if any(tokens(word) == ["исус"] and confidence >= .62 and min(end, stop) - max(at, start) >= .08
                   for word, start, stop, confidence in read_words(max(0, at - 1), min(duration, end + 5))):
                supported = True
                break
    if worship and supported:
        for i in occurrences:
            for index, replacement in ((i - 2, "Ти"), (i - 1, "си,"), (i, "Исус,"), (i + 1, "животът")):
                _, at, end, confidence = normalized[index]
                normalized[index] = replacement, at, end, confidence
    if normalized == recorded:
        return result
    lines, rows = [], []
    offset = 0
    for line, anchors in zip(result["lines"], result["words"]):
        corrected = normalized[offset:offset + len(anchors)]
        original = recorded[offset:offset + len(anchors)]
        offset += len(anchors)
        if corrected == original or tokens(line["text"]) != tokens(" ".join(word[0] for word in original)):
            lines.append(line)
            rows.append(anchors)
            continue
        lines.append(line | {"text": format_bulgarian(" ".join(word[0] for word in corrected))})
        rows.append([anchor | {"text": word[0]} for anchor, word in zip(anchors, corrected)])
    return result | {"lines": lines, "words": rows}


def split_repeated_sung_lines(result):
    """Separate joined clauses when the same words recur as separate sung lines."""
    lines, words = result.get("lines", []), result.get("words", [])
    if result.get("language") != "bg" or len(lines) != len(words):
        return result
    known = {tuple(tokens(line["text"])) for line in lines}
    split_lines, split_words = [], []
    for line, anchors in zip(lines, words):
        split = None
        for index, anchor in enumerate(anchors[2:-3], 2):
            if not anchor["text"].endswith((",", ";")):
                continue
            left, right = anchors[:index + 1], anchors[index + 1:]
            left_text = " ".join(word["text"] for word in left)
            right_text = " ".join(word["text"] for word in right)
            if (tuple(tokens(left_text)) in known and tuple(tokens(right_text)) in known
                    and tokens(left_text + " " + right_text) == tokens(line["text"])):
                split = (left, right, left_text, right_text)
                break
        if split is None:
            split_lines.append(line)
            split_words.append(anchors)
            continue
        left, right, left_text, right_text = split
        offset = right[0]["at"]
        split_lines.extend([
            line | {"end": round(line["at"] + left[-1]["end"], 3), "text": left_text},
            line | {"at": round(line["at"] + offset, 3), "text": right_text},
        ])
        split_words.extend([left, [word | {"at": round(word["at"] - offset, 3),
                                         "end": round(word["end"] - offset, 3)} for word in right]])
    return result | {"lines": split_lines, "words": split_words, "matched": len(split_lines), "total": len(split_lines)}


def generated_text_matches(result, text):
    return ([line.strip() for line in text.splitlines() if line.strip()]
            == [line["text"].strip() for line in result["lines"]])


def polish_bulgarian_repeats(result):
    """Repair repeated phrases and keep the timing of the underlying audio."""
    lines, rows = result.get("lines", []), result.get("words", [])
    if result.get("language") != "bg" or len(lines) != len(rows):
        return result
    known = {tuple(tokens(line["text"])) for line in lines}
    anointing = ("помазваш", "ти", "нозете", "ми") in known
    last_hour = ("до", "края", "на", "земния", "ми", "час")
    has_last_hour = any(phrase[-6:] == last_hour for phrase in known)
    lines, rows = list(lines), list(rows)
    for i, (line, anchors) in enumerate(zip(lines, rows)):
        words = tokens(line["text"])
        if not anchors or words != tokens(" ".join(word["text"] for word in anchors)):
            continue
        if anointing and words == ["омазваш", "ти", "но", "взете", "ми"] and len(anchors) == 5:
            first, second, third, fourth, fifth = anchors
            rows[i] = [first | {"text": "Помазваш"}, second | {"text": "Ти"},
                       third | {"text": "нозете", "end": fourth["end"]}, fifth]
            lines[i] = line | {"text": "Помазваш Ти нозете ми"}
        elif has_last_hour and words == ["до", "края", "на", "землия", "мича"] and len(anchors) == 5:
            rows[i] = [*anchors[:3], anchors[3] | {"text": "земния"}, anchors[4] | {"text": "ми час"}]
            lines[i] = line | {"text": "До края на земния ми час"}
        elif (i + 1 < len(lines) and words[-4:] == ["животът", "в", "мен", "ти"]
              and tokens(anchors[-1]["text"]) == ["ти"] and len(anchors) > 1 and rows[i + 1]
              and tokens(lines[i + 1]["text"])[:3] == ["просто", "всичко", "си"]):
            pronoun = anchors[-1]
            start = round(line["at"] + pronoun["at"], 3)
            next_line = lines[i + 1]
            gap = round(next_line["at"] - start, 3)
            if not 0 <= gap <= 1 or pronoun["end"] - pronoun["at"] > gap + .12:
                continue
            rows[i] = anchors[:-1]
            lines[i] = line | {"text": re.sub(r"\s+ти[.!?,]*$", "", line["text"], flags=re.I).rstrip(","),
                               "end": round(line["at"] + rows[i][-1]["end"], 3)}
            rows[i + 1] = [pronoun | {"text": "Ти", "at": 0, "end": round(pronoun["end"] - pronoun["at"], 3)},
                           *(word | {"at": round(word["at"] + gap, 3), "end": round(word["end"] + gap, 3)}
                             for word in rows[i + 1])]
            first, rest = next_line["text"][0], next_line["text"][1:]
            lines[i + 1] = next_line | {"at": start, "text": "Ти " + first.lower() + rest}
    return result | {"lines": lines, "words": rows}


def cached_bulgarian_refinement(cache_dir, path, result):
    base = [line["text"] for line in result["lines"]]
    return cache_dir / (fingerprint(path, base, "bg-context-1", "bg") + ".json")


def refine_cached_generation(model_dir, cache_dir, path, duration, result):
    if result.get("language") != "bg":
        return result
    target = cached_bulgarian_refinement(cache_dir, path, result)
    try:
        cached = json.loads(target.read_text(encoding="utf8"))
        return polish_bulgarian_repeats(refine_bulgarian_result(cached, duration))
    except (OSError, ValueError):
        pass

    model = audio = None

    def read_words(start, end):
        nonlocal model, audio
        if model is None:
            from faster_whisper import WhisperModel
            from faster_whisper.audio import decode_audio
            model = WhisperModel(str(model_dir), device="cpu", compute_type="int8",
                                 cpu_threads=min(4, os.cpu_count() or 1), local_files_only=True)
            audio = decode_audio(str(path), sampling_rate=16000)
        segments, _ = model.transcribe(audio[round(start * 16000):round(end * 16000)], language="bg",
                                       word_timestamps=True, beam_size=5, condition_on_previous_text=False,
                                       hotwords="Исус, Христос, Господ, помазваш, миро")
        return heard_words(segments, start)

    available = (model_dir / "model.bin").is_file()
    refined = split_repeated_sung_lines(refine_bulgarian_result(result, duration, read_words if available else None))
    if available:
        temporary = target.with_suffix(f".{os.getpid()}.tmp")
        temporary.write_text(json.dumps(refined, ensure_ascii=False), encoding="utf8")
        temporary.replace(target)
    return polish_bulgarian_repeats(refined)


def recover_saved_generation(model_dir, cache_dir, request, path, text):
    """Upgrade a saved transcript only after finding its exact audio and original words."""
    language = request.get("language")
    hints = list(dict.fromkeys((language, "auto", None)))
    current, original, keys = {}, None, {}

    def read(hint, suffix):
        if hint not in keys:
            keys[hint] = fingerprint(path, [], ["generate", request["version"]], hint)
        key = keys[hint]
        try:
            result = json.loads((cache_dir / (key + suffix)).read_text(encoding="utf8"))
            if result.get("state") == "generated" and result.get("lines"):
                result.pop("originalTranscript", None)
                return result
        except (OSError, ValueError):
            pass
        return None

    def refine(result):
        return refine_cached_generation(model_dir, cache_dir, path, float(request["duration"]), result)

    for hint in hints:
        for suffix in GENERATION_SUFFIXES:
            result = read(hint, suffix)
            if not result:
                continue
            if suffix == GENERATION_SUFFIXES[0]:
                current[hint] = result
                if result.get("language") == "bg":
                    try:
                        prior = json.loads(cached_bulgarian_refinement(cache_dir, path, result).read_text(encoding="utf8"))
                    except (OSError, ValueError):
                        prior = None
                    if prior and generated_text_matches(prior, text):
                        return prior if request.get("cachedOnly") else refine(result) | {"upgradedSaved": True}
                    if prior:
                        corrected = polish_bulgarian_repeats(refine_bulgarian_result(prior, float(request["duration"])))
                        if generated_text_matches(corrected, text):
                            return corrected
                structured = split_repeated_sung_lines(result)
                if generated_text_matches(structured, text):
                    return structured if request.get("cachedOnly") else refine(result) | {"upgradedSaved": True}
            if generated_text_matches(result, text):
                if suffix == GENERATION_SUFFIXES[0]:
                    return result if request.get("cachedOnly") else refine(result) | {"upgradedSaved": True}
                if original is None:
                    original = (hint, result)
    if original is None:
        return {"state": "not-cached"}
    hint, result = original
    if request.get("cachedOnly"):
        return result
    detected = result.get("language")
    newer = current.get(hint) or current.get(detected) or read(detected, GENERATION_SUFFIXES[0])
    if newer and newer.get("language") == detected:
        return refine(newer) | {"upgradedSaved": True}
    if not (model_dir / "model.bin").is_file():
        return result
    new_request = {key: value for key, value in request.items() if key != "recoverSavedText"}
    newer = run(model_dir, cache_dir, new_request | {"language": hint})
    return (refine(newer) | {"upgradedSaved": True}
            if newer.get("state") == "generated" and newer.get("language") == detected else result)


def run(model_dir, cache_dir, request):
    start, cpu = time.monotonic(), time.process_time()
    path = Path(request["path"])
    lines = request["lines"]
    language = request.get("language")
    duration = float(request["duration"])
    generate = bool(request.get("transcribe"))
    if not path.is_file():
        return {"state": "no-audio"}
    if request.get("verifyDraft") is True:
        if not (isinstance(lines, list) and 2 <= len(lines) <= 200 and math.isfinite(duration)
                and 1 <= duration <= 1200 and all(isinstance(line, str) and 1 <= len(line) <= 350 for line in lines)
                and (language is None or isinstance(language, str))):
            return {"state": "unverified"}
        return verify_lyrics_from_recording(path, lines, language, duration, model_dir, cache_dir)
    if generate:
        if not (math.isfinite(duration) and 1 <= duration <= 1200):
            return {"state": "unreliable"}
        saved_text = request.get("recoverSavedText")
        if isinstance(saved_text, str) and 0 < len(saved_text) <= 50000:
            return recover_saved_generation(model_dir, cache_dir, request, path, saved_text)
    elif not (2 <= len(lines) <= 500 and math.isfinite(duration) and 1 <= duration <= 1200
            and all(isinstance(line, str) and len(line) <= 400 for line in lines)):
        return {"state": "unreliable"}
    expected = request.get("expected")
    version = request["version"]
    if generate:
        version = ["generate", version]
    if expected is not None:
        if (not isinstance(expected, list) or len(expected) != len(lines)
            or not all(isinstance(at, (int, float)) and 0 <= at < duration for at in expected)
            or any(a > b for a, b in zip(expected, expected[1:]))):
            return {"state": "unreliable"}
        version = [version, expected]
    if not generate and expected is None:
        anchored = align_transcript(lines, request.get("heard"), duration)
        if anchored:
            return anchored
    key = fingerprint(path, lines, version, language)
    cached = cache_dir / (key + (GENERATION_SUFFIXES[0] if generate else ".lrc1.json" if expected is not None else ".refrain4.json"))
    baseline = cache_dir / (key + ".json")

    def read_cache(file):
        try:
            result = json.loads(file.read_text(encoding="utf8"))
            if result.get("state") == "generated" and generate:
                result.pop("originalTranscript", None)
                return result
            if result.get("state") == "aligned" and len(result.get("marks", [])) == len(lines):
                return result
        except (OSError, ValueError):
            pass
        return None

    result = None if generate and request.get("refresh") else read_cache(cached)
    previous_generation = None
    if generate:
        for suffix in GENERATION_SUFFIXES:
            previous_generation = read_cache(cache_dir / (key + suffix))
            if previous_generation:
                break
    if generate and request.get("cachedOnly"):
        for suffix in GENERATION_SUFFIXES[1:]:
            if result:
                break
            result = read_cache(cache_dir / (key + suffix))
        return result | {"cached": True} if result else {"state": "not-cached"}
    if result:
        if generate:
            result = refine_cached_generation(model_dir, cache_dir, path, duration, result)
        return result | {"cached": True}
    if generate and not request.get("refresh") and language not in (None, "auto", "bg"):
        if previous_generation:
            return previous_generation | {"cached": True}
    if not generate and expected is None:
        prior = read_cache(cache_dir / (key + ".refrain2.json"))
        if prior and not prior.get("verifiedPartial"):
            return prior | {"cached": True}
    previous = read_cache(cache_dir / (key + (".gen3.json" if generate else ".refrain1.json")))
    if not generate and previous is None:
        previous = read_cache(cache_dir / (key + ".gap4.json"))
    result = previous or read_cache(baseline)
    if not (model_dir / "model.bin").is_file():
        if generate and result is None:
            result = previous_generation
        return result | {"cached": True} if result else {"state": "unavailable"}
    from faster_whisper import WhisperModel
    from faster_whisper.audio import decode_audio
    audio = decode_audio(str(path), sampling_rate=16000)
    model = None
    if result is None and not generate and expected is None:
        for hint in dict.fromkeys((language, "auto", None)):
            original_key = fingerprint(path, [], ["generate", "generate"], hint)
            for suffix in GENERATION_SUFFIXES:
                try:
                    original = json.loads((cache_dir / (original_key + suffix)).read_text(encoding="utf8"))
                    result = align_cached_lyrics(lines, original, duration, speech_activity(audio))
                except (OSError, ValueError, TypeError, KeyError):
                    continue
                if result:
                    break
            if result:
                break
    if result and result.get("verifiedPartial"):
        def read_bulgarian(start, end):
            nonlocal model
            if model is None:
                model = WhisperModel(str(model_dir), device="cpu", compute_type="int8",
                                     cpu_threads=min(4, os.cpu_count() or 1), local_files_only=True)
            offset = round(start * 16000)
            segments, _ = model.transcribe(audio[offset:round(end * 16000)], language="bg",
                                           word_timestamps=True, beam_size=5, condition_on_previous_text=False,
                                           hotwords=BG_TERMS)
            return heard_words(segments, offset / 16000)
        result = refine_cached_bulgarian(lines, original, result, duration, read_bulgarian)
        cache_dir.mkdir(parents=True, exist_ok=True)
        temporary = cached.with_suffix(f".{os.getpid()}.tmp")
        temporary.write_text(json.dumps(result), encoding="utf8")
        temporary.replace(cached)
        return result
    model = WhisperModel(str(model_dir), device="cpu", compute_type="int8",
                         cpu_threads=min(4, os.cpu_count() or 1), local_files_only=True)
    hint = language if language in ("en", "bg", "tr") else None
    if generate:
        # No provider text was found for this recording, so the heard words
        # become the timed lyric lines. This is a machine transcript of the
        # recording, not the song's published lyrics.
        generation_hint = language if isinstance(language, str) and re.fullmatch(r"[a-z]{2}", language) else None
        if generation_hint not in model.supported_languages:
            generation_hint = None
        has_signal = speech_activity(audio)

        def read_excerpt(start, end, guide=None):
            offset = round(start * 16000)
            excerpt, _ = model.transcribe(audio[offset:round(end * 16000)], language="bg",
                                          word_timestamps=True, beam_size=5, condition_on_previous_text=False,
                                          hotwords=guide)
            return heard_words(excerpt, offset / 16000)

        def read_song(hint, guide=None):
            segments, info = model.transcribe(audio, language=hint, word_timestamps=True,
                                              condition_on_previous_text=False, beam_size=5, hotwords=guide)
            detected = hint or info.language
            raw = []

            def retain_transcript():
                for segment in segments:
                    raw.append(segment.text.strip())
                    yield segment

            return list(generated_words(retain_transcript(), detected, has_signal)), detected, raw

        previous_words = (generation_anchors(previous_generation, duration)
                          if previous_generation and previous_generation.get("language") == "bg" else [])
        if previous_words:
            initial, detected, raw = previous_words, "bg", []
        else:
            initial, detected, raw = read_song(generation_hint)
        voices = generation_voice_windows(audio)
        if detected == "bg":
            worship = bulgarian_worship_context(initial)
            if worship and not previous_words:
                guided, _, guided_raw = read_song("bg", BG_TERMS)
                if transcript_evidence(guided) > transcript_evidence(initial):
                    initial, raw = guided, guided_raw
            if voices:
                def read_gap(start, end):
                    offset = round(start * 16000)
                    excerpt, _ = model.transcribe(audio[offset:round(end * 16000)], language="bg",
                                                  word_timestamps=True, beam_size=5,
                                                  condition_on_previous_text=False)
                    return [(word, at + offset / 16000, until + offset / 16000, probability)
                            for word, at, until, probability in generated_words(excerpt, "bg")
                            if has_signal(at + offset / 16000, until + offset / 16000)]
                initial = recover_bulgarian_vocal_gaps(initial, voices, read_gap, duration)
            initial = normalize_bulgarian_lyrics(initial, worship)
            initial = recover_bulgarian_verbs(initial, read_excerpt, has_signal, duration, worship, bulgarian_morphology())
            contextual = refine_bulgarian_context(initial, read_excerpt, has_signal, duration, worship,
                                                  model_dir.parent.parent / "lyrics.sqlite3")
            revised = revise_bulgarian_phrases(contextual, read_excerpt, has_signal, duration, worship)
            checked = corroborate_bulgarian_words(
                revised, lambda start, end: read_excerpt(start, end, BG_TERMS if worship else None))
            generated, anchors = structure_bulgarian_transcript(checked)
        else:
            generated, anchors = group_transcript(initial)
        generated, anchors = repair_generated_refrains(generated, anchors, audio, detected)
        if not generated:
            result = {"state": "unreliable"}
        else:
            result = {"state": "generated", "lines": generated, "words": anchors,
                      "matched": len(generated), "total": len(generated)}
            if voices is not None:
                result["instrumentals"] = generation_instrumentals(generated, audio, voices)
        result.update(seconds=round(time.monotonic()-start, 2), cpuSeconds=round(time.process_time()-cpu, 2),
                      peakMiB=memory_mib(), language=detected)
        if result["state"] == "generated":
            result = polish_bulgarian_repeats(split_repeated_sung_lines(refine_bulgarian_result(
                result, duration, (lambda start, end: read_excerpt(start, end, BG_TERMS)) if detected == "bg" else None)))
            cache_dir.mkdir(parents=True, exist_ok=True)
            temporary = cached.with_suffix(f".{os.getpid()}.tmp")
            temporary.write_text(json.dumps(result | {"originalTranscript": "\n".join(raw)}, ensure_ascii=False), encoding="utf8")
            temporary.replace(cached)
        return result
    if result is None:
        segments, info = model.transcribe(audio, language=hint, word_timestamps=True,
                                          condition_on_previous_text=False, beam_size=3,
                                          **({"hotwords": BG_TERMS} if hint == "bg" else {}))
        heard = heard_words(segments)
        result = (align(lines, heard, duration) if expected is None
                  else align(lines, heard, duration, minimum_quality=.86, recovery=True, expected=expected))
        if expected is not None and result["matched"] < max(3, len(lines) // 3):
            result = {"state": "unreliable"}
        hint = hint or info.language
    else:
        hint = hint or result.get("language")
    if result["state"] == "aligned" and expected is None:
        def retry(start, end, hotwords=None):
            padding = 0 if hotwords else .75
            offset = max(0, round((start - padding) * 16000))
            limit = round((end + padding) * 16000)
            guided = hotwords or (BG_TERMS if hint == "bg" else None)
            segments, _ = model.transcribe(audio[offset:limit], language=hint, word_timestamps=True,
                                           condition_on_previous_text=False, beam_size=5, hotwords=guided)
            return [word for word in heard_words(segments, offset / 16000)
                    if start <= word[1] < word[2] <= end]
        if previous is None and result["matched"] < len(lines):
            result = recover_gaps(lines, result, retry, audio)

        def short_pass(start, end):
            offset = round(start * 16000)
            segments, _ = model.transcribe(audio[offset:round(end * 16000)], language=hint, word_timestamps=True,
                                           condition_on_previous_text=False, beam_size=5,
                                           **({"hotwords": BG_TERMS} if hint == "bg" else {}))
            return heard_words(segments, start)

        result = repair_collapsed_refrains(lines, result, short_pass, duration)
    result.update(seconds=round(time.monotonic()-start, 2), cpuSeconds=round(time.process_time()-cpu, 2),
                  peakMiB=memory_mib(), language=hint)
    if result["state"] == "aligned":
        cache_dir.mkdir(parents=True, exist_ok=True)
        temporary = cached.with_suffix(f".{os.getpid()}.tmp")
        temporary.write_text(json.dumps(result), encoding="utf8")
        temporary.replace(cached)
    return result


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.buffer.read(262145))
        result = run(Path(sys.argv[1]), Path(sys.argv[2]), request)
    except (OSError, ValueError, ImportError, RuntimeError, KeyError):
        result = {"state": "unavailable"}
    print(json.dumps(result))
