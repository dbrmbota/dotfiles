import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	ARTIFACT_REF_RE,
	applyRefCompletion,
	buildRefHint,
	buildRefSuggestions,
	buildStorePrompt,
	completeArtifactArgs,
	extractRefToken,
	formatAge,
	isRefHintToken,
	normalizeRemoteUrl,
	parseArtifactArg,
	substituteRefs,
	type FuzzyFn,
} from "./refs.ts";
import type { ArtifactEntry, ArtifactType } from "./store.ts";

/** Stub fuzzy matcher: keeps items whose text contains the query, in input order. */
const contains: FuzzyFn = (items, query, getText) => items.filter((item) => getText(item).includes(query));

function entry(type: ArtifactType, name: string, mtimeMs: number, title = `Title ${name}`): ArtifactEntry {
	return { type, name, path: `/store/${type}/${name}.md`, title, mtimeMs };
}

/** `type:name` pairs of every ARTIFACT_REF_RE match in `text`. */
function refsIn(text: string): string[] {
	return [...text.matchAll(ARTIFACT_REF_RE)].map((match) => `${match[2]}:${match[3]}`);
}

describe("ARTIFACT_REF_RE", () => {
	it("matches at the start of the text and after spaces, tabs, and newlines", () => {
		assert.deepEqual(refsIn("@plan:foo"), ["plan:foo"]);
		assert.deepEqual(refsIn("a @task:x"), ["task:x"]);
		assert.deepEqual(refsIn("a\tb\n@report:r1"), ["report:r1"]);
	});

	it("drops trailing punctuation so @plan:foo. resolves to foo", () => {
		assert.deepEqual(refsIn("see @plan:foo."), ["plan:foo"]);
		assert.deepEqual(refsIn("@plan:foo-, next"), ["plan:foo"]);
	});

	it("keeps dotted name segments", () => {
		assert.deepEqual(refsIn("@report:v1.2"), ["report:v1.2"]);
	});

	it("does not match inside a word or with another type", () => {
		assert.deepEqual(refsIn("foo@plan:x"), []);
		assert.deepEqual(refsIn("@plans:x"), []);
		assert.deepEqual(refsIn("@PLAN:x"), []);
	});
});

describe("substituteRefs", () => {
	const exists = (type: ArtifactType, name: string): string | undefined =>
		type === "plan" && name === "foo" ? "/abs/plan/foo.md" : undefined;

	it("replaces a known reference with its absolute path", () => {
		assert.deepEqual(substituteRefs("Read @plan:foo now", exists), {
			text: "Read /abs/plan/foo.md now",
			unknown: [],
		});
	});

	it("keeps the leading newline and keeps trailing punctuation", () => {
		assert.deepEqual(substituteRefs("a\n@plan:foo.", exists), {
			text: "a\n/abs/plan/foo.md.",
			unknown: [],
		});
	});

	it("leaves unknown references unchanged and reports them", () => {
		assert.deepEqual(substituteRefs("@plan:nope and @plan:foo", exists), {
			text: "@plan:nope and /abs/plan/foo.md",
			unknown: ["plan:nope"],
		});
	});

	it("reports each unknown reference once", () => {
		assert.deepEqual(substituteRefs("@task:x @task:x", exists).unknown, ["task:x"]);
	});

	it("returns the text unchanged when there are no references", () => {
		assert.deepEqual(substituteRefs("plain text", exists), { text: "plain text", unknown: [] });
	});
});

describe("parseArtifactArg", () => {
	it("accepts @type:name and bare type:name", () => {
		assert.deepEqual(parseArtifactArg("@task:fix-x"), { type: "task", name: "fix-x" });
		assert.deepEqual(parseArtifactArg("plan:fix-x"), { type: "plan", name: "fix-x" });
		assert.deepEqual(parseArtifactArg("@report:v1.2"), { type: "report", name: "v1.2" });
	});

	it("rejects a bare type, unknown types, empty and invalid names, and the empty string", () => {
		for (const arg of ["plan", "@foo:x", "", "@plan:", "@plan:Bad", "@plan:a/b", "@plan:x y"]) {
			assert.equal(parseArtifactArg(arg), undefined, arg);
		}
	});
});

