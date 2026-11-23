import type { Theme } from "@earendil-works/pi-coding-agent";
import { BashExecutionComponent, DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	type Color,
	type Component,
	type TuiMouseEvent,
	Box,
	Container,
	Markdown,
	Spacer,
	Text,
	colorToOklch,
	foregroundAnsi,
	oklchColor,
	rgbColor,
	truncateToWidth,
	visibleWidth,
	TuiAltScreen,
} from "@earendil-works/pi-tui";
import {
	type FrameSection,
	extractBgSgr,
	formatTopBorder,
	frameContainerSections,
	frameInlineDialog,
	frameLines,
	parseTruecolorBg,
	wrapRoundedPill,
} from "./border";
import { bgToFg, fgAnsi } from "./style";

/** Key of the saved original methods on each patched prototype. */
const ORIGINAL = Symbol.for("vim-chrome.blocks.original");

/** Methods saved from a prototype before patching. */
type Originals = {
	render(width: number): string[];
	handleMouse?(event: TuiMouseEvent): unknown;
};

/** A prototype that may hold its saved originals under ORIGINAL. */
type Patchable = { [ORIGINAL]?: Originals };

type BoxView = { bgFn?: (text: string) => string; paddingY: number };
type TextView = { customBgFn?: (text: string) => string; paddingY: number };
type MarkdownView = { defaultTextStyle?: { bgColor?: (text: string) => string }; paddingY: number };
type BashView = { contentContainer?: { render?(width: number): string[] }; colorKey?: "bashMode" | "dim" };

/** Outer horizontal margin in columns on each side of framed blocks (keeps right border clear of the scrollbar). */
const MARGIN_X = 1;

/** Left inset of framed Container content in columns: margin, border column, plus one space of padding. */
const INSET_X = MARGIN_X + 2;

/** Key of the layout that a framed Container recorded in its last render, read back by its handleMouse. */
const FRAME_LAYOUT = Symbol.for("vim-chrome.blocks.frame-layout");

/** Row layout of a framed Container: the frame's first and last child indexes and the trimmed rows per child. */
type FrameLayout = { width: number; topIdx: number; bottomIdx: number; trimmedTops: number[] };

/** The Container fields that the framing patch reads and writes. */
type ContainerView = {
	children: readonly Component[];
	render(width: number): string[];
	mouseLayout?: { width: number; children: { component: Component; height: number }[] };
	[FRAME_LAYOUT]?: FrameLayout;
};

/** The field of a TuiAltScreen that the scroll-to-end patch reads and swaps. */
type ScrollIndicatorView = { scrollToEndIndicator?: () => string };

/** TuiAltScreen's prototype as the scroll-to-end patch sees it, with the saved original under Symbol.for. */
type ScrollIndicatorPatchable = {
	compositeScrollToEndIndicator: (this: ScrollIndicatorView, screen: string[], layout: unknown, width: number) => string[];
	[key: symbol]: unknown;
};

/** Rounded caps drawn around the fullscreen "Jump to latest message" pill. */
export type PillCaps = { capLeft: string; capRight: string };

/** Lightness shift of error borders, so they read as a deeper red than the other borders. */
const ERROR_LIGHTNESS_OFFSET = -0.05;

/**
 * Border colour for a block whose background is `source`: keeps the hue of `source`, takes the
 * lightness of the theme's dim colour shifted by `lightnessOffset`, and falls back to `fallbackFg`
 * when the colour is unusable.
 */
export function liftedBorderFg(
	theme: Theme,
	source: Color | undefined,
	fallbackFg: string,
	lightnessOffset = 0,
): string {
	if (source === undefined) return fallbackFg;
	try {
		const src = colorToOklch(source);
		const ref = colorToOklch(theme.colors.dim ?? theme.colors.border ?? theme.colors.muted);
		const achromatic = src.c < 0.005 || !Number.isFinite(src.h);
		const maxChroma = Math.max(ref.c * 1.15, 0.12);
		const minChroma = Math.min(Math.max(ref.c * 0.45, 0.04), maxChroma);
		const chroma = achromatic ? 0 : Math.min(maxChroma, Math.max(minChroma, src.c * 3));
		const color = oklchColor(ref.l + lightnessOffset, chroma, Number.isFinite(src.h) ? src.h : 0);
		return foregroundAnsi(color, theme.getColorMode());
	} catch {
		return fallbackFg;
	}
}

/** True when `bgSgr` is the theme's tool-error background. */
function isErrorBg(theme: Theme, bgSgr: string): boolean {
	try {
		const errorBg = theme.getBgAnsi("toolErrorBg");
		return errorBg !== "" && bgSgr.includes(errorBg);
	} catch {
		return false;
	}
}

