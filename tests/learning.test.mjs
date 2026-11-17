// Learning backend: rules (unit) + API integration on a real server. PGlite always; PostgreSQL too when
// DATABASE_URL is set (isolated throwaway database).
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes, randomUUID, createHash} from 'node:crypto';
import {freePort, stopServer} from './helpers.mjs';
import {learnerDay, streakFrom, parseActivity} from '../server/learning.js';
import {createDb} from '../server/db/index.js';
import * as repo from '../server/db/repo.js';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PW = 'correct-horse-battery-staple';
const sha = v => createHash('sha256').update(v).digest('hex');
const throws = (fn, status) => { try { fn(); return false; } catch (e) { return e.status === status; } };

// ---------------------------------------------------------------- unit: rules
console.log('-- rules');
ok(/^\d{4}-\d{2}-\d{2}$/.test(learnerDay()), 'learnerDay is YYYY-MM-DD');
ok(learnerDay(Date.UTC(2026, 10, 3, 22, 30)) === '2026-11-04', 'learner day uses Cairo time (22:30 UTC on Nov 3 is Nov 4 in Cairo)');
ok(streakFrom(['2026-11-04', '2026-11-03', '2026-11-02'], '2026-11-04') === 3, 'streak counts consecutive days ending today');
ok(streakFrom(['2026-11-03', '2026-11-02'], '2026-11-04') === 2, 'streak survives until the end of the next day');
ok(streakFrom(['2026-11-02'], '2026-11-04') === 0, 'a missed day resets the streak');
ok(streakFrom(['2026-11-04', '2026-11-02'], '2026-11-04') === 1, 'a gap breaks the run');
ok(streakFrom(['2026-03-01', '2026-02-28'], '2026-03-01') === 2, 'streak crosses month boundaries');
ok(streakFrom([], '2026-11-04') === 0, 'no activity -> streak 0');
const a = parseActivity({ref: 'Airport', title: 'The airport', words: ['Gate', 'gate', 'x', 'boarding pass', ...Array(30).fill('w').map((w, i) => w + i)]});
ok(a.kind === 'simulation' && a.skill === 'Functional English' && a.ref === 'airport', 'scenario refs are simulations (Functional English evidence)');
ok(a.words[0] === 'gate' && a.words[1] === 'boarding pass' && a.words.length === 20, 'words are lower-cased, de-duplicated, too-short dropped, capped at 20');
ok(parseActivity({ref: 'writing', title: 'Writing studio'}).skill === 'Writing' && parseActivity({ref: 'coach', title: 'AI'}).skill === 'Conversation' && parseActivity({ref: 'story', title: 'S'.repeat(3)}).skill === 'Reading', 'writing/coach/story map to Writing/Conversation/Reading');
ok(throws(() => parseActivity({ref: '../etc', title: 'x'}), 400) && throws(() => parseActivity({ref: 'story', title: ''}), 400) && throws(() => parseActivity({ref: 'story', title: 'ok', clientId: 'bad id!'}), 400), 'invalid ref, missing title and malformed clientId are rejected (400)');

