# envlinks

Links app config locations to this repo (see `setup.ps1`): Neovim, pi agent,
Windows Terminal. Colorschemes for all three are managed together with
`theme.cmd`.

## theme.cmd — one colorscheme everywhere

```cmd
theme.cmd                          interactive menu of installed themepacks
theme.cmd nord                     apply an installed themepack
theme.cmd -List                    list installed themepacks
theme.cmd -Current                 show the active scheme
theme.cmd -Search gruvbox          search tinted-theming/schemes online, pick, install
theme.cmd -FromBase16 <yaml-url>   install any base16 scheme straight from a URL
theme.cmd -Add <json-url>          install a themepack from a URL
theme.cmd -Validate <url-or-file>  test a themepack: validate + show derived
                                   WT/pi/nvim output, without applying
theme.cmd -SelfTest                validate all installed themepacks
```

Applying a pack updates:

| App | What changes | Takes effect |
|---|---|---|
| Neovim | `nvim/lua/plugins/colorscheme.lua` rewritten | next nvim start (lazy.nvim auto-installs) |
| pi agent | `pi-agent/themes/<name>.json` written; `theme` set in `pi-agent/settings.json` | next pi start (or `/settings`) |
| Windows Terminal | scheme upserted into `windows-terminal/settings.json`; `profiles.defaults.colorScheme` set | live (WT auto-reloads) |

## Themepack v1 — the URL-addressable format

A themepack is a single JSON file, hosted anywhere (raw GitHub, gist, …) or kept
locally in `scripts/themes/`. Schema: `scripts/schemas/themepack-v1.schema.json`.

The color standard is **base16 / Tinted Theming**: 16 roles
(`base00`–`base0F`), which map deterministically onto all three apps. Explicit
per-target overrides win over the derived defaults — **a pack with only a
palette is complete**.

Minimal example (palette-driven; nvim uses `mini.base16`):

```json
{
  "$schema": "https://raw.githubusercontent.com/earendil-works/envlinks/main/scripts/schemas/themepack-v1.schema.json",
  "name": "my-theme",
  "description": "what it looks like",
  "source": "https://github.com/tinted-theming/schemes",
  "palette": {
    "base00": "#1a1b26", "base01": "#16161e", "base02": "#2f3549", "base03": "#444b6a",
    "base04": "#787c99", "base05": "#a9b1d6", "base06": "#cbccd1", "base07": "#d5d6db",
    "base08": "#c0caf5", "base09": "#a9b1d6", "base0A": "#0db9d7", "base0B": "#9ece6a",
    "base0C": "#b4f9f8", "base0D": "#2ac3de", "base0E": "#bb9af7", "base0F": "#f7768e"
  },
  "nvim": { "engine": "mini-base16" }
}
```

Optional overrides:

- `"nvim": { "engine": "plugin", "spec": "<lua table>" }` — full-fidelity nvim
  plugin spec (e.g. catppuccin) written verbatim to `colorscheme.lua`.
- `"pi": { "vars": {...}, "colors": { "accent": "#..." } }` — sparse pi token
  overrides merged over the derived 51-token theme (or a full explicit theme).
- `"wt": { "name": "Display Name", "colors": { "cursorColor": "#..." } }` —
  sparse overrides over the derived 20-color Windows Terminal scheme.

### Discovering themes online

Hundreds of ready-to-use base16 schemes live at predictable URLs:

```
https://raw.githubusercontent.com/tinted-theming/schemes/spec-0.11/base16/<name>.yaml
```

`theme.cmd -Search <query>` lists and installs them interactively;
`-FromBase16 <url>` converts any such YAML into a themepack
(palette + `mini-base16` engine). To author your own, copy the example above,
host it anywhere, and share the URL — `theme.cmd -Validate <url>` is the
test loop.

## Setup

Run `setup.ps1` once per machine to link the configs. If symlinks are
unavailable it copies files instead; `theme.ps1` detects that and syncs the
live copies on every apply.
