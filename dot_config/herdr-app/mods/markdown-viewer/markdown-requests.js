// Markdown viewer requests: the label protocol's pure logic. No herdr imports, so the smoke test can load it.
// A request is a terminal label `markdown.show.<id>=<absolute path>`, see main.js.

const PREFIX = "markdown.show.";

/**
 * The pending markdown requests: one per label whose key starts with "markdown.show.".
 * `machine` is the terminal's machine, else the address prefix before "/", else null.
 * `address` is the machine-qualified address ("machine/tN" when remote), as `hc label` takes it.
 * `space` is the client-side space id (the terminal's herdr.space label, or the space holding its
 * herdr.tab label), prefixed with "machine/" when remote. Requests whose space is unknown are skipped.
 * @param {any[]} terminals terminals() entries
 * @param {any[]} spaces spaces() entries
 * @returns {{ address: string, key: string, path: string, machine: string | null, space: string }[]}
 */
export function pendingRequests(terminals, spaces) {
  const requests = [];
  for (const terminal of terminals) {
    const machine = machineOf(terminal);
    const address = machine && !terminal.address.includes("/") ? `${machine}/${terminal.address}` : terminal.address;
    for (const [key, path] of Object.entries(terminal.labels ?? {})) {
      if (!key.startsWith(PREFIX)) continue;
      const space = spaceOf(terminal, machine, spaces);
      if (space === null) continue;
      requests.push({ address, key, path, machine, space });
    }
  }
  return requests;
}

/**
 * The state with a doc added to a space's list. A doc whose path is already listed only becomes active
 * again. A new doc is appended and made active. Returns a new object; state is not changed.
 * State shape: { [spaceId]: { docs: [{ path, machine }], active: path } }.
 * @param {Record<string, { docs: { path: string, machine: string | null }[], active: string }>} state
 * @param {string} spaceId
 * @param {{ path: string, machine: string | null }} doc
 * @returns {Record<string, { docs: { path: string, machine: string | null }[], active: string }>}
 */
export function addDoc(state, spaceId, doc) {
  const entry = state[spaceId] ?? { docs: [] };
  const listed = entry.docs.some((d) => d.path === doc.path);
  const docs = listed ? entry.docs : [...entry.docs, { path: doc.path, machine: doc.machine }];
  return { ...state, [spaceId]: { docs, active: doc.path } };
}

/**
 * Drops entries for spaces that no longer exist. It only prunes when every machine is "ready"
 * (an unavailable machine's docs are kept). Returns the same object when nothing changed.
 * @param {Record<string, { docs: { path: string, machine: string | null }[], active: string }>} state
 * @param {{ id: string }[]} spaces spaces() entries
 * @param {{ name: string | null, layout: "loading" | "ready" | "unavailable" }[]} machines machines() entries
 * @returns {Record<string, { docs: { path: string, machine: string | null }[], active: string }>}
 */
export function pruneDocs(state, spaces, machines) {
  if (machines.some((m) => m.layout !== "ready")) return state;
  const live = new Set(spaces.map((s) => s.id));
  const keys = Object.keys(state);
  if (keys.every((k) => live.has(k))) return state;
  return Object.fromEntries(keys.filter((k) => live.has(k)).map((k) => [k, state[k]]));
}

// Private: the machine of a terminal: its machine field, else the address prefix before "/", else null.
function machineOf(terminal) {
  if (terminal.machine) return terminal.machine;
  return terminal.address.includes("/") ? terminal.address.split("/")[0] : null;
}

// Private: the client-side space id of a request terminal, or null. Uses herdr.space, else the space with a tab
// equal to herdr.tab. Remote terminals get the "machine/" prefix.
function spaceOf(terminal, machine, spaces) {
  const labels = terminal.labels ?? {};
  const prefix = machine ? `${machine}/` : "";
  if (labels["herdr.space"] !== undefined) {
    const id = prefix + labels["herdr.space"];
    return spaces.some((s) => s.id === id) ? id : null;
  }
  if (labels["herdr.tab"] !== undefined) {
    const tab = prefix + labels["herdr.tab"];
    return spaces.find((s) => (s.tabs ?? []).some((t) => t.id === tab))?.id ?? null;
  }
  return null;
}
