// A-7: backup status file (written by scripts/backup-status.mjs, read by readBackupStatus / GET /api/admin/backup-status).
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readBackupStatus} from '../server/admin.js';

const run = promisify(execFile);
let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const dir = await mkdtemp(join(tmpdir(), 'usam-bs-'));
const f = join(dir, 'status.json');
const SUM = 'a'.repeat(64);
const helper = (args, file = f) => run(process.execPath, ['scripts/backup-status.mjs', ...args], {env: {...process.env, BACKUP_STATUS_FILE: file}}).then(() => 0, e => e.code);
try {
  ok(JSON.stringify(await readBackupStatus(f)) === '{"configured":false}', 'missing file -> {configured:false}');
  await writeFile(f, '{not json');
  ok((await readBackupStatus(f)).problem === 'malformed', 'malformed JSON -> configured:false, problem malformed');
  await writeFile(f, '[1,2]');
  ok((await readBackupStatus(f)).problem === 'malformed', 'a JSON array is malformed');
  ok((await readBackupStatus(dir)).problem === 'unreadable', 'an unreadable path is reported, not thrown');
  await writeFile(f, JSON.stringify({lastBackup: {at: '2026-11-27T01:00:00Z', file: 'usam-x.dump', sizeBytes: 1234, sha256: SUM, result: 'ok', secret: 'leak'}, lastRestoreTest: {at: '2026-11-20T02:00:00Z', result: 'ok'}, extra: 'x'}));
  const s = await readBackupStatus(f);
  ok(s.configured && s.lastBackup.sizeBytes === 1234 && s.lastBackup.sha256 === SUM && s.lastBackup.at === '2026-11-27T01:00:00.000Z' && s.lastRestoreTest.result === 'ok', 'valid file is passed through');
  ok(!JSON.stringify(s).includes('leak') && !('extra' in s), 'unknown fields are dropped');
  await writeFile(f, JSON.stringify({lastBackup: {at: 'not a date', sha256: 'zz', sizeBytes: 'big'}, lastRestoreTest: {at: '2026-11-20T02:00:00Z', result: 'maybe'}}));
  const bad = await readBackupStatus(f);
  ok(bad.configured && bad.lastBackup === null && bad.lastRestoreTest.result === null, 'invalid field values are not trusted');

  // the writer used by backup.sh and restore.sh
  const g = join(dir, 'sub', 'dir', 'written.json');
  ok(await helper(['backup', 'usam-1.dump', '4096', SUM], g) === 0, 'backup-status.mjs backup writes the file (creates the directory)');
  ok(await helper(['restore-test', 'ok'], g) === 0 && await helper(['backup-failed'], g) === 0, 'restore-test and backup-failed update the same file');
  const w = JSON.parse(await readFile(g, 'utf8'));
  ok(w.lastBackup.file === 'usam-1.dump' && w.lastBackup.result === 'ok' && w.lastRestoreTest.result === 'ok' && w.lastAttempt.result === 'failed', 'merged: last good backup kept, restore test recorded, last attempt failed');
  ok(await helper(['backup', 'x', 'notanumber', SUM], g) !== 0 && await helper(['restore-test', 'maybe'], g) !== 0 && await helper(['nonsense'], g) !== 0, 'bad arguments are refused');
  ok((await readBackupStatus(g)).configured === true, 'the written file is read back by the server code');
} finally { await rm(dir, {recursive: true, force: true}); }
if (failures) { console.error(`\nBackup status tests FAILED (${failures}).`); process.exit(1); }
console.log('\nBackup status tests passed.');
