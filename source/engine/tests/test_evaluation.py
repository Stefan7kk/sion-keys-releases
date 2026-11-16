"""Synthetic tests for the chord evaluation harness."""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

from evaluate_chords import (  # noqa: E402
    NO_CHORD,
    Segment,
    evaluate_manifest,
    evaluate_pair,
    load_lab,
    normalize_label,
)


def _seg(start: float, end: float, label: str, kind: str = "chord") -> Segment:
    return Segment(start=start, end=end, label=label, kind=kind)


def test_normalize_label():
    assert normalize_label("C") == "C:maj"
    assert normalize_label("Cm") == "C:min"
    assert normalize_label("C:maj7") == "C:maj7"
    assert normalize_label("Cm7") == "C:min7"
    assert normalize_label("C7") == "C:7"
    assert normalize_label("Db") == "C#:maj"
    assert normalize_label("Bbmin7") == "A#:min7"
    assert normalize_label("N.C.") == NO_CHORD
    assert normalize_label("N") == NO_CHORD
    assert normalize_label("A:min/b7") == "A:min"
    assert normalize_label("E:min/b3") == "E:min"
    assert normalize_label("F:maj6/5") == "F:maj6"
    assert normalize_label("C/7") == "C:maj"


def test_exact_root_and_triad_accuracy():
    ground_truth = [
        _seg(0.0, 1.0, "C:maj", "ground_truth"),
        _seg(1.0, 2.0, "G:maj", "ground_truth"),
    ]
    predicted = [
        _seg(0.0, 0.8, "C:maj", "chord"),
        _seg(0.8, 1.0, "C:maj", "uncertain"),
        _seg(1.0, 2.0, "G:maj", "chord"),
    ]
    metrics = evaluate_pair(predicted, ground_truth, duration=2.0, tolerance=0.25)
    assert metrics["exactAccuracy"] == 1.0
    assert metrics["rootAccuracy"] == 1.0
    assert metrics["triadAccuracy"] == 1.0
    assert metrics["strictExactAccuracy"] == 0.9
    assert metrics["strictRootAccuracy"] == 0.9
    assert metrics["strictTriadAccuracy"] == 0.9
    assert metrics["confidentTimeSec"] == 1.8
    assert metrics["confidentExactAccuracy"] == 1.0
    assert metrics["uncertainTimeSec"] == 0.2
    assert metrics["boundaryExact"]["truePositive"] == 1
    assert metrics["boundaryExact"]["falsePositive"] == 0
    assert metrics["boundaryExact"]["falseNegative"] == 0
    assert metrics["boundaryTriad"]["truePositive"] == 1


def test_seventh_chords_reduce_to_triad_family():
    ground_truth = [
        _seg(0.0, 1.0, "C:maj", "ground_truth"),
        _seg(1.0, 2.0, "A:min", "ground_truth"),
        _seg(2.0, 3.0, "F:maj", "ground_truth"),
    ]
    predicted = [
        _seg(0.0, 1.0, "C:maj7", "chord"),
        _seg(1.0, 2.0, "A:min7", "chord"),
        _seg(2.0, 3.0, "F:maj6", "chord"),
    ]
    metrics = evaluate_pair(predicted, ground_truth, duration=3.0, tolerance=0.25)
    assert metrics["exactAccuracy"] == 0.0
    assert metrics["rootAccuracy"] == 1.0
    assert metrics["triadAccuracy"] == 1.0


def test_silence_and_uncertain_confusion():
    ground_truth = [
        _seg(0.0, 0.5, NO_CHORD, "ground_truth"),
        _seg(0.5, 1.5, "C:maj", "ground_truth"),
    ]
    predicted = [
        _seg(0.0, 0.5, NO_CHORD, "no_chord"),
        _seg(0.5, 1.0, "C:maj", "uncertain"),
        _seg(1.0, 1.5, "C:maj", "chord"),
    ]
    metrics = evaluate_pair(predicted, ground_truth, duration=1.5, tolerance=0.25)
    assert metrics["exactAccuracy"] == 1.0
    assert metrics["strictExactAccuracy"] == round(1.0 / 1.5, 6)
    assert metrics["confusion"]["groundTruthNoChord"]["predictedNoChordSec"] == 0.5
    assert metrics["confusion"]["groundTruthNoChord"]["predictedUncertainSec"] == 0.0
    assert metrics["confusion"]["groundTruthNoChord"]["predictedChordSec"] == 0.0
    assert metrics["confusion"]["groundTruthChord"]["predictedUncertainSec"] == 0.5
    assert metrics["confusion"]["groundTruthChord"]["predictedChordSec"] == 0.5


