/**
 * git — object visibility and the review commit for `/review`.
 *
 * omp-undo-redo keeps its snapshot objects in a separate store, so they are
 * invisible to the user's repository. Git reads them through
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES`, which the git CLI honours. tuicr's libgit2
 * backend does not, so `materialize` copies the objects into the repository's
 * object database as a pack. It adds no refs, and it leaves the index, the
 * worktree, HEAD, and branches untouched. This module never imports pi packages.
 */

import { spawnSync } from "node:child_process";

/** Which repository a git command runs in, and whether omp's snapshot store is visible to it. */
export interface RepoView {
	/** Working directory for git. */
	cwd: string;
	/** omp-undo-redo object directory, added as an alternate object store when set. */
	alternateObjects?: string;
}

/** Inputs for `materialize`. */
export interface MaterializeOptions {
	/** Commit to parent the review commit on: the previous review commit, or the first before-snapshot. */
	base: string;
	/** omp `after` snapshot tree commit to review up to. */
	head: string;
	/** Repository worktree, used as the working directory for git. */
	worktree: string;
	/** omp-undo-redo object directory that holds `base` and `head`. */
	storeObjects: string;
	/** Commits already present in the repository whose objects the pack can skip. */
	exclude: string[];
}

/**
 * Returns true when `sha` names a commit that git can read through `view`.
 */
export function hasObject(view: RepoView, sha: string): boolean {
	return runGit(["cat-file", "-e", `${sha}^{commit}`], { cwd: view.cwd, env: alternateEnv(view), encoding: "utf8" }).code === 0;
}

/**
 * Returns the tree hash of commit `sha` as seen through `view`.
 * Used to test whether two snapshots are equal (an empty round).
 */
export function treeOf(view: RepoView, sha: string): string {
	const result = runGit(["rev-parse", `${sha}^{tree}`], { cwd: view.cwd, env: alternateEnv(view), encoding: "utf8" });
	if (result.code !== 0) {
		throw new Error(`could not read the tree of ${sha.slice(0, 7)}`);
	}
	return String(result.stdout).trim();
}

/**
 * Creates the deterministic review commit `B' = commit-tree tree(head) -p base` and packs the
 * objects it needs into the repository's object database. It adds no refs.
 * Returns the hash of `B'`. The same (base, head) always gives the same hash.
 * Throws "could not make snapshot objects visible" when a reachable object is still missing after packing.
 */
export function materialize(options: MaterializeOptions): string {
	const { base, head, worktree, storeObjects, exclude } = options;
	const alt: RepoView = { cwd: worktree, alternateObjects: storeObjects };
	const plain: RepoView = { cwd: worktree };
	const run = (view: RepoView, args: string[], extra: { env?: NodeJS.ProcessEnv; input?: Buffer; encoding?: "utf8" | "buffer" } = {}) =>
		runGit(args, { cwd: view.cwd, env: { ...alternateEnv(view), ...extra.env }, input: extra.input, encoding: extra.encoding ?? "utf8" });

	const tree = treeOf(alt, head);
	const log = run(alt, ["log", "-1", "--format=%cd", "--date=raw", head]);
	if (log.code !== 0) {
		throw new Error(`could not read the date of ${head.slice(0, 7)}`);
	}
	const date = String(log.stdout).trim();

	const message = [`pi review ${base.slice(0, 12)}..${head.slice(0, 12)}`, "", `base: ${base}`, `head: ${head} (omp-undo-redo after-turn snapshot)`].join("\n");
	const identity = {
		GIT_AUTHOR_NAME: "pi-review",
		GIT_AUTHOR_EMAIL: "pi-review@localhost",
		GIT_COMMITTER_NAME: "pi-review",
		GIT_COMMITTER_EMAIL: "pi-review@localhost",
		GIT_AUTHOR_DATE: date,
		GIT_COMMITTER_DATE: date,
	};
	const created = run(alt, ["commit-tree", "--no-gpg-sign", tree, "-p", base, "-m", message], { env: identity });
	if (created.code !== 0) {
		throw new Error("could not create the review commit");
	}
	const reviewCommit = String(created.stdout).trim();

	const headExists = run(plain, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]).code === 0;
	const presentExcludes = exclude.filter((sha) => hasObject(plain, sha));
	const revs = [reviewCommit, ...(headExists ? ["^HEAD"] : []), ...presentExcludes.map((sha) => `^${sha}`)];
	const packed = run(alt, ["pack-objects", "--revs", "--stdout", "-q"], { input: Buffer.from(`${revs.join("\n")}\n`), encoding: "buffer" });
	if (packed.code !== 0) {
		throw new Error("could not make snapshot objects visible");
	}
	if (run(plain, ["index-pack", "--stdin"], { input: packed.stdout as Buffer }).code !== 0) {
		throw new Error("could not make snapshot objects visible");
	}

	const verified = run(plain, ["rev-list", "--objects", "--missing=print", reviewCommit, "--not", ...(headExists ? ["HEAD"] : []), ...presentExcludes]);
	if (verified.code !== 0 || String(verified.stdout).split("\n").some((line) => line.startsWith("?"))) {
		throw new Error("could not make snapshot objects visible");
	}
	return reviewCommit;
}

/**
 * Returns the environment that makes `view`'s omp-undo-redo objects visible to git:
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES` when `alternateObjects` is set, otherwise an empty object.
 */
function alternateEnv(view: RepoView): NodeJS.ProcessEnv {
	return view.alternateObjects === undefined ? {} : { GIT_ALTERNATE_OBJECT_DIRECTORIES: view.alternateObjects };
}

/**
 * Runs git with `args` and returns `{ code, stdout, stderr }`.
 * Uses `node:child_process` spawnSync with a 30 s timeout. `env` overrides are merged into
 * process.env, and `input` is piped to stdin. The `encoding` option controls stdout/stderr decoding.
 */
function runGit(
	args: string[],
	options: { cwd: string; env?: NodeJS.ProcessEnv; input?: Buffer; encoding: BufferEncoding | "buffer" },
): { code: number; stdout: Buffer | string; stderr: string } {
	const result = spawnSync("git", args, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		input: options.input,
		timeout: 30_000,
		maxBuffer: 64 * 1024 * 1024,
		encoding: options.encoding,
	});
	return {
		code: result.status ?? -1,
		stdout: result.stdout ?? "",
		stderr: result.stderr?.toString() ?? "",
	};
}
