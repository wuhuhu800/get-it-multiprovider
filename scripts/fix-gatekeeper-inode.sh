#!/usr/bin/env bash
#
# fix-gatekeeper-inode.sh — make a correctly-signed .app launch again
#
# The problem this solves
# -----------------------
# You sign the app, `codesign --verify --deep --strict` passes, `spctl -a`
# says "accepted" — and double-clicking still shows
#
#     "Get It" will damage your computer. You should move it to the Trash.
#
# The reason is that syspolicyd caches its exec decision per *filesystem
# object*, keyed by the directory inode. You can see it in the log:
#
#     GK evaluateScanResult: 2 ... objid: 31437523
#     $ stat -f "%i" "/Applications/Get It BYOK.app"
#     31437523
#
# Once that inode has a rejection recorded, re-signing, changing the bundle id
# or stripping xattrs will NOT trigger a re-evaluation — the decision is
# returned from cache before the policy layer is even consulted. That is why
# `spctl -a` can report "accepted" while the launch still fails.
#
# The fix is to change the inode: copy the bundle with `ditto`, which creates
# new filesystem objects. Renaming afterwards is safe, because the cache is
# bound to the inode, not the path.
#
# Usage
# -----
#     scripts/fix-gatekeeper-inode.sh "/Applications/Get It BYOK.app"
#     scripts/fix-gatekeeper-inode.sh "/Applications/Get It BYOK.app" --yes
#
# Requires sudo for the xattr / spctl steps. Nothing global is changed:
# Gatekeeper stays enabled. (`spctl --global-disable` is deliberately not used:
# it weakens every app on the machine and macOS has been observed to re-enable
# it on its own.)
#
set -u

APP="${1:-}"
ASSUME_YES=0
[ "${2:-}" = "--yes" ] && ASSUME_YES=1

if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  echo "usage: $0 \"/path/to/App.app\" [--yes]" >&2
  [ -n "$APP" ] && echo "       not a directory: $APP" >&2
  exit 1
fi

APP="${APP%/}"
DIR="$(dirname "$APP")"
BASE="$(basename "$APP" .app)"
NEW="$DIR/$BASE (new).app"
LREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

echo "=================================================="
echo "  Gatekeeper inode-cache repair"
echo "  target: $APP"
echo "  theory: syspolicyd caches the rejection per directory inode,"
echo "          so a new inode means a fresh evaluation."
echo "=================================================="
echo

echo "---------- diagnosis before repair ----------"
printf "version        : "; /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist" 2>/dev/null || echo "unknown"
printf "directory inode: "; stat -f "%i" "$APP" 2>/dev/null || echo "unreadable"
printf "authority      : "; codesign -dv "$APP" 2>&1 | sed -n 's/^Authority=//p' | head -1
printf "codesign       : "; if codesign --verify --deep --strict "$APP" 2>/dev/null; then echo "valid"; else echo "INVALID (re-sign first: scripts/resign-app.py)"; fi
printf "quarantine     : "; if xattr "$APP" 2>/dev/null | grep -q "com.apple.quarantine"; then echo "present"; else echo "absent"; fi
printf "gatekeeper     : "; spctl --status 2>&1
printf "assessment     : "; spctl -a -vvv --type execute "$APP" 2>&1 | head -1
echo

if [ "$ASSUME_YES" -ne 1 ]; then
  printf "continue? [y/N] "
  read -r reply
  case "$reply" in [yY]*) ;; *) echo "aborted"; exit 0 ;; esac
  echo
fi

echo "---------- 1. stop leftover processes ----------"
pkill -f "$(basename "$APP")/Contents/MacOS" 2>/dev/null && echo "stopped" || echo "none running"
sleep 1
echo

echo "---------- 2. strip quarantine ----------"
sudo xattr -cr "$APP" && echo "done"
echo

echo "---------- 3. re-register with LaunchServices ----------"
"$LREG" -f "$APP" 2>&1 && echo "done" || echo "skipped"
echo

echo "---------- 4. add a Gatekeeper allow rule (best effort) ----------"
# spctl --add exists on macOS 12 and earlier; on newer releases it may be
# rejected or removed. Failure here is not fatal — step 5 is what actually
# fixes the launch, this only makes the first double-click quieter.
if sudo spctl --add --path "$APP" 2>&1; then
  echo "rule written"
else
  echo "spctl --add unavailable on this macOS version; continuing"
fi
printf "assessment     : "; spctl -a -vvv --type execute "$APP" 2>&1 | head -1
echo

echo "---------- 5. copy to a fresh inode and launch ----------"
echo "This is the step that matters: ditto creates new filesystem objects,"
echo "so syspolicyd has no cached rejection for them."
echo

if [ -d "$NEW" ]; then
  echo "removing previous copy..."
  rm -rf "$NEW"
fi

echo "copying (a 2 GB bundle takes 1-3 minutes)..."
ditto "$APP" "$NEW" || { echo "copy failed"; exit 1; }

printf "new inode      : "; stat -f "%i" "$NEW"
printf "new assessment : "; spctl -a -vvv --type execute "$NEW" 2>&1 | head -1
echo

echo "launching the new copy..."
open -a "$NEW" 2>&1
sleep 6

if pgrep -f "$BASE (new).app/Contents/MacOS" >/dev/null 2>&1; then
  echo
  echo "=================================================="
  echo "  launched successfully"
  echo "=================================================="
  echo "use this bundle from now on:"
  echo "  $NEW"
  echo "once it has run reliably for a few days, the old one can go:"
  echo "  rm -rf \"$APP\""
else
  echo
  echo "=================================================="
  echo "  the fresh copy did not start either — collect these:"
  echo "=================================================="
  echo "  spctl -a -vvv --type execute \"$NEW\""
  echo "  codesign --verify --deep --strict --verbose=4 \"$NEW\""
  echo "  log show --last 2m --predicate 'process == \"syspolicyd\"' | tail -40"
  echo
  echo "a consistent 'rejected' points at a signing problem, not the cache:"
  echo "  python3 scripts/resign-app.py \"$NEW\""
fi

echo
echo "Gatekeeper itself was never disabled; it is still: $(spctl --status 2>&1)"
echo "=================================================="
