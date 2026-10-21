/**
 * Pure value parsers for agent frontmatter and settings. Imports no pi
 * packages, so it can be unit-tested on its own.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Every thinking level pi accepts, from least to most effort. */
export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The trimmed string, or undefined when `v` is not a non-empty string. */
export function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * A list from an array of strings or a comma-separated string. Entries are
 * trimmed and empty ones dropped. Undefined and null stay undefined.
 */
export function strList(v: unknown): string[] | undefined {
	if (v === undefined || v === null) return undefined;
	if (Array.isArray(v)) return v.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
	if (typeof v === "string") {
		if (!v.trim()) return [];
		return v.split(",").map((t) => t.trim()).filter(Boolean);
	}
	return undefined;
}

/** The thinking level when `v` names one of `THINKING_LEVELS`, else undefined. */
export function parseThinking(v: unknown): ThinkingLevel | undefined {
	return typeof v === "string" && (THINKING_LEVELS as string[]).includes(v.trim()) ? (v.trim() as ThinkingLevel) : undefined;
}
