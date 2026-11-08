// Tests for src/memory/journal.ts: the persona's journal records, written to the memory database
// (a test database on a temporary directory; the lines each write sends are recorded as `{ file,
// line }`, `file` the day file they stand for), and read back from it; no real data/.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  callMarksOf,
  createJournal,
  createOffPeriodsReader,
  offPeriods,
  triggerLinksOf,
} from '../src/memory/journal.ts';
import { tempDir } from './fixtures/tmp.ts';
import { journalLabel, openTestMemory, openTestMemorySync } from './fixtures/memory-db/service.ts';
import type { Untyped } from '../src/tools/types.ts';
import { wrongly, present } from './fixtures/loose-types.ts';
import type { StorageKey } from '../src/memory/db/storage-keys.ts';

const DATA = path.join('fake-root', 'data');
const DAY_D = Date.UTC(2026, 9, 13, 23, 59, 50);
const DAY_D1 = Date.UTC(2026, 9, 14, 0, 0, 5);

type Line = { file: string; line: string };

function fakeAppendStore() {
  const lines: Array<Line> = [];
  return {
    lines,
    append: async (file: string, line: string) => {
      lines.push({ file, line });
    },
    async *iterate(file: string) {
      let offset = 0;
      for (const entry of lines) {
        if (entry.file !== file) continue;
        yield { offset, line: entry.line };
        offset += Buffer.byteLength(entry.line) + 1;
      }
    },
  };
}

function counter(prefix: string) {
  let n = 0;
  return () => `${prefix}${(n += 1)}`;
}

/** The test databases opened here; closed when the file is done. */
const OPENED: Array<ReturnType<typeof openTestMemorySync>> = [];
after(async () => {
  for (const mem of OPENED) await mem.close();
});

/** A test memory database whose unit writes also record each line in `lines` as `{ file, line }`. */
function recordingMemory(lines: Array<Line>) {
  const mem = openTestMemorySync();
  OPENED.push(mem);
  return {
    ...mem.memoryDb,
    writeUnit: (update: unknown) => {
      const unit = wrongly<{ key: StorageKey; lines?: Array<unknown> }>(update);
      for (const line of unit.lines ?? []) {
        // File labels are a test export projection. The real writer receives the original semantic update.
        lines.push({ file: journalLabel(DATA, unit.key), line: JSON.stringify(line) });
      }
      return mem.memoryDb.writeUnit(update);
    },
  };
}

function journalAt(clock: { ms: number }) {
  const appendStore = fakeAppendStore();
  const journal = createJournal({
    appendStore,
    memoryDb: recordingMemory(appendStore.lines),
    dataDir: DATA,
    config: () => ({}),
    now: () => clock.ms,
    uuid: counter('u-'),
  });
  return { journal, appendStore };
}

const records = (appendStore: { lines: Array<Line> }) =>
  appendStore.lines.map(({ file, line }) => ({ file, record: wrongly<Record<string, Untyped>>(JSON.parse(line)) }));

