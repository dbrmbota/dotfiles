import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	historyPathFor,
	isCaughtUp,
	parseHistory,
	pickSnapshots,
	readHistory,
	storeDirFor,
	storeRoot,
	type History,
} from "./omp.ts";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const hex = (digit: string): string => digit.repeat(40);

function gitCheckpoint(parentLeafId: string | null, before: string, after: string) {
	return { kind: "git", parentLeafId, beforeHash: hex(before), afterHash: hex(after) };
}

function sessionCheckpoint(parentLeafId: string | null) {
	return { kind: "session", parentLeafId, reason: "file_history_gap" };
}

function historyDoc(currentIndex: number, checkpoints: unknown[], schemaVersion = 3): string {
	return JSON.stringify({ schemaVersion, repository: { worktree: "/work/repo" }, currentIndex, checkpoints });
}

function parse(currentIndex: number, checkpoints: unknown[]): History {
	return parseHistory(historyDoc(currentIndex, checkpoints));
}

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "pi-turn-review-omp-")));
});

describe("storeRoot", () => {
	it("uses OMP_UNDO_REDO_STORE_DIR when it is set", () => {
		const dir = join(root, "custom-store");
		mkdirSync(dir);
		assert.equal(storeRoot({ OMP_UNDO_REDO_STORE_DIR: dir }), realpathSync(dir));
	});
});

describe("storeDirFor", () => {
	it("returns <root>/repos/<sha256(realpath(commonDir))>.git when the store is configured for the repo", () => {
		const commonDir = join(root, "user-repo", ".git");
		mkdirSync(commonDir, { recursive: true });
		const realCommonDir = realpathSync(commonDir);
		const storeDir = join(root, "repos", `${sha256(realCommonDir)}.git`);
		execFileSync("git", ["init", "-q", "--bare", storeDir]);
		execFileSync("git", ["--git-dir", storeDir, "config", "omp-undo-redo.commondir", realCommonDir]);

		assert.equal(storeDirFor(root, commonDir), storeDir);
	});
});

describe("historyPathFor", () => {
	it("returns <store>/omp-undo-redo/history/<sha256(sessionId)>.json", () => {
		assert.equal(
			historyPathFor("/store/x.git", "session-123"),
			join("/store/x.git", "omp-undo-redo", "history", `${sha256("session-123")}.json`),
		);
	});
});

describe("readHistory", () => {
	it("reports a missing history with the no-snapshots message", () => {
		const storeDir = join(root, "store.git");
		mkdirSync(join(storeDir, "omp-undo-redo", "history"), { recursive: true });

		assert.throws(() => readHistory(storeDir, "session-1"), /no snapshots for this session yet/);
	});

	it("reports an expired history when only the .expired.json file exists", () => {
		const storeDir = join(root, "store.git");
		const historyDir = join(storeDir, "omp-undo-redo", "history");
		mkdirSync(historyDir, { recursive: true });
		writeFileSync(join(historyDir, `${sha256("session-1")}.expired.json`), historyDoc(-1, []));

		assert.throws(() => readHistory(storeDir, "session-1"), /omp-undo-redo history for this session expired/);
	});
});

describe("parseHistory", () => {
	it("rejects a history whose schemaVersion is not 3", () => {
		assert.throws(() => parseHistory(historyDoc(0, [gitCheckpoint(null, "1", "2")], 2)), /unsupported omp-undo-redo history format/);
	});

	it("keeps session-only checkpoints for correlation", () => {
		const history = parse(1, [gitCheckpoint(null, "1", "2"), sessionCheckpoint(hex("3"))]);

		assert.equal(history.checkpoints.length, 2);
		assert.equal(history.checkpoints[1]?.kind, "session");
	});
});

describe("pickSnapshots", () => {
	it("moves the head back with currentIndex after an undo", () => {
		const checkpoints = [gitCheckpoint(null, "1", "2"), gitCheckpoint(hex("2"), "2", "3")];

		assert.equal(pickSnapshots(parse(1, checkpoints)).head, hex("3"));
		assert.equal(pickSnapshots(parse(0, checkpoints)).head, hex("2"));
	});

	it("gives no head when currentIndex is -1", () => {
		const snapshots = pickSnapshots(parse(-1, [gitCheckpoint(null, "1", "2")]));

		assert.equal(snapshots.head, undefined);
	});

	it("never picks a session-only checkpoint as head or base", () => {
		const onlySession = pickSnapshots(parse(0, [sessionCheckpoint(null)]));
		assert.equal(onlySession.head, undefined);
		assert.deepEqual(onlySession.earliestBefore, []);

		const mixed = pickSnapshots(parse(1, [gitCheckpoint(null, "1", "2"), sessionCheckpoint(hex("2"))]));
		assert.equal(mixed.head, hex("2"));
		assert.deepEqual(mixed.earliestBefore, [hex("1")]);
	});

	it("reads checkpoint indexes from array position when omp writes no index field", () => {
		const checkpoints = [
			{ kind: "git", beforeHash: hex("1"), afterHash: hex("2"), parentLeafId: "leaf-a", leafId: "leaf-b" },
			{ kind: "git", beforeHash: hex("2"), afterHash: hex("3"), parentLeafId: "leaf-b", leafId: "leaf-c" },
		];

		const snapshots = pickSnapshots(parse(1, checkpoints));

		assert.equal(snapshots.head, hex("3"));
		assert.deepEqual(snapshots.earliestBefore, [hex("1"), hex("2")]);
	});
});

describe("isCaughtUp", () => {
	it("is true when there is no pending turn", () => {
		assert.equal(isCaughtUp(parse(-1, []), undefined, 0), true);
	});

	it("is true when a git checkpoint matches the turn's leaf", () => {
		const history = parse(0, [gitCheckpoint("leaf-a", "1", "2")]);

		assert.equal(isCaughtUp(history, { turnStartLeaf: "leaf-a" }, 0), true);
	});

	it("is true when a session-only checkpoint matches the turn's leaf", () => {
		const history = parse(0, [sessionCheckpoint("leaf-a")]);

		assert.equal(isCaughtUp(history, { turnStartLeaf: "leaf-a" }, 0), true);
	});

	it("is false when nothing matches and the turn has not settled", () => {
		const history = parse(0, [gitCheckpoint("leaf-old", "1", "2")]);

		assert.equal(isCaughtUp(history, { turnStartLeaf: "leaf-new" }, 1_000), false);
	});

	it("is true when nothing matches but the history was written after the turn settled", () => {
		const history = parse(0, [gitCheckpoint("leaf-old", "1", "2")]);

		assert.equal(isCaughtUp(history, { turnStartLeaf: "leaf-new", settledAt: 1_000 }, 1_000), true);
	});

	it("is false when nothing matches and the history was written before the turn settled", () => {
		const history = parse(0, [gitCheckpoint("leaf-old", "1", "2")]);

		assert.equal(isCaughtUp(history, { turnStartLeaf: "leaf-new", settledAt: 2_000 }, 1_000), false);
	});

	it("matches a null turn leaf against a checkpoint with a null parentLeafId", () => {
		const history = parse(0, [gitCheckpoint(null, "1", "2")]);

		assert.equal(isCaughtUp(history, { turnStartLeaf: null }, 0), true);
	});
});
