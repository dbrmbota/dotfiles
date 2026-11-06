import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findBroadSearch } from "./analyze.ts";
import { loadBashParser } from "./parser.ts";

const HOME = "/Users/u";
const CWD = "/Users/u/proj";

async function analyze(command: string, cwd = CWD): Promise<ReturnType<typeof findBroadSearch>> {
	return findBroadSearch(command, { cwd, home: HOME, parse: await loadBashParser() });
}

const BLOCKED: Array<[command: string, root: string]> = [
	// find /
	["find / -name x", "/"],
	["find / -name x 2>/dev/null", "/"],
	["sudo find / -type f", "/"],
	["/usr/bin/find / -name x", "/"],
	["find -L / -name x", "/"],
	["find / -maxdepth 1", "/"],
	["find /tmp/../ -name x", "/"],
	[String.raw`find / \( -name a -o -name b \) -print`, "/"],
	// home and its ancestors
	["find /Users -name x", "/Users"],
	["find ~ -name x", "/Users/u"],
	["find ~/ -name x", "/Users/u"],
	["find $HOME -name x", "/Users/u"],
	['find "$HOME" -name x', "/Users/u"],
	// cloud and mount roots
	["find ~/Library -name x", "/Users/u/Library"],
	["find ~/Library/CloudStorage/OneDrive-X -name x", "/Users/u/Library/CloudStorage/OneDrive-X"],
	["find /Volumes/NAS -name x", "/Volumes/NAS"],
	["find /Volumes/* -name x", "/Volumes"],
	// Linux roots
	["find /home -name x", "/home"],
	["find /mnt/c -name x", "/mnt/c"],
	["find /media/u/disk -name x", "/media/u/disk"],
	["find /run/user/1000/gvfs/smb-share:x -name x", "/run/user/1000/gvfs/smb-share:x"],
	["find /proc -name x", "/proc"],
	// grep
	["grep -rn foo /", "/"],
	["grep -R foo ~", "/Users/u"],
	["grep --recursive foo /usr", "/usr"],
	// rg
	["rg foo /", "/"],
	["rg -e foo /", "/"],
	["rg -g'*.ts' foo /", "/"],
	["rg --files / | grep x", "/"],
	// fd
	["fd foo /", "/"],
	["fd -H foo ~", "/Users/u"],
	["fd foo --search-path /", "/"],
	// other walkers
	["ag foo /", "/"],
	["du -sh /*", "/"],
	["du -sh ~", "/Users/u"],
	["ls -laR /", "/"],
	["tree /", "/"],
	// cd
	["cd / && find . -name x", "/"],
	["cd && rg foo", "/Users/u"],
	// nesting
	["bash -c 'find / -name x'", "/"],
	["echo $(find / -name x)", "/"],
	["echo `find /`", "/"],
	["x=$(find / -name a)", "/"],
	["ls <(find /)", "/"],
	// wrappers and control flow
	["timeout 10 find / -name x", "/"],
	["xargs grep -r foo /", "/"],
	["if true; then find /; fi", "/"],
	["case $x in a) find / ;; esac", "/"],
	["f() { find / ; }", "/"],
	["! grep -r x /", "/"],
	// partial parse errors: the clean command before the error is still analyzed
	['find / -name x; echo "bad', "/"],
];

const ALLOWED: string[] = [
	// narrow roots
	"find . -name x",
	"find src -name '*.ts'",
	"find /opt/homebrew/Cellar/pi-coding-agent -name '*.md'",
	"find ~/.config -name x",
	"find /usr/local/include -name x",
	"du -sh ./node_modules",
	// not a recursive search
	"grep foo /etc/hosts",
	"ls /",
	"ls -la ~",
	"git grep foo",
	"locate foo",
	// patterns that look like paths
	'grep -r "/" src',
	'rg "/" src',
	"rg --type-add 'web:*.html' foo src",
	// default root when the cwd is not broad
	"rg -n foo",
	// not commands
	'echo "find / -name x"',
	"cat <<EOF\nfind /\nEOF",
	"# find / -name x",
	// scoped or unknown cwd
	"(cd /; ls) && find . -name x",
	'cd "$DIR" && find .',
	// dynamic paths
	"find $SOMEVAR -name x",
	'for f in /*; do du -sh "$f"; done',
	// parse errors: only the ERROR region is skipped
	'echo "unterminated; find / -name x',
];

describe("findBroadSearch blocks broad roots", () => {
	for (const [command, root] of BLOCKED) {
		it(`blocks ${command}`, async () => {
			const finding = await analyze(command);
			assert.equal(finding?.root, root);
		});
	}

	it("blocks implicit . when the cwd is home", async () => {
		const finding = await analyze("find . -name x", HOME);
		assert.equal(finding?.root, "/Users/u");
	});
});

describe("findBroadSearch allows narrow or non-recursive searches", () => {
	for (const command of ALLOWED) {
		it(`allows ${command}`, async () => {
			assert.equal(await analyze(command), undefined);
		});
	}

	it("allows a piped rg with the cwd at home", async () => {
		assert.equal(await analyze("ps aux | rg foo", HOME), undefined);
	});

	it("allows rg with redirected stdin and the cwd at home", async () => {
		assert.equal(await analyze("rg foo < list.txt", HOME), undefined);
	});

	it("allows rg with a heredoc as stdin and the cwd at home", async () => {
		assert.equal(await analyze("rg foo <<EOF\nbar\nEOF", HOME), undefined);
	});

	it("allows rg with a herestring as stdin and the cwd at home", async () => {
		assert.equal(await analyze("rg foo <<<bar", HOME), undefined);
	});
});
