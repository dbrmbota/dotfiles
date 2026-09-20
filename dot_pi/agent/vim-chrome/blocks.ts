import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { RESET_FG, bgToFg, fgAnsi } from "./style";

type ThemeColor = Parameters<Theme["fg"]>[0];
type ThemeBg = Parameters<Theme["bg"]>[0];

export type BlockChromeOptions = {
	/** Rail glyph, drawn on the terminal background in the rail colour. */
	railGlyph: string;
	/** Which foreground token to use for a block with the given background. */
	railColors: Partial<Record<ThemeBg, ThemeColor>>;
};

const ORIGINAL = Symbol.for("vim-chrome.blocks.original");
const RAIL_WIDTH = 1;
const SGR_PREFIX = /^(?:\x1b\[[0-9;]*m)+/;

type BgFn = (text: string) => string;
type Patchable = {
	render(width: number): string[];
	handleMouse?(event: TuiMouseEvent): unknown;
	[ORIGINAL]?: { render: (width: number) => string[]; handleMouse?: (event: TuiMouseEvent) => unknown };
};

/** Leading background SGR of a bgFn's output, or undefined when it paints no background. */
function backgroundOf(bgFn: BgFn | undefined): string | undefined {
	if (!bgFn) return undefined;
	const sample = bgFn("");
	const prefix = SGR_PREFIX.exec(sample)?.[0];
	if (!prefix || !/\x1b\[(?:48;|4[0-7]m|10[0-7]m)/.test(prefix)) return undefined;
	return prefix;
}

function railFor(theme: Theme, bg: string, options: BlockChromeOptions): string {
	for (const [token, color] of Object.entries(options.railColors) as [ThemeBg, ThemeColor][]) {
		let ansi: string;
		try {
			ansi = theme.getBgAnsi(token);
		} catch {
			continue;
		}
		if (ansi && bg.includes(ansi)) return `${fgAnsi(theme, color)}${options.railGlyph}${RESET_FG}`;
	}
	// Unknown background: use the same colour as foreground.
	return `${bgToFg(bg)}${options.railGlyph}${RESET_FG}`;
}

/**
 * Give every background-filled Box/Text (user messages, tool calls, compaction,
 * custom messages) the same left rail as the editor chrome.
 */
export function installBlockChrome(getTheme: () => Theme, options: BlockChromeOptions): () => void {
	const patch = (proto: Patchable, bgKey: string) => {
		const original = proto[ORIGINAL] ?? { render: proto.render, handleMouse: proto.handleMouse };
		proto[ORIGINAL] = original;

		proto.render = function (this: Record<string, unknown>, width: number): string[] {
			const bg = backgroundOf(this[bgKey] as BgFn | undefined);
			if (!bg || width <= RAIL_WIDTH + 1) return original.render.call(this, width);
			const lines = original.render.call(this, width - RAIL_WIDTH);
			if (lines.length === 0) return lines;
			const rail = railFor(getTheme(), bg, options);
			return lines.map((line) => rail + line);
		};

		if (original.handleMouse) {
			const originalMouse = original.handleMouse;
			proto.handleMouse = function (this: Record<string, unknown>, event: TuiMouseEvent) {
				if (!backgroundOf(this[bgKey] as BgFn | undefined)) return originalMouse.call(this, event);
				if (event.x < RAIL_WIDTH) return undefined;
				return originalMouse.call(this, {
					...event,
					x: event.x - RAIL_WIDTH,
					width: event.width - RAIL_WIDTH,
				});
			};
		}

		return () => {
			proto.render = original.render;
			if (original.handleMouse) proto.handleMouse = original.handleMouse;
			delete proto[ORIGINAL];
		};
	};

	const undo = [
		patch(Box.prototype as unknown as Patchable, "bgFn"),
		patch(Text.prototype as unknown as Patchable, "customBgFn"),
	];
	return () => {
		for (const fn of undo) fn();
	};
}
