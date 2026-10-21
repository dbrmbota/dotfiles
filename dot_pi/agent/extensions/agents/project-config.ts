/**
 * `.pi/agents.json`: extra skills and tools for named agents in one project.
 * Merging is additive only. Pure apart from reading the file.
 */

import * as fs from "node:fs";
import type { AgentDefinition } from "./catalog.ts";
import { strList } from "./parse.ts";

/** One agent's entry in `.pi/agents.json`. Unknown keys are ignored. */
export interface ProjectAgentEntry {
	skills?: string[];
	tools?: string[];
}

/** The parsed file, keyed by agent name. */
export type ProjectConfig = Record<string, ProjectAgentEntry>;

/** A loaded config and, when the file was not valid JSON, the error to show once. */
export interface LoadedProjectConfig {
	config: ProjectConfig;
	error?: string;
}

/** A plain object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The values of `lists` joined in order, without duplicates. */
function union(...lists: (readonly string[] | undefined)[]): string[] {
	const out = new Set<string>();
	for (const list of lists) for (const item of list ?? []) out.add(item);
	return [...out];
}

/**
 * Read `file` (null when the project has none). A missing file gives an empty
 * config without an error. Invalid JSON gives an empty config and an error.
 */
export function loadProjectConfig(file: string | null): LoadedProjectConfig {
	if (file === null) return { config: {} };
	let text: string;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return { config: {} };
		return { config: {}, error: `agents: could not read ${file}` };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { config: {}, error: `agents: ${file} is not valid JSON` };
	}
	return { config: parseProjectConfig(raw) };
}

/**
 * Parse decoded JSON into a project config. Non-object values are skipped, and
 * so are non-object agent entries. Each list accepts an array or a comma string.
 */
export function parseProjectConfig(raw: unknown): ProjectConfig {
	if (!isRecord(raw)) return {};
	const config: ProjectConfig = {};
	for (const [name, value] of Object.entries(raw)) {
		if (!isRecord(value)) continue;
		const entry: ProjectAgentEntry = {};
		const skills = strList(value.skills);
		if (skills !== undefined) entry.skills = skills;
		const tools = strList(value.tools);
		if (tools !== undefined) entry.tools = tools;
		config[name] = entry;
	}
	return config;
}

/** Agent names in `config` that are not in `catalogNames`, in config order. */
export function unknownAgentNames(config: ProjectConfig, catalogNames: readonly string[]): string[] {
	return Object.keys(config).filter((name) => !catalogNames.includes(name));
}

/**
 * The skill names for an agent. When `def.skills` is defined, the result is
 * `def.skills` plus the project skills, without duplicates. Otherwise undefined,
 * which keeps normal skill discovery.
 */
export function effectiveSkills(def: AgentDefinition, entry: ProjectAgentEntry | undefined): string[] | undefined {
	if (def.skills === undefined) return undefined;
	return union(def.skills, entry?.skills);
}

/**
 * The tool specs for an agent, unexpanded. When `def.tools` is defined, the
 * result is `def.tools` plus project tools plus `grants`. When it is undefined
 * and there are project tools or grants, the result starts from `baselineTools`.
 * Otherwise undefined.
 */
export function effectiveToolSpecs(
	def: AgentDefinition,
	entry: ProjectAgentEntry | undefined,
	baselineTools: readonly string[],
	grants: readonly string[],
): string[] | undefined {
	if (def.tools !== undefined) return union(def.tools, entry?.tools, grants);
	if ((entry?.tools?.length ?? 0) > 0 || grants.length > 0) return union(baselineTools, entry?.tools, grants);
	return undefined;
}
