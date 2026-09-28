// Labels the Pi pane for the Herdr auto-name plugin.
//
// The auto-name plugin (local.auto-name) owns every pane label except Pi
// panes: while `agent == "pi"` it skips the pane, so this extension renames
// the Pi pane to `pi` (unnamed session) or `pi - <session name>` and then
// triggers a plugin sync so the tab prefix follows. On clean quit the label
// is cleared so the plugin reclaims the pane as an idle shell.
//
// Keep this beside herdr-agent-state.ts: reinstalling/updating the Herdr
// integration overwrites that file but leaves this one alone.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

const bin = process.env.HERDR_BIN_PATH || "herdr";
const paneId = process.env.HERDR_PANE_ID;

// `herdr pane rename <pane> <label>` (or --clear), then a plugin sync so the
// tab prefix follows. `$0` is the herdr binary, `$1` the pane, `$2` the label.
const SCRIPT =
	'if [ -n "$2" ]; then "$0" pane rename "$1" "$2"; ' +
	'else "$0" pane rename "$1" --clear; fi; ' +
	'"$0" plugin action invoke sync --plugin local.auto-name';

/** Session label for the pane: `pi` unnamed, `pi - <name>` otherwise. */
export function label(name: string | undefined): string {
	return name ? `pi - ${name}` : "pi";
}

let lastApplied: string | null | undefined;
let active = false;

/** Rename the Pi pane (or clear it when null), then trigger a plugin sync. */
export function apply(labelOrNull: string | null): void {
	if (labelOrNull === lastApplied) return;
	lastApplied = labelOrNull;
	try {
		spawn("/bin/sh", ["-c", SCRIPT, bin, paneId ?? "", labelOrNull ?? ""], {
			detached: true,
			stdio: "ignore",
		}).unref();
	} catch {
		// Best effort: a missing shell or herdr must never break the session.
	}
}

export default function (pi: ExtensionAPI) {
	// Only Herdr consumes pane labels; stay a no-op outside a Herdr pane.
	if (process.env.HERDR_ENV !== "1" || !paneId) return;

	pi.on("session_start", (_event, ctx) => {
		// TUI only: RPC/JSON/print modes are headless (no PTY herdr can display),
		// and RPC still reports hasUI=true, so mode is the reliable gate.
		if (ctx?.mode !== "tui") return;
		active = true;
		apply(label(pi.getSessionName()));
	});

	pi.on("session_info_changed", (event) => {
		if (!active) return;
		apply(label(event.name));
	});

	pi.on("session_shutdown", (event) => {
		if (!active) return;
		// A clean quit clears the label so the plugin reclaims the pane.
		// Other reasons are followed by a session_start, which relabels.
		if (event.reason === "quit") apply(null);
	});
}