test('journal: start allots a turnId and writes turn.start to the day of occurredAt', async () => {
  const clock = { ms: DAY_D };
  const { journal, appendStore } = journalAt(clock);
  const started = journal.start('g1', {
    placeId: 'c1',
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
  assert.equal(file, path.join(DATA, 'places', 'g1', 'journal', '2026-10-13.jsonl'));
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
  // The key names the place (the file above): the line itself no longer spells a root.
  assert.equal(record.occurredAt, started.startedAt);
  assert.equal(typeof record.recordedAt, 'string');

  // A second attempt keeps the turn's id.
  const second = journal.start('g1', { placeId: 'c1', mode: 'reply', turnId: started.turnId, attemptId: 2 });
  assert.equal(second.turnId, started.turnId);
  assert.equal(second.attemptId, 2);
});

test('journal: turn record carries the envelope and its think', async () => {
  const clock = { ms: DAY_D };
  const { journal, appendStore } = journalAt(clock);
  await journal.turn('g1', {
    turnId: 't-1',
    attemptId: 1,
    placeId: 'c1',
    outcome: 'spoke',
    reason: null,
    think: 'Ελένη ρώτησε για το γλυκό και θέλω να απαντήσω σύντομα. '.repeat(80),
    participants: ['u1', 'u2'],
    sourceMessageIds: ['m1', 'm2'],
    posted: [{ messageId: 's1', replyTo: 'm2' }],
  });
  const [{ record }] = records(appendStore);
  for (const key of [
    'v',
    'id',
    'kind',
    'occurredAt',
    'recordedAt',
    'scope',
    'participants',
    'sourceMessageIds',
    'origin',
  ]) {
    assert.ok(key in record, `envelope key ${key}`);
  }
  assert.equal(record.kind, 'turn');
  assert.equal(record.id, 'u-1');
  assert.deepEqual(record.scope, { channel: 'c1' });
  assert.deepEqual(record.participants, ['u1', 'u2']);
  // The owner's decision of 2026-11-02 keeps the whole think, so the former cap and its mark are gone.
  assert.ok(record.think.length > 0);
  assert.equal('thinkTruncated' in record, false);
  assert.deepEqual(record.posted, [{ messageId: 's1', replyTo: 'm2' }]);

  await journal.turn('g1', { turnId: 't-2', attemptId: 1, placeId: 'c1', outcome: 'skip', think: 'κοντό' });
  const short = records(appendStore)[1].record;
  assert.equal(short.think, 'κοντό');
  assert.equal('thinkTruncated' in short, false);
});

test('journal: a think over the former limit is stored whole', async () => {
  // Bug: a think over 4000 characters lost its tail, so her diary and her replay read a cut thought.
  const { journal, appendStore } = journalAt({ ms: DAY_D });
  const think = 'a'.repeat(9000);
  await journal.turn('g1', { turnId: 't-1', attemptId: 1, placeId: 'c1', outcome: 'spoke', reason: null, think });
  const [{ record }] = records(appendStore);
  assert.equal(record.think, think);
  assert.equal('thinkTruncated' in record, false);
});

test('journal: a private turn goes to the private day file, never the root file', async () => {
  const clock = { ms: DAY_D };
  const { journal, appendStore } = journalAt(clock);
  const started = journal.start('dm-u7', { placeId: 'dm1', mode: 'reply' });
  await journal.turn('dm-u7', { ...started, placeId: 'dm1', outcome: 'spoke' });
  const privateFile = path.join(DATA, 'places', 'dm-u7', 'journal', '2026-10-13.jsonl');
  assert.equal(journal.dayFile('dm-u7', '2026-10-13'), privateFile);
  assert.equal(appendStore.lines.length, 2);
  for (const { file, record } of records(appendStore)) {
    assert.equal(file, privateFile);
    // A private chat's lines name the chat; the place holding them says whose it is.
    assert.deepEqual(record.scope, { channel: 'dm1' });
  }
  assert.ok(appendStore.lines.every(({ file }) => file !== journal.dayFile('g1', '2026-10-13')));
  assert.equal((await journal.read('dm-u7', { day: '2026-10-13' })).length, 2);
  assert.deepEqual(await journal.read('g1', { day: '2026-10-13' }), []);
});

test('journal: read returns the last n records of a kind, newest last', async () => {
  const clock = { ms: DAY_D };
  const { journal } = journalAt(clock);
  const started = journal.start('g1', { placeId: 'c1', mode: 'interject' });
  await journal.system({ event: 'pause', by: 'owner' });
  clock.ms = DAY_D1;
  await journal.turn('g1', { turnId: started.turnId, attemptId: 1, placeId: 'c1', outcome: 'skip' });
  for (let i = 0; i < 3; i += 1) {
    const next = journal.start('g1', { placeId: 'c1', mode: 'reply' });
    await journal.turn('g1', { ...next, placeId: 'c1', outcome: `o${i}` });
  }

  const dayD = await journal.read('g1', { day: '2026-10-13' });
  // A system record belongs to the persona, not to the place a turn ran in.
  assert.deepEqual(
    dayD.map((r: Record<string, Untyped>) => r.kind),
    ['turn.start']
  );
  assert.deepEqual(
    (await journal.read(null, { day: '2026-10-13' })).map((r) => (r as { kind?: unknown }).kind),
    ['system']
  );
  const startD: Record<string, Untyped> = (await journal.read('g1', { day: '2026-10-13', kind: 'turn.start' }))[0];

  const turnsD1 = await journal.read('g1', { day: '2026-10-14', kind: 'turn', n: 2 });
  assert.deepEqual(
    turnsD1.map((r: Record<string, Untyped>) => r.outcome),
    ['o1', 'o2']
  );
  const all: Record<string, Untyped> = await journal.read('g1', { day: '2026-10-14', kind: 'turn' });
  assert.equal(all.length, 4);
  // The turn that started on day D closed on day D+1, linked by its turnId.
  assert.equal(all[0].turnId, startD.turnId);
  assert.equal(all[0].outcome, 'skip');
  assert.deepEqual(await journal.read('g1', { day: '2026-10-12' }), []);
});

test('triggerLinksOf: each posted message of a turn maps to the message that started it; a turn without one maps nothing', () => {
  const start = (turnId: string, messageId: Untyped) => ({
    kind: 'turn.start',
    turnId,
    trigger: messageId === null ? null : { kind: 'mention', messageId, authorId: 'u1' },
  });
  const turn = (turnId: string, ids: Record<string, Untyped>) => ({
    kind: 'turn',
    turnId,
    posted: ids.map((messageId: string) => ({ opId: `op-${messageId}`, messageId, replyTo: null })),
  });
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
  assert.deepEqual(triggerLinksOf(wrongly(null)), []);
});

test('journal: triggerLinks rebuilds the links of the days read, a turn closed the next day included', async () => {
  const clock = { ms: DAY_D };
  const { journal } = journalAt(clock);
  const first = journal.start('g1', {
    placeId: 'c1',
    mode: 'reply',
    trigger: { kind: 'mention', messageId: 'm1', authorId: 'u1' },
  });
  const spontaneous = journal.start('g1', { placeId: 'c1', mode: 'interject', trigger: wrongly(null) });
  await journal.turn('g1', {
    ...spontaneous,
    placeId: 'c1',
    outcome: 'spoke',
    posted: [{ messageId: 'p0', replyTo: null }],
  });
  clock.ms = DAY_D1;
  await journal.turn('g1', {
    ...first,
    placeId: 'c1',
    outcome: 'spoke',
    posted: [
      { messageId: 'p1', replyTo: null },
      { messageId: 'p2', replyTo: 'm7' },
    ],
  });
  journal.start('dm-u2', {
    placeId: 'c1',
    mode: 'reply',
    trigger: { kind: 'private', messageId: 'd1', authorId: 'u2' },
    turnId: 't-private',
  });
  await journal.turn('dm-u2', {
    turnId: 't-private',
    attemptId: 1,
    outcome: 'spoke',
    posted: [{ messageId: 'd2' }],
  });

  assert.deepEqual(await journal.triggerLinks('g1', { days: ['2026-10-13', '2026-10-14'] }), [
    ['p1', 'm1'],
    ['p2', 'm1'],
  ]);
  // The day the turn started not read: its posts have no known trigger.
  assert.deepEqual(await journal.triggerLinks('g1', { days: ['2026-10-14'] }), []);
});

test('callMarksOf: each skill call of the records with its channel, time, status (and why it did not work), target and the posts of its turn', () => {
  const at = (s: number) => `2026-10-14T10:00:${String(s).padStart(2, '0')}.000Z`;
  const skill = (opId: string, phase: Untyped, extra: Record<string, Untyped> = {}) => ({
    kind: 'action',
    name: 'skill',
    opId,
    turnId: 't1',
    phase,
    scope: { channel: 'c1' },
    occurredAt: at(extra.s ?? 0),
    ...extra,
  });
  const marks = callMarksOf([
    { kind: 'turn.start', turnId: 't1', trigger: { kind: 'mention', messageId: 'm1' } },
    {
      kind: 'action',
      name: 'post',
      opId: 'op-p',
      turnId: 't1',
      phase: 'succeeded',
      scope: { channel: 'c1' },
      result: { messageId: 'p1' },
    },
    skill('op-1', 'proposed', { input: { skill: 'message.create', invocationId: 'i1', args: ['channel'] }, s: 1 }),
    skill('op-1', 'started', { input: { skill: 'message.create' }, target: { channel: 'c9' }, s: 2 }),
    skill('op-1', 'succeeded', { result: { messageId: 'x1' }, s: 3 }),
    skill('op-2', 'proposed', { input: { skill: 'message.delete' }, s: 4 }),
    skill('op-2', 'failed', { result: { code: 'not-allowed', status: 'denied' }, s: 5 }),
    skill('op-3', 'proposed', { input: { skill: 'message.edit' }, s: 6 }),
    skill('op-3', 'started', { input: { skill: 'message.edit' }, target: { channel: 'c1', message: 'p0' }, s: 7 }),
    skill('op-3', 'failed', { result: { code: 'error' }, s: 8 }), // an old line without its status
    skill('op-4', 'proposed', { input: { skill: 'lore.list' }, s: 9 }),
    skill('op-4', 'unknown', { result: { code: 'timeout' }, s: 10 }),
    skill('op-5', 'proposed', { input: { skill: 'lore.list' }, s: 11 }), // never closed
    {
      kind: 'action',
      name: 'skill',
      opId: 'op-6',
      turnId: 't2',
      phase: 'proposed',
      scope: { user: 'u2', private: true },
      input: { skill: 'lore.list' },
      occurredAt: at(12),
    },
    skill('op-7', 'proposed', { input: { skill: 'message.delete' }, s: 13 }),
    skill('op-7', 'failed', {
      result: { code: 'invalid-args', status: 'invalid', reason: 'args.message:required' },
      s: 14,
    }),
    { kind: 'turn', turnId: 't1', posted: [{ messageId: 'p1' }, 'p2'] },
  ]);
  const posted = ['p1', 'x1', 'p2'];
  assert.deepEqual(marks.calls, [
    {
      placeId: 'c1',
      at: Date.parse(at(3)),
      skill: 'message.create',
      status: 'ok',
      target: { messageId: null, placeId: 'c9' },
      postedId: 'x1',
      posted,
    },
    {
      placeId: 'c1',
      at: Date.parse(at(5)),
      skill: 'message.delete',
      status: 'denied',
      code: 'not-allowed',
      target: { messageId: null, placeId: null },
      postedId: null,
      posted,
    },
    {
      placeId: 'c1',
      at: Date.parse(at(8)),
      skill: 'message.edit',
      status: 'failed',
      code: 'error',
      target: { messageId: 'p0', placeId: 'c1' },
      postedId: null,
      posted,
    },
    {
      placeId: 'c1',
      at: Date.parse(at(10)),
      skill: 'lore.list',
      status: 'unknown',
      code: 'timeout',
      target: { messageId: null, placeId: null },
      postedId: null,
      posted,
    },
    {
      placeId: 'c1',
      at: Date.parse(at(11)),
      skill: 'lore.list',
      status: 'unknown',
      target: { messageId: null, placeId: null },
      postedId: null,
      posted,
    },
    {
      placeId: 'c1',
      at: Date.parse(at(14)),
      skill: 'message.delete',
      status: 'invalid',
      code: 'invalid-args',
      reason: 'args.message:required',
      target: { messageId: null, placeId: null },
      postedId: null,
      posted,
    },
  ]);
  assert.deepEqual(
    marks.postedFrom,
    [['x1', 'c1']],
    'a post the call made in another channel names the channel of its turn'
  );
  assert.deepEqual(callMarksOf(wrongly(null)), { calls: [], postedFrom: [] });
});

test('journal: callMarks rebuilds the skill calls of the days read from the operations a turn wrote', async () => {
  const clock = { ms: DAY_D };
  const { journal } = journalAt(clock);
  const started = journal.start('g1', {
    placeId: 'c1',
    mode: 'reply',
    trigger: { kind: 'mention', messageId: 'm1', authorId: 'u1' },
  });
  const op = journal.op('g1', {
    turnId: started.turnId,
    name: 'skill',
    by: 'persona',
    placeId: 'c1',
    input: { skill: 'message.create', invocationId: 'i1' },
  });
  await op.proposed({ input: { skill: 'message.create', invocationId: 'i1', args: ['channel'], body: true } });
  await op.started({ target: { channel: 'c9' } });
  clock.ms = DAY_D1;
  await op.succeeded({ messageId: 'x1' });
  await journal.turn('g1', {
    ...started,
    placeId: 'c1',
    outcome: 'spoke',
    posted: [{ messageId: 'p1', replyTo: 'm1' }],
  });
  const refused = journal.op('g1', {
    turnId: started.turnId,
    name: 'skill',
    by: 'persona',
    placeId: 'c1',
    input: { skill: 'lore.list' },
  });
  await refused.proposed();
  await refused.failed('not-allowed', { status: 'denied' });

  const marks = await journal.callMarks('g1', { days: ['2026-10-13', '2026-10-14'] });
  assert.deepEqual(
    marks.calls.map((call: Record<string, Untyped>) => [
      call.placeId,
      call.skill,
      call.status,
      call.target,
      call.postedId,
      call.posted,
      call.at,
    ]),
    [
      ['c1', 'message.create', 'ok', { messageId: null, placeId: 'c9' }, 'x1', ['x1', 'p1'], DAY_D1],
      ['c1', 'lore.list', 'denied', { messageId: null, placeId: null }, null, ['x1', 'p1'], DAY_D1],
    ]
  );
  assert.deepEqual(marks.postedFrom, [['x1', 'c1']]);
  assert.deepEqual(await journal.callMarks('g1', { days: [] }), { calls: [], postedFrom: [] });
});

test('journal: a record missing participants or sourceMessageIds is written with empty arrays, never rejected', async () => {
  const clock = { ms: DAY_D };
  const { journal, appendStore } = journalAt(clock);
  await journal.turn('g1', {
    turnId: 't-1',
    attemptId: 1,
    placeId: 'c1',
    outcome: 'error',
    participants: null,
    sourceMessageIds: 'm1',
  });
  await journal.action('g1', {
    opId: 'op-1',
    turnId: 't-1',
    phase: 'started',
    name: 'post',
    by: 'persona',
    placeId: 'c1',
  });
  await journal.memory('g1', { batchId: 'b-1', participants: [7, 'u1', 'u1'] });
  await journal.system({ event: 'resume', by: 'owner' });
  const written = records(appendStore).map(({ record }) => record);
  assert.deepEqual(
    written.map((r) => r.kind),
    ['turn', 'action', 'memory', 'system']
  );
  for (const record of written) {
    assert.ok(Array.isArray(record.participants));
    assert.ok(Array.isArray(record.sourceMessageIds));
  }
  assert.deepEqual(written[0].participants, []);
  assert.deepEqual(written[0].sourceMessageIds, []);
  assert.deepEqual(written[1].scope, { channel: 'c1' });
  assert.deepEqual(written[2].participants, ['u1']);
  // A record of no chat has an empty scope: the key already names its place or the persona.
  assert.deepEqual(written[2].scope, {});
  assert.deepEqual(written[3].scope, {});
});

test('journal: op writes started then one closing phase with the same opId', async () => {
  const clock = { ms: DAY_D };
  const { journal, appendStore } = journalAt(clock);
  const op = journal.op('g1', {
    turnId: 't-1',
    name: 'post',
    by: 'persona',
    placeId: 'c1',
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
  assert.deepEqual(
    written.map((r) => r.phase),
    ['started', 'succeeded']
  );
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

  const failing = journal.op('g1', { turnId: 't-1', name: 'draw', by: 'persona', placeId: 'c1', dryRun: true });
  await failing.started({ input: { self: true } });
  await failing.failed('image-cap');
  const [fs, ff] = records(appendStore)
    .slice(2)
    .map(({ record }) => record);
  assert.deepEqual(fs.input, { self: true });
  assert.equal(fs.dryRun, true);
  assert.equal(ff.phase, 'failed');
  assert.deepEqual(ff.result, { code: 'image-cap' });
  assert.equal(ff.dryRun, true);
});

test('journal: pending lists started operations without a closing phase', async () => {
  const clock = { ms: DAY_D };
  const { journal } = journalAt(clock);
  const open = journal.op('g1', {
    turnId: 't-1',
    name: 'post',
    by: 'persona',
    placeId: 'c1',
    intent: { replyTo: 'm1', text: 'Ελένη' },
  });
  await open.started();
  const done = journal.op('g1', { turnId: 't-1', name: 'react', by: 'persona', placeId: 'c1' });
  await done.started();
  await done.succeeded({ to: 'm1', emoji: 'x' });
  const failed = journal.op('g1', { turnId: 't-1', name: 'gif', by: 'persona', placeId: 'c1' });
  await failed.started();
  await failed.failed('http-403');
  const lost = journal.op('g1', { turnId: 't-1', name: 'draw', by: 'persona', placeId: 'c1' });
  await lost.started();
  await lost.unknown();
  await journal.turn('g1', { turnId: 't-1', attemptId: 1, placeId: 'c1', outcome: 'spoke' });
  // Started late on day D, closed on D+1: open on D alone, closed over both days.
  clock.ms = DAY_D + 5000;
  const crossing = journal.op('g1', { turnId: 't-2', name: 'recall', by: 'engine', placeId: 'c2' });
  await crossing.started();
  clock.ms = DAY_D1;
  await crossing.succeeded({ hits: 0, delivered: false });

  const pending = await journal.pending('g1', { day: '2026-10-13' });
  assert.deepEqual(
    pending.map((p) => p.opId),
    [open.opId, crossing.opId]
  );
  assert.deepEqual(pending[0], {
    opId: open.opId,
    turnId: 't-1',
    name: 'post',
    intent: { replyTo: 'm1', text: 'Ελένη' },
    placeId: 'c1',
  });
  assert.deepEqual(
    (await journal.pending('g1', { days: ['2026-10-13', '2026-10-14'] })).map((p) => p.opId),
    [open.opId]
  );
  assert.deepEqual(await journal.pending('g1', { day: '2026-10-14' }), []);
});

test('journal: reconcile matches a post by replyTo and the first 80 chars of intent, else marks unknown, never re-sends', async () => {
  const clock = { ms: DAY_D - 60_000 };
  const { journal, appendStore } = journalAt(clock);
  const long = 'Καλημέρα σε όλους, σήμερα η Ζωή έφερε γλυκά και ο Andrés έφερε καφέ για την ομάδα μας.';
  const found = journal.op('g1', {
    turnId: 't-1',
    name: 'post',
    by: 'persona',
    placeId: 'c1',
    participants: ['u1'],
    intent: { replyTo: 'm1', text: long },
  });
  await found.started();
  // Same text, wrong reply target: not a match.
  const missing = journal.op('g1', {
    turnId: 't-1',
    name: 'post',
    by: 'persona',
    placeId: 'c1',
    intent: { replyTo: 'm2', text: 'ναι' },
  });
  await missing.started();
  // Right target, different text: not a match either.
  const plain = journal.op('g1', {
    turnId: 't-2',
    name: 'post',
    by: 'persona',
    placeId: 'c2',
    intent: { replyTo: null, text: 'éclair' },
  });
  await plain.started();
  const reacted = journal.op('g1', { turnId: 't-1', name: 'react', by: 'persona', placeId: 'c1' });
  await reacted.started();
  const recalled = journal.op('g1', { turnId: 't-1', name: 'recall', by: 'engine', placeId: 'c1' });
  await recalled.started();

  const sends: Array<Untyped> = [];
  const own = (id: string, content: Untyped, replyToId: Untyped) => ({
    id,
    content,
    replyToId,
    createdAt: DAY_D - 30_000,
    reply: () => sends.push(id),
    channel: { send: () => sends.push(id) },
  });
  const fetched: Array<Untyped> = [];
  const fetchOwnMessages = async (placeId: string, n: Untyped) => {
    fetched.push({ placeId, n });
    if (placeId === 'c1')
      return [own('s0', 'ναι', 'm9'), own('s1', `${long} και κάτι ακόμα`, 'm1'), own('s2', 'ναι', null)];
    return [own('s3', 'eclair', null)];
  };

  clock.ms = DAY_D;
  const counts = await journal.reconcile('g1', { days: ['2026-10-12', '2026-10-13'], fetchOwnMessages });
  assert.deepEqual(counts, { succeeded: 1, unknown: 4 });
  assert.deepEqual(sends, []);
  // One fetch per channel with a pending post; a react or a recall needs none.
  assert.deepEqual(
    fetched.sort((a, b) => a.placeId.localeCompare(b.placeId)),
    [
      { placeId: 'c1', n: 20 },
      { placeId: 'c2', n: 20 },
    ]
  );

  const closing = records(appendStore)
    .map(({ record }) => record)
    .filter((r) => r.phase !== 'started');
  const byOp: Record<string, Untyped> = new Map(closing.map((r) => [r.opId, r]));
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
  const op = journal.op('g1', {
    turnId: 't-1',
    name: 'post',
    by: 'persona',
    placeId: 'c1',
    intent: { replyTo: null, text: 'Ζωή' },
  });
  await op.started();
  const counts = await journal.reconcile('g1', {
    days: ['2026-10-13'],
    fetchOwnMessages: async () => {
      throw new Error('gone');
    },
  });
  assert.deepEqual(counts, { succeeded: 0, unknown: 1 });
  assert.equal(present(records(appendStore).at(-1)).record.phase, 'unknown');
});

test('journal: reconcile leaves alone an operation started after its cutoff', async () => {
  const clock = { ms: DAY_D - 10_000 };
  const { journal } = journalAt(clock);
  const old = journal.op('g1', { turnId: 't-1', name: 'react', by: 'persona', placeId: 'c1' });
  await old.started();
  clock.ms = DAY_D;
  // A turn running while the reconciliation reads: its post is still in flight.
  const live = journal.op('g1', {
    turnId: 't-2',
    name: 'post',
    by: 'persona',
    placeId: 'c1',
    intent: { replyTo: null, text: 'Ζωή' },
  });
  await live.started();
  const fetched: Array<Untyped> = [];
  const counts = await journal.reconcile('g1', {
    days: ['2026-10-13'],
    before: DAY_D - 1000,
    fetchOwnMessages: wrongly(async (placeId: string) => fetched.push(placeId) && []),
  });
  assert.deepEqual(counts, { succeeded: 0, unknown: 1 });
  assert.deepEqual(fetched, []);
  assert.deepEqual(
    (await journal.pending('g1', { day: '2026-10-13' })).map((p) => p.opId),
    [live.opId]
  );
});

test('journal: stalled follows the append store and a private memory record goes to the private day file', async () => {
  const clock = { ms: DAY_D };
  const { journal, appendStore }: Record<string, Untyped> = journalAt(clock);
  assert.equal(journal.stalled(), false, 'a store without stats never stalls');
  let stalled = false;
  appendStore.stats = () => ({ pending: stalled ? 1000 : 0, failed: 0, stalled });
  assert.equal(journal.stalled(), false);
  stalled = true;
  assert.equal(journal.stalled(), true);

  await journal.memory('dm-u7', { batchId: 'b-1', stage: 'single', participants: ['u7'] });
  const [{ file, record }] = records(appendStore);
  assert.equal(file, journal.dayFile('dm-u7', '2026-10-13'));
  assert.deepEqual(record.scope, {});
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
    placeId: 'c1',
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
  assert.equal(record.placeId, undefined, 'the channel is the scope, not stored twice');
  assert.deepEqual(
    (await journal.read('g1', { day: '2026-10-13', kind: 'answer' })).map((r: Record<string, Untyped>) => r.messageId),
    ['m1']
  );
  const { journalLine } = await import('../src/memory/journal.ts');
  assert.equal(
    journalLine({ ...record, occurredAt: '2026-10-13T08:09:10.000Z' }),
    '08:09:10 answer fact replaced-deferred'
  );
  assert.equal(
    journalLine({
      kind: 'answer',
      occurredAt: '2026-10-13T08:09:10.000Z',
      event: 'verdict',
      reason: 'gate-failed',
      verdict: 'owed',
    }),
    '08:09:10 answer verdict gate-failed owed'
  );
  assert.equal(
    journalLine({ kind: 'answer', occurredAt: '2026-10-13T08:09:10.000Z', event: 'recovery', outcome: 'spoke' }),
    '08:09:10 answer recovery spoke'
  );
});

// ---- the run marker: a real directory and database --------------------------------------------

async function realJournal(clock: Record<string, Untyped>) {
  const fsp = await import('node:fs/promises');
  const { createAppendStore } = await import('../src/memory/append-store.ts');
  const dataDir = tempDir('nep-journal-');
  const quiet = { info() {}, warn() {} };
  const mem = await openTestMemory({ dataDir });
  OPENED.push(mem);
  const appendStore = createAppendStore({ fsyncMs: 0, log: quiet, now: () => clock.ms });
  const make = (store = appendStore) =>
    createJournal({
      appendStore: store,
      dataDir,
      config: () => ({}),
      now: () => clock.ms,
      uuid: counter('r-'),
      log: quiet,
      memoryDb: mem.memoryDb,
    });
  return { fsp, dataDir, appendStore, make, journal: make() };
}

test('journal: a .running marker left over at start writes an unclean-stop record', async () => {
  const clock = { ms: DAY_D };
  const { fsp, dataDir, appendStore, journal } = await realJournal(clock);
  try {
    // Runtime markers belong under run/ so starting the journal does not recreate legacy memory folders.
    const running = path.join(dataDir, 'run', 'journal.running');
    // A clean first start: no leftover marker, no unclean-stop; the marker is written.
    assert.deepEqual(await journal.markRunning(), { unclean: false });
    await fsp.stat(running);
    await assert.rejects(fsp.stat(path.join(dataDir, 'guilds')), { code: 'ENOENT' });
    // A clean shutdown removes it.
    await journal.clearRunning();
    await assert.rejects(fsp.stat(running), { code: 'ENOENT' });
    assert.deepEqual(await journal.read(null, { day: '2026-10-13' }), []);

    // A killed process leaves it behind: the next start says so first.
    await journal.markRunning();
    assert.deepEqual(await journal.markRunning(), { unclean: true });
    await appendStore.flush();
    const written = await journal.read(null, { day: '2026-10-13' });
    assert.deepEqual(
      written.map((r: Record<string, Untyped>) => [r.kind, r.event]),
      [['system', 'unclean-stop']]
    );
    await fsp.stat(running);
  } finally {
    await appendStore.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test('journalLine: one short line per kind', async () => {
  const { journalLine } = await import('../src/memory/journal.ts');
  const at = '2026-10-13T08:09:10.000Z';
  assert.equal(
    journalLine({
      kind: 'turn',
      occurredAt: at,
      mode: 'reply',
      outcome: 'spoke',
      seen: { messageIds: ['a', 'b', 'c'] },
      think: `Ζωή\n${'x'.repeat(100)}`,
    }),
    `08:09:10 turn reply spoke 3 msgs, think: Ζωή ${'x'.repeat(76)}`
  );
  assert.equal(
    journalLine({ kind: 'turn', occurredAt: at, mode: 'interject', outcome: 'skip', think: null }),
    '08:09:10 turn interject skip 0 msgs, think: -'
  );
  assert.equal(
    journalLine({ kind: 'action', occurredAt: at, name: 'post', phase: 'started' }),
    '08:09:10 action post started'
  );
  assert.equal(
    journalLine({
      kind: 'memory',
      occurredAt: at,
      batch: { messageIds: ['a'], consumed: 4 },
      changed: { users: ['u1', 'u2'] },
      episodes: [{}],
    }),
    '08:09:10 memory batch 4 lines, users 2, episodes 1'
  );
  assert.equal(
    journalLine({ kind: 'system', occurredAt: at, event: 'pause', by: 'owner' }),
    '08:09:10 system pause owner'
  );
  assert.equal(journalLine({ kind: 'system', occurredAt: at, event: 'unclean-stop' }), '08:09:10 system unclean-stop');
  assert.equal(
    journalLine({ kind: 'system', occurredAt: at, event: 'reload', note: 'prompts' }),
    '08:09:10 system reload prompts'
  );
});

test('journal: withWriterLock flushes the store first and holds appends until fn resolves', async () => {
  const clock = { ms: DAY_D };
  const { journal, appendStore }: Record<string, Untyped> = journalAt(clock);
  const order: Array<Untyped> = [];
  appendStore.flush = async () => {
    order.push('flush');
  };
  let finish: ((value?: unknown) => void) | undefined;
  const held = new Promise((resolve) => {
    finish = resolve;
  });
  const locked = journal.withWriterLock(async () => {
    order.push('fn');
    await held;
    return 'copied';
  });
  await new Promise((resolve) => setImmediate(resolve));
  const writing = journal.system({ event: 'pause', by: 'owner' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['flush', 'fn']);
  assert.equal(appendStore.lines.length, 0);
  present(finish)();
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
    /disk full/
  );
  await journal.system({ event: 'resume', by: 'owner' });
  assert.equal(appendStore.lines.length, 1);
});

// ---- the persona's time away: offPeriods, timeline, createOffPeriodsReader ----

const T0 = Date.UTC(2026, 9, 14, 10, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY_WINDOW = 24 * HOUR;
const sys = (at: number, event: Untyped) => ({ at, kind: 'system', event });
const turnAt = (at: number) => ({ at, kind: 'turn', event: null });

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
    sys(T0, 'pause'),
    sys(T0 + 10 * MINUTE, 'resume'),
    sys(T0 + HOUR, 'pause'),
    sys(T0 + HOUR + 10 * MINUTE, 'resume'),
    sys(T0 + 2 * HOUR, 'stop'),
    sys(T0 + 2 * HOUR + 10 * MINUTE, 'start'),
    // A pause that a restart falls inside: one period, paused.
    sys(T0 + 3 * HOUR, 'pause'),
    sys(T0 + 3 * HOUR + 5 * MINUTE, 'stop'),
    sys(T0 + 3 * HOUR + 6 * MINUTE, 'start'),
    sys(T0 + 3 * HOUR + 40 * MINUTE, 'resume'),
  ];
  assert.deepEqual(offPeriods(timeline, { now: T0 + 5 * HOUR, windowMs: DAY_WINDOW }), [
    { kind: 'paused', from: T0 + 3 * HOUR, to: T0 + 3 * HOUR + 40 * MINUTE },
    { kind: 'stopped', from: T0 + 2 * HOUR, to: T0 + 2 * HOUR + 10 * MINUTE },
    { kind: 'paused', from: T0 + HOUR, to: T0 + HOUR + 10 * MINUTE },
  ]);
});

test('journal: timeline reads the root day files the window spans, oldest first, kind and event only', async () => {
  const clock = { ms: T0 - 36 * HOUR };
  const { journal } = journalAt(clock);
  await journal.system({ event: 'stop', by: 'service' }); // two days back: outside the read days
  clock.ms = T0 - 20 * HOUR; // yesterday
  journal.start('g1', { placeId: 'c1', mode: 'reply', participants: ['u1'] });
  await Promise.resolve();
  clock.ms = T0;
  await journal.system({ event: 'start', by: 'service' });
  journal.start('dm-u2', { placeId: 'c1', mode: 'reply' }); // a private journal: not read
  await Promise.resolve();
  const timeline = await journal.timeline('g1', { from: T0 - DAY_WINDOW });
  assert.deepEqual(timeline, [
    { at: T0 - 20 * HOUR, kind: 'turn.start', event: null },
    { at: T0, kind: 'system', event: 'start' },
  ]);
});

test('createOffPeriodsReader: reads the window once a minute and gives [] with a warn on a failure', async () => {
  const clock = { ms: T0 + HOUR };
  const reads: Array<Untyped> = [];
  const warns: Array<Untyped> = [];
  let fail = false;
  const journal = {
    timeline: async (placeId: string, query: string) => {
      reads.push([placeId, query]);
      if (fail) throw Object.assign(new Error('boom'), { code: 'EIO' });
      return [sys(T0, 'pause'), sys(T0 + 20 * MINUTE, 'resume')];
    },
  };
  const log = { warn: (event: string, fields: Untyped) => warns.push([event, fields]) };
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
  assert.deepEqual(warns, [['journal: off periods unread', { placeId: 'g1', code: 'EIO' }]]);

  // No reader at all: nothing to show.
  assert.deepEqual(await createOffPeriodsReader({ journal: null })('g1', { windowHours: 24 }), []);
});

test('journal: turnOperations gives the operations of one turn with how each ended; a started one without a closing line is open, a proposed one never started stays proposed', async () => {
  const clock = { ms: DAY_D };
  const { journal } = journalAt(clock);
  const post = journal.op('g1', {
    turnId: 't-1',
    name: 'post',
    by: 'persona',
    placeId: 'c1',
    intent: { replyTo: null, text: 'Ελένη' },
  });
  await post.started();
  await post.succeeded({ messageId: 's1' });
  const call = journal.op('g1', {
    turnId: 't-1',
    name: 'skill',
    by: 'persona',
    placeId: 'c1',
    input: { skill: 'message.create', invocationId: 'i1' },
  });
  await call.proposed();
  await call.started();
  const refused = journal.op('g1', {
    turnId: 't-1',
    name: 'skill',
    by: 'persona',
    placeId: 'c1',
    input: { skill: 'draw.create', invocationId: 'i2' },
  });
  await refused.proposed();
  const other = journal.op('g1', { turnId: 't-2', name: 'react', by: 'persona', placeId: 'c1' });
  await other.started();
  await other.succeeded({});
  const ops = await journal.turnOperations('g1', { turnId: 't-1', days: ['2026-10-13'] });
  assert.deepEqual(
    ops.map((op) => [op.name, op.phase, op.skill, op.text]),
    [
      ['post', 'succeeded', null, 'Ελένη'],
      ['skill', 'open', 'message.create', null],
      ['skill', 'proposed', 'draw.create', null],
    ]
  );
  assert.deepEqual(await journal.turnOperations('g1', { turnId: 't-9', days: ['2026-10-13'] }), []);
  assert.deepEqual(await journal.turnOperations('g1', { turnId: wrongly(null), days: ['2026-10-13'] }), []);
});
