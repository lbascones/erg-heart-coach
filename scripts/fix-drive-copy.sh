#!/usr/bin/env bash
# Fixes and checks the automatic Google Drive copy on the laptop.
#
# The README's service file used to have the ROWING_AFTER_BACKUP line without quotes, so systemd cut the
# command at the first space and the copy to Drive never ran. This script adds the quotes, restarts the
# service, copies everything that is missing to Drive right away, and then checks the automatic copy.
#
# Run it on the laptop:
#   cd ~/erg-heart-coach && git pull && bash scripts/fix-drive-copy.sh
# Safe to run more than once.

set -u
SERVICE="$HOME/.config/systemd/user/rowing.service"

step() { printf '\n== %s\n' "$1"; }

step "1. Diagnostics files on the laptop"
ls -la "$HOME/rowing-backups/diagnostics/" 2>/dev/null || echo "   No diagnostics folder yet."

step "2. Service file"
if [ ! -f "$SERVICE" ]; then
  echo "   $SERVICE not found. Do step 5 of 'Setting up the laptop' in the README first."
  exit 1
fi
if grep -q '^Environment=ROWING_AFTER_BACKUP=' "$SERVICE"; then
  cp "$SERVICE" "$SERVICE.bak"
  sed -i 's|^Environment=ROWING_AFTER_BACKUP=\(.*\)$|Environment="ROWING_AFTER_BACKUP=\1"|' "$SERVICE"
  echo "   Added the missing quotes (the old file is kept as rowing.service.bak)."
elif grep -q '^Environment="ROWING_AFTER_BACKUP=' "$SERVICE"; then
  echo "   Already has the quotes."
else
  echo "   There is no active ROWING_AFTER_BACKUP line. If it starts with #, remove the # and run this again."
  exit 1
fi
grep ROWING_AFTER_BACKUP "$SERVICE"

step "3. Restarting the app server"
systemctl --user daemon-reload
systemctl --user restart rowing
sleep 2
echo "   Service: $(systemctl --user is-active rowing)"
systemctl --user show rowing -p Environment

step "4. Copying everything that is missing to Google Drive now"
CMD=$(sed -n 's|^Environment="ROWING_AFTER_BACKUP=\(.*\)"$|\1|p' "$SERVICE" | sed "s|%h|$HOME|g")
echo "   Running: $CMD"
if eval "$CMD"; then
  echo "   Copy finished. Files in Drive:"
  REMOTE=$(echo "$CMD" | awk '{print $NF}')
  rclone lsf -R "$REMOTE" | sed 's/^/     /'
else
  echo "   The copy failed (see the message above). Check the internet connection and 'rclone config'."
  exit 1
fi

step "5. Checking the automatic copy"
echo "   In the app, open Settings and tap Save (that makes a backup)."
read -r -p "   Then come back here and press Enter... " _
sleep 3
if journalctl --user -u rowing -n 20 --no-pager | grep -q 'after-backup command finished'; then
  echo "   OK: the server copied the backup to Drive by itself."
else
  echo "   Not seen yet. The last messages from the server:"
  journalctl --user -u rowing -n 10 --no-pager
  echo "   (A big copy can take a little longer: wait a minute and run"
  echo "    journalctl --user -u rowing -n 5 --no-pager   and look for 'after-backup command finished'.)"
fi