/** True when `bgSgr` is the theme's user-message background. */
function isUserMessageBg(theme: Theme, bgSgr: string): boolean {
	try {
		const userBg = theme.getBgAnsi("userMessageBg");
		return userBg !== "" && bgSgr.includes(userBg);
	} catch {
		return false;
	}
}

/**
 * Border colour for a block with the background SGR `bgSgr`. Error backgrounds take the theme's
 * error colour, lifted and darkened; other truecolor backgrounds are lifted from their own colour.
 */
export function borderFgFromBgSgr(theme: Theme, bgSgr: string): string {
	if (isErrorBg(theme, bgSgr)) {
		return liftedBorderFg(theme, theme.colors.error, bgToFg(bgSgr), ERROR_LIGHTNESS_OFFSET);
	}
	const rgb = parseTruecolorBg(bgSgr);
	if (!rgb) return bgToFg(bgSgr);
	return liftedBorderFg(theme, rgbColor(rgb.r, rgb.g, rgb.b), bgToFg(bgSgr));
}

/**
 * Frames every backgrounded block (user messages, tool calls, custom and summary messages, `!` and `!!`
 * bash blocks) in a rounded border instead of a solid fill. When `scrollCaps` is given, the fullscreen
 * jump-to-latest pill is also wrapped in rounded caps. Patches the pi-tui and pi components on their
 * prototypes. Returns a function that restores the originals. Calling it again while patched is a no-op.
 */
export function installBlockChrome(getTheme: () => Theme, scrollCaps?: PillCaps): () => void {
	if (Object.prototype.hasOwnProperty.call(Box.prototype, ORIGINAL)) return () => {};
	// patchContainer runs last: patchBashExecution captures the inherited handleMouse, and must keep the unpatched one.
	const restores = [
		patchBox(getTheme),
		patchText(getTheme),
		patchMarkdown(getTheme),
		patchBashExecution(getTheme),
		patchContainer(getTheme),
	];
	if (scrollCaps) restores.push(patchScrollToEndIndicator(scrollCaps));
	return () => {
		for (const restore of restores) restore();
	};
}

/** Swaps `render` (and `handleMouse` when given) on `proto`, keeping the originals for restore. */
function patchPrototype(proto: object, build: (original: Originals) => Originals): () => void {
	const target = proto as Patchable & Originals;
	const original: Originals = { render: target.render, handleMouse: target.handleMouse };
	const methods = build(original);
	target[ORIGINAL] = original;
	target.render = methods.render;
	if (methods.handleMouse) target.handleMouse = methods.handleMouse;
	return () => {
		target.render = original.render;
		if (original.handleMouse) target.handleMouse = original.handleMouse;
		delete target[ORIGINAL];
	};
}

/** Patches Box.prototype.render and handleMouse. Returns the restore function. */
function patchBox(getTheme: () => Theme): () => void {
	const chromeWidth = 2 + 2 * MARGIN_X;
	return patchPrototype(Box.prototype, (original) => ({
		render(this: BoxView, width: number): string[] {
			const bg = extractBgSgr(this.bgFn);
			if (!bg || width < 3 + 2 * MARGIN_X) return original.render.call(this, width);
			const { bgFn, paddingY } = this;
			this.bgFn = undefined;
			this.paddingY = Math.max(0, paddingY - 1);
			let lines: string[];
			try {
				lines = original.render.call(this, width - chromeWidth);
			} finally {
				this.bgFn = bgFn;
				this.paddingY = paddingY;
			}
			return frameLines(
				lines,
				width,
				borderFgFromBgSgr(getTheme(), bg),
				visibleWidth,
				(text, w) => truncateToWidth(text, w, ""),
				{ marginX: MARGIN_X },
			);
		},
		handleMouse(this: BoxView, event: TuiMouseEvent): unknown {
			if (!extractBgSgr(this.bgFn) || event.width < 3 + 2 * MARGIN_X) return original.handleMouse?.call(this, event);
			const { x, y, width, height } = event;
			const borderInset = MARGIN_X + 1;
			if (x < borderInset || x >= width - borderInset || y < 1 || (height !== undefined && y >= height - 1)) {
				return undefined;
			}
			const { paddingY } = this;
			this.paddingY = Math.max(0, paddingY - 1);
			try {
				return original.handleMouse?.call(this, {
					...event,
					x: x - borderInset,
					y: y - 1,
					width: width - chromeWidth,
				});
			} finally {
				this.paddingY = paddingY;
			}
		},
	}));
}

