import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { installBlockChrome } from "./blocks.ts";

const options = {
	railGlyph: "┃",
	railColors: {},
} as const;

function fakeTheme() {
	return {
		getBgAnsi: () => "",
		getFgAnsi: () => "",
	} as unknown as Parameters<typeof installBlockChrome>[0] extends never
		? never
		: ReturnType<Parameters<typeof installBlockChrome>[0]>;
}

describe("installBlockChrome", () => {
	it("wraps Box, Text, and Markdown render methods", () => {
		const boxRender = Box.prototype.render;
		const textRender = Text.prototype.render;
		const markdownRender = Markdown.prototype.render;
		const undo = installBlockChrome(fakeTheme(), options);
		try {
			assert.notEqual(Box.prototype.render, boxRender);
			assert.notEqual(Text.prototype.render, textRender);
			assert.notEqual(Markdown.prototype.render, markdownRender);
		} finally {
			undo();
		}
	});

	it("restores the original render methods on undo", () => {
		const boxRender = Box.prototype.render;
		const textRender = Text.prototype.render;
		const markdownRender = Markdown.prototype.render;
		const undo = installBlockChrome(fakeTheme(), options);
		undo();
		assert.equal(Box.prototype.render, boxRender);
		assert.equal(Text.prototype.render, textRender);
		assert.equal(Markdown.prototype.render, markdownRender);
	});
});
