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
	throw new Error("not implemented");
}

/**
 * Validate a memory description (single line, 1-200 chars after trimming).
 * Returns an error message, or undefined when valid.
 */
export function validateDescription(description: string): string | undefined {
	throw new Error("not implemented");
}

/**
 * Extract the `@mem:` query from text before the cursor, or undefined when
 * the cursor is not inside an `@mem:` token. Used by the autocomplete
 * provider's `getSuggestions` (not by the `input` handler, which passes
 * references through unchanged and only warns on unknown names).
 */
export function extractMemToken(textBeforeCursor: string): string | undefined {
	throw new Error("not implemented");
}

/** True when the text before the cursor ends with `@m`, `@me`, or `@mem`. */
export function isMemHintToken(textBeforeCursor: string): boolean {
	throw new Error("not implemented");
}

/**
 * Extract all `@mem:<name>` references from a submitted message. Trailing
 * punctuation is excluded by the regex, so `@mem:foo.` yields `foo`.
 */
export function extractMemRefs(text: string): string[] {
	throw new Error("not implemented");
}

/**
 * Normalize a git remote URL to `host/path` (lowercase, no scheme/userinfo/
 * port, no trailing `/` or `.git`). `user@host:path` scp syntax is handled.
 * Local paths become `file/<absolute path>`.
 */
export function normalizeRemoteUrl(url: string): string {
	throw new Error("not implemented");
}

/** Serialize the prefill text for the `/memory edit` editor. */
export function serializeMemoryEdit(description: string, content: string): string {
	throw new Error("not implemented");
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
	throw new Error("not implemented");
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
	throw new Error("not implemented");
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
	throw new Error("not implemented");
}

/** The `@mem:` hint item shown for bare `@m` / `@me` / `@mem` tokens. */
export function buildMemHint(): SuggestionItem {
	throw new Error("not implemented");
}
