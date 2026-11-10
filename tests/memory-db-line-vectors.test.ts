// The write kind `line-vectors` (src/memory/db/line-vectors.ts): the vectors of the lines she saw and said, written as
// `vectors` rows of a place directly instead of as month units with a manifest. The tests read the months and lines,
// the vector index over a reopen, and the schema step that gave the older rows their place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createVectors } from '../src/memory/vectors.ts';
import { lineVectorKeys, lineVectorMonth, lineVectorMonths } from '../src/memory/db/line-vectors.ts';
import { OBSERVATION_VERSION } from '../src/memory/db/observe.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';

const DIMS = 4;
const MODEL = 'test/embedder';
const GROUP = 'discord:guild:1';
const NOW = Date.parse('2026-11-09T10:00:00.000Z');

/** A stored line of the index: what src/memory/vectors.ts writes for a row, with its int8 bytes. */
type Stored = { line: Row; bytes: Uint8Array };

function stored(id: string, row: number, occurredAt: string, fill: number, extra: Row = {}): Stored {
  return {
    line: {
      row,
      kind: 'record',
      id,
      revision: 1,
      occurredAt,
      placeId: 'discord:channel:10',
      by: 'owner',
      participants: ['owner'],
      sourceIds: [id],
      scale: 0.01 * fill,
      norm: 1 + fill,
      ...extra,
    },
    bytes: Uint8Array.from({ length: DIMS }, (_, i) => fill + i),
  };
}

/** An observed line of a direct chat, which makes its DM place. */
const dmLine = (native: string) => ({
  v: OBSERVATION_VERSION,
  iface: 'discord',
  authority: 'discord/global',
  native: { kind: 'message', key: `${native}:1`, revision: 1 },
  place: { authority: 'discord/global', key: `dm:${native}`, kind: 'dm', chat: 'dm' },
  author: { kind: 'account', key: native },
  occurredAt: '2026-11-03T10:00:00.000Z',
  observedAt: '2026-11-03T10:00:01.000Z',
  text: 'a synthetic line',
  mentions: [],
  direct: true,
  relations: [],
});

type Fresh = {
  env: Awaited<ReturnType<typeof openTestMemory>>;
  memoryDb: Awaited<ReturnType<typeof openTestMemory>>['memoryDb'];
  dm: string;
  db: () => Db;
};

async function fresh(): Promise<Fresh> {
  const env = await openTestMemory();
  const { memoryDb } = env;
  const seen = (await memoryDb.observe(dmLine('7'), null)) as { placeId: string };
  return { env, memoryDb, dm: seen.placeId, db: () => dbOf(memoryDb.readHandle()!) };
}

const OCT = '2026-10-05T10:00:00.000Z';
const NOV = '2026-11-03T10:00:00.000Z';

test('the readers give the months, the lines in row order with their bytes, and the chunk keys of a place', async () => {
  // Catches: a reader that mixes places, loses the row order, or answers a retired line.
  const { env, db } = await fresh();
  try {
    await env.memoryDb.writeLineVectors({
      op: 'append',
      placeId: GROUP,
      month: '2026-11',
      model: MODEL,
      lines: [stored('m2', 0, NOV, 2), stored('m1', 1, NOV, 1)],
    });
    await env.memoryDb.writeLineVectors({
      op: 'append',
      placeId: GROUP,
      month: '2026-10',
      model: MODEL,
      lines: [stored('o1', 0, OCT, 5)],
    });
    await env.memoryDb.writeLineVectors({
      op: 'append',
      placeId: 'discord:guild:2',
      month: '2026-09',
      model: MODEL,
      lines: [stored('x1', 0, '2026-09-01T00:00:00.000Z', 6)],
    });
    assert.deepEqual(lineVectorMonths(db(), GROUP), ['2026-10', '2026-11']);
    const month = lineVectorMonth(db(), GROUP, '2026-11');
    assert.deepEqual(
      month?.metas.map((meta) => meta.id),
      ['m2', 'm1']
    );
    assert.deepEqual(month?.metas[0], stored('m2', 0, NOV, 2).line);
    assert.deepEqual([...(month?.data ?? [])], [2, 3, 4, 5, 1, 2, 3, 4]);
    assert.deepEqual([...lineVectorKeys(db(), GROUP, '2026-11')].sort(), ['record:m1:1', 'record:m2:1']);
  } finally {
    await env.close();
  }
});

test('the vector index finds what it appended after the database reopens', async () => {
  // Catches: rows the index writes that no new index can find once the first one and its cache are gone.
  let env = await openTestMemory();
  try {
    const first = createVectors({ dataDir: env.dataDir, memoryDb: env.memoryDb, now: () => NOW });
    await first.append(
      GROUP,
      [
        { meta: { kind: 'record', id: 'm1', revision: 1, occurredAt: NOV }, vector: [1, 0, 0, 0] },
        { meta: { kind: 'record', id: 'm2', revision: 1, occurredAt: NOV }, vector: [0, 1, 0, 0] },
      ],
      { model: MODEL }
    );
    await env.close();
    env = await openTestMemory({ dataDir: env.dataDir });
    const second = createVectors({ dataDir: env.dataDir, memoryDb: env.memoryDb, now: () => NOW });
    const found = await second.search(GROUP, [1, 0.1, 0, 0], { k: 2 });
    assert.deepEqual(
      found.map((hit) => (hit.meta as { id: string }).id),
      ['m1', 'm2']
    );
    assert.deepEqual([...(await second.has(GROUP, '2026-11'))].sort(), ['record:m1:1', 'record:m2:1']);
    assert.deepEqual(await second.stats(GROUP), { months: 1, rows: 2, bytes: (await second.stats(GROUP)).bytes });
  } finally {
    await env.close();
    fs.rmSync(env.dataDir, { recursive: true, force: true });
  }
});

test('a line found by its stored address is searched through its index in a new database', () => {
  // Catches: an index over other expressions than the query's, so finding an old line scans every line.
  // Changed with the baseline at version 56: the index is part of the baseline, so a new database holds it.
  const handle = openMemoryDb(path.join(tempDir('line-vectors-index'), 'memory.db'));
  try {
    const plan = dbOf(handle)
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM sources WHERE iface = ? AND CASE WHEN json_valid(extra) THEN COALESCE(json_extract(extra, '$."$messageLocator".chatId'), json_extract(extra, '$."$messageLocator".conversationId')) END = ? AND CASE WHEN json_valid(extra) THEN json_extract(extra, '$."$messageLocator".messageId') END = ? AND generation = ?`
      )
      .all('discord', 'c', 'm', 1)
      .map((row) => String(row.detail));
    assert.match(plan.join(' | '), /USING INDEX sources_message_locator/);
  } finally {
    handle.close();
  }
});
