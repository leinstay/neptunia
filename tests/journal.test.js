// Tests for src/memory/journal.js: the persona's journal records, written as JSON lines
// through an append store. A fake append store records `{ file, line }` and replays them on
// iterate; no real disk, no real data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createJournal, createOffPeriodsReader, offPeriods, triggerLinksOf } from '../src/memory/journal.js';

const DATA = path.join('fake-root', 'data');
const DAY_D = Date.UTC(2026, 9, 13, 23, 59, 50);
const DAY_D1 = Date.UTC(2026, 9, 14, 0, 0, 5);

function fakeAppendStore() {
  const lines = [];
  return {
    lines,
    append: async (file, line) => {
      lines.push({ file, line });
    },
    async *iterate(file) {
      let offset = 0;
      for (const entry of lines) {
        if (entry.file !== file) continue;
        yield { offset, line: entry.line };
        offset += Buffer.byteLength(entry.line) + 1;
      }
    },
  };
}

function counter(prefix) {
  let n = 0;
  return () => `${prefix}${(n += 1)}`;
}

function journalAt(clock, { thinkChars = 4000 } = {}) {
  const appendStore = fakeAppendStore();
  const journal = createJournal({
    appendStore,
    dataDir: DATA,
    config: () => ({ thinkChars }),
    now: () => clock.ms,
    uuid: counter('u-'),
  });
  return { journal, appendStore };
}

const records = (appendStore) => appendStore.lines.map(({ file, line }) => ({ file, record: JSON.parse(line) }));

test('journal: start allots a turnId and writes turn.start to the day of occurredAt', async () => {
  const clock = { ms: DAY_D };
  const { journal, appendStore } = journalAt(clock);
  const started = journal.start('g1', {
    channelId: 'c1',
    mode: 'reply',
    trigger: { kind: 'mention', messageId: 'm1', authorId: 'u1' },
    participants: ['u1'],
    sourceMessageIds: ['m1'],
  });
  assert.equal(typeof started.turnId, 'string');
  assert.ok(started.turnId.length > 0);
  assert.equal(started.attemptId, 1);
  assert.equal(started.startedAt, new Date(DAY_D).toISOString());
  await Promise.resolve();
  const [{ file, record }] = records(appendStore);
  assert.equal(file, path.join(DATA, 'guilds', 'g1', 'journal', '2026-10-13.jsonl'));
  assert.equal(file, journal.dayFile('g1', '2026-10-13'));
  assert.equal(record.kind, 'turn.start');
  assert.equal(record.v, 1);
  assert.equal(record.turnId, started.turnId);
  assert.equal(record.attemptId, 1);
  assert.equal(record.mode, 'reply');
  assert.deepEqual(record.trigger, { kind: 'mention', messageId: 'm1', authorId: 'u1' });
  assert.deepEqual(record.scope, { channel: 'c1' });
  assert.deepEqual(record.participants, ['u1']);
  assert.deepEqual(record.sourceMessageIds, ['m1']);
  assert.equal(record.origin, 'live');
  assert.equal(record.guildId, 'g1');
  assert.equal(record.occurredAt, started.startedAt);
  assert.equal(typeof record.recordedAt, 'string');

  // A second attempt keeps the turn's id.
  const second = journal.start('g1', { channelId: 'c1', mode: 'reply', turnId: started.turnId, attemptId: 2 });
  assert.equal(second.turnId, started.turnId);
  assert.equal(second.attemptId, 2);
});

test('journal: turn record carries the envelope and caps think at thinkChars', async () => {
  const clock = { ms: DAY_D };
  const { journal, appendStore } = journalAt(clock, { thinkChars: 20 });
  await journal.turn('g1', {
    turnId: 't-1',
    attemptId: 1,
    channelId: 'c1',
    outcome: 'spoke',
    reason: null,
    think: 'Ελένη ρώτησε για το γλυκό και θέλω να απαντήσω σύντομα.',
    participants: ['u1', 'u2'],
    sourceMessageIds: ['m1', 'm2'],
    posted: [{ messageId: 's1', replyTo: 'm2' }],
  });
  const [{ record }] = records(appendStore);
  for (const key of ['v', 'id', 'kind', 'occurredAt', 'recordedAt', 'guildId', 'scope', 'participants', 'sourceMessageIds', 'origin']) {
    assert.ok(key in record, `envelope key ${key}`);
  }
  assert.equal(record.kind, 'turn');
  assert.equal(record.id, 'u-1');
  assert.deepEqual(record.scope, { channel: 'c1' });
  assert.deepEqual(record.participants, ['u1', 'u2']);
  assert.ok(Array.from(record.think).length <= 20, record.think);
  assert.ok(record.think.length > 0);
  assert.equal(record.thinkTruncated, true);
  assert.deepEqual(record.posted, [{ messageId: 's1', replyTo: 'm2' }]);

  await journal.turn('g1', { turnId: 't-2', attemptId: 1, channelId: 'c1', outcome: 'skip', think: 'κοντό' });
  const short = records(appendStore)[1].record;
  assert.equal(short.think, 'κοντό');
  assert.equal('thinkTruncated' in short, false);
});

test('journal: a private turn goes to the private day file, never the guild file', async () => {
  const clock = { ms: DAY_D };
  const { journal, appendStore } = journalAt(clock);
  const started = journal.start('g1', { channelId: 'dm1', mode: 'reply', privateUserId: 'u7' });
  await journal.turn('g1', { ...started, channelId: 'dm1', privateUserId: 'u7', outcome: 'spoke' });
  const privateFile = path.join(DATA, 'guilds', 'g1', 'private', 'u7', 'journal', '2026-10-13.jsonl');
  assert.equal(journal.dayFile('g1', '2026-10-13', 'u7'), privateFile);
  assert.equal(appendStore.lines.length, 2);
  for (const { file, record } of records(appendStore)) {
    assert.equal(file, privateFile);
    assert.deepEqual(record.scope, { user: 'u7', private: true });
  }
  assert.ok(appendStore.lines.every(({ file }) => file !== journal.dayFile('g1', '2026-10-13')));
  assert.equal((await journal.read('g1', { day: '2026-10-13', privateUserId: 'u7' })).length, 2);
  assert.deepEqual(await journal.read('g1', { day: '2026-10-13' }), []);
});

