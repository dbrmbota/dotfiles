// Slim wrapper around pi-web-access (https://github.com/nicobailon/pi-web-access).
//
// pi installs the package from npm via settings.json:
//   { "source": "npm:pi-web-access", "extensions": [] }
// `"extensions": []` installs it (deps included, under ~/.pi/agent/npm) without
// loading its own extension entry. This file loads the bundle through a proxied
// `pi` object and strips the YouTube/video parameters from fetch_content, which
// are disabled in web-search.json anyway (youtube.enabled / video.enabled: false)
// but otherwise cost ~240 tokens of schema on every turn.
//
// Version-agnostic: if upstream renames a description string, the rewrite is a
// no-op and the parameter stripping still applies.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";

const PACKAGE = "pi-web-access";

/** Parameters to remove from each tool's schema. */
const STRIP_PARAMS: Record<string, string[]> = {
	fetch_content: ["timestamp", "frames", "model"],
	// Extra ~200 tokens if you never use proxies, browser-cookie fetches or the curator:
	// fetch_content: ["timestamp", "frames", "model", "proxy", "auth"],
	// web_search: ["workflow", "proxy"],
};

/** Exact-string rewrites of tool descriptions (applied with String.replace). */
const DESCRIPTION_REWRITES: Record<string, Array<[string, string]>> = {
	fetch_content: [
		[
			" Supports YouTube transcripts, GitHub repositories, PDFs, and local videos when supported by the selected mode.",
			" Supports GitHub repositories and PDFs.",
		],
	],
};

/** Exact-string rewrites of individual parameter descriptions. */
const PARAM_REWRITES: Record<string, Record<string, Array<[string, string]>>> = {
	fetch_content: {
		prompt: [
			["Question or instruction for video analysis, or the page-local question required by answer mode.", "Page-local question required by answer mode."],
			["Question or instruction for video analysis.", "Unused."],
		],
	},
};

const PROMPT_SNIPPETS: Record<string, string> = {
	fetch_content: "Use to fetch URL content, direct images, GitHub repos, and PDFs.",
};

function resolveBundle(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const req = createRequire(join(agentDir, "npm", "package.json"));
	const pkg = req(`${PACKAGE}/package.json`) as { pi?: { extensions?: string[] } };
	return req.resolve(join(PACKAGE, pkg.pi?.extensions?.[0] ?? "./dist"));
}

function trimTool(def: any): any {
	const name: string = def.name;
	const strip = STRIP_PARAMS[name];
	const paramRewrites = PARAM_REWRITES[name];
	const descRewrites = DESCRIPTION_REWRITES[name];
	if (!strip && !paramRewrites && !descRewrites && !PROMPT_SNIPPETS[name]) return def;

	const props: Record<string, any> = { ...(def.parameters?.properties ?? {}) };
	for (const key of strip ?? []) delete props[key];
	for (const [param, rewrites] of Object.entries(paramRewrites ?? {})) {
		if (!props[param]) continue;
		for (const [from, to] of rewrites) {
			if (props[param].description === from) props[param] = { ...props[param], description: to };
		}
	}

	let description: string = def.description ?? "";
	for (const [from, to] of descRewrites ?? []) description = description.replace(from, to);

	return {
		...def,
		description,
		promptSnippet: PROMPT_SNIPPETS[name] ?? def.promptSnippet,
		parameters: { ...def.parameters, properties: props },
	};
}

export default async function (pi: ExtensionAPI) {
	const mod = await import(resolveBundle());
	const factory = mod.default ?? mod;
	if (typeof factory !== "function") throw new Error(`${PACKAGE} bundle does not export an extension factory`);

	const proxied = new Proxy(pi, {
		get(target, prop, receiver) {
			if (prop === "registerTool") return (def: any) => target.registerTool(trimTool(def));
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	await factory(proxied);
}
