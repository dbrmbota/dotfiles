return {
  {
    "GustavEikaas/easy-dotnet.nvim",
    dependencies = { "nvim-lua/plenary.nvim", "mfussenegger/nvim-dap", "folke/snacks.nvim" },
    opts = {
      lsp = {
        easy_dotnet_extension_enabled = true, -- Needs to be true for enhanced_rename and create_type_from_usage
        enhanced_rename = true, -- auto rename file when renaming class
        create_type_from_usage = true, -- code action for creating class from unresolved symbol in a separate file
        restart_roslyn_on_branch_change = true, -- Restart Roslyn when Git HEAD changes
      },
      test_runner = {
        neotest_integration = true,
      },
      diagnostics = {
        default_severity = "warning", -- "error" or "warning" (default: "error")
        setqflist = true, -- Populate quickfix list automatically (default: false)
      },
    },
  },
  {
    "nvim-lualine/lualine.nvim",
    opts = function(_, opts)
      local dotnet = require("easy-dotnet")
      -- running dotnet jobs, next to the mode
      table.insert(opts.sections.lualine_a, dotnet.lualine.jobs)
      -- default startup project + launch profile, pushed by the server on change
      table.insert(opts.sections.lualine_x, dotnet.lualine.active_project)
    end,
  },
  {
    "nvim-neotest/neotest",
    opts = function(_, opts)
      local dotnet = require("easy-dotnet.neotest")
      -- insert easy-dotnet adapter
      table.insert(opts.adapters, dotnet)
    end,
  },
  {
    "mason-org/mason.nvim",
    opts = { ensure_installed = { "csharpier", "netcoredbg", "fantomas" } },
  },
  {
    "stevearc/conform.nvim",
    optional = true,
    opts = {
      formatters_by_ft = {
        cs = { "csharpier" },
        fsharp = { "fantomas" },
      },
    },
  },
}
