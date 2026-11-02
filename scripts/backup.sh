#!/usr/bin/env bash
set -euo pipefail
src=${CUSTOMER_DB_FILE:-/var/lib/usam-language/customers.json}
out=${1:-/var/backups/usam-language}
install -d -m 700 "$out"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
cp --preserve=mode "$src" "$out/customers-$stamp.json"
sha256sum "$out/customers-$stamp.json" > "$out/customers-$stamp.sha256"
find "$out" -name 'customers-*.json' -mtime +30 -delete
find "$out" -name 'customers-*.sha256' -mtime +30 -delete
