"""Local CREMA ONNX experiment. Model files and ONNX Runtime are external."""

from __future__ import annotations

from functools import lru_cache
import hashlib
from importlib import import_module
import json
import math
import os
from pathlib import Path
import sys
import time

import numpy as np

from .chords import ChordSegment
from .constants import HOP_LENGTH, NO_CHORD, SR

FLAG = "HEARTHKEYS_DEV_CREMA_DIR"
DETECTOR = "crema_onnx"
DECODER = "crema_viterbi"
SCORE_KIND = "crema_onnx_label"
RATE = 44100
HOP = 4096
OUTPUT_NAMES = ("Identity:0", "Identity_1:0", "Identity_2:0", "Identity_3:0")
MODEL_FILES = {
    "crema-0.2.0-opset18.onnx": "a903f9709821fccebb31d4e93d7d783642faaa90859f45f308c0f9131cc7ca59",
    "crema-0.2.0-runtime-state.json": "3744bf9ecb47de7194cb9f250fba26678ea347911af32ec4813645d5e033aca2",
}
ROOTS = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
QUALITIES = {
    "7": (0, 4, 7, 10), "aug": (0, 4, 8), "dim": (0, 3, 6),
    "dim7": (0, 3, 6, 9), "hdim7": (0, 3, 6, 10),
    "maj": (0, 4, 7), "maj6": (0, 4, 7, 9), "maj7": (0, 4, 7, 11),
    "min": (0, 3, 7), "min6": (0, 3, 7, 9), "min7": (0, 3, 7, 10),
    "minmaj7": (0, 3, 7, 11), "sus2": (0, 2, 7), "sus4": (0, 5, 7),
}
DEGREES = ("1", "b2", "2", "b3", "3", "4", "b5", "5", "b6", "6", "b7", "7")


def requested_directory() -> Path | None:
    if sys.platform != "win32" or getattr(sys, "frozen", False):
        return None
    directory = os.environ.get(FLAG)
    return Path(directory).resolve() if directory else None


def detector_registry() -> dict:
    return {
        "default": "template",
        "template": {"decoder": "viterbi"},
        "chordformer": {"scope": "existing_local_research"},
        DETECTOR: {"scope": "windows_source_only", "decoder": DECODER, "default": False},
    }


@lru_cache(maxsize=1)
def _runtime(directory: Path):
    model_path, state_path = (directory / name for name in MODEL_FILES)
    for path in (model_path, state_path):
        with path.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != MODEL_FILES[path.name]:
                raise ValueError("CREMA artifact SHA-256 mismatch")
    state = json.loads(state_path.read_text(encoding="utf-8"))
    ort = import_module("onnxruntime")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.use_deterministic_compute = True
    ort.disable_telemetry_events()
    session = ort.InferenceSession(str(model_path), options, providers=["CPUExecutionProvider"])
    if [value.name for value in session.get_inputs()] != ["cqt_mag"]:
        raise ValueError("Unexpected CREMA input schema")
    if [value.name for value in session.get_outputs()] != list(OUTPUT_NAMES):
        raise ValueError("Unexpected CREMA output schema")
    return session, state


