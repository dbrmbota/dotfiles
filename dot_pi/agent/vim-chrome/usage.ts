import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	latestCacheHitRate: number | undefined;
	cost: number;
};

type Usage = {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cost?: { total?: unknown } | null;
};

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function cacheHitRate(input: number, cacheRead: number, cacheWrite: number): number | undefined {
	const prompt = input + cacheRead + cacheWrite;
	if (prompt === 0) return undefined;
	return (cacheRead / prompt) * 100;
}

export function formatCount(value: number): string {
	if (value < 1000) return value.toString();
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
	if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	return `${Math.round(value / 1_000_000)}M`;
}

type Entry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];

function usageFor(entry: Entry): { usage: Usage | undefined; assistant: boolean } | undefined {
	const e = entry as unknown as {
		type?: string;
		usage?: Usage;
		message?: { role?: string; usage?: Usage };
	};
	if (e.type === "message") {
		const role = e.message?.role;
		if (role !== "assistant" && role !== "toolResult") return undefined;
		return { usage: e.message?.usage, assistant: role === "assistant" };
	}
	if (e.type === "compaction" || e.type === "branch_summary") {
		return { usage: e.usage, assistant: false };
	}
	return undefined;
}

let cache: { key: string; totals: UsageTotals } | undefined;

export function sessionUsage(ctx: ExtensionContext): UsageTotals {
	const entries = ctx.sessionManager.getBranch();
	const last = entries.at(-1) as unknown as
		| { id?: string; message?: { usage?: Usage }; usage?: Usage }
		| undefined;
	const lastUsage = last?.message?.usage ?? last?.usage;
	const key = `${entries.length}:${last?.id ?? ""}:${num(lastUsage?.output)}:${num(
		lastUsage?.input,
	)}:${num(lastUsage?.cost?.total)}`;
	if (cache?.key === key) return cache.totals;

	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let latestCacheHitRate: number | undefined;
	for (const entry of entries) {
		const selected = usageFor(entry);
		if (!selected) continue;
		const u = selected.usage;
		const i = num(u?.input);
		const r = num(u?.cacheRead);
		const w = num(u?.cacheWrite);
		input += i;
		output += num(u?.output);
		cacheRead += r;
		cacheWrite += w;
		cost += num(u?.cost?.total);
		if (selected.assistant) latestCacheHitRate = cacheHitRate(i, r, w);
	}
	const totals = { input, output, cacheRead, cacheWrite, latestCacheHitRate, cost };
	cache = { key, totals };
	return totals;
}

export function tokenLabel(totals: UsageTotals, cacheIcon: string): string {
	const parts: string[] = [];
	if (totals.input) parts.push(`↑${formatCount(totals.input)}`);
	if (totals.output) parts.push(`↓${formatCount(totals.output)}`);
	const hasCache = totals.cacheRead > 0 || totals.cacheWrite > 0;
	if (hasCache && totals.latestCacheHitRate !== undefined) {
		parts.push(`${cacheIcon} ${totals.latestCacheHitRate.toFixed(1)}%`);
	}
	if (totals.cacheRead > 0) parts.push(`R${formatCount(totals.cacheRead)}`);
	if (totals.cacheWrite > 0) parts.push(`W${formatCount(totals.cacheWrite)}`);
	return parts.join(" ");
}
