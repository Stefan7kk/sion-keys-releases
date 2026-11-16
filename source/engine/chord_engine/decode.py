"""
FFmpeg-first decode to mono float32 PCM at SR.

All analysis, waveform, and playback timelines share this decoded stream.
Does not rely on librosa's internal decoder for production paths.
"""

from __future__ import annotations

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import wave
from dataclasses import dataclass
from pathlib import Path

from .constants import SR
from .procutil import kill_process_tree, popen_list, track_temp, untrack_temp


class DecodeError(RuntimeError):
    """Raised when FFmpeg cannot decode the input."""


@dataclass(frozen=True)
class DecodedAudio:
    """Mono float32 samples and metadata from a consistent decode path."""

    samples: list[float]
    sample_rate: int
    duration_sec: float
    channels_in: int
    path_pcm: Path | None
    source_path: str


def find_ffmpeg() -> tuple[str, str]:
    """
    Resolve ffmpeg and ffprobe binaries.

    Order:
      1. CHORD_FFMPEG_DIR env
      2. packaged layouts next to frozen exe / Tauri resources
      3. PATH
    """
    candidates: list[Path] = []
    env_dir = os.environ.get("CHORD_FFMPEG_DIR")
    if env_dir:
        candidates.append(Path(env_dir))

    here = Path(__file__).resolve()
    try:
        candidates.append(here.parents[2] / "resources" / "ffmpeg")
        candidates.append(here.parents[2] / "ffmpeg")
    except IndexError:
        pass

    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        candidates.extend(
            [
                exe_dir / "ffmpeg",
                exe_dir.parent / "ffmpeg",
                exe_dir.parent / "resources" / "ffmpeg",
                exe_dir / "resources" / "ffmpeg",
            ]
        )

    if res := os.environ.get("TAURI_RESOURCE_DIR"):
        candidates.append(Path(res) / "ffmpeg")
        candidates.append(Path(res) / "resources" / "ffmpeg")

    names = ("ffmpeg.exe", "ffmpeg") if os.name == "nt" else ("ffmpeg",)
    probe_names = ("ffprobe.exe", "ffprobe") if os.name == "nt" else ("ffprobe",)

    for d in candidates:
        if not d.is_dir():
            continue
        ff = next((d / n for n in names if (d / n).is_file()), None)
        fp = next((d / n for n in probe_names if (d / n).is_file()), None)
        if ff and fp:
            return str(ff), str(fp)

    ff_path = shutil.which("ffmpeg")
    fp_path = shutil.which("ffprobe")
    if ff_path and fp_path:
        return ff_path, fp_path
    raise DecodeError(
        "FFmpeg/FFprobe not found. Set CHORD_FFMPEG_DIR or place binaries in resources/ffmpeg."
    )


def probe_duration(path: str | Path) -> float | None:
    """Return container duration in seconds, or None if unknown."""
    _, ffprobe = find_ffmpeg()
    cmd = [
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        str(path),
    ]
    try:
        out = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise DecodeError(f"ffprobe failed: {exc}") from exc
    if out.returncode != 0:
        return None
    try:
        data = json.loads(out.stdout or "{}")
        dur = data.get("format", {}).get("duration")
        return float(dur) if dur is not None else None
    except (json.JSONDecodeError, TypeError, ValueError):
        return None


