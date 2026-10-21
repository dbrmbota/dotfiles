import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCommandArgs, substituteArgs } from "./prompt-args.ts";

describe("parseCommandArgs", () => {
	it("splits on whitespace and ignores repeated or edge spaces", () => {
		assert.deepEqual(parseCommandArgs("  a  b c "), ["a", "b", "c"]);
		assert.deepEqual(parseCommandArgs("   "), []);
	});

	it("keeps double- and single-quoted text together without the quotes", () => {
		assert.deepEqual(parseCommandArgs(`"two words" 'single q' x`), ["two words", "single q", "x"]);
	});

	it("keeps a quoted empty string as an argument", () => {
		assert.deepEqual(parseCommandArgs(`"" x`), ["", "x"]);
	});
});

describe("substituteArgs", () => {
	it("replaces numbered positions, using an empty string for a missing one", () => {
		assert.equal(substituteArgs("$1 and $2 / $3", ["a", "b"]), "a and b / ");
	});

	it("replaces $@ and $ARGUMENTS with all args joined by spaces", () => {
		assert.equal(substituteArgs("$@ / $ARGUMENTS", ["a", "b"]), "a b / a b");
	});

	it("uses the default of ${N:-default} only when the arg is missing or empty", () => {
		assert.equal(substituteArgs("${1:-d}", []), "d");
		assert.equal(substituteArgs("${1:-d}", [""]), "d");
		assert.equal(substituteArgs("${1:-d}", ["x"]), "x");
	});

	it("uses the default of ${@:-default} only when there are no args", () => {
		assert.equal(substituteArgs("${@:-d}", []), "d");
		assert.equal(substituteArgs("${@:-d}", ["a", "b"]), "a b");
	});

	it("slices from the Nth arg with ${@:N}, and treats 0 as the first arg", () => {
		assert.equal(substituteArgs("${@:2}", ["a", "b", "c"]), "b c");
		assert.equal(substituteArgs("${@:0}", ["a", "b", "c"]), "a b c");
	});

	it("takes L args from the Nth arg with ${@:N:L}", () => {
		assert.equal(substituteArgs("${@:2:1}", ["a", "b", "c"]), "b");
	});

	it("does not expand placeholders that appear inside a substituted value", () => {
		assert.equal(substituteArgs("$1", ["$2"]), "$2");
	});

	it("keeps a quoted empty arg as a position", () => {
		assert.equal(substituteArgs("[$1][$2]", parseCommandArgs(`"" x`)), "[][x]");
	});
});
