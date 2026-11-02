// Spaced-repetition scheduling engine (deterministic, provider-independent, dependency-free).
//
// Implements the SM-2 algorithm (Piotr Wozniak, SuperMemo 2), a well-established, openly documented
// spaced-repetition method. Chosen over a full FSRS implementation for the initial product because:
//   - SM-2 is self-contained and needs no per-user training/optimization pass.
//   - Its behavior is fully testable with pure functions.
//   - The card shape is forward-compatible: fields (stability/difficulty) can be added later for FSRS
//     without breaking persisted data.
//
// A review "card" tracks one item (e.g. a vocabulary word):
//   { word, reps, interval, ease, due, lapses }
//     reps:     number of consecutive successful reviews
//     interval: current inter-review interval in DAYS
//     ease:     ease factor (>= 1.3), SM-2 "E-Factor"
//     due:      epoch ms when the card next becomes due
//     lapses:   number of times the item was forgotten
//
// Grades (learner self-assessment of recall), 0..5 per SM-2:
//   0 total blackout · 1 wrong, remembered on seeing answer · 2 wrong, seemed easy once seen
//   3 correct, serious difficulty · 4 correct, hesitation · 5 perfect recall
// The UI uses a simpler good/again pair; map "again" -> 2 and "good" -> 4 via gradeFromBinary().

const DAY = 86400000;
const MIN_EASE = 1.3;

export function newCard(word, now = Date.now()) {
  return { word: String(word), reps: 0, interval: 0, ease: 2.5, due: now, lapses: 0 };
}

export function gradeFromBinary(good) {
  // Binary UI -> SM-2 quality. "again" is a lapse (2), "good" is a confident pass (4).
  return good ? 4 : 2;
}

// Pure SM-2 step. Returns a NEW card; never mutates the input.
export function review(card, quality, now = Date.now()) {
  const c = { word: card.word, reps: card.reps | 0, interval: card.interval || 0, ease: card.ease || 2.5, lapses: card.lapses | 0 };
  const q = Math.max(0, Math.min(5, Number(quality)));
  if (q < 3) {
    // Lapse: reset repetitions, short relearning step (10 minutes), keep (slightly reduced) ease.
    const ease = Math.max(MIN_EASE, c.ease - 0.2);
    return { word: c.word, reps: 0, interval: 0, ease, due: now + 10 * 60 * 1000, lapses: c.lapses + 1 };
  }
  // Successful recall: advance interval.
  let interval;
  if (c.reps === 0) interval = 1;
  else if (c.reps === 1) interval = 6;
  else interval = Math.round(c.interval * c.ease);
  interval = Math.max(1, interval);
  // SM-2 ease update.
  const ease = Math.max(MIN_EASE, c.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  return { word: c.word, reps: c.reps + 1, interval, ease, due: now + interval * DAY, lapses: c.lapses };
}

export function isDue(card, now = Date.now()) {
  return !card.due || card.due <= now;
}

export function dueCards(cards, now = Date.now()) {
  return (cards || []).filter(c => isDue(c, now));
}

// Migrate a legacy client card ({word, due, interval, ease}) into the current shape without data loss.
export function normalizeCard(card, now = Date.now()) {
  if (!card || typeof card.word !== 'string') return null;
  return {
    word: card.word,
    reps: Number.isFinite(card.reps) ? card.reps | 0 : (card.interval > 1 ? 2 : card.interval === 1 ? 1 : 0),
    interval: Number.isFinite(card.interval) ? Math.max(0, card.interval) : 0,
    ease: Number.isFinite(card.ease) ? Math.max(MIN_EASE, card.ease) : 2.5,
    due: Number.isFinite(card.due) ? card.due : now,
    lapses: Number.isFinite(card.lapses) ? card.lapses | 0 : 0,
  };
}

export const SCHEDULER_MIN_EASE = MIN_EASE;
