return {
    {
        "nvim-telescope/telescope.nvim",
        cmd = "Telescope",
        dependencies = {
            "nvim-lua/plenary.nvim",
            {
                "nvim-telescope/telescope-fzf-native.nvim",
                build =
                "cmake -S. -Bbuild -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release && cmake --install build --prefix build",
            },
        },
        keys = {
            { "<leader>ff", "<cmd>Telescope find_files<cr>",  desc = "Find files" },
            { "<leader>fg", "<cmd>Telescope live_grep<cr>",   desc = "Live grep" },
            { "<leader>fb", "<cmd>Telescope buffers<cr>",     desc = "Buffers" },
            { "<leader>fh", "<cmd>Telescope help_tags<cr>",   desc = "Help tags" },
            { "<leader>fr", "<cmd>Telescope oldfiles<cr>",    desc = "Recent files" },
            { "<leader>fd", "<cmd>Telescope diagnostics<cr>", desc = "Diagnostics" },
        },
        config = function()
            require("telescope").setup({
                defaults = {
                    path_display = { "filename_first" }, -- show name first, then dir path
                    layout_strategy = "horizontal",
                    layout_config = {
                        width = 0.95, -- use 95% of screen width
                        preview_width = 0.5, -- give results half, preview half
                    },
                },
            })
            require("telescope").load_extension("fzf")
        end,
    },
}
