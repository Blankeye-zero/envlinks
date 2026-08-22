#Requires -Version 5.1
<#
.SYNOPSIS
    Builds pi (https://github.com/earendil-works/pi) from source and generates a pi.cmd launcher.

.DESCRIPTION
    1. Clones (or updates) the pi repository from GitHub.
    2. Verifies the active Node.js major version is 24.
    3. Runs 'npm install'.
    4. Runs 'npm run build'.
    5. Generates a pi.cmd launcher pointing at the built CLI.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\build-pi.ps1
#>

param(
    [string]$RepoUrl           = "https://github.com/earendil-works/pi",
    [string]$InstallDir        = "C:\Users\User\Projects\pi",
    [string]$NodeExe           = "C:\Users\User\AppData\Local\nvm\v24.18.0\node.exe",
    [string]$PiCmdPath         = "C:\Users\User\Projects\envlinks\pi.cmd",
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

# The generated pi.cmd hard-codes $NodeExe, so make sure it exists and is Node 24.
if (-not (Test-Path -LiteralPath $NodeExe)) {
    Fail "Node executable not found: '$NodeExe'. Update the -NodeExe parameter."
}
try {
    $exeVersion = ((& $NodeExe --version) | Out-String).Trim()
    if ($exeVersion -match '^v?(\d+)\.' -and ([int]$matches[1]) -ne $RequiredNodeMajor) {
        Write-Warning "pi.cmd node ($exeVersion) is not major version $RequiredNodeMajor."
    }
}
catch {
    Write-Warning "Could not verify '$NodeExe' version: $_"
}
Write-Host "[ok] pi.cmd node: $NodeExe" -ForegroundColor Green

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
# 4. Generate pi.cmd
# ---------------------------------------------------------------------------
$cliJs = Join-Path $InstallDir "packages\coding-agent\dist\cli.js"
if (-not (Test-Path -LiteralPath $cliJs)) {
    Write-Warning "Built CLI not found at '$cliJs'."
    Write-Warning "If the build output moved, update the path inside the generated pi.cmd manually."
}

# Same content as the known-good envlinks pi.cmd:
#   @echo off
#   "<NodeExe>" "<cliJs>" %*
$cmdContent = "@echo off`r`n`"$NodeExe`" `"$cliJs`" %*`r`n"

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
Write-Host "  Launcher:  $PiCmdPath"
