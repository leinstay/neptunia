// Tests for src/intentions/model.ts: the persona's intentions as pure data. A record is created
// with an expiry, moves only along the allowed transitions, never out of a terminal status, waits
// only on a real errand with a deadline, comes back to pending once (and only once) its errand
// ends, expires by the clock, and is listed when due. Candidates are anchored to her own lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTEND_DEFAULTS,
  DEFAULTS,
  attendCounter,
  bumpAttend,
  isAttend,
  normalizeAttend,
  validAttend,
  STANDING_EXPIRES_AT,
  advanceOccurrence,
  nextOccurrence,
  parseEvery,
  pinEvery,
  arrive,
  checkInvariants,
  concernsMember,
  createIntention,
  dropIntention,
  dueList,
  expireAt,
  intentionSettings,
  isIntentionId,
  newIntentionId,
  parseWhen,
  reconcileWait,
  transition,
  waitOn,
} from '../src/intentions/model.ts';
import { zonedEpoch } from '../src/time.ts';
import type { Untyped } from '../src/tools/types.ts';
import { present, wrongly } from './fixtures/loose-types.ts';

const T0 = Date.parse('2026-10-18T10:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function mine(extra = {}) {
  const made = createIntention({
    purpose: 'βρες το άρθρο για την Ζωή',
    provenance: { kind: 'self', turnId: 't1' },
    now: T0,
    id: 'i1',
    ...extra,
  });
  assert.equal(made.ok, true, wrongly(made.code));
  return made.intention;
}

test('createIntention: her own is pending with the default expiry', () => {
  const own = mine();
  assert.equal(own.status, 'pending');
  assert.equal(own.expiresAt, T0 + DEFAULTS.expiresDays * DAY);
  assert.deepEqual(own.provenance, { kind: 'self', turnId: 't1', scope: 'group' });
  assert.deepEqual(own.history, [{ at: T0, to: 'pending', by: 'persona' }]);
});

test('createIntention: refuses an empty purpose, an unknown provenance, a past expiry and a due time after the expiry', () => {
  const base = { provenance: { kind: 'self' }, now: T0 };
  assert.equal(createIntention(wrongly({ ...base, purpose: '  ' })).code, 'no-purpose');
  assert.equal(
    createIntention({ ...base, purpose: 'x', provenance: { kind: wrongly('quoted') } }).code,
    'bad-provenance'
  );
  assert.equal(createIntention(wrongly({ ...base, purpose: 'x', expiresAt: T0 })).code, 'bad-expiry');
  assert.equal(
    createIntention(wrongly({ ...base, purpose: 'x', dueAt: T0 + 2 * HOUR, expiresAt: T0 + HOUR })).code,
    'due-after-expiry'
  );
});

test('waitOn: waiting needs a real errand id and a deadline after now; the invariant holds on every record', () => {
  const own = mine();
  assert.equal(waitOn(own, { errandId: '', deadline: T0 + HOUR, now: T0 }).code, 'wait-without-errand');
  assert.equal(waitOn(own, { errandId: 'tabc', deadline: T0, now: T0 }).code, 'bad-deadline');
  const waited = waitOn(own, { errandId: 'tabc', deadline: T0 + HOUR, now: T0 });
  assert.equal(present(waited.intention).status, 'waiting');
  assert.equal(present(waited.intention).awaitingErrandId, 'tabc');
  assert.equal(checkInvariants(waited.intention), null);
  assert.equal(checkInvariants({ ...waited.intention, waitDeadline: null }), 'wait-without-deadline');
  assert.equal(checkInvariants({ ...waited.intention, awaitingErrandId: null }), 'wait-without-errand');
  assert.equal(checkInvariants({ ...own, expiresAt: null }), 'no-expiry');
  // A plain transition to waiting without them is refused by the same invariant.
  assert.equal(transition(own, 'waiting', { now: T0 }).code, 'wait-without-errand');
});

test('transition: terminal statuses are final; a move its status does not allow is refused', () => {
  const own = mine();
  const done = transition(own, 'done', { now: T0 + 1 }).intention;
  for (const to of ['pending', 'waiting', 'cancelled', 'expired', 'done'])
    assert.equal(transition(wrongly(done), wrongly(to), { now: T0 + 2 }).code, 'terminal');
});

