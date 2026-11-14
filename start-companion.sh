#!/bin/sh
# Linux counterpart of "Start Companion.cmd": starts the packaged app from release/linux-unpacked.
dir=$(dirname "$(readlink -f "$0")")
app="$dir/release/linux-unpacked/street-brawl-companion"
if [ ! -x "$app" ]; then
  echo "The Linux application has not been packaged yet."
  echo "Run \"npm ci\" and then \"npm run package:linux\" in this folder first."
  exit 1
fi
exec "$app" "$@"
