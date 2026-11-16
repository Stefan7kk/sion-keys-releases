"""
Template-based maj / min / 7th / N.C. detection.

- Raw frame decisions are kept in raw segments. Duration smoothing is display-only.
- scoreKind is template_similarity (cosine), never probability.
- N.C. from energy gate, distinct from low-similarity harmony.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

import numpy as np

from .constants import HOP_LENGTH, NO_CHORD, NOTE_NAMES, SR
from .sequence import (
    VITERBI_NO_CHORD_FLOOR,
    VITERBI_SELF_TRANSITION,
    VITERBI_TEMPERATURE,
    decode_viterbi,
)


SEVENTH_PRIOR = 0.95

# Near-tie decision priors. Audio cannot separate templates that share two of
# three chord tones (D#m↔B, C#m↔E, G#m↔B, ...); the beat-median chroma smears
# the distinguishing third. In those frames only, a key prior mildly prefers
# diatonic readings and a bass-structure prior prefers the chord the bass
# actually plays (root position > first inversion > second inversion). These
# adjust the argmax decision only: stored scores stay raw template similarity.
KEY_PRIOR_BOOST = 0.05
BASS_ROOT_BOOST = 0.10
BASS_THIRD_BOOST = 0.04
BASS_FIFTH_PENALTY = 0.90
# Bass evidence must be a real dominant pitch class, not merely the largest of
# twelve near-equal classes. Uniform bass has share 1/12 and dominance 1.0, so
# it must not influence a near-tie decision.
BASS_SHARE_MIN = 0.25
BASS_DOMINANCE_MIN = 1.5


def build_templates() -> tuple[np.ndarray, list[str]]:
    """Unit L2 templates: 12 maj + 12 min + 12 maj7 + 12 min7 + 12 dom7."""
    labels: list[str] = []
    rows: list[np.ndarray] = []
    # The 7th templates carry a stronger penalty: with four tones each they
    # must reject both the conflicting third and seventh, or structureless
    # chroma (flat noise) clears the 0.45 N.C. floor and earns a chord name.
    # They are also scaled by SEVENTH_PRIOR (a chord-type prior): a passing
    # seventh under a plain triad must not flip the label, so a 7th needs a
    # slightly clearer win than the triad reading of the same frame.
    specs = (
        ("maj", (0, 4, 7), (3,), 0.35),
        ("min", (0, 3, 7), (4,), 0.35),
        ("maj7", (0, 4, 7, 11), (3, 10), 0.5),
        ("min7", (0, 3, 7, 10), (4, 11), 0.5),
        ("7", (0, 4, 7, 10), (3, 11), 0.5),
    )
    for root_idx, root in enumerate(NOTE_NAMES):
        for q, tones, conflicts, penalty in specs:
            vec = np.zeros(12, dtype=np.float64)
            for iv in tones:
                vec[(root_idx + iv) % 12] = 1.0
            for iv in conflicts:
                vec[(root_idx + iv) % 12] -= penalty
            n = np.linalg.norm(vec)
            if n > 1e-8:
                vec = vec / n
            if q in ("maj7", "min7", "7"):
                vec = vec * SEVENTH_PRIOR
            labels.append(f"{root}:{q}")
            rows.append(vec)
    return np.stack(rows, axis=0), labels


TEMPLATES, TEMPLATE_LABELS = build_templates()

# Chord tones and pitch-class metadata per template, for the bass-structure
# prior (root position > first inversion > second inversion).
_TEMPLATE_TONES = {
    "maj": (0, 4, 7),
    "min": (0, 3, 7),
    "maj7": (0, 4, 7, 11),
    "min7": (0, 3, 7, 10),
    "7": (0, 4, 7, 10),
}
_TEMPLATE_ROOT_IDX = [NOTE_NAMES.index(lab.split(":", 1)[0]) for lab in TEMPLATE_LABELS]
_TEMPLATE_THIRDS = [_TEMPLATE_TONES[lab.split(":", 1)[1]][1] for lab in TEMPLATE_LABELS]
_TEMPLATE_PCS = [
    frozenset((_TEMPLATE_ROOT_IDX[i] + iv) % 12 for iv in _TEMPLATE_TONES[lab.split(":", 1)[1]])
    for i, lab in enumerate(TEMPLATE_LABELS)
]


def _dominant_bass_root(bass_frame: np.ndarray) -> int | None:
    """Return the dominant bass pitch-class index, or None when unreliable.

    A bass class is reliable only when it carries a meaningful share of the
    low-octave energy and is clearly stronger than the runner-up. Uniform or
    noisy bass must not influence a near-tie chord decision.
    """
    b = np.maximum(np.asarray(bass_frame, dtype=np.float64), 0.0)
    total = float(np.sum(b))
    if total <= 1e-8:
        return None
    c = int(np.argmax(b))
    share = float(b[c] / total)
    if b.size <= 1:
        runner = 0.0
    else:
        runner = float(np.max(np.delete(b, c)))
    if runner <= 1e-8:
        dominance = float("inf")
    else:
        dominance = float(b[c] / runner)
    if share >= BASS_SHARE_MIN and dominance >= BASS_DOMINANCE_MIN:
        return c
    return None


@dataclass
class ChordSegment:
    start: float
    end: float
    label: str
    score: float | None
    scoreKind: str  # "template_similarity" | "energy_gate"
    kind: str  # "chord" | "no_chord" | "uncertain"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def silence_threshold(rms: np.ndarray) -> float:
    max_rms = float(np.max(rms)) if len(rms) else 1.0
    return max(0.008, max_rms * 0.025)


def _frame_times(n_frames: int, sr: int = SR, hop: int = HOP_LENGTH) -> np.ndarray:
    return (np.arange(n_frames, dtype=np.float64) * hop) / float(sr)


# In-key chords used only when two templates are too close to separate.
# Diminished degrees are omitted because this vocabulary has no dim templates.
_DIATONIC = {
    "major": (
        (0, "maj"), (0, "maj7"),
        (2, "min"), (2, "min7"),
        (4, "min"), (4, "min7"),
        (5, "maj"), (5, "maj7"),
        (7, "maj"), (7, "7"),
        (9, "min"), (9, "min7"),
    ),
    "minor": (
        (0, "min"), (0, "min7"),
        (3, "maj"), (3, "maj7"),
        (5, "min"), (5, "min7"),
        (7, "min"), (7, "min7"), (7, "7"),
        (8, "maj"), (8, "maj7"),
        (10, "maj"), (10, "7"),
    ),
}


def diatonic_labels(tonic: str | None, mode: str | None) -> frozenset[str]:
    """Maj/min/7th labels of a key. Empty when the key was not estimated confidently."""
    if not tonic or mode not in _DIATONIC or tonic not in NOTE_NAMES:
        return frozenset()
    root = NOTE_NAMES.index(tonic)
    return frozenset(
        f"{NOTE_NAMES[(root + interval) % 12]}:{quality}"
        for interval, quality in _DIATONIC[mode]
    )


def detect_chords(
    chroma: np.ndarray,
    rms: np.ndarray,
    duration_sec: float,
    sr: int = SR,
    hop: int = HOP_LENGTH,
    min_merge_sec: float = 0.25,
    smooth_sec: float = 1.0,
    min_chord_sec: float = 0.5,
    key_tonic: str | None = None,
    key_mode: str | None = None,
    bass: np.ndarray | None = None,
    decoder: str = "stabilized",
    viterbi_temperature: float = VITERBI_TEMPERATURE,
    viterbi_self_transition: float = VITERBI_SELF_TRANSITION,
    viterbi_no_chord_floor: float = VITERBI_NO_CHORD_FLOOR,
) -> tuple[list[ChordSegment], list[ChordSegment]]:
    """
    Returns (display_merged, raw_segments).

    raw_segments: per-frame decisions before duration smoothing. Near-tie
    frames (two templates within 0.05 similarity) may be decided by the key
    prior and, when ``bass`` is given, by the bass-structure prior; the stored
    score is always that template's RAW similarity and the frame stays
    uncertain unless the margin is comfortable.
    display_merged: the default ``stabilized`` decoder keeps confident chords
    once they hold for min_chord_sec and fills uncertain flicker from the
    surrounding harmony. The optional ``viterbi`` decoder performs sequence
    decoding over raw template evidence while preserving the same confidence
    contract. Shorter wiggles remain in raw_segments either way.
    """
    n_frames = chroma.shape[0]
    if n_frames == 0:
        empty: list[ChordSegment] = []
        return empty, empty

    if bass is not None and bass.shape[0] != n_frames:
        bass = None

    if len(rms) < n_frames:
        rms = np.pad(rms, (0, n_frames - len(rms)), mode="edge")
    else:
        rms = rms[:n_frames]

    silence_thr = silence_threshold(rms)

    times = _frame_times(n_frames, sr, hop)
    # Frame end times
    frame_dur = hop / float(sr)
    in_key = diatonic_labels(key_tonic, key_mode)

    frame_labels: list[str] = []
    frame_scores: list[float] = []
    frame_kinds: list[str] = []
    frame_score_kinds: list[str] = []
    normalized_chroma = np.empty_like(chroma, dtype=np.float64)
    decision_sims = np.zeros((n_frames, len(TEMPLATE_LABELS)), dtype=np.float64)

    for t in range(n_frames):
        vec = chroma[t].astype(np.float64)
        vn = float(np.linalg.norm(vec))
        normalized_chroma[t] = vec / (vn + 1e-8)
        er = float(rms[t])
        # Energy gate is RMS-only: HPSS can flatten broadband noise to near-zero
        # chroma, but audible noise is not silence. Low-norm energetic frames
        # fall through to template matching and surface as uncertain N.C.
        if er < silence_thr:
            frame_labels.append(NO_CHORD)
            frame_scores.append(1.0)
            frame_kinds.append("no_chord")
            frame_score_kinds.append("energy_gate")
            continue

        v = normalized_chroma[t]
        raw_sims = TEMPLATES @ v  # cosine-like since templates unit-norm
        raw_order = np.argsort(raw_sims)[::-1]
        raw_best_i = int(raw_order[0])
        raw_best_s = float(raw_sims[raw_best_i])
        raw_second_s = float(raw_sims[raw_order[1]]) if len(raw_order) > 1 else raw_best_s
        raw_margin = raw_best_s - raw_second_s

        sims = raw_sims.copy()  # priors below may adjust the argmax only
        best_i = raw_best_i
        if raw_margin < 0.05 and raw_best_s >= 0.45:
            # Key prior: diatonic templates get a mild boost in near-ties.
            if in_key:
                for i, lab in enumerate(TEMPLATE_LABELS):
                    if lab in in_key:
                        sims[i] *= 1.0 + KEY_PRIOR_BOOST
            best_i = int(np.argmax(sims))
            best_s = float(sims[best_i])
            order = np.argsort(sims)[::-1]
            second_s = float(sims[order[1]]) if len(order) > 1 else best_s
            margin = best_s - second_s
            # Bass-structure prior: root position > first inversion > second
            # inversion. A dominant bass class that the winner cannot explain
            # flips the tie toward bass-root templates; a bass equal to the
            # winner's root or third confirms it; second-inversion readings
            # get no help and stay honest.
            if bass is not None and margin < 0.05:
                c = _dominant_bass_root(bass[t])
                if c is not None:
                    tie = [
                        int(i)
                        for i in np.flatnonzero(sims >= best_s - 0.05)
                    ]
                    best_in_key = (not in_key) or TEMPLATE_LABELS[best_i] in in_key
                    if _TEMPLATE_ROOT_IDX[best_i] == c and best_in_key:
                        sims[best_i] *= 1.0 + BASS_ROOT_BOOST
                    elif c not in _TEMPLATE_PCS[best_i]:
                        for i in tie:
                            if _TEMPLATE_ROOT_IDX[i] == c:
                                sims[i] *= 1.0 + BASS_ROOT_BOOST
                    elif best_in_key and (_TEMPLATE_ROOT_IDX[best_i] + _TEMPLATE_THIRDS[best_i]) % 12 == c:
                        sims[best_i] *= 1.0 + BASS_THIRD_BOOST
                        for i in tie:
                            if _TEMPLATE_ROOT_IDX[i] != c and (_TEMPLATE_ROOT_IDX[i] + 7) % 12 == c:
                                sims[i] *= BASS_FIFTH_PENALTY
                    best_i = int(np.argmax(sims))
                    best_s = float(sims[best_i])
                    order = np.argsort(sims)[::-1]
                    second_s = float(sims[order[1]]) if len(order) > 1 else best_s
                    margin = best_s - second_s

        # Confidence always comes from the RAW template evidence, never from a
        # prior-boosted decision value. Priors may choose a near-tie label, but
        # they cannot turn weak evidence into a confident chord.
        selected_raw_s = float(raw_sims[best_i])
        confidence_score = raw_best_s
        confidence_margin = raw_margin
        decision_sims[t] = sims

        if confidence_score < 0.45:
            frame_labels.append(NO_CHORD)
            frame_scores.append(round(selected_raw_s, 4))
            frame_kinds.append("uncertain")
            frame_score_kinds.append("template_similarity")
        elif confidence_margin < 0.05 and confidence_score < 0.65:
            # Ambiguous major/minor or neighboring roots
            frame_labels.append(TEMPLATE_LABELS[best_i])
            frame_scores.append(round(selected_raw_s, 4))
            frame_kinds.append("uncertain")
            frame_score_kinds.append("template_similarity")
        else:
            frame_labels.append(TEMPLATE_LABELS[best_i])
            frame_scores.append(round(selected_raw_s, 4))
            frame_kinds.append("chord")
            frame_score_kinds.append("template_similarity")

    raw = _segments_from_frames(
        frame_labels, frame_scores, frame_kinds, frame_score_kinds, times, frame_dur, duration_sec
    )
    if decoder == "viterbi":
        sm_labels, sm_kinds, sm_score_kinds = decode_viterbi(
            decision_sims,
            frame_labels,
            frame_kinds,
            frame_score_kinds,
            TEMPLATE_LABELS,
            temperature=viterbi_temperature,
            self_transition=viterbi_self_transition,
            no_chord_floor=viterbi_no_chord_floor,
        )
    elif decoder == "stabilized":
        window = max(1, int(round(smooth_sec / frame_dur))) if smooth_sec > 0 else 1
        confident_min = max(1, int(round(min_chord_sec / frame_dur))) if min_chord_sec > 0 else 1
        dwell = max(window, confident_min)
        sm_labels, sm_kinds, sm_score_kinds = _stabilize_frames(
            frame_labels, frame_kinds, frame_score_kinds, window, dwell, confident_min
        )
    else:
        raise ValueError(f"Unknown chord decoder: {decoder!r}")
    smoothed = _segments_from_frames(
        sm_labels, frame_scores, sm_kinds, sm_score_kinds, times, frame_dur, duration_sec
    )
    for segment in smoothed:
        # Stabilized spans may cover frames scored against other labels; force an
        # honest recompute from the actual frames below instead of reusing them.
        if segment.scoreKind == "template_similarity":
            segment.score = None
    merged = _merge_short(smoothed, min_merge_sec=min_merge_sec, duration_sec=duration_sec)
    for i, segment in enumerate(merged):
        if segment.scoreKind != "template_similarity" or segment.score is not None:
            continue
        # Recover exact frame indices despite four-decimal timestamp rounding.
        start_i = max(0, min(n_frames, int(round(segment.start * sr / hop))))
        end_i = n_frames if i == len(merged) - 1 else int(round(segment.end * sr / hop))
        end_i = max(start_i, min(n_frames, end_i))
        frames = normalized_chroma[start_i:end_i]
        if not len(frames):
            continue  # No evidence: leave score absent, never fabricate one.
        if segment.label == NO_CHORD:
            # Uncertain N.C. has no template: preserve per-frame best similarity.
            similarities = np.max(frames @ TEMPLATES.T, axis=1)
        else:
            template = TEMPLATES[TEMPLATE_LABELS.index(segment.label)]
            similarities = frames @ template
        segment.score = round(float(np.mean(similarities)), 4)
    return merged, raw


def _mode_smooth(
    labels: list[str],
    kinds: list[str],
    score_kinds: list[str],
    window: int,
) -> tuple[list[str], list[str], list[str]]:
    """Centered majority vote on the chord label for the display path.

    A confident frame (kind == "chord") keeps its own label: a real short chord
    must not be outvoted by surrounding harmony. Only uncertain / no-chord frames
    are filled from the neighbourhood majority, which absorbs brief low-confidence
    flicker into the sustained chord. The centre label wins ties so a sustained
    chord does not jitter at its edges.
    """
    n = len(labels)
    if window <= 1 or n == 0:
        return labels[:], kinds[:], score_kinds[:]
    half = window // 2
    out_l: list[str] = []
    out_k: list[str] = []
    out_sk: list[str] = []
    for i in range(n):
        if kinds[i] == "chord":
            out_l.append(labels[i])
            out_k.append(kinds[i])
            out_sk.append(score_kinds[i])
            continue
        lo = max(0, i - half)
        hi = min(n, i + half + 1)
        label_counts: dict[str, int] = {}
        state_counts: dict[str, dict[tuple[str, str], int]] = {}
        for j in range(lo, hi):
            lab = labels[j]
            label_counts[lab] = label_counts.get(lab, 0) + 1
            states = state_counts.setdefault(lab, {})
            key = (kinds[j], score_kinds[j])
            states[key] = states.get(key, 0) + 1
        best = max(label_counts.values())
        winner_label = (
            labels[i] if label_counts.get(labels[i], 0) == best else max(label_counts, key=lambda k: label_counts[k])
        )
        states = state_counts[winner_label]
        top = max(states.values())
        centre_state = (kinds[i], score_kinds[i])
        winner_state = (
            centre_state if states.get(centre_state, 0) == top else max(states, key=lambda k: states[k])
        )
        out_l.append(winner_label)
        out_k.append(winner_state[0])
        out_sk.append(winner_state[1])
    return out_l, out_k, out_sk


def _hysteresis_labels(
    labels: list[str], kinds: list[str], dwell: int, confident_min: int
) -> list[str]:
    """Confirm a run, then keep its original onset in offline output.

    A confident chord run is kept once it lasts ``confident_min`` frames, so a
    real short chord survives. An uncertain run must persist for the longer
    ``dwell`` before it replaces the current chord; shorter uncertain flicker is
    absorbed into the surrounding harmony.
    """
    n = len(labels)
    if n == 0:
        return labels[:]
    if dwell <= 1 and confident_min <= 1:
        return labels[:]
    out = labels[:]
    cur = labels[0]
    start = 0
    while start < n:
        end = start + 1
        while end < n and labels[end] == labels[start]:
            end += 1
        length = end - start
        confident = sum(1 for t in range(start, end) if kinds[t] == "chord") * 2 >= length
        if length >= dwell or (confident and length >= confident_min):
            cur = labels[start]
        out[start:end] = [cur] * length
        start = end
    return out


def _stabilize_frames(
    labels: list[str],
    kinds: list[str],
    score_kinds: list[str],
    window: int,
    dwell: int,
    confident_min: int,
) -> tuple[list[str], list[str], list[str]]:
    """Display-path labels: majority vote then confidence-aware hysteresis.

    Each resulting run's kind/scoreKind is the majority of the ORIGINAL frame
    states inside that run, so displayed confidence reflects real evidence rather
    than the single frame where the chord happened to switch.
    """
    sm_labels, sm_kinds, _ = _mode_smooth(labels, kinds, score_kinds, window)
    stable = _hysteresis_labels(sm_labels, sm_kinds, dwell, confident_min)
    n = len(stable)
    out_k: list[str] = [""] * n
    out_sk: list[str] = [""] * n
    i = 0
    while i < n:
        j = i
        while j < n and stable[j] == stable[i]:
            j += 1
        if stable[i] == NO_CHORD:
            # Keep silence (energy-gate) distinct from low-similarity N.C.; do not
            # majority-vote them into a single state.
            for t in range(i, j):
                if labels[t] == NO_CHORD:
                    out_k[t] = kinds[t]
                    out_sk[t] = score_kinds[t]
                else:
                    out_k[t] = "uncertain"
                    out_sk[t] = "template_similarity"
        else:
            counts: dict[tuple[str, str], int] = {}
            for t in range(i, j):
                if labels[t] != stable[i]:
                    continue  # confidence must come from frames carrying this label
                key = (kinds[t], score_kinds[t])
                counts[key] = counts.get(key, 0) + 1
            winner = max(counts, key=lambda k: counts[k]) if counts else ("uncertain", "template_similarity")
            for t in range(i, j):
                out_k[t] = winner[0]
                out_sk[t] = winner[1]
        i = j
    return stable, out_k, out_sk


def _segments_from_frames(
    labels: list[str],
    scores: list[float],
    kinds: list[str],
    score_kinds: list[str],
    times: np.ndarray,
    frame_dur: float,
    duration_sec: float,
) -> list[ChordSegment]:
    if not labels:
        return []
    segs: list[ChordSegment] = []
    start_i = 0
    for i in range(1, len(labels) + 1):
        if (
            i < len(labels)
            and labels[i] == labels[start_i]
            and kinds[i] == kinds[start_i]
            and score_kinds[i] == score_kinds[start_i]
        ):
            continue
        sl = slice(start_i, i)
        start_t = float(times[start_i])
        end_t = float(times[i - 1] + frame_dur)
        if i == len(labels):
            end_t = max(end_t, duration_sec)
        mean_score = float(np.mean(scores[sl]))
        # majority kind
        kind = kinds[start_i]
        sk = score_kinds[start_i]
        segs.append(
            ChordSegment(
                start=round(start_t, 4),
                end=round(min(end_t, duration_sec), 4),
                label=labels[start_i],
                score=round(mean_score, 4),
                scoreKind=sk,
                kind=kind,
            )
        )
        start_i = i
    if segs:
        segs[-1].end = round(duration_sec, 4)
    return segs


def _merge_short(
    segs: list[ChordSegment],
    min_merge_sec: float,
    duration_sec: float,
) -> list[ChordSegment]:
    """Preserve categories; changed template spans need frame-based rescoring."""
    if not segs:
        return []
    work = [ChordSegment(**asdict(s)) for s in segs]
    i = 0
    while i < len(work):
        dur = round(work[i].end - work[i].start, 4)
        if dur < min_merge_sec and len(work) > 1:
            compatible = [
                j for j in (i - 1, i + 1)
                if 0 <= j < len(work)
                and work[j].kind == work[i].kind
                and work[j].scoreKind == work[i].scoreKind
            ]
            if compatible:
                # Compare at the endpoints' precision, avoiding float-only tie
                # differences. Candidates are left then right: left wins ties.
                neighbor_i = max(compatible, key=lambda j: round(work[j].end - work[j].start, 4))
                neighbor = work[neighbor_i]
                if neighbor_i < i:
                    neighbor.end = work[i].end
                else:
                    neighbor.start = work[i].start
                if neighbor.scoreKind == "template_similarity":
                    neighbor.score = None
                del work[i]
                continue
        i += 1

    out: list[ChordSegment] = []
    for s in work:
        if (
            out
            and out[-1].label == s.label
            and out[-1].kind == s.kind
            and out[-1].scoreKind == s.scoreKind
        ):
            prev = out[-1]
            pd = prev.end - prev.start
            cd = s.end - s.start
            if prev.scoreKind == "template_similarity":
                prev.score = None
            elif prev.score is not None and s.score is not None and (pd + cd) > 0:
                prev.score = round((prev.score * pd + s.score * cd) / (pd + cd), 4)
            prev.end = s.end
        else:
            out.append(ChordSegment(**asdict(s)))
    return out


def display_label(label: str) -> str:
    """C:maj → C, C:min → Cm, C:maj7 → Cmaj7, C:min7 → Cm7, C:7 → C7."""
    if label == NO_CHORD:
        return NO_CHORD
    if ":" not in label:
        return label
    root, q = label.split(":", 1)
    if q == "maj":
        return root
    if q == "min":
        return f"{root}m"
    if q == "maj7":
        return f"{root}maj7"
    if q == "min7":
        return f"{root}m7"
    if q == "7":
        return f"{root}7"
    return label
