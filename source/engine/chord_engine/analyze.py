"""End-to-end analysis: decode → features → key + chords → JSON contract."""

from __future__ import annotations

import logging
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from typing import Any

from .accompaniment import instrumental_audio, refine_boundaries, splitter_runtime
from . import crema
from .chords import detect_chords, display_label, silence_threshold
from .constants import HOP_LENGTH, SR
from .decode import DecodeError, decode_audio, probe_duration
from .features import extract_features, waveform_peaks
from .key import estimate_key
from .model import recognize_local_model
from .result_cache import cache_entry, load_result, save_result


logger = logging.getLogger(__name__)


def analyze_file(
    path: str | Path,
    cancel_event=None,
    source_name: str | None = None,
    decoder: str = "viterbi",
    on_progress=None,
) -> dict[str, Any]:
    """
    Analyze a local audio file. Raises on failure — never returns mock chords.
    """
    from .procutil import cancel_event as global_cancel

    path = Path(path)
    t0 = time.perf_counter()
    ev = cancel_event if cancel_event is not None else global_cancel()
    try:
        duration_hint = probe_duration(path) or 0.0
    except Exception:
        duration_hint = 0.0
    crema_dir = crema.requested_directory() if decoder == "viterbi" else None
    stop_model = Event()
    rhythm: dict[str, Any] = {}

    def report_pass(count):
        if on_progress and not ev.is_set():
            on_progress("chords", 40 + count * 9, f"Chord model · {count} of 5 passes complete")

    # The chord model reads the source file itself, so it starts while the
    # same file is decoded for the key and the template comparison.
    with ThreadPoolExecutor(max_workers=1) as pool:
        model_job = (
            pool.submit(recognize_local_model, path, duration_hint or 900, stop_model, report_pass)
            if decoder == "viterbi" and crema_dir is None else None
        )
        try:
            try:
                t_decode = time.perf_counter()
                samples, sr, duration, _wav = decode_audio(
                    path, sr=SR, keep_wav=False, cancel_event=ev
                )
                decode_sec = time.perf_counter() - t_decode
            except DecodeError:
                raise
            except Exception as exc:
                raise DecodeError(str(exc)) from exc
            if ev is not None and ev.is_set():
                return {"ok": False, "error": "cancelled", "errorCode": "CANCELLED"}
            if on_progress:
                on_progress("features", 25, "Reading harmony and preparing chord model")
            t_parallel = time.perf_counter()
            t_features = time.perf_counter()
            chroma, bass, rms = extract_features(samples, sr=sr, hop_length=HOP_LENGTH, rhythm=rhythm,
                                                cancelled=ev.is_set)
            key = estimate_key(chroma)
            features_sec = time.perf_counter() - t_features
            while model_job is not None and not model_job.done() and not ev.is_set():
                ev.wait(0.15)
        finally:
            stop_model.set()
    model_chords = model_job.result() if model_job is not None and not ev.is_set() else None
    parallel_sec = time.perf_counter() - t_parallel
    if ev.is_set():
        return {"ok": False, "error": "cancelled", "errorCode": "CANCELLED"}
    shifts = []
    if model_chords and 5 <= duration <= 900 and splitter_runtime() is not None:
        if on_progress:
            on_progress("chords", 87, "Checking chord timing against accompaniment")
        try:
            with instrumental_audio(path, duration, ev) as stem:
                if stem is not None:
                    separated = recognize_local_model(stem, duration, ev)
                    if separated:
                        model_chords, shifts = refine_boundaries(model_chords, separated)
        except OSError:
            pass
    if ev.is_set():
        return {"ok": False, "error": "cancelled", "errorCode": "CANCELLED"}
    crema_result = None
    if crema_dir is not None:
        if on_progress:
            on_progress("chords", 65, "Running local CREMA experiment")
        try:
            # The RMS mask is passed through and ignored. CREMA gates only digital silence.
            crema_result = crema.recognize(crema_dir, samples, sr, duration,
                                           rms < silence_threshold(rms), ev, on_progress=on_progress)
        except Exception as exc:
            logger.warning("Local CREMA experiment failed.", exc_info=True)
            return {
                "ok": False,
                "error": "CREMA experiment failed",
                "errorCode": "CREMA_FAILED",
                "detail": str(exc),
            }
        if crema_result is None or ev.is_set():
            return {"ok": False, "error": "cancelled", "errorCode": "CANCELLED"}
    if ev.is_set():
        return {"ok": False, "error": "cancelled", "errorCode": "CANCELLED"}
    if on_progress:
        on_progress("finalize", 94, "Finalizing chord timeline")
    t_detect = time.perf_counter()
    # An uncertain key must not pull chord labels. The tie-break never changes
    # the reported template similarity into a confidence.
    guide_tonic = None if key.uncertain else key.tonic
    guide_mode = None if key.uncertain else key.mode
    crema_timings = {}
    if crema_result is not None:
        raw, merged, crema_timings = crema_result
    else:
        merged, raw = detect_chords(
            chroma,
            rms,
            duration_sec=duration,
            sr=sr,
            hop=HOP_LENGTH,
            key_tonic=guide_tonic,
            key_mode=guide_mode,
            bass=bass,
            decoder=decoder,
        )
    if ev.is_set():
        return {"ok": False, "error": "cancelled", "errorCode": "CANCELLED"}
    if model_chords is not None and crema_result is None:
        merged = model_chords
    detect_sec = time.perf_counter() - t_detect

    def pack(seg):
        d = seg.to_dict()
        d["display"] = display_label(seg.label)
        return d

    elapsed = time.perf_counter() - t0
    return {
        "ok": True,
        "engineVersion": "0.1.0",
        "source": {
            "path": str(path),
            "name": source_name or path.name,
            "durationSec": round(duration, 4),
            "sampleRate": sr,
        },
        "key": key.to_dict(),
        "chords": [pack(s) for s in merged],
        "rawChords": [pack(s) for s in raw],
        "waveform": waveform_peaks(samples, buckets=min(1200, max(200, int(duration * 10)))),
        "meta": {
            "elapsedSec": round(elapsed, 3),
            "timings": {
                "decodeSec": round(decode_sec, 3),
                "featuresSec": round(features_sec, 3),
                "featuresAndModelSec": round(parallel_sec, 3),
                "detectSec": round(detect_sec, 3),
                **({"meterSec": rhythm.pop("meterSec")} if "meterSec" in rhythm else {}),
                **crema_timings,
            },
            "hopLength": HOP_LENGTH,
            **({"accompanimentBoundaryShifts": shifts} if shifts else {}),
            **rhythm,
            "detector": (crema.DETECTOR if crema_result is not None else
                         "chordformer" if model_chords is not None else "template"),
            "decoder": (crema.DECODER if crema_result is not None else
                        "chordformer" if model_chords is not None else decoder),
            "vocabulary": sorted({seg.label.partition(":")[2] or seg.label for seg in merged}),
            "scoreKinds": {
                "key": "profile_correlation",
                "chord": crema.SCORE_KIND if crema_result is not None else "template_similarity",
                "noChord": "energy_gate",
                **({"modelNoChord": crema.SCORE_KIND} if crema_result is not None else {}),
            },
            "notes": [
                "Key score is KK profile correlation, not P(correct).",
                "CREMA chord labels use scoreKind crema_onnx_label. That marker is not a probability and not template similarity.",
                "Raw chords are the energy-gated model argmax. Displayed chords use CREMA's own transition decoder.",
                "The shared RMS energy gate is applied before decoding. Its silence stays energy_gate N.C., separate from a model N label.",
            ] if crema_result is not None else [
                "Key score is KK profile correlation, not P(correct).",
                *(
                    ["Chords are decoded by ChordFormer. The model supplies labels without confidence scores; rawChords shows the template detector for comparison."]
                    if model_chords is not None else
                    ["Local ChordFormer was unavailable or bypassed. Chords use the template detector."]
                ),
                *(
                    ["Some display chord changes use a bounded timing cross-check against the local accompaniment track."]
                    if shifts else []
                ),
                "Chord score is template similarity, not probability.",
                ("Long uncertain holds can split where sustained candidate evidence is stronger. Those candidates remain uncertain." if decoder == "viterbi" else "Short uncertain flicker is smoothed in the display; rawChords retains the original observations."),
                "Near-tie frames (two templates within 0.05 similarity) are decided by a key prior and a bass-structure prior (root position > first inversion > second inversion); the stored score is always the raw template similarity of the chosen label.",
                "Seventh chords must win clearly over the plain triad reading of the same frame.",
                "rawChords are independent of the display decoder; displayed scores are still raw template similarity.",
                "Tempo uses detected beat spacing. Meter estimates use bass and harmonic motion, multiband attacks, subdivision and agreement across sections. A notated meter can remain ambiguous from audio alone.",
            ],
        },
    }


