/**
 * state — the "last reviewed" marker stored in the pi session.
 *
 * `/review` appends one custom entry per round marked reviewed (exported, or closed
 * with no comments). The latest valid marker on the current branch gives the base for
 * the next round. The branch scope means
 * `/tree` navigation and forks behave naturally. This module never imports pi
 * packages, so it can be unit-tested with `node --test`.
 */

/** Custom entry type used for review markers. */
export const CUSTOM_TYPE = "turn-review";

/** Data stored in a `turn-review` custom entry. */
export interface ReviewMarker {
	v: 1;
	/** Base commit the round diffed from. */
	base: string;
	/** omp `after` snapshot the round reviewed up to. */
	head: string;
	/** Review commit `B'` that was materialized for the round. */
	reviewCommit: string;
	/** tuicr session slug, when tuicr reported one. */
	slug?: string;
	/** ISO timestamp of when the round was marked reviewed. */
	at: string;
}

/** The fields of a session entry that `latestMarker` reads. */
export interface BranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/**
 * Returns the latest entry on `branchEntries` that is a `CUSTOM_TYPE` custom entry with valid data.
 * Other custom types and malformed data are ignored. Returns undefined when there is none.
 */
export function latestMarker(branchEntries: readonly BranchEntry[]): ReviewMarker | undefined {
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		const entry = branchEntries[i];
		if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) {
			continue;
		}
		const marker = parseMarker(entry.data);
		if (marker !== undefined) {
			return marker;
		}
	}
	return undefined;
}

/**
 * Validates untrusted entry data as a `ReviewMarker`.
 * Requires `v === 1`, string `base`, `head`, `reviewCommit`, `at`, and an optional string `slug`.
 * Returns undefined for any other value.
 */
function parseMarker(data: unknown): ReviewMarker | undefined {
	if (typeof data !== "object" || data === null) {
		return undefined;
	}
	const fields = data as Record<string, unknown>;
	const { base, head, reviewCommit, at, slug } = fields;
	if (fields.v !== 1 || typeof base !== "string" || typeof head !== "string" || typeof reviewCommit !== "string" || typeof at !== "string") {
		return undefined;
	}
	if (slug !== undefined && typeof slug !== "string") {
		return undefined;
	}
	return { v: 1, base, head, reviewCommit, at, ...(slug === undefined ? {} : { slug }) };
}
