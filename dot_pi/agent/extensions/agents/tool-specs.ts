/**
 * Tool specs: an exact tool name, or a pattern where `*` matches any run of
 * characters (for example `mcp__github__*`). Pure.
 */

/** True when `spec` contains `*`. */
export function isToolPattern(spec: string): boolean {
	return spec.includes("*");
}

/** The registered names that one spec matches, in the order the spec gives them. */
function matchesFor(spec: string, allNames: readonly string[]): string[] {
	if (!isToolPattern(spec)) return allNames.includes(spec) ? [spec] : [];
	const source = spec
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	const re = new RegExp(`^${source}$`);
	return allNames.filter((name) => re.test(name)).sort((a, b) => a.localeCompare(b));
}

/**
 * Expand specs against the registered tool names. Each spec keeps its position,
 * and the matches for a pattern are sorted alphabetically there. Exact names
 * that are not registered produce nothing. Duplicates are removed.
 */
export function expandToolSpecs(specs: readonly string[], allNames: readonly string[]): string[] {
	const out = new Set<string>();
	for (const spec of specs) {
		for (const name of matchesFor(spec, allNames)) out.add(name);
	}
	return [...out];
}

/** The specs that match no registered tool, in input order. */
export function unresolvedSpecs(specs: readonly string[], allNames: readonly string[]): string[] {
	return specs.filter((spec) => matchesFor(spec, allNames).length === 0);
}
