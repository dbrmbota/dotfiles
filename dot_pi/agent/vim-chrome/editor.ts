import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { paintSelection } from "./selection";
import {
	RESET_FG,
	bgAnsi,
	bgToFg,
	fg,
	fgAnsi,
	modeColor,
	modeKindFromLabel,
	padRight,
	paintBackground,
} from "./style";

/** Columns used by the rail + gap on the left of every editor row. */
const CHROME_WIDTH = 2;

export type EditorChromeOptions = {
	/** Paint the input surface with the theme's userMessageBg (opencode look). */
	bodyBackground: boolean;
	/** Glyph for the left rail, drawn in the mode colour (e.g. "┃"). */
	railGlyph: string;
	/** Glyph that caps the rail on the final (half-height) chrome row (e.g. "╹"). */
	railCapGlyph: string;
};

export type EditorMeta = {
	model?: string;
	provider?: string;
	thinking?: string;
	agent?: { name: string; color?: string };
};

type MouseEvent = { x: number; y: number } & Record<string, unknown>;

/** The surface of pi-vim's ModalEditor we touch. Privates exist at runtime. */
export type VimEditorLike = {
	render(width: number): string[];
	handleMouse?(event: MouseEvent): unknown;
	getMode?(): string;
	renderedVisibleLineCount?: number;
	renderedAutocompleteHeight?: number;
	getModeLabel?(): string;
};

export type ChromedEditor = {
	/** Raw pi-vim label, e.g. " NORMAL ", " NORMAL 2d_ ", " EX :w_ ", " V-LINE ". */
	modeLabel(): string;
};

const VIEWPORT_ABOVE = /^─── ↑ ([1-9]\d*) more ─*$/;
const VIEWPORT_BELOW = /^─── ↓ ([1-9]\d*) more ─*$/;
const PLAIN_BORDER = /^─+$/;

function isBorder(line: string, below: boolean): string | undefined {
	const plain = stripVTControlCharacters(line);
	if (PLAIN_BORDER.test(plain)) return "";
	const match = (below ? VIEWPORT_BELOW : VIEWPORT_ABOVE).exec(plain);
	return match ? match[1] : undefined;
}

