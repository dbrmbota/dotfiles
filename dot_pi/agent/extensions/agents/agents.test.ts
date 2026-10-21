import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import agentsExtension from "./index.ts";

const CHAT_MD = `---
name: chat
description: Default agent
thinking: high
---

Chat body.
`;

const BUILD_MD = `---
name: build
description: Build agent
tools: read, bash
model: opencode/build-model
thinking: medium
---

Build body.
`;

const PLAIN_MD = `---
name: plain
description: Plain agent
tools: read
---

Plain body.
`;

const REVIEW_MD = `---
name: review
description: Review agent
skills: guide
---

Review body.
`;

const REVIEW_SKILL_MD = `---
name: review
description: Review skill
metadata:
  pi-tools: fetch_content
---

Review skill body.
`;

const HIDDEN_SKILL_MD = `---
name: hidden
description: Hidden skill
disable-model-invocation: true
metadata:
  pi-tools: fetch_content
---

Hidden skill body.
`;

const GH_PROMPT_MD = `---
description: Create a pull request
tools: ask_user
---

Create a pull request for $@.
`;

interface Command {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	sourceInfo: { path: string; source: string; scope: string; origin: string };
}

interface Harness {
	dir: string;
	project: string;
	pi: any;
	ctx: any;
	handlers: Record<string, (event: any, ctx: any) => any>;
	commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	commandList: Command[];
	listeners: Record<string, ((payload: unknown) => void)[]>;
	toolNames: string[];
	activeTools: string[];
	toolCalls: string[][];
	thinkingLevels: string[];
	modelLookups: [string, string][];
	appendedEntries: { type: string; data: any }[];
	emitted: { name: string; payload: unknown }[];
	notices: { message: string; level: string | undefined }[];
	autocompleteFactories: unknown[];
	branch: unknown[];
	picker: { render(width: number): string[] } | undefined;
}

interface SetupOptions {
	/** Files under the project directory, which is the session cwd. */
	project?: Record<string, string>;
	/** Answer for `ctx.isProjectTrusted()`. Defaults to false. */
	trusted?: boolean;
	/** Entries returned by `ctx.sessionManager.getBranch()`. */
	branch?: unknown[];
}

const tempDirs: string[] = [];
let savedAgentDir: string | undefined;

