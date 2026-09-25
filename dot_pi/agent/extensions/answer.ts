// /answer — turn plain-text questions from the last assistant reply into an
// ask_user form.
//
// Agents often end a reply with a numbered list of open questions instead of
// calling ask_user (typically because the questions have no obvious options).
// This command asks the agent to re-ask them through ask_user, one form
// question per open question, with enough background in each prompt to answer
// it without scrolling back.
//
// The form itself comes from the ask_user tool (@qmahyar/pi-ask), so text
// answers use the host editor (pi-vim). This extension adds no UI of its own.
//
// Usage:
//   /answer                     re-ask the open questions from the last reply
//   /answer <extra instruction> same, plus a note for the agent
//                               (e.g. "/answer skip 3, I already decided it")

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const ASK_TOOL = "ask_user";

function lastAssistantText(ctx: ExtensionCommandContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return undefined;
		const text = content
			.filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
			.map((b) => b.text)
			.join("\n")
			.trim();
		return text || undefined;
	}
	return undefined;
}

function buildPrompt(extra: string): string {
	const lines = [
		`Re-ask the open questions from your last reply using the ${ASK_TOOL} tool. Call ${ASK_TOOL} right away, before doing anything else.`,
		"",
		"- One form question per open question, in the original order. Skip questions that are already answered or purely rhetorical.",
		"- header: a short topic label. prompt: the question plus the background needed to answer it without scrolling back — relevant context, constraints, consequences, and your current leaning if you have one.",
		"- Use a choice question only when your reply offered concrete alternatives (trade-offs go in option details; set recommendation if you had a preference). Otherwise use a text question.",
		"- If there are more than 10, ask the 10 most blocking ones first.",
		"- After the form: act on the submitted answers. For needs_discussion items, discuss them in chat first, then re-ask only the ones still open.",
	];
	if (extra) lines.push("", `Additional instruction from me: ${extra}`);
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("answer", {
		description: "Re-ask the open questions from the last reply as an ask_user form",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("/answer: wait for the agent to finish its reply", "warning");
				return;
			}
			if (!pi.getActiveTools().includes(ASK_TOOL)) {
				ctx.ui.notify(`/answer: the ${ASK_TOOL} tool is not active (install @qmahyar/pi-ask)`, "error");
				return;
			}
			if (!lastAssistantText(ctx)) {
				ctx.ui.notify("/answer: no assistant reply with text on this branch", "warning");
				return;
			}
			pi.sendUserMessage(buildPrompt(args.trim()));
		},
	});
}
