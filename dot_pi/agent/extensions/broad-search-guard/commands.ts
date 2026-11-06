// Works out which filesystem roots a command walks. Handles the recursive
// walkers the guard watches: find, fd, rg, grep -r, ag, ack, du, ls -R, and tree.
// Wrapper commands (sudo, env, timeout, xargs, ...) are stripped first, so the
// walker behind them is still found. Every other command yields no plan.

import path from "node:path";
import type { Word } from "./words.ts";

/** A command after wrapper stripping: the basename of its name, its arguments, and whether its stdin is a pipe or redirect. */
export type Invocation = { name: string; args: Word[]; pipedInput: boolean };

/**
 * The roots a walker searches. `roots` are its path operands, with the default `.` when
 * none is given. `base` is fd's `--base-directory`: it resolves relative roots and is the default root.
 */
export type SearchPlan = { roots: Word[]; base: Word | undefined };

/**
 * Strips wrapper commands from `words` (the command name first) and returns the invoked command.
 * Returns undefined when `words` is empty or the name is dynamic.
 * `pipedInput` is the caller's value. xargs turns it on for the command it runs.
 */
export function invocationOf(words: Word[], pipedInput: boolean): Invocation | undefined {
	let current = words;
	let piped = pipedInput;
	let step = unwrapOnce(current);
	while (step) {
		current = step.words;
		piped = piped || step.pipedInput;
		step = unwrapOnce(current);
	}
	const [name, ...args] = current;
	if (!name || name.dynamic) return undefined;
	return { name: path.posix.basename(name.value), args, pipedInput: piped };
}

/**
 * Returns the search roots of a recursive walker, or undefined when the command is not one the guard watches.
 * Dispatch by `invocation.name`: find/gfind, fd/fdfind, rg, grep/egrep/fgrep/ggrep, ag, ack, du, ls, tree.
 */
export function planSearch(invocation: Invocation): SearchPlan | undefined {
	const { name, args, pipedInput } = invocation;
	switch (name) {
		case "find":
		case "gfind":
			return planFind(args);
		case "fd":
		case "fdfind":
			return planFd(args);
		case "rg":
			return planRipgrep(args, pipedInput);
		case "grep":
		case "egrep":
		case "fgrep":
		case "ggrep":
			return planGrep(args, pipedInput);
		case "ag":
		case "ack":
			return planAgAck(args, pipedInput);
		case "du":
			return planDu(args);
		case "ls":
			return planLs(args);
		case "tree":
			return planTree(args);
		default:
			return undefined;
	}
}

/**
 * Returns the script that a shell or eval runs, or undefined when the text is not known statically.
 * - bash|sh|zsh|dash|ksh with `-c` (also in clusters, such as `-lc`): the next positional word is the script.
 * - eval: the non-dynamic words, joined with spaces.
 */
export function nestedScriptOf(invocation: Invocation): string | undefined {
	const { name, args } = invocation;
	if (name === "eval") {
		return args
			.filter((word) => !word.dynamic)
			.map((word) => word.value)
			.join(" ");
	}
	if (!["bash", "sh", "zsh", "dash", "ksh"].includes(name)) return undefined;
	const scanned = scanArgs(args, new Set(["-o"]));
	if (!scanned.options.some((option) => option.flag === "-c")) return undefined;
	const script = scanned.operands[0];
	return script && !script.dynamic ? script.value : undefined;
}

/** One wrapper step: the words of the command it runs, and whether that command reads a pipe (xargs). */
type Unwrapped = { words: Word[]; pipedInput: boolean };

/**
 * Strips one wrapper (env, sudo, doas, command, builtin, exec, nohup, caffeinate, time, nice,
 * timeout, gtimeout, stdbuf, ionice, xargs) from `words`. Returns undefined when the name is not a wrapper.
 */
