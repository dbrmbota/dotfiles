return {
	{
		"LazyVim/LazyVim",
		opts = {
			colorscheme = "tokyonight-night",
		},
	},
	{
		"folke/tokyonight.nvim",
		opts = {
			on_highlights = function(hl, c)
				hl.StatusLine = { fg = c.fg_sidebar, bg = c.bg }
				hl.StatusLineNC = { fg = c.fg_gutter, bg = c.bg }
			end,
		},
	},
}
