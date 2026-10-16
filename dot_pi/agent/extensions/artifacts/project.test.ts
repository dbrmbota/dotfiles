import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProject, type ExecFn, type ExecResultLike } from "./project.ts";

let dir: string;

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-memory-proj-")));
});

function canned(handlers: Record<string, ExecResultLike | Error>): ExecFn {
	return async (_command: string, args: string[], _options: { cwd: string; timeout: number }) => {
		const key = args.join(" ");
		const handler = handlers[key];
		if (handler instanceof Error) throw handler;
		if (!handler) throw new Error(`unexpected exec: ${key}`);
		return handler;
	};
}

function ok(stdout: string): ExecResultLike {
	return { code: 0, stdout, stderr: "" };
}

describe("resolveProject", () => {
	it("uses the origin remote for a repo", async () => {
		const top = join(dir, "proj");
		mkdirSync(top, { recursive: true });
		const real = realpathSync(top);
		const exec = canned({
			"rev-parse --show-toplevel --git-common-dir": ok(`${real}\n${real}/.git\n`),
			remote: ok("origin\nupstream\n"),
			"remote get-url origin": ok("git@github.com:Acme/Widget.git\n"),
		});
		assert.deepEqual(await resolveProject(real, exec), {
			kind: "git",
			key: "git:github.com/acme/widget",
			root: real,
		});
	});

	it("falls back to the first alphabetical remote without an origin", async () => {
		const top = join(dir, "proj");
		mkdirSync(top, { recursive: true });
		const real = realpathSync(top);
		const exec = canned({
			"rev-parse --show-toplevel --git-common-dir": ok(`${real}\n${real}/.git\n`),
			remote: ok("upstream\nfork\n"),
			"remote get-url fork": ok("https://github.com/Acme/Widget\n"),
		});
		assert.deepEqual(await resolveProject(real, exec), {
			kind: "git",
			key: "git:github.com/acme/widget",
			root: real,
		});
	});

	it("shares one path key across worktrees via the common dir", async () => {
		const main = join(dir, "main");
		mkdirSync(join(main, ".git"), { recursive: true });
		const realMain = realpathSync(main);
		const exec = canned({
			"rev-parse --show-toplevel --git-common-dir": ok(`${join(dir, "wt")}\n${realMain}/.git\n`),
			remote: ok("\n"),
		});
		const identity = await resolveProject(join(dir, "wt"), exec);
		assert.deepEqual(identity, { kind: "path", key: `path:${realMain}`, root: realMain });
	});

	it("uses the toplevel when the common dir does not end in /.git", async () => {
		const top = join(dir, "proj");
		mkdirSync(top, { recursive: true });
		const real = realpathSync(top);
		const exec = canned({
			"rev-parse --show-toplevel --git-common-dir": ok(`${real}\n${real}\n`),
			remote: ok("\n"),
		});
		assert.deepEqual(await resolveProject(real, exec), {
			kind: "path",
			key: `path:${real}`,
			root: real,
		});
	});

	it("falls back to the cwd path outside a repo", async () => {
		const exec = canned({
			"rev-parse --show-toplevel --git-common-dir": { code: 128, stdout: "", stderr: "not a repo" },
		});
		assert.deepEqual(await resolveProject(dir, exec), {
			kind: "path",
			key: `path:${dir}`,
			root: dir,
		});
	});

	it("never throws when git fails", async () => {
		const exec = canned({
			"rev-parse --show-toplevel --git-common-dir": new Error("timed out"),
		});
		assert.deepEqual(await resolveProject(dir, exec), {
			kind: "path",
			key: `path:${dir}`,
			root: dir,
		});
	});
});

afterEach(() => {
	// Temp dirs live under the OS tmpdir and are cleaned by the OS; nothing to do.
});