function unwrapOnce(words: Word[]): Unwrapped | undefined {
	const [head, ...rest] = words;
	if (!head || head.dynamic) return undefined;
	const specs: Record<string, { valueOptions: string[]; positionals: number; assignments?: boolean; pipedInput?: boolean }> = {
		env: { valueOptions: ["-u"], positionals: 0, assignments: true },
		sudo: { valueOptions: ["-u", "-g", "-C", "-h", "-p"], positionals: 0 },
		doas: { valueOptions: [], positionals: 0 },
		command: { valueOptions: [], positionals: 0 },
		builtin: { valueOptions: [], positionals: 0 },
		exec: { valueOptions: [], positionals: 0 },
		nohup: { valueOptions: [], positionals: 0 },
		caffeinate: { valueOptions: [], positionals: 0 },
		time: { valueOptions: [], positionals: 0 },
		nice: { valueOptions: ["-n"], positionals: 0 },
		timeout: { valueOptions: ["-s", "-k"], positionals: 1 },
		gtimeout: { valueOptions: ["-s", "-k"], positionals: 1 },
		stdbuf: { valueOptions: ["-i", "-o", "-e"], positionals: 0 },
		ionice: { valueOptions: ["-c", "-n"], positionals: 0 },
		xargs: {
			valueOptions: ["-I", "-n", "-P", "-L", "-d", "-E", "-s"],
			positionals: 0,
			pipedInput: true,
		},
	};
	const name = path.posix.basename(head.value);
	const spec = Object.hasOwn(specs, name) ? specs[name] : undefined;
	if (!spec) return undefined;

	// Words an option consumes: 2 for a value flag with its value in the next word, else 1.
	const optionWidth = (flag: string): number => {
		if (flag.startsWith("--")) return !flag.includes("=") && spec.valueOptions.includes(flag) ? 2 : 1;
		for (let char = 1; char < flag.length; char++) {
			if (spec.valueOptions.includes(`-${flag[char]}`)) return char + 1 < flag.length ? 1 : 2;
		}
		return 1;
	};
	let index = 0;
	while (index < rest.length) {
		const word = rest[index]!;
		if (word.dynamic) break;
		if (word.value === "--") {
			index += 1;
			break;
		}
		if (spec.assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value)) {
			index += 1;
			continue;
		}
		if (!word.value.startsWith("-") || word.value === "-") break;
		index += optionWidth(word.value);
	}
	const remaining = rest.slice(index + spec.positionals);
	if (remaining.length === 0) return undefined;
	return { words: remaining, pipedInput: spec.pipedInput === true };
}

/** The options and operands of one command's arguments. */
type ScannedArgs = { options: { flag: string; value: Word | undefined }[]; operands: Word[] };

/**
 * Splits arguments into options and operands. Flags in `valueOptions` take a value.
 * A short value flag takes the rest of its cluster, or the next word. `--opt=value` carries its value inline.
 * `--` ends option parsing. Unknown options count as flags. Each short char in a cluster is its own option.
 */
function scanArgs(args: Word[], valueOptions: ReadonlySet<string>): ScannedArgs {
	const options: ScannedArgs["options"] = [];
	const operands: Word[] = [];
	let optionsOpen = true;
	let index = 0;
	while (index < args.length) {
		const word = args[index]!;
		index += 1;
		const { value } = word;
		if (!optionsOpen || word.dynamic || value === "-" || !value.startsWith("-")) {
			operands.push(word);
		} else if (value === "--") {
			optionsOpen = false;
		} else if (value.startsWith("--")) {
			const equals = value.indexOf("=");
			if (equals >= 0) {
				options.push({
					flag: value.slice(0, equals),
					value: { value: value.slice(equals + 1), dynamic: false, glob: word.glob },
				});
			} else if (valueOptions.has(value)) {
				options.push({ flag: value, value: args[index] });
				index += 1;
			} else {
				options.push({ flag: value, value: undefined });
			}
		} else {
			for (let char = 1; char < value.length; char++) {
				const flag = `-${value[char]}`;
				if (valueOptions.has(flag)) {
					if (char + 1 < value.length) {
						options.push({ flag, value: { value: value.slice(char + 1), dynamic: false, glob: word.glob } });
					} else {
						options.push({ flag, value: args[index] });
						index += 1;
					}
					break;
				}
				options.push({ flag, value: undefined });
			}
		}
	}
	return { options, operands };
}

