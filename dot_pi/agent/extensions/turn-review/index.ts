/**
 * turn-review — `/review` sends the last agent turn's file changes to tuicr.
 *
 * `/review` takes no arguments. It waits until omp-undo-redo has recorded the last
 * turn, then diffs the previous review (or the session's first snapshot) against
 * the latest omp `after` snapshot. It runs tuicr full screen in the same terminal
 * and pastes a `y` export into the editor. Only an export marks the round as
 * reviewed. The readiness check matches omp's checkpoint `parentLeafId` against the
 * leaf read in `before_agent_start`. This assumes no extension appends session
 * entries inside `before_agent_start`. If that is violated, the cost is a spurious
 * wait that Esc dismisses, never a wrong diff. Pi-free logic lives in `omp.ts`,
 * `git.ts`, and `state.ts`.
 */

import { spawnSync } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { hasObject, materialize, treeOf } from "./git.ts";
import {
	historyPathFor,
	isCaughtUp,
	pickSnapshots,
	readHistory,
	resolveRepo,
	storeDirFor,
	storeRoot,
	turnCheckpoint,
	type History,
	type PendingTurn,
} from "./omp.ts";
import { CUSTOM_TYPE, latestMarker } from "./state.ts";

/** Readiness state for the agent turn that is in flight or just finished in this process. */
let pending: PendingTurn | undefined;

/** Registers the `/review` command and the turn lifecycle listeners. */
export default function turnReview(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (_event, ctx) => onBeforeAgentStart(ctx));
	pi.on("agent_settled", () => onAgentSettled());
	pi.on("session_start", () => onSessionStart());
	pi.registerCommand("review", {
		description: "Review the last agent turn's file changes in tuicr",
		handler: (args, ctx) => handleReview(pi, args, ctx),
	});
}

/** Records the leaf id that omp will read as `parentLeafId` for this turn. */
function onBeforeAgentStart(ctx: ExtensionContext): void {
	pending = { turnStartLeaf: ctx.sessionManager.getLeafId() };
}

/** Marks the pending turn as settled at the current time. */
function onAgentSettled(): void {
	if (pending !== undefined) {
		pending.settledAt = Date.now();
	}
}

/** Drops pending state, since a freshly loaded or switched session has nothing in flight. */
function onSessionStart(): void {
	pending = undefined;
}

/**
 * Runs `/review`: guards, repo and history lookup, readiness wait, head and base
 * selection, the empty-round check, review commit materialization, tuicr, and the result.
 * Every error message starts with "/review:".
 */
async function handleReview(pi: ExtensionAPI, _args: string, ctx: ExtensionCommandContext): Promise<void> {
	const notify = (message: string, level: "info" | "warning" | "error") =>
		ctx.ui.notify(message.startsWith("/review") ? message : `/review: ${message}`, level);
	if (ctx.mode !== "tui") {
		return notify("/review needs the interactive TUI", "error");
	}
	if (!ctx.isIdle()) {
		return notify("wait for the agent to finish", "warning");
	}
	try {
		const repo = resolveRepo(ctx.cwd);
		const storeDir = storeDirFor(storeRoot(), repo.commonDir);
		const sessionId = ctx.sessionManager.getSessionId();

		let recorded: { history: History; mtimeMs: number } | undefined;
		try {
			recorded = readHistory(storeDir, sessionId);
		} catch (error) {
			if (pending === undefined) {
				throw error;
			}
		}
		if (recorded === undefined || !isCaughtUp(recorded.history, pending, recorded.mtimeMs)) {
			const caughtUp = await waitForCaughtUp(ctx, storeDir, sessionId);
			if (!caughtUp && !(await confirmReviewPrevious(ctx))) {
				return;
			}
		}
		const { history } = readHistory(storeDir, sessionId);

		const turn = pending === undefined ? undefined : turnCheckpoint(history, pending.turnStartLeaf);
		if (turn?.kind === "session") {
			notify(
				`last turn has no file snapshot (${turn.reason ?? "unknown reason"}); its changes will show up in the next round`,
				"warning",
			);
		}

		const snapshots = pickSnapshots(history);
		if (snapshots.head === undefined) {
			return notify("no snapshots to review yet", "info");
		}
		const head = snapshots.head;
		const worktree = history.worktree;
		const storeObjects = join(storeDir, "objects");
		const alt = { cwd: worktree, alternateObjects: storeObjects };
		if (!hasObject(alt, head)) {
			throw new Error(`latest snapshot ${head.slice(0, 7)} is missing (expired?)`);
		}

		const marker = latestMarker(ctx.sessionManager.getBranch());
		let base: string;
		let exclude: string[] = [];
		if (marker !== undefined && hasObject({ cwd: worktree }, marker.reviewCommit)) {
			base = marker.reviewCommit;
			exclude = [base];
		} else {
			if (marker !== undefined) {
				notify("previous review commit is gone; reviewing the whole session", "warning");
			}
			const first = snapshots.earliestBefore.find((sha) => hasObject(alt, sha));
			if (first === undefined) {
				throw new Error("no surviving before-snapshot for this session");
			}
			base = first;
		}

		if (treeOf(alt, base) === treeOf(alt, head)) {
			return notify(`nothing to review since ${base.slice(0, 7)}`, "info");
		}

		const reviewCommit = materialize({ base, head, worktree, storeObjects, exclude });
		const result = await runTuicr(ctx, worktree, base, reviewCommit);
		if (result.spawnErrorCode === "ENOENT") {
			throw new Error("tuicr not found on PATH");
		}
		if (result.status !== 0) {
			throw new Error(`tuicr exited with an error${result.stderrTail === "" ? "" : `: ${result.stderrTail}`}`);
		}

		if (result.stdout.trim() === "") {
			return notify("no export; round not marked reviewed — /review reopens it", "info");
		}
		ctx.ui.pasteToEditor(result.stdout.trimEnd());
		pi.appendEntry(CUSTOM_TYPE, { v: 1, base, head, reviewCommit, slug: result.slug, at: new Date().toISOString() });
		notify("review comments added to the editor — press Enter to send", "info");
	} catch (error) {
		notify(error instanceof Error ? error.message : String(error), "error");
	}
}

