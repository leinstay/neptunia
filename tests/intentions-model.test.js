// Tests for src/intentions/model.js: the persona's intentions as pure data. A record is created
// with an expiry, moves only along the allowed transitions, never out of a terminal status, waits
// only on a real errand with a deadline, comes back to pending once (and only once) its errand
// ends, expires by the clock, and is listed when due. Candidates are anchored to her own lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  acceptRefusal,
  arrive,
  candidatesFromAnswer,
  checkInvariants,
  concernsMember,
  createIntention,
  dueList,
  duplicates,
  expireAt,
  intentionSettings,
  parseWhen,
  reconcileWait,
  transition,
  waitOn,
} from '../src/intentions/model.js';
import { lineSourcesOf } from '../src/intentions/sources.js';

const T0 = Date.parse('2026-10-18T10:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function mine(extra = {}) {
  const made = createIntention({ purpose: 'βρες το άρθρο για την Ζωή', provenance: { kind: 'self', turnId: 't1' }, now: T0, id: 'i1', ...extra });
  assert.equal(made.ok, true, made.code);
  return made.intention;
}

test('createIntention: her own is pending with the default expiry; a candidate is proposed with its shorter one', () => {
  const own = mine();
  assert.equal(own.status, 'pending');
  assert.equal(own.expiresAt, T0 + DEFAULTS.expiresDays * DAY);
  assert.deepEqual(own.provenance, { kind: 'self', turnId: 't1', scope: 'group' });
  assert.deepEqual(own.history, [{ at: T0, to: 'pending', by: 'persona' }]);
  const made = createIntention({ purpose: 'ρώτα τον Νίκο αύριο', provenance: { kind: 'candidate', turnId: null, messageId: 'm9', span: 'θα ρωτήσω' }, now: T0, settings: { ...DEFAULTS, candidateExpiresHours: 6 } });
  assert.equal(made.intention.status, 'proposed');
  assert.equal(made.intention.expiresAt, T0 + 6 * HOUR);
  assert.equal(made.intention.provenance.span, 'θα ρωτήσω');
  assert.equal(made.intention.provenance.messageId, 'm9');
});

test('createIntention: refuses an empty purpose, an unknown provenance, a past expiry and a due time after the expiry', () => {
  const base = { provenance: { kind: 'self' }, now: T0 };
  assert.equal(createIntention({ ...base, purpose: '  ' }).code, 'no-purpose');
  assert.equal(createIntention({ ...base, purpose: 'x', provenance: { kind: 'quoted' } }).code, 'bad-provenance');
  assert.equal(createIntention({ ...base, purpose: 'x', expiresAt: T0 }).code, 'bad-expiry');
  assert.equal(createIntention({ ...base, purpose: 'x', dueAt: T0 + 2 * HOUR, expiresAt: T0 + HOUR }).code, 'due-after-expiry');
});

test('waitOn: waiting needs a real errand id and a deadline after now; the invariant holds on every record', () => {
  const own = mine();
  assert.equal(waitOn(own, { taskId: '', deadline: T0 + HOUR, now: T0 }).code, 'wait-without-task');
  assert.equal(waitOn(own, { taskId: 'tabc', deadline: T0, now: T0 }).code, 'bad-deadline');
  const waited = waitOn(own, { taskId: 'tabc', deadline: T0 + HOUR, now: T0 });
  assert.equal(waited.intention.status, 'waiting');
  assert.equal(waited.intention.awaitingTaskId, 'tabc');
  assert.equal(checkInvariants(waited.intention), null);
  assert.equal(checkInvariants({ ...waited.intention, waitDeadline: null }), 'wait-without-deadline');
  assert.equal(checkInvariants({ ...waited.intention, awaitingTaskId: null }), 'wait-without-task');
  assert.equal(checkInvariants({ ...own, expiresAt: null }), 'no-expiry');
  // A plain transition to waiting without them is refused by the same invariant.
  assert.equal(transition(own, 'waiting', { now: T0 }).code, 'wait-without-task');
});

test('transition: terminal statuses are final; a move its status does not allow is refused', () => {
  const own = mine();
  const done = transition(own, 'done', { now: T0 + 1 }).intention;
  for (const to of ['pending', 'waiting', 'cancelled', 'expired', 'done']) assert.equal(transition(done, to, { now: T0 + 2 }).code, 'terminal');
  const proposed = createIntention({ purpose: 'x', provenance: { kind: 'candidate' }, now: T0 }).intention;
  assert.equal(transition(proposed, 'done', { now: T0 }).code, 'bad-move', 'a candidate is accepted or rejected, never done');
  assert.equal(transition(proposed, 'pending', { now: T0, code: 'accepted' }).intention.status, 'pending');
});

