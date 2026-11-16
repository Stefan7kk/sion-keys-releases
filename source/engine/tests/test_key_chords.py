"""Unit tests for key + chord DSP (synthetic signals) + cancel/temp."""

from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from chord_engine.chords import (
    TEMPLATES,
    TEMPLATE_LABELS,
    ChordSegment,
    _merge_short,
    _segments_from_frames,
    detect_chords,
    display_label,
)
from chord_engine.constants import HOP_LENGTH, SR
from chord_engine.key import estimate_key
from chord_engine.procutil import cleanup_all_temps, track_temp, untrack_temp


def _tone_chord(freqs: list[float], dur: float = 2.0, sr: int = SR) -> np.ndarray:
    t = np.linspace(0, dur, int(sr * dur), endpoint=False)
    y = np.zeros_like(t)
    for f in freqs:
        y += 0.3 * np.sin(2 * np.pi * f * t)
    return y.astype(np.float32)


def _chroma_from_y(y: np.ndarray):
    from chord_engine.features import extract_features

    return extract_features(y, sr=SR, hop_length=HOP_LENGTH)


def _write_wav(path: Path, y: np.ndarray, sr: int = SR) -> None:
    # int16 PCM
    clipped = np.clip(y, -1.0, 1.0)
    ints = (clipped * 32767.0).astype(np.int16)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(ints.tobytes())


def _assert_timeline_and_provenance(merged, raw, duration):
    original_bounds = {s.start for s in raw} | {s.end for s in raw}
    for segments in (raw, merged):
        assert segments[0].start == 0.0
        assert segments[-1].end == round(duration, 4)
        assert all(s.start < s.end for s in segments)
        assert all(a.end == b.start for a, b in zip(segments, segments[1:]))
        assert all(s.start in original_bounds and s.end in original_bounds for s in segments)
    for final in merged:
        for original in raw:
            if max(final.start, original.start) < min(final.end, original.end):
                assert (final.kind, final.scoreKind) == (original.kind, original.scoreKind)
        assert final.score is not None
        if final.scoreKind == "energy_gate":
            assert final.kind == "no_chord" and final.label == "N.C."
            assert final.score == 1.0
        else:
            assert final.scoreKind == "template_similarity"


def test_merge_short_preserves_protected_edge_categories():
    categories = [
        ("N.C.", "no_chord", "energy_gate"),
        ("N.C.", "uncertain", "template_similarity"),
        ("C:maj", "chord", "template_similarity"),
    ]
    for short_category in categories:
        for long_category in categories:
            if short_category == long_category:
                continue
            for leading in (True, False):
                ordered = [short_category, long_category] if leading else [long_category, short_category]
                boundary = 0.0929 if leading else 1.3
                raw = [
                    ChordSegment(0.0, boundary, ordered[0][0], 0.7, ordered[0][2], ordered[0][1]),
                    ChordSegment(boundary, 1.3929, ordered[1][0], 0.6, ordered[1][2], ordered[1][1]),
                ]
                snapshot = [s.to_dict() for s in raw]
                merged = _merge_short(raw, min_merge_sec=0.25, duration_sec=1.3929)
                assert [s.to_dict() for s in merged] == snapshot, (leading, ordered, merged)
                assert [s.to_dict() for s in raw] == snapshot
                assert all(final is not original for final in merged for original in raw)


def test_merge_short_chooses_only_compatible_neighbors():
    chord = ("chord", "template_similarity")
    silence = ("no_chord", "energy_gate")
    uncertain = ("uncertain", "template_similarity")
    other_score_kind = ("chord", "energy_gate")
    cases = [
        # Left/right duration, category, and expected recipient. Left wins ties.
        (0.6, 0.4, chord, chord, "left"),
        (0.4, 0.6, chord, chord, "right"),
        (0.6, 0.6, chord, chord, "left"),
        (0.4, 0.6, chord, silence, "left"),
        (0.6, 0.4, uncertain, chord, "right"),
        (0.4, 0.6, chord, other_score_kind, "left"),
        (0.6, 0.4, other_score_kind, chord, "right"),
        (0.6, 0.4, silence, uncertain, None),
        (0.6, 0.4, other_score_kind, other_score_kind, None),
    ]
    for left_d, right_d, left_category, right_category, recipient in cases:
        boundary = round(left_d + 0.0929, 4)
        duration = round(boundary + right_d, 4)
        raw = [
            ChordSegment(0.0, left_d, "C:maj", 0.8, left_category[1], left_category[0]),
            ChordSegment(left_d, boundary, "D:maj", 0.9, chord[1], chord[0]),
            ChordSegment(boundary, duration, "G:maj", 0.7, right_category[1], right_category[0]),
        ]
        snapshot = [s.to_dict() for s in raw]
        merged = _merge_short(raw, min_merge_sec=0.25, duration_sec=duration)
        assert [s.to_dict() for s in raw] == snapshot
        if recipient is None:
            assert [s.to_dict() for s in merged] == snapshot
        else:
            assert [s.label for s in merged] == ["C:maj", "G:maj"]
            expected_boundary = boundary if recipient == "left" else left_d
            assert merged[0].end == merged[1].start == expected_boundary
            assert merged[0].start == 0.0 and merged[-1].end == duration
            # A changed template span has no valid score until detect_chords rescoring.
            assert merged[0 if recipient == "left" else 1].score is None


