"""Chroma + RMS from decoded mono float audio (no file decode here)."""

from __future__ import annotations

import logging
import time
from typing import Any, Callable

import numpy as np

from .constants import HOP_LENGTH, SR
from .rhythm import estimate_audio_meter

logger = logging.getLogger(__name__)


def _median_31(spectrum: np.ndarray, axis: int, move_median) -> np.ndarray:
    """Match SciPy's centered 31-bin median with reflected edge samples."""
    rows = np.moveaxis(spectrum, axis, -1)
    output = np.empty_like(spectrum)
    target = np.moveaxis(output, axis, -1)
    # Bound the rolling-median scratch space for long recordings.
    block_rows = max(1, min(128, 262_144 // (rows.shape[-1] + 30)))
    for start in range(0, len(rows), block_rows):
        block = rows[start:start + block_rows]
        padded = np.pad(block, ((0, 0), (15, 15)), mode="symmetric")
        target[start:start + block_rows] = move_median(
            np.ascontiguousarray(padded), window=31
        )[:, 30:]
    return output


def _harmonic_audio(y: np.ndarray) -> np.ndarray:
    """Reproduce librosa's default harmonic isolation with a rolling median."""
    import librosa

    try:
        from bottleneck import move_median
    except ImportError:
        return librosa.effects.harmonic(y)

    magnitude, phase = librosa.magphase(librosa.stft(y))
    harmonic = _median_31(magnitude, axis=1, move_median=move_median)
    percussive = _median_31(magnitude, axis=0, move_median=move_median)
    mask = librosa.util.softmask(harmonic, percussive, power=2, split_zeros=True)
    return librosa.istft((magnitude * mask) * phase, dtype=y.dtype, n_fft=2048, length=y.size)


def extract_features(
    y: np.ndarray,
    sr: int = SR,
    hop_length: int = HOP_LENGTH,
    rhythm: dict[str, Any] | None = None,
    cancelled: Callable[[], bool] = lambda: False,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Returns:
      chroma: (n_frames, 12) L2-normalized log-compressed CQT chroma
      bass: (n_frames, 12) low-octave chroma (C2..B3 only), used to locate
        the bass note for near-tie decisions; same per-frame normalization
      rms: (n_frames,) energy envelope aligned to chroma frames
    """
    import librosa

    if y.size == 0:
        empty = np.zeros((0, 12), dtype=np.float32)
        return empty, empty, np.zeros((0,), dtype=np.float32)

    # Tuning estimate (fail soft). Cap length so first analysis of long files
    # does not spend the whole feature stage on a full-file pitch search.
    try:
        tune_n = min(int(y.size), int(sr * 30))
        tuning = float(librosa.estimate_tuning(y=y[:tune_n], sr=sr))
    except Exception:
        tuning = 0.0

    fmin = librosa.note_to_hz("C2")
    n_octaves = 4
    bins_per_octave = 36

    # Reflect-pad the edges (a whole number of hop frames) so the median filter
    # and the first/last CQT windows see real signal context instead of silence.
    # Without this, the onset frame reads as a smeared broadband blob. The pad
    # frames are sliced off afterwards; frame 0 still belongs to sample 0.
    pad = 12 * hop_length
    padded = np.pad(y, (pad, pad), mode="reflect")
    n_frames = 1 + int(y.size // hop_length)

    # Separate the sustained harmonic content from percussive transients and
    # broadband noise before reading pitch. Full-mix chroma lets melody notes and
    # drum hits dominate individual frames, which the chord decoder then reads as
    # spurious chord changes. The harmonic component reflects the accompaniment.
    try:
        harmonic = _harmonic_audio(padded)
    except Exception:
        harmonic = padded

    cqt = np.abs(
        librosa.cqt(
            harmonic,
            sr=sr,
            hop_length=hop_length,
            fmin=fmin,
            n_bins=n_octaves * bins_per_octave,
            bins_per_octave=bins_per_octave,
            tuning=tuning,
        )
    )
    # Align to the original grid: frame 0 of y sits at padded frame index
    # pad // hop_length (each CQT frame is centered at index * hop_length).
    cqt = cqt[:, pad // hop_length : pad // hop_length + n_frames]
    if cqt.shape[1] < n_frames:
        missing = n_frames - cqt.shape[1]
        cqt = np.pad(cqt, ((0, 0), (0, missing)), mode="edge")
    # Fold to pitch classes with librosa's leakage-aware mapping (each class is
    # centered one third-bin below the nominal semitone, where CQT side energy
    # of a pure tone actually lands). Bass emphasis first: chord roots sit in
    # the lowest octaves, which are far less crowded than the upper ones.
    mapping = librosa.filters.cq_to_chroma(
        cqt.shape[0], bins_per_octave=bins_per_octave, n_chroma=12, fmin=fmin
    )
    bin_octave = np.arange(cqt.shape[0]) // bins_per_octave
    weights = np.power(1.4, (n_octaves - 1 - bin_octave)).astype(cqt.dtype)
    chroma = mapping @ (cqt * weights[:, None])

    # Bass chroma: only the lowest 2 octaves (C2..B3), before octave weighting,
    # so the dominant low-register pitch class stays visible for near-tie
    # decisions in the chord decoder.
    low = cqt[: 2 * bins_per_octave]
    low_map = librosa.filters.cq_to_chroma(
        low.shape[0], bins_per_octave=bins_per_octave, n_chroma=12, fmin=fmin
    )
    bass = low_map @ low

    meter_chroma, meter_bass = chroma.T, bass.T
    beats = np.empty(0, dtype=int)

    # Beat-synchronous hold: average each pitch class inside every beat, so a
    # passing melody note cannot flip a single frame. Falls back to the raw
    # frame grid when beat tracking is unreliable (e.g. synthetic tones).
    try:
        _tempo, beats = librosa.beat.beat_track(y=y, sr=sr, hop_length=hop_length, trim=False)
        beats = np.unique(np.clip(beats.astype(int), 0, chroma.shape[1]))
        if len(beats) > 1:
            intervals = np.diff(beats)
            max_beat_frames = int(round(1.5 / (hop_length / float(sr))))
            if rhythm is not None:
                median_interval = float(np.median(intervals))
                tolerance = max(1, median_interval * 0.15)
                if len(beats) >= 8 and float(np.median(intervals)) <= max_beat_frames:
                    if np.mean(np.abs(intervals - median_interval) <= tolerance) >= 0.8:
                        bpm = 60 * sr / (hop_length * float(np.mean(intervals)))
                        if 35 <= bpm <= 240:
                            rhythm["tempoBpm"] = round(bpm, 1)
                bc = np.empty_like(chroma)
                bb = np.empty_like(bass)
                edges = np.concatenate(([0], beats, [chroma.shape[1]]))
                for a, b in zip(edges[:-1], edges[1:]):
                    if b > a:
                        # Median, not mean: a passing melody note affects only
                        # half the frames, so the mean dilutes chord tones while
                        # the median keeps the classes active all beat long.
                        bc[:, a:b] = np.median(chroma[:, a:b], axis=1, keepdims=True)
                        bb[:, a:b] = np.median(bass[:, a:b], axis=1, keepdims=True)
                # Keep some frame-level evidence for changes inside a beat.
                chroma = 0.65 * bc + 0.35 * chroma
                bass = 0.65 * bb + 0.35 * bass
    except Exception:
        pass

    if rhythm is not None and not cancelled():
        meter_start = time.perf_counter()
        try:
            rhythm.update(estimate_audio_meter(y, sr, meter_chroma, meter_bass, hop_length, cancelled, beats))
        except Exception:
            logger.warning("Meter estimation failed; leaving time signature unset.", exc_info=True)
        rhythm["meterSec"] = round(time.perf_counter() - meter_start, 3)

    # Per-frame max normalization, same as librosa's chroma_cqt, keeps CQT
    # side-lobe leakage from competing with true pitch-class energy.
    chroma = librosa.util.normalize(chroma, norm=np.inf, axis=-2)
    chroma = np.log1p(5.0 * chroma)
    chroma = chroma / (np.linalg.norm(chroma, axis=0, keepdims=True) + 1e-8)
    chroma = chroma.T.astype(np.float32)
    bass = bass.T.astype(np.float32)
    rms = librosa.feature.rms(y=padded, hop_length=hop_length)[0].astype(np.float32)
    rms = rms[pad // hop_length : pad // hop_length + n_frames]
    if len(rms) < n_frames:
        rms = np.pad(rms, (0, n_frames - len(rms)), mode="edge")
    else:
        rms = rms[:n_frames]
    n = chroma.shape[0]
    if len(rms) < n:
        rms = np.pad(rms, (0, n - len(rms)), mode="edge")
    else:
        rms = rms[:n]
    return chroma, bass, rms


def waveform_peaks(y: np.ndarray, buckets: int = 800) -> list[float]:
    """Downsample abs peaks for UI waveform (0..1)."""
    if y.size == 0 or buckets <= 0:
        return []
    y = np.asarray(y, dtype=np.float32)
    n = len(y)
    edges = np.linspace(0, n, buckets + 1, dtype=int)
    peaks = np.zeros(buckets, dtype=np.float32)
    for i in range(buckets):
        a, b = edges[i], edges[i + 1]
        if b <= a:
            continue
        peaks[i] = float(np.max(np.abs(y[a:b])))
    mx = float(peaks.max()) if peaks.size else 0.0
    if mx > 1e-8:
        peaks = peaks / mx
    return peaks.tolist()


