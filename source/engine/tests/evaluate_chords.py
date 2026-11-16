"""Chord evaluation harness for development use only.

Reads recording-aligned ``.lab`` chord annotations and engine result JSON,
then reports interval and boundary metrics. This module is intentionally
small and dependency-free apart from the standard library.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

NO_CHORD = "N.C."

_NOTE_ALIASES = {
    "C": "C", "C#": "C#", "Db": "C#",
    "D": "D", "D#": "D#", "Eb": "D#",
    "E": "E", "F": "F", "F#": "F#", "Gb": "F#",
    "G": "G", "G#": "G#", "Ab": "G#",
    "A": "A", "A#": "A#", "Bb": "A#",
    "B": "B",
}

_QUALITY_ALIASES = {
    "": "maj",
    "maj": "maj",
    "major": "maj",
    "m": "min",
    "min": "min",
    "minor": "min",
    "maj7": "maj7",
    "m7": "min7",
    "min7": "min7",
    "7": "7",
    "dom7": "7",
    "maj6": "maj6",
    "min6": "min6",
    "dim": "dim",
    "dim7": "dim7",
    "hdim7": "hdim7",
    "aug": "aug",
    "sus2": "sus2",
    "sus4": "sus4",
}

_TRIAD_FAMILIES = {
    "maj": "maj",
    "maj7": "maj",
    "maj6": "maj",
    "7": "maj",
    "6": "maj",
    "add9": "maj",
    "9": "maj",
    "11": "maj",
    "min": "min",
    "min7": "min",
    "min6": "min",
    "min9": "min",
    "dim": "dim",
    "dim7": "dim",
    "hdim7": "dim",
    "aug": "aug",
    "sus2": "sus2",
    "sus4": "sus4",
}

_NO_CHORD_LABELS = {
    "N.C.",
    "N.C",
    "NC",
    "N",
    "NO_CHORD",
    "NOCHORD",
    "SILENCE",
}


@dataclass(frozen=True)
class Segment:
    """A time-aligned chord interval."""

    start: float
    end: float
    label: str
    kind: str = "ground_truth"


def _normalize_root(root: str) -> str:
    key = root.strip()
    if key not in _NOTE_ALIASES:
        raise ValueError(f"Unsupported chord root: {root!r}")
    return _NOTE_ALIASES[key]


def normalize_label(label: str) -> str:
    """Normalize display or colon labels to ``Root:quality`` or ``N.C.``."""
    text = label.strip()
    if not text:
        raise ValueError("Empty chord label")
    if text.upper() in _NO_CHORD_LABELS:
        return NO_CHORD

    # Harte-style annotations may include an inversion/bass suffix
    # (C/7, A:min/b7, E:min/b3). The app does not emit slash chords, so
    # evaluate the root-position chord while retaining it as a documented
    # annotation simplification.
    text = text.split("/", 1)[0].strip()
    if not text:
        raise ValueError(f"Chord label has no root: {label!r}")

    if ":" in text:
        root, quality = text.split(":", 1)
        normalized_root = _normalize_root(root)
        normalized_quality = _QUALITY_ALIASES.get(quality.strip().lower())
        if normalized_quality is None:
            raise ValueError(f"Unsupported chord quality: {quality!r}")
        return f"{normalized_root}:{normalized_quality}"

    # Display form: C, Cm, Cmaj7, Cm7, C7, Cdim, Caug, Csus2, Csus4.
    root = text[0]
    rest = text[1:]
    if rest[:1] in ("#", "b"):
        root += rest[0]
        rest = rest[1:]
    normalized_root = _normalize_root(root)
    normalized_quality = _QUALITY_ALIASES.get(rest.strip().lower())
    if normalized_quality is None:
        raise ValueError(f"Unsupported chord quality: {rest!r}")
    return f"{normalized_root}:{normalized_quality}"


def load_lab(path: str | Path) -> list[Segment]:
    """Load a three-column ``start end label`` chord annotation."""
    lab_path = Path(path)
    if not lab_path.is_file():
        raise FileNotFoundError(f"Annotation file not found: {lab_path}")
    segments: list[Segment] = []
    with lab_path.open("r", encoding="utf-8-sig") as handle:
        for line_number, raw_line in enumerate(handle, start=1):
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) < 3:
                raise ValueError(
                    f"{lab_path}:{line_number}: expected 'start end label', got {line!r}"
                )
            try:
                start = float(parts[0])
                end = float(parts[1])
            except ValueError as exc:
                raise ValueError(
                    f"{lab_path}:{line_number}: invalid interval {line!r}"
                ) from exc
            if start < 0 or end <= start:
                raise ValueError(
                    f"{lab_path}:{line_number}: invalid interval {start!r}-{end!r}"
                )
            segments.append(
                Segment(
                    start=start,
                    end=end,
                    label=normalize_label(" ".join(parts[2:])),
                    kind="ground_truth",
                )
            )
    if not segments:
        raise ValueError(f"{lab_path}: no chord annotations")
    segments.sort(key=lambda segment: segment.start)
    _validate_timeline(segments, source=str(lab_path))
    return segments


def load_result(path: str | Path) -> tuple[list[Segment], float, dict]:
    """Load displayed ``chords`` from an engine result JSON file."""
    result_path = Path(path)
    if not result_path.is_file():
        raise FileNotFoundError(f"Result file not found: {result_path}")
    with result_path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not payload.get("ok"):
        raise ValueError(f"{result_path}: result is not ok")
    duration = float(payload["source"]["durationSec"])
    raw_segments = payload.get("chords", [])
    segments: list[Segment] = []
    for item in raw_segments:
        label = item.get("label", item.get("display", ""))
        segments.append(
            Segment(
                start=float(item["start"]),
                end=float(item["end"]),
                label=normalize_label(label),
                kind=str(item.get("kind", "unknown")),
            )
        )
    _validate_timeline(segments, source=str(result_path))
    meta = payload.get("meta", {})
    meta.setdefault("engineVersion", payload.get("engineVersion"))
    return segments, duration, meta


def _validate_timeline(segments: Sequence[Segment], source: str) -> None:
    if not segments:
        raise ValueError(f"{source}: no segments")
    previous_end = segments[0].start
    for index, segment in enumerate(segments):
        if segment.start < 0 or segment.end <= segment.start:
            raise ValueError(f"{source}: invalid segment {segment}")
        if segment.start < previous_end - 1e-6:
            raise ValueError(f"{source}: overlapping segments at index {index}")
        previous_end = segment.end


def _label_root(segment: Segment) -> str:
    label = segment.label
    if label == NO_CHORD:
        return NO_CHORD
    return label.split(":", 1)[0]


def _label_family(segment: Segment) -> str:
    label = segment.label
    if label == NO_CHORD:
        return NO_CHORD
    root, quality = label.split(":", 1)
    family = _TRIAD_FAMILIES.get(quality, quality)
    return f"{root}:{family}"


def _overlap(start_a: float, end_a: float, start_b: float, end_b: float) -> float:
    return max(0.0, min(end_a, end_b) - max(start_a, start_b))


def _match_duration(
    ground_truth: Sequence[Segment],
    predicted: Sequence[Segment],
    key: Callable[[Segment], str],
    strict: bool = False,
) -> float:
    matched = 0.0
    i = 0
    j = 0
    while i < len(ground_truth) and j < len(predicted):
        gt = ground_truth[i]
        pred = predicted[j]
        overlap = _overlap(gt.start, gt.end, pred.start, pred.end)
        if overlap > 0 and key(gt) == key(pred):
            if not strict or _strictly_correct(gt, pred):
                matched += overlap
        if gt.end < pred.end:
            i += 1
        else:
            j += 1
    return matched


def _strictly_correct(ground_truth: Segment, predicted: Segment) -> bool:
    if ground_truth.label == NO_CHORD:
        return predicted.label == NO_CHORD and predicted.kind == "no_chord"
    return predicted.kind == "chord"


def _boundary_times(
    segments: Sequence[Segment],
    key: Callable[[Segment], str],
) -> list[float]:
    times: list[float] = []
    previous_label: str | None = None
    for segment in segments:
        current = key(segment)
        if previous_label is not None and current != previous_label:
            times.append(segment.start)
        previous_label = current
    return times


def _boundary_metrics(
    ground_truth_times: Sequence[float],
    predicted_times: Sequence[float],
    tolerance: float,
) -> dict[str, float | int]:
    gt = sorted(ground_truth_times)
    pred = sorted(predicted_times)
    true_positive = 0
    used_pred: set[int] = set()
    for gt_time in gt:
        best_index: int | None = None
        best_distance = float("inf")
        for index, pred_time in enumerate(pred):
            if index in used_pred:
                continue
            distance = abs(pred_time - gt_time)
            if distance < best_distance:
                best_distance = distance
                best_index = index
        if best_index is not None and best_distance <= tolerance:
            true_positive += 1
            used_pred.add(best_index)
    false_positive = len(pred) - true_positive
    false_negative = len(gt) - true_positive
    precision = true_positive / (true_positive + false_positive) if (true_positive + false_positive) else 0.0
    recall = true_positive / (true_positive + false_negative) if (true_positive + false_negative) else 0.0
    f1 = (
        2 * precision * recall / (precision + recall)
        if (precision + recall) > 0
        else 0.0
    )
    return {
        "truePositive": true_positive,
        "falsePositive": false_positive,
        "falseNegative": false_negative,
        "precision": round(precision, 6),
        "recall": round(recall, 6),
        "f1": round(f1, 6),
    }


def _kind_duration(
    ground_truth: Sequence[Segment],
    predicted: Sequence[Segment],
    ground_truth_kind: str,
    predicted_kind: str,
) -> float:
    total = 0.0
    for gt in ground_truth:
        if gt.label == NO_CHORD if ground_truth_kind == "no_chord" else gt.label != NO_CHORD:
            for pred in predicted:
                if pred.kind == predicted_kind:
                    total += _overlap(gt.start, gt.end, pred.start, pred.end)
    return total


def evaluate_pair(
    predicted: Sequence[Segment],
    ground_truth: Sequence[Segment],
    duration: float,
    tolerance: float = 0.25,
) -> dict[str, float | int | dict[str, float]]:
    if duration <= 0:
        raise ValueError("Duration must be positive")

    exact = _match_duration(ground_truth, predicted, lambda segment: segment.label)
    root = _match_duration(ground_truth, predicted, _label_root)
    triad = _match_duration(ground_truth, predicted, _label_family)
    strict_exact = _match_duration(ground_truth, predicted, lambda segment: segment.label, strict=True)
    strict_root = _match_duration(ground_truth, predicted, _label_root, strict=True)
    strict_triad = _match_duration(ground_truth, predicted, _label_family, strict=True)

    confident_segments = [segment for segment in predicted if segment.kind == "chord"]
    confident_duration = sum(segment.end - segment.start for segment in confident_segments)
    confident_exact = _match_duration(ground_truth, confident_segments, lambda segment: segment.label)
    confident_root = _match_duration(ground_truth, confident_segments, _label_root)
    confident_triad = _match_duration(ground_truth, confident_segments, _label_family)

    uncertain_duration = sum(
        segment.end - segment.start for segment in predicted if segment.kind == "uncertain"
    )
    no_chord_duration = sum(
        segment.end - segment.start for segment in predicted if segment.kind == "no_chord"
    )

    exact_boundaries = _boundary_metrics(
        _boundary_times(ground_truth, lambda segment: segment.label),
        _boundary_times(predicted, lambda segment: segment.label),
        tolerance,
    )
    triad_boundaries = _boundary_metrics(
        _boundary_times(ground_truth, _label_family),
        _boundary_times(predicted, _label_family),
        tolerance,
    )

    return {
        "durationSec": round(duration, 6),
        "exactAccuracy": round(exact / duration, 6),
        "rootAccuracy": round(root / duration, 6),
        "triadAccuracy": round(triad / duration, 6),
        "strictExactAccuracy": round(strict_exact / duration, 6),
        "strictRootAccuracy": round(strict_root / duration, 6),
        "strictTriadAccuracy": round(strict_triad / duration, 6),
        "confidentTimeSec": round(confident_duration, 6),
        "confidentTimePct": round(confident_duration / duration, 6),
        "confidentExactAccuracy": (
            round(confident_exact / confident_duration, 6) if confident_duration > 0 else None
        ),
        "confidentRootAccuracy": (
            round(confident_root / confident_duration, 6) if confident_duration > 0 else None
        ),
        "confidentTriadAccuracy": (
            round(confident_triad / confident_duration, 6) if confident_duration > 0 else None
        ),
        "uncertainTimeSec": round(uncertain_duration, 6),
        "uncertainTimePct": round(uncertain_duration / duration, 6),
        "noChordTimeSec": round(no_chord_duration, 6),
        "noChordTimePct": round(no_chord_duration / duration, 6),
        "boundaryExact": exact_boundaries,
        "boundaryTriad": triad_boundaries,
        "confusion": {
            "groundTruthNoChord": {
                "predictedNoChordSec": round(
                    _kind_duration(ground_truth, predicted, "no_chord", "no_chord"), 6
                ),
                "predictedUncertainSec": round(
                    _kind_duration(ground_truth, predicted, "no_chord", "uncertain"), 6
                ),
                "predictedChordSec": round(
                    _kind_duration(ground_truth, predicted, "no_chord", "chord"), 6
                ),
            },
            "groundTruthChord": {
                "predictedNoChordSec": round(
                    _kind_duration(ground_truth, predicted, "chord", "no_chord"), 6
                ),
                "predictedUncertainSec": round(
                    _kind_duration(ground_truth, predicted, "chord", "uncertain"), 6
                ),
                "predictedChordSec": round(
                    _kind_duration(ground_truth, predicted, "chord", "chord"), 6
                ),
            },
        },
    }


def _resolve_path(base: Path, value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else base / path


def evaluate_manifest(
    manifest_path: str | Path,
    output_path: str | Path | None = None,
    tolerance: float = 0.25,
) -> dict:
    manifest_file = Path(manifest_path)
    if not manifest_file.is_file():
        raise FileNotFoundError(f"Manifest not found: {manifest_file}")
    with manifest_file.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    base_dir = manifest_file.parent
    tolerance = float(manifest.get("toleranceSec", tolerance))

    evaluated: list[dict] = []
    pending: list[dict] = []
    for entry in manifest.get("songs", []):
        song_id = entry.get("id")
        split = entry.get("split", "unspecified")
        result_value = entry.get("result")
        lab_value = entry.get("lab")
        if not song_id or not result_value:
            pending.append(
                {
                    "id": song_id,
                    "split": split,
                    "reason": "missing id or result path",
                }
            )
            continue
        result_path = _resolve_path(base_dir, result_value)
        if not lab_value:
            pending.append(
                {
                    "id": song_id,
                    "split": split,
                    "reason": "annotation pending",
                    "result": str(result_path),
                }
            )
            continue
        lab_path = _resolve_path(base_dir, lab_value)
        if not lab_path.is_file():
            pending.append(
                {
                    "id": song_id,
                    "split": split,
                    "reason": "annotation file missing",
                    "result": str(result_path),
                }
            )
            continue
        try:
            predicted, duration, meta = load_result(result_path)
            ground_truth = load_lab(lab_path)
            offset = float(entry.get("offsetSec", 0.0))
            if offset:
                # Development recordings can have a different intro/lead-in
                # from the source annotation. Apply one fixed offset for the
                # whole song; never fit an offset per decoder/candidate.
                ground_truth = [
                    Segment(
                        start=segment.start + offset,
                        end=segment.end + offset,
                        label=segment.label,
                        kind=segment.kind,
                    )
                    for segment in ground_truth
                ]
            metrics = evaluate_pair(predicted, ground_truth, duration, tolerance)
        except Exception as exc:
            pending.append(
                {
                    "id": song_id,
                    "split": split,
                    "reason": str(exc),
                    "result": str(result_path),
                }
            )
            continue
        evaluated.append(
            {
                "id": song_id,
                "split": split,
                "result": str(result_path),
                "lab": str(lab_path),
                "metrics": metrics,
                "meta": {
                    "engineVersion": meta.get("engineVersion"),
                    "timings": meta.get("timings"),
                    "wallSec": meta.get("wallSec"),
                },
            }
        )

    aggregate = _aggregate_metrics(evaluated)
    report = {
        "ok": True,
        "toleranceSec": tolerance,
        "songs": evaluated,
        "pending": pending,
        "aggregate": aggregate,
    }
    if output_path is not None:
        output_file = Path(output_path)
        output_file.parent.mkdir(parents=True, exist_ok=True)
        output_file.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def _aggregate_metrics(evaluated: Sequence[dict]) -> dict:
    if not evaluated:
        return {
            "songs": 0,
            "durationSec": 0.0,
            "exactAccuracy": None,
            "rootAccuracy": None,
            "triadAccuracy": None,
            "strictExactAccuracy": None,
            "strictRootAccuracy": None,
            "strictTriadAccuracy": None,
            "confidentTimeSec": 0.0,
            "uncertainTimeSec": 0.0,
            "boundaryExactF1": None,
            "boundaryTriadF1": None,
        }

    total_duration = 0.0
    exact = 0.0
    root = 0.0
    triad = 0.0
    strict_exact = 0.0
    strict_root = 0.0
    strict_triad = 0.0
    confident_duration = 0.0
    confident_exact = 0.0
    uncertain_duration = 0.0
    boundary_exact_counts = {"truePositive": 0, "falsePositive": 0, "falseNegative": 0}
    boundary_triad_counts = {"truePositive": 0, "falsePositive": 0, "falseNegative": 0}

    for song in evaluated:
        metrics = song["metrics"]
        duration = float(metrics["durationSec"])
        total_duration += duration
        exact += float(metrics["exactAccuracy"]) * duration
        root += float(metrics["rootAccuracy"]) * duration
        triad += float(metrics["triadAccuracy"]) * duration
        strict_exact += float(metrics["strictExactAccuracy"]) * duration
        strict_root += float(metrics["strictRootAccuracy"]) * duration
        strict_triad += float(metrics["strictTriadAccuracy"]) * duration
        confident_duration += float(metrics["confidentTimeSec"])
        confident_exact += (
            float(metrics["confidentExactAccuracy"] or 0.0) * float(metrics["confidentTimeSec"])
        )
        uncertain_duration += float(metrics["uncertainTimeSec"])
        for key, value in metrics["boundaryExact"].items():
            if key in boundary_exact_counts:
                boundary_exact_counts[key] += int(value)
        for key, value in metrics["boundaryTriad"].items():
            if key in boundary_triad_counts:
                boundary_triad_counts[key] += int(value)

    def _boundary_f1(counts: dict[str, int]) -> float | None:
        tp = counts["truePositive"]
        fp = counts["falsePositive"]
        fn = counts["falseNegative"]
        if tp + fp + fn == 0:
            return None
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        return round(
            2 * precision * recall / (precision + recall) if (precision + recall) else 0.0,
            6,
        )

    return {
        "songs": len(evaluated),
        "durationSec": round(total_duration, 6),
        "exactAccuracy": round(exact / total_duration, 6),
        "rootAccuracy": round(root / total_duration, 6),
        "triadAccuracy": round(triad / total_duration, 6),
        "strictExactAccuracy": round(strict_exact / total_duration, 6),
        "strictRootAccuracy": round(strict_root / total_duration, 6),
        "strictTriadAccuracy": round(strict_triad / total_duration, 6),
        "confidentTimeSec": round(confident_duration, 6),
        "confidentExactAccuracy": (
            round(confident_exact / confident_duration, 6) if confident_duration > 0 else None
        ),
        "uncertainTimeSec": round(uncertain_duration, 6),
        "boundaryExactF1": _boundary_f1(boundary_exact_counts),
        "boundaryTriadF1": _boundary_f1(boundary_triad_counts),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate chord results against .lab annotations")
    parser.add_argument("--manifest", required=True, help="Evaluation manifest JSON")
    parser.add_argument("--out", default=None, help="Optional JSON report output path")
    parser.add_argument("--tolerance", type=float, default=0.25, help="Boundary tolerance in seconds")
    args = parser.parse_args(argv)
    report = evaluate_manifest(args.manifest, args.out, args.tolerance)
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
