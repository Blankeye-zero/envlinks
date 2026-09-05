-- ~/.config/nvim/lua/plugins/python.lua
return {
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
