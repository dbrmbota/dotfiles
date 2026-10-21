import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expandAgentVars, mergeAgentVars } from "./vars.ts";

describe("expandAgentVars", () => {
	it("replaces bare and braced names that are set", () => {
		const vars = new Map([["NAME", "x"]]);
		assert.equal(expandAgentVars("a $NAME and ${NAME}", vars), "a x and x");
	});

	it("uses the fallback of ${NAME:-default} only when the name is unset", () => {
		assert.equal(expandAgentVars("${MODE:-default}", new Map()), "default");
		assert.equal(expandAgentVars("${MODE:-default}", new Map([["MODE", "read-only"]])), "read-only");
	});

	it("leaves unknown names literal and does not expand substituted values again", () => {
		assert.equal(expandAgentVars("$OTHER", new Map()), "$OTHER");
		assert.equal(expandAgentVars("$NAME", new Map([["NAME", "$OTHER"], ["OTHER", "y"]])), "$OTHER");
	});
});

describe("mergeAgentVars", () => {
	it("sets string values and keeps other names", () => {
		const map = new Map([["KEEP", "1"]]);
		mergeAgentVars(map, { ARTIFACTS_PATH: "/tmp/a" });
		assert.deepEqual([...map.entries()], [["KEEP", "1"], ["ARTIFACTS_PATH", "/tmp/a"]]);
	});

	it("removes a name when its value is null", () => {
		const map = new Map([["ARTIFACTS_PATH", "/tmp/a"]]);
		mergeAgentVars(map, { ARTIFACTS_PATH: null });
		assert.equal(map.has("ARTIFACTS_PATH"), false);
	});

	it("ignores values that are neither strings nor null", () => {
		const map = new Map<string, string>();
		mergeAgentVars(map, { COUNT: 3, FLAG: true, MISSING: undefined } as unknown as Record<string, string | null>);
		assert.equal(map.size, 0);
	});
});
