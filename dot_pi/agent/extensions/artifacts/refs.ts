/**
 * refs — pi-free helpers for artifact references, the store prompts, the
 * `/artifact` argument parsing, autocomplete suggestions, and remote-URL
 * normalization.
 *
 * Only this module (plus project/store) is imported by unit tests, so it must
 * never import pi packages. The fuzzy matcher is injected by the caller so
 * tests can pass a stub instead of pi-tui's `fuzzyFilter`.
 */

import { ARTIFACT_NAME_RE, ARTIFACT_TYPES, type ArtifactEntry, type ArtifactType } from "./store.ts";

/**
 * Matches `@task:<name>`, `@plan:<name>`, or `@report:<name>` at the start of
 * the text or after a space, tab, or newline. Group 1 is the leading
 * separator, group 2 the type, group 3 the name. The name ends alphanumerically,
 * so `@plan:foo.` resolves to `foo`.
 */
export const ARTIFACT_REF_RE = /(^|[ \t\n])@(task|plan|report):([a-z0-9]+(?:[-_.][a-z0-9]+)*)/g;

/** Autocomplete item shape (mirrors pi-tui's `AutocompleteItem`). */
export interface SuggestionItem {
	value: string;
	label: string;
	description?: string;
}

/** Fuzzy matcher matching pi-tui's `fuzzyFilter` signature. */
export type FuzzyFn = <T>(items: T[], query: string, getText: (item: T) => string) => T[];

/** Result of applying an autocomplete item to the cursor line. */
export interface AppliedCompletion {
	text: string;
	cursorCol: number;
}

/** Artifact types that `/task` and `/report` can create. */
export type StorableType = "task" | "report";

/**
 * Parse a `/artifact edit` or `/artifact delete` argument. Accepts `@type:name`
 * (the canonical form that autocomplete inserts) and bare `type:name`. Returns
 * undefined for an unknown type, an invalid name, or anything else.
 */
export function parseArtifactArg(arg: string): { type: ArtifactType; name: string } | undefined {
	const body = arg.startsWith("@") ? arg.slice(1) : arg;
	const colon = body.indexOf(":");
	if (colon === -1) return undefined;
	const type = ARTIFACT_TYPES.find((candidate) => candidate === body.slice(0, colon));
	const name = body.slice(colon + 1);
	if (!type || !ARTIFACT_NAME_RE.test(name)) return undefined;
	return { type, name };
}

/**
 * Replace every known `@type:name` reference in `text` with the absolute path
 * that `exists` returns for it. Unknown references stay unchanged and are listed
 * in `unknown` as `type:name`. Returns the text unchanged when nothing matched.
 */
export function substituteRefs(
	text: string,
	exists: (type: ArtifactType, name: string) => string | undefined,
): { text: string; unknown: string[] } {
	const missing: string[] = [];
	const replaced = text.replace(ARTIFACT_REF_RE, (match: string, lead: string, rawType: string, name: string) => {
		const type = ARTIFACT_TYPES.find((candidate) => candidate === rawType);
		const path = type ? exists(type, name) : undefined;
		if (path !== undefined) return `${lead}${path}`;
		const label = `${rawType}:${name}`;
		if (!missing.includes(label)) missing.push(label);
		return match;
	});
	return { text: replaced, unknown: missing };
}

/**
 * Extract the type and query of an `@<type prefix>:` token at the end of the text
 * before the cursor. The prefix may be a full type name or a unique prefix of one
 * (`@p:` is plan). Returns undefined when the cursor is not inside such a token.
 */
export function extractRefToken(textBeforeCursor: string): { type: ArtifactType; query: string } | undefined {
	const match = textBeforeCursor.match(/(?:^|[ \t])@([a-z]+):([a-z0-9._-]*)$/);
	if (!match) return undefined;
	const matches = ARTIFACT_TYPES.filter((type) => type.startsWith(match[1]));
	return matches.length === 1 ? { type: matches[0], query: match[2] } : undefined;
}

/**
 * Types whose hint matches the text before the cursor. A bare `@` followed by a
 * prefix of a type name (`@t`, `@pla`, `@report`) matches that type. Returns an
 * empty list otherwise.
 */
export function isRefHintToken(textBeforeCursor: string): ArtifactType[] {
	const word = textBeforeCursor.match(/(?:^|[ \t])@([a-z]*)$/)?.[1];
	if (!word) return [];
	return ARTIFACT_TYPES.filter((type) => type.startsWith(word));
}