/** Patches Text.prototype.render. Returns the restore function. */
function patchText(getTheme: () => Theme): () => void {
	const chromeWidth = 2 + 2 * MARGIN_X;
	return patchPrototype(Text.prototype, (original) => ({
		render(this: TextView, width: number): string[] {
			const bg = extractBgSgr(this.customBgFn);
			if (!bg || width < 3 + 2 * MARGIN_X) return original.render.call(this, width);
			const { customBgFn, paddingY } = this;
			this.customBgFn = undefined;
			this.paddingY = Math.max(0, paddingY - 1);
			let lines: string[];
			try {
				lines = original.render.call(this, width - chromeWidth);
			} finally {
				this.customBgFn = customBgFn;
				this.paddingY = paddingY;
			}
			return frameLines(
				lines,
				width,
				borderFgFromBgSgr(getTheme(), bg),
				visibleWidth,
				(text, w) => truncateToWidth(text, w, ""),
				{ marginX: MARGIN_X },
			);
		},
	}));
}

/** Patches Markdown.prototype.render (user messages). Returns the restore function. */
function patchMarkdown(getTheme: () => Theme): () => void {
	const chromeWidth = 2 + 2 * MARGIN_X;
	return patchPrototype(Markdown.prototype, (original) => ({
		render(this: MarkdownView, width: number): string[] {
			const style = this.defaultTextStyle;
			const bg = extractBgSgr(style?.bgColor);
			if (!style || !bg || width < 3 + 2 * MARGIN_X) return original.render.call(this, width);
			const { paddingY } = this;
			this.defaultTextStyle = { ...style, bgColor: undefined };
			this.paddingY = Math.max(0, paddingY - 1);
			let lines: string[];
			try {
				lines = original.render.call(this, width - chromeWidth);
			} finally {
				this.defaultTextStyle = style;
				this.paddingY = paddingY;
			}
			const theme = getTheme();
			const borderFg = borderFgFromBgSgr(theme, bg);
			const truncate = (text: string, w: number) => truncateToWidth(text, w, "");
			const top = isUserMessageBg(theme, bg)
				? formatTopBorder(
						width - 2 * MARGIN_X,
						borderFg,
						`${borderFg}${theme.bold("User")}`,
						visibleWidth,
						truncate,
					)
				: undefined;
			return frameLines(lines, width, borderFg, visibleWidth, truncate, {
				...(top ? { top } : {}),
				marginX: MARGIN_X,
			});
		},
	}));
}

/**
 * Wraps TuiAltScreen's jump-to-latest pill in rounded caps, keeping TuiAltScreen's own measuring, clipping
 * and click target. Returns the restore function, which is a no-op when TuiAltScreen is unavailable.
 */
function patchScrollToEndIndicator({ capLeft, capRight }: PillCaps): () => void {
	const target = TuiAltScreen?.prototype as unknown as ScrollIndicatorPatchable | undefined;
	if (typeof target?.compositeScrollToEndIndicator !== "function") return () => {};
	const key = Symbol.for("vim-chrome.scroll-indicator.original");
	const original = target.compositeScrollToEndIndicator;
	target[key] = original;
	target.compositeScrollToEndIndicator = function (this: ScrollIndicatorView, screen, layout, width) {
		const indicator = this.scrollToEndIndicator;
		if (typeof indicator !== "function") return original.call(this, screen, layout, width);
		this.scrollToEndIndicator = () => wrapRoundedPill(indicator(), capLeft, capRight);
		try {
			return original.call(this, screen, layout, width);
		} finally {
			this.scrollToEndIndicator = indicator;
		}
	};
	return () => {
		target.compositeScrollToEndIndicator = original;
		delete target[key];
	};
}

/**
 * Indexes of the frame's top and bottom DynamicBorder children: the first and last children that are not
 * Spacers. Undefined unless the bottom index is after the top index and both are DynamicBorders.
 */
function findDynamicBorderBounds(children: readonly unknown[]): { topIdx: number; bottomIdx: number } | undefined {
	const topIdx = children.findIndex((child) => !(child instanceof Spacer));
	if (topIdx === -1) return undefined;
	let bottomIdx = children.length - 1;
	while (bottomIdx > topIdx && children[bottomIdx] instanceof Spacer) bottomIdx--;
	if (bottomIdx <= topIdx) return undefined;
	if (!(children[topIdx] instanceof DynamicBorder) || !(children[bottomIdx] instanceof DynamicBorder)) return undefined;
	return { topIdx, bottomIdx };
}

/**
 * Frame bounds for `container` rendered at `width`. Undefined for a plain Container (pi's chatContainer), for
 * widths under 5 + 2 * MARGIN_X, and for containers without a DynamicBorder frame.
 */
function frameBounds(container: ContainerView, width: number): { topIdx: number; bottomIdx: number } | undefined {
	if (container.constructor === Container || width < 5 + 2 * MARGIN_X) return undefined;
	return findDynamicBorderBounds(container.children);
}

/**
 * Patches Container.prototype.render and handleMouse so every Container subclass with a DynamicBorder frame is drawn
 * in a rounded border. A plain Container whose sole child is an allowlisted inline dialog (see frameInlineDialog) is
 * framed the same way. Returns the restore function.
 */
