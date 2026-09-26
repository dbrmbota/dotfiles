#!/bin/sh
# pi-memory pre-apply smoke test driver.
#
# Usage: bash dot_pi/agent/extensions/memory/smoke.sh
#        (from the chezmoi source root; excluded from `chezmoi apply`
#        via .chezmoiignore, so it never lands in ~/.pi)
#
# What it does:
#   1. Stages this directory to /tmp/pi-memory-smoke/stage, installs deps,
#      and re-runs the unit suite (fast, no model needed).
#   2. Runs a non-interactive pi load check (extension must load via jiti
#      with no errors; requires your normal pi auth).
#   3. Prints the interactive checklist, then drops you into
#      PI_MEMORY_DB=... pi -e <stage>/index.ts for the manual steps.
#   4. After you exit pi, dumps the smoke DB contents for inspection.
#
# Prerequisite: use an agent whose tools include memory_read, memory_find
# and memory_write (the `chat` agent gets them automatically; custom agents
# need them added to their `tools:` list manually). The live ~/.pi/agent is
# untouched — everything runs from /tmp/pi-memory-smoke.

set -eu

SRC="$(cd "$(dirname "$0")" && pwd)"
ROOT=/tmp/pi-memory-smoke
STAGE="$ROOT/stage"
DB="$ROOT/smoke.db"

if [ ! -f "$SRC/package.json" ]; then
	echo "memory source not found at $SRC" >&2
	exit 1
fi

echo "=== 1/4 staging copy + deps ==="
rm -rf "$STAGE"
cp -R "$SRC" "$STAGE"
cd "$STAGE" && npm ci --omit=peer --no-audit --no-fund

echo "=== 2/4 unit tests (PI_MEMORY_DB=$ROOT/test.db) ==="
PI_MEMORY_DB="$ROOT/test.db" npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"

echo "=== 3/4 pi load check (non-interactive) ==="
rm -f "$DB"
PI_MEMORY_DB="$DB" pi -e "$STAGE/index.ts" --no-session -p "Reply with exactly: smoke-ok" 2>&1 | tail -5

cat <<'CHECKLIST'

=== 4/4 interactive checks ===
Launching: PI_MEMORY_DB=... pi -e <stage>/index.ts
Work through these, then exit pi (the script dumps the DB afterwards):

[1] Write gate: ask "store a memory called probe about this session".
    Expect the memory_write tool error (no /remember yet): "only allowed
    after the user runs /remember. Do not retry."

[2] /remember (pick a real topic from your day).
    Expect: model calls memory_find first, then memory_write exactly once,
    and a "Remembered: <name>" notify.

[3] In the same run, ask it to store one more memory.
    Expect rejection (gate disarms after the first successful write).

[4] /remember again on the same topic (same name).
    Expect the collision error (existing description + updated date), then
    the model retries with overwrite: true.

[5] @mem: flow: type @m, then : — expect the 5 recent entries with
    descriptions; keep typing to fuzzy-filter; Tab after the hint opens the
    list; picking one inserts "@mem:<name> " (trailing space).
    (Tab-accepting the hint closes the popup by design — press Tab again
    or retype : to reopen the recents.)
    Submit a message containing it — expect the model to call memory_read.
    Submit @mem:does-not-exist — expect an "Unknown memory" warning, and
    the text itself is sent unchanged.

[6] memory_find: ask about the topic from [2] in fresh words.
    Expect one line per hit: name · updated YYYY-MM-DD · description.
    (A "(keyword-only: ...)" suffix means vectors degraded — still valid,
    just FTS-only.)

[7] /memory edit <name>: change the description in the editor, save.
    Expect an "Updated" notify. Cancel path: nothing happens.
    /memory delete <name>: confirm, expect "Deleted"; repeat and expect
    the unknown-name error. Tab-completion after /memory should offer
    edit/delete, then names.

[8] (optional) concurrency: open a second terminal with the same
    PI_MEMORY_DB + -e stage path, /remember in both at once.
    Expect no SQLITE_BUSY errors.

CHECKLIST
printf 'Press Enter to launch pi...'
read -r _

PI_MEMORY_DB="$DB" pi -e "$STAGE/index.ts"

echo "=== smoke DB contents ($DB) ==="
node -e "
import('node:sqlite').then(({ DatabaseSync }) => {
  const db = new DatabaseSync(process.env.PI_MEMORY_DB);
  for (const p of db.prepare('SELECT id, kind, key, root FROM projects').all()) {
    console.log('project', p.id, p.kind, p.key, 'root=' + p.root);
    for (const m of db.prepare('SELECT name, description, updated_at, embedding_model FROM memories WHERE project_id = ?').all(p.id)) {
      console.log('  -', m.name, '|', m.description, '| updated', new Date(m.updated_at).toISOString().slice(0, 10), '| vector:', m.embedding_model ?? 'pending');
    }
  }
  db.close();
}).catch((e) => console.error('dump skipped:', e.message));
"
ls -la "$DB"*
echo 'Done. Next (per plan): chezmoi apply, then check ~/.pi/agent/extensions/memory/node_modules exists and plain pi auto-discovers the extension.'