/** Format an age in ms as a short relative string (`5m`, `3h`, `2d`). */
export function formatAge(nowMs: number, tsMs: number): string {
	const diff = Math.max(0, nowMs - tsMs);
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(diff / 3_600_000);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(diff / 86_400_000)}d`;
}

/**
 * Build `@type:name` suggestions for one type. An empty query gives the 5 newest
 * artifacts of that type (`entries` is already newest first); otherwise fuzzy-match
 * the names and return the top 20. Description is `<age> · <title>`.
 */
export function buildRefSuggestions(
	entries: ArtifactEntry[],
	type: ArtifactType,
	query: string,
	fuzzy: FuzzyFn,
	nowMs: number,
): SuggestionItem[] {
	const ofType = entries.filter((entry) => entry.type === type);
	const picked = query === "" ? ofType.slice(0, 5) : fuzzy(ofType, query, (entry) => entry.name).slice(0, 20);
	return picked.map((entry) => ({
		value: `@${type}:${entry.name}`,
		label: entry.name,
		description: `${formatAge(nowMs, entry.mtimeMs)} · ${entry.title}`,
	}));
}

/** The `@type:` hint item shown for a partial type token. */
export function buildRefHint(type: ArtifactType): SuggestionItem {
	return { value: `@${type}:`, label: `@${type}:`, description: `${type} artifact` };
}

/**
 * Apply a `@type:` completion: replace `prefix` before the cursor with `value`.
 * Names get a trailing space; the `@type:` hint gets none. Returns null when
 * the item is not an artifact reference, so the caller can delegate.
 */
export function applyRefCompletion(
	beforeCursor: string,
	afterCursor: string,
	value: string,
	prefix: string,
): AppliedCompletion | null {
	if (!/^@(task|plan|report):/.test(value)) return null;
	const start = Math.max(0, beforeCursor.length - prefix.length);
	const insert = value.endsWith(":") ? value : `${value} `;
	return { text: `${beforeCursor.slice(0, start)}${insert}${afterCursor}`, cursorCol: start + insert.length };
}

/**
 * Complete `/artifact` arguments. The first word completes to `edit` or `delete`.
 * After either, every artifact is offered as `@type:name`, fuzzy-matched against
 * `type:name`. Item values carry the full argument text (`edit @plan:foo`).
 */
export function completeArtifactArgs(
	argumentPrefix: string,
	entries: ArtifactEntry[],
	fuzzy: FuzzyFn,
): SuggestionItem[] {
	const parts = argumentPrefix.split(/\s+/);
	if (parts.length <= 1) {
		const first = parts[0] ?? "";
		return ["edit", "delete"].filter((sub) => sub.startsWith(first)).map((sub) => ({ value: sub, label: sub }));
	}
	const [sub, ...rest] = parts;
	if (sub !== "edit" && sub !== "delete") return [];
	const query = rest.join(" ").replace(/^@/, "");
	const candidates = query ? fuzzy(entries, query, (entry) => `${entry.type}:${entry.name}`) : entries;
	return candidates.map((entry) => ({
		value: `${sub} @${entry.type}:${entry.name}`,
		label: `${entry.type}:${entry.name}`,
		description: entry.title,
	}));
}

/**
 * Build the message that `/task` and `/report` send. It names the full type
 * directory, so it works in any agent. `instructions` is appended as an
 * "Additional instruction from me" line when not blank.
 */
export function buildStorePrompt(type: StorableType, typeDir: string, instructions: string): string {
	const typeLine: Record<StorableType, string> = {
		task: "The task states the goal, scope, and acceptance criteria.",
		report: "The report states findings with evidence and sources.",
	};
	const lines = [
		`Save a ${type} artifact for handoff to another agent, using the write tool, at ${typeDir}/<name>.md.`,
		"<name> is a short kebab-case name you choose.",
		'The file starts with a "# Title" line and is self-contained markdown with context, rationale, and concrete paths or identifiers.',
		`Before writing, run ls ${typeDir}. Reuse an existing name only to update that same artifact.`,
		typeLine[type],
		`Finish by replying with @${type}:<name>.`,
	];
	const extra = instructions.trim();
	const body = lines.join("\n");
	return extra ? `${body}\n\nAdditional instruction from me: ${extra}` : body;
}

/** Strip trailing slashes and one trailing `.git` (case-insensitive). */
function stripUrlSuffix(value: string): string {
	const noSlashes = value.replace(/\/+$/, "");
	if (/\.git$/i.test(noSlashes)) return noSlashes.slice(0, -4).replace(/\/+$/, "");
	return noSlashes;
}

/**
 * Normalize a git remote URL to `host/path` (lowercase, no scheme/userinfo/
 * port, no trailing `/` or `.git`). `user@host:path` scp syntax is handled.
 * Local paths become `file/<absolute path>`.
 */
export function normalizeRemoteUrl(url: string): string {
	const trimmed = url.trim();
	const scp = trimmed.match(/^[^@/:\s]+@([^:/\s]+):(.*)$/);
	if (scp) {
		return stripUrlSuffix(`${scp[1]}/${scp[2]}`).toLowerCase();
	}
	const scheme = trimmed.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(.*)$/);
	if (scheme) {
		let rest = scheme[1];
		const at = rest.lastIndexOf("@");
		if (at !== -1) rest = rest.slice(at + 1);
		const slash = rest.indexOf("/");
		const host = slash === -1 ? rest : rest.slice(0, slash);
		const path = slash === -1 ? "" : rest.slice(slash + 1);
		const bareHost = host.includes(":") ? host.slice(0, host.indexOf(":")) : host;
		const combined = path ? `${bareHost}/${path}` : bareHost;
		return stripUrlSuffix(combined).toLowerCase();
	}
	return stripUrlSuffix(`file/${trimmed.replace(/^\/+/, "")}`).toLowerCase();
}
