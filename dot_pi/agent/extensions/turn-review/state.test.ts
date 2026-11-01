import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CUSTOM_TYPE, latestMarker, type BranchEntry } from "./state.ts";

function marker(base: string, reviewCommit: string) {
	return { v: 1, base, head: "head-sha", reviewCommit, at: "2025-01-01T00:00:00.000Z" };
}

function customEntry(data: unknown, customType: string = CUSTOM_TYPE): BranchEntry {
	return { type: "custom", customType, data };
}

describe("latestMarker", () => {
	it("returns the latest valid marker on the branch", () => {
		const entries = [customEntry(marker("base-1", "review-1")), customEntry(marker("base-2", "review-2"))];

		assert.equal(latestMarker(entries)?.reviewCommit, "review-2");
	});

	it("ignores other custom types, other entry types, and malformed data", () => {
		const entries: BranchEntry[] = [
			customEntry(marker("base-1", "review-1")),
			customEntry(marker("base-2", "review-2"), "some-other-extension"),
			customEntry({ v: 1, base: "base-3" }),
			{ type: "message", data: marker("base-4", "review-4") },
		];

		assert.equal(latestMarker(entries)?.reviewCommit, "review-1");
	});

	it("returns undefined for an empty branch", () => {
		assert.equal(latestMarker([]), undefined);
	});
});
