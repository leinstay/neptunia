// Tests for src/memory/journal.js: the persona's journal records, written as JSON lines
// through an append store. A fake append store records `{ file, line }` and replays them on
// iterate; no real disk, no real data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createJournal } from '../src/memory/journal.js';

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
