"""
24-way Krumhansl–Kessler key estimate.

Returns tonic, mode, relative alternative, correlation scores, and uncertainty.
Scores are profile_correlation — not probability of correctness.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

import numpy as np

from .constants import KK_MAJOR, KK_MINOR, NOTE_NAMES


@dataclass
class KeyResult:
    label: str  # e.g. "G Major"
    tonic: str
    mode: str  # "major" | "minor"
    score: float | None
    scoreKind: str  # "profile_correlation"
    alternative: dict[str, Any] | None
    uncertain: bool
    margin: float | None  # best - second best correlation

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _relative_major_minor(tonic: str, mode: str) -> tuple[str, str]:
    """Return relative key (tonic, mode)."""
    idx = NOTE_NAMES.index(tonic)
    if mode == "major":
        # relative minor = -3 semitones
        return NOTE_NAMES[(idx - 3) % 12], "minor"
    return NOTE_NAMES[(idx + 3) % 12], "major"


def estimate_key(chroma: np.ndarray) -> KeyResult:
    """
    chroma: (n_frames, 12) non-negative; silent/empty → Uncertain.
    """
    if chroma.size == 0 or chroma.shape[0] < 2:
        return KeyResult(
            label="Uncertain",
            tonic="",
            mode="",
            score=None,
            scoreKind="profile_correlation",
            alternative=None,
            uncertain=True,
            margin=None,
        )

    agg = chroma.mean(axis=0).astype(np.float64)
    s = float(agg.sum())
    if s < 1e-8:
        return KeyResult(
            label="Uncertain",
            tonic="",
            mode="",
            score=None,
            scoreKind="profile_correlation",
            alternative=None,
            uncertain=True,
            margin=None,
        )
    agg = agg / s

    kk_maj = np.asarray(KK_MAJOR, dtype=np.float64)
    kk_min = np.asarray(KK_MINOR, dtype=np.float64)

    scored: list[tuple[float, str, str]] = []
    for root_idx, name in enumerate(NOTE_NAMES):
        maj_p = np.roll(kk_maj, root_idx)
        min_p = np.roll(kk_min, root_idx)
        # corrcoef can be nan if variance is 0
        maj_c = float(np.corrcoef(agg, maj_p)[0, 1])
        min_c = float(np.corrcoef(agg, min_p)[0, 1])
        if np.isnan(maj_c):
            maj_c = -1.0
        if np.isnan(min_c):
            min_c = -1.0
        scored.append((maj_c, name, "major"))
        scored.append((min_c, name, "minor"))

    scored.sort(key=lambda t: t[0], reverse=True)
    best_score, tonic, mode = scored[0]
    second = scored[1][0] if len(scored) > 1 else best_score
    margin = float(best_score - second)

    # Relative major/minor often close; surface as alternative, not as "wrong".
    rel_t, rel_m = _relative_major_minor(tonic, mode)
    rel_score = next((s for s, t, m in scored if t == rel_t and m == rel_m), None)

    # Uncertainty: low absolute correlation or tiny margin vs non-relative runner-up
    non_rel = [s for s, t, m in scored[1:] if not (t == rel_t and m == rel_m)]
    next_non_rel = non_rel[0] if non_rel else second
    margin_non_rel = float(best_score - next_non_rel)
    uncertain = bool(best_score < 0.35 or margin_non_rel < 0.04)

    mode_label = "Major" if mode == "major" else "Minor"
    label = "Uncertain" if uncertain and best_score < 0.25 else f"{tonic} {mode_label}"
    if uncertain and best_score < 0.25:
        return KeyResult(
            label="Uncertain",
            tonic=tonic,
            mode=mode,
            score=round(best_score, 4),
            scoreKind="profile_correlation",
            alternative={
                "label": f"{tonic} {mode_label}",
                "tonic": tonic,
                "mode": mode,
                "score": round(best_score, 4),
                "scoreKind": "profile_correlation",
            },
            uncertain=True,
            margin=round(margin, 4),
        )

    alt = {
        "label": f"{rel_t} {'Major' if rel_m == 'major' else 'Minor'}",
        "tonic": rel_t,
        "mode": rel_m,
        "score": round(float(rel_score), 4) if rel_score is not None else None,
        "scoreKind": "profile_correlation",
        "relation": "relative",
    }

    return KeyResult(
        label=label if not uncertain else f"{tonic} {mode_label}",
        tonic=tonic,
        mode=mode,
        score=round(best_score, 4),
        scoreKind="profile_correlation",
        alternative=alt,
        uncertain=uncertain,
        margin=round(margin, 4),
    )
