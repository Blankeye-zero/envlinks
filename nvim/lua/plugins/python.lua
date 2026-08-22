-- ~/.config/nvim/lua/plugins/python.lua
return {
    -- Virtualenv selector: auto-detects uv's .venv on file open
    {
        "linux-cultist/venv-selector.nvim",
        dependencies = { "neovim/nvim-lspconfig" },
        event = "VeryLazy",
        opts = {
            settings = {
                options = {
                    notify_user_on_venv_activation = true,
                },
            },
        },
        keys = {
            { "<leader>cv", "<cmd>VenvSelect<cr>", desc = "Select Python venv" },
        },
    },

    -- uv workflow: run files, add/remove packages, manage venvs
    {
        "benomahony/uv.nvim",
        event = "VeryLazy",
        opts = {
            auto_activate_venv = true, -- activates .venv on Neovim start
            picker_integration = true, -- set true if using Telescope/Snacks
        },
        -- default keymaps are <leader>x prefix:
        -- <leader>xr  = run current file
        -- <leader>xs  = run selection (visual mode)
        -- <leader>xa  = uv add <package>
        -- <leader>xd  = uv remove <package>
        -- <leader>xi  = uv init
        -- <leader>xc  = uv sync
    },
}
