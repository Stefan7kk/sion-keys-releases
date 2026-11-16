# PyInstaller packaging (standalone engine)

## Goal

Ship `chord-engine/` next to the Tauri binary so end users need no Python install.

## Steps (Windows, Python 3.12 venv)

```powershell
cd my-chord-app/engine
.\.venv\Scripts\pip install pyinstaller==6.16.0
.\.venv\Scripts\pyinstaller `
  --noconfirm --clean --onedir --name chord-engine `
  --paths . `
  --hidden-import=librosa --hidden-import=sklearn --hidden-import=resampy `
  --collect-all librosa --collect-all resampy --collect-all soxr `
  run_engine.py
```

Copy `dist/chord-engine/` → `my-chord-app/src-tauri/resources/chord-engine/` (or bundle resources path used by `resolve_python` in `lib.rs`).

## Pins

- Rebuild only after deliberate `requirements.txt` bumps + tests.
- Do not auto-upgrade to nightlies in production.

## Verification

```powershell
.\chord-engine\chord-engine.exe selftest
.\chord-engine\chord-engine.exe analyze sample.wav
```
