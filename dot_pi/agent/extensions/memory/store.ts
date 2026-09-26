/**
 * store — SQLite storage for project-scoped memories.
 *
 * One DB (`$PI_MEMORY_DB`, else `~/.pi/agent/memory.db`) holds all projects.
 * Keyword search uses FTS5 (`memories_fts`, porter stemming, name weighted
 * above description above content via bm25); semantic search uses a
 * `sqlite-vec` vec0 table partitioned by project. Only this module touches
 * the database; it never imports pi packages.
 *
 * Recency rules: writes/edits set `updated_at = last_used_at = now`,
 * `memory_read` sets `accessed_at = last_used_at = now`; listing, find, and
 * delete never bump. Re-embedding happens only when `content` changes.
 *
 * Vector conventions: `upsertMemory` with a non-null embedding stores the
 * vector (and marks `embedding_model`); a null embedding leaves an existing
 * row's vector untouched (description-only path) and leaves a new row
 * pending backfill (`embedding_model IS NULL`). Clearing a stale vector
 * goes through `setVector(id, projectId, null)`.
 */

import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import { homedir } from "node:os";
import { join } from "node:path";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "./embed.ts";

/** Schema version stored in `meta`. */
export const SCHEMA_VERSION = 1;

/** Full memory row as returned by reads. */
export interface MemoryRecord {
	id: number;
	projectId: number;
	name: string;
	description: string;
	content: string;
	createdAt: number;
	updatedAt: number;
	accessedAt: number | null;
	lastUsedAt: number;
	embeddingModel: string | null;
}

/** One search hit (list + find output). */
export interface SearchHit {
	name: string;
	description: string;
	updatedAt: number;
}

/** Resolve the DB path: `$PI_MEMORY_DB`, else `~/.pi/agent/memory.db`. */
export function getDbPath(): string {
	const env = process.env.PI_MEMORY_DB;
	if (env && env.trim() !== "") return env;
	return join(homedir(), ".pi", "agent", "memory.db");
}

/**
 * Tokenize a find query into a quoted FTS5 `OR` expression
 * (`/[\p{L}\p{N}_]+/gu` tokens). Returns null when the query has no tokens.
 */
export function buildFtsQuery(query: string): string | null {
	const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
	if (tokens.length === 0) return null;
	return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
}

/**
 * Fuse ranked candidate lists with reciprocal rank fusion:
 * `score = Σ 1/(60 + rank)`. Order of the returned items is fused best
 * first; items are deduplicated by `getKey`.
 */
export function rrfFuse<T>(lists: T[][], getKey: (item: T) => string): T[] {
	const scores = new Map<string, { item: T; score: number; order: number }>();
	let order = 0;
	for (const list of lists) {
		list.forEach((item, rank) => {
			const key = getKey(item);
			const existing = scores.get(key);
			const gain = 1 / (60 + rank);
			if (existing) existing.score += gain;
			else scores.set(key, { item, score: gain, order: order++ });
		});
	}
	return [...scores.values()]
		.sort((a, b) => b.score - a.score || a.order - b.order)
		.map((entry) => entry.item);
}

/** Raw memories row as stored (snake_case columns). */
interface MemoryRow {
	id: number;
	project_id: number;
	name: string;
	description: string;
	content: string;
	created_at: number;
	updated_at: number;
	accessed_at: number | null;
	last_used_at: number;
	embedding_model: string | null;
}

/** Columns selected by every read (kept in one place for mapping). */
const MEMORY_COLUMNS = "id, project_id, name, description, content, created_at, updated_at, accessed_at, last_used_at, embedding_model";

/**
 * Project-scoped memory store. Opened lazily on first use (`node:sqlite`
 * with `allowExtension` + `sqlite-vec`); `close()` is idempotent and called
 * from `session_shutdown`.
 */
export class MemoryStore {
	private dbPath: string;
	private db: DatabaseSync | null = null;
	private vectorsOk: boolean = true;
	private cachedWarning: string | undefined = undefined;

