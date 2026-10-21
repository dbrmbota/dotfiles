/**
 * skill-refs — `@skill:<name>` references in user messages.
 *
 * Pi wiring only. A reference anywhere in a message (several at a time, and in
 * the arguments of a prompt-template invocation) injects that skill as a
 * `<skill>` block at the start of the message, and the `@skill:` text stays where
 * it was written. A leading `/skill:<name>` or `/<template>` is expanded too.
 * Skill names autocomplete in the editor. After each expansion the
 * `skill-refs:expanded` event reports which skills and template were used, so
 * the agents extension can grant their tools. This extension knows nothing
 * about agents. The pi-free modules (`refs.ts`, `prompt-args.ts`,
 * `autocomplete.ts`) hold the logic.
 */

import { readFileSync } from "node:fs";
import { parseFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteProvider } from "@earendil-works/pi-tui";
import {
	applySkillCompletion,
	buildSkillHint,
	buildSkillSuggestions,
	extractSkillToken,
	isSkillHintToken,
	type SkillCandidate,
} from "./autocomplete.ts";
import { expandMessage, type ResolvedSkill, type ResolvedTemplate } from "./refs.ts";

const SKILL_COMMAND_PREFIX = "skill:";
const EXPANDED_EVENT = "skill-refs:expanded";

/** Skills that `pi.getCommands()` lists, with their file path and description. */
function skillCandidates(pi: ExtensionAPI): SkillCandidate[] {
	return pi
		.getCommands()
		.filter((command) => command.source === "skill")
		.map((command) => ({
			name: command.name.slice(SKILL_COMMAND_PREFIX.length),
			path: command.sourceInfo.path,
			description: command.description,
		}));
}

/** The body of a markdown file without its frontmatter (untrimmed), or undefined when it is unreadable. */
function readBody(file: string): string | undefined {
	try {
		return parseFrontmatter(readFileSync(file, "utf-8")).body;
	} catch {
		return undefined;
	}
}

/**
 * Wrap the host's autocomplete provider. It claims `@skill:` tokens and the
 * `@skill:` hint, and delegates everything else. `skills` is read on each call.
 */
function createSkillAutocompleteProvider(
	current: AutocompleteProvider,
	skills: () => SkillCandidate[],
): AutocompleteProvider {
	return {
		// `:` retriggers the session, so typing `@skill:` (or retyping `:` after
		// accepting the hint) always opens the skill list.
		triggerCharacters: [":"],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const token = extractSkillToken(before);
			if (token) {
				const items = buildSkillSuggestions(skills(), token.query, fuzzyFilter);
				if (items.length > 0) return { items, prefix: before.slice(before.lastIndexOf("@")) };
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}
			if (isSkillHintToken(before)) {
				const prefix = before.slice(before.lastIndexOf("@"));
				const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);
				if (base && base.prefix === prefix) return { items: [buildSkillHint(), ...base.items], prefix };
				if (!base) return { items: [buildSkillHint()], prefix };
				return base;
			}
			return current.getSuggestions(lines, cursorLine, cursorCol, options);
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const line = lines[cursorLine] ?? "";
			const applied = applySkillCompletion(line.slice(0, cursorCol), line.slice(cursorCol), item.value, prefix);
			if (applied) {
				const nextLines = [...lines];
				nextLines[cursorLine] = applied.text;
				return { lines: nextLines, cursorLine, cursorCol: applied.cursorCol };
			}
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
			if (extractSkillToken(before) !== undefined || isSkillHintToken(before)) return true;
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function (pi: ExtensionAPI): void {
	let autocompleteRegistered = false;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (!autocompleteRegistered) {
			autocompleteRegistered = true;
			ctx.ui.addAutocompleteProvider((current) => createSkillAutocompleteProvider(current, () => skillCandidates(pi)));
		}
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return undefined;
		const resolveSkill = (name: string): ResolvedSkill | undefined => {
			const skill = skillCandidates(pi).find((candidate) => candidate.name === name);
			if (!skill) return undefined;
			const body = readBody(skill.path);
			return body === undefined ? undefined : { name: skill.name, path: skill.path, body };
		};
		const resolveTemplate = (name: string): ResolvedTemplate | undefined => {
			const command = pi.getCommands().find((candidate) => candidate.source === "prompt" && candidate.name === name);
			if (!command) return undefined;
			const body = readBody(command.sourceInfo.path);
			return body === undefined ? undefined : { name, path: command.sourceInfo.path, body };
		};

		const expansion = expandMessage(event.text, resolveSkill, resolveTemplate);
		for (const name of expansion.unknown) {
			ctx.ui.notify(`skill-refs: @skill:${name} is not a known skill or could not be read`, "warning");
		}
		if (!expansion.changed) return undefined;
		pi.events.emit(EXPANDED_EVENT, {
			skills: expansion.skills.map((skill) => ({ name: skill.name, path: skill.path })),
			template: expansion.template,
		});
		return { action: "transform", text: expansion.text };
	});
}
