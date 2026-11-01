/**
 * omp — locates and reads the omp-undo-redo history for a pi session.
 *
 * omp-undo-redo keeps one store per git common dir under its store root and
 * one history JSON (schema v3) per pi session. This module resolves those
 * paths, validates the history strictly, and picks the snapshot endpoints
 * for a review. It never imports pi packages, so it can be unit-tested with
 * `node --test`.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A checkpoint recorded by omp-undo-redo for a turn with file snapshots. */
export interface GitCheckpoint {
	/** Position in the history's `checkpoints` array (omp writes no index field). */
	index: number;
	kind: "git";
	/** Leaf id read by omp at `before_agent_start`, or null before the first entry. */
	parentLeafId: string | null;
	reason?: string;
	/** Snapshot tree commit taken before the turn (hex, 40 or 64 chars). */
	beforeHash: string;
	/** Snapshot tree commit taken after the turn (hex, 40 or 64 chars). */
	afterHash: string;
}

/** A checkpoint recorded without file snapshots (for example `file_history_gap`). */
export interface SessionCheckpoint {
	/** Position in the history's `checkpoints` array (omp writes no index field). */
	index: number;
	kind: "session";
	parentLeafId: string | null;
	reason?: string;
}

/** One checkpoint of an omp-undo-redo history. */
export type Checkpoint = GitCheckpoint | SessionCheckpoint;

/** A validated omp-undo-redo history (schema v3). */
export interface History {
	worktree: string;
	currentIndex: number;
	checkpoints: Checkpoint[];
}

/** Snapshot endpoints derived from a history. */
export interface Snapshots {
	worktree: string;
	/** `beforeHash` of every git checkpoint, in history order. */
	earliestBefore: string[];
	/** `afterHash` of the nearest git checkpoint at or before `currentIndex`. */
	head?: string;
}

/** The repository that `/review` runs in. */
export interface RepoInfo {
	/** Worktree top-level directory. */
	toplevel: string;
	/** Realpath of the git common dir (the `.git` directory, shared by worktrees). */
	commonDir: string;
}

/** A pi turn that started in this process and may not be recorded by omp yet. */
export interface PendingTurn {
	/** Leaf id read in `before_agent_start`; omp records the same value as `parentLeafId`. */
	turnStartLeaf: string | null;
	/** Epoch ms when pi reported the agent settled, once known. */
	settledAt?: number;
}

/**
 * Returns the omp-undo-redo store root: `OMP_UNDO_REDO_STORE_DIR` when set,
 * otherwise `~/.omp/omp-undo-redo`, resolved through realpath when possible.
 */
export function storeRoot(env: NodeJS.ProcessEnv = process.env): string {
	const path = env.OMP_UNDO_REDO_STORE_DIR ?? join(homedir(), ".omp", "omp-undo-redo");
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * Resolves the git repository containing `cwd`.
 * Throws "/review needs a git repository" when `cwd` is not inside one.
 */
export function resolveRepo(cwd: string): RepoInfo {
	const result = spawnSync("git", ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"], {
		cwd,
		encoding: "utf8",
	});
	const [toplevel, commonDir] = result.status === 0 ? result.stdout.trim().split("\n") : [];
	if (!toplevel || !commonDir) {
		throw new Error("/review needs a git repository");
	}
	return { toplevel, commonDir: realpathSync(commonDir) };
}

/**
 * Returns `<root>/repos/<sha256(realpath(commonDir))>.git` after checking that the store's
 * `omp-undo-redo.commondir` config equals the realpath'd common dir.
 * Throws "no omp-undo-redo store for this repo" on a missing store or a mismatch.
 */
export function storeDirFor(root: string, commonDir: string): string {
	const realCommonDir = realpathSync(commonDir);
	const storeDir = join(root, "repos", `${sha256(realCommonDir)}.git`);
	const config = spawnSync("git", ["--git-dir", storeDir, "config", "omp-undo-redo.commondir"], { encoding: "utf8" });
	if (config.status !== 0 || config.stdout.trim() !== realCommonDir) {
		throw new Error("no omp-undo-redo store for this repo");
	}
	return storeDir;
}

/**
 * Returns the history file path `<store>/omp-undo-redo/history/<sha256(sessionId)>.json`.
 * Pure path computation; existence is checked by `readHistory`.
 */
export function historyPathFor(storeDir: string, sessionId: string): string {
	return join(storeDir, "omp-undo-redo", "history", `${sha256(sessionId)}.json`);
}

/**
 * Reads and validates the history for `sessionId`, returning it with the file's mtime.
 * Throws "omp-undo-redo history for this session expired" when only `<hash>.expired.json`
 * exists, and "no snapshots for this session yet (is omp-undo-redo installed and has the
 * agent run a turn?)" when neither file exists.
 */