function patchContainer(getTheme: () => Theme): () => void {
	return patchPrototype(Container.prototype, (original) => ({
		render(this: ContainerView, width: number): string[] {
			if (this.constructor === Container) {
				const framedDialog = frameInlineDialog(
					this.children,
					width,
					() => fgAnsi(getTheme(), "borderAccent"),
					visibleWidth,
					(text, w) => truncateToWidth(text, w, ""),
					MARGIN_X,
				);
				if (framedDialog) {
					this.mouseLayout = {
						width,
						children: [{ component: framedDialog.child, height: framedDialog.lines.length }],
					};
					return framedDialog.lines;
				}
			}
			const bounds = frameBounds(this, width);
			if (!bounds) return original.render.call(this, width);
			const { topIdx, bottomIdx } = bounds;
			const innerWidth = width - 2 * INSET_X;
			const lines: string[] = [];
			const mouseChildren: { component: Component; height: number }[] = [];
			const renderUnframed = (child: Component) => {
				const childLines = child.render(width);
				lines.push(...childLines);
				mouseChildren.push({ component: child, height: childLines.length });
			};
			this.children.slice(0, topIdx).forEach(renderUnframed);
			const interior = this.children.slice(topIdx + 1, bottomIdx);
			const sections = interior.map((child): FrameSection =>
				child instanceof DynamicBorder ? { isDivider: true } : { isDivider: false, lines: child.render(innerWidth) },
			);
			const framed = frameContainerSections(
				sections,
				width,
				fgAnsi(getTheme(), "borderAccent"),
				visibleWidth,
				(text, w) => truncateToWidth(text, w, ""),
				MARGIN_X,
			);
			lines.push(...framed.lines);
			mouseChildren.push({ component: this.children[topIdx]!, height: 1 });
			interior.forEach((component, j) => mouseChildren.push({ component, height: framed.heights[j]! }));
			mouseChildren.push({ component: this.children[bottomIdx]!, height: 1 });
			this.children.slice(bottomIdx + 1).forEach(renderUnframed);
			this.mouseLayout = { width, children: mouseChildren };
			this[FRAME_LAYOUT] = { width, topIdx, bottomIdx, trimmedTops: framed.trimmedTops };
			return lines;
		},
		handleMouse(this: ContainerView, event: TuiMouseEvent): unknown {
			if (!frameBounds(this, event.width)) return original.handleMouse?.call(this, event);
			if (this.mouseLayout?.width !== event.width) this.render(event.width);
			const frame = this[FRAME_LAYOUT];
			const layout = this.mouseLayout;
			if (!frame || frame.width !== event.width || !layout) return original.handleMouse?.call(this, event);
			const borderInset = MARGIN_X + 1;
			if (event.type !== "wheel" && (event.x < borderInset || event.x >= event.width - borderInset)) return undefined;
			let childY = 0;
			for (const [index, { component, height }] of layout.children.entries()) {
				if (event.y < childY || event.y >= childY + height) {
					childY += height;
					continue;
				}
				if (index <= frame.topIdx || index >= frame.bottomIdx) return undefined;
				const innerWidth = event.width - 2 * INSET_X;
				const trimmedTop = frame.trimmedTops[index - frame.topIdx - 1] ?? 0;
				const previous = this.mouseLayout;
				this.mouseLayout = { width: innerWidth, children: [{ component, height: height + trimmedTop }] };
				try {
					return original.handleMouse?.call(this, {
						...event,
						x: Math.max(0, Math.min(innerWidth - 1, event.x - INSET_X)),
						y: event.y - childY + trimmedTop,
						width: innerWidth,
						height: height + trimmedTop,
					});
				} finally {
					this.mouseLayout = previous;
				}
			}
			return undefined;
		},
	}));
}

/** Patches BashExecutionComponent.prototype.render (`!` and `!!` blocks). Returns the restore function. */
function patchBashExecution(getTheme: () => Theme): () => void {
	const chromeWidth = 2 + 2 * MARGIN_X;
	return patchPrototype(BashExecutionComponent.prototype, (original) => ({
		render(this: BashView, width: number): string[] {
			const container = this.contentContainer;
			if (width < 3 + 2 * MARGIN_X || typeof container?.render !== "function") {
				return original.render.call(this, width);
			}
			const contentLines = container.render(width - chromeWidth);
			const theme = getTheme();
			const dim = fgAnsi(theme, "dim");
			const borderFg = this.colorKey === "dim" ? dim : liftedBorderFg(theme, theme.colors.bashMode, dim);
			return [
				"",
				...frameLines(contentLines, width, borderFg, visibleWidth, (text, w) => truncateToWidth(text, w, ""), {
					marginX: MARGIN_X,
				}),
			];
		},
	}));
}
