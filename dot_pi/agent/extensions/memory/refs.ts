/**
 * refs — pi-free helpers for memory names, `@mem:` tokens, remote-URL
 * normalization, edit frontmatter, and autocomplete suggestion building.
 *
 * Only this module (plus project/store/embed) is imported by unit tests, so
 * it must never import pi packages. The fuzzy matcher is injected by the
 * caller so tests can pass a stub instead of pi-tui's `fuzzyFilter`.
 */

/** Memory names: lowercase alphanumerics joined by single `-`, `_`, `.`, `/`. */
export const NAME_RE = /^[a-z0-9]+(?:[-_./][a-z0-9]+)*$/;

/** Maximum length of a memory name. */
export const MAX_NAME_LENGTH = 80;

/** Maximum length of a memory description (single line). */
export const MAX_DESCRIPTION_LENGTH = 200;

/**
 * Matches an `@mem:<query>` token at the end of the text before the cursor.
 * Group 1 is the query (possibly empty). Only spaces/tabs may precede the
 * token, so `foo@mem:` does not match.
 */
export const MEM_TOKEN_RE = /(?:^|[ \t])@mem:([a-z0-9._/-]*)$/;

/**
 * Matches `@mem:<name>` references in a submitted message. The trailing
 * segment must end alphanumerically, so `@mem:foo.` resolves to `foo`.
 */
export const MEM_REF_RE = /@mem:([a-z0-9]+(?:[-_./][a-z0-9]+)*)/g;

/** Matches a bare `@m`, `@me`, or `@mem` token at end of input (hint case). */
export const MEM_HINT_RE = /(?:^|[ \t])@(m|me|mem)$/;

/**
 * Validate a memory name. Returns an error message, or undefined when valid.
 */
export function validateName(name: string): string | undefined {
	if (name.length === 0) return "name must not be empty";
	if (name.length > MAX_NAME_LENGTH) {
		return `name must be at most ${MAX_NAME_LENGTH} characters (got ${name.length})`;
	}
	if (!NAME_RE.test(name)) {
		return "name must be lowercase alphanumeric segments joined by single -, _, ., or / (e.g. my-memory)";
	}
	return undefined;
}

/**
 * Validate a memory description (single line, 1-200 chars after trimming).
 * Returns an error message, or undefined when valid.
 */
export function validateDescription(description: string): string | undefined {
	const trimmed = description.trim();
	if (trimmed.length === 0) return "description must not be empty";
	if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
		return `description must be at most ${MAX_DESCRIPTION_LENGTH} characters (got ${trimmed.length})`;
	}
	if (/[\r\n]/.test(trimmed)) return "description must be a single line";
	return undefined;
}

/**
 * Extract the `@mem:` query from text before the cursor, or undefined when
 * the cursor is not inside an `@mem:` token. Used by the autocomplete
 * provider's `getSuggestions` (not by the `input` handler, which passes
 * references through unchanged and only warns on unknown names).
 */
export function extractMemToken(textBeforeCursor: string): string | undefined {
	const match = textBeforeCursor.match(MEM_TOKEN_RE);
	return match ? match[1] : undefined;
}

/** True when the text before the cursor ends with `@m`, `@me`, or `@mem`. */
export function isMemHintToken(textBeforeCursor: string): boolean {
	return MEM_HINT_RE.test(textBeforeCursor);
}

/**
 * Extract all `@mem:<name>` references from a submitted message. Trailing
 * punctuation is excluded by the regex, so `@mem:foo.` yields `foo`.
 */
export function extractMemRefs(text: string): string[] {
	MEM_REF_RE.lastIndex = 0;
	const names: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = MEM_REF_RE.exec(text)) !== null) {
		names.push(match[1]);
	}
	return names;
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

/** Serialize the prefill text for the `/memory edit` editor. */
export function serializeMemoryEdit(description: string, content: string): string {
	return `---\ndescription: ${JSON.stringify(description)}\n---\n\n${content}`;
}

/** Frontmatter parser matching pi's exported `parseFrontmatter` shape. */
export type FrontmatterParser = (text: string) => {
	frontmatter: Record<string, unknown>;
	body: string;
};