def test_merge_short_left_wins_equal_rounded_durations():
    raw = [
        ChordSegment(0.0, 0.6, "C:maj", 0.8, "template_similarity", "chord"),
        ChordSegment(0.6, 0.7, "D:maj", 0.9, "template_similarity", "chord"),
        ChordSegment(0.7, 1.3, "G:maj", 0.7, "template_similarity", "chord"),
    ]
    # Binary floats make 1.3 - 0.7 slightly greater than 0.6 - 0.0.
    merged = _merge_short(raw, min_merge_sec=0.25, duration_sec=1.3)
    assert len(merged) == 2 and merged[0].end == merged[1].start == 0.7


def test_consecutive_segments_respect_score_kind():
    # Independently guard provenance even when both label and kind match.
    frame_dur = HOP_LENGTH / SR
    raw = _segments_from_frames(
        ["N.C.", "N.C."], [1.0, 0.4], ["no_chord", "no_chord"],
        ["energy_gate", "template_similarity"], np.array([0.0, frame_dur]),
        frame_dur, 2 * frame_dur,
    )
    assert len(raw) == 2
    snapshot = [s.to_dict() for s in raw]
    for threshold in (0.0, 1.0):
        merged = _merge_short(raw, min_merge_sec=threshold, duration_sec=2 * frame_dur)
        assert [s.to_dict() for s in merged] == snapshot
        assert [s.to_dict() for s in raw] == snapshot


def test_seeded_noise_between_silence_stays_uncertain():
    rng = np.random.default_rng(0)
    y = np.concatenate([
        np.zeros(SR), rng.standard_normal(int(SR * 0.1)) * 0.03, np.zeros(SR),
    ]).astype(np.float32)
    chroma, bass, rms = _chroma_from_y(y)
    merged, raw = detect_chords(chroma, rms, duration_sec=len(y) / SR, smooth_sec=0.0, min_chord_sec=0.0, bass=bass)
    uncertain_raw = [s for s in raw if s.kind == "uncertain"]
    uncertain_merged = [s for s in merged if s.kind == "uncertain"]
    assert uncertain_raw and uncertain_merged, (raw, merged)
    assert raw[0].scoreKind == raw[-1].scoreKind == "energy_gate"
    assert merged[0].end == uncertain_raw[0].start == uncertain_merged[0].start
    assert merged[-1].start == uncertain_raw[-1].end == uncertain_merged[-1].end
    _assert_timeline_and_provenance(merged, raw, len(y) / SR)


def test_short_uncertain_nc_between_silence_is_not_energy_gate():
    chroma = np.vstack([np.zeros((5, 12)), np.ones((1, 12)), np.zeros((6, 12))])
    rms = np.concatenate([np.zeros(5), [0.1], np.zeros(6)])
    duration = (len(chroma) - 0.6) * HOP_LENGTH / SR
    merged, raw = detect_chords(chroma, rms, duration, min_merge_sec=3 * HOP_LENGTH / SR, smooth_sec=0.0, min_chord_sec=0.0)
    assert len(raw) == 3 and [s.label for s in raw] == ["N.C."] * 3
    assert raw[1].kind == "uncertain" and raw[1].scoreKind == "template_similarity"
    assert raw[1].score < 0.45
    assert [s.to_dict() for s in merged] == [s.to_dict() for s in raw]
    _assert_timeline_and_provenance(merged, raw, duration)


