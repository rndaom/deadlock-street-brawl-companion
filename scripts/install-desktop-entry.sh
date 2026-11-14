#!/bin/sh
# Adds Street Brawl Companion to the desktop's app launcher (the Super+Space menu on Omarchy),
# starting this checkout's packaged app through start-companion.sh.
#   scripts/install-desktop-entry.sh           -> install or update the entry
#   scripts/install-desktop-entry.sh --remove  -> take it out again
set -eu
root=$(dirname "$(dirname "$(readlink -f "$0")")")
data=${XDG_DATA_HOME:-$HOME/.local/share}
entry="$data/applications/street-brawl-companion.desktop"
icon="$data/icons/hicolor/scalable/apps/street-brawl-companion.svg"

refresh() {
  if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q "$data/applications" || true; fi
}

if [ "${1:-}" = "--remove" ]; then
  rm -f "$entry" "$icon"
  refresh
  echo "Removed the Street Brawl Companion launcher entry."
  exit 0
fi

mkdir -p "$data/applications" "$(dirname "$icon")"
cp "$root/public/favicon.svg" "$icon"
# Desktop entries quote paths with double quotes; escape the characters that are special inside them.
launcher=$(printf '%s' "$root/start-companion.sh" | sed -e 's/[\\"`$]/\\&/g' -e 's/%/%%/g')
cat > "$entry" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Street Brawl Companion
GenericName=Deadlock Street Brawl helper
Comment=Reads the Street Brawl item draft and suggests a pick
Exec="$launcher"
Icon=$icon
Terminal=false
Categories=Game;
Keywords=deadlock;street;brawl;draft;companion;
StartupNotify=false
EOF
refresh
if [ ! -x "$root/release/linux-unpacked/street-brawl-companion" ]; then
  echo "Note: the app is not packaged yet. Run \"npm ci\" and \"npm run package:linux\" in $root first."
fi
echo "Installed $entry"
