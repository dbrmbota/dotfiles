#!/bin/bash
# auto-name.sh — reconcile Herdr pane/tab names with foreground processes.
#
# Usage: auto-name.sh sync | reset
#   sync   one coalesced reconcile pass (plugin events, zsh hooks)
#   reset  same pass with reset=true (overwrite manual labels)
# Reads: `herdr api snapshot`, `herdr pane process-info --pane <id>`.
# Writes: `herdr pane rename`, `herdr tab rename`, `$HERDR_PLUGIN_STATE_DIR/state.json`.
# Exit 0 unless an unexpected error occurs; diagnostics go to stderr
# (visible in `herdr plugin log`). Bash 3.2 compatible (no associative arrays).

set -u

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

H="${HERDR_BIN_PATH:-herdr}"
S="${HERDR_PLUGIN_STATE_DIR:-${TMPDIR:-/tmp}/herdr-auto-name}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JQFILE="$SCRIPT_DIR/auto-name.jq"
LOCK="$S/lock"
DIRTY="$S/dirty"

# Take $LOCK (mkdir) or record a coalescing request via $DIRTY.
# Returns 0 when the caller holds the lock, 1 when it deferred to the holder.
acquire_lock() {
  if mkdir "$LOCK" 2>/dev/null; then
    return 0
  fi
  now=$(date +%s)
  mtime=$(stat -f %m "$LOCK" 2>/dev/null || stat -c %Y "$LOCK" 2>/dev/null || echo "")
  case "$mtime" in
    ''|*[!0-9]*) ;;
    *)
      if [ "$((now - mtime))" -lt 30 ]; then
        touch "$DIRTY"
        return 1
      fi
      ;;
  esac
  rm -rf "$LOCK" 2>/dev/null || true
  if mkdir "$LOCK" 2>/dev/null; then
    return 0
  fi
  touch "$DIRTY"
  return 1
}

# Release the lock dir. A dirty marker left behind is consumed by the next pass.
release_lock() {
  rmdir "$LOCK" 2>/dev/null || true
}

# One pass: snapshot, per-pane process-info, jq naming, apply ops, save state.
# $1 is "true" (reset) or "false" (sync).
run_pass() {
  reset="$1"
  snap="$("$H" api snapshot 2>/dev/null | jq -c '.result.snapshot // empty')" || {
    echo "auto-name: snapshot request failed" >&2
    return 1
  }
  if [ -z "$snap" ]; then
    echo "auto-name: empty snapshot" >&2
    return 1
  fi
  pane_ids=$(printf '%s' "$snap" | jq -r '.panes[] | select(.agent == null) | .pane_id') || {
    echo "auto-name: failed to list panes" >&2
    return 1
  }
  procs="{"
  first=1
  for pid in $pane_ids; do
    info="$("$H" pane process-info --pane "$pid" 2>/dev/null | jq -c '.result.process_info // empty')" || continue
    [ -n "$info" ] || continue
    key=$(printf '%s' "$pid" | jq -R .) || continue
    if [ "$first" = 1 ]; then first=0; else procs="$procs,"; fi
    procs="$procs$key:$info"
  done
  procs="$procs}"
  state="{}"
  if [ -f "$S/state.json" ]; then
    state=$(jq -c 'if type == "object" then . else {} end' "$S/state.json" 2>/dev/null) || state="{}"
    [ -n "$state" ] || state="{}"
  fi
  result=$(jq -n --argjson snap "$snap" --argjson procs "$procs" \
    --argjson state "$state" --arg home "$HOME" --argjson reset "$reset" \
    -f "$JQFILE") || {
    echo "auto-name: naming failed" >&2
    return 1
  }
  printf '%s' "$result" | jq -r '.ops[] | [.kind, .id, .label] | @tsv' | {
    while IFS='	' read -r kind id label; do
      if [ "$kind" = "pane" ]; then
        "$H" pane rename "$id" "$label" >/dev/null 2>&1 || \
          echo "auto-name: pane rename $id failed" >&2
      elif [ "$kind" = "tab" ]; then
        "$H" tab rename "$id" "$label" >/dev/null 2>&1 || \
          echo "auto-name: tab rename $id failed" >&2
      fi
    done
  }
  tmp="$S/state.json.tmp.$$"
  if printf '%s' "$result" | jq -c '.state' > "$tmp" 2>/dev/null; then
    mv "$tmp" "$S/state.json" || {
      echo "auto-name: state write failed" >&2
      rm -f "$tmp"
      return 1
    }
  else
    echo "auto-name: state encode failed" >&2
    rm -f "$tmp"
    return 1
  fi
  return 0
}

# Run passes while the dirty marker reappears; re-check once after release so
# a request arriving during release is not lost.
sync_loop() {
  reset="$1"
  acquire_lock || exit 0
  trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT INT TERM
  while :; do
    rm -f "$DIRTY"
    run_pass "$reset" || break
    [ -e "$DIRTY" ] || break
  done
  release_lock
  if [ -e "$DIRTY" ]; then
    if acquire_lock; then
      while :; do
        rm -f "$DIRTY"
        run_pass "$reset" || break
        [ -e "$DIRTY" ] || break
      done
      release_lock
    fi
  fi
  trap - EXIT INT TERM
}

# One coalesced reconcile pass.
do_sync() {
  sync_loop "false"
}

# One pass with reset=true: manual labels are overwritten.
do_reset() {
  sync_loop "true"
}

command -v jq >/dev/null 2>&1 || {
  echo "auto-name: jq not found in PATH" >&2
  exit 1
}
[ -f "$JQFILE" ] || {
  echo "auto-name: $JQFILE not found" >&2
  exit 1
}
mkdir -p "$S" 2>/dev/null || {
  echo "auto-name: cannot create $S" >&2
  exit 1
}

case "${1:-}" in
  sync) do_sync ;;
  reset) do_reset ;;
  *) echo "usage: $0 {sync|reset}" >&2; exit 1 ;;
esac