def test_merged_chord_score_uses_assigned_template_and_exact_frames():
    c = np.zeros(12)
    c[[0, 4, 7]] = 1.0
    g = np.zeros(12)
    g[[7, 11, 2]] = 1.0
    region = np.vstack([np.tile(c, (9, 1)), np.tile(g, (2, 1)), np.tile(c, (12, 1)), g])
    for sr, hop in ((SR, HOP_LENGTH), (48000, 1024)):
        for padding in (False, True):
            # Fractional final hop must still include the last valid frame.
            chroma = np.vstack([np.zeros((3, 12)), region, np.zeros((4, 12))]) if padding else region.copy()
            rms = np.where(np.linalg.norm(chroma, axis=1) > 0, 0.1, 0.0)
            duration = (len(chroma) - 0.8) * hop / sr
            chroma_before, rms_before = chroma.copy(), rms.copy()
            _, baseline_raw = detect_chords(chroma, rms, duration, sr=sr, hop=hop, min_merge_sec=0.0, smooth_sec=0.0, min_chord_sec=0.0)
            merged, raw = detect_chords(chroma, rms, duration, sr=sr, hop=hop, min_merge_sec=3 * hop / sr, smooth_sec=0.0, min_chord_sec=0.0)
            assert [s.to_dict() for s in raw] == [s.to_dict() for s in baseline_raw]
            np.testing.assert_array_equal(chroma, chroma_before)
            np.testing.assert_array_equal(rms, rms_before)
            chords = [s for s in merged if s.kind == "chord"]
            assert len(chords) == 1 and chords[0].label == "C:maj", merged
            final = chords[0]
            expected_start = round(3 * hop / sr, 4) if padding else 0.0
            expected_end = round(27 * hop / sr, 4) if padding else round(duration, 4)
            assert (final.start, final.end) == (expected_start, expected_end)
            normalized = region / (np.linalg.norm(region, axis=1, keepdims=True) + 1e-8)
            similarities = normalized @ TEMPLATES[TEMPLATE_LABELS.index("C:maj")]
            assert final.score == round(float(np.mean(similarities)), 4)
            assert final.score != round(float(np.mean(similarities[:-1])), 4)
            assert final.score < min(s.score for s in raw if s.kind == "chord")
            _assert_timeline_and_provenance(merged, raw, duration)


def test_merged_uncertain_named_score_uses_assigned_template():
    chroma = np.vstack([
        np.tile(np.eye(12)[0], (9, 1)), np.tile(np.eye(12)[2], (2, 1)),
        np.tile(np.eye(12)[0], (13, 1)),
    ])
    rms = np.full(len(chroma), 0.1)
    duration = (len(chroma) - 0.8) * HOP_LENGTH / SR
    merged, raw = detect_chords(chroma, rms, duration, min_merge_sec=3 * HOP_LENGTH / SR, smooth_sec=0.0, min_chord_sec=0.0)
    assert len(merged) == 1 and all(s.kind == "uncertain" for s in raw)
    final = merged[0]
    assert final.label != "N.C." and final.kind == "uncertain"
    normalized = chroma / (np.linalg.norm(chroma, axis=1, keepdims=True) + 1e-8)
    expected = round(float(np.mean(normalized @ TEMPLATES[TEMPLATE_LABELS.index(final.label)])), 4)
    assert final.score == expected and final.score < min(s.score for s in raw)
    _assert_timeline_and_provenance(merged, raw, duration)


def test_merged_uncertain_nc_score_is_mean_best_frame_similarity():
    # Named uncertain single-note frames can join uncertain N.C., but their best
    # similarities must not be discarded or interpreted as an N.C. template.
    chroma = np.vstack([
        np.ones((9, 12)), np.tile(np.eye(12)[0], (2, 1)), np.eye(12)[2], np.ones((12, 12)),
    ])
    rms = np.full(len(chroma), 0.1)
    duration = (len(chroma) - 0.8) * HOP_LENGTH / SR
    _, baseline_raw = detect_chords(chroma, rms, duration, min_merge_sec=0.0, smooth_sec=0.0, min_chord_sec=0.0)
    merged, raw = detect_chords(chroma, rms, duration, min_merge_sec=3 * HOP_LENGTH / SR, smooth_sec=0.0, min_chord_sec=0.0)
    assert [s.to_dict() for s in raw] == [s.to_dict() for s in baseline_raw]
    assert len(merged) == 1
    final = merged[0]
    assert (final.label, final.kind, final.scoreKind) == ("N.C.", "uncertain", "template_similarity")
    normalized = chroma / (np.linalg.norm(chroma, axis=1, keepdims=True) + 1e-8)
    similarities = normalized @ TEMPLATES.T
    expected = round(float(np.mean(np.max(similarities, axis=1))), 4)
    assert final.score == expected and final.score != raw[0].score
    assert final.score != round(float(np.max(np.mean(similarities, axis=0))), 4)
    _assert_timeline_and_provenance(merged, raw, duration)


