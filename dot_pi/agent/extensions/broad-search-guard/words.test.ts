import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadBashParser } from "./parser.ts";
import { decodeWord, type Word, type WordEnv } from "./words.ts";

const ENV: WordEnv = { cwd: "/Users/u/proj", home: "/Users/u" };

async function decodeArgument(argument: string): Promise<Word> {
	const parse = await loadBashParser();
	const tree = parse(`echo ${argument}`);
	try {
		const command = tree.rootNode.descendantsOfType("command")[0]!;
		const [node] = command.childrenForFieldName("argument");
		return decodeWord(node!, ENV);
	} finally {
		tree.delete();
	}
}

describe("decodeWord", () => {
	it("removes backslash escapes from a word", async () => {
		assert.deepEqual(await decodeArgument(String.raw`a\(b`), { value: "a(b", dynamic: false, glob: false });
		assert.deepEqual(await decodeArgument(String.raw`foo\/bar`), { value: "foo/bar", dynamic: false, glob: false });
	});

	it("keeps raw_string content literally", async () => {
		assert.deepEqual(await decodeArgument("'a $HOME b'"), { value: "a $HOME b", dynamic: false, glob: false });
	});

	it("expands $HOME inside a string", async () => {
		assert.deepEqual(await decodeArgument('"$HOME/x"'), { value: "/Users/u/x", dynamic: false, glob: false });
	});

	it("marks an unknown variable inside a string as dynamic", async () => {
		assert.equal((await decodeArgument('"$X/y"')).dynamic, true);
	});

	it("concatenates tilde expansion with a quoted part", async () => {
		assert.deepEqual(await decodeArgument('~/"My Dir"'), { value: "/Users/u/My Dir", dynamic: false, glob: false });
	});

	it("keeps ansi_c_string content literally", async () => {
		assert.deepEqual(await decodeArgument(String.raw`$'a\tb'`), { value: String.raw`a\tb`, dynamic: false, glob: false });
	});

	it("marks ~user as dynamic", async () => {
		assert.equal((await decodeArgument("~user/x")).dynamic, true);
	});

	it("sets glob for unquoted glob characters only", async () => {
		assert.deepEqual(await decodeArgument("*.ts"), { value: "*.ts", dynamic: false, glob: true });
		assert.deepEqual(await decodeArgument('"*.ts"'), { value: "*.ts", dynamic: false, glob: false });
	});
});
