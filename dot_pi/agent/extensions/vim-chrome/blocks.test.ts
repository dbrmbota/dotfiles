import { afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type * as Coding from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type * as Tui from "@earendil-works/pi-tui";
import type { TuiMouseDispatchTarget, TuiMouseEvent, MarkdownTheme } from "@earendil-works/pi-tui";
import type { installBlockChrome } from "./blocks.ts";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_TUI = "@earendil-works/pi-tui";
const ORIGINAL = Symbol.for("vim-chrome.blocks.original");
const FRAME_LAYOUT = Symbol.for("vim-chrome.blocks.frame-layout");
const WIDTH = 40;
/** Columns from a framed Container's left edge to its interior content: margin, border, and padding. */
const INSET_X = 3;

type Pi = {
	tui: typeof Tui;
	coding: typeof Coding;
	installBlockChrome: typeof installBlockChrome;
	theme: Theme;
	retargetMouseEvent: TuiModule["retargetMouseEvent"];
};

type MouseResult = { handled?: boolean; focus?: boolean };

type ThemeModule = {
	loadThemeFromPath(path: string): Theme;
	setThemeInstance(theme: Theme): void;
};

type TuiModule = {
	retargetMouseEvent(event: TuiMouseEvent, target: TuiMouseDispatchTarget): TuiMouseEvent;
};

/** Real paths of the pi binaries to try: `which pi`, then the Homebrew default. */
function piBinaryPaths(): string[] {
	const found: string[] = [];
	try {
		found.push(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
	} catch {
		// `which` exits non-zero when pi is not on PATH; the Homebrew fallback still applies.
	}
	found.push("/opt/homebrew/bin/pi");
	return found.filter((path) => path !== "" && existsSync(path)).map((path) => realpathSync(path));
}

/** Package root of the pi install behind the binary, for Homebrew libexec and npm global layouts. */
function findPiPackageRoot(): string {
	for (const bin of piBinaryPaths()) {
		let dir = dirname(bin);
		for (;;) {
			for (const candidate of [
				join(dir, "node_modules", PI_PACKAGE),
				join(dir, "lib", "node_modules", PI_PACKAGE),
				join(dir, "libexec", "lib", "node_modules", PI_PACKAGE),
			]) {
				if (existsSync(join(candidate, "package.json"))) return candidate;
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	throw new Error("pi installation not found: put `pi` on PATH or install it under /opt/homebrew");
}

/** Loads pi-tui, pi-coding-agent, and blocks.ts through pi's bundled jiti, sharing one module instance of each. */
async function loadPi(): Promise<Pi> {
	const root = findPiPackageRoot();
	const requireFromPi = createRequire(join(root, "package.json"));
	const tuiPackageJson = requireFromPi.resolve(`${PI_TUI}/package.json`);
	const tuiEntry = join(dirname(tuiPackageJson), JSON.parse(readFileSync(tuiPackageJson, "utf8")).main);
	const codingEntry = join(root, "dist", "index.js");
	const themeDir = join(root, "dist", "modes", "interactive", "theme");
	const { createJiti } = await import(requireFromPi.resolve("jiti"));
	const jiti = createJiti(import.meta.url, {
		alias: { [PI_TUI]: tuiEntry, [PI_PACKAGE]: codingEntry },
		interopDefault: true,
		moduleCache: true,
	});
	const tui = await jiti.import<typeof Tui>(tuiEntry);
	const coding = await jiti.import<typeof Coding>(codingEntry);
	const chrome = await jiti.import<{ installBlockChrome: typeof installBlockChrome }>(
		new URL("./blocks.ts", import.meta.url).pathname,
	);
	const tuiModule = await jiti.import<TuiModule>(join(dirname(tuiEntry), "tui.js"));
	const themeModule = await jiti.import<ThemeModule>(join(themeDir, "theme.js"));
	const theme = themeModule.loadThemeFromPath(join(themeDir, "dark.json"));
	themeModule.setThemeInstance(theme);
	return {
		tui,
		coding,
		installBlockChrome: chrome.installBlockChrome,
		theme,
		retargetMouseEvent: tuiModule.retargetMouseEvent,
	};
}

let pi: Pi;
let restore: (() => void) | undefined;

before(async () => {
	pi = await loadPi();
});

afterEach(() => {
	restore?.();
	restore = undefined;
});

/** Installs the chrome patches with the loaded theme and returns their restore function. */
function installChrome(): () => void {
	restore = pi.installBlockChrome(() => pi.theme);
	assert.ok(
		Object.hasOwn(pi.tui.Container.prototype, ORIGINAL),
		"blocks.ts must patch the same pi-tui instance that the tests use",
	);
	return restore;
}

/** Leaf component with fixed rows that records each mouse event and each render width it receives. */
class Probe {
	lines: readonly string[];
	result: MouseResult | undefined;
	events: TuiMouseEvent[] = [];
	renderWidths: number[] = [];

	constructor(lines: readonly string[], result: MouseResult | undefined = { handled: true }) {
		this.lines = lines;
		this.result = result;
	}

	render(width: number): readonly string[] {
		this.renderWidths.push(width);
		return this.lines;
	}

	handleMouse(event: TuiMouseEvent): MouseResult | undefined {
		this.events.push(event);
		return this.result;
	}
}

class ThrowingProbe extends Probe {
	handleMouse(): never {
		throw new Error("child failed");
	}
}

/** Named like pi's allowlisted inline dialog, so frameInlineDialog frames it. */
class PermissionPromptComponent extends Probe {}

/** Named like pi's ModalEditor, which is not allowlisted, so it is never framed. */
class ModalEditor extends Probe {}

function mouse(x: number, y: number, width = WIDTH, height = 20, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type: "press",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		...extra,
	};
}

function geometry(event: TuiMouseEvent): { x: number; y: number; width: number; height: number } {
	return { x: event.x, y: event.y, width: event.width, height: event.height };
}

/** The Container's cached child layout, which pi-tui keeps in a private field. */
function childLinesOf(container: object): { children: unknown[] } | undefined {
	return (container as { childLines?: { children: unknown[] } }).childLines;
}

/** Adds the frame's leading Spacer, top DynamicBorder, `interior`, bottom DynamicBorder, and trailing Spacer. */
function frame(container: Tui.Container, interior: Tui.Component[]): Tui.Container {
	container.addChild(new pi.tui.Spacer(1));
	container.addChild(new pi.coding.DynamicBorder());
	for (const child of interior) container.addChild(child);
	container.addChild(new pi.coding.DynamicBorder());
	container.addChild(new pi.tui.Spacer(1));
	return container;
}

function framedContainer(interior: Tui.Component[]): Tui.Container {
	class FramedContainer extends pi.tui.Container {}
	return frame(new FramedContainer(), interior);
}

function identityMarkdownTheme(): MarkdownTheme {
	const identity = (text: string) => text;
	return {
		heading: identity,
		link: identity,
		linkUrl: identity,
		code: identity,
		codeBlock: identity,
		codeBlockBorder: identity,
		quote: identity,
		quoteBorder: identity,
		hr: identity,
		listBullet: identity,
		bold: identity,
		italic: identity,
		strikethrough: identity,
		underline: identity,
	};
}

describe("blocks.ts: framed Container subclass mouse dispatch", () => {
	beforeEach(() => {
		installChrome();
	});

	it("maps clicks on interior children to child-local coordinates", () => {
		const top = new Probe(["row a1", "row a2"]);
		const bottom = new Probe(["row b1"]);
		const container = framedContainer([top, new pi.coding.DynamicBorder(), bottom]);
		container.render(WIDTH);
		container.handleMouse(mouse(5, 2));
		container.handleMouse(mouse(5, 5));
		assert.deepEqual(top.events.map(geometry), [{ x: 2, y: 0, width: WIDTH - 2 * INSET_X, height: 2 }]);
		assert.deepEqual(bottom.events.map(geometry), [{ x: 2, y: 0, width: WIDTH - 2 * INSET_X, height: 1 }]);
	});

	it("maps rows of a child with trimmed leading blank lines back to its own rows", () => {
		const child = new Probe(["", "", "content"]);
		const container = framedContainer([child]);
		container.render(WIDTH);
		container.handleMouse(mouse(5, 2));
		assert.deepEqual(child.events.map(geometry), [{ x: 2, y: 2, width: WIDTH - 2 * INSET_X, height: 3 }]);
	});

	it("clamps the translated x to the inner width", () => {
		const child = new Probe(["row"]);
		const container = framedContainer([child]);
		container.render(WIDTH);
		container.handleMouse(mouse(2, 2));
		container.handleMouse(mouse(WIDTH - 3, 2));
		assert.deepEqual(
			child.events.map((event) => event.x),
			[0, WIDTH - 2 * INSET_X - 1],
		);
	});

	it("returns a target whose origin retargets later drag events accurately", () => {
		const child = new Probe(["row a1", "row a2"]);
		const container = framedContainer([child]);
		container.render(WIDTH);
		const result = container.handleMouse(mouse(5, 2));
		assert.ok(result?.target, "a click on a child returns a dispatch target");
		const drag = pi.retargetMouseEvent(
			mouse(0, 0, WIDTH, 20, { type: "drag", screenX: 20, screenY: 3 }),
			result.target,
		);
		assert.deepEqual(geometry(drag), { x: 17, y: 1, width: WIDTH - 2 * INSET_X, height: 2 });
	});

	it("keeps the framed container as focusTarget for a handleInput-bearing subclass", () => {
		class FocusContainer extends pi.tui.Container {
			handleInput(): void {}
		}
		const child = new Probe(["focus row"], { handled: true, focus: true });
		const container = frame(new FocusContainer(), [child]);
		container.render(WIDTH);
		const result = container.handleMouse(mouse(5, 2));
		assert.equal(result?.focusTarget, container);
	});

	it("returns undefined for margin, border, DynamicBorder, and Spacer rows", () => {
		const top = new Probe(["row a1", "row a2"]);
		const bottom = new Probe(["row b1"]);
		const container = framedContainer([top, new pi.coding.DynamicBorder(), bottom]);
		container.render(WIDTH);
		const points: [number, number][] = [
			[0, 2],
			[1, 2],
			[WIDTH - 2, 2],
			[WIDTH - 1, 2],
			[5, 0],
			[5, 1],
			[5, 6],
			[5, 7],
		];
		for (const [x, y] of points) {
			assert.equal(container.handleMouse(mouse(x, y)), undefined, `x=${x} y=${y}`);
		}
		assert.equal(top.events.length + bottom.events.length, 0);
	});

	it("dispatches wheel events in the outer margin to the interior child", () => {
		const child = new Probe(["row"]);
		const container = framedContainer([child]);
		container.render(WIDTH);
		container.handleMouse(mouse(0, 2, WIDTH, 20, { type: "wheel", button: "none", wheelDelta: -1 }));
		assert.equal(child.events.length, 1);
		assert.equal(child.events[0]!.type, "wheel");
		assert.equal(child.events[0]!.x, 0);
	});

	it("returns undefined for events with y outside [0, height)", () => {
		const child = new Probe(["row a1", "row a2"]);
		const container = framedContainer([child]);
		container.render(WIDTH);
		assert.equal(container.handleMouse(mouse(5, 2, WIDTH, 2)), undefined);
		assert.equal(container.handleMouse(mouse(5, -1)), undefined);
		assert.equal(child.events.length, 0);
	});

	it("lazily renders before dispatching when the container was never rendered", () => {
		const child = new Probe(["row a1", "row a2"]);
		const container = framedContainer([child]);
		container.handleMouse(mouse(5, 2));
		assert.deepEqual(child.events.map(geometry), [{ x: 2, y: 0, width: WIDTH - 2 * INSET_X, height: 2 }]);
	});

	it("re-renders at a new width before dispatching", () => {
		const child = new Probe(["row a1", "row a2"]);
		const container = framedContainer([child]);
		container.render(WIDTH);
		container.handleMouse(mouse(5, 2, WIDTH + 10));
		assert.deepEqual(child.events.map(geometry), [
			{ x: 2, y: 0, width: WIDTH + 10 - 2 * INSET_X, height: 2 },
		]);
	});

	it("re-renders when childLines matches the width but FRAME_LAYOUT is missing", () => {
		const child = new Probe(["row a1", "row a2"]);
		const container = framedContainer([child]);
		container.render(WIDTH);
		delete (container as unknown as Record<symbol, unknown>)[FRAME_LAYOUT];
		container.handleMouse(mouse(5, 2));
		assert.deepEqual(child.events.map(geometry), [{ x: 2, y: 0, width: WIDTH - 2 * INSET_X, height: 2 }]);
	});

	it("restores this.childLines after handleMouse, including when the child throws", () => {
		const okContainer = framedContainer([new Probe(["row"])]);
		okContainer.render(WIDTH);
		const okBefore = childLinesOf(okContainer);
		okContainer.handleMouse(mouse(5, 2));
		assert.equal(childLinesOf(okContainer), okBefore);

		const throwingContainer = framedContainer([new ThrowingProbe(["row"])]);
		throwingContainer.render(WIDTH);
		const throwBefore = childLinesOf(throwingContainer);
		assert.throws(() => throwingContainer.handleMouse(mouse(5, 2)), /child failed/);
		assert.equal(childLinesOf(throwingContainer), throwBefore);
	});
});

describe("blocks.ts: frameInlineDialog plain Container", () => {
	beforeEach(() => {
		installChrome();
	});

	it("replaces a cleared ModalEditor layout so clicks in the framed dialog do not reach ModalEditor", () => {
		const modal = new ModalEditor(["modal line 1", "modal line 2"]);
		const container = new pi.tui.Container();
		container.addChild(modal);
		container.render(WIDTH);
		container.clear();
		const prompt = new PermissionPromptComponent(["Allow once?", "[y] yes  [n] no"]);
		container.addChild(prompt);
		const lines = container.render(WIDTH);
		assert.equal(lines.length, 4);
		assert.ok(lines[0]!.includes("╭"));
		assert.equal(childLinesOf(container)?.children[0], prompt);

		container.handleMouse(mouse(5, 1));
		assert.equal(modal.events.length, 0);
		assert.deepEqual(
			prompt.events.map((event) => ({ x: event.x, y: event.y, height: event.height })),
			[{ x: 5, y: 1, height: 4 }],
		);
		assert.ok(prompt.renderWidths.length > 0);
		assert.ok(prompt.renderWidths.every((width) => width === WIDTH - 6));
	});

	it("renders a ModalEditor unframed and dispatches to it after the prompt is removed", () => {
		const prompt = new PermissionPromptComponent(["Allow once?"]);
		const container = new pi.tui.Container();
		container.addChild(prompt);
		container.render(WIDTH);
		container.clear();
		const modal = new ModalEditor(["modal line 1", "modal line 2"]);
		container.addChild(modal);
		const lines = container.render(WIDTH);
		assert.deepEqual([...lines], ["modal line 1", "modal line 2"]);

		container.handleMouse(mouse(5, 1));
		assert.deepEqual(
			modal.events.map((event) => ({ x: event.x, y: event.y, height: event.height })),
			[{ x: 5, y: 1, height: 2 }],
		);
		assert.equal(prompt.events.length, 0);
	});
});

describe("blocks.ts: immutability", () => {
	beforeEach(() => {
		installChrome();
	});

	it("renders frozen child lines under a framed Container", () => {
		const child = new Probe(Object.freeze(["frozen row"]));
		const container = framedContainer([child]);
		const lines = container.render(WIDTH);
		assert.equal(lines.length, 5);
		container.handleMouse(mouse(5, 2));
		assert.equal(child.events.length, 1);
	});

	it("renders frozen child lines under frameInlineDialog", () => {
		const container = new pi.tui.Container();
		container.addChild(new PermissionPromptComponent(Object.freeze(["Allow once?"])));
		const lines = container.render(WIDTH);
		assert.equal(lines.length, 3);
	});

	it("renders Box, Text, and Markdown without throwing", () => {
		const bg = (text: string) => `\x1b[48;2;20;20;30m${text}\x1b[49m`;
		const box = new pi.tui.Box(1, 0, bg);
		box.addChild(new Probe(Object.freeze(["boxed row"])));
		assert.ok(box.render(WIDTH)[0]!.includes("╭"));

		const text = new pi.tui.Text("hello", 1, 0, bg);
		assert.ok(text.render(WIDTH)[0]!.includes("╭"));

		const markdown = new pi.tui.Markdown("hi", 1, 0, identityMarkdownTheme(), { bgColor: bg });
		assert.ok(markdown.render(WIDTH).length > 0);
	});
});

describe("blocks.ts: installBlockChrome restore", () => {
	it("restores Container.prototype.render and handleMouse to their exact pre-patch functions", () => {
		const { Container } = pi.tui;
		const render = Container.prototype.render;
		const handleMouse = Container.prototype.handleMouse;
		const undo = installChrome();
		assert.notEqual(Container.prototype.render, render);
		undo();
		restore = undefined;
		assert.equal(Container.prototype.render, render);
		assert.equal(Container.prototype.handleMouse, handleMouse);
	});
});
