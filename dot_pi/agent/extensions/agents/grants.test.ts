import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GRANT_ENTRY, pendingGrants, replayGrants, type BranchEntryLike } from "./grants.ts";

function grantEntry(tools: unknown, source = "gh-create-pr"): BranchEntryLike {
	return { type: "custom", customType: GRANT_ENTRY, data: { tools, source } };
}

describe("replayGrants", () => {
	it("gives the union of the specs in first-seen order", () => {
		const entries = [grantEntry(["fetch_content"]), grantEntry(["mcp__x__*", "fetch_content"]), grantEntry(["ask_user"])];
		assert.deepEqual(replayGrants(entries), ["fetch_content", "mcp__x__*", "ask_user"]);
	});

	it("ignores entries of other types and other custom types", () => {
		const entries: BranchEntryLike[] = [
			{ type: "message", data: { tools: ["fetch_content"] } },
			{ type: "custom", customType: "active-agent", data: { name: "build" } },
			grantEntry(["ask_user"]),
		];
		assert.deepEqual(replayGrants(entries), ["ask_user"]);
	});

	it("ignores agent-grants entries whose tools are not a list", () => {
		const entries: BranchEntryLike[] = [
			{ type: "custom", customType: GRANT_ENTRY },
			grantEntry(42),
			grantEntry(["ask_user"]),
		];
		assert.deepEqual(replayGrants(entries), ["ask_user"]);
	});

	it("gives an empty list when there are no grants", () => {
		assert.deepEqual(replayGrants([]), []);
	});
});

describe("pendingGrants", () => {
	const registered = ["read", "bash", "fetch_content", "mcp__github__search", "mcp__github__create_issue"];

	it("drops specs that are already granted", () => {
		assert.deepEqual(pendingGrants(["fetch_content"], ["fetch_content"], [], registered), []);
	});

	it("drops exact specs whose tool is already active", () => {
		assert.deepEqual(pendingGrants(["read"], [], ["read", "bash"], registered), []);
	});

	it("drops patterns whose matches are all active", () => {
		assert.deepEqual(pendingGrants(["mcp__github__*"], [], ["mcp__github__search", "mcp__github__create_issue"], registered), []);
	});

	it("keeps patterns that are only partly active", () => {
		assert.deepEqual(pendingGrants(["mcp__github__*"], [], ["mcp__github__search"], registered), ["mcp__github__*"]);
	});

	it("keeps specs that are not active, and keeps patterns that match nothing yet", () => {
		assert.deepEqual(pendingGrants(["fetch_content", "mcp__slack__*"], [], ["read"], registered), [
			"fetch_content",
			"mcp__slack__*",
		]);
	});
});
