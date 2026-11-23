import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { BorderStatus } from "./footer";
import { formatBottomBorder, formatTopBorder, frameLines } from "./border";
import { paintSelection } from "./selection";
import { type ModeKind, fg, fgAnsi, modeColor, modeKindFromLabel, modePendingFromLabel, padRight } from "./style";

/** Columns inset on each side of the rounded editor frame: 1 border column plus 1 padding column. */
const INSET_X = 2;

type MouseEvent = { x: number; y: number } & Record<string, unknown>;

/** The surface of pi-vim's ModalEditor we touch. Privates exist at runtime. */
export type VimEditorLike = {
	render(width: number): readonly string[];
	handleMouse?(event: MouseEvent): unknown;
	getMode?(): string;
	renderedVisibleLineCount?: number;
	renderedAutocompleteHeight?: number;
	getModeLabel?(): string;
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

/**
 * Installs the vim-chrome frame on `editor`. The frame takes the mode colour (vibrant), shows pending keys
 * or the EX command on its top border, and shows `getStatus` items on its bottom border. Mouse rows map
 * back to the base editor.
 */
export function installEditorChrome(
	editor: VimEditorLike,
	getTheme: () => Theme,
	getStatus: (theme: Theme, kind: ModeKind) => BorderStatus,
): void {
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

	editor.render = function render(width: number): readonly string[] {
		if (width < 5) return originalRender.call(editor, width);
		const innerWidth = Math.max(1, width - INSET_X * 2);
		const lines = originalRender.call(editor, innerWidth);
		if (lines.length === 0) return lines;

		const theme = getTheme();

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

		const surface = (line: string): string => ` ${padRight(line, innerWidth, visibleWidth(line))} `;
		const hint = (text: string): string => surface(fg(theme, "muted", text));

		const rows: string[] = [];
		rows.push(surface(""));
		if (above) rows.push(hint(`↑ ${above} more`));
		for (const line of content) rows.push(surface(line));
		if (below) rows.push(hint(`↓ ${below} more`));
		for (const line of autocomplete) rows.push(surface(line));
		rows.push(surface(""));

		// The frame's top border row sits above the first padding row.
		layout = {
			above: 2 + (above ? 1 : 0),
			content: content.length,
			below: below ? 1 : 0,
			autocomplete: autocomplete.length,
		};
		const rawLabel = modeLabel();
		const kind = modeKindFromLabel(rawLabel);
		const pending = modePendingFromLabel(rawLabel);
		const borderFg = fgAnsi(theme, modeColor(kind));
		const status = getStatus(theme, kind);
		const top = formatTopBorder(width, borderFg, pending ? `${borderFg}${pending}` : "", visibleWidth, (text, w) =>
			truncateToWidth(text, w, ""),
		);
		const bottom = formatBottomBorder(width, borderFg, status.left, status.right, status.middle, visibleWidth);
		return frameLines(rows, width, borderFg, visibleWidth, (text, w) => truncateToWidth(text, w, ""), { top, bottom });
	};

	if (originalMouse) {
		editor.handleMouse = function handleMouse(event: MouseEvent) {
			if (event.x < 1 || (typeof event.width === "number" && event.x >= event.width - 1)) return false;
			const { above, content, below, autocomplete } = layout;
			let y = event.y;
			if (y < above) return false;
			if (y < above + content) {
				y = y - above + 1; // base rows 1..n are content
			} else if (y < above + content + below) {
				return false; // viewport hint row
			} else if (y < above + content + below + autocomplete) {
				y = y - above - content - below + content + 2; // base autocomplete starts at n+2
			} else {
				return false; // bottom padding row
			}
			return originalMouse({
				...event,
				x: Math.max(0, event.x - INSET_X),
				y,
				...(typeof event.width === "number" ? { width: event.width - INSET_X * 2 } : {}),
			});
		};
	}

}
