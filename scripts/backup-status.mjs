// Writes the small backup status file that the admin console reads (GET /api/admin/backup-status).
// Called by scripts/backup.sh and scripts/restore.sh; not meant to be run by hand.
//   node scripts/backup-status.mjs backup <file name> <size bytes> <sha256>    last backup succeeded
//   node scripts/backup-status.mjs backup-failed                                last attempt failed (lastBackup keeps the last good one)
//   node scripts/backup-status.mjs restore-test ok|failed                       result of a restore drill
// File: BACKUP_STATUS_FILE (default /var/lib/usam-language/backup-status.json). Written atomically (temp file + rename).
// Contains no secrets: times, a file name, a size and a checksum.
import {readFile, writeFile, rename, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';

const file = process.env.BACKUP_STATUS_FILE || '/var/lib/usam-language/backup-status.json';
const [kind, a, b, c] = process.argv.slice(2);
let status = {};
try { status = JSON.parse(await readFile(file, 'utf8')); } catch { status = {}; }
if (!status || typeof status !== 'object' || Array.isArray(status)) status = {};
const at = new Date().toISOString();

if (kind === 'backup') {
  if (!a || !/^\d+$/.test(b || '') || !/^[a-f0-9]{64}$/.test(c || '')) { console.error('usage: backup <file> <size bytes> <sha256>'); process.exit(2); }
  status.lastBackup = {at, file: a, sizeBytes: Number(b), sha256: c, result: 'ok'};
  status.lastAttempt = {at, result: 'ok'};
} else if (kind === 'backup-failed') {
  status.lastAttempt = {at, result: 'failed'}; // lastBackup keeps the last GOOD backup
} else if (kind === 'restore-test') {
  if (!['ok', 'failed'].includes(a)) { console.error('usage: restore-test ok|failed'); process.exit(2); }
  status.lastRestoreTest = {at, result: a};
} else { console.error('unknown command: ' + kind); process.exit(2); }

await mkdir(dirname(file), {recursive: true});
const tmp = file + '.tmp-' + process.pid;
await writeFile(tmp, JSON.stringify(status, null, 2) + '\n', {mode: 0o644});
await rename(tmp, file);