def decode_to_wav(
    source: str | Path,
    out_wav: str | Path | None = None,
    sr: int = SR,
    cancel_event=None,
) -> Path:
    """
    Decode any FFmpeg-supported audio to mono PCM WAV at `sr`.

    Uses subprocess list args only (never shell interpolation).
    On cancel/failure: kill FFmpeg process tree and delete temp output.
    """
    ffmpeg, _ = find_ffmpeg()
    source = Path(source)
    if not source.is_file():
        raise DecodeError(f"Input file not found: {source}")

    owned_temp = False
    if out_wav is None:
        fd, tmp = tempfile.mkstemp(suffix=".wav", prefix="chord_decode_")
        os.close(fd)
        out_path = Path(tmp)
        owned_temp = True
    else:
        out_path = Path(out_wav)

    if owned_temp:
        track_temp(out_path)

    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        "0",
        "-i",
        str(source),
        "-ac",
        "1",
        "-ar",
        str(sr),
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        str(out_path),
    ]
    proc: subprocess.Popen | None = None
    try:
        # Honour cancel before spawn when already set
        if cancel_event is not None and cancel_event.is_set():
            if owned_temp:
                untrack_temp(out_path, delete=True)
            raise DecodeError("Decode cancelled")

        proc = popen_list(cmd, text=True)
        while True:
            if cancel_event is not None and cancel_event.is_set():
                kill_process_tree(proc.pid)
                try:
                    proc.wait(timeout=10)
                except Exception:
                    pass
                try:
                    if proc.stdout:
                        proc.stdout.close()
                    if proc.stderr:
                        proc.stderr.close()
                except Exception:
                    pass
                if owned_temp:
                    untrack_temp(out_path, delete=True)
                raise DecodeError("Decode cancelled")
            try:
                code = proc.wait(timeout=0.25)
                break
            except subprocess.TimeoutExpired:
                continue
        stderr = ""
        if proc.stderr:
            try:
                stderr = proc.stderr.read() or ""
            except Exception:
                stderr = ""
        if cancel_event is not None and cancel_event.is_set():
            if owned_temp:
                untrack_temp(out_path, delete=True)
            raise DecodeError("Decode cancelled")
        if code != 0:
            if owned_temp:
                untrack_temp(out_path, delete=True)
            raise DecodeError(f"FFmpeg decode failed (code {code}): {stderr[-800:]}")
    except DecodeError:
        raise
    except OSError as exc:
        if owned_temp:
            untrack_temp(out_path, delete=True)
        raise DecodeError(f"FFmpeg spawn failed: {exc}") from exc

    return out_path


def read_wav_mono_float(path: str | Path) -> tuple["np.ndarray", int]:
    """Read mono/stereo WAV to mono float32 in [-1, 1]. Prefer soundfile; fallback wave."""
    import numpy as np

    path = Path(path)
    try:
        import soundfile as sf

        data, sr = sf.read(str(path), always_2d=True, dtype="float32")
        mono = data.mean(axis=1)
        return mono.astype(np.float32), int(sr)
    except Exception:
        pass

    with wave.open(str(path), "rb") as wf:
        n_ch = wf.getnchannels()
        sr = wf.getframerate()
        n_frames = wf.getnframes()
        width = wf.getsampwidth()
        raw = wf.readframes(n_frames)

    if width == 2:
        ints = struct.unpack("<" + "h" * (len(raw) // 2), raw)
        arr = np.array(ints, dtype=np.float32).reshape(-1, n_ch) / 32768.0
    elif width == 4:
        ints = struct.unpack("<" + "i" * (len(raw) // 4), raw)
        arr = np.array(ints, dtype=np.float32).reshape(-1, n_ch) / 2147483648.0
    else:
        raise DecodeError(f"Unsupported WAV sample width: {width}")
    mono = arr.mean(axis=1).astype(np.float32)
    return mono, sr


def decode_audio(
    source: str | Path,
    sr: int = SR,
    keep_wav: bool = False,
    cancel_event=None,
) -> tuple["np.ndarray", int, float, Path | None]:
    """
    Full decode path: source → FFmpeg mono WAV @ sr → float32 array.

    Returns (samples, sample_rate, duration_sec, wav_path_or_none).
    Temp WAV is always untracked+deleted unless keep_wav=True.
    """
    wav_path = decode_to_wav(source, sr=sr, cancel_event=cancel_event)
    try:
        samples, got_sr = read_wav_mono_float(wav_path)
        if got_sr != sr:
            raise DecodeError(f"Sample rate mismatch: expected {sr}, got {got_sr}")
        duration = float(len(samples) / sr) if sr else 0.0
        if keep_wav:
            return samples, sr, duration, wav_path
        return samples, sr, duration, None
    finally:
        if not keep_wav:
            untrack_temp(wav_path, delete=True)
