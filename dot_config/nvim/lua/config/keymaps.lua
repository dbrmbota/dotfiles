-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua
-- Add any additional keymaps here

local function copy_buffer_path(modifier)
  local path = vim.api.nvim_buf_get_name(0)

  if path == "" then
    vim.notify("Current buffer has no path", vim.log.levels.WARN)
    return
  end

  path = vim.fn.fnamemodify(path, modifier)
  vim.fn.setreg("+", path)
  vim.notify("Copied " .. path)
end

vim.keymap.set("n", "<leader>by", "<nop>", { desc = "+yank path" })

vim.keymap.set("n", "<leader>byr", function()
  copy_buffer_path(":.")
end, { desc = "Copy relative buffer path" })

vim.keymap.set("n", "<leader>bya", function()
  copy_buffer_path(":p")
end, { desc = "Copy absolute buffer path" })
