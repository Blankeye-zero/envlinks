return {
    {
        "MeanderingProgrammer/render-markdown.nvim",
        dependencies = { "nvim-treesitter/nvim-treesitter" },
        ft = { "markdown" },
        opts = {
            heading = {
                icons = { "# ", "## ", "### ", "#### ", "##### ", "###### " },
            },
        },
        keys = {
            { "<leader>mp", "<cmd>RenderMarkdown toggle<cr>", desc = "Toggle markdown render" },
        },
    },
}
