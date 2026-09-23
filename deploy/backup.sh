#!/usr/bin/env bash
# Nightly backup of the database and uploaded photos. Run as the sideroad user from cron:
#   15 3 * * * /opt/sideroad/app/deploy/backup.sh
# Copy /var/backups/sideroad somewhere off the server too (e.g. rclone to object storage).
set -euo pipefail
DEST=/var/backups/sideroad
KEEP_DAYS=14
STAMP=$(date +%Y%m%d-%H%M)
mkdir -p "$DEST"
pg_dump --format=custom --dbname=sideroad --file="$DEST/db-$STAMP.dump"
tar -czf "$DEST/uploads-$STAMP.tar.gz" -C /var/lib/sideroad uploads
find "$DEST" -type f -mtime +"$KEEP_DAYS" -delete
