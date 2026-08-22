-- ~/.config/nvim/lua/plugins/colorscheme.lua
return {
    {
        "catppuccin/nvim",
        name = "catppuccin",
        priority = 1000, -- load before all other plugins
        lazy = false,    -- load during startup, not on-demand
        opts = {
            flavour = "macchiato", -- latte (light), frappe, macchiato, mocha (darkest)
            integrations = {
                treesitter = true,
                native_lsp = { enabled = true },
                blink_cmp = true,
                telescope = { enabled = true },
                mason = true,
                markdown = true,
                render_markdown = true,
            },
        },
        config = function(_, opts)
            require("catppuccin").setup(opts)
            vim.cmd.colorscheme("catppuccin")
        end,
    },
}
