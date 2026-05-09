param(
    [int]$Camera = 0,
    [int]$Port = 8791,
    [switch]$NoMirror
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$PythonCandidates = @(
    (Join-Path $Root "venv\Scripts\python.exe"),
    "py",
    "python"
)

$Python = $null
foreach ($Candidate in $PythonCandidates) {
    try {
        $VersionOutput = & $Candidate --version 2>$null
        if ($LASTEXITCODE -eq 0 -and $VersionOutput) {
            $Python = $Candidate
            break
        }
    } catch {
    }
}

if (-not $Python) {
    throw "Could not find a working Python executable. Activate your venv or install Python first."
}

$Args = @(
    "tools/hand_camera_stream.py",
    "--camera", $Camera,
    "--port", $Port
)

if (-not $NoMirror) {
    $Args += "--mirror"
}

Set-Location $Root
& $Python @Args
