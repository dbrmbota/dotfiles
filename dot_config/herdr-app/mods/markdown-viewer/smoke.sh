#!/bin/bash
# smoke.sh: fixture checks for markdown.js and markdown-requests.js (dev aid, not deployed, see .chezmoiignore).
# Run: bash smoke.sh. Prints "ok <name>" or "FAIL <name>: <reason>", exits nonzero on any failure.

cd "$(dirname "$0")" || exit 1
MARKDOWN="$PWD/markdown.js" REQUESTS="$PWD/markdown-requests.js" exec node --input-type=module <<'JS'
import { pathToFileURL } from "node:url";

const { splitMarkdown, hashSource, parseSvgSize, docTitle } = await import(pathToFileURL(process.env.MARKDOWN).href);
const { pendingRequests, addDoc, pruneDocs } = await import(pathToFileURL(process.env.REQUESTS).href);

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

// Order-insensitive deep equality, so object key order never matters.
function same(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same(a[k], b[k]));
}
const eq = (got, want) => (same(got, want) ? null : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// The chunk structure without md whitespace: "md" or "mermaid:<source>".
const shape = (chunks) => chunks.map((c) => (c.kind === "mermaid" ? `mermaid:${c.source}` : "md"));

// Markdown fence rules (splitMarkdown).
check("backtick mermaid fence is split out", () => eq(shape(splitMarkdown("before\n```mermaid\nA-->B\n```\nafter\n")), ["md", "mermaid:A-->B", "md"]));
check("tilde mermaid fence is split out", () => eq(shape(splitMarkdown("before\n~~~mermaid\nA-->B\n~~~\nafter\n")), ["md", "mermaid:A-->B", "md"]));
check("shorter fence does not close a longer one", () => eq(shape(splitMarkdown("````mermaid\nA-->B\n```\nstill\n````\n")), ["mermaid:A-->B\n```\nstill"]));
check("longer fence closes a shorter opening", () => eq(shape(splitMarkdown("````mermaid\nA-->B\n`````\nafter")), ["mermaid:A-->B", "md"]));
check("fence indented 3 spaces is a fence", () => eq(shape(splitMarkdown("   ```mermaid\nA-->B\n   ```\n")), ["mermaid:A-->B"]));
check("fence indented 4 spaces is not a fence", () => eq(shape(splitMarkdown("    ```mermaid\nA-->B\n    ```\n")), ["md"]));
check("mermaid fence inside another fence is not split", () => eq(shape(splitMarkdown("````md\n```mermaid\nA-->B\n```\n````\n")), ["md"]));
check("unclosed fence runs to end of file", () => eq(shape(splitMarkdown("```mermaid\nA-->B\nC")), ["mermaid:A-->B\nC"]));
check("info string is case-insensitive", () => eq(shape(splitMarkdown("```Mermaid\nA-->B\n```\n")), ["mermaid:A-->B"]));
check("CRLF input is normalized", () => eq(shape(splitMarkdown("```mermaid\r\nA-->B\r\n```\r\n")), ["mermaid:A-->B"]));

// hashSource: FNV-1a 32 of "abc" is 1a47e90b, then the length 3 in hex.
check("hashSource is fnv1a32 hex plus length hex", () => eq(hashSource("abc"), "1a47e90b3"));

// parseSvgSize: width/height first, viewBox when those are missing.
check("parseSvgSize reads width and height", () => eq(parseSvgSize('<svg xmlns="http://www.w3.org/2000/svg" width="398.5px" height="164" viewBox="0 0 10 10">'), { width: 398.5, height: 164 }));
check("parseSvgSize falls back to viewBox", () => eq(parseSvgSize('<svg viewBox="0 0 886.31 157.48">'), { width: 886.31, height: 157.48 }));

// docTitle: first "# " heading, else the file name.
check("docTitle uses the first # heading", () => eq(docTitle("intro\n# Real Title\n## sub", "/x/notes.md"), "Real Title"));
check("docTitle falls back to the file name", () => eq(docTitle("no heading here", "/x/notes.md"), "notes.md"));

// pendingRequests: label protocol mapping.
check("pendingRequests: local terminal", () => eq(
  pendingRequests([{ address: "t8", labels: { "markdown.show.k1": "/a.md", "herdr.space": "sp1", where: "x / 1" } }], [{ id: "sp1", tabs: [] }]),
  [{ address: "t8", key: "markdown.show.k1", path: "/a.md", machine: null, space: "sp1" }],
));
check("pendingRequests: remote terminals, machine field and address prefix", () => eq(
  pendingRequests(
    [
      { address: "vps/t7", machine: "vps", labels: { "markdown.show.k2": "/srv/b.md", "herdr.space": "sp2" } },
      { address: "vps/t9", labels: { "markdown.show.k3": "/srv/c.md", "herdr.space": "sp2" } },
    ],
    [{ id: "vps/sp2", tabs: [] }],
  ),
  [
    { address: "vps/t7", key: "markdown.show.k2", path: "/srv/b.md", machine: "vps", space: "vps/sp2" },
    { address: "vps/t9", key: "markdown.show.k3", path: "/srv/c.md", machine: "vps", space: "vps/sp2" },
  ],
));
check("pendingRequests: missing herdr.space falls back to herdr.tab", () => eq(
  pendingRequests(
    [{ address: "t8", labels: { "herdr.tab": "tb1", "markdown.show.k4": "/c.md" } }],
    [{ id: "sp1", tabs: [{ id: "tb1" }] }, { id: "sp2", tabs: [{ id: "tb2" }] }],
  ),
  [{ address: "t8", key: "markdown.show.k4", path: "/c.md", machine: null, space: "sp1" }],
));
check("pendingRequests: unknown space is skipped", () => eq(
  pendingRequests([{ address: "t8", labels: { "herdr.space": "gone", "markdown.show.k5": "/d.md" } }], [{ id: "sp1", tabs: [] }]),
  [],
));

// addDoc: append and activate, then dedupe by path.
check("addDoc appends a new doc and makes it active", () => eq(
  addDoc({}, "sp1", { path: "/a.md", machine: null }),
  { sp1: { docs: [{ path: "/a.md", machine: null }], active: "/a.md" } },
));
check("addDoc with a listed path only activates it", () => eq(
  addDoc(
    { sp1: { docs: [{ path: "/a.md", machine: null }, { path: "/b.md", machine: null }], active: "/b.md" } },
    "sp1",
    { path: "/a.md", machine: null },
  ),
  { sp1: { docs: [{ path: "/a.md", machine: null }, { path: "/b.md", machine: null }], active: "/a.md" } },
));

// pruneDocs: drops missing spaces only when every machine is ready.
const entry = (path) => ({ docs: [{ path, machine: null }], active: path });
check("pruneDocs drops missing spaces when all machines are ready", () => eq(
  pruneDocs({ sp1: entry("/a.md"), gone: entry("/g.md") }, [{ id: "sp1" }], [{ name: null, layout: "ready" }]),
  { sp1: entry("/a.md") },
));
check("pruneDocs keeps everything when a machine is unavailable", () => eq(
  pruneDocs({ sp1: entry("/a.md"), "vps/sp2": entry("/r.md") }, [{ id: "sp1" }], [{ name: null, layout: "ready" }, { name: "vps", layout: "unavailable" }]),
  { sp1: entry("/a.md"), "vps/sp2": entry("/r.md") },
));

console.log(failed ? `${failed} failed` : "all ok");
process.exit(failed ? 1 : 0);
JS
