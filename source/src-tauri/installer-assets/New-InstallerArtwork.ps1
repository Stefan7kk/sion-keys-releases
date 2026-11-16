$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Get-Color([string] $Hex) {
    [System.Drawing.ColorTranslator]::FromHtml("#$Hex")
}

function Draw-Text($Graphics, [string] $Text, [float] $Size, [string] $Color, [float] $X, [float] $Y, [switch] $Bold) {
    $style = if ($Bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
    $font = [System.Drawing.Font]::new('Segoe UI', $Size, $style, [System.Drawing.GraphicsUnit]::Pixel)
    $brush = [System.Drawing.SolidBrush]::new((Get-Color $Color))
    try { $Graphics.DrawString($Text, $font, $brush, $X, $Y) } finally { $font.Dispose(); $brush.Dispose() }
}

function Fill-Wave($Graphics, [int] $Y, [int] $LeftCurve, [int] $RightCurve, [string] $Color) {
    $wave = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $brush = [System.Drawing.SolidBrush]::new((Get-Color $Color))
    try {
        $wave.AddBezier(-2, $Y, 57, $LeftCurve, 110, $RightCurve, 166, ($Y - 9))
        $wave.AddLine(166, ($Y - 9), 166, 316)
        $wave.AddLine(166, 316, -2, 316)
        $wave.CloseFigure()
        $Graphics.FillPath($brush, $wave)
    } finally { $brush.Dispose(); $wave.Dispose() }
}

function Draw-Mark($Graphics, $Logo, [int] $X, [int] $Y, [int] $Size) {
    $destination = [System.Drawing.Rectangle]::new($X, $Y, $Size, $Size)
    $source = [System.Drawing.Rectangle]::new(104, 150, 985, 985)
    # Map the original pixels to silver tones and keep the source alpha and silhouette.
    $matrix = [System.Drawing.Imaging.ColorMatrix]::new()
    $matrix.Matrix00 = $matrix.Matrix01 = $matrix.Matrix02 = 0.115
    $matrix.Matrix10 = $matrix.Matrix11 = $matrix.Matrix12 = 0.220
    $matrix.Matrix20 = $matrix.Matrix21 = $matrix.Matrix22 = 0.045
    $matrix.Matrix40 = $matrix.Matrix41 = $matrix.Matrix42 = 0.56
    $attributes = [System.Drawing.Imaging.ImageAttributes]::new()
    try {
        $attributes.SetColorMatrix($matrix)
        $Graphics.DrawImage($Logo, $destination, $source.X, $source.Y, $source.Width, $source.Height, [System.Drawing.GraphicsUnit]::Pixel, $attributes)
    } finally { $attributes.Dispose() }
}

function Draw-Wordmark($Graphics, $Wordmark, [float] $X, [float] $CenterY, [float] $Width) {
    $height = $Width * $Wordmark.Height / $Wordmark.Width
    $Graphics.DrawImage($Wordmark, $X, [float]($CenterY - $height / 2), $Width, [float]$height)
}

function Write-Artwork([string] $Name, [int] $Width, [int] $Height, [scriptblock] $Draw) {
    $master = [System.Drawing.Bitmap]::new($Width * 3, $Height * 3)
    $bitmap = [System.Drawing.Bitmap]::new($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $large = [System.Drawing.Graphics]::FromImage($master)
    $small = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $large.ScaleTransform(3, 3)
        $large.SmoothingMode = 'AntiAlias'
        $large.InterpolationMode = 'HighQualityBicubic'
        $large.TextRenderingHint = 'AntiAliasGridFit'
        & $Draw $large ([System.Drawing.Rectangle]::new(0, 0, $Width, $Height))
        $small.InterpolationMode = 'HighQualityBicubic'
        $small.DrawImage($master, 0, 0, $Width, $Height)
        $bitmap.Save((Join-Path $PSScriptRoot $Name), [System.Drawing.Imaging.ImageFormat]::Bmp)
    } finally { $small.Dispose(); $large.Dispose(); $bitmap.Dispose(); $master.Dispose() }
}

$logoPath = Join-Path $PSScriptRoot '../../src/assets/about-logo.png'
$wordmarkPath = Join-Path $PSScriptRoot '../../src/assets/sion-wordmark-dark.png'
$logo = $null
$wordmark = $null
try {
    $logo = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $logoPath).Path)
    $wordmark = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $wordmarkPath).Path)
    Write-Artwork 'sidebar.bmp' 164 314 {
        param($g, $area)
        $g.Clear((Get-Color '2B2C2F'))
        Draw-Mark $g $logo 43 55 78
        Draw-Wordmark $g $wordmark 24 155 116
        Draw-Text $g 'Chord & Key Analyzer' 11 'BCBDC2' 25 177
        Fill-Wave $g 250 269 212 '35363A'
        Fill-Wave $g 271 205 305 '414247'
        Fill-Wave $g 293 257 317 '4E4F55'
    }

    Write-Artwork 'header.bmp' 150 57 {
        param($g, $area)
        $g.Clear((Get-Color '202124'))
        Draw-Mark $g $logo 17 10 35
        Draw-Wordmark $g $wordmark 58 28.5 80
    }
} finally {
    if ($wordmark) { $wordmark.Dispose() }
    if ($logo) { $logo.Dispose() }
}