test('arrive: the awaited errand ending moves the wait back to pending once; a second delivery changes nothing', () => {
  const waiting = waitOn(mine(), { errandId: 'tabc', deadline: T0 + HOUR, now: T0 }).intention;
  const other = arrive(wrongly(waiting), { id: 'tzzz', state: 'done' }, { now: T0 + 1 });
  assert.equal(other.changed, false);
  const stillOpen = arrive(wrongly(waiting), { id: 'tabc', state: 'running' }, { now: T0 + 1 });
  assert.equal(stillOpen.changed, false);
  const first = arrive(
    wrongly(waiting),
    { id: 'tabc', state: 'failed', error: 'restarted', endedAt: T0 + 5 },
    { now: T0 + 10 }
  );
  assert.equal(first.changed, true);
  assert.equal(first.intention.status, 'pending');
  assert.deepEqual(first.intention.outcome, { errandId: 'tabc', state: 'failed', error: 'restarted', at: T0 + 5 });
  assert.equal(first.intention.awaitingErrandId, null);
  assert.equal(first.intention.lastErrandId, 'tabc');
  const again = arrive(first.intention, { id: 'tabc', state: 'failed', error: 'restarted' }, { now: T0 + 20 });
  assert.equal(again.changed, false);
  assert.equal(again.intention, first.intention);
});

test('arrive: the end is a fresh due moment when the old one has passed; a due still ahead stays', () => {
  // She waited at T0 on an intention due at T0 (the wake that set the wait): the end at T0 + 5 is the new due.
  const past = waitOn(mine({ dueAt: T0 }), { errandId: 'tabc', deadline: T0 + HOUR, now: T0 }).intention;
  assert.equal(
    present(arrive(wrongly(past), { id: 'tabc', state: 'done', endedAt: T0 + 5 }, { now: T0 + 10 }).intention).dueAt,
    T0 + 5
  );
  // No due time at all: the end is one now.
  const none = waitOn(mine(), { errandId: 'tabc', deadline: T0 + HOUR, now: T0 }).intention;
  assert.equal(
    present(arrive(wrongly(none), { id: 'tabc', state: 'done' }, { now: T0 + 10 }).intention).dueAt,
    T0 + 10
  );
  // A due ahead of the end is hers to keep.
  const ahead = waitOn(mine({ dueAt: T0 + 2 * HOUR }), { errandId: 'tabc', deadline: T0 + HOUR, now: T0 }).intention;
  assert.equal(
    present(arrive(wrongly(ahead), { id: 'tabc', state: 'done', endedAt: T0 + 5 }, { now: T0 + 10 }).intention).dueAt,
    T0 + 2 * HOUR
  );
});

test('reconcileWait: a gone errand, an ended one and a passed deadline each move the wait to pending with its note', () => {
  const waiting = waitOn(mine(), { errandId: 'tabc', deadline: T0 + HOUR, now: T0 }).intention;
  assert.equal(
    present(reconcileWait(wrongly(waiting), { errandOf: () => null, now: T0 + 1 }).intention).note,
    'errand-missing'
  );
  assert.equal(
    present(reconcileWait(wrongly(waiting), { errandOf: () => ({ id: 'tabc', state: 'done' }), now: T0 + 1 }).intention)
      .note,
    'errand-done'
  );
  assert.equal(
    reconcileWait(wrongly(waiting), { errandOf: () => ({ id: 'tabc', state: 'running' }), now: T0 + 1 }).changed,
    false
  );
  assert.equal(
    present(
      reconcileWait(wrongly(waiting), { errandOf: () => ({ id: 'tabc', state: 'running' }), now: T0 + HOUR }).intention
    ).note,
    'wait-deadline'
  );
});

test('expireAt and dueList: the clock expires an open record; due and overdue are listed', () => {
  const own = mine({ dueAt: T0 + HOUR });
  assert.equal(expireAt(own, own.expiresAt - 1).changed, false);
  assert.equal(present(expireAt(own, own.expiresAt).intention).status, 'expired');
  const waiting = waitOn(mine({ id: 'i2' }), { errandId: 't1', deadline: T0 + 30 * 60 * 1000, now: T0 }).intention;
  assert.deepEqual(dueList([own, waiting], T0), []);
  assert.deepEqual(
    dueList([own, waiting], T0 + 2 * HOUR).map((entry) => [entry.intention.id, entry.reason]),
    [
      ['i2', 'wait-deadline'],
      ['i1', 'due'],
    ]
  );
});

test('parseWhen and intentionSettings: relative and ISO times; missing settings fall back to the defaults', () => {
  assert.equal(parseWhen('30m', T0), T0 + 30 * 60 * 1000);
  assert.equal(parseWhen('6h', T0), T0 + 6 * HOUR);
  assert.equal(parseWhen('2d', T0), T0 + 2 * DAY);
  assert.equal(parseWhen('2026-10-20T08:00:00Z', T0), Date.parse('2026-10-20T08:00:00Z'));
  assert.equal(parseWhen('tomorrow', T0), null);
  assert.equal(parseWhen('', T0), null);
  assert.deepEqual(intentionSettings({ intentions: { maxOpen: 3 } }), { ...DEFAULTS, maxOpen: 3 });
});

