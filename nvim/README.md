# Requirements

System dependencies this config needs beyond Neovim itself.

See `installables.md` for complete installation commands (winget/alternative methods).

## Core

- **Neovim 0.11+** (developed against 0.12). Native `vim.lsp.config`/`vim.lsp.enable`
  and the `:lsp` command are used instead of `nvim-lspconfig`'s old `setup()`/`:LspInfo`
  API — see `lua/plugins/lsp.lua`.
- **git** — required by `lazy.nvim` to bootstrap and update plugins.
