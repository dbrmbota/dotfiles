/**
 * Invocation tool grants: tools that a skill or template asked for, kept for
 * the rest of the session. Pure. The controller does the host calls.
 */

import { strList } from "./parse.ts";
import { expandToolSpecs } from "./tool-specs.ts";

/** Custom entry type under which grants are persisted on the session branch. */
export const GRANT_ENTRY = "agent-grants";

/** Data of one persisted `agent-grants` entry. */
export interface GrantEntryData {
	tools: string[];
	source: string;
}

/** The fields of a session branch entry that grant replay reads. */
export interface BranchEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

/**
 * The union of the specs in every `agent-grants` entry on the branch, in first-seen
 * order. Entries of other types are ignored.
 */
export function replayGrants(entries: readonly BranchEntryLike[]): string[] {
	const out = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== GRANT_ENTRY) continue;
		if (typeof entry.data !== "object" || entry.data === null) continue;
		const tools = strList((entry.data as { tools?: unknown }).tools);
		if (tools === undefined) continue;
		for (const spec of tools) out.add(spec);
	}
	return [...out];
}

/**
 * The specs that still need granting: not already in `granted`, and not fully
 * active. A spec that matches nothing yet counts as not active, so it stays
 * pending.
 */
export function pendingGrants(
	specs: readonly string[],
	granted: readonly string[],
	activeNames: readonly string[],
	allNames: readonly string[],
): string[] {
	return [...new Set(specs)].filter((spec) => {
		if (granted.includes(spec)) return false;
		const matches = expandToolSpecs([spec], allNames);
		return !(matches.length > 0 && matches.every((name) => activeNames.includes(name)));
	});
}
