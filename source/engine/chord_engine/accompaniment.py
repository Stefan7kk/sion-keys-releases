"""Optional, local accompaniment evidence for an existing chord timeline."""

from contextlib import contextmanager
from dataclasses import replace
import ctypes
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from collections import defaultdict

from .chords import ChordSegment
from .decode import find_ffmpeg
from .procutil import popen_list, terminate_popen

_MODEL = "UVR-MDX-NET-Inst_HQ_3.onnx"
_RUNNER = r"""
import logging
from pathlib import Path
import sys

source, models, output, runtime = sys.argv[1:5]
if runtime:
    sys.path.insert(0, runtime)

import onnxruntime as ort
from audio_separator.separator import Separator

available = ort.get_available_providers()
providers = [p for p in ("DmlExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider")
             if p in available]
session = ort.InferenceSession

def existing_file(_, url, path):
    if not Path(path).is_file():
        raise FileNotFoundError(path)

Separator.download_file_if_not_exists = existing_file
for provider in providers:
    def checked_session(*args, **kwargs):
        if provider == "DmlExecutionProvider":
            options = kwargs["sess_options"]
            options.enable_mem_pattern = False
            options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        result = session(*args, **kwargs)
        if result.get_providers()[0] != provider:
            raise RuntimeError("Requested ONNX provider could not be initialized")
        return result

    ort.InferenceSession = checked_session
    try:
        separator = Separator(log_level=logging.ERROR, model_file_dir=models, output_dir=output,
                              output_format="WAV", output_single_stem="Instrumental")
        separator.onnx_execution_provider = [provider]
        separator.load_model(sys.argv[5])
        separator.separate(source, {"Instrumental": "instrumental"})
        if not (Path(output) / "instrumental.wav").is_file():
            raise RuntimeError("Instrumental output missing")
        break
    except (RuntimeError, OSError, ValueError):
        if provider == providers[-1]:
            raise
else:
    raise RuntimeError("No usable ONNX provider")
"""


def splitter_runtime() -> tuple[Path, Path] | None:
    python = os.environ.get("CHORD_SEPARATOR_PYTHON")
    models = os.environ.get("CHORD_SEPARATOR_MODELS")
    if not python or not models:
        return None
    exe, directory = Path(python), Path(models)
    if exe.is_absolute() and directory.is_absolute() and exe.is_file() and (directory / _MODEL).is_file():
        return exe, directory
    return None


@contextmanager
def instrumental_audio(path: Path, duration: float, cancelled):
    """Yield a temporary instrumental from the configured local runtime."""
    runtime = splitter_runtime()
    if runtime is None or cancelled.is_set() or not 5 <= duration <= 900:
        yield None
        return
    python, models = runtime
    ffmpeg, _ = find_ffmpeg()
    env = {k: v for k, v in os.environ.items() if not k.startswith("_PYI_") and k != "PYTHONPATH"}
    env["PATH"] = str(Path(ffmpeg).parent) + os.pathsep + env.get("PATH", "")
    env["PYTHONUTF8"] = "1"
    env["HF_HUB_OFFLINE"] = "1"
    ort = os.environ.get("CHORD_SEPARATOR_ORT_PATH", "")
    with tempfile.TemporaryDirectory(prefix="accompaniment-", dir=os.environ.get("CHORD_ANALYSIS_SCRATCH"),
                                     ignore_cleanup_errors=True) as scratch:
        result = Path(scratch) / "instrumental.wav"
        proc = None
        frozen_windows = sys.platform == "win32" and getattr(sys, "frozen", False)
        try:
            if frozen_windows:
                ctypes.windll.kernel32.SetDllDirectoryW(None)
            try:
                proc = popen_list([str(python), "-I", "-c", _RUNNER, str(path.resolve()), str(models),
                                   scratch, ort, _MODEL], env=env,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            finally:
                if frozen_windows:
                    ctypes.windll.kernel32.SetDllDirectoryW(sys._MEIPASS)
            deadline = time.monotonic() + min(180, 18 + duration * .6)
            while proc.poll() is None and not cancelled.is_set() and time.monotonic() < deadline:
                cancelled.wait(.15)
        except OSError:
            pass
        finally:
            terminate_popen(proc)
        if proc is None or proc.returncode != 0 or cancelled.is_set() or not result.is_file():
            yield None
            return
        yield result


def refine_boundaries(full: list[ChordSegment], instrumental: list[ChordSegment]):
    """Move only jointly detected changes. Keep chord identities and score provenance."""
    times: dict[tuple[str, str], list[float]] = defaultdict(list)
    for left, right in zip(instrumental, instrumental[1:]):
        if left.kind == right.kind == "chord" and left.label != right.label:
            times[left.label, right.label].append(right.start)
    result = full[:]
    shifts = []
    for i in range(1, len(full)):
        left, right = full[i - 1], full[i]
        if (left.kind != "chord" or right.kind != "chord" or left.label == right.label
            or min(left.end - left.start, right.end - right.start) < .3):
            continue
        nearby = [t for t in times[left.label, right.label] if abs(t - right.start) <= .25]
        if len(nearby) != 1:
            continue
        refined = round((right.start + nearby[0]) / 2, 4)
        if refined != right.start and result[i - 1].start < refined < right.end:
            result[i - 1] = replace(result[i - 1], end=refined)
            result[i] = replace(right, start=refined)
            shifts.append([right.start, refined])
    return result, shifts

