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
	throw new Error("not implemented");
}

/**
 * Tokenize a find query into a quoted FTS5 `OR` expression
 * (`/[\p{L}\p{N}_]+/gu` tokens). Returns null when the query has no tokens.
 */
export function buildFtsQuery(query: string): string | null {
	throw new Error("not implemented");
}

/**
 * Fuse ranked candidate lists with reciprocal rank fusion:
 * `score = Σ 1/(60 + rank)`. Order of the returned items is fused best
 * first; items are deduplicated by `getKey`.
 */
export function rrfFuse<T>(lists: T[][], getKey: (item: T) => string): T[] {
	throw new Error("not implemented");
}

/**
 * Project-scoped memory store. Opened lazily on first use (`node:sqlite`
 * with `allowExtension` + `sqlite-vec`); `close()` is idempotent and called
 * from `session_shutdown`.
 */
export class MemoryStore {
	constructor(dbPath?: string) {
		throw new Error("not implemented");
	}

	/** True when the DB embedding model/dimensions match this code's constants. */
	get vectorsAvailable(): boolean {
		throw new Error("not implemented");
	}

	/** One-time FTS-only warning when the stored model/dimensions mismatch. */
	get vectorWarning(): string | undefined {
		throw new Error("not implemented");
	}

	/** Idempotently close the database. */
	close(): void {
		throw new Error("not implemented");
	}

	/** Get or create the project row; returns its id. */
	ensureProject(kind: "git" | "path", key: string, root: string): number {
		throw new Error("not implemented");
	}

	/** Fetch one memory by name within a project. */
	getMemory(projectId: number, name: string): MemoryRecord | undefined {
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
		throw new Error("not implemented");
	}

	/**
	 * Update the vector for one memory (delete then insert; vec0 ids bound
	 * as BigInt). A null vector clears the row back to pending-backfill.
	 */
	setVector(memoryId: number, projectId: number, vector: number[] | null): void {
		throw new Error("not implemented");
	}

	/** Delete a memory (row + vector; FTS cleaned by triggers). */
	deleteMemory(projectId: number, name: string): boolean {
		throw new Error("not implemented");
	}

	/**
	 * Fetch one memory and bump `accessed_at = last_used_at = now`
	 * (the `memory_read` recency rule).
	 */
	readMemory(projectId: number, name: string, now?: number): MemoryRecord | undefined {
		throw new Error("not implemented");
	}

	/** Most recent memories by `last_used_at` (autocomplete listing; no bump). */
	listRecent(projectId: number, limit: number): MemoryRecord[] {
		throw new Error("not implemented");
	}

	/** Keyword search ranked by bm25 (name > description > content); no bump. */
	ftsSearch(projectId: number, query: string, limit: number): MemoryRecord[] {
		throw new Error("not implemented");
	}

	/** KNN vector search scoped to one project partition; no bump. */
	vectorSearch(projectId: number, vector: number[], k: number): MemoryRecord[] {
		throw new Error("not implemented");
	}

	/** Up to `limit` rows of this project with no vector (backfill queue). */
	getUnembedded(projectId: number, limit: number): MemoryRecord[] {
		throw new Error("not implemented");
	}
}
