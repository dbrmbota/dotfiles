#!/bin/bash
# smoke.sh — fixture tests for auto-name.jq (not deployed, see .chezmoiignore).
#
# Each case runs: jq -n --argjson snap/procs/state --arg home --argjson reset
# -f auto-name.jq, then asserts ops + state with `jq -e`.
# Fixture shapes follow the herdr 0.9.1 API schema (pane_id/tab_id/workspace_id).

set -u
cd "$(dirname "$0")" || exit 1
JQ="auto-name.jq"
PASS=0
FAIL=0

# run_case <name> <snap> <procs> <state> <reset> <home> <assert-filter>
run_case() {
  out=$(jq -n --argjson snap "$2" --argjson procs "$3" --argjson state "$4" \
    --arg home "$6" --argjson reset "$5" -f "$JQ" 2>&1) || {
    echo "FAIL $1 (jq error): $out"
    FAIL=$((FAIL + 1))
    return
  }
  if printf '%s' "$out" | jq -e "$7" >/dev/null; then
    echo "ok $1"
    PASS=$((PASS + 1))
  else
    echo "FAIL $1: got $(printf '%s' "$out" | jq -c '.')"
    FAIL=$((FAIL + 1))
  fi
}

HOME_T="/Users/test"

# 1: idle -zsh in $HOME -> "zsh: ~"
SNAP1='{"workspaces":[{"workspace_id":"w1","label":"main"}],"tabs":[],"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1","label":"","agent":null,"foreground_cwd":"/Users/test","cwd":"/Users/test","focused":true}],"layouts":[]}'
PROC1='{"w1:p1":{"foreground_process_group_id":100,"foreground_processes":[{"pid":100,"argv0":"-zsh","name":"zsh","cwd":"/Users/test"}]}}'
run_case "idle-zsh-home" "$SNAP1" "$PROC1" '{}' false "$HOME_T" \
  '.ops==[{kind:"pane",id:"w1:p1",label:"zsh: ~"}] and .state.panes["w1:p1"]=="zsh: ~"'

# 2: idle zsh in /x/chezmoi via pane.foreground_cwd fallback -> "zsh: chezmoi"
SNAP2='{"workspaces":[{"workspace_id":"w1","label":"main"}],"tabs":[],"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1","label":"","agent":null,"foreground_cwd":"/x/chezmoi","cwd":"/x","focused":true}],"layouts":[]}'
PROC2='{"w1:p1":{"foreground_process_group_id":11,"foreground_processes":[{"pid":11,"argv0":"zsh","name":"zsh"}]}}'
run_case "idle-zsh-dir" "$SNAP2" "$PROC2" '{}' false "$HOME_T" \
  '.ops==[{kind:"pane",id:"w1:p1",label:"zsh: chezmoi"}]'

# 3: pipeline picks the group leader; nvim -> "nvim"
SNAP3='{"workspaces":[{"workspace_id":"w1","label":"main"}],"tabs":[],"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1","label":"","agent":null,"foreground_cwd":"/x","cwd":"/x","focused":true}],"layouts":[]}'
PROC3='{"w1:p1":{"foreground_process_group_id":20,"foreground_processes":[{"pid":10,"argv0":"zsh","name":"zsh","cwd":"/x"},{"pid":20,"argv0":"/usr/local/bin/nvim","name":"nvim","cwd":"/x"}]}}'
run_case "pipeline-leader-nvim" "$SNAP3" "$PROC3" '{}' false "$HOME_T" \
  '.ops==[{kind:"pane",id:"w1:p1",label:"nvim"}]'

# 4: agent pane without display_agent -> agent name
SNAP4='{"workspaces":[{"workspace_id":"w1","label":"main"}],"tabs":[],"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1","label":"","agent":"codex","display_agent":null,"foreground_cwd":"/x","cwd":"/x","focused":true}],"layouts":[]}'
run_case "agent-name" "$SNAP4" '{}' '{}' false "$HOME_T" \
  '.ops==[{kind:"pane",id:"w1:p1",label:"codex"}]'

# 5: manual pane label kept, dropped from state
SNAP5='{"workspaces":[{"workspace_id":"w1","label":"main"}],"tabs":[],"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1","label":"myterm","agent":null,"foreground_cwd":"/Users/test","cwd":"/Users/test","focused":true}],"layouts":[]}'
run_case "manual-kept" "$SNAP5" "$PROC1" '{}' false "$HOME_T" \
  '.ops==[] and (.state.panes|has("w1:p1")|not)'

# 6: reset=true overwrites the manual label
run_case "manual-reset" "$SNAP5" "$PROC1" '{}' true "$HOME_T" \
  '.ops==[{kind:"pane",id:"w1:p1",label:"zsh: ~"}]'

