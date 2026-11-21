/**
 * vim-chrome — opencode-style editor frame + LazyVim-style powerline footer
 * on top of pi-vim's ModalEditor.
 *
 * Load order in settings.json must be: npm:pi-vim, ./extensions/vim-chrome, npm:pi-zentui.
 * Keep the ./extensions/vim-chrome entry in settings.json packages even though it lives in
 * extensions/: auto-discovered extensions rank ahead of packages, so without the entry this
 * would load before pi-vim and install() would bail.
 * Zentui must have components.editor.enabled=false and footer.style="native".
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type VimEditorLike, installEditorChrome } from "./editor";
import { type FooterMeta, createFooterFactory } from "./footer";
import { installBlockChrome } from "./blocks";

const OPTIONS = {
	footer: {
		icons: {
			cache: "\udb80\udd9c",
		},
		contextThresholds: { warning: 70, error: 90 },
		hiddenStatuses: ["sandbox"], // the pi-sandbox chip is noise
	},
	scrollIndicatorCaps: { capLeft: "\ue0b6", capRight: "\ue0b4" },
};

export default function (pi: ExtensionAPI) {
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

	const install = (ctx: ExtensionContext) => {
		const previous = ctx.ui.getEditorComponent();
		if (typeof previous !== "function") return; // pi-vim not loaded before us

		const meta = (): FooterMeta => ({
			model: ctx.model?.id,
			provider: ctx.model?.provider,
			thinking: ctx.thinkingLevel,
			agent,
		});

		const footer = createFooterFactory(ctx, meta, OPTIONS.footer);
		// setFooter first, so footerData is captured before the editor's first render.
		ctx.ui.setFooter(footer.footerFactory);

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = previous(tui, theme, keybindings) as unknown as VimEditorLike;
			requestRender = () => tui.requestRender();
			// Read the full pi Theme live so /theme switches are picked up.
			installEditorChrome(editor, () => ctx.ui.theme, footer.getStatus);
			return editor as unknown as ReturnType<typeof previous>;
		});
		return footer;
	};

	let footer: ReturnType<typeof createFooterFactory> | undefined;
	let uninstallBlocks: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		footer = install(ctx);
		uninstallBlocks ??= installBlockChrome(() => ctx.ui.theme, OPTIONS.scrollIndicatorCaps);
	});

	// Footer/editor read live state on every render; just make sure a frame happens.
	pi.events.on("pi-vim:mode-change", () => requestRender?.());
	pi.on("model_select", () => requestRender?.());
	pi.on("thinking_level_select", () => requestRender?.());
	pi.on("turn_end", () => requestRender?.());
	pi.on("agent_end", () => {
		footer?.refreshSettings();
		requestRender?.();
	});

	pi.on("session_shutdown", () => {
		uninstallBlocks?.();
		uninstallBlocks = undefined;
		footer = undefined;
		requestRender = undefined;
	});
}
