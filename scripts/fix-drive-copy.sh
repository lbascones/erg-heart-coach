#!/usr/bin/env bash
# Fixes and checks the automatic Google Drive copy on the laptop.
#
# Turns on the automatic copy: writes the ROWING_AFTER_BACKUP line into the service file (replacing a line
# that is still commented out with #, or an old one without quotes, which systemd cuts at the first space),
# restarts the service, copies everything that is missing to Drive right away, then checks the automatic copy.
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
REMOTE=$(rclone listremotes 2>/dev/null | grep -m1 '^gdrive:' || rclone listremotes 2>/dev/null | head -n1)
if [ -z "$REMOTE" ]; then
  echo "   rclone has no Google Drive remote yet. Do 'Google Drive backups (rclone)' in the README first."
  exit 1
fi
LINE="Environment=\"ROWING_AFTER_BACKUP=rclone copy %h/rowing-backups ${REMOTE}rowing-backups\""
if grep -qxF "$LINE" "$SERVICE"; then
  echo "   Already set correctly."
else
  # Replace any old version of the line (commented out with #, or without quotes) with the right one.
  cp "$SERVICE" "$SERVICE.bak"
  sed -i '/ROWING_AFTER_BACKUP=/d' "$SERVICE"
  sed -i "/^ExecStart=/a $LINE" "$SERVICE"
  echo "   Turned on the Drive copy (the old file is kept as rowing.service.bak)."
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