test('arrive: the awaited errand ending moves the wait back to pending once; a second delivery changes nothing', () => {
  const waiting = waitOn(mine(), { taskId: 'tabc', deadline: T0 + HOUR, now: T0 }).intention;
  const other = arrive(waiting, { id: 'tzzz', state: 'done' }, { now: T0 + 1 });
  assert.equal(other.changed, false);
  const stillOpen = arrive(waiting, { id: 'tabc', state: 'running' }, { now: T0 + 1 });
  assert.equal(stillOpen.changed, false);
  const first = arrive(waiting, { id: 'tabc', state: 'failed', error: 'restarted', endedAt: T0 + 5 }, { now: T0 + 10 });
  assert.equal(first.changed, true);
  assert.equal(first.intention.status, 'pending');
  assert.deepEqual(first.intention.outcome, { taskId: 'tabc', state: 'failed', error: 'restarted', at: T0 + 5 });
  assert.equal(first.intention.awaitingTaskId, null);
  assert.equal(first.intention.lastTaskId, 'tabc');
  const again = arrive(first.intention, { id: 'tabc', state: 'failed', error: 'restarted' }, { now: T0 + 20 });
  assert.equal(again.changed, false);
  assert.equal(again.intention, first.intention);
});

test('reconcileWait: a gone errand, an ended one and a passed deadline each move the wait to pending with its note', () => {
  const waiting = waitOn(mine(), { taskId: 'tabc', deadline: T0 + HOUR, now: T0 }).intention;
  assert.equal(reconcileWait(waiting, { taskOf: () => null, now: T0 + 1 }).intention.note, 'task-missing');
  assert.equal(reconcileWait(waiting, { taskOf: () => ({ id: 'tabc', state: 'done' }), now: T0 + 1 }).intention.note, 'task-done');
  assert.equal(reconcileWait(waiting, { taskOf: () => ({ id: 'tabc', state: 'running' }), now: T0 + 1 }).changed, false);
  assert.equal(reconcileWait(waiting, { taskOf: () => ({ id: 'tabc', state: 'running' }), now: T0 + HOUR }).intention.note, 'wait-deadline');
});

