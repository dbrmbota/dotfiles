/**
 * Agent catalog: definition shape, discovery from the agent directories, and
 * small file readers. Imports pi only for paths and frontmatter parsing.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	parseFrontmatter,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parseThinking, str, strList, type ThinkingLevel } from "./parse.ts";

/** The agent used when none is named, and the first entry in the catalog. */
export const DEFAULT_AGENT = "chat";

/**
 * One agent definition read from a markdown file. Omitted fields mean
 * "baseline", never "keep whatever is active now".
 */
export interface AgentDefinition {
	name: string;
	description: string;
	model?: string;
	thinking?: ThinkingLevel;
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

/** The pi agent directory, falling back to `~/.pi/agent` when pi cannot report it. */
export function agentDir(): string {
	try {
		return getAgentDir();
	} catch {
		return path.join(os.homedir(), ".pi", "agent");
	}
}

/** Parse one agent markdown file. Undefined when it is unreadable or has no description. */
export function parseAgentFile(filePath: string, source: AgentDefinition["source"]): AgentDefinition | undefined {
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

/** Markdown files under `dir`, recursively, sorted by name. Missing directories give an empty list. */
export function walkMd(dir: string): string[] {
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

/**
 * The nearest existing `.pi/<rel>` directory or file from `cwd` upwards, or
 * null when no ancestor has one.
 */
export function nearestProjectPath(cwd: string, rel: string): string | null {
	let dir = path.resolve(cwd);
	while (true) {
		const candidate = path.join(dir, CONFIG_DIR_NAME, rel);
		try {
			fs.statSync(candidate);
			return candidate;
		} catch {
			/* not here */
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Project resources load only when the project is trusted: a cloned repo must
 * not shadow user agents. Non-TUI contexts fail open.
 */
export function projectTrusted(ctx: ExtensionContext | undefined): boolean {
	try {
		return ctx?.isProjectTrusted?.() !== false;
	} catch {
		return true;
	}
}

/**
 * Agents from the user directory, then trusted-project overrides on name
 * collision. The default agent sorts first.
 */
export function discoverAgents(cwd: string, trusted: boolean): AgentDefinition[] {
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
		const proj = nearestProjectPath(cwd, "agents");
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

/** The frontmatter of a markdown file, or undefined when it is unreadable. */
export function readFrontmatter(filePath: string): Record<string, unknown> | undefined {
	try {
		return parseFrontmatter<Record<string, unknown>>(fs.readFileSync(filePath, "utf-8")).frontmatter;
	} catch {
		return undefined;
	}
}