test('createIntention: the members of the conversation are kept in the provenance, distinct, ids only', () => {
  const made = createIntention({
    purpose: 'x',
    provenance: wrongly({ kind: 'self', participants: ['u2', 'u2', 7, '', 'u3'] }),
    now: T0,
  });
  assert.deepEqual(present(made.intention).provenance.participants, ['u2', 'u3']);
  assert.equal('participants' in mine().provenance, false, 'none given, none kept');
});

test('concernsMember: the destination, a participant, the id or a name of theirs in its words; nothing else', () => {
  const base = {
    purpose: 'φέρε το άρθρο',
    provenance: { kind: 'self', span: 'θα το φέρω', participants: ['u5'] },
    now: T0,
  };
  const record = createIntention(wrongly(base)).intention;
  assert.equal(concernsMember(wrongly(record), { accountId: 'u5' }), true, 'a participant of the conversation');
  assert.equal(concernsMember(wrongly(record), { accountId: 'u6' }), false);
  assert.equal(
    concernsMember(wrongly(createIntention(wrongly({ ...base, destination: 'u6' })).intention), { accountId: 'u6' }),
    true,
    'the destination'
  );
  assert.equal(
    concernsMember(
      wrongly(createIntention(wrongly({ ...base, purpose: 'ρώτα τον <@123456789012345678>' })).intention),
      {
        accountId: '123456789012345678',
      }
    ),
    true,
    'the token'
  );
  const named = createIntention(wrongly({ ...base, purpose: 'στείλε στη Ζωή το βίντεο' })).intention;
  assert.equal(
    concernsMember(wrongly(named), { accountId: 'u7', names: ['ζωη'] }),
    true,
    'a name, accents folded, a whole word'
  );
  assert.equal(
    concernsMember(wrongly(named), { accountId: 'u7', names: ['Ζω'] }),
    false,
    'a name under three letters is not matched'
  );
  assert.equal(
    concernsMember(wrongly(createIntention(wrongly({ ...base, purpose: 'Ζωήρα' })).intention), {
      accountId: 'u7',
      names: ['Ζωή'],
    }),
    false,
    'not inside another word'
  );
  const spoken = createIntention({
    ...base,
    provenance: wrongly({ ...base.provenance, span: 'θα το πω στη Ζωή' }),
  }).intention;
  assert.equal(concernsMember(wrongly(spoken), { accountId: 'u7', names: ['Ζωή'] }), true, 'the quoted span');
  assert.equal(concernsMember(wrongly(record), { accountId: '' }), false);
});

test('isIntentionId: one bare token of i + hex digits, as newIntentionId makes them; nothing else', () => {
  assert.equal(isIntentionId(newIntentionId()), true);
  assert.equal(isIntentionId(' i00000001 '), true, 'surrounding blanks are not the token');
  assert.equal(isIntentionId('I0A1B2C3D'), true);
  for (const bad of ['i', 'i1 done', 'done i1', 'x1', 'i00000001\nnote', '', null, 7, 'ig000000'])
    assert.equal(isIntentionId(bad), false, String(bad));
});

// ---- recurring intentions (`every`) ------------------------------------------------

const ATHENS = 'Europe/Athens';
/** The instant the wall clock of ATHENS reads `date` `HH:MM`. */
const athens = (date: Untyped, hhmm: Untyped) =>
  zonedEpoch(date, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3)), ATHENS);

test('parseEvery: day, week, <n>h, <n>d as her words; none clears; anything else is bad-every', () => {
  assert.deepEqual(parseEvery('day'), { ok: true, every: { period: 'day', at: null } });
  assert.deepEqual(parseEvery(' Week '), { ok: true, every: { period: 'week', at: null } });
  assert.deepEqual(parseEvery('12h'), { ok: true, every: { period: '12h', at: null } });
  assert.deepEqual(parseEvery('3d'), { ok: true, every: { period: '3d', at: null } });
  assert.deepEqual(parseEvery('none'), { ok: true, every: null });
  for (const bad of ['', 'hourly', '0h', '2w', 'day 21:00', 7, null])
    assert.deepEqual(parseEvery(bad), { ok: false, code: 'bad-every' }, String(bad));
});

