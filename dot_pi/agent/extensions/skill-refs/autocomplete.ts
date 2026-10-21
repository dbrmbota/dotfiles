/**
 * `@skill:` autocomplete: token and hint detection, suggestions, and applying a
 * completion. Imports no pi packages. The fuzzy matcher is passed in by the caller.
 */

import type { SkillFile } from "./refs.ts";

/** A suggestion row, in the shape the editor's autocomplete expects. */
export interface SuggestionItem {
	value: string;
	label: string;
	description?: string;
}

/** A skill offered by autocomplete. */
export interface SkillCandidate extends SkillFile {
	description?: string;
}

/** Fuzzy filter: keeps the items that match `query`, best first. */
export type FuzzyFn = <T>(items: T[], query: string, getText: (item: T) => string) => T[];

/** Result of applying an autocomplete item to the cursor line. */
export interface AppliedCompletion {
	text: string;
	cursorCol: number;
}

/**
 * The query after an `@skill:` token that ends the text before the cursor, or
 * undefined when there is no such token. The `@` must start the text or follow
 * a space, tab, or newline.
 */
export function extractSkillToken(textBeforeCursor: string): { query: string } | undefined {
	const match = textBeforeCursor.match(/(?:^|[ \t\n])@skill:([A-Za-z0-9._-]*)$/);
	return match ? { query: match[1]! } : undefined;
}

/**
 * True when the text before the cursor ends in `@` followed by a prefix of
 * `skill` (`@s` through `@skill`). The `@` must start the text or follow whitespace.
 */
export function isSkillHintToken(textBeforeCursor: string): boolean {
	return /(?:^|[ \t\n])@(s|sk|ski|skil|skill)$/.test(textBeforeCursor);
}

/**
 * Suggestions for `@skill:<query>`. An empty query lists every skill in
 * alphabetical order. Otherwise the best 20 fuzzy matches are returned. Each item
 * has the value `@skill:<name>`.
 */
export function buildSkillSuggestions(
	skills: readonly SkillCandidate[],
	query: string,
	fuzzy: FuzzyFn,
): SuggestionItem[] {
	const picked =
		query === ""
			? [...skills].sort((a, b) => a.name.localeCompare(b.name))
			: fuzzy([...skills], query, (skill) => skill.name).slice(0, 20);
	return picked.map((skill) => ({
		value: `@skill:${skill.name}`,
		label: `@skill:${skill.name}`,
		description: skill.description ?? "skill",
	}));
}

/** The `@skill:` hint item. Accepting it inserts `@skill:` with no trailing space. */
export function buildSkillHint(): SuggestionItem {
	return { value: "@skill:", label: "@skill:", description: "skill reference" };
}

/**
 * Apply a `@skill:` completion by replacing `prefix` before the cursor with `value`.
 * A skill name gets a trailing space, and the hint does not. Returns null when
 * `value` is not a `@skill:` item, so the caller can delegate.
 */
export function applySkillCompletion(
	beforeCursor: string,
	afterCursor: string,
	value: string,
	prefix: string,
): AppliedCompletion | null {
	if (!/^@skill:/.test(value)) return null;
	const start = Math.max(0, beforeCursor.length - prefix.length);
	const insert = value.endsWith(":") ? value : `${value} `;
	return { text: `${beforeCursor.slice(0, start)}${insert}${afterCursor}`, cursorCol: start + insert.length };
}
