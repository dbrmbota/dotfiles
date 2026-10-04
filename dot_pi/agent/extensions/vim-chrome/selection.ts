import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { RESET_BG, bgAnsi } from "./style";

type Pos = { line: number; col: number };
type LayoutLine = { text: string; hasCursor: boolean; cursorPos?: number };
type VisualLine = { logicalLine: number; startCol: number; length: number };

/** Runtime surface of pi-tui's Editor + pi-vim's ModalEditor used for selection painting. */
type SelectionEditor = {
	getMode?(): string;
	getCursor?(): Pos;
	getLines?(): string[];
	visualAnchor?: Pos | null;
	scrollOffset?: number;
	lastWidth?: number;
	paddingX?: number;
	focused?: boolean;
	layoutText?(width: number): LayoutLine[];
	buildVisualLineMap?(width: number): VisualLine[];
};

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const INVERSE = "\x1b[7m";
const INVERSE_OFF = "\x1b[27m";

function order(a: Pos, b: Pos): [Pos, Pos] {
	if (a.line < b.line || (a.line === b.line && a.col <= b.col)) return [a, b];
	return [b, a];
}

/**
 * Re-render `rows` (the visible content rows from Editor.render, in order)
 * with pi-vim's visual selection painted. Returns undefined when not in a
 * visual mode or when the editor internals we rely on are unavailable.
 */
export function paintSelection(
	editor: SelectionEditor,
	rows: string[],
	innerWidth: number,
	theme: Theme,
): string[] | undefined {
	const mode = editor.getMode?.();
	if (mode !== "visual" && mode !== "visual-line") return undefined;
	if (
		!editor.getCursor ||
		!editor.getLines ||
		!editor.layoutText ||
		!editor.buildVisualLineMap ||
		typeof editor.lastWidth !== "number" ||
		typeof editor.scrollOffset !== "number"
	) {
		return undefined;
	}

	const lines = editor.getLines();
	const cursor = editor.getCursor();
	const rawAnchor = editor.visualAnchor ?? cursor;
	const anchor: Pos = {
		line: Math.min(Math.max(0, rawAnchor.line), Math.max(0, lines.length - 1)),
		col: Math.max(0, Math.min(rawAnchor.col, (lines[rawAnchor.line] ?? "").length)),
	};
	const [start, end] = order(anchor, cursor);

	const layout = editor.layoutText(editor.lastWidth);
	const visual = editor.buildVisualLineMap(editor.lastWidth);
	if (layout.length !== visual.length) return undefined;

	const maxPadding = Math.max(0, Math.floor((innerWidth - 1) / 2));
	const paddingX = Math.min(editor.paddingX ?? 0, maxPadding);
	const contentWidth = Math.max(1, innerWidth - paddingX * 2);
	const pad = " ".repeat(paddingX);
	// searchMatchBg contrasts with the userMessageBg surface; selectedBg is often too close.
	const selBg = bgAnsi(theme, "searchMatchBg");
	const marker = editor.focused ? CURSOR_MARKER : "";

	const out: string[] = [];
	for (let i = 0; i < rows.length; i++) {
		const index = editor.scrollOffset + i;
		const lay = layout[index];
		const vis = visual[index];
		if (!lay || !vis) {
			out.push(rows[i]!);
			continue;
		}
		const L = vis.logicalLine;
		const lineLength = (lines[L] ?? "").length;
		const isLastChunk = visual[index + 1]?.logicalLine !== L;

		// Selected column range [lo, hi) on this logical line; hi = Infinity
		// means "through end of line, including the newline cell".
		let lo = Number.POSITIVE_INFINITY;
		let hi = Number.NEGATIVE_INFINITY;
		if (L >= start.line && L <= end.line) {
			if (mode === "visual-line") {
				lo = 0;
				hi = Number.POSITIVE_INFINITY;
			} else {
				lo = L === start.line ? start.col : 0;
				hi = L === end.line ? (end.col >= lineLength ? Number.POSITIVE_INFINITY : end.col + 1) : Number.POSITIVE_INFINITY;
			}
		}

		const s = vis.startCol;
		const text = lay.text;
		const a = Math.max(0, Math.min(text.length, lo - s));
		const b = Math.max(0, Math.min(text.length, hi - s));
		// Paint the newline cell only for empty lines so a selected blank line is visible.
		const selectedTail =
			isLastChunk && lineLength === 0 && lo <= s + text.length && hi > s + text.length;
		const hasSelection = b > a || selectedTail;
		if (!hasSelection) {
			out.push(rows[i]!);
			continue;
		}

		const cursorPos = lay.hasCursor ? lay.cursorPos : undefined;
		let display = "";
		let inSel = false;
		let cursorDrawn = false;
		for (const seg of segmenter.segment(text)) {
			const idx = seg.index;
			const sel = idx >= a && idx < b;
			if (sel !== inSel) {
				display += sel ? selBg : RESET_BG;
				inSel = sel;
			}
			if (cursorPos === idx) {
				display += `${marker}${INVERSE}${seg.segment}${INVERSE_OFF}`;
				cursorDrawn = true;
			} else {
				display += seg.segment;
			}
		}
		let width = visibleWidth(text);
		if (selectedTail !== inSel) {
			display += selectedTail ? selBg : RESET_BG;
			inSel = selectedTail;
		}
		if (cursorPos !== undefined && !cursorDrawn) {
			display += `${marker}${INVERSE} ${INVERSE_OFF}`;
			width += 1;
		} else if (selectedTail) {
			display += " ";
			width += 1;
		}
		if (inSel) display += RESET_BG;

		const fill = " ".repeat(Math.max(0, contentWidth - width));
		out.push(`${pad}${display}${fill}${pad}`);
	}
	return out;
}
