#Requires -Version 5.1
<#
.SYNOPSIS
    Builds pi (https://github.com/earendil-works/pi) from source as a single binary
    and generates a pi.cmd launcher pointing at it.

.DESCRIPTION
    1. Clones (or updates) the pi repository from GitHub.
    2. Verifies the active Node.js major version is 24 (build toolchain requirement).
    3. Runs 'npm install'.
    4. Runs 'npm run build' (Node dist).
    5. Runs 'npm run build:binary' in packages/coding-agent (Bun-compiled pi.exe + assets).
    6. Generates a pi.cmd launcher pointing at the built pi.exe.

    Requires Bun (winget install Oven-sh.Bun).

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\build-pi.ps1
#>

param(
    [string]$RepoUrl           = "https://github.com/earendil-works/pi",
    [string]$InstallDir        = "$env:USERPROFILE\Projects\pi",
    [string]$PiCmdPath         = "$env:USERPROFILE\Projects\envlinks\pi.cmd",
    [int]   $RequiredNodeMajor = 24
)

$ErrorActionPreference = "Stop"

function Fail {
    param([string]$Message)
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

function Assert-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Fail "'$Name' was not found on PATH."
    }
}

# ---------------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------------
Assert-Command "git"
Assert-Command "node"
Assert-Command "npm"
Assert-Command "bun"

# Active Node.js major version must be 24 (used by npm install / npm run build).
$nodeVersion = ((& node --version) | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
    Fail "Failed to run 'node --version'."
}
if ($nodeVersion -notmatch '^v?(\d+)\.') {
    Fail "Could not parse Node.js version from '$nodeVersion'."
}
$nodeMajor = [int]$matches[1]
if ($nodeMajor -ne $RequiredNodeMajor) {
    Fail "Node.js major version must be $RequiredNodeMajor but found '$nodeVersion'.`n" +
         "Run 'nvm use $($RequiredNodeMajor).18.0' (or install Node $RequiredNodeMajor) and try again."
}
Write-Host "[ok] Active Node.js: $nodeVersion" -ForegroundColor Green
Write-Host "[ok] Bun: $(((& bun --version) | Out-String).Trim())" -ForegroundColor Green

# ---------------------------------------------------------------------------
# 2. Download / update pi
# ---------------------------------------------------------------------------
if (Test-Path -LiteralPath $InstallDir) {
    if (-not (Test-Path -LiteralPath (Join-Path $InstallDir ".git"))) {
        Fail "'$InstallDir' exists but is not a git repository."
    }
    Write-Host "Updating $InstallDir ..."
    git -C $InstallDir pull
    if ($LASTEXITCODE -ne 0) { Fail "git pull failed." }
}
else {
    Write-Host "Cloning $RepoUrl -> $InstallDir ..."
    git clone $RepoUrl $InstallDir
    if ($LASTEXITCODE -ne 0) { Fail "git clone failed." }
}

# ---------------------------------------------------------------------------
# 3. npm install + npm run build
# ---------------------------------------------------------------------------
Push-Location $InstallDir
try {
    Write-Host "Running: npm install"
    npm install
    if ($LASTEXITCODE -ne 0) { Fail "npm install failed." }

    Write-Host "Running: npm run build"
    npm run build
    if ($LASTEXITCODE -ne 0) { Fail "npm run build failed." }
}
finally {
    Pop-Location
}

# ---------------------------------------------------------------------------
# 4. Build the Bun-compiled binary
# ---------------------------------------------------------------------------
Push-Location (Join-Path $InstallDir "packages\coding-agent")
try {
    Write-Host "Running: npm run build:binary"
    npm run build:binary
    if ($LASTEXITCODE -ne 0) { Fail "npm run build:binary failed." }
}
finally {
    Pop-Location
}

# ---------------------------------------------------------------------------
# 5. Generate pi.cmd
# ---------------------------------------------------------------------------
$piExe = Join-Path $InstallDir "packages\coding-agent\dist\pi.exe"
if (-not (Test-Path -LiteralPath $piExe)) {
    Fail "Built binary not found at '$piExe'."
}

# Emit a portable launcher: use %USERPROFILE% when the exe lives under it,
# so the generated pi.cmd works for any user / machine.
#   @echo off
#   "%USERPROFILE%\...\pi.exe" %*
$exeForCmd = $piExe
if ($piExe.StartsWith($env:USERPROFILE, [System.StringComparison]::OrdinalIgnoreCase)) {
    $exeForCmd = "%USERPROFILE%" + $piExe.Substring($env:USERPROFILE.Length)
}
$cmdContent = "@echo off`r`n`"$exeForCmd`" %*`r`n"

$PiCmdPath = [System.IO.Path]::GetFullPath($PiCmdPath)
$piCmdDir  = Split-Path -Parent $PiCmdPath
if ($piCmdDir -and -not (Test-Path -LiteralPath $piCmdDir)) {
    New-Item -ItemType Directory -Path $piCmdDir -Force | Out-Null
}

[System.IO.File]::WriteAllText($PiCmdPath, $cmdContent, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[ok] Generated $PiCmdPath" -ForegroundColor Green

Write-Host ""
Write-Host "Build complete." -ForegroundColor Cyan
Write-Host "  Repo:      $InstallDir"
Write-Host "  Binary:    $piExe"
Write-Host "  Launcher:  $PiCmdPath"