test('journal: read returns the last n records of a kind, newest last', async () => {
  const clock = { ms: DAY_D };
  const { journal } = journalAt(clock);
  const started = journal.start('g1', { channelId: 'c1', mode: 'interject' });
  await journal.system('g1', { event: 'pause', by: 'owner' });
  clock.ms = DAY_D1;
  await journal.turn('g1', { turnId: started.turnId, attemptId: 1, channelId: 'c1', outcome: 'skip' });
  for (let i = 0; i < 3; i += 1) {
    const next = journal.start('g1', { channelId: 'c1', mode: 'reply' });
    await journal.turn('g1', { ...next, channelId: 'c1', outcome: `o${i}` });
  }

  const dayD = await journal.read('g1', { day: '2026-10-13' });
  assert.deepEqual(dayD.map((r) => r.kind), ['turn.start', 'system']);
  const startD = (await journal.read('g1', { day: '2026-10-13', kind: 'turn.start' }))[0];

  const turnsD1 = await journal.read('g1', { day: '2026-10-14', kind: 'turn', n: 2 });
  assert.deepEqual(turnsD1.map((r) => r.outcome), ['o1', 'o2']);
  const all = await journal.read('g1', { day: '2026-10-14', kind: 'turn' });
  assert.equal(all.length, 4);
  // The turn that started on day D closed on day D+1, linked by its turnId.
  assert.equal(all[0].turnId, startD.turnId);
  assert.equal(all[0].outcome, 'skip');
  assert.deepEqual(await journal.read('g1', { day: '2026-10-12' }), []);
});

test('triggerLinksOf: each posted message of a turn maps to the message that started it; a turn without one maps nothing', () => {
  const start = (turnId, messageId) => ({ kind: 'turn.start', turnId, trigger: messageId === null ? null : { kind: 'mention', messageId, authorId: 'u1' } });
  const turn = (turnId, ids) => ({ kind: 'turn', turnId, posted: ids.map((messageId) => ({ opId: `op-${messageId}`, messageId, replyTo: null })) });
  const links = triggerLinksOf([
    start('t1', 'm98'),
    start('t2', 'm99'),
    start('t3', null), // a spontaneous turn
    turn('t1', ['p100', 'p101']),
    { kind: 'system', event: 'start' },
    turn('t3', ['p102']),
    start('t1', 'm98'), // a second attempt of t1 keeps its trigger
    turn('t1', ['p103']),
    turn('t2', []),
    turn('t9', ['p104']), // its start lies before the days read
    { kind: 'turn', turnId: 't2', posted: [{ messageId: null }, null, { messageId: 'm99' }] },
  ]);
  assert.deepEqual(links, [
    ['p100', 'm98'],
    ['p101', 'm98'],
    ['p103', 'm98'],
  ]);
  assert.deepEqual(triggerLinksOf(null), []);
});

test('journal: triggerLinks rebuilds the links of the days read, a turn closed the next day included', async () => {
  const clock = { ms: DAY_D };
  const { journal } = journalAt(clock);
  const first = journal.start('g1', { channelId: 'c1', mode: 'reply', trigger: { kind: 'mention', messageId: 'm1', authorId: 'u1' } });
  const spontaneous = journal.start('g1', { channelId: 'c1', mode: 'interject', trigger: null });
  await journal.turn('g1', { ...spontaneous, channelId: 'c1', outcome: 'spoke', posted: [{ messageId: 'p0', replyTo: null }] });
  clock.ms = DAY_D1;
  await journal.turn('g1', { ...first, channelId: 'c1', outcome: 'spoke', posted: [{ messageId: 'p1', replyTo: null }, { messageId: 'p2', replyTo: 'm7' }] });
  journal.start('g1', { channelId: 'c1', mode: 'reply', privateUserId: 'u2', trigger: { kind: 'private', messageId: 'd1', authorId: 'u2' }, turnId: 't-private' });
  await journal.turn('g1', { turnId: 't-private', attemptId: 1, privateUserId: 'u2', outcome: 'spoke', posted: [{ messageId: 'd2' }] });

  assert.deepEqual(await journal.triggerLinks('g1', { days: ['2026-10-13', '2026-10-14'] }), [
    ['p1', 'm1'],
    ['p2', 'm1'],
  ]);
  // The day the turn started not read: its posts have no known trigger.
  assert.deepEqual(await journal.triggerLinks('g1', { days: ['2026-10-14'] }), []);
});

test('journal: a record missing participants or sourceMessageIds is written with empty arrays, never rejected', async () => {
  const clock = { ms: DAY_D };
  const { journal, appendStore } = journalAt(clock);
  await journal.turn('g1', { turnId: 't-1', attemptId: 1, channelId: 'c1', outcome: 'error', participants: null, sourceMessageIds: 'm1' });
  await journal.action('g1', { opId: 'op-1', turnId: 't-1', phase: 'started', name: 'post', by: 'persona', channelId: 'c1' });
  await journal.memory('g1', { batchId: 'b-1', participants: [7, 'u1', 'u1'] });
  await journal.system('g1', { event: 'resume', by: 'owner' });
  const written = records(appendStore).map(({ record }) => record);
  assert.deepEqual(written.map((r) => r.kind), ['turn', 'action', 'memory', 'system']);
  for (const record of written) {
    assert.ok(Array.isArray(record.participants));
    assert.ok(Array.isArray(record.sourceMessageIds));
  }
  assert.deepEqual(written[0].participants, []);
  assert.deepEqual(written[0].sourceMessageIds, []);
  assert.deepEqual(written[1].scope, { channel: 'c1' });
  assert.deepEqual(written[2].participants, ['u1']);
  assert.deepEqual(written[2].scope, { guild: true });
  assert.deepEqual(written[3].scope, { guild: true });
});

