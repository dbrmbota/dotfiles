import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	expandMessage,
	findSkillRefs,
	renderSkillBlock,
	type Expansion,
	type ResolvedSkill,
	type ResolvedTemplate,
} from "./refs.ts";

const SKILLS: Record<string, ResolvedSkill> = {
	a: { name: "a", path: "/skills/a/SKILL.md", body: "\nAlpha body.\n" },
	b: { name: "b", path: "/skills/b/SKILL.md", body: "\nBeta body.\n" },
};

const TEMPLATES: Record<string, ResolvedTemplate> = {
	gh: { name: "gh", path: "/prompts/gh.md", body: "Do $1 with $2\n" },
	pipe: { name: "pipe", path: "/prompts/pipe.md", body: "$1|$2" },
	note: { name: "note", path: "/prompts/note.md", body: "See @skill:a here" },
};

const resolveSkill = (name: string): ResolvedSkill | undefined => SKILLS[name];
const resolveTemplate = (name: string): ResolvedTemplate | undefined => TEMPLATES[name];

const A_BLOCK = '<skill name="a" location="/skills/a/SKILL.md">\nReferences are relative to /skills/a.\n\nAlpha body.\n</skill>';
const B_BLOCK = '<skill name="b" location="/skills/b/SKILL.md">\nReferences are relative to /skills/b.\n\nBeta body.\n</skill>';

function summary(result: Expansion) {
	return {
		text: result.text,
		changed: result.changed,
		skills: result.skills.map((skill) => skill.name),
		template: result.template?.name,
		unknown: result.unknown,
	};
}

describe("findSkillRefs", () => {
	it("returns distinct names in order of first appearance", () => {
		assert.deepEqual(findSkillRefs("Use @skill:b and @skill:a, then @skill:b again"), ["b", "a"]);
	});

	it("does not include a trailing period in the name", () => {
		assert.deepEqual(findSkillRefs("Use @skill:a."), ["a"]);
	});

	it("keeps dots, dashes, and underscores inside a name", () => {
		assert.deepEqual(findSkillRefs("@skill:a.b @skill:a-b_c"), ["a.b", "a-b_c"]);
	});

	it("needs a space, tab, newline, or the start of the text before @skill:", () => {
		assert.deepEqual(findSkillRefs("email me@skill:a"), []);
		assert.deepEqual(findSkillRefs("x\n@skill:a"), ["a"]);
		assert.deepEqual(findSkillRefs("\t@skill:a"), ["a"]);
		assert.deepEqual(findSkillRefs("@skill:a"), ["a"]);
	});
});

describe("renderSkillBlock", () => {
	it("renders Pi's skill block format with the directory of the file and the trimmed body", () => {
		assert.equal(renderSkillBlock({ name: "a", path: "/skills/a/SKILL.md" }, "\nAlpha body.\n\n"), A_BLOCK);
	});
});

describe("expandMessage", () => {
	it("leaves a message without known refs unchanged", () => {
		assert.deepEqual(summary(expandMessage("hello there", resolveSkill, resolveTemplate)), {
			text: "hello there",
			changed: false,
			skills: [],
			template: undefined,
			unknown: [],
		});
	});

	it("leaves an unknown ref literal and reports it", () => {
		assert.deepEqual(summary(expandMessage("hi @skill:zzz", resolveSkill, resolveTemplate)), {
			text: "hi @skill:zzz",
			changed: false,
			skills: [],
			template: undefined,
			unknown: ["zzz"],
		});
	});

	it("puts the blocks first, keeps the text and the tokens, and joins them with blank lines", () => {
		const result = expandMessage("Use @skill:a and @skill:b for x", resolveSkill, resolveTemplate);

		assert.equal(result.text, `${A_BLOCK}\n\n${B_BLOCK}\n\nUse @skill:a and @skill:b for x`);
		assert.deepEqual(result.skills.map((skill) => skill.name), ["a", "b"]);
	});

	it("injects a repeated ref once", () => {
		const result = expandMessage("@skill:a then @skill:a", resolveSkill, resolveTemplate);

		assert.equal(result.text, `${A_BLOCK}\n\n@skill:a then @skill:a`);
	});

	it("folds a leading /skill:<name> into the first block and removes only that token", () => {
		const result = expandMessage("/skill:b fix @skill:a now", resolveSkill, resolveTemplate);

		assert.equal(result.text, `${B_BLOCK}\n\n${A_BLOCK}\n\nfix @skill:a now`);
		assert.deepEqual(result.skills.map((skill) => skill.name), ["b", "a"]);
	});

	it("gives only the block when the leading /skill:<name> has no other text", () => {
		assert.equal(expandMessage("/skill:b", resolveSkill, resolveTemplate).text, B_BLOCK);
	});

	it("treats a leading /skill:<unknown> as plain text", () => {
		const result = expandMessage("/skill:zzz @skill:a", resolveSkill, resolveTemplate);

		assert.equal(result.text, `${A_BLOCK}\n\n/skill:zzz @skill:a`);
		assert.deepEqual(result.unknown, []);
	});

	it("expands a leading template, keeps @skill: tokens as positional args, and adds the skill blocks", () => {
		const result = expandMessage("/gh @skill:a x", resolveSkill, resolveTemplate);

		assert.equal(result.text, `${A_BLOCK}\n\nDo @skill:a with x\n`);
		assert.deepEqual(result.template, { name: "gh", path: "/prompts/gh.md" });
	});

	it("keeps quoted args together when it expands a template", () => {
		const result = expandMessage('/pipe "two words" @skill:a', resolveSkill, resolveTemplate);

		assert.equal(result.text, `${A_BLOCK}\n\ntwo words|@skill:a`);
	});

	it("expands a template with no refs to its text", () => {
		const result = expandMessage("/gh x y", resolveSkill, resolveTemplate);

		assert.equal(result.text, "Do x with y\n");
		assert.equal(result.changed, true);
		assert.deepEqual(result.skills, []);
	});

	it("does not expand @skill: written in a template body", () => {
		const result = expandMessage("/note", resolveSkill, resolveTemplate);

		assert.equal(result.text, "See @skill:a here");
		assert.deepEqual(result.skills, []);
	});

	it("treats a leading /word that is not a known template as plain text", () => {
		assert.equal(expandMessage("/unknown @skill:a", resolveSkill, resolveTemplate).text, `${A_BLOCK}\n\n/unknown @skill:a`);
	});

	it("reports an unknown ref that is passed as a template arg and keeps it literal", () => {
		const result = expandMessage("/gh @skill:zzz x", resolveSkill, resolveTemplate);

		assert.equal(result.text, "Do @skill:zzz with x\n");
		assert.deepEqual(result.unknown, ["zzz"]);
	});
});
