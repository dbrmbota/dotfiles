/**
 * Agent body variables: `$NAME`, `${NAME}`, and `${NAME:-default}`. Pure, so
 * it can be unit-tested without pi.
 */

/**
 * Replace `$NAME`, `${NAME}`, and `${NAME:-default}` in an agent body. Only names
 * present in `vars` are replaced; `${NAME:-default}` uses `default` when NAME is
 * absent. Names match `[A-Z][A-Z0-9_]*`; `$NAME` ends at the first other character.
 * Substituted values are not expanded again.
 */
export function expandAgentVars(body: string, vars: ReadonlyMap<string, string>): string {
	return body.replace(
		/\$\{([A-Z][A-Z0-9_]*)(?::-([^}]*))?\}|\$([A-Z][A-Z0-9_]*)/g,
		(match: string, braced: string | undefined, fallback: string | undefined, bare: string | undefined) => {
			const name = braced ?? bare;
			if (name === undefined) return match;
			const value = vars.get(name);
			if (value !== undefined) return value;
			if (braced !== undefined && fallback !== undefined) return fallback;
			return match;
		},
	);
}

/**
 * Apply one `agents:vars` update to `map`: a string sets the name, `null`
 * removes it. Other values are ignored.
 */
export function mergeAgentVars(map: Map<string, string>, update: Record<string, string | null>): void {
	for (const [name, value] of Object.entries(update)) {
		if (typeof value === "string") map.set(name, value);
		else if (value === null) map.delete(name);
	}
}
