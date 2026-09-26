import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	ATTEMPT_TIMEOUT_MS,
	EMBEDDING_DIMENSIONS,
	MAX_EMBED_TOKENS,
	backoffDelayMs,
	countTokens,
	embedTexts,
	isWithinTokenLimit,
	type FetchFn,
	type SleepFn,
} from "./embed.ts";

function vector(dim: number): number[] {
	return Array.from({ length: dim }, (_, i) => (i + 1) / dim);
}

type FetchResult = Awaited<ReturnType<FetchFn>>;

function jsonResponse(status: number, body: unknown, retryAfter?: string): FetchResult {
	return {
		status,
		headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null) },
		json: async () => body,
	};
}

/** Backoff sleeps only (excludes the per-attempt timeout-race sleep calls). */
function backoffs(sleeps: number[]): number[] {
	return sleeps.filter((ms) => ms !== ATTEMPT_TIMEOUT_MS);
}

function okBody(embeddings: number[][]): unknown {
	return { data: embeddings.map((embedding) => ({ embedding })) };
}

function makeDeps(
	handler: (call: number) => FetchResult | Error | Promise<never>,
	sleep?: SleepFn,
): { fetch: FetchFn; calls: { count: number }; sleeps: number[]; sleepFn: SleepFn } {
	const calls = { count: 0 };
	const sleeps: number[] = [];
	const sleepFn: SleepFn = sleep ?? (async (ms: number) => {
		sleeps.push(ms);
	});
	const fetch: FetchFn = async () => {
		calls.count += 1;
		const result = await handler(calls.count);
		if (result instanceof Error) throw result;
		return result;
	};
	return { fetch, calls, sleeps, sleepFn };
}

describe("countTokens", () => {
	it("matches known cl100k_base counts", () => {
		assert.equal(countTokens(""), 0);
		assert.equal(countTokens("hello"), 1);
		assert.equal(countTokens("hello world"), 2);
	});

	it("is exact at the 8191 boundary", () => {
		const atLimit = "hello" + " hello".repeat(MAX_EMBED_TOKENS - 1);
		assert.equal(countTokens(atLimit), 8191);
		assert.equal(isWithinTokenLimit(atLimit), true);
		assert.equal(isWithinTokenLimit(`${atLimit} hello`), false);
	});
});

