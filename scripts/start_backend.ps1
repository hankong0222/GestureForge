param(
  [int]$Port = 8787,
  [string]$Python = "python",
  [string]$Model = "gpt-4o-mini",
  [int]$MaxFiles = 50,
  [int]$MaxEvidence = 25,
  [int]$MaxContextLines = 1
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

Set-Location $ProjectRoot
$env:PORT = "$Port"
$env:PYTHON = $Python
$env:ANALYZER_MODEL = $Model
$env:ANALYZER_MAX_FILES = "$MaxFiles"
$env:ANALYZER_MAX_EVIDENCE = "$MaxEvidence"
$env:ANALYZER_MAX_CONTEXT_LINES = "$MaxContextLines"

Write-Host "Starting GestureForge backend on http://localhost:$Port"
Write-Host "Using Python executable: $Python"
Write-Host "Analyzer model: $Model"
Write-Host "Analyzer scan limits: max_files=$MaxFiles max_evidence=$MaxEvidence max_context_lines=$MaxContextLines"
npm run backend
