import { stripVTControlCharacters } from "node:util";
import { RESET, RESET_BG, bgToFg } from "./style.ts";

const SGR = /\x1b\[([0-9;]*)m/g;

/**
 * Leading background SGR of a `bgFn`'s output, or undefined when it paints no background.
 * Only truecolor (`48;2;`), 256-colour (`48;5;`) and basic (`40-47`, `100-107`) backgrounds count.
 */
export function extractBgSgr(bgFn: ((text: string) => string) | undefined): string | undefined {
	return bgFn ? extractLeadingBgSgr(bgFn("x")) : undefined;
}

/**
 * Final active background SGR in the leading SGR run of `text`, or undefined when that run sets none.
 * Skips foreground parameters (`38;5;N`, `38;2;R;G;B`) and clears the background on `0` or `49`.
 */
export function extractLeadingBgSgr(text: string): string | undefined {
	const prefix = /^(?:\x1b\[[0-9;]*m)+/.exec(text)?.[0];
	if (!prefix) return undefined;
	let bg: string | undefined;
	for (const match of prefix.matchAll(SGR)) {
		const codes = (match[1] ?? "").split(";");
		for (let i = 0; i < codes.length; i++) {
			const code = Number(codes[i]);
			if (code === 0 || code === 49) {
				bg = undefined;
			} else if (code === 48 && codes[i + 1] === "5" && i + 2 < codes.length) {
				bg = `\x1b[48;5;${codes[i + 2]}m`;
				i += 2;
			} else if (code === 48 && codes[i + 1] === "2" && i + 4 < codes.length) {
				bg = `\x1b[48;2;${codes[i + 2]};${codes[i + 3]};${codes[i + 4]}m`;
				i += 4;
			} else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
				bg = `\x1b[${code}m`;
			} else if (code === 38) {
				i += codes[i + 1] === "5" ? 2 : codes[i + 1] === "2" ? 4 : 0;
			}
		}
	}
	return bg;
}

/** RGB channels of a truecolor background SGR (`\x1b[48;2;R;G;Bm`), or undefined for any other SGR. */
export function parseTruecolorBg(bgSgr: string): { r: number; g: number; b: number } | undefined {
	for (const match of bgSgr.matchAll(SGR)) {
		const codes = (match[1] ?? "").split(";");
		for (let i = 0; i + 4 < codes.length; i++) {
			if (codes[i] !== "48" || codes[i + 1] !== "2") continue;
			const [r, g, b] = [codes[i + 2], codes[i + 3], codes[i + 4]].map(Number);
			if ([r, g, b].every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)) {
				return { r: r!, g: g!, b: b! };
			}
		}
	}
	return undefined;
}

/** True for Kitty and iTerm2 inline-image escape sequences, which must not be measured or framed. */
export function isImageLine(line: string): boolean {
	return line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
}

/**
 * Wraps `lines` in a rounded `╭─╮` / `│ │` / `╰─╯` frame `width` columns wide, drawn in `borderFg`.
 * `custom.top` and `custom.bottom`, when given, replace the default top and bottom rows (sized to
 * `width - 2 * marginX`). When `custom.marginX` is given, adds that many blank spaces on both sides
 * outside the border. Returns `lines` unchanged when it is empty or the framed width is under 3.
 * Content rows are fitted to the inner width with `truncate` or padding, and image rows pass through
 * untouched.
 */
export function frameLines(
	lines: string[],
	width: number,
	borderFg: string,
	measure: (s: string) => number,
	truncate: (s: string, w: number) => string,
	custom?: { top?: string; bottom?: string; marginX?: number },
): string[] {
	const marginX = Math.max(0, custom?.marginX ?? 0);
	const frameWidth = width - marginX * 2;
	if (lines.length === 0 || frameWidth < 3) return lines;
	const innerWidth = frameWidth - 2;
	const horizontal = "─".repeat(innerWidth);
	const margin = " ".repeat(marginX);
	const out = [`${margin}${custom?.top ?? `${borderFg}╭${horizontal}╮${RESET}`}${margin}`];
	for (const line of lines) {
		if (isImageLine(line)) {
			out.push(line);
			continue;
		}
		const visible = measure(line);
		const fitted =
			visible > innerWidth ? truncate(line, innerWidth) : `${line}${" ".repeat(innerWidth - visible)}`;
		out.push(`${margin}${borderFg}│${RESET}${fitted}${RESET}${borderFg}│${RESET}${margin}`);
	}
	out.push(`${margin}${custom?.bottom ?? `${borderFg}╰${horizontal}╯${RESET}`}${margin}`);
	return out;
}

