> **Automated install:** every winget package below can be installed in one shot with
> `powershell -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%\Projects\envlinks\scripts\install-deps.ps1`
> (add `-NvimOnly` to skip the general dev tools). Non-winget items remain manual (see script output).

- nvm-windows - `winget install CoreyButler.NVMforWindows`
- Node.js - via nvm: `nvm install 24.18.0` then `nvm use 24.18.0` (not winget)
- pnpm - `winget install pnpm.pnpm`
- Python 3.X - `winget install Python.Python.3.13`
- 0xProto Font - Not in winget (download manually from GitHub)
- Obsidian - `winget install Obsidian.Obsidian`
- Bruno - `winget install Bruno.Bruno`
- MongoDB - `winget install MongoDB.Server`
- PostgreSQL - `winget install PostgreSQL.PostgreSQL.17`
- Docker Desktop - `winget install Docker.DockerDesktop`
- VS Build Tools - `winget install Microsoft.VisualStudio.2022.BuildTools`
- LLVM 22 - `winget install LLVM.LLVM`
- Flutter & Dart - Dart SDK: `winget install Google.DartSDK`, then `dart pub global activate flutter` or install from flutter.dev
- FVM - `dart pub global activate fvm`
- Aseprite - Not in winget (paid software, download from aseprite.org)
- Neovim - `winget install Neovim.Neovim`
- Crush Agent Harness - `winget install charmbracelet.crush`
- Pi Agent Harness - `powershell -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%\Projects\envlinks\scripts\build-pi.ps1` (clones, builds from source, then generates pi.cmd; requires Node 24)
- vcpkg - `git clone https://github.com/Microsoft/vcpkg.git`
- CMake - `winget install Kitware.CMake`

## Neovim Plugin Dependencies

### Required by LSP (mason-lspconfig)
- Go - `winget install GoLang.Go` (for gopls)
- Rust - `winget install Rustlang.Rustup` (for rust_analyzer)
- Terraform - `winget install Hashicorp.Terraform` (for terraformls)

### Required by Telescope
- ripgrep - `winget install BurntSushi.ripgrep.MSVC` (for live_grep)
- fd - `winget install sharkdp.fd` (for find_files performance)

### Required by Formatting (mason-tool-installer)
- StyLua - `winget install JohnnyMorganz.StyLua` (Lua formatter)
- Prettier - Auto-installed by Mason (JavaScript/TypeScript formatter)

### Required by Python Plugin (uv.nvim)
- uv - `winget install astral-sh.uv` (fast Python package manager)

### Required by Git Plugins
- Git - `winget install Git.Git` (for gitsigns/fugitive)
- GitHub CLI - `winget install GitHub.cli` (optional, for GitHub integration)

### Notes
- clangd, basedpyright, ruff, lua_ls, delve: Auto-installed by Mason
- Treesitter parsers: Auto-installed by nvim-treesitter
- Telescope fzf-native: Built automatically using CMake

