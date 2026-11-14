# Erg Heart Coach

A heart-rate-first display for a Concept2 rower with a **PM3 or PM4** monitor. It runs in Chrome/Chromium,
talks to the monitor over USB (WebHID) through [ErgometerJS](https://github.com/tijmenvangulik/ErgometerJS),
and gets heart rate from the strap paired to the monitor.

> **Not a medical device.** Heart-rate limits come from you (ideally from your doctor). The app is a
> helper, not a substitute for listening to your body: stop if you feel dizzy, short of breath or chest discomfort.

## Run it (development)

```sh
npm install        # also copies ergometer.js into public/lib/
npm run dev        # open http://localhost:5173
```

- **Use simulator** fakes a rower and heart rate. Keys: `↑/↓` effort, `Space` stop/row, `H` drop HR signal.
  Opening `http://localhost:5173/?sim` starts the simulator directly.
- **Connect monitor (USB)** shows Chrome's USB picker. After the first time, the app reconnects by itself.

## What it does

- Big heart-rate number; the whole screen is tinted by zone (blue easy, green target, amber above, red over the limit).
- **Over-limit alarm:** flashing red, banner and repeating beeps until HR is 3 bpm below the ceiling.
- **No-signal alarm:** if no valid HR arrives for 5 s, it shows `--` and warns. It never shows a stale number.
  (ErgometerJS only refreshes HR when the stroke phase changes; we poll it every second so it keeps updating when you stop.)
- Session flow: standby → warm-up → workout → cool-down → 60 s recovery check → summary (time in zones, HR drop in 60 s).
  **Standby:** press Start at the laptop (no heart rate needed: the strap may be out of the receiver's range there),
  then get on the rower. A blue "Waiting for heart-rate signal" banner shows until the strap is picked up; the session
  begins with your first stroke. The no-signal alarm stays quiet until you row; **Start now** starts the clock without rowing.
- Before a session, the second row shows the monitor's own distance, time and calories; during a session, the session's.
- **Cancel session** (any time during a session) discards it: nothing is saved and the plan is unchanged, so today's
  session can still be done later.
- Pace, watts, stroke rate, distance, time and calories, plus a live force curve with the last few strokes for comparison.
- Settings (birth date, max HR, target zone, ceiling, warm-up/cool-down length) and session history are kept in the browser.
  Age is worked out from the birth date. Limits filled in from the age estimate move to the new age's estimate on your
  birthday (with a note on the home screen); limits you typed in yourself, e.g. from your doctor, are never changed.

## Virtual trainer

The home screen tells you whether today is a rowing day and for how long.

- **Levels 1–12:** from 3×10 min a week to 5×30 min (plus warm-up and cool-down). Intensity never rises:
  you always row in your own heart-rate zone; only time and frequency grow.
- **After each session** you rate how hard it felt (1–10) and report any symptoms.
  - 3 good sessions (≥90% of planned time, felt ≤6/10, under 30 s over the ceiling) → next level.
  - Felt ≥8/10 or over 2 min above the ceiling → step back a level. Two cut-short sessions in a row → step back.
  - Symptoms → the plan pauses until you confirm a doctor has cleared you.
- **Rest days:** at 3 sessions a week there is always a rest day between sessions; never more than the level's sessions in any 7 days.
- **Time off (e.g. vacation)** is detected from the date of your last session, even if the app was left running:
  8+ days → back 1 level, 14+ → 2, 21+ → 3, 28+ → 4 (plus a fitness check soon after), 60+ → level 1.
- **Fitness check** every 4 weeks: 10 min holding the same test heart rate; the last 5 min are scored.
  More watts at the same heart rate = fitter. Keep the damper setting the same every time.
- **Progress screen:** fitness-check results, watts in your zone, heart-rate drop 60 s after stopping,
  minutes per week vs. your level's goal. **Export data** regularly: history lives in the browser.

### Phone reminders (ntfy)

Install the free ntfy app, subscribe to a hard-to-guess topic (e.g. `row-k7f2q9`), and enter it in Settings.
After each session (and whenever the app starts) the next rowing day's reminder is scheduled on the ntfy server,
so it arrives even while the laptop is off. ntfy.sh holds messages up to 3 days ahead.
Reminder text is generic (no name or health data), but it does pass through the ntfy server.

## Code map

| File | Purpose |
|---|---|
| `src/sources/pm4.ts` | Real monitor (PM3/PM4) over USB: connect, auto-reconnect, data, force curve, HR polling |
| `src/sources/simulator.ts` | Fake rower and heart-rate model |
| `src/heartrate.ts` | Zone logic, signal-loss detection, alarm latching |
| `src/alarm.ts` | Sound cues (Web Audio, no files) |
| `src/session.ts` | Phases, time in zone, summary, saved history |
| `src/trainer.ts` | Levels, scheduling, progression and time-off rules, fitness checks |
| `src/progress.ts` | Progress screen charts and tiles |
| `src/notify.ts` | Scheduled phone reminders through ntfy |
| `src/backup.ts` | Export, import, automatic backup and restore |
| `src/diagnostics.ts` | Diagnostics recorder (raw USB traffic, events, errors) |
| `server.js`, `server/backup.js` | Laptop server: serves the app, writes backups and diagnostics, runs the Drive sync |
| `src/charts.ts` | HR trend and force curve drawing |
| `src/main.ts` | Wires everything to the screen |

## The laptop (Acer Aspire V5-572P)

**Hardware:** 15.6" 1366×768 10-point touchscreen (the size the app's layout was designed for), Intel Core i3-3227U or
i5-3337U, 4 GB RAM (enough; a memory upgrade is optional), one 2.5" SATA drive bay, internal battery, HDMI out.

### Status (2026-11-12)

- **The drive is dead.** The startup screen showed `PXE-E61 … No bootable device`, both in Legacy and UEFI mode.
  The setup screen (F2 → Information) lists the drive as **"SATAFIRM S11"**: the name an SSD with a failed controller
  reports. It can't be repaired, and nothing on it needs rescuing (Proxmox now runs on another machine).
- **Setup screen (BIOS):** Boot Mode changed from Legacy to **UEFI**. Leave it on UEFI.
- **Live-USB test passed** (Xubuntu running from a USB stick): screen, touchscreen, Wi-Fi, sound and charging all work.
- **Not checked yet:** the PM4 over USB (the rower is in the basement). Check it during app setup:
  `lsusb | grep -i 17a4` should show `17a4:0001` (PM3) or `17a4:0002` (PM4), and `ls /dev/hidraw*` should list a device.

### The replacement drive

The whole system needs about 15 GB, and the app's data is small and backed up to Google Drive, so a cheap drive is fine.
From best to acceptable:

1. **Internal 2.5" SATA SSD, 120–128 GB**, used or new. Get a 7 mm drive: the dead one was an SSD, so a standard
   7 mm SSD fits. Brands that name their parts, e.g. Crucial MX500/BX500, Samsung 870 EVO, WD Blue SA510.
2. **Any spare 2.5" laptop drive** (SSD or hard disk). It must be 7 mm thick; a 9.5 mm drive may not fit.
   A hard disk starts up slower but runs the app just as well.
3. **A good USB 3 stick, 64 GB+**, if internal drives cost too much. Slower and wears out sooner; use the USB 3 port.

The old, slow pendrive stays the **installer** only. Don't install onto it.

**Fitting an internal drive:** unplug the charger, remove the **17 Phillips #0 screws** on the bottom, prise the cover
off with a plastic tool, **disconnect the battery connector first**, then lift the old drive out of its brackets (no
screws) and drop the new one in. Guides: [bottom cover](https://ifixit.com/Guide/Acer+Aspire+V5-572+Bottom+Cover+Replacement/33900),
[drive](https://www.ifixit.com/Guide/Acer+Aspire+V5-572+V5-572G+HDD+Replacement/33903).

### Installing Xubuntu

- Use the **current LTS** release. The **minimal** install is enough: the laptop only runs the rowing app.
  (For the live-USB test the regular desktop version was used, because it includes Firefox for testing.)
- Boot the installer with **F12** (if F12 does nothing: F2 → Main → turn on **F12 Boot Menu**, save with F10).
- Choose **Erase disk and install** on the new drive, and turn on **automatic login**, so the laptop goes
  straight to the app instead of a password screen.
- The minimal install has no browser: the setup below installs Google Chrome (not the Chromium snap, whose sandbox
  can block USB access).

### Placing it at the rower

Don't mount the laptop on the rower: it's too heavy for the monitor arm, would hide the PM4, and the arm moves.

- **Recommended:** a height-adjustable **rolling laptop/projector stand** just beyond the front of the rower, clear of
  the handle and chain. Screen at your seated eye level, tilted toward you, 1.5–2 m from the seat.
- **Alternatives:** a wall shelf or laptop tray if the rower faces a wall; or a **TV over HDMI** for a bigger screen,
  with the laptop on a shelf. The layout would need checking at TV resolution, since it was built for 1366×768.
- **PM4 cable:** USB-A to USB-B (the printer-cable type) into the back of the monitor. Get a **3 m** one, run it along
  the arm with slack, and fix it with Velcro straps. Keep the power cord clear of the flywheel and seat rail.
- You only tap the screen to start and to rate a session, never mid-row. A **cheap wireless mouse** by the rower saves
  getting up.
- **Spare 24" monitor:** plug it into the laptop's HDMI port for a bigger screen (lid closed with a wireless mouse,
  or lid open beside the rower for touch). The laptop speakers carry the alarms. Scale the layout to 1920×1080 at setup.
  (A Raspberry Pi 1 can't run the app: too slow, and current Chromium/Node.js don't support it.)
- Still to decide: which way the rower faces (wall, open room, TV?) and whether it's a Model D or E.

## Setting up the laptop

1. **Software.** Google Chrome is used instead of Chromium: Ubuntu only ships Chromium as a snap, whose sandbox can
   block USB access. The minimal Xubuntu has no browser and may lack font settings.
   ```sh
   sudo apt update && sudo apt upgrade -y
   sudo apt install -y git curl wget nodejs npm
   sudo apt install --reinstall -y fontconfig fontconfig-config fonts-dejavu-core && fc-cache -f
   wget -P /tmp https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
   sudo apt install -y /tmp/google-chrome-stable_current_amd64.deb
   node -v   # must be v20 or newer
   ```
   If `apt` can't find `nodejs`, enable the universe source first: `sudo add-apt-repository universe && sudo apt update`.
2. **Get the code and build it.** For a private repo, sign in first: `sudo apt install -y gh`, `gh auth login`
   (GitHub.com, HTTPS, yes, log in with a web browser; Google sign-in works there), then `gh auth setup-git`.
   ```sh
   git clone https://github.com/lbascones/erg-heart-coach.git ~/erg-heart-coach
   cd ~/erg-heart-coach && npm install && npm run build
   ```
   To update later, see [Updating the app](#updating-the-app).
   Quick test without the steps below: `node server.js` in one terminal (leave it open), then open
   http://localhost:4173/?sim in Chrome.
3. **Let the browser open the PM4 without root:**
   ```sh
   echo 'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="17a4", MODE="0660", TAG+="uaccess"' | sudo tee /etc/udev/rules.d/50-concept2.rules
   sudo udevadm control --reload && sudo udevadm trigger
   ```
   then replug the PM4.
4. **Pre-approve the PM4** so Chrome never shows a USB picker:
   ```sh
   sudo mkdir -p /etc/opt/chrome/policies/managed
   echo '{ "WebHidAllowDevicesForUrls": [ { "devices": [ { "vendor_id": 6052 } ], "urls": [ "http://localhost:4173" ] } ] }' | sudo tee /etc/opt/chrome/policies/managed/rowing.json
   ```
   Check it at `chrome://policy` in Chrome.
5. **Run the app server at startup.** It serves the app on http://localhost:4173 and saves backups to
   `~/rowing-backups`.
   ```sh
   mkdir -p ~/.config/systemd/user
   cat > ~/.config/systemd/user/rowing.service <<'EOF'
   [Unit]
   Description=Erg Heart Coach server

   [Service]
   WorkingDirectory=%h/erg-heart-coach
   ExecStart=/usr/bin/node server.js
   # Copy backups to Google Drive after each save (see "Google Drive backups" below). Add once rclone is set up.
   # Keep the quotes: without them systemd cuts the value at the first space.
   #Environment="ROWING_AFTER_BACKUP=rclone copy %h/rowing-backups gdrive:rowing-backups"
   Restart=always

   [Install]
   WantedBy=default.target
   EOF
   systemctl --user daemon-reload
   systemctl --user enable --now rowing
   systemctl --user status rowing   # should say "active (running)"
   ```
6. **Open the app full-screen at login.** It waits until the server answers, then starts Chrome in kiosk mode.
   `--autoplay-policy` lets alarms sound before anyone touches the screen. Exit kiosk mode with **Alt+F4**.
   ```sh
   mkdir -p ~/.config/autostart
   cat > ~/.config/autostart/erg-heart-coach.desktop <<'EOF'
   [Desktop Entry]
   Type=Application
   Name=Erg Heart Coach
   Exec=sh -c 'until curl -s -o /dev/null http://localhost:4173; do sleep 1; done; exec google-chrome --kiosk --password-store=basic --no-first-run --noerrdialogs --disable-session-crashed-bubble --autoplay-policy=no-user-gesture-required http://localhost:4173'
   EOF
   ```
7. **Keep the screen on.** Settings → Power Manager → Display: set blanking and sleep to **Never** when plugged in.
   On the Security tab, turn off automatic screen locking. Under General, set the power button to **Shutdown**.
8. Turn on automatic login if it wasn't chosen during install, then restart. The app should open by itself.

**After a session:** save your rating in the summary (that saves the session and makes the backup), then press the
power button briefly to shut down cleanly. Don't hold the button down.

## Updating the app

When the code on GitHub changes (for example after a fix), bring the laptop up to date:

1. Exit kiosk mode with **Alt+F4**, then open a terminal (Ctrl+Alt+T).
2. Download, build and restart:
   ```sh
   bash ~/erg-heart-coach/scripts/update.sh
   ```
   (It runs `git pull`, `npm install`, `npm run build` and `systemctl --user restart rowing`.)
   If the `rowing` service isn't set up yet (step 5 of the setup), start the server by hand instead:
   `node server.js` in a terminal that stays open.
3. Press F5 in Chrome or restart the laptop. The new version loads.

`git pull` only fetches; your sessions, settings and backups are stored elsewhere and are never touched.
If `git pull` asks for a login, the repo has been made private again: see step 2 of the setup.

## Diagnostics

When something doesn't work with the monitor (no data, dropouts, odd numbers), record a diagnostics file:

1. Open **Settings → Diagnostics** (or **Diagnostics** on the connect screen) and tap **Start recording**.
   A red **● Recording** button stays in the top bar while it runs.
2. Reproduce the problem: for example row a few strokes, or tap **Reconnect monitor** to capture the whole
   connection sequence. To capture start-up too, open the app as http://localhost:4173/?diag.
3. Tap **● Recording → Stop and save**. The file is written to
   `~/rowing-backups/diagnostics/diag-YYYY-MM-DD-HHMMSS.json` and copied to Google Drive
   (`rowing-backups/diagnostics`) right away, if rclone is set up. If the server can't take it (for example
   it wasn't restarted after an update), the message says why and Chrome saves the file to `~/Downloads` instead.

The file holds the monitor's raw USB traffic, connection and stroke events, the heart rate and rowing data the app
received, error messages, the USB device details (model, report sizes) and the app version. It doesn't hold your
settings or session history. Recording stops if the page reloads or the laptop shuts down, and anything not yet
saved is lost.

## Backups

- **Automatic, on the laptop:** after every session (and when settings change) the app sends all its data to the
  local server, which writes `~/rowing-backups/rowing-latest.json` plus one dated copy per day
  (`rowing-2026-11-12.json`, …). Files are written atomically, so a power cut can't leave a broken backup.
- **Automatic restore:** if the browser's data is ever wiped, the app finds the latest backup at start-up and offers to restore it.
- **Manual:** Export / Import buttons on the progress screen. Use Import to move data from another computer.
- The server only listens on the laptop itself (127.0.0.1) and only accepts backups from the app's own page.

### Google Drive backups (rclone)

1. Install rclone: `sudo apt install rclone`.
2. Run `rclone config` and create a remote:
   - `n` (new remote), name it `gdrive`, storage type **Google Drive**;
   - leave client id and secret empty;
   - scope: choose **drive.file** (rclone can only see files it creates, not the rest of your Drive);
   - accept the defaults for the rest, then sign in to Google in the browser window it opens.
3. Test it: `rclone copy ~/rowing-backups gdrive:rowing-backups`. A `rowing-backups` folder appears in your Drive.
4. Turn on the automatic copy: in `~/.config/systemd/user/rowing.service`, remove the `#` in front of the
   `Environment="ROWING_AFTER_BACKUP=..."` line (keep the quotes), then
   `systemctl --user daemon-reload && systemctl --user restart rowing`.
   To check it, save Settings once, then `journalctl --user -u rowing -n 5` should say
   `after-backup command finished`.
   If your service file has that line **without** the quotes (an earlier version of this README),
   `bash ~/erg-heart-coach/scripts/fix-drive-copy.sh` fixes it, copies what's missing, and checks the automatic copy.
5. From then on, new backups and diagnostics files are copied after every save. If the internet
   is down at that moment, the next session's copy catches up (rclone copies everything that's missing).
   It uses `copy`, not `sync`, so deleting files on the laptop never deletes them from Drive.