	constructor(dbPath?: string) {
		this.dbPath = dbPath ?? getDbPath();
	}

	/** True when the DB embedding model/dimensions match this code's constants. */
	get vectorsAvailable(): boolean {
		this.ensureOpen();
		return this.vectorsOk;
	}

	/** One-time FTS-only warning when the stored model/dimensions mismatch. */
	get vectorWarning(): string | undefined {
		this.ensureOpen();
		return this.vectorsOk ? undefined : this.cachedWarning;
	}

	/** Idempotently close the database. */
	close(): void {
		this.db?.close();
		this.db = null;
	}

	/** Open the DB on first use: extension, pragmas, schema, mismatch check. */
	private ensureOpen(): DatabaseSync {
		if (this.db) return this.db;
		const db = new DatabaseSync(this.dbPath, { allowExtension: true });
		sqliteVec.load(db);
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA foreign_keys = ON");
		db.exec("PRAGMA busy_timeout = 5000");
		this.createSchema(db);
		const model = this.getMeta(db, "embedding_model");
		const dims = this.getMeta(db, "dimensions");
		if (model !== EMBEDDING_MODEL || dims !== String(EMBEDDING_DIMENSIONS)) {
			this.vectorsOk = false;
			this.cachedWarning =
				`memory: embedding model mismatch (database has ${model ?? "none"}/${dims ?? "none"}, ` +
				`code expects ${EMBEDDING_MODEL}/${EMBEDDING_DIMENSIONS}) — running keyword-only. ` +
				`Reset the database to re-enable semantic search.`;
		}
		this.db = db;
		return db;
	}

	/** Read one `meta` value (no auto-open; caller holds the handle). */
	private getMeta(db: DatabaseSync, key: string): string | undefined {
		const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as unknown as { value: string } | undefined;
		return row?.value;
	}

	/** Idempotent v1 schema plus external-content FTS triggers. */
	private createSchema(db: DatabaseSync): void {
		db.exec(`
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');
INSERT OR IGNORE INTO meta(key, value) VALUES ('embedding_model', '${EMBEDDING_MODEL}');
INSERT OR IGNORE INTO meta(key, value) VALUES ('dimensions', '${EMBEDDING_DIMENSIONS}');
CREATE TABLE IF NOT EXISTS projects(
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('git', 'path')),
  key TEXT NOT NULL,
  root TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(kind, key)
);
CREATE TABLE IF NOT EXISTS memories(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  accessed_at INTEGER,
  last_used_at INTEGER NOT NULL,
  embedding_model TEXT,
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_memories_recency ON memories(project_id, last_used_at DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  name, description, content,
  content='memories', content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, name, description, content)
  VALUES (new.id, new.name, new.description, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, name, description, content)
  VALUES ('delete', old.id, old.name, old.description, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, name, description, content)
  VALUES ('delete', old.id, old.name, old.description, old.content);
  INSERT INTO memories_fts(rowid, name, description, content)
  VALUES (new.id, new.name, new.description, new.content);
END;
CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
  memory_id INTEGER PRIMARY KEY,
  project_id INTEGER PARTITION KEY,
  embedding float[${EMBEDDING_DIMENSIONS}] distance_metric=cosine
);`);
	}

