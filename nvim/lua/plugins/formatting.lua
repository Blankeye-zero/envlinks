return {
  -- Auto-installs non-LSP tools via Mason (mason-lspconfig's ensure_installed only covers LSP servers)
  {
    "WhoIsSethDaniel/mason-tool-installer.nvim",
    dependencies = { "mason-org/mason.nvim" },
    opts = {
      ensure_installed = { "stylua", "prettierd", "prettier" },
    },
  },

  {
    "stevearc/conform.nvim",
    event = "BufWritePre",
    opts = {
      formatters_by_ft = {
        python = { "ruff_format" },
        lua    = { "stylua" },
        javascript = { "prettierd", "prettier", stop_after_first = true },
        typescript = { "prettierd", "prettier", stop_after_first = true },
        javascriptreact = { "prettierd", "prettier", stop_after_first = true },
        typescriptreact = { "prettierd", "prettier", stop_after_first = true },
        html = { "prettierd", "prettier", stop_after_first = true },
      },
      format_on_save = {
        timeout_ms = 3000,
        lsp_fallback = true,
      },
    },
  },
}
