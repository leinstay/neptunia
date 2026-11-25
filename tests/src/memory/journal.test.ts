// Tests for src/memory/journal.ts: the persona's journal records, written to the memory database and read back from
// it. Most tests use a test database on a temporary directory and record the lines each write sends as `{ file,
// line }`, `file` the day file they stand for. Later sections use the reader fixture, a reopened database, and the
// real service over seeded people and places. No real data/.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  callMarksOf,
  createJournal,
  createOffPeriodsReader,
  offPeriods,
  triggerLinksOf,
  turnOfMessage,
  turnView,
} from '../../../src/memory/journal.ts';
import { createAppendStore } from '../../../src/memory/append-store.ts';
import { createArchive } from '../../../src/memory/archive.ts';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { createMemoryDb } from '../../../src/memory/db/service.ts';
import type { MemoryDbService } from '../../../src/memory/db/service.ts';
import { PERSONA_ID } from '../../../src/memory/db/ids.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import type { Db } from '../../../src/memory/db/types.ts';
import type { JournalLinesWrite } from '../../../src/memory/db/journal-lines.ts';
import { createRecord } from '../../../src/memory/record.ts';
import { createStore } from '../../../src/memory/store.ts';
import { createVectors } from '../../../src/memory/vectors.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { journalLineLabel, openTestMemory, openTestMemorySync, tempDataDir } from '../../fixtures/memory-db/service.ts';
import { addAccount, addDmPlace, addGroupPlace } from '../../fixtures/memory-db/opaque-people.ts';
import {
  GUILD,
  placeOfGuild,
  readAt,
  GUILD_2,
  MEMBER,
  readerEnv,
  type ReaderEnv,
} from '../../fixtures/memory-db/readers.ts';
import { wrongly, present } from '../../fixtures/loose-types.ts';
import { internalContext, scopeWhere } from '../../../src/memory/db/scope.ts';
import { IFACE, SELF_ID, channel, rig, message } from '../../fixtures/reads-rig.ts';
import { ownMessagesOf } from '../../../src/behavior/own-messages.ts';
import { createDiscordAdapter, createDiscordInterface } from '../../../interfaces/discord/index.ts';
import { createTurnRunner } from '../../fixtures/turn-runner.ts';
import {
  NOW as TURN_MEMORY_CONTEXT_NOW,
  fakeClient,
  fakeLookup,
  fakeStore,
  fakeTurnChannel,
  identityCalibrator,
} from '../../fixtures/turn-kit.ts';
import { splitLlm, splitHot, manualSchedule } from '../../fixtures/turn-split.ts';
import { createTurnRunner as faultCreateTurnRunner } from '../../../src/behavior/turn.ts';
import { createReads } from '../../../src/interface/reads.ts';
import { userText } from '../../../src/behavior/prompt.ts';
import { createInnerLife } from '../../../src/behavior/inner.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createEventDoor } from '../../../src/interface/door.ts';
import { personaJournal } from '../../../src/behavior/inner/persona-sources.ts';
import { createErrandStores } from '../../../src/errands/store.ts';
import { createErrandService } from '../../../src/errands/service.ts';
import { createErrandTurns } from '../../../src/errands/turns.ts';
import { runOp } from '../../../src/tools/operations/index.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import { createAdmin } from '../../../src/admin.ts';
import { HOUR_MS, utcDay } from '../../../src/time.ts';
import { labels } from '../../fixtures/labels.ts';
import { call, completionOf, toolAnswer } from '../../fixtures/tool-answers.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { OWNER_PERSON, ownedBy } from '../../fixtures/owner-accounts.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import { describe } from 'node:test';

const quiet = { info() {}, debug() {}, warn() {}, error() {} };

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
    writeJournalLines: (write: JournalLinesWrite) => {
      for (const line of write.lines) {
        // File labels are a test export projection. The real writer receives the original write.
        lines.push({ file: journalLineLabel(DATA, write.placeId, line), line: JSON.stringify(line) });
      }
      return mem.memoryDb.writeJournalLines(write);
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
  // The key names the place (the file above): the line itself spells no root.
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
  // The think is kept whole, with no cap and no mark of a cut.
  assert.ok(record.think.length > 0);
  assert.equal('thinkTruncated' in record, false);
  assert.deepEqual(record.posted, [{ messageId: 's1', replyTo: 'm2' }]);

  await journal.turn('g1', { turnId: 't-2', attemptId: 1, placeId: 'c1', outcome: 'skip', think: 'κοντό' });
  const short = records(appendStore)[1].record;
  assert.equal(short.think, 'κοντό');
  assert.equal('thinkTruncated' in short, false);
});

