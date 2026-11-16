"""
YouTube download + optional MP3 export via yt-dlp Python API and FFmpeg.

Rules:
  - Pasting a URL does nothing (UI-only); this module runs only when CLI/commands invoke it.
  - Analyze: bestaudio/best to temp cache, NO permanent MP3.
  - Download MP3 / Export MP3: user-chosen destination only; convert via temp then move.
  - Never interpolate URLs into shell commands (list argv / API only).
  - noplaylist: True; single-video only.
"""

from __future__ import annotations

import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable

from .decode import find_ffmpeg, probe_duration
from .procutil import (
    cancel_event,
    kill_process_tree,
    popen_list,
    track_temp,
    untrack_temp,
)

ProgressCb = Callable[[str, int, str], None]


class YoutubeError(RuntimeError):
    def __init__(self, message: str, code: str = "YOUTUBE_ERROR"):
        super().__init__(message)
        self.code = code


def find_node() -> str | None:
    """Bundled Node first, then PATH."""
    candidates: list[Path] = []
    env = os.environ.get("CHORD_NODE_PATH")
    if env:
        candidates.append(Path(env))
    env_dir = os.environ.get("CHORD_NODE_DIR")
    if env_dir:
        candidates.append(Path(env_dir) / ("node.exe" if os.name == "nt" else "node"))

    here = Path(__file__).resolve()
    try:
        root = here.parents[2]
        candidates.extend(
            [
                root / "resources" / "node" / "node.exe",
                root / "resources" / "node" / "node",
            ]
        )
    except IndexError:
        pass

    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        candidates.extend(
            [
                exe_dir / "node" / "node.exe",
                exe_dir.parent / "node" / "node.exe",
                exe_dir.parent / "resources" / "node" / "node.exe",
            ]
        )

    if res := os.environ.get("TAURI_RESOURCE_DIR"):
        candidates.append(Path(res) / "node" / "node.exe")
        candidates.append(Path(res) / "resources" / "node" / "node.exe")

    which = shutil.which("node")
    if which:
        candidates.append(Path(which))

    for c in candidates:
        if c.is_file():
            return str(c)
    return None


def _safe_filename(title: str, max_len: int = 80) -> str:
    t = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", title).strip(" .")
    if not t:
        t = "audio"
    return t[:max_len]


def _ydl_base_opts(cache_dir: Path, node_path: str | None) -> dict[str, Any]:
    ffmpeg, _ = find_ffmpeg()
    opts: dict[str, Any] = {
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "outtmpl": str(cache_dir / "%(id)s.%(ext)s"),
        "paths": {"home": str(cache_dir)},
        "ffmpeg_location": str(Path(ffmpeg).parent),
        "restrictfilenames": True,
        "overwrites": True,
        "concurrent_fragment_downloads": 8,
        "fragment_retries": 10,
        # Never pull remote components in packaged app
        "remote_components": [],
    }
    if node_path:
        # yt-dlp >= 2024/2025 js_runtimes dict form
        opts["js_runtimes"] = {"node": {"path": node_path}}
    return opts


def _check_cancel() -> None:
    if cancel_event().is_set():
        raise YoutubeError("cancelled", "CANCELLED")


