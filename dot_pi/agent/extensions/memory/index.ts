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
	// TODO: join the constant REMEMBER_PROMPT steps (exactly-once memory_write, self-contained <8k-token markdown with paths/identifiers, kebab-case name + one-sentence description, memory_find-first with overwrite on near-duplicate) plus `Additional instruction from me: <args>` when instructions are non-blank; no dependencies.
	throw new Error("not implemented");
}

/** Register tools, commands, autocomplete, and lifecycle handlers. */
export default function (pi: ExtensionAPI): void {
	// TODO: register memory_write (TypeBox params, sequential, armed-gate + validation + embed-first + transactional upsert + disarm/notify), memory_read (header + bump + fuzzy unknown-name error), memory_find (limit ≤20, ≤20-row backfill, FTS + KNN fused by rrfFuse, keyword-only suffix); register /remember (idle + active-tool checks, arm, sendUserMessage, agent_end disarm) and /memory edit|delete (argument completions, editor/confirm flows); wire session_start (resolveProject via pi.exec, autocomplete provider via ctx.ui, memory_read-active gating) + input passthrough (extractMemRefs unknown-name notify, always continue) + session_shutdown (store close); depends on ./store.ts, ./project.ts, ./embed.ts, ./refs.ts, typebox, @earendil-works/pi-tui fuzzyFilter, pi parseFrontmatter.
	throw new Error("not implemented");
}
