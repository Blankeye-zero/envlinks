-- :FM — manage the abdu-fyi blog YAML frontmatter format.
-- Local plugin, loaded on first use of the :FM command.
return {
    {
        dir = vim.fn.stdpath("config") .. "/local/frontmatter",
        name = "frontmatter",
        cmd = { "FM" },
        opts = {},
    },
}
