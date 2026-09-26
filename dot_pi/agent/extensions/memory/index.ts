/**
 * memory — project-scoped markdown memory with hybrid search.
 *
 * Pi wiring only: registers the `memory_write` / `memory_read` / `memory_find`
 * model tools, the `/remember` and `/memory` commands, the `@mem:`
 * autocomplete provider, and the `input` passthrough handler. Storage,
 * project identity, embeddings, and token helpers live in the pi-free
 * sibling modules (`store.ts`, `project.ts`, `embed.ts`, `refs.ts`) so they
 * can be unit-tested with `node --test` outside pi.
 *
 * Write gate: `memory_write` succeeds only once per `/remember`, controlled
 * by a runtime "armed" flag that is disarmed after the first successful write
 * and unconditionally on `agent_end`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fuzzyFilter } from "@earendil-works/pi-tui";

/** Prompt sent to the model by `/remember`, before optional instructions. */
export const REMEMBER_PROMPT: string = "not implemented";

/** Build the `/remember` prompt, appending user instructions when given. */
export function buildRememberPrompt(instructions: string): string {
	throw new Error("not implemented");
}

/** Register tools, commands, autocomplete, and lifecycle handlers. */
export default function (pi: ExtensionAPI): void {
	throw new Error("not implemented");
}
