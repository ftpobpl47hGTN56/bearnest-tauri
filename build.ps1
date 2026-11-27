# ============================================================================
#  build.ps1 - BearNest VPN (Tauri+Rust) build with automatic version bump.
#  Each build increments the patch component: 2.10.0 -> 2.10.1 -> 2.10.2 ...
#  Syncs src-tauri/tauri.conf.json and src-tauri/Cargo.toml (version + description).
#  Frontend and tray read the version dynamically (app_version / CARGO_PKG_VERSION),
#  so no frontend files are touched here.
#
#  Usage (from project root):
#    powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1          # build
#    powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1 -NoBuild # bump version only
#  Switches: -NoBuild (no build), -SkipCheck (skip node/cargo checks),
#            -SkipBump (build without version change)
#
#  Requirements: PowerShell 5.1, Rust (cargo), Tauri CLI (cargo tauri);
#  node --check is optional.
# ============================================================================

param(
  [switch]$NoBuild,
  [switch]$SkipCheck,
  [switch]$SkipBump
)

Set-Location -LiteralPath $PSScriptRoot

# 1) Current version from tauri.conf.json (source of truth)
$confPath = Join-Path $PSScriptRoot "src-tauri\tauri.conf.json"
$conf = Get-Content -LiteralPath $confPath -Raw -Encoding UTF8
if ($conf -notmatch '"version"\s*:\s*"(\d+)\.(\d+)\.(\d+)"') { throw "Version not found in tauri.conf.json" }
$oldVersion = "{0}.{1}.{2}" -f $Matches[1], $Matches[2], $Matches[3]
$version = $oldVersion

# 2) Auto-increment patch component
if (-not $SkipBump) {
  $version = "{0}.{1}.{2}" -f $Matches[1], $Matches[2], ([int]$Matches[3] + 1)
}

# 3) tauri.conf.json: replace only the "version": "..." line
if ($version -ne $oldVersion) {
  $confNew = [regex]::Replace($conf, '("version"\s*:\s*")\d+\.\d+\.\d+(")', ('${1}' + $version + '${2}'))
  [System.IO.File]::WriteAllText($confPath, $confNew)
  Write-Host ("tauri.conf.json: " + $oldVersion + " -> " + $version)
}

# 4) Cargo.toml: package version + version inside description
$cargoPath = Join-Path $PSScriptRoot "src-tauri\Cargo.toml"
$cargo = Get-Content -LiteralPath $cargoPath -Raw -Encoding UTF8
$cargoNew = [regex]::Replace($cargo, '(?m)^(version\s*=\s*")[^"]+(")', ('${1}' + $version + '${2}'))
$cargoNew = [regex]::Replace($cargoNew, '(?m)^(description\s*=\s*"[^"]*v)\d+\.\d+\.\d+(")', ('${1}' + $version + '${2}'))
if ($cargoNew -ne $cargo) {
  [System.IO.File]::WriteAllText($cargoPath, $cargoNew)
  Write-Host ("Cargo.toml: -> " + $version)
}

# 5) Quick checks
if (-not $SkipCheck) {
  if (Get-Command node -ErrorAction SilentlyContinue) {
    node --check src\main.js
    if ($LASTEXITCODE -ne 0) { throw "node --check src\main.js failed" }
    Write-Host "node --check: OK"
  }
  if (Get-Command cargo -ErrorAction SilentlyContinue) {
    Push-Location (Join-Path $PSScriptRoot "src-tauri")
    cargo check
    $cargoOk = ($LASTEXITCODE -eq 0)
    Pop-Location
    if (-not $cargoOk) { throw "cargo check failed" }
    Write-Host "cargo check: OK"
  }
}

# 6) Build
if ($NoBuild) {
  Write-Host ("Done. Version: " + $version + " (build skipped: -NoBuild)")
  exit 0
}

cargo tauri build
if ($LASTEXITCODE -ne 0) { throw "cargo tauri build failed" }
Write-Host ("Done. Version: " + $version)
exit 0
