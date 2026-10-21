import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { frontmatterToolSpecs, leadingCommandName, resolveReadPath } from "./invocations.ts";

describe("leadingCommandName", () => {
	it("returns the name of a leading command without the slash", () => {
		assert.equal(leadingCommandName("/skill:review please"), "skill:review");
		assert.equal(leadingCommandName("/gh-create-pr @skill:a"), "gh-create-pr");
	});

	it("returns undefined when the text does not start with a command", () => {
		assert.equal(leadingCommandName("please /skill:review"), undefined);
		assert.equal(leadingCommandName(" /skill:review"), undefined);
		assert.equal(leadingCommandName("/"), undefined);
		assert.equal(leadingCommandName("/ review"), undefined);
	});
});

describe("frontmatterToolSpecs", () => {
	it("reads tools from a prompt, as a list or a comma string", () => {
		assert.deepEqual(frontmatterToolSpecs("prompt", { tools: "fetch_content, ask_user" }), ["fetch_content", "ask_user"]);
		assert.deepEqual(frontmatterToolSpecs("prompt", { tools: ["mcp__github__*"] }), ["mcp__github__*"]);
	});

	it("gives no tools for a prompt without tools", () => {
		assert.deepEqual(frontmatterToolSpecs("prompt", {}), []);
	});

	it("reads a skill's tools from metadata pi-tools", () => {
		assert.deepEqual(frontmatterToolSpecs("skill", { metadata: { "pi-tools": ["fetch_content"] } }), ["fetch_content"]);
	});

	it("ignores a top-level tools key on a skill", () => {
		assert.deepEqual(frontmatterToolSpecs("skill", { tools: ["bash"] }), []);
		assert.deepEqual(frontmatterToolSpecs("skill", { tools: ["bash"], metadata: { "pi-tools": ["ask_user"] } }), [
			"ask_user",
		]);
	});

	it("gives no tools for a skill whose metadata is missing or not an object", () => {
		assert.deepEqual(frontmatterToolSpecs("skill", {}), []);
		assert.deepEqual(frontmatterToolSpecs("skill", { metadata: "pi-tools: ask_user" }), []);
	});
});

describe("resolveReadPath", () => {
	const cwd = path.join(path.sep, "work", "repo");

	it("strips a leading @ and resolves a relative path against cwd", () => {
		assert.equal(resolveReadPath("@skills/review/SKILL.md", cwd), path.join(cwd, "skills", "review", "SKILL.md"));
		assert.equal(resolveReadPath("./notes.md", cwd), path.join(cwd, "notes.md"));
	});

	it("expands a leading tilde to the home directory", () => {
		assert.equal(resolveReadPath("~/.pi/agent/skills/x/SKILL.md", cwd), path.join(os.homedir(), ".pi", "agent", "skills", "x", "SKILL.md"));
		assert.equal(resolveReadPath("@~/y.md", cwd), path.join(os.homedir(), "y.md"));
	});

	it("keeps an absolute path", () => {
		assert.equal(resolveReadPath(path.join(path.sep, "abs", "z.md"), cwd), path.join(path.sep, "abs", "z.md"));
	});
});