test('parseWhen: a wall-clock time is the next such moment in the timezone; a weekday and time the next such weekday', () => {
  // T0 is 2026-10-18 13:00 in Athens (EEST, UTC+3), a Sunday.
  assert.equal(parseWhen('21:00', T0, { timezone: ATHENS }), athens('2026-10-18', '21:00'), 'later today');
  assert.equal(parseWhen('09:30', T0, { timezone: ATHENS }), athens('2026-10-19', '09:30'), 'already past: tomorrow');
  assert.equal(
    parseWhen('13:00', T0, { timezone: ATHENS }),
    athens('2026-10-19', '13:00'),
    'exactly now counts as past'
  );
  assert.equal(parseWhen('mon 20:00', T0, { timezone: ATHENS }), athens('2026-10-19', '20:00'));
  assert.equal(parseWhen('Sun 20:00', T0, { timezone: ATHENS }), athens('2026-10-18', '20:00'), 'today, still ahead');
  assert.equal(
    parseWhen('sun 10:00', T0, { timezone: ATHENS }),
    athens('2026-10-25', '10:00'),
    'today, already past: next week'
  );
  assert.equal(parseWhen('21:00', T0), T0 + 11 * HOUR, 'no timezone: UTC');
  for (const bad of ['25:00', '21:60', 'mon', 'someday 20:00', 'mon 9'])
    assert.equal(parseWhen(bad, T0, { timezone: ATHENS }), null, bad);
});

test('nextOccurrence: a daily 21:00 keeps 21:00 across the autumn DST change; pinEvery takes the time from the first due', () => {
  const first = athens('2026-10-23', '21:00');
  const every = pinEvery(wrongly(parseEvery('day').every), first, ATHENS);
  assert.deepEqual(every, { period: 'day', at: '21:00' });
  const record = { every, dueAt: first, expiresAt: first + 30 * DAY };
  const d24 = nextOccurrence(record, first, ATHENS);
  assert.equal(d24, athens('2026-10-24', '21:00'));
  assert.equal(d24 - first, 24 * HOUR, 'still summer time');
  const d25 = nextOccurrence(record, d24, ATHENS);
  assert.equal(d25, athens('2026-10-25', '21:00'));
  assert.equal(d25 - d24, 25 * HOUR, 'the clocks went back: 21:00 wall time is an hour later in UTC');
  assert.equal(new Date(d25).toISOString(), '2026-10-25T19:00:00.000Z');
  // After now, never at it: the occurrence due exactly now is this one, the next is tomorrow's.
  assert.equal(nextOccurrence(record, d25, ATHENS), athens('2026-10-26', '21:00'));
  assert.equal(
    nextOccurrence({ every: { period: 'day', at: null }, dueAt: first }, first, ATHENS),
    d24,
    "no pinned time: the first due's wall clock"
  );
});

test('nextOccurrence: a weekly mon 20:00 steps by seven days of the same weekday; 12h steps from the last due instant', () => {
  const monday = parseWhen('mon 20:00', T0, { timezone: ATHENS });
  const weekly = { every: pinEvery({ period: 'week', at: null }, monday, ATHENS), dueAt: monday };
  const next = nextOccurrence(weekly, wrongly(monday), ATHENS);
  assert.equal(next, athens('2026-10-26', '20:00'));
  assert.equal(new Date(next).getUTCDay(), 1);
  assert.equal(next - present(monday), 7 * DAY + HOUR, 'the DST change lies between: the wall time holds');
  assert.equal(nextOccurrence(weekly, present(monday) + 3 * DAY, ATHENS), athens('2026-10-26', '20:00'));
  assert.equal(
    nextOccurrence(weekly, present(monday) + 10 * DAY, ATHENS),
    athens('2026-11-02', '20:00'),
    'a week skipped'
  );
  const twelve = { every: { period: '12h', at: null }, dueAt: T0 };
  assert.equal(nextOccurrence(twelve, T0, 'UTC'), T0 + 12 * HOUR);
  assert.equal(nextOccurrence(twelve, T0 + 12 * HOUR, 'UTC'), T0 + 24 * HOUR);
  assert.equal(nextOccurrence(twelve, T0 + 30 * HOUR, 'UTC'), T0 + 36 * HOUR, 'two steps skipped');
  assert.equal(nextOccurrence({ every: { period: '3d', at: null }, dueAt: T0 }, T0 + 1, 'UTC'), T0 + 3 * DAY);
  assert.equal(nextOccurrence({ every: null, dueAt: T0 }, T0, 'UTC'), null, 'a one-off has no next occurrence');
});