def test_c_major_key_and_chord():
    y = _tone_chord([261.63, 329.63, 392.0], dur=3.0)
    chroma, bass, rms = _chroma_from_y(y)
    key = estimate_key(chroma)
    assert key.tonic == "C"
    assert key.mode == "major"
    assert key.scoreKind == "profile_correlation"
    assert key.score is not None
    merged, raw = detect_chords(chroma, rms, duration_sec=len(y) / SR, bass=bass)
    assert raw, "expected raw segments"
    labels = {s.label for s in merged if s.kind == "chord"}
    assert any(l.startswith("C:") for l in labels) or any(
        s.label == "C:maj" for s in merged
    ), f"got {merged}"


def test_a_minor_key_and_chord():
    # A3 C4 E4 — A minor triad; key should prefer A minor or C major relative
    y = _tone_chord([220.0, 261.63, 329.63], dur=4.0)
    chroma, bass, rms = _chroma_from_y(y)
    key = estimate_key(chroma)
    assert key.scoreKind == "profile_correlation"
    assert key.tonic in ("A", "C"), f"unexpected tonic {key.tonic} {key.mode}"
    if key.tonic == "A":
        assert key.mode == "minor"
    merged, _ = detect_chords(chroma, rms, duration_sec=len(y) / SR, bass=bass)
    joined = " ".join(s.label for s in merged)
    assert "A:min" in joined or "C:maj" in joined, f"got {joined}"


def test_a_minor_chord_template():
    y = _tone_chord([220.0, 261.63, 329.63], dur=3.0)
    chroma, bass, rms = _chroma_from_y(y)
    merged, _ = detect_chords(chroma, rms, duration_sec=len(y) / SR, bass=bass)
    joined = " ".join(s.label for s in merged)
    assert "A:min" in joined or "C:maj" in joined


def test_silence_is_nc():
    y = np.zeros(SR * 2, dtype=np.float32)
    chroma, bass, rms = _chroma_from_y(y)
    merged, raw = detect_chords(chroma, rms, duration_sec=2.0, bass=bass)
    assert merged and raw
    assert all(s.label == "N.C." for s in raw)
    assert all(s.kind == "no_chord" for s in raw)
    _assert_timeline_and_provenance(merged, raw, 2.0)


def test_chord_changes_c_to_g():
    # 2s C major then 2s G major
    c = _tone_chord([261.63, 329.63, 392.0], dur=2.0)
    g = _tone_chord([392.0, 493.88, 587.33], dur=2.0)
    y = np.concatenate([c, g])
    chroma, bass, rms = _chroma_from_y(y)
    merged, raw = detect_chords(chroma, rms, duration_sec=len(y) / SR, smooth_sec=0.0, min_chord_sec=0.0, bass=bass)
    # Require both families in each output, not merely either one anywhere.
    tolerance = 2 * HOP_LENGTH / SR  # CQT smoothing can straddle a hop boundary.
    default_merged, default_raw = detect_chords(chroma, rms, duration_sec=len(y) / SR, bass=bass)
    assert default_raw == raw
    for segments in (raw, merged, default_merged):
        c_segments = [s for s in segments if s.kind == "chord" and s.label.startswith("C:")]
        g_segments = [s for s in segments if s.kind == "chord" and s.label.startswith("G:")]
        assert c_segments and g_segments, f"expected both C/G families, got {segments}"
        assert any(s.start <= 1.0 < s.end for s in c_segments), segments
        assert any(s.start <= 3.0 < s.end for s in g_segments), segments
        assert any(
            c.end <= g.start
            and abs(c.end - 2.0) <= tolerance
            and abs(g.start - 2.0) <= tolerance
            for c in c_segments for g in g_segments
        ), f"expected ordered C to G change near 2s, got {segments}"
    _assert_timeline_and_provenance(merged, raw, len(y) / SR)


def test_half_second_chord_is_displayed_at_its_onset():
    # The old 1.0 s dwell replaced this G with the surrounding C.
    c = _tone_chord([261.63, 329.63, 392.0], dur=2.0)
    g = _tone_chord([392.0, 493.88, 587.33], dur=0.5)
    y = np.concatenate([c, g, c])
    chroma, bass, rms = _chroma_from_y(y)
    duration = len(y) / SR
    merged, raw = detect_chords(chroma, rms, duration_sec=duration, bass=bass)
    tolerance = 2 * HOP_LENGTH / SR
    for segments in (raw, merged):
        g_segments = [s for s in segments if s.kind == "chord" and s.label.startswith("G:")]
        assert g_segments, segments
        assert any(
            abs(s.start - 2.0) <= tolerance and abs(s.end - 2.5) <= tolerance
            for s in g_segments
        ), segments
    assert merged[0].start == 0.0 and merged[-1].end == round(duration, 4)
    assert all(a.end == b.start for a, b in zip(merged, merged[1:]))


