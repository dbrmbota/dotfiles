import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasObject, materialize, treeOf, type RepoView } from "./git.ts";

/** Runs git and returns trimmed stdout. */
function git(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string {
	return execFileSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" }).trim();
}

interface Fixture {
	root: string;
	/** User repository (worktree). */
	repo: string;
	/** Object directory of the omp-undo-redo store, which holds the snapshot objects. */
	storeObjects: string;
	/** Object directory of the user repository. */
	repoObjects: string;
	/** Before-turn snapshot commit. */
	before: string;
	/** After-turn snapshot commit. */
	after: string;
}

let counter = 0;

/** Writes a parentless snapshot of the worktree into the store, like omp-undo-redo does. */
function snapshot(f: Omit<Fixture, "before" | "after">, message: string): string {
	const env = {
		GIT_INDEX_FILE: join(f.repo, "..", `snapshot-index-${counter++}`),
		GIT_OBJECT_DIRECTORY: f.storeObjects,
		GIT_ALTERNATE_OBJECT_DIRECTORIES: f.repoObjects,
		GIT_AUTHOR_NAME: "omp",
		GIT_AUTHOR_EMAIL: "omp@localhost",
		GIT_COMMITTER_NAME: "omp",
		GIT_COMMITTER_EMAIL: "omp@localhost",
	};
	git(["read-tree", "HEAD"], f.repo, env);
	git(["add", "-A"], f.repo, env);
	const tree = git(["write-tree"], f.repo, env);
	return git(["-c", "commit.gpgSign=false", "commit-tree", tree, "-m", message], f.repo, env);
}

/**
 * Builds a user repository with one commit and `commit.gpgSign=true`, a bare store, and two
 * snapshots: `before` (clean worktree) and `after` (modified tracked file, new file, untracked file).
 */
function makeFixture(t: { after(fn: () => void): void }): Fixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-turn-review-git-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const repo = join(root, "repo");
	mkdirSync(repo);
	git(["init", "-q"], repo);
	git(["config", "user.name", "user"], repo);
	git(["config", "user.email", "user@localhost"], repo);
	writeFileSync(join(repo, "README.md"), "one\n");
	git(["add", "README.md"], repo);
	git(["-c", "commit.gpgSign=false", "commit", "-q", "-m", "init"], repo);
	git(["config", "commit.gpgSign", "true"], repo);

	const storeGit = join(root, "store.git");
	git(["init", "-q", "--bare", storeGit], root);
	const partial = {
		root,
		repo,
		storeObjects: join(storeGit, "objects"),
		repoObjects: join(repo, ".git", "objects"),
	};

	const before = snapshot(partial, "before");
	writeFileSync(join(repo, "README.md"), "two\n");
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "src", "new.txt"), "new\n");
	writeFileSync(join(repo, "untracked.txt"), "untracked\n");
	const after = snapshot(partial, "after");

	return { ...partial, before, after };
}

function view(f: Fixture): RepoView {
	return { cwd: f.repo, alternateObjects: f.storeObjects };
}

function materializeFixture(f: Fixture, base: string, head: string, exclude: string[] = []): string {
	return materialize({ base, head, worktree: f.repo, storeObjects: f.storeObjects, exclude });
}

describe("snapshot visibility", () => {
	it("hides omp snapshots from the repository unless the alternate object store is used", (t) => {
		const f = makeFixture(t);

		assert.equal(hasObject({ cwd: f.repo }, f.before), false);
		assert.equal(hasObject({ cwd: f.repo }, f.after), false);
		assert.equal(hasObject(view(f), f.before), true);
		assert.equal(hasObject(view(f), f.after), true);
	});

	it("detects an empty round by comparing tree hashes", (t) => {
		const f = makeFixture(t);
		const sameTree = snapshot(f, "after again, nothing changed");

		assert.notEqual(treeOf(view(f), f.before), treeOf(view(f), f.after));
		assert.equal(treeOf(view(f), sameTree), treeOf(view(f), f.after));
	});
});

describe("materialize", () => {
	it("creates a review commit whose parent is base and whose tree is head's tree", (t) => {
		const f = makeFixture(t);

		const reviewCommit = materializeFixture(f, f.before, f.after);

		assert.equal(git(["rev-parse", `${reviewCommit}^`], f.repo), f.before);
		assert.equal(git(["rev-parse", `${reviewCommit}^{tree}`], f.repo), treeOf(view(f), f.after));
	});

	it("makes a plain git diff of base..review commit list exactly the changed files", (t) => {
		const f = makeFixture(t);

		const reviewCommit = materializeFixture(f, f.before, f.after);
		const names = git(["diff", "--name-status", f.before, reviewCommit], f.repo).split("\n").sort();

		assert.deepEqual(names, ["A\tsrc/new.txt", "A\tuntracked.txt", "M\tREADME.md"]);
	});

	it("is deterministic for the same base and head", (t) => {
		const f = makeFixture(t);

		const first = materializeFixture(f, f.before, f.after);
		const second = materializeFixture(f, f.before, f.after);

		assert.equal(first, second);
	});

	it("leaves HEAD, refs, the index, and the worktree status untouched", (t) => {
		const f = makeFixture(t);
		const observe = () => {
			git(["status", "--porcelain"], f.repo);
			return {
				head: git(["rev-parse", "HEAD"], f.repo),
				refs: git(["for-each-ref"], f.repo),
				index: readFileSync(join(f.repo, ".git", "index")),
				status: git(["status", "--porcelain"], f.repo),
			};
		};
		const before = observe();

		materializeFixture(f, f.before, f.after);

		assert.deepEqual(observe(), before);
	});

	it("builds a second round on the previous review commit and diffs only the new change", (t) => {
		const f = makeFixture(t);
		const firstRound = materializeFixture(f, f.before, f.after);
		writeFileSync(join(f.repo, "untracked.txt"), "changed again\n");
		const next = snapshot(f, "after second turn");

		const secondRound = materializeFixture(f, firstRound, next, [firstRound]);

		assert.equal(git(["rev-parse", `${secondRound}^`], f.repo), firstRound);
		assert.deepEqual(git(["diff", "--name-status", firstRound, secondRound], f.repo).split("\n"), ["M\tuntracked.txt"]);
	});

	it("throws when the head snapshot is missing", (t) => {
		const f = makeFixture(t);
		const missing = "f".repeat(40);

		assert.equal(hasObject(view(f), missing), false);
		assert.throws(() => materializeFixture(f, f.before, missing));
	});
});
