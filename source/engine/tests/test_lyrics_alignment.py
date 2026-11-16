import json
import sys
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lyrics_alignment import BG_TERMS, align, align_cached_lyrics, align_transcript, bulgarian_worship_context, corroborate_bulgarian_words, format_bulgarian, generated_words, generation_anchors, group_transcript, recover_gaps, refine_bulgarian_context, repair_collapsed_refrains, repeat_match, revise_bulgarian_phrases, structure_bulgarian_transcript, tokens, transcript_evidence
from lyrics_alignment import GENERATION_SUFFIXES, fingerprint, generation_instrumentals, normalize_bulgarian_lyrics, recover_bulgarian_vocal_gaps, repair_generated_refrains, run, verify_lyric_draft


def transcript(parts):
    words = []
    for start, text in parts:
        words.extend((word, start + i * .3, start + i * .3 + .2, .96)
                     for i, word in enumerate(tokens(text)))
    return words


class AlignmentTests(unittest.TestCase):
    def test_bulgarian_verb_dictionary_requires_audio_and_subject_agreement(self):
        from lyrics_alignment import bulgarian_morphology, recover_bulgarian_verbs
        forms = bulgarian_morphology()
        self.assertGreater(len(forms), 30000)
        self.assertEqual(forms["продължа"], 1)
        self.assertEqual(forms["продължавам"], 1)
        self.assertNotIn("продължам", forms)
        phrase = [("Ние", 1, 1.2, .9), ("ще", 1.2, 1.4, .9), ("вярвем", 1.4, 1.8, .51)]
        heard = [phrase[1], ("вярваме", 1.4, 1.8, .91)]
        revise = lambda reader: recover_bulgarian_verbs(phrase, reader, lambda *_: True, 15, True, forms)
        self.assertEqual(revise(lambda *args: heard)[-1], ("вярваме", 1.4, 1.8, .51))
        self.assertEqual(revise(lambda *args: [phrase[1], ("вярвам", 1.4, 1.8, .95)]), phrase)
        self.assertEqual(revise(lambda *args: heard if len(args) == 2 else []), phrase)
        self.assertEqual(revise(lambda *args: [("вярваме", 5, 6, .95)]), phrase)

    def test_future_form_uses_standard_bulgarian_without_changing_timing(self):
        words = transcript([(1, "при теб ще продължам"), (7, "ще продължавам да пея")])
        corrected = normalize_bulgarian_lyrics(words, False)
        self.assertEqual(" ".join(word[0] for word in corrected), "при теб ще продължа ще продължавам да пея")
        self.assertEqual([word[1:] for word in corrected], [word[1:] for word in words])

    def test_bulgarian_phrase_context_preserves_word_timing(self):
        words = transcript([(1, "омазваш ти нозете ми със миро"), (6, "ще пе аз до края на земния ми част"),
                            (12, "една част от песента")])
        corrected = normalize_bulgarian_lyrics(words, True)
        self.assertEqual(" ".join(word[0] for word in corrected),
                         "помазваш Ти нозете ми със миро ще пея аз до края на земния ми час една част от песента")
        self.assertEqual([word[1:] for word in corrected], [word[1:] for word in words])

    def test_recover_upgrades_a_saved_generation_across_language_hints(self):
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder)
            path = cache / "audio.wav"
            path.write_bytes(b"same-recording-fixture")
            older = {"state": "generated", "language": "bg", "lines": [{"text": "По-ранен текст"}]}
            newer = {"state": "generated", "language": "bg",
                     "lines": [{"text": "Коригиран текст"}], "instrumentals": [{"at": 1, "end": 6}]}
            older_key = fingerprint(path, [], ["generate", "generate"], "auto")
            newer_key = fingerprint(path, [], ["generate", "generate"], "bg")
            (cache / (older_key + GENERATION_SUFFIXES[1])).write_text(json.dumps(older), encoding="utf8")
            (cache / (newer_key + GENERATION_SUFFIXES[0])).write_text(json.dumps(newer), encoding="utf8")
            request = {"path": str(path), "lines": [], "duration": 60, "version": "generate",
                       "language": "auto", "transcribe": True, "recoverSavedText": "По-ранен текст"}
            self.assertEqual(run(cache, cache, request), newer | {"upgradedSaved": True})
            self.assertEqual(run(cache, cache, request | {"cachedOnly": True}), older)
            self.assertEqual(run(cache, cache, request | {"recoverSavedText": "Ръчно редактиран текст"}),
                             {"state": "not-cached"})
            path.write_bytes(b"other-recording-fixture")
            self.assertEqual(run(cache, cache, request), {"state": "not-cached"})

    def test_lyric_draft_requires_recorded_words_and_correct_order(self):
        lines = ["First comes the careful verse", "Then sing the chorus again", "Finally we sing our farewell"]
        heard = transcript(zip([3, 11, 19], lines))
        good = verify_lyric_draft(lines, heard, 30)
        self.assertEqual(good["state"], "verified")
        self.assertEqual(good["proof"]["checkedLines"], 3)
        self.assertEqual(good["proof"]["checkedWords"], 15)
        for bad in [lines[::-1], [lines[0], "nonsense dishwasher washing machine", lines[2]],
                    [lines[0], lines[0], lines[2]], ["lala lala lala lala"] * 3]:
            self.assertEqual(verify_lyric_draft(bad, heard, 30)["state"], "unverified")

    def test_bulgarian_plural_and_worship_style_keep_original_times(self):
        draft = transcript([(3, "в крилете твои скривам се що мидват силни ветрови")])
        revised = normalize_bulgarian_lyrics(draft, True)
        self.assertEqual(" ".join(word[0] for word in revised), "в крилете Твои скривам се щом идват силни ветрове")
        self.assertEqual([word[1:] for word in revised], [word[1:] for word in draft])
        self.assertEqual(normalize_bulgarian_lyrics(draft, False)[2][0], "твои")
        secular = transcript([(3, "ветрови натоварвания идвам у дома")])
        self.assertEqual(normalize_bulgarian_lyrics(secular, False), secular)

    def test_generated_lyric_gap_requires_two_matching_audio_reads(self):
        first = transcript([(1, "начален ред тук")])
        missing = transcript([(4, "от всяка буря и беда")])
        last = transcript([(10, "финал звучи тук")])
        draft = first + last
        primary = first + missing + last
        self.assertEqual(recover_bulgarian_vocal_gaps(draft, [(4, 6)], lambda *_: primary, 20), primary)
        self.assertEqual(recover_bulgarian_vocal_gaps(draft, [], lambda *_: primary, 20), draft)
        readings = iter([primary, transcript([(4, "нищо удобен тест")])])
        self.assertEqual(recover_bulgarian_vocal_gaps(draft, [(4, 6)], lambda *_: next(readings), 20), draft)

    def test_solo_uses_nonvocal_audio_and_skips_silence(self):
        import numpy as np

        audio = np.full(16 * 16000, .04)
        lines = [{"at": 6, "end": 10}]
        self.assertEqual(generation_instrumentals(lines, audio, [(6, 10)]),
                         [{"at": 0, "end": 6}, {"at": 10, "end": 16}])
        self.assertEqual(generation_instrumentals(lines, audio, [(1, 4), (6, 10), (12, 15)]), [])
        self.assertEqual(generation_instrumentals(lines, np.zeros_like(audio), []), [])

    def test_refrain_recovers_multiple_words_from_distinct_vocal_occurrences(self):
        correct = "I can see the morning clearly now"
        heard = transcript([(5, "I can see the mooring dearly now"), (20, correct), (35, correct)])
        for i in (4, 5):
            heard[i] = (*heard[i][:3], .44)
        lines, rows = group_transcript(heard)
        audio = range(45 * 16000)
        with patch("lyrics_alignment.repeat_match", side_effect=[[5, 7], [5, 7]]) as compare:
            fixed, words = repair_generated_refrains(lines, rows, audio, "en")
        self.assertEqual(fixed[0]["text"], correct.lower())
        self.assertEqual(compare.call_count, 2)
        self.assertEqual(words[0][4]["text"], "morning")
        self.assertEqual(words[0][5]["text"], "clearly")
        self.assertEqual([(word["at"], word["end"]) for word in words[0]],
                         [(word["at"], word["end"]) for word in rows[0]])
        self.assertEqual(fixed[1:], lines[1:])
        with patch("lyrics_alignment.repeat_match", side_effect=[[5, 7], None]):
            self.assertEqual(repair_generated_refrains(lines, rows, audio, "en"), (lines, rows))
        with patch("lyrics_alignment.repeat_match", side_effect=[[5, 7], [5.3, 7.3]]):
            self.assertEqual(repair_generated_refrains(lines, rows, audio, "en"), (lines, rows))

    def test_refrain_preserves_an_intentional_lyric_variant(self):
        heard = transcript([(5, "I can see the morning clearly now"),
                            (20, "I can see the sunset clearly now"),
                            (35, "I can see the sunset clearly now")])
        lines, rows = group_transcript(heard)
        with patch("lyrics_alignment.repeat_match") as compare:
            self.assertEqual(repair_generated_refrains(lines, rows, range(45 * 16000), "en"), (lines, rows))
            compare.assert_not_called()

    def test_spelling_uses_the_same_sung_phrase_without_moving_word_times(self):
        draft = transcript([(2, "и не знаеш нъкъде"), (16, "и не знаеш накъде")])
        def unexpected_read(*_):
            self.fail("A corroborated spelling correction should not need another audio pass")
        path = Path("missing-songbook.sqlite3")
        result = refine_bulgarian_context(draft, unexpected_read, lambda *_: True, 30, False, path)
        self.assertEqual(result[3], ("накъде", *draft[3][1:]))
        self.assertEqual(result[4:], draft[4:])
        unsupported = transcript([(2, "и не знаеш нъкъде"), (16, "аз не знам накъде")])
        self.assertEqual(refine_bulgarian_context(unsupported, unexpected_read, lambda *_: True,
                                                30, False, path), unsupported)

    def test_songbook_proposes_words_only_for_worship_and_requires_local_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "lyrics.sqlite3")
            db = sqlite3.connect(path)
            with db:
                db.executescript("""
                    CREATE VIRTUAL TABLE worship_transcripts USING fts5(id UNINDEXED, lyrics);
                    CREATE TABLE documents (id TEXT, rights TEXT);
                    CREATE TABLE candidates (id TEXT, metadata TEXT);
                    INSERT INTO worship_transcripts VALUES ('test', 'да бъде винаги благословен');
                    INSERT INTO documents VALUES ('test', 'user-authorized-local-import');
                    INSERT INTO candidates VALUES ('test', '{"language":"bg"}');
                """)
            db.close()
            audio = transcript([(5, "да бъде винаги благословен")])
            initial = audio[:3] + [("благолвен!", *audio[3][1:3], .54)]
            reviews = []

            def audio_read(*window):
                reviews.append(window)
                return audio

            self.assertEqual(refine_bulgarian_context(initial, audio_read, lambda *_: True,
                                                     20, False, path), initial)
            self.assertFalse(reviews)
            result = refine_bulgarian_context(initial, audio_read, lambda *_: True, 20, True, path)
            self.assertEqual(result[3], ("благословен!", *initial[3][1:]))
            self.assertEqual(len(reviews), 1)
            self.assertEqual(refine_bulgarian_context(initial, lambda *_: audio[-1:], lambda *_: True,
                                                     20, True, path), initial)

    def test_bulgarian_prayer_word_correction_requires_overlapping_audio(self):
        words = [("Исус", 4, 4.4, .95), ("се", 4.4, 4.6, .95), ("молни,", 4.6, 5.2, .72)]
        confirmed = list(corroborate_bulgarian_words(words, lambda *_: [("моли", 4.7, 5.1, .83)]))
        self.assertEqual(confirmed[-1], ("моли,", 4.6, 5.2, .72))
        separate = list(corroborate_bulgarian_words(words, lambda *_: [("моли", 8, 8.4, .99)]))
        self.assertEqual(separate, words)

    def test_bulgarian_worship_correction_requires_stronger_overlapping_audio(self):
        words = [("Алелуя!", 2, 2.6, .7), ("слава", 2.7, 3.1, .96)]
        confirmed = list(corroborate_bulgarian_words(words, lambda *_: [("алилуя", 2.1, 2.5, .84)]))
        self.assertEqual(confirmed[0], ("алилуя!", 2, 2.6, .7))
        weak = list(corroborate_bulgarian_words(words, lambda *_: [("алилуя", 2.1, 2.5, .65)]))
        self.assertEqual(weak, words)
        separate = list(corroborate_bulgarian_words(words, lambda *_: [("алилуя", 4, 4.4, .99)]))
        self.assertEqual(separate, words)
        self.assertEqual(format_bulgarian(confirmed[0][0]), "Алилуя!")

    def test_bulgarian_worship_vocabulary_covers_common_biblical_terms(self):
        for term in ("Исус Христос", "Светият Дух", "изкупление", "Божието царство", "Евангелие"):
            self.assertIn(term, BG_TERMS)

    def test_biblical_phrase_hints_require_heard_context(self):
        self.assertTrue(bulgarian_worship_context(transcript([(0, "В името на Исус Христос")])))
        self.assertFalse(bulgarian_worship_context(transcript([(0, "Новият ден дойде с любов и надежда")])))
        self.assertFalse(bulgarian_worship_context([("исус", 1, 1.2, .4), ("христос", 1.3, 1.6, .4)]))

    def test_context_restores_a_connector_only_with_two_matching_reads(self):
        first = ("исус", 4, 4.22, .95)
        second = ("моли", 4.55, 4.83, .94)
        last = ("христос", 5, 5.35, .9)
        original = [first, second, last]
        found = [first, ("се", 4.28, 4.45, .86), second, last]
        calls = []

        def read(start, stop, guide):
            calls.append(guide)
            return found

        result = revise_bulgarian_phrases(original, read, lambda *_: True, 10, True)
        self.assertEqual(result, found)
        self.assertTrue(any(guide and "Исус Христос" in guide for guide in calls))
        self.assertIn(None, calls)
        self.assertEqual(revise_bulgarian_phrases(original, read, lambda *_: False, 10, True), original)
        self.assertEqual(revise_bulgarian_phrases(
            original, lambda _a, _b, guide: found if guide else original, lambda *_: True, 10, True), original)

    def test_secular_context_can_repair_a_word_without_worship_hints(self):
        words = [("отивам", 2, 2.3, .97), ("па", 2.4, 2.53, .52), ("море.", 2.61, 2.92, .96)]
        confirmed = [words[0], ("на", 2.41, 2.56, .90), words[2]]
        hints = []

        def read(_start, _stop, guide):
            hints.append(guide)
            return confirmed

        self.assertEqual(revise_bulgarian_phrases(words, read, lambda *_: True, 10, False)[1], confirmed[1])
        self.assertEqual(hints, ["отивам, море.", None])

    def test_bulgarian_preposition_pronoun_still_needs_matching_audio(self):
        words = [("за", 2, 2.3, .97), ("те,", 2.4, 2.53, .82), ("сега.", 2.61, 2.92, .96)]
        confirmed = [words[0], ("теб", 2.41, 2.56, .91), words[2]]
        self.assertEqual(revise_bulgarian_phrases(
            words, lambda *_: confirmed, lambda *_: True, 10, False)[1][0], "теб,")
        self.assertEqual(revise_bulgarian_phrases(
            words, lambda _a, _b, guide: confirmed if guide else words, lambda *_: True, 10, False), words)

    def test_prior_draft_keeps_time_and_repetition_does_not_inflate_evidence(self):
        words = transcript([(3, "Някой се моли"), (35, "Някой се моли")])
        lines, anchors = group_transcript(words)
        self.assertEqual(generation_anchors({"lines": lines, "words": anchors}, 60),
                         [(text, round(at, 3), round(end, 3), probability) for text, at, end, probability in words])
        repeated = [("христос", 2 + i * .2, 2.1 + i * .2, .99) for i in range(30)]
        self.assertLess(transcript_evidence(repeated), transcript_evidence(words))

    def test_bulgarian_structure_preserves_words_and_anchors_when_refrain_restarts(self):
        def line(start, text):
            return [(word, start + i * .25, start + i * .25 + .2, .95)
                    for i, word in enumerate(text.split())]
        heard = (line(2, "ти не си сам") + line(5, "ти не си сам")
                 + line(9, "исус христос се моли, ти не си сам"))
        rows, anchors = structure_bulgarian_transcript(heard)
        self.assertEqual([row["text"] for row in rows], [
            "Ти не си сам", "Ти не си сам", "Исус Христос се моли,", "Ти не си сам",
        ])
        self.assertEqual([row["at"] for row in rows], [2, 5, 9, 10])
        self.assertEqual(anchors[-1][0]["at"], 0)

    def test_original_transcript_anchors_align_library_repeats_in_recording_order(self):
        lines = ["Горда планина", "Мила родина", "Тиха земя", "Мила родина"]
        heard = [list(word) for word in transcript(zip([3, 12, 24, 30], lines))]
        result = align_transcript(lines, heard, 40)
        self.assertEqual([mark[0] for mark in result["marks"]], [3, 12, 24, 30])

    def test_original_transcript_anchors_reject_unrelated_or_weak_matches(self):
        lines = ["First verse", "Come sing with me"]
        heard = [list(word) for word in transcript([(10, "A completely different recording")])]
        self.assertIsNone(align_transcript(lines, heard, 30))
        weak = [list(word[:3]) + [.3] for word in transcript(zip([3, 12], lines))]
        self.assertIsNone(align_transcript(lines, weak, 30))

    def test_bulgarian_generation_keeps_sung_repetition_and_punctuation(self):
        anchors = [SimpleNamespace(word=word, start=start, end=start + .2, probability=probability)
                   for word, start, probability in [("исус", 0, .9), ("христос!", .3, .9),
                       ("повтори", .6, .95), ("повтори", .6, .95), ("повтори.", .9, .95), ("шум", 1.2, .12)]]
        segment = SimpleNamespace(words=anchors, no_speech_prob=.43, avg_logprob=-.3)
        lines, words = group_transcript(generated_words([segment], "bg"))
        self.assertEqual(format_bulgarian(lines[0]["text"]), "Исус Христос! Повтори повтори.")
        self.assertEqual([item["at"] for item in words[0]], [0, .3, .6, .9])
        self.assertEqual([item["probability"] for item in words[0]], [.9, .9, .95, .95])

    def test_chorus_uses_distinct_acoustic_occurrences(self):
        lines = ["First verse", "Come sing with me", "Second verse", "Come sing with me"]
        result = align(lines, transcript(zip([5, 18, 37, 50], lines)), 60)
        self.assertEqual(result["state"], "aligned")
        self.assertEqual([mark[0] for mark in result["marks"]], [5, 18, 37, 50])

    def test_duplicate_cannot_reuse_timing(self):
        result = align(["Sing again", "Sing again"], transcript([(4, "Sing again")]), 20)
        self.assertEqual(result["state"], "unreliable")
        self.assertEqual(result["marks"], [])

    def test_unheard_line_is_never_interpolated(self):
        lines = ["Горда планина", "Тиха земя", "Несъществуващ ред", "Мила родина", "Роден край"]
        result = align(lines, transcript([(3, lines[0]), (12, lines[1]), (40, lines[3]), (51, lines[4])]), 70)
        self.assertEqual(result["state"], "aligned")
        self.assertIsNone(result["marks"][2])

    def test_opening_word_stretched_across_instrumental_is_rejected(self):
        lines = ["One clear line", "A second line", "The third line", "Then we sing again"]
        heard = transcript(zip([4, 8, 12], lines[:3]))
        heard.extend([("then", 18, 29, .98), ("we", 29, 29.2, .98),
                      ("sing", 29.3, 29.5, .98), ("again", 29.6, 30, .98)])
        result = align(lines, heard, 40)
        self.assertEqual(result["state"], "aligned")
        self.assertIsNone(result["marks"][-1])

    def test_strong_partial_result_keeps_distinct_lines_only(self):
        lines = [f"Unique lyric anchor {i}" for i in range(12)]
        heard = transcript([(5 + i * 4, lines[i]) for i in range(8)])
        result = align(lines, heard, 60)
        self.assertEqual(result["state"], "aligned")
        self.assertEqual(result["matched"], 8)
        self.assertEqual(result["marks"][8:], [None] * 4)

    def test_repeated_phrase_alone_does_not_unlock_lower_coverage(self):
        phrase = "Come sing with me"
        lines = [phrase] * 8 + ["Missing verse"] * 4
        result = align(lines, transcript([(5 + i * 4, phrase) for i in range(8)]), 60)
        self.assertEqual(result["state"], "unreliable")

    def test_cached_audio_keeps_exact_lines_and_excludes_ambiguous_repeats(self):
        chorus = "Come sing along with me"
        verse = "This is the opening line"
        ambiguous = "One more repeated line here"
        lines = [verse, chorus, chorus, ambiguous, chorus, chorus, ambiguous, "Thanks", "Unheard line"]
        original = [verse, chorus, chorus, ambiguous, chorus, chorus, "Thanks"]
        heard = transcript(zip([5, 12, 20, 25, 31, 41, 50], original))
        records, anchors = group_transcript(heard, max_chars=100)
        result = align_cached_lyrics(lines, {"lines": records, "words": anchors}, 60, lambda *_: True)
        self.assertEqual(result["state"], "aligned")
        self.assertEqual(result["matched"], 5)
        self.assertTrue(all(result["marks"][index] is None for index in (3, 6, 7, 8)))
        self.assertIsNone(align_cached_lyrics(lines, {"lines": records, "words": anchors}, 60, lambda *_: False))

    def test_missing_first_word_is_never_backdated(self):
        lines = ["Begin with this clear opening", "And this line is sung clearly", "A final phrase ends everything"]
        heard = transcript([(4, lines[0]), (12, "this line is sung clearly"), (20, lines[2])])
        result = align(lines, heard, 30)
        self.assertEqual(result["state"], "aligned")
        self.assertEqual(result["marks"][1][0], 12)
        self.assertEqual(result["words"][1][0], [1, 12, 12.2])

    def test_gap_recovery_preserves_neighboring_timings(self):
        lines = ["First verse starts", "Now the chorus begins", "Last verse ends"]
        baseline = {"marks": [[2, 4], None, [12, 14]], "words": [[], [], []], "matched": 2}
        result = recover_gaps(lines, baseline, lambda *_: transcript([(6, lines[1])]))
        self.assertEqual(result["marks"], [[2, 4], [6, 7.1], [12, 14]])
        self.assertEqual(baseline["marks"][1], None)

    def test_vocabulary_hint_alone_cannot_supply_timing(self):
        lines = ["First verse starts", "Now the chorus begins again", "Last verse ends"]
        baseline = {"marks": [[2, 4], None, [12, 14]], "words": [[], [], []], "matched": 2}
        def transcribe(start, end, hint=None):
            return transcript([(6, hint or "the crowd cheers")])
        self.assertIsNone(recover_gaps(lines, baseline, transcribe)["marks"][1])

    def test_audio_repeat_requires_a_distinct_peak_in_the_gap(self):
        import numpy as np

        rng = np.random.default_rng(7)
        audio = rng.normal(0, .03, 16 * 16000)
        phrase = rng.normal(0, .3, 2 * 16000)
        for at in (2, 6, 10):
            audio[at * 16000:(at + 2) * 16000] += phrase
        self.assertEqual(repeat_match(audio, [2, 4], 5, 9), [6, 8])
        self.assertIsNone(repeat_match(audio, [2, 4], 5, 13))
        self.assertIsNone(repeat_match(audio, [2, 4], 12.5, 15.5))

    def test_collapsed_refrain_rechecked_with_distinct_audio_matches(self):
        lines = ["First verse starts", "Holy holy holy", "Holy holy holy", "A final line"]
        baseline = {"marks": [[2, 4], [8, 8.04], [8.04, 8.08], [20, 22]],
                    "words": [[], [], [], []], "matched": 4}
        heard = transcript([(7, lines[1]), (13, lines[2])])
        result = repair_collapsed_refrains(
            lines, baseline, lambda start, end: [w for w in heard if start <= w[1] < end], 25)
        self.assertEqual(result["marks"], [[2, 4], [7, 7.8], [13, 13.8], [20, 22]])

    def test_refrain_repair_rejects_clumped_decoder_words(self):
        lines = ["First verse starts", "Holy holy holy", "A final line"]
        baseline = {"marks": [[2, 4], [8, 8.04], [20, 22]], "words": [[], [], []], "matched": 3}
        heard = [("holy", 8 + i * .02, 8.02 + i * .02, .99) for i in range(3)]
        result = repair_collapsed_refrains(lines, baseline, lambda *_: heard, 25)
        self.assertEqual(result["marks"], [[2, 4], None, [20, 22]])

    def test_provider_onsets_corroborated_without_reusing_repeats(self):
        lines = ["A clear opening phrase", "I want to see you", "I want to see you"]
        heard = transcript([(8, lines[0]), (14, lines[1]), (25, lines[1])])
        result = align(lines, heard, 40, minimum_quality=.86, recovery=True, expected=[9, 15, 31])
        self.assertEqual(result["marks"], [[8, 9.1], [14, 15.4], None])

    def test_provider_correction_requires_the_sung_opening(self):
        lines = ["And this line is sung clearly", "A final phrase ends everything"]
        heard = transcript([(8, "this line is sung clearly"), (20, lines[1])])
        result = align(lines, heard, 40, minimum_quality=.86, recovery=True, expected=[9, 21])
        self.assertEqual(result["marks"][0], None)
        self.assertEqual(result["marks"][1][0], 20)

    def test_rejects_nonmonotonic_audio_and_wrong_language(self):
        lines = ["İsa ışığı", "Beni unutma"]
        self.assertEqual(align(lines, transcript([(9, lines[0]), (2, lines[1])]), 20)["state"], "unreliable")
        self.assertEqual(align(lines, transcript([(4, "Never give up"), (10, "The song ends")]), 20)["state"], "unreliable")


if __name__ == "__main__":
    unittest.main()
