#!/bin/bash

if [ "$SENDER" = "volume_change" ]; then
  V="$INFO"
else
  V="$(osascript -e 'output volume of (get volume settings)' 2>/dev/null)"
  [ -z "$V" ] && exit 0
fi

case "$V" in
  [7-9][0-9]|100) ICON="" ;;
  [3-6][0-9])     ICON="" ;;
  [1-9]|[1-2][0-9]) ICON="" ;;
  *)              ICON="" ;;
esac

sketchybar --set "$NAME" icon="$ICON" label="$V%"
