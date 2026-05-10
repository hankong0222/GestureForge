param(
    [int]$Camera = -1,
    [int]$Port = 8791,
    [ValidateSet("auto", "dshow", "msmf", "any")]
    [string]$Backend = "auto",
    [switch]$NoMirror
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$CodexPython = if ($env:USERPROFILE) {
    Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
} else {
    ""
}
$PythonCandidates = @(
    (Join-Path $Root "venv\Scripts\python.exe"),
    $CodexPython,
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

$VenvSitePackages = Join-Path $Root "venv\Lib\site-packages"
if (Test-Path $VenvSitePackages) {
    $PythonPaths = @($VenvSitePackages)

    if ($env:PYTHONPATH) {
        $PythonPaths += $env:PYTHONPATH
    }

    $env:PYTHONPATH = $PythonPaths -join [System.IO.Path]::PathSeparator
}

$Args = @(
    "tools/hand_camera_stream.py",
    "--camera", $Camera,
    "--backend", $Backend,
    "--port", $Port
)

if (-not $NoMirror) {
    $Args += "--mirror"
}

Set-Location $Root
& $Python @Args