export function readHistory(storeDir: string, sessionId: string): { history: History; mtimeMs: number } {
	const path = historyPathFor(storeDir, sessionId);
	if (!existsSync(path)) {
		const expiredPath = `${path.slice(0, -".json".length)}.expired.json`;
		if (existsSync(expiredPath)) {
			throw new Error("omp-undo-redo history for this session expired");
		}
		throw new Error("no snapshots for this session yet (is omp-undo-redo installed and has the agent run a turn?)");
	}
	return { history: parseHistory(readFileSync(path, "utf8")), mtimeMs: statSync(path).mtimeMs };
}

/**
 * Parses and validates an omp-undo-redo history JSON document.
 * Requires `schemaVersion === 3`, a string `repository.worktree`, a `checkpoints` array, and an
 * integer `currentIndex`; otherwise throws "unsupported omp-undo-redo history format".
 * Git checkpoints without hex (40 or 64 chars) `beforeHash`/`afterHash` are dropped.
 * Session-only checkpoints are kept, so readiness can correlate them.
 */
export function parseHistory(json: string): History {
	const unsupported = () => new Error("unsupported omp-undo-redo history format");
	let doc: unknown;
	try {
		doc = JSON.parse(json);
	} catch {
		throw unsupported();
	}
	if (
		!isRecord(doc) ||
		doc.schemaVersion !== 3 ||
		!isRecord(doc.repository) ||
		typeof doc.repository.worktree !== "string" ||
		!Array.isArray(doc.checkpoints) ||
		!Number.isInteger(doc.currentIndex)
	) {
		throw unsupported();
	}
	return {
		worktree: doc.repository.worktree,
		currentIndex: doc.currentIndex as number,
		checkpoints: doc.checkpoints.flatMap((raw, index) => toCheckpoint(raw, index)),
	};
}

/**
 * Derives the snapshot endpoints of a history.
 * `head` is the `afterHash` of the nearest git checkpoint whose index is at or below
 * `currentIndex`, so `/undo` moves the head back. Negative `currentIndex` or no such
 * checkpoint leaves `head` undefined. Session-only checkpoints never become endpoints.
 */
export function pickSnapshots(history: History): Snapshots {
	const gitCheckpoints = history.checkpoints.filter((checkpoint): checkpoint is GitCheckpoint => checkpoint.kind === "git");
	let nearest: GitCheckpoint | undefined;
	if (history.currentIndex >= 0) {
		for (const checkpoint of gitCheckpoints) {
			if (checkpoint.index <= history.currentIndex && (nearest === undefined || checkpoint.index > nearest.index)) {
				nearest = checkpoint;
			}
		}
	}
	return {
		worktree: history.worktree,
		earliestBefore: gitCheckpoints.map((checkpoint) => checkpoint.beforeHash),
		head: nearest?.afterHash,
	};
}

/**
 * Returns the checkpoint omp recorded for the turn that started at `turnStartLeaf`
 * (`parentLeafId` equal to it), or undefined. Works for git and session-only checkpoints.
 */
export function turnCheckpoint(history: History, turnStartLeaf: string | null): Checkpoint | undefined {
	return history.checkpoints.find((checkpoint) => checkpoint.parentLeafId === turnStartLeaf);
}

/**
 * Returns true when the history is ready for `/review` to read.
 * True if `pending` is undefined, or some checkpoint has `parentLeafId === pending.turnStartLeaf`,
 * or `pending.settledAt` is set and `historyMtimeMs >= pending.settledAt`. Otherwise false.
 */
export function isCaughtUp(history: History, pending: PendingTurn | undefined, historyMtimeMs: number): boolean {
	if (pending === undefined || turnCheckpoint(history, pending.turnStartLeaf) !== undefined) {
		return true;
	}
	return pending.settledAt !== undefined && historyMtimeMs >= pending.settledAt;
}

/** Returns the sha256 hex digest of `text`. */
function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Narrows an unknown JSON value to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Converts one raw history checkpoint at array position `index`. Returns `[]` for checkpoints
 * that are invalid or that are git checkpoints without valid hashes, so `flatMap` drops them.
 */
function toCheckpoint(raw: unknown, index: number): Checkpoint[] {
	if (!isRecord(raw) || (raw.parentLeafId !== null && typeof raw.parentLeafId !== "string")) {
		return [];
	}
	const parentLeafId = raw.parentLeafId as string | null;
	const reason = typeof raw.reason === "string" ? raw.reason : undefined;
	if (raw.kind === "session") {
		return [{ index, kind: "session", parentLeafId, reason }];
	}
	if (
		raw.kind === "git" &&
		typeof raw.beforeHash === "string" &&
		typeof raw.afterHash === "string" &&
		/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(raw.beforeHash) &&
		/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(raw.afterHash)
	) {
		return [{ index, kind: "git", parentLeafId, reason, beforeHash: raw.beforeHash, afterHash: raw.afterHash }];
	}
	return [];
}
