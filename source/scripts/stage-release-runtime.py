"""Stage the pinned release runtimes for the current OS and CPU."""

import hashlib
import os
import platform
import shutil
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RESOURCES = ROOT / "resources"
NODE_VERSION = "v22.14.0"
NODE_ARCHIVES = {
    ("Windows", "x64"): ("win-x64.zip", "55b639295920b219bb2acbcfa00f90393a2789095b7323f79475c9f34795f217"),
    ("Linux", "x64"): ("linux-x64.tar.xz", "69b09dba5c8dcb05c4e4273a4340db1005abeafe3927efda2bc5b249e80437ec"),
    ("Darwin", "x64"): ("darwin-x64.tar.xz", "deb5b211c25f3f803cd49c1c3fc3964e6c3725546d7d9608d994270388dcbf02"),
    ("Darwin", "arm64"): ("darwin-arm64.tar.xz", "4e845cb71b4e897289312743b2e31c405a8a48720655404d82a4dce23fc43527"),
}
WIN_NODE_SHA = "33b1bc1a8aca11fd5a4f2699e51019c63c0af30cf437701d07af69be7706771b"
FFMPEG_ARCHIVE = "ffmpeg-n9.0.2-48-gd4070a14ce-win64-lgpl-9.0.zip"
FFMPEG_ARCHIVE_SHA = "9f83f349ee2e12f8f31529f85a0740321997e3c72b2f8fd0a819a9fc850805f5"
FFMPEG_FILES = {
    "ffmpeg.exe": "6983e1ca0f7e2048a3853f004592c7c75ea8e1a809141cb51ce4c765be1be734",
    "ffprobe.exe": "35946b6ca6d587c0e4643929e31eacbd65b3326f4b4a33bc435dd016d977eccb",
}


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(url, target, digest):
    with urllib.request.urlopen(url, timeout=120) as source, target.open("wb") as stream:
        shutil.copyfileobj(source, stream)
    if sha256(target) != digest:
        raise RuntimeError(f"SHA-256 mismatch: {url}")


def copy_member(source, target):
    if source is None:
        raise RuntimeError(f"Missing archive member: {target.name}")
    with source, target.open("wb") as stream:
        shutil.copyfileobj(source, stream)


def stage_node(system, arch, scratch):
    windows = system == "Windows"
    target = RESOURCES / ("node" if windows else "node-portable")
    binary = target / ("node.exe" if windows else "node")
    if windows and binary.is_file() and (target / "LICENSE").is_file() and sha256(binary) == WIN_NODE_SHA:
        return
    suffix, digest = NODE_ARCHIVES[system, arch]
    name = f"node-{NODE_VERSION}-{suffix}"
    archive = scratch / name
    download(f"https://nodejs.org/dist/{NODE_VERSION}/{name}", archive, digest)
    target.mkdir(parents=True, exist_ok=True)
    if windows:
        prefix = name.removesuffix(".zip")
        with zipfile.ZipFile(archive) as source:
            copy_member(source.open(f"{prefix}/node.exe"), binary)
            copy_member(source.open(f"{prefix}/LICENSE"), target / "LICENSE")
        if sha256(binary) != WIN_NODE_SHA:
            raise RuntimeError("Unexpected Windows Node executable")
    else:
        prefix = name.removesuffix(".tar.xz")
        with tarfile.open(archive, "r:xz") as source:
            copy_member(source.extractfile(f"{prefix}/bin/node"), binary)
            copy_member(source.extractfile(f"{prefix}/LICENSE"), target / "LICENSE")
        binary.chmod(0o755)


def stage_windows_ffmpeg(scratch):
    target = RESOURCES / "ffmpeg"
    if (target / "LICENSE.txt").is_file() and all(
        (target / name).is_file() and sha256(target / name) == digest
        for name, digest in FFMPEG_FILES.items()
    ):
        return
    archive = scratch / FFMPEG_ARCHIVE
    download(
        "https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/"
        f"autobuild-2026-11-08-12-35/{FFMPEG_ARCHIVE}", archive, FFMPEG_ARCHIVE_SHA,
    )
    prefix = FFMPEG_ARCHIVE.removesuffix(".zip")
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as source:
        for name, digest in FFMPEG_FILES.items():
            path = target / name
            copy_member(source.open(f"{prefix}/bin/{name}"), path)
            if sha256(path) != digest:
                raise RuntimeError(f"Unexpected FFmpeg executable: {name}")
        copy_member(source.open(f"{prefix}/LICENSE.txt"), target / "LICENSE.txt")


def main():
    system = platform.system()
    arch = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(platform.machine().lower())
    if (system, arch) not in NODE_ARCHIVES:
        raise SystemExit(f"Unsupported native release target: {system} {platform.machine()}")
    with tempfile.TemporaryDirectory(prefix="hearthkeys-release-runtime-") as scratch:
        stage_node(system, arch, Path(scratch))
        if os.name == "nt":
            stage_windows_ffmpeg(Path(scratch))
    print(f"Pinned runtime assets ready for {system} {arch}")


if __name__ == "__main__":
    main()
