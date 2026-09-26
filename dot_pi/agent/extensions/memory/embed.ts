/**
 * embed — pi-free OpenRouter embeddings client with retries, plus token
 * counting for the 8,191-token content limit.
 *
 * `fetch` and `sleep` are injected so tests can pass fakes. Callers degrade
 * on typed failure instead of throwing: writes still save the row with no
 * vector, searches fall back to FTS only. The only throw is an aborted
 * signal, which stops retrying immediately.
 */

import { encode } from "gpt-tokenizer/encoding/cl100k_base";

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

/**
 * Per-attempt timeout in ms. Driven by the injected sleep (rather than a
 * real timer) so tests can fake it; fakes therefore also observe these
 * timeout-race sleep calls alongside backoff sleeps.
 */
export const ATTEMPT_TIMEOUT_MS = 10_000;

/** Base backoff delays in ms before retry 1 and retry 2 (±20% jitter). */
const BACKOFF_BASE_MS = [500, 1500];

/** Cap for a server-sent Retry-After delay. */
const RETRY_AFTER_CAP_MS = 5000;

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
	return encode(content).length;
}

/** True when `content` fits within the model's token input limit. */
export function isWithinTokenLimit(content: string): boolean {
	return countTokens(content) <= MAX_EMBED_TOKENS;
}

/** Compute the backoff delay before attempt `attempt` (1-based retry index). */
export function backoffDelayMs(
	attempt: number,
	retryAfterMs: number | undefined,
	jitter: () => number,
): number {
	if (retryAfterMs !== undefined) return Math.min(Math.max(0, retryAfterMs), RETRY_AFTER_CAP_MS);
	const base = BACKOFF_BASE_MS[Math.min(Math.max(1, attempt), BACKOFF_BASE_MS.length) - 1] ?? 1500;
	return base * (1 + 0.2 * jitter());
}

/** Parse a numeric Retry-After header (seconds) into ms; undefined otherwise. */
function parseRetryAfterMs(value: string | null): number | undefined {
	if (value === null || !/^\d+$/.test(value.trim())) return undefined;
	return Number(value.trim()) * 1000;
}

/** Throw when the caller's signal has fired. */
function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
	}
}

interface ValidatedResponse {
	embeddings?: number[][];
	retryableCause?: string;
	retryAfterMs?: number;
	fatal?: string;
}

/** Classify one settled attempt as usable embeddings or a failure cause. */
async function classifyAttempt(
	response: Awaited<ReturnType<FetchFn>>,
	expected: number,
): Promise<ValidatedResponse> {
	const { status } = response;
	if (status === 408 || status === 429 || status >= 500) {
		return { retryableCause: `HTTP ${status}`, retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")) };
	}
	if (status !== 200) {
		return { fatal: `HTTP ${status}` };
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch (error) {
		return { retryableCause: `unparseable 200 body: ${(error as Error).message}` };
	}
	const data = (body as { data?: unknown }).data;
	if (!Array.isArray(data) || data.length !== expected) {
		return { retryableCause: `200 body has ${Array.isArray(data) ? data.length : "no"} embeddings, expected ${expected}` };
	}
	const embeddings: number[][] = [];
	for (const item of data) {
		const embedding = (item as { embedding?: unknown }).embedding;
		if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
			return { retryableCause: `200 body has a wrong-dimension embedding, expected ${EMBEDDING_DIMENSIONS}` };
		}
		embeddings.push(embedding as number[]);
	}
	return { embeddings };
}

/**
 * Embed `texts` (memory content strings) via OpenRouter, batching in one
 * request. Retries transient failures (network errors, timeouts, 408/429/5xx,
 * malformed or wrong-dimension 200 bodies) with 500ms/1500ms backoff
 * (±20% jitter, numeric `Retry-After` capped at 5s). Fails immediately on a
 * missing key, abort, or other 4xx. Returns a typed outcome; never throws
 * except on abort.
 */
export async function embedTexts(
	texts: string[],
	options: { apiKey: string | undefined; signal?: AbortSignal },
	deps: { fetch: FetchFn; sleep: SleepFn },
): Promise<EmbedOutcome> {
	const { apiKey, signal } = options;
	const { fetch, sleep } = deps;
	if (!apiKey) return { ok: false, reason: "missing OpenRouter API key" };

	let lastCause = "unknown error";
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		throwIfAborted(signal);
		const controller = new AbortController();
		const onAbort = (): void => controller.abort(signal?.reason);
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
		try {
			const response = await Promise.race([
				fetch(OPENROUTER_EMBEDDINGS_URL, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
					signal: controller.signal,
				}),
				(async () => {
					await sleep(ATTEMPT_TIMEOUT_MS);
					throw new Error(`request timed out after ${ATTEMPT_TIMEOUT_MS}ms`);
				})(),
			]);
			const classified = await classifyAttempt(response, texts.length);
			if (classified.embeddings) return { ok: true, embeddings: classified.embeddings };
			if (classified.fatal) return { ok: false, reason: `${classified.fatal} (no retry)` };
			lastCause = classified.retryableCause ?? `HTTP ${response.status}`;
			if (attempt < MAX_ATTEMPTS) {
				await sleep(backoffDelayMs(attempt, classified.retryAfterMs, () => Math.random() * 2 - 1));
			}
		} catch (error) {
			throwIfAborted(signal);
			lastCause = (error as Error).message ?? String(error);
			if (attempt < MAX_ATTEMPTS) {
				await sleep(backoffDelayMs(attempt, undefined, () => Math.random() * 2 - 1));
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}
	return { ok: false, reason: `embedding request failed after ${MAX_ATTEMPTS} attempts: ${lastCause}` };
}