// ---------------------------------------------------------------- API
async function apiSuite(label, extraEnv, openDb) {
  console.log(`-- api (${label})`);
  const dir = await mkdtemp(join(tmpdir(), 'usam-learn-'));
  const procs = [];
  const baseEnv = {...process.env, NODE_ENV: 'test', REDIS_URL: '', RATE_LIMIT_PREFIX: 'learn' + Date.now(), AUTH_IP_LIMIT: '1000', AUTH_EMAIL_LIMIT: '1000', LEADS_FILE: join(dir, 'l.jsonl'), CUSTOMER_DB_FILE: join(dir, 'db.json'), LEARNING_DAILY_XP_ACTIVITIES: '3', ...extraEnv};
  async function start(env) {
    const port = await freePort();
    const child = spawn(process.execPath, ['server/index.js'], {env: {...baseEnv, ...env, PORT: String(port)}, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
    procs.push(child);
    const o = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 300; i++) { try { if ((await fetch(o + '/api/health')).ok) return {o, child}; } catch {} if (child.exitCode !== null) break; await sleep(100); }
    throw Error('server did not start');
  }
  const call = async (o, path, {method = 'GET', body, cookie} = {}) => { const r = await fetch(o + path, {method, headers: {...(body ? {'Content-Type': 'application/json'} : {}), ...(cookie ? {Cookie: cookie} : {})}, body: body ? JSON.stringify(body) : undefined}); let data = {}; try { data = await r.json(); } catch {} return {status: r.status, data, cookie: (r.headers.get('set-cookie') || '').split(';')[0], headers: r.headers}; };
  const register = async (o, tag) => { const r = await call(o, '/api/customer/register', {method: 'POST', body: {name: 'Learner ' + tag, email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, phone: '01000000000', password: PW}}); return r.cookie; };
  const act = (o, cookie, body) => call(o, '/api/customer/learning/activities', {method: 'POST', cookie, body});
  try {
    // ---- legacy blob conversion: a learner whose progress lived only in the old synced profile blob ----
    const legacyToken = randomBytes(32).toString('hex'), legacyId = randomUUID();
    {
      const db = await openDb(dir);
      await repo.users.create(db, {id: legacyId, email: `legacy-${Date.now()}@example.com`, name: 'Legacy Learner', password: 'x:y', profile: {goal: 'Travel & everyday life', xp: 300, streak: 4, sessions: [{id: 'airport', title: 'The airport', date: '2026-10-01T10:00:00.000Z', words: ['gate'], summary: 'old'}, {id: 'story', title: 'The last train', date: '2026-10-02T10:00:00.000Z', words: ['platform'], summary: 'old'}], reviews: [{word: 'gate', interval: 6, ease: 2.4, due: Date.now() - 1000}, {word: 'luggage', due: Date.now() + 86400000}]}});
      await repo.sessions.create(db, {id: randomUUID(), hash: sha(legacyToken), userId: legacyId, createdAt: Date.now(), lastSeen: Date.now(), device: 't', expires: Date.now() + 864e5});
      await db.close();
    }
    const S = await start({ACCESS_ENFORCEMENT: 'open'});
    const legacyCookie = 'usam_session=' + legacyToken;
    const lm = (await call(S.o, '/api/customer/me', {cookie: legacyCookie})).data.profile;
    ok(lm.xp === 300 && lm.sessions.length === 2 && lm.sessions[0].id === 'story' && lm.reviews.length === 2 && lm.reviews.find(r => r.word === 'gate')?.interval === 6, `${label}: legacy progress blob converted on first read (xp 300, 2 sessions, 2 review cards kept)`);
    ok(lm.goal === 'Travel & everyday life', `${label}: learner settings in the blob are preserved`);
    await call(S.o, '/api/customer/profile', {method: 'PUT', cookie: legacyCookie, body: {profile: {goal: 'Career & interviews', minutes: 30}}});
    const lm2 = (await call(S.o, '/api/customer/me', {cookie: legacyCookie})).data.profile;
    ok(lm2.goal === 'Career & interviews' && lm2.xp === 300 && lm2.sessions.length === 2, `${label}: saving settings after conversion keeps the converted history`);

    // ---- a new learner ----
    const c = await register(S.o, 'new');
    let me = (await call(S.o, '/api/customer/me', {cookie: c})).data.profile;
    ok(me.xp === 0 && me.streak === 0 && me.sessions.length === 0 && me.reviews.length === 0, `${label}: a new learner starts at 0 XP, no sessions, no cards`);
    const r1 = await act(S.o, c, {clientId: 'client-aaaaaaaa', ref: 'airport', title: 'The airport', words: ['Gate', 'luggage'], summary: 'You stayed in the conversation.'});
    ok(r1.status === 201 && r1.data.activity.xp === 25 && r1.data.activity.newCards === 2, `${label}: completing an activity records it (+25 XP, 2 new review cards)`);
    ok(r1.data.progress.xp === 25 && r1.data.progress.streak === 1 && r1.data.progress.sessions[0].id === 'airport' && r1.data.progress.evidence['Functional English'] === 1 && r1.data.progress.completed.includes('airport'), `${label}: the response carries server-computed progress (xp, streak, sessions, evidence, completed)`);
    const dup = await act(S.o, c, {clientId: 'client-aaaaaaaa', ref: 'airport', title: 'The airport', words: ['gate']});
    ok(dup.status === 200 && dup.data.duplicate === true && dup.data.progress.xp === 25, `${label}: a retried request with the same clientId is not counted twice`);
    ok((await act(S.o, c, {ref: '<script>', title: 'x'})).status === 400, `${label}: invalid activity -> 400`);

    // ---- the browser can no longer set progress ----
    await call(S.o, '/api/customer/profile', {method: 'PUT', cookie: c, body: {profile: {xp: 99999, streak: 365, sessions: [{id: 'fake', title: 'Fake'}], reviews: [{word: 'fake', due: 0}], goal: 'Study & university'}}});
    me = (await call(S.o, '/api/customer/me', {cookie: c})).data.profile;
    ok(me.xp === 25 && me.streak === 1 && me.sessions.length === 1 && !me.reviews.some(r => r.word === 'fake'), `${label}: XP/streak/sessions/cards sent by the browser are ignored`);
    ok(me.goal === 'Study & university', `${label}: learner settings sent by the browser are saved`);

    // ---- daily XP cap (3 in this test) under concurrency ----
    const burst = await Promise.all(Array.from({length: 6}, (_, i) => act(S.o, c, {clientId: 'burst-' + i + '-xxxxxx', ref: 'story', title: 'The last train', words: []})));
    ok(burst.every(r => r.status === 201), `${label}: 6 concurrent activities all recorded`);
    me = (await call(S.o, '/api/customer/me', {cookie: c})).data.profile;
    ok(me.xp === 75 && burst.filter(r => r.data.activity.xp === 25).length === 2, `${label}: daily XP cap holds under concurrency (3 XP activities per day -> total 75)`);
    ok(me.sessions.length === 7 && me.evidence.Reading === 6, `${label}: capped activities are still recorded as learning evidence`);

    // ---- review grading (SM-2 on the server) ----
    const g = await call(S.o, '/api/customer/learning/reviews', {method: 'POST', cookie: c, body: {word: 'gate', good: true}});
    ok(g.status === 200 && g.data.card.reps === 1 && g.data.card.interval === 1 && g.data.card.due > Date.now() + 23 * 36e5, `${label}: grading "remembered" schedules the card ~1 day out`);
    const g2 = await call(S.o, '/api/customer/learning/reviews', {method: 'POST', cookie: c, body: {word: 'luggage', good: false}});
    ok(g2.data.card.lapses === 1 && g2.data.card.due < Date.now() + 11 * 60000, `${label}: grading "again" counts a lapse and brings the card back in ~10 minutes`);
    ok((await call(S.o, '/api/customer/learning/reviews', {method: 'POST', cookie: c, body: {word: 'never-added', good: true}})).status === 404, `${label}: grading an unknown word -> 404`);
    ok((await call(S.o, '/api/customer/learning/reviews', {method: 'POST', cookie: c, body: {word: 'gate', good: 'yes'}})).status === 400, `${label}: malformed grade -> 400`);
    const due = (await call(S.o, '/api/customer/learning/reviews?due=true', {cookie: c})).data.cards;
    ok(Array.isArray(due) && !due.some(x => x.word === 'gate'), `${label}: a card graded "remembered" is no longer due`);

    // ---- placement assessment history ----
    const anon = await call(S.o, '/api/assessment', {method: 'POST', body: {answers: {v1: 0}}});
    ok(anon.status === 200 && anon.data.stored === false && anon.data.level, `${label}: anonymous placement is graded but not stored`);
    const pl = await call(S.o, '/api/assessment', {method: 'POST', cookie: c, body: {answers: {v1: 0, g1: 1, r1: 0, l1: 0, g2: 1, v2: 0}}});
    ok(pl.data.stored === true && pl.data.level === 'B1', `${label}: a signed-in learner's placement is stored`);
    me = (await call(S.o, '/api/customer/me', {cookie: c})).data.profile;
    ok(me.level === 'B1' && me.assessmentDone === true && me.skills.Grammar >= 80, `${label}: the profile's level and skills come from the latest stored assessment`);
    ok((await call(S.o, '/api/customer/learning/assessments', {cookie: c})).data.assessments.length === 1, `${label}: assessment history lists it`);

    // ---- history + export ----
    const h = await call(S.o, '/api/customer/learning/history?pageSize=5', {cookie: c});
    ok(h.data.total === 7 && h.data.items.length === 5 && h.data.pages === 2, `${label}: activity history is paginated`);
    const ex = await call(S.o, '/api/customer/export', {cookie: c});
    const exText = JSON.stringify(ex.data);
    ok(ex.status === 200 && /attachment/.test(ex.headers.get('content-disposition') || '') && ex.data.activities.length === 7 && ex.data.reviewCards.length === 2 && ex.data.assessments.length === 1, `${label}: data export contains activities, review cards and assessments`);
    ok(!exText.includes('"password"') && !/"hash"/.test(exText) && ex.data.account.email, `${label}: data export contains no password or session/token hashes`);

    // ---- isolation (IDOR): another learner sees nothing of the first ----
    const other = await register(S.o, 'other');
    const om = (await call(S.o, '/api/customer/me', {cookie: other})).data.profile;
    ok(om.xp === 0 && om.reviews.length === 0 && (await call(S.o, '/api/customer/export', {cookie: other})).data.activities.length === 0, `${label}: learning records are per learner (no cross-account access)`);
    ok((await call(S.o, '/api/customer/learning/progress')).status === 401, `${label}: learning APIs require sign-in`);
    await stopServer(S.child);

    // ---- entitlement on learning writes when access is enforced ----
    const E = await start({ACCESS_ENFORCEMENT: 'enforced'});
    const ec = await register(E.o, 'unpaid');
    ok((await act(E.o, ec, {ref: 'story', title: 'The last train'})).status === 402, `${label}: enforced deployment: recording practice requires an active subscription (402)`);
    ok((await call(E.o, '/api/customer/me', {cookie: ec})).status === 200 && (await call(E.o, '/api/customer/export', {cookie: ec})).status === 200, `${label}: reading own progress and exporting data never require a subscription`);
    await stopServer(E.child);
  } finally {
    for (const p of procs) try { p.kill(); } catch {}
    await sleep(300);
    await rm(dir, {recursive: true, force: true});
  }
}

await apiSuite('pglite', {DATABASE_URL: ''}, dir => createDb({databaseUrl: '', dataDir: join(dir, 'db-pglite')}));
if (process.env.DATABASE_URL) {
  const {default: pg} = await import('pg');
  const admin = new pg.Client({connectionString: process.env.DATABASE_URL}); await admin.connect();
  const name = 'usam_learn_' + Date.now();
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(process.env.DATABASE_URL); u.pathname = '/' + name;
  try { await apiSuite('postgres', {DATABASE_URL: u.toString()}, () => createDb({databaseUrl: u.toString()})); }
  finally { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); }
} else console.log('DATABASE_URL not set — skipping PostgreSQL suite.');

if (failures) { console.error(`\nLearning tests FAILED (${failures}).`); process.exit(1); }
console.log('\nLearning tests passed.');
process.exit(0);
