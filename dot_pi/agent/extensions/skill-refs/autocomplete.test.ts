import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	applySkillCompletion,
	buildSkillHint,
	buildSkillSuggestions,
	extractSkillToken,
	isSkillHintToken,
	type FuzzyFn,
	type SkillCandidate,
} from "./autocomplete.ts";

const SKILLS: SkillCandidate[] = [
	{ name: "review", description: "Review code", path: "/skills/review/SKILL.md" },
	{ name: "abc", path: "/skills/abc/SKILL.md" },
	{ name: "deploy", description: "Ship it", path: "/skills/deploy/SKILL.md" },
];

/** A fuzzy stand-in that keeps items containing the query, in input order. */
const includesFuzzy: FuzzyFn = (items, query, getText) => items.filter((item) => getText(item).includes(query));

describe("extractSkillToken", () => {
	it("returns the query after @skill: at the end of the text before the cursor", () => {
		assert.deepEqual(extractSkillToken("@skill:rev"), { query: "rev" });
		assert.deepEqual(extractSkillToken("use @skill:"), { query: "" });
		assert.deepEqual(extractSkillToken("use @skill:a.b-c_1"), { query: "a.b-c_1" });
	});

	it("returns undefined when there is no token at the end", () => {
		assert.equal(extractSkillToken("email@skill:a"), undefined);
		assert.equal(extractSkillToken("@skill:a "), undefined);
		assert.equal(extractSkillToken("@task:x"), undefined);
	});
});

describe("isSkillHintToken", () => {
	it("is true for @ followed by any prefix of skill, from s to skill", () => {
		assert.equal(isSkillHintToken("@s"), true);
		assert.equal(isSkillHintToken("@sk"), true);
		assert.equal(isSkillHintToken("@ski"), true);
		assert.equal(isSkillHintToken("@skil"), true);
		assert.equal(isSkillHintToken("@skill"), true);
		assert.equal(isSkillHintToken("use @s"), true);
	});

	it("is false for a bare @, a longer word, a word not at a token start, or a full token", () => {
		assert.equal(isSkillHintToken("@"), false);
		assert.equal(isSkillHintToken("@skillx"), false);
		assert.equal(isSkillHintToken("email@s"), false);
		assert.equal(isSkillHintToken("@skill:"), false);
	});
});

describe("buildSkillSuggestions", () => {
	it("lists every skill alphabetically for an empty query", () => {
		const items = buildSkillSuggestions(SKILLS, "", includesFuzzy);

		assert.deepEqual(items.map((item) => item.value), ["@skill:abc", "@skill:deploy", "@skill:review"]);
	});

	it("uses the skill description, and falls back to skill when there is none", () => {
		const items = buildSkillSuggestions(SKILLS, "", includesFuzzy);

		assert.equal(items.find((item) => item.value === "@skill:review")?.description, "Review code");
		assert.equal(items.find((item) => item.value === "@skill:abc")?.description, "skill");
	});

	it("labels each item with its @skill: value", () => {
		const item = buildSkillSuggestions(SKILLS, "rev", includesFuzzy)[0];

		assert.equal(item?.label, "@skill:review");
	});

	it("uses the order of the fuzzy matcher for a non-empty query", () => {
		const reversed: FuzzyFn = (items) => [...items].reverse();

		assert.deepEqual(buildSkillSuggestions(SKILLS, "x", reversed).map((item) => item.value), [
			"@skill:deploy",
			"@skill:abc",
			"@skill:review",
		]);
	});

	it("keeps only the matches the fuzzy matcher returns for a query", () => {
		assert.deepEqual(buildSkillSuggestions(SKILLS, "ev", includesFuzzy).map((item) => item.value), ["@skill:review"]);
	});

	it("shows at most 20 fuzzy matches", () => {
		const many: SkillCandidate[] = Array.from({ length: 25 }, (_, i) => ({
			name: `s${String(i).padStart(2, "0")}`,
			path: `/skills/s${i}/SKILL.md`,
		}));

		assert.equal(buildSkillSuggestions(many, "s", includesFuzzy).length, 20);
	});
});

describe("buildSkillHint", () => {
	it("is the @skill: item, labelled with the same text", () => {
		const hint = buildSkillHint();

		assert.equal(hint.value, "@skill:");
		assert.equal(hint.label, "@skill:");
	});
});

describe("applySkillCompletion", () => {
	it("replaces the typed prefix with the skill reference and a trailing space", () => {
		assert.deepEqual(applySkillCompletion("use @sk", "", "@skill:review", "@sk"), {
			text: "use @skill:review ",
			cursorCol: 18,
		});
	});

	it("keeps the text after the cursor", () => {
		assert.deepEqual(applySkillCompletion("use @sk", "!", "@skill:review", "@sk"), {
			text: "use @skill:review !",
			cursorCol: 18,
		});
	});

	it("inserts the hint without a trailing space", () => {
		assert.deepEqual(applySkillCompletion("use @s", "", "@skill:", "@s"), { text: "use @skill:", cursorCol: 11 });
	});

	it("returns null for values that are not @skill: items", () => {
		assert.equal(applySkillCompletion("use @ta", "", "@task:x", "@ta"), null);
		assert.equal(applySkillCompletion("readme", "", "readme.md", "readme"), null);
	});
});
