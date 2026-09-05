# validate.ps1 - hand-rolled themepack validation (Windows PowerShell 5.1 safe;
# no dependency on PS7 Test-Json -SchemaFile).
# Dot-sourced by theme.ps1 after derive.ps1.

$script:Base16Keys = @('base00','base01','base02','base03','base04','base05','base06','base07',
                       'base08','base09','base0A','base0B','base0C','base0D','base0E','base0F')

$script:WtColorKeys = @('background','foreground','cursorColor','selectionBackground',
                        'black','red','green','yellow','blue','purple','cyan','white',
                        'brightBlack','brightRed','brightGreen','brightYellow',
                        'brightBlue','brightPurple','brightCyan','brightWhite')

function Test-IsHex([string]$s) {
    return ($null -ne $s -and $s -match '^#[0-9a-fA-F]{6}$')
}

function Test-IsPiColor($v, [string[]]$VarNames) {
    # Valid pi color: hex, 0-255 index, var reference, or "" (terminal default).
    if ($null -eq $v) { return $false }
    if ($v -is [int] -or $v -is [long]) { return ($v -ge 0 -and $v -le 255) }
    $s = [string]$v
    if ($s -eq '') { return $true }
    if (Test-IsHex $s) { return $true }
    if ($s -match '^\d{1,3}$' -and [int]$s -le 255) { return $true }
    return ($VarNames -contains $s)
}

function Test-Themepack {
    # Returns @() when valid, otherwise @(error strings).
    param(
        [Parameter(Mandatory)]$Pack,
        [string[]]$ExistingNames = @(),   # installed pack slugs (uniqueness check)
        [string]$AllowName                 # name exempt from the uniqueness check (self)
    )
    $errors = New-Object System.Collections.Generic.List[string]

    if ($null -eq $Pack) { return @('pack is null') }

    # --- name ---
    $name = [string]$Pack.name
    if ([string]::IsNullOrWhiteSpace($name)) {
        $errors.Add('missing required field: name')
    } elseif ($name -notmatch '^[a-z0-9-]+$') {
        $errors.Add("name '$name' must match ^[a-z0-9-]+$ (lowercase slug)")
    } elseif ($name -ne $AllowName -and ($ExistingNames -contains $name)) {
        $errors.Add("a themepack named '$name' is already installed")
    }

    # --- palette ---
    $hasPalette = ($null -ne $Pack.palette)
    if ($hasPalette) {
        foreach ($k in $script:Base16Keys) {
            $v = $Pack.palette.$k
            if (-not (Test-IsHex ([string]$v))) {
                $errors.Add("palette.$k must be a #rrggbb hex color (got '$v')")
            }
        }
    }

    # --- nvim ---
    $engine = $null
    $hasPluginSpec = $false
    if ($null -ne $Pack.nvim) {
        $engine = [string]$Pack.nvim.engine
        if ($engine -notin @('mini-base16', 'plugin')) {
            $errors.Add("nvim.engine must be 'mini-base16' or 'plugin' (got '$engine')")
        }
        $hasPluginSpec = -not [string]::IsNullOrWhiteSpace([string]$Pack.nvim.spec)
        if ($engine -eq 'plugin' -and -not $hasPluginSpec) {
            $errors.Add("nvim.engine=plugin requires a non-empty nvim.spec (Lua plugin table)")
        }
    }

    if (-not $hasPalette) {
        $errors.Add('missing required field: palette')
    }

    # --- wt overrides ---
    $hasWtColors = ($null -ne $Pack.wt -and $null -ne $Pack.wt.colors)
    if ($hasWtColors) {
        foreach ($prop in $Pack.wt.colors.PSObject.Properties) {
            if ($script:WtColorKeys -notcontains $prop.Name) {
                $errors.Add("wt.colors.$($prop.Name) is not a known Windows Terminal scheme key")
            } elseif (-not (Test-IsHex ([string]$prop.Value))) {
                $errors.Add("wt.colors.$($prop.Name) must be a #rrggbb hex color (got '$($prop.Value)')")
            }
        }
    }

    # --- merge + final artifact checks (only if structurally OK so far) ---
    if ($errors.Count -eq 0) {
        $merged = Merge-Themepack $Pack

        # pi theme: all tokens present with valid colors
        $varNames = @($merged.piTheme.vars.PSObject.Properties.Name)
        if ($merged.piTheme.vars -is [System.Collections.Specialized.OrderedDictionary] -or
            $merged.piTheme.vars -is [hashtable]) {
            $varNames = @($merged.piTheme.vars.Keys)
        }
        foreach ($tok in $script:PiRequiredTokens) {
            $v = $merged.piTheme.colors[$tok]
            if ($null -eq $v -and $merged.piTheme.colors -isnot [System.Collections.Specialized.OrderedDictionary] -and
                $merged.piTheme.colors -isnot [hashtable]) {
                $v = $merged.piTheme.colors.$tok
            }
            if ($null -eq $v) {
                $errors.Add("derived pi theme is missing token: $tok")
            } elseif (-not (Test-IsPiColor $v $varNames)) {
                $errors.Add("pi token '$tok' has invalid color value '$v'")
            }
        }

        # wt scheme: all 20 colors + name
        foreach ($k in $script:WtColorKeys) {
            if (-not (Test-IsHex ([string]$merged.wtScheme[$k]))) {
                $errors.Add("derived WT scheme has invalid/missing color: $k")
            }
        }
        if ([string]::IsNullOrWhiteSpace([string]$merged.wtScheme['name'])) {
            $errors.Add('derived WT scheme has no name')
        }

        # nvim spec present
        if ([string]::IsNullOrWhiteSpace([string]$merged.nvimSpec)) {
            $errors.Add('no nvim spec could be derived or found')
        }
    }

    return @($errors)
}