/**
 * Waits in `ctx.ui.custom` with a BorderedLoader until omp has recorded the last turn.
 * Watches the history directory with fs.watch, re-checks once after installing the watcher,
 * and re-checks every 1 s. Resolves true when caught up, false on Esc.
 */
async function waitForCaughtUp(ctx: ExtensionCommandContext, storeDir: string, sessionId: string): Promise<boolean> {
	const historyDir = dirname(historyPathFor(storeDir, sessionId));
	return ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, "Waiting for omp-undo-redo to record the last turn… (Esc to stop waiting)");
		let watcher: FSWatcher | undefined;
		let interval: NodeJS.Timeout | undefined;
		let finished = false;
		const finish = (caughtUp: boolean) => {
			if (finished) {
				return;
			}
			finished = true;
			watcher?.close();
			clearInterval(interval);
			done(caughtUp);
		};
		const check = () => {
			if (finished) {
				return;
			}
			try {
				const recorded = readHistory(storeDir, sessionId);
				if (isCaughtUp(recorded.history, pending, recorded.mtimeMs)) {
					finish(true);
				}
			} catch {
				// Not written yet, or being replaced by a rename; the next event or tick re-checks.
			}
		};
		loader.onAbort = () => finish(false);
		try {
			watcher = watch(historyDir, check);
			watcher.on("error", () => watcher?.close());
		} catch {
			// The history directory does not exist yet; the interval re-checks.
		}
		interval = setInterval(check, 1000);
		setImmediate(check);
		return loader;
	});
}

/**
 * Offers "Review up to the previous snapshot" or "Cancel" after an Esc from the readiness wait.
 * Resolves true only for the first choice. Cancel or dismiss resolves false.
 */
async function confirmReviewPrevious(ctx: ExtensionCommandContext): Promise<boolean> {
	const choice = await ctx.ui.select("omp-undo-redo hasn't recorded the last turn yet", [
		"Review up to the previous snapshot",
		"Cancel",
	]);
	return choice === "Review up to the previous snapshot";
}

/** Outcome of one tuicr run. */
interface TuicrResult {
	/** Export text printed by tuicr on `y`, empty on `q`. */
	stdout: string;
	/** Last lines of stderr, excluding `tuicr-session:` lines. */
	stderrTail: string;
	/** Session slug parsed from `tuicr-session: <slug>` on stderr. */
	slug?: string;
	/** Process exit status, or null when it did not exit normally. */
	status: number | null;
	/** Spawn error, such as ENOENT when tuicr is not on PATH. */
	spawnErrorCode?: string;
}

/**
 * Suspends the pi TUI and runs `tuicr --no-update-check --stdout -r <base>..<reviewCommit>`
 * in `worktree` with the same terminal. Restarts the TUI on every path and returns the result.
 */
async function runTuicr(
	ctx: ExtensionCommandContext,
	worktree: string,
	base: string,
	reviewCommit: string,
): Promise<TuicrResult> {
	return ctx.ui.custom<TuicrResult>((tui, _theme, _keybindings, done) => {
		tui.stop();
		process.stdout.write("\x1b[2J\x1b[H");
		const child = spawnSync("tuicr", ["--no-update-check", "--stdout", "-r", `${base}..${reviewCommit}`], {
			cwd: worktree,
			stdio: ["inherit", "pipe", "pipe"],
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			env: process.env,
		});
		tui.start();
		tui.requestRender(true);
		const stderr = child.stderr ?? "";
		const stderrTail = stderr
			.split("\n")
			.filter((line) => line.trim() !== "" && !line.startsWith("tuicr-session:"))
			.slice(-5)
			.join("\n");
		done({
			stdout: child.stdout ?? "",
			stderrTail,
			slug: parseSlug(stderr),
			status: child.status,
			spawnErrorCode: (child.error as NodeJS.ErrnoException | undefined)?.code,
		});
		return { render: () => [], invalidate: () => {} };
	});
}

/** Parses the session slug from tuicr stderr. Returns undefined when no `tuicr-session:` line exists. */
function parseSlug(stderr: string): string | undefined {
	return /^tuicr-session: (.+)$/m.exec(stderr)?.[1]?.trim();
}
