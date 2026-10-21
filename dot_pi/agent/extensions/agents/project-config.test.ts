import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDefinition } from "./catalog.ts";
import {
	effectiveSkills,
	effectiveToolSpecs,
	loadProjectConfig,
	parseProjectConfig,
	unknownAgentNames,
	type ProjectAgentEntry,
} from "./project-config.ts";

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "build",
		description: "Build agent",
		systemPrompt: "append",
		contextFiles: true,
		body: "",
		filePath: "",
		source: "user",
		...overrides,
	};
}

describe("parseProjectConfig", () => {
	it("reads skills and tools from arrays and from comma strings", () => {
		assert.deepEqual(parseProjectConfig({ review: { skills: ["a", "b"], tools: "t1, t2" } }), {
			review: { skills: ["a", "b"], tools: ["t1", "t2"] },
		});
	});

	it("leaves out lists that are absent", () => {
		assert.deepEqual(parseProjectConfig({ review: { tools: ["t1"] } }), { review: { tools: ["t1"] } });
	});

	it("gives an empty config for a top-level value that is not an object", () => {
		assert.deepEqual(parseProjectConfig(["review"]), {});
		assert.deepEqual(parseProjectConfig("review"), {});
		assert.deepEqual(parseProjectConfig(null), {});
	});

	it("skips agent entries that are not objects", () => {
		assert.deepEqual(parseProjectConfig({ review: "tools", build: null, plan: ["x"], ok: { tools: "t" } }), {
			ok: { tools: ["t"] },
		});
	});

	it("ignores unknown per-agent keys", () => {
		assert.deepEqual(parseProjectConfig({ review: { notes: "later", tools: ["t"] } }), { review: { tools: ["t"] } });
	});
});

describe("loadProjectConfig", () => {
	it("gives an empty config when there is no file", () => {
		assert.deepEqual(loadProjectConfig(null), { config: {} });
	});

	it("gives an empty config without an error when the file does not exist", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-config-"));
		try {
			assert.deepEqual(loadProjectConfig(path.join(dir, "agents.json")), { config: {} });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("gives an empty config and an error that names the file when the JSON is invalid", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-config-"));
		try {
			const file = path.join(dir, "agents.json");
			fs.writeFileSync(file, "{ not json");
			const loaded = loadProjectConfig(file);
			assert.deepEqual(loaded.config, {});
			assert.ok(loaded.error?.includes(file));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("parses a valid file", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-config-"));
		try {
			const file = path.join(dir, "agents.json");
			fs.writeFileSync(file, JSON.stringify({ review: { skills: ["repo-guidelines"] } }));
			assert.deepEqual(loadProjectConfig(file), { config: { review: { skills: ["repo-guidelines"] } } });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("unknownAgentNames", () => {
	it("lists config names that are not in the catalog, in config order", () => {
		const config = { review: {}, ghost: {}, build: {}, phantom: {} } as Record<string, ProjectAgentEntry>;
		assert.deepEqual(unknownAgentNames(config, ["chat", "build", "review"]), ["ghost", "phantom"]);
	});
});

describe("effectiveSkills", () => {
	it("keeps normal skill discovery when the agent defines no skills", () => {
		assert.equal(effectiveSkills(agent(), { skills: ["repo-guidelines"] }), undefined);
	});

	it("unions the agent's skills with the project skills, agent first, without duplicates", () => {
		const def = agent({ skills: ["a", "b"] });
		assert.deepEqual(effectiveSkills(def, { skills: ["b", "c"] }), ["a", "b", "c"]);
	});

	it("uses the project skills when the agent defines an empty list", () => {
		assert.deepEqual(effectiveSkills(agent({ skills: [] }), { skills: ["c"] }), ["c"]);
	});
});

describe("effectiveToolSpecs", () => {
	it("unions def.tools, project tools, and grants in that order when def.tools is defined", () => {
		const def = agent({ tools: ["read", "bash"] });
		assert.deepEqual(effectiveToolSpecs(def, { tools: ["fetch_content", "bash"] }, ["edit"], ["mcp__x__*", "read"]), [
			"read",
			"bash",
			"fetch_content",
			"mcp__x__*",
		]);
	});

	it("is undefined when def.tools is undefined and there are no project tools or grants", () => {
		assert.equal(effectiveToolSpecs(agent(), undefined, ["read", "bash"], []), undefined);
		assert.equal(effectiveToolSpecs(agent(), { tools: [] }, ["read", "bash"], []), undefined);
	});

	it("starts from the baseline when def.tools is undefined and there are project tools", () => {
		assert.deepEqual(effectiveToolSpecs(agent(), { tools: ["fetch_content"] }, ["read", "bash"], ["grepper"]), [
			"read",
			"bash",
			"fetch_content",
			"grepper",
		]);
	});

	it("starts from the baseline when def.tools is undefined and there are only grants", () => {
		assert.deepEqual(effectiveToolSpecs(agent(), undefined, ["read"], ["fetch_content"]), ["read", "fetch_content"]);
	});
});