/** Parsed result of the `/memory edit` editor text. */
export type ParsedMemoryEdit =
	| { ok: true; description: string; content: string }
	| { ok: false; error: string };

/**
 * Parse editor text back into description + content. `parse` is pi's
 * `parseFrontmatter`, injected so this module stays pi-free.
 */
export function parseMemoryEdit(
	text: string,
	parse: FrontmatterParser,
): ParsedMemoryEdit {
	const { frontmatter, body } = parse(text);
	const raw = frontmatter["description"];
	if (typeof raw !== "string") {
		return { ok: false, error: "missing description in frontmatter" };
	}
	const description = raw.trim();
	const invalid = validateDescription(description);
	if (invalid) return { ok: false, error: invalid };
	if (body.trim().length === 0) {
		return { ok: false, error: "memory content is empty — use /memory delete to remove it" };
	}
	return { ok: true, description, content: body };
}

/** Minimal memory fields needed to build autocomplete suggestions. */
export interface SuggestionEntry {
	name: string;
	description: string;
	lastUsedAt: number;
}

/** Autocomplete item shape (mirrors pi-tui's `AutocompleteItem`). */
export interface SuggestionItem {
	value: string;
	label: string;
	description?: string;
}

/** Fuzzy matcher matching pi-tui's `fuzzyFilter` signature. */
export type FuzzyFn = <T>(items: T[], query: string, getText: (item: T) => string) => T[];

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
 * Build `@mem:` suggestion items. An empty query returns the 5 most recent
 * entries (already recency-ordered by the caller); otherwise fuzzy-match
 * names and return the top 20.
 */
export function buildMemSuggestions(
	entries: SuggestionEntry[],
	query: string,
	fuzzy: FuzzyFn,
	nowMs: number,
): SuggestionItem[] {
	const picked = query === "" ? entries.slice(0, 5) : fuzzy(entries, query, (entry) => entry.name).slice(0, 20);
	return picked.map((entry) => ({
		value: `@mem:${entry.name}`,
		label: entry.name,
		description: `${formatAge(nowMs, entry.lastUsedAt)} · ${entry.description}`,
	}));
}

/** The `@mem:` hint item shown for bare `@m` / `@me` / `@mem` tokens. */
export function buildMemHint(): SuggestionItem {
	return { value: "@mem:", label: "@mem:", description: "project memory" };
}

/**
 * Complete `/memory` arguments: `edit` / `delete` first, then entry names.
 * Name values carry the full argument text (`"edit <name>"`) because the
 * host replaces the whole argument prefix with the item value.
 */
export function completeMemoryArgs(
	argumentPrefix: string,
	entries: SuggestionEntry[],
	fuzzy: FuzzyFn,
): SuggestionItem[] {
	const parts = argumentPrefix.split(/\s+/);
	if (parts.length <= 1) {
		const first = parts[0] ?? "";
		return ["edit", "delete"]
			.filter((sub) => sub.startsWith(first))
			.map((sub) => ({ value: sub, label: sub }));
	}
	const [sub, ...rest] = parts;
	if (sub !== "edit" && sub !== "delete") return [];
	const query = rest.join(" ");
	const picked = query ? fuzzy(entries, query, (entry) => entry.name).slice(0, 20) : entries.slice(0, 20);
	return picked.map((entry) => ({
		value: `${sub} ${entry.name}`,
		label: entry.name,
		description: entry.description,
	}));
}

/** Result of applying an `@mem:` completion to the cursor line. */
export interface AppliedCompletion {
	text: string;
	cursorCol: number;
}

/**
 * Apply an `@mem:` completion: replace `prefix` before the cursor with
 * `value` (trailing space for names, none for the `@mem:` hint).
 * Returns null when the item is not a memory reference (caller delegates).
 */
export function applyMemCompletion(
	beforeCursor: string,
	afterCursor: string,
	value: string,
	prefix: string,
): AppliedCompletion | null {
	if (!value.startsWith("@mem:")) return null;
	const start = Math.max(0, beforeCursor.length - prefix.length);
	const insert = value === "@mem:" ? value : `${value} `;
	return { text: `${beforeCursor.slice(0, start)}${insert}${afterCursor}`, cursorCol: start + insert.length };
}