describe("extractRefToken", () => {
	it("returns the type and query for each prefix", () => {
		assert.deepEqual(extractRefToken("@task:"), { type: "task", query: "" });
		assert.deepEqual(extractRefToken("fix @plan:fo"), { type: "plan", query: "fo" });
		assert.deepEqual(extractRefToken("@report:r-1"), { type: "report", query: "r-1" });
	});

	it("accepts a unique type prefix before the colon", () => {
		assert.deepEqual(extractRefToken("@p:"), { type: "plan", query: "" });
		assert.deepEqual(extractRefToken("@t:fi"), { type: "task", query: "fi" });
		assert.deepEqual(extractRefToken("@re:r1"), { type: "report", query: "r1" });
	});

	it("returns undefined outside a token", () => {
		assert.equal(extractRefToken("x@plan:"), undefined);
		assert.equal(extractRefToken("@:"), undefined);
		assert.equal(extractRefToken("@plan:foo bar"), undefined);
		assert.equal(extractRefToken("@foo:"), undefined);
		assert.equal(extractRefToken("plain"), undefined);
	});
});

describe("isRefHintToken", () => {
	it("matches a partial type word after @ for each prefix", () => {
		assert.deepEqual(isRefHintToken("@t"), ["task"]);
		assert.deepEqual(isRefHintToken("x @p"), ["plan"]);
		assert.deepEqual(isRefHintToken("@r"), ["report"]);
		assert.deepEqual(isRefHintToken("@rep"), ["report"]);
		assert.deepEqual(isRefHintToken("@plan"), ["plan"]);
	});

	it("returns an empty list for a bare @, full refs, and mid-word matches", () => {
		assert.deepEqual(isRefHintToken("@"), []);
		assert.deepEqual(isRefHintToken("@task:"), []);
		assert.deepEqual(isRefHintToken("@tasks"), []);
		assert.deepEqual(isRefHintToken("x@t"), []);
	});
});

describe("formatAge", () => {
	const now = 1_700_000_000_000;
	it("formats minutes, hours, and days", () => {
		assert.equal(formatAge(now, now), "0m");
		assert.equal(formatAge(now, now - 5 * 60_000), "5m");
		assert.equal(formatAge(now, now - 3 * 3_600_000), "3h");
		assert.equal(formatAge(now, now - 2 * 86_400_000), "2d");
	});

	it("clamps future timestamps", () => {
		assert.equal(formatAge(now, now + 60_000), "0m");
	});
});

describe("buildRefSuggestions", () => {
	const now = 1_700_000_000_000;
	const plans = Array.from({ length: 7 }, (_, i) => entry("plan", `plan-${i}`, now - i * 60_000));
	const task = entry("task", "a-task", now - 1000);
	const newestFirst = [plans[0], task, ...plans.slice(1)];

	it("returns the 5 newest artifacts of the type for an empty query", () => {
		const items = buildRefSuggestions(newestFirst, "plan", "", contains, now);
		assert.deepEqual(
			items.map((item) => item.value),
			["@plan:plan-0", "@plan:plan-1", "@plan:plan-2", "@plan:plan-3", "@plan:plan-4"],
		);
	});

	it("uses the injected fuzzy matcher for a non-empty query", () => {
		const items = buildRefSuggestions(newestFirst, "plan", "plan-3", contains, now);
		assert.deepEqual(items.map((item) => item.value), ["@plan:plan-3"]);
	});

	it("passes the query to the injected matcher, so its order wins", () => {
		const reversed: FuzzyFn = (items) => [...items].reverse();
		const items = buildRefSuggestions(newestFirst, "plan", "x", reversed, now);
		assert.deepEqual(
			items.map((item) => item.value),
			["@plan:plan-6", "@plan:plan-5", "@plan:plan-4", "@plan:plan-3", "@plan:plan-2", "@plan:plan-1", "@plan:plan-0"],
		);
	});

	it("caps fuzzy results at 20", () => {
		const many = Array.from({ length: 25 }, (_, i) => entry("plan", `item-${i}`, now - i));
		assert.equal(buildRefSuggestions(many, "plan", "item", contains, now).length, 20);
	});

	it("describes each item as <age> · <title>", () => {
		const items = buildRefSuggestions([entry("plan", "p", now - 3 * 3_600_000, "Plan title")], "plan", "", contains, now);
		assert.equal(items[0].label, "p");
		assert.equal(items[0].description, "3h · Plan title");
	});
});

describe("buildRefHint", () => {
	it("returns the @type: hint without a trailing space", () => {
		const hint = buildRefHint("plan");
		assert.equal(hint.value, "@plan:");
		assert.equal(hint.label, "@plan:");
	});
});