def download_bestaudio(url: str, cache_dir: str | Path, on_progress: ProgressCb | None = None) -> dict[str, Any]:
    """
    Download best audio (no extract-audio) into cache_dir.
    Returns {path, title, id, ext, webpage_url}.
    """
    try:
        import yt_dlp
    except ImportError as e:
        raise YoutubeError(f"yt-dlp not installed: {e}", "YTDLP_MISSING") from e

    cache = Path(cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    # Do NOT track_temp(cache): successful Analyze must leave source on disk for
    # playback + Export MP3 after this process exits. App/Tauri owns lifetime
    # (clear on replace/clear/quit; wipe job dir on failure below).

    node = find_node()
    opts = _ydl_base_opts(cache, node)
    opts["format"] = "bestaudio/best"
    # Do NOT set extractaudio / postprocessors for analyze path

    def hook(d: dict[str, Any]) -> None:
        _check_cancel()
        if on_progress and d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            pct = int(min(95, (done / total) * 90)) if total else 20
            on_progress("download", pct, "Downloading audio")
        if on_progress and d.get("status") == "finished":
            on_progress("download", 95, "Download finished")

    opts["progress_hooks"] = [hook]

    if on_progress:
        on_progress("download", 5, "Starting download")

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if info is None:
                raise YoutubeError("No metadata returned", "NO_INFO")
            if info.get("_type") == "playlist":
                raise YoutubeError("Playlists are not supported; use a single-video URL", "PLAYLIST")
            # If entries somehow present, reject
            if "entries" in info and info["entries"] is not None:
                raise YoutubeError("Playlists are not supported; use a single-video URL", "PLAYLIST")

            path = Path(ydl.prepare_filename(info))
            if not path.is_file():
                # ext may differ after download
                vid = info.get("id") or ""
                matches = list(cache.glob(f"{vid}.*")) if vid else []
                matches = [m for m in matches if m.suffix.lower() not in (".json", ".part")]
                if not matches:
                    raise YoutubeError(f"Downloaded file not found in {cache}", "FILE_MISSING")
                path = matches[0]
    except YoutubeError:
        _scrub_partials(cache)
        raise
    except Exception as e:
        _scrub_partials(cache)
        msg = str(e)
        if cancel_event().is_set() or "cancelled" in msg.lower():
            raise YoutubeError("cancelled", "CANCELLED") from e
        raise YoutubeError(msg, "DOWNLOAD_FAILED") from e

    _check_cancel()
    return {
        "path": str(path),
        "title": info.get("title") or path.stem,
        "id": info.get("id") or path.stem,
        "ext": path.suffix.lstrip("."),
        "webpage_url": info.get("webpage_url") or url,
        "duration": info.get("duration"),
    }


def _scrub_partials(cache: Path) -> None:
    """Remove .part / incomplete downloads on failure; leave caller to drop job dir."""
    if not cache.is_dir():
        return
    for p in cache.glob("*"):
        try:
            if p.suffix.lower() == ".part" or p.name.endswith(".part") or p.name.endswith(".ytdl"):
                p.unlink(missing_ok=True)
        except OSError:
            pass


def analyze_youtube_url(
    url: str,
    cache_dir: str | Path,
    on_progress: ProgressCb | None = None,
    audio_only: bool = False,
) -> dict[str, Any]:
    """Download temporary playback audio and analyze it for a new song."""

    def download_progress(phase, pct, msg):
        if on_progress:
            on_progress(phase, pct * 0.45, msg)

    def analysis_progress(phase, pct, msg):
        if on_progress:
            on_progress(phase, 45 + pct * 0.55, msg)

    meta = download_bestaudio(url, cache_dir, on_progress=on_progress if audio_only else download_progress)
    if audio_only:
        duration = probe_duration(meta["path"])
        if duration is None or not math.isfinite(duration) or duration <= 0:
            raise YoutubeError("Could not verify the recovered recording duration.", "INVALID_DURATION")
        return {"ok": True, "source": {
            "name": meta["title"], "path": meta["path"], "url": meta["webpage_url"],
            "youtubeId": meta["id"], "cachedSourcePath": meta["path"],
            "fromYoutube": True, "durationSec": duration,
        }, "cache": {"dir": str(cache_dir), "sourcePath": meta["path"]}}
    from .analyze import analyze_to_json
    result = analyze_to_json(meta["path"], source_name=meta["title"], on_progress=analysis_progress)
    if result.get("ok"):
        result["source"] = {
            **result.get("source", {}),
            "name": meta["title"],
            "path": meta["path"],
            "url": meta["webpage_url"],
            "youtubeId": meta["id"],
            "cachedSourcePath": meta["path"],
            "fromYoutube": True,
        }
        result["cache"] = {"dir": str(cache_dir), "sourcePath": meta["path"]}
    return result


def _mp3_ffmpeg_args(quality: str) -> list[str]:
    """high = VBR 0 (best), 192 = 192k CBR, 128 = 128k CBR."""
    q = (quality or "high").lower()
    if q in ("high", "vbr", "vbr0", "0"):
        return ["-codec:a", "libmp3lame", "-q:a", "0"]
    if q in ("192", "192k"):
        return ["-codec:a", "libmp3lame", "-b:a", "192k"]
    if q in ("128", "128k"):
        return ["-codec:a", "libmp3lame", "-b:a", "128k"]
    raise YoutubeError(f"Unknown MP3 quality: {quality}", "BAD_QUALITY")


def convert_to_mp3(
    source: str | Path,
    dest: str | Path,
    quality: str = "high",
    on_progress: ProgressCb | None = None,
) -> str:
    """
    Convert to MP3 via temp file then os.replace into dest.
    Never writes a partial final dest; cancel deletes temp only.
    """
    ffmpeg, _ = find_ffmpeg()
    source = Path(source)
    dest = Path(dest)
    if not source.is_file():
        raise YoutubeError(f"Source not found: {source}", "SOURCE_MISSING")

    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(suffix=".mp3", prefix="chord_mp3_", dir=str(dest.parent))
    os.close(fd)
    tmp = Path(tmp_name)
    track_temp(tmp)

    if on_progress:
        on_progress("convert", 10, "Converting to MP3")

    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-vn",
        *_mp3_ffmpeg_args(quality),
        str(tmp),
    ]
    proc = popen_list(cmd, text=True)
    try:
        while True:
            _check_cancel()
            if cancel_event().is_set():
                kill_process_tree(proc.pid)
                untrack_temp(tmp, delete=True)
                raise YoutubeError("cancelled", "CANCELLED")
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
                pass
        if code != 0:
            untrack_temp(tmp, delete=True)
            raise YoutubeError(f"MP3 convert failed: {stderr[-500:]}", "CONVERT_FAILED")
        if not tmp.is_file() or tmp.stat().st_size < 64:
            untrack_temp(tmp, delete=True)
            raise YoutubeError("MP3 convert produced empty file", "CONVERT_EMPTY")

        # Atomic replace into final destination
        os.replace(str(tmp), str(dest))
        untrack_temp(tmp, delete=False)
        if on_progress:
            on_progress("convert", 100, "MP3 saved")
        return str(dest)
    except YoutubeError:
        raise
    except Exception as e:
        kill_process_tree(proc.pid) if proc.poll() is None else None
        untrack_temp(tmp, delete=True)
        raise YoutubeError(str(e), "CONVERT_FAILED") from e


