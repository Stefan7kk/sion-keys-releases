"""Synthetic tests for the chord sequence decoder."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from chord_engine.chords import TEMPLATE_LABELS  # noqa: E402
from chord_engine.constants import NO_CHORD  # noqa: E402
from chord_engine.sequence import _span_confidence, decode_viterbi  # noqa: E402


def _sims_for_labels(labels: list[str], strength: float = 0.9) -> np.ndarray:
    sims = np.zeros((len(labels), len(TEMPLATE_LABELS)), dtype=np.float64)
    for index, label in enumerate(labels):
        if label != NO_CHORD:
            sims[index, TEMPLATE_LABELS.index(label)] = strength
    return sims


def _frame_state(labels: list[str]) -> tuple[list[str], list[str], list[str]]:
    kinds: list[str] = []
    score_kinds: list[str] = []
    for label in labels:
        if label == NO_CHORD:
            kinds.append("uncertain")
        else:
            kinds.append("chord")
        score_kinds.append("template_similarity")
    return labels[:], kinds, score_kinds


def _decode(labels: list[str], self_transition: float = 0.93):
    sims = _sims_for_labels(labels)
    frame_labels, kinds, score_kinds = _frame_state(labels)
    return decode_viterbi(
        sims,
        frame_labels,
        kinds,
        score_kinds,
        TEMPLATE_LABELS,
        self_transition=self_transition,
    )


def test_viterbi_absorbs_two_frame_flicker():
    labels = ["C:maj"] * 30 + ["D:maj"] * 2 + ["C:maj"] * 30
    decoded, _, _ = _decode(labels)
    assert decoded == ["C:maj"] * 62


def test_viterbi_preserves_half_second_chord():
    # 2048 / 22050 = 92.9 ms per frame; six frames are about 0.56 s.
    labels = ["C:maj"] * 20 + ["G:maj"] * 6 + ["C:maj"] * 20
    decoded, kinds, _ = _decode(labels)
    g_indices = [index for index, label in enumerate(decoded) if label == "G:maj"]
    assert g_indices, decoded
    assert min(g_indices) >= 18 and max(g_indices) <= 27, decoded
    assert all(kind == "chord" for kind in kinds)


def test_viterbi_keeps_energy_gate_frames_fixed():
    labels = ["N.C."] * 5 + ["C:maj"] * 15 + ["N.C."] * 5
    sims = _sims_for_labels(labels)
    frame_labels, kinds, score_kinds = _frame_state(labels)
    kinds[:5] = ["no_chord"] * 5
    kinds[-5:] = ["no_chord"] * 5
    score_kinds[:5] = ["energy_gate"] * 5
    score_kinds[-5:] = ["energy_gate"] * 5
    decoded, decoded_kinds, decoded_score_kinds = decode_viterbi(
        sims,
        frame_labels,
        kinds,
        score_kinds,
        TEMPLATE_LABELS,
    )
    assert decoded[:5] == [NO_CHORD] * 5
    assert decoded[-5:] == [NO_CHORD] * 5
    assert decoded_kinds[:5] == ["no_chord"] * 5
    assert decoded_score_kinds[:5] == ["energy_gate"] * 5
    assert any(label == "C:maj" for label in decoded[5:-5])


def test_span_confidence_never_invents_support():
    kind, score_kind = _span_confidence(
        "C:maj",
        labels=["G:maj", "G:maj"],
        kinds=["chord", "chord"],
        score_kinds=["template_similarity", "template_similarity"],
    )
    assert (kind, score_kind) == ("uncertain", "template_similarity")


if __name__ == "__main__":
    test_viterbi_absorbs_two_frame_flicker()
    test_viterbi_preserves_half_second_chord()
    test_viterbi_keeps_energy_gate_frames_fixed()
    test_span_confidence_never_invents_support()
    print("all sequence tests passed")
