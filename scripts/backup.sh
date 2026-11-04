#!/usr/bin/env bash
# PostgreSQL backup for USAM Language.
#
#   DATABASE_URL=postgres://user:pass@host:5432/usam scripts/backup.sh [OUT_DIR]
#
# Writes a pg_dump custom-format archive + SHA-256 checksum, validates the archive is readable before keeping it,
# prunes local archives older than BACKUP_RETENTION_DAYS (default 30), and optionally copies both files off-site to
# BACKUP_S3_URI (e.g. s3://bucket/usam-language) with server-side encryption.
#
# NOT in the database, back these up separately (secret manager): AUDIT_HMAC_KEY (+ AUDIT_HMAC_PREVIOUS_KEYS) and
# ADMIN_MFA_KEY. Without them a restored database cannot verify its audit chain or decrypt admin MFA secrets.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL must be set}"
out=${1:-${BACKUP_DIR:-/var/backups/usam-language}}
keep=${BACKUP_RETENTION_DAYS:-30}
umask 077
mkdir -p "$out"
chmod 700 "$out"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
name="usam-$stamp.dump"
file="$out/$name"

pg_dump --format=custom --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$file.partial"
pg_restore --list "$file.partial" > /dev/null   # refuse to keep an unreadable/truncated archive
mv "$file.partial" "$file"
(cd "$out" && sha256sum "$name" > "$name.sha256")

if [ -n "${BACKUP_S3_URI:-}" ]; then
  aws s3 cp "$file" "$BACKUP_S3_URI/$name" --sse AES256 --only-show-errors
  aws s3 cp "$file.sha256" "$BACKUP_S3_URI/$name.sha256" --sse AES256 --only-show-errors
fi

find "$out" -name 'usam-*.dump' -mtime +"$keep" -delete
find "$out" -name 'usam-*.dump.sha256' -mtime +"$keep" -delete
echo "$file"
