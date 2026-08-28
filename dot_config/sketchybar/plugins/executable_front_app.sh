#!/bin/bash

source "$HOME/.config/sketchybar/icon_map.sh"

if [ "$SENDER" = "front_app_switched" ]; then
  APP="$INFO"
else
  APP="$(osascript -e 'tell application "System Events" to name of first application process whose frontmost is true' 2>/dev/null)"
fi

[ -z "$APP" ] && exit 0

case "$APP" in
  ghostty) APP="Ghostty" ;;
  Outlook) APP="Microsoft Outlook" ;;
esac

__icon_map "$APP"
sketchybar --set "$NAME" icon="$icon_result" label="$APP"