	/** Run `fn` in a `BEGIN IMMEDIATE` transaction (`node:sqlite` has none). */
	private transaction<T>(fn: () => T): T {
		const db = this.ensureOpen();
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// The rollback itself failed; the original error matters.
			}
			throw error;
		}
	}

	/** Map a raw row to a `MemoryRecord`. */
	private toRecord(row: MemoryRow): MemoryRecord {
		return {
			id: row.id,
			projectId: row.project_id,
			name: row.name,
			description: row.description,
			content: row.content,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			accessedAt: row.accessed_at,
			lastUsedAt: row.last_used_at,
			embeddingModel: row.embedding_model,
		};
	}

	/** Encode a JS embedding as the float32 blob vec0 expects. */
	private toBlob(vector: number[]): Uint8Array {
		return new Uint8Array(new Float32Array(vector).buffer);
	}

	/** Get or create the project row; returns its id. */
	ensureProject(kind: "git" | "path", key: string, root: string): number {
		return this.transaction(() => {
			const db = this.ensureOpen();
			db.prepare("INSERT OR IGNORE INTO projects(kind, key, root, created_at) VALUES (?, ?, ?, ?)")
				.run(kind, key, root, Date.now());
			const row = db.prepare("SELECT id FROM projects WHERE kind = ? AND key = ?").get(kind, key) as unknown as { id: number };
			return row.id;
		});
	}

	/** Fetch one memory by name within a project. */
	getMemory(projectId: number, name: string): MemoryRecord | undefined {
		const db = this.ensureOpen();
		const row = db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE project_id = ? AND name = ?`)
			.get(projectId, name) as unknown as MemoryRow | undefined;
		return row ? this.toRecord(row) : undefined;
	}

	/**
	 * Insert or overwrite a memory row plus its vector atomically. A null
	 * `embedding` stores the row with `embedding_model NULL` (pending
	 * backfill). Write/edit bumps `updated_at = last_used_at = now`.
	 */
	upsertMemory(
		projectId: number,
		name: string,
		description: string,
		content: string,
		embedding: number[] | null,
		now?: number,
	): { created: boolean } {
		const at = now ?? Date.now();
		return this.transaction(() => {
			const db = this.ensureOpen();
			const existing = db.prepare("SELECT id FROM memories WHERE project_id = ? AND name = ?")
				.get(projectId, name) as unknown as { id: number } | undefined;
			const storeVector = embedding !== null && this.vectorsOk;
			if (!existing) {
				db.prepare(
					`INSERT INTO memories(project_id, name, description, content, created_at, updated_at, accessed_at, last_used_at, embedding_model)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
				).run(projectId, name, description, content, at, at, at, storeVector ? EMBEDDING_MODEL : null);
			} else {
				if (storeVector) {
					db.prepare(
						"UPDATE memories SET description = ?, content = ?, updated_at = ?, last_used_at = ?, embedding_model = ? WHERE id = ?",
					).run(description, content, at, at, EMBEDDING_MODEL, existing.id);
				} else {
					db.prepare("UPDATE memories SET description = ?, content = ?, updated_at = ?, last_used_at = ? WHERE id = ?")
						.run(description, content, at, at, existing.id);
				}
			}
			const row = db.prepare("SELECT id FROM memories WHERE project_id = ? AND name = ?")
				.get(projectId, name) as unknown as { id: number };
			if (storeVector && embedding) this.writeVector(db, row.id, projectId, embedding);
			return { created: !existing };
		});
	}

	/** Delete-then-insert one vec0 row (ids as BigInt) plus the model marker. */
	private writeVector(db: DatabaseSync, memoryId: number, projectId: number, vector: number[]): void {
		db.prepare("DELETE FROM memory_vectors WHERE memory_id = ?").run(BigInt(memoryId));
		db.prepare("INSERT INTO memory_vectors(memory_id, project_id, embedding) VALUES (?, ?, ?)")
			.run(BigInt(memoryId), BigInt(projectId), this.toBlob(vector));
		db.prepare("UPDATE memories SET embedding_model = ? WHERE id = ?").run(EMBEDDING_MODEL, memoryId);
	}

	/**
	 * Update the vector for one memory (delete then insert; vec0 ids bound
	 * as BigInt). A null vector clears the row back to pending-backfill.
	 */
	setVector(memoryId: number, projectId: number, vector: number[] | null): void {
		const db = this.ensureOpen();
		if (!this.vectorsOk) return;
		if (vector === null) {
			db.prepare("DELETE FROM memory_vectors WHERE memory_id = ?").run(BigInt(memoryId));
			db.prepare("UPDATE memories SET embedding_model = NULL WHERE id = ?").run(memoryId);
			return;
		}
		this.writeVector(db, memoryId, projectId, vector);
	}

	/** Delete a memory (row + vector; FTS cleaned by triggers). */
	deleteMemory(projectId: number, name: string): boolean {
		return this.transaction(() => {
			const db = this.ensureOpen();
			const existing = db.prepare("SELECT id FROM memories WHERE project_id = ? AND name = ?")
				.get(projectId, name) as unknown as { id: number } | undefined;
			if (!existing) return false;
			db.prepare("DELETE FROM memory_vectors WHERE memory_id = ?").run(BigInt(existing.id));
			db.prepare("DELETE FROM memories WHERE id = ?").run(existing.id);
			return true;
		});
	}

	/**
	 * Fetch one memory and bump `accessed_at = last_used_at = now`
	 * (the `memory_read` recency rule).
	 */
	readMemory(projectId: number, name: string, now?: number): MemoryRecord | undefined {
		const at = now ?? Date.now();
		return this.transaction(() => {
			const db = this.ensureOpen();
			const row = db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE project_id = ? AND name = ?`)
				.get(projectId, name) as unknown as MemoryRow | undefined;
			if (!row) return undefined;
			db.prepare("UPDATE memories SET accessed_at = ?, last_used_at = ? WHERE id = ?").run(at, at, row.id);
			return this.toRecord({ ...row, accessed_at: at, last_used_at: at });
		});
	}

	/** Most recent memories by `last_used_at` (autocomplete listing; no bump). */
	listRecent(projectId: number, limit: number): MemoryRecord[] {
		const db = this.ensureOpen();
		const rows = db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE project_id = ? ORDER BY last_used_at DESC LIMIT ?`)
			.all(projectId, limit) as unknown as MemoryRow[];
		return rows.map((row) => this.toRecord(row));
	}

	/** Keyword search ranked by bm25 (name > description > content); no bump. */
	ftsSearch(projectId: number, query: string, limit: number): MemoryRecord[] {
		const db = this.ensureOpen();
		const match = buildFtsQuery(query);
		if (!match) return [];
		const rows = db.prepare(
			`SELECT m.${MEMORY_COLUMNS.split(", ").join(", m.")} FROM memories_fts
       JOIN memories m ON m.id = memories_fts.rowid
       WHERE memories_fts MATCH ? AND m.project_id = ?
       ORDER BY bm25(memories_fts, 5.0, 3.0, 1.0)
       LIMIT ?`,
		).all(match, projectId, limit) as unknown as MemoryRow[];
		return rows.map((row) => this.toRecord(row));
	}

	/** KNN vector search scoped to one project partition; no bump. */
	vectorSearch(projectId: number, vector: number[], k: number): MemoryRecord[] {
		const db = this.ensureOpen();
		if (!this.vectorsOk) return [];
		const count = Math.max(1, Math.floor(k));
		const rows = db.prepare(
			`SELECT m.${MEMORY_COLUMNS.split(", ").join(", m.")} FROM memory_vectors v
       JOIN memories m ON m.id = v.memory_id
       WHERE v.embedding MATCH ? AND v.project_id = ? AND k = ${count}`,
		).all(this.toBlob(vector), BigInt(projectId)) as unknown as MemoryRow[];
		return rows.map((row) => this.toRecord(row));
	}

	/** Up to `limit` rows of this project with no vector (backfill queue). */
	getUnembedded(projectId: number, limit: number): MemoryRecord[] {
		const db = this.ensureOpen();
		const rows = db.prepare(
			`SELECT ${MEMORY_COLUMNS} FROM memories WHERE project_id = ? AND embedding_model IS NULL ORDER BY id LIMIT ?`,
		).all(projectId, limit) as unknown as MemoryRow[];
		return rows.map((row) => this.toRecord(row));
	}
}
