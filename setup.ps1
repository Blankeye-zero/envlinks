<#
.SYNOPSIS
  Links app config locations to this repo (envlinks).

.DESCRIPTION
  Idempotent and non-destructive:
  - Directories become NTFS junctions (no admin required).
  - Single files become symlinks when possible; otherwise the repo copy is
    copied over the target (warning printed). If symlinks fail and the target
    file differs from the repo copy, the target is backed up first.
  - Existing real directories/files are renamed to <name>.bak-<timestamp>
    before linking. Nothing is deleted.
  - Safe to run repeatedly; already-correct links are skipped.

.NOTES
  Repo layout expected:
    nvim\                        -> %LOCALAPPDATA%\nvim
    pi-agent\extensions\         -> ~\.pi\agent\extensions
    pi-agent\themes\             -> ~\.pi\agent\themes
    pi-agent\settings.json       -> ~\.pi\agent\settings.json
    windows-terminal\settings.json -> WT LocalState\settings.json
#>

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'

$linked  = @()
$copied  = @()
$skipped = @()
$backedUp = @()

function Test-IsReparsePoint([string]$path) {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    return ($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))
}

function Test-PointsTo([string]$path, [string]$target) {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return $false }
    $t = $item.Target
    if ($null -eq $t) { return $false }
    if ($t -is [array]) { $t = $t[0] }
    # Normalize both sides for comparison
    $normLink   = [IO.Path]::GetFullPath(([string]$t).TrimStart('\','?'))
    $normTarget = [IO.Path]::GetFullPath($target)
    return ($normLink -ieq $normTarget)
}

function Backup-Existing([string]$path) {
    $bak = "$path.bak-$timestamp"
    Rename-Item -LiteralPath $path -NewName (Split-Path $bak -Leaf)
    $script:backedUp += "$path -> $bak"
}

function Install-DirLink([string]$link, [string]$target) {
    if (-not (Test-Path -LiteralPath $target)) {
        New-Item -ItemType Directory -Path $target -Force | Out-Null
    }
    if (Test-IsReparsePoint $link) {
        if (Test-PointsTo $link $target) {
            $script:skipped += "$link (junction already correct)"
            return
        }
        Remove-Item -LiteralPath $link -Force   # stale junction: safe, only removes the link
    } elseif (Test-Path -LiteralPath $link) {
        Backup-Existing $link
    }
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
    $script:linked += "$link -> $target"
}

function Install-FileLink([string]$link, [string]$target) {
    if (-not (Test-Path -LiteralPath $target)) {
        throw "Repo file missing: $target"
    }
    if (Test-IsReparsePoint $link) {
        if (Test-PointsTo $link $target) {
            $script:skipped += "$link (symlink already correct)"
            return
        }
        Remove-Item -LiteralPath $link -Force
    }
    try {
        New-Item -ItemType SymbolicLink -Path $link -Target $target -ErrorAction Stop | Out-Null
        $script:linked += "$link -> $target (symlink)"
    } catch {
        # No Developer Mode / admin: fall back to copying the repo file.
        if (Test-Path -LiteralPath $link) {
            $diff = $true
            try {
                $diff = -not ((Get-FileHash $link).Hash -eq (Get-FileHash $target).Hash)
            } catch { $diff = $true }
            if ($diff) { Backup-Existing $link }
        }
        Copy-Item -LiteralPath $target -Destination $link -Force
        $script:copied += "$link (symlink unavailable; copied from repo)"
    }
}

# --- Directory mappings (junctions) ---
Install-DirLink "$env:LOCALAPPDATA\nvim"                "$repo\nvim"
Install-DirLink "$env:USERPROFILE\.pi\agent\extensions" "$repo\pi-agent\extensions"
Install-DirLink "$env:USERPROFILE\.pi\agent\themes"     "$repo\pi-agent\themes"

# --- File mappings (symlink, copy fallback) ---
Install-FileLink "$env:USERPROFILE\.pi\agent\settings.json" "$repo\pi-agent\settings.json"
$wtLocalState = "$env:LOCALAPPDATA\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState"
if (Test-Path -LiteralPath $wtLocalState) {
    Install-FileLink "$wtLocalState\settings.json" "$repo\windows-terminal\settings.json"
} else {
    Write-Host "NOTE: Windows Terminal LocalState not found; skipping WT settings link."
}

# --- Summary ---
Write-Host ""
Write-Host "=== envlinks setup summary ==="
if ($linked.Count)   { Write-Host "Linked:";   $linked   | ForEach-Object { Write-Host "  $_" } }
if ($copied.Count)   { Write-Host "Copied (symlink unavailable - rerun setup.ps1 after in-app edits, or enable Developer Mode for symlinks):"
                       $copied   | ForEach-Object { Write-Host "  $_" } }
if ($skipped.Count)  { Write-Host "Already OK:"; $skipped | ForEach-Object { Write-Host "  $_" } }
if ($backedUp.Count) { Write-Host "Backed up:"; $backedUp | ForEach-Object { Write-Host "  $_" } }
if (-not ($linked.Count -or $copied.Count -or $backedUp.Count)) {
    Write-Host "Nothing to do - all links already in place."
}
