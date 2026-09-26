/**
 * agents — primary-agent picker (OpenCode-style agents) for the main session.
 *
 * Agent definitions live in `~/.pi/agent/agents/*.md` (plus trusted-project
 * `.pi/agents/**`, which override on name collision). One agent is always
 * active; `build` is the default and matches the settings defaults.
 *
 * `alt+a` or `/agent` opens the picker, `/agent <name>` switches directly,
 * `/agent reload` re-runs discovery. Picking an agent applies its model,
 * thinking level, tools, perm mode, and system-prompt body. The active agent
 * is shown in the editor chrome via the `agents:change` event.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	DynamicBorder,
	getAgentDir,
	parseFrontmatter,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";

/** Shortcut that opens the agent picker. pi-vim sends synthetic ctrl+a/ctrl+e/ctrl+k/ctrl+r/ctrl+_, so none of those can be used. */
const PICKER_SHORTCUT = "alt+a";

const DEFAULT_AGENT = "chat";
const ACTIVE_ENTRY = "active-agent";
const CHANGE_EVENT = "agents:change";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Omitted fields mean "baseline", never "keep whatever is active now". */
interface AgentDefinition {
	name: string;
	description: string;
	model?: string;
	thinking?: ThinkingLevel;
	perm?: string;
	tools?: string[];
	/** undefined = normal skill discovery; defined (even empty) = keep only these. */
	skills?: string[];
	/** replace → customPrompt, append (default) → sections.agent. */
	systemPrompt: "replace" | "append";
	contextFiles: boolean;
	color?: string;
	body: string;
	filePath: string;
	source: "user" | "project";
}

interface Baseline {
	model?: string;
	thinking: ThinkingLevel;
	tools: string[];
	perm: string;
}

function agentDir(): string {
	try {
		return getAgentDir();
	} catch {
		return path.join(os.homedir(), ".pi", "agent");
	}
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Comma/string/array → trimmed list. Undefined/null stay undefined. */
function strList(v: unknown): string[] | undefined {
	if (v === undefined || v === null) return undefined;
	if (Array.isArray(v)) return v.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
	if (typeof v === "string") {
		if (!v.trim()) return [];
		return v.split(",").map((t) => t.trim()).filter(Boolean);
	}
	return undefined;
}

function parseThinking(v: unknown): ThinkingLevel | undefined {
	return typeof v === "string" && (THINKING_LEVELS as string[]).includes(v.trim()) ? (v.trim() as ThinkingLevel) : undefined;
}

function parseAgentFile(filePath: string, source: AgentDefinition["source"]): AgentDefinition | undefined {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}
	let fm: Record<string, unknown>;
	let body: string;
	try {
		const parsed = parseFrontmatter<Record<string, unknown>>(content);
		fm = parsed.frontmatter;
		body = parsed.body;
	} catch {
		return undefined;
	}
	const description = str(fm.description);
	if (!description) return undefined;
	const name = str(fm.name) ?? path.basename(filePath, path.extname(filePath));
	return {
		name,
		description,
		model: str(fm.model),
		thinking: parseThinking(fm.thinking),
		perm: str(fm.perm),
		tools: strList(fm.tools),
		skills: strList(fm.skills),
		systemPrompt: str(fm.systemPrompt) === "replace" ? "replace" : "append",
		contextFiles: typeof fm.contextFiles === "boolean" ? fm.contextFiles : true,
		color: str(fm.color),
		body: body.trim(),
		filePath,
		source,
	};
}

function walkMd(dir: string): string[] {
	const out: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...walkMd(p));
		else if ((e.isFile() || e.isSymbolicLink()) && e.name.endsWith(".md")) out.push(p);
	}
	return out;
}

