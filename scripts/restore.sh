#!/usr/bin/env bash
# Restore a USAM Language PostgreSQL backup made by scripts/backup.sh.
#
#   RESTORE_CONFIRM=yes TARGET_DATABASE_URL=postgres://user:pass@host:5432/usam_restore scripts/restore.sh /path/usam-XXXX.dump
#
# - Verifies the SHA-256 checksum next to the archive (refuses on mismatch; warns if the checksum file is missing).
# - Replaces the objects in the TARGET database (drops and recreates them) inside ONE transaction: on any error
#   nothing is changed. Requires RESTORE_CONFIRM=yes.
# - Recommended drill: restore into a NEW empty database, point a staging instance at it, sign in, and run
#   "verify audit log" in the admin console (needs the same AUDIT_HMAC_KEY).
set -euo pipefail
file=${1:?usage: scripts/restore.sh BACKUP_FILE}
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL must be set}"
[ -f "$file" ] || { echo "No such backup: $file" >&2; exit 2; }

if [ -f "$file.sha256" ]; then
  (cd "$(dirname "$file")" && sha256sum -c "$(basename "$file").sha256") || { echo "Checksum mismatch: refusing to restore $file" >&2; exit 3; }
else
  echo "WARNING: no checksum file next to $file; continuing without integrity verification" >&2
fi
if [ "${RESTORE_CONFIRM:-}" != "yes" ]; then
  echo "Refusing to restore: this replaces data in the target database. Set RESTORE_CONFIRM=yes to proceed." >&2
  exit 2
fi

pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error --single-transaction --dbname="$TARGET_DATABASE_URL" "$file"
echo "Restored $file"
