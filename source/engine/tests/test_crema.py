"""CREMA stays opt-in, and its labels stay distinct from template scores."""

from __future__ import annotations

import logging
import os
import sys
import tempfile
from pathlib import Path
from threading import Event
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from chord_engine import crema
from chord_engine.constants import HOP_LENGTH, SR
from chord_engine.crema import NO_CHORD


def test_registry_keeps_template_viterbi_as_default():
    registry = crema.detector_registry()
    assert registry["default"] == "template"
    assert registry["template"]["decoder"] == "viterbi"
    assert registry[crema.DETECTOR]["default"] is False
    assert registry[crema.DETECTOR]["decoder"] == crema.DECODER
    assert crema.DECODER != "viterbi"
    assert crema.SCORE_KIND not in {"template_similarity", "probability"}


def test_flag_is_off_unless_a_windows_source_process_sets_it():
    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop(crema.FLAG, None)
        assert crema.requested_directory() is None
    with tempfile.TemporaryDirectory() as directory:
        with patch.dict(os.environ, {crema.FLAG: directory}):
            assert crema.requested_directory() == Path(directory).resolve()
            with patch.object(crema.sys, "frozen", True, create=True):
                assert crema.requested_directory() is None


def test_frame_grid_matches_the_22050_pipeline():
    assert crema.HOP * SR == crema.RATE * HOP_LENGTH
    samples = SR * 3 + 100
    frames = crema.pipeline_frames(samples)
    assert frames == samples // HOP_LENGTH
    for index in range(frames):
        assert index * HOP_LENGTH / SR == index * crema.HOP / crema.RATE


def test_energy_gate_precedes_model_inference_and_keeps_its_score_kind():
    class Session:
        def run(self, *_args, **_kwargs):
            raise AssertionError("silence reached the model")

    state = {"decoder": {"labels": ["N", "C:maj"]}}
    samples = np.zeros(SR, np.float32)
    with patch.object(crema, "_runtime", return_value=(Session(), state)):
        raw, display, _timings = crema.recognize(
            Path("."), samples, SR, 1.0, np.array([True, True]), Event()
        )
    assert [(row.label, row.kind, row.scoreKind) for row in raw] == [
        (NO_CHORD, "no_chord", "energy_gate")
    ]
    assert display[0].scoreKind == "energy_gate"

    bass = np.ones((2, 12), np.float32)
    timeline = crema._timeline(np.array([1, 1]), np.array([False, True]), bass, ["N", "C:maj"], 2 * crema.HOP / crema.RATE)
    assert timeline[0].score is None and timeline[0].scoreKind == crema.SCORE_KIND
    assert timeline[0].label == "C:maj"
    assert timeline[1].label == NO_CHORD and timeline[1].scoreKind == "energy_gate"


def test_relative_rms_mask_does_not_override_crema_on_sounding_audio():
    frames = crema.pipeline_frames(SR)

    class Session:
        called = False

        def run(self, _names, feeds):
            Session.called = True
            count = feeds["cqt_mag"].shape[1]
            tag = np.full((1, count, 170), 1e-6, np.float32)
            tag[..., 1] = 1.0
            return (
                tag,
                np.zeros((1, count, 12), np.float32),
                np.zeros((1, count, 13), np.float32),
                np.zeros((1, count, 13), np.float32),
            )

    labels = ["N"] + ["C:maj"] * 169
    state = {
        "decoder": {
            "labels": labels,
            "transition": {"diagonal": 0.9, "off_diagonal": (1 - 0.9) / 169},
        },
        "preprocessing": {},
    }
    samples = np.full(SR, 0.2, np.float32)
    with patch.object(crema, "_runtime", return_value=(Session(), state)), \
         patch.object(crema, "_features", return_value=np.zeros((1, frames, 216, 2), np.float32)):
        _raw, display, _timings = crema.recognize(
            Path("."), samples, SR, 1.0, np.ones(frames + 1, dtype=bool), Event()
        )
    assert Session.called
    assert display
    assert all(row.scoreKind == crema.SCORE_KIND for row in display)
    assert any(row.label == "C:maj" for row in display)


def test_failed_crema_does_not_substitute_template_chords():
    from chord_engine.analyze import analyze_file

    logging.getLogger("chord_engine.analyze").setLevel(logging.CRITICAL)

    with tempfile.TemporaryDirectory() as directory:
        with patch.dict(os.environ, {crema.FLAG: directory}), \
             patch("chord_engine.analyze.decode_audio", return_value=(np.zeros(SR, np.float32), SR, 1.0, None)), \
             patch("chord_engine.analyze.extract_features", return_value=(
                 np.zeros((2, 12), np.float32), np.zeros((2, 12), np.float32), np.ones(2, np.float32)
             )), \
             patch("chord_engine.analyze.estimate_key", return_value=object()), \
             patch("chord_engine.analyze.crema.recognize", side_effect=RuntimeError("missing weights")):
            result = analyze_file("unused.wav")
    assert result["ok"] is False
    assert result["errorCode"] == "CREMA_FAILED"
    assert "chords" not in result


if __name__ == "__main__":
    test_registry_keeps_template_viterbi_as_default()
    test_flag_is_off_unless_a_windows_source_process_sets_it()
    test_frame_grid_matches_the_22050_pipeline()
    test_energy_gate_precedes_model_inference_and_keeps_its_score_kind()
    test_relative_rms_mask_does_not_override_crema_on_sounding_audio()
    test_failed_crema_does_not_substitute_template_chords()
    print("all CREMA tests passed")