test('journal: op writes started then one closing phase with the same opId', async () => {
  const clock = { ms: DAY_D };
  const { journal, appendStore } = journalAt(clock);
  const op = journal.op('g1', {
    turnId: 't-1',
    name: 'post',
    by: 'persona',
    channelId: 'c1',
    participants: ['u1'],
    sourceMessageIds: ['m1'],
    intent: { replyTo: 'm1', text: 'ά'.repeat(100) },
  });
  assert.equal(typeof op.opId, 'string');
  assert.ok(op.opId.startsWith('op-'));
  await op.started();
  await op.succeeded({ messageId: 's1' });
  await op.failed('late'); // ignored: the operation is closed
  await op.unknown(); // ignored too
  const written = records(appendStore).map(({ record }) => record);
  assert.deepEqual(written.map((r) => r.phase), ['started', 'succeeded']);
  const [started, closed] = written;
  assert.equal(started.kind, 'action');
  assert.equal(started.opId, op.opId);
  assert.equal(closed.opId, op.opId);
  assert.equal(started.name, 'post');
  assert.equal(started.by, 'persona');
  assert.equal(started.turnId, 't-1');
  assert.equal(Array.from(started.intent.text).length, 80);
  assert.equal(started.intent.replyTo, 'm1');
  assert.deepEqual(started.scope, { channel: 'c1' });
  assert.deepEqual(closed.result, { messageId: 's1' });
  assert.equal('intent' in closed, false);
  assert.equal(closed.name, 'post');
  assert.deepEqual(closed.participants, ['u1']);

  const failing = journal.op('g1', { turnId: 't-1', name: 'draw', by: 'persona', channelId: 'c1', dryRun: true });
  await failing.started({ input: { self: true } });
  await failing.failed('image-cap');
  const [fs, ff] = records(appendStore).slice(2).map(({ record }) => record);
  assert.deepEqual(fs.input, { self: true });
  assert.equal(fs.dryRun, true);
  assert.equal(ff.phase, 'failed');
  assert.deepEqual(ff.result, { code: 'image-cap' });
  assert.equal(ff.dryRun, true);
});

test('journal: pending lists started operations without a closing phase', async () => {
  const clock = { ms: DAY_D };
  const { journal } = journalAt(clock);
  const open = journal.op('g1', { turnId: 't-1', name: 'post', by: 'persona', channelId: 'c1', intent: { replyTo: 'm1', text: 'Ελένη' } });
  await open.started();
  const done = journal.op('g1', { turnId: 't-1', name: 'react', by: 'persona', channelId: 'c1' });
  await done.started();
  await done.succeeded({ to: 'm1', emoji: 'x' });
  const failed = journal.op('g1', { turnId: 't-1', name: 'gif', by: 'persona', channelId: 'c1' });
  await failed.started();
  await failed.failed('http-403');
  const lost = journal.op('g1', { turnId: 't-1', name: 'draw', by: 'persona', channelId: 'c1' });
  await lost.started();
  await lost.unknown();
  await journal.turn('g1', { turnId: 't-1', attemptId: 1, channelId: 'c1', outcome: 'spoke' });
  // Started late on day D, closed on D+1: open on D alone, closed over both days.
  clock.ms = DAY_D + 5000;
  const crossing = journal.op('g1', { turnId: 't-2', name: 'recall', by: 'engine', channelId: 'c2' });
  await crossing.started();
  clock.ms = DAY_D1;
  await crossing.succeeded({ hits: 0, delivered: false });

  const pending = await journal.pending('g1', { day: '2026-10-13' });
  assert.deepEqual(pending.map((p) => p.opId), [open.opId, crossing.opId]);
  assert.deepEqual(pending[0], { opId: open.opId, turnId: 't-1', name: 'post', intent: { replyTo: 'm1', text: 'Ελένη' }, channelId: 'c1' });
  assert.deepEqual((await journal.pending('g1', { days: ['2026-10-13', '2026-10-14'] })).map((p) => p.opId), [open.opId]);
  assert.deepEqual(await journal.pending('g1', { day: '2026-10-14' }), []);
});

