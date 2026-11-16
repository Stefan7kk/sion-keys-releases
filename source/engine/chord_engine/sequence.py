"""Sequence decoding for chord display segments.

The frame scorer produces per-frame template evidence. This module turns that
evidence into a stable label sequence. It does not create confidence: the
caller still derives each span's ``kind`` from the original frame evidence.
"""

from __future__ import annotations

from typing import Sequence

import numpy as np

from .constants import NO_CHORD, SR, HOP_LENGTH

VITERBI_TEMPERATURE = 0.16
VITERBI_SELF_TRANSITION = 0.93
VITERBI_NO_CHORD_FLOOR = 0.50


def decode_viterbi(
    decision_sims: np.ndarray,
    frame_labels: Sequence[str],
    frame_kinds: Sequence[str],
    frame_score_kinds: Sequence[str],
    template_labels: Sequence[str],
    temperature: float = VITERBI_TEMPERATURE,
    self_transition: float = VITERBI_SELF_TRANSITION,
    no_chord_floor: float = VITERBI_NO_CHORD_FLOOR,
) -> tuple[list[str], list[str], list[str]]:
    """Decode named chord labels plus an uncertain-N.C. state.

    Energy-gated ``no_chord`` frames are hard boundaries and are never passed
    through the Viterbi path. Within each active region, the emission for a
    named template is its prior-adjusted similarity; the uncertain-N.C. state
    uses a fixed similarity floor. The returned scores are still placeholders:
    the caller must rescore spans from raw template similarity.
    """
    n_frames = int(decision_sims.shape[0])
    if n_frames == 0:
        return [], [], []
    if decision_sims.shape[1] != len(template_labels):
        raise ValueError("decision_sims columns must match template labels")
    if len(frame_labels) != n_frames or len(frame_kinds) != n_frames:
        raise ValueError("frame label/kind arrays must match decision_sims")

    temperature = max(float(temperature), 1e-6)
    self_transition = min(max(float(self_transition), 1e-6), 1.0 - 1e-6)

    output_labels = list(frame_labels)
    output_kinds = list(frame_kinds)
    output_score_kinds = list(frame_score_kinds)

    active = np.asarray([kind != "no_chord" for kind in frame_kinds], dtype=bool)
    start = 0
    while start < n_frames:
        if not active[start]:
            start += 1
            continue
        end = start + 1
        while end < n_frames and active[end]:
            end += 1
        _decode_region(
            start,
            end,
            decision_sims,
            frame_labels,
            frame_kinds,
            frame_score_kinds,
            template_labels,
            temperature,
            self_transition,
            no_chord_floor,
            output_labels,
            output_kinds,
            output_score_kinds,
        )
        start = end

    _restore_sustained_candidates(decision_sims, frame_labels, frame_kinds, template_labels, output_labels, output_kinds, output_score_kinds, no_chord_floor)
    return output_labels, output_kinds, output_score_kinds


