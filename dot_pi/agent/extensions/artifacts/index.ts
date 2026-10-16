/**
 * artifacts — markdown handoff files (task, plan, report) per project.
 *
 * Pi wiring only: the `/task` and `/report` commands ask the active agent to
 * save an artifact with its `write` tool, `/artifact` edits, deletes, and
 * picks artifacts, the `@task:` / `@plan:` / `@report:` autocomplete and the
 * `input` handler replace references with absolute paths, and the project's
 * artifact directory is published as `ARTIFACTS_PATH` over `agents:vars`.
 * Storage, identity, and reference helpers live in the pi-free sibling modules
 * (`store.ts`, `project.ts`, `refs.ts`).
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { resolveProject, type ExecFn } from "./project.ts";
import {
	applyRefCompletion,
	buildRefHint,
	buildRefSuggestions,
	buildStorePrompt,
	completeArtifactArgs,
	extractRefToken,
	isRefHintToken,
	parseArtifactArg,
	substituteRefs,
	type StorableType,
} from "./refs.ts";
import {
	artifactPath,
	artifactsRoot,
	deleteArtifact,
	listArtifacts,
	projectDirPath,
	readArtifact,
	writeArtifact,
	type ArtifactEntry,
	type ArtifactType,
} from "./store.ts";

/** Usage line for `/artifact` when the arguments are not understood. */
const ARTIFACT_USAGE = "Usage: /artifact [edit|delete @type:name]";

