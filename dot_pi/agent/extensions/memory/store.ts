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
 */

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
	// TODO: return PI_MEMORY_DB env when set, else `~/.pi/agent/memory.db` via node:os homedir + node:path join; no DB access.
	throw new Error("not implemented");
}

/**
 * Tokenize a find query into a quoted FTS5 `OR` expression
 * (`/[\p{L}\p{N}_]+/gu` tokens). Returns null when the query has no tokens.
 */
export function buildFtsQuery(query: string): string | null {
	// TODO: tokenize with /[\p{L}\p{N}_]+/gu, wrap each token in double quotes (escaping embedded quotes), join with OR; null when no tokens; no dependencies.
	throw new Error("not implemented");
}

/**
 * Fuse ranked candidate lists with reciprocal rank fusion:
 * `score = Σ 1/(60 + rank)`. Order of the returned items is fused best
 * first; items are deduplicated by `getKey`.
 */
export function rrfFuse<T>(lists: T[][], getKey: (item: T) => string): T[] {
	// TODO: score each item Σ 1/(60 + rank) across lists (rank is 0-based index within its list), dedupe by getKey keeping first-seen item, sort by score desc; no dependencies.
	throw new Error("not implemented");
}

/**
 * Project-scoped memory store. Opened lazily on first use (`node:sqlite`
 * with `allowExtension` + `sqlite-vec`); `close()` is idempotent and called
 * from `session_shutdown`.
 */
export class MemoryStore {
	// Lazily-opened DB handle; null until first use. Set in implementation.
	constructor(dbPath?: string) {
	// TODO: store the resolved path (arg or getDbPath()); actual open is lazy via a private ensureOpen using node:sqlite DatabaseSync with allowExtension + sqlite-vec load + WAL/foreign_keys/busy_timeout pragmas + idempotent schema creation + model-mismatch detection.
	throw new Error("not implemented");
	}

	/** True when the DB embedding model/dimensions match this code's constants. */
	get vectorsAvailable(): boolean {
		// TODO: ensure open, then report whether stored meta model/dimensions match EMBEDDING_MODEL/EMBEDDING_DIMENSIONS.
		throw new Error("not implemented");
	}

	/** One-time FTS-only warning when the stored model/dimensions mismatch. */
	get vectorWarning(): string | undefined {
		// TODO: ensure open, then return the one-time FTS-only reset warning when mismatched, else undefined.
		throw new Error("not implemented");
	}

	/** Idempotently close the database. */
	close(): void {
		// TODO: close the DB handle if open and clear it, safe to call repeatedly or before any open.
		throw new Error("not implemented");
	}

	/** Get or create the project row; returns its id. */
	ensureProject(kind: "git" | "path", key: string, root: string): number {
		// TODO: INSERT OR IGNORE into projects then SELECT id for (kind, key), storing created_at epoch ms.
		throw new Error("not implemented");
	}

	/** Fetch one memory by name within a project. */
	getMemory(projectId: number, name: string): MemoryRecord | undefined {
		// TODO: SELECT the memories row for (projectId, name), mapping columns to MemoryRecord; no recency change.
		throw new Error("not implemented");
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
		// TODO: in one BEGIN IMMEDIATE transaction: INSERT or UPDATE the row (setting embedding_model only when embedding is non-null, bumping updated_at = last_used_at = now), then setVector-equivalent delete+insert of the vec0 row when vectors are available and embedding is non-null; FTS syncs via triggers; return whether the name is new.
		throw new Error("not implemented");
	}

	/**
	 * Update the vector for one memory (delete then insert; vec0 ids bound
	 * as BigInt). A null vector clears the row back to pending-backfill.
	 */
	setVector(memoryId: number, projectId: number, vector: number[] | null): void {
		// TODO: DELETE the vec0 row, then INSERT with ids bound as BigInt and the vector as Uint8Array over Float32Array when non-null; no-op when vectors are unavailable.
		throw new Error("not implemented");
	}

	/** Delete a memory (row + vector; FTS cleaned by triggers). */
	deleteMemory(projectId: number, name: string): boolean {
		// TODO: in one transaction DELETE the vec0 row by memory id then the memories row; return whether a row existed; FTS cleanup via triggers; no recency change.
		throw new Error("not implemented");
	}

	/**
	 * Fetch one memory and bump `accessed_at = last_used_at = now`
	 * (the `memory_read` recency rule).
	 */
	readMemory(projectId: number, name: string, now?: number): MemoryRecord | undefined {
		// TODO: SELECT the row, then UPDATE accessed_at = last_used_at = now (arg or Date.now()); return the refreshed record.
		throw new Error("not implemented");
	}

	/** Most recent memories by `last_used_at` (autocomplete listing; no bump). */
	listRecent(projectId: number, limit: number): MemoryRecord[] {
		// TODO: SELECT ordered by last_used_at DESC up to limit (backs the empty-query autocomplete list); no bump.
		throw new Error("not implemented");
	}

	/** Keyword search ranked by bm25 (name > description > content); no bump. */
	ftsSearch(projectId: number, query: string, limit: number): MemoryRecord[] {
		// TODO: build the MATCH expression via buildFtsQuery (empty when no tokens), JOIN memories on rowid with project_id filter, ORDER BY bm25(memories_fts, 5.0, 3.0, 1.0); no bump.
		throw new Error("not implemented");
	}

	/** KNN vector search scoped to one project partition; no bump. */
	vectorSearch(projectId: number, vector: number[], k: number): MemoryRecord[] {
		// TODO: SELECT with `embedding MATCH ? AND project_id = ? AND k = ?`, binding ids as BigInt and the vector as Uint8Array over Float32Array, JOIN memories for the rows in KNN order; empty when vectors are unavailable; no bump.
		throw new Error("not implemented");
	}

	/** Up to `limit` rows of this project with no vector (backfill queue). */
	getUnembedded(projectId: number, limit: number): MemoryRecord[] {
		// TODO: SELECT rows of this project with embedding_model IS NULL ordered by rowid up to limit (memory_find backfill queue).
		throw new Error("not implemented");
	}
}
