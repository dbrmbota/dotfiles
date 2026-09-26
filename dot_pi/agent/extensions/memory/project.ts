/**
 * project — pi-free project identity resolution.
 *
 * Resolves the current project to `{ kind, key, root }` via an injected
 * `exec` function (pi's `pi.exec` at runtime, a fake in tests). Never throws:
 * when git is unavailable or fails, falls back to a `path:` key so the
 * session is never blocked.
 */

import { normalizeRemoteUrl } from "./refs.ts";

/** Minimal exec result shape (matches pi's `ExecResult` fields we use). */
export interface ExecResultLike {
	code: number;
	stdout: string;
	stderr: string;
}

/** Injected command runner (pi.exec at runtime). */
export type ExecFn = (
	command: string,
	args: string[],
	options: { cwd: string; timeout: number },
) => Promise<ExecResultLike>;

/** Resolved project identity. `key` is `git:<host/path>` or `path:<root>`. */
export interface ProjectIdentity {
	kind: "git" | "path";
	key: string;
	root: string;
}

/**
 * Resolve the project for `cwd`. Prefers a `git:` key from the remote URL
 * (origin, else first alphabetically); without remotes, all worktrees of a
 * repo share the main-worktree `path:` key; outside git, the realpath of
 * `cwd`. Never throws — falls back to `path:` + cwd on any failure.
 */
export function resolveProject(cwd: string, exec: ExecFn): Promise<ProjectIdentity> {
	// TODO: wrap everything in try/catch falling back to `{ kind: "path", key: "path:" + realpath(cwd), root: realpath(cwd) }` (node:fs realpathSync, node:path dirname). Steps via exec (each `{ cwd, timeout: 5000 }`): `git rev-parse --show-toplevel --git-common-dir` (two-line stdout; non-zero code means non-repo); `git remote` (empty means no remotes -> main-worktree root: dirname(realpath(commonDir)) when it ends in `/.git`, else toplevel); prefer `origin` else first alphabetical, `git remote get-url <r>` then normalizeRemoteUrl for the `git:` key.
	throw new Error("not implemented");
}