def download_youtube_mp3(
    url: str,
    dest_path: str | Path,
    quality: str = "high",
    cache_dir: str | Path | None = None,
    on_progress: ProgressCb | None = None,
) -> dict[str, Any]:
    """
    Download best audio to work dir, convert to dest MP3, then remove work files
    (unless convert still needs them — we delete after successful convert).
    """
    dest = Path(dest_path)
    owned_cache = cache_dir is None
    if cache_dir is None:
        cache_dir = Path(tempfile.mkdtemp(prefix="chord_yt_mp3_"))
        track_temp(cache_dir)
    else:
        cache_dir = Path(cache_dir)
        cache_dir.mkdir(parents=True, exist_ok=True)

    try:
        meta = download_bestaudio(url, cache_dir, on_progress=on_progress)
        # Default filename from title if dest is a directory
        if dest.is_dir() or str(dest_path).endswith(("/", "\\")):
            dest = dest / f"{_safe_filename(meta['title'])}.mp3"
        elif dest.suffix.lower() != ".mp3":
            dest = dest.with_suffix(".mp3")

        final = convert_to_mp3(meta["path"], dest, quality=quality, on_progress=on_progress)
        return {
            "path": final,
            "title": meta["title"],
            "quality": quality,
            "sourceUrl": meta["webpage_url"],
        }
    finally:
        if owned_cache:
            cleanup_cache_dir(cache_dir)


def export_cached_mp3(
    source_path: str | Path,
    dest_path: str | Path,
    quality: str = "high",
    on_progress: ProgressCb | None = None,
) -> dict[str, Any]:
    final = convert_to_mp3(source_path, dest_path, quality=quality, on_progress=on_progress)
    return {"path": final, "quality": quality, "sourcePath": str(source_path)}


def cleanup_cache_dir(cache_dir: str | Path, keep_path: str | Path | None = None) -> int:
    """Delete files under cache_dir except keep_path. Returns number removed."""
    cache = Path(cache_dir)
    if not cache.is_dir():
        return 0
    keep = Path(keep_path).resolve() if keep_path else None
    removed = 0
    for p in list(cache.rglob("*")):
        if not p.is_file():
            continue
        try:
            if keep and p.resolve() == keep:
                continue
            p.unlink(missing_ok=True)
            removed += 1
        except OSError:
            pass
    # remove empty dirs bottom-up
    for p in sorted(cache.rglob("*"), reverse=True):
        if p.is_dir():
            try:
                p.rmdir()
            except OSError:
                pass
    try:
        if keep is None or not any(cache.iterdir()):
            cache.rmdir()
            untrack_temp(cache, delete=False)
    except OSError:
        pass
    return removed
