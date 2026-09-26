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

import {
	parseFrontmatter,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { countTokens, embedTexts, isWithinTokenLimit, MAX_EMBED_TOKENS, type EmbedOutcome } from "./embed.ts";
import { resolveProject, type ExecFn } from "./project.ts";
import {
	applyMemCompletion,
	buildMemHint,
	buildMemSuggestions,
	completeMemoryArgs,
	extractMemRefs,
	extractMemToken,
	isMemHintToken,
	serializeMemoryEdit,
	parseMemoryEdit,
	validateDescription,
	validateName,
} from "./refs.ts";
import { MemoryStore, rrfFuse, type MemoryRecord } from "./store.ts";

/** Prompt sent to the model by `/remember`, before optional instructions. */
export const REMEMBER_PROMPT = [
	"Call memory_write exactly once to store what is worth remembering from this conversation.",
	"Summarize the relevant findings, ideas, plan, or decisions from this conversation as self-contained markdown under 8k tokens. Include context, rationale, and concrete file paths or identifiers, so it makes sense in a future session without this conversation.",
	"Choose a short kebab-case name and a one-sentence description.",
	"Call memory_find first. If a closely related entry exists, update it with overwrite: true instead of creating a duplicate.",
].join("\n");

/** Build the `/remember` prompt, appending user instructions when given. */
export function buildRememberPrompt(instructions: string): string {
	const extra = instructions.trim();
	return extra ? `${REMEMBER_PROMPT}\n\nAdditional instruction from me: ${extra}` : REMEMBER_PROMPT;
}

/** Result when no project has been resolved (session_start failed). */
const NO_PROJECT_ERROR = "memory is unavailable: the project could not be resolved for this session.";

/** Format an epoch-ms timestamp as YYYY-MM-DD. */
function formatDate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/** Register tools, commands, autocomplete, and lifecycle handlers. */
export default function (pi: ExtensionAPI): void {
	let armed = false;
	let store: MemoryStore | null = null;
	let projectId: number | null = null;
	let vectorWarned = false;
	let autocompleteRegistered = false;

	const getStore = (): MemoryStore => (store ??= new MemoryStore());
	const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
	const execFn: ExecFn = (command, args, options) =>
		pi.exec(command, args, { cwd: options.cwd, timeout: options.timeout });

	/** Resolve the OpenRouter key from pi, falling back to the environment. */
	async function resolveApiKey(ctx: ExtensionContext): Promise<string | undefined> {
		try {
			const key = await ctx.modelRegistry.getApiKeyForProvider("openrouter");
			if (key) return key;
		} catch {
			// Fall through to the environment variable.
		}
		return process.env.OPENROUTER_API_KEY;
	}

	/** Embed content strings with runtime fetch/sleep; typed outcome, throws only on abort. */
	function embedContents(
		contents: string[],
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
	): Promise<EmbedOutcome> {
		return resolveApiKey(ctx).then((apiKey) =>
			embedTexts(
				contents,
				{ apiKey, signal },
				{ fetch: (url, init) => globalThis.fetch(url, init), sleep },
			),
		);
	}

	/** Show the FTS-only mismatch warning once per runtime. */
	function maybeWarnVectors(ctx: ExtensionContext): void {
		const current = getStore();
		if (!current.vectorsAvailable && !vectorWarned) {
			vectorWarned = true;
			ctx.ui.notify(current.vectorWarning ?? "memory: vector search is disabled", "warning");
		}
	}

	/** Throw unless the project was resolved in session_start. */
	function requireProject(): number {
		if (projectId === null) throw new Error(NO_PROJECT_ERROR);
		return projectId;
	}

	pi.registerTool({
		name: "memory_write",
		label: "Memory write",
		description: "Store a project-scoped markdown memory (finding, idea, plan, or decision) for future sessions.",
		promptGuidelines: ["Only call memory_write when the user has run /remember; otherwise it fails."],
		parameters: Type.Object({
			name: Type.String({ description: "Short kebab-case memory name, e.g. auth-flow" }),
			description: Type.String({ description: "One sentence saying what the memory is about" }),
			content: Type.String({ description: "Self-contained markdown under 8k tokens" }),
			overwrite: Type.Optional(Type.Boolean({ description: "Set true to update the existing entry with this name" })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!armed) {
				throw new Error("memory_write is only allowed after the user runs /remember. Do not retry.");
			}
			const current = getStore();
			const pid = requireProject();
			const nameError = validateName(params.name);
			if (nameError) throw new Error(`invalid name: ${nameError}`);
			const description = params.description.trim();
			const descriptionError = validateDescription(params.description);
			if (descriptionError) throw new Error(`invalid description: ${descriptionError}`);
			const content = params.content.trim();
			if (content.length === 0) throw new Error("content must not be empty");
			if (!isWithinTokenLimit(content)) {
				const tokens = countTokens(content);
				throw new Error(
					`content is ${tokens} tokens; the limit is ${MAX_EMBED_TOKENS} — condense it or split into separate memories`,
				);
			}
			const existing = current.getMemory(pid, params.name);
			if (existing && !params.overwrite) {
				throw new Error(
					`memory "${params.name}" already exists (description: "${existing.description}", updated ${formatDate(existing.updatedAt)}). ` +
						"Pick a new name or retry with overwrite: true if updating that entry is intended.",
				);
			}
			maybeWarnVectors(ctx);
			const contentChanged = !existing || existing.content !== content;
			let embedding: number[] | null = null;
			let pendingReason: string | undefined;
			if (contentChanged && current.vectorsAvailable) {
				const outcome = await embedContents([content], ctx, signal);
				if (outcome.ok) embedding = outcome.embeddings[0];
				else pendingReason = outcome.reason;
			} else if (contentChanged) {
				pendingReason = current.vectorWarning ?? "vector search is disabled";
			}
			const { created } = current.upsertMemory(pid, params.name, description, content, embedding);
			if (contentChanged && embedding === null) {
				const row = current.getMemory(pid, params.name);
				if (row && row.embeddingModel !== null) current.setVector(row.id, pid, null);
			}
			armed = false;
			ctx.ui.notify(`Remembered: ${params.name}`);
			let text = `Stored "${params.name}" (${created ? "created" : "updated"})`;
			if (pendingReason) text += ` — semantic index pending: ${pendingReason}`;
			return { content: [{ type: "text", text }] };
		},
	});

	pi.registerTool({
		name: "memory_read",
		label: "Memory read",
		description: "Read one project-scoped markdown memory by name, with its full content.",
		promptGuidelines: ["When a user message contains `@mem:<name>`, call memory_read with that name before answering."],
		parameters: Type.Object({
			name: Type.String({ description: "Memory name, e.g. auth-flow (or the @mem:<name> reference)" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const current = getStore();
			const pid = requireProject();
			const record = current.readMemory(pid, params.name);
			if (!record) {
				const candidates = fuzzyFilter(current.listRecent(pid, 500), params.name, (row) => row.name).slice(0, 3);
				const hint =
					candidates.length > 0
						? ` Did you mean: ${candidates.map((row) => `"${row.name}" — ${row.description}`).join("; ")}?`
						: "";
				throw new Error(`unknown memory "${params.name}".${hint}`);
			}
			return {
				content: [
					{
						type: "text",
						text: `${record.name} · ${record.description} · updated ${formatDate(record.updatedAt)}\n\n${record.content}`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "memory_find",
		label: "Memory find",
		description: "Hybrid keyword + semantic search over this project's markdown memories. Returns one line per hit; use memory_read for full content.",
		promptGuidelines: [
			"Use memory_find to look up earlier findings, decisions, or plans for this project when the user refers to prior work that isn't in context.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "What to look for" }),
			limit: Type.Optional(Type.Number({ description: "Maximum hits (default 5, max 20)" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const current = getStore();
			const pid = requireProject();
			const limit = Math.min(Math.max(params.limit ?? 5, 1), 20);
			maybeWarnVectors(ctx);
			if (current.vectorsAvailable) {
				const pending = current.getUnembedded(pid, 20);
				if (pending.length > 0) {
					const backfill = await embedContents(
						pending.map((row) => row.content),
						ctx,
						signal,
					);
					if (backfill.ok) {
						pending.forEach((row, index) => current.setVector(row.id, pid, backfill.embeddings[index]));
					}
				}
			}
			const ftsHits = current.ftsSearch(pid, params.query, 50);
			let vectorHits: MemoryRecord[] = [];
			let keywordOnly: string | undefined;
			if (current.vectorsAvailable) {
				const queryEmbedding = await embedContents([params.query], ctx, signal);
				if (queryEmbedding.ok) {
					vectorHits = current.vectorSearch(pid, queryEmbedding.embeddings[0], 50);
				} else {
					keywordOnly = queryEmbedding.reason;
				}
			} else {
				keywordOnly = current.vectorWarning ?? "vector search is disabled";
			}
			const fused = rrfFuse([ftsHits, vectorHits], (row) => row.name).slice(0, limit);
			if (fused.length === 0) {
				return { content: [{ type: "text", text: "No memories match. Use memory_read for the full content of a known entry." }] };
			}
			let text = fused.map((row) => `${row.name} · updated ${formatDate(row.updatedAt)} · ${row.description}`).join("\n");
			if (keywordOnly) text += `\n(keyword-only: ${keywordOnly})`;
			return { content: [{ type: "text", text }] };
		},
	});

	pi.registerCommand("remember", {
		description: "Summarize this conversation into project memory (one memory_write call)",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("/remember: wait for the agent to finish its reply", "warning");
				return;
			}
			if (!pi.getActiveTools().includes("memory_write")) {
				ctx.ui.notify("/remember: the memory_write tool is not active (add it to the agent tools list)", "error");
				return;
			}
			armed = true;
			pi.sendUserMessage(buildRememberPrompt(args.trim()));
		},
	});

	pi.registerCommand("memory", {
		description: "Edit or delete a project memory: /memory edit <name> | /memory delete <name>",
		getArgumentCompletions: (argumentPrefix: string) => {
			const entries =
				projectId === null
					? []
					: getStore()
							.listRecent(projectId, 500)
							.map((row) => ({ name: row.name, description: row.description, lastUsedAt: row.lastUsedAt }));
			const items = completeMemoryArgs(argumentPrefix, entries, fuzzyFilter);
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			await handleMemoryCommand(args, ctx);
		},
	});

	async function handleMemoryCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const parts = args.trim().split(/\s+/).filter((part) => part.length > 0);
		const [sub, ...rest] = parts;
		const name = rest.join(" ");
		if ((sub !== "edit" && sub !== "delete") || !name) {
			ctx.ui.notify("Usage: /memory edit <name> | /memory delete <name>", "info");
			return;
		}
		const current = getStore();
		const pid = requireProject();
		const record = current.getMemory(pid, name);
		if (!record) {
			ctx.ui.notify(`Unknown memory: ${name}`, "error");
			return;
		}
		if (sub === "delete") {
			const confirmed = await ctx.ui.confirm("Delete memory?", `${record.name} — ${record.description}`);
			if (!confirmed) return;
			current.deleteMemory(pid, name);
			ctx.ui.notify(`Deleted "${name}"`);
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify("/memory edit needs an interactive UI", "error");
			return;
		}
		const edited = await ctx.ui.editor(`Edit memory: ${name}`, serializeMemoryEdit(record.description, record.content));
		if (edited === undefined) return;
		const parsed = parseMemoryEdit(edited, parseFrontmatter);
		if (!parsed.ok) {
			ctx.ui.notify(`/memory edit: ${parsed.error}`, "error");
			return;
		}
		if (parsed.description === record.description && parsed.content === record.content) return;
		if (!isWithinTokenLimit(parsed.content)) {
			ctx.ui.notify(`/memory edit: content is ${countTokens(parsed.content)} tokens; the limit is ${MAX_EMBED_TOKENS}`, "error");
			return;
		}
		maybeWarnVectors(ctx);
		const contentChanged = parsed.content !== record.content;
		let embedding: number[] | null = null;
		let pending = false;
		if (contentChanged && current.vectorsAvailable) {
			const outcome = await embedContents([parsed.content], ctx, ctx.signal ?? undefined);
			if (outcome.ok) embedding = outcome.embeddings[0];
			else pending = true;
		} else if (contentChanged) {
			pending = true;
		}
		current.upsertMemory(pid, name, parsed.description, parsed.content, embedding);
		if (contentChanged && embedding === null) {
			const row = current.getMemory(pid, name);
			if (row && row.embeddingModel !== null) current.setVector(row.id, pid, null);
		}
		ctx.ui.notify(`Updated "${name}"${pending ? " (semantic index pending)" : ""}`);
	}

	function createAutocompleteProvider(current: AutocompleteProvider): AutocompleteProvider {
		return {
			// `:` retriggers the session, so typing `@mem:` (or retyping `:`
			// after accepting the `@mem:` hint) always opens the recents.
			triggerCharacters: [":"],
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				if (!pi.getActiveTools().includes("memory_read") || projectId === null) {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}
				const pid = projectId;
				const line = lines[cursorLine] ?? "";
				const before = line.slice(0, cursorCol);
				const token = extractMemToken(before);
				if (token !== undefined) {
					const entries = getStore()
						.listRecent(pid, 500)
						.map((row) => ({ name: row.name, description: row.description, lastUsedAt: row.lastUsedAt }));
					if (entries.length === 0) {
						return current.getSuggestions(lines, cursorLine, cursorCol, options);
					}
					const items = buildMemSuggestions(entries, token, fuzzyFilter, Date.now());
					if (items.length === 0) {
						return current.getSuggestions(lines, cursorLine, cursorCol, options);
					}
					return {
						items: items.map((item) => ({
							value: item.value,
							label: item.label,
							description: item.description,
						})),
						prefix: `@mem:${token}`,
					};
				}
				if (isMemHintToken(before)) {
					const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);
					const hint = buildMemHint();
					const hintItem = { value: hint.value, label: hint.label, description: hint.description };
					const tokenMatch = before.match(/@(m|me|mem)$/);
					const hintToken = tokenMatch ? `@${tokenMatch[1]}` : null;
					if (hintToken && base && base.prefix === hintToken) {
						return { items: [hintItem, ...base.items], prefix: base.prefix };
					}
					if (hintToken && !base) {
						return { items: [hintItem], prefix: hintToken };
					}
					return base;
				}
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},

			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				const line = lines[cursorLine] ?? "";
				const applied = applyMemCompletion(line.slice(0, cursorCol), line.slice(cursorCol), item.value, prefix);
				if (applied) {
					const nextLines = [...lines];
					nextLines[cursorLine] = applied.text;
					return { lines: nextLines, cursorLine, cursorCol: applied.cursorCol };
				}
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},

			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				const line = lines[cursorLine] ?? "";
				if (extractMemToken(line.slice(0, cursorCol)) !== undefined) return true;
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		};
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			const identity = await resolveProject(ctx.cwd, execFn);
			projectId = getStore().ensureProject(identity.kind, identity.key, identity.root);
		} catch {
			projectId = null;
		}
		if (!autocompleteRegistered) {
			autocompleteRegistered = true;
			ctx.ui.addAutocompleteProvider((current) => createAutocompleteProvider(current));
		}
	});

	pi.on("input", async (event, ctx) => {
		const pid = projectId;
		if (pid !== null && pi.getActiveTools().includes("memory_read")) {
			const refs = extractMemRefs(event.text);
			if (refs.length > 0) {
				const unknown = refs.filter((name) => !getStore().getMemory(pid, name));
				if (unknown.length > 0) {
					ctx.ui.notify(`Unknown memory: ${unknown.join(", ")}`, "warning");
				}
			}
		}
		return { action: "continue" };
	});

	pi.on("agent_end", () => {
		armed = false;
	});

	pi.on("session_shutdown", () => {
		store?.close();
		store = null;
		projectId = null;
	});
}
