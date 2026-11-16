"""Use the existing local ChordFormer runtime without bundling a second copy."""

import ctypes
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
from threading import Thread

from .chords import ChordSegment
from .constants import NO_CHORD
from .procutil import popen_list, terminate_popen


_RUNNER = """
import contextlib
import json
import os
import sys
from pathlib import Path
output = sys.stdout
with contextlib.redirect_stdout(sys.stderr):
    import torch
    import chord_recognition as model
    # Keep CPU capacity for the parent process's concurrent key analysis.
    available = os.process_cpu_count() if hasattr(os, "process_cpu_count") else os.cpu_count()
    threads = max(1, min(12, (available or 4) * 3 // 4))
    torch.set_num_threads(threads)
    torch.set_float32_matmul_precision("highest")
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    rows = []
    reported = 0
    passes = 0
    use_gpu = torch.cuda.is_available()

    class InferenceNetwork(model.NetworkInterface):
        def __init__(self, net, save_name, **kwargs):
            self.net = net
            net.use_gpu = use_gpu
            # Checkpoints also contain training optimizer state. Only weights are
            # needed here. Keep optimizer tensors off the GPU.
            checkpoint = torch.load(Path("cache_data") / f"{save_name}.sdict", map_location="cpu")
            net.load_state_dict(checkpoint["net"])

        def inference(self, *args, **kwargs):
            global passes, reported
            result = super().inference(*args, **kwargs)
            passes += 1
            if passes > reported:
                reported = passes
                print(f"pass {passes}", file=output, flush=True)
            return result

    model.NetworkInterface = InferenceNetwork
    model.ChordLabIO.write = lambda self, data, filename, entry: rows.extend(data)
    try:
        model.chord_recognition(sys.argv[1], 'stdout')
    except RuntimeError:
        if not use_gpu:
            raise
        use_gpu = False
        passes = 0
        rows.clear()
        torch.cuda.empty_cache()
        model.chord_recognition(sys.argv[1], 'stdout')
print(json.dumps(rows))
"""


def local_model_runtime():
    for root in Path(sys.executable).resolve().parents:
        model = root / "work/benchmark/chordformer"
        python = root / "engine/.venv/Scripts/python.exe"
        if python.is_file() and (model / "chord_recognition.py").is_file():
            return python, model
    return None


def recognize_local_model(path: Path, duration: float, cancel_event, on_pass=None):
    """Return timestamped model decisions, or None if the local runtime is unavailable."""
    runtime = local_model_runtime()
    if runtime is None:
        return None
    python, model = runtime

    env = {k: v for k, v in os.environ.items() if not k.startswith("_PYI_") and k != "PYTHONPATH"}
    env["PYTHONUTF8"] = "1"
    # The child uses its own Python and native libraries, outside PyInstaller.
    frozen_windows = sys.platform == "win32" and getattr(sys, "frozen", False)
    try:
        if frozen_windows:
            ctypes.windll.kernel32.SetDllDirectoryW(None)
        try:
            process = popen_list(
                [str(python), "-c", _RUNNER, str(path.resolve())],
                cwd=model, env=env, stderr=subprocess.DEVNULL,
            )
        finally:
            if frozen_windows:
                ctypes.windll.kernel32.SetDllDirectoryW(sys._MEIPASS)
    except OSError:
        return None

    try:
        lines = []
        def read_output():
            with process.stdout as stream:
                for line in stream:
                    if line.startswith(b"pass ") and line.strip()[5:] in (b"1", b"2", b"3", b"4", b"5"):
                        if on_pass:
                            on_pass(int(line[5:]))
                    else:
                        lines.append(line)
        reader = Thread(target=read_output, daemon=True)
        reader.start()
        deadline = time.monotonic() + max(120, duration * 3)
        while not cancel_event.is_set() and time.monotonic() < deadline:
            try:
                process.wait(timeout=0.25)
                break
            except subprocess.TimeoutExpired:
                continue
        else:
            return None
        if process.returncode != 0:
            return None
        reader.join(timeout=2)
        if reader.is_alive():
            return None
        segments = []
        last = 0.0
        for start, end, label in json.loads(b"".join(lines)):
            if not math.isfinite(start) or not math.isfinite(end) or abs(start - last) > 0.001:
                return None
            end = round(min(end, duration), 4)
            if end <= last or not isinstance(label, str) or not label:
                return None
            no_chord = label == "N"
            segments.append(ChordSegment(
                last, end, NO_CHORD if no_chord else label, None,
                "chordformer_label", "no_chord" if no_chord else "chord",
            ))
            last = end
            if end >= round(duration, 4):
                break
        if not segments or abs(last - duration) > 0.1:
            return None
        segments[-1].end = round(duration, 4)
        return segments
    except (ValueError, TypeError):
        return None
    finally:
        terminate_popen(process)
