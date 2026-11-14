#!/usr/bin/env bash
# Trackpad helper for the laptop.
#
#   bash ~/erg-heart-coach/scripts/touchpad.sh          # record what's going on, then try to revive the trackpad
#   bash ~/erg-heart-coach/scripts/touchpad.sh check    # only record (run once while it works, as a baseline)
#
# Run it WHILE the trackpad is frozen (the keyboard still works: Alt+Tab to a terminal you left open).
# The report goes to ~/rowing-backups/diagnostics/touchpad-<date>-<time>.txt, so it reaches Google Drive with the
# backups once the Drive copy is on. sudo will ask for your password for the kernel messages and the driver restart.

set -u
MODE="${1:-fix}"
OUT_DIR="$HOME/rowing-backups/diagnostics"
mkdir -p "$OUT_DIR"
REPORT="$OUT_DIR/touchpad-$(date +%Y-%m-%d-%H%M%S)${MODE:+-$MODE}.txt"
export DISPLAY="${DISPLAY:-:0}"

section() { printf '\n== %s\n' "$1"; }

# The touchpad's xinput id and name (first device whose name looks like a touchpad).
touchpad_id() { xinput list 2>/dev/null | grep -iE 'touchpad|synaptics|elan|glidepoint' | grep -v -i 'touchscreen' | head -n1 | sed -n 's/.*id=\([0-9]*\).*/\1/p'; }

report() {
  echo "Touchpad report ($MODE), $(date '+%Y-%m-%d %H:%M:%S')"

  section "Input devices (xinput)"
  xinput list 2>&1

  local id; id=$(touchpad_id)
  section "Touchpad settings (xinput id ${id:-none found})"
  [ -n "$id" ] && xinput list-props "$id" 2>&1 | grep -iE 'enabled|tapping|click|accel|disable while|send events'

  section "Which kernel driver it uses"
  grep -iE -A6 'N: Name=.*(touchpad|synaptics|elan|glidepoint)' /proc/bus/input/devices | grep -E '^(N|P|S|H):'

  section "Open windows, including hidden dialogs"
  if command -v wmctrl >/dev/null; then wmctrl -l 2>&1
  else xwininfo -root -children 2>/dev/null | grep -E '0x[0-9a-f]+ "' | grep -v '"(has no name)"' | head -n 40; fi

  section "Programs that show password or choice dialogs"
  ps -eo pid,etime,args | grep -Ei 'gcr-prompter|gnome-keyring|seahorse|polkit|pkexec|exo-|xfce4-appfinder|zenity|xfce4-terminal|xterm|ssh-askpass|gh ' | grep -v grep

  section "Ctrl+Alt+T shortcut and preferred terminal"
  xfconf-query -c xfce4-keyboard-shortcuts -l -v 2>/dev/null | grep -i '<alt>t\b\|<Alt>t '
  cat "$HOME/.config/xfce4/helpers.rc" 2>/dev/null || echo "(no helpers.rc: no preferred applications chosen)"

  section "Recent kernel messages about input devices"
  (journalctl -k -b --no-pager 2>/dev/null || sudo dmesg 2>/dev/null) \
    | grep -iE 'psmouse|synaptics|elan|i2c_hid|i8042|touchpad|serio|input:' | tail -n 30
}

{
  report
  if [ "$MODE" != "check" ]; then
    section "Trying to revive the trackpad"
    id=$(touchpad_id)
    if [ -n "$id" ]; then
      xinput enable "$id" 2>&1 && echo "xinput enable $id: done (in case it had been switched off, e.g. by Fn+F7)"
    fi
    if grep -iE -A6 'N: Name=.*(touchpad|synaptics|elan|glidepoint)' /proc/bus/input/devices | grep -q 'serio'; then
      echo "PS/2 touchpad: reloading psmouse"
      sudo modprobe -r psmouse && sudo modprobe psmouse && echo "psmouse reloaded"
    elif lsmod | grep -q '^i2c_hid_acpi'; then
      echo "I2C touchpad: reloading i2c_hid_acpi"
      sudo modprobe -r i2c_hid_acpi && sudo modprobe i2c_hid_acpi && echo "i2c_hid_acpi reloaded"
    else
      echo "Touchpad driver not recognised; nothing reloaded."
    fi
    sleep 3
    section "After the revive attempt"
    xinput list 2>&1 | grep -iE 'touchpad|synaptics|elan|glidepoint'
  fi
} 2>&1 | tee "$REPORT"

echo
echo "Saved to $REPORT"
if rclone listremotes 2>/dev/null | grep -q '^gdrive:'; then
  rclone copy "$REPORT" gdrive:rowing-backups/diagnostics && echo "Copied to Google Drive (rowing-backups/diagnostics)."
fi
[ "$MODE" != "check" ] && echo "Does the trackpad work now? Remember the answer for the report."
