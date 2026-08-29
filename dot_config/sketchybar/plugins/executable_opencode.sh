#!/bin/bash

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

NAME="${NAME:-opencode}"
CACHE="/tmp/sketchybar-opencode-stats.txt"
FONT="Hack Nerd Font"
WHITE=0xffe2e2e3
GREY=0xff7f8490
GREEN=0xff9ed072

popup_draw() {
  sketchybar --set "$NAME" popup.drawing="$1"
}

case "$SENDER" in
  mouse.entered)
    popup_draw on
    exit 0
    ;;
  mouse.exited | mouse.exited.global)
    popup_draw off
    exit 0
    ;;
esac

if ! command -v opencode >/dev/null 2>&1; then
  sketchybar --set "$NAME" label="—"
  exit 0
fi

STATS="$(opencode stats --days 1 --models 2>/dev/null | perl -pe 's/\e\[[0-9;]*[A-Za-z]//g')"

if [ -z "$STATS" ]; then
  sketchybar --set "$NAME" label="—"
  exit 0
fi

ZEN_COST="$(printf '%s\n' "$STATS" | awk '
  BEGIN { in_models=0; current=""; zen=0 }
  {
    gsub(/[┌┐└┘├┤│─]/, "")
    gsub(/^[ \t]+|[ \t]+$/, "")
    if ($0 == "MODEL USAGE") { in_models=1; current=""; next }
    if ($0 == "TOOL USAGE" || $0 == "OVERVIEW" || $0 == "COST & TOKENS") { in_models=0; next }
    if (!in_models) next
    if ($0 == "") next
    if ($0 ~ /^[^[:space:]]+\/[^[:space:]]+$/) { current=$0; next }
    if ($1 == "Cost") {
      cost=$NF
      gsub(/\$/, "", cost)
      if (current ~ /^opencode\//) zen += cost+0
    }
  }
  END { printf "$%.2f", zen }
')"

sketchybar --set "$NAME" label="$ZEN_COST"

if [ "$STATS" = "$(cat "$CACHE" 2>/dev/null)" ] && sketchybar --query "${NAME}.line.0" >/dev/null 2>&1; then
  exit 0
fi
printf '%s\n' "$STATS" > "$CACHE"

ROWS="$(printf '%s\n' "$STATS" | awk '
  function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
  function flush_overview() {
    if (ov_sess == "") return
    day = ov_days " day"
    if (ov_days != "1") day = day "s"
    print "L|" ov_sess " sessions · " ov_msg " messages · " day
    ov_sess = ""
  }
  function flush_cost() {
    if (c_total == "") return
    print "L|Total " c_total " · " c_avg "/day"
    print "L|" c_in " in · " c_out " out"
    print "L|" c_cr " cache read · " c_cw " write"
    print "L|" c_avg_tok " avg/sess · " c_med_tok " med"
    c_total = ""
  }
  function flush_model() {
    if (m_name == "") return
    print "M|" m_name "|" m_cost
    print "L|" m_msg " msg · " m_in " in · " m_out " out"
    print "L|" m_cr " cache read · " m_cw " write"
    m_name = ""
  }
  {
    gsub(/[┌┐└┘├┤│─]/, "")
    line = trim($0)
    if (line == "") next
    if (line == "OVERVIEW") { print "H|Overview"; section = "overview"; next }
    if (line == "COST & TOKENS") { flush_overview(); print "S|"; print "H|Cost & Tokens"; section = "cost"; next }
    if (line == "MODEL USAGE") { flush_cost(); print "S|"; print "H|Models"; section = "models"; next }
    if (line == "TOOL USAGE") { flush_model(); print "S|"; print "H|Tools"; section = "tools"; next }
    n = split(line, parts, /[ \t]+/)
    val = parts[n]
    key = parts[1]
    for (i = 2; i < n; i++) key = key " " parts[i]
    if (section == "overview") {
      if (key == "Sessions") ov_sess = val
      if (key == "Messages") ov_msg = val
      if (key == "Days") ov_days = val
      next
    }
    if (section == "cost") {
      if (key == "Total Cost") c_total = val
      if (key == "Avg Cost/Day") c_avg = val
      if (key == "Avg Tokens/Session") c_avg_tok = val
      if (key == "Median Tokens/Session") c_med_tok = val
      if (key == "Input") c_in = val
      if (key == "Output") c_out = val
      if (key == "Cache Read") c_cr = val
      if (key == "Cache Write") c_cw = val
      next
    }
    if (section == "models") {
      if (line ~ /^[^[:space:]]+\/[^[:space:]]+$/) { flush_model(); m_name = line; next }
      if (key == "Messages") m_msg = val
      if (key == "Input Tokens") m_in = val
      if (key == "Output Tokens") m_out = val
      if (key == "Cache Read") m_cr = val
      if (key == "Cache Write") m_cw = val
      if (key == "Cost") m_cost = val
      next
    }
    if (section == "tools") {
      gsub(/[█▓▒░]/, "", line)
      line = trim(line)
      n = split(line, parts, /[ \t]+/)
      tool = parts[1]
      rest = parts[2]
      for (i = 3; i <= n; i++) rest = rest " " parts[i]
      print "T|" tool "|" rest
    }
  }
  END { flush_overview(); flush_cost(); flush_model() }
')"

sketchybar --remove "/${NAME}\\.line\\..*/" 2>/dev/null

args=()
i=0
while IFS= read -r row || [ -n "$row" ]; do
  [ -z "$row" ] && continue
  typ="${row%%|*}"
  rest="${row#*|}"
  id="${NAME}.line.$i"
  args+=(
    --add item "$id" "popup.$NAME"
    --set "$id"
      background.drawing=off
      background.height=18
      padding_left=0
      padding_right=0
      icon.padding_left=0
      icon.padding_right=0
  )
  case "$typ" in
    S)
      args+=(
        icon.drawing=off
        label.drawing=off
      )
      ;;
    H)
      args+=(
        icon.drawing=off
        label="$rest"
        label.font="$FONT:Bold:10.0"
        label.color=$GREY
        label.padding_left=10
        label.padding_right=10
      )
      ;;
    L)
      args+=(
        icon.drawing=off
        label="$rest"
        label.font="$FONT:Regular:11.0"
        label.color=$WHITE
        label.padding_left=12
        label.padding_right=10
      )
      ;;
    M)
      model="${rest%%|*}"
      cost="${rest#*|}"
      args+=(
        icon="$model"
        icon.font="$FONT:Bold:11.0"
        icon.color=$WHITE
        icon.align=left
        icon.width=200
        icon.padding_left=10
        icon.padding_right=4
        label="$cost"
        label.font="$FONT:Bold:11.0"
        label.color=$GREEN
        label.padding_left=4
        label.padding_right=10
      )
      ;;
    T)
      tool="${rest%%|*}"
      count="${rest#*|}"
      args+=(
        icon="$tool"
        icon.font="$FONT:Regular:11.0"
        icon.color=$WHITE
        icon.align=left
        icon.width=130
        icon.padding_left=10
        icon.padding_right=4
        label="$count"
        label.font="$FONT:Regular:11.0"
        label.color=$WHITE
        label.padding_left=4
        label.padding_right=10
      )
      ;;
  esac
  i=$((i + 1))
done <<< "$ROWS"

if [ ${#args[@]} -gt 0 ]; then
  sketchybar "${args[@]}" --set "$NAME" popup.drawing=off
fi