def _decode_region(
    start: int,
    end: int,
    decision_sims: np.ndarray,
    frame_labels: Sequence[str],
    frame_kinds: Sequence[str],
    frame_score_kinds: Sequence[str],
    template_labels: Sequence[str],
    temperature: float,
    self_transition: float,
    no_chord_floor: float,
    output_labels: list[str],
    output_kinds: list[str],
    output_score_kinds: list[str],
) -> None:
    length = end - start
    if length <= 0:
        return
    n_named = len(template_labels)
    n_states = n_named + 1
    nc_state = n_named

    emissions = np.empty((length, n_states), dtype=np.float64)
    emissions[:, :n_named] = decision_sims[start:end] / temperature
    # The uncertain-N.C. state represents active but harmonically weak audio.
    # A named template must clear the evidence floor to outrank it. The floor
    # is slightly above the raw N.C. threshold so isolated low-evidence blips
    # stay unnamed rather than becoming spurious uncertain chord names.
    emissions[:, nc_state] = no_chord_floor / temperature

    log_self = np.log(self_transition)
    log_other = np.log((1.0 - self_transition) / max(n_states - 1, 1))
    backpointer = np.zeros((length, n_states), dtype=np.int16)
    previous = emissions[0].copy()

    for t in range(1, length):
        order = np.argsort(previous)[::-1]
        best_i = int(order[0])
        best_s = float(previous[best_i])
        second_i = int(order[1]) if len(order) > 1 else best_i
        second_s = float(previous[second_i]) if len(order) > 1 else best_s

        stay = previous + log_self
        change = np.full(n_states, best_s + log_other, dtype=np.float64)
        change_idx = np.full(n_states, best_i, dtype=np.int16)
        change[best_i] = second_s + log_other
        change_idx[best_i] = second_i

        keep = stay >= change
        previous = np.where(keep, stay, change) + emissions[t]
        backpointer[t] = np.where(keep, np.arange(n_states, dtype=np.int16), change_idx)

    path = np.empty(length, dtype=np.int16)
    path[-1] = int(np.argmax(previous))
    for t in range(length - 2, -1, -1):
        path[t] = backpointer[t + 1, path[t + 1]]

    run_start = 0
    while run_start < length:
        state = int(path[run_start])
        run_end = run_start + 1
        while run_end < length and int(path[run_end]) == state:
            run_end += 1
        absolute_start = start + run_start
        absolute_end = start + run_end
        if state == nc_state:
            label = NO_CHORD
            kind = "uncertain"
            score_kind = "template_similarity"
        else:
            label = template_labels[state]
            kind, score_kind = _span_confidence(
                label,
                frame_labels[absolute_start:absolute_end],
                frame_kinds[absolute_start:absolute_end],
                frame_score_kinds[absolute_start:absolute_end],
            )
        for t in range(absolute_start, absolute_end):
            output_labels[t] = label
            output_kinds[t] = kind
            output_score_kinds[t] = score_kind
        run_start = run_end


def _span_confidence(
    label: str,
    labels: Sequence[str],
    kinds: Sequence[str],
    score_kinds: Sequence[str],
) -> tuple[str, str]:
    """Preserve raw confidence for a decoded named-chord span."""
    counts: dict[tuple[str, str], int] = {}
    for frame_label, kind, score_kind in zip(labels, kinds, score_kinds):
        if frame_label != label:
            continue
        counts[(kind, score_kind)] = counts.get((kind, score_kind), 0) + 1
    if not counts:
        # The decoder chose a label no raw frame supported. Keep it visible,
        # but never invent confidence for it.
        return "uncertain", "template_similarity"
    return max(counts, key=lambda key: counts[key])

def _restore_sustained_candidates(sims, labels, kinds, template_labels,
                                 output_labels, output_kinds, output_score_kinds, no_chord_floor):
    """Break uncertain holds only for sustained, stronger named evidence.

    This restores candidate boundaries, not confidence. Silence and confident
    decoded spans remain unchanged; raw frame data is never modified.
    """
    long_hold = [False] * len(labels)
    start = 0
    while start < len(labels):
        end = start + 1
        while end < len(labels) and output_labels[end] == output_labels[start] and output_kinds[end] == output_kinds[start]:
            end += 1
        if output_kinds[start] == "uncertain" and (end-start)*HOP_LENGTH/SR >= 5:
            long_hold[start:end] = [True] * (end-start)
        start = end
    index = {label: i for i, label in enumerate(template_labels)}
    minimum = int(np.ceil(0.5 * SR / HOP_LENGTH))
    start = 0
    while start < len(labels):
        end = start + 1
        while end < len(labels) and labels[end] == labels[start] and kinds[end] != "no_chord":
            end += 1
        label = labels[start]
        if end - start >= minimum and label in index and kinds[start] != "no_chord":
            candidate = index[label]
            for t in range(start, end):
                if not long_hold[t] or output_labels[t] == label:
                    continue
                incumbent = index.get(output_labels[t])
                # Do not override a near tie: keep a measurable evidence margin.
                floor = no_chord_floor if incumbent is None else sims[t, incumbent]
                if sims[t, candidate] >= floor + 0.03:
                    output_labels[t] = label
                    output_score_kinds[t] = "template_similarity"
        start = end
