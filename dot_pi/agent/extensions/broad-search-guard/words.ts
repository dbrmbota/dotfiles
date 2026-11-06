// Decodes tree-sitter bash word nodes into the text a shell passes to a
// command. Values the guard cannot know statically are marked dynamic.

import type { Node } from "web-tree-sitter";

/**
 * One shell word, as far as it can be known statically.
 * `dynamic`: the value depends on something the guard cannot resolve, such as a
 * command substitution, an unknown variable, or `~user`. `value` is then unreliable.
 * `glob`: the word has unquoted glob characters, so `value` is a pattern.
 */
export type Word = { value: string; dynamic: boolean; glob: boolean };

/** Expansion context: `home` for `~` and `$HOME`, and `cwd` for `$PWD` (undefined when unknown). */
export type WordEnv = { cwd: string | undefined; home: string };

/** Decodes one word node (`word`, `number`, `raw_string`, `string`, `concatenation`, ...) into a Word. */
export function decodeWord(node: Node, env: WordEnv): Word {
	switch (node.type) {
		case "word":
		case "number": {
			const text = node.text;
			let glob = false;
			for (let index = 0; index < text.length; index++) {
				const char = text[index]!;
				if (char === "\\") {
					index++;
				} else if (char === "*" || char === "?" || char === "[" || char === "{") {
					glob = true;
				}
			}
			const tilde = text === "~" || text.startsWith("~/");
			if (text.startsWith("~") && !tilde) return { value: text, dynamic: true, glob };
			const rest = tilde ? text.slice(1) : text;
			const value = (tilde ? env.home : "") + rest.replace(/\\(.)/gs, "$1");
			return { value, dynamic: false, glob };
		}
		case "raw_string":
			return { value: node.text.slice(1, -1), dynamic: false, glob: false };
		case "ansi_c_string":
			return { value: node.text.slice(2, -1), dynamic: false, glob: false };
		case "string_content":
			return { value: node.text, dynamic: false, glob: false };
		case "string":
		case "concatenation": {
			const parts = node.namedChildren.map((child, index) =>
				// A tilde after a quoted part is literal in bash. The "~" home makes the word expand to itself.
				decodeWord(child, index > 0 && child.type === "word" ? { ...env, home: "~" } : env),
			);
			return {
				value: parts.map((part) => part.value).join(""),
				dynamic: parts.some((part) => part.dynamic),
				glob: parts.some((part) => part.glob),
			};
		}
		case "simple_expansion":
		case "expansion": {
			const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(node.text);
			if (match?.[1] === "HOME") return { value: env.home, dynamic: false, glob: false };
			if (match?.[1] === "PWD" && env.cwd !== undefined) return { value: env.cwd, dynamic: false, glob: false };
			return { value: "", dynamic: true, glob: false };
		}
		default:
			return { value: "", dynamic: true, glob: false };
	}
}
