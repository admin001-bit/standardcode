# standardcode direct-download verifier (Windows). M7 WP-10 (Appendix E line 630).
# Flow: download artifact + SHA256SUMS.txt -> SHA-256 check -> run hint.
# Usage: powershell -ExecutionPolicy Bypass -File verify.ps1 [-BaseUrl URL] [-Artifact NAME] [-Version X.Y.Z] [-Dest DIR]
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 parses BOM-less files as ANSI).
param(
  [string]$BaseUrl = "https://github.com/admin001-bit/standardcode/releases/download",
  [string]$Artifact = "standardcode-windows-x64.exe",
  [string]$Version = "0.1.1",
  [string]$Dest = "."
)
$ErrorActionPreference = "Stop"

function Fail($m) { Write-Host "[verify] FAILED: $m"; exit 1 }

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$baseDir = "$BaseUrl/v$Version"

function Fetch($uri, $out) {
  if ($BaseUrl -like "file://*" -or $BaseUrl -match "^[A-Za-z]:[\\/]") {
    Copy-Item -Force ($uri -replace '^file://', '') $out
  } else {
    Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $out
  }
}

Write-Host "[verify] fetching SHA256SUMS.txt + $Artifact (v$Version)"
$sumsPath = Join-Path $Dest "SHA256SUMS.txt"
$artPath = Join-Path $Dest $Artifact
Fetch "$baseDir/SHA256SUMS.txt" $sumsPath
Fetch "$baseDir/$Artifact" $artPath

$line = Get-Content $sumsPath | Where-Object { $_ -match ("  " + [Regex]::Escape($Artifact) + "$") } | Select-Object -First 1
if (-not $line) { Fail "SHA256SUMS.txt has no entry for $Artifact" }
$expect = ($line -split '\s+')[0].ToLower()
$actual = (Get-FileHash -Algorithm SHA256 -Path $artPath).Hash.ToLower()

if ($actual -eq $expect) {
  Write-Host "[verify] checksum OK  $actual"
  Write-Host "[verify] run: $artPath --version"
} else {
  Fail "checksum mismatch (expected $expect, got $actual) - do NOT run the artifact"
}
