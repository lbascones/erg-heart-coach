#!/usr/bin/env bash
# Updates the app on the laptop to the latest version on GitHub and restarts the server.
#
#   bash ~/erg-heart-coach/scripts/update.sh
#
# Your sessions, settings and backups are not touched.

set -e
cd "$HOME/erg-heart-coach"

echo "== Downloading the latest version"
git pull

echo "== Installing and building"
npm install --no-fund --no-audit
npm run build

echo "== Restarting the app server"
systemctl --user restart rowing
sleep 2
echo "Service: $(systemctl --user is-active rowing)"

echo
echo "Updated to: $(git log -1 --format='%h %s')"
echo "Now reload the app: press F5 in Chrome, or restart the laptop."
