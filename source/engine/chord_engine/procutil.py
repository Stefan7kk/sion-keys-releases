"""Process helpers: kill trees, tracked temps, cancel events."""

from __future__ import annotations

import atexit
import os
import signal
import subprocess
import sys
import threading
from pathlib import Path

_tracked_temps: set[Path] = set()
_lock = threading.Lock()
_cancel = threading.Event()


def cancel_event() -> threading.Event:
    return _cancel


def request_cancel() -> None:
    _cancel.set()


def clear_cancel() -> None:
    _cancel.clear()


def track_temp(path: str | Path) -> Path:
    p = Path(path)
    with _lock:
        _tracked_temps.add(p)
    return p


def untrack_temp(path: str | Path, delete: bool = True) -> None:
    p = Path(path)
    if not delete:
        with _lock:
            _tracked_temps.discard(p)
        return
    ok = _unlink_retry(p)
    with _lock:
        if ok or not p.exists():
            _tracked_temps.discard(p)
        # else keep tracked so cleanup_all_temps / atexit can retry


def _unlink_retry(p: Path, attempts: int = 12, delay: float = 0.08) -> bool:
    """Windows may keep locks briefly after taskkill; retry delete. True if gone."""
    import time

    for i in range(attempts):
        try:
            if not p.exists():
                return True
            if p.is_dir():
                import shutil

                shutil.rmtree(p, ignore_errors=False)
            else:
                p.unlink(missing_ok=True)
            if not p.exists():
                return True
        except OSError:
            pass
        time.sleep(delay * (i + 1))
    try:
        if p.is_dir():
            import shutil

            shutil.rmtree(p, ignore_errors=True)
        else:
            p.unlink(missing_ok=True)
    except OSError:
        pass
    return not p.exists()


def cleanup_all_temps() -> None:
    with _lock:
        paths = list(_tracked_temps)
        _tracked_temps.clear()
    for p in paths:
        try:
            if p.is_dir():
                import shutil

                shutil.rmtree(p, ignore_errors=True)
            else:
                p.unlink(missing_ok=True)
        except OSError:
            pass


def kill_process_tree(pid: int) -> None:
    """Terminate pid and descendants. Windows: taskkill /T; POSIX: killpg if possible."""
    if pid <= 0:
        return
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                capture_output=True,
                check=False,
                timeout=15,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass
        return
    try:
        group = os.getpgid(pid)
        if group == os.getpgrp():
            os.kill(pid, signal.SIGTERM)
        else:
            os.killpg(group, signal.SIGTERM)
    except (OSError, ProcessLookupError, AttributeError):
        try:
            os.kill(pid, signal.SIGTERM)
        except (OSError, ProcessLookupError):
            pass


def popen_list(cmd: list[str], **kwargs) -> subprocess.Popen:
    """Popen with list argv only (never shell=True)."""
    if kwargs.get("shell"):
        raise ValueError("shell=True is forbidden")
    kwargs.setdefault("stdout", subprocess.PIPE)
    kwargs.setdefault("stderr", subprocess.PIPE)
    if os.name == "nt":
        # New process group so we can taskkill /T the root
        kwargs.setdefault("creationflags", subprocess.CREATE_NEW_PROCESS_GROUP)  # type: ignore[attr-defined]
    else:
        kwargs.setdefault("start_new_session", os.environ.get("HEARTHKEYS_ENGINE_GROUP") != "1")
    return subprocess.Popen(cmd, **kwargs)


def terminate_popen(proc: subprocess.Popen | None, temp_paths: list[Path] | None = None) -> None:
    if proc is not None and proc.poll() is None:
        kill_process_tree(proc.pid)
        try:
            proc.wait(timeout=10)
        except Exception:
            pass
    if temp_paths:
        for p in temp_paths:
            untrack_temp(p, delete=True)


def install_no_window() -> None:
    """On Windows, force every subprocess to run without a console window.

    The packed engine is a console-subsystem exe launched from a GUI app with no
    console; without this, each child it spawns (FFmpeg, FFprobe, node, yt-dlp's
    helpers, taskkill) would allocate a visible console. Wrapping Popen covers
    spawns we do not control directly (e.g. inside yt-dlp). CREATE_NO_WINDOW is
    OR-ed so existing flags such as CREATE_NEW_PROCESS_GROUP are preserved.
    """
    if os.name != "nt" or getattr(subprocess, "_chord_no_window", False):
        return
    create_no_window = 0x08000000
    orig_popen = subprocess.Popen

    class _NoWindowPopen(orig_popen):  # type: ignore[misc,valid-type]
        def __init__(self, *args, **kwargs):
            flags = kwargs.get("creationflags", 0) or 0
            kwargs["creationflags"] = flags | create_no_window
            super().__init__(*args, **kwargs)

    subprocess.Popen = _NoWindowPopen  # type: ignore[misc]
    subprocess._chord_no_window = True  # type: ignore[attr-defined]


def install_signal_cleanup() -> None:
    atexit.register(cleanup_all_temps)

    def _handler(signum, frame):  # noqa: ARG001
        request_cancel()
        cleanup_all_temps()
        sys.exit(130)

    if os.name == "nt":
        try:
            signal.signal(signal.SIGTERM, _handler)
            signal.signal(signal.SIGINT, _handler)
            signal.signal(signal.SIGBREAK, _handler)  # type: ignore[attr-defined]
        except (ValueError, AttributeError):
            pass
    else:
        try:
            signal.signal(signal.SIGTERM, _handler)
            signal.signal(signal.SIGINT, _handler)
        except ValueError:
            pass
