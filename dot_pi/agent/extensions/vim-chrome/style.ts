import type { Theme } from "@earendil-works/pi-coding-agent";

export type ModeKind = "insert" | "normal" | "visual" | "ex";

export const RESET = "\x1b[0m";
export const RESET_BG = "\x1b[49m";
export const RESET_FG = "\x1b[39m";

type ThemeColor = Parameters<Theme["fg"]>[0];
type ThemeBg = Parameters<Theme["bg"]>[0];

export function modeKindFromLabel(rawLabel: string): ModeKind {
	const label = rawLabel.trim();
	if (label.startsWith("INSERT")) return "insert";
	if (label.startsWith("EX")) return "ex";
	if (label.startsWith("VISUAL") || label.startsWith("V-LINE")) return "visual";
	return "normal";
}

/**
 * Pending vim keys or EX command shown on the editor's top border, e.g. ":help foo_" or "2d_".
 * Returns "" for resting mode labels (INSERT, NORMAL, VISUAL, V-LINE).
 */
export function modePendingFromLabel(rawLabel: string): string {
	const label = rawLabel.trim();
	const space = label.indexOf(" ");
	return space === -1 ? "" : label.slice(space + 1);
}

export function modeColor(kind: ModeKind): ThemeColor {
	switch (kind) {
		case "insert":
			return "success";
		case "visual":
			return "syntaxKeyword";
		case "ex":
			return "warning";
		default:
			return "accent";
	}
}

export function fgAnsi(theme: Theme, color: ThemeColor): string {
	try {
		return theme.getFgAnsi(color);
	} catch {
		return RESET_FG;
	}
}

export function bgAnsi(theme: Theme, color: ThemeBg): string {
	try {
		return theme.getBgAnsi(color);
	} catch {
		return RESET_BG;
	}
}

/** Turn a background SGR sequence into the equivalent foreground sequence. */
export function bgToFg(seq: string): string {
	return seq
		.replace(/\x1b\[48;/g, "\x1b[38;")
		.replace(/\x1b\[4([0-7])m/g, "\x1b[3$1m")
		.replace(/\x1b\[10([0-7])m/g, "\x1b[9$1m");
}

export function fg(theme: Theme, color: ThemeColor, text: string): string {
	try {
		return theme.fg(color, text);
	} catch {
		return text;
	}
}

export function padRight(text: string, width: number, visible: number): string {
	return width > visible ? `${text}${" ".repeat(width - visible)}` : text;
}
