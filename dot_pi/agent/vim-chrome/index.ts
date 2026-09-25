/**
 * vim-chrome — opencode-style editor frame + LazyVim-style powerline footer
 * on top of pi-vim's ModalEditor.
 *
 * Load order in settings.json must be: npm:pi-vim, ./vim-chrome, npm:pi-zentui.
 * Zentui must have components.editor.enabled=false and footer.style="native".
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ChromedEditor, type VimEditorLike, installEditorChrome } from "./editor";
import { createFooterFactory } from "./footer";
import { installBlockChrome } from "./blocks";

const OPTIONS = {
	editor: {
		bodyBackground: true, // opencode-style input surface; false = rail only
		railGlyph: "┃", // drawn in the mode colour
		railCapGlyph: "╹", // half-height stub closing the rail on the final row
	},
	footer: {
		icons: {
			branch: "\ue0a0", //
			cache: "\udb80\udd9c", // 󰆼
			separatorRight: "\ue0b0", //
			separatorLeft: "\ue0b2", //
		},
		contextThresholds: { warning: 70, error: 90 },
		hiddenStatuses: ["perm"], // perm mode is tied to the active agent; the chip is noise
	},
	blocks: {
		railGlyph: "┃",
		// Rail colour per block background (user messages, tool calls, compaction/custom).
		railColors: {
			userMessageBg: "accent",
			toolPendingBg: "warning",
			toolSuccessBg: "success",
			toolErrorBg: "error",
			customMessageBg: "customMessageLabel",
		},
	} as const,
};

export default function (pi: ExtensionAPI) {
	let chromed: ChromedEditor | undefined;
	let requestRender: (() => void) | undefined;
	let agent: { name: string; color?: string } | undefined;

	// Registered at load (before session_start) so the event emitted at startup is not missed.
	pi.events.on("agents:change", (data) => {
		try {
			const d = data as { name?: unknown; color?: unknown };
			if (d && typeof d.name === "string" && d.name) {
				agent = { name: d.name, color: typeof d.color === "string" ? d.color : undefined };
			} else {
				agent = undefined;
			}
		} catch {
			agent = undefined;
		}
		requestRender?.();
	});

	const modeLabel = () => chromed?.modeLabel() ?? " INSERT ";

	const install = (ctx: ExtensionContext) => {
		const previous = ctx.ui.getEditorComponent();
		if (typeof previous !== "function") return; // pi-vim not loaded before us

		const meta = () => ({
			model: ctx.model?.id,
			provider: ctx.model?.provider,
			thinking: ctx.thinkingLevel,
			agent,
		});

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = previous(tui, theme, keybindings) as unknown as VimEditorLike;
			requestRender = () => tui.requestRender();
			// Read the full pi Theme live so /theme switches are picked up.
			chromed = installEditorChrome(editor, () => ctx.ui.theme, OPTIONS.editor, meta);
			return editor as unknown as ReturnType<typeof previous>;
		});

		const footer = createFooterFactory(ctx, modeLabel, OPTIONS.footer);
		ctx.ui.setFooter(footer.factory);
		return footer;
	};

	let footer: ReturnType<typeof createFooterFactory> | undefined;
	let uninstallBlocks: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		footer = install(ctx);
		uninstallBlocks ??= installBlockChrome(() => ctx.ui.theme, OPTIONS.blocks);
	});

	// Footer/editor read live state on every render; just make sure a frame happens.
	pi.events.on("pi-vim:mode-change", () => requestRender?.());
	pi.on("model_select", () => requestRender?.());
	pi.on("turn_end", () => requestRender?.());
	pi.on("agent_end", () => {
		footer?.refreshSettings();
		requestRender?.();
	});

	pi.on("session_shutdown", () => {
		uninstallBlocks?.();
		uninstallBlocks = undefined;
		chromed = undefined;
		requestRender = undefined;
	});
}
