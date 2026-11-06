// Loads the tree-sitter bash parser: the web-tree-sitter runtime plus the
// tree-sitter-bash WASM grammar that ships in its package.

import { createRequire } from "node:module";
import type { Tree } from "web-tree-sitter";

/** Parses bash source into a syntax tree. The caller owns the tree and must call `tree.delete()`. */
export type ParseFn = (source: string) => Tree;

let cached: Promise<ParseFn> | undefined;

/**
 * Loads the bash parser and caches it, so the load happens once per process.
 * A failed load rejects, and the next call tries again.
 */
export function loadBashParser(): Promise<ParseFn> {
	cached ??= (async (): Promise<ParseFn> => {
		const { Parser, Language } = await import("web-tree-sitter");
		await Parser.init();
		const grammarPath = createRequire(import.meta.url).resolve("tree-sitter-bash/tree-sitter-bash.wasm");
		const parser = new Parser();
		parser.setLanguage(await Language.load(grammarPath));
		return (source) => {
			const tree = parser.parse(source);
			if (!tree) throw new Error("tree-sitter returned no tree");
			return tree;
		};
	})().catch((error: unknown) => {
		cached = undefined;
		throw error;
	});
	return cached;
}
