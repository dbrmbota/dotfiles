/**
 * The agent picker TUI component. It only renders and reads keys; the caller
 * decides what to do with the chosen name.
 */

import { DynamicBorder, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	type KeybindingsManager,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { AgentDefinition } from "./catalog.ts";

/** What AgentPicker needs from showPicker's caller and from pi's custom-UI factory. */
type PickerOptions = {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	done: (name: string | null) => void;
	catalog: readonly AgentDefinition[];
	activeName: string;
	describe: (def: AgentDefinition) => string;
	initialQuery: string;
};

/**
 * The searchable agent list. It is a Container bounded by DynamicBorder children, so vim-chrome frames it with
 * the other pickers and it still renders unframed without vim-chrome. Keys and filtering match the earlier
 * object-literal picker.
 */
class AgentPicker extends Container {
	private readonly options: PickerOptions;
	private readonly search = new Input();
	private matches: AgentDefinition[] = [];
	private selected = 0;

	constructor(options: PickerOptions) {
		super();
		this.options = options;
		if (options.initialQuery) this.search.setValue(options.initialQuery);
		this.filter();
		const { theme } = options;
		const accent = (s: string) => theme.fg("accent", s);
		this.addChild(new DynamicBorder(accent));
		this.addChild(new Text(theme.fg("accent", theme.bold("Select Agent")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.search);
		this.addChild(new Spacer(1));
		this.addChild({ render: (width: number) => this.renderRows(width) });
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "type to search • ↑↓ navigate • enter select • esc cancel"), 0, 0));
		this.addChild(new DynamicBorder(accent));
	}

	/** Keyboard focus follows the search input, which owns the cursor. */
	get focused(): boolean {
		return this.search.focused;
	}

	set focused(value: boolean) {
		this.search.focused = value;
	}

	/** Recomputes matches and selection from the search text: fuzzy match or all agents, active agent selected when empty. */
	private filter(): void {
		const { catalog, activeName } = this.options;
		const q = this.search.getValue().trim();
		this.matches = q ? fuzzyFilter([...catalog], q, (d) => d.name) : [...catalog];
		this.selected = q ? 0 : Math.max(0, this.matches.findIndex((d) => d.name === activeName));
	}

	/** The rows of the visible window (10 max) with cursor, active badge, and description, or the empty-state line, plus an (n/m) counter when scrolled. Each row is truncated to width. */
	private renderRows(width: number): string[] {
		const { theme, activeName, describe } = this.options;
		if (this.matches.length === 0) return [theme.fg("warning", "  No matching agents")];
		const lines: string[] = [];
		const start = Math.max(0, Math.min(this.selected - 5, this.matches.length - 10));
		const end = Math.min(start + 10, this.matches.length);
		for (let i = start; i < end; i++) {
			const d = this.matches[i]!;
			const isSelected = i === this.selected;
			const cursor = isSelected ? theme.fg("accent", "→ ") : "  ";
			const name = isSelected ? theme.fg("accent", d.name) : d.name;
			const activeBadge = d.name === activeName ? theme.fg("muted", " (active)") : "";
			lines.push(truncateToWidth(`${cursor}${name}${activeBadge}  ${theme.fg("muted", describe(d))}`, width));
		}
		if (start > 0 || end < this.matches.length) {
			lines.push(theme.fg("dim", `  (${this.selected + 1}/${this.matches.length})`));
		}
		return lines;
	}

	/** Handles up/down, confirm, cancel, and otherwise forwards keys to the search input, refiltering on change. */
	handleInput(data: string): void {
		const { tui, keybindings: kb, done } = this.options;
		if (kb.matches(data, "tui.select.up")) {
			if (this.matches.length > 0) this.selected = this.selected === 0 ? this.matches.length - 1 : this.selected - 1;
		} else if (kb.matches(data, "tui.select.down")) {
			if (this.matches.length > 0) this.selected = this.selected === this.matches.length - 1 ? 0 : this.selected + 1;
		} else if (kb.matches(data, "tui.select.confirm")) {
			const match = this.matches[this.selected];
			if (match) done(match.name);
		} else if (kb.matches(data, "tui.select.cancel")) {
			done(null);
		} else {
			const before = this.search.getValue();
			this.search.handleInput(data);
			if (this.search.getValue() !== before) this.filter();
		}
		tui.requestRender();
	}

	invalidate(): void {
		super.invalidate();
	}
}

/**
 * Open the searchable agent list. `initialQuery` prefills the search, `activeName`
 * gets the "(active)" badge, and `describe` gives each row's detail text. Resolves
 * to the chosen agent name, or null when the picker is cancelled.
 */
export function showPicker(
	ctx: ExtensionContext,
	catalog: readonly AgentDefinition[],
	activeName: string,
	describe: (def: AgentDefinition) => string,
	initialQuery: string,
): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, kb, done) =>
		new AgentPicker({ tui, theme, keybindings: kb, done, catalog, activeName, describe, initialQuery }),
	);
}
