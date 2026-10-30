// Tab naming shared by the auto-name-tabs tab bar and the tab-picker popup.
// Pure: no herdr imports. Callers pass panes, spaces and home in.

const MAX_NAME = 32;

/** The pane that names a tab: the tab's focused terminal pane, else the terminal pane `leads[tabId]`
 *  names when it still exists, else the tab's first terminal pane. Null when the tab has none. */
export function leadPane(tabId, panes, leads) {
  const mine = panes.filter((p) => p.tab === tabId && p.terminal);
  return mine.find((p) => p.focused) ?? mine.find((p) => p.pane === leads[tabId]) ?? mine[0] ?? null;
}

/** The auto name for one pane: an agent's telling title, else its program name plus ": <folder>".
 *  Null when there is no pane or program. At most 32 characters. */
export function wantName(p, home) {
  const program = p?.program;
  if (!program) return null;
  if (program.agent) return (tellingTitle(p) ?? program.name).trim().slice(0, MAX_NAME);
  const folder = folderOf(p.cwd, home);
  const text = folder === null ? program.name : `${program.name}: ${folder}`;
  return text.trim().slice(0, MAX_NAME);
}

/** The label drawn for a tab: its own name when someone named it, else wantName of its lead pane,
 *  else the title of its first pane (a tab holding only a mod), else its number. */
export function tabLabel(tab, panes, leads, home) {
  if (tab.named) return tab.name;
  const auto = wantName(leadPane(tab.id, panes, leads), home);
  if (auto !== null) return auto;
  const first = panes.find((p) => p.tab === tab.id);
  return first ? first.title : tab.name;
}

/** The lead memory for the next render: for each tab in spaces, the focused terminal pane's id when
 *  there is one, else the id already in leads. Tabs that no longer exist are dropped. Returns the
 *  same object as leads when nothing changed, so callers can compare by identity. */
export function nextLeads(spaces, panes, leads) {
  const next = {};
  for (const space of spaces) {
    for (const tab of space.tabs) {
      const focused = panes.find((p) => p.tab === tab.id && p.terminal && p.focused);
      if (focused) next[tab.id] = focused.pane;
      else if (panes.some((p) => p.pane === leads[tab.id])) next[tab.id] = leads[tab.id];
    }
  }
  const ids = Object.keys(next);
  const same = ids.length === Object.keys(leads).length && ids.every((id) => leads[id] === next[id]);
  return same ? leads : next;
}

// The cleaned agent title when it says something about the task, else null. The same test as
// mods/agents/main.js title(), copied verbatim.
function tellingTitle(p) {
  const prog = p.program.name;
  const live = clean(p.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== p.program.key;
  return telling ? live : null;
}

// Strips leading symbols and surrounding space, as mods/agents/main.js clean().
function clean(text) {
  return (text ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

// "~" for the home folder, else the folder's basename. Null when cwd is null.
function folderOf(cwd, home) {
  if (cwd == null) return null;
  if (cwd === home) return "~";
  return cwd.split("/").filter(Boolean).pop() ?? "/";
}
