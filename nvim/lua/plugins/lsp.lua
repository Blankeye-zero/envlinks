-- ~/.config/nvim/lua/plugins/lsp.lua
return {
	-- LSP package manager
	{
		"mason-org/mason.nvim",
		opts = {},
	},

	-- Bridge: mason → lspconfig, auto-installs servers
	{
		"mason-org/mason-lspconfig.nvim",
		opts = {
			ensure_installed = {
				"basedpyright", -- Python type checking + go-to-def + inlay hints
				"ruff", -- Python linting + formatting
				"lua_ls", -- Neovim config editing
				"clangd", -- C/C++
				"gopls", -- Go
				"ts_ls", -- JavaScript/TypeScript
				"rust_analyzer", -- Rust
				"terraformls",
			},
		},
	},

	-- Connect Neovim to the installed LSP servers
	{
		"neovim/nvim-lspconfig",
		config = function()
			-- basedpyright: disable its own formatting (ruff handles that)
			vim.lsp.config("basedpyright", {
				settings = {
					basedpyright = {
						analysis = {
							typeCheckingMode = "standard",
							-- ruff handles unused imports/vars, tell pyright to ignore them
							ignore = { "*" },
						},
					},
				},
			})

			-- ruff LSP: linting + format-on-save via LSP
			vim.lsp.config("ruff", {
				init_options = {
					settings = {
						fixAll = true,
						organizeImports = true,
					},
				},
			})

			vim.lsp.config("lua_ls", {
				settings = {
					Lua = { diagnostics = { globals = { "vim" } } },
				},
			})

			-- clangd only auto-detects a compiler's system include paths (MSVC STL,
			-- Windows SDK, etc.) if it's allowed to invoke that compiler directly.
			-- Whitelist LLVM's bin dir so it can query clang++.exe, the compiler
			-- actually used by CMake, instead of falling back to generic defaults.
			vim.lsp.config("clangd", {
				cmd = { "clangd", "--query-driver=C:/Program Files/LLVM/bin/*.exe" },
			})

			vim.lsp.enable({
				"basedpyright",
				"ruff",
				"lua_ls",
				"clangd",
				"gopls",
				"ts_ls",
				"rust_analyzer",
				"terraformls",
			})

			-- Shared LSP keymaps, set on attach
			vim.api.nvim_create_autocmd("LspAttach", {
				callback = function(ev)
					local opts = { buffer = ev.buf, silent = true }
					vim.keymap.set("n", "gd", vim.lsp.buf.definition, opts)
					vim.keymap.set("n", "gr", vim.lsp.buf.references, opts)
					vim.keymap.set("n", "K", vim.lsp.buf.hover, opts)
					vim.keymap.set("n", "<leader>rn", vim.lsp.buf.rename, opts)
					vim.keymap.set("n", "<leader>ca", vim.lsp.buf.code_action, opts)
					vim.keymap.set("n", "[d", vim.diagnostic.goto_prev, opts)
					vim.keymap.set("n", "]d", vim.diagnostic.goto_next, opts)
					vim.keymap.set("n", "<leader>e", vim.diagnostic.open_float, opts)
				end,
			})
		end,
	},

	-- Flutter/Dart: manages dartls itself, plus run/hot-reload/device commands
	{
		"akinsho/flutter-tools.nvim",
		dependencies = { "nvim-lua/plenary.nvim" },
		ft = "dart",
		opts = {
			fvm = true, -- use the project's .fvm/flutter_sdk when present
		},
	},
}