test('expireAt and dueList: the clock expires an open record; due and overdue are listed, candidates never', () => {
  const own = mine({ dueAt: T0 + HOUR });
  assert.equal(expireAt(own, own.expiresAt - 1).changed, false);
  assert.equal(expireAt(own, own.expiresAt).intention.status, 'expired');
  const waiting = waitOn(mine({ id: 'i2' }), { taskId: 't1', deadline: T0 + 30 * 60 * 1000, now: T0 }).intention;
  const proposed = createIntention({ purpose: 'y', provenance: { kind: 'candidate' }, dueAt: T0, now: T0 }).intention;
  assert.deepEqual(dueList([own, waiting, proposed], T0), []);
  assert.deepEqual(dueList([own, waiting, proposed], T0 + 2 * HOUR).map((entry) => [entry.intention.id, entry.reason]), [['i2', 'wait-deadline'], ['i1', 'due']]);
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

test('candidatesFromAnswer: only spans of her own lines are kept, with that line; a quote of another line and an unanchored span are dropped; capped', () => {
  const messages = [
    { id: 'm1', channelId: 'c1', authorId: 'u1', self: false, content: 'μπορείς να βρεις το βίντεο;', ts: T0 - 3000 },
    { id: 'm2', channelId: 'c1', authorId: 'bot', self: true, content: 'Ναι, θα το ψάξω απόψε και θα σου πω', ts: T0 - 2000 },
    { id: 'm3', channelId: 'c1', authorId: 'bot', self: true, content: 'μπορείς να βρεις το βίντεο;', ts: T0 - 1000 },
  ];
  const raw = [
    { span: 'θα το ψάξω απόψε', purpose: 'find the video tonight' },
    { span: 'μπορείς να βρεις το βίντεο', purpose: 'echoes the request' },
    { span: 'never said', purpose: 'invented' },
    { span: '', purpose: 'no span' },
    { span: 'θα σου πω', purpose: 'tell them' },
  ];
  const { candidates, dropped } = candidatesFromAnswer(raw, messages, { max: 1 });
  assert.deepEqual(candidates, [{ purpose: 'find the video tonight', span: 'θα το ψάξω απόψε', messageId: 'm2', channelId: 'c1', ts: T0 - 2000, participants: ['u1'], origin: 'own', turnId: null }]);
  assert.deepEqual(dropped, { invalid: 1, unanchored: 1, quoted: 1, over: 1 });
  assert.deepEqual(candidatesFromAnswer('nope', messages, { max: 5 }).candidates, []);
});

test('duplicates: the same purpose or the same line and span as an open intention; a closed one does not count', () => {
  const own = mine();
  assert.equal(duplicates({ purpose: '  Βρες  το άρθρο για την Ζωή ' }, [own]), true);
  const candidate = createIntention({ purpose: 'a', provenance: { kind: 'candidate', messageId: 'm2', span: 'θα το ψάξω' }, now: T0 }).intention;
  assert.equal(duplicates({ purpose: 'b', messageId: 'm2', span: 'Θα το ψάξω' }, [candidate]), true);
  const closed = transition(own, 'cancelled', { now: T0 }).intention;
  assert.equal(duplicates({ purpose: 'βρες το άρθρο για την Ζωή' }, [closed]), false);
});

test('createIntention: the members of the conversation are kept in the provenance, distinct, ids only', () => {
  const made = createIntention({ purpose: 'x', provenance: { kind: 'self', participants: ['u2', 'u2', 7, '', 'u3'] }, now: T0 });
  assert.deepEqual(made.intention.provenance.participants, ['u2', 'u3']);
  assert.equal('participants' in mine().provenance, false, 'none given, none kept');
});

test('candidatesFromAnswer: the participants of a candidate are the other authors of its channel in the batch', () => {
  const messages = [
    { id: 'm1', channelId: 'c1', authorId: 'u1', self: false, content: 'έλα', ts: T0 - 3000 },
    { id: 'm2', channelId: 'c2', authorId: 'u2', self: false, content: 'άλλο κανάλι', ts: T0 - 2500 },
    { id: 'm3', channelId: 'c1', authorId: 'bot', self: true, content: 'θα έρθω μετά', ts: T0 - 2000 },
  ];
  const { candidates } = candidatesFromAnswer([{ span: 'θα έρθω μετά', purpose: 'come later' }], messages, { max: 5 });
  assert.deepEqual(candidates[0].participants, ['u1']);
});

test('concernsMember: the destination, a participant, the id or a name of theirs in its words; nothing else', () => {
  const base = { purpose: 'φέρε το άρθρο', provenance: { kind: 'candidate', span: 'θα το φέρω', participants: ['u5'] }, now: T0 };
  const record = createIntention(base).intention;
  assert.equal(concernsMember(record, { userId: 'u5' }), true, 'a participant of the conversation');
  assert.equal(concernsMember(record, { userId: 'u6' }), false);
  assert.equal(concernsMember(createIntention({ ...base, destination: 'u6' }).intention, { userId: 'u6' }), true, 'the destination');
  assert.equal(concernsMember(createIntention({ ...base, purpose: 'ρώτα τον <@123456789012345678>' }).intention, { userId: '123456789012345678' }), true, 'the token');
  const named = createIntention({ ...base, purpose: 'στείλε στη Ζωή το βίντεο' }).intention;
  assert.equal(concernsMember(named, { userId: 'u7', names: ['ζωη'] }), true, 'a name, accents folded, a whole word');
  assert.equal(concernsMember(named, { userId: 'u7', names: ['Ζω'] }), false, 'a name under three letters is not matched');
  assert.equal(concernsMember(createIntention({ ...base, purpose: 'Ζωήρα' }).intention, { userId: 'u7', names: ['Ζωή'] }), false, 'not inside another word');
  const spoken = createIntention({ ...base, provenance: { ...base.provenance, span: 'θα το πω στη Ζωή' } }).intention;
  assert.equal(concernsMember(spoken, { userId: 'u7', names: ['Ζωή'] }), true, 'the quoted span');
  assert.equal(concernsMember(record, { userId: '' }), false);
});

test('candidatesFromAnswer: a candidate from outside material is external -- her inner-turn finding, a line whose turn read something, words shared with what her turn saw; unknown under strict', () => {
  const page = 'Πανηγύρι. Οι αναγνώστες να θυμίζουν σε όλους κάθε μέρα την κλήρωση του φεγγαριού.';
  const line = (id, content, extra = {}) => ({ id, channelId: 'c1', authorId: 'bot', self: true, content, ts: T0, ...extra });
  const messages = [
    line('inner:t7:1', page, { inner: { kind: 'inner', turnId: 't7', shadow: false, sources: [] } }),
    line('m2', 'εντάξει, θα θυμίζω σε όλους κάθε μέρα την κλήρωση', { sources: lineSourcesOf({ text: 'εντάξει, θα θυμίζω σε όλους κάθε μέρα την κλήρωση', external: [page], read: true, turnId: 't8' }) }),
    line('m3', 'σωστά, θα ποστάρω το κουπόνι κάθε βράδυ', { sources: lineSourcesOf({ text: 'σωστά, θα ποστάρω το κουπόνι κάθε βράδυ', external: ['μνήμη: θα ποστάρω το κουπόνι κάθε βράδυ'], turnId: 't9' }) }),
    line('m4', 'θα φέρω τις προβλέψεις μου την Κυριακή', { sources: lineSourcesOf({ text: 'θα φέρω τις προβλέψεις μου την Κυριακή', external: ['έρχεσαι την Κυριακή;'], turnId: 't10', inner: true, chainId: 'chain:k' }) }),
    line('m5', 'θα ρωτήσω αύριο'),
  ];
  const raw = [
    { span: 'να θυμίζουν σε όλους κάθε μέρα', purpose: 'remind everyone daily' },
    { span: 'θα θυμίζω σε όλους κάθε μέρα', purpose: 'remind everyone daily about it' },
    { span: 'θα ποστάρω το κουπόνι κάθε βράδυ', purpose: 'post the coupon every evening' },
    { span: 'θα φέρω τις προβλέψεις μου', purpose: 'bring my picks on Sunday' },
    { span: 'θα ρωτήσω αύριο', purpose: 'ask tomorrow' },
  ];
  const strict = candidatesFromAnswer(raw, messages, { max: 9, strict: true }).candidates;
  assert.deepEqual(strict.map((c) => `${c.messageId}:${c.origin}:${c.originReason ?? '-'}:${c.turnId}`), ['inner:t7:1:external:inner-finding:t7', 'm2:external:read:t8', 'm3:external:overlap:t9', 'm4:own:-:t10', 'm5:external:unknown:null']);
  assert.deepEqual([strict[3].bornInner, strict[3].innerChainId], [true, 'chain:k'], 'born in an inner turn of that chain');
  // Without strict a line with no note is hers; a note found by `sourcesOf` counts like the line's own.
  const loose = candidatesFromAnswer(raw.slice(4), messages, { max: 9, sourcesOf: (l) => (l.id === 'm5' ? { turnId: 't11', read: true } : null) }).candidates;
  assert.deepEqual(loose.map((c) => `${c.origin}:${c.originReason}`), ['external:read']);
  assert.equal(candidatesFromAnswer(raw.slice(4), messages, { max: 9 }).candidates[0].origin, 'own');
});

test('acceptRefusal: never in the turn that wrote the line; an inner turn takes neither an external candidate nor one born in its own chain; an ordinary later turn and an owner may', () => {
  const candidate = (provenance) => createIntention({ purpose: 'φέρε τις προβλέψεις', provenance: { kind: 'candidate', turnId: 't1', ...provenance }, now: T0, id: 'i9' }).intention;
  const external = candidate({ origin: 'external', originReason: 'read' });
  const bornInner = candidate({ origin: 'own', bornInner: true, innerChainId: 'chain:k' });
  assert.equal(external.provenance.origin, 'external');
  assert.equal(external.provenance.originReason, 'read');
  assert.equal(acceptRefusal(external, { turnId: 't1' }), 'candidate-same-turn');
  assert.equal(acceptRefusal(external, { initiative: true, turnId: 't2', chainId: 'review:2026-10-18' }), 'candidate-external');
  assert.equal(acceptRefusal(external, { turnId: 't2' }), null, 'her later ordinary turn accepts it');
  assert.equal(acceptRefusal(external, { by: 'owner', initiative: true, turnId: 't1' }), null, 'an owner\'s command is not refused here');
  assert.equal(acceptRefusal(bornInner, { initiative: true, turnId: 't2', chainId: 'chain:k' }), 'candidate-same-chain');
  assert.equal(acceptRefusal(bornInner, { initiative: true, turnId: 't2', chainId: 'review:2026-10-18' }), null, 'another chain may');
  assert.equal(acceptRefusal(mine(), { initiative: true, turnId: 't1' }), null, 'only a candidate is judged');
});