def test_near_tie_follows_key_and_keeps_raw_score():
    # C# major leads C# minor by less than 0.05 similarity. B major contains
    # C# minor and not C# major, so the key prior picks C# minor. The prior may
    # choose the label, but the RAW evidence is still ambiguous, so the frame
    # stays uncertain and the stored score is the RAW similarity of the chosen
    # template, never the boosted value.
    maj_i = TEMPLATE_LABELS.index("C#:maj")
    min_i = TEMPLATE_LABELS.index("C#:min")
    blended = 0.51 * TEMPLATES[maj_i] + 0.49 * TEMPLATES[min_i] + 0.5
    blended = blended / np.linalg.norm(blended)
    sims = TEMPLATES @ blended
    assert int(np.argmax(sims)) == maj_i
    assert 0 < float(sims[maj_i] - sims[min_i]) < 0.05
    assert float(sims[maj_i]) < 0.65
    chroma = np.tile(blended, (10, 1))
    rms = np.full(len(chroma), 0.3)
    duration = len(chroma) * HOP_LENGTH / SR
    plain, _ = detect_chords(chroma, rms, duration, smooth_sec=0.0, min_chord_sec=0.0, min_merge_sec=0.0)
    guided, _ = detect_chords(
        chroma, rms, duration, smooth_sec=0.0, min_chord_sec=0.0, min_merge_sec=0.0,
        key_tonic="B", key_mode="major",
    )
    assert len(plain) == 1 and plain[0].label == "C#:maj" and plain[0].kind == "uncertain"
    assert len(guided) == 1 and guided[0].label == "C#:min" and guided[0].kind == "uncertain"
    assert guided[0].score is not None and plain[0].score is not None
    assert guided[0].score == round(float(sims[min_i]), 4)
    assert guided[0].score <= plain[0].score
    pure = np.tile(TEMPLATES[maj_i], (10, 1))
    strong, _ = detect_chords(pure, rms, duration, key_tonic="B", key_mode="major")
    assert any(s.label == "C#:maj" and s.kind == "chord" for s in strong), strong


def _blend_tie(label_a: str, label_b: str, weight: float = 0.51, offset: float = 0.8) -> np.ndarray:
    a_i = TEMPLATE_LABELS.index(label_a)
    b_i = TEMPLATE_LABELS.index(label_b)
    blended = weight * TEMPLATES[a_i] + (1.0 - weight) * TEMPLATES[b_i] + offset
    return blended / np.linalg.norm(blended)


def test_bass_prior_confirms_in_key_root_position():
    # G# major leads G# minor by less than 0.05 similarity. The key prior
    # (B major) prefers G# minor, and a dominant G# bass confirms the
    # root-position reading. The raw evidence is still ambiguous, so the frame
    # remains uncertain while the selected score stays the raw similarity.
    min_i = TEMPLATE_LABELS.index("G#:min")
    blended = _blend_tie("G#:maj", "G#:min")
    sims = TEMPLATES @ blended
    chroma = np.tile(blended, (10, 1))
    bass = np.zeros_like(chroma)
    bass[:, 8] = 1.0  # G# bass: root of both candidates
    rms = np.full(len(chroma), 0.3)
    duration = len(chroma) * HOP_LENGTH / SR
    merged, _ = detect_chords(
        chroma, rms, duration, smooth_sec=0.0, min_chord_sec=0.0, min_merge_sec=0.0,
        key_tonic="B", key_mode="major", bass=bass,
    )
    assert len(merged) == 1 and merged[0].label == "G#:min" and merged[0].kind == "uncertain"
    assert merged[0].score == round(float(sims[min_i]), 4)


def test_bass_prior_flips_tie_to_bass_root():
    # D# minor leads B major by less than 0.05 similarity; both are diatonic
    # to B major so the key prior cannot separate them. A dominant B bass
    # (not a chord tone of the winner) flips the tie to the bass-root chord.
    # The frame stays uncertain because the raw evidence is ambiguous.
    b_i = TEMPLATE_LABELS.index("B:maj")
    blended = _blend_tie("D#:min", "B:maj")
    sims = TEMPLATES @ blended
    assert int(np.argmax(sims)) == TEMPLATE_LABELS.index("D#:min")
    chroma = np.tile(blended, (10, 1))
    bass = np.zeros_like(chroma)
    bass[:, 11] = 1.0  # B bass: chord tone of B:maj, not of D#:min
    rms = np.full(len(chroma), 0.3)
    duration = len(chroma) * HOP_LENGTH / SR
    merged, _ = detect_chords(
        chroma, rms, duration, smooth_sec=0.0, min_chord_sec=0.0, min_merge_sec=0.0,
        key_tonic="B", key_mode="major", bass=bass,
    )
    assert len(merged) == 1 and merged[0].label == "B:maj" and merged[0].kind == "uncertain"
    assert merged[0].score == round(float(sims[b_i]), 4)


