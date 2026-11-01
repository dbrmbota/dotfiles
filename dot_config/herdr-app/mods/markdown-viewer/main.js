// Markdown viewer: the Docs panel. Shows the markdown files that programs in Herdr terminals ask for.
//
// Label protocol (the public interface). From any Herdr terminal, on any machine:
//   hc label "$HC_TERMINAL_ID" markdown.show.<id>=<absolute path of a UTF-8 .md file on that machine>
// - <id> is [a-z0-9]+ and unique per request, e.g. base36 Date.now() plus 4 random base36 characters.
// - Two copies of this mod run, both from theorian.json:
//   - The button copy (props { button: true, panel, stack, child }) sits in the tab row, always shown.
//     It draws the Docs show/hide button, takes the label, adds the doc to that space's list, clears
//     the label (markdown.show.<id>=), and opens the panel on the "markdown" child.
//   - The panel copy (props { panel, stack, child }) draws the docs in the panel, when open.
// - A request made while the app is closed is handled at the next start.
//
// Shared state "markdown-viewer.docs": { [spaceId]: { docs: [{ path, machine }], active: path } }.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { spaces, terminals, machines, shared, setShared, readTextFile, exec, hc, appHome, props, layout, run, theme } from "herdr";
import * as fs from "fs/promises";
import { splitMarkdown, hashSource, parseSvgSize, docTitle } from "./markdown.js";
import { pendingRequests, addDoc, pruneDocs } from "./markdown-requests.js";

const POLL_MS = 2000;

// This copy's props. Null when herdr-app check loads the mod without a layout, so it falls back to {}.
function config() {
  return props() ?? {};
}

// The node with this id in a layout tree, or null.
function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

export default class Docs extends View {
  init(_props, cx) {
    this.cache = new Map();
    this.diagrams = new Map();
    this.handled = new Set();
    this.width = 0;
    cx.timer.every(POLL_MS, (cx) => this.poll(cx));
  }