function nearestProjectAgentsDir(cwd: string): string | null {
	let dir = path.resolve(cwd);
	while (true) {
		const candidate = path.join(dir, CONFIG_DIR_NAME, "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			/* not here */
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Project agents load only when the project is trusted: a cloned repo must
 * not shadow user agents (the TUI trust prompt is the attack surface;
 * non-TUI contexts fail open like before).
 */
function projectTrusted(ctx: ExtensionContext | undefined): boolean {
	try {
		return ctx?.isProjectTrusted?.() !== false;
	} catch {
		return true;
	}
}

/** User agents, then trusted-project overrides. `build` sorts first. */
function discoverAgents(cwd: string, trusted: boolean): AgentDefinition[] {
	const map = new Map<string, AgentDefinition>();
	for (const f of walkMd(path.join(agentDir(), "agents"))) {
		try {
			const d = parseAgentFile(f, "user");
			if (d) map.set(d.name, d);
		} catch {
			/* one bad file must not take down the catalog */
		}
	}
	if (trusted) {
		const proj = nearestProjectAgentsDir(cwd);
		if (proj) {
			for (const f of walkMd(proj)) {
				try {
					const d = parseAgentFile(f, "project");
					if (d) map.set(d.name, d);
				} catch {
					/* skip bad files */
				}
			}
		}
	}
	return [...map.values()].sort((a, b) =>
		a.name === DEFAULT_AGENT ? -1 : b.name === DEFAULT_AGENT ? 1 : a.name.localeCompare(b.name),
	);
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
		if (typeof raw === "object" && raw !== null) return raw as Record<string, unknown>;
	} catch {
		/* missing/unreadable */
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	let catalog: AgentDefinition[] = [];
	let baseline: Baseline = { thinking: "high", tools: [], perm: "default" };
	let activeName = DEFAULT_AGENT;
	let lastCtx: ExtensionContext | undefined;

	const find = (name: string): AgentDefinition | undefined => catalog.find((d) => d.name === name);
	const active = (): AgentDefinition | undefined => find(activeName) ?? find(DEFAULT_AGENT);

	/** pi's own default tools plus every extension-registered tool. */
	function baselineTools(): string[] {
		const base = ["read", "bash", "edit", "write"];
		const names = new Set(base);
		let all: { name: string; sourceInfo?: { source?: string } }[] = [];
		try {
			all = pi.getAllTools() as typeof all;
		} catch {
			all = [];
		}
		for (const t of all) {
			if (t.sourceInfo?.source !== "builtin") names.add(t.name);
		}
		const existing = new Set(all.map((t) => t.name));
		return [...names].filter((n) => existing.has(n));
	}

	function readBaselines(ctx: ExtensionContext): void {
		const settings = readJson(path.join(agentDir(), "settings.json"));
		const model =
			typeof settings?.defaultProvider === "string" && typeof settings?.defaultModel === "string"
				? `${settings.defaultProvider}/${settings.defaultModel}`
				: ctx.model
					? typeof (ctx.model as { provider?: unknown }).provider === "string"
						? `${(ctx.model as { provider: string }).provider}/${ctx.model.id}`
						: ctx.model.id
					: undefined;
		const thinking =
			parseThinking(settings?.defaultThinkingLevel) ?? (pi.getThinkingLevel() as ThinkingLevel) ?? "high";
		const permFile = readJson(path.join(agentDir(), "permission-mode", "permission-mode.json"));
		const perm = typeof permFile?.defaultMode === "string" && permFile.defaultMode.trim() ? permFile.defaultMode.trim() : "default";
		baseline = { model, thinking, tools: baselineTools(), perm };
	}

	function emitChange(def: AgentDefinition): void {
		try {
			pi.events.emit(CHANGE_EVENT, { name: def.name, color: def.color });
		} catch {
			/* chrome not listening; ignore */
		}
	}

	async function applyAgent(def: AgentDefinition, ctx: ExtensionContext): Promise<void> {
		// 1. model (setModel resets thinking, so thinking comes after).
		const spec = def.model ?? baseline.model;
		if (spec) {
			const slash = spec.indexOf("/");
			const model = slash >= 0
				? ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1))
				: ctx.modelRegistry.getAll().find((m) => m.id === spec);
			if (!model) {
				ctx.ui.notify(`agents: model "${spec}" not found; keeping current model`, "warning");
			} else {
				const ok = await pi.setModel(model);
				if (!ok) ctx.ui.notify(`agents: no auth configured for ${spec}; keeping current model`, "warning");
			}
		}
		// 2. thinking.
		pi.setThinkingLevel(def.thinking ?? baseline.thinking);
		// 3. tools, then 4. perm: perm-modes re-applies hideTools on every
		// before_agent_start, so tools must come first.
		let allNames: string[] = [];
		try {
			allNames = pi.getAllTools().map((t) => t.name);
		} catch {
			allNames = [];
		}
		const want = def.tools ?? baseline.tools;
		const unknown = want.filter((t) => !allNames.includes(t));
		if (unknown.length > 0) ctx.ui.notify(`agents: unknown tools: ${unknown.join(", ")}`, "warning");
		const valid = want.filter((t) => allNames.includes(t));
		if (valid.length > 0) pi.setActiveTools(valid);
		else ctx.ui.notify(`agents: "${def.name}" enables no known tools; keeping current tools`, "warning");
		const target = def.perm ?? baseline.perm;
		if (process.env.PI_PERMISSION_MODE !== target) {
			pi.sendUserMessage(`/perm ${target}`, { expandPromptTemplates: true });
		}
		// 5. persist + chrome.
		activeName = def.name;
		try {
			pi.appendEntry(ACTIVE_ENTRY, { name: def.name });
		} catch {
			/* persistence is best-effort */
		}
		emitChange(def);
	}

	function describe(def: AgentDefinition): string {
		return `${def.model ?? baseline.model ?? "?"} · ${def.thinking ?? baseline.thinking} · ${def.perm ?? baseline.perm}`;
	}

	async function showPicker(ctx: ExtensionContext): Promise<void> {
		if (catalog.length === 0) {
			ctx.ui.notify("agents: no agent definitions found", "warning");
			return;
		}
		const items: SelectItem[] = catalog.map((d) => ({
			value: d.name,
			label: d.name === activeName ? `${d.name} (active)` : d.name,
			description: describe(d),
		}));
		const initial = Math.max(0, catalog.findIndex((d) => d.name === activeName));
		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Select Agent"))));
			const list = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			list.setSelectedIndex(initial);
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			container.addChild(list);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • type to filter • enter select • esc cancel")));
			container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});
		if (!result) return;
		const def = find(result);
		if (!def) {
			ctx.ui.notify(`agents: unknown agent "${result}"`, "error");
			return;
		}
		await applyAgent(def, ctx);
		ctx.ui.notify(`Agent "${def.name}" activated`, "info");
	}

	/** Last persisted agent name on the current branch, if any. */
	function restoredName(ctx: ExtensionContext): string | undefined {
		try {
			const branch = ctx.sessionManager.getBranch();
			for (let i = branch.length - 1; i >= 0; i--) {
				const e = branch[i] as { type?: string; customType?: string; data?: { name?: unknown } };
				if (e?.type === "custom" && e.customType === ACTIVE_ENTRY && typeof e.data?.name === "string") {
					return e.data.name;
				}
			}
		} catch {
			/* no branch info */
		}
		return undefined;
	}

	/** Name only: model, thinking, and tools were already restored by pi. */
	function adoptName(ctx: ExtensionContext): void {
		const name = restoredName(ctx);
		const def = (name && find(name)) ?? find(DEFAULT_AGENT);
		if (!def) return;
		activeName = def.name;
		emitChange(def);
	}

	pi.registerShortcut(PICKER_SHORTCUT, {
		description: "Pick the primary agent",
		handler: async (ctx) => {
			lastCtx = ctx;
			await showPicker(ctx);
		},
	});

	pi.registerCommand("agent", {
		description: "Pick the primary agent (picker, name, or reload)",
		getArgumentCompletions: (prefix) =>
			catalog
				.filter((d) => d.name.startsWith(prefix))
				.map((d) => ({ value: d.name, label: d.name, description: d.description })),
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const rest = args.trim();
			if (!rest) {
				await showPicker(ctx);
				return;
			}
			if (rest === "reload") {
				catalog = discoverAgents(ctx.cwd, projectTrusted(ctx));
				ctx.ui.notify(`agents: reloaded ${catalog.length} agent(s)`, "info");
				return;
			}
			const def = find(rest.split(/\s+/)[0]!);
			if (!def) {
				ctx.ui.notify(`agents: unknown agent "${rest}". Available: ${catalog.map((d) => d.name).join(", ") || "none"}`, "error");
				return;
			}
			await applyAgent(def, ctx);
			ctx.ui.notify(`Agent "${def.name}" activated`, "info");
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		lastCtx = ctx;
		const def = active();
		if (!def) return;
		const opts = event.systemPromptOptions;
		if (def.body) {
			if (def.systemPrompt === "replace") opts.customPrompt = def.body;
			else opts.sections["agent"] = def.body;
		}
		if (!def.contextFiles) opts.contextFiles = [];
		if (def.skills !== undefined) {
			const keep = new Set(def.skills);
			opts.skills = opts.skills.filter((s) => keep.has(s.name));
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		lastCtx = ctx;
		catalog = discoverAgents(ctx.cwd, projectTrusted(ctx));
		readBaselines(ctx);
		const name = restoredName(ctx);
		if (!name) {
			// New session (or no entry): start from a known state.
			const def = find(DEFAULT_AGENT) ?? catalog[0];
			if (def) await applyAgent(def, ctx);
		} else {
			adoptName(ctx);
		}
	});

	// Branch navigation changes which active-agent entry is on the branch.
	pi.on("session_tree", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		lastCtx = ctx;
		adoptName(ctx);
	});
}
