-- Autocmds are automatically loaded on the VeryLazy event
-- Default autocmds that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/autocmds.lua
--
-- Add any additional autocmds here
-- with `vim.api.nvim_create_autocmd`
--
-- Or remove existing autocmds by their group name (which is prefixed with `lazyvim_` for the defaults)
-- e.g. vim.api.nvim_del_augroup_by_name("lazyvim_wrap_spell")

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
