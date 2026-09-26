import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryStore, buildFtsQuery, getDbPath, rrfFuse } from "./store.ts";
import { EMBEDDING_DIMENSIONS } from "./embed.ts";

let dbPath: string;
let store: MemoryStore;

function vector(seed: number): number[] {
	return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (((seed * 7919 + i * 13) % 100) + 1) / 100);
}

beforeEach(() => {
	dbPath = join(mkdtempSync(join(tmpdir(), "pi-memory-store-")), "test.db");
	store?.close();
	store = new MemoryStore(dbPath);
});

describe("getDbPath", () => {
	it("prefers PI_MEMORY_DB and falls back to ~/.pi/agent/memory.db", () => {
		const previous = process.env.PI_MEMORY_DB;
		try {
			process.env.PI_MEMORY_DB = "/tmp/custom.db";
			assert.equal(getDbPath(), "/tmp/custom.db");
			delete process.env.PI_MEMORY_DB;
			assert.match(getDbPath(), /\.pi\/agent\/memory\.db$/);
		} finally {
			if (previous === undefined) delete process.env.PI_MEMORY_DB;
			else process.env.PI_MEMORY_DB = previous;
		}
	});
});

describe("buildFtsQuery", () => {
	it("quotes unicode tokens and joins with OR", () => {
		assert.equal(buildFtsQuery("hello world"), '"hello" OR "world"');
		assert.equal(buildFtsQuery("déploiement 42_x"), '"déploiement" OR "42_x"');
	});

	it("returns null when there are no tokens", () => {
		assert.equal(buildFtsQuery(""), null);
		assert.equal(buildFtsQuery("!!! …"), null);
	});

	it("drops punctuation-only tokens", () => {
		assert.equal(buildFtsQuery('say "hi"'), '"say" OR "hi"');
	});
});

describe("rrfFuse", () => {
	it("fuses by Σ 1/(60 + rank) with dedupe", () => {
		const fused = rrfFuse([["a", "b"], ["c", "b"]], (item) => item);
		assert.deepEqual(fused, ["b", "a", "c"]);
	});

	it("returns an empty list for empty input", () => {
		assert.deepEqual(rrfFuse([], (item: string) => item), []);
	});
});

describe("MemoryStore projects", () => {
	it("creates the schema idempotently across reopens", () => {
		const id = store.ensureProject("git", "git:example.com/a/b", "/tmp/a");
		store.close();
		const reopened = new MemoryStore(dbPath);
		try {
			assert.equal(reopened.ensureProject("git", "git:example.com/a/b", "/tmp/a"), id);
		} finally {
			reopened.close();
		}
	});

	it("isolates memories per project", () => {
		const a = store.ensureProject("git", "git:example.com/a", "/tmp/a");
		const b = store.ensureProject("git", "git:example.com/b", "/tmp/b");
		store.upsertMemory(a, "shared-name", "Desc A", "quokka roaming", vector(1), 1000);
		store.upsertMemory(b, "shared-name", "Desc B", "quokka roaming", vector(1), 1000);
		assert.equal(store.listRecent(a, 10).length, 1);
		assert.equal(store.ftsSearch(a, "quokka", 10).length, 1);
		assert.equal(store.ftsSearch(a, "quokka", 10)[0].description, "Desc A");
		assert.deepEqual(store.vectorSearch(a, vector(1), 10).map((row) => row.description), ["Desc A"]);
		assert.equal(store.getMemory(b, "shared-name")?.description, "Desc B");
	});

	it("reports created vs overwrite on name reuse", () => {
		const project = store.ensureProject("path", "path:/tmp/a", "/tmp/a");
		assert.equal(store.upsertMemory(project, "n", "d1", "c1", null, 1000).created, true);
		const again = store.upsertMemory(project, "n", "d2", "c2", null, 2000);
		assert.equal(again.created, false);
		assert.equal(store.getMemory(project, "n")?.description, "d2");
	});
});

