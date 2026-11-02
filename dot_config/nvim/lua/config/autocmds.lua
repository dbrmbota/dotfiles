-- Autocmds are automatically loaded on the VeryLazy event
-- Default autocmds that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/autocmds.lua
--
-- Add any additional autocmds here
-- with `vim.api.nvim_create_autocmd`
--
-- Or remove existing autocmds by their group name (which is prefixed with `lazyvim_` for the defaults)
-- e.g. vim.api.nvim_del_augroup_by_name("lazyvim_wrap_spell")

-- Private. Encodes a non-negative integer in base 36 using [a-z0-9].
local function to_base36(n)
  if n == 0 then
    return "0"
  end
  local digits = "0123456789abcdefghijklmnopqrstuvwxyz"
  local out = {}
  while n > 0 do
    local d = n % 36
    table.insert(out, 1, digits:sub(d + 1, d + 1))
    n = math.floor(n / 36)
  end
  return table.concat(out)
end

-- Private. Sends the buffer's file to the Herdr markdown viewer, or falls back to `:MarkdownPreviewToggle` when HC_TERMINAL_ID is unset.
local function herdr_markdown_show(buf)
  if vim.env.HC_TERMINAL_ID == nil or vim.env.HC_TERMINAL_ID == "" then
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

  local id = to_base36(os.time()) .. to_base36(vim.uv.hrtime() % 36 ^ 4)
  local function on_exit(obj)
    vim.schedule(function()
      if obj.code ~= 0 then
        local stderr = vim.trim(obj.stderr or "")
        vim.notify(stderr ~= "" and stderr or "hc label failed", vim.log.levels.ERROR)
        return
      end
      vim.notify("Showing " .. vim.fn.fnamemodify(path, ":~:.") .. " in Herdr", vim.log.levels.INFO)
    end)
  end

  local called = pcall(
    vim.system,
    { "hc", "label", vim.env.HC_TERMINAL_ID, "markdown.show." .. id .. "=" .. path },
    { text = true, timeout = 5000 },
    on_exit
  )
  if not called then
    vim.notify("hc not found", vim.log.levels.ERROR)
  end
end

-- Private. Sets the buffer-local <leader>cp map that calls `herdr_markdown_show` for this buffer.
local function herdr_markdown_map(buf)
  vim.keymap.set("n", "<leader>cp", function()
    herdr_markdown_show(buf)
  end, { buffer = buf, desc = "Markdown Preview (Herdr)" })
end

-- Markdown buffers <leader>cp map. Applies to the FileType autocmd below and to already-loaded markdown buffers.
local herdr_markdown_group = vim.api.nvim_create_augroup("herdr_markdown_show", { clear = true })
vim.api.nvim_create_autocmd("FileType", {
  group = herdr_markdown_group,
  pattern = "markdown",
  callback = function(args)
    herdr_markdown_map(args.buf)
  end,
})

for _, buf in ipairs(vim.api.nvim_list_bufs()) do
  if vim.bo[buf].filetype == "markdown" then
    herdr_markdown_map(buf)
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
