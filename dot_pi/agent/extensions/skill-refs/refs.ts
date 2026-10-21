/**
 * Pure helpers for `@skill:` references: finding them, rendering skill blocks,
 * and building the expanded message. Imports no pi packages, so the unit tests
 * run with plain node.
 */

import { dirname } from "node:path";
import { parseCommandArgs, substituteArgs } from "./prompt-args.ts";

/** A skill that can be referenced. `name` has no `skill:` prefix. */
export interface SkillFile {
	name: string;
	path: string;
}

/** A skill whose file was read. `body` is the file content without frontmatter. */
export interface ResolvedSkill extends SkillFile {
	body: string;
}

/** A prompt template whose file was read. `body` is the file content without frontmatter, untrimmed. */
export interface ResolvedTemplate {
	name: string;
	path: string;
	body: string;
}

/** The result of expanding one raw user message. */
export interface Expansion {
	/** The message to send. Equal to the input when `changed` is false. */
	text: string;
	/** True when skill blocks or a template were added. */
	changed: boolean;
	/** The skills injected, in block order. */
	skills: SkillFile[];
	/** The template that was expanded, when the message invoked one. */
	template?: { name: string; path: string };
	/** `@skill:` names that did not resolve. They stay literal in `text`. */
	unknown: string[];
}

const SKILL_REF = /(^|[ \t\n])@skill:([A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*)/g;
const COMMAND = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;
const SKILL_COMMAND_PREFIX = "skill:";

/**
 * Distinct `@skill:` names in `text`, in order of first appearance. A reference
 * starts at the beginning of the text or after a space, tab, or newline. A trailing
 * `.` is not part of the name.
 */
export function findSkillRefs(text: string): string[] {
	const names = new Set<string>();
	for (const match of text.matchAll(SKILL_REF)) names.add(match[2]!);
	return [...names];
}

/**
 * The `<skill>` block for one skill, in Pi's exact format. `location` is the skill
 * file, `DIR` in the reference line is its directory, and `body` is trimmed.
 */
export function renderSkillBlock(skill: SkillFile, body: string): string {
	return `<skill name="${skill.name}" location="${skill.path}">\nReferences are relative to ${dirname(skill.path)}.\n\n${body.trim()}\n</skill>`;
}

/** Blocks, then the tail, joined with blank lines. Without blocks the tail stands alone, and without a tail the blocks do. */
function assembleMessage(blocks: string[], tail: string): string {
	if (blocks.length === 0) return tail;
	if (tail === "") return blocks.join("\n\n");
	return `${blocks.join("\n\n")}\n\n${tail}`;
}

/**
 * Expand one raw user message. Skill refs are resolved with `resolveSkill` (an
 * undefined result leaves the ref literal and lists it in `unknown`). A leading
 * `/skill:<name>` adds that skill first and is removed from the text. A leading
 * `/<name>` that `resolveTemplate` knows is replaced by the expanded template.
 * Refs stay in the text, and blocks come first, joined with blank lines.
 */
export function expandMessage(
	text: string,
	resolveSkill: (name: string) => ResolvedSkill | undefined,
	resolveTemplate: (name: string) => ResolvedTemplate | undefined,
): Expansion {
	const command = COMMAND.exec(text);
	const commandName = command?.[1];
	const commandArgs = command?.[2] ?? "";

	const skills: SkillFile[] = [];
	const bodies = new Map<string, string>();
	const addSkill = (skill: ResolvedSkill): void => {
		if (skills.some((known) => known.name === skill.name)) return;
		skills.push({ name: skill.name, path: skill.path });
		bodies.set(skill.name, skill.body);
	};

	let leadingSkill = false;
	let tail = text;
	if (commandName?.startsWith(SKILL_COMMAND_PREFIX)) {
		const skill = resolveSkill(commandName.slice(SKILL_COMMAND_PREFIX.length));
		if (skill) {
			addSkill(skill);
			leadingSkill = true;
			tail = commandArgs;
		}
	}

	const unknown: string[] = [];
	for (const name of findSkillRefs(text)) {
		const skill = resolveSkill(name);
		if (skill) addSkill(skill);
		else unknown.push(name);
	}

	let template: { name: string; path: string } | undefined;
	if (!leadingSkill && commandName !== undefined && !commandName.startsWith(SKILL_COMMAND_PREFIX)) {
		const resolved = resolveTemplate(commandName);
		if (resolved) {
			template = { name: resolved.name, path: resolved.path };
			tail = substituteArgs(resolved.body, parseCommandArgs(commandArgs));
		}
	}

	if (skills.length === 0 && template === undefined) {
		return { text, changed: false, skills: [], unknown };
	}
	const blocks = skills.map((skill) => renderSkillBlock(skill, bodies.get(skill.name)!));
	return {
		text: assembleMessage(blocks, tail),
		changed: true,
		skills,
		template,
		unknown,
	};
}