describe("applyRefCompletion", () => {
	it("replaces the typed prefix with the reference plus a trailing space", () => {
		const applied = applyRefCompletion("see @pl", "", "@plan:foo", "@pl");
		assert.deepEqual(applied, { text: "see @plan:foo ", cursorCol: "see @plan:foo ".length });
	});

	it("inserts the hint without a trailing space", () => {
		assert.deepEqual(applyRefCompletion("see @p", "", "@plan:", "@p"), {
			text: "see @plan:",
			cursorCol: "see @plan:".length,
		});
	});

	it("keeps the text after the cursor", () => {
		assert.deepEqual(applyRefCompletion("@p", " tail", "@plan:", "@p"), {
			text: "@plan: tail",
			cursorCol: "@plan:".length,
		});
	});

	it("returns null for values that are not artifact references", () => {
		assert.equal(applyRefCompletion("@m", "", "@mem:x", "@m"), null);
		assert.equal(applyRefCompletion("", "", "src/index.ts", ""), null);
	});
});

describe("completeArtifactArgs", () => {
	const entries = [entry("plan", "alpha", 2000, "Alpha"), entry("task", "beta", 1000, "Beta")];
	const values = (prefix: string): string[] => completeArtifactArgs(prefix, entries, contains).map((item) => item.value);

	it("completes the subcommand on the first word", () => {
		assert.deepEqual(values(""), ["edit", "delete"]);
		assert.deepEqual(values("ed"), ["edit"]);
		assert.deepEqual(values("x"), []);
	});

	it("offers every artifact after edit or delete, carrying the full argument text", () => {
		assert.deepEqual(values("edit "), ["edit @plan:alpha", "edit @task:beta"]);
		assert.deepEqual(values("delete "), ["delete @plan:alpha", "delete @task:beta"]);
	});

	it("fuzzy-matches the typed reference after the subcommand", () => {
		assert.deepEqual(values("edit @pl"), ["edit @plan:alpha"]);
	});

	it("labels items as type:name with the title as description", () => {
		const [item] = completeArtifactArgs("edit ", entries, contains);
		assert.equal(item.label, "plan:alpha");
		assert.equal(item.description, "Alpha");
	});

	it("returns nothing for unknown subcommands and empty artifact lists", () => {
		assert.deepEqual(values("bogus "), []);
		assert.deepEqual(completeArtifactArgs("edit ", [], contains), []);
	});
});

describe("buildStorePrompt", () => {
	const typeDir = "/store/proj-1/task";

	it("names the full type directory and the reply format for a task", () => {
		const prompt = buildStorePrompt("task", typeDir, "");
		assert.ok(prompt.includes(`${typeDir}/<name>.md`), prompt);
		assert.ok(prompt.includes(`ls ${typeDir}`), prompt);
		assert.ok(prompt.includes("@task:<name>"), prompt);
		assert.ok(prompt.includes("goal, scope, and acceptance criteria"), prompt);
		assert.ok(!prompt.includes("Additional instruction from me"), prompt);
	});

	it("uses the report line for a report", () => {
		const reportDir = "/store/proj-1/report";
		const prompt = buildStorePrompt("report", reportDir, "");
		assert.ok(prompt.includes(`${reportDir}/<name>.md`), prompt);
		assert.ok(prompt.includes("@report:<name>"), prompt);
		assert.ok(prompt.includes("findings with evidence and sources"), prompt);
		assert.ok(!prompt.includes("acceptance criteria"), prompt);
	});

	it("appends the trimmed instructions as an additional instruction line", () => {
		const prompt = buildStorePrompt("report", "/store/p/report", "  focus on perf  ");
		assert.ok(prompt.endsWith("\n\nAdditional instruction from me: focus on perf"), prompt);
	});
});

describe("normalizeRemoteUrl", () => {
	const expected = "github.com/acme/widget";
	it("maps ssh, https, ssh://, userinfo, port, .git, slash, and case to one key", () => {
		const variants = [
			"git@github.com:Acme/Widget.git",
			"https://github.com/Acme/Widget",
			"ssh://git@github.com:22/Acme/Widget.git",
			"https://user@github.com:8443/Acme/Widget.git/",
			"HTTP://GITHUB.COM/Acme/Widget/",
		];
		for (const url of variants) {
			assert.equal(normalizeRemoteUrl(url), expected, url);
		}
	});

	it("maps local paths to file/ keys", () => {
		assert.equal(normalizeRemoteUrl("/srv/git/foo.git"), "file/srv/git/foo");
		assert.equal(normalizeRemoteUrl("/srv/git/foo/"), "file/srv/git/foo");
	});
});
