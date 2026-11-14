#!/usr/bin/env bash
# Trackpad helper for the laptop.
#
#   bash ~/erg-heart-coach/scripts/touchpad.sh          # record what's going on, then try to revive the trackpad
#   bash ~/erg-heart-coach/scripts/touchpad.sh check    # only record (run once while it works, as a baseline)
#   bash ~/erg-heart-coach/scripts/touchpad.sh setup    # tap-to-click on, Ctrl+Alt+T terminal set, steadier touchpad
#                                                       # connection (needs a restart afterwards)
#   bash ~/erg-heart-coach/scripts/touchpad.sh undo     # take back the touchpad connection change (needs a restart)
#
# Run it WHILE the trackpad is frozen (the keyboard still works: Alt+Tab to a terminal you left open).
# The report goes to ~/rowing-backups/diagnostics/touchpad-<date>-<time>.txt, so it reaches Google Drive with the
# backups once the Drive copy is on. sudo will ask for your password for the kernel messages and the driver restart.

set -u
MODE="${1:-fix}"
case "$MODE" in check|fix|setup|undo) ;; *) echo "Unknown mode '$MODE'. Use: check, fix, setup or undo."; exit 1 ;; esac
GRUB=/etc/default/grub
GRUB_BACKUP=/etc/default/grub.before-touchpad
KERNEL_OPT=psmouse.synaptics_intertouch=1
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

  section "Windows actually on screen (including any behind the app)"
  xwininfo -root -tree 2>/dev/null | sed -n 's/^ *\(0x[0-9a-f]*\) \("[^"]*"\).*/\1 \2/p' | grep -v '"(has no name)"' \
    | while read -r wid name; do
        [ "$(xwininfo -id "$wid" 2>/dev/null | sed -n 's/.*Map State: //p')" = IsViewable ] && echo "$wid $name"
      done | head -n 60

  section "Programs that show password or choice dialogs"
  ps -eo pid,etime,args | grep -Ei 'gcr-prompter|gnome-keyring|seahorse|polkit|pkexec|exo-|xfce4-appfinder|zenity|xfce4-terminal|xterm|ssh-askpass|gh ' | grep -v grep

  section "Ctrl+Alt+T shortcut and preferred terminal"
  xfconf-query -c xfce4-keyboard-shortcuts -l -v 2>/dev/null | grep -i 'alt>t '
  cat "$HOME/.config/xfce4/helpers.rc" 2>/dev/null || echo "(no helpers.rc: no preferred applications chosen)"

  section "Kernel settings for this boot"
  cat /proc/cmdline

  section "Recent kernel messages about input devices"
  (journalctl -k -b --no-pager 2>/dev/null || sudo dmesg 2>/dev/null) \
    | grep -iE 'psmouse|synaptics|elan|i2c_hid|i8042|touchpad|serio|rmi4|smbus|input:' | tail -n 30
}

setup() {
  echo "Touchpad setup, $(date '+%Y-%m-%d %H:%M:%S')"

  section "1. Tap to click"
  local id; id=$(touchpad_id)
  [ -n "$id" ] && xinput set-prop "$id" "libinput Tapping Enabled" 1 && echo "   On now."
  # Keep it on after restarts, whatever name the touchpad gets.
  sudo mkdir -p /etc/X11/xorg.conf.d
  printf '%s\n' 'Section "InputClass"' '    Identifier "touchpad tap to click"' '    MatchIsTouchpad "on"' \
    '    Option "Tapping" "on"' 'EndSection' | sudo tee /etc/X11/xorg.conf.d/40-touchpad.conf >/dev/null
  echo "   Kept on after restarts (/etc/X11/xorg.conf.d/40-touchpad.conf)."
  # If Xfce's own settings stored "off", that would win: switch those to on too.
  xfconf-query -c pointers -l 2>/dev/null | grep -i 'Tapping_Enabled$' | while read -r p; do
    xfconf-query -c pointers -p "$p" -s 1 && echo "   Xfce setting $p: on"
  done

  section "2. Terminal for Ctrl+Alt+T (so it never asks which one)"
  local helpers="$HOME/.config/xfce4/helpers.rc" term=xterm
  command -v xfce4-terminal >/dev/null && term=xfce4-terminal
  mkdir -p "$(dirname "$helpers")"
  touch "$helpers"
  sed -i '/^TerminalEmulator=/d' "$helpers"
  echo "TerminalEmulator=$term" >>"$helpers"
  echo "   Set to $term."

  section "3. Steadier touchpad connection (kernel setting, used from the next restart)"
  if grep -q "$KERNEL_OPT" "$GRUB"; then
    echo "   Already set."
  else
    sudo cp "$GRUB" "$GRUB_BACKUP"
    sudo sed -i "s/^GRUB_CMDLINE_LINUX_DEFAULT=\"\(.*\)\"/GRUB_CMDLINE_LINUX_DEFAULT=\"\1 $KERNEL_OPT\"/" "$GRUB"
    if grep -q "$KERNEL_OPT" "$GRUB"; then
      sudo update-grub 2>&1 | tail -n 2
      echo "   Set (the old file is kept as $GRUB_BACKUP)."
    else
      echo "   Could not find GRUB_CMDLINE_LINUX_DEFAULT in $GRUB; nothing changed."
    fi
  fi
  grep '^GRUB_CMDLINE_LINUX_DEFAULT' "$GRUB"
}

undo() {
  echo "Touchpad undo, $(date '+%Y-%m-%d %H:%M:%S')"
  section "Taking back the touchpad connection setting"
  if ! grep -q "$KERNEL_OPT" "$GRUB"; then
    echo "   It is not set; nothing to do."
  else
    sudo sed -i "s/ *$KERNEL_OPT//" "$GRUB"
    sudo update-grub 2>&1 | tail -n 2
    echo "   Removed."
  fi
  grep '^GRUB_CMDLINE_LINUX_DEFAULT' "$GRUB"
}

{
  if [ "$MODE" = setup ]; then setup
  elif [ "$MODE" = undo ]; then undo
  else report
  fi
  if [ "$MODE" = fix ]; then
    section "Trying to revive the trackpad"
    id=$(touchpad_id)
    if [ -n "$id" ]; then
      xinput enable "$id" 2>&1 && echo "xinput enable $id: done (in case it had been switched off, e.g. by Fn+F7)"
    fi
    # psmouse drives the touchpad both over PS/2 (serio) and, with the setup's kernel setting, over SMBus (rmi4).
    if grep -iE -A6 'N: Name=.*(touchpad|synaptics|glidepoint)' /proc/bus/input/devices | grep -qE 'serio|rmi4'; then
      echo "Synaptics touchpad: reloading psmouse"
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
case "$MODE" in
  fix) echo "Does the trackpad work now? Remember the answer for the report." ;;
  setup | undo) echo "Restart the laptop (sudo reboot) to finish, then run:  bash ~/erg-heart-coach/scripts/touchpad.sh check" ;;
esac
