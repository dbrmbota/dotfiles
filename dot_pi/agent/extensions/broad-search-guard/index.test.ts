import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerBroadSearchGuard } from "./index.ts";
import { loadBashParser, type ParseFn } from "./parser.ts";

type Handler = (event: any, ctx: any) => any;

const HOME = "/Users/u";

function loadHandlers(loadParser: () => Promise<ParseFn>): Record<string, Handler> {
	const handlers: Record<string, Handler> = {};
	const pi = { on: (name: string, handler: Handler) => (handlers[name] = handler) };
	registerBroadSearchGuard(pi as any, { loadParser, home: HOME });
	return handlers;
}

function bashEvent(command: unknown): Record<string, unknown> {
	return { toolName: "bash", input: { command } };
}

function makeCtx(hasUI: boolean, notifications: unknown[][] = []): Record<string, unknown> {
	return {
		cwd: "/Users/u/proj",
		hasUI,
		ui: { notify: (...args: unknown[]) => notifications.push(args) },
	};
}

describe("broad-search-guard tool_call hook", () => {
	it("ignores tool calls that are not bash", async () => {
		const handler = loadHandlers(loadBashParser).tool_call!;
		const event = { toolName: "read", input: { command: "find / -name x" } };
		assert.equal(await handler(event, makeCtx(true)), undefined);
	});

	it("blocks a broad search with the segment, root, and cwd in the reason", async () => {
		const handler = loadHandlers(loadBashParser).tool_call!;
		const result = await handler(bashEvent("find / -name foo"), makeCtx(true));
		assert.equal(result.block, true);
		assert.equal("terminate" in result, false);
		assert.ok(result.reason.includes("find / -name foo"), result.reason);
		assert.ok(result.reason.includes("`/`"), result.reason);
		assert.ok(result.reason.includes("/Users/u/proj"), result.reason);
	});

	it("allows a narrow search", async () => {
		const handler = loadHandlers(loadBashParser).tool_call!;
		assert.equal(await handler(bashEvent("find . -name foo"), makeCtx(true)), undefined);
	});

	it("fails open with one warning per session when the parser cannot load", async () => {
		const handler = loadHandlers(() => Promise.reject(new Error("no parser"))).tool_call!;
		const notifications: unknown[][] = [];
		const ctx = makeCtx(true, notifications);
		assert.equal(await handler(bashEvent("find / -name foo"), ctx), undefined);
		assert.equal(await handler(bashEvent("find / -name foo"), ctx), undefined);
		assert.equal(notifications.length, 1);
	});

	it("fails open without a warning when the parser cannot load and there is no UI", async () => {
		const handler = loadHandlers(() => Promise.reject(new Error("no parser"))).tool_call!;
		const notifications: unknown[][] = [];
		const ctx = makeCtx(false, notifications);
		assert.equal(await handler(bashEvent("find / -name foo"), ctx), undefined);
		assert.equal(await handler(bashEvent("find / -name foo"), ctx), undefined);
		assert.equal(notifications.length, 0);
	});

	it("fails open when the analyzer throws on a non-string command", async () => {
		const handler = loadHandlers(loadBashParser).tool_call!;
		assert.equal(await handler(bashEvent(42), makeCtx(true)), undefined);
	});
});
