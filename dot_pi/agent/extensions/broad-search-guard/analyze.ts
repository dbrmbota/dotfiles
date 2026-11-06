// Finds recursive searches over broad roots in one bash command string. The
// syntax tree is walked in document order. Each command is checked with the
// rules in commands.ts, after its roots are resolved against the current working
// directory and matched against the broad roots in roots.ts.

import path from "node:path";
import type { Node } from "web-tree-sitter";
import { invocationOf, nestedScriptOf, planSearch, type Invocation, type SearchPlan } from "./commands.ts";
import type { ParseFn } from "./parser.ts";
import { buildBroadRoots } from "./roots.ts";
import { decodeWord, type Word, type WordEnv } from "./words.ts";

/** The first search that walks a broad root. `segment` is the command's source text, `root` is the resolved path, and `matched` is the broad-root pattern. */
export type Finding = { segment: string; root: string; matched: string };

/** Inputs of one analysis: the starting working directory, the home directory, and the parser. */
export type AnalyzeOptions = { cwd: string; home: string; parse: ParseFn };

/**
 * Returns the first recursive search in `command` that walks a broad root, or undefined.
 * Throws a TypeError when `command` is not a string. Regions that fail to parse are skipped, not thrown.
 */
export function findBroadSearch(command: string, options: AnalyzeOptions): Finding | undefined {
	if (typeof command !== "string") throw new TypeError("command must be a string");
	const walk: Walk = {
		home: options.home,
		parse: options.parse,
		broad: buildBroadRoots(options.home),
		depth: 0,
	};
	return analyzeSource(command, { cwd: options.cwd }, walk);
}

/** The shell's working directory at one point of the walk. `undefined` means it is not known statically. */
type Scope = { cwd: string | undefined };

/** Shared state of one analysis. `depth` counts nested scripts (bash -c, eval) and is capped at 3. */
type Walk = { home: string; parse: ParseFn; broad: (path: string) => string | undefined; depth: number };

/**
 * Parses `source` and walks it with `scope`. Frees the tree in a finally block,
 * because web-tree-sitter trees hold WASM memory.
 */
function analyzeSource(source: string, scope: Scope, walk: Walk): Finding | undefined {
	const tree = walk.parse(source);
	try {
		return visit(tree.rootNode, scope, false, walk);
	} finally {
		tree.delete();
	}
}

/**
 * Visits one node in document order. Returns the first finding.
 * `pipedInput` is true only when the node's stdin is a pipe or redirect. It applies to a command node,
 * to the body of a redirected statement, and to the child of a negated command.
 * ERROR nodes are skipped entirely.
 */
function visit(node: Node, scope: Scope, pipedInput: boolean, walk: Walk): Finding | undefined {
	switch (node.type) {
		case "ERROR":
			return undefined;
		case "command":
			return visitCommand(node, scope, pipedInput, walk);
		case "pipeline":
			for (const [index, stage] of node.namedChildren.entries()) {
				const finding = visit(stage, { cwd: scope.cwd }, index > 0, walk);
				if (finding) return finding;
			}
			return undefined;
		case "redirected_statement": {
			const body = node.childForFieldName("body");
			if (!body) return undefined;
			const readsStdin = node.namedChildren.some(
				(child) =>
					child.type === "heredoc_redirect" ||
					child.type === "herestring_redirect" ||
					(child.type === "file_redirect" && /^\d*<(?![<&])/.test(child.text)),
			);
			return visit(body, scope, readsStdin, walk);
		}
		case "negated_command":
			for (const child of node.namedChildren) {
				const finding = visit(child, scope, pipedInput, walk);
				if (finding) return finding;
			}
			return undefined;
		case "subshell":
		case "command_substitution":
		case "process_substitution":
		case "function_definition":
			return visitChildren(node, { cwd: scope.cwd }, walk);
		default:
			return visitChildren(node, scope, walk);
	}
}

/**
 * Analyzes one `command` node. Order:
 * 1. Decode command_name and the argument children into Word[] (with the scope's cwd and walk's home).
 * 2. invocationOf, then applyDirectoryChange for cd/pushd.
 * 3. planSearch, then resolveRoots and walk.broad on each root. The first match is a finding. Its segment is node.text.
 * 4. nestedScriptOf: for a bash-like shell, analyzeSource with a copied scope and depth + 1. For eval, use the
 *    same scope, because eval runs in the current shell. Skip this step when depth is already 3.
 * 5. Visit the argument subtrees with a copied scope, so command substitutions are analyzed too.
 */