test('journal: reconcile matches a post by replyTo and the first 80 chars of intent, else marks unknown, never re-sends', async () => {
  const clock = { ms: DAY_D - 60_000 };
  const { journal, appendStore } = journalAt(clock);
  const long = 'Καλημέρα σε όλους, σήμερα η Ζωή έφερε γλυκά και ο Andrés έφερε καφέ για την ομάδα μας.';
  const found = journal.op('g1', { turnId: 't-1', name: 'post', by: 'persona', channelId: 'c1', participants: ['u1'], intent: { replyTo: 'm1', text: long } });
  await found.started();
  // Same text, wrong reply target: not a match.
  const missing = journal.op('g1', { turnId: 't-1', name: 'post', by: 'persona', channelId: 'c1', intent: { replyTo: 'm2', text: 'ναι' } });
  await missing.started();
  // Right target, different text: not a match either.
  const plain = journal.op('g1', { turnId: 't-2', name: 'post', by: 'persona', channelId: 'c2', intent: { replyTo: null, text: 'éclair' } });
  await plain.started();
  const reacted = journal.op('g1', { turnId: 't-1', name: 'react', by: 'persona', channelId: 'c1' });
  await reacted.started();
  const recalled = journal.op('g1', { turnId: 't-1', name: 'recall', by: 'engine', channelId: 'c1' });
  await recalled.started();

  const sends = [];
  const own = (id, content, replyToId) => ({
    id,
    content,
    replyToId,
    createdAt: DAY_D - 30_000,
    reply: () => sends.push(id),
    channel: { send: () => sends.push(id) },
  });
  const fetched = [];
  const fetchOwnMessages = async (channelId, n) => {
    fetched.push({ channelId, n });
    if (channelId === 'c1') return [own('s0', 'ναι', 'm9'), own('s1', `${long} και κάτι ακόμα`, 'm1'), own('s2', 'ναι', null)];
    return [own('s3', 'eclair', null)];
  };

  clock.ms = DAY_D;
  const counts = await journal.reconcile('g1', { days: ['2026-10-12', '2026-10-13'], fetchOwnMessages });
  assert.deepEqual(counts, { succeeded: 1, unknown: 4 });
  assert.deepEqual(sends, []);
  // One fetch per channel with a pending post; a react or a recall needs none.
  assert.deepEqual(fetched.sort((a, b) => a.channelId.localeCompare(b.channelId)), [
    { channelId: 'c1', n: 20 },
    { channelId: 'c2', n: 20 },
  ]);

  const closing = records(appendStore).map(({ record }) => record).filter((r) => r.phase !== 'started');
  const byOp = new Map(closing.map((r) => [r.opId, r]));
  assert.equal(closing.length, 5);
  assert.equal(byOp.get(found.opId).phase, 'succeeded');
  assert.deepEqual(byOp.get(found.opId).result, { messageId: 's1' });
  assert.equal(byOp.get(found.opId).reconciled, true);
  assert.deepEqual(byOp.get(found.opId).participants, ['u1']);
  assert.equal(byOp.get(found.opId).turnId, 't-1');
  for (const op of [missing, plain, reacted, recalled]) {
    assert.equal(byOp.get(op.opId).phase, 'unknown');
    assert.equal(byOp.get(op.opId).reconciled, true);
  }
  assert.deepEqual(await journal.pending('g1', { days: ['2026-10-12', '2026-10-13'] }), []);

  // A second start finds nothing left to reconcile and fetches nothing.
  const again = await journal.reconcile('g1', { days: ['2026-10-12', '2026-10-13'], fetchOwnMessages });
  assert.deepEqual(again, { succeeded: 0, unknown: 0 });
  assert.equal(fetched.length, 2);
});

test('journal: reconcile marks a post unknown when the fetch fails', async () => {
  const clock = { ms: DAY_D };
  const { journal, appendStore } = journalAt(clock);
  const op = journal.op('g1', { turnId: 't-1', name: 'post', by: 'persona', channelId: 'c1', intent: { replyTo: null, text: 'Ζωή' } });
  await op.started();
  const counts = await journal.reconcile('g1', {
    days: ['2026-10-13'],
    fetchOwnMessages: async () => {
      throw new Error('gone');
    },
  });
  assert.deepEqual(counts, { succeeded: 0, unknown: 1 });
  assert.equal(records(appendStore).at(-1).record.phase, 'unknown');
});

test('journal: reconcile leaves alone an operation started after its cutoff', async () => {
  const clock = { ms: DAY_D - 10_000 };
  const { journal } = journalAt(clock);
  const old = journal.op('g1', { turnId: 't-1', name: 'react', by: 'persona', channelId: 'c1' });
  await old.started();
  clock.ms = DAY_D;
  // A turn running while the reconciliation reads: its post is still in flight.
  const live = journal.op('g1', { turnId: 't-2', name: 'post', by: 'persona', channelId: 'c1', intent: { replyTo: null, text: 'Ζωή' } });
  await live.started();
  const fetched = [];
  const counts = await journal.reconcile('g1', { days: ['2026-10-13'], before: DAY_D - 1000, fetchOwnMessages: async (channelId) => fetched.push(channelId) && [] });
  assert.deepEqual(counts, { succeeded: 0, unknown: 1 });
  assert.deepEqual(fetched, []);
  assert.deepEqual((await journal.pending('g1', { day: '2026-10-13' })).map((p) => p.opId), [live.opId]);
});

test('journal: stalled follows the append store and a private memory record goes to the private day file', async () => {
  const clock = { ms: DAY_D };
  const { journal, appendStore } = journalAt(clock);
  assert.equal(journal.stalled(), false, 'a store without stats never stalls');
  let stalled = false;
  appendStore.stats = () => ({ pending: stalled ? 1000 : 0, failed: 0, stalled });
  assert.equal(journal.stalled(), false);
  stalled = true;
  assert.equal(journal.stalled(), true);

  await journal.memory('g1', { batchId: 'b-1', stage: 'single', participants: ['u7'], privateUserId: 'u7' });
  const [{ file, record }] = records(appendStore);
  assert.equal(file, journal.dayFile('g1', '2026-10-13', 'u7'));
  assert.deepEqual(record.scope, { user: 'u7', private: true });
  assert.equal(record.kind, 'memory');
});

test('journal: an answer record is scoped to its channel, named by its participants and read by kind', async () => {
  const clock = { ms: DAY_D };
  const { journal, appendStore } = journalAt(clock);
  await journal.answer('g1', {
    event: 'fact',
    reason: 'replaced-deferred',
    messageId: 'm1',
    authorId: 'u7',
    channelId: 'c1',
    at: '2026-10-13T23:59:40.000Z',
    replacedBy: 'm2',
    participants: ['u7'],
    sourceMessageIds: ['m1', 'm2'],
  });
  const [{ file, record }] = records(appendStore);
  assert.equal(file, journal.dayFile('g1', '2026-10-13'));
  assert.equal(record.kind, 'answer');
  assert.deepEqual(record.scope, { channel: 'c1' });
  assert.deepEqual(record.participants, ['u7']);
  assert.deepEqual(record.sourceMessageIds, ['m1', 'm2']);
  assert.equal(record.channelId, undefined, 'the channel is the scope, not stored twice');
  assert.deepEqual((await journal.read('g1', { day: '2026-10-13', kind: 'answer' })).map((r) => r.messageId), ['m1']);
  const { journalLine } = await import('../src/memory/journal.js');
  assert.equal(journalLine({ ...record, occurredAt: '2026-10-13T08:09:10.000Z' }), '08:09:10 answer fact replaced-deferred');
  assert.equal(journalLine({ kind: 'answer', occurredAt: '2026-10-13T08:09:10.000Z', event: 'verdict', reason: 'gate-failed', verdict: 'owed' }), '08:09:10 answer verdict gate-failed owed');
  assert.equal(journalLine({ kind: 'answer', occurredAt: '2026-10-13T08:09:10.000Z', event: 'recovery', outcome: 'spoke' }), '08:09:10 answer recovery spoke');
});