/** Path of the artifact `@type:name` when that file exists under `projectDir`, else undefined. */
function resolveRefPath(projectDir: string, type: ArtifactType, name: string): string | undefined {
	const path = artifactPath(projectDir, type, name);
	try {
		return statSync(path).isFile() ? path : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Wrap the host's autocomplete provider. Claims `@task:` / `@plan:` /
 * `@report:` tokens and their hints, and delegates everything else. `entries`
 * is read on each call so the list stays current.
 */
function createAutocompleteProvider(
	current: AutocompleteProvider,
	entries: () => ArtifactEntry[],
): AutocompleteProvider {
	return {
		// `:` retriggers the session, so typing `@plan:` (or retyping `:` after
		// accepting a hint) always opens the recents.
		triggerCharacters: [":"],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const token = extractRefToken(before);
			if (token) {
				const items = buildRefSuggestions(entries(), token.type, token.query, fuzzyFilter, Date.now());
				if (items.length > 0) {
					return { items, prefix: before.slice(before.lastIndexOf("@")) };
				}
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}
			const hints = isRefHintToken(before);
			if (hints.length > 0) {
				const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);
				const prefix = before.slice(before.lastIndexOf("@"));
				const hintItems = hints.map((type) => buildRefHint(type));
				if (base && base.prefix === prefix) return { items: [...hintItems, ...base.items], prefix };
				if (!base) return { items: hintItems, prefix };
				return base;
			}
			return current.getSuggestions(lines, cursorLine, cursorCol, options);
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const line = lines[cursorLine] ?? "";
			const applied = applyRefCompletion(line.slice(0, cursorCol), line.slice(cursorCol), item.value, prefix);
			if (applied) {
				const nextLines = [...lines];
				nextLines[cursorLine] = applied.text;
				return { lines: nextLines, cursorLine, cursorCol: applied.cursorCol };
			}
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
			if (extractRefToken(before) !== undefined || isRefHintToken(before).length > 0) return true;
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

/**
 * Run `/task` or `/report`: require an idle session and an active `write` tool,
 * then send the store prompt with the project's type directory for `type`.
 */
function runStoreCommand(
	pi: ExtensionAPI,
	type: StorableType,
	args: string,
	ctx: ExtensionCommandContext,
	projectDir: string | null,
): void {
	if (projectDir === null) {
		ctx.ui.notify("artifacts: the project could not be resolved", "warning");
		return;
	}
	if (!ctx.isIdle()) {
		ctx.ui.notify(`/${type}: wait for the agent to finish its reply`, "warning");
		return;
	}
	if (!pi.getActiveTools().includes("write")) {
		ctx.ui.notify(`/${type}: the active agent has no write tool`, "error");
		return;
	}
	pi.sendUserMessage(buildStorePrompt(type, join(projectDir, type), args.trim()));
}

/**
 * Run `/artifact`. With no arguments, open the picker. With `edit` or `delete`
 * and an `@type:name` argument, edit or delete that artifact. Other input
 * prints the usage line or the unknown name.
 */
async function runArtifactCommand(
	args: string,
	ctx: ExtensionCommandContext,
	projectDir: string | null,
): Promise<void> {
	if (projectDir === null) {
		ctx.ui.notify("artifacts: the project could not be resolved", "warning");
		return;
	}
	const entries = listArtifacts(projectDir);
	const trimmed = args.trim();
	if (trimmed === "") {
		if (entries.length === 0) {
			ctx.ui.notify("No artifacts yet.", "info");
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify(ARTIFACT_USAGE, "info");
			return;
		}
		const picked = await pickArtifact(ctx, entries);
		if (!picked) return;
		const action = await ctx.ui.select(`${picked.type}:${picked.name}`, ["Insert reference", "Edit", "Delete"]);
		if (action === "Insert reference") ctx.ui.pasteToEditor(`@${picked.type}:${picked.name} `);
		else if (action === "Edit") await editArtifact(ctx, picked);
		else if (action === "Delete") await removeArtifact(ctx, picked);
		return;
	}
	const [sub, ...rest] = trimmed.split(/\s+/);
	const ref = parseArtifactArg(rest.join(" "));
	if ((sub !== "edit" && sub !== "delete") || !ref) {
		ctx.ui.notify(ARTIFACT_USAGE, "info");
		return;
	}
	const entry = entries.find((candidate) => candidate.type === ref.type && candidate.name === ref.name);
	if (!entry) {
		ctx.ui.notify(`Unknown artifact: ${ref.type}:${ref.name}`, "error");
		return;
	}
	if (sub === "edit") await editArtifact(ctx, entry);
	else await removeArtifact(ctx, entry);
}

/** Show a select list of artifacts (newest first) and return the chosen one. */
async function pickArtifact(ctx: ExtensionCommandContext, entries: ArtifactEntry[]): Promise<ArtifactEntry | undefined> {
	const options = entries.map((entry) => `${entry.type}:${entry.name} — ${entry.title}`);
	const choice = await ctx.ui.select("Artifacts", options);
	if (choice === undefined) return undefined;
	return entries[options.indexOf(choice)];
}

/**
 * Open the artifact in the editor and save it when the text changed and is not empty.
 * An empty result shows an error that points to `/artifact delete`.
 */
async function editArtifact(ctx: ExtensionCommandContext, entry: ArtifactEntry): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/artifact edit needs an interactive UI", "error");
		return;
	}
	const content = readArtifact(entry.path);
	const edited = await ctx.ui.editor(`Edit ${entry.type}:${entry.name}`, content);
	if (edited === undefined || edited === content) return;
	if (edited.trim() === "") {
		ctx.ui.notify(`Empty artifact: use /artifact delete @${entry.type}:${entry.name} to remove it`, "error");
		return;
	}
	writeArtifact(entry.path, edited);
	ctx.ui.notify(`Updated ${entry.type}:${entry.name}`, "info");
}

/** Confirm, then delete the artifact file. */
async function removeArtifact(ctx: ExtensionCommandContext, entry: ArtifactEntry): Promise<void> {
	const confirmed = await ctx.ui.confirm("Delete artifact?", `${entry.type}:${entry.name} — ${entry.title}`);
	if (!confirmed) return;
	deleteArtifact(entry.path);
	ctx.ui.notify(`Deleted ${entry.type}:${entry.name}`, "info");
}

/** Register the `input` handler, the commands, the autocomplete provider, and the lifecycle handlers. */
export default function (pi: ExtensionAPI): void {
	let projectDir: string | null = null;
	let autocompleteRegistered = false;

	const execFn: ExecFn = (command, args, options) =>
		pi.exec(command, args, { cwd: options.cwd, timeout: options.timeout });
	const listEntries = (): ArtifactEntry[] => (projectDir ? listArtifacts(projectDir) : []);

	pi.on("session_start", async (_event, ctx) => {
		try {
			const identity = await resolveProject(ctx.cwd, execFn);
			projectDir = projectDirPath(artifactsRoot(), identity);
		} catch {
			projectDir = null;
		}
		if (projectDir === null && ctx.hasUI) {
			ctx.ui.notify("artifacts: the project could not be resolved; artifact features are disabled", "warning");
		}
		pi.events.emit("agents:vars", { ARTIFACTS_PATH: projectDir });
		if (!autocompleteRegistered) {
			autocompleteRegistered = true;
			ctx.ui.addAutocompleteProvider((current) => createAutocompleteProvider(current, listEntries));
		}
	});

	pi.on("session_shutdown", () => {
		pi.events.emit("agents:vars", { ARTIFACTS_PATH: null });
		projectDir = null;
	});

	pi.on("input", (event, ctx) => {
		const dir = projectDir;
		if (dir === null) return { action: "continue" };
		const result = substituteRefs(event.text, (type, name) => resolveRefPath(dir, type, name));
		if (result.unknown.length > 0) {
			ctx.ui.notify(`Unknown artifact: ${result.unknown.join(", ")}`, "warning");
		}
		if (result.text === event.text) return { action: "continue" };
		return { action: "transform", text: result.text };
	});

	for (const type of ["task", "report"] as const) {
		pi.registerCommand(type, {
			description: `Ask the active agent to save a ${type} artifact`,
			handler: async (args, ctx) => runStoreCommand(pi, type, args, ctx, projectDir),
		});
	}

	pi.registerCommand("artifact", {
		description: "Edit, delete, or pick artifacts",
		getArgumentCompletions: (prefix) => {
			const items = completeArtifactArgs(prefix, listEntries(), fuzzyFilter);
			return items.length > 0 ? items : null;
		},
		handler: (args, ctx) => runArtifactCommand(args, ctx, projectDir),
	});
}
