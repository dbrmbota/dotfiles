import type { Theme } from "@earendil-works/pi-coding-agent";

export type ModeKind = "insert" | "normal" | "visual" | "ex";

export const RESET = "\x1b[0m";
export const RESET_BG = "\x1b[49m";
export const RESET_FG = "\x1b[39m";

const SGR = /\x1b\[([0-9;]*)m/g;

type ThemeColor = Parameters<Theme["fg"]>[0];
type ThemeBg = Parameters<Theme["bg"]>[0];

export function modeKindFromLabel(rawLabel: string): ModeKind {
	const label = rawLabel.trim();
	if (label.startsWith("INSERT")) return "insert";
	if (label.startsWith("EX")) return "ex";
	if (label.startsWith("VISUAL") || label.startsWith("V-LINE")) return "visual";
	return "normal";
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

/** Turn a foreground SGR sequence into the equivalent background sequence. */
export function fgToBg(seq: string): string {
	return seq
		.replace(/\x1b\[38;/g, "\x1b[48;")
		.replace(/\x1b\[3([0-7])m/g, "\x1b[4$1m")
		.replace(/\x1b\[9([0-7])m/g, "\x1b[10$1m");
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

/** True when an SGR parameter list resets the background (full reset or 49). */
function resetsBackground(params: string): boolean {
	if (params === "") return true;
	const parts = params.split(";");
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (p === "0" || p === "49") return true;
		if (p === "38" || p === "48") {
			const kind = parts[i + 1];
			i += kind === "2" ? 4 : kind === "5" ? 2 : 0;
		}
	}
	return false;
}

/** Paint `text` with `bg`, re-applying it after any embedded SGR reset. */
export function paintBackground(text: string, bg: string): string {
	const restored = text.replace(SGR, (seq, params: string) =>
		resetsBackground(params) ? `${seq}${bg}` : seq,
	);
	return `${bg}${restored}${RESET_BG}`;
}

export function padRight(text: string, width: number, visible: number): string {
	return width > visible ? `${text}${" ".repeat(width - visible)}` : text;
}