test('createIntention: a recurring one needs a due time, lives recurringExpiresDays and is never done; a bad every is refused', () => {
  const every = { period: 'day', at: '21:00' };
  const made = createIntention({
    purpose: 'ψάξε για memes',
    provenance: { kind: 'self' },
    dueAt: T0 + 8 * HOUR,
    every,
    now: T0,
    id: 'r1',
  });
  assert.equal(made.ok, true, wrongly(made.code));
  assert.deepEqual(made.intention.every, every);
  assert.equal(made.intention.expiresAt, T0 + DEFAULTS.recurringExpiresDays * DAY);
  assert.equal(DEFAULTS.recurringExpiresDays, 30);
  assert.equal(
    createIntention({ purpose: 'x', provenance: { kind: 'self' }, every, now: T0 }).code,
    'every-without-due'
  );
  assert.equal(
    createIntention({
      purpose: 'x',
      provenance: { kind: 'self' },
      dueAt: T0 + HOUR,
      every: { period: 'hourly', at: null },
      now: T0,
    }).code,
    'bad-every'
  );
  assert.equal(
    createIntention({ purpose: 'x', provenance: { kind: 'self' }, dueAt: T0 + HOUR, every: wrongly('day'), now: T0 })
      .code,
    'bad-every'
  );
  assert.equal(checkInvariants({ ...made.intention, dueAt: null }), 'every-without-due');
  assert.equal(checkInvariants({ ...made.intention, status: 'done' }), 'recurring-done');
  assert.equal(transition(made.intention, 'done', { now: T0 + 9 * HOUR }).code, 'recurring-done');
  assert.equal(
    present(transition(made.intention, 'cancelled', { now: T0 + 9 * HOUR }).intention).status,
    'cancelled',
    'a cancel ends it'
  );
  assert.equal(
    present(expireAt(made.intention, made.intention.expiresAt).intention).status,
    'expired',
    'an expiry ends it'
  );
  const oneOff = createIntention({
    purpose: 'x',
    provenance: { kind: 'self' },
    dueAt: T0 + HOUR,
    every: null,
    now: T0,
  });
  assert.equal(present(oneOff.intention).every, null);
  assert.equal(present(oneOff.intention).expiresAt, T0 + DEFAULTS.expiresDays * DAY);
  assert.equal(intentionSettings({ intentions: { recurringExpiresDays: 10 } }).recurringExpiresDays, 10);
});

test('advanceOccurrence: the due moves past now, skipping missed occurrences; the occurrence code goes to the history; done closes only the occurrence', () => {
  const first = T0 + 8 * HOUR;
  const record = createIntention({
    purpose: 'ψάξε για memes',
    provenance: { kind: 'self' },
    dueAt: first,
    every: { period: 'day', at: null },
    now: T0,
    id: 'r1',
  }).intention;
  const done = advanceOccurrence(wrongly(record), {
    now: first + 5 * 60_000,
    timezone: 'UTC',
    code: 'done-occurrence',
  });
  assert.equal(done.ok, true, wrongly(done.code));
  assert.equal(done.intention.status, 'pending', 'never done');
  assert.equal(done.intention.dueAt, first + DAY);
  assert.deepEqual(done.intention.history.at(-1), {
    at: first + 5 * 60_000,
    from: 'pending',
    to: 'pending',
    by: 'persona',
    code: 'done-occurrence',
  });
  // Three days of silence: the occurrences in between are not replayed, the next one is after now.
  const missed = advanceOccurrence(done.intention, {
    now: first + 3 * DAY + HOUR,
    timezone: 'UTC',
    code: 'missed',
    by: 'engine',
  });
  assert.equal(present(missed.intention).dueAt, first + 4 * DAY);
  assert.equal(present(present(missed.intention).history.at(-1)).code, 'missed');
  assert.equal(present(present(missed.intention).history.at(-1)).by, 'engine');
  // A waiting occurrence closes its wait on the way (the errand kept as lastErrandId).
  const waiting = waitOn(wrongly(record), { errandId: 'tabc', deadline: first + HOUR, now: first }).intention;
  const closed = advanceOccurrence(wrongly(waiting), { now: first + 10, timezone: 'UTC', code: 'done-occurrence' });
  assert.equal(present(closed.intention).status, 'pending');
  assert.equal(present(closed.intention).awaitingErrandId, null);
  assert.equal(present(closed.intention).lastErrandId, 'tabc');
  assert.equal(checkInvariants(closed.intention), null);
  // A note of a past occurrence is cleared, an outcome kept only when asked (the wait's end).
  const noted = { ...record, note: 'wait-deadline', outcome: { errandId: 'tabc', state: 'done', at: first } };
  assert.equal(
    present(advanceOccurrence(wrongly(noted), { now: first + 1, timezone: 'UTC', code: 'recurred' }).intention).note,
    null
  );
  assert.equal(
    present(advanceOccurrence(wrongly(noted), { now: first + 1, timezone: 'UTC', code: 'recurred' }).intention).outcome,
    null
  );
  assert.deepEqual(
    present(
      advanceOccurrence(wrongly(noted), { now: first + 1, timezone: 'UTC', code: 'recurred', keepWaitEnd: true })
        .intention
    ).outcome,
    noted.outcome
  );
  // Not for a one-off, nor out of a terminal status.
  assert.equal(
    advanceOccurrence(mine({ dueAt: first }), { now: first + 1, timezone: 'UTC', code: 'recurred' }).code,
    'not-recurring'
  );
  assert.equal(
    advanceOccurrence(wrongly(transition(wrongly(record), 'cancelled', { now: T0 }).intention), {
      now: first + 1,
      timezone: 'UTC',
      code: 'recurred',
    }).code,
    'terminal'
  );
});

