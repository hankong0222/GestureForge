param(
  [Parameter(Mandatory = $true)]
  [string]$Source,

  [string]$Python = "python",
  [int]$MaxFiles = 160,
  [int]$MaxEvidence = 220,
  [int]$MaxContextLines = 2
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

Set-Location $ProjectRoot

& $Python tools\analyze_game_controls_with_composio.py `
  --source $Source `
  --max-files $MaxFiles `
  --max-evidence $MaxEvidence `
  --max-context-lines $MaxContextLines `
  --collect-only
