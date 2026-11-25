return {
	{
		"nvim-lualine/lualine.nvim",
		opts = function(_, opts)
			opts.options.section_separators = { left = "", right = "" }
			opts.options.component_separators = ""

			-- lualine_a[1] is LazyVim's "mode" (ui.lua:95); keep it, add caps
			opts.sections.lualine_a[1] = {
				"mode",
				separator = { left = "", right = "" },
			}

			-- lualine_z[1] is LazyVim's clock function (ui.lua:161-166);
			-- wrap it instead of duplicating its logic
			local clock = opts.sections.lualine_z[1]
			opts.sections.lualine_z[1] = {
				clock,
				separator = { left = "", right = "" },
			}
		end,
	},
}
