"""Build the native Python engine on a Linux or macOS host."""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def main():
    if sys.version_info[:2] != (3, 12) or sys.platform not in {"linux", "darwin"}:
        raise SystemExit("Run on the target Linux or macOS host with Python 3.12.")
    root = Path(__file__).resolve().parents[1]
    engine = root / "engine"
    output = root / "resources" / "chord-engine-portable"
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="hearthkeys-pack-") as scratch:
        build = Path(scratch)
        command = [
            sys.executable, "-m", "PyInstaller", "--onefile", "--name", "chord-engine",
            "--workpath", str(build / "work"), "--specpath", str(build),
            "--distpath", str(build / "dist"), "--paths", str(engine),
        ]
        for module in ("torch", "mutagen", "onnxruntime"):
            command += ["--exclude-module", module]
        for module in ("librosa", "sklearn", "scipy", "soundfile", "audioread"):
            command += ["--hidden-import", module]
        for module in ("librosa", "soxr", "yt_dlp", "yt_dlp_ejs"):
            command += ["--collect-submodules", module]
        for module in ("librosa", "yt_dlp", "yt_dlp_ejs"):
            command += ["--collect-data", module]
        subprocess.run([*command, str(engine / "run_engine.py")], cwd=engine, check=True)
        target = output / "chord-engine"
        shutil.copy2(build / "dist" / "chord-engine", target)
    env = dict(os.environ, CHORD_NODE_PATH=str(root / "resources" / "node-portable" / "node"))
    subprocess.run([str(target), "selftest"], env=env, check=True)


if __name__ == "__main__":
    main()