test('advanceOccurrence: expiry wins over the next due -- the last occurrence before expiry advances past it and the clock expires the record', () => {
  const first = T0 + HOUR;
  const record = createIntention({
    purpose: 'x',
    provenance: { kind: 'self' },
    dueAt: first,
    every: { period: 'day', at: null },
    expiresAt: first + 36 * HOUR,
    now: T0,
    id: 'r2',
  }).intention;
  const second = advanceOccurrence(wrongly(record), { now: first + 1, timezone: 'UTC', code: 'recurred' }).intention;
  assert.equal(present(second).dueAt, first + DAY, 'the second occurrence lies before the expiry');
  assert.ok(
    present(nextOccurrence(wrongly(second), wrongly(present(second).dueAt), 'UTC')) > present(second).expiresAt,
    'the second is the last occurrence'
  );
  const after = advanceOccurrence(wrongly(second), {
    now: present(present(second).dueAt) + 1,
    timezone: 'UTC',
    code: 'done-occurrence',
  }).intention;
  assert.ok(present(present(after).dueAt) > present(after).expiresAt);
  assert.deepEqual(dueList([after], present(after).expiresAt - 1), [], 'nothing is due before the expiry');
  assert.equal(present(expireAt(wrongly(after), present(after).expiresAt).intention).status, 'expired');
  assert.equal(expireAt(wrongly(after), present(present(after).dueAt) - HOUR).changed, true, 'the expiry comes first');
});

// ---- attention: an intention of kind attend ----------------------------------------------

test('attend: her own intention with a place is an attention with the defaults filled; no due, no recurrence', () => {
  const made = createIntention({
    purpose: 'listen to the garden talk',
    provenance: { kind: 'self' },
    attend: { place: 'c-garden' },
    now: T0,
    id: 'ia1',
  });
  assert.equal(made.ok, true, wrongly(made.code));
  assert.equal(isAttend(made.intention), true);
  assert.deepEqual(made.intention.attend, {
    place: 'c-garden',
    people: [],
    settle: ATTEND_DEFAULTS.settleSeconds,
    perDay: ATTEND_DEFAULTS.perDayDefault,
    today: null,
  });
  assert.equal(made.intention.dueAt, null);
  assert.equal(
    made.intention.expiresAt,
    T0 + DEFAULTS.expiresDays * DAY,
    'an attention ends like any intention of hers'
  );
  assert.equal(checkInvariants(made.intention), null);
  assert.equal(isAttend(mine()), false);
  assert.equal(mine().attend, null);
  // Her own numbers and people, the defaults from the live config.
  const own = createIntention({
    purpose: 'p',
    provenance: { kind: 'self' },
    attend: { place: 'c-garden', people: ['u1', 'u1', ' u2 ', 7], settle: 0, perDay: 3 },
    now: T0,
    settings: { ...DEFAULTS, attention: { settleSeconds: 30, perDayDefault: 5 } },
  });
  assert.deepEqual(present(own.intention).attend, {
    place: 'c-garden',
    people: ['u1', 'u2', '7'],
    settle: 0,
    perDay: 3,
    today: null,
  });
  const configured = createIntention({
    purpose: 'p',
    provenance: { kind: 'self' },
    attend: { place: 'c-garden' },
    now: T0,
    settings: { ...DEFAULTS, attention: { settleSeconds: 30, perDayDefault: 5 } },
  });
  assert.deepEqual(
    [present(present(configured.intention).attend).settle, present(present(configured.intention).attend).perDay],
    [30, 5]
  );
  // The codes.
  const code = (extra: Record<string, Untyped>) =>
    createIntention({ purpose: 'p', provenance: { kind: 'self' }, now: T0, ...extra }).code;
  assert.equal(code({ attend: { place: '' } }), 'bad-attend');
  assert.equal(code({ attend: { place: 'c', settle: -1 } }), 'bad-attend');
  assert.equal(code({ attend: { place: 'c', perDay: 0 } }), 'bad-attend');
  assert.equal(code({ attend: { place: 'c', perDay: 1.5 } }), 'bad-attend');
  assert.equal(code({ attend: { place: 'c', people: 'u1' } }), 'bad-attend');
  assert.equal(code({ attend: 'c-garden' }), 'bad-attend');
  assert.equal(code({ attend: { place: 'c' }, dueAt: T0 + HOUR }), 'attend-with-due');
  assert.equal(code({ attend: { place: 'c' }, every: { period: 'day', at: null } }), 'attend-with-every');
});

