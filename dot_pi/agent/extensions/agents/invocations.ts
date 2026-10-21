/**
 * Recognizing skill and template invocations: the leading command in raw input,
 * the tool specs in their frontmatter, and the path a `read` call loads. Pure.
 */

import * as os from "node:os";
import * as path from "node:path";
import { strList } from "./parse.ts";

/**
 * Payload of the `skill-refs:expanded` event. The agents extension mirrors this
 * shape and never imports `skill-refs`.
 */
export interface SkillRefsExpanded {
	skills: { name: string; path: string }[];
	template?: { name: string; path: string };
}

/**
 * The command name of a leading `/command` in `text`, without the slash
 * (`skill:review` for `/skill:review`). Undefined when the text does not start
 * with `/` followed by a non-space character.
 */
export function leadingCommandName(text: string): string | undefined {
	return /^\/(\S+)/.exec(text)?.[1];
}

/**
 * The tool specs a frontmatter declares. A prompt uses `tools`. A skill uses
 * `metadata["pi-tools"]`, and a top-level `tools` on a skill is ignored.
 */
export function frontmatterToolSpecs(kind: "prompt" | "skill", frontmatter: Record<string, unknown>): string[] {
	if (kind === "prompt") return strList(frontmatter.tools) ?? [];
	const metadata = frontmatter.metadata;
	if (typeof metadata !== "object" || metadata === null) return [];
	return strList((metadata as Record<string, unknown>)["pi-tools"]) ?? [];
}

/**
 * The absolute path a `read` call names. A leading `@` is stripped, `~` expands
 * to the home directory, and a relative path resolves against `cwd`.
 */
export function resolveReadPath(rawPath: string, cwd: string): string {
	let p = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	if (p === "~") p = os.homedir();
	else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
	return path.resolve(cwd, p);
}