  render(cx) {
    const t = theme();
    if (config().button) {
      this.watchRequests(cx);
      return this.renderButton(t);
    }
    const entry = shared("markdown-viewer.docs")?.[this.activeSpaceId()] ?? null;
    const doc = entry?.docs.find((d) => d.path === entry.active) ?? null;
    if (doc) this.ensureLoaded(doc, cx);
    const stop = (_e, cx) => cx.stop_propagation();
    const root = v_flex().id("root").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); });
    if (!entry || !doc) return root.child(this.emptyState(t));
    const tabs = entry.docs.map((d) => {
      const on = d.path === entry.active, key = hashSource(d.path);
      const title = docTitle(this.cache.get(d.path)?.text ?? "", d.path);
      return h_flex().id(`doc-${key}`).h(29).px(10).gap(7).items_center().flex_none().rounded(7).text_size(12.8)
        .border(1).border_color(on ? t.border : t.chrome).bg(on ? t.raised : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.activate(d.path, cx))
        .child(div().max_w(200).truncate().child(title))
        .child(div().id(`close-${key}`).size(20).flex().items_center().justify_center().rounded(5).text_size(16).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
          .on_click((_e, cx) => { cx.stop_propagation(); this.closeDoc(d.path); }).child("×"));
    });
    return root
      .child(h_flex().id("docs-tabs").h(42).flex_none().px(8).gap(3).items_center().border_b(1).border_color(t.border).overflow_x_scrollbar().children(tabs))
      .child(this.renderDoc(doc, t, cx));
  }

  // Private (button copy): the Docs button, centered in the tab row, drawn like the Files button. Dimmed when the
  // panel is closed, selected background when visible(). Click runs togglePanel().
  renderButton(t) {
    const on = this.visible();
    const stop = (_e, cx) => cx.stop_propagation();
    return h_flex().size_full().items_center().justify_center().bg(t.chrome).border_b(1).border_color(t.border).child(
      h_flex().id("docs-toggle").h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12)
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .on_mouse_down("left", stop).on_click(() => this.togglePanel())
        .child(svg("mods/markdown-viewer/doc.svg").size(14)).child("Docs"));
  }

  // Private (button copy): takes the pending markdown requests from terminals(). For each not in this.handled:
  // adds it to this.handled, adds the doc to shared state, clears its label, and when its space is the active one,
  // opens the panel on config().child. Drops handled entries that are no longer pending. Writes the state only when it
  // changed (pruneDocs drops spaces that no longer exist).
  watchRequests(cx) {
    const pending = pendingRequests(terminals(), spaces());
    const live = new Set(pending.map((r) => `${r.address}:${r.key}`));
    for (const id of this.handled) if (!live.has(id)) this.handled.delete(id);
    const before = shared("markdown-viewer.docs") ?? {};
    const active = this.activeSpaceId();
    let state = before;
    for (const r of pending) {
      const id = `${r.address}:${r.key}`;
      if (this.handled.has(id)) continue;
      this.handled.add(id);
      state = addDoc(state, r.space, { path: r.path, machine: r.machine });
      hc(["label", r.address, `${r.key}=`]).catch(() => {});
      if (r.space === active) {
        run("layout.select", { stack: config().stack, child: config().child });
        run("layout.show", { id: config().panel });
      }
    }
    state = pruneDocs(state, spaces(), machines());
    if (state !== before) {
      setShared("markdown-viewer.docs", state);
      cx.notify();
    }
  }

  // Private (button copy): the button's click. Hides the panel when visible(); otherwise opens it on config().child
  // (the empty state shows when the active space has no docs).
  togglePanel() {
    if (this.visible()) {
      run("layout.hide", { id: config().panel });
      return;
    }
    run("layout.select", { stack: config().stack, child: config().child });
    run("layout.show", { id: config().panel });
  }

  // Private: the client-side id of the active space, or null.
  activeSpaceId() {
    return spaces().find((s) => s.active)?.id ?? null;
  }

  // Private: true when the panel is open on this copy's child: config().panel is not hidden and
  // layout()'s stack named config().stack has active === config().child.
  visible() {
    const panel = findNode(layout(), config().panel), stack = findNode(layout(), config().stack);
    return Boolean(panel && !panel.hidden && stack?.active === config().child);
  }

  // Private: timer callback. Re-reads only the active doc, and only while visible().
  poll(cx) {
    if (config().button || !this.visible()) return;
    const entry = shared("markdown-viewer.docs")?.[this.activeSpaceId()];
    const doc = entry?.docs.find((d) => d.path === entry.active);
    if (doc) this.loadDoc(doc, cx);
  }

  // Private: reads the doc once when it has no cache entry yet (the first read on activation).
  ensureLoaded(doc, cx) {
    if (!this.cache.has(doc.path)) this.loadDoc(doc, cx);
  }

  // Private: reads one doc with readTextFile(path, { on: machine }) (1 MiB cap). Stores { text, chunks, error }
  // in this.cache. null means "File not found: <path>"; a rejection shows its message. Calls cx.notify()
  // only when the text (or error) changed.
  loadDoc(doc, cx) {
    cx.spawn(async (cx) => {
      let next;
      try {
        const text = await readTextFile(doc.path, { on: doc.machine });
        next = text === null
          ? { text: null, chunks: [], error: `File not found: ${doc.path}` }
          : { text, chunks: splitMarkdown(text), error: null };
      } catch (e) {
        next = { text: null, chunks: [], error: String(e?.message ?? e).split("\n")[0] };
      }
      const prev = this.cache.get(doc.path);
      if (prev && prev.text === next.text && prev.error === next.error) return;
      this.cache.set(doc.path, next);
      cx.notify();
    });
  }

  // Private: makes a doc the active one of the active space and reads it now.
  activate(path, cx) {
    const id = this.activeSpaceId();
    const state = shared("markdown-viewer.docs") ?? {};
    const entry = state[id];
    if (!entry) return;
    setShared("markdown-viewer.docs", { ...state, [id]: { ...entry, active: path } });
    const doc = entry.docs.find((d) => d.path === path);
    if (doc) this.loadDoc(doc, cx);
    cx.notify();
  }

  // Private: removes a doc from the active space. When the closed doc was active, the doc before it becomes
  // active (or the first one). Closing the last doc deletes the space's entry and hides the panel.
  closeDoc(path) {
    const id = this.activeSpaceId();
    const state = shared("markdown-viewer.docs") ?? {};
    const entry = state[id];
    if (!entry) return;
    const docs = entry.docs.filter((d) => d.path !== path);
    if (docs.length === 0) {
      const { [id]: _closed, ...rest } = state;
      setShared("markdown-viewer.docs", rest);
      run("layout.hide", { id: config().panel });
      return;
    }
    let active = entry.active;
    if (entry.active === path) {
      const index = entry.docs.findIndex((d) => d.path === path);
      active = index > 0 ? entry.docs[index - 1].path : docs[0].path;
    }
    setShared("markdown-viewer.docs", { ...state, [id]: { docs, active } });
  }

  // Private: the scroll container for one doc, with its chunks. Scroll id: "scroll-" + hashSource(path).
  renderDoc(doc, t, cx) {
    const key = hashSource(doc.path);
    const body = v_flex().id("scroll-" + key).flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(10).text_color(t.foreground);
    const entry = this.cache.get(doc.path);
    if (!entry) return body.child(div().text_color(t.dim).child("Loading…"));
    if (entry.error) return body.child(div().text_color(t.dim).child(entry.error));
    return body.children(entry.chunks.map((chunk, i) => (chunk.kind === "md"
      ? TextView.markdown(`md-${key}-${i}`, chunk.text).selectable(true).text_color(t.foreground)
      : this.renderMermaid(chunk.source, t, cx))));
  }

  // Private: one mermaid chunk: a white rounded card with the drawn SVG (or the fallback, or a spinner).
  renderMermaid(source, t, cx) {
    const hash = hashSource(source);
    const state = this.diagrams.get(hash);
    if (!state) this.ensureDiagram(hash, source, cx);
    if (!state || state.status === "pending") return div().text_color(t.dim).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90);
    if (state.status === "failed") return this.fallback(source, state.error, t);
    const room = this.width ? this.width - 40 : state.width;
    const w = Math.min(state.width, room), h = (state.height * w) / state.width;
    return div().rounded(8).p(8).bg("#ffffff").child(image(`data/markdown-viewer/${hash}.svg`).w(w).h(h));
  }

  // Private: renders one diagram once per hash, in cx.spawn. Writes <appHome>/data/markdown-viewer/<hash>.mmd
  // (fs/promises writeFile after mkdir recursive), runs exec("mmdr", ["-i", mmd, "-e", "svg"]) and reads the
  // size with parseSvgSize, then writes <hash>.svg from its stdout. Sets this.diagrams status done or failed.
  // A missing program or a nonzero exit fails with the first line of stderr.
  ensureDiagram(hash, source, cx) {
    if (this.diagrams.has(hash)) return;
    this.diagrams.set(hash, { status: "pending", width: 0, height: 0, error: null });
    cx.spawn(async (cx) => {
      const dir = `${appHome()}/data/markdown-viewer`, mmd = `${dir}/${hash}.mmd`;
      const fail = (error) => this.diagrams.set(hash, { status: "failed", width: 0, height: 0, error });
      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(mmd, source);
      } catch (e) {
        fail(String(e?.message ?? e).split("\n")[0]);
        cx.notify();
        return;
      }
      let r = null;
      try {
        r = await exec("mmdr", ["-i", mmd, "-e", "svg"]);
      } catch {
        fail(null);
        cx.notify();
        return;
      }
      const size = r.code === 0 ? parseSvgSize(r.stdout) : null;
      if (!size) {
        fail(r.stderr.trim().split("\n")[0] ?? "");
        cx.notify();
        return;
      }
      try {
        await fs.writeFile(`${dir}/${hash}.svg`, r.stdout);
      } catch (e) {
        fail(String(e?.message ?? e).split("\n")[0]);
        cx.notify();
        return;
      }
      this.diagrams.set(hash, { status: "done", width: size.width, height: size.height, error: null });
      cx.notify();
    });
  }

  // Private: the fallback for a diagram: its source as a fenced code block (TextView.markdown). A missing program
  // (error null) shows the dim install line; a failed render shows the error's first line.
  fallback(source, error, t) {
    const longest = Math.max(2, ...(source.match(/`+/g) ?? []).map((ticks) => ticks.length));
    const fence = "`".repeat(longest + 1);
    return v_flex().gap(6)
      .child(TextView.markdown(`mermaid-src-${hashSource(source)}`, `${fence}\n${source}\n${fence}`).selectable(true).text_color(t.foreground))
      .when(error === null, (el) => el.child(div().text_size(11).text_color(t.dim).child("Install mmdr to draw diagrams")))
      .when(Boolean(error), (el) => el.child(div().text_size(11).text_color(t.ansi1).child(error)));
  }

  // Private: the empty state text: "No documents. From a Herdr terminal: hc label $HC_TERMINAL_ID markdown.show.<id>=<path>".
  emptyState(t) {
    return v_flex().size_full().items_center().justify_center().p(16).gap(6).text_size(12).text_color(t.dim)
      .child("No documents.")
      .child("From a Herdr terminal: hc label $HC_TERMINAL_ID markdown.show.<id>=<path>");
  }
}
