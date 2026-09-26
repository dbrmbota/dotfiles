/**
 * embed — pi-free OpenRouter embeddings client with retries, plus token
 * counting for the 8,191-token content limit.
 *
 * `fetch` and `sleep` are injected so tests can pass fakes. Callers degrade
 * on typed failure instead of throwing: writes still save the row with no
 * vector, searches fall back to FTS only.
 */

/** Embedding model id sent to OpenRouter. */
export const EMBEDDING_MODEL = "openai/text-embedding-3-small";

/** Vector dimensions of `EMBEDDING_MODEL`. Stored in `meta` for mismatch checks. */
export const EMBEDDING_DIMENSIONS = 1536;

/** Maximum content tokens accepted for embedding (model input limit). */
export const MAX_EMBED_TOKENS = 8191;

/** OpenRouter embeddings endpoint. */
export const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";

/** Maximum attempts per embedding request (initial try + retries). */
export const MAX_ATTEMPTS = 3;

/** Injected fetch matching the global `fetch` signature we use. */
export type FetchFn = (
	url: string,
	init: {
		method: string;
		headers: Record<string, string>;
		body: string;
		signal?: AbortSignal;
	},
) => Promise<{
	status: number;
	headers: { get(name: string): string | null };
	json(): Promise<unknown>;
}>;

/** Injected sleeper (for backoff; faked in tests). */
export type SleepFn = (ms: number) => Promise<void>;

/** Successful embedding result. */
export type EmbedOutcome =
	| { ok: true; embeddings: number[][] }
	| { ok: false; reason: string };

/** Count cl100k_base tokens in `content` (exact tokenizer check). */
export function countTokens(content: string): number {
	// TODO: return `encode(content).length` using `encode` from `gpt-tokenizer/encoding/cl100k_base`.
	throw new Error("not implemented");
}

/** True when `content` fits within the model's token input limit. */
export function isWithinTokenLimit(content: string): boolean {
	// TODO: return `countTokens(content) <= MAX_EMBED_TOKENS`.
	throw new Error("not implemented");
}

/**
 * Embed `texts` (memory content strings) via OpenRouter, batching in one
 * request. Retries transient failures (network errors, timeouts, 408/429/5xx,
 * malformed or wrong-dimension 200 bodies) with 500ms/1500ms backoff
 * (±20% jitter, numeric `Retry-After` capped at 5s). Fails immediately on a
 * missing key, abort, or other 4xx. Returns a typed outcome; never throws
 * except on abort.
 */
export function embedTexts(
	texts: string[],
	options: { apiKey: string | undefined; signal?: AbortSignal },
	deps: { fetch: FetchFn; sleep: SleepFn },
): Promise<EmbedOutcome> {
	// TODO: missing apiKey returns `{ ok: false }` immediately (no retries). Otherwise up to MAX_ATTEMPTS: POST JSON `{ model: EMBEDDING_MODEL, input: texts }` with Bearer auth via injected fetch, each attempt under a 10s timeout combined with the caller's signal via AbortSignal.any; classify retryable (network/timeout errors, 408/429/5xx, 200 without data[i].embedding of EMBEDDING_DIMENSIONS floats) vs immediate-fail 4xx; sleep backoffDelayMs between attempts honoring numeric Retry-After (capped 5s); abort stops at once. Exhaustion returns `{ ok: false, reason }` naming the last status/cause and attempt count; never throws except on abort.
	throw new Error("not implemented");
}

/** Compute the backoff delay before attempt `attempt` (1-based retry index). */
export function backoffDelayMs(
	attempt: number,
	retryAfterMs: number | undefined,
	jitter: () => number,
): number {
	// TODO: base 500ms for attempt 1, 1500ms for attempt 2 (later attempts reuse the last entry), apply ±20% jitter via the injected `jitter`, override with numeric retryAfterMs capped at 5000ms when defined.
	throw new Error("not implemented");
}