test('attend: the invariants hold on every move; validAttend and normalizeAttend check the shape', () => {
  const record = createIntention({
    purpose: 'p',
    provenance: { kind: 'self' },
    attend: { place: 'c-garden' },
    now: T0,
    id: 'ia2',
  }).intention;
  assert.equal(checkInvariants({ ...record, dueAt: T0 }), 'attend-with-due');
  assert.equal(checkInvariants({ ...record, every: { period: 'day', at: null }, dueAt: null }), 'attend-with-every');
  assert.equal(checkInvariants({ ...record, attend: { ...present(record).attend, perDay: 0 } }), 'bad-attend');
  assert.equal(
    transition(wrongly(record), 'done', { now: T0 + HOUR, patch: { dueAt: T0 } }).code,
    'attend-with-due',
    'a patch cannot give an attention a due time'
  );
  assert.equal(present(transition(wrongly(record), 'cancelled', { now: T0 + HOUR }).intention).status, 'cancelled');
  assert.equal(validAttend(null), true);
  assert.equal(
    validAttend({ place: 'c', people: [], settle: 90, perDay: 12, today: { day: '2026-10-18', wakes: 2 } }),
    true
  );
  assert.equal(validAttend({ place: 'c', people: [], settle: 90, perDay: 12, today: { day: '2026-10-18' } }), false);
  assert.equal(validAttend({ place: 'c', people: [''], settle: 90, perDay: 12, today: null }), false);
  assert.equal(normalizeAttend({ place: 'c', people: [{}] }), null, 'an object is no id');
  assert.deepEqual(normalizeAttend({ place: 'c', people: ['', 'u1', ''] }, { settleSeconds: 10, perDayDefault: 2 }), {
    place: 'c',
    people: ['u1'],
    settle: 10,
    perDay: 2,
    today: null,
  });
  assert.equal(
    present(normalizeAttend({ place: 'c', people: Array.from({ length: 30 }, (_, i) => `u${i}`) })).people.length,
    20,
    'at most ATTEND_PEOPLE_MAX people'
  );
});

test('attend: the per-day counter counts on its local day and starts again on the next', () => {
  const record = createIntention({
    purpose: 'p',
    provenance: { kind: 'self' },
    attend: { place: 'c-garden', perDay: 2 },
    now: T0,
    id: 'ia3',
  }).intention;
  assert.deepEqual(attendCounter(record, '2026-10-18'), { day: '2026-10-18', wakes: 0 });
  const once = bumpAttend(wrongly(record), '2026-10-18');
  assert.equal(once.ok, true);
  assert.deepEqual(present(once.intention.attend).today, { day: '2026-10-18', wakes: 1 });
  const twice = bumpAttend(once.intention, '2026-10-18').intention;
  assert.deepEqual(attendCounter(twice, '2026-10-18'), { day: '2026-10-18', wakes: 2 });
  assert.deepEqual(attendCounter(twice, '2026-10-19'), { day: '2026-10-19', wakes: 0 }, 'a new day, a fresh count');
  assert.deepEqual(present(present(bumpAttend(wrongly(twice), '2026-10-19').intention).attend).today, {
    day: '2026-10-19',
    wakes: 1,
  });
  assert.equal(checkInvariants(twice), null);
  assert.equal(bumpAttend(mine(), '2026-10-18').code, 'not-attend');
  assert.equal(
    dueList([twice], T0 + DAY).length,
    0,
    "an attention is never due: the scheduler lists its place's lines instead"
  );
});

test('attend: a forget of one of the attended people takes the attention out', () => {
  const record = createIntention({
    purpose: 'listen',
    provenance: { kind: 'self' },
    attend: { place: 'c-garden', people: ['u9'] },
    now: T0,
    id: 'ia4',
  }).intention;
  assert.equal(concernsMember(wrongly(record), { accountId: 'u9' }), true);
  assert.equal(concernsMember(wrongly(record), { accountId: 'u8' }), false);
});

