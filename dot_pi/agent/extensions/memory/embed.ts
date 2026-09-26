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
	throw new Error("not implemented");
}

/** True when `content` fits within the model's token input limit. */
export function isWithinTokenLimit(content: string): boolean {
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
	throw new Error("not implemented");
}

/** Compute the backoff delay before attempt `attempt` (1-based retry index). */
export function backoffDelayMs(
	attempt: number,
	retryAfterMs: number | undefined,
	jitter: () => number,
): number {
	throw new Error("not implemented");
}
