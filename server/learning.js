// Learning engine (server side): rules for recording activities, XP, streaks, skill evidence and review cards, plus
// the service functions that apply them in the database. Progress shown to the learner is computed from stored
// records; the browser can no longer set XP, streaks or review state directly.
import {randomUUID} from 'node:crypto';
import {newCard, review as sm2, gradeFromBinary, normalizeCard} from './scheduler.js';

// ---------------------------------------------------------------- rules (pure)
export const KINDS = ['simulation', 'coach', 'story', 'writing', 'pronunciation'];
const KIND_BY_REF = {coach: 'coach', story: 'story', writing: 'writing', pronunciation: 'pronunciation'};
// Same mapping the learner UI has always used for "evidence" per skill.
const SKILL_BY_KIND = {writing: 'Writing', story: 'Reading', pronunciation: 'Pronunciation', coach: 'Conversation', simulation: 'Functional English'};
export const XP_PER_ACTIVITY = 25;
export const DAILY_XP_ACTIVITIES = () => Number(process.env.LEARNING_DAILY_XP_ACTIVITIES || 20); // anti-farming cap
export const MAX_REVIEW_CARDS = 500;
export const MAX_WORDS_PER_ACTIVITY = 20;

// Learner calendar day in Cairo time (the product's primary market). Used for streaks and daily caps.
export function learnerDay(ts = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
// Milliseconds from `ts` to the next midnight in Cairo (when the daily AI cap resets). At least 1 second.
// shortcut: on the two days a year when Cairo changes its clock this is off by one hour; fine for a "resets in about" message.
export function msUntilCairoMidnight(ts = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone: 'Africa/Cairo', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit'}).formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  const sinceMidnight = (Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second)) * 1000 + (ts % 1000);
  return Math.max(1000, 86400000 - sinceMidnight);
}
const prevDay = d => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); };

// Consecutive active days ending today or yesterday (a streak survives until the end of the next day).
export function streakFrom(daysDesc, today = learnerDay()) {
  const set = new Set(daysDesc);
  let d = set.has(today) ? today : prevDay(today);
  if (!set.has(d)) return 0;
  let n = 0;
  while (set.has(d)) { n++; d = prevDay(d); }
  return n;
}

const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
// Validates and normalizes an activity submitted by the learner app. Throws {status: 400} on bad input.
export function parseActivity(body = {}) {
  const ref = cleanText(body.ref ?? body.id, 40).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(ref)) throw Object.assign(Error('Invalid activity reference.'), {status: 400});
  const kind = KIND_BY_REF[ref] || 'simulation';
  const title = cleanText(body.title, 120);
  if (title.length < 2) throw Object.assign(Error('Activity title is required.'), {status: 400});
  const words = Array.isArray(body.words) ? [...new Set(body.words.map(w => cleanText(w, 40).toLowerCase()).filter(w => w.length >= 2))].slice(0, MAX_WORDS_PER_ACTIVITY) : [];
  const clientId = body.clientId == null ? null : cleanText(body.clientId, 64);
  if (clientId !== null && !/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) throw Object.assign(Error('Invalid client id.'), {status: 400});
  const metrics = body.metrics && typeof body.metrics === 'object' && !Array.isArray(body.metrics) && JSON.stringify(body.metrics).length <= 2000 ? body.metrics : {};
  return {ref, kind, title, words, clientId, summary: cleanText(body.summary, 400), metrics, skill: SKILL_BY_KIND[kind]};
}

const toCardRow = c => ({word: c.word, reps: c.reps, interval: c.interval, ease: c.ease, due: c.due, lapses: c.lapses});