export function installEditorChrome(
	editor: VimEditorLike,
	getTheme: () => Theme,
	options: EditorChromeOptions,
	getMeta: () => EditorMeta,
): ChromedEditor {
	const proto = Object.getPrototypeOf(editor) as VimEditorLike;
	const originalRender = proto.render;
	const originalMouse = editor.handleMouse ? editor.handleMouse.bind(editor) : undefined;
	const protoModeLabel = typeof proto.getModeLabel === "function" ? proto.getModeLabel : undefined;

	const modeLabel = (): string => {
		if (protoModeLabel) {
			try {
				return protoModeLabel.call(editor);
			} catch {
				// fall through
			}
		}
		const mode = editor.getMode?.() ?? "insert";
		return ` ${mode === "visual-line" ? "V-LINE" : mode.toUpperCase()} `;
	};

	// Shadow pi-vim's private label getter on the instance so its render()
	// appends nothing. We read the prototype implementation ourselves.
	if (protoModeLabel) {
		(editor as { getModeLabel: () => string }).getModeLabel = () => "";
	}

	// Layout of the last render, used to translate mouse rows back to the base editor.
	let layout = { above: 0, content: 0, below: 0, autocomplete: 0 };

	editor.render = function render(width: number): string[] {
		const innerWidth = Math.max(1, width - CHROME_WIDTH);
		const lines = originalRender.call(editor, innerWidth);
		if (lines.length === 0) return lines;

		const theme = getTheme();
		const label = modeLabel();
		const kind = modeKindFromLabel(label);
		const bodyBg = options.bodyBackground ? bgAnsi(theme, "userMessageBg") : undefined;
		// Rail sits on the terminal background; only the body gets the surface colour.
		const rail = `${fgAnsi(theme, modeColor(kind))}${options.railGlyph}${RESET_FG}`;

		// Slice using pi-tui's bookkeeping; fall back to a border scan.
		let contentCount = editor.renderedVisibleLineCount;
		let bottomIndex =
			typeof contentCount === "number" && contentCount >= 0 ? contentCount + 1 : -1;
		if (bottomIndex < 1 || bottomIndex >= lines.length || isBorder(lines[bottomIndex] ?? "", true) === undefined) {
			bottomIndex = lines.findIndex((line, i) => i > 0 && isBorder(line, true) !== undefined);
			if (bottomIndex === -1) bottomIndex = lines.length - 1;
			contentCount = bottomIndex - 1;
		}

		const above = isBorder(lines[0] ?? "", false) || "";
		const below = isBorder(lines[bottomIndex] ?? "", true) || "";
		let content = lines.slice(1, bottomIndex);
		const autocomplete = lines.slice(bottomIndex + 1);
		try {
			content = paintSelection(editor, content, innerWidth, theme) ?? content;
		} catch {
			// keep pi-vim's rows if the editor internals changed shape
		}

		const surface = (line: string): string => {
			const body = ` ${padRight(line, innerWidth, visibleWidth(line))}`;
			return `${rail}${bodyBg ? paintBackground(body, bodyBg) : body}`;
		};
		const hint = (text: string): string => surface(fg(theme, "muted", text));
		// Final row: the rail ends in a heavy "up" stub and the surface is drawn
		// with upper-half blocks, so the box bottom is half-height and the rail
		// reads as continuous with the full-height rows above it.
		const cap = (): string => {
			const railCap = `${fgAnsi(theme, modeColor(kind))}${options.railCapGlyph}${RESET_FG}`;
			const capBody = bodyBg
				? `${bgToFg(bodyBg)}${"▀".repeat(Math.max(0, width - 1))}${RESET_FG}`
				: " ".repeat(Math.max(0, width - 1));
			return railCap + capBody;
		};

		const out: string[] = [];
		out.push(surface(""));
		if (above) out.push(hint(`↑ ${above} more`));
		for (const line of content) out.push(surface(line));
		if (below) out.push(hint(`↓ ${below} more`));
		for (const line of autocomplete) out.push(surface(line));
		out.push(surface(""));
		out.push(surface(metaRow(innerWidth, label, kind, theme, getMeta())));
		out.push(cap());

		layout = {
			above: 1 + (above ? 1 : 0),
			content: content.length,
			below: below ? 1 : 0,
			autocomplete: autocomplete.length,
		};
		return out.map((line) => truncateToWidth(line, width, ""));
	};

	if (originalMouse) {
		editor.handleMouse = function handleMouse(event: MouseEvent) {
			const { above, content, below } = layout;
			let y = event.y;
			if (y < above) return false;
			if (y < above + content) {
				y = y - above + 1; // base rows 1..n are content
			} else if (y < above + content + below) {
				return false; // viewport hint row
			} else {
				y = y - above - content - below + content + 2; // base autocomplete starts at n+2
			}
			return originalMouse({ ...event, x: Math.max(0, event.x - CHROME_WIDTH), y });
		};
	}

	return { modeLabel };
}

function providerLabel(provider: string | undefined): string {
	if (!provider) return "";
	const known: Record<string, string> = {
		anthropic: "Anthropic",
		openai: "OpenAI",
		"openai-codex": "Codex",
		google: "Google",
		gemini: "Google",
		opencode: "OpenCode Zen",
		"opencode-go": "OpenCode Go",
		openrouter: "OpenRouter",
		xai: "xAI",
		groq: "Groq",
		mistral: "Mistral",
		ollama: "Ollama",
	};
	return (
		known[provider] ??
		provider
			.split("-")
			.map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
			.join(" ")
	);
}

/** Inner content (no rail/gap) of the model row, fitted to `available` columns. */
function metaRow(
	available: number,
	label: string,
	kind: ReturnType<typeof modeKindFromLabel>,
	theme: Theme,
	meta: EditorMeta,
): string {
	const dot = fg(theme, "dim", " · ");
	const accent = modeColor(kind); // same colour as the rail
	const parts: string[] = [];
	if (meta.agent) {
		const color = (meta.agent.color ?? accent) as Parameters<Theme["fg"]>[0];
		parts.push(fg(theme, color, meta.agent.name));
	}
	if (meta.model) parts.push(fg(theme, accent, meta.model));
	const provider = providerLabel(meta.provider);
	if (provider) parts.push(fg(theme, "muted", provider));
	if (meta.thinking && meta.thinking.toLowerCase() !== "off") {
		parts.push(fg(theme, accent, meta.thinking));
	}
	const right = parts.join(dot);

	let left = "";
	if (kind === "ex") {
		// " EX :cmd_ " → ":cmd_"
		const command = label.trim().replace(/^EX\s?/, "");
		left = fg(theme, "warning", command);
	}

	if (!left) return truncateToWidth(right, available, "…");
	const gap = available - visibleWidth(left) - visibleWidth(right);
	if (gap >= 2) return `${left}${" ".repeat(gap)}${right}`;
	return truncateToWidth(left, available, "…");
}
