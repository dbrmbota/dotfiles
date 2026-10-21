/**
 * Prompt-template argument handling, copied from Pi 1.3.0
 * `dist/core/prompt-templates.js` (`parseCommandArgs` and `substituteArgs`).
 * Pi does not export them, so keep this copy in sync when Pi is upgraded.
 */

/** Split a command argument string into args. Quoted text keeps its spaces. */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	// Tracks whether a token has started, so quoted empty strings ("" or '') are kept as arguments
	let hasToken = false;
	let inQuote: string | null = null;
	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i]!;
		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
			hasToken = true;
		} else if (/\s/.test(char)) {
			if (hasToken) {
				args.push(current);
				current = "";
				hasToken = false;
			}
		} else {
			current += char;
			hasToken = true;
		}
	}
	if (hasToken) {
		args.push(current);
	}
	return args;
}

/**
 * Replace the placeholders Pi supports in a template body: `$1`, `$@`, `$ARGUMENTS`,
 * `${N:-default}`, `${@:-default}`, `${ARGUMENTS:-default}`, `${@:N}`, and `${@:N:L}`.
 * Substituted values are not expanded again.
 */
export function substituteArgs(content: string, args: string[]): string {
	const allArgs = args.join(" ");
	return content.replace(
		/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		(
			_match: string,
			defaultTarget: string | undefined,
			defaultValue: string | undefined,
			sliceStart: string | undefined,
			sliceLength: string | undefined,
			simple: string | undefined,
		): string => {
			if (defaultTarget) {
				const value =
					defaultTarget === "@" || defaultTarget === "ARGUMENTS" ? allArgs : args[parseInt(defaultTarget, 10) - 1];
				return value ? value : (defaultValue ?? "");
			}
			if (sliceStart) {
				let start = parseInt(sliceStart, 10) - 1; // Convert to 0-indexed (user provides 1-indexed)
				// Treat 0 as 1 (bash convention: args start at 1)
				if (start < 0) start = 0;
				if (sliceLength) {
					const length = parseInt(sliceLength, 10);
					return args.slice(start, start + length).join(" ");
				}
				return args.slice(start).join(" ");
			}
			if (simple === "ARGUMENTS" || simple === "@") {
				return allArgs;
			}
			const index = parseInt(simple ?? "", 10) - 1;
			return args[index] ?? "";
		},
	);
}
