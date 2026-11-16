#!/bin/bash
# Nightly Rupakarsa backup: database dump plus a mirror of the local media directory.
# Installed by deploy/rupakarsa-ci-deploy from the repo; run by rupakarsa-backup.timer.
set -euo pipefail

ENV_FILE=/etc/rupakarsa/api.env
DEST=/var/backups/rupakarsa
MEDIA=/var/lib/rupakarsa/media
KEEP_DUMPS=14

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
install -d -o root -g root -m 750 "$DEST"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

pg_dump --format=custom --no-owner --dbname="${DATABASE_URL:?DATABASE_URL missing}" \
  --file="$DEST/db-$STAMP.dump"
ls -1t "$DEST"/db-*.dump 2>/dev/null | tail -n +"$((KEEP_DUMPS + 1))" | xargs -r rm -f

if [ -n "${BACKUP_TARGET:-}" ]; then
  install -d -o root -g root -m 750 "$BACKUP_TARGET/media"
  rsync -a --delete "$MEDIA/" "$BACKUP_TARGET/media/"
  echo "media mirrored to $BACKUP_TARGET/media"
else
  # Default: keep a local mirror next to the dumps so a single host failure is still recoverable.
  rsync -a --delete "$MEDIA/" "$DEST/media/"
  echo "media mirrored to $DEST/media"
fi

echo "backup complete: $DEST/db-$STAMP.dump"
