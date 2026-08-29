# import-base16.ps1 - converts a tinted-theming / base16 scheme YAML (flat
# key: value format) into a themepack object.
# Dot-sourced by theme.ps1.

function ConvertFrom-Base16Yaml {
    # Parses flat base16 scheme YAML:
    #   scheme: "Nord"
    #   author: "..."
    #   base00: "2e3440"   # or "#2e3440", quoted or not
    # Returns a themepack-compatible object (palette + mini-base16 engine).
    param(
        [Parameter(Mandatory)][string]$Text,
        [string]$Source,
        [string]$NameOverride
    )

    $fields = @{}
    foreach ($line in ($Text -split "`r?`n")) {
        # match: key: value   (value double-quoted, single-quoted, or bare; trailing comment allowed)
        if ($line -match '^\s*([A-Za-z0-9_]+)\s*:\s*(?:"([^"]*)"|''([^'']*)''|([^#\s]+))\s*(#.*)?$') {
            $key = $Matches[1]
            $val = @($Matches[2], $Matches[3], $Matches[4]) | Where-Object { $null -ne $_ } | Select-Object -First 1
            if ($null -ne $val -and -not $fields.ContainsKey($key)) { $fields[$key] = ([string]$val).Trim() }
        }
    }

    if ($fields.ContainsKey('system') -and $fields['system'] -ne 'base16') {
        throw "unsupported scheme system '$($fields['system'])' (only base16 is supported; base24 is not)"
    }

    $palette = [ordered]@{}
    foreach ($k in $script:Base16Keys) {
        $raw = $fields[$k]
        if ($null -eq $raw) { throw "base16 YAML is missing required color: $k" }
        $hex = $raw.TrimStart('#')
        if ($hex -notmatch '^[0-9a-fA-F]{6}$') {
            throw "base16 YAML color $k is not a 6-digit hex value: '$raw'"
        }
        $palette[$k] = "#$($hex.ToLower())"
    }

    # Display name: tinted-theming uses "name", classic base16 uses "scheme".
    $displayName = $fields['name']
    if ([string]::IsNullOrWhiteSpace($displayName)) { $displayName = $fields['scheme'] }
    if ([string]::IsNullOrWhiteSpace($displayName)) { $displayName = $fields['slug'] }
    if ([string]::IsNullOrWhiteSpace($displayName)) { $displayName = 'imported-base16' }

    $slug = if (-not [string]::IsNullOrWhiteSpace($NameOverride)) {
        $NameOverride
    } elseif (-not [string]::IsNullOrWhiteSpace($fields['slug'])) {
        ($fields['slug'].ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
    } else {
        ($displayName.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
    }

    $pack = [ordered]@{
        name        = $slug
        description = "base16 scheme '$displayName' (imported)"
        nvim        = [ordered]@{ engine = 'mini-base16' }
        palette     = $palette
        wt          = [ordered]@{ name = $displayName }
    }
    if (-not [string]::IsNullOrWhiteSpace($fields['author'])) { $pack['author'] = $fields['author'] }
    if (-not [string]::IsNullOrWhiteSpace($Source)) { $pack['source'] = $Source }

    return [pscustomobject]$pack
}
