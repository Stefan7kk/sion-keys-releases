"""One reusable full-quality result, keyed by the audio and detector build."""

import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

from .accompaniment import splitter_runtime
from .model import local_model_runtime


MAX_RESULT_BYTES = 4 * 1024 * 1024


def cache_entry(audio: Path, decoder: str):
    # Experimental results depend on an independently installed runtime.
    # Keep them out of the normal full-mix cache.
    if decoder != "viterbi" or splitter_runtime() is not None or not getattr(sys, "frozen", False):
        return None
    runtime = local_model_runtime()
    app_data = os.environ.get("LOCALAPPDATA")
    if runtime is None or not app_data:
        return None
    python, model = runtime
    try:
        weights = sorted((model / "cache_data").glob("chordformer_head16*.best.sdict"))
        if len(weights) != 5:
            return None
        inputs = [
            Path(sys.executable), python,
            python.parent.parent / "Lib/site-packages/torch/version.py",
            *weights, *sorted(model.rglob("*.py")), *sorted((model / "data").glob("*.txt")),
        ]
        with audio.open("rb") as stream:
            key = hashlib.file_digest(stream, "sha256").hexdigest()
        versions = [(str(path), info.st_size, info.st_mtime_ns)
                    for path in inputs if (info := path.stat())]
        stamp = hashlib.sha256(json.dumps([key, versions]).encode()).hexdigest()
        return Path(app_data) / "com.chordai.learn" / "analysis-result.json", stamp
    except OSError:
        return None


def load_result(entry):
    if entry is None:
        return None
    path, stamp = entry
    try:
        if path.stat().st_size > MAX_RESULT_BYTES:
            return None
        cached = json.loads(path.read_text(encoding="utf-8"))
        result = cached["result"]
        if cached["stamp"] == stamp and result["ok"] and result["meta"]["decoder"] == "chordformer":
            return result
    except (OSError, ValueError, TypeError, KeyError):
        pass
    return None


def save_result(entry, result):
    if entry is None or not result.get("ok") or result["meta"]["decoder"] != "chordformer":
        return
    path, stamp = entry
    payload = json.dumps({"stamp": stamp, "result": result}, separators=(",", ":"))
    if len(payload) > MAX_RESULT_BYTES:
        return
    pending = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
            pending = Path(stream.name)
            stream.write(payload)
        pending.replace(path)
    except OSError:
        pass
    finally:
        if pending is not None:
            try:
                pending.unlink(missing_ok=True)
            except OSError:
                pass