def analyze_to_json(path: str, source_name: str | None = None, decoder: str = "viterbi", on_progress=None) -> dict[str, Any]:
    try:
        from .procutil import cancel_event

        started = time.perf_counter()
        audio = Path(path)
        entry = None if crema.requested_directory() is not None else cache_entry(audio, decoder)
        cached = load_result(entry)
        if cancel_event().is_set():
            return {"ok": False, "error": "cancelled", "errorCode": "CANCELLED"}
        if cached is not None:
            if on_progress:
                on_progress("cache", 96, "Restoring full-quality chord analysis")
            cached["source"].update(path=str(audio), name=source_name or audio.name)
            elapsed = round(time.perf_counter() - started, 3)
            cached["meta"].update(elapsedSec=elapsed, timings={"cacheSec": elapsed}, cacheHit=True)
            return cached
        if on_progress:
            on_progress("decode", 15, "Decoding audio")
        result = analyze_file(path, source_name=source_name, decoder=decoder, on_progress=on_progress)
        if result.get("ok") and entry is not None and not cancel_event().is_set():
            # Avoid storing the result under an old key if the source changed during inference.
            if cache_entry(audio, decoder) == entry:
                save_result(entry, result)
        return result
    except DecodeError as exc:
        return {
            "ok": False,
            "error": str(exc),
            "errorCode": "DECODE_ERROR",
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": str(exc),
            "errorCode": "ENGINE_ERROR",
            "detail": traceback.format_exc()[-2000:],
        }
