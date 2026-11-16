"""
CLI entry: chord-engine analyze|selftest|youtube-*|export-mp3|cleanup

Progress and results on stdout as NDJSON lines.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from .procutil import clear_cancel, install_no_window, install_signal_cleanup, request_cancel


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def cmd_analyze(args: argparse.Namespace) -> int:
    clear_cancel()
    path = Path(args.path)
    if not path.is_file():
        _emit({"type": "error", "ok": False, "error": f"File not found: {path}", "errorCode": "NOT_FOUND"})
        return 2

    t0 = time.perf_counter()
    _emit({"type": "progress", "phase": "import", "pct": 2, "message": "Preparing analysis (first run compiles audio features)"})
    from .analyze import analyze_to_json
    from .procutil import cancel_event

    result = analyze_to_json(
        str(path), source_name=args.name, decoder=args.decoder,
        on_progress=lambda phase, pct, msg: _emit(
            {"type": "progress", "phase": phase, "pct": pct, "message": msg}
        ),
    )
    # Wire cancel into analyze if we extend analyze_file later; currently decode checks event.
    if cancel_event().is_set():
        _emit({"type": "error", "ok": False, "error": "cancelled", "errorCode": "CANCELLED"})
        return 130
    if not result.get("ok"):
        _emit({"type": "error", **result})
        return 1
    result.setdefault("meta", {})
    result["meta"]["wallSec"] = round(time.perf_counter() - t0, 3)
    _emit({"type": "progress", "phase": "done", "pct": 100, "message": "Complete"})
    _emit({"type": "result", **result})
    if args.out:
        Path(args.out).write_text(json.dumps(result, indent=2), encoding="utf-8")
    return 0


def cmd_selftest(_args: argparse.Namespace) -> int:
    info: dict = {"type": "selftest", "ok": True, "checks": {}}
    try:
        import numpy  # noqa: F401

        info["checks"]["numpy"] = True
    except Exception as e:
        info["checks"]["numpy"] = str(e)
        info["ok"] = False
    try:
        import librosa  # noqa: F401

        info["checks"]["librosa"] = True
    except Exception as e:
        info["checks"]["librosa"] = str(e)
        info["ok"] = False
    try:
        from .decode import find_ffmpeg

        ff, fp = find_ffmpeg()
        info["checks"]["ffmpeg"] = ff
        info["checks"]["ffprobe"] = fp
    except Exception as e:
        info["checks"]["ffmpeg"] = str(e)
        info["ok"] = False
    try:
        import yt_dlp  # noqa: F401

        yv = None
        try:
            from yt_dlp.version import __version__ as _yv

            yv = str(_yv)
        except Exception:
            v = getattr(yt_dlp, "version", None)
            # yt_dlp.version is a module — never emit it raw
            if isinstance(v, str):
                yv = v
            elif v is not None and hasattr(v, "__version__"):
                yv = str(getattr(v, "__version__"))
        info["checks"]["yt_dlp"] = yv or True
    except Exception as e:
        info["checks"]["yt_dlp"] = f"missing: {e}"
        info["checks"]["yt_dlp_optional"] = True
    try:
        from .youtube import find_node

        node = find_node()
        info["checks"]["node"] = node or "not found (needed for some YouTube extracts)"
    except Exception as e:
        info["checks"]["node"] = str(e)
    if info["checks"]["numpy"] is True:
        from .crema import detector_registry, requested_directory

        registry = detector_registry()
        info["checks"]["detectors"] = registry
        info["checks"]["cremaRequested"] = requested_directory() is not None
        if registry["default"] != "template" or registry["template"]["decoder"] != "viterbi":
            info["ok"] = False
    _emit(info)
    return 0 if info["ok"] else 1


def cmd_youtube_search(args: argparse.Namespace) -> int:
    import re

    from yt_dlp import YoutubeDL

    with YoutubeDL({
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
        "skip_download": True,
        "socket_timeout": 5,
        "extractor_retries": 0,
        "retries": 0,
    }) as ydl:
        results = ydl.extract_info("ytsearch12:" + args.query, download=False)
    videos = [
        {
            "id": entry["id"], "title": entry["title"],
            "channel": entry.get("channel") or entry.get("uploader"),
            "duration": entry.get("duration"), "views": entry.get("view_count"),
        }
        for entry in (results or {}).get("entries", [])
        if entry and re.fullmatch(r"[A-Za-z0-9_-]{11}", entry.get("id") or "") and entry.get("title")
    ]
    _emit({"ok": True, "videos": videos})
    return 0


def cmd_youtube_analyze(args: argparse.Namespace) -> int:
    clear_cancel()
    from .youtube import YoutubeError, analyze_youtube_url

    try:
        result = analyze_youtube_url(
            args.url,
            cache_dir=args.cache_dir,
            audio_only=args.audio_only,
            on_progress=lambda phase, pct, msg: _emit(
                {"type": "progress", "phase": phase, "pct": pct, "message": msg}
            ),
        )
    except YoutubeError as e:
        _emit({"type": "error", "ok": False, "error": str(e), "errorCode": e.code})
        return 1
    if not result.get("ok"):
        _emit({"type": "error", **result})
        return 1
    _emit({"type": "progress", "phase": "done", "pct": 100, "message": "Complete"})
    _emit({"type": "result", **result})
    if args.out:
        Path(args.out).write_text(json.dumps(result, indent=2), encoding="utf-8")
    return 0


def cmd_youtube_download_mp3(args: argparse.Namespace) -> int:
    clear_cancel()
    from .youtube import YoutubeError, download_youtube_mp3

    try:
        result = download_youtube_mp3(
            args.url,
            dest_path=args.dest,
            quality=args.quality,
            cache_dir=args.cache_dir,
            on_progress=lambda phase, pct, msg: _emit(
                {"type": "progress", "phase": phase, "pct": pct, "message": msg}
            ),
        )
    except YoutubeError as e:
        _emit({"type": "error", "ok": False, "error": str(e), "errorCode": e.code})
        return 1
    _emit({"type": "progress", "phase": "done", "pct": 100, "message": "Complete"})
    _emit({"type": "result", "ok": True, **result})
    return 0


def cmd_export_mp3(args: argparse.Namespace) -> int:
    """Convert already-cached source audio to MP3 (no re-download)."""
    clear_cancel()
    from .youtube import YoutubeError, export_cached_mp3

    try:
        result = export_cached_mp3(
            source_path=args.source,
            dest_path=args.dest,
            quality=args.quality,
            on_progress=lambda phase, pct, msg: _emit(
                {"type": "progress", "phase": phase, "pct": pct, "message": msg}
            ),
        )
    except YoutubeError as e:
        _emit({"type": "error", "ok": False, "error": str(e), "errorCode": e.code})
        return 1
    _emit({"type": "progress", "phase": "done", "pct": 100, "message": "Complete"})
    _emit({"type": "result", "ok": True, **result})
    return 0


def cmd_cleanup(args: argparse.Namespace) -> int:
    from .youtube import cleanup_cache_dir

    n = cleanup_cache_dir(args.cache_dir, keep_path=args.keep)
    _emit({"type": "result", "ok": True, "removed": n})
    return 0


def cmd_lyrics(args: argparse.Namespace) -> int:
    from .lyrics import dispatch
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise ValueError("Lyrics request too large")
        _emit(dispatch(Path(args.db), json.loads(raw)))
        return 0
    except Exception as error:
        _emit({"error": str(error)})
        return 1


def main(argv: list[str] | None = None) -> int:
    install_no_window()
    install_signal_cleanup()
    parser = argparse.ArgumentParser(prog="chord-engine")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_lyrics = sub.add_parser("lyrics", help="Independent lyrics metadata, lookup and local library")
    p_lyrics.add_argument("--db", required=True)
    p_lyrics.set_defaults(func=cmd_lyrics)

    p_an = sub.add_parser("analyze", help="Analyze a local audio file")
    p_an.add_argument("path", help="Path to WAV/MP3/etc.")
    p_an.add_argument("--name", default=None, help="Display name")
    p_an.add_argument("--decoder", choices=("stabilized", "viterbi"), default="viterbi", help="Display decoder (stabilized kept for A/B testing)")
    p_an.add_argument("--out", default=None, help="Optional JSON output path")
    p_an.set_defaults(func=cmd_analyze)

    p_st = sub.add_parser("selftest", help="Check deps and ffmpeg")
    p_st.set_defaults(func=cmd_selftest)

    p_search = sub.add_parser("youtube-search", help="Search YouTube video metadata")
    p_search.add_argument("--query", required=True)
    p_search.set_defaults(func=cmd_youtube_search)

    p_ya = sub.add_parser("youtube-analyze", help="Download temp best-audio and analyze")
    p_ya.add_argument("url", help="Single-video YouTube URL")
    p_ya.add_argument("--cache-dir", required=True, help="Job cache directory")
    p_ya.add_argument("--audio-only", action="store_true", help="Recover temporary playback audio without chord analysis")
    p_ya.add_argument("--out", default=None)
    p_ya.set_defaults(func=cmd_youtube_analyze)

    p_yd = sub.add_parser("youtube-download-mp3", help="Download and convert to MP3")
    p_yd.add_argument("url")
    p_yd.add_argument("--dest", required=True, help="Final .mp3 path")
    p_yd.add_argument("--quality", choices=("high", "192", "128"), default="high")
    p_yd.add_argument("--cache-dir", default=None, help="Optional work dir")
    p_yd.set_defaults(func=cmd_youtube_download_mp3)

    p_ex = sub.add_parser("export-mp3", help="Convert cached source to MP3")
    p_ex.add_argument("--source", required=True)
    p_ex.add_argument("--dest", required=True)
    p_ex.add_argument("--quality", choices=("high", "192", "128"), default="high")
    p_ex.set_defaults(func=cmd_export_mp3)

    p_cl = sub.add_parser("cleanup", help="Remove cache dir contents")
    p_cl.add_argument("--cache-dir", required=True)
    p_cl.add_argument("--keep", default=None, help="Path to keep (still in use)")
    p_cl.set_defaults(func=cmd_cleanup)

    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except KeyboardInterrupt:
        request_cancel()
        _emit({"type": "error", "ok": False, "error": "cancelled", "errorCode": "CANCELLED"})
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
