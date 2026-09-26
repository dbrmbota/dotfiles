import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_DESCRIPTION_LENGTH,
	MAX_NAME_LENGTH,
	NAME_RE,
	applyMemCompletion,
	buildMemHint,
	buildMemSuggestions,
	completeMemoryArgs,
	extractMemRefs,
	extractMemToken,
	formatAge,
	isMemHintToken,
	normalizeRemoteUrl,
	parseMemoryEdit,
	serializeMemoryEdit,
	validateDescription,
	validateName,
	type FrontmatterParser,
	type SuggestionEntry,
} from "./refs.ts";

describe("NAME_RE", () => {
	it("accepts simple and compound names", () => {
		for (const name of ["a", "foo", "foo-bar", "foo_bar", "a/b.c_d", "x1", "0"]) {
			assert.match(name, NAME_RE, name);
		}
	});

	it("rejects uppercase, spaces, and bad separators", () => {
		for (const name of ["", "Foo", "-foo", "foo-", "foo--bar", "foo..bar", "foo bar", "foo:", "/foo", "foo/"]) {
			assert.doesNotMatch(name, NAME_RE, name);
		}
	});
});

describe("validateName", () => {
	it("accepts a valid name", () => {
		assert.equal(validateName("my-memory"), undefined);
	});

	it("rejects empty and over-long names", () => {
		assert.ok(validateName(""));
		assert.equal(validateName("a".repeat(MAX_NAME_LENGTH)), undefined);
		assert.ok(validateName("a".repeat(MAX_NAME_LENGTH + 1)));
	});

	it("rejects names outside the pattern", () => {
		assert.ok(validateName("Has Space"));
		assert.ok(validateName("UPPER"));
	});
});

describe("validateDescription", () => {
	it("accepts a one-sentence description", () => {
		assert.equal(validateDescription("Project-scoped markdown memory for pi."), undefined);
	});

	it("rejects empty, over-long, and multiline descriptions", () => {
		assert.ok(validateDescription(""));
		assert.ok(validateDescription("   "));
		assert.ok(validateDescription("a".repeat(MAX_DESCRIPTION_LENGTH + 1)));
		assert.ok(validateDescription("line one\nline two"));
		assert.ok(validateDescription("line one\r\nline two"));
	});

	it("accepts exactly the maximum length", () => {
		assert.equal(validateDescription("a".repeat(MAX_DESCRIPTION_LENGTH)), undefined);
	});
});

describe("extractMemToken", () => {
	it("extracts the query from an @mem: token", () => {
		assert.equal(extractMemToken("@mem:foo"), "foo");
		assert.equal(extractMemToken("hello @mem:bar-baz"), "bar-baz");
		assert.equal(extractMemToken("@mem:"), "");
		assert.equal(extractMemToken("\t@mem:a/b.c_d"), "a/b.c_d");
	});

	it("returns undefined outside an @mem: token", () => {
		assert.equal(extractMemToken("x@mem:foo"), undefined);
		assert.equal(extractMemToken("@mem:foo bar"), undefined);
		assert.equal(extractMemToken("@me:foo"), undefined);
		assert.equal(extractMemToken("plain text"), undefined);
	});

});

describe("isMemHintToken", () => {
	it("matches bare @m, @me, and @mem at the end", () => {
		assert.equal(isMemHintToken("@m"), true);
		assert.equal(isMemHintToken("@me"), true);
		assert.equal(isMemHintToken("@mem"), true);
		assert.equal(isMemHintToken("see @me"), true);
	});

	it("rejects longer tokens and mid-text matches", () => {
		assert.equal(isMemHintToken("@mem:x"), false);
		assert.equal(isMemHintToken("@memo"), false);
		assert.equal(isMemHintToken("a@me"), false);
		assert.equal(isMemHintToken("@me x"), false);
	});
});

