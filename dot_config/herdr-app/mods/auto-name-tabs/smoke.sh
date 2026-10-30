#!/bin/bash
# smoke.sh: fixture checks for naming.js (dev aid, not deployed, see .chezmoiignore).
# Run: bash smoke.sh. Prints "ok <name>" or "FAIL <name>: <reason>", exits nonzero on any failure.

cd "$(dirname "$0")" || exit 1
NAMING="$PWD/naming.js" exec node --input-type=module <<'JS'
import { pathToFileURL } from "node:url";

const { leadPane, wantName, tabLabel, nextLeads } = await import(pathToFileURL(process.env.NAMING).href);

const HOME = "/Users/test";
const CHEZMOI = "/Users/test/.local/share/chezmoi";
const program = (name, extra = {}) => ({ key: name.toLowerCase(), name, icon: null, tint: false, tile: null, color: null, shell: false, agent: false, ...extra });
const SHELL = program("zsh", { shell: true });
const NVIM = program("Neovim");
const YAZI = program("yazi");
const CLAUDE = program("Claude Code", { key: "claude", agent: true });
const terminal = (pane, tab, fields = {}) => ({ pane, terminal: pane, tab, title: "", cwd: null, branch: null, status: null, app: null, program: SHELL, focused: false, zoomed: false, movable: true, ...fields });

let failed = 0;
function check(name, fn) {
  try {
    const reason = fn();
    if (reason) { failed++; console.log(`FAIL ${name}: ${reason}`); }
    else console.log(`ok ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
const eq = (got, want) => (JSON.stringify(got) === JSON.stringify(want) ? null : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

check("zsh at home is zsh: ~", () => eq(wantName(terminal("p1", "t1", { program: SHELL, cwd: HOME }), HOME), "zsh: ~"));
check("zsh in chezmoi is zsh: chezmoi", () => eq(wantName(terminal("p1", "t1", { program: SHELL, cwd: CHEZMOI }), HOME), "zsh: chezmoi"));
check("nvim in chezmoi is Neovim: chezmoi", () => eq(wantName(terminal("p1", "t1", { program: NVIM, cwd: CHEZMOI }), HOME), "Neovim: chezmoi"));
check("yazi in chezmoi is yazi: chezmoi", () => eq(wantName(terminal("p1", "t1", { program: YAZI, cwd: CHEZMOI }), HOME), "yazi: chezmoi"));
check("agent with telling title shows the title", () => eq(wantName(terminal("p1", "t1", { program: CLAUDE, title: "✳ Fix login bug", cwd: CHEZMOI }), HOME), "Fix login bug"));
check("agent without telling title shows Claude Code", () => eq(wantName(terminal("p1", "t1", { program: CLAUDE, title: "Claude Code", cwd: CHEZMOI }), HOME), "Claude Code"));
check("40-char name is cut to 32 characters", () => eq(wantName(terminal("p1", "t1", { program: program("A".repeat(40)), cwd: null }), HOME), "A".repeat(32)));

check("named tab shows its own name", () => eq(tabLabel({ id: "t1", index: 1, name: "deploy", named: true, active: true }, [terminal("p1", "t1", { cwd: CHEZMOI })], {}, HOME), "deploy"));
check("tab with only a mod shows the mod pane's title", () => {
  const mod = { pane: "m1", terminal: null, mod: "files", tab: "t1", title: "Files", focused: true, zoomed: false };
  return eq(tabLabel({ id: "t1", index: 1, name: "1", named: false, active: true }, [mod], {}, HOME), "Files");
});

check("focus moved to another tab: leadPane returns the remembered pane", () => {
  const panes = [
    terminal("pA", "t1", { focused: false }),
    terminal("pB", "t1", { focused: false }),
    terminal("pC", "t2", { focused: true }),
  ];
  return eq(leadPane("t1", panes, { t1: "pA" })?.pane ?? null, "pA");
});
check("unchanged input: nextLeads returns the same object", () => {
  const leads = { t1: "pA" };
  const panes = [terminal("pA", "t1", { focused: true })];
  const spaces = [{ id: "s1", tabs: [{ id: "t1" }] }];
  return nextLeads(spaces, panes, leads) === leads ? null : "returned a new object";
});
check("closed tab is pruned by nextLeads", () => {
  const panes = [terminal("pA", "t1", { focused: true })];
  const spaces = [{ id: "s1", tabs: [{ id: "t1" }] }];
  return eq(nextLeads(spaces, panes, { t1: "pA", t9: "pZ" }), { t1: "pA" });
});

console.log(failed ? `${failed} failed` : "all ok");
process.exit(failed ? 1 : 0);
JS
