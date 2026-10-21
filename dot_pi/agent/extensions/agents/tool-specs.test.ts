import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expandToolSpecs, isToolPattern, unresolvedSpecs } from "./tool-specs.ts";

const REGISTERED = ["read", "bash", "edit", "mcp__github__search", "mcp__github__create_issue", "mcp__slack__post"];

describe("isToolPattern", () => {
	it("is true only for specs that contain a star", () => {
		assert.equal(isToolPattern("mcp__github__*"), true);
		assert.equal(isToolPattern("read"), false);
	});
});

describe("expandToolSpecs", () => {
	it("keeps exact names that are registered and drops the rest", () => {
		assert.deepEqual(expandToolSpecs(["read", "not_there"], REGISTERED), ["read"]);
	});

	it("expands a pattern to its matches sorted alphabetically", () => {
		assert.deepEqual(expandToolSpecs(["mcp__github__*"], REGISTERED), [
			"mcp__github__create_issue",
			"mcp__github__search",
		]);
	});

	it("keeps the order of the specs, with each pattern's matches at its position", () => {
		assert.deepEqual(expandToolSpecs(["edit", "mcp__github__*", "read"], REGISTERED), [
			"edit",
			"mcp__github__create_issue",
			"mcp__github__search",
			"read",
		]);
	});

	it("removes duplicates, keeping the first occurrence", () => {
		assert.deepEqual(expandToolSpecs(["read", "read", "mcp__github__search", "mcp__github__*"], REGISTERED), [
			"read",
			"mcp__github__search",
			"mcp__github__create_issue",
		]);
	});

	it("matches literally except for the star", () => {
		assert.deepEqual(expandToolSpecs(["mcp.github*"], ["mcp.github_1", "mcpXgithub_1"]), ["mcp.github_1"]);
	});
});

describe("unresolvedSpecs", () => {
	it("returns specs that match no registered tool, in order", () => {
		assert.deepEqual(unresolvedSpecs(["read", "mcp__linear__*", "gone", "mcp__slack__*"], REGISTERED), [
			"mcp__linear__*",
			"gone",
		]);
	});
});
