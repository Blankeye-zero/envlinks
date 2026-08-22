-- ~/.config/nvim/lua/plugins/dap.lua
return {
    {
        "mfussenegger/nvim-dap",
        dependencies = {
            "rcarriga/nvim-dap-ui",
            "nvim-neotest/nvim-nio",
        },
        config = function()
            local dap = require("dap")
            local dapui = require("dapui")

            dapui.setup()

            -- lldb-dap ships with the LLVM install (Mason's clangd install) and
            -- speaks DAP natively, so no separate debug adapter (e.g. codelldb) is needed.
            dap.adapters.lldb = {
                type = "executable",
                command = "C:/Program Files/LLVM/bin/lldb-dap.exe",
                name = "lldb",
            }

            -- Generic fallback for any C++ project that doesn't define its own override -
            -- prompts for the executable path each time. Projects that want a fixed,
            -- no-prompt target should set dap.configurations.cpp themselves in a project-local
            -- .nvim.lua (auto-sourced via 'exrc', see init.lua) rather than editing this file.
            dap.configurations.cpp = {
                {
                    name = "Launch",
                    type = "lldb",
                    request = "launch",
                    program = function()
                        return vim.fn.input("Path to executable: ", vim.fn.getcwd() .. "/build/", "file")
                    end,
                    cwd = function()
                        return vim.fn.getcwd() .. "/build"
                    end,
                    stopOnEntry = false,
                    args = {},
                },
            }
            dap.configurations.c = dap.configurations.cpp

            -- Auto open/close the UI (breakpoints, scopes, variables, stacks) with the session.
            -- Applies to every language's DAP session (cpp, go, ...), not just cpp.
            dap.listeners.after.event_initialized["dapui_config"] = function()
                dapui.open()
            end
            dap.listeners.before.event_terminated["dapui_config"] = function()
                dapui.close()
            end
            dap.listeners.before.event_exited["dapui_config"] = function()
                dapui.close()
            end

            local opts = { silent = true }
            vim.keymap.set("n", "<leader>db", dap.toggle_breakpoint, opts)
            vim.keymap.set("n", "<leader>dc", dap.continue, opts)
            vim.keymap.set("n", "<leader>di", dap.step_into, opts)
            vim.keymap.set("n", "<leader>do", dap.step_over, opts)
            vim.keymap.set("n", "<leader>dO", dap.step_out, opts)
            vim.keymap.set("n", "<leader>dr", dap.repl.open, opts)
            vim.keymap.set("n", "<leader>du", dapui.toggle, opts)
            vim.keymap.set("n", "<leader>dq", dap.terminate, opts)
        end,
    },

    -- Installs the delve debug adapter binary through Mason, the same way
    -- mason-lspconfig's ensure_installed does for LSP servers.
    {
        "jay-babu/mason-nvim-dap.nvim",
        dependencies = { "mason-org/mason.nvim", "mfussenegger/nvim-dap" },
        opts = {
            ensure_installed = { "delve" },
            automatic_installation = true,
        },
    },

    -- Go: adapter/configs (Debug, Debug test, Debug test (go.mod), Attach) via delve on $PATH
    -- (Mason puts its bin dir on $PATH for Neovim, so the mason-installed `dlv` is found automatically).
    {
        "leoluz/nvim-dap-go",
        ft = "go",
        dependencies = { "mfussenegger/nvim-dap" },
        opts = {},
    },
}