def test_bass_prior_ignores_out_of_key_root():
    # A# major leads A# minor by less than 0.05 similarity and neither is
    # diatonic to B major. A dominant A# bass (root of both) must NOT confirm
    # an out-of-key winner: the frame stays uncertain and honest.
    blended = _blend_tie("A#:maj", "A#:min")
    chroma = np.tile(blended, (10, 1))
    bass = np.zeros_like(chroma)
    bass[:, 10] = 1.0  # A# bass
    rms = np.full(len(chroma), 0.3)
    duration = len(chroma) * HOP_LENGTH / SR
    merged, _ = detect_chords(
        chroma, rms, duration, smooth_sec=0.0, min_chord_sec=0.0, min_merge_sec=0.0,
        key_tonic="B", key_mode="major", bass=bass,
    )
    assert len(merged) == 1 and merged[0].label == "A#:maj" and merged[0].kind == "uncertain"


def test_bass_prior_second_inversion_stays_honest():
    # G# minor leads B major by less than 0.05 similarity (both diatonic to
    # B major). A dominant D# bass is the winner's fifth — a second
    # inversion — so the prior must not change the reading.
    blended = _blend_tie("G#:min", "B:maj")
    chroma = np.tile(blended, (10, 1))
    bass = np.zeros_like(chroma)
    bass[:, 3] = 1.0  # D# bass = fifth of G#:min
    rms = np.full(len(chroma), 0.3)
    duration = len(chroma) * HOP_LENGTH / SR
    plain, _ = detect_chords(
        chroma, rms, duration, smooth_sec=0.0, min_chord_sec=0.0, min_merge_sec=0.0,
        key_tonic="B", key_mode="major",
    )
    with_bass, _ = detect_chords(
        chroma, rms, duration, smooth_sec=0.0, min_chord_sec=0.0, min_merge_sec=0.0,
        key_tonic="B", key_mode="major", bass=bass,
    )
    assert [s.to_dict() for s in plain] == [s.to_dict() for s in with_bass]
    assert plain[0].label == "G#:min"


def test_uniform_bass_cannot_flip_tie():
    # Uniform low-octave energy carries no root information. It must not
    # confirm or flip a near-tie, even though its largest class is nonzero.
    blended = _blend_tie("D#:min", "B:maj")
    chroma = np.tile(blended, (10, 1))
    uniform_bass = np.ones_like(chroma)
    rms = np.full(len(chroma), 0.3)
    duration = len(chroma) * HOP_LENGTH / SR
    plain, _ = detect_chords(
        chroma, rms, duration, smooth_sec=0.0, min_chord_sec=0.0, min_merge_sec=0.0,
        key_tonic="B", key_mode="major",
    )
    with_uniform, _ = detect_chords(
        chroma, rms, duration, smooth_sec=0.0, min_chord_sec=0.0, min_merge_sec=0.0,
        key_tonic="B", key_mode="major", bass=uniform_bass,
    )
    assert [s.to_dict() for s in plain] == [s.to_dict() for s in with_uniform]
    assert plain[0].kind == "uncertain"


def test_stabilizer_absorbs_short_blip_but_raw_keeps_it():
    # A sustained C chord with a 2-frame D flicker: display shows one sustained C,
    # raw stays frame-faithful and still records the D blip.
    c = np.zeros(12)
    c[[0, 4, 7]] = 1.0
    d = np.zeros(12)
    d[[2, 6, 9]] = 1.0
    chroma = np.vstack([np.tile(c, (30, 1)), np.tile(d, (2, 1)), np.tile(c, (30, 1))])
    rms = np.full(len(chroma), 0.1)
    duration = len(chroma) * HOP_LENGTH / SR
    merged, raw = detect_chords(chroma, rms, duration)
    _, raw_off = detect_chords(chroma, rms, duration, smooth_sec=0.0, min_chord_sec=0.0)
    assert [s.to_dict() for s in raw] == [s.to_dict() for s in raw_off]
    assert any(s.label == "D:maj" for s in raw), raw
    chord_merged = [s for s in merged if s.kind == "chord"]
    assert len(chord_merged) == 1 and chord_merged[0].label == "C:maj", merged
    assert chord_merged[0].start == 0.0 and chord_merged[0].end == round(duration, 4)
    _assert_timeline_and_provenance(merged, raw, duration)


