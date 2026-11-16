# Optional local lyrics alignment runtime. Run explicitly to download it.
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'com.chordai.learn\alignment'
py -3.12 -m venv (Join-Path $root 'runtime')
if ($LASTEXITCODE -ne 0) { throw 'Python 3.12 is required for the optional alignment runtime.' }
$python = Join-Path $root 'runtime\Scripts\python.exe'
& $python -m pip install 'faster-whisper==1.2.1' 'av==16.0.1'
if ($LASTEXITCODE -ne 0) { throw 'Could not install local alignment dependencies.' }
$env:HEARTHKEYS_ALIGNMENT_MODEL = Join-Path $root 'model'
try {
  & $python -c 'import os; from faster_whisper.utils import download_model; download_model("turbo", output_dir=os.environ["HEARTHKEYS_ALIGNMENT_MODEL"])'
  if ($LASTEXITCODE -ne 0) { throw 'Could not download the optional Whisper small model.' }
} finally {
  Remove-Item Env:HEARTHKEYS_ALIGNMENT_MODEL -ErrorAction SilentlyContinue
}