# 7: stale "pi - foo" on a shell pane is reclaimed
SNAP7='{"workspaces":[{"workspace_id":"w1","label":"main"}],"tabs":[],"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1","label":"pi - foo","agent":null,"foreground_cwd":"/Users/test","cwd":"/Users/test","focused":true}],"layouts":[]}'
run_case "stale-pi-reclaimed" "$SNAP7" "$PROC1" '{}' false "$HOME_T" \
  '.ops==[{kind:"pane",id:"w1:p1",label:"zsh: ~"}]'

# 8: "pi - foo" on an agent:"pi" pane -> no op, not in state
SNAP8='{"workspaces":[{"workspace_id":"w1","label":"main"}],"tabs":[],"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1","label":"pi - foo","agent":"pi","display_agent":null,"foreground_cwd":"/x","cwd":"/x","focused":true}],"layouts":[]}'
run_case "pi-owned" "$SNAP8" '{}' '{}' false "$HOME_T" \
  '.ops==[] and (.state.panes|has("w1:p1")|not)'

# 9: unnamed tab takes the layouts focused pane (not pane.focused): "1: pi - foo"
SNAP9='{"workspaces":[{"workspace_id":"w1","label":"main"}],"tabs":[{"tab_id":"w1:t1","workspace_id":"w1","label":"1"}],"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1","label":"pi - foo","agent":"pi","display_agent":null,"foreground_cwd":"/x","cwd":"/x","focused":false},{"pane_id":"w1:p2","tab_id":"w1:t1","label":"zsh: x","agent":null,"foreground_cwd":"/x","cwd":"/x","focused":true}],"layouts":[{"tab_id":"w1:t1","focused_pane_id":"w1:p1","panes":[{"pane_id":"w1:p1","focused":false},{"pane_id":"w1:p2","focused":true}]}]}'
PROC9='{"w1:p2":{"foreground_process_group_id":30,"foreground_processes":[{"pid":30,"argv0":"zsh","name":"zsh","cwd":"/x"}]}}'
STATE9='{"panes":{"w1:p2":"zsh: x"},"tabs":{}}'
run_case "tab-unnamed-pi" "$SNAP9" "$PROC9" "$STATE9" false "$HOME_T" \
  '.ops==[{kind:"tab",id:"w1:t1",label:"1: pi - foo"}]'

# 10: hand-renamed tab keeps base: "2: api work", base recorded
SNAP10='{"workspaces":[{"workspace_id":"w1","label":"main"}],"tabs":[{"tab_id":"w1:t1","workspace_id":"w1","label":"1: zsh: a"},{"tab_id":"w1:t2","workspace_id":"w1","label":"api work"}],"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1","label":"zsh: a","agent":null,"foreground_cwd":"/a","cwd":"/a","focused":false},{"pane_id":"w1:p2","tab_id":"w1:t2","label":"zsh: b","agent":null,"foreground_cwd":"/b","cwd":"/b","focused":true}],"layouts":[{"tab_id":"w1:t1","focused_pane_id":"w1:p1","panes":[{"pane_id":"w1:p1","focused":true}]},{"tab_id":"w1:t2","focused_pane_id":"w1:p2","panes":[{"pane_id":"w1:p2","focused":true}]}]}'
PROC10='{"w1:p1":{"foreground_process_group_id":40,"foreground_processes":[{"pid":40,"argv0":"zsh","name":"zsh","cwd":"/a"}]},"w1:p2":{"foreground_process_group_id":50,"foreground_processes":[{"pid":50,"argv0":"zsh","name":"zsh","cwd":"/b"}]}}'
STATE10='{"panes":{"w1:p1":"zsh: a","w1:p2":"zsh: b"},"tabs":{"w1:t1":{"written":"1: zsh: a","base":null}}}'
run_case "tab-manual-base" "$SNAP10" "$PROC10" "$STATE10" false "$HOME_T" \
  '.ops==[{kind:"tab",id:"w1:t2",label:"2: api work"}] and .state.tabs["w1:t2"].base=="api work"'

# 11: moving tabs renumbers but keeps base: "1: api work"
SNAP11='{"workspaces":[{"workspace_id":"w1","label":"main"}],"tabs":[{"tab_id":"w1:t2","workspace_id":"w1","label":"2: api work"},{"tab_id":"w1:t1","workspace_id":"w1","label":"1: zsh: a"}],"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1","label":"zsh: a","agent":null,"foreground_cwd":"/a","cwd":"/a","focused":false},{"pane_id":"w1:p2","tab_id":"w1:t2","label":"zsh: b","agent":null,"foreground_cwd":"/b","cwd":"/b","focused":true}],"layouts":[{"tab_id":"w1:t2","focused_pane_id":"w1:p2","panes":[{"pane_id":"w1:p2","focused":true}]},{"tab_id":"w1:t1","focused_pane_id":"w1:p1","panes":[{"pane_id":"w1:p1","focused":true}]}]}'
STATE11='{"panes":{"w1:p1":"zsh: a","w1:p2":"zsh: b"},"tabs":{"w1:t1":{"written":"1: zsh: a","base":null},"w1:t2":{"written":"2: api work","base":"api work"}}}'
run_case "tab-renumber-keeps-base" "$SNAP11" "$PROC10" "$STATE11" false "$HOME_T" \
  '.ops==[{kind:"tab",id:"w1:t2",label:"1: api work"},{kind:"tab",id:"w1:t1",label:"2: zsh: a"}] and .state.tabs["w1:t2"].base=="api work"'

