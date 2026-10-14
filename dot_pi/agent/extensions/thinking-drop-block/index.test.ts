import { describe, it } from "node:test";
import assert from "node:assert/strict";
import extension from "./index.ts";

const BETA = "thinking-binding-controls-2026-08-01";
const DROP_BLOCK = { prefix_mismatch_behavior: "drop_block" };

function loadHandler(): (event: { payload: unknown }, ctx: unknown) => any {
	const handlers: Record<string, (event: { payload: unknown }, ctx: unknown) => any> = {};
	extension({ on: (name: string, handler: any) => (handlers[name] = handler) } as any);
	return handlers["before_provider_request"]!;
}

const anthropicCtx = { model: { api: "anthropic-messages" } };

function adaptivePayload(model = "opencode/claude-opus-5-5"): Record<string, any> {
	return {
		model,
		max_tokens: 1024,
		messages: [{ role: "user", content: "hi" }],
		thinking: { type: "adaptive", display: "summarized" },
	};
}

describe("thinking-drop-block", () => {
	it("registers a before_provider_request handler", () => {
		assert.equal(typeof loadHandler(), "function");
	});

	it("adds block_binding and the beta to a supported adaptive request", () => {
		const handler = loadHandler();
		const result = handler({ payload: adaptivePayload() }, anthropicCtx);
		assert.deepEqual(result, {
			...adaptivePayload(),
			thinking: { type: "adaptive", display: "summarized", block_binding: DROP_BLOCK },
			betas: [BETA],
		});
	});

	it("keeps existing betas and does not duplicate the beta", () => {
		const handler = loadHandler();
		const payload = { ...adaptivePayload(), betas: ["interleaved-thinking-2025-05-14", BETA] };
		const result = handler({ payload }, anthropicCtx);
		assert.deepEqual(result.betas, ["interleaved-thinking-2025-05-14", BETA]);
		assert.deepEqual(result.thinking.block_binding, DROP_BLOCK);
	});

	it("appends the beta after existing betas", () => {
		const handler = loadHandler();
		const payload = { ...adaptivePayload(), betas: ["interleaved-thinking-2025-05-14"] };
		const result = handler({ payload }, anthropicCtx);
		assert.deepEqual(result.betas, ["interleaved-thinking-2025-05-14", BETA]);
	});

	it("accepts thinking type enabled", () => {
		const handler = loadHandler();
		const payload = { ...adaptivePayload("claude-opus-5"), thinking: { type: "enabled", budget_tokens: 2048 } };
		const result = handler({ payload }, anthropicCtx);
		assert.deepEqual(result.thinking, { type: "enabled", budget_tokens: 2048, block_binding: DROP_BLOCK });
	});

	it("does not mutate the input payload", () => {
		const handler = loadHandler();
		const payload = adaptivePayload();
		const snapshot = structuredClone(payload);
		handler({ payload }, anthropicCtx);
		assert.deepEqual(payload, snapshot);
	});

	for (const model of [
		"opencode/claude-opus-5-5",
		"opencode/claude-haiku-5-5",
		"opencode-go/claude-haiku-5-5",
		"claude-opus-4.7",
		"claude-opus-4-8",
		"claude-sonnet-5",
		"claude-fable-5",
	]) {
		it(`applies to supported model ${model}`, () => {
			const handler = loadHandler();
			const result = handler({ payload: adaptivePayload(model) }, anthropicCtx);
			assert.deepEqual(result.thinking.block_binding, DROP_BLOCK);
		});
	}

	for (const model of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-5", "gpt-5.1"]) {
		it(`leaves unsupported model ${model} untouched`, () => {
			const handler = loadHandler();
			assert.equal(handler({ payload: adaptivePayload(model) }, anthropicCtx), undefined);
		});
	}

	for (const [label, ctx] of [
		["a non-anthropic API", { model: { api: "openai-responses" } }],
		["no model", {}],
	] as const) {
		it(`leaves requests untouched for ${label}`, () => {
			const handler = loadHandler();
			assert.equal(handler({ payload: adaptivePayload() }, ctx), undefined);
		});
	}

	for (const [label, payload] of [
		["a null payload", null],
		["a string payload", "text"],
		["an array payload", []],
		["a payload without a model string", { ...adaptivePayload(), model: 5 }],
		["a payload without thinking", { ...adaptivePayload(), thinking: undefined }],
		["thinking that is not an object", { ...adaptivePayload(), thinking: "adaptive" }],
		["thinking of type disabled", { ...adaptivePayload(), thinking: { type: "disabled" } }],
		[
			"a block_binding that is already set",
			{ ...adaptivePayload(), thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "fail" } } },
		],
	] as const) {
		it(`leaves ${label} untouched`, () => {
			const handler = loadHandler();
			assert.equal(handler({ payload }, anthropicCtx), undefined);
		});
	}
});
