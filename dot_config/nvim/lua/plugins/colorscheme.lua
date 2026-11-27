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
			on_colors = function(colors)
				colors.bg_statusline = colors.bg
			end,
		},
	},
}