# 12: reset puts the moved tab back to automatic
run_case "tab-reset" "$SNAP11" "$PROC10" "$STATE11" true "$HOME_T" \
  '.ops==[{kind:"tab",id:"w1:t2",label:"1: zsh: b"},{kind:"tab",id:"w1:t1",label:"2: zsh: a"}]'

# 13: label == written -> no op; rerun on output state -> zero ops.
# Snapshot labels match the post-renumber state from case 11.
SNAP13='{"workspaces":[{"workspace_id":"w1","label":"main"}],"tabs":[{"tab_id":"w1:t2","workspace_id":"w1","label":"1: api work"},{"tab_id":"w1:t1","workspace_id":"w1","label":"2: zsh: a"}],"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1","label":"zsh: a","agent":null,"foreground_cwd":"/a","cwd":"/a","focused":false},{"pane_id":"w1:p2","tab_id":"w1:t2","label":"zsh: b","agent":null,"foreground_cwd":"/b","cwd":"/b","focused":true}],"layouts":[{"tab_id":"w1:t2","focused_pane_id":"w1:p2","panes":[{"pane_id":"w1:p2","focused":true}]},{"tab_id":"w1:t1","focused_pane_id":"w1:p1","panes":[{"pane_id":"w1:p1","focused":true}]}]}'
STATE13='{"panes":{"w1:p1":"zsh: a","w1:p2":"zsh: b"},"tabs":{"w1:t2":{"written":"1: api work","base":"api work"},"w1:t1":{"written":"2: zsh: a","base":null}}}'
run_case "tab-idempotent" "$SNAP13" "$PROC10" "$STATE13" false "$HOME_T" '.ops==[]'
OUT13=$(jq -n --argjson snap "$SNAP13" --argjson procs "$PROC10" \
  --argjson state "$STATE13" \
  --arg home "$HOME_T" --argjson reset false -f "$JQ" 2>/dev/null | jq -c '.state')
RERUN=$(jq -n --argjson snap "$SNAP13" --argjson procs "$PROC10" --argjson state "$OUT13" \
  --arg home "$HOME_T" --argjson reset false -f "$JQ" 2>/dev/null | jq -c '.ops')
if [ "$RERUN" = "[]" ]; then
  echo "ok tab-rerun-zero-ops"
  PASS=$((PASS + 1))
else
  echo "FAIL tab-rerun-zero-ops: got $RERUN"
  FAIL=$((FAIL + 1))
fi

# 14: null / non-object state handled like {}
run_case "state-null" "$SNAP1" "$PROC1" 'null' false "$HOME_T" \
  '.ops==[{kind:"pane",id:"w1:p1",label:"zsh: ~"}]'
run_case "state-string" "$SNAP1" "$PROC1" '"oops"' false "$HOME_T" \
  '.ops==[{kind:"pane",id:"w1:p1",label:"zsh: ~"}]'

# 15: pane label changes -> tab follows in the SAME pass (no second sync)
SNAP15='{"workspaces":[{"workspace_id":"w1","label":"main"}],"tabs":[{"tab_id":"w1:t1","workspace_id":"w1","label":"1: zsh: a"}],"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1","label":"zsh: a","agent":null,"foreground_cwd":"/a","cwd":"/a","focused":true}],"layouts":[{"tab_id":"w1:t1","focused_pane_id":"w1:p1","panes":[{"pane_id":"w1:p1","focused":true}]}]}'
PROC15='{"w1:p1":{"foreground_process_group_id":60,"foreground_processes":[{"pid":60,"argv0":"/usr/local/bin/nvim","name":"nvim","cwd":"/a"}]}}'
STATE15='{"panes":{"w1:p1":"zsh: a"},"tabs":{"w1:t1":{"written":"1: zsh: a","base":null}}}'
run_case "tab-follows-pane-same-pass" "$SNAP15" "$PROC15" "$STATE15" false "$HOME_T" \
  '.ops==[{kind:"pane",id:"w1:p1",label:"nvim"},{kind:"tab",id:"w1:t1",label:"1: nvim"}]'

echo "---"
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
