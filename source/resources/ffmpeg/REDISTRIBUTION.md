# FFmpeg binaries in this folder

## Provenance

- Exact upstream binary archive: [BtbN autobuild 2026-11-08 12:35](https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/tag/autobuild-2026-11-08-12-35), asset `ffmpeg-n9.0.2-48-gd4070a14ce-win64-lgpl-9.0.zip`.
- Archive SHA-256: `9f83f349ee2e12f8f31529f85a0740321997e3c72b2f8fd0a819a9fc850805f5`.
- Verified byte-for-byte against the archive: `ffmpeg.exe` SHA-256 `6983e1ca0f7e2048a3853f004592c7c75ea8e1a809141cb51ce4c765be1be734` and `ffprobe.exe` SHA-256 `35946b6ca6d587c0e4643929e31eacbd65b3326f4b4a33bc435dd016d977eccb`.
- Build scripts: [BtbN commit c9fe5114060e](https://github.com/FFmpeg-Builds/FFmpeg-Builds/tree/c9fe5114060e507409f7ee07edfd82efaf25d767). FFmpeg source: [commit d4070a14ce](https://github.com/FFmpeg/FFmpeg/commit/d4070a14ce). The exact archive and hashes establish binary provenance. Complete corresponding source and linked dependency notices still need to be assembled before redistribution.
- Verified local `ffmpeg -buildconf`:
  - **No** `--enable-gpl`
  - `--disable-libx264` / `--disable-libx265`
  - `--enable-version3` (LGPLv3-compatible FFmpeg configure flag family)
  - Includes `libmp3lame` for MP3 encode (lame is LGPL)

## Do not use

The machine-local Gyan “essentials” build under `~\.cache\editor-v1\ffmpeg` is **GPLv3**
(`--enable-gpl --enable-version3` + x264/x265). It must **not** be copied into this app.

## Redistribution obligations (summary)

Bundling LGPL FFmpeg generally requires:

1. Prominent notice that the app uses FFmpeg under LGPL.
2. Provide the Corresponding Source for the exact binaries through a method permitted by their LGPL terms, including relevant dependency source and build materials.
3. Allow the user to relink/replace the LGPL library bits where applicable (static LGPL builds have stricter practical requirements — prefer documenting the exact release URL and retaining the zip hash in release notes).

This is not legal advice; confirm before commercial distribution.

## App runtime

Set `CHORD_FFMPEG_DIR` to this directory, or place `ffmpeg.exe` / `ffprobe.exe` here so the engine resolves them first.
