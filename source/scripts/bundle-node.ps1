# Download official Node.js Windows x64 binary into resources/node (no installer).
# Used by yt-dlp for YouTube JS/EJS challenges. App must not depend on system Node.
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$dest = Join-Path $root "resources\node"
$ver = "v22.14.0"
$zipName = "node-$ver-win-x64.zip"
$url = "https://nodejs.org/dist/$ver/$zipName"
$tmp = Join-Path $env:TEMP "chord-node-bundle"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zipPath = Join-Path $tmp $zipName

if ((Test-Path (Join-Path $dest "node.exe"))) {
  $got = & (Join-Path $dest "node.exe") -v 2>$null
  Write-Host "Node already at $dest ($got). Re-download? delete folder and re-run."
  exit 0
}

Write-Host "Downloading $url ..."
Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
$extract = Join-Path $tmp "extract"
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
Expand-Archive -Path $zipPath -DestinationPath $extract -Force
$inner = Get-ChildItem $extract -Directory | Select-Object -First 1
if (-not $inner) { throw "Unexpected Node zip layout" }
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
# Ship node.exe + LICENSE only (minimal runtime for yt-dlp)
Copy-Item (Join-Path $inner.FullName "node.exe") (Join-Path $dest "node.exe")
foreach ($f in @("LICENSE", "LICENSE.MD", "license", "README.md")) {
  $p = Join-Path $inner.FullName $f
  if (Test-Path $p) { Copy-Item $p (Join-Path $dest (Split-Path $f -Leaf)) -ErrorAction SilentlyContinue }
}
# Keep a small notice
@"
Node.js $ver win-x64 binary redistributed for yt-dlp JavaScript runtime only.
Upstream: https://nodejs.org/dist/$ver/
License: see LICENSE in this folder (MIT).
"@ | Set-Content -Path (Join-Path $dest "REDISTRIBUTION.md") -Encoding UTF8

& (Join-Path $dest "node.exe") -v
Write-Host "Bundled Node -> $dest"
