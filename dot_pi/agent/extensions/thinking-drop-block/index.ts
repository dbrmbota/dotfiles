// Ask Anthropic to drop stale thinking blocks instead of rejecting the request.
//
// A signed thinking block is only valid while the request prefix (system
// prompt, tools, earlier messages) matches the one it was signed under. pi
// rebuilds the leading system text when permission state or the sandbox
// allowlist changes, and the next request then fails with a 400 "Invalid
// signature in thinking block". With block_binding set to drop_block, the
// API discards the mismatched block and answers normally, at the cost of the
// dropped reasoning and one cache miss.
//
// pi-ai only sets this for models in supportsThinkingBlockBinding. Older
// models reject the field, so this extension mirrors that model list and
// leaves every other request untouched. The beta flag goes into the payload's
// betas array, because pi-ai turns that array into the anthropic-beta header
// and a configured header would replace pi's own betas.

import type {
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const BLOCK_BINDING_BETA = "thinking-binding-controls-2026-08-01";
const BLOCK_BINDING_MODEL_MARKERS = ["opus-4-7", "opus-4-8", "opus-5", "sonnet-5", "haiku-5", "fable-5"];

function supportsBlockBinding(modelId: string): boolean {
	const normalized = modelId.toLowerCase().replace(/\./g, "-");
	return BLOCK_BINDING_MODEL_MARKERS.some((marker) => normalized.includes(marker));
}

function withDropBlock(payload: Record<string, unknown>): Record<string, unknown> {
	const thinking = typeof payload.thinking === "object" && payload.thinking !== null ? payload.thinking : {};
	const existingBetas = Array.isArray(payload.betas) ? payload.betas : [];
	return {
		...payload,
		thinking: { ...thinking, block_binding: { prefix_mismatch_behavior: "drop_block" } },
		betas: [...new Set([...existingBetas, BLOCK_BINDING_BETA])],
	};
}

function onBeforeProviderRequest(
	event: BeforeProviderRequestEvent,
	ctx: ExtensionContext,
): BeforeProviderRequestEventResult {
	if (ctx.model?.api !== "anthropic-messages") return undefined;
	const payload = event.payload as Record<string, unknown> | null | undefined;
	if (typeof payload?.model !== "string") return undefined;
	const thinking = payload.thinking as Record<string, unknown> | null | undefined;
	if (thinking?.type !== "adaptive" && thinking?.type !== "enabled") return undefined;
	if (thinking?.block_binding !== undefined) return undefined;
	if (!supportsBlockBinding(payload.model)) return undefined;
	return withDropBlock(payload);
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", onBeforeProviderRequest);
}
