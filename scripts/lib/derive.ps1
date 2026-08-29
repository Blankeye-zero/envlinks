# derive.ps1 - deterministic default derivation from a base16 palette.
# Dot-sourced by theme.ps1. Pure functions: no file I/O, no network.

# --- palette helpers ---------------------------------------------------------

function Get-PaletteMap {
    # Normalizes a themepack palette into an ordered hashtable base00..base0F.
    param([Parameter(Mandatory)]$Palette)
    $keys = @('base00','base01','base02','base03','base04','base05','base06','base07',
              'base08','base09','base0A','base0B','base0C','base0D','base0E','base0F')
    $map = [ordered]@{}
    foreach ($k in $keys) {
        $v = $Palette.$k
        if ($null -eq $v) { $v = $Palette.PSObject.Properties[$k].Value }
        $map[$k] = [string]$v
    }
    return $map
}

# --- Windows Terminal --------------------------------------------------------

function Get-DefaultWtScheme {
    # base16 -> Windows Terminal scheme (mirrors tinted-theming/base16-windows-terminal).
    param(
        [Parameter(Mandatory)]$Palette,
        [Parameter(Mandatory)][string]$Name
    )
    $p = Get-PaletteMap $Palette
    return [ordered]@{
        name                = $Name
        background          = $p.base00
        foreground          = $p.base05
        cursorColor         = $p.base05  # fg, not accent: pi draws its own fg-colored caret and can't be themed, so keep the terminal cursor consistent with it (WT ignores nvim's OSC 12 anyway). Override per-pack via wt.colors.cursorColor.
        selectionBackground = $p.base02
        black               = $p.base00
        red                 = $p.base08
        green               = $p.base0B
        yellow              = $p.base0A
        blue                = $p.base0D
        purple              = $p.base0E
        cyan                = $p.base0C
        white               = $p.base05
        brightBlack         = $p.base03
        brightRed           = $p.base09
        brightGreen         = $p.base0B
        brightYellow        = $p.base0A
        brightBlue          = $p.base0D
        brightPurple        = $p.base0E
        brightCyan          = $p.base0C
        brightWhite         = $p.base07
    }
}

# --- pi agent ----------------------------------------------------------------

$script:PiRequiredTokens = @(
    # Core UI (11)
    'accent','border','borderAccent','borderMuted','success','error','warning',
    'muted','dim','text','thinkingText',
    # Backgrounds & content (14)
    'selectedBg','scrollbarThumb','searchMatchBg','searchMatchText',
    'userMessageBg','userMessageText','customMessageBg','customMessageText',
    'customMessageLabel','toolPendingBg','toolSuccessBg','toolErrorBg',
    'toolTitle','toolOutput',
    # Markdown (10)
    'mdHeading','mdLink','mdLinkUrl','mdCode','mdCodeBlock','mdCodeBlockBorder',
    'mdQuote','mdQuoteBorder','mdHr','mdListBullet',
    # Tool diffs (3)
    'toolDiffAdded','toolDiffRemoved','toolDiffContext',
    # Syntax (9)
    'syntaxComment','syntaxKeyword','syntaxFunction','syntaxVariable','syntaxString',
    'syntaxNumber','syntaxType','syntaxOperator','syntaxPunctuation',
    # Thinking levels (7)
    'thinkingOff','thinkingMinimal','thinkingLow','thinkingMedium','thinkingHigh',
    'thinkingXhigh','thinkingMax',
    # Bash mode (1)
    'bashMode'
)

function Get-DefaultPiTheme {
    # base16 -> complete pi theme (all 51 tokens), referencing palette vars.
    param(
        [Parameter(Mandatory)]$Palette,
        [Parameter(Mandatory)][string]$Name
    )
    $p = Get-PaletteMap $Palette

    $vars = [ordered]@{}
    foreach ($k in $p.Keys) { $vars[$k] = $p[$k] }

    $colors = [ordered]@{
        # Core UI
        accent             = 'base0E'
        border             = 'base02'
        borderAccent       = 'base0E'
        borderMuted        = 'base01'
        success            = 'base0B'
        error              = 'base08'
        warning            = 'base0A'
        muted              = 'base04'
        dim                = 'base03'
        text               = ''
        thinkingText       = 'base06'
        # Backgrounds & content
        selectedBg         = 'base01'
        scrollbarThumb     = 'base02'
        searchMatchBg      = 'base02'
        searchMatchText    = 'base06'
        userMessageBg      = 'base01'
        userMessageText    = ''
        customMessageBg    = 'base01'
        customMessageText  = ''
        customMessageLabel = 'base0D'
        toolPendingBg      = 'base01'
        toolSuccessBg      = 'base01'
        toolErrorBg        = 'base01'
        toolTitle          = 'base0D'
        toolOutput         = ''
        # Markdown
        mdHeading          = 'base0E'
        mdLink             = 'base0D'
        mdLinkUrl          = 'base0C'
        mdCode             = 'base09'
        mdCodeBlock        = ''
        mdCodeBlockBorder  = 'base02'
        mdQuote            = 'base04'
        mdQuoteBorder      = 'base02'
        mdHr               = 'base02'
        mdListBullet       = 'base0E'
        # Tool diffs
        toolDiffAdded      = 'base0B'
        toolDiffRemoved    = 'base08'
        toolDiffContext    = 'base04'
        # Syntax highlighting
        syntaxComment      = 'base03'
        syntaxKeyword      = 'base0E'
        syntaxFunction     = 'base0D'
        syntaxVariable     = 'base08'
        syntaxString       = 'base0B'
        syntaxNumber       = 'base09'
        syntaxType         = 'base0A'
        syntaxOperator     = 'base0C'
        syntaxPunctuation  = 'base05'
        # Thinking level borders (blue -> cyan -> green -> yellow -> orange -> red)
        thinkingOff        = 'base04'
        thinkingMinimal    = 'base0D'
        thinkingLow        = 'base0C'
        thinkingMedium     = 'base0B'
        thinkingHigh       = 'base0A'
        thinkingXhigh      = 'base09'
        thinkingMax        = 'base08'
        # Bash mode
        bashMode           = 'base0A'
    }

    return [ordered]@{
        '$schema' = 'https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json'
        name      = $Name
        vars      = $vars
        colors    = $colors
    }
}

# --- Neovim ------------------------------------------------------------------

function Get-DefaultNvimSpec {
    # base16 -> lazy.nvim spec using mini.base16 (renders any base16 palette,
    # no per-scheme plugin required).
    param([Parameter(Mandatory)]$Palette)
    $p = Get-PaletteMap $Palette

    # NOTE: keep key case exactly (base0A etc.) - Lua table keys are case-sensitive
    # and mini.base16 validates against the exact base16 names.
    $paletteLines = ($p.Keys | ForEach-Object { "                $_ = `"$($p[$_])`"" }) -join ",`n"

    return @"
return {
    {
        "echasnovski/mini.base16",
        version = false,
        lazy = false,    -- load during startup, not on-demand
        priority = 1000, -- load before all other plugins
        config = function()
            require("mini.base16").setup({
                palette = {
$paletteLines
                },
            })
            -- mini.base16 applies the palette during setup(); no colorscheme command needed.
            vim.g.colors_name = "envlinks-base16"
        end,
    },
}
"@
}
