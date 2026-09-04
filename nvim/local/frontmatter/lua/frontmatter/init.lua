-- frontmatter.nvim (local plugin)
--
-- Provides the :FM command for managing the YAML frontmatter format used by
-- the abdu-fyi Astro blog (src/content/blog/*.md):
--
--   ---
--   author: Abdur Rahman
--   pubDatetime: 2026-04-07T01:16:04.000Z
--   modDatetime: 2026-04-07T01:16:04.000Z
--   title: Holding Embers
--   slug: holding-embers
--   featured: true
--   draft: false
--   tags:
--     - prediction
--     - future
--   description: In Anticipation of a bleak midsummer
--   ---
--
-- Usage:
--   :FM          insert the frontmatter scaffold (title/slug derived from the
--                filename, pubDatetime/modDatetime set to now, draft: true).
--                If frontmatter already exists, bumps modDatetime instead.
--   :FM update   bump modDatetime to now.
--   :FM toggle   flip draft true/false (and bump modDatetime).

local M = {}

M.opts = {
    author = "Abdur Rahman",
    -- Bump modDatetime automatically whenever a markdown file with
    -- frontmatter is written. Off by default; enable via setup().
    update_on_save = false,
}

-- Timestamps in the format used by the blog: 2026-04-07T01:16:04.000Z
local function now_iso()
    return vim.fn.strftime("%Y-%m-%dT%H:%M:%S.000Z")
end

-- Returns the 0-based {start, stop} fence line indices (inclusive), or nil.
local function detect(buf)
    buf = buf or 0
    local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
    if #lines < 2 or lines[1] ~= "---" then
        return nil
    end
    for i = 2, #lines do
        if lines[i] == "---" then
            return { start = 0, stop = i - 1 }
        end
    end
    return nil
end

local function get_field(range, key)
    local lines = vim.api.nvim_buf_get_lines(0, range.start + 1, range.stop, false)
    for _, line in ipairs(lines) do
        local value = line:match("^%s*" .. key .. ":%s*(.-)%s*$")
        if value then
            return value
        end
    end
    return nil
end

-- Set `key: value` inside an existing frontmatter block, keeping field order
-- by replacing in place (inserts before the closing fence when absent).
local function set_field(range, key, value)
    local lines = vim.api.nvim_buf_get_lines(0, range.start + 1, range.stop, false)
    for i, line in ipairs(lines) do
        if line:match("^%s*" .. key .. ":") then
            vim.api.nvim_buf_set_lines(0, range.start + i, range.start + i + 1, false, { key .. ": " .. value })
            return
        end
    end
    vim.api.nvim_buf_set_lines(0, range.stop, range.stop, false, { key .. ": " .. value })
end

local function bump_modDatetime(range)
    set_field(range, "modDatetime", now_iso())
end

local function filename_stem()
    local name = vim.fn.fnamemodify(vim.api.nvim_buf_get_name(0), ":t:r")
    if name == "" then
        name = "untitled"
    end
    return name
end

local function title_from_stem(stem)
    local words = vim.split(stem:gsub("[%_%-]+", " "):gsub("%s+", " "), " ")
    for i, word in ipairs(words) do
        words[i] = word:sub(1, 1):upper() .. word:sub(2)
    end
    return table.concat(words, " ")
end

local function notify(msg, level)
    vim.notify("[FM] " .. msg, level or vim.log.levels.INFO)
end

local function ensure_markdown()
    local ok, ft = pcall(vim.api.nvim_get_option_value, "filetype", { buf = 0 })
    if not ok or not ft:match("markdown") then
        notify("only markdown files are supported", vim.log.levels.WARN)
        return false
    end
    return true
end

--- Insert the frontmatter scaffold at the top of the buffer.
function M.insert()
    if not ensure_markdown() then
        return
    end
    local range = detect()
    if range then
        bump_modDatetime(range)
        notify("frontmatter already present — updated modDatetime")
        return
    end

    local stem = filename_stem()
    local now = now_iso()
    local fm = {
        "---",
        "author: " .. M.opts.author,
        "pubDatetime: " .. now,
        "modDatetime: " .. now,
        "title: " .. title_from_stem(stem),
        "slug: " .. stem,
        "featured: false",
        "draft: true",
        "tags: []",
        "description: ",
        "---",
    }
    vim.api.nvim_buf_set_lines(0, 0, 0, false, fm)
    -- Cursor on the description line, ready to type.
    vim.api.nvim_win_set_cursor(0, { #fm - 1, #"description: " })
    vim.cmd("startinsert!")
    notify("frontmatter scaffold inserted")
end

--- Bump modDatetime to the current time.
function M.update()
    local range = detect()
    if not range then
        notify("no frontmatter block found — run :FM to insert one first", vim.log.levels.WARN)
        return
    end
    bump_modDatetime(range)
    notify("updated modDatetime")
end

--- Toggle draft true <-> false, bumping modDatetime on publish.
function M.toggle_draft()
    local range = detect()
    if not range then
        notify("no frontmatter block found — run :FM to insert one first", vim.log.levels.WARN)
        return
    end
    local current = get_field(range, "draft")
    if current == nil then
        set_field(range, "draft", "true")
        notify("draft: true (not set before)")
        return
    end
    local next = current == "true" and "false" or "true"
    set_field(range, "draft", next)
    if next == "false" then
        bump_modDatetime(range)
        notify("published — draft: false, modDatetime bumped")
    else
        notify("draft: true")
    end
end

function M.setup(opts)
    M.opts = vim.tbl_deep_extend("force", M.opts, opts or {})

    vim.api.nvim_create_user_command("FM", function(ctx)
        local sub = (ctx.args or ""):match("^%s*(.-)%s*$")
        if sub == "" or sub == "insert" then
            M.insert()
        elseif sub == "update" then
            M.update()
        elseif sub == "toggle" or sub == "draft" then
            M.toggle_draft()
        else
            notify("unknown subcommand: " .. sub .. " (use: insert, update, toggle)", vim.log.levels.ERROR)
        end
    end, {
        nargs = "?",
        complete = function()
            return { "insert", "update", "toggle" }
        end,
        desc = "Frontmatter: insert scaffold / update modDatetime / toggle draft",
    })

    if M.opts.update_on_save then
        local group = vim.api.nvim_create_augroup("frontmatter_mod_on_save", { clear = true })
        vim.api.nvim_create_autocmd("BufWritePre", {
            group = group,
            pattern = { "*.md", "*.mdx" },
            callback = function(args)
                local range = detect(args.buf)
                if range then
                    bump_modDatetime(range)
                end
            end,
        })
    end
end

return M