test('dropped: any open record can be dropped with a reason; it is final, never due, never expires, and needs a reason', () => {
  const own = mine({ dueAt: T0 + HOUR });
  assert.equal(dropIntention(own, { reason: '  ', now: T0 + 1 }).code, 'reason-required');
  const dropped = dropIntention(own, { reason: 'changed my mind about it', now: T0 + 1 });
  assert.equal(dropped.ok, true, wrongly(dropped.code));
  assert.deepEqual(
    [dropped.intention.status, dropped.intention.reason, dropped.intention.droppedAt],
    ['dropped', 'changed my mind about it', T0 + 1]
  );
  assert.equal(present(dropped.intention.history.at(-1)).to, 'dropped');
  assert.equal(checkInvariants(dropped.intention), null);
  assert.equal(checkInvariants({ ...dropped.intention, reason: '' }), 'reason-required');
  for (const to of ['pending', 'waiting', 'cancelled', 'expired', 'done', 'dropped'])
    assert.equal(transition(dropped.intention, wrongly(to), { now: T0 + 2 }).code, 'terminal');
  assert.equal(dropIntention(dropped.intention, { reason: 'again', now: T0 + 2 }).code, 'terminal');
  assert.deepEqual(dueList([dropped.intention], T0 + 2 * HOUR), []);
  assert.equal(expireAt(dropped.intention, dropped.intention.expiresAt + 1).changed, false);
  const waiting = waitOn(mine({ id: 'i2' }), { errandId: 't1', deadline: T0 + HOUR, now: T0 }).intention;
  const fromWait = dropIntention(wrongly(waiting), { reason: 'not needed', now: T0 + 5 }).intention;
  assert.deepEqual(
    [present(fromWait).status, present(fromWait).awaitingErrandId, present(fromWait).waitDeadline],
    ['dropped', null, null]
  );
  assert.equal(
    present(present(dropIntention(mine({ id: 'i4' }), { reason: 'x'.repeat(400), now: T0 }).intention).reason).length,
    300
  );
});

test('createIntention dropped: born dropped with its reason, no due or recurrence; her own only', () => {
  const base = {
    purpose: 'πήγαινε στην παραλία',
    provenance: { kind: 'self', turnId: 't1' },
    now: T0,
    id: 'i1',
    dropped: true,
  };
  assert.equal(createIntention(wrongly(base)).code, 'reason-required');
  assert.equal(
    createIntention(wrongly({ ...base, reason: 'too cold', provenance: { kind: 'candidate' } })).code,
    'bad-provenance'
  );
  const made = createIntention(
    wrongly({ ...base, reason: 'too cold', dueAt: T0 + HOUR, every: { period: 'day', at: null } })
  );
  assert.equal(made.ok, true, wrongly(made.code));
  assert.deepEqual(
    [
      made.intention.status,
      made.intention.reason,
      made.intention.dueAt,
      made.intention.every,
      made.intention.droppedAt,
    ],
    ['dropped', 'too cold', null, null, T0]
  );
  assert.equal(checkInvariants(made.intention), null);
  assert.equal(made.intention.expiresAt, T0);
});

test('a standing task outlives the recurring limit, is skipped forward, and needs a recurrence', () => {
  // Bug: a task the owner wants for good silently expires after 30 days, or an ordinary intention stops expiring.
  const every = { period: 'day', at: '21:00' };
  const made = createIntention({
    purpose: 'κάθε μέρα',
    provenance: { kind: 'self' },
    dueAt: T0 + HOUR,
    every,
    standing: true,
    now: T0,
    id: 's1',
  });
  if (!made.ok) throw new Error(made.code);
  const standing = made.intention;
  assert.equal(standing.standing, true);
  const later = T0 + 400 * DAY;
  assert.equal(expireAt(standing, later).intention?.status, standing.status, 'still open after 400 days');
  const moved = advanceOccurrence(standing, { now: later, by: 'engine', code: 'done-occurrence' });
  assert.ok((moved.intention?.dueAt ?? 0) > later, 'the missed occurrences are skipped, none replayed');
  assert.equal(moved.intention?.expiresAt, STANDING_EXPIRES_AT);
  assert.equal(
    transition(standing, 'cancelled', { now: later, by: 'persona', code: 'cancelled' }).intention?.status,
    'cancelled'
  );
  assert.equal(createIntention({ purpose: 'x', provenance: { kind: 'self' }, standing: true, now: T0 }).ok, false);
  const ordinary = createIntention({
    purpose: 'y',
    provenance: { kind: 'self' },
    dueAt: T0 + HOUR,
    every,
    now: T0,
    id: 'o1',
  });
  if (!ordinary.ok) throw new Error(ordinary.code);
  assert.equal(expireAt(ordinary.intention, later).intention?.status, 'expired');
});