/** find, gfind: operands up to the first word starting with -, (, !, ), or ,. Skips the plan's leading options, and BSD `-f`. */
function planFind(args: Word[]): SearchPlan {
	const roots: Word[] = [];
	const leadingFlags = new Set(["-H", "-L", "-P", "-E", "-X", "-s", "-x", "-d"]);
	let index = 0;
	while (index < args.length) {
		const word = args[index]!;
		if (!word.dynamic && leadingFlags.has(word.value)) {
			index += 1;
		} else if (!word.dynamic && /^-O\d*$/.test(word.value)) {
			index += 1;
		} else if (!word.dynamic && word.value === "-D") {
			index += 2;
		} else if (!word.dynamic && word.value === "-f") {
			const root = args[index + 1];
			if (root) roots.push(root);
			index += 2;
		} else {
			break;
		}
	}
	while (index < args.length) {
		const word = args[index]!;
		if (!word.dynamic && /^[-(!),]/.test(word.value)) break;
		roots.push(word);
		index += 1;
	}
	if (roots.length === 0) roots.push({ value: ".", dynamic: false, glob: false });
	return { roots, base: undefined };
}

/** fd, fdfind: the first positional is the pattern. Handles --search-path, --base-directory, and exec options. */
function planFd(args: Word[]): SearchPlan {
	const execIndex = args.findIndex((word) => !word.dynamic && ["-x", "--exec", "-X", "--exec-batch"].includes(word.value));
	const scanned = scanArgs(execIndex >= 0 ? args.slice(0, execIndex) : args, new Set([
		"-e", "-t", "-E", "-d", "-S", "-o", "-j", "-c",
		"--min-depth", "--max-depth", "--exact-depth", "--changed-within", "--changed-before",
		"--max-results", "--color", "--format", "--ignore-file", "--batch-size", "--path-separator",
		"--search-path", "--base-directory",
	]));
	const positionals = scanned.operands.slice(1);
	const searchPaths = scanned.options.flatMap((option) =>
		option.flag === "--search-path" && option.value ? [option.value] : [],
	);
	const roots = [...positionals, ...searchPaths];
	if (roots.length === 0) roots.push({ value: ".", dynamic: false, glob: false });
	const base = scanned.options.findLast((option) => option.flag === "--base-directory")?.value;
	return { roots, base };
}

/** rg: all positionals are roots when -e, -f, --files, or --type-list is present; otherwise the first is the pattern. */
function planRipgrep(args: Word[], pipedInput: boolean): SearchPlan {
	const scanned = scanArgs(args, new Set([
		"-A", "-B", "-C", "-e", "-f", "-g", "-t", "-T", "-m", "-d", "-j", "-M", "-r", "-E",
		"--iglob", "--type-add", "--type-clear", "--max-depth", "--maxdepth", "--engine", "--colors",
		"--color", "--sort", "--sortr", "--pre", "--pre-glob", "--ignore-file", "--max-filesize",
		"--context-separator", "--path-separator", "--dfa-size-limit", "--regex-size-limit",
		"--hyperlink-format",
	]));
	const explicitPatterns = scanned.options.some((option) =>
		["-e", "--regexp", "-f", "--file", "--files", "--type-list"].includes(option.flag),
	);
	const roots = explicitPatterns ? scanned.operands : scanned.operands.slice(1);
	if (roots.length === 0 && !pipedInput) roots.push({ value: ".", dynamic: false, glob: false });
	return { roots, base: undefined };
}

/**
 * grep, egrep, fgrep, ggrep: returns undefined unless recursive (-r or -R in a cluster, --recursive,
 * --dereference-recursive, -d recurse, --directories=recurse). Pattern and root rules are the same as rg.
 */
