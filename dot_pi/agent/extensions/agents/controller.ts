/**
 * Agent state and behavior behind the extension wiring. The controller owns the
 * catalog, the baseline, the active agent, project config, and invocation
 * grants. `index.ts` only forwards pi events and commands to it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { agentDir, DEFAULT_AGENT, discoverAgents, nearestProjectPath, projectTrusted, readFrontmatter, type AgentDefinition } from "./catalog.ts";
import { GRANT_ENTRY, pendingGrants, replayGrants, type BranchEntryLike } from "./grants.ts";
import { frontmatterToolSpecs, leadingCommandName, resolveReadPath, type SkillRefsExpanded } from "./invocations.ts";
import { parseThinking, type ThinkingLevel } from "./parse.ts";
import { showPicker } from "./picker.ts";
import {
	effectiveSkills,
	effectiveToolSpecs,
	loadProjectConfig,
	unknownAgentNames,
	type ProjectConfig,
} from "./project-config.ts";
import { expandToolSpecs, isToolPattern, unresolvedSpecs } from "./tool-specs.ts";
import { expandAgentVars } from "./vars.ts";

const CHANGE_EVENT = "agents:change";
const ACTIVE_ENTRY = "active-agent";
const SKILL_PREFIX = "skill:";
const MCP_PREFIX = "mcp__";
const GRANT_POLL_MS = 250;
const GRANT_WAIT_MS = 10_000;

/** Handlers the extension wiring calls. Each one is a single delegating call in `index.ts`. */
export interface AgentsController {
	/** Values published over `agents:vars`, read by `expandAgentVars` when an agent starts. */
	readonly agentVars: Map<string, string>;
	/** The discovered agents, default first. */
	readonly catalog: readonly AgentDefinition[];
	/**
	 * Re-discover agents and reload `.pi/agents.json` (only when the project is
	 * trusted). Returns how many agents were found. Runs on session start and `/agent reload`.
	 */
	reload(ctx: ExtensionContext): number;
	/** Switch to the agent called `name`. Resolves to false when no agent has that name. */
	switchTo(name: string, ctx: ExtensionContext): Promise<boolean>;
	/** Open the picker, prefilled with `query`, and switch to the chosen agent. */
	pick(ctx: ExtensionContext, query: string): Promise<void>;
	/** Load the catalog and baselines, then adopt the restored agent or start the default one. */
	onSessionStart(ctx: ExtensionContext): Promise<void>;
	/** Rebuild grants from the new branch, then re-adopt the agent that it restores. */
	onSessionTree(ctx: ExtensionContext): void;
	/** Shape the run's tool list and system prompt. Waits for any grant still in flight. */
	onBeforeAgentStart(event: BeforeAgentStartEvent): Promise<void>;
	/** Grant the tools of a leading `/skill:` or `/template` in raw user input. */
	onInput(event: InputEvent, ctx: ExtensionContext): void;
	/** Grant the tools of the skills and template that `skill-refs` expanded. */
	onSkillRefsExpanded(payload: SkillRefsExpanded, ctx: ExtensionContext): void;
	/** Grant the tools of a skill that the model read, when the active agent advertises it. */
	onToolResult(event: ToolResultEvent, ctx: ExtensionContext): void;
}

