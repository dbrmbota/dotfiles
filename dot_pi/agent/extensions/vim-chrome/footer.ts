import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { BorderItem } from "./border";
import { RESET, type ModeKind, fgAnsi, modeColor } from "./style";
import { formatCount, sessionUsage, tokenLabel } from "./usage";

type ThemeColor = Parameters<Theme["fg"]>[0];

export type FooterOptions = {
	icons: {
		cache: string;
	};
	contextThresholds: { warning: number; error: number };
	/** Status keys (from ctx.ui.setStatus) hidden from the footer middle. */
	hiddenStatuses: string[];
};

/** Items for the editor's bottom border: `left` and `right` are item lists, `middle` is pre-styled text. */
export type BorderStatus = { left: BorderItem[]; right: BorderItem[]; middle: string };

export type FooterMeta = {
	model?: string;
	provider?: string;
	thinking?: string;
	agent?: { name: string; color?: string };
};

type FooterData = Parameters<
	NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>
>[2];

function compactionEnabled(ctx: ExtensionContext): boolean {
	try {
		return SettingsManager.create(ctx.cwd).getCompactionEnabled();
	} catch {
		return false;
	}
}

/**
 * Creates the footer parts. `footerFactory` is pi's bottom footer: it captures the footer data and renders
 * no rows. `getStatus` returns the items for the editor's bottom border for a vim mode kind.
 */
export function createFooterFactory(ctx: ExtensionContext, getMeta: () => FooterMeta, options: FooterOptions) {
	let autoCompaction = compactionEnabled(ctx);
	const refreshSettings = () => {
		autoCompaction = compactionEnabled(ctx);
	};

	/** Extension statuses captured by footerFactory for getStatus. */
	let footerData: FooterData | undefined;

	/**
	 * Bottom border items: agent, model and effort on the left; context, tokens and cost on the right;
	 * extension statuses in the middle. Mode accent colour comes from `kind`.
	 */
	const getStatus = (theme: Theme, kind: ModeKind): BorderStatus => {
		const accentFg = fgAnsi(theme, modeColor(kind));
		const textFg = fgAnsi(theme, "text");
		const mutedFg = fgAnsi(theme, "muted");
		const meta = getMeta();

		// ── left ───────────────────────────────────────────────
		const left: BorderItem[] = [];
		if (meta.agent?.name) {
			const agentColor = (meta.agent.color ?? modeColor(kind)) as ThemeColor;
			left.push({ text: `${fgAnsi(theme, agentColor)}${meta.agent.name}`, priority: 65 });
		}
		const model = [meta.provider, meta.model].filter(Boolean).join("/");
		if (model) {
			left.push({ text: `${textFg}${model}`, priority: 60 });
		}
		if (meta.thinking && meta.thinking.toLowerCase() !== "off") {
			left.push({ text: `${mutedFg}${meta.thinking}`, priority: 45 });
		}

		// ── right ──────────────────────────────────────────────
		const right: BorderItem[] = [];
		const usage = ctx.getContextUsage();
		const contextWindow = ctx.model?.contextWindow ?? usage?.contextWindow;
		const percent = usage?.percent ?? undefined;
		if (percent !== undefined && Number.isFinite(percent)) {
			const tier =
				percent >= options.contextThresholds.error
					? "error"
					: percent >= options.contextThresholds.warning
						? "warning"
						: undefined;
			const pctFg = tier ? fgAnsi(theme, tier) : textFg;
			const total = contextWindow ? `/${formatCount(contextWindow)}` : "";
			const auto = autoCompaction ? ` ${mutedFg}(auto)` : "";
			right.push({ text: `${pctFg}${percent.toFixed(1)}%${textFg}${total}${auto}`, priority: 70 });
		}
		const tokens = tokenLabel(sessionUsage(ctx), options.icons.cache);
		if (tokens) {
			right.push({ text: `${textFg}${tokens}`, priority: 40 });
		}
		const cost = sessionUsage(ctx).cost;
		if (cost > 0) {
			right.push({ text: `${accentFg}$${cost.toFixed(3)}`, priority: 50 });
		}

		// ── middle: extension statuses ─────────────────────────
		const hidden = new Set(options.hiddenStatuses);
		const statuses = [...(footerData?.getExtensionStatuses().entries() ?? [])]
			.filter(([key]) => !hidden.has(key))
			.map(([, s]) => s.trim())
			.filter(Boolean);
		const middle = statuses.length ? `${mutedFg}${statuses.join("  ")}${RESET}` : "";

		return { left, right, middle };
	};

	/** Bottom footer: captures `footerData` and renders no rows, so pi's footer takes 0 rows. */
	const footerFactory = (_tui: { requestRender(): void }, _theme: Theme, data: FooterData) => {
		footerData = data;
		return {
			dispose() {
				footerData = undefined;
			},
			invalidate() {},
			render: (): string[] => [],
		};
	};

	return { footerFactory, getStatus, refreshSettings };
}
