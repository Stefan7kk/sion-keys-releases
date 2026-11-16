"""Smoke-test a frozen engine extracted from a release candidate."""

import json
import math
import os
import struct
import subprocess
import sys
import tempfile
import wave
from pathlib import Path


def run(engine, env, scratch, *arguments):
    stdout = subprocess.check_output([str(engine), *map(str, arguments)], env=env, cwd=scratch, encoding="utf-8", timeout=120)
    return json.loads(stdout.strip().splitlines()[-1])


def main():
    engine = Path(sys.argv[1]).resolve(strict=True)
    resources = engine.parent.parent
    node = resources / "node" / ("node.exe" if os.name == "nt" else "node")
    if not node.is_file():
        raise SystemExit("The packaged Node executable is missing.")
    env = dict(os.environ, CHORD_NODE_PATH=str(node))
    for name in ("CHORD_SEPARATOR_PYTHON", "CHORD_SEPARATOR_MODELS", "HEARTHKEYS_DEV_CREMA_DIR"):
        env.pop(name, None)
    if os.name == "nt":
        env["CHORD_FFMPEG_DIR"] = str(resources / "ffmpeg")
    with tempfile.TemporaryDirectory(prefix="hearthkeys-release-test-") as scratch:
        root = Path(scratch)
        # Isolate the Windows research-result cache from the host installation.
        env["LOCALAPPDATA"] = str(root)
        checks = run(engine, env, root, "selftest")
        if not checks["ok"] or checks["checks"]["detectors"]["default"] != "template":
            raise RuntimeError(checks)
        source = root / "Песен.wav"
        sample_rate = 22_050
        with wave.open(str(source), "wb") as audio:
            audio.setparams((1, 2, sample_rate, 0, "NONE", "not compressed"))
            audio.writeframes(b"".join(
                struct.pack("<h", int(3000 * sum(math.sin(2 * math.pi * f * i / sample_rate)
                                                for f in (261.626, 329.628, 391.995))))
                for i in range(6 * sample_rate)
            ))
        result = run(engine, env, root, "analyze", source)
        if (not result["ok"] or result["meta"]["detector"] != "template"
                or result["meta"]["decoder"] != "viterbi"
                or result["source"]["name"] != source.name
                or not result["chords"] or not result["waveform"]):
            raise RuntimeError("Packaged analysis returned an unexpected result.")
        mp3 = root / "Песен.mp3"
        exported = run(engine, env, root, "export-mp3", "--source", source, "--dest", mp3)
        if not exported["ok"] or not mp3.is_file() or mp3.stat().st_size == 0:
            raise RuntimeError("Packaged MP3 export failed.")
        print(json.dumps({"engine": str(engine), "decoder": result["meta"]["decoder"],
                          "key": result["key"]["label"], "chords": len(result["chords"]),
                          "mp3Bytes": mp3.stat().st_size}, ensure_ascii=True))


if __name__ == "__main__":
    main()
