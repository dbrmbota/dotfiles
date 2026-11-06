// Block bash searches that walk a broad filesystem root, such as /, $HOME,
// /Users, /Volumes/*, or a cloud-storage mount.
//
// A recursive find, grep, rg, fd, or du over one of these roots can traverse
// the whole disk, home caches, and network or cloud mounts, and can run for a
// very long time. The guard blocks the call and tells the model how to narrow
// the search. The check parses each command with tree-sitter (see analyze.ts).
// A parser or analysis failure fails open: the command runs, and the user is
// warned once that the guard is inactive.

import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findBroadSearch, type Finding } from "./analyze.ts";
import { loadBashParser, type ParseFn } from "./parser.ts";

/** Runtime inputs of the guard. Tests inject `loadParser` and `home`. */
export type BroadSearchGuardDeps = {
	loadParser: () => Promise<ParseFn>;
	home: string;
};

/**
 * Registers the hooks that block broad `bash` searches on `pi`.
 * It blocks only `bash` tool calls and never mutates their input.
 * It warns once per session when the parser is unavailable.
 */
export function registerBroadSearchGuard(pi: ExtensionAPI, deps: BroadSearchGuardDeps): void {
	let warned = false;

	pi.on("session_start", () => {
		warned = false;
		deps.loadParser().catch(() => undefined);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		let parse: ParseFn;
		try {
			parse = await deps.loadParser();
		} catch {
			if (ctx.hasUI && !warned) {
				warned = true;
				ctx.ui.notify(
					"broad-search-guard: bash parser unavailable (run `npm ci --omit=dev --ignore-scripts` in ~/.pi/agent/extensions/broad-search-guard); broad searches are NOT being blocked",
					"warning",
				);
			}
			return undefined;
		}
		const command: unknown = event.input.command;
		if (typeof command !== "string") return undefined;
		let finding: Finding | undefined;
		try {
			finding = findBroadSearch(command, { cwd: ctx.cwd, home: deps.home, parse });
		} catch {
			return undefined;
		}
		if (!finding) return undefined;
		return { block: true, reason: blockReason(finding, ctx.cwd) };
	});
}

/** Builds the reason the model receives for a blocked search. `cwd` is the session's working directory. */
function blockReason(finding: Finding, cwd: string): string {
	return [
		`Blocked broad filesystem search: \`${finding.segment}\` walks \`${finding.root}\` (matches broad root \`${finding.matched}\`).`,
		"Searching from such roots can traverse the whole disk, home caches, and network/cloud mounts, and may take a very long time.",
		"Narrow the search instead:",
		`- search the project (cwd: ${cwd}) or a specific subdirectory you have reason to expect;`,
		"- search a known install/config location (e.g. /opt/homebrew/Cellar/<pkg>, ~/.config/<app>, ~/.local/share/<app>);",
		"- locate tools/packages via metadata (`command -v <tool>`, `brew --prefix <formula>`, `dpkg -L <pkg>`), or `ls <dir>` to inspect one level;",
		"- if you don't know where to look, ask the user.",
		"Do not retry the same search through another broad root (e.g. $HOME, /Users/*, /Volumes/*).",
	].join("\n");
}

/** pi entry point: registers the guard with the real parser and the real home directory. */
export default function (pi: ExtensionAPI): void {
	registerBroadSearchGuard(pi, { loadParser: loadBashParser, home: homedir() });
}
