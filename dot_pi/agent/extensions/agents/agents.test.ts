import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import agentsExtension, { expandAgentVars } from "./agents.ts";

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

interface Harness {
	pi: any;
	ctx: any;
	handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>>;
	commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	toolCalls: string[][];
	thinkingLevels: string[];
	modelLookups: [string, string][];
	appendedEntries: { type: string; data: unknown }[];
	emitted: { name: string; payload: unknown }[];
	picker: { render(width: number): string[] } | undefined;
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

/** Writes an agent directory with the given files and returns fake pi/ctx objects that record calls. */
function setup(files: Record<string, string>): Harness {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-test-"));
	tempDirs.push(agentDir);
	for (const [rel, content] of Object.entries(files)) {
		const file = path.join(agentDir, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const h: Harness = {
		pi: undefined,
		ctx: undefined,
		handlers: {},
		commands: {},
		toolCalls: [],
		thinkingLevels: [],
		modelLookups: [],
		appendedEntries: [],
		emitted: [],
		picker: undefined,
	};

	const tools = ["read", "bash", "edit", "write", "ask_user", "fetch_content"];
	h.pi = {
		events: {
			on() {},
			emit(name: string, payload: unknown) {
				h.emitted.push({ name, payload });
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
			tools.map((name) => ({ name, sourceInfo: { source: name === "ask_user" ? "extension" : "builtin" } })),
		setActiveTools(names: string[]) {
			h.toolCalls.push(names);
		},
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
		cwd: agentDir,
		hasUI: true,
		isProjectTrusted: () => false,
		ui: {
			notify() {},
			custom: async (factory: (...args: unknown[]) => { render(width: number): string[] }) => {
				h.picker = factory(tui, theme, keys, () => {});
				return null;
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
		sessionManager: { getBranch: () => [] },
	};

	agentsExtension(h.pi);
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

describe("expandAgentVars", () => {
	it("replaces bare and braced names that are set", () => {
		const vars = new Map([["NAME", "x"]]);
		assert.equal(expandAgentVars("a $NAME and ${NAME}", vars), "a x and x");
	});

	it("uses the fallback of ${NAME:-default} only when the name is unset", () => {
		assert.equal(expandAgentVars("${MODE:-default}", new Map()), "default");
		assert.equal(expandAgentVars("${MODE:-default}", new Map([["MODE", "read-only"]])), "read-only");
	});

	it("leaves unknown names literal and does not expand substituted values again", () => {
		assert.equal(expandAgentVars("$OTHER", new Map()), "$OTHER");
		assert.equal(expandAgentVars("$NAME", new Map([["NAME", "$OTHER"], ["OTHER", "y"]])), "$OTHER");
	});
});