function Merge-Themepack {
    # Applies "explicit overrides win; derive the rest from palette".
    # Returns @{ nvimSpec; piTheme (ordered); wtScheme (ordered) }.
    param([Parameter(Mandatory)]$Pack)

    $name = [string]$Pack.name
    $palette = $Pack.palette

    # nvim
    if ($null -ne $Pack.nvim -and $Pack.nvim.engine -eq 'plugin' -and
        -not [string]::IsNullOrWhiteSpace([string]$Pack.nvim.spec)) {
        $nvimSpec = [string]$Pack.nvim.spec
    } elseif ($null -ne $palette) {
        $nvimSpec = Get-DefaultNvimSpec $palette
    } else {
        $nvimSpec = $null
    }

    # pi
    if ($null -ne $palette) {
        $piTheme = Get-DefaultPiTheme $palette $name
    } else {
        $piTheme = [ordered]@{
            '$schema' = 'https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json'
            name      = $name
            vars      = [ordered]@{}
            colors    = [ordered]@{}
        }
    }
    if ($null -ne $Pack.pi -and $null -ne $Pack.pi.vars) {
        foreach ($prop in $Pack.pi.vars.PSObject.Properties) {
            $piTheme.vars[$prop.Name] = $prop.Value
        }
    }
    if ($null -ne $Pack.pi -and $null -ne $Pack.pi.colors) {
        foreach ($prop in $Pack.pi.colors.PSObject.Properties) {
            $piTheme.colors[$prop.Name] = $prop.Value
        }
    }

    # wt
    $wtName = $name
    if ($null -ne $Pack.wt -and -not [string]::IsNullOrWhiteSpace([string]$Pack.wt.name)) {
        $wtName = [string]$Pack.wt.name
    }
    if ($null -ne $palette) {
        $wtScheme = Get-DefaultWtScheme $palette $wtName
    } else {
        $wtScheme = [ordered]@{ name = $wtName }
    }
    if ($null -ne $Pack.wt -and $null -ne $Pack.wt.colors) {
        foreach ($prop in $Pack.wt.colors.PSObject.Properties) {
            $wtScheme[$prop.Name] = $prop.Value
        }
    }

    return @{ nvimSpec = $nvimSpec; piTheme = $piTheme; wtScheme = $wtScheme }
}
