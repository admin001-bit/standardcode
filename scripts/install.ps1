# standardcode installer - Windows (macOS/Linux use scripts/install.sh).
# ADR-0044 decision 6 ([self-defined]; Appendix E line 630 mechanism backbone): npm channel, zero privilege
# elevation (no admin actions; npm global dir = user-writable semantics).
# Flow: precheck (node>=18 + npm) -> npm i -g @standardcode/cli@latest -> standardcode --version self-check
#       -> PATH missing => confirm "yes" then write user PATH + record install manifest (ENG-040 line 431).
# Usage: powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [@version]
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 parses BOM-less files as ANSI).
$ErrorActionPreference = "Stop"
$Pkg = "@standardcode/cli"
$VersionArg = if ($args.Count -ge 1) { $args[0] } else { "@latest" }
$NodeMinMajor = 18
$DataDir = Join-Path $env:USERPROFILE ".standardcode"
$Manifest = Join-Path $DataDir "install-manifest.json"

function Fail($msg) {
  Write-Host "[install] FAILED: $msg"
  Write-Host "[install] action: fix the precondition above and retry, or run manually: npm i -g $Pkg@latest"
  exit 1
}

# (1) precheck
try { $nodeVer = (& node -p "process.versions.node.split('.')[0]") } catch { Fail "node not found on PATH" }
if ([int]$nodeVer -lt $NodeMinMajor) { Fail "node >= $NodeMinMajor required (found $(node -v))" }
try { $null = & npm -v } catch { Fail "npm not found on PATH" }

# (2) install (npm global; zero privilege elevation)
Write-Host "[install] installing $Pkg$VersionArg (npm global, no privilege elevation)..."
& npm i -g "$Pkg$VersionArg"
if ($LASTEXITCODE -ne 0) { Fail "npm install failed" }

# (3) self-check
$cmd = Get-Command standardcode -ErrorAction SilentlyContinue
if (-not $cmd) { Fail "standardcode not on PATH after install (npm global dir may be missing from PATH, see PATH step)" }
$installed = & standardcode --version
Write-Host "[install] installed: $installed"

# (4) PATH (confirm before writing; ENG-040: PATH write requires "yes")
$npmBin = (& npm prefix -g)
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$hasEntry = (@($userPath -split ";") -contains $npmBin)
$inProcPath = (@($env:Path -split ";") -contains $npmBin)
if ($hasEntry -or $inProcPath) {
  Write-Host "[install] PATH already contains $npmBin (skip)"
} else {
  $answer = Read-Host "[install] PATH does not contain npm global dir ($npmBin). Write user PATH? type 'yes'"
  if ($answer -eq "yes") {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $npmBin } else { "$userPath;$npmBin" }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    $manifestObj = if (Test-Path $Manifest) { Get-Content $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json } else { [PSCustomObject]@{ pathEntries = @() } }
    $entry = [PSCustomObject]@{ value = $npmBin; scope = "win-user-registry" }
    $entries = @($manifestObj.pathEntries) + @($entry)
    $out = [PSCustomObject]@{ pathEntries = $entries }
    $out | ConvertTo-Json -Depth 5 | Set-Content -Path $Manifest -Encoding UTF8
    Write-Host "[install] PATH entry written to user registry (recorded in $Manifest)"
    Write-Host "[install] takes effect in new terminals"
  } else {
    Write-Host "[install] PATH not written (confirmation semantics honored)"
  }
}

# (5) checksum hint (SEC-040: integrity channel)
Write-Host "[install] done - integrity check: node scripts\checksum.mjs verify apps\cli\dist (SHA256SUMS.txt ships with release artifacts)"
