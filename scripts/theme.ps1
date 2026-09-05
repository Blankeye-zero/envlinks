<#
.SYNOPSIS
  Switch the colorscheme for Windows Terminal, Neovim, and pi agent in one step.

.DESCRIPTION
  Applies a "themepack" (scripts/themes/<name>.json) to all three apps:
    - Neovim:           rewrites nvim/lua/plugins/colorscheme.lua
    - pi agent:         writes pi-agent/themes/<name>.json + sets "theme" in pi-agent/settings.json
    - Windows Terminal: upserts the scheme into windows-terminal/settings.json and
                        sets profiles.defaults.colorScheme

  Themepacks are URL-addressable JSON (schema: scripts/schemas/themepack-v1.schema.json).
  Any base16 scheme from the internet (e.g. tinted-theming/schemes) can be imported
  directly from a URL with -FromBase16.

.EXAMPLES
  theme.ps1                      # interactive menu
  theme.ps1 nord                 # apply installed pack 'nord'
  theme.ps1 -List                # list installed packs
  theme.ps1 -Current             # show active scheme
  theme.ps1 -Search gruvbox      # search tinted-theming/schemes online
  theme.ps1 -Add https://example.com/my.json
  theme.ps1 -FromBase16 https://raw.githubusercontent.com/tinted-theming/schemes/main/base16/nord.yaml
  theme.ps1 -Validate ./scripts/themes/nord.json   # test without applying
  theme.ps1 -SelfTest            # validate all installed packs
