#!/bin/sh
# Starts the hosted DAO dashboard: the gateway, which runs this DAO's agent servers beside it.
# The volume holds all state in /data/state; the app stays in /app. Nothing here ever overwrites state.
set -eu
umask 077
APP=${APP_DIR:-/app}
DATA=${DATA_DIR:-/data}
STATE=$DATA/state

# First boot only: move the treasury agent's state in, from a gzipped tar of its state files whose
# SHA-256 must match RESTORE_SHA256. Existing state is never replaced; delete the archive variable after.
if [ ! -d "$STATE" ] && [ -n "${RESTORE_ARCHIVE:-}" ]; then
  : "${RESTORE_SHA256:?RESTORE_SHA256 is required with RESTORE_ARCHIVE}"
  printf %s "$RESTORE_ARCHIVE" | base64 -d > "$DATA/restore.tgz"
  echo "$RESTORE_SHA256  $DATA/restore.tgz" | sha256sum -c -
  mkdir -p "$DATA/restoring"
  tar -xzf "$DATA/restore.tgz" -C "$DATA/restoring"
  mv "$DATA/restoring" "$STATE"
  rm -f "$DATA/restore.tgz"
  echo "Restored state from the archive"
fi
mkdir -p "$STATE"

# Each agent's settings file (its id and grant token) is written once from a secret variable, then
# owned by the volume: grants rotated later are saved there and must not be replaced on restart.
write_once() {
  if [ ! -f "$STATE/$1" ] && [ -n "$2" ]; then
    printf %s "$2" | base64 -d > "$STATE/$1"
    echo "Wrote $1 from its variable"
  fi
}
write_once .env.dao "${DAO_ENV:-}"
write_once .env.payout "${PAYOUT_ENV:-}"

cd "$STATE"
exec "$APP/node_modules/.bin/tsx" "$APP/src/gateway/server.ts"
