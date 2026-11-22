import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	type FrameSection,
	extractBgSgr,
	extractLeadingBgSgr,
	formatBottomBorder,
	formatTopBorder,
	frameContainerSections,
	frameLines,
	isBlankLine,
	parseTruecolorBg,
	wrapRoundedPill,
} from "./border.ts";
import { RESET_BG, modePendingFromLabel } from "./style.ts";

const RESET = "\x1b[0m";
const BORDER_FG = "\x1b[38;2;90;90;110m";
const SGR = /\x1b\[[0-9;]*m/g;
const CAP_LEFT = "\ue0b6";
const CAP_RIGHT = "\ue0b4";
const RED = "\x1b[31m";

function measure(text: string): number {
	return text.replace(SGR, "").length;
}

/** Cuts `text` to `width` visible columns, keeping SGR sequences. */
function truncate(text: string, width: number): string {
	let out = "";
	let visible = 0;
	for (const token of text.split(/(\x1b\[[0-9;]*m)/)) {
		if (token === "") continue;
		if (token.startsWith("\x1b[")) {
			out += token;
			continue;
		}
		for (const ch of token) {
			if (visible >= width) break;
			out += ch;
			visible++;
		}
	}
	return out;
}

describe("extractBgSgr", () => {
	it("detects truecolor, 256-colour and basic backgrounds", () => {
		assert.equal(extractBgSgr((t) => `\x1b[48;2;10;20;30m${t}`), "\x1b[48;2;10;20;30m");
		assert.equal(extractBgSgr((t) => `\x1b[48;5;236m${t}`), "\x1b[48;5;236m");
		assert.equal(extractBgSgr((t) => `\x1b[41m${t}`), "\x1b[41m");
		assert.equal(extractBgSgr((t) => `\x1b[104m${t}`), "\x1b[104m");
	});

	it("returns undefined for a missing, no-op or foreground-only function", () => {
		assert.equal(extractBgSgr(undefined), undefined);
		assert.equal(extractBgSgr((t) => t), undefined);
		assert.equal(extractBgSgr((t) => `\x1b[38;2;10;20;30m${t}\x1b[39m`), undefined);
	});
});

describe("parseTruecolorBg", () => {
	it("parses truecolor background sequences, including combined parameters", () => {
		assert.deepEqual(parseTruecolorBg("\x1b[48;2;10;20;30m"), { r: 10, g: 20, b: 30 });
		assert.deepEqual(parseTruecolorBg("\x1b[1;48;2;255;128;0m"), { r: 255, g: 128, b: 0 });
	});

	it("returns undefined for non-truecolor sequences", () => {
		assert.equal(parseTruecolorBg("\x1b[48;5;236m"), undefined);
		assert.equal(parseTruecolorBg("\x1b[41m"), undefined);
		assert.equal(parseTruecolorBg("\x1b[38;2;10;20;30m"), undefined);
	});
});

describe("frameLines", () => {
	it("returns the input unchanged for empty lines or width < 3", () => {
		assert.deepEqual(frameLines([], 10, BORDER_FG, measure, truncate), []);
		assert.deepEqual(frameLines(["hi"], 2, BORDER_FG, measure, truncate), ["hi"]);
	});

	it("emits a rounded frame exactly width columns wide", () => {
		const out = frameLines(["ab"], 6, BORDER_FG, measure, truncate);
		assert.deepEqual(out, [
			`${BORDER_FG}╭────╮${RESET}`,
			`${BORDER_FG}│${RESET}ab  ${RESET}${BORDER_FG}│${RESET}`,
			`${BORDER_FG}╰────╯${RESET}`,
		]);
		for (const line of out) assert.equal(measure(line), 6);
	});

	it("pads short lines to the inner width", () => {
		const [, row] = frameLines(["ab"], 6, BORDER_FG, measure, truncate);
		assert.equal(row, `${BORDER_FG}│${RESET}ab  ${RESET}${BORDER_FG}│${RESET}`);
	});

	it("truncates overflowing lines to the inner width", () => {
		const out = frameLines(["abcdefgh"], 5, BORDER_FG, measure, truncate);
		assert.equal(out[1], `${BORDER_FG}│${RESET}abc${RESET}${BORDER_FG}│${RESET}`);
		assert.equal(measure(out[1]!), 5);
	});

	it("isolates inner ANSI SGR before the right border", () => {
		const [, row] = frameLines(["\x1b[31mab"], 6, BORDER_FG, measure, truncate);
		assert.equal(row, `${BORDER_FG}│${RESET}\x1b[31mab  ${RESET}${BORDER_FG}│${RESET}`);
		assert.ok(row!.endsWith(`${RESET}${BORDER_FG}│${RESET}`));
	});

	it("passes Kitty and iTerm image lines through unmodified", () => {
		const kitty = "\x1b_Gf=100,a=T;AAAA\x1b\\";
		const iterm = "\x1b]1337;File=inline=1:AAAA\x07";
		const out = frameLines([kitty, iterm], 10, BORDER_FG, measure, truncate);
		assert.deepEqual(out.slice(1, 3), [kitty, iterm]);
	});
});

describe("modePendingFromLabel", () => {
	it("returns an empty string for resting mode labels", () => {
		for (const label of [" INSERT ", " NORMAL ", " VISUAL ", " V-LINE "]) {
			assert.equal(modePendingFromLabel(label), "");
		}
	});

	it("extracts EX commands and pending vim keys", () => {
		assert.equal(modePendingFromLabel(" EX :help foo_ "), ":help foo_");
		assert.equal(modePendingFromLabel(" EX :_ "), ":_");
		assert.equal(modePendingFromLabel(" NORMAL 2d_ "), "2d_");
		assert.equal(modePendingFromLabel(" NORMAL r_ "), "r_");
		assert.equal(modePendingFromLabel(" VISUAL g_ "), "g_");
		assert.equal(modePendingFromLabel(" NORMAL Z_ "), "Z_");
	});
});

describe("extractLeadingBgSgr", () => {
	it("returns truecolor, 256-colour and basic backgrounds", () => {
		assert.equal(extractLeadingBgSgr("\x1b[48;2;10;20;30mhi"), "\x1b[48;2;10;20;30m");
		assert.equal(extractLeadingBgSgr("\x1b[48;5;236mhi"), "\x1b[48;5;236m");
		assert.equal(extractLeadingBgSgr("\x1b[41mhi"), "\x1b[41m");
		assert.equal(extractLeadingBgSgr("\x1b[104mhi"), "\x1b[104m");
	});

	it("finds the background when foreground SGR comes before or after it", () => {
		assert.equal(extractLeadingBgSgr("\x1b[48;2;10;20;30m\x1b[38;2;1;2;3mhi"), "\x1b[48;2;10;20;30m");
		assert.equal(extractLeadingBgSgr("\x1b[38;5;200m\x1b[48;5;236mhi"), "\x1b[48;5;236m");
	});

	it("reads combined SGR parameters and returns the background alone", () => {
		assert.equal(extractLeadingBgSgr("\x1b[1;48;2;10;20;30;38;2;1;2;3mhi"), "\x1b[48;2;10;20;30m");
	});

	it("ignores 48 used as a foreground parameter", () => {
		assert.equal(extractLeadingBgSgr("\x1b[38;2;48;2;1;2;3mhi"), undefined);
		assert.equal(extractLeadingBgSgr("\x1b[38;5;48mhi"), undefined);
	});

	it("keeps the last active background and clears it on 0 or 49", () => {
		assert.equal(extractLeadingBgSgr("\x1b[41m\x1b[48;2;1;2;3mhi"), "\x1b[48;2;1;2;3m");
		assert.equal(extractLeadingBgSgr("\x1b[48;2;10;20;30m\x1b[0mhi"), undefined);
		assert.equal(extractLeadingBgSgr("\x1b[48;2;10;20;30m\x1b[49mhi"), undefined);
	});

	it("ignores backgrounds outside the leading SGR run", () => {
		assert.equal(extractLeadingBgSgr("hi\x1b[48;2;1;2;3m"), undefined);
		assert.equal(extractLeadingBgSgr("\x1b[38;2;1;2;3mhi"), undefined);
	});
});

describe("extractBgSgr with theme wrappers", () => {
	it("detects a background followed by a trailing reset", () => {
		assert.equal(extractBgSgr((t) => `\x1b[48;2;1;2;3m${t}\x1b[49m`), "\x1b[48;2;1;2;3m");
	});

	it("detects a background with foreground SGR before or after it", () => {
		assert.equal(
			extractBgSgr((t) => `\x1b[48;2;1;2;3m\x1b[38;2;9;9;9m${t}\x1b[39m\x1b[49m`),
			"\x1b[48;2;1;2;3m",
		);
		assert.equal(extractBgSgr((t) => `\x1b[38;5;200m\x1b[48;5;236m${t}\x1b[49m`), "\x1b[48;5;236m");
	});
});

describe("wrapRoundedPill", () => {
	const BG = "\x1b[48;2;10;20;30m";
	const FG_OF_BG = "\x1b[38;2;10;20;30m";

	it("draws rounded caps in the background colour around background-filled text", () => {
		const text = `${BG}hi${RESET}`;
		assert.equal(
			wrapRoundedPill(text, CAP_LEFT, CAP_RIGHT),
			`${RESET_BG}${FG_OF_BG}${CAP_LEFT}${RESET}${text}${RESET}${FG_OF_BG}${RESET_BG}${CAP_RIGHT}${RESET}`,
		);
	});

	it("keeps nested foreground SGR inside the pill", () => {
		const text = `${BG}\x1b[38;2;1;2;3mhi${RESET}`;
		const out = wrapRoundedPill(text, CAP_LEFT, CAP_RIGHT);
		assert.ok(out.startsWith(`${RESET_BG}${FG_OF_BG}${CAP_LEFT}${RESET}${text}`));
		assert.ok(out.endsWith(`${FG_OF_BG}${RESET_BG}${CAP_RIGHT}${RESET}`));
	});

	it("returns plain and foreground-only text unchanged", () => {
		assert.equal(wrapRoundedPill("hi", CAP_LEFT, CAP_RIGHT), "hi");
		const fgOnly = "\x1b[38;2;1;2;3mhi\x1b[39m";
		assert.equal(wrapRoundedPill(fgOnly, CAP_LEFT, CAP_RIGHT), fgOnly);
	});
});

describe("formatTopBorder", () => {
	it("draws a plain rounded top when the label is empty", () => {
		assert.equal(formatTopBorder(10, BORDER_FG, "", measure, truncate), `${BORDER_FG}╭${"─".repeat(8)}╮${RESET}`);
	});

	it("draws a plain rounded top when the inner width is under 5", () => {
		assert.equal(
			formatTopBorder(6, BORDER_FG, `${BORDER_FG}x`, measure, truncate),
			`${BORDER_FG}╭${"─".repeat(4)}╮${RESET}`,
		);
	});

	it("returns an empty string below width 3", () => {
		assert.equal(formatTopBorder(2, BORDER_FG, "x", measure, truncate), "");
	});

	it("fits the label with ANSI isolation at exact width", () => {
		const label = `${BORDER_FG}:help foo_`;
		const out = formatTopBorder(20, BORDER_FG, label, measure, truncate);
		assert.equal(out, `${BORDER_FG}╭─ ${RESET}${label}${RESET}${BORDER_FG} ${"─".repeat(5)}╮${RESET}`);
		assert.equal(measure(out), 20);
		assert.equal(out.replace(SGR, ""), "╭─ :help foo_ ─────╮");
	});

	it("truncates an overlong label cleanly", () => {
		const out = formatTopBorder(12, BORDER_FG, "abcdefghijklmnop", measure, truncate);
		assert.equal(measure(out), 12);
		assert.equal(out.replace(SGR, ""), "╭─ abcdef ─╮");
	});
});

describe("formatBottomBorder", () => {
	const agent = { text: "agent", priority: 65 };
	const model = { text: "model", priority: 60 };
	const ctx = { text: "ctx", priority: 70 };
	const cost = { text: "$1.000", priority: 50 };
	const pct = "0.0%";
	const plain = (out: string) => out.replace(SGR, "");

	it("lays out left and right items at exact width", () => {
		const out = formatBottomBorder(30, BORDER_FG, [agent, model], [ctx], "", measure);
		assert.equal(measure(out), 30);
		assert.equal(plain(out), `╰─ agent ─ model ${"─".repeat(6)} ctx ─╯`);
	});

	it("lays out left, middle and right at exact width with split fill", () => {
		const out = formatBottomBorder(40, BORDER_FG, [agent], [cost], pct, measure);
		assert.equal(measure(out), 40);
		assert.equal(plain(out), `╰─ agent ${"─".repeat(7)} 0.0% ${"─".repeat(8)} $1.000 ─╯`);
	});

	it("lays out left and middle at exact width", () => {
		const out = formatBottomBorder(20, BORDER_FG, [agent], [], pct, measure);
		assert.equal(measure(out), 20);
		assert.equal(plain(out), `╰─ agent ${"─".repeat(3)} 0.0% ─╯`);
	});

	it("lays out middle and right at exact width", () => {
		const out = formatBottomBorder(20, BORDER_FG, [], [cost], pct, measure);
		assert.equal(measure(out), 20);
		assert.equal(plain(out), `╰─ 0.0% ${"─".repeat(2)} $1.000 ─╯`);
	});

	it("lays out right only at exact width", () => {
		const out = formatBottomBorder(20, BORDER_FG, [], [ctx], "", measure);
		assert.equal(measure(out), 20);
		assert.match(plain(out), /^╰─+ ctx ─╯$/);
	});

	it("lays out left only at exact width", () => {
		const out = formatBottomBorder(20, BORDER_FG, [agent], [], "", measure);
		assert.equal(measure(out), 20);
		assert.match(plain(out), /^╰─ agent ─+╯$/);
	});

	it("keeps coloured item text out of the width measurement", () => {
		const coloured = { text: `${RED}agent${RESET}`, priority: 65 };
		const out = formatBottomBorder(20, BORDER_FG, [coloured], [ctx], "", measure);
		assert.equal(measure(out), 20);
		assert.equal(plain(out), `╰─ agent ${"─".repeat(4)} ctx ─╯`);
	});

	it("draws the middle alone when both sides are empty", () => {
		const out = formatBottomBorder(20, BORDER_FG, [], [], pct, measure);
		assert.equal(measure(out), 20);
		assert.match(plain(out), /^╰─ 0\.0% ─+╯$/);
	});

	it("drops the middle first on narrow widths", () => {
		const out = formatBottomBorder(20, BORDER_FG, [model], [ctx], pct, measure);
		assert.equal(measure(out), 20);
		assert.equal(plain(out), `╰─ model ${"─".repeat(4)} ctx ─╯`);
	});

	it("then drops the lowest-priority side item", () => {
		const out = formatBottomBorder(20, BORDER_FG, [agent, model], [ctx], "", measure);
		assert.equal(measure(out), 20);
		assert.equal(plain(out), `╰─ agent ${"─".repeat(4)} ctx ─╯`);
	});

	it("falls back to a plain bottom when nothing fits", () => {
		assert.equal(
			formatBottomBorder(8, BORDER_FG, [agent], [ctx], "", measure),
			`${BORDER_FG}╰${"─".repeat(6)}╯${RESET}`,
		);
	});

	it("falls back to a plain bottom when the middle does not fit", () => {
		assert.equal(
			formatBottomBorder(8, BORDER_FG, [], [], pct, measure),
			`${BORDER_FG}╰${"─".repeat(6)}╯${RESET}`,
		);
	});

	it("returns an empty string below width 3", () => {
		assert.equal(formatBottomBorder(2, BORDER_FG, [agent], [ctx], pct, measure), "");
	});
});

describe("frameLines custom borders", () => {
	it("replaces the top and bottom rows and keeps content rows", () => {
		const out = frameLines(["ab"], 6, BORDER_FG, measure, truncate, { top: "TOP", bottom: "BOT" });
		assert.deepEqual(out, ["TOP", `${BORDER_FG}│${RESET}ab  ${RESET}${BORDER_FG}│${RESET}`, "BOT"]);
	});

	it("replaces only the rows that are given", () => {
		const out = frameLines(["ab"], 6, BORDER_FG, measure, truncate, { top: "TOP" });
		assert.equal(out[0], "TOP");
		assert.equal(out[2], `${BORDER_FG}╰────╯${RESET}`);
	});

	it("adds symmetric outer horizontal margin while keeping total width and passing images through", () => {
		const kitty = "\x1b_Gf=100,a=T;AAAA\x1b\\";
		const top = formatTopBorder(6, BORDER_FG, `${BORDER_FG}U`, measure, truncate);
		const out = frameLines(["abcd", kitty], 8, BORDER_FG, measure, truncate, { top, marginX: 1 });
		assert.deepEqual(out, [
			` ${top} `,
			` ${BORDER_FG}│${RESET}abcd${RESET}${BORDER_FG}│${RESET} `,
			kitty,
			` ${BORDER_FG}╰────╯${RESET} `,
		]);
		assert.equal(measure(out[0]!), 8);
		assert.equal(measure(out[1]!), 8);
		assert.equal(measure(out[3]!), 8);
		assert.deepEqual(frameLines(["hi"], 4, BORDER_FG, measure, truncate, { marginX: 1 }), ["hi"]);
	});
});

describe("isBlankLine", () => {
	it("is true for empty strings, whitespace and SGR-only whitespace", () => {
		assert.equal(isBlankLine(""), true);
		assert.equal(isBlankLine("   "), true);
		assert.equal(isBlankLine(`${RED}  ${RESET}`), true);
	});

	it("is false for visible text", () => {
		assert.equal(isBlankLine("x"), false);
		assert.equal(isBlankLine(`${RED} x ${RESET}`), false);
	});

	it("is false for Kitty and iTerm image lines", () => {
		assert.equal(isBlankLine("\x1b_Gf=100,a=T;AAAA\x1b\\"), false);
		assert.equal(isBlankLine("\x1b]1337;File=inline=1:AAAA\x07"), false);
	});

	it("is false for lines with APC cursor markers", () => {
		assert.equal(isBlankLine("\x1b_pi:c\x07"), false);
		assert.equal(isBlankLine("\x1b_pi:fc\x07"), false);
	});
});

describe("frameContainerSections", () => {
	const frame = (sections: FrameSection[]) => frameContainerSections(sections, 6, BORDER_FG, measure, truncate);
	const top = `${BORDER_FG}╭────╮${RESET}`;
	const bottom = `${BORDER_FG}╰────╯${RESET}`;
	const divider = `${BORDER_FG}├────┤${RESET}`;
	/** A content row whose inner text is already padded to the 2-column inner width. */
	const row = (content: string) => `${BORDER_FG}│${RESET} ${content} ${RESET}${BORDER_FG}│${RESET}`;

	it("emits an exact width-column rounded frame with one space of inner padding", () => {
		assert.deepEqual(frame([{ isDivider: false, lines: ["a"] }]), {
			lines: [top, row("a "), bottom],
			heights: [1],
			trimmedTops: [0],
		});
		for (const line of frame([{ isDivider: false, lines: ["a"] }]).lines) assert.equal(measure(line), 6);
	});

	it("isolates inner ANSI SGR before the right border", () => {
		const [, content] = frame([{ isDivider: false, lines: [`${RED}ab`] }]).lines;
		assert.equal(content, `${BORDER_FG}│${RESET} ${RED}ab ${RESET}${BORDER_FG}│${RESET}`);
		assert.equal(measure(content!), 6);
	});

	it("renders divider sections as full-width tee rows", () => {
		assert.deepEqual(
			frame([{ isDivider: false, lines: ["a"] }, { isDivider: true }, { isDivider: false, lines: ["b"] }]),
			{ lines: [top, row("a "), divider, row("b "), bottom], heights: [1, 1, 1], trimmedTops: [0, 0, 0] },
		);
	});

	it("strips leading and trailing blank lines across sections and keeps interior blank lines", () => {
		assert.deepEqual(
			frame([
				{ isDivider: false, lines: [""] },
				{ isDivider: false, lines: ["", "a", "", "b", ""] },
				{ isDivider: false, lines: ["", ""] },
			]),
			{
				lines: [top, row("a "), row("  "), row("b "), bottom],
				heights: [0, 3, 0],
				trimmedTops: [1, 1, 0],
			},
		);
	});

	it("stops leading trimming at a divider", () => {
		assert.deepEqual(
			frame([{ isDivider: false, lines: [""] }, { isDivider: true }, { isDivider: false, lines: ["a", ""] }]),
			{ lines: [top, divider, row("a "), bottom], heights: [0, 1, 1], trimmedTops: [1, 0, 0] },
		);
	});

	it("stops trailing trimming at a divider", () => {
		assert.deepEqual(
			frame([{ isDivider: false, lines: ["a", ""] }, { isDivider: true }, { isDivider: false, lines: ["", "b"] }]),
			{
				lines: [top, row("a "), row("  "), divider, row("  "), row("b "), bottom],
				heights: [2, 1, 2],
				trimmedTops: [0, 0, 0],
			},
		);
	});

	it("passes Kitty and iTerm image lines through unmodified and truncates content to width - 4", () => {
		const kitty = "\x1b_Gf=100,a=T;AAAA\x1b\\";
		const iterm = "\x1b]1337;File=inline=1:AAAA\x07";
		const out = frame([{ isDivider: false, lines: [kitty, iterm, "abcdefgh"] }]);
		assert.deepEqual(out.lines, [top, kitty, iterm, row("ab"), bottom]);
		assert.deepEqual(out.heights, [3]);
		assert.equal(measure(out.lines[3]!), 6);
	});

	it("adds symmetric outer horizontal margin around borders and dividers", () => {
		const kitty = "\x1b_Gf=100,a=T;AAAA\x1b\\";
		const out = frameContainerSections(
			[{ isDivider: false, lines: ["abcdef", kitty] }, { isDivider: true }, { isDivider: false, lines: ["x"] }],
			8,
			BORDER_FG,
			measure,
			truncate,
			1,
		);
		assert.deepEqual(out.lines, [
			` ${top} `,
			` ${row("ab")} `,
			kitty,
			` ${divider} `,
			` ${row("x ")} `,
			` ${bottom} `,
		]);
		for (const line of out.lines) {
			if (line !== kitty) assert.equal(measure(line), 8);
		}
	});
});