#>
[CmdletBinding(DefaultParameterSetName = 'Apply')]
param(
    [Parameter(ParameterSetName = 'Apply', Position = 0)]
    [ArgumentCompleter({
        param($cmd, $param, $wordToComplete)
        $dir = Join-Path $PSScriptRoot 'themes'
        if (Test-Path $dir) {
            Get-ChildItem $dir -Filter *.json |
                Where-Object { $_.BaseName -like "$wordToComplete*" } |
                ForEach-Object { $_.BaseName }
        }
    })]
    [string]$Name,

    [Parameter(ParameterSetName = 'List')][switch]$List,
    [Parameter(ParameterSetName = 'Current')][switch]$Current,

    [Parameter(ParameterSetName = 'Add', Mandatory)]
    [Alias('Install')][string]$Add,

    [Parameter(ParameterSetName = 'FromBase16', Mandatory)][string]$FromBase16,
    [Parameter(ParameterSetName = 'FromBase16')][string]$As,

    [Parameter(ParameterSetName = 'Search')][string]$Search,

    [Parameter(ParameterSetName = 'Validate', Mandatory)][string]$Validate,

    [Parameter(ParameterSetName = 'SelfTest')][switch]$SelfTest,

    [Parameter(ParameterSetName = 'Help')][Alias('h', '?')][switch]$Help
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo       = Split-Path $PSScriptRoot -Parent
$themesDir  = Join-Path $PSScriptRoot 'themes'
$nvimSpec   = Join-Path $repo 'nvim\lua\plugins\colorscheme.lua'
$piThemeDir = Join-Path $repo 'pi-agent\themes'
$piSettings = Join-Path $repo 'pi-agent\settings.json'
$wtSettings = Join-Path $repo 'windows-terminal\settings.json'
$wtLive     = "$env:LOCALAPPDATA\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json"
$piLive     = "$env:USERPROFILE\.pi\agent\settings.json"
$schemaUrl  = 'https://raw.githubusercontent.com/earendil-works/envlinks/main/scripts/schemas/themepack-v1.schema.json'

. (Join-Path $PSScriptRoot 'lib\derive.ps1')
. (Join-Path $PSScriptRoot 'lib\validate.ps1')
. (Join-Path $PSScriptRoot 'lib\import-base16.ps1')

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

function Get-InstalledPacks {
    if (-not (Test-Path $themesDir)) { return @() }
    return @(Get-ChildItem $themesDir -Filter *.json | Sort-Object Name)
}

function Read-JsonFile([string]$Path) {
    return (Get-Content -LiteralPath $Path -Raw) | ConvertFrom-Json
}

function Write-JsonFile([string]$Path, $Obj) {
    $json = $Obj | ConvertTo-Json -Depth 100
    # ConvertTo-Json indents with 2 spaces and is stable enough for diffs.
    [IO.File]::WriteAllText($Path, ($json -replace "`r`n", "`n") + "`n", [Text.UTF8Encoding]::new($false))
}

function Test-IsSymlinkTo([string]$Link, [string]$Target) {
    $item = Get-Item -LiteralPath $Link -Force -ErrorAction SilentlyContinue
    if ($null -eq $item -or $null -eq $item.Target) { return $false }
    $t = $item.Target; if ($t -is [array]) { $t = $t[0] }
    try {
        return ([IO.Path]::GetFullPath(([string]$t).TrimStart('\','?')) -ieq [IO.Path]::GetFullPath($Target))
    } catch { return $false }
}

function Sync-LiveCopy {
    # setup.ps1 falls back to COPYING file targets when symlinks are unavailable.
    # If the live file is not a symlink to the repo copy, mirror the repo file there.
    param([string]$RepoFile, [string]$LiveFile, [string]$Label)
    if (-not (Test-Path -LiteralPath $LiveFile)) { return }
    if (Test-IsSymlinkTo $LiveFile $RepoFile) { return }
    Copy-Item -LiteralPath $RepoFile -Destination $LiveFile -Force
    Write-Host "  synced live copy: $LiveFile ($Label; not a symlink to the repo)"
}

function Resolve-PackName([string]$Query) {
    $packs = Get-InstalledPacks
    $exact = $packs | Where-Object { $_.BaseName -eq $Query }
    if ($exact) { return $exact[0].BaseName }
    $prefix = @($packs | Where-Object { $_.BaseName -like "$Query*" })
    if ($prefix.Count -eq 1) { return $prefix[0].BaseName }
    if ($prefix.Count -gt 1) {
        throw "'$Query' is ambiguous: $($prefix.BaseName -join ', ')"
    }
    throw "no installed themepack matches '$Query'. Run 'theme.ps1 -List' or 'theme.ps1 -Search $Query'."
}

function Install-Pack {
    param([Parameter(Mandatory)]$Pack, [string]$Origin)
    $errors = Test-Themepack $Pack -ExistingNames @((Get-InstalledPacks).BaseName)
    if ($errors.Count) {
        Write-Host "themepack failed validation:" -ForegroundColor Red
        $errors | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
        exit 1
    }
    if (-not (Test-Path $themesDir)) { New-Item -ItemType Directory -Path $themesDir | Out-Null }
    $dest = Join-Path $themesDir "$($Pack.name).json"
    # Re-serialize with $schema stamped in.
    $packOut = [ordered]@{ '$schema' = $schemaUrl }
    foreach ($prop in $Pack.PSObject.Properties) { $packOut[$prop.Name] = $prop.Value }
    Write-JsonFile $dest ([pscustomobject]$packOut)
    Write-Host "installed themepack '$($Pack.name)' -> $dest" -ForegroundColor Green
    if ($Origin) { Write-Host "  from: $Origin" }
    Write-Host "apply it with: theme.cmd $($Pack.name)"
}

function Apply-Pack([string]$PackName) {
    $path = Join-Path $themesDir "$PackName.json"
    $pack = Read-JsonFile $path
    $errors = Test-Themepack $pack -AllowName $PackName
    if ($errors.Count) {
        Write-Host "themepack '$PackName' failed validation:" -ForegroundColor Red
        $errors | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
        exit 1
    }
    $merged = Merge-Themepack $pack

    Write-Host "applying themepack '$PackName'..." -ForegroundColor Cyan

    # --- (a) Neovim ---
    $header = "-- Generated by scripts/theme.ps1 from themepack '$PackName' -- do not edit; run theme.cmd to switch."
    [IO.File]::WriteAllText($nvimSpec, "$header`n$($merged.nvimSpec.TrimEnd())`n", [Text.UTF8Encoding]::new($false))
    Write-Host "  nvim:    wrote $nvimSpec"

    # --- (b) pi agent ---
    if (-not (Test-Path $piThemeDir)) { New-Item -ItemType Directory -Path $piThemeDir -Force | Out-Null }
    $piThemePath = Join-Path $piThemeDir "$PackName.json"
    Write-JsonFile $piThemePath ([pscustomobject]$merged.piTheme)
    Write-Host "  pi:      wrote $piThemePath"

    $piCfg = Read-JsonFile $piSettings
    $piCfg.theme = $PackName
    Write-JsonFile $piSettings $piCfg
    Write-Host "  pi:      settings.json theme = '$PackName'"

    # --- (c) Windows Terminal ---
    $wtCfg = Read-JsonFile $wtSettings
    $scheme = [pscustomobject]$merged.wtScheme
    $schemeName = $scheme.name

    $schemes = @($wtCfg.schemes)
    $existing = $schemes | Where-Object { $_.name -eq $schemeName }
    if ($existing) {
        $idx = [Array]::IndexOf($schemes, $existing[0])
        $schemes[$idx] = $scheme
    } else {
        $schemes = @($schemes) + $scheme
    }
    $wtCfg.schemes = @($schemes)

    if ($null -eq $wtCfg.profiles.defaults) {
        $wtCfg.profiles | Add-Member -NotePropertyName defaults -NotePropertyValue ([pscustomobject]@{})
    }
    if ($wtCfg.profiles.defaults -is [hashtable] -or
        $wtCfg.profiles.defaults -is [System.Collections.Specialized.OrderedDictionary]) {
        $wtCfg.profiles.defaults = [pscustomobject]$wtCfg.profiles.defaults
    }
    $wtCfg.profiles.defaults | Add-Member -NotePropertyName colorScheme -NotePropertyValue $schemeName -Force

    # per-profile colorScheme on the PowerShell profile is now redundant
    foreach ($prof in @($wtCfg.profiles.list)) {
        if ($prof.name -eq 'Windows PowerShell' -and
            $prof.PSObject.Properties.Match('colorScheme').Count -gt 0) {
            $prof.PSObject.Properties.Remove('colorScheme')
        }
    }

    Write-JsonFile $wtSettings $wtCfg
    Write-Host "  wt:      scheme '$schemeName' registered; profiles.defaults.colorScheme set"

    # --- (d) live copies (setup.ps1 copy fallback) ---
    Sync-LiveCopy $piSettings $piLive 'pi settings'
    if (Test-Path -LiteralPath $wtLive) {
        Sync-LiveCopy $wtSettings $wtLive 'Windows Terminal settings'
    }

    Write-Host ""
    Write-Host "done. Notes:" -ForegroundColor Green
    Write-Host "  - Windows Terminal reloads settings.json automatically (new tabs/panes)."
    Write-Host "  - Neovim applies on next start (lazy.nvim installs new plugins automatically)."
    Write-Host "  - pi picks the new theme on next start (or select it via /settings)."
}

function Show-PackList {
    $packs = Get-InstalledPacks
    if (-not $packs.Count) {
        Write-Host "no themepacks installed in $themesDir"
        Write-Host "discover online with: theme.cmd -Search <query>"
        return
    }
    $current = $null
    try { $current = (Read-JsonFile $piSettings).theme } catch {}
    foreach ($p in $packs) {
        $obj = Read-JsonFile $p.FullName
        $mark = if ($p.BaseName -eq $current) { ' *' } else { '  ' }
        $desc = if ($obj.description) { " - $($obj.description)" } else { '' }
        Write-Host ("{0} {1}{2}" -f $mark, $p.BaseName, $desc)
    }
    if ($current) { Write-Host "`n* = currently active" }
}

function Show-Current {
    $current = (Read-JsonFile $piSettings).theme
    $wtCurrent = (Read-JsonFile $wtSettings).profiles.defaults.colorScheme
    Write-Host "pi theme:                $current"
    Write-Host "wt profiles.defaults:    $wtCurrent"
    $nvimHead = (Get-Content $nvimSpec -TotalCount 1)
    Write-Host "nvim colorscheme.lua:    $nvimHead"
}

function Invoke-Search([string]$Query) {
    Write-Host "fetching scheme list from tinted-theming/schemes..." -ForegroundColor Cyan
    $entries = Invoke-RestMethod 'https://api.github.com/repos/tinted-theming/schemes/contents/base16' `
        -Headers @{ 'User-Agent' = 'envlinks-theme' }
    $files = @($entries | Where-Object { $_.name -like '*.yaml' })
    if (-not [string]::IsNullOrWhiteSpace($Query)) {
        $files = @($files | Where-Object { ($_.name -replace '\.yaml$','') -like "*$Query*" })
    }
    if (-not $files.Count) {
        Write-Host "no schemes match '$Query'"
        return
    }
    Write-Host "$($files.Count) scheme(s):"
    for ($i = 0; $i -lt $files.Count; $i++) {
        Write-Host ("  [{0}] {1}" -f ($i + 1), ($files[$i].name -replace '\.yaml$',''))
    }
    $choice = Read-Host "number to install (blank to cancel)"
    if ([string]::IsNullOrWhiteSpace($choice)) { return }
    $n = 0
    if (-not [int]::TryParse($choice, [ref]$n) -or $n -lt 1 -or $n -gt $files.Count) {
        throw "invalid selection: $choice"
    }
    $sel = $files[$n - 1]
    $rawUrl = $sel.download_url   # API-provided URL; robust against default-branch renames
    Write-Host "downloading $rawUrl"
    $yaml = (Invoke-WebRequest $rawUrl -UseBasicParsing -Headers @{ 'User-Agent' = 'envlinks-theme' }).Content
    $pack = ConvertFrom-Base16Yaml $yaml -Source $rawUrl
    Install-Pack $pack -Origin $rawUrl
}

function Invoke-Validate([string]$Target) {
    if ($Target -match '^https?://') {
        Write-Host "fetching $Target"
        $text = (Invoke-WebRequest $Target -UseBasicParsing -Headers @{ 'User-Agent' = 'envlinks-theme' }).Content
        if ($Target -match '\.ya?ml$') {
            $pack = ConvertFrom-Base16Yaml $text -Source $Target
        } else {
            $pack = $text | ConvertFrom-Json
        }
    } else {
        $pack = Read-JsonFile $Target
    }

    $errors = Test-Themepack $pack -AllowName ([string]$pack.name)
    if ($errors.Count) {
        Write-Host "INVALID themepack:" -ForegroundColor Red
        $errors | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
        exit 1
    }

    $merged = Merge-Themepack $pack
    Write-Host "themepack '$($pack.name)' is valid." -ForegroundColor Green
    Write-Host ""
    Write-Host "--- Windows Terminal scheme ---" -ForegroundColor Cyan
    $merged.wtScheme | ConvertTo-Json -Depth 5
    Write-Host "--- pi theme (derived) ---" -ForegroundColor Cyan
    $merged.piTheme | ConvertTo-Json -Depth 5
    Write-Host "--- nvim colorscheme.lua ---" -ForegroundColor Cyan
    Write-Host $merged.nvimSpec
    exit 0
}

function Invoke-SelfTest {
    $fail = 0
    $packs = Get-InstalledPacks
    if (-not $packs.Count) {
        Write-Host "no themepacks installed - nothing to test" -ForegroundColor Yellow
        exit 0
    }
    foreach ($p in $packs) {
        $pack = Read-JsonFile $p.FullName
        $errors = Test-Themepack $pack -AllowName $p.BaseName
        if ($p.BaseName -ne [string]$pack.name) {
            $errors += "filename '$($p.BaseName).json' does not match pack name '$($pack.name)'"
        }
        if ($errors.Count) {
            $fail++
            Write-Host "FAIL $($p.BaseName)" -ForegroundColor Red
            $errors | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
            continue
        }
        # determinism: derive twice, compare
        $a = (Merge-Themepack $pack).piTheme | ConvertTo-Json -Depth 10 -Compress
        $b = (Merge-Themepack $pack).piTheme | ConvertTo-Json -Depth 10 -Compress
        if ($a -ne $b) {
            $fail++
            Write-Host "FAIL $($p.BaseName): derivation is not deterministic" -ForegroundColor Red
            continue
        }
        Write-Host "ok   $($p.BaseName)" -ForegroundColor Green
    }
    if ($fail) { Write-Host "`n$fail pack(s) failed" -ForegroundColor Red; exit 1 }
    Write-Host "`nall $($packs.Count) themepack(s) valid" -ForegroundColor Green
    exit 0
}

# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------

switch ($PSCmdlet.ParameterSetName) {
    'List'       { Show-PackList; break }
    'Current'    { Show-Current; break }
    'Add'        {
        $text = (Invoke-WebRequest $Add -UseBasicParsing -Headers @{ 'User-Agent' = 'envlinks-theme' }).Content
        $pack = $text | ConvertFrom-Json
        Install-Pack $pack -Origin $Add
        break
    }
    'FromBase16' {
        $yaml = (Invoke-WebRequest $FromBase16 -UseBasicParsing -Headers @{ 'User-Agent' = 'envlinks-theme' }).Content
        $pack = ConvertFrom-Base16Yaml $yaml -Source $FromBase16 -NameOverride $As
        Install-Pack $pack -Origin $FromBase16
        break
    }
    'Search'     { Invoke-Search $Search; break }
    'Validate'   { Invoke-Validate $Validate; break }
    'SelfTest'   { Invoke-SelfTest; break }
    'Help'       { Get-Help $PSCommandPath; break }
    'Apply'      {
        if ([string]::IsNullOrWhiteSpace($Name)) {
            # interactive menu
            $packs = Get-InstalledPacks
            if (-not $packs.Count) {
                Write-Host "no themepacks installed. Discover online: theme.cmd -Search <query>"
                exit 1
            }
            $current = $null
            try { $current = (Read-JsonFile $piSettings).theme } catch {}
            Write-Host "available themepacks:"
            for ($i = 0; $i -lt $packs.Count; $i++) {
                $mark = if ($packs[$i].BaseName -eq $current) { ' *' } else { '  ' }
                Write-Host ("  [{0}]{1} {2}" -f ($i + 1), $mark, $packs[$i].BaseName)
            }
            $choice = Read-Host "number or name (blank to cancel)"
            if ([string]::IsNullOrWhiteSpace($choice)) { exit 0 }
            $n = 0
            if ([int]::TryParse($choice, [ref]$n) -and $n -ge 1 -and $n -le $packs.Count) {
                $Name = $packs[$n - 1].BaseName
            } else {
                $Name = Resolve-PackName $choice
            }
        } else {
            $Name = Resolve-PackName $Name
        }
        Apply-Pack $Name
        break
    }
}