describe("extractMemRefs", () => {
	it("collects references and drops trailing punctuation", () => {
		assert.deepEqual(extractMemRefs("see @mem:foo and @mem:bar-baz."), ["foo", "bar-baz"]);
	});

	it("returns an empty list when there are no references", () => {
		assert.deepEqual(extractMemRefs("no refs here"), []);
		assert.deepEqual(extractMemRefs("@me:foo"), []);
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

/** Minimal frontmatter parser for the exact shape serializeMemoryEdit emits. */
function miniParse(text: string): { frontmatter: Record<string, unknown>; body: string } {
	const match = text.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
	assert.ok(match, "prefill shape");
	const line = match[1];
	const descMatch = line.match(/^description: (.*)$/);
	assert.ok(descMatch, "description line");
	const raw = descMatch[1];
	let description: string;
	if (raw.startsWith('"')) {
		description = JSON.parse(raw) as string;
	} else if (raw.startsWith("'")) {
		description = raw.slice(1, -1).replace(/''/g, "'");
	} else {
		description = raw;
	}
	return { frontmatter: { description }, body: match[2] };
}

describe("serializeMemoryEdit / parseMemoryEdit", () => {
	it("round-trips description and content", () => {
		const text = serializeMemoryEdit("Short memory", "# Title\n\nBody text.");
		const parsed = parseMemoryEdit(text, miniParse);
		assert.deepEqual(parsed, { ok: true, description: "Short memory", content: "# Title\n\nBody text." });
	});

	it("round-trips a description containing a colon", () => {
		const text = serializeMemoryEdit("Notes: auth flow", "content");
		assert.deepEqual(parseMemoryEdit(text, miniParse), {
			ok: true,
			description: "Notes: auth flow",
			content: "content",
		});
	});

	it("round-trips a body containing ---", () => {
		const text = serializeMemoryEdit("Desc", "a\n---\nb");
		assert.deepEqual(parseMemoryEdit(text, miniParse), {
			ok: true,
			description: "Desc",
			content: "a\n---\nb",
		});
	});

	it("rejects missing, empty, and invalid descriptions", () => {
		const noDesc: FrontmatterParser = () => ({ frontmatter: {}, body: "content" });
		assert.ok(!parseMemoryEdit("x", noDesc).ok);
		const emptyDesc: FrontmatterParser = () => ({ frontmatter: { description: "  " }, body: "content" });
		assert.ok(!parseMemoryEdit("x", emptyDesc).ok);
		const multiDesc: FrontmatterParser = () => ({
			frontmatter: { description: "one\ntwo" },
			body: "content",
		});
		assert.ok(!parseMemoryEdit("x", multiDesc).ok);
	});

	it("rejects an empty body and points at /memory delete", () => {
		const emptyBody: FrontmatterParser = () => ({ frontmatter: { description: "Desc" }, body: "  \n " });
		const parsed = parseMemoryEdit("x", emptyBody);
		assert.equal(parsed.ok, false);
		if (!parsed.ok) assert.match(parsed.error, /\/memory delete/);
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

function entry(name: string, index: number): SuggestionEntry {
	return { name, description: `Description of ${name}`, lastUsedAt: 1_000_000 - index * 1000 };
}

describe("buildMemSuggestions", () => {
	const now = 1_000_000;

	it("returns the 5 most recent entries for an empty query", () => {
		const entries = ["a", "b", "c", "d", "e", "f", "g"].map((n, i) => entry(n, i));
		const items = buildMemSuggestions(entries, "", () => {
			throw new Error("fuzzy must not be called for an empty query");
		}, now);
		assert.equal(items.length, 5);
		assert.deepEqual(items.map((item) => item.value), ["@mem:a", "@mem:b", "@mem:c", "@mem:d", "@mem:e"]);
		assert.equal(items[0].label, "a");
		assert.match(items[0].description ?? "", /Description of a/);
	});

	it("uses the injected fuzzy matcher for a non-empty query", () => {
		const entries = [entry("auth-flow", 0), entry("deploy-notes", 1)];
		let seenQuery: string | undefined;
		const items = buildMemSuggestions(entries, "auth", (things: SuggestionEntry[], query: string) => {
			seenQuery = query;
			return things.filter((thing) => thing.name.includes(query));
		}, now);
		assert.equal(seenQuery, "auth");
		assert.deepEqual(items.map((item) => item.value), ["@mem:auth-flow"]);
	});

	it("caps fuzzy results at 20", () => {
		const entries = Array.from({ length: 25 }, (_, i) => entry(`mem-${i}`, i));
		const items = buildMemSuggestions(entries, "mem", (things) => things, now);
		assert.equal(items.length, 20);
	});
});

describe("buildMemHint", () => {
	it("returns the @mem: hint item without a trailing space", () => {
		const hint = buildMemHint();
		assert.equal(hint.value, "@mem:");
		assert.equal(hint.label, "@mem:");
		assert.equal(hint.description, "project memory");
	});
});

describe("completeMemoryArgs", () => {
	const entries = ["deploy-notes", "auth-flow"].map((name, i) => entry(name, i));

	it("completes subcommands first", () => {
		assert.deepEqual(completeMemoryArgs("", [], () => { throw new Error("no fuzzy"); }), [
			{ value: "edit", label: "edit" },
			{ value: "delete", label: "delete" },
		]);
		assert.deepEqual(completeMemoryArgs("e", [], () => { throw new Error("no fuzzy"); }), [
			{ value: "edit", label: "edit" },
		]);
		assert.deepEqual(completeMemoryArgs("x", [], () => { throw new Error("no fuzzy"); }), []);
	});

	it("returns full argument text for names so the subcommand survives", () => {
		assert.deepEqual(completeMemoryArgs("edit ", entries, () => { throw new Error("no fuzzy"); }), [
			{ value: "edit deploy-notes", label: "deploy-notes", description: "Description of deploy-notes" },
			{ value: "edit auth-flow", label: "auth-flow", description: "Description of auth-flow" },
		]);
	});

	it("fuzzy-filters names and caps at 20", () => {
		let seen = "";
		const items = completeMemoryArgs("delete mem", Array.from({ length: 25 }, (_, i) => entry(`mem-${i}`, i)), (things, query) => {
			seen = query;
		return things;
		});
		assert.equal(seen, "mem");
		assert.equal(items.length, 20);
		assert.ok(items.every((item) => item.value.startsWith("delete mem-")));
	});

	it("returns nothing for unknown subcommands", () => {
		assert.deepEqual(completeMemoryArgs("rename foo", entries, (things) => things), []);
	});
});

describe("applyMemCompletion", () => {
	it("replaces the prefix with the name plus a trailing space", () => {
		assert.deepEqual(
			applyMemCompletion("- @mem:re", " tail", "@mem:resource", "@mem:re"),
			{ text: "- @mem:resource  tail", cursorCol: 16 },
		);
	});

	it("applies the hint without a trailing space", () => {
		assert.deepEqual(applyMemCompletion("@m", "", "@mem:", "@m"), { text: "@mem:", cursorCol: 5 });
	});

	it("delegates non-memory values", () => {
		assert.equal(applyMemCompletion("#12", "", "#12", "#12"), null);
	});
});
