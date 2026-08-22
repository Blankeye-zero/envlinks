#Requires -Version 5.1
<#
.SYNOPSIS
    Installs all dependencies listed in nvim/installables.md.

.DESCRIPTION
    Iterates every winget-installable dependency from installables.md and runs
    'winget install' for each. Already-installed packages are skipped by winget
    itself (it reports "Found an existing package already installed").

    Items that are NOT winget-installable are printed as manual steps at the end:
      - 0xProto Font      (download from GitHub)
      - Aseprite          (paid, download from aseprite.org)
      - Flutter           (dart pub global activate flutter / flutter.dev)
      - FVM               (dart pub global activate fvm)
      - vcpkg             (git clone)
      - Pi Agent Harness  (scripts\build-pi.ps1)

    Safe to re-run; winget is idempotent per package.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-deps.ps1

.EXAMPLE
    # Only the nvim plugin dependencies (skip general dev tools)
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-deps.ps1 -NvimOnly
#>

param(
    # Skip the general dev tools; only install what the nvim plugins need.
    [switch]$NvimOnly
)

$ErrorActionPreference = "Continue"

# ---------------------------------------------------------------------------
# Package list (winget IDs), mirroring nvim/installables.md
# ---------------------------------------------------------------------------
$general = @(
    # General dev tools
    "CoreyButler.NVMforWindows",
    # Node.js is installed via nvm (see manual steps), not winget.
    "pnpm.pnpm",
    "Python.Python.3.13",
    "Obsidian.Obsidian",
    "Bruno.Bruno",
    "MongoDB.Server",
    "PostgreSQL.PostgreSQL.17",
    "Docker.DockerDesktop",
    "Microsoft.VisualStudio.2022.BuildTools",
    "LLVM.LLVM",
    "Google.DartSDK",
    "Neovim.Neovim",
    "charmbracelet.crush",
    "Oven-sh.Bun",                 # required by build-pi.ps1 (binary build)
    "Kitware.CMake"
)

$nvimDeps = @(
    # LSP (mason-lspconfig)
    "GoLang.Go",                  # gopls
    "Rustlang.Rustup",            # rust_analyzer
    "Hashicorp.Terraform",        # terraformls
    # Telescope
    "BurntSushi.ripgrep.MSVC",    # live_grep
    "sharkdp.fd",                 # find_files performance
    # Formatting (mason-tool-installer)
    "JohnnyMorganz.StyLua",       # Lua formatter
    # Python plugin (uv.nvim)
    "astral-sh.uv",
    # Git plugins
    "Git.Git",
    "GitHub.cli"                  # optional
)

$packages = if ($NvimOnly) { $nvimDeps } else { $general + $nvimDeps }

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
if (-not (Get-Command "winget" -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: 'winget' was not found on PATH. Install App Installer from the Microsoft Store." -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
# Install loop
# ---------------------------------------------------------------------------
$ok      = @()
$failed  = @()

foreach ($pkg in $packages) {
    Write-Host ""
    Write-Host "=== $pkg ===" -ForegroundColor Cyan
    winget install --id $pkg --exact --accept-source-agreements --accept-package-agreements --disable-interactivity
    if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq -1978335189) {
        # 0 = installed; -1978335189 (0x8A15002B) = already installed / no applicable update
        $ok += $pkg
    } else {
        Write-Host "FAILED: $pkg (exit $LASTEXITCODE)" -ForegroundColor Red
        $failed += $pkg
    }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "=== install-deps summary ===" -ForegroundColor Cyan
Write-Host "Installed / already present: $($ok.Count)"
if ($failed.Count) {
    Write-Host "Failed ($($failed.Count)):" -ForegroundColor Red
    $failed | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
}

Write-Host ""
Write-Host "=== Manual steps (not winget-installable) ===" -ForegroundColor Yellow
Write-Host "  Node.js           - nvm install 24.18.0; nvm use 24.18.0   (via nvm-windows, installed above)"
Write-Host "  0xProto Font      - download from https://github.com/0xType/0xProto (install the Nerd Font Mono variant)"
Write-Host "  Aseprite          - paid; download from https://www.aseprite.org/"
Write-Host "  Flutter           - dart pub global activate flutter   (or install from https://flutter.dev)"
Write-Host "  FVM               - dart pub global activate fvm"
Write-Host "  vcpkg             - git clone https://github.com/Microsoft/vcpkg.git"
Write-Host "  Pi Agent Harness  - powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\build-pi.ps1`""
Write-Host ""
Write-Host "=== Auto-installed by nvim itself (nothing to do) ===" -ForegroundColor DarkGray
Write-Host "  Mason: clangd, basedpyright, ruff, lua_ls, delve, Prettier"
Write-Host "  nvim-treesitter: parsers;   Telescope: fzf-native (built via CMake)"

if ($failed.Count) { exit 1 }