function planGrep(args: Word[], pipedInput: boolean): SearchPlan | undefined {
	// -A, -B, and -C take a value only as an attached part or when the next word is all digits.
	const withoutContext: Word[] = [];
	for (let index = 0; index < args.length; index++) {
		const word = args[index]!;
		withoutContext.push(word);
		const next = args[index + 1];
		if (!word.dynamic && /^-[A-Za-z]*[ABC]$/.test(word.value) && next && !next.dynamic && /^\d+$/.test(next.value)) {
			index += 1;
		}
	}
	const scanned = scanArgs(withoutContext, new Set([
		"-e", "-f", "-m", "-d", "-D", "--include", "--exclude", "--exclude-dir", "--exclude-from",
		"--label", "--color", "--regexp", "--file", "--max-count", "--directories", "--devices",
		"--binary-files", "--group-separator", "--context",
	]));
	const recursive =
		scanned.options.some((option) =>
			["-r", "-R", "--recursive", "--dereference-recursive"].includes(option.flag),
		) ||
		scanned.options.some(
			(option) => (option.flag === "-d" || option.flag === "--directories") && option.value?.value === "recurse",
		);
	if (!recursive) return undefined;
	const explicitPatterns = scanned.options.some((option) => ["-e", "-f", "--regexp", "--file"].includes(option.flag));
	const roots = explicitPatterns ? scanned.operands : scanned.operands.slice(1);
	if (roots.length === 0 && !pipedInput) roots.push({ value: ".", dynamic: false, glob: false });
	return { roots, base: undefined };
}

/** ag, ack: recursive by default. With -g/-G (ag) or -f/-g (ack), all positionals are roots, otherwise the first is the pattern. */
function planAgAck(args: Word[], pipedInput: boolean): SearchPlan {
	const scanned = scanArgs(args, new Set([
		"-A", "-B", "-C", "-m", "-G", "-g", "-p", "-W", "--depth", "--ignore", "--ignore-dir",
		"--ignore-file", "--path-to-ignore", "--pager", "--type", "--match", "--output",
	]));
	const listing = scanned.options.some((option) => ["-g", "-G", "-f"].includes(option.flag));
	const roots = listing ? scanned.operands : scanned.operands.slice(1);
	if (roots.length === 0 && !pipedInput) roots.push({ value: ".", dynamic: false, glob: false });
	return { roots, base: undefined };
}

/** du: all positionals are roots, with the default "." when there are none. */
function planDu(args: Word[]): SearchPlan {
	const scanned = scanArgs(args, new Set([
		"-d", "--max-depth", "-B", "--block-size", "-t", "--threshold", "--exclude", "-X",
		"--exclude-from", "-I", "--time-style", "--files0-from",
	]));
	const roots = scanned.operands.length > 0 ? scanned.operands : [{ value: ".", dynamic: false, glob: false }];
	return { roots, base: undefined };
}

/** ls: a search only when recursive (R in a cluster, or --recursive). Otherwise returns undefined. */
function planLs(args: Word[]): SearchPlan | undefined {
	const scanned = scanArgs(args, new Set([
		"-I", "--ignore", "--hide", "-w", "--width", "-T", "--tabsize", "--format", "--sort", "--time",
		"--color", "--block-size", "--quoting-style", "--indicator-style", "--time-style",
	]));
	const recursive = scanned.options.some((option) => option.flag === "-R" || option.flag === "--recursive");
	if (!recursive) return undefined;
	const roots = scanned.operands.length > 0 ? scanned.operands : [{ value: ".", dynamic: false, glob: false }];
	return { roots, base: undefined };
}

/** tree: operands are roots, with the default "." when there are none. */
function planTree(args: Word[]): SearchPlan {
	const scanned = scanArgs(args, new Set([
		"-L", "-P", "-I", "-o", "-H", "-T", "--filelimit", "--charset", "--timefmt", "--sort",
		"--gitfile", "--infofile",
	]));
	const roots = scanned.operands.length > 0 ? scanned.operands : [{ value: ".", dynamic: false, glob: false }];
	return { roots, base: undefined };
}
