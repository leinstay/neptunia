// The write kind `journal-lines` (src/memory/db/journal-lines.ts): the lines of the journal written as rows of their
// place's day directly instead of through the journal mapper of a unit write. The first tests write the same lines
// through the unit write of each day and through the write kind, and compare every table column by column: the `day`,
// `decisions`, `sources` and `affinity_events` rows, their day's unit and the graph. Then the journal over a reopen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJournal } from '../src/memory/journal.ts';
import { placeOrPersona } from '../src/memory/db/storage-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';

const NOW = Date.parse('2026-11-09T10:00:00.000Z');
const ROOT = 'synthetic:root:1';
const DAY1 = '2026-11-08T09:00:00.000Z';
const DAY2 = '2026-11-09T08:00:00.000Z';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;
/** One write of a test: the place (null: the persona's) and its lines. */
type Write = { placeId: string | null; lines: Array<Row> };

const envelope = (kind: string, id: string, occurredAt: string, extra: Row = {}): Row => ({
  v: 1,
  id,
  kind,
  occurredAt,
  recordedAt: occurredAt,
  scope: { channel: 'room-a' },
  participants: ['member'],
  sourceMessageIds: ['m1'],
  origin: 'live',
  ...extra,
});

const turn = (id: string, occurredAt: string, extra: Row = {}): Row =>
  envelope('turn', id, occurredAt, {
    turnId: `turn-${id}`,
    attemptId: 1,
    mode: 'reply',
    outcome: 'spoke',
    reason: null,
    posted: [{ messageId: 'm9', replyTo: 'm1', opId: 'op-1' }],
    think: 'a synthetic thought',
    usage: { prompt: 10, cached: 4, completion: 3 },
    ...extra,
  });

const memory = (id: string, occurredAt: string): Row =>
  envelope('memory', id, occurredAt, {
    batchId: 'b-1',
    stage: 'applied',
    note: 'a batch',
    attitude: [
      { accountId: 'member', delta: 3, applied: 2, reason: 'was kind' },
      { accountId: 'other', delta: -1, applied: -1, reason: 'was rude', extraField: 'kept' },
    ],
  });

/** Every table but the full-text indexes, each row as stored, in rowid order. */
function tablesOf(db: Db): string {
  const out: Record<string, Array<Row>> = {};
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name")
    .all()
    .map((row) => String(row.name))
    .filter((name) => !/_(fts|tri)(_|$)/.test(name));
  for (const name of names) out[name] = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  return JSON.stringify(out, null, 1);
}

/** The unit writes of one write: one per run of lines of one day. */
function unitWrites(write: Write): Array<Row> {
  const runs: Array<Row> = [];
  for (const line of write.lines) {
    const key = placeOrPersona('journal', write.placeId, { partition: String(line.occurredAt).slice(0, 10) });
    const last = runs.at(-1);
    if (last && JSON.stringify(last.key) === JSON.stringify(key)) (last.lines as Array<Row>).push(line);
    else runs.push({ op: 'lines', key, lines: [line] });
  }
  return runs;
}

async function fresh(): Promise<Memory> {
  return openTestMemory({ now: () => NOW, iface: () => 'synthetic' });
}

/** The answers of the unit writes of one direct write, summed. */
function summed(answers: Array<unknown>): Row {
  const out: Row = { written: 0, duplicates: 0, adopted: 0 };
  for (const answer of answers as Array<Row>)
    for (const key of ['written', 'duplicates', 'adopted']) out[key] = Number(out[key]) + Number(answer[key] ?? 0);
  return out;
}

/** Runs the writes through both paths; returns every table of each and the answers of each direct write. */
async function writeBoth(
  writes: ReadonlyArray<Write>
): Promise<{ unit: [string, Array<Row>]; direct: [string, Array<unknown>] }> {
  const viaUnit = await fresh();
  const direct = await fresh();
  try {
    const unitAnswers: Array<Row> = [];
    for (const write of writes) {
      const answers: Array<unknown> = [];
      for (const update of unitWrites(write)) answers.push(await viaUnit.memoryDb.writeUnit(update));
      unitAnswers.push(summed(answers));
    }
    const directAnswers: Array<unknown> = [];
    for (const write of writes) directAnswers.push(await direct.memoryDb.writeJournalLines(write));
    return {
      unit: [tablesOf(dbOf(viaUnit.memoryDb.readHandle()!)), unitAnswers],
      direct: [tablesOf(dbOf(direct.memoryDb.readHandle()!)), directAnswers],
    };
  } finally {
    await viaUnit.close();
    await direct.close();
  }
}

test('turns, starts, actions and memory lines across two days store the same rows both ways', async () => {
  const { unit, direct } = await writeBoth([
    {
      placeId: ROOT,
      lines: [
        envelope('turn.start', 's1', DAY1, {
          turnId: 'turn-t1',
          attemptId: 1,
          mode: 'reply',
          trigger: { kind: 'message' },
        }),
        turn('t1', DAY1),
        memory('mem1', DAY1),
        envelope('action', 'a1', DAY2, { name: 'errand', phase: 'started', input: { errandId: 'errand-1' } }),
        turn('t2', DAY2, { think: null, outcome: 'silent', reason: 'nothing to say' }),
      ],
    },
    { placeId: ROOT, lines: [envelope('inner', 'i1', DAY2, { event: 'wake' })] },
  ]);
  assert.equal(direct[0], unit[0]);
  assert.deepEqual(direct[1], unit[1]);
});

test('lines of a direct chat and system lines of the persona store the same rows both ways', async () => {
  const { unit, direct } = await writeBoth([
    { placeId: 'synthetic:dm:partner', lines: [turn('d1', DAY2, { scope: { user: 'partner', private: true } })] },
    { placeId: null, lines: [envelope('system', 'y1', DAY2, { scope: {}, event: 'started' })] },
  ]);
  assert.equal(direct[0], unit[0]);
  assert.deepEqual(direct[1], unit[1]);
});

test('a write whose lines are not a list is refused with a code', async () => {
  const memoryDb = (await fresh()).memoryDb;
  try {
    await assert.rejects(memoryDb.writeJournalLines({ placeId: ROOT, lines: 'none' as never }), {
      code: 'JOURNAL_LINES_LINES',
    });
  } finally {
    await memoryDb.close();
  }
});

test('the journal reads back what it wrote after the database is closed and opened again', async () => {
  const dataDir = tempDataDir();
  let clock = Date.parse(DAY2);
  const now = () => clock;
  const first = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'synthetic' });
  const written: Array<object> = [];
  try {
    const journal = createJournal({ dataDir, memoryDb: first.memoryDb, now });
    const { turnId } = journal.start(ROOT, { placeId: 'room-a', mode: 'reply' });
    clock += 1000;
    await journal.turn(ROOT, { placeId: 'room-a', turnId, think: 'a synthetic thought', outcome: 'spoke' });
    await journal.memory(ROOT, { batchId: 'b-1', attitude: [{ accountId: 'member', delta: 1 }] });
    written.push(...(await journal.read(ROOT, { day: DAY2, n: 10 })));
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'synthetic' });
  try {
    const journal = createJournal({ dataDir, memoryDb: second.memoryDb, now });
    const read = await journal.read(ROOT, { day: DAY2, n: 10 });
    assert.equal(read.length, 3);
    assert.deepEqual(read, written);
    assert.deepEqual(
      read.map((line) => (line as { kind?: unknown }).kind),
      ['turn.start', 'turn', 'memory']
    );
    assert.equal((await journal.stats(ROOT)).lastWriteMs, clock);
  } finally {
    await second.close();
  }
});
