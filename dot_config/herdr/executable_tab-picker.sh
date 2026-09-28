#!/bin/sh
# tab-picker.sh — fzf popup listing every tab in the session.
#
# Usage: tab-picker.sh [--rows-from <file> | --preview <pane_id> <summary...>]
#   (no args)      normal mode: fzf rows, `herdr tab focus` on Enter
#   --rows-from    debug/test mode: print the TSV rows for a saved snapshot
#                  file (accepts raw `herdr api snapshot` output or a bare
#                  snapshot), without needing a TTY
#   --preview      preview mode: print the panes summary, a separator line,
#                  then the focused pane's recent output
# Rows (TSV): tab_id, focused_pane_id, panes summary, workspace, tab, status.
# Exit 0 on focus, Esc, or empty selection. Requires fzf + jq + herdr.

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
H="${HERDR_BIN_PATH:-herdr}"

ROWS_JQ='
def pane_short($p):
  (($p.label // "") as $l
   | if $l == "" then ($p.agent // $p.pane_id) else $l end);
def tab_row($t; $ws; $focus; $bypane):
  (($bypane[$t.tab_id] // []) as $ps
   | ([($ps[]) as $p | pane_short($p)] | join(", ")) as $sum
   | [$t.tab_id,
      ($focus[$t.tab_id] // ""),
      $sum,
      ($ws[$t.workspace_id] // ""),
      ($t.label // ""),
      (if ([$ps[] | select(.agent != null)] | length) > 0
       then ($t.agent_status // "") else "" end)]);
(.result.snapshot // .) as $s
| ((($s.workspaces // [])
    | map({key: .workspace_id, value: (.label // "")})
    | from_entries)) as $ws
| ((($s.layouts // [])
    | map({key: .tab_id, value: (.focused_pane_id // "")})
    | from_entries)) as $focus
| ((($s.panes // [])
    | group_by(.tab_id)
    | map({key: .[0].tab_id, value: .})
    | from_entries)) as $bypane
| ([(($s.tabs // [])[]) as $t | tab_row($t; $ws; $focus; $bypane)]) as $rows
| (([$rows[][3] | length] + [0] | max)) as $m4
| (([$rows[][4] | length] + [0] | max)) as $m5
| ([28, $m4] | min) as $w4
| ([28, $m5] | min) as $w5
| ($rows[]
   | (.[3] |= (. + (" " * ($w4 - length))))
   | (.[4] |= (. + (" " * ($w5 - length))))
   | @tsv)
'

# build_rows: snapshot JSON on stdin -> 6-field TSV, one row per tab.
build_rows() {
  jq -r "$ROWS_JQ"
}

# preview_mode <pane_id> <summary...>: summary, separator, recent pane output.
# Extra args are rejoined: fzf substitutes {3} unquoted, so summaries with
# spaces arrive split across $3..$n.
preview_mode() {
  pane_id=$(printf '%s' "${1:-}" | sed 's/[[:blank:]]*$//')
  shift
  summary=$(printf '%s ' "$@" | sed 's/[[:blank:]]*$//')
  printf '%s\n' "$summary"
  printf '%s\n' "---"
  if [ -n "$pane_id" ]; then
    out=$("$H" pane read "$pane_id" --source recent --lines 60 2>/dev/null) || exit 0
    text=$(printf '%s' "$out" | jq -r '.result.text // empty' 2>/dev/null)
    if [ -n "$text" ]; then
      printf '%s\n' "$text"
    else
      printf '%s\n' "$out"
    fi
  fi
}

# run_picker: fzf over rows; on selection `herdr tab focus <tab_id>`.
run_picker() {
  command -v fzf >/dev/null 2>&1 || exit 0
  rows=$("$H" api snapshot 2>/dev/null | build_rows) || exit 0
  [ -n "$rows" ] || exit 0
  tab_id=$(printf '%s\n' "$rows" | fzf --delimiter='\t' --with-nth=4,5,6 \
    --nth=1,2 --accept-nth=1 --tiebreak=index \
    --prompt='tab> ' --header='enter: focus · esc: cancel' \
    --preview="$0 --preview {2} {3}" --preview-window='right,60%,wrap' || true)
  [ -n "$tab_id" ] || exit 0
  "$H" tab focus "$tab_id" >/dev/null 2>&1 || true
  exit 0
}

if [ "${1:-}" = "--preview" ]; then
  shift
  preview_mode "$@"
elif [ "${1:-}" = "--rows-from" ]; then
  build_rows < "${2:-/dev/null}"
else
  run_picker
fi
