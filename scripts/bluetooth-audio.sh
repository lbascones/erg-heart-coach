#!/usr/bin/env bash
# Bluetooth speaker + Spotify helper for the laptop.
#
#   bash ~/erg-heart-coach/scripts/bluetooth-audio.sh          # record what's there (Bluetooth, sound outputs, Spotify)
#   bash ~/erg-heart-coach/scripts/bluetooth-audio.sh setup    # install Bluetooth audio support, a volume mixer and Spotify
#   bash ~/erg-heart-coach/scripts/bluetooth-audio.sh pair     # pair the speaker (put it in pairing mode first)
#   bash ~/erg-heart-coach/scripts/bluetooth-audio.sh connect  # reconnect the paired speaker and send all sound to it
#
# The report goes to ~/rowing-backups/diagnostics/bluetooth-<date>-<time>.txt (reaches Google Drive with the backups).

set -u
MODE="${1:-check}"
case "$MODE" in check|setup|pair|connect) ;; *) echo "Unknown mode '$MODE'. Use: check, setup, pair or connect."; exit 1 ;; esac
SPEAKER_NAME_RE='uboom|earfun'
OUT_DIR="$HOME/rowing-backups/diagnostics"
mkdir -p "$OUT_DIR"
REPORT="$OUT_DIR/bluetooth-$(date +%Y-%m-%d-%H%M%S)-$MODE.txt"

section() { printf '\n== %s\n' "$1"; }
uses_pipewire() { pactl info 2>/dev/null | grep -qi 'pipewire'; }

# MAC address of the speaker among known devices.
speaker_mac() { bluetoothctl devices 2>/dev/null | grep -iE "$SPEAKER_NAME_RE" | head -n1 | awk '{print $2}'; }

# Send all sound to the Bluetooth speaker (and move anything already playing).
use_speaker_output() {
  local sink=""
  for _ in $(seq 1 15); do
    sink=$(pactl list short sinks 2>/dev/null | awk '/bluez/ {print $2; exit}')
    [ -n "$sink" ] && break
    sleep 1
  done
  if [ -z "$sink" ]; then
    echo "The speaker is connected but no Bluetooth sound output showed up. Run 'setup', restart, then 'connect'."
    return 1
  fi
  pactl set-default-sink "$sink"
  pactl list short sink-inputs 2>/dev/null | awk '{print $1}' | while read -r id; do pactl move-sink-input "$id" "$sink"; done
  echo "Sound now goes to: $sink"
}

report() {
  echo "Bluetooth audio report ($MODE), $(date '+%Y-%m-%d %H:%M:%S')"

  section "Bluetooth hardware"
  lsusb 2>/dev/null | grep -iE 'bluetooth|atheros|qualcomm|broadcom|intel|realtek' || echo "(nothing obvious on USB)"
  rfkill list 2>&1

  section "Kernel messages about Bluetooth (driver and firmware)"
  (journalctl -k -b --no-pager 2>/dev/null || sudo dmesg 2>/dev/null) | grep -iE 'bluetooth|btusb|ath3k|hci' | tail -n 25

  section "Bluetooth service and adapter"
  systemctl is-active bluetooth 2>&1
  bluetoothctl show 2>&1 | grep -E 'Controller|Name|Powered|Pairable|Discoverable|PowerState' || echo "(no adapter found)"

  section "Fresh 15-second search (names of everything in range)"
  bluetoothctl power on 2>&1
  bluetoothctl --timeout 15 scan on 2>&1 | grep -E 'NEW|CHG.*Name' | head -n 40

  section "Known Bluetooth devices"
  bluetoothctl devices 2>&1
  local mac; mac=$(speaker_mac)
  [ -n "$mac" ] && bluetoothctl info "$mac" 2>&1 | grep -E 'Name|Paired|Trusted|Connected'

  section "Sound server"
  pactl info 2>&1 | grep -E 'Server Name|Default Sink'
  dpkg -l libspa-0.2-bluetooth pulseaudio-module-bluetooth blueman pavucontrol 2>/dev/null | awk '/^ii/ {print $2, $3}'

  section "Sound outputs"
  pactl list short sinks 2>&1

  section "Spotify"
  if command -v spotify >/dev/null 2>&1 || snap list spotify >/dev/null 2>&1; then echo "installed"; else echo "not installed"; fi
}

case "$MODE" in
  setup)
    echo "Installing Bluetooth audio support, Blueman (Bluetooth settings), PulseAudio Volume Control and Spotify."
    sudo apt-get update -qq
    if uses_pipewire; then pkg=libspa-0.2-bluetooth; else pkg=pulseaudio-module-bluetooth; fi
    sudo apt-get install -y bluez blueman pavucontrol "$pkg"
    sudo rfkill unblock bluetooth
    sudo systemctl enable --now bluetooth
    if ! snap list spotify >/dev/null 2>&1 && ! command -v spotify >/dev/null 2>&1; then sudo snap install spotify; fi
    if uses_pipewire; then systemctl --user restart wireplumber pipewire pipewire-pulse 2>/dev/null; else pulseaudio -k 2>/dev/null; fi
    echo
    echo "Done. Next: put the speaker in pairing mode and run:  bash ~/erg-heart-coach/scripts/bluetooth-audio.sh pair"
    ;;
  pair)
    echo "Make sure the speaker is in pairing mode (Bluetooth light flashing). Searching for 20 seconds..."
    bluetoothctl power on >/dev/null
    bluetoothctl --timeout 20 scan on >/dev/null 2>&1
    mac=$(speaker_mac)
    if [ -z "$mac" ]; then
      echo "Didn't find a speaker named UBoom/EarFun. Devices seen:"
      bluetoothctl devices
      echo "Put it in pairing mode and try again, or pair it from Settings > Bluetooth Manager."
    else
      echo "Found $(bluetoothctl devices | grep "$mac")"
      bluetoothctl pair "$mac"
      bluetoothctl trust "$mac"   # trusted = it reconnects by itself when switched on
      bluetoothctl connect "$mac" && use_speaker_output
    fi
    ;;
  connect)
    mac=$(speaker_mac)
    if [ -z "$mac" ]; then echo "No paired speaker yet. Run 'pair' first."; exit 1; fi
    bluetoothctl power on >/dev/null
    bluetoothctl connect "$mac" && use_speaker_output
    ;;
esac

report 2>&1 | tee "$REPORT"
echo
echo "Report saved to $REPORT"
REMOTE=$(rclone listremotes 2>/dev/null | grep -m1 '^gdrive:' || rclone listremotes 2>/dev/null | head -n1)
if [ -n "$REMOTE" ]; then
  rclone copy "$REPORT" "${REMOTE}rowing-backups/diagnostics" && echo "Copied to Google Drive (rowing-backups/diagnostics)."
fi
