// Unit tests for the deterministic learning engine (server/engine.js).
// These lock current behavior and assert the improved writing/placement/recommendation logic.
// Run: node tests/engine.test.mjs
import {getAssessment, gradeAssessment, assessText, nextActivity, simulationTurn, reportSession, packs} from '../server/engine.js';

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log('  PASS:', msg); else { console.error('  FAIL:', msg); failures++; } };
const eq = (a, b, msg) => ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);

// --- Language pack registry ---
ok(packs.en && packs.en.cefr.includes('A1'), 'English language pack is registered with CEFR levels');

// --- Placement assessment ---
{
  const qs = getAssessment();
  ok(Array.isArray(qs) && qs.length >= 6, 'assessment returns questions');
  ok(qs.every(q => !('answer' in q)), 'assessment questions never leak the answer key');
  ok(qs.every(q => q.id && q.skill && Array.isArray(q.options)), 'each question has id, skill, options');
}

// --- gradeAssessment: deterministic level banding ---
{
  const empty = gradeAssessment({});
  eq(empty.correct, 0, 'no answers -> 0 correct');
  eq(empty.level, 'A1', 'no answers -> A1');
  ok(empty.skills && typeof empty.skills.Speaking === 'number', 'returns per-skill estimates');
  ok(empty.confidence && /speaking/i.test(empty.confidence), 'returns a confidence caveat');

  // Build an all-correct answer set from the private key via known correct options.
  const correct = { v1: 0, g1: 1, r1: 0, l1: 0, g2: 1, v2: 0 };
  const perfect = gradeAssessment(correct);
  eq(perfect.correct, 6, 'all correct -> 6 correct');
  eq(perfect.total, 6, 'total is 6');
  eq(perfect.level, 'B1', 'all correct -> B1 band');
  ok(perfect.detail.every(d => typeof d.correct === 'boolean'), 'per-question detail present');
}

// --- assessText: writing feedback heuristics ---
{
  const short = assessText('Hi');
  ok(short.wordCount === 1, 'counts words');
  ok(short.signals.some(s => /more detail/i.test(s)), 'flags too-short input');

  const agreement = assessText('I is very happy today and we is learning.');
  ok(agreement.signals.some(s => /agreement/i.test(s)), 'flags subject-verb agreement');

  const pastTense = assessText('Yesterday I go to the market with my friend.');
  ok(pastTense.signals.some(s => /past/i.test(s)), 'flags past-tense mismatch with "yesterday"');

  const noPunct = assessText('This is a complete thought without an ending mark');
  ok(noPunct.signals.some(s => /punctuation/i.test(s)), 'flags missing end punctuation');

  const clean = assessText('I enjoyed the lesson today, and I practiced new words.');
  eq(clean.hasEvidence, true, 'clean text has evidence');
  ok(clean.uniqueWords > 0, 'counts unique words');
}

// --- nextActivity: recommends weakest skill ---
{
  const rec = nextActivity({ skills: { Speaking: 30, Listening: 80, Reading: 75, Writing: 60, Grammar: 70, Vocabulary: 65, Pronunciation: 55 }, minutes: 25 });
  eq(rec.skill, 'Speaking', 'recommends the weakest skill');
  eq(rec.minutes, 25, 'carries the learner minutes');
  ok(rec.activity && rec.reason, 'returns an activity and a reason');
}

// --- simulationTurn: deterministic guided scene ---
{
  const scenario = { id: 'airport', opening: 'Good morning!', event: 'Your flight is delayed.', hint: 'Try a full sentence.', words: ['gate'] };
  const t0 = simulationTurn(scenario, [], '');
  eq(t0.reply, 'Good morning!', 'first turn returns the opening');
  const turns = [{ role: 'coach', text: 'Good morning!' }, { role: 'user', text: 'Here is my passport.' }, { role: 'coach', text: '...' }, { role: 'user', text: 'I have one bag.' }];
  const t2 = simulationTurn(scenario, turns, 'I have one bag.');
  ok(typeof t2.reply === 'string' && t2.reply.length > 0, 'later turns return a reply');
  ok('analysis' in t2, 'turn includes writing analysis of the learner text');
}

// --- reportSession: summarizes a guided session ---
{
  const scenario = { title: 'The airport', words: ['gate', 'luggage', 'boarding pass'] };
  const turns = [
    { role: 'coach', text: 'Welcome.' },
    { role: 'user', text: 'I need to find my gate and check my luggage please.' },
    { role: 'user', text: 'Where is the boarding pass desk?' },
  ];
  const report = reportSession(scenario, turns);
  eq(report.title, 'The airport', 'report carries the scenario title');
  eq(report.turns, 2, 'counts learner turns only');
  ok(report.targetWords.includes('gate') && report.targetWords.includes('luggage'), 'detects used target words');
  eq(report.provisional, true, 'report is marked provisional (not a certified score)');
}

if (failures) { console.error(`\nEngine unit tests FAILED (${failures} assertion(s)).`); process.exit(1); }
console.log('\nEngine unit tests passed.');