// ---- forget and the run marker: a real append store on a temp dir --------------------------

async function realJournal(clock) {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const { createAppendStore } = await import('../src/memory/append-store.js');
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nep-journal-'));
  const quiet = { info() {}, warn() {} };
  const appendStore = createAppendStore({ fsyncMs: 0, log: quiet, now: () => clock.ms });
  const make = (store = appendStore) => createJournal({ appendStore: store, dataDir, config: () => ({}), now: () => clock.ms, uuid: counter('r-'), log: quiet });
  return { fsp, dataDir, appendStore, make, journal: make() };
}

test('journal: forgetUser rewrites day files dropping records whose participants include the user, with a marker that survives a crash', async () => {
  const clock = { ms: DAY_D };
  const { fsp, dataDir, appendStore, make, journal } = await realJournal(clock);
  try {
    await journal.turn('g1', { turnId: 't-1', attemptId: 1, channelId: 'c1', outcome: 'spoke', think: 'Ζωή', participants: ['u1', 'u2'] });
    await journal.system('g1', { event: 'pause', by: 'owner' });
    await journal.turn('g1', { turnId: 't-p', attemptId: 1, channelId: 'dm1', privateUserId: 'u1', outcome: 'spoke', participants: ['u1'] });
    clock.ms = DAY_D1;
    await journal.action('g1', { opId: 'op-1', phase: 'started', name: 'post', channelId: 'c1', participants: ['u1'] });
    await journal.action('g1', { opId: 'op-2', phase: 'started', name: 'react', channelId: 'c1', participants: ['u3'] });
    await appendStore.flush();

    // A crash mid-forget: the second day file's rewrite never happens.
    let calls = 0;
    const crashing = {
      ...appendStore,
      rewrite: async (file, keep) => {
        calls += 1;
        if (calls === 2) throw Object.assign(new Error('killed'), { code: 'EKILLED' });
        return appendStore.rewrite(file, keep);
      },
    };
    await assert.rejects(make(crashing).forgetUser('g1', 'u1'), /killed/);
    const marker = path.join(dataDir, 'guilds', 'g1', 'forgetting', 'u1.json');
    await fsp.stat(marker); // the marker survived the crash

    // While the marker exists, the reader hides the user everywhere.
    assert.deepEqual((await journal.read('g1', { day: '2026-10-14' })).map((r) => r.opId), ['op-2']);
    assert.deepEqual((await journal.read('g1', { day: '2026-10-13' })).map((r) => r.kind), ['system']);
    assert.deepEqual(await journal.read('g1', { day: '2026-10-13', privateUserId: 'u1' }), []);

    // The next start finishes the job and removes the marker.
    const finished = await journal.resumeForgets('g1');
    assert.equal(finished.finished, 1);
    await assert.rejects(fsp.stat(marker), { code: 'ENOENT' });
    const raw = async (day) => (await fsp.readFile(journal.dayFile('g1', day), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual((await raw('2026-10-13')).map((r) => r.kind), ['system']);
    assert.deepEqual((await raw('2026-10-14')).map((r) => r.opId), ['op-2']);
    await assert.rejects(fsp.stat(path.join(dataDir, 'guilds', 'g1', 'private', 'u1', 'journal')), { code: 'ENOENT' });

    // A marker someone else owns stays where it is; the journal part is still done.
    await fsp.writeFile(path.join(dataDir, 'guilds', 'g1', 'forgetting', 'u3.json'), '{"userId":"u3"}\n');
    const result = await journal.forgetUser('g1', 'u3');
    assert.equal(result.dropped, 1);
    await fsp.stat(path.join(dataDir, 'guilds', 'g1', 'forgetting', 'u3.json'));
    // And the store keeps appending after a rewrite.
    await journal.system('g1', { event: 'resume', by: 'owner' });
    await appendStore.flush();
    assert.deepEqual((await raw('2026-10-14')).map((r) => r.kind), ['system']);
  } finally {
    await appendStore.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test('journal: a .running marker left over at start writes an unclean-stop record', async () => {
  const clock = { ms: DAY_D };
  const { fsp, dataDir, appendStore, journal } = await realJournal(clock);
  try {
    const running = path.join(dataDir, 'guilds', 'g1', 'journal', '.running');
    // A clean first start: no leftover marker, no unclean-stop; the marker is written.
    assert.deepEqual(await journal.markRunning('g1'), { unclean: false });
    await fsp.stat(running);
    // A clean shutdown removes it.
    await journal.clearRunning('g1');
    await assert.rejects(fsp.stat(running), { code: 'ENOENT' });
    assert.deepEqual(await journal.read('g1', { day: '2026-10-13' }), []);

    // A killed process leaves it behind: the next start says so first.
    await journal.markRunning('g1');
    assert.deepEqual(await journal.markRunning('g1'), { unclean: true });
    await appendStore.flush();
    const written = await journal.read('g1', { day: '2026-10-13' });
    assert.deepEqual(written.map((r) => [r.kind, r.event]), [['system', 'unclean-stop']]);
    await fsp.stat(running);
  } finally {
    await appendStore.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test('journal: removeGuild deletes the guild journal day files and every private journal, the run marker stays', async () => {
  const clock = { ms: DAY_D };
  const { fsp, dataDir, appendStore, journal } = await realJournal(clock);
  try {
    await journal.markRunning('g1');
    await journal.system('g1', { event: 'pause', by: 'owner' });
    await journal.turn('g1', { turnId: 't-p', attemptId: 1, channelId: 'dm1', privateUserId: 'u1', outcome: 'spoke' });
    const counts = await journal.removeGuild('g1');
    assert.equal(counts.files, 2);
    assert.deepEqual(await journal.read('g1', { day: '2026-10-13' }), []);
    assert.deepEqual(await journal.read('g1', { day: '2026-10-13', privateUserId: 'u1' }), []);
    await fsp.stat(path.join(dataDir, 'guilds', 'g1', 'journal', '.running'));
    await journal.system('g1', { event: 'wipe', by: 'owner' });
    assert.deepEqual((await journal.read('g1', { day: '2026-10-13' })).map((r) => r.event), ['wipe']);
  } finally {
    await appendStore.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test('journalLine: one short line per kind', async () => {
  const { journalLine } = await import('../src/memory/journal.js');
  const at = '2026-10-13T08:09:10.000Z';
  assert.equal(
    journalLine({ kind: 'turn', occurredAt: at, mode: 'reply', outcome: 'spoke', seen: { messageIds: ['a', 'b', 'c'] }, think: `Ζωή\n${'x'.repeat(100)}` }),
    `08:09:10 turn reply spoke 3 msgs, think: Ζωή ${'x'.repeat(76)}`,
  );
  assert.equal(journalLine({ kind: 'turn', occurredAt: at, mode: 'interject', outcome: 'skip', think: null }), '08:09:10 turn interject skip 0 msgs, think: -');
  assert.equal(journalLine({ kind: 'action', occurredAt: at, name: 'post', phase: 'started' }), '08:09:10 action post started');
  assert.equal(
    journalLine({ kind: 'memory', occurredAt: at, batch: { messageIds: ['a'], consumed: 4 }, changed: { users: ['u1', 'u2'] }, episodes: [{}] }),
    '08:09:10 memory batch 4 lines, users 2, episodes 1',
  );
  assert.equal(journalLine({ kind: 'system', occurredAt: at, event: 'pause', by: 'owner' }), '08:09:10 system pause owner');
  assert.equal(journalLine({ kind: 'system', occurredAt: at, event: 'unclean-stop' }), '08:09:10 system unclean-stop');
  assert.equal(journalLine({ kind: 'system', occurredAt: at, event: 'reload', note: 'prompts' }), '08:09:10 system reload prompts');
});

/** An in-memory `fs/promises` stand-in: files by path, directories derived from them. */
function memoryFs() {
  const files = new Map();
  const dirNames = (dir) => {
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    const names = new Set();
    for (const file of files.keys()) if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split(path.sep)[0]);
    return [...names];
  };
  return {
    files,
    mkdir: async () => {},
    writeFile: async (file, text) => {
      files.set(file, String(text));
    },
    rename: async (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
    readdir: async (dir) => {
      const names = dirNames(dir);
      if (names.length === 0) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return names;
    },
    rm: async (target) => {
      for (const file of [...files.keys()]) if (file === target || file.startsWith(target + path.sep)) files.delete(file);
    },
  };
}

function dumpJournal({ keepRequests = 3 } = {}, ms = DAY_D) {
  const fs = memoryFs();
  const journal = createJournal({
    appendStore: fakeAppendStore(),
    dataDir: DATA,
    config: () => ({ thinkChars: 4000, keepRequests }),
    now: () => ms,
    uuid: counter('u-'),
    fs,
  });
  return { journal, fs };
}

const REQUESTS = path.join(DATA, 'guilds', 'g1', 'journal', 'requests');

test('journal: dumpRequest writes <day>/<turnId>-<attempt>.json with the request parts and the raw answer', async () => {
  const { journal, fs } = dumpJournal();
  const dataUrl = `data:image/png;base64,${'QUJD'.repeat(10)}`;
  await journal.dumpRequest('g1', {
    turnId: 't-1',
    attemptId: 2,
    request: {
      messages: [
        { role: 'system', content: 'sys text' },
        { role: 'user', content: [{ type: 'text', text: 'chat' }, { type: 'image_url', image_url: { url: dataUrl } }, { type: 'text', text: 'task' }] },
      ],
    },
    raw: '<msg>γεια</msg>',
    usage: { prompt: 10, cached: 4, completion: 2 },
  });
  const file = path.join(REQUESTS, '2026-10-13', 't-1-2.json');
  assert.deepEqual([...fs.files.keys()], [file]);
  const dump = JSON.parse(fs.files.get(file));
  assert.equal(dump.v, 1);
  assert.equal(dump.turnId, 't-1');
  assert.equal(dump.attemptId, 2);
  assert.equal(dump.recordedAt, new Date(DAY_D).toISOString());
  assert.equal(dump.system, 'sys text');
  assert.equal(dump.raw, '<msg>γεια</msg>');
  assert.deepEqual(dump.usage, { prompt: 10, cached: 4, completion: 2 });
  assert.deepEqual(dump.parts, [{ type: 'text', text: 'chat' }, { image: 'attachment', bytes: 30 }, { type: 'text', text: 'task' }]);
  assert.ok(!fs.files.get(file).includes('data:'));

  // A private turn lands under the partner's private journal directory.
  await journal.dumpRequest('g1', { turnId: 't-2', attemptId: 1, request: { system: 's', parts: [{ type: 'text', text: 'x' }] }, raw: '', usage: null, privateUserId: 'u9' });
  assert.ok(fs.files.has(path.join(DATA, 'guilds', 'g1', 'private', 'u9', 'journal', 'requests', '2026-10-13', 't-2-1.json')));
});

test('journal: pruneRequests deletes days older than keepRequests and keeps the rest', async () => {
  const { journal, fs } = dumpJournal({ keepRequests: 3 });
  for (const day of ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-12', '2026-10-13']) fs.files.set(path.join(REQUESTS, day, 't-1.json'), '{}');
  fs.files.set(path.join(DATA, 'guilds', 'g1', 'private', 'u9', 'journal', 'requests', '2026-10-01', 't-1.json'), '{}');
  fs.files.set(path.join(REQUESTS, 'notes'), 'not a day');
  const result = await journal.pruneRequests('g1');
  assert.deepEqual(result, { removed: 3 });
  const left = [...fs.files.keys()].map((file) => path.relative(DATA, file)).sort();
  assert.deepEqual(left, [
    path.join('guilds', 'g1', 'journal', 'requests', '2026-10-10', 't-1.json'),
    path.join('guilds', 'g1', 'journal', 'requests', '2026-10-12', 't-1.json'),
    path.join('guilds', 'g1', 'journal', 'requests', '2026-10-13', 't-1.json'),
    path.join('guilds', 'g1', 'journal', 'requests', 'notes'),
  ]);
});

test('journal: keepRequests 0 writes nothing', async () => {
  const { journal, fs } = dumpJournal({ keepRequests: 0 });
  await journal.dumpRequest('g1', { turnId: 't-1', attemptId: 1, request: { system: 's', parts: [] }, raw: 'x', usage: null });
  assert.equal(fs.files.size, 0);
  fs.files.set(path.join(REQUESTS, '2000-01-01', 't.json'), '{}');
  assert.deepEqual(await journal.pruneRequests('g1'), { removed: 0 });
  assert.equal(fs.files.size, 1);
});

test('journal: withWriterLock flushes the store first and holds appends until fn resolves', async () => {
  const clock = { ms: DAY_D };
  const { journal, appendStore } = journalAt(clock);
  const order = [];
  appendStore.flush = async () => {
    order.push('flush');
  };
  let finish;
  const held = new Promise((resolve) => {
    finish = resolve;
  });
  const locked = journal.withWriterLock(async () => {
    order.push('fn');
    await held;
    return 'copied';
  });
  await new Promise((resolve) => setImmediate(resolve));
  const writing = journal.system('g1', { event: 'pause', by: 'owner' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['flush', 'fn']);
  assert.equal(appendStore.lines.length, 0);
  finish();
  assert.equal(await locked, 'copied');
  await writing;
  assert.equal(appendStore.lines.length, 1);
  assert.equal(JSON.parse(appendStore.lines[0].line).event, 'pause');
});

test('journal: withWriterLock releases the lock when fn throws', async () => {
  const clock = { ms: DAY_D };
  const { journal, appendStore } = journalAt(clock);
  await assert.rejects(
    journal.withWriterLock(async () => {
      throw new Error('disk full');
    }),
    /disk full/,
  );
  await journal.system('g1', { event: 'resume', by: 'owner' });
  assert.equal(appendStore.lines.length, 1);
});

test('journal: request dumps that mention a forgotten user are deleted', async () => {
  const { journal, fs } = dumpJournal();
  fs.readFile = async (file) => {
    if (!fs.files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return fs.files.get(file);
  };
  const id = '348100000000000101';
  const privateRequests = path.join(DATA, 'guilds', 'g1', 'private', '348100000000000202', 'journal', 'requests');
  const named = path.join(REQUESTS, '2026-10-12', 't-1-1.json');
  const token = path.join(REQUESTS, '2026-10-13', 't-2-1.json');
  const inPrivate = path.join(privateRequests, '2026-10-13', 't-3-1.json');
  const other = path.join(REQUESTS, '2026-10-13', 't-4-1.json');
  const longer = path.join(REQUESTS, '2026-10-13', 't-5-1.json');
  fs.files.set(named, JSON.stringify({ system: `Ελένη (id:${id})`, parts: [] }));
  fs.files.set(token, JSON.stringify({ system: '', parts: [{ type: 'text', text: `<@${id}> καλημέρα` }] }));
  fs.files.set(inPrivate, JSON.stringify({ system: '', parts: [{ type: 'text', text: `about <@${id}>` }] }));
  fs.files.set(other, JSON.stringify({ system: '', parts: [{ type: 'text', text: 'καλησπέρα' }] }));
  fs.files.set(longer, JSON.stringify({ system: '', parts: [{ type: 'text', text: `<@${id}9>` }] }));

  assert.deepEqual(await journal.forgetRequests('g1', id), { removed: 3 });
  assert.deepEqual([...fs.files.keys()].sort(), [longer, other].sort(), 'another id that only starts the same stays');
  assert.deepEqual(await journal.forgetRequests('g1', id), { removed: 0 });
});

// ---- the persona's time away: offPeriods, timeline, createOffPeriodsReader ----

const T0 = Date.UTC(2026, 9, 14, 10, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY_WINDOW = 24 * HOUR;
const sys = (at, event) => ({ at, kind: 'system', event });
const turnAt = (at) => ({ at, kind: 'turn', event: null });

test('offPeriods: an owner pause at 10:00 and its resume at 10:20 are one paused period', () => {
  const timeline = [sys(T0, 'pause'), sys(T0 + 20 * MINUTE, 'resume')];
  assert.deepEqual(offPeriods(timeline, { now: T0 + HOUR, windowMs: DAY_WINDOW }), [
    { kind: 'paused', from: T0, to: T0 + 20 * MINUTE },
  ]);
});

test('offPeriods: a service stop and the next start are one stopped period', () => {
  const timeline = [turnAt(T0 - MINUTE), sys(T0, 'stop'), sys(T0 + 5 * MINUTE, 'start')];
  assert.deepEqual(offPeriods(timeline, { now: T0 + HOUR, windowMs: DAY_WINDOW }), [
    { kind: 'stopped', from: T0, to: T0 + 5 * MINUTE },
  ]);
});

test('offPeriods: two restarts 30 s apart merge into one period', () => {
  const timeline = [
    sys(T0, 'stop'),
    sys(T0 + MINUTE, 'start'),
    sys(T0 + MINUTE + 30_000, 'stop'),
    sys(T0 + 5 * MINUTE, 'start'),
  ];
  assert.deepEqual(offPeriods(timeline, { now: T0 + HOUR, windowMs: DAY_WINDOW }), [
    { kind: 'stopped', from: T0, to: T0 + 5 * MINUTE },
  ]);
});

test('offPeriods: a start with no stop before it (a crash) counts from the last record before it', () => {
  const timeline = [turnAt(T0), sys(T0 + 30 * MINUTE, 'unclean-stop'), sys(T0 + 30 * MINUTE, 'start')];
  assert.deepEqual(offPeriods(timeline, { now: T0 + HOUR, windowMs: DAY_WINDOW }), [
    { kind: 'stopped', from: T0, to: T0 + 30 * MINUTE },
  ]);
  // The first start the journal holds has nothing before it: no period.
  assert.deepEqual(offPeriods([sys(T0, 'start')], { now: T0 + HOUR, windowMs: DAY_WINDOW }), []);
});

test('offPeriods: periods that ended before the window are ignored; an ongoing pause is not shown', () => {
  const old = [sys(T0 - 30 * HOUR, 'pause'), sys(T0 - 29 * HOUR, 'resume')];
  assert.deepEqual(offPeriods(old, { now: T0, windowMs: DAY_WINDOW }), []);
  const ongoing = [sys(T0 - HOUR, 'pause')];
  assert.deepEqual(offPeriods(ongoing, { now: T0, windowMs: DAY_WINDOW }), []);
  assert.deepEqual(offPeriods([], { now: T0, windowMs: DAY_WINDOW }), []);
});

test('offPeriods: at most 3 periods, newest first; an overlap takes the kind of its longest part', () => {
  const timeline = [
    sys(T0, 'pause'), sys(T0 + 10 * MINUTE, 'resume'),
    sys(T0 + HOUR, 'pause'), sys(T0 + HOUR + 10 * MINUTE, 'resume'),
    sys(T0 + 2 * HOUR, 'stop'), sys(T0 + 2 * HOUR + 10 * MINUTE, 'start'),
    // A pause that a restart falls inside: one period, paused.
    sys(T0 + 3 * HOUR, 'pause'), sys(T0 + 3 * HOUR + 5 * MINUTE, 'stop'), sys(T0 + 3 * HOUR + 6 * MINUTE, 'start'),
    sys(T0 + 3 * HOUR + 40 * MINUTE, 'resume'),
  ];
  assert.deepEqual(offPeriods(timeline, { now: T0 + 5 * HOUR, windowMs: DAY_WINDOW }), [
    { kind: 'paused', from: T0 + 3 * HOUR, to: T0 + 3 * HOUR + 40 * MINUTE },
    { kind: 'stopped', from: T0 + 2 * HOUR, to: T0 + 2 * HOUR + 10 * MINUTE },
    { kind: 'paused', from: T0 + HOUR, to: T0 + HOUR + 10 * MINUTE },
  ]);
});

test('journal: timeline reads the guild day files the window spans, oldest first, kind and event only', async () => {
  const clock = { ms: T0 - 36 * HOUR };
  const { journal } = journalAt(clock);
  await journal.system('g1', { event: 'stop', by: 'service' }); // two days back: outside the read days
  clock.ms = T0 - 20 * HOUR; // yesterday
  journal.start('g1', { channelId: 'c1', mode: 'reply', participants: ['u1'] });
  await Promise.resolve();
  clock.ms = T0;
  await journal.system('g1', { event: 'start', by: 'service' });
  journal.start('g1', { channelId: 'c1', mode: 'reply', privateUserId: 'u2' }); // a private journal: not read
  await Promise.resolve();
  const timeline = await journal.timeline('g1', { from: T0 - DAY_WINDOW });
  assert.deepEqual(timeline, [
    { at: T0 - 20 * HOUR, kind: 'turn.start', event: null },
    { at: T0, kind: 'system', event: 'start' },
  ]);
});

test('createOffPeriodsReader: reads the window once a minute and gives [] with a warn on a failure', async () => {
  const clock = { ms: T0 + HOUR };
  const reads = [];
  const warns = [];
  let fail = false;
  const journal = {
    timeline: async (guildId, query) => {
      reads.push([guildId, query]);
      if (fail) throw Object.assign(new Error('boom'), { code: 'EIO' });
      return [sys(T0, 'pause'), sys(T0 + 20 * MINUTE, 'resume')];
    },
  };
  const log = { warn: (event, fields) => warns.push([event, fields]) };
  const read = createOffPeriodsReader({ journal, now: () => clock.ms, log });

  const first = await read('g1', { windowHours: 24 });
  assert.deepEqual(first, [{ kind: 'paused', from: T0, to: T0 + 20 * MINUTE }]);
  assert.deepEqual(reads, [['g1', { from: T0 + HOUR - DAY_WINDOW }]]);
  clock.ms += 30_000;
  assert.deepEqual(await read('g1', { windowHours: 24 }), first);
  assert.equal(reads.length, 1, 'within a minute: the cached list');

  clock.ms += MINUTE;
  fail = true;
  assert.deepEqual(await read('g1', { windowHours: 24 }), []);
  assert.equal(reads.length, 2);
  assert.deepEqual(warns, [['journal: off periods unread', { guildId: 'g1', code: 'EIO' }]]);

  // No reader at all: nothing to show.
  assert.deepEqual(await createOffPeriodsReader({ journal: null })('g1', { windowHours: 24 }), []);
});
