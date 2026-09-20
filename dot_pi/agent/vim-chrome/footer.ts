import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import {
	RESET,
	RESET_BG,
	bgAnsi,
	fgAnsi,
	fgToBg,
	modeColor,
	modeKindFromLabel,
} from "./style";
import { formatCount, sessionUsage, tokenLabel } from "./usage";

export type FooterOptions = {
	icons: {
		branch: string;
		cache: string;
		separatorRight: string;
		separatorLeft: string;
	};
	contextThresholds: { warning: number; error: number };
};

type FooterData = Parameters<
	NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>
>[2];

type Segment = {
	text: string; // may contain fg SGR, must not contain bg
	/** Background SGR used for the surface and for powerline glyph colours. */
	bg: string;
	/**
	 * Accent segments are drawn as `inverse` of the mode colour: the glyphs take
	 * the terminal's own background colour, so nothing is hardcoded.
	 */
	accentFg?: string;
	fg?: string;
	priority: number; // higher = dropped later when narrow
};

function paint(theme: Theme, seg: Segment): string {
	if (seg.accentFg) {
		return `${RESET}${seg.accentFg}${theme.bold(theme.inverse(` ${seg.text} `))}${RESET}`;
	}
	return `${seg.bg}${seg.fg ?? ""} ${seg.text} ${RESET}`;
}

function bgOnly(bg: string): string {
	// A background sequence as a foreground sequence, for powerline glyphs.
	return bg
		.replace(/\x1b\[48;/g, "\x1b[38;")
		.replace(/\x1b\[4([0-7])m/g, "\x1b[3$1m")
		.replace(/\x1b\[10([0-7])m/g, "\x1b[9$1m");
}

/** Left-to-right powerline chain, ending in a transparent tail. */
function chainLeft(theme: Theme, segments: Segment[], sep: string): string {
	let out = "";
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!;
		const next = segments[i + 1];
		out += paint(theme, seg);
		out += `${bgOnly(seg.bg)}${next ? next.bg : RESET_BG}${sep}${RESET}`;
	}
	return out;
}

/** Right-to-left powerline chain, starting from a transparent head. */
function chainRight(theme: Theme, segments: Segment[], sep: string): string {
	let out = "";
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!;
		const prev = segments[i - 1];
		out += `${prev ? prev.bg : RESET_BG}${bgOnly(seg.bg)}${sep}${RESET}`;
		out += paint(theme, seg);
	}
	return out;
}

function compactionEnabled(ctx: ExtensionContext): boolean {
	try {
		return SettingsManager.create(ctx.cwd).getCompactionEnabled();
	} catch {
		return false;
	}
}

export function createFooterFactory(
	ctx: ExtensionContext,
	getModeLabel: () => string,
	options: FooterOptions,
) {
	let autoCompaction = compactionEnabled(ctx);
	const refreshSettings = () => {
		autoCompaction = compactionEnabled(ctx);
	};

	const factory = (tui: { requestRender(): void }, theme: Theme, footerData: FooterData) => {
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
		return {
			dispose: unsubscribe,
			invalidate() {},
			render(width: number): string[] {
				if (width <= 0) return ["", ""];
				const label = getModeLabel();
				const kind = modeKindFromLabel(label);
				const modeText = kind === "ex" ? "EX" : label.trim();

				const accentFg = fgAnsi(theme, modeColor(kind));
				const accentBg = fgToBg(accentFg);
				const surfaceBg = bgAnsi(theme, "selectedBg");
				const surfaceAltBg = bgAnsi(theme, "userMessageBg");
				const textFg = fgAnsi(theme, "text");
				const mutedFg = fgAnsi(theme, "muted");

				// ── left ───────────────────────────────────────────────
				const left: Segment[] = [
					{ text: modeText, bg: accentBg, accentFg, priority: 100 },
				];
				const cwd = basename(ctx.cwd) || ctx.cwd;
				const session = ctx.sessionManager.getSessionName?.() ?? "";
				const branch = footerData.getGitBranch();
				const where = [
					cwd,
					session ? `in ${session}` : "",
					branch ? `on ${options.icons.branch} ${branch}` : "",
				]
					.filter(Boolean)
					.join(" ");
				left.push({ text: where, bg: surfaceBg, fg: textFg, priority: 60 });

				// ── right ──────────────────────────────────────────────
				const right: Segment[] = [];
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
					right.push({
						text: `${pctFg}${percent.toFixed(1)}%${textFg}${total}${auto}`,
						bg: surfaceBg,
						fg: textFg,
						priority: 70,
					});
				}
				const tokens = tokenLabel(sessionUsage(ctx), options.icons.cache);
				if (tokens) {
					right.push({ text: tokens, bg: surfaceAltBg, fg: textFg, priority: 40 });
				}
				const cost = sessionUsage(ctx).cost;
				if (cost > 0) {
					right.push({ text: `$${cost.toFixed(3)}`, bg: accentBg, accentFg, priority: 50 });
				}

				// ── middle: extension statuses ─────────────────────────
				const statuses = [...footerData.getExtensionStatuses().values()]
					.map((s) => s.trim())
					.filter(Boolean);
				let middle = statuses.length ? ` ${mutedFg}${statuses.join("  ")}${RESET}` : "";

				// ── fit ────────────────────────────────────────────────
				const compose = () => {
					const l = chainLeft(theme, left, options.icons.separatorRight);
					const r = chainRight(theme, right, options.icons.separatorLeft);
					return { l, r, w: visibleWidth(l) + visibleWidth(r) + visibleWidth(middle) };
				};
				let { l, r, w } = compose();
				while (w > width) {
					if (middle) {
						middle = "";
					} else {
						const all = [...left, ...right].sort((a, b) => a.priority - b.priority);
						const victim = all[0];
						if (!victim || victim.priority >= 100) break;
						const li = left.indexOf(victim);
						if (li >= 0) left.splice(li, 1);
						const ri = right.indexOf(victim);
						if (ri >= 0) right.splice(ri, 1);
					}
					({ l, r, w } = compose());
				}
				const gap = Math.max(0, width - w);
				const line = `${l}${middle}${" ".repeat(gap)}${r}`;
				// Blank spacer row keeps the powerline off the editor chrome.
				return ["", truncateToWidth(line, width, "")];
			},
		};
	};

	return { factory, refreshSettings };
}
