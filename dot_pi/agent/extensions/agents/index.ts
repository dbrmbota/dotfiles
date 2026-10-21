/**
 * agents — primary-agent picker (OpenCode-style agents) for the main session.
 *
 * Agent definitions live in `~/.pi/agent/agents/*.md` (plus trusted-project
 * `.pi/agents/**`, which override on name collision). One agent is always
 * active; `chat` is the default and matches the settings defaults.
 *
 * `ctrl+n` or `/agent` opens the picker, `/agent <name>` switches directly,
 * `/agent <term>` opens the picker prefilled with `<term>`,
 * `/agent reload` re-runs discovery. Picking an agent applies its model,
 * thinking level, tools, and system-prompt body. The active agent
 * is shown in the editor chrome via the `agents:change` event.
 *
 * Agent bodies can use variables: `$NAME`, `${NAME}`, and `${NAME:-default}`.
 * Only names that other extensions publish over the `agents:vars` event are
 * replaced: a string value sets the name, `null` removes it. Other `$NAME`
 * forms stay literal, and `${NAME:-default}` falls back to `default` when the
 * name is not set. Expansion runs on every agent start.
 *
 * A project can add skills and tools to named agents in `.pi/agents.json`
 * (trusted projects only). Tools of a skill or template that a user invokes
 * (`/skill:`, `/template`, `@skill:` through `skill-refs:expanded`) or that the
 * model reads from an advertised skill are granted for the rest of the
 * session. The grants are recorded as `agent-grants` entries on the branch.
 *
 * This file is wiring only. The controller (`controller.ts`) holds the state
 * and behavior, and the pure modules hold the parsing and matching logic.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentsController } from "./controller.ts";
import type { SkillRefsExpanded } from "./invocations.ts";
import { mergeAgentVars } from "./vars.ts";

export { expandAgentVars } from "./vars.ts";

const PICKER_SHORTCUT = "ctrl+n";
const VARS_EVENT = "agents:vars";
const SKILL_REFS_EVENT = "skill-refs:expanded";

export default function (pi: ExtensionAPI) {
	const controller = createAgentsController(pi);
	// Event listeners get no context from pi, so the last one seen is reused for the
	// `skill-refs:expanded` listener, which needs it to notify.
	let lastCtx: ExtensionContext | undefined;

	pi.events.on(VARS_EVENT, (data) => {
		if (typeof data === "object" && data !== null) mergeAgentVars(controller.agentVars, data as Record<string, string | null>);
	});

	pi.events.on(SKILL_REFS_EVENT, (payload) => {
		if (lastCtx === undefined || typeof payload !== "object" || payload === null) return;
		if (!Array.isArray((payload as { skills?: unknown }).skills)) return;
		controller.onSkillRefsExpanded(payload as SkillRefsExpanded, lastCtx);
	});

	pi.registerShortcut(PICKER_SHORTCUT, {
		description: "Pick the primary agent",
		handler: async (ctx) => {
			lastCtx = ctx;
			await controller.pick(ctx, "");
		},
	});

	pi.registerCommand("agent", {
		description: "Pick the primary agent (picker, name/search, or reload)",
		getArgumentCompletions: (prefix) =>
			controller.catalog
				.filter((d) => d.name.startsWith(prefix))
				.map((d) => ({ value: d.name, label: d.name, description: d.description })),
		handler: async (args, ctx: ExtensionContext) => {
			lastCtx = ctx;
			const rest = args.trim();
			if (!rest) {
				await controller.pick(ctx, "");
				return;
			}
			if (rest === "reload") {
				ctx.ui.notify(`agents: reloaded ${controller.reload(ctx)} agent(s)`, "info");
				return;
			}
			if (await controller.switchTo(rest.split(/\s+/)[0]!, ctx)) return;
			await controller.pick(ctx, rest);
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		lastCtx = ctx;
		await controller.onBeforeAgentStart(event);
	});

	pi.on("input", (event, ctx) => {
		lastCtx = ctx;
		controller.onInput(event, ctx);
	});

	pi.on("tool_result", (event, ctx) => {
		lastCtx = ctx;
		controller.onToolResult(event, ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		await controller.onSessionStart(ctx);
	});

	// Branch navigation changes which active-agent entry is on the branch.
	pi.on("session_tree", (_event, ctx) => {
		lastCtx = ctx;
		controller.onSessionTree(ctx);
	});
}
