param(
  [Parameter(Mandatory = $true)]
  [string]$ZipPath,

  [int]$Port = 8787,
  [int]$TimeoutSeconds = 240,
  [int]$PollSeconds = 3,
  [string]$OutputPath = "runs\controls.json"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ApiBase = "http://localhost:$Port"
$ResolvedZip = Resolve-Path $ZipPath

Set-Location $ProjectRoot

Write-Host "Checking backend health at $ApiBase/api/health"
Invoke-RestMethod "$ApiBase/api/health" | Out-Null

Write-Host "Uploading zip $ResolvedZip"
$Created = Invoke-RestMethod `
  -Method Post `
  -Uri "$ApiBase/api/sessions/zip" `
  -ContentType "application/zip" `
  -Headers @{ "X-Filename" = [IO.Path]::GetFileName($ResolvedZip) } `
  -InFile $ResolvedZip

$SessionId = $Created.session_id

if (-not $SessionId) {
  throw "Backend did not return a session_id."
}

Write-Host "Session: $SessionId"

$StartedAt = Get-Date
while ($true) {
  $Status = Invoke-RestMethod "$ApiBase/api/sessions/$SessionId"
  $Elapsed = [int]((Get-Date) - $StartedAt).TotalSeconds
  Write-Host "[$Elapsed sec] status=$($Status.status)"

  if ($Status.status -eq "ready") {
    break
  }

  if ($Status.status -eq "failed") {
    throw "Session failed: $($Status.error)"
  }

  if ($Elapsed -ge $TimeoutSeconds) {
    throw "Timed out waiting for session $SessionId after $TimeoutSeconds seconds."
  }

  Start-Sleep -Seconds $PollSeconds
}

$Analysis = Invoke-RestMethod "$ApiBase/api/sessions/$SessionId/analysis"
$OutputFullPath = Join-Path $ProjectRoot $OutputPath
$OutputDir = Split-Path $OutputFullPath -Parent

if ($OutputDir) {
  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
}

$Analysis | ConvertTo-Json -Depth 20 | Set-Content -Path $OutputFullPath -Encoding UTF8

Write-Host "Analysis saved to $OutputFullPath"
Write-Host "Game iframe URL: $ApiBase/api/sessions/$SessionId/game/"
$Analysis | ConvertTo-Json -Depth 20
