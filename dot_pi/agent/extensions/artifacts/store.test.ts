import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	ARTIFACT_NAME_RE,
	ARTIFACT_TYPES,
	artifactPath,
	artifactsRoot,
	deleteArtifact,
	listArtifacts,
	projectDirName,
	projectDirPath,
	readArtifact,
	titleOf,
	writeArtifact,
} from "./store.ts";

let root: string;
let projectDir: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "pi-artifacts-store-")));
	projectDir = join(root, "proj");
	mkdirSync(projectDir, { recursive: true });
});

/** Write a file under projectDir and set its mtime (ms). */
function place(relative: string, content: string, mtimeMs: number): string {
	const file = join(projectDir, relative);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, content);
	utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
	return file;
}

describe("ARTIFACT_TYPES and ARTIFACT_NAME_RE", () => {
	it("lists the three artifact types", () => {
		assert.deepEqual([...ARTIFACT_TYPES], ["task", "plan", "report"]);
	});

	it("accepts compound names and rejects bad edges, slashes, and uppercase", () => {
		for (const name of ["a", "fix-x", "v1.2", "a_b-c.d", "0"]) {
			assert.ok(ARTIFACT_NAME_RE.test(name), name);
		}
		for (const name of ["", "-x", "x-", "x--y", "x/y", "Foo", "x y", ".x", "x."]) {
			assert.ok(!ARTIFACT_NAME_RE.test(name), name);
		}
	});
});

describe("artifactsRoot", () => {
	it("is ~/.pi/agent/artifacts", () => {
		assert.equal(artifactsRoot(), join(homedir(), ".pi", "agent", "artifacts"));
	});
});

describe("projectDirName", () => {
	const identity = { key: "git:github.com/acme/widget", root: "/Users/me/src/widget" };

	it("is stable for one key and is the last key segment plus 8 hex chars", () => {
		const name = projectDirName(identity);
		assert.match(name, /^widget-[0-9a-f]{8}$/);
		assert.equal(projectDirName(identity), name);
	});

	it("uses the last segment of a path key for a project without a remote", () => {
		assert.match(projectDirName({ key: "path:/Users/me/src/proj" }), /^proj-[0-9a-f]{8}$/);
	});

	it("gives different names for different keys", () => {
		const other = { key: "git:github.com/acme/gadget", root: identity.root };
		assert.notEqual(projectDirName(other), projectDirName(identity));
	});

	it("gives a worktree with another folder name the same name as the main checkout", () => {
		const worktree = { key: identity.key, root: "/Users/me/src/wt-fix" };
		assert.equal(projectDirName(worktree), projectDirName(identity));
	});
});

describe("projectDirPath and artifactPath", () => {
	it("joins the root with the project directory name", () => {
		const identity = { key: "path:/x/proj", root: "/x/proj" };
		assert.equal(projectDirPath("/store", identity), join("/store", projectDirName(identity)));
	});

	it("builds <projectDir>/<type>/<name>.md", () => {
		assert.equal(artifactPath("/store/proj-1", "plan", "fix-x"), join("/store/proj-1", "plan", "fix-x.md"));
	});
});

describe("writeArtifact and readArtifact", () => {
	it("creates missing parent directories and leaves no temp file behind", () => {
		const path = artifactPath(projectDir, "task", "fix-x");
		writeArtifact(path, "# Fix X\n\nbody\n");
		assert.equal(readArtifact(path), "# Fix X\n\nbody\n");
		assert.deepEqual(readdirSync(join(projectDir, "task")), ["fix-x.md"]);
	});

	it("replaces the content of an existing artifact", () => {
		const path = artifactPath(projectDir, "plan", "slug");
		writeArtifact(path, "first");
		writeArtifact(path, "second");
		assert.equal(readArtifact(path), "second");
		assert.deepEqual(readdirSync(join(projectDir, "plan")), ["slug.md"]);
	});
});

describe("listArtifacts", () => {
	it("returns [] when the project directory is missing", () => {
		assert.deepEqual(listArtifacts(join(root, "missing")), []);
	});

	it("sorts by mtime, newest first, with path, title, and mtime", () => {
		const alpha = place("task/alpha.md", "# Alpha task\n", 1_000_000);
		const beta = place("plan/beta.md", "Beta plan line\n", 3_000_000);
		const gamma = place("report/gamma.md", "# Gamma\n", 2_000_000);
		assert.deepEqual(listArtifacts(projectDir), [
			{ type: "plan", name: "beta", path: beta, title: "Beta plan line", mtimeMs: 3_000_000 },
			{ type: "report", name: "gamma", path: gamma, title: "Gamma", mtimeMs: 2_000_000 },
			{ type: "task", name: "alpha", path: alpha, title: "Alpha task", mtimeMs: 1_000_000 },
		]);
	});

	it("skips invalid names, non-.md files, directories, and unknown type directories", () => {
		const keep = place("task/keep.md", "# Keep\n", 1_000_000);
		place("task/Bad.md", "x", 1_000_000);
		place("task/.hidden.md", "x", 1_000_000);
		place("task/notes.txt", "x", 1_000_000);
		place("task/.write-temp.tmp", "x", 1_000_000);
		mkdirSync(join(projectDir, "task", "dir.md"));
		place("misc/other.md", "x", 1_000_000);
		assert.deepEqual(listArtifacts(projectDir), [
			{ type: "task", name: "keep", path: keep, title: "Keep", mtimeMs: 1_000_000 },
		]);
	});
});

describe("titleOf", () => {
	it("uses the first # heading", () => {
		assert.equal(titleOf("# Title\n\nbody"), "Title");
	});

	it("prefers a later # heading over an earlier plain line", () => {
		assert.equal(titleOf("Intro line\n# Later"), "Later");
	});

	it("ignores ## headings", () => {
		assert.equal(titleOf("## Sub\n# Top"), "Top");
	});

	it("falls back to the first non-empty line, trimmed", () => {
		assert.equal(titleOf("\n\n   first line   \nsecond"), "first line");
	});

	it("truncates to 80 characters", () => {
		assert.equal(titleOf(`# ${"x".repeat(100)}`).length, 80);
	});

	it("returns an empty string for empty content", () => {
		assert.equal(titleOf(""), "");
		assert.equal(titleOf("  \n \n"), "");
	});
});

describe("deleteArtifact", () => {
	it("removes the file", () => {
		const path = artifactPath(projectDir, "report", "r1");
		writeArtifact(path, "# R1\n");
		deleteArtifact(path);
		assert.equal(existsSync(path), false);
	});

	it("throws ENOENT when the file is missing", () => {
		assert.throws(() => deleteArtifact(artifactPath(projectDir, "report", "nope")), { code: "ENOENT" });
	});
});