// ---------------------------------------------------------------- services (database)
// repo: server/db/repo.js; q: db or transaction handle.
export function createLearning(repo) {
  const L = repo.learning;

  // Converts a learner's legacy browser-synced blob (profile.sessions / reviews / xp) into records, once.
  async function ensureImported(q, user) {
    if (user.learningImported) return;
    await q.tx(async t => {
      const fresh = await L.lockImportFlag(t, user.id);
      if (fresh === null || fresh === true) return;
      const p = user.profile || {};
      const now = Date.now();
      let given = 0;
      for (const s of Array.isArray(p.sessions) ? p.sessions.slice(0, 60) : []) {
        let a; try { a = parseActivity({ref: s.id || 'practice', title: s.title || 'Practice', words: s.words, summary: s.summary}); } catch { continue; }
        const at = Number.isFinite(Date.parse(s.date)) ? new Date(s.date) : new Date(now);
        await L.insertActivity(t, {id: randomUUID(), userId: user.id, clientId: null, ...a, xp: XP_PER_ACTIVITY, day: learnerDay(at.getTime()), createdAt: at.toISOString()});
        given += XP_PER_ACTIVITY;
      }
      const rest = Math.max(0, Math.floor(Number(p.xp) || 0) - given);
      if (rest > 0) await L.insertActivity(t, {id: randomUUID(), userId: user.id, clientId: null, ref: 'legacy', kind: 'legacy', title: 'Earlier progress', skill: 'Functional English', words: [], summary: 'Progress recorded before server-side tracking.', metrics: {imported: true}, xp: rest, day: learnerDay(now), createdAt: new Date(now).toISOString()});
      for (const r of Array.isArray(p.reviews) ? p.reviews.slice(0, MAX_REVIEW_CARDS) : []) {
        const c = normalizeCard(r, now);
        if (c && /^.{2,40}$/.test(c.word)) await L.upsertCard(t, user.id, {...toCardRow(c), word: c.word.toLowerCase()}, now, {onlyIfMissing: true});
      }
      await L.setImported(t, user.id);
    });
    user.learningImported = true;
  }

  // Server-computed progress in the exact shape the learner UI uses for its profile object.
  async function progress(q, user) {
    await ensureImported(q, user);
    // Sequential on purpose: one pooled connection per request, even under load.
    const {xp, days, evidence, completed, last} = await L.summary(q, user.id);
    const recent = await L.recentActivities(q, user.id, 60);
    const cards = await L.cards(q, user.id);
    const latest = await L.latestAssessment(q, user.id);
    const out = {
      xp, streak: streakFrom(days), lastActive: last ? new Date(last).toDateString() : '',
      evidence, completed, reviews: cards,
      sessions: recent.map(a => ({id: a.ref, title: a.title, date: a.createdAt, words: a.words, summary: a.summary, score: null, xp: a.xp})),
    };
    if (latest) Object.assign(out, {level: latest.result.level, skills: latest.result.skills, assessmentDone: true, assessedAt: latest.createdAt});
    return out;
  }

  // Records a completed activity. Idempotent per clientId. XP only for the first N activities per learner day.
  async function recordActivity(db, user, body) {
    const a = parseActivity(body);
    await ensureImported(db, user);
    const now = Date.now(), day = learnerDay(now);
    const res = await db.tx(async t => {
      await L.lockUser(t, user.id); // serializes this learner's writes: daily cap and card count stay exact
      if (a.clientId) { const dup = await L.byClientId(t, user.id, a.clientId); if (dup) return {activity: dup, duplicate: true}; }
      const today = await L.countXpActivitiesOnDay(t, user.id, day);
      const xp = today < DAILY_XP_ACTIVITIES() ? XP_PER_ACTIVITY : 0;
      const activity = {id: randomUUID(), userId: user.id, ...a, xp, day, createdAt: new Date(now).toISOString()};
      await L.insertActivity(t, activity);
      let added = 0;
      if (a.words.length) {
        let count = await L.cardCount(t, user.id);
        for (const w of a.words) {
          if (count >= MAX_REVIEW_CARDS) break;
          if (await L.upsertCard(t, user.id, toCardRow(newCard(w, now)), now, {onlyIfMissing: true})) { count++; added++; }
        }
      }
      return {activity: {id: activity.id, ref: a.ref, kind: a.kind, xp, createdAt: activity.createdAt, newCards: added}, duplicate: false};
    });
    return {...res, progress: await progress(db, user)};
  }

  // Grades one review card with SM-2 and stores the new state.
  async function gradeReview(db, user, body) {
    const word = cleanText(body?.word, 40).toLowerCase();
    if (word.length < 2 || typeof body?.good !== 'boolean') throw Object.assign(Error('Send {word, good: true|false}.'), {status: 400});
    await ensureImported(db, user);
    const now = Date.now();
    const card = await db.tx(async t => {
      const current = await L.cardForUpdate(t, user.id, word);
      if (!current) throw Object.assign(Error('This word is not in your review list.'), {status: 404});
      const next = sm2(current, gradeFromBinary(body.good), now);
      await L.upsertCard(t, user.id, toCardRow(next), now, {reviewed: true});
      return next;
    });
    return {card: toCardRow(card), reviews: await L.cards(db, user.id)};
  }

  async function recordAssessment(db, userId, answers, result) {
    const row = {id: randomUUID(), userId, kind: 'placement', answers, result, createdAt: new Date().toISOString()};
    await L.insertAssessment(db, row);
    return row;
  }

  return {ensureImported, progress, recordActivity, gradeReview, recordAssessment};
}