def test_stabilizer_preserves_silence_vs_uncertain_nc():
    # With smoothing on, an uncertain N.C. frame between silence must not be
    # majority-voted into the surrounding energy-gate silence.
    chroma = np.vstack([np.zeros((10, 12)), np.ones((1, 12)), np.zeros((10, 12))])
    rms = np.concatenate([np.zeros(10), [0.1], np.zeros(10)])
    duration = len(chroma) * HOP_LENGTH / SR
    merged, raw = detect_chords(chroma, rms, duration)
    assert [s.kind for s in merged] == ["no_chord", "uncertain", "no_chord"], merged
    assert merged[0].scoreKind == merged[2].scoreKind == "energy_gate"
    assert merged[1].scoreKind == "template_similarity" and merged[1].label == "N.C."
    _assert_timeline_and_provenance(merged, raw, duration)


def test_display_label():
    assert display_label("C:maj") == "C"
    assert display_label("A:min") == "Am"
    assert display_label("N.C.") == "N.C."


def test_key_uncertain_on_noise():
    rng = np.random.default_rng(0)
    y = (rng.standard_normal(SR * 2) * 0.01).astype(np.float32)
    chroma, _, _ = _chroma_from_y(y)
    key = estimate_key(chroma)
    assert key.scoreKind == "profile_correlation"


def test_key_ambiguity_reports_alternative():
    # C major triad — relative A minor should appear as alternative often
    y = _tone_chord([261.63, 329.63, 392.0], dur=3.0)
    chroma, _, _ = _chroma_from_y(y)
    key = estimate_key(chroma)
    d = key.to_dict()
    assert d["scoreKind"] == "profile_correlation"
    # alternative may be null on very strong keys; just ensure schema
    assert "alternative" in d
    assert "uncertain" in d


def test_temp_track_and_cleanup():
    fd, tmp = tempfile.mkstemp(prefix="chord_test_tmp_", suffix=".wav")
    os.close(fd)
    p = Path(tmp)
    p.write_bytes(b"RIFF")
    track_temp(p)
    assert p.is_file()
    untrack_temp(p, delete=True)
    assert not p.exists()


def test_cleanup_all_temps():
    paths = []
    for _ in range(3):
        fd, tmp = tempfile.mkstemp(prefix="chord_test_all_", suffix=".bin")
        os.close(fd)
        p = Path(tmp)
        p.write_bytes(b"x")
        track_temp(p)
        paths.append(p)
    cleanup_all_temps()
    for p in paths:
        assert not p.exists(), p


def test_decode_cleans_temp_wav():
    """decode_audio must delete temp WAV when keep_wav=False."""
    from chord_engine.decode import decode_audio, find_ffmpeg

    try:
        find_ffmpeg()
    except Exception as e:
        print(f"skip decode temp test: {e}")
        return

    y = _tone_chord([440.0], dur=0.5)
    fd, tmp = tempfile.mkstemp(prefix="chord_src_", suffix=".wav")
    os.close(fd)
    src = Path(tmp)
    _write_wav(src, y)
    before = set(Path(tempfile.gettempdir()).glob("chord_decode_*"))
    samples, sr, dur, wav = decode_audio(src, keep_wav=False)
    after = set(Path(tempfile.gettempdir()).glob("chord_decode_*"))
    assert wav is None
    assert len(samples) > 0
    assert sr == SR
    assert dur > 0.4
    # No new leftover decode temps
    leaked = after - before
    assert not leaked, f"leaked temps: {leaked}"
    src.unlink(missing_ok=True)


