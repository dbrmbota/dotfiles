#!/bin/bash

WHITE=0xffe2e2e3
RED=0xfffc5d7c

IP="$(ipconfig getifaddr en0 2>/dev/null)"
if [ -n "$IP" ]; then
  sketchybar --set "$NAME" icon="" icon.color=$WHITE
else
  sketchybar --set "$NAME" icon="" icon.color=$RED
fi
