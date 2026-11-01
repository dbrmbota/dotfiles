import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isMarkerLine, isReviewedClean, parseSlug, parseSummary } from "./tuicr.ts";

describe("parseSummary", () => {
	it("parses a summary with no comments", () => {
		assert.deepEqual(parseSummary("tuicr-summary: reviewed 3/3 files, 0 comments added"), { reviewed: 3, total: 3, comments: 0 });
	});

	it("parses the singular comment form", () => {
		assert.deepEqual(parseSummary("tuicr-summary: reviewed 1/1 files, 1 comment added"), { reviewed: 1, total: 1, comments: 1 });
	});

	it("parses partially reviewed rounds with comments", () => {
		assert.deepEqual(parseSummary("tuicr-summary: reviewed 10/12 files, 3 comments added"), { reviewed: 10, total: 12, comments: 3 });
	});

	it("returns undefined when there is no summary line", () => {
		assert.equal(parseSummary("tuicr-session: some-slug\n"), undefined);
		assert.equal(parseSummary(""), undefined);
	});

	it("finds the summary line among other stderr lines", () => {
		const stderr = "warning: something happened\ntuicr-session: some-slug\ntuicr-summary: reviewed 2/2 files, 0 comments added\n";

		assert.deepEqual(parseSummary(stderr), { reviewed: 2, total: 2, comments: 0 });
	});

	it("parses a CRLF line ending", () => {
		assert.deepEqual(parseSummary("tuicr-summary: reviewed 3/3 files, 0 comments added\r\n"), { reviewed: 3, total: 3, comments: 0 });
	});

	it("ignores a malformed or prefixed summary line", () => {
		assert.equal(parseSummary("x tuicr-summary: reviewed 3/3 files, 0 comments added"), undefined);
	});
});

describe("isReviewedClean", () => {
	it("is true when every file is reviewed and there are no comments", () => {
		assert.equal(isReviewedClean({ reviewed: 3, total: 3, comments: 0 }), true);
	});

	it("is false when some files are not reviewed", () => {
		assert.equal(isReviewedClean({ reviewed: 2, total: 3, comments: 0 }), false);
	});

	it("is false when there are comments", () => {
		assert.equal(isReviewedClean({ reviewed: 3, total: 3, comments: 1 }), false);
	});

	it("is false for an empty round", () => {
		assert.equal(isReviewedClean({ reviewed: 0, total: 0, comments: 0 }), false);
	});

	it("is false without a summary", () => {
		assert.equal(isReviewedClean(undefined), false);
	});
});

describe("parseSlug", () => {
	it("parses and trims the session slug", () => {
		assert.equal(parseSlug("tuicr-session:  some-slug  \n"), "some-slug");
	});

	it("returns undefined when there is no session line", () => {
		assert.equal(parseSlug("tuicr-summary: reviewed 1/1 files, 0 comments added\n"), undefined);
	});
});

describe("isMarkerLine", () => {
	it("is true for tuicr-session and tuicr-summary lines", () => {
		assert.equal(isMarkerLine("tuicr-session: some-slug"), true);
		assert.equal(isMarkerLine("tuicr-summary: reviewed 1/1 files, 0 comments added"), true);
	});

	it("is false for ordinary lines", () => {
		assert.equal(isMarkerLine("warning: something happened"), false);
		assert.equal(isMarkerLine(""), false);
	});
});