def pipeline_frames(n_samples: int) -> int:
    """Left-aligned frame count on the shared 22050 Hz, 2048-sample grid."""
    return max(1, int(n_samples) // HOP_LENGTH)


def _features(samples, sr, spec, stop, frames):
    import librosa

    if sr != RATE:
        samples = librosa.resample(samples, orig_sr=sr, target_sr=RATE)
    channels = []
    for harmonic in spec["harmonics"]:
        if stop.is_set():
            return None
        cqt = librosa.cqt(samples, sr=RATE, hop_length=HOP,
                          fmin=spec["fmin"] * harmonic, n_bins=216, bins_per_octave=36)
        magnitude = np.abs(librosa.util.fix_length(cqt, size=frames, axis=-1))
        channels.append(librosa.amplitude_to_db(magnitude, ref=np.max))
    return np.ascontiguousarray(np.stack(channels, axis=-1).transpose(1, 0, 2)[None], dtype=np.float32)


def _decode(log_scores, diagonal, off_diagonal):
    """Use CREMA's uniform transition matrix once, with stable index ties."""
    n_frames, n_labels = log_scores.shape
    stay, change = math.log(diagonal), math.log(off_diagonal)
    previous = log_scores[0].copy()
    labels = np.arange(n_labels)
    pointers = np.zeros((n_frames, n_labels), dtype=np.int16)
    for frame in range(1, n_frames):
        best = int(np.argmax(previous))
        second = int(np.argmax(np.where(labels == best, -np.inf, previous)))
        other = np.where(labels == best, second, best)
        a, b = previous + stay, previous[other] + change
        keep = (a > b) | ((a == b) & (labels < other))
        pointers[frame] = np.where(keep, labels, other)
        previous = log_scores[frame] + np.where(keep, a, b)
    path = np.empty(n_frames, dtype=np.int16)
    path[-1] = np.argmax(previous)
    for frame in range(n_frames - 1, 0, -1):
        path[frame - 1] = pointers[frame, path[frame]]
    return path


def _timeline(path, gated, bass, labels, duration):
    changes = np.flatnonzero((path[1:] != path[:-1]) | (gated[1:] != gated[:-1])) + 1
    edges = np.r_[0, changes, len(path)]
    tiny = np.finfo(np.float32).tiny
    result = []
    for left, right in zip(edges[:-1], edges[1:], strict=True):
        start = min(duration, round(int(left) * HOP / RATE, 4))
        end = duration if right == len(path) else min(duration, round(int(right) * HOP / RATE, 4))
        if end <= start:
            continue
        if gated[left]:
            result.append(ChordSegment(start, end, NO_CHORD, 1.0, "energy_gate", "no_chord"))
            continue
        label = labels[path[left]]
        kind = {"N": "no_chord", "X": "uncertain"}.get(label, "chord")
        if kind == "chord":
            root, quality = label.split(":", 1)
            bass_note = int(np.argmax(np.log(np.maximum(bass[left:right], tiny)).mean(axis=0)))
            relative = (bass_note - ROOTS.index(root)) % 12
            if bass_note < 12 and relative and relative in QUALITIES[quality]:
                label = f"{label}/{DEGREES[relative]}"
        result.append(ChordSegment(start, end, label if kind == "chord" else NO_CHORD,
                                   None, SCORE_KIND, kind))
    return result


def _digital_silence(samples, frames):
    """True only where a frame's samples are numerically silent.

    The template recognizer's relative RMS gate is intentionally not used.
    On the development recordings it replaced CREMA's trained N decisions.
    """
    usable = frames * HOP_LENGTH
    audio = np.zeros(usable, dtype=np.float32)
    copied = min(len(samples), usable)
    if copied:
        audio[:copied] = np.asarray(samples[:copied], dtype=np.float32)
    if frames == 0:
        return np.zeros(0, dtype=bool)
    peaks = np.max(np.abs(audio.reshape(frames, HOP_LENGTH)), axis=1)
    return peaks <= np.float32(1e-8)


def recognize(directory, samples, sr, duration, silent, stop, on_progress=None):
    started = time.perf_counter()
    session, state = _runtime(directory)
    initialized = time.perf_counter()
    del silent  # Template RMS mask. CREMA keeps its own N predictions.
    frames = pipeline_frames(len(samples))
    gated = _digital_silence(samples, frames)
    if frames == 0 or bool(gated.all()):
        segment = ChordSegment(0.0, duration, NO_CHORD, 1.0, "energy_gate", "no_chord")
        return [segment], [segment], {"modelInitSec": round(initialized - started, 3)}
    features = _features(samples, sr, state["preprocessing"], stop, frames)
    if features is None or stop.is_set():
        return None
    prepared = time.perf_counter()
    if on_progress:
        on_progress("crema-infer", 80, "Running CREMA ONNX inference")
    if stop.is_set():
        return None
    outputs = session.run(list(OUTPUT_NAMES), {"cqt_mag": features})
    inferred = time.perf_counter()
    if stop.is_set():
        return None
    if features.shape[1] != frames:
        raise ValueError("CREMA frame grid drifted from the 22050 Hz pipeline")
    if [value.shape for value in outputs] != [(1, frames, n) for n in (170, 12, 13, 13)]:
        raise ValueError("Unexpected CREMA output shape")
    tag, _, _, bass = (value[0] for value in outputs)
    if not np.isfinite(tag).all() or not np.isfinite(bass).all():
        raise ValueError("Non-finite CREMA outputs")
    labels = state["decoder"]["labels"]
    if HOP * SR != HOP_LENGTH * RATE:
        raise ValueError("CREMA hop does not match the 22050 Hz pipeline")
    if stop.is_set():
        return None
    log_scores = np.log(np.maximum(tag, np.finfo(np.float32).tiny)).astype(np.float64)
    log_scores[gated] = -np.inf
    log_scores[gated, labels.index("N")] = 0
    transition = state["decoder"]["transition"]
    raw = _timeline(log_scores.argmax(axis=1), gated, bass, labels, duration)
    display = _timeline(_decode(log_scores, transition["diagonal"], transition["off_diagonal"]),
                        gated, bass, labels, duration)
    return raw, display, {
        "modelInitSec": round(initialized - started, 3),
        "modelFeaturesSec": round(prepared - initialized, 3),
        "modelInferenceSec": round(inferred - prepared, 3),
    }
