#!/usr/bin/env bash
# Collects what is needed to see why files are not copied to Google Drive automatically.
#
#   cd ~/erg-heart-coach && git pull && bash scripts/check-drive-copy.sh
#
# Prints a short report and also saves it as ~/drive-check.txt.

set -u
REPORT="$HOME/drive-check.txt"

{
  echo "== Drive copy check, $(date '+%Y-%m-%d %H:%M')"

  echo; echo "== rclone"
  command -v rclone || echo "rclone is not on this terminal's PATH"
  rclone version 2>/dev/null | head -1
  echo "remotes: $(rclone listremotes 2>/dev/null | tr '\n' ' ')"

  echo; echo "== What the server was given"
  systemctl --user show rowing -p Environment -p ActiveState -p ActiveEnterTimestamp
  systemctl --user show-environment 2>/dev/null | grep '^PATH='

  echo; echo "== Server messages about backups and copies (newest last)"
  journalctl --user -u rowing --no-pager -n 300 -o short-iso 2>/dev/null \
    | grep -Ei 'backup|diagnostic|rclone|error|listening|Rowing display' | tail -n 15

  echo; echo "== Files on the laptop"
  ls -la "$HOME/rowing-backups/" "$HOME/rowing-backups/diagnostics/" 2>&1 | tail -n 15

  echo; echo "== The copy command, run here by hand"
  CMD=$(systemctl --user show rowing -p Environment | grep -o 'ROWING_AFTER_BACKUP=.*' \
    | sed 's/^ROWING_AFTER_BACKUP=//; s/\\x20/ /g; s/"$//' | sed "s|%h|$HOME|g")
  if [ -z "$CMD" ]; then
    echo "The server has no ROWING_AFTER_BACKUP setting."
  else
    echo "Command: $CMD"
    eval "$CMD -v" 2>&1 | tail -n 8
    echo "Exit code: ${PIPESTATUS[0]}"
    echo; echo "== Files in Drive"
    rclone lsf -R "$(echo "$CMD" | awk '{print $NF}')" 2>&1 | tail -n 15
  fi
} 2>&1 | tee "$REPORT"

echo
echo "Saved to $REPORT"