/**
 * True when `line` shows nothing once SGR sequences are stripped. Image lines and lines containing APC
 * sequences (cursor and fake-cursor markers) are never blank.
 */
export function isBlankLine(line: string): boolean {
	if (isImageLine(line) || line.includes("\x1b_")) return false;
	return stripVTControlCharacters(line).trim() === "";
}

/** One block of a framed container: a full-width divider row, or the content lines of one child. */
export type FrameSection = { isDivider: true } | { isDivider: false; lines: string[] };

/**
 * Result of framing sections. `lines` are the framed rows. `heights[i]` and `trimmedTops[i]` describe section `i`:
 * the rows it contributes, and the leading blank lines removed from it. Dividers have height 1 and trimmedTop 0.
 */
export type FramedSectionsResult = { lines: string[]; heights: number[]; trimmedTops: number[] };

/**
 * Frames `sections` in a rounded border `width` columns wide, drawn in `borderFg`, with `marginX` blank
 * columns outside the border on both sides. Divider sections become `├───┤` rows. Content rows get one
 * space of padding on each side, are fitted to `width - 2 * marginX - 4` columns, and image rows pass
 * through untouched. Leading and trailing blank lines of the whole interior are removed, stopping at
 * dividers. Requires `width >= 5 + 2 * marginX`.
 */
export function frameContainerSections(
	sections: readonly FrameSection[],
	width: number,
	borderFg: string,
	measure: (s: string) => number,
	truncate: (s: string, w: number) => string,
	marginX = 0,
): FramedSectionsResult {
	const contents: string[][] = sections.map((section) => (section.isDivider ? [] : [...section.lines]));
	const trimmedTops = sections.map(() => 0);
	for (let i = 0; i < sections.length && !sections[i]!.isDivider; i++) {
		const lines = contents[i]!;
		while (lines.length > 0 && isBlankLine(lines[0]!)) {
			lines.shift();
			trimmedTops[i]!++;
		}
		if (lines.length > 0) break;
	}
	for (let i = sections.length - 1; i >= 0 && !sections[i]!.isDivider; i--) {
		const lines = contents[i]!;
		while (lines.length > 0 && isBlankLine(lines[lines.length - 1]!)) lines.pop();
		if (lines.length > 0) break;
	}

	const safeMarginX = Math.max(0, marginX);
	const frameWidth = width - safeMarginX * 2;
	const margin = " ".repeat(safeMarginX);
	const bar = "─".repeat(frameWidth - 2);
	const innerWidth = frameWidth - 4;
	const lines = [`${margin}${borderFg}╭${bar}╮${RESET}${margin}`];
	const heights: number[] = [];
	sections.forEach((section, i) => {
		if (section.isDivider) {
			lines.push(`${margin}${borderFg}├${bar}┤${RESET}${margin}`);
			heights.push(1);
			return;
		}
		const content = contents[i]!;
		heights.push(content.length);
		for (const line of content) {
			if (isImageLine(line)) {
				lines.push(line);
				continue;
			}
			const visible = measure(line);
			const fitted = visible > innerWidth ? truncate(line, innerWidth) : `${line}${" ".repeat(innerWidth - visible)}`;
			lines.push(`${margin}${borderFg}│${RESET} ${fitted} ${RESET}${borderFg}│${RESET}${margin}`);
		}
	});
	lines.push(`${margin}${borderFg}╰${bar}╯${RESET}${margin}`);
	return { lines, heights, trimmedTops };
}

/** A status item on the editor's bottom border. Lower `priority` is dropped first on narrow widths. */
export type BorderItem = { text: string; priority: number };

/**
 * Rounded pill around background-filled `text`: Nerd Font caps in the background colour of `text`,
 * drawn on the terminal background. Returns `text` unchanged when it has no background.
 */
export function wrapRoundedPill(text: string, capLeft: string, capRight: string): string {
	const bg = extractLeadingBgSgr(text);
	if (!bg) return text;
	const capFg = bgToFg(bg);
	return `${RESET_BG}${capFg}${capLeft}${RESET}${text}${RESET}${capFg}${RESET_BG}${capRight}${RESET}`;
}

/**
 * Editor top border of exactly `width` columns: `╭─ <label> ───╮` in `borderFg`. `label` is truncated
 * to fit. A plain `╭───╮` row is drawn when `label` is empty or the inner width is under 5. Returns ""
 * when `width < 3`.
 */
