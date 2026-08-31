-- ~/.config/nvim/lua/plugins/completion.lua
return {
  {
    "saghen/blink.cmp",
    version = "v1.*",   -- pin to stable
    opts = {
      keymap = {
        preset = "default",
        -- navigate the suggestion list with Ctrl+k / Ctrl+j
        ["<C-k>"] = { "select_prev", "fallback" },
        ["<C-j>"] = { "select_next", "fallback" },
        -- jump between snippet placeholders with Ctrl+h / Ctrl+l
        ["<C-h>"] = { "snippet_backward", "fallback" },
        ["<C-l>"] = { "snippet_forward", "fallback" },
        -- Tab accepts the selected suggestion
        ["<Tab>"] = { "accept", "fallback" },
      },
      appearance = {
        use_nvim_cmp_as_default = true,
        nerd_font_variant = "mono",
      },
      sources = {
        default = { "lsp", "path", "snippets", "buffer" },
      },
      -- Signature help while you type function args
      signature = { enabled = true },
    },
  },
}
