#!/bin/bash

GREEN=0xff9ed072
ORANGE=0xfff39660
RED=0xfffc5d7c

PERCENTAGE="$(pmset -g batt | grep -Eo '[0-9]+%' | tr -d '%' | head -1)"
if [ -z "$PERCENTAGE" ]; then
  exit 0
fi

CHARGING="$(pmset -g batt | grep -c 'AC Power')"
COLOR=$GREEN
if [ "$CHARGING" -gt 0 ]; then
  ICON=""
else
  if [ "$PERCENTAGE" -gt 80 ]; then
    ICON=""
  elif [ "$PERCENTAGE" -gt 60 ]; then
    ICON=""
  elif [ "$PERCENTAGE" -gt 40 ]; then
    ICON=""
  elif [ "$PERCENTAGE" -gt 20 ]; then
    ICON=""
    COLOR=$ORANGE
  else
    ICON=""
    COLOR=$RED
  fi
fi

sketchybar --set "$NAME" icon="$ICON" icon.color="$COLOR" label="${PERCENTAGE}%"
