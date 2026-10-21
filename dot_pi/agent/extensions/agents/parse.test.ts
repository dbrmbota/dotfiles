import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseThinking, str, strList } from "./parse.ts";

describe("str", () => {
	it("returns the trimmed text of a non-empty string", () => {
		assert.equal(str("  review  "), "review");
	});

	it("returns undefined for blank strings and non-strings", () => {
		assert.equal(str("   "), undefined);
		assert.equal(str(3), undefined);
		assert.equal(str(undefined), undefined);
	});
});

describe("strList", () => {
	it("trims an array and drops empty entries and non-strings", () => {
		assert.deepEqual(strList([" read ", "", 3, "bash"]), ["read", "bash"]);
	});

	it("splits a comma string and trims each part", () => {
		assert.deepEqual(strList("read, bash ,,edit"), ["read", "bash", "edit"]);
	});

	it("gives an empty list for a blank string", () => {
		assert.deepEqual(strList("   "), []);
	});

	it("keeps undefined and null as undefined, and other types as undefined", () => {
		assert.equal(strList(undefined), undefined);
		assert.equal(strList(null), undefined);
		assert.equal(strList(42), undefined);
	});
});

describe("parseThinking", () => {
	it("accepts a known level with surrounding spaces", () => {
		assert.equal(parseThinking(" medium "), "medium");
		assert.equal(parseThinking("max"), "max");
	});

	it("rejects unknown levels and non-strings", () => {
		assert.equal(parseThinking("ultra"), undefined);
		assert.equal(parseThinking(undefined), undefined);
		assert.equal(parseThinking(1), undefined);
	});
});
