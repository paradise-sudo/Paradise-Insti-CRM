#!/usr/bin/env bash
#
# One command: pull, deploy, and run every pending data fix.
#
#   ./ship.sh              deploy + report what the fixes WOULD do
#   ./ship.sh --apply      deploy + actually run them
#
# Written because switching between the browser and Cloud Shell drops the
# session, so the whole job needs to survive one paste.
#
# set -e stops at the first failure. That matters: the reason a deploy once
# went out against stale code was a `git pull` that failed while the command
# after it ran anyway.
set -euo pipefail

APPLY=""
[ "${1:-}" = "--apply" ] && APPLY="--apply"

cd "$(dirname "$0")"

step () { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

step "1/5  Pulling"
git pull --ff-only

step "2/5  Deploying hosting, functions and rules"
firebase deploy --only hosting,functions,firestore:rules --force

cd seed
node -e "require.resolve('firebase-admin')" 2>/dev/null \
  || { step "Installing firebase-admin"; npm install firebase-admin --no-fund --no-audit; }

step "3/5  Stale targets and users"
node cleanup.js $APPLY

step "4/5  Phantom stage-history rows"
node cleanup.js --only=stageHistory $APPLY

step "5/5  Dates stored in UTC"
node fixdates.js $APPLY

if [ -z "$APPLY" ]; then
  printf '\n\033[1mThat was a dry run. Nothing was changed.\033[0m\n'
  printf 'Read the three reports above, then run:  ./ship.sh --apply\n'
else
  printf '\n\033[1mDone.\033[0m\n'
  printf 'Check: Dashboard, range "Last month" -> target Rs 67.1L, net Rs 38.5L, 57%%.\n'
  printf 'If the target reads about double, step 3 did not run.\n'
fi