describe("MemoryStore vectors", () => {
	it("updates FTS and the vector on overwrite", () => {
		const project = store.ensureProject("git", "git:example.com/a", "/tmp/a");
		store.upsertMemory(project, "n", "d", "alpha quokka", vector(1), 1000);
		store.upsertMemory(project, "n", "d", "beta wombat", vector(2), 2000);
		assert.equal(store.ftsSearch(project, "quokka", 10).length, 0);
		assert.equal(store.ftsSearch(project, "wombat", 10).length, 1);
		assert.equal(store.vectorSearch(project, vector(2), 10).length, 1);
	});

	it("keeps the vector on a description-only update", () => {
		const project = store.ensureProject("git", "git:example.com/a", "/tmp/a");
		store.upsertMemory(project, "n", "old desc", "stable content", vector(1), 1000);
		store.upsertMemory(project, "n", "new desc", "stable content", null, 2000);
		assert.equal(store.getMemory(project, "n")?.description, "new desc");
		assert.equal(store.vectorSearch(project, vector(1), 10).length, 1);
		assert.equal(store.getUnembedded(project, 10).length, 0);
	});

	it("queues new vector-less rows for backfill", () => {
		const project = store.ensureProject("git", "git:example.com/a", "/tmp/a");
		store.upsertMemory(project, "pending", "d", "no vector yet", null, 1000);
		assert.deepEqual(store.getUnembedded(project, 10).map((row) => row.name), ["pending"]);
		const row = store.getMemory(project, "pending");
		assert.ok(row);
		store.setVector(row.id, project, vector(3));
		assert.equal(store.getUnembedded(project, 10).length, 0);
	});

	it("removes the row from all three tables on delete", () => {
		const project = store.ensureProject("git", "git:example.com/a", "/tmp/a");
		store.upsertMemory(project, "n", "d", "quokka content", vector(1), 1000);
		assert.equal(store.deleteMemory(project, "n"), true);
		assert.equal(store.deleteMemory(project, "n"), false);
		assert.equal(store.getMemory(project, "n"), undefined);
		assert.equal(store.ftsSearch(project, "quokka", 10).length, 0);
		assert.equal(store.vectorSearch(project, vector(1), 10).length, 0);
		assert.equal(store.getUnembedded(project, 10).length, 0);
	});
});

describe("MemoryStore recency", () => {
	it("bumps on read but not on list or find", () => {
		const project = store.ensureProject("git", "git:example.com/a", "/tmp/a");
		store.upsertMemory(project, "n", "d", "quokka content", vector(1), 1000);
		const before = store.getMemory(project, "n");
		assert.ok(before);
		assert.equal(before.lastUsedAt, 1000);

		store.listRecent(project, 10);
		store.ftsSearch(project, "quokka", 10);
		store.vectorSearch(project, vector(1), 10);
		assert.equal(store.getMemory(project, "n")?.lastUsedAt, 1000);

		const read = store.readMemory(project, "n", 2000);
		assert.equal(read?.lastUsedAt, 2000);
		assert.equal(read?.accessedAt, 2000);
		assert.equal(read?.updatedAt, 1000);
	});

	it("bumps updated_at and recency on write", () => {
		const project = store.ensureProject("git", "git:example.com/a", "/tmp/a");
		store.upsertMemory(project, "n", "d1", "c1", null, 1000);
		store.upsertMemory(project, "n", "d2", "c2", null, 2000);
		const row = store.getMemory(project, "n");
		assert.equal(row?.updatedAt, 2000);
		assert.equal(row?.lastUsedAt, 2000);
	});
});

describe("MemoryStore search ranking", () => {
	it("ranks name and description matches above content matches", () => {
		const project = store.ensureProject("git", "git:example.com/a", "/tmp/a");
		store.upsertMemory(project, "filler", " filler words", "quokka grazing at daylight", null, 1000);
		store.upsertMemory(project, "quokka-notes", "other words", "unrelated filler text here", null, 1000);
		const hits = store.ftsSearch(project, "quokka", 10);
		assert.deepEqual(hits.map((hit) => hit.name), ["quokka-notes", "filler"]);
	});
});

describe("MemoryStore model mismatch", () => {
	it("falls back to FTS-only with a reset warning", () => {
		const project = store.ensureProject("git", "git:example.com/a", "/tmp/a");
		store.upsertMemory(project, "n", "d", "quokka content", vector(1), 1000);
		store.close();

		const raw = new DatabaseSync(dbPath);
		raw.exec("UPDATE meta SET value = 'other-model' WHERE key = 'embedding_model'");
		raw.close();

		const mismatched = new MemoryStore(dbPath);
		try {
			assert.equal(mismatched.vectorsAvailable, false);
			assert.match(mismatched.vectorWarning ?? "", /reset/i);
			mismatched.upsertMemory(project, "m", "d", "quokka second", vector(2), 2000);
			assert.equal(mismatched.ftsSearch(project, "quokka", 10).length, 2);
			assert.equal(mismatched.vectorSearch(project, vector(1), 10).length, 0);
		} finally {
			mismatched.close();
		}
	});
});
