-- Autocmds are automatically loaded on the VeryLazy event
-- Default autocmds that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/autocmds.lua
--
-- Add any additional autocmds here
-- with `vim.api.nvim_create_autocmd`
--
-- Or remove existing autocmds by their group name (which is prefixed with `lazyvim_` for the defaults)
-- e.g. vim.api.nvim_del_augroup_by_name("lazyvim_wrap_spell")

-- Private. Opens the buffer's file in a focused Rex side pane running leaf, or falls back to `:MarkdownPreviewToggle` when REX_SESSION or REX_BLOCK is unset or empty.
local function rex_markdown_show(buf)
  local session = vim.env.REX_SESSION
  local block = vim.env.REX_BLOCK
  if session == nil or session == "" or block == nil or block == "" then
    vim.cmd("MarkdownPreviewToggle")
    return
  end

  local name = vim.api.nvim_buf_get_name(buf)
  if name == "" or vim.bo[buf].buftype ~= "" then
    vim.notify("Buffer has no file", vim.log.levels.WARN)
    return
  end

  if vim.bo[buf].modified then
    local ok, err
    vim.api.nvim_buf_call(buf, function()
      ok, err = pcall(vim.cmd, "silent update")
    end)
    if not ok then
      vim.notify(err, vim.log.levels.ERROR)
      return
    end
  end

  local path = vim.fn.fnamemodify(name, ":p")
  if vim.uv.fs_stat(path) == nil then
    vim.notify("File not found: " .. path, vim.log.levels.ERROR)
    return
  end

  local function on_exit(obj)
    vim.schedule(function()
      if obj.code ~= 0 then
        local stderr = vim.trim(obj.stderr or "")
        vim.notify(stderr ~= "" and stderr or "rex split failed", vim.log.levels.ERROR)
        return
      end
      vim.notify("Showing " .. vim.fn.fnamemodify(path, ":~:.") .. " in Rex (leaf)", vim.log.levels.INFO)
    end)
  end

  local called = pcall(
    vim.system,
    { "rex", "split", "-s", session, "-b", block, "--split=right", "--ratio", "40", "--label", vim.fn.fnamemodify(path, ":t"), "--", "leaf", "open", path },
    { text = true, timeout = 5000 },
    on_exit
  )
  if not called then
    vim.notify("rex not found", vim.log.levels.ERROR)
  end
end

-- Private. Sets the buffer-local <leader>cp map that calls `rex_markdown_show` for this buffer.
local function rex_markdown_map(buf)
  vim.keymap.set("n", "<leader>cp", function()
    rex_markdown_show(buf)
  end, { buffer = buf, desc = "Markdown Preview (Rex/leaf)" })
end

-- Markdown buffers <leader>cp map. Applies to the FileType autocmd below and to already-loaded markdown buffers.
local rex_markdown_group = vim.api.nvim_create_augroup("rex_markdown_show", { clear = true })
vim.api.nvim_create_autocmd("FileType", {
  group = rex_markdown_group,
  pattern = "markdown",
  callback = function(args)
    rex_markdown_map(args.buf)
  end,
})

for _, buf in ipairs(vim.api.nvim_list_bufs()) do
  if vim.bo[buf].filetype == "markdown" then
    rex_markdown_map(buf)
  end
end

-- easy-dotnet: create contextual items from within mini.files
vim.api.nvim_create_autocmd("User", {
  pattern = "MiniFilesBufferCreate",
  callback = function(args)
    local buf_id = args.data.buf_id
    vim.keymap.set("n", "<leader>cn", function()
      local entry = require("mini.files").get_fs_entry()
      if entry == nil then
        vim.notify("No fd entry in mini files", vim.log.levels.WARN)
        return
      end
      local target_dir = entry.path
      if entry.fs_type == "file" then
        target_dir = vim.fn.fnamemodify(entry.path, ":h")
      end
      require("easy-dotnet").create_item(target_dir)
    end, { buffer = buf_id, desc = "Create item" })
  end,
})