def test_cancel_during_decode():
    """Cancel event should abort decode and not leave temps."""
    from chord_engine.decode import DecodeError, decode_to_wav, find_ffmpeg
    from chord_engine.procutil import cleanup_all_temps

    try:
        find_ffmpeg()
    except Exception as e:
        print(f"skip cancel decode test: {e}")
        return

    # Longer file so cancel can win a race
    y = _tone_chord([440.0], dur=12.0)
    fd, tmp = tempfile.mkstemp(prefix="chord_src_long_", suffix=".wav")
    os.close(fd)
    src = Path(tmp)
    _write_wav(src, y)

    ev = threading.Event()
    # Pre-set cancel so decode aborts immediately after spawn/check
    ev.set()
    before = set(Path(tempfile.gettempdir()).glob("chord_decode_*"))
    err = None
    out = None
    try:
        out = decode_to_wav(src, cancel_event=ev)
    except Exception as e:
        err = e
    # Always sweep tracked temps (engine atexit does this on process exit)
    cleanup_all_temps()
    # Extra sweep of any chord_decode_* that appeared
    after = set(Path(tempfile.gettempdir()).glob("chord_decode_*"))
    leaked = {p for p in (after - before) if p.exists()}
    for p in list(leaked):
        try:
            p.unlink(missing_ok=True)
            if not p.exists():
                leaked.discard(p)
        except OSError:
            pass
    src.unlink(missing_ok=True)
    assert err is not None, f"expected cancel error, got path {out}"
    assert isinstance(err, DecodeError) or "cancel" in str(err).lower()
    assert not leaked, f"leaked after cancel: {leaked}"


def test_beat_sync_leaves_no_uninitialized_frames():
    # Clicks trigger beat-sync with the first beat after frame 0; every chroma
    # frame must be finite (pre-fix, the frames before the first beat stayed
    # np.empty garbage) and the sustained triad must still be detected.
    dur = 8.0
    t = np.arange(int(SR * dur)) / SR
    y = (0.5 * np.sin(2 * np.pi * 261.63 * t) + 0.5 * np.sin(2 * np.pi * 329.63 * t) + 0.5 * np.sin(2 * np.pi * 392.0 * t)) / 3
    rng = np.random.default_rng(7)
    for k in range(int(dur * 2)):
        i0 = int(k * 0.5 * SR)
        y[i0:i0 + int(0.02 * SR)] += rng.standard_normal(int(0.02 * SR)) * 0.8
    y = y.astype(np.float32)
    chroma, bass, rms = _chroma_from_y(y)
    assert np.isfinite(chroma).all() and np.isfinite(bass).all() and np.isfinite(rms).all()
    merged, raw = detect_chords(chroma, rms, duration_sec=dur, bass=bass)
    assert merged and raw
    assert all(np.isfinite(s.score or 0.0) for s in merged + raw)
    labels = [s.label for s in merged if s.kind == "chord"]
    assert "C:maj" in labels, labels


def test_seventh_chords_detected():
    for freqs, expected in [
        ([261.63, 329.63, 392.0, 466.16], "C:7"),
        ([261.63, 329.63, 392.0, 493.88], "C:maj7"),
        ([261.63, 311.13, 392.0, 466.16], "C:min7"),
    ]:
        y = _tone_chord(freqs, dur=3.0)
        chroma, bass, rms = _chroma_from_y(y)
        merged, raw = detect_chords(chroma, rms, duration_sec=len(y) / SR, bass=bass)
        assert [s.label for s in merged if s.kind == "chord"] == [expected], (freqs, merged)
        assert all(s.kind == "chord" for s in merged)


if __name__ == "__main__":
    test_display_label()
    test_silence_is_nc()
    test_c_major_key_and_chord()
    test_a_minor_key_and_chord()
    test_a_minor_chord_template()
    test_chord_changes_c_to_g()
    test_half_second_chord_is_displayed_at_its_onset()
    test_near_tie_follows_key_and_keeps_raw_score()
    test_bass_prior_confirms_in_key_root_position()
    test_bass_prior_flips_tie_to_bass_root()
    test_bass_prior_ignores_out_of_key_root()
    test_bass_prior_second_inversion_stays_honest()
    test_uniform_bass_cannot_flip_tie()
    test_merge_short_preserves_protected_edge_categories()
    test_merge_short_chooses_only_compatible_neighbors()
    test_merge_short_left_wins_equal_rounded_durations()
    test_consecutive_segments_respect_score_kind()
    test_seeded_noise_between_silence_stays_uncertain()
    test_short_uncertain_nc_between_silence_is_not_energy_gate()
    test_merged_chord_score_uses_assigned_template_and_exact_frames()
    test_merged_uncertain_named_score_uses_assigned_template()
    test_merged_uncertain_nc_score_is_mean_best_frame_similarity()
    test_stabilizer_absorbs_short_blip_but_raw_keeps_it()
    test_stabilizer_preserves_silence_vs_uncertain_nc()
    test_key_uncertain_on_noise()
    test_key_ambiguity_reports_alternative()
    test_temp_track_and_cleanup()
    test_cleanup_all_temps()
    test_decode_cleans_temp_wav()
    test_cancel_during_decode()
    test_beat_sync_leaves_no_uninitialized_frames()
    test_seventh_chords_detected()
    print("all passed")
