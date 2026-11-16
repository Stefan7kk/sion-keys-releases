# Rebuild PyInstaller engine and copy into resources/chord-engine
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$engine = Join-Path $root "engine"
$venvPy = Join-Path $engine ".venv\Scripts\python.exe"
$venvPi = Join-Path $engine ".venv\Scripts\pyinstaller.exe"
if (-not (Test-Path $venvPy)) {
  throw "Missing engine venv. Run: py -3.12 -m venv engine\.venv && engine\.venv\Scripts\pip install -r engine\requirements.txt"
}
if (-not (Test-Path $venvPi)) {
  & $venvPy -m pip install "pyinstaller==6.16.0"
}
# Ensure yt-dlp + ejs present for M2
& $venvPy -c "import yt_dlp, yt_dlp_ejs"
if ($LASTEXITCODE -ne 0) { throw "Missing pinned engine dependencies" }

Push-Location $engine
try {
  & $venvPi --noconfirm --onedir --exclude-module torch --exclude-module mutagen --name chord-engine --paths . `
    --hidden-import=librosa --hidden-import=sklearn --hidden-import=scipy `
    --hidden-import=numpy --hidden-import=soundfile --hidden-import=audioread `
    --hidden-import=yt_dlp --hidden-import=yt_dlp.utils `
    --hidden-import=yt_dlp_ejs --hidden-import=yt_dlp_ejs.yt --hidden-import=yt_dlp_ejs.yt.solver `
    --hidden-import=chord_engine --hidden-import=chord_engine.analyze `
    --hidden-import=chord_engine.cli --hidden-import=chord_engine.decode `
    --hidden-import=chord_engine.features --hidden-import=chord_engine.key `
    --hidden-import=chord_engine.chords --hidden-import=chord_engine.procutil `
    --hidden-import=chord_engine.sequence `
    --hidden-import=chord_engine.youtube `
    --hidden-import=chord_engine.crema `
    --collect-submodules=librosa --collect-submodules=soxr --collect-submodules=yt_dlp `
    --collect-submodules=yt_dlp_ejs `
    --collect-data=librosa --collect-data=yt_dlp --collect-data=yt_dlp_ejs `
    run_engine.py
  if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed: $LASTEXITCODE" }
} finally {
  Pop-Location
}
$src = Join-Path $engine "dist\chord-engine"
$dst = Join-Path $root "resources\chord-engine"
# Update the existing bundle in place without a second installation.
robocopy $src $dst /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed: $LASTEXITCODE" }
Write-Host "Engine packed to $dst"
$env:CHORD_FFMPEG_DIR = Join-Path $root "resources\ffmpeg"
$nodeExe = Join-Path $root "resources\node\node.exe"
if (Test-Path $nodeExe) {
  $env:CHORD_NODE_PATH = $nodeExe
  $env:CHORD_NODE_DIR = Join-Path $root "resources\node"
}
& (Join-Path $dst "chord-engine.exe") selftest