function visitCommand(node: Node, scope: Scope, pipedInput: boolean, walk: Walk): Finding | undefined {
	const env: WordEnv = { cwd: scope.cwd, home: walk.home };
	const nameNode = node.namedChildren.find((child) => child.type === "command_name");
	const argumentNodes = node.childrenForFieldName("argument");
	const words: Word[] = nameNode
		? [decodeWord(nameNode.namedChildren[0] ?? nameNode, env), ...argumentNodes.map((argument) => decodeWord(argument, env))]
		: [];
	// A herestring is a child of the command node, not of redirected_statement.
	const readsStdin = pipedInput || node.namedChildren.some((child) => child.type === "herestring_redirect");
	const invocation = invocationOf(words, readsStdin);
	if (invocation) {
		if (invocation.name === "cd" || invocation.name === "pushd") {
			applyDirectoryChange(invocation, scope, walk.home);
		}
		const plan = planSearch(invocation);
		if (plan) {
			for (const root of resolveRoots(plan, scope)) {
				const matched = walk.broad(root);
				if (matched !== undefined) return { segment: node.text, root, matched };
			}
		}
		// Nested scripts are analyzed at most 3 levels deep, so a loop of eval strings ends.
		const script = nestedScriptOf(invocation);
		if (script !== undefined && walk.depth < 3) {
			const nestedScope = invocation.name === "eval" ? scope : { cwd: scope.cwd };
			const finding = analyzeSource(script, nestedScope, { ...walk, depth: walk.depth + 1 });
			if (finding) return finding;
		}
	}
	for (const child of nameNode ? [nameNode, ...argumentNodes] : argumentNodes) {
		const finding = visit(child, { cwd: scope.cwd }, false, walk);
		if (finding) return finding;
	}
	return undefined;
}

/** Visits the children of `node` in order, with the same scope. Stops at the first finding. */
function visitChildren(node: Node, scope: Scope, walk: Walk): Finding | undefined {
	for (const child of node.namedChildren) {
		const finding = visit(child, scope, false, walk);
		if (finding) return finding;
	}
	return undefined;
}

/**
 * Updates `scope` for cd and pushd. A literal path sets cwd (relative to the current cwd).
 * No argument sets cwd to `home`. A dynamic path, `-`, or `~user` makes cwd unknown. Options L, P, e, and @ are skipped.
 */
function applyDirectoryChange(invocation: Invocation, scope: Scope, home: string): void {
	let index = 0;
	while (index < invocation.args.length) {
		const word = invocation.args[index]!;
		if (word.dynamic || !word.value.startsWith("-") || word.value === "-") break;
		index += 1;
		if (word.value === "--") break;
	}
	const target = invocation.args[index];
	if (!target) {
		scope.cwd = home;
		return;
	}
	if (target.dynamic || target.glob || target.value === "-") {
		scope.cwd = undefined;
		return;
	}
	if (target.value.startsWith("/")) {
		scope.cwd = path.posix.resolve(target.value);
		return;
	}
	scope.cwd = scope.cwd === undefined ? undefined : path.posix.resolve(scope.cwd, target.value);
}

/**
 * Resolves the plan's roots to absolute, normalized paths. Relative roots resolve against
 * plan.base when it is set, else against scope.cwd. Dynamic or unresolvable roots are dropped.
 */
function resolveRoots(plan: SearchPlan, scope: Scope): string[] {
	const base = plan.base ? resolveRoot(plan.base, scope.cwd) : scope.cwd;
	return plan.roots.flatMap((root) => {
		const resolved = resolveRoot(root, base);
		return resolved === undefined ? [] : [resolved];
	});
}

/**
 * Resolves one word to an absolute path. Returns undefined when the word is dynamic, or when it is
 * relative and `base` is undefined. A glob word resolves to its literal prefix (`/Volumes/*` to
 * `/Volumes`, `~/*` to home). The result is normalized with path.posix.resolve, with no realpath.
 */
function resolveRoot(word: Word, base: string | undefined): string | undefined {
	if (word.dynamic) return undefined;
	let value = word.value;
	if (word.glob) {
		const parts = value.split("/");
		const firstGlob = parts.findIndex((part) => /[*?[{]/.test(part));
		const literal = parts.slice(0, firstGlob < 0 ? parts.length : firstGlob).join("/");
		value = literal === "" && value.startsWith("/") ? "/" : literal;
	}
	if (value.startsWith("/")) return path.posix.resolve(value);
	if (base === undefined) return undefined;
	return path.posix.resolve(base, value);
}
