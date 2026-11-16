<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="src/assets/sion-wordmark-dark.png">
    <img src="src/assets/sion-wordmark-ice.png" alt="Sion Keys" width="420" height="103">
  </picture>
</p>

# Sion Keys — Chord & Key Analyzer

Sion Keys is a free desktop app for musicians, learners, and worship teams. It estimates musical keys and chords from audio, displays a chord timeline and Lyrics Sheet, and shows chord diagrams for piano, guitar, and bass.

**[Download Sion Keys for Windows](https://github.com/Stefan7kk/sion-keys-releases/releases/latest)** · [Screenshots and quick start](https://github.com/Stefan7kk/sion-keys-releases#readme) · [Report a problem](https://github.com/Stefan7kk/sion-keys-releases/issues)

This is the public source for **Sion Keys v0.1.1**. The official Windows installer and release notes are in the downloads repository.

## Source layout

- [React and TypeScript interface](src/) — Analyze, practice tools, lyrics, chord diagrams, history, themes, and translations.
- [Tauri desktop app](src-tauri/) — native window, engine integration, audio access, and export.
- [Python analysis engine](engine/) — audio analysis, chord and key detection, and optional lyric alignment.
- [Development and packaging scripts](scripts/) — engine setup, portable runtime preparation, and optional service handlers.

## Develop on Windows

Install Node.js 24+, Python 3.12, Rust with the MSVC toolchain, Visual Studio C++ Build Tools, and Microsoft Edge WebView2. Install FFmpeg and FFprobe, then set **CHORD_FFMPEG_DIR** to the folder containing them. Node.js should be on PATH. The native app automatically looks for the Python engine environment at **engine/.venv**.

From the repository root in PowerShell:

~~~powershell
py -3.12 -m venv engine/.venv
.\engine\.venv\Scripts\python.exe -m pip install -r engine/requirements.txt
npm ci
npm run tauri:dev
~~~

For a frontend-only build check, run **npm run build**. For local engine tests, run **npm run test:engine**. The browser preview can be started with **npm run dev**. Local file analysis and native integrations require the Tauri app.

Local lyric transcription is optional. On Windows, **scripts/setup-lyrics-alignment.ps1** installs the separate transcription runtime and downloads its Whisper model. Audio analysis works with the Python environment and FFmpeg.

Official release signing and publishing run in the maintainer's private repository. The source checkout can run in development mode without those credentials. Before distributing your own build, use your own app identifier and updater configuration and review the [third-party distribution notices](THIRD_PARTY_LICENSES.md).

## Contribute

Open an issue to describe a bug or suggest an improvement, or fork this repository and submit a pull request. Include steps to reproduce and the app version when reporting a bug. Use audio or lyrics you have permission to share in public examples.

## License

Sion Keys application code is available under the [MIT License](LICENSE). Third-party dependencies, artwork, fonts, and text have separate terms where applicable. See [Third-party licenses and redistribution review](THIRD_PARTY_LICENSES.md).