export function formatTopBorder(
	width: number,
	borderFg: string,
	label: string,
	measure: (s: string) => number,
	truncate: (s: string, w: number) => string,
): string {
	if (width < 3) return "";
	const innerWidth = width - 2;
	if (!label || innerWidth < 5) return `${borderFg}╭${"─".repeat(innerWidth)}╮${RESET}`;
	const maxLabelWidth = innerWidth - 4;
	const fitted = measure(label) > maxLabelWidth ? truncate(label, maxLabelWidth) : label;
	const fill = innerWidth - 3 - measure(fitted);
	return `${borderFg}╭─ ${RESET}${fitted}${RESET}${borderFg} ${"─".repeat(fill)}╮${RESET}`;
}

/**
 * Editor bottom border of exactly `width` columns. `left` items sit at the left corner, `right` items at
 * the right corner, and `middle` fills the centre gap. Items on one side are joined with " ─ ". When the
 * row is too narrow, `middle` is dropped first, then the lowest-priority items. Falls back to a plain
 * `╰───╯`. Returns "" when `width < 3`.
 */
export function formatBottomBorder(
	width: number,
	borderFg: string,
	left: readonly BorderItem[],
	right: readonly BorderItem[],
	middle: string,
	measure: (s: string) => number,
): string {
	if (width < 3) return "";
	const innerWidth = width - 2;
	const plain = `${borderFg}╰${"─".repeat(innerWidth)}╯${RESET}`;
	const separator = `${RESET}${borderFg} ─ ${RESET}`;
	const sideText = (items: readonly BorderItem[]): string => items.map((item) => item.text).join(separator);
	const pairRow = (a: string, b: string, fill: number): string =>
		`${borderFg}╰─ ${RESET}${a}${RESET}${borderFg} ${"─".repeat(fill)} ${RESET}${b}${RESET}${borderFg} ─╯${RESET}`;

	const build = (l: readonly BorderItem[], r: readonly BorderItem[], mid: string): string | undefined => {
		const lt = sideText(l);
		const rt = sideText(r);
		const wL = measure(lt);
		const wR = measure(rt);
		const wM = measure(mid);
		const hasL = l.length > 0;
		const hasR = r.length > 0;
		const hasM = mid !== "";
		if (hasL && hasR && hasM) {
			const fill = width - 10 - wL - wM - wR;
			if (fill < 2) return undefined;
			const leftFill = Math.floor(fill / 2);
			return `${borderFg}╰─ ${RESET}${lt}${RESET}${borderFg} ${"─".repeat(leftFill)} ${RESET}${mid}${RESET}${borderFg} ${"─".repeat(fill - leftFill)} ${RESET}${rt}${RESET}${borderFg} ─╯${RESET}`;
		}
		if (hasL && hasR) {
			const fill = width - 8 - wL - wR;
			return fill >= 1 ? pairRow(lt, rt, fill) : undefined;
		}
		if (hasL && hasM) {
			const fill = width - 8 - wL - wM;
			return fill >= 1 ? pairRow(lt, mid, fill) : undefined;
		}
		if (hasR && hasM) {
			const fill = width - 8 - wM - wR;
			return fill >= 1 ? pairRow(mid, rt, fill) : undefined;
		}
		if (hasL) {
			const fill = width - 5 - wL;
			return fill >= 1 ? `${borderFg}╰─ ${RESET}${lt}${RESET}${borderFg} ${"─".repeat(fill)}╯${RESET}` : undefined;
		}
		if (hasR) {
			const fill = width - 5 - wR;
			return fill >= 1 ? `${borderFg}╰${"─".repeat(fill)} ${RESET}${rt}${RESET}${borderFg} ─╯${RESET}` : undefined;
		}
		if (hasM) {
			const fill = width - 5 - wM;
			return fill >= 1 ? `${borderFg}╰─ ${RESET}${mid}${RESET}${borderFg} ${"─".repeat(fill)}╯${RESET}` : undefined;
		}
		return undefined;
	};

	let l = [...left];
	let r = [...right];
	let mid = middle;
	for (;;) {
		const row = build(l, r, mid);
		if (row !== undefined) return row;
		if (mid !== "") {
			mid = "";
			continue;
		}
		const items = [...l, ...r];
		if (items.length === 0) return plain;
		const victim = items.reduce((low, item) => (item.priority < low.priority ? item : low));
		l = l.filter((item) => item !== victim);
		r = r.filter((item) => item !== victim);
	}
}
