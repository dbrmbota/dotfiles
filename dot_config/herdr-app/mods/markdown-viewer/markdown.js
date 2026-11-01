// Markdown viewer helpers. Pure: no imports, so the smoke test can load it.

/**
 * Splits markdown into text chunks and Mermaid chunks, following GFM fence rules.
 * Returns [{ kind: "md", text } | { kind: "mermaid", source }]. CRLF becomes LF.
 * Only fences whose info string's first word is "mermaid" (any case) become mermaid chunks;
 * other fenced blocks stay inside md chunks. An unclosed fence runs to the end of the text.
 * @param {string} text
 * @returns {({ kind: "md", text: string } | { kind: "mermaid", source: string })[]}
 */
export function splitMarkdown(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const chunks = [];
  let md = "";
  const flush = () => {
    if (md.trim()) chunks.push({ kind: "md", text: md });
    md = "";
  };
  for (let i = 0; i < lines.length; i++) {
    const open = openingFence(lines[i]);
    if (!open) {
      md += lines[i] + "\n";
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !closesFence(lines[end], open.char, open.length)) end++;
    if (open.info.split(/\s+/)[0].toLowerCase() === "mermaid") {
      flush();
      let source = lines.slice(i + 1, end).join("\n");
      if (end === lines.length) source = source.replace(/\n+$/, "");
      chunks.push({ kind: "mermaid", source });
    } else {
      md += lines.slice(i, end + 1).join("\n") + "\n";
    }
    i = end;
  }
  flush();
  return chunks;
}

/**
 * A stable content hash for cache names: fnv1a32 of the string as 8 hex chars, then its length in hex.
 * @param {string} s
 * @returns {string}
 */
export function hashSource(s) {
  return fnv1a32(s).toString(16).padStart(8, "0") + s.length.toString(16);
}

/**
 * The natural size of an SVG, from the root <svg> width/height (px or unitless), else its viewBox.
 * Null when neither can be read.
 * @param {string} svg
 * @returns {{ width: number, height: number } | null}
 */
export function parseSvgSize(svg) {
  const tag = rootTag(svg);
  if (!tag) return null;
  const width = parseLength(attribute(tag, "width")), height = parseLength(attribute(tag, "height"));
  if (width !== null && height !== null) return { width, height };
  const box = (attribute(tag, "viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (box.length === 4 && box[2] > 0 && box[3] > 0) return { width: box[2], height: box[3] };
  return null;
}

/**
 * The document's title: the text of its first "# " heading, else the file name from the path.
 * @param {string} text
 * @param {string} path absolute path of the document
 * @returns {string}
 */
export function docTitle(text, path) {
  const match = /^# (.+?)\s*$/m.exec(text);
  return match ? match[1] : path.split("/").pop();
}

// Private: FNV-1a 32-bit hash of a string, as an unsigned number.
function fnv1a32(s) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// Private: the root <svg> start tag of an SVG string, or null.
function rootTag(svg) {
  const match = /<svg\b[^>]*>/i.exec(svg);
  return match ? match[0] : null;
}

// Private: the value of one attribute in a tag, or null.
function attribute(tag, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return match ? (match[1] ?? match[2]) : null;
}

// Private: a positive px length from an SVG attribute value, or null (percentages and missing values too).
function parseLength(value) {
  if (value === null || value.endsWith("%")) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Private: an opening fence line ({ char, length, info }) or null. Indent 0-3 spaces; run of 3+ "`" or "~".
function openingFence(line) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const run = match[1], info = match[2].trim();
  if (run[0] === "`" && info.includes("`")) return null;
  return { char: run[0], length: run.length, info };
}

// Private: true when a line closes a fence opened with char and length: same char, run >= length, only whitespace after.
function closesFence(line, char, length) {
  const match = /^ {0,3}(`+|~+)\s*$/.exec(line);
  return Boolean(match) && match[1][0] === char && match[1].length >= length;
}
