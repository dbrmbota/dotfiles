/**
 * store — file-based storage for handoff artifacts (task, plan, report).
 *
 * Artifacts are plain markdown files at `<root>/<projectDir>/<type>/<name>.md`,
 * where the root is `~/.pi/agent/artifacts` and the project directory is
 * derived from the project identity. Files have no frontmatter. This module
 * never imports pi packages, so it can be unit-tested with `node --test`.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProjectIdentity } from "./project.ts";

/** Artifact types, which are also the type directory names under a project directory. */
export const ARTIFACT_TYPES = ["task", "plan", "report"] as const;

/** One of `ARTIFACT_TYPES`. */
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** Artifact names: lowercase alphanumeric segments joined by single `-`, `_`, or `.`. */
export const ARTIFACT_NAME_RE = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;

/** Longest title that `titleOf` returns. */
const TITLE_MAX_LENGTH = 80;

/** One artifact file found by `listArtifacts`. */
export interface ArtifactEntry {
	type: ArtifactType;
	name: string;
	/** Absolute path of the artifact file. */
	path: string;
	/** `titleOf` of the file content. */
	title: string;
	mtimeMs: number;
}

/** Root directory for all artifacts: `~/.pi/agent/artifacts`. */
export function artifactsRoot(): string {
	return join(homedir(), ".pi", "agent", "artifacts");
}

/**
 * Directory name for a project: `<last segment of identity.key>-<first 8 hex chars of sha256(identity.key)>`.
 * The key of a git project is its normalized remote, so every worktree of that repo gets the same name.
 */
export function projectDirName(identity: Pick<ProjectIdentity, "key">): string {
	const hash = createHash("sha256").update(identity.key).digest("hex").slice(0, 8);
	const repo = identity.key.slice(identity.key.lastIndexOf("/") + 1);
	return `${repo}-${hash}`;
}

/** Absolute project directory for an identity under `root`. The directory need not exist yet. */
export function projectDirPath(root: string, identity: Pick<ProjectIdentity, "key">): string {
	return join(root, projectDirName(identity));
}

/** Absolute path of the artifact file `<projectDir>/<type>/<name>.md`. Callers validate `name`. */
export function artifactPath(projectDir: string, type: ArtifactType, name: string): string {
	return join(projectDir, type, `${name}.md`);
}

/**
 * List the artifacts in a project directory, newest first by mtime. Skips files
 * whose name is invalid, whose extension is not `.md`, or that sit under an
 * unknown type directory. A missing project directory gives `[]`.
 */
export function listArtifacts(projectDir: string): ArtifactEntry[] {
	const entries: ArtifactEntry[] = [];
	for (const type of ARTIFACT_TYPES) {
		const typeDir = join(projectDir, type);
		let files: Dirent[];
		try {
			files = readdirSync(typeDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.isFile() || !file.name.endsWith(".md")) continue;
			const name = file.name.slice(0, -".md".length);
			if (!ARTIFACT_NAME_RE.test(name)) continue;
			const path = join(typeDir, file.name);
			try {
				entries.push({
					type,
					name,
					path,
					title: titleOf(readFileSync(path, "utf-8")),
					mtimeMs: statSync(path).mtimeMs,
				});
			} catch {
				// The file vanished between readdir and read; skip it.
			}
		}
	}
	return entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Read the content of an artifact file. Throws when the file is missing. */
export function readArtifact(path: string): string {
	return readFileSync(path, "utf-8");
}

/**
 * Write an artifact file, creating its parent directories. The content goes to a
 * temporary file in the same directory first and is then renamed into place.
 */
export function writeArtifact(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, content);
		renameSync(tmp, path);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw err;
	}
}

/** Delete an artifact file. Throws when the file is missing. */
export function deleteArtifact(path: string): void {
	unlinkSync(path);
}

/**
 * Title of an artifact: the text of the first `# ` heading, else the first
 * non-empty line, trimmed and cut to 80 characters. Returns `""` for empty content.
 */
export function titleOf(content: string): string {
	const lines = content.split("\n");
	const heading = lines.find((line) => line.trimStart().startsWith("# "));
	const chosen = heading !== undefined ? heading.trimStart().slice(2) : lines.find((line) => line.trim() !== "");
	return (chosen ?? "").trim().slice(0, TITLE_MAX_LENGTH);
}