describe("embedTexts", () => {
	it("returns embeddings on the first try", async () => {
		const { fetch, calls, sleepFn } = makeDeps(() => jsonResponse(200, okBody([vector(EMBEDDING_DIMENSIONS)])));
		const outcome = await embedTexts(["content"], { apiKey: "key" }, { fetch, sleep: sleepFn });
		assert.equal(outcome.ok, true);
		assert.equal(calls.count, 1);
		if (outcome.ok) assert.equal(outcome.embeddings[0].length, EMBEDDING_DIMENSIONS);
	});

	it("retries 429, 500, timeouts, and malformed bodies, then succeeds", async () => {
		const cases: Array<{ name: string; bad: FetchResult | Error }> = [
			{ name: "429", bad: jsonResponse(429, {}) },
			{ name: "500", bad: jsonResponse(500, {}) },
			{ name: "timeout", bad: new Error("timeout") },
			{ name: "malformed", bad: jsonResponse(200, { nonsense: true }) },
			{ name: "wrong-dimension", bad: jsonResponse(200, okBody([vector(3)])) },
		];
		for (const { name, bad } of cases) {
			const { fetch, calls, sleeps, sleepFn } = makeDeps((call) =>
				call === 1 ? bad : jsonResponse(200, okBody([vector(EMBEDDING_DIMENSIONS)])),
			);
			const outcome = await embedTexts(["content"], { apiKey: "key" }, { fetch, sleep: sleepFn });
			assert.equal(outcome.ok, true, name);
			assert.equal(calls.count, 2, name);
			const retrySleeps = backoffs(sleeps);
			assert.equal(retrySleeps.length, 1, name);
			assert.ok(retrySleeps[0] >= 400 && retrySleeps[0] <= 600, `${name}: ${retrySleeps[0]}`);
		}
	});

	it("does not retry 400, 401, or 402", async () => {
		for (const status of [400, 401, 402]) {
			const { fetch, calls, sleeps, sleepFn } = makeDeps(() => jsonResponse(status, { error: "bad" }));
			const outcome = await embedTexts(["content"], { apiKey: "key" }, { fetch, sleep: sleepFn });
			assert.equal(outcome.ok, false, String(status));
			assert.equal(calls.count, 1, String(status));
			assert.equal(backoffs(sleeps).length, 0, String(status));
		}
	});

	it("fails without retries when the key is missing", async () => {
		const { fetch, calls, sleepFn } = makeDeps(() => jsonResponse(200, okBody([vector(EMBEDDING_DIMENSIONS)])));
		const outcome = await embedTexts(["content"], { apiKey: undefined }, { fetch, sleep: sleepFn });
		assert.equal(outcome.ok, false);
		assert.equal(calls.count, 0);
	});

	it("honors Retry-After and caps it at 5s", async () => {
		const { fetch, sleepFn, sleeps } = makeDeps((call) =>
			call === 1
				? jsonResponse(429, {}, "1")
				: jsonResponse(200, okBody([vector(EMBEDDING_DIMENSIONS)])),
		);
		await embedTexts(["content"], { apiKey: "key" }, { fetch, sleep: sleepFn });
		assert.deepEqual(backoffs(sleeps), [1000]);

		const capped = makeDeps((call) =>
			call === 1
				? jsonResponse(429, {}, "30")
				: jsonResponse(200, okBody([vector(EMBEDDING_DIMENSIONS)])),
		);
		await embedTexts(["content"], { apiKey: "key" }, { fetch: capped.fetch, sleep: capped.sleepFn });
		assert.deepEqual(backoffs(capped.sleeps), [5000]);
	});

	it("gives up after 3 attempts naming the last cause", async () => {
		const { fetch, calls, sleeps, sleepFn } = makeDeps(() => jsonResponse(500, {}));
		const outcome = await embedTexts(["content"], { apiKey: "key" }, { fetch, sleep: sleepFn });
		assert.equal(outcome.ok, false);
		assert.equal(calls.count, 3);
		const giveUpSleeps = backoffs(sleeps);
		assert.equal(giveUpSleeps.length, 2);
		assert.ok(giveUpSleeps[0] >= 400 && giveUpSleeps[0] <= 600, `first: ${giveUpSleeps[0]}`);
		assert.ok(giveUpSleeps[1] >= 1200 && giveUpSleeps[1] <= 1800, `second: ${giveUpSleeps[1]}`);
		if (!outcome.ok) assert.match(outcome.reason, /3 attempts/);
	});

	it("treats a hanging fetch as a per-attempt timeout", async () => {
		const { fetch, calls, sleepFn } = makeDeps(() => new Promise<never>(() => {}) as Promise<never>);
		const outcome = await embedTexts(["content"], { apiKey: "key" }, { fetch, sleep: sleepFn });
		assert.equal(outcome.ok, false);
		assert.equal(calls.count, 3);
	});

	it("stops retrying when aborted", async () => {
		const controller = new AbortController();
		const { fetch, calls } = makeDeps(() => jsonResponse(500, {}), async () => {
			controller.abort();
		});
		await assert.rejects(embedTexts(["content"], { apiKey: "key", signal: controller.signal }, {
			fetch,
			sleep: async () => {
				controller.abort();
			},
		}));
		assert.equal(calls.count, 1);
	});

	it("throws immediately on a pre-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const { fetch, calls, sleepFn } = makeDeps(() => jsonResponse(200, okBody([vector(EMBEDDING_DIMENSIONS)])));
		await assert.rejects(
			embedTexts(["content"], { apiKey: "key", signal: controller.signal }, { fetch, sleep: sleepFn }),
		);
		assert.equal(calls.count, 0);
	});
});

describe("backoffDelayMs", () => {
	it("uses 500ms then 1500ms with no jitter", () => {
		assert.equal(backoffDelayMs(1, undefined, () => 0), 500);
		assert.equal(backoffDelayMs(2, undefined, () => 0), 1500);
	});

	it("applies ±20% jitter", () => {
		assert.equal(backoffDelayMs(1, undefined, () => 1), 600);
		assert.equal(backoffDelayMs(1, undefined, () => -1), 400);
	});

	it("lets a numeric Retry-After override, capped at 5s", () => {
		assert.equal(backoffDelayMs(1, 2000, () => 0), 2000);
		assert.equal(backoffDelayMs(1, 30_000, () => 0), 5000);
	});
});
