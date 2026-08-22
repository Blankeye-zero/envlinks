-- %LOCALAPPDATA%\nvim\init.lua

-- Leader must be set BEFORE any <leader> mapping is defined.
vim.g.mapleader = " "
vim.g.maplocalleader = " "

vim.api.nvim_set_keymap("i", "jk", "<Esc>", { noremap = false })

-- Press "-" in normal mode to open netrw (vim-vinegar style)
vim.keymap.set("n", "-", "<cmd>Ex<cr>", { desc = "Open netrw" })

-- Terminal mode: Esc exits to normal mode, then window nav with Ctrl+hjkl
vim.keymap.set("t", "<Esc><Esc>", [[<C-\><C-n>]], { desc = "Exit terminal mode" })
vim.keymap.set("t", "<C-h>", [[<C-\><C-n><C-w>h]], { desc = "Window left" })
vim.keymap.set("t", "<C-j>", [[<C-\><C-n><C-w>j]], { desc = "Window down" })
vim.keymap.set("t", "<C-k>", [[<C-\><C-n><C-w>k]], { desc = "Window up" })
vim.keymap.set("t", "<C-l>", [[<C-\><C-n><C-w>l]], { desc = "Window right" })

-- Open a PowerShell terminal in a split
vim.keymap.set("n", "<leader>th", function()
  vim.cmd("split")
  vim.cmd("terminal powershell")
end, { desc = "Terminal (horizontal)" })
vim.keymap.set("n", "<leader>tv", function()
  vim.cmd("vsplit")
  vim.cmd("terminal powershell")
end, { desc = "Terminal (vertical)" })

-- Bootstrap lazy.nvim
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not (vim.uv or vim.loop).fs_stat(lazypath) then
    vim.fn.system({
        "git", "clone", "--filter=blob:none",
        "https://github.com/folke/lazy.nvim.git",
        "--branch=stable",
        lazypath,
    })
end
vim.opt.rtp:prepend(lazypath)

-- Auto-source a project-local .nvim.lua (e.g. per-project dap.configurations overrides)
-- when opening a project. First use in a given directory prompts a one-time trust dialog.
vim.o.exrc = true

-- Basic options
vim.opt.number = true
vim.opt.relativenumber = true
vim.opt.expandtab = true
vim.opt.tabstop = 4
vim.opt.shiftwidth = 4
vim.opt.termguicolors = true

-- Load plugins
require("lazy").setup("plugins", {
    change_detection = { notify = false },
})
