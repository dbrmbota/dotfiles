#!/bin/sh
# smoke.sh — row-builder tests for tab-picker.sh (not deployed, see .chezmoiignore).
#
# Exercises the `--rows-from <snapshot-file>` debug flag: it prints the same
# 6-field TSV rows the picker feeds to fzf, without needing a TTY.
# Expected to FAIL until tab-picker.sh is implemented (stage 4).
set -u
cd "$(dirname "$0")" || exit 1
PASS=0
FAIL=0

FIX="$PWD/.smoke-snap.json"
cat >"$FIX" <<'JSON'
{"workspaces":[{"workspace_id":"w1","label":"main"},{"workspace_id":"w2","label":"ops"}],
 "tabs":[{"tab_id":"w1:t1","workspace_id":"w1","label":"1: zsh: api","agent_status":null},
         {"tab_id":"w1:t2","workspace_id":"w1","label":"2: pi - foo","agent_status":"working"},
         {"tab_id":"w2:t3","workspace_id":"w2","label":"1: nvim","agent_status":null}],
 "panes":[{"pane_id":"w1:p1","tab_id":"w1:t1","label":"zsh: api","agent":null},
          {"pane_id":"w1:p2","tab_id":"w1:t2","label":"pi - foo","agent":"pi"},
          {"pane_id":"w2:p3","tab_id":"w2:t3","label":"nvim","agent":null}],
 "layouts":[{"tab_id":"w1:t1","focused_pane_id":"w1:p1"},
            {"tab_id":"w1:t2","focused_pane_id":"w1:p2"},
            {"tab_id":"w2:t3","focused_pane_id":"w2:p3"}]}
JSON

ROWS=$(sh ./executable_tab-picker.sh --rows-from "$FIX" 2>&1) || {
  echo "FAIL rows-from (exit non-zero): $ROWS"
  FAIL=$((FAIL + 1))
  ROWS=""
}

if [ -n "$ROWS" ]; then
  # 3 rows, one per tab, in snapshot order.
  if [ "$(printf '%s\n' "$ROWS" | wc -l)" -eq 3 ]; then
    echo "ok row-count"; PASS=$((PASS + 1))
  else
    echo "FAIL row-count: $ROWS"; FAIL=$((FAIL + 1))
  fi
  # Every row has exactly 6 tab-separated fields.
  if printf '%s\n' "$ROWS" | awk -F'\t' 'NF!=6{bad=1} END{exit bad}'; then
    echo "ok six-fields"; PASS=$((PASS + 1))
  else
    echo "FAIL six-fields: $ROWS"; FAIL=$((FAIL + 1))
  fi
  # Tabs without agents have an empty status column; agent tabs do not.
  if printf '%s\n' "$ROWS" | awk -F'\t' '$1=="w1:t1"{$6!=""?bad=1:0} $1=="w2:t3"{$6!=""?bad=1:0} $1=="w1:t2"{$6==""?bad=1:0} END{exit bad}'; then
    echo "ok status-column"; PASS=$((PASS + 1))
  else
    echo "FAIL status-column: $ROWS"; FAIL=$((FAIL + 1))
  fi
fi

rm -f "$FIX"
echo "---"
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
