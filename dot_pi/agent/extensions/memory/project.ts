/**
 * project — pi-free project identity resolution.
 *
 * Resolves the current project to `{ kind, key, root }` via an injected
 * `exec` function (pi's `pi.exec` at runtime, a fake in tests). Never throws:
 * when git is unavailable or fails, falls back to a `path:` key so the
 * session is never blocked.
 */

import { realpathSync } from "node:fs";
import { dirname } from "node:path";
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

/** Timeout for every git probe (keeps slow repos from blocking the session). */
const GIT_TIMEOUT_MS = 5000;

/** realpath that falls back to the input when the path does not exist. */
function realpathOr(p: string, fallback: string): string {
	try {
		return realpathSync(p);
	} catch {
		return fallback;
	}
}

/**
 * Resolve the project for `cwd`. Prefers a `git:` key from the remote URL
 * (origin, else first alphabetically); without remotes, all worktrees of a
 * repo share the main-worktree `path:` key; outside git, the realpath of
 * `cwd`. Never throws — falls back to `path:` + cwd on any failure.
 */
export async function resolveProject(cwd: string, exec: ExecFn): Promise<ProjectIdentity> {
	const cwdReal = realpathOr(cwd, cwd);
	const fallback: ProjectIdentity = { kind: "path", key: `path:${cwdReal}`, root: cwdReal };
	try {
		const rev = await exec("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
		});
		if (rev.code !== 0) return fallback;
		const lines = rev.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
		if (lines.length < 2) return fallback;
		const toplevel = lines[0];
		const commonDir = lines[1];
		const topReal = realpathOr(toplevel, toplevel);

		const remotes = await exec("git", ["remote"], { cwd, timeout: GIT_TIMEOUT_MS });
		if (remotes.code !== 0) return fallback;
		const names = remotes.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).sort();
		if (names.length === 0) {
			const commonReal = realpathOr(commonDir, commonDir);
			const root = commonReal.endsWith("/.git") ? dirname(commonReal) : topReal;
			return { kind: "path", key: `path:${root}`, root };
		}
		const pick = names.includes("origin") ? "origin" : names[0];
		const urlRes = await exec("git", ["remote", "get-url", pick], { cwd, timeout: GIT_TIMEOUT_MS });
		const remoteUrl = urlRes.code === 0 ? urlRes.stdout.trim() : "";
		if (!remoteUrl) return { kind: "path", key: `path:${topReal}`, root: topReal };
		return { kind: "git", key: `git:${normalizeRemoteUrl(remoteUrl)}`, root: topReal };
	} catch {
		return fallback;
	}
}
