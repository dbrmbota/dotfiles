// Reports Pi's blocking user-facing prompts to Herdr as "blocked".
//
// The managed Herdr integration (~/.pi/agent/extensions/herdr-agent-state.ts,
// written by `herdr integration install pi`) learns that Pi needs the user from
// a custom `herdr:blocked` event, but nothing emits it. Pi itself emits
// `ui_prompt_start` / `ui_prompt_end` around every blocking `ctx.ui.*` dialog
// (select/confirm/input/editor/custom) — including the approval prompts from
// pi-permission-modes — so this companion translates one into the other.
//
// Without it, Herdr's Pi integration has "lifecycle authority" and skips its
// screen-based fallback, so the pane stays "working" while a prompt is open and
// no needs-input notification is ever sent.
//
// Keep this beside herdr-agent-state.ts: reinstalling/updating the Herdr
// integration overwrites that file but leaves this one alone.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const KIND_LABEL: Record<string, string> = {
	select: "Waiting for a choice",
	confirm: "Waiting for confirmation",
	input: "Waiting for input",
	editor: "Waiting for editor input",
	custom: "Waiting for input",
};

export default function (pi: ExtensionAPI) {
	// Only Herdr consumes this event; stay a no-op outside a Herdr pane.
	if (process.env.HERDR_ENV !== "1") return;

	pi.on("ui_prompt_start", (event) => {
		pi.events.emit("herdr:blocked", {
			active: true,
			label: event.title ?? KIND_LABEL[event.kind] ?? "Waiting for input",
		});
	});

	pi.on("ui_prompt_end", () => {
		pi.events.emit("herdr:blocked", { active: false });
	});
}