/** Settings defaults for agents that do not set a model or thinking level. */
interface Baseline {
	model?: string;
	thinking: ThinkingLevel;
	tools: string[];
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The real path of `file`, or undefined when it does not exist. */
function realpathOf(file: string): string | undefined {
	try {
		return fs.realpathSync(file);
	} catch {
		return undefined;
	}
}

/**
 * Create the controller for one extension instance. The controller keeps its
 * state in closures and calls `pi` for every host operation.
 */
export function createAgentsController(pi: ExtensionAPI): AgentsController {
	const agentVars = new Map<string, string>();
	let catalog: AgentDefinition[] = [];
	let baseline: Baseline = { thinking: "high", tools: [] };
	let activeName = DEFAULT_AGENT;
	let projectConfig: ProjectConfig = {};
	let grants: string[] = [];
	let inflight: Promise<void> = Promise.resolve();

	const find = (name: string): AgentDefinition | undefined => catalog.find((d) => d.name === name);
	const active = (): AgentDefinition | undefined => find(activeName) ?? find(DEFAULT_AGENT);

	/** Every registered tool name, or none when pi cannot list them. */
	function allToolNames(): string[] {
		try {
			return pi.getAllTools().map((t) => t.name);
		} catch {
			return [];
		}
	}

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
		let settings: Record<string, unknown> | undefined;
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(path.join(agentDir(), "settings.json"), "utf-8"));
			if (typeof parsed === "object" && parsed !== null) settings = parsed as Record<string, unknown>;
		} catch {
			/* no settings file */
		}
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
		baseline = { model, thinking, tools: baselineTools() };
	}

	function emitChange(def: AgentDefinition): void {
		try {
			pi.events.emit(CHANGE_EVENT, { name: def.name, color: def.color });
		} catch {
			/* chrome not listening; ignore */
		}
	}

	/** The tool specs an agent gets this run: its own, project additions, and grants. */
	function effectiveSpecs(def: AgentDefinition): string[] | undefined {
		return effectiveToolSpecs(def, projectConfig[def.name], baseline.tools, grants);
	}

	/**
	 * Apply an agent's tool set, or the baseline when it defines none. Warns
	 * about unknown tools in the agent definition and keeps the current set when
	 * nothing is known. Project and grant specs that match nothing stay pending
	 * without a warning.
	 */
	function applyTools(def: AgentDefinition, ctx: ExtensionContext): void {
		const names = allToolNames();
		const unknown = unresolvedSpecs(def.tools ?? [], names).filter((spec) => !isToolPattern(spec));
		if (unknown.length > 0) ctx.ui.notify(`agents: unknown tools: ${unknown.join(", ")}`, "warning");
		const valid = expandToolSpecs(effectiveSpecs(def) ?? baseline.tools, names);
		if (valid.length > 0) pi.setActiveTools(valid);
		else ctx.ui.notify(`agents: "${def.name}" enables no known tools; keeping current tools`, "warning");
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
		// 3. tools.
		applyTools(def, ctx);
		// 4. persist + chrome.
		activeName = def.name;
		try {
			pi.appendEntry(ACTIVE_ENTRY, { name: def.name });
		} catch {
			/* persistence is best-effort */
		}
		emitChange(def);
	}

	function describe(def: AgentDefinition): string {
		return `${def.model ?? baseline.model ?? "?"} · ${def.thinking ?? baseline.thinking}`;
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

	/** The entries of the current branch, or none when they cannot be read. */
	function branchEntries(ctx: ExtensionContext): BranchEntryLike[] {
		try {
			return ctx.sessionManager.getBranch() as BranchEntryLike[];
		} catch {
			return [];
		}
	}

	/**
	 * Adopt the agent restored from the transcript on resume, reload, or branch
	 * navigation: resolve the restored name (falling back to the default), then
	 * re-apply its tools and announce the change. Core restores the model and
	 * thinking from the session, but not the tools.
	 */
	function adoptAgent(ctx: ExtensionContext): void {
		const name = restoredName(ctx);
		const def = (name && find(name)) ?? find(DEFAULT_AGENT);
		if (!def) return;
		activeName = def.name;
		applyTools(def, ctx);
		emitChange(def);
	}

	function reload(ctx: ExtensionContext): number {
		const trusted = projectTrusted(ctx);
		catalog = discoverAgents(ctx.cwd, trusted);
		const loaded = trusted
			? loadProjectConfig(nearestProjectPath(ctx.cwd, "agents.json"))
			: { config: {} as ProjectConfig };
		projectConfig = loaded.config;
		if (loaded.error) ctx.ui.notify(loaded.error, "warning");
		for (const name of unknownAgentNames(projectConfig, catalog.map((d) => d.name))) {
			ctx.ui.notify(`agents: .pi/agents.json names unknown agent "${name}"`, "warning");
		}
		return catalog.length;
	}

	async function switchTo(name: string, ctx: ExtensionContext): Promise<boolean> {
		const def = find(name);
		if (!def) return false;
		await applyAgent(def, ctx);
		ctx.ui.notify(`Agent "${def.name}" activated`, "info");
		return true;
	}

	async function pick(ctx: ExtensionContext, query: string): Promise<void> {
		if (catalog.length === 0) {
			ctx.ui.notify("agents: no agent definitions found", "warning");
			return;
		}
		const chosen = await showPicker(ctx, catalog, activeName, describe, query);
		if (!chosen) return;
		const def = find(chosen);
		if (!def) {
			ctx.ui.notify(`agents: unknown agent "${chosen}"`, "error");
			return;
		}
		await applyAgent(def, ctx);
		ctx.ui.notify(`Agent "${def.name}" activated`, "info");
	}

	/**
	 * Grant `specs` for the rest of the session. The grant is recorded at once, so a
	 * second source for the same invocation finds nothing pending. Tool activation
	 * waits in the background, and `inflight` keeps the next run waiting for it.
	 */
	function grant(specs: string[], label: string, ctx: ExtensionContext): void {
		const fresh = pendingGrants(specs, grants, pi.getActiveTools(), allToolNames());
		if (fresh.length === 0) return;
		grants = [...grants, ...fresh];
		try {
			pi.appendEntry(GRANT_ENTRY, { tools: fresh, source: label });
		} catch {
			/* persistence is best-effort */
		}
		inflight = Promise.all([inflight, activateGrants(fresh, label, ctx)]).then(() => undefined);
	}

	/**
	 * Enable granted specs now. MCP tools register asynchronously, so MCP specs
	 * that do not resolve yet are polled for up to `GRANT_WAIT_MS`. Specs that still
	 * do not resolve stay granted and are enabled once their tools register.
	 */
	async function activateGrants(specs: string[], label: string, ctx: ExtensionContext): Promise<void> {
		let names = allToolNames();
		const deadline = Date.now() + GRANT_WAIT_MS;
		while (unresolvedSpecs(specs, names).some((spec) => spec.startsWith(MCP_PREFIX)) && Date.now() < deadline) {
			await sleep(GRANT_POLL_MS);
			names = allToolNames();
		}
		const resolved = expandToolSpecs(specs, names);
		if (resolved.length > 0) {
			pi.setActiveTools([...new Set([...pi.getActiveTools(), ...resolved])]);
			ctx.ui.notify(`agents: enabled ${resolved.join(", ")} (from ${label})`, "info");
		}
		const missing = unresolvedSpecs(specs, names);
		if (missing.length > 0) {
			ctx.ui.notify(`agents: ${missing.join(", ")} not registered yet; enabled once available (from ${label})`, "warning");
		}
	}

	return {
		agentVars,
		get catalog() {
			return catalog;
		},
		reload,
		switchTo,
		pick,
		async onSessionStart(ctx: ExtensionContext): Promise<void> {
			if (!ctx.hasUI) return;
			reload(ctx);
			readBaselines(ctx);
			grants = replayGrants(branchEntries(ctx));
			const name = restoredName(ctx);
			if (!name) {
				// New session (or no entry): start from a known state.
				const def = find(DEFAULT_AGENT) ?? catalog[0];
				if (def) await applyAgent(def, ctx);
			} else {
				adoptAgent(ctx);
			}
		},
		onSessionTree(ctx: ExtensionContext): void {
			if (!ctx.hasUI) return;
			grants = replayGrants(branchEntries(ctx));
			adoptAgent(ctx);
		},
		async onBeforeAgentStart(event: BeforeAgentStartEvent): Promise<void> {
			await inflight;
			const def = active();
			if (!def) return;
			const opts = event.systemPromptOptions;
			const specs = effectiveSpecs(def);
			if (specs !== undefined) {
				const names = allToolNames();
				const expanded = expandToolSpecs(specs, names);
				const projectOrGrant = new Set(expandToolSpecs([...(projectConfig[def.name]?.tools ?? []), ...grants], names));
				const current = new Set(opts.selectedTools);
				const next = expanded.filter((name) => current.has(name) || projectOrGrant.has(name));
				const changed = next.length !== opts.selectedTools.length || next.some((n, i) => n !== opts.selectedTools[i]);
				if (changed) opts.selectedTools = next;
			}
			if (def.body) {
				const body = expandAgentVars(def.body, agentVars);
				if (def.systemPrompt === "replace") opts.customPrompt = body;
				else opts.sections["agent"] = body;
			}
			if (!def.contextFiles) opts.contextFiles = [];
			const skills = effectiveSkills(def, projectConfig[def.name]);
			if (skills !== undefined) {
				const keep = new Set(skills);
				opts.skills = opts.skills.filter((s) => keep.has(s.name));
			}
		},
		onInput(event: InputEvent, ctx: ExtensionContext): void {
			if (event.source === "extension") return;
			const name = leadingCommandName(event.text);
			if (name === undefined) return;
			const command = pi
				.getCommands()
				.find((c) => c.name === name && (c.source === "skill" || c.source === "prompt"));
			if (!command) return;
			const fm = readFrontmatter(command.sourceInfo.path);
			if (!fm) return;
			const specs = frontmatterToolSpecs(command.source === "skill" ? "skill" : "prompt", fm);
			if (specs.length > 0) grant(specs, name, ctx);
		},
		onSkillRefsExpanded(payload: SkillRefsExpanded, ctx: ExtensionContext): void {
			const specs: string[] = [];
			for (const skill of payload.skills) {
				const fm = readFrontmatter(skill.path);
				if (fm) specs.push(...frontmatterToolSpecs("skill", fm));
			}
			if (payload.template) {
				const fm = readFrontmatter(payload.template.path);
				if (fm) specs.push(...frontmatterToolSpecs("prompt", fm));
			}
			const labels = [
				...payload.skills.map((skill) => `${SKILL_PREFIX}${skill.name}`),
				...(payload.template ? [payload.template.name] : []),
			];
			if (specs.length > 0) grant(specs, labels.join(", "), ctx);
		},
		onToolResult(event: ToolResultEvent, ctx: ExtensionContext): void {
			if (event.toolName !== "read" || event.isError) return;
			const rawPath = event.input.path;
			if (typeof rawPath !== "string") return;
			const target = realpathOf(resolveReadPath(rawPath, ctx.cwd));
			if (target === undefined) return;
			const skill = pi.getCommands().find((c) => c.source === "skill" && realpathOf(c.sourceInfo.path) === target);
			if (!skill) return;
			const fm = readFrontmatter(skill.sourceInfo.path);
			if (!fm || fm["disable-model-invocation"] === true) return;
			const def = active();
			const listed = def ? effectiveSkills(def, projectConfig[def.name]) : undefined;
			if (listed !== undefined && !listed.includes(skill.name.slice(SKILL_PREFIX.length))) return;
			const specs = frontmatterToolSpecs("skill", fm);
			if (specs.length > 0) grant(specs, skill.name, ctx);
		},
	};
}
