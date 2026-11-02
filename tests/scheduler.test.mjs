// Unit tests for the SM-2 spaced-repetition scheduler. Pure functions -> exact expected values.
// Run: node tests/scheduler.test.mjs
import {newCard, review, gradeFromBinary, isDue, dueCards, normalizeCard, SCHEDULER_MIN_EASE} from '../server/scheduler.js';

const DAY = 86400000;
const T0 = 1_700_000_000_000; // fixed "now" for determinism
let failures = 0;
const eq = (a, b, msg) => { if (a === b) console.log('  PASS:', msg); else { console.error(`  FAIL: ${msg} (expected ${b}, got ${a})`); failures++; } };
const approx = (a, b, msg, tol = 1e-9) => { if (Math.abs(a - b) <= tol) console.log('  PASS:', msg); else { console.error(`  FAIL: ${msg} (expected ~${b}, got ${a})`); failures++; } };

// newCard
{
  const c = newCard('departure', T0);
  eq(c.word, 'departure', 'newCard sets word');
  eq(c.reps, 0, 'newCard reps=0');
  eq(c.interval, 0, 'newCard interval=0');
  approx(c.ease, 2.5, 'newCard ease=2.5');
  eq(c.due, T0, 'newCard due=now');
}

// First three successful reviews follow SM-2 interval schedule 1 -> 6 -> round(6*ease)
{
  let c = newCard('luggage', T0);
  c = review(c, 4, T0);            // first pass
  eq(c.reps, 1, 'after 1st good review reps=1');
  eq(c.interval, 1, 'after 1st good review interval=1 day');
  eq(c.due, T0 + 1 * DAY, 'due 1 day out');
  const easeAfter1 = c.ease;       // q=4 -> ease += (0.1 - 1*(0.08+1*0.02)) = 0.1 - 0.1 = 0 -> stays 2.5
  approx(easeAfter1, 2.5, 'q=4 leaves ease unchanged');

  c = review(c, 4, c.due);         // second pass
  eq(c.reps, 2, 'after 2nd good review reps=2');
  eq(c.interval, 6, 'after 2nd good review interval=6 days');

  c = review(c, 4, c.due);         // third pass -> round(6 * 2.5)=15
  eq(c.reps, 3, 'after 3rd good review reps=3');
  eq(c.interval, 15, 'after 3rd good review interval=round(6*2.5)=15');
}

// Perfect recall (q=5) raises ease; difficult-but-correct (q=3) lowers it.
{
  let c = newCard('gate', T0);
  c = review(c, 5, T0);            // q=5 -> ease += 0.1
  approx(c.ease, 2.6, 'q=5 raises ease by 0.1');
  let d = newCard('delayed', T0);
  d = review(d, 3, T0);            // q=3 -> ease += (0.1 - 2*(0.08+2*0.02)) = 0.1-0.24 = -0.14
  approx(d.ease, 2.36, 'q=3 lowers ease by 0.14');
}

// Lapse resets reps/interval, adds a 10-minute relearning step, decrements ease, increments lapses.
{
  let c = newCard('deadline', T0);
  c = review(c, 4, T0);
  c = review(c, 4, c.due);         // reps=2, interval=6, ease=2.5
  const before = c.ease;
  const lapseNow = c.due;          // the moment the lapse happens
  c = review(c, 1, lapseNow);      // lapse
  eq(c.reps, 0, 'lapse resets reps to 0');
  eq(c.interval, 0, 'lapse resets interval to 0');
  eq(c.lapses, 1, 'lapse increments lapses');
  approx(c.ease, before - 0.2, 'lapse reduces ease by 0.2');
  eq(c.due, lapseNow + 10 * 60 * 1000, 'lapse due is a 10-minute relearning step from now (not days)');
}

// Ease never drops below the floor.
{
  let c = newCard('floor', T0);
  for (let i = 0; i < 20; i++) c = review(c, 0, T0); // repeated total blackout
  eq(c.ease >= SCHEDULER_MIN_EASE, true, 'ease stays >= 1.3 floor');
  approx(c.ease, SCHEDULER_MIN_EASE, 'ease clamps exactly to 1.3');
}

// Purity: input card is not mutated.
{
  const c = newCard('immutable', T0);
  const snapshot = JSON.stringify(c);
  review(c, 5, T0);
  eq(JSON.stringify(c), snapshot, 'review() does not mutate its input');
}

// gradeFromBinary + due selection
{
  eq(gradeFromBinary(true), 4, 'binary good -> quality 4');
  eq(gradeFromBinary(false), 2, 'binary again -> quality 2 (lapse)');
  const cards = [newCard('a', T0), { ...newCard('b', T0), due: T0 + 5 * DAY }];
  eq(isDue(cards[0], T0), true, 'card due at now is due');
  eq(isDue(cards[1], T0), false, 'card due in 5 days is not due');
  eq(dueCards(cards, T0).length, 1, 'dueCards filters to only due items');
}

// normalizeCard migrates legacy client cards without data loss.
{
  const legacy = { word: 'legacy', interval: 6, ease: 2.3, due: T0 };
  const n = normalizeCard(legacy, T0);
  eq(n.word, 'legacy', 'normalize keeps word');
  eq(n.reps, 2, 'normalize infers reps from interval>1');
  eq(n.interval, 6, 'normalize keeps interval');
  approx(n.ease, 2.3, 'normalize keeps ease');
  eq(n.lapses, 0, 'normalize defaults lapses to 0');
  eq(normalizeCard({}, T0), null, 'normalize rejects card with no word');
}

if (failures) { console.error(`\nScheduler unit tests FAILED (${failures} assertion(s)).`); process.exit(1); }
console.log('\nScheduler unit tests passed.');