def test_boundary_tolerance_matching():
    ground_truth = [
        _seg(0.0, 1.0, "C:maj", "ground_truth"),
        _seg(1.0, 2.0, "G:maj", "ground_truth"),
        _seg(2.0, 3.0, "C:maj", "ground_truth"),
    ]
    predicted = [
        _seg(0.0, 1.1, "C:maj", "chord"),
        _seg(1.1, 2.2, "G:maj", "chord"),
        _seg(2.2, 3.0, "C:maj", "chord"),
    ]
    metrics = evaluate_pair(predicted, ground_truth, duration=3.0, tolerance=0.25)
    assert metrics["boundaryExact"]["truePositive"] == 2
    assert metrics["boundaryExact"]["falsePositive"] == 0
    assert metrics["boundaryExact"]["falseNegative"] == 0

    late = [
        _seg(0.0, 1.4, "C:maj", "chord"),
        _seg(1.4, 2.4, "G:maj", "chord"),
        _seg(2.4, 3.0, "C:maj", "chord"),
    ]
    late_metrics = evaluate_pair(late, ground_truth, duration=3.0, tolerance=0.25)
    assert late_metrics["boundaryExact"]["truePositive"] == 0
    assert late_metrics["boundaryExact"]["falsePositive"] == 2
    assert late_metrics["boundaryExact"]["falseNegative"] == 2


def test_lab_loader_and_manifest_evaluation():
    with tempfile.TemporaryDirectory(prefix="chord_eval_test_") as temp_dir:
        root = Path(temp_dir)
        lab_path = root / "song.lab"
        lab_path.write_text(
            "0.0 1.0 C\n1.0 2.0 G\n2.0 3.0 N.C.\n",
            encoding="utf-8",
        )
        loaded = load_lab(lab_path)
        assert [segment.label for segment in loaded] == ["C:maj", "G:maj", NO_CHORD]

        result_path = root / "song-result.json"
        result_payload = {
            "ok": True,
            "source": {"durationSec": 3.0},
            "chords": [
                {"start": 0.0, "end": 1.0, "label": "C:maj", "kind": "chord"},
                {"start": 1.0, "end": 2.0, "label": "G:maj", "kind": "chord"},
                {"start": 2.0, "end": 3.0, "label": "N.C.", "kind": "no_chord"},
            ],
            "meta": {"engineVersion": "test", "timings": {"detectSec": 0.1}},
        }
        result_path.write_text(json.dumps(result_payload), encoding="utf-8")

        manifest_path = root / "manifest.json"
        manifest_payload = {
            "toleranceSec": 0.25,
            "songs": [
                {
                    "id": "synthetic-song",
                    "split": "dev",
                    "result": "song-result.json",
                    "lab": "song.lab",
                },
                {
                    "id": "pending-song",
                    "split": "holdout",
                    "result": "song-result.json",
                    "lab": None,
                },
            ],
        }
        manifest_path.write_text(json.dumps(manifest_payload), encoding="utf-8")

        report = evaluate_manifest(manifest_path, root / "report.json")
        assert report["ok"] is True
        assert len(report["songs"]) == 1
        assert report["songs"][0]["id"] == "synthetic-song"
        assert report["songs"][0]["metrics"]["exactAccuracy"] == 1.0
        assert report["songs"][0]["metrics"]["strictExactAccuracy"] == 1.0
        assert report["aggregate"]["songs"] == 1
        assert report["aggregate"]["exactAccuracy"] == 1.0
        assert len(report["pending"]) == 1
        assert report["pending"][0]["id"] == "pending-song"
        assert report["pending"][0]["reason"] == "annotation pending"
        assert (root / "report.json").is_file()


if __name__ == "__main__":
    test_normalize_label()
    test_exact_root_and_triad_accuracy()
    test_seventh_chords_reduce_to_triad_family()
    test_silence_and_uncertain_confusion()
    test_boundary_tolerance_matching()
    test_lab_loader_and_manifest_evaluation()
    print("all evaluation tests passed")
