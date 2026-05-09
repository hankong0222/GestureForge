param(
  [int]$Port = 8787,
  [string]$Python = "",
  [string]$Model = "gpt-4o-mini",
  [int]$MaxFiles = 50,
  [int]$MaxEvidence = 25,
  [int]$MaxContextLines = 1
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

if (-not $Python) {
  $PythonCandidates = @(
    (Join-Path $ProjectRoot "venv\Scripts\python.exe"),
    "py",
    "python"
  )

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
}

if (-not $Python) {
  throw "Could not find a working Python executable. Pass -Python `"C:\path\to\python.exe`"."
}

Set-Location $ProjectRoot
$env:PORT = "$Port"
$env:PYTHON = $Python
$env:ANALYZER_MODEL = $Model
$env:ANALYZER_MAX_FILES = "$MaxFiles"
$env:ANALYZER_MAX_EVIDENCE = "$MaxEvidence"
$env:ANALYZER_MAX_CONTEXT_LINES = "$MaxContextLines"

Write-Host "Starting GestureForge backend on http://localhost:$Port"
Write-Host "Using Python executable: $Python"
Write-Host "Camera stream will auto-start from backend at http://localhost:$Port/api/camera/video"
Write-Host "Analyzer model: $Model"
Write-Host "Analyzer scan limits: max_files=$MaxFiles max_evidence=$MaxEvidence max_context_lines=$MaxContextLines"
npm run backend