test('journal: a think over the former limit is stored whole', async () => {
  // Bug: a think over 4000 characters lost its tail, so the persona's diary and replay read a cut thought.
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
  const gif = journal.op('g1', { turnId: 't-1', name: 'gif', by: 'persona', placeId: 'c1' });
  await gif.started();
  await gif.failed('http-403');
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
  const { journalLine } = await import('../../../src/memory/journal.ts');
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
  const { createAppendStore } = await import('../../../src/memory/append-store.ts');
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

// The think in a journal line is kept whole, with no limit of 80.
test('journalLine: one line per kind, the think whole', async () => {
  const { journalLine } = await import('../../../src/memory/journal.ts');
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
    `08:09:10 turn reply spoke 3 msgs, think: Ζωή ${'x'.repeat(100)}`
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
  const [written] = appendStore.lines as Array<Line>;
  assert.equal(JSON.parse(written.line).event, 'pause');
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

const FIVE_MINUTES = 5 * MINUTE;

test('offPeriods: with minMs a stop of 30 seconds is left out and one of six minutes stays', () => {
  // Bug: every deploy restart fills the list of off periods, so a stop the persona cannot have felt reads as an absence.
  const timeline = [
    sys(T0, 'stop'),
    sys(T0 + 30_000, 'start'),
    sys(T0 + HOUR, 'stop'),
    sys(T0 + HOUR + 6 * MINUTE, 'start'),
  ];
  const options = { now: T0 + 2 * HOUR, windowMs: DAY_WINDOW, minMs: FIVE_MINUTES };
  assert.deepEqual(offPeriods(timeline, options), [{ kind: 'stopped', from: T0 + HOUR, to: T0 + HOUR + 6 * MINUTE }]);
});

test('offPeriods: two stops of three minutes under a minute apart are one period of seven and stay under minMs of five', () => {
  // Bug: the cut measures each stop before the merge, so one outage that a restart interrupted is dropped as two
  // short ones.
  const timeline = [
    sys(T0, 'stop'),
    sys(T0 + 3 * MINUTE, 'start'),
    sys(T0 + 3 * MINUTE + 30_000, 'stop'),
    sys(T0 + 7 * MINUTE, 'start'),
  ];
  const options = { now: T0 + HOUR, windowMs: DAY_WINDOW, minMs: FIVE_MINUTES };
  assert.deepEqual(offPeriods(timeline, options), [{ kind: 'stopped', from: T0, to: T0 + 7 * MINUTE }]);
});

test('offPeriods: the cut comes before the newest three are taken, so three short restarts do not hide an hour', () => {
  // Bug: the newest three periods are taken first and the short ones filtered after, so an absence of an hour that
  // three later restarts followed never reaches the persona.
  const timeline = [
    sys(T0, 'pause'),
    sys(T0 + HOUR, 'resume'),
    sys(T0 + 2 * HOUR, 'stop'),
    sys(T0 + 2 * HOUR + 20_000, 'start'),
    sys(T0 + 3 * HOUR, 'stop'),
    sys(T0 + 3 * HOUR + 20_000, 'start'),
    sys(T0 + 4 * HOUR, 'stop'),
    sys(T0 + 4 * HOUR + 20_000, 'start'),
  ];
  const options = { now: T0 + 5 * HOUR, windowMs: DAY_WINDOW, minMs: FIVE_MINUTES };
  assert.deepEqual(offPeriods(timeline, options), [{ kind: 'paused', from: T0, to: T0 + HOUR }]);
});

test('offPeriods: without minMs a period of 30 seconds stays', () => {
  // Bug: a shipped cut is applied when the caller sets none, so the setting at 0 cannot keep every period.
  const timeline = [sys(T0, 'stop'), sys(T0 + 30_000, 'start')];
  assert.deepEqual(offPeriods(timeline, { now: T0 + HOUR, windowMs: DAY_WINDOW }), [
    { kind: 'stopped', from: T0, to: T0 + 30_000 },
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

// ---- the turn of a message: turnOfMessage, findTurn, turnView -------------------------------------------------

// The turn record of the turn that posted one of the persona's messages, found by the message's own UTC day (from
// its id) and the next, shown whole.

type Clock = { ms: number };

/** The id of a message sent at `ms` on a platform whose ids carry their time (the first possible id of that millisecond), `n` keeping ids of the same millisecond apart. */
const ID_EPOCH_MS = 1_420_070_400_000n;
const idAt = (ms: number, n = 1) => (((BigInt(ms) - ID_EPOCH_MS) << 22n) + BigInt(n)).toString();

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A long think in Greek: far past the 80 characters a day line shows. */
const THINK = `Η Ελένη ρωτά για το ταξίδι. ${'Σκέφτομαι τι να πω, και πώς. '.repeat(90)}Τέλος.`;

/**
 * One turn written as a live turn writes it: `turn.start` at `startMs`, a post operation closed
 * `succeeded` with `postedId` at `postMs`, the `turn` record at `endMs`. `oldShape`: the record
 * keeps no `posted` ids (only the action line names the post). `call`: a skill call of the turn.
 */
async function writeTurn(
  journal: ReturnType<typeof journalAt>['journal'],
  clock: Clock,
  {
    startMs,
    postMs,
    endMs,
    triggerId,
    postedId,
    oldShape = false,
    call = false,
  }: {
    startMs: number;
    postMs: number;
    endMs: number;
    triggerId: string;
    postedId: string;
    oldShape?: boolean;
    call?: boolean;
  }
) {
  clock.ms = startMs;
  const started = journal.start('g1', {
    placeId: 'c1',
    mode: 'reply',
    trigger: { kind: 'mention', messageId: triggerId, authorId: '7' },
    participants: ['7'],
    sourceMessageIds: [triggerId],
  });
  await tick();
  clock.ms = postMs;
  const op = journal.op('g1', {
    turnId: started.turnId,
    name: 'post',
    by: 'persona',
    placeId: 'c1',
    intent: { replyTo: triggerId, text: 'γεια' },
  });
  await op.started();
  await op.succeeded({ messageId: postedId });
  const actions = [op.opId];
  if (call) {
    const skill = journal.op('g1', {
      turnId: started.turnId,
      name: 'skill',
      by: 'persona',
      placeId: 'c1',
      input: { skill: 'memory.profile.read', invocationId: 'inv-1' },
    });
    await skill.proposed({
      input: { skill: 'memory.profile.read', invocationId: 'inv-1', args: ['user'], body: false },
    });
    await skill.started({ target: { user: '7' } });
    await skill.succeeded({});
    actions.push(skill.opId);
  }
  clock.ms = endMs;
  await journal.turn('g1', {
    turnId: started.turnId,
    attemptId: started.attemptId,
    startedAt: started.startedAt,
    placeId: 'c1',
    mode: 'reply',
    outcome: 'spoke',
    reason: null,
    seen: { messageIds: [triggerId] },
    think: THINK,
    posted: oldShape ? [] : [{ opId: op.opId, messageId: postedId, replyTo: triggerId }],
    actions,
  });
  return started;
}

const D = Date.UTC(2026, 9, 13, 12, 0, 0);

test('turnOfMessage: the turn whose posted names the message, its start, its posts and its skill call', async () => {
  const clock = { ms: D };
  const { journal, appendStore } = journalAt(clock);
  const postedId = idAt(D + 3000);
  const started = await writeTurn(journal, clock, {
    startMs: D,
    postMs: D + 3000,
    endMs: D + 5000,
    triggerId: 'm-trigger',
    postedId,
    call: true,
  });
  const records = appendStore.lines.map(({ line }) => JSON.parse(line));

  const found = turnOfMessage(records, postedId);
  assert.equal(wrongly<Untyped>(present(found).turn).turnId, started.turnId);
  assert.equal(wrongly<Untyped>(present(present(found).start)).trigger.messageId, 'm-trigger');
  assert.deepEqual(present(found).posted, [postedId]);
  assert.deepEqual(present(found).calls, [
    {
      skill: 'memory.profile.read',
      args: ['user'],
      target: { user: '7' },
      phase: 'succeeded',
      code: null,
      messageId: null,
    },
  ]);
  assert.equal(turnOfMessage(records, 'm-trigger'), null, 'the message that started the turn is not one it posted');
  assert.equal(turnOfMessage(records, 'm-none'), null);
  assert.equal(turnOfMessage(wrongly(null), postedId), null);

  // The view: every field, the think whole.
  const view = turnView(wrongly(found));
  assert.ok(view.includes(THINK), 'the stored think, whole');
  for (const part of [
    started.turnId,
    'reply',
    'spoke',
    'mention m-trigger',
    postedId,
    'c1',
    'memory.profile.read',
    started.startedAt,
  ])
    assert.ok(view.includes(part), part);
});

test('turnOfMessage: an old record without posted ids is found through its post operation', async () => {
  const clock = { ms: D };
  const { journal, appendStore } = journalAt(clock);
  const postedId = idAt(D + 3000);
  const started = await writeTurn(journal, clock, {
    startMs: D,
    postMs: D + 3000,
    endMs: D + 5000,
    triggerId: 'm-t',
    postedId,
    oldShape: true,
  });
  const records = appendStore.lines.map(({ line }) => JSON.parse(line));
  const found = turnOfMessage(records, postedId);
  assert.equal(wrongly<Untyped>(present(found).turn).turnId, started.turnId);
  assert.deepEqual(present(found).posted, [postedId], 'the posted ids from the operation line');

  // A record whose posted list holds bare strings, empty ones among them, still reads.
  const legacy = records.map((record) => (record.kind === 'turn' ? { ...record, posted: ['', postedId] } : record));
  assert.deepEqual(present(turnOfMessage(legacy, postedId)).posted, [postedId]);
});

test('findTurn: a turn that crossed midnight -- the record of the next day, the start of the day before', async () => {
  const clock = { ms: D };
  const { journal } = journalAt(clock);
  // Posted at 23:59:58, the turn record written at 00:00:05 the next day.
  const lateStart = Date.UTC(2026, 9, 13, 23, 59, 50);
  const latePost = Date.UTC(2026, 9, 13, 23, 59, 58);
  const lateId = idAt(latePost);
  const late = await writeTurn(journal, clock, {
    startMs: lateStart,
    postMs: latePost,
    endMs: Date.UTC(2026, 9, 14, 0, 0, 5),
    triggerId: 'm-late',
    postedId: lateId,
  });
  const found = await journal.findTurn('g1', { messageId: lateId, at: latePost });
  assert.equal(wrongly<Untyped>(present(found).turn).turnId, late.turnId);
  assert.equal(wrongly<Untyped>(present(present(found).start)).trigger.messageId, 'm-late');

  // Started at 23:59:50, posted after midnight: the start is read from the day before.
  const earlyStart = Date.UTC(2026, 9, 14, 23, 59, 50);
  const earlyPost = Date.UTC(2026, 9, 15, 0, 0, 2);
  const earlyId = idAt(earlyPost);
  const early = await writeTurn(journal, clock, {
    startMs: earlyStart,
    postMs: earlyPost,
    endMs: Date.UTC(2026, 9, 15, 0, 0, 4),
    triggerId: 'm-early',
    postedId: earlyId,
  });
  const crossed = await journal.findTurn('g1', { messageId: earlyId, at: earlyPost });
  assert.equal(wrongly<Untyped>(present(crossed).turn).turnId, early.turnId);
  assert.equal(wrongly<Untyped>(present(present(crossed).start)).trigger.messageId, 'm-early');

  // Two days later nothing of these is searched.
  assert.equal(await journal.findTurn('g1', { messageId: lateId, at: latePost + 2 * 86_400_000 }), null);
});

test('turnView: an old skip record with reason null still reads', () => {
  const turn = {
    kind: 'turn',
    turnId: 't-old',
    attemptId: 1,
    mode: 'reply',
    outcome: 'skip',
    reason: null,
    think: null,
    posted: [],
  };
  const view = turnView({ turn, start: null, posted: [], calls: [] });
  assert.ok(view.includes('outcome: skip, reason: -'));
  const silent = turnView({ turn: { ...turn, reason: 'silence' }, start: null, posted: [], calls: [] });
  assert.ok(silent.includes('outcome: skip, reason: silence'));
});

test('a skill action line keeps the tool call id and the coerced argument names, nothing else of the arguments', async () => {
  const clock = { ms: Date.UTC(2026, 9, 13, 12) };
  const { journal, appendStore } = journalAt(clock);
  const op = journal.op('g1', { name: 'message.create', by: 'persona', input: { skill: 'message.create' } });
  await op.proposed({ input: { skill: 'message.create', args: ['count'], toolCallId: 'call_1', coerced: ['count'] } });
  await tick();
  const [first] = appendStore.lines;
  const line = JSON.parse(first.line);
  assert.equal(line.input.toolCallId, 'call_1');
  assert.deepEqual(line.input.coerced, ['count']);
  assert.equal(JSON.stringify(line).includes('"7"'), false);
});

// ---- the journal over a reopened database ------------------------------------------------------------------------

const LINES_NOW = Date.parse('2026-11-09T10:00:00.000Z');
const LINES_ROOT = 'synthetic:root:1';
const LINES_DAY = '2026-11-09T08:00:00.000Z';

test('the journal reads back what it wrote after the database is closed and opened again', async () => {
  const dataDir = tempDataDir();
  let clock = Date.parse(LINES_DAY);
  const now = () => clock;
  const first = await openTestMemory({ dataDir, now: () => LINES_NOW, iface: () => 'synthetic' });
  const written: Array<object> = [];
  try {
    const journal = createJournal({ dataDir, memoryDb: first.memoryDb, now });
    const { turnId } = journal.start(LINES_ROOT, { placeId: 'room-a', mode: 'reply' });
    clock += 1000;
    await journal.turn(LINES_ROOT, { placeId: 'room-a', turnId, think: 'a synthetic thought', outcome: 'spoke' });
    await journal.memory(LINES_ROOT, { batchId: 'b-1', attitude: [{ accountId: 'member', delta: 1 }] });
    written.push(...(await journal.read(LINES_ROOT, { day: LINES_DAY, n: 10 })));
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => LINES_NOW, iface: () => 'synthetic' });
  try {
    const journal = createJournal({ dataDir, memoryDb: second.memoryDb, now });
    const read = await journal.read(LINES_ROOT, { day: LINES_DAY, n: 10 });
    assert.equal(read.length, 3);
    assert.deepEqual(read, written);
    assert.deepEqual(
      read.map((line) => (line as { kind?: unknown }).kind),
      ['turn.start', 'turn', 'memory']
    );
    assert.equal((await journal.stats(LINES_ROOT)).lastWriteMs, clock);
  } finally {
    await second.close();
  }
});

test('a memory line reads back its own attitude, never that of a line whose id begins with its id', async () => {
  // Bug: a line's attitude rows were found by the prefix `aff:<line id>:` of their ids, which the rows of line `<id>:2` share.
  const dataDir = tempDataDir();
  const memory = await openTestMemory({ dataDir, now: () => LINES_NOW, iface: () => 'synthetic' });
  try {
    const journal = createJournal({ dataDir, memoryDb: memory.memoryDb, now: () => Date.parse(LINES_DAY) });
    await journal.memory(LINES_ROOT, { id: 'line-a', batchId: 'b-1', attitude: [{ accountId: 'member', delta: 1 }] });
    await journal.memory(LINES_ROOT, { id: 'line-a:2', batchId: 'b-2', attitude: [{ accountId: 'member', delta: 2 }] });
    const read = (await journal.read(LINES_ROOT, { day: LINES_DAY, n: 10 })) as Array<{
      id?: string;
      attitude?: Array<{ delta?: number }>;
    }>;
    assert.deepEqual(read.map((line) => [line.id, (line.attitude ?? []).map((move) => move.delta)]).sort(), [
      ['line-a', [1]],
      ['line-a:2', [2]],
    ]);
  } finally {
    await memory.close();
  }
});

// ---- the journal's reads from the database --------------------------------------------------------------------------

// The day reads and everything built on them (findTurn, turnOperations, pending, triggerLinks, callMarks, timeline)
// answer from the database, and fail with a code when the database cannot answer.

const READER_NOW = Date.parse('2026-10-21T23:00:00.000Z');
const READER_DAYS = ['2026-10-19', '2026-10-20', '2026-10-21'];

// The journal's records are untyped; the tests read these fields.
type Rec = { id: string; turnId: string; kind: string; think: string; attitude: Array<unknown> };
const rec = (value: object | null | undefined) => value as Partial<Rec> | null | undefined;

const journalOf = (env: ReaderEnv, memoryDb: ReaderEnv['memoryDb'] | ReaderEnv['closedDb'] = env.memoryDb) =>
  createJournal({ dataDir: env.data, log: env.log, now: () => READER_NOW, memoryDb });

test('journal db reader: read answers every day, kind, limit and layer, the turn and memory joins included', async () => {
  const env = await readerEnv();
  try {
    const journal = journalOf(env);
    const queries = [
      { n: 1000 },
      { n: 2 },
      { kind: 'action', n: 1000 },
      { kind: 'turn' },
      { privateAccountId: MEMBER, n: 1000 },
    ];
    const none = [[], [], [], [], []];
    const day20 = (suffix: string, privateIds: Array<string>) => [
      [`j-start${suffix}`, `j-turn${suffix}`, `j-system${suffix}`, `j-memory${suffix}`],
      [`j-system${suffix}`, `j-memory${suffix}`],
      [],
      [`j-turn${suffix}`],
      privateIds,
    ];
    const expected: Record<string, Record<string, Array<Array<string>>>> = {
      [GUILD]: {
        '2026-10-19': none,
        '2026-10-20': day20('', ['jp-a1', 'jp-a2']),
        '2026-10-21': [
          ['j2-start', 'j2-a1', 'j2-a2', 'j2-a3', 'j2-turn', 'j2-system', 'j2-hidden'],
          ['j2-system', 'j2-hidden'],
          ['j2-a1', 'j2-a2', 'j2-a3', 'j2-hidden'],
          ['j2-turn'],
          [],
        ],
      },
      [GUILD_2]: { '2026-10-19': none, '2026-10-20': day20('.g2', []), '2026-10-21': none },
    };
    for (const placeId of [GUILD, GUILD_2]) {
      for (const day of READER_DAYS) {
        for (const [index, query] of queries.entries()) {
          // A DM place has no guild: the private queries run once, under the first guild.
          if (placeId === GUILD_2 && 'privateAccountId' in query) continue;
          const { placeId: holder, rest } = readAt(placeId, query);
          const ids = (await journal.read(holder, { day, ...rest })).map((record) => rec(record)?.id);
          const byQuery = expected[placeId][day];
          assert.deepEqual(ids, byQuery[index], `${placeId} ${day} ${JSON.stringify(query)}`);
        }
      }
    }
    const day = await journal.read(placeOfGuild(GUILD), { day: '2026-10-20', n: 1000 });
    assert.equal(rec(day.find((record) => rec(record)?.kind === 'turn'))?.think, 'Καλημέρα. A café thought.');
    assert.equal(rec(day.find((record) => rec(record)?.kind === 'memory'))?.attitude?.length, 1);
    assert.deepEqual(env.warns, []);
  } finally {
    env.done();
  }
});

test('journal db reader: findTurn, turnOperations, pending, triggerLinks, callMarks and timeline', async () => {
  const env = await readerEnv();
  try {
    const journal = journalOf(env);
    const found = await journal.findTurn(placeOfGuild(GUILD), {
      messageId: '400000000000000014',
      at: Date.parse('2026-10-21T08:07:00.000Z'),
    });
    assert.deepEqual(
      { turn: rec(found?.turn)?.id, start: rec(found?.start)?.id, posted: found?.posted, calls: found?.calls },
      { turn: 'j2-turn', start: 'j2-start', posted: ['400000000000000014'], calls: [] }
    );
    const first = await journal.findTurn(placeOfGuild(GUILD), {
      messageId: '400000000000000009',
      at: Date.parse('2026-10-20T10:00:00.000Z'),
    });
    assert.deepEqual(
      [rec(first?.turn)?.id, rec(first?.turn)?.turnId, rec(first?.start)?.id, first?.posted],
      ['j-turn', 'turn-1', 'j-start', ['400000000000000009']]
    );
    assert.equal(
      await journal.findTurn(placeOfGuild(GUILD), {
        messageId: '400000000000000098',
        at: Date.parse('2026-10-20T10:00:00.000Z'),
      }),
      null
    );
    assert.deepEqual(
      (await journal.turnOperations(placeOfGuild(GUILD), { turnId: 'turn-2', days: READER_DAYS })).map((op) => [
        op.opId,
        op.name,
        op.phase,
        op.text,
      ]),
      [
        ['op-2', 'post', 'succeeded', 'Ναι'],
        ['op-3', 'react', 'open', null],
        ['op-4', 'post', 'open', null],
      ]
    );
    assert.deepEqual(
      (
        await journal.turnOperations(readAt(GUILD, { privateAccountId: MEMBER }).placeId, {
          turnId: 'turn-p',
          days: READER_DAYS,
        })
      ).map((op) => [op.phase, op.skill]),
      [['failed', 'msg']]
    );
    assert.deepEqual(
      (await journal.pending(placeOfGuild(GUILD), { days: READER_DAYS })).map((op) => op.opId),
      ['op-3', 'op-4']
    );
    assert.deepEqual(
      await journal.pending(placeOfGuild(GUILD), { days: READER_DAYS, before: Date.parse('2026-10-21T08:07:00.000Z') }),
      []
    );
    assert.deepEqual(await journal.triggerLinks(placeOfGuild(GUILD), { days: READER_DAYS }), []);
    assert.deepEqual(await journal.callMarks(placeOfGuild(GUILD), { days: READER_DAYS }), {
      calls: [],
      postedFrom: [],
    });
    const kinds = (timeline: Array<{ kind: string; event: string | null }>) =>
      timeline.map((entry) => (entry.event ? `${entry.kind}:${entry.event}` : entry.kind));
    assert.deepEqual(
      kinds(await journal.timeline(placeOfGuild(GUILD), { from: Date.parse('2026-10-19T00:00:00.000Z') })),
      [
        'turn.start',
        'turn',
        'system:start',
        'memory',
        'turn.start',
        'action',
        'action',
        'action',
        'turn',
        'action',
        'system:stop',
      ]
    );
    assert.deepEqual(
      kinds(await journal.timeline(placeOfGuild(GUILD_2), { from: Date.parse('2026-10-20T00:00:00.000Z') })),
      ['turn.start', 'turn', 'system:start', 'memory']
    );
  } finally {
    env.done();
  }
});

test('journal db reader: stats is the latest recordedAt of today and yesterday from the database', async () => {
  const env = await readerEnv();
  try {
    const journal = journalOf(env);
    assert.deepEqual(await journal.stats(placeOfGuild(GUILD)), { lastWriteMs: Date.parse('2026-10-21T20:00:00.000Z') });
    assert.deepEqual(await journal.stats(placeOfGuild(GUILD), { now: Date.parse('2026-10-25T10:00:00.000Z') }), {
      lastWriteMs: null,
    });
  } finally {
    env.done();
  }
});

test('journal db reader: a closed database is an error with a code, logged', async () => {
  const env = await readerEnv();
  try {
    const closed = journalOf(env, env.closedDb);
    await assert.rejects(
      () => closed.read(placeOfGuild(GUILD), { day: '2026-10-20' }),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
    await assert.rejects(
      () => closed.findTurn(placeOfGuild(GUILD), { messageId: '400000000000000014', at: READER_NOW }),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
    await assert.rejects(
      () => closed.timeline(placeOfGuild(GUILD), { from: READER_NOW }),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
    await assert.rejects(
      () => closed.stats(placeOfGuild(GUILD)),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
    assert.equal(env.warns.length, 4);
    assert.ok(
      env.warns.every(
        (warn) => warn.message === 'memory db: read failed' && warn.reader === 'journal' && warn.code === 'DB_CLOSED'
      )
    );
  } finally {
    env.done();
  }
});

// ---- the place of the journal's rows ----------------------------------------------------------------------------

// The engine's own lines belong to the persona, and a turn with no place stores its rows with no place.

const PLACES_NOW = Date.UTC(2026, 10, 3, 9, 0, 0);

/** The holders of a writer's live rows in `table`: the places, or the persona, whose lines they are. */
const holdersOf = (db: Db, table: string, writer: string): Array<unknown> =>
  db
    .prepare(`SELECT DISTINCT holder_id FROM "${table}" WHERE writer = ? AND retired_at IS NULL ORDER BY holder_id`)
    .all(writer)
    .map((row) => row.holder_id);

async function scene() {
  const mem = await openTestMemory({ iface: () => 'somewhere-else' });
  const read = (): Db => dbOf(wrongly<Parameters<typeof dbOf>[0]>(mem.memoryDb.readHandle()));
  return { mem, read };
}

test('the engine lines of the journal belong to the persona', async () => {
  // Bug: a start line with no root is written under `<iface>:guild:`, an address shared by nobody and everybody.
  const { mem, read } = await scene();
  try {
    const journal = createJournal({ dataDir: mem.dataDir, memoryDb: mem.memoryDb, now: () => PLACES_NOW, log: quiet });
    await journal.system({ event: 'start', by: 'service' });
    await journal.flush?.();
    assert.deepEqual(holdersOf(read(), 'day', 'journal'), [PERSONA_ID]);
  } finally {
    await mem.close();
  }
});

test('a turn with no place stores its journal rows with no place, never a place that does not exist', async () => {
  // Bug: a service turn runs in the stand-in chat `persona:local`, and the journal scoped its lines to that chat, so the
  // mapper spelled `<iface>:channel:persona:local` into `day.place_id` and `sources.place_id`, a place no row of `places` holds.
  const { mem, read } = await scene();
  try {
    const journal = createJournal({ dataDir: mem.dataDir, memoryDb: mem.memoryDb, now: () => PLACES_NOW, log: quiet });
    const { turnId, attemptId } = journal.start(PERSONA_ID, {
      placeId: PERSONA_ID,
      mode: 'inner',
      turnId: 't-service',
    });
    await journal.action(PERSONA_ID, { placeId: PERSONA_ID, turnId, name: 'skill', phase: 'started' });
    await journal.turn(PERSONA_ID, { placeId: PERSONA_ID, turnId, attemptId, outcome: 'spoke', posted: ['m-1'] });
    await journal.flush?.();
    const rows = read()
      .prepare(
        `SELECT 'day' AS t, place_id FROM day WHERE turn_id = 't-service'
         UNION ALL SELECT 'sources', place_id FROM sources WHERE turn_id = 't-service'`
      )
      .all();
    assert.deepEqual(rows.map((row) => row.t).sort(), ['day', 'day', 'day', 'sources']);
    assert.deepEqual(
      rows.map((row) => row.place_id),
      [null, null, null, null]
    );
  } finally {
    await mem.close();
  }
});

// ---- the journal of a DM -----------------------------------------------------------------------------------------

// A DM turn's lines are written through the journal over the real service and database, seeded with synthetic
// people and places, then read from the DM, a group and the persona.

const PRIVACY_NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const PRIVACY_DAY = '2026-11-05';
const SECRET = 'xylophonewhisper';

// A first-generation DM on the home authority: the place and the person are spelled from the native id.
const PARTNER = 'n1';
const PARTNER_ACCOUNT = 'discord:n1';
const PARTNER_PERSON = 'person:discord:n1';
const DM = 'discord:dm:n1';
const DM_CHAT = 'dm-chat-n1';
// Another partner on the same interface.
const OTHER = 'n2';
const OTHER_PERSON = 'person:discord:n2';
const OTHER_DM = 'discord:dm:n2';
const GROUP = 'discord:channel:room-1';
const SERVER = 'discord:server:g1';
// A partner with the same native id under another authority of the interface: the place's id spells nothing.
const STRANGER_ACCOUNT = 'account:other-authority';
const STRANGER_PERSON = 'person:elsewhere';
const STRANGER_DM = 'place:dm-other-authority';

/** Lets the journal's unawaited writes reach the writer, which runs on this thread here. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

const openedServices: Array<MemoryDbService> = [];
after(async () => {
  for (const service of openedServices) await service.close();
});

function seedWorld(db: Db): void {
  addAccount(db, {
    id: PARTNER_ACCOUNT,
    iface: 'discord',
    authority: 'discord/global',
    native: PARTNER,
    person: PARTNER_PERSON,
  });
  addAccount(db, {
    id: 'discord:n2',
    iface: 'discord',
    authority: 'discord/global',
    native: OTHER,
    person: OTHER_PERSON,
  });
  addAccount(db, {
    id: STRANGER_ACCOUNT,
    iface: 'discord',
    authority: 'discord/other',
    native: PARTNER,
    person: STRANGER_PERSON,
  });
  addDmPlace(db, {
    id: DM,
    iface: 'discord',
    authority: 'discord/global',
    account: PARTNER_ACCOUNT,
    person: PARTNER_PERSON,
  });
  addDmPlace(db, {
    id: OTHER_DM,
    iface: 'discord',
    authority: 'discord/global',
    account: 'discord:n2',
    person: OTHER_PERSON,
  });
  addDmPlace(db, {
    id: STRANGER_DM,
    iface: 'discord',
    authority: 'discord/other',
    account: STRANGER_ACCOUNT,
    person: STRANGER_PERSON,
  });
  addGroupPlace(db, GROUP, 'discord', 'discord/global');
  db.prepare(
    `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, chat, scope_kind)
     VALUES (?, 'discord', 'server', 'g1', 'server:g1', 'discord/global', 1, 'group', 'group')`
  ).run(SERVER);
}

function world() {
  const dataDir = tempDir('nep-dm-privacy-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  seedWorld(dbOf(seed));
  seed.close();
  const hot = { config: { memoryDb: { session: { mode: 'off' } }, context: { memory: { openPrivate: false } } } };
  const memoryDb = createMemoryDb({
    hot,
    dataDir,
    log: quiet,
    worker: false,
    iface: () => 'discord',
  });
  memoryDb.tick();
  openedServices.push(memoryDb);
  const read = (): Db => dbOf(wrongly<Parameters<typeof dbOf>[0]>(memoryDb.readHandle()));
  const journal = createJournal({ dataDir, memoryDb, now: () => PRIVACY_NOW, log: quiet });
  const record = createRecord({ dataDir, memoryDb, now: () => PRIVACY_NOW, log: quiet });
  const appendStore = createAppendStore({ fsyncMs: 0, log: quiet });
  const archive = createArchive({ appendStore, dataDir, memoryDb, now: () => PRIVACY_NOW, log: quiet });
  const vectors = createVectors({ dataDir, memoryDb, now: () => PRIVACY_NOW, log: quiet });
  const store = createStore({ dataDir, archive, memoryDb });
  const contexts = {
    group: memoryDb.issueContext({ kind: 'group', iface: 'discord', destination: GROUP }),
    other: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: OTHER_PERSON, place: OTHER_DM }),
    partner: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: PARTNER_PERSON, place: DM }),
    stranger: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: STRANGER_PERSON, place: STRANGER_DM }),
  };
  return { dataDir, hot, memoryDb, read, journal, record, archive, vectors, store, contexts };
}
type World = ReturnType<typeof world>;

/** A DM turn's journal lines, as the turn runner writes them, under the place `place`. */
async function journalDmTurn(w: World, place = DM) {
  const started = w.journal.start(place, {
    placeId: DM_CHAT,
    mode: 'reply',
    participants: [PARTNER],
    sourceMessageIds: ['m-dm'],
    trigger: { kind: 'message', messageId: 'm-dm', authorId: PARTNER },
  });
  const op = w.journal.op(place, {
    placeId: DM_CHAT,
    turnId: started.turnId,
    name: 'post',
    by: 'persona',
    intent: { replyTo: null, text: `said ${SECRET} to the partner` },
  });
  await op.started();
  await op.succeeded({ messageId: 'said-1' });
  await w.journal.turn(place, {
    placeId: DM_CHAT,
    turnId: started.turnId,
    attemptId: started.attemptId,
    outcome: 'spoke',
    think: `they told me about the ${SECRET}`,
    posted: ['said-1'],
  });
  await w.journal.memory(place, {
    batchId: 'b1',
    note: 'batch',
    attitude: [{ accountId: PARTNER, delta: 1, applied: 1, reason: `shared the ${SECRET}` }],
  });
  await settled();
}

test("a group's journal holds no line of a DM", async () => {
  // Bug: a turn whose place resolves to its root writes the DM's lines into the root's journal.
  const w = world();
  await journalDmTurn(w);
  const lines = await w.journal.read(GROUP, { day: PRIVACY_DAY, n: 100 });
  assert.equal(JSON.stringify(lines).includes(SECRET), false);
});

test("the persona's journal holds no line of a DM turn", async () => {
  // Bug: a turn line under the persona is read by every wake, whoever the wake answers to.
  const w = world();
  await journalDmTurn(w);
  const lines = await w.journal.read(PERSONA_ID, { day: PRIVACY_DAY, n: 100 });
  assert.equal(JSON.stringify(lines).includes(SECRET), false);
});

test('the turn that posted a DM message is not found from a group', async () => {
  // Bug: `memory.journal.read message:` from a group hands over the DM turn's think whole.
  const w = world();
  await journalDmTurn(w);
  const found = await w.journal.findTurn(GROUP, { messageId: 'said-1', at: PRIVACY_NOW });
  assert.equal(found, null);
});

test("the partner's own journal reads their own lines", async () => {
  // Bug: a fix that drops DM lines from the place's journal takes the owner's view and the turn's own recovery with it.
  const w = world();
  await journalDmTurn(w);
  const lines = await w.journal.read(DM, { day: PRIVACY_DAY, n: 100 });
  assert.equal(JSON.stringify(lines).includes(SECRET), true);
});

// What a direct message leaves in the journal, the record, the archive and the meaning index reaches its partner alone. A
// journal line of a DM names only its chat (`scope: { channel }`) and carries no private mark, so every reader
// that branched on the mark falls through to the channel rule or to none. Each test seeds one synthetic secret word through
// the writer a turn uses, over the real service and database, then reads as another reader: a group turn, another
// partner's private turn, the persona's own wake. Where the answer could be empty for want of a row, an internal context
// checks first that the row exists, so an empty answer means refused and never means unwritten. The last group asserts
// the converse: the partner's own private turn still reads their own lines.

const dmJournalPrivacyQuiet = { info() {}, debug() {}, warn() {}, error() {} };
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const DM_JOURNAL_PRIVACY_SECRET = 'xylophonewhisper';
const LIKE = `%${DM_JOURNAL_PRIVACY_SECRET}%`;

// A first-generation DM on the home authority: the place and the person are spelled from the native id.
const DM_JOURNAL_PRIVACY_PARTNER = 'n1';
const DM_JOURNAL_PRIVACY_PARTNER_ACCOUNT = 'discord:n1';
const DM_JOURNAL_PRIVACY_PARTNER_PERSON = 'person:discord:n1';
const DM_JOURNAL_PRIVACY_DM = 'discord:dm:n1';
const DM_JOURNAL_PRIVACY_DM_CHAT = 'dm-chat-n1';
// Another partner on the same interface.
const DM_JOURNAL_PRIVACY_OTHER = 'n2';
const DM_JOURNAL_PRIVACY_OTHER_PERSON = 'person:discord:n2';
const DM_JOURNAL_PRIVACY_OTHER_DM = 'discord:dm:n2';
const DM_JOURNAL_PRIVACY_GROUP = 'discord:channel:room-1';
const DM_JOURNAL_PRIVACY_SERVER = 'discord:server:g1';
// A partner with the same native id under another authority of the interface: the place's id spells nothing.
const DM_JOURNAL_PRIVACY_STRANGER_ACCOUNT = 'account:other-authority';
const DM_JOURNAL_PRIVACY_STRANGER_PERSON = 'person:elsewhere';
const DM_JOURNAL_PRIVACY_STRANGER_DM = 'place:dm-other-authority';

/** Lets the journal's unawaited writes reach the writer, which runs on this thread here. */
const dmJournalPrivacySettled = () => new Promise((resolve) => setImmediate(resolve));

const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

function dmJournalPrivacySeedWorld(db: Db): void {
  addAccount(db, {
    id: DM_JOURNAL_PRIVACY_PARTNER_ACCOUNT,
    iface: 'discord',
    authority: 'discord/global',
    native: DM_JOURNAL_PRIVACY_PARTNER,
    person: DM_JOURNAL_PRIVACY_PARTNER_PERSON,
  });
  addAccount(db, {
    id: 'discord:n2',
    iface: 'discord',
    authority: 'discord/global',
    native: DM_JOURNAL_PRIVACY_OTHER,
    person: DM_JOURNAL_PRIVACY_OTHER_PERSON,
  });
  addAccount(db, {
    id: DM_JOURNAL_PRIVACY_STRANGER_ACCOUNT,
    iface: 'discord',
    authority: 'discord/other',
    native: DM_JOURNAL_PRIVACY_PARTNER,
    person: DM_JOURNAL_PRIVACY_STRANGER_PERSON,
  });
  addDmPlace(db, {
    id: DM_JOURNAL_PRIVACY_DM,
    iface: 'discord',
    authority: 'discord/global',
    account: DM_JOURNAL_PRIVACY_PARTNER_ACCOUNT,
    person: DM_JOURNAL_PRIVACY_PARTNER_PERSON,
  });
  addDmPlace(db, {
    id: DM_JOURNAL_PRIVACY_OTHER_DM,
    iface: 'discord',
    authority: 'discord/global',
    account: 'discord:n2',
    person: DM_JOURNAL_PRIVACY_OTHER_PERSON,
  });
  addDmPlace(db, {
    id: DM_JOURNAL_PRIVACY_STRANGER_DM,
    iface: 'discord',
    authority: 'discord/other',
    account: DM_JOURNAL_PRIVACY_STRANGER_ACCOUNT,
    person: DM_JOURNAL_PRIVACY_STRANGER_PERSON,
  });
  addGroupPlace(db, DM_JOURNAL_PRIVACY_GROUP, 'discord', 'discord/global');
  db.prepare(
    `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, chat, scope_kind)
     VALUES (?, 'discord', 'server', 'g1', 'server:g1', 'discord/global', 1, 'group', 'group')`
  ).run(DM_JOURNAL_PRIVACY_SERVER);
}

function dmJournalPrivacyWorld() {
  const dataDir = tempDir('nep-dm-privacy-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  dmJournalPrivacySeedWorld(dbOf(seed));
  seed.close();
  const hot = { config: { memoryDb: { session: { mode: 'off' } }, context: { memory: { openPrivate: false } } } };
  const memoryDb = createMemoryDb({
    hot,
    dataDir,
    log: dmJournalPrivacyQuiet,
    worker: false,
    iface: () => 'discord',
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const read = (): Db => dbOf(wrongly<Parameters<typeof dbOf>[0]>(memoryDb.readHandle()));
  const journal = createJournal({ dataDir, memoryDb, now: () => NOW, log: dmJournalPrivacyQuiet });
  const record = createRecord({ dataDir, memoryDb, now: () => NOW, log: dmJournalPrivacyQuiet });
  const appendStore = createAppendStore({ fsyncMs: 0, log: dmJournalPrivacyQuiet });
  const archive = createArchive({ appendStore, dataDir, memoryDb, now: () => NOW, log: dmJournalPrivacyQuiet });
  const vectors = createVectors({ dataDir, memoryDb, now: () => NOW, log: dmJournalPrivacyQuiet });
  const store = createStore({ dataDir, archive, memoryDb });
  const contexts = {
    group: memoryDb.issueContext({ kind: 'group', iface: 'discord', destination: DM_JOURNAL_PRIVACY_GROUP }),
    other: memoryDb.issueContext({
      kind: 'dm',
      iface: 'discord',
      person: DM_JOURNAL_PRIVACY_OTHER_PERSON,
      place: DM_JOURNAL_PRIVACY_OTHER_DM,
    }),
    partner: memoryDb.issueContext({
      kind: 'dm',
      iface: 'discord',
      person: DM_JOURNAL_PRIVACY_PARTNER_PERSON,
      place: DM_JOURNAL_PRIVACY_DM,
    }),
    stranger: memoryDb.issueContext({
      kind: 'dm',
      iface: 'discord',
      person: DM_JOURNAL_PRIVACY_STRANGER_PERSON,
      place: DM_JOURNAL_PRIVACY_STRANGER_DM,
    }),
  };
  return { dataDir, hot, memoryDb, read, journal, record, archive, vectors, store, contexts };
}
type DmJournalPrivacyWorld = ReturnType<typeof dmJournalPrivacyWorld>;

/** The rows of `table` holding the secret that the context may read, by the rule every scoped read uses. */
function secretRows(db: Db, table: string, ctx: unknown): Array<Record<string, unknown>> {
  const scope = scopeWhere(ctx, 's');
  const columns = db
    .prepare(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((row) => String(row.name))
    .filter((name) => ['text', 'think', 'extra', 'reason', 'what'].includes(name));
  const holds = columns.map((name) => `s.${name} LIKE ?`).join(' OR ');
  return db
    .prepare(`SELECT s.* FROM ${table} s WHERE (${holds}) AND ${scope.sql}`)
    .all(...columns.map(() => LIKE), ...scope.params);
}

/** A DM turn's journal lines, as the turn runner writes them, under the place `place`. */
async function dmJournalPrivacyJournalDmTurn(w: DmJournalPrivacyWorld, place = DM_JOURNAL_PRIVACY_DM) {
  const started = w.journal.start(place, {
    placeId: DM_JOURNAL_PRIVACY_DM_CHAT,
    mode: 'reply',
    participants: [DM_JOURNAL_PRIVACY_PARTNER],
    sourceMessageIds: ['m-dm'],
    trigger: { kind: 'message', messageId: 'm-dm', authorId: DM_JOURNAL_PRIVACY_PARTNER },
  });
  const op = w.journal.op(place, {
    placeId: DM_JOURNAL_PRIVACY_DM_CHAT,
    turnId: started.turnId,
    name: 'post',
    by: 'persona',
    intent: { replyTo: null, text: `said ${DM_JOURNAL_PRIVACY_SECRET} to the partner` },
  });
  await op.started();
  await op.succeeded({ messageId: 'said-1' });
  await w.journal.turn(place, {
    placeId: DM_JOURNAL_PRIVACY_DM_CHAT,
    turnId: started.turnId,
    attemptId: started.attemptId,
    outcome: 'spoke',
    think: `they told me about the ${DM_JOURNAL_PRIVACY_SECRET}`,
    posted: ['said-1'],
  });
  await w.journal.memory(place, {
    batchId: 'b1',
    note: 'batch',
    attitude: [
      {
        accountId: DM_JOURNAL_PRIVACY_PARTNER,
        delta: 1,
        applied: 1,
        reason: `shared the ${DM_JOURNAL_PRIVACY_SECRET}`,
      },
    ],
  });
  await dmJournalPrivacySettled();
}

// ---- the journal of a DM ------------------------------------------------------------------------------------------

for (const table of ['day', 'sources', 'affinity_events']) {
  test(`a group turn reads nothing of a DM turn's journal from the ${table} rows`, async () => {
    // Bug: without the private mark `{ channel }` maps to a group scope, so the persona's think in a DM opens to every group.
    const w = dmJournalPrivacyWorld();
    await dmJournalPrivacyJournalDmTurn(w);
    assert.notEqual(secretRows(w.read(), table, internalContext()).length, 0);
    assert.deepEqual(secretRows(w.read(), table, w.contexts.group), []);
  });

  test(`another partner's private turn reads nothing of a DM turn's journal from the ${table} rows`, async () => {
    // Bug: a group-scoped line is open to every DM context too, because a group row is shown in a DM.
    const w = dmJournalPrivacyWorld();
    await dmJournalPrivacyJournalDmTurn(w);
    assert.notEqual(secretRows(w.read(), table, internalContext()).length, 0);
    assert.deepEqual(secretRows(w.read(), table, w.contexts.other), []);
  });
}

test('a DM journal line under another authority is out of reach of the partner with the same native id', async () => {
  // Bug: `scopeInto` spells the place from the native id, so two people with one native id share one audience.
  const w = dmJournalPrivacyWorld();
  await dmJournalPrivacyJournalDmTurn(w, DM_JOURNAL_PRIVACY_STRANGER_DM);
  assert.notEqual(secretRows(w.read(), 'sources', internalContext()).length, 0);
  assert.deepEqual(secretRows(w.read(), 'sources', w.contexts.partner), []);
});

// ---- the partner's own turn -----------------------------------------------------------------------------------------

test("the partner's own context reads the rows of their own journal", async () => {
  // Bug: a fix that narrows the scope to `internal` closes the DM to its partner too.
  const w = dmJournalPrivacyWorld();
  await dmJournalPrivacyJournalDmTurn(w);
  assert.notEqual(secretRows(w.read(), 'sources', w.contexts.partner).length, 0);
  assert.notEqual(secretRows(w.read(), 'day', w.contexts.partner).length, 0);
});

// The journal's reconciliation after a restart (src/memory/journal.ts#reconcile) finds the persona's own messages through
// the interface's `history` read. `ownMessagesOf(reads, iface)` (src/behavior/own-messages.ts) is the `fetchOwnMessages`
// it is handed: the last `count` messages of a chat, only the persona's, each as `{ id, content, replyToId,
// createdAt }`. `content` is the text as written in the core's grammar (`sourceText`), the form a post's intent was
// recorded in, never the text as the chat shows it.

const DAY = Date.UTC(2026, 9, 13, 23, 59, 50);
const ROOT = 'g1';
const room = channel('c1');

const journalReconcileReadOpened: Array<ReturnType<typeof openTestMemorySync>> = [];
after(async () => {
  for (const memory of journalReconcileReadOpened) await memory.close();
});

function journalReconcileReadJournalAt(clock: { ms: number }) {
  const memory = openTestMemorySync();
  journalReconcileReadOpened.push(memory);
  let n = 0;
  return createJournal({
    appendStore: {
      append: () => Promise.resolve(),
      iterate: async function* () {},
    },
    memoryDb: memory.memoryDb,
    dataDir: memory.dataDir,
    config: () => ({ thinkChars: 4000 }),
    now: () => clock.ms,
    uuid: () => `u-${(n += 1)}`,
  });
}

test('closes a post as succeeded when its own message is found by the text as written', async () => {
  const { reads, fake } = rig();
  fake.seedChat(room);
  fake.seedEvent(
    message(room, 'm9', DAY - 500, 'hi @Eleni, welcome', {
      authorId: SELF_ID,
      sourceText: 'hi <@u1>, welcome',
      replyToId: 'm1',
    })
  );
  const clock = { ms: DAY - 60_000 };
  const journal = journalReconcileReadJournalAt(clock);
  const op = journal.op(ROOT, {
    turnId: 't-1',
    name: 'post',
    by: 'persona',
    placeId: 'c1',
    intent: { replyTo: 'm1', text: 'hi <@u1>, welcome' },
  });
  await op.started();
  clock.ms = DAY;
  const counts = await journal.reconcile(ROOT, {
    days: ['2026-10-13'],
    fetchOwnMessages: ownMessagesOf(reads, IFACE),
  });
  assert.deepEqual(counts, { succeeded: 1, unknown: 0 });
});

test("closes a post as unknown when the only message with its words is another person's", async () => {
  const { reads, fake } = rig();
  fake.seedChat(room);
  fake.seedEvent(message(room, 'm9', DAY - 500, 'good morning', { authorId: 'u1', replyToId: 'm1' }));
  const clock = { ms: DAY - 60_000 };
  const journal = journalReconcileReadJournalAt(clock);
  const op = journal.op(ROOT, {
    turnId: 't-1',
    name: 'post',
    by: 'persona',
    placeId: 'c1',
    intent: { replyTo: 'm1', text: 'good morning' },
  });
  await op.started();
  clock.ms = DAY;
  const counts = await journal.reconcile(ROOT, {
    days: ['2026-10-13'],
    fetchOwnMessages: ownMessagesOf(reads, IFACE),
  });
  assert.deepEqual(counts, { succeeded: 0, unknown: 1 });
});

// Public turn context, split-chain merging and private journal boundaries.

const DISCORD = createDiscordInterface().capabilities;

test('a triggerless private inner turn writes its completed turn only to its partner journal', async () => {
  const memory = await openTestMemory({ now: () => TURN_MEMORY_CONTEXT_NOW });
  try {
    let id = 0;
    const journal = createJournal({
      memoryDb: memory.memoryDb,
      dataDir: memory.dataDir,
      config: () => ({ thinkChars: 4000 }),
      now: () => TURN_MEMORY_CONTEXT_NOW,
      uuid: () => `private-turn-${++id}`,
    });
    const hot = splitHot();
    hot.prompts['turn/inner'] = 'Respond to the private wake.';
    const llm = splitLlm({ talk: '<msg>private inner answer</msg>' });
    const turns = createTurnRunner({
      discord: DISCORD,
      createPort: createDiscordAdapter,
      hot,
      store: fakeStore(),
      llm,
      journal,
      calibrator: identityCalibrator(),
      client: fakeClient(),
      lookup: fakeLookup(),
      now: () => TURN_MEMORY_CONTEXT_NOW,
      schedule: manualSchedule(),
    });
    const channel = fakeTurnChannel({ id: 'private-room', dm: true, partnerId: 'u1' });
    const result = await turns.runTurn({
      channel,
      placeId: 'g1',
      mode: 'inner',
      triggerKind: 'inner',
      inner: {
        wake: {
          kind: 'intention_due',
          items: [],
          intentions: [],
          now: TURN_MEMORY_CONTEXT_NOW,
          timezone: 'UTC',
          channels: [],
        },
        shadow: false,
        mayAct: () => true,
      },
    });
    assert.equal(result.outcome, 'spoke');
    const day = new Date(TURN_MEMORY_CONTEXT_NOW).toISOString().slice(0, 10);
    // A private chat is its own place since places: its turn is journalled there and in no server's journal.
    const privateTurns = await journal.read('private-room', { day, kind: 'turn' });
    const groupTurns = await journal.read('g1', { day, kind: 'turn' });
    assert.equal(groupTurns.length, 0);
    assert.equal(privateTurns.length, 1);
    const privateTurn = privateTurns[0];
    assert.ok('mode' in privateTurn && 'scope' in privateTurn);
    assert.equal(privateTurn.mode, 'inner');
    // Its place says it is private; the scope of a record is the chat it happened in.
    assert.deepEqual(privateTurn.scope, { channel: 'private-room' });
  } finally {
    await memory.close();
  }
});

// Fault-injection tests for "no silent failure": the
// persona's engine is built from its own factories over fakes -- the inner life's scheduler, the
// turn runner, the errand service and its result turns, the fact ledger in the inner state file,
// the journal -- on one temp data directory, and a fault is injected: the process "dies" (a fresh
// scheduler, errand service and turn runner are built over the same directory, the way a restart
// does; what ran in the old ones is left hanging), a model call fails or never returns, a send
// times out, a call fails on the last step, a state file is corrupt. One test per row of the
// spec's table, each titled with its row number; every scenario ends in assertNoSilentFailure,
// which checks the invariant from the fakes' records. No network, no Discord, no bot start.

/** The memory database of each data directory used here (a restart opens the same one); closed when the file is done. */
const MEMORY = new Map<string, ReturnType<typeof openTestMemorySync>>();
function memoryOf(dataDir: string) {
  if (!MEMORY.has(dataDir)) MEMORY.set(dataDir, openTestMemorySync({ dataDir }));
  return present(MEMORY.get(dataDir)).memoryDb;
}

const FAULT_DISCORD = createDiscordInterface().capabilities;
const NOW0 = Date.parse('2026-10-19T12:00:00Z');
const FAULT_GUILD = 'g1';
const SELF = 'self-id';
const SILENT = { info() {}, warn() {}, error() {} };
const INNER_TASK = 'Nobody wrote to you; read the wake block.';
const clock = { t: NOW0 };

/** A model call that never returns: the process dies there. */
const HANG = Symbol('hang');

// ---- the chat: what survives a "death" (the chats, the model, the log of what was asked) ----

/**
 * The chat world: a fake port holding every message (seeded and sent), the channels reading their
 * history from it, a scripted model, and the records the invariant checks. It is built once per
 * scenario and outlives every boot.
 */
const names: Record<string, string> = { u1: 'Alice', u2: 'Zoë', [SELF]: 'Bot' };

type Chat = ReturnType<typeof makeChat>;

/** The scripted model of a chat: every request it got, and the answer it plays. */
type ChatLlm = {
  calls: Array<Array<Record<string, Untyped>>>;
  complete: (messages: Array<Record<string, Untyped>>) => Promise<unknown>;
};

function makeChat() {
  let stamp = 0;
  const port = createFakeAdapter({ iface: 'fake', selfId: SELF, now: () => clock.t - 5000 + (stamp += 1) });
  const injected: Array<Untyped> = []; // the sends a fault turned into a failure: { n, chat, text }
  const failures = new Map<number, Record<string, Untyped>>(); // send attempt number -> the result it gets
  const dyingAfter = new Set(); // send attempt numbers after which the process dies: the message is in the chat, the answer never comes
  let attempts = 0;
  const send = port.send.bind(port);
  port.send = wrongly<typeof port.send>(
    async (target: Parameters<typeof send>[0], content: Parameters<typeof send>[1]) => {
      attempts += 1;
      if (dyingAfter.has(attempts)) {
        await send(target, content);
        chat.hung = true;
        return new Promise(() => {});
      }
      const result = failures.get(attempts);
      if (!result) return send(target, content);
      port.calls.push({ op: 'send', args: [target, content] });
      injected.push({ n: attempts, chat: target.chatId, text: content?.text ?? '' });
      return result;
    }
  );

  // The chats of the chat: #c1, #c2 and #c3 of the root and the direct chat d1 (c9 is unknown to the interface).
  const infoOf = (id: string, { send = true }: { send?: boolean } = {}) => ({
    id,
    kind: id === 'd1' ? 'dm' : 'channel',
    rootId: id === 'd1' ? null : FAULT_GUILD,
    name: id === 'd1' ? null : `chan-${id}`,
    topic: null,
    category: null,
    chatType: id === 'd1' ? 'dm' : 'channel',
    ...(id === 'd1' ? { partnerId: 'u1' } : {}),
    iface: 'fake',
    permissions: { read: true, send, attach: true, react: true },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
    audience:
      id === 'd1'
        ? null
        : {
            everyone: true,
            groups: [],
            groupAllow: [],
            groupDeny: [],
            memberAllow: [],
            memberDeny: [],
            memberGroups: {},
          },
  });
  for (const id of ['c1', 'c2', 'c3', 'd1']) port.seedChat(wrongly(infoOf(id)));

  const results: Array<Untyped> = []; // every turn that ended: { placeId, mode, result, failedSends }
  const requests: Array<{ audience: string | null; text: string }> = []; // every request a model call got: { audience, text }
  const completed: Array<Untyped> = []; // every model call that answered: { at, audience }
  const script: Array<Untyped> = []; // the next answers: a text, an Error, a function of the messages, or HANG
  const fallback: unknown = '<skip/>';
  const audience = null;
  const gifs = null;
  const llm = wrongly<ChatLlm>(null);
  const chat = {
    port,
    injected,
    results,
    requests,
    completed,
    script,
    fallback,
    hung: false,
    audience,
    gifs,
    /** The nth send attempt (1-based, counted over the whole scenario) fails with `result`. */
    failSend(n: number, result = { status: 'failed', error: { code: 'rate-limited', retryable: false } }) {
      failures.set(n, result);
    },
    /** The process dies right after the nth send attempt reached the chat. */
    dieAfterSend(n: number) {
      dyingAfter.add(n);
    },
    get sendAttempts() {
      return attempts;
    },
    /** Where the persona may write: the chats in `unwritable` may not be written in, the others may. */
    permit(unwritable: Array<string> = []) {
      for (const id of ['c1', 'c2', 'c3', 'd1'])
        port.seedChat(wrongly(infoOf(id, { send: !unwritable.includes(wrongly(id)) })));
    },
    /** A line by `authorId` in `chatId` (the persona's own when it is `SELF`); its raw form. */
    /**
     */
    say(chatId: string, authorId: Untyped, text: string) {
      stamp += 1;
      const at = clock.t - 5000 + stamp;
      const id = `s${stamp}`;
      if (authorId === SELF) {
        port.seed(chatId, { authorId, text, messageId: id });
      } else {
        // A member's line is a whole event, the way an interface reports it, with the name the member goes by.
        port.seedEvent({
          kind: 'message.received',
          iface: 'fake',
          at,
          id: `fake:message:${id}`,
          chat: {
            id: chatId,
            kind: chatId === 'd1' ? 'dm' : 'channel',
            rootId: chatId === 'd1' ? null : FAULT_GUILD,
            name: chatId === 'd1' ? null : `chan-${chatId}`,
          },
          message: {
            id,
            author: { id: authorId, name: names[authorId] ?? authorId, self: false, bot: false },
            content: text,
            sourceText: text,
            system: false,
            at,
            replyToId: null,
            replyPingAccountId: null,
            forwardedFrom: null,
            attachments: [],
            links: [],
            forwarded: [],
            stickers: [],
            emojis: [],
            reactions: [],
          },
          addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
        });
      }
      return { id, placeId: chatId, cleanContent: text, createdTimestamp: at };
    },
    ownMessages(chatId: string, n = 20) {
      return port
        .messagesIn(chatId)
        .filter((message) => message.authorId === SELF)
        .slice(-n)
        .map((message) => ({
          id: message.ref.messageId,
          content: message.text,
          replyToId: message.replyTo?.messageId ?? null,
          createdAt: message.at,
        }));
    },
    textsFromSelf(chatId: string) {
      return port
        .messagesIn(chatId)
        .filter((message) => message.authorId === SELF)
        .map((message) => message.text);
    },
    llm,
  };
  chat.llm = {
    calls: [],
    complete: async (messages: Array<Record<string, Untyped>>) => {
      const llmCalls = chat.llm.calls;
      llmCalls.push(messages);
      chat.requests.push(wrongly({ audience: chat.audience, text: userText(messages[1].content) }));
      let step: unknown = chat.script.length > 0 ? chat.script.shift() : chat.fallback;
      if (typeof step === 'function') step = await wrongly<(messages: Untyped) => Promise<unknown>>(step)(messages);
      if (step === HANG) {
        chat.hung = true;
        return new Promise(() => {});
      }
      if (step instanceof Error) throw step;
      chat.completed.push(wrongly({ at: clock.t, audience: chat.audience }));
      return completionOf(step);
    },
  };
  return chat;
}

/** A fake intention service over `records` (mutable, outlives a boot): the due ones are pending with a passed dueAt. */
function fakeIntentions(records: Untyped) {
  return {
    records,
    due: () =>
      records
        .filter(
          (r: Record<string, Untyped>) => r.status === 'pending' && Number.isFinite(r.dueAt) && r.dueAt <= clock.t
        )
        .map((r: Record<string, Untyped>) => ({ intention: r, reason: 'due', at: r.dueAt })),
    reconcile: () => ({ arrived: 0, missing: 0, deadline: 0, expired: 0 }),
    list: () => records.filter((r: Record<string, Untyped>) => ['pending', 'waiting', 'proposed'].includes(r.status)),
    store: () => ({
      get: (id: string) => records.find((r: Record<string, Untyped>) => r.id === id) ?? null,
      list: () => records,
    }),
  };
}

const personaGrants = (names: Array<string>) =>
  Object.fromEntries(names.map((name) => [name, { everyone: false, roles: [], users: [SELF] }]));

function hotWith({
  features = {},
  wakes = {},
  timezone = 'UTC',
  grants = [],
  config = {},
}: {
  features?: Record<string, Untyped>;
  wakes?: Record<string, Untyped>;
  timezone?: string;
  grants?: Array<Untyped>;
  config?: Record<string, Untyped>;
} = {}) {
  return {
    config: {
      bot: { timezone, dryRunChannelId: '', ownerPerson: OWNER_PERSON, access: personaGrants(grants) },
      context: {
        channelMessages: 100,
        neighborMessages: 5,
        neighborMaxAgeMinutes: 60,
        neighborMaxChannels: 8,
        maxMessageChars: 800,
        gapMarkerMinutes: 20,
        otherProfiles: 6,
        failedTurnsKept: 3,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: {
          maxImages: 2,
          tokensPerImage: 400,
          imageSize: 512,
          recentImages: 0,
          recentImageMinutes: 0,
          maxBytes: 1_500_000,
          fetchTimeoutMs: 10_000,
        },
        pull: { scanMessages: 20, maxChannels: 1, sameAudience: true },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features: {
        memory: true,
        reactions: true,
        multiMessage: true,
        typingSimulation: false,
        vision: false,
        callMarkers: true,
        coreTools: true,
        wakes: true,
        intentions: true,
        ...features,
      },
      models: { routes: chainsOf({ analyzer: 'x/text' }) },
      media: { maxPerTurn: 6, filePreviewChars: 500 },
      gifs: { maxPerDay: 40 },
      mention: { oneAtATime: true },
      tools: {
        safeMode: false,
        resultMaxChars: 2000,
        callTimeoutMs: 120000,
        loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 },
      },
      wakes: {
        mode: 'live',
        tickSeconds: 60,
        queueMax: 20,
        chatMessages: 30,
        caps: { perChain: 3 },
        ...wakes,
      },
      heartbeat: { enabled: false },
      errands: { maxOpen: 3, resultMaxChars: 1000, resultCooldownSeconds: 60, resultRetrySeconds: 30 },
      agents: { scout: { enabled: true, daily: { tasks: 10 } } },
      ...config,
    },
    prompts: {
      main: 'You are a regular member of this chat, not an assistant.',
      persona: 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      'turn/reply': 'Someone called you: {{author}}.',
      interject: 'Jump into the chat.',
      initiate: 'Start a topic.',
      'turn/inner': INNER_TASK,
      labels,
    },
    reloadConfig: () => true,
  };
}

function faultFakeStore(gifs = null) {
  const store = {
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    countUsers: () => 0,
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
    state: { data: {}, markDirty() {} },
  };
  if (gifs)
    Object.assign(store, {
      findGif: (handle: string) => gifs[handle] ?? null,
      recordOwnGif: () => {},
    });
  return store;
}

/**
 * One boot: a turn runner, an inner life, an errand service with its result turns, all over the
 * chat and `dataDir` -- what src/index.ts builds at start, less Discord. A second boot over the same
 * `dataDir` is a restart. `records` are the intentions (they outlive a boot, like their file would).
 * `die`: the errand service's end hook does nothing (the process died before the result turn).
 */
function boot(
  chat: Chat,
  {
    dataDir,
    records = [],
    hot = hotWith(),
    unwritable = [],
    recall = null,
    failOps = [],
    journal = null,
    record = null,
    gifs = null,
    runErrand = null,
    die = false,
    store = faultFakeStore(gifs),
    ready = undefined,
    innerMemory = null,
  }: {
    dataDir: string;
    records?: Array<Untyped>;
    hot?: ReturnType<typeof hotWith>;
    unwritable?: Array<string>;
    recall?: Untyped;
    failOps?: Array<string>;
    journal?: Untyped;
    record?: Untyped;
    gifs?: Untyped;
    runErrand?: Untyped;
    die?: boolean;
    store?: ReturnType<typeof faultFakeStore>;
    ready?: Untyped;
    innerMemory?: Untyped;
  }
) {
  const intentions = fakeIntentions(records);
  const timers: Array<Untyped> = [];
  const accepted = new Set();
  const client = { user: { id: SELF, username: 'Bot' } };
  const port = chat.port;
  chat.permit(unwritable);
  const reads = createReads(port, SILENT);
  const admin = createAdmin({
    discord: FAULT_DISCORD,
    hot,
    store,
    client,
    isServedRoot: (id: unknown) => id === FAULT_GUILD,
    port,
    reads,
  });
  const runOp =
    failOps.length === 0
      ? admin.runSkillOp
      : async (op: string, args: Record<string, Untyped>, context: Record<string, Untyped>) =>
          failOps.includes(op)
            ? { status: 'failed', code: 'error', summary: 'it did not work', data: null }
            : admin.runSkillOp(op, args, context);

  // The errand service over the real task store; its runner is a fake that ends at once.
  const stores = createErrandStores({ memoryDb: memoryOf(dataDir), config: () => hot.config, log: SILENT });
  let taskTurns = wrongly<ReturnType<typeof createErrandTurns>>(null);
  const errands = createErrandService({
    client: {
      configured: () => true,
      run: async (task) =>
        runErrand ? runErrand(task) : { status: 'done', result: { text: 'found it' }, usage: { usd: 0.01 } },
      cancel: () => true,
    },
    stores,
    hot,
    log: SILENT,
    onFinished: (task) => (die ? null : taskTurns.onFinished(task)),
  });

  const turns = faultCreateTurnRunner({
    hot,
    store,
    llm: chat.llm,
    calibrator: { ratio: 1, apply: (value) => value, observe: () => {} },
    now: () => clock.t,
    port,
    reads,
    selfId: () => SELF,
    getSelfName: () => 'Bot',
    memberOf: (placeId: string, accountId: string) =>
      accountId in names ? { name: names[accountId], bot: false } : null,
    membersOf: () => Object.entries(names).map(([id, name]) => ({ id, name, bot: false })),
    chatName: (id: string) => (id === 'd1' ? null : `chan-${id}`),
    skills: skillRegistry(),
    journal,
    runOp,
    runOwnOp: admin.runOwnSkillOp,
    runInitiativeOp: admin.runInitiativeSkillOp,
    errands,
    ...(recall ? { recall } : {}),
  });
  // Every turn that ends is recorded with the sends a fault failed during it.
  const recorded = {
    isAnyBusy: () => turns.isAnyBusy?.() ?? false,
    isBusy: (id: string) => turns.isBusy?.(id) ?? false,
    runTurn: async (params: Record<string, Untyped>) => {
      chat.audience = params.chat?.chatId ?? null;
      const before = chat.sendAttempts;
      const result = await turns.runTurn(params);
      chat.results.push({
        placeId: params.chat?.chatId ?? null,
        mode: params.mode,
        result,
        failedSends: chat.injected.filter((f) => f.n > before && f.n <= chat.sendAttempts),
      });
      return result;
    },
  };
  taskTurns = createErrandTurns({
    hot,
    reads,
    iface: () => 'fake',
    turns: recorded,
    errands,
    now: () => clock.t,
    setTimer: wrongly((fn: string, ms: Array<Record<string, Untyped>>) => timers.push({ fn, ms })),
    log: SILENT,
  });

  let inner: ReturnType<typeof createInnerLife>;
  const door = createEventDoor({ handlers: { 'inner.wake': (event) => inner.onWake(event) }, log: SILENT });
  inner = createInnerLife({
    hot,
    dataDir,
    turns: recorded,
    intentions,
    record,
    journal: journal ? personaJournal(wrongly(journal), () => [FAULT_GUILD]) : null,
    reads,
    iface: () => 'fake',
    ...(ready ? { ready } : {}),
    submit: (event) => {
      accepted.add(event.id);
      return door.submit(event);
    },
    store: { state: { data: {} } },
    meter: { run: async (fn) => ({ result: await fn(), usd: 0, requests: 1, voice: 1 }) },
    ...(innerMemory ? { memoryDb: innerMemory } : {}),
    rng: () => 0.5,
    now: () => clock.t,
    log: SILENT,
  });
  turns.setFactsSource(inner.facts);

  const quiet = async (fn: () => unknown) => (await withCapturedLogs(fn)).result;
  const world = {
    chat,
    hot,
    dataDir,
    store,
    client,
    port,
    reads,
    turns,
    inner,
    errands,
    taskTurns,
    intentions,
    records,
    accepted,
    timers,
    journal,
    /** A wake handed to the door, as the scheduler would; remembered as accepted work. */
    accept: (wake: Record<string, Untyped>) => {
      accepted.add(wake.id);
      return door.submit({ kind: 'inner.wake', at: clock.t, id: wake.id, rootId: FAULT_GUILD, wake });
    },
    tick: () => quiet(() => inner.tick()),
    /** Alice's line in `chatId`, answered by an addressed turn (the model's next answers are `chat.script`). */
    ask: (chatId: string, text: Untyped, { dm = false }: { dm?: boolean } = {}) =>
      quiet(async () => {
        const raw = chat.say(chatId, 'u1', text);
        const trigger = {
          id: raw.id,
          placeId: raw.placeId,
          authorId: 'u1',
          authorName: 'Alice',
          self: false,
          bot: false,
          content: raw.cleanContent,
          ts: raw.createdTimestamp,
          replyToId: null,
          attachments: [],
          stickers: [],
        };
        return recorded.runTurn({
          chat: { iface: 'fake', chatId },
          ...(dm ? { placeId: FAULT_GUILD } : {}),
          mode: 'reply',
          trigger,
          triggerKind: 'mention',
        });
      }),
    quiet,
    state: () => inner.state(),
    factKinds: () =>
      inner.state().facts.map((fact: Record<string, Untyped>) => `${fact.kind}${fact.told ? ':told' : ''}`),
  };
  return world;
}

/** Starts `start()` (its promise is left hanging, as a dead process leaves it) and returns once the model call it hangs on was made. */
async function dieDuring(chat: Chat, start: () => Promise<unknown>) {
  chat.hung = false;
  await withCapturedLogs(async () => {
    start().catch(() => {});
    for (let i = 0; i < 400 && !chat.hung; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  });
  assert.ok(chat.hung, 'the scenario reached the model call the process dies in');
  chat.hung = false;
}

describe('fault injection', () => {
  after(async () => {
    for (const { close } of MEMORY.values()) await close();
  });

  test.beforeEach(() => {
    clock.t = NOW0;
  });

  test('row 2: the process dies right after a message was sent -- the journal closes the post as said, and nothing is sent again', async () => {
    const dataDir = tempDir('nep-fault-');
    const chat = makeChat();
    const makeJournal = () =>
      createJournal({ memoryDb: memoryOf(dataDir), dataDir, config: () => ({ thinkChars: 4000 }), now: () => clock.t });
    const hot = hotWith({ features: { journal: true } });
    const before = boot(chat, { dataDir, hot, journal: makeJournal() });
    chat.script = ['<msg>καλημέρα</msg>'];
    chat.dieAfterSend(1);
    await dieDuring(chat, () => before.ask('c1', 'say good morning'));
    assert.deepEqual(
      chat.textsFromSelf('c1'),
      ['καλημέρα'],
      'the message reached the chat; the process never learned it'
    );

    // The restart: a fresh journal over the same files finds the post open and closes it from the chat.
    const after = makeJournal();
    const open = await after.pending(FAULT_GUILD, { days: [utcDay(clock.t)] });
    assert.deepEqual(
      open.map((op) => op.name),
      ['post']
    );
    const reconciled = await after.reconcile(FAULT_GUILD, {
      days: [utcDay(clock.t)],
      before: clock.t + HOUR_MS,
      fetchOwnMessages: async (chatId, n) => chat.ownMessages(chatId, n),
    });
    assert.deepEqual(
      reconciled,
      { succeeded: 1, unknown: 0 },
      'the post is on record as said, not failed and not unknown'
    );
    assert.deepEqual(await after.pending(FAULT_GUILD, { days: [utcDay(clock.t)] }), []);
    assert.deepEqual(chat.textsFromSelf('c1'), ['καλημέρα'], 'the reconciliation sends nothing');
  });

  test("row 2: the process dies after a tool call's send reached the chat and before its result was recorded -- the journal closes the call as unknown from the restart, and nothing is sent again", async () => {
    const dataDir = tempDir('nep-fault-');
    const chat = makeChat();
    const makeJournal = () =>
      createJournal({ memoryDb: memoryOf(dataDir), dataDir, config: () => ({ thinkChars: 4000 }), now: () => clock.t });
    const hot = hotWith({ grants: ['message.create'], features: { journal: true } });
    const before = boot(chat, { dataDir, hot, journal: makeJournal() });
    chat.script = [toolAnswer('<think>x</think>', [call('message.create', { text: 'καλημέρα' })])];
    chat.dieAfterSend(1);
    await dieDuring(chat, () => before.ask('c1', 'say good morning'));
    assert.deepEqual(
      chat.textsFromSelf('c1'),
      ['καλημέρα'],
      'the message reached the chat; the process never learned it'
    );

    const after = makeJournal();
    const open = await after.pending(FAULT_GUILD, { days: [utcDay(clock.t)] });
    assert.deepEqual(
      open.map((op) => op.name),
      ['skill'],
      'the call was opened and never closed'
    );
    const reconciled = await after.reconcile(FAULT_GUILD, {
      days: [utcDay(clock.t)],
      before: clock.t + HOUR_MS,
      fetchOwnMessages: async (chatId, n) => chat.ownMessages(chatId, n),
    });
    assert.deepEqual(
      reconciled,
      { succeeded: 0, unknown: 1 },
      'a call that may have taken effect is closed unknown, never failed and never sent again'
    );
    assert.deepEqual(await after.pending(FAULT_GUILD, { days: [utcDay(clock.t)] }), []);
    assert.deepEqual(chat.textsFromSelf('c1'), ['καλημέρα'], 'the reconciliation sends nothing');
  });

  // The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
  // It is installed for the cases of this section only, and removed after them.
  let stopOwner: () => void = () => undefined;
  before(() => {
    stopOwner = ownedBy(['u1']);
  });
  after(() => stopOwner());
});
