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

function Get-ListeningPids {
  param([int]$ListenPort)

  $Rows = netstat -ano | Select-String -Pattern "LISTENING" | Where-Object {
    $_.Line -match ":$ListenPort\s+"
  }

  $Pids = foreach ($Row in $Rows) {
    if ($Row.Line -match "LISTENING\s+(\d+)$") {
      [int]$Matches[1]
    }
  }

  @($Pids | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
}

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

$EnvPath = Join-Path $ProjectRoot ".env"
if (Test-Path $EnvPath) {
  Get-Content $EnvPath | ForEach-Object {
    $Line = $_.Trim()
    if (-not $Line -or $Line.StartsWith("#") -or -not $Line.Contains("=")) {
      return
    }

    $Name, $Value = $Line.Split("=", 2)
    if ($Name) {
      [Environment]::SetEnvironmentVariable($Name.Trim(), $Value.Trim(), "Process")
    }
  }
}

$env:PORT = "$Port"
$env:PYTHON = $Python
$env:ANALYZER_MODEL = $Model
$env:ANALYZER_MAX_FILES = "$MaxFiles"
$env:ANALYZER_MAX_EVIDENCE = "$MaxEvidence"
$env:ANALYZER_MAX_CONTEXT_LINES = "$MaxContextLines"

$ExistingPids = @(Get-ListeningPids -ListenPort $Port)

if ($ExistingPids.Count -gt 0) {
  $HealthOk = $false

  try {
    $Health = Invoke-RestMethod -Uri "http://localhost:$Port/api/health" -TimeoutSec 2
    $HealthOk = $Health.status -eq "ok"
  } catch {
  }

  if ($HealthOk) {
    Write-Host "GestureForge backend is already running on http://localhost:$Port"
    Write-Host "Existing PID(s): $($ExistingPids -join ', ')"
    return
  }

  throw "Port $Port is already in use by PID(s): $($ExistingPids -join ', '). Close the existing backend terminal or use another port."
}

Write-Host "Starting GestureForge backend on http://localhost:$Port"
Write-Host "Using Python executable: $Python"
Write-Host "Camera stream will auto-start from backend at http://localhost:$Port/api/camera/video"
Write-Host "Analyzer model: $Model"
Write-Host "Analyzer scan limits: max_files=$MaxFiles max_evidence=$MaxEvidence max_context_lines=$MaxContextLines"
npm run backend