beforeEach(() => {
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeFiles(root: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const file = path.join(root, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
}

/**
 * Writes the agent directory and the project directory, then returns fake pi/ctx
 * objects that record calls. Event listeners are delivered synchronously, as pi does.
 */
function setup(files: Record<string, string>, options: SetupOptions = {}): Harness {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-test-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "agents-project-"));
	tempDirs.push(dir, project);
	writeFiles(dir, files);
	writeFiles(project, options.project ?? {});
	process.env.PI_CODING_AGENT_DIR = dir;

	const builtin = ["read", "bash", "edit", "write"];
	const h: Harness = {
		dir,
		project,
		pi: undefined,
		ctx: undefined,
		handlers: {},
		commands: {},
		commandList: [],
		listeners: {},
		toolNames: [...builtin, "ask_user", "fetch_content"],
		activeTools: [...builtin],
		toolCalls: [],
		thinkingLevels: [],
		modelLookups: [],
		appendedEntries: [],
		emitted: [],
		notices: [],
		autocompleteFactories: [],
		branch: options.branch ?? [],
		picker: undefined,
	};

	h.pi = {
		events: {
			on(name: string, listener: (payload: unknown) => void) {
				(h.listeners[name] ??= []).push(listener);
			},
			emit(name: string, payload: unknown) {
				h.emitted.push({ name, payload });
				for (const listener of h.listeners[name] ?? []) listener(payload);
			},
		},
		registerShortcut() {},
		registerCommand(name: string, command: Harness["commands"][string]) {
			h.commands[name] = command;
		},
		on(name: string, handler: Harness["handlers"][string]) {
			h.handlers[name] = handler;
		},
		getAllTools: () =>
			h.toolNames.map((name) => ({ name, sourceInfo: { source: builtin.includes(name) ? "builtin" : "extension" } })),
		getActiveTools: () => [...h.activeTools],
		setActiveTools(names: string[]) {
			h.toolCalls.push(names);
			h.activeTools = names.filter((name) => h.toolNames.includes(name));
		},
		getCommands: () => h.commandList,
		async setModel() {
			return true;
		},
		setThinkingLevel(level: string) {
			h.thinkingLevels.push(level);
		},
		getThinkingLevel: () => "high",
		sendUserMessage() {},
		appendEntry(type: string, data: unknown) {
			h.appendedEntries.push({ type, data });
		},
	};

	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const keys = { matches: () => false };
	const tui = { requestRender() {} };
	h.ctx = {
		cwd: project,
		hasUI: true,
		isProjectTrusted: () => options.trusted ?? false,
		ui: {
			notify(message: string, level?: string) {
				h.notices.push({ message, level });
			},
			custom: async (factory: (...args: unknown[]) => { render(width: number): string[] }) => {
				h.picker = factory(tui, theme, keys, () => {});
				return null;
			},
			addAutocompleteProvider(factory: unknown) {
				h.autocompleteFactories.push(factory);
			},
		},
		modelRegistry: {
			find: (provider: string, id: string) => {
				h.modelLookups.push([provider, id]);
				return { provider, id };
			},
			getAll: () => [],
		},
		model: undefined,
		sessionManager: { getBranch: () => h.branch },
	};

	agentsExtension(h.pi);
	return h;
}

async function start(h: Harness): Promise<void> {
	await h.handlers.session_start!({}, h.ctx);
}

async function switchTo(h: Harness, name: string): Promise<void> {
	await h.commands.agent!.handler(name, h.ctx);
}

async function submit(h: Harness, text: string): Promise<void> {
	await h.handlers.input!({ type: "input", text, source: "interactive" }, h.ctx);
}

/** Runs `before_agent_start` for the active agent and returns the prompt options it left behind. */
async function startRun(h: Harness, selectedTools: string[], skills: string[] = []) {
	const event = {
		type: "before_agent_start",
		systemPrompt: "",
		prompt: "",
		systemPromptOptions: {
			selectedTools: [...selectedTools],
			sections: {},
			skills: skills.map((name) => ({ name })),
			contextFiles: [],
		},
	};
	await h.handlers.before_agent_start!(event, h.ctx);
	return event.systemPromptOptions;
}

function grantEntries(h: Harness): { type: string; data: any }[] {
	return h.appendedEntries.filter((entry) => entry.type === "agent-grants");
}

function skillCommand(h: Harness, rel: string, name: string): Command {
	return {
		name: `skill:${name}`,
		description: `${name} skill`,
		source: "skill",
		sourceInfo: { path: path.join(h.dir, rel), source: "local", scope: "user", origin: "top-level" },
	};
}

function promptCommand(h: Harness, rel: string, name: string): Command {
	return {
		name,
		description: `${name} prompt`,
		source: "prompt",
		sourceInfo: { path: path.join(h.dir, rel), source: "local", scope: "user", origin: "top-level" },
	};
}

const REVIEW_SKILL_REL = "skills/review/SKILL.md";
const HIDDEN_SKILL_REL = "skills/hidden/SKILL.md";
const GH_PROMPT_REL = "prompts/gh-create-pr.md";

/** Agents, skills, and a template that the grant tests share. */
function grantFiles(): Record<string, string> {
	return {
		"agents/chat.md": CHAT_MD,
		"agents/build.md": BUILD_MD,
		"agents/plain.md": PLAIN_MD,
		"agents/review.md": REVIEW_MD,
		[REVIEW_SKILL_REL]: REVIEW_SKILL_MD,
		[HIDDEN_SKILL_REL]: HIDDEN_SKILL_MD,
		[GH_PROMPT_REL]: GH_PROMPT_MD,
	};
}

function grantHarness(options: SetupOptions = {}): Harness {
	const h = setup(grantFiles(), options);
	h.commandList.push(
		skillCommand(h, REVIEW_SKILL_REL, "review"),
		skillCommand(h, HIDDEN_SKILL_REL, "hidden"),
		promptCommand(h, GH_PROMPT_REL, "gh-create-pr"),
	);
	return h;
}

describe("agents extension", () => {
	it("session_start persists and announces the default agent", async () => {
		const h = setup({ "agents/chat.md": CHAT_MD, "agents/build.md": BUILD_MD });

		await h.handlers.session_start!({}, h.ctx);

		assert.deepEqual(h.appendedEntries.at(-1), { type: "active-agent", data: { name: "chat" } });
		assert.deepEqual(h.emitted.at(-1), { name: "agents:change", payload: { name: "chat", color: undefined } });
	});

	it("switching agents applies the agent tools, persists it, and announces it", async () => {
		const h = setup({ "agents/chat.md": CHAT_MD, "agents/build.md": BUILD_MD });
		await h.handlers.session_start!({}, h.ctx);

		await h.commands.agent!.handler("build", h.ctx);

		assert.deepEqual(h.toolCalls.at(-1), ["read", "bash"]);
		assert.deepEqual(h.appendedEntries.at(-1), { type: "active-agent", data: { name: "build" } });
		assert.deepEqual(h.emitted.at(-1), { name: "agents:change", payload: { name: "build", color: undefined } });
	});

	it("an agent without model or thinking uses the settings defaults", async () => {
		const h = setup({
			"settings.json": JSON.stringify({ defaultProvider: "opencode", defaultModel: "muse", defaultThinkingLevel: "low" }),
			"agents/chat.md": CHAT_MD,
			"agents/plain.md": PLAIN_MD,
		});
		await h.handlers.session_start!({}, h.ctx);

		await h.commands.agent!.handler("plain", h.ctx);

		assert.deepEqual(h.modelLookups.at(-1), ["opencode", "muse"]);
		assert.equal(h.thinkingLevels.at(-1), "low");
	});

	it("picker rows show model and thinking", async () => {
		const h = setup({
			"settings.json": JSON.stringify({ defaultProvider: "opencode", defaultModel: "muse", defaultThinkingLevel: "low" }),
			"agents/chat.md": CHAT_MD,
			"agents/build.md": BUILD_MD,
		});
		await h.handlers.session_start!({}, h.ctx);

		await h.commands.agent!.handler("", h.ctx);

		const lines = h.picker!.render(120);
		const buildLine = lines.find((line) => line.includes("build"));
		const chatLine = lines.find((line) => line.includes("chat"));
		assert.ok(buildLine?.includes("opencode/build-model · medium"));
		assert.ok(chatLine?.includes("opencode/muse · high"));
	});
});

describe("project config (.pi/agents.json)", () => {
	const PROJECT_BUILD_TOOL = JSON.stringify({ build: { tools: ["fetch_content"] } });

	it("a trusted project config adds a tool to build", async () => {
		const h = setup({ "agents/chat.md": CHAT_MD, "agents/build.md": BUILD_MD }, {
			trusted: true,
			project: { ".pi/agents.json": PROJECT_BUILD_TOOL },
		});
		await start(h);

		await switchTo(h, "build");

		assert.deepEqual(h.toolCalls.at(-1), ["read", "bash", "fetch_content"]);
	});

	it("an untrusted project config is ignored", async () => {
		const h = setup({ "agents/chat.md": CHAT_MD, "agents/build.md": BUILD_MD }, {
			trusted: false,
			project: { ".pi/agents.json": PROJECT_BUILD_TOOL },
		});
		await start(h);

		await switchTo(h, "build");

		assert.deepEqual(h.toolCalls.at(-1), ["read", "bash"]);
	});

	it("warns once for each config name that is not a known agent", async () => {
		const h = setup({ "agents/chat.md": CHAT_MD, "agents/build.md": BUILD_MD }, {
			trusted: true,
			project: { ".pi/agents.json": JSON.stringify({ ghost: { tools: ["fetch_content"] } }) },
		});

		await start(h);

		const warnings = h.notices.filter((notice) => notice.level === "warning" && notice.message.includes("ghost"));
		assert.equal(warnings.length, 1);
	});

	it("invalid JSON warns once and is treated as an empty config", async () => {
		const h = setup({ "agents/chat.md": CHAT_MD, "agents/build.md": BUILD_MD }, {
			trusted: true,
			project: { ".pi/agents.json": "{ not json" },
		});

		await start(h);
		await switchTo(h, "build");

		assert.equal(h.notices.filter((notice) => notice.level === "warning").length, 1);
		assert.deepEqual(h.toolCalls.at(-1), ["read", "bash"]);
	});
});

describe("before_agent_start", () => {
	it("keeps the current project tools and adds registered project tools that are missing, in effective order", async () => {
		const h = setup({ "agents/chat.md": CHAT_MD, "agents/build.md": BUILD_MD }, {
			trusted: true,
			project: { ".pi/agents.json": JSON.stringify({ build: { tools: ["fetch_content"] } }) },
		});
		await start(h);
		await switchTo(h, "build");

		const options = await startRun(h, ["bash", "edit"]);

		assert.deepEqual(options.selectedTools, ["bash", "fetch_content"]);
	});

	it("includes the project skills in the skill filter", async () => {
		const h = setup({ "agents/chat.md": CHAT_MD, "agents/review.md": REVIEW_MD }, {
			trusted: true,
			project: { ".pi/agents.json": JSON.stringify({ review: { skills: ["extra"] } }) },
		});
		await start(h);
		await switchTo(h, "review");

		const options = await startRun(h, [], ["guide", "extra", "other"]);

		assert.deepEqual(options.skills.map((skill: { name: string }) => skill.name), ["guide", "extra"]);
	});
});

describe("invocation tool grants", () => {
	it("a raw /template with tools grants them to the active agent and persists an agent-grants entry", async () => {
		const h = grantHarness();
		await start(h);
		await switchTo(h, "build");
		assert.equal(h.activeTools.includes("ask_user"), false);

		await submit(h, "/gh-create-pr fix the login bug");

		assert.equal(h.activeTools.includes("ask_user"), true);
		assert.deepEqual(grantEntries(h).at(-1), { type: "agent-grants", data: { tools: ["ask_user"], source: "gh-create-pr" } });
	});

	it("a grant for tools that are already active persists nothing", async () => {
		const h = grantHarness();
		await start(h);

		await submit(h, "/gh-create-pr fix the login bug");

		assert.deepEqual(grantEntries(h), []);
	});

	it("a leading /skill: grants the skill's pi-tools", async () => {
		const h = grantHarness();
		await start(h);
		await switchTo(h, "build");

		await submit(h, "/skill:review check this");

		assert.deepEqual(grantEntries(h).at(-1)?.data.tools, ["fetch_content"]);
	});

	it("skill-refs:expanded grants the skills' pi-tools, and the next before_agent_start includes them", async () => {
		const h = grantHarness();
		await start(h);
		await switchTo(h, "build");

		h.pi.events.emit("skill-refs:expanded", { skills: [{ name: "review", path: path.join(h.dir, REVIEW_SKILL_REL) }] });
		const options = await startRun(h, ["read"]);

		assert.deepEqual(options.selectedTools, ["read", "fetch_content"]);
	});

	it("skill-refs:expanded grants a disable-model-invocation skill too, because manual use is always allowed", async () => {
		const h = grantHarness();
		await start(h);
		await switchTo(h, "build");

		h.pi.events.emit("skill-refs:expanded", { skills: [{ name: "hidden", path: path.join(h.dir, HIDDEN_SKILL_REL) }] });

		assert.deepEqual(grantEntries(h).at(-1)?.data.tools, ["fetch_content"]);
	});

	it("an invocation seen by both input and the event grants once when input comes first", async () => {
		const h = grantHarness();
		await start(h);
		await switchTo(h, "build");

		await submit(h, "/skill:review check this");
		h.pi.events.emit("skill-refs:expanded", { skills: [{ name: "review", path: path.join(h.dir, REVIEW_SKILL_REL) }] });
		await startRun(h, ["read"]);

		assert.equal(grantEntries(h).length, 1);
	});

	it("an invocation seen by both input and the event grants once when the event comes first", async () => {
		const h = grantHarness();
		await start(h);
		await switchTo(h, "build");

		h.pi.events.emit("skill-refs:expanded", { skills: [{ name: "review", path: path.join(h.dir, REVIEW_SKILL_REL) }] });
		await submit(h, "/skill:review check this");
		await startRun(h, ["read"]);

		assert.equal(grantEntries(h).length, 1);
	});

	it("a model read of an advertised skill grants its pi-tools", async () => {
		const h = grantHarness();
		await start(h);
		await switchTo(h, "build");

		await h.handlers.tool_result!(
			{ type: "tool_result", toolName: "read", toolCallId: "1", input: { path: path.join(h.dir, REVIEW_SKILL_REL) }, content: [], isError: false },
			h.ctx,
		);

		assert.deepEqual(grantEntries(h).at(-1)?.data.tools, ["fetch_content"]);
	});

	it("a model read of a disable-model-invocation skill grants nothing", async () => {
		const h = grantHarness();
		await start(h);
		await switchTo(h, "build");

		await h.handlers.tool_result!(
			{ type: "tool_result", toolName: "read", toolCallId: "2", input: { path: path.join(h.dir, HIDDEN_SKILL_REL) }, content: [], isError: false },
			h.ctx,
		);

		assert.deepEqual(grantEntries(h), []);
	});

	it("a model read of a skill that is not on the agent's skill list grants nothing", async () => {
		const h = grantHarness();
		await start(h);
		await switchTo(h, "review");

		await h.handlers.tool_result!(
			{ type: "tool_result", toolName: "read", toolCallId: "3", input: { path: path.join(h.dir, REVIEW_SKILL_REL) }, content: [], isError: false },
			h.ctx,
		);

		assert.deepEqual(grantEntries(h), []);
	});

	it("grants survive an agent switch", async () => {
		const h = grantHarness();
		await start(h);
		await switchTo(h, "build");
		await submit(h, "/gh-create-pr fix the login bug");

		await switchTo(h, "plain");

		assert.deepEqual(h.toolCalls.at(-1), ["read", "ask_user"]);
	});

	it("resuming replays the grants on the branch before the agent is adopted", async () => {
		const h = grantHarness({
			branch: [
				{ type: "custom", customType: "agent-grants", data: { tools: ["ask_user"], source: "gh-create-pr" } },
				{ type: "custom", customType: "active-agent", data: { name: "build" } },
			],
		});

		await start(h);

		assert.deepEqual(h.toolCalls.at(-1), ["read", "bash", "ask_user"]);
	});

	it("branch navigation replays the grants of the new branch", async () => {
		const h = grantHarness();
		await start(h);

		h.branch = [
			{ type: "custom", customType: "agent-grants", data: { tools: ["ask_user"], source: "gh-create-pr" } },
			{ type: "custom", customType: "active-agent", data: { name: "build" } },
		];
		await h.handlers.session_tree!({}, h.ctx);

		assert.deepEqual(h.toolCalls.at(-1), ["read", "bash", "ask_user"]);
	});
});
