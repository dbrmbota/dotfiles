#!/bin/bash

BLUE=0xff76cce0
YELLOW=0xffe7c664
ORANGE=0xfff39660
RED=0xfffc5d7c

NCPU="$(sysctl -n hw.ncpu 2>/dev/null)"
[ -z "$NCPU" ] || [ "$NCPU" -lt 1 ] && NCPU=1

LOAD="$(ps -A -o %cpu 2>/dev/null | awk -v n="$NCPU" 'NR>1 { s += $1 } END { v = (n > 0) ? s / n : 0; if (v < 0) v = 0; if (v > 100) v = 100; printf "%.0f", v }')"
[ -z "$LOAD" ] && exit 0

COLOR=$BLUE
if [ "$LOAD" -gt 80 ]; then
  COLOR=$RED
elif [ "$LOAD" -gt 60 ]; then
  COLOR=$ORANGE
elif [ "$LOAD" -gt 30 ]; then
  COLOR=$YELLOW
fi

FRAC="$(awk -v l="$LOAD" 'BEGIN { printf "%.2f", l / 100 }')"
sketchybar --push cpu "$FRAC"
sketchybar --set cpu label="cpu ${LOAD}%" graph.color="$COLOR"
