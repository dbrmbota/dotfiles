/**
 * The agent picker TUI component. It only renders and reads keys; the caller
 * decides what to do with the chosen name.
 */

import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentDefinition } from "./catalog.ts";

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
	return ctx.ui.custom<string | null>((tui, theme, kb, done) => {
		const search = new Input();
		if (initialQuery) search.setValue(initialQuery);
		let matches: AgentDefinition[] = [];
		let selected = 0;
		const activeIndex = (list: AgentDefinition[]): number =>
			Math.max(0, list.findIndex((d) => d.name === activeName));
		const filter = (): void => {
			const q = search.getValue().trim();
			matches = q ? fuzzyFilter([...catalog], q, (d) => d.name) : [...catalog];
			selected = q ? 0 : activeIndex(matches);
		};
		filter();
		const header = new Container();
		const topBorder = new DynamicBorder((s) => theme.fg("accent", s));
		const title = new Text(theme.fg("accent", theme.bold("Select Agent")));
		header.addChild(topBorder);
		header.addChild(title);
		const footer = new Container();
		const hint = new Text(theme.fg("dim", "type to search • ↑↓ navigate • enter select • esc cancel"));
		const bottomBorder = new DynamicBorder((s) => theme.fg("accent", s));
		footer.addChild(hint);
		footer.addChild(bottomBorder);
		return {
			get focused(): boolean {
				return search.focused;
			},
			set focused(value: boolean) {
				search.focused = value;
			},
			render(width: number) {
				const lines: string[] = [];
				lines.push(...header.render(width));
				lines.push(...search.render(width));
				if (matches.length === 0) {
					lines.push(theme.fg("warning", "  No matching agents"));
				} else {
					const start = Math.max(0, Math.min(selected - 5, matches.length - 10));
					const end = Math.min(start + 10, matches.length);
					for (let i = start; i < end; i++) {
						const d = matches[i]!;
						const isSelected = i === selected;
						const cursor = isSelected ? theme.fg("accent", "→ ") : "  ";
						const name = isSelected ? theme.fg("accent", d.name) : d.name;
						const activeBadge = d.name === activeName ? theme.fg("muted", " (active)") : "";
						lines.push(truncateToWidth(`${cursor}${name}${activeBadge}  ${theme.fg("muted", describe(d))}`, width));
					}
					if (start > 0 || end < matches.length) {
						lines.push(theme.fg("dim", `  (${selected + 1}/${matches.length})`));
					}
				}
				lines.push(...footer.render(width));
				return lines;
			},
			invalidate() {
				header.invalidate();
				search.invalidate();
				footer.invalidate();
			},
			handleInput(data: string) {
				if (kb.matches(data, "tui.select.up")) {
					if (matches.length > 0) selected = selected === 0 ? matches.length - 1 : selected - 1;
				} else if (kb.matches(data, "tui.select.down")) {
					if (matches.length > 0) selected = selected === matches.length - 1 ? 0 : selected + 1;
				} else if (kb.matches(data, "tui.select.confirm")) {
					const match = matches[selected];
					if (match) done(match.name);
				} else if (kb.matches(data, "tui.select.cancel")) {
					done(null);
				} else {
					const before = search.getValue();
					search.handleInput(data);
					if (search.getValue() !== before) filter();
				}
				tui.requestRender();
			},
		};
	});
}
