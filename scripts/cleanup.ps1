# standardcode manual cleanup script - Windows (macOS/Linux use scripts/cleanup.sh).
# ADR-0044 decision 5/6: CLI-independent uninstall channel (automation matrix and when CLI unusable).
# Steps: (1) npm rm -g @standardcode/cli (+residue assert) (2) PATH manifest restore
#        (3) -PurgeHome removes ~\.standardcode (+residue assert).
# Usage: powershell -ExecutionPolicy Bypass -File scripts\cleanup.ps1 [-PurgeHome]
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 parses BOM-less files as ANSI).
param(
  [switch]$PurgeHome
)
$ErrorActionPreference = "Stop"
$Pkg = "@standardcode/cli"
$DataDir = Join-Path $env:USERPROFILE ".standardcode"
$Manifest = Join-Path $DataDir "install-manifest.json"

# (1) package removal
$npmFound = $true
try { $null = & npm -v } catch { $npmFound = $false }
if ($npmFound) {
  Write-Host "[cleanup] removing global package ($Pkg)..."
  & npm rm -g $Pkg
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[cleanup] FAILED: npm rm -g failed - close running standardcode instances and retry"
    exit 1
  }
} else {
  Write-Host "[cleanup] npm not found - skip package removal"
}
if (Get-Command standardcode -ErrorAction SilentlyContinue) {
  Write-Host "[cleanup] FAILED: standardcode still on PATH after removal - leftover shim in npm global dir, remove manually"
  exit 1
}
Write-Host "[cleanup] residue check: package gone"

# (2) PATH manifest restore (Windows user registry)
if (Test-Path $Manifest) {
  $m = Get-Content $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $changed = $false
  foreach ($e in @($m.pathEntries)) {
    if ($e.scope -ne "win-user-registry") { continue }
    $present = @($userPath -split ";") -contains $e.value
    if (-not $present) { Write-Host "[cleanup] PATH entry not present (skip): $($e.value)"; continue }
    $parts = @($userPath -split ";") | Where-Object { $_ -ne "" -and $_.ToLowerInvariant() -ne $e.value.ToLowerInvariant() }
    $userPath = ($parts -join ";")
    $changed = $true
    Write-Host "[cleanup] PATH entry removed: $($e.value)"
  }
  if ($changed) { [Environment]::SetEnvironmentVariable("Path", $userPath, "User") }
} else {
  Write-Host "[cleanup] no install manifest (skip PATH restore)"
}

# (3) -PurgeHome (user data)
if ($PurgeHome) {
  if (Test-Path $DataDir) {
    Remove-Item -Recurse -Force $DataDir
    if (Test-Path $DataDir) { Write-Host "[cleanup] FAILED: $DataDir still present after removal"; exit 1 }
    Write-Host "[cleanup] purged $DataDir"
  } else {
    Write-Host "[cleanup] $DataDir absent (skip purge)"
  }
} else {
  Write-Host "[cleanup] user data dir kept: $DataDir (rerun with -PurgeHome to delete)"
}

Write-Host "[cleanup] done"
