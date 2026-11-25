// The line vectors (src/memory/db/line-vectors.ts): a month of vectors that grows by an append keeps the audience of
// the DM place it belongs to. The new rows take the scope of the unit's own interface, never the caller's default one,
// so a DM of an interface other than the default keeps its audience on every append. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMemory } from '../../../fixtures/memory-db/service.ts';
import { OBSERVATION_VERSION } from '../../../../src/memory/db/observe.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import { placeCollection } from '../../../../src/memory/db/unit-keys.ts';
import { writeUnitUpdate } from '../../../fixtures/memory-db/unit-writes.ts';
import { lineVectorKeys, lineVectorMonth, lineVectorMonths } from '../../../../src/memory/db/line-vectors.ts';
import type { Db, Row } from '../../../../src/memory/db/types.ts';

const DIMS = 4;
const MONTH = '2026-11';

/** An observed DM on `iface`; a DM of an interface that links no person leaves `places.partner_person` NULL. */
const dm = (iface: string, native: string) => ({
  v: OBSERVATION_VERSION,
  iface,
  authority: `${iface}/global`,
  native: { kind: 'message', key: `${native}:1`, revision: 1 },
  place: { authority: `${iface}/global`, key: `dm:${native}`, kind: 'dm', chat: 'dm' },
  author: { kind: 'account', key: native },
  occurredAt: '2026-11-03T10:00:00.000Z',
  observedAt: '2026-11-03T10:00:01.000Z',
  text: 'a synthetic line',
  mentions: [],
  direct: true,
  relations: [],
});

/** The delta the vector index sends for `ids` appended after `before` rows: manifest, jsonl lines and int8 bytes. */
function delta(ids: ReadonlyArray<string>, before: number) {
  const meta = ids
    .map(
      (id, i) =>
        `${JSON.stringify({ row: before + i, kind: 'record', id, revision: 1, occurredAt: '2026-11-03T10:00:00.000Z', placeId: null, by: 'owner', participants: ['owner'], sourceIds: [id], scale: 0.01, norm: 1 })}\n`
    )
    .join('');
  const rows = before + ids.length;
  return {
    manifest: {
      v: 1,
      gen: 1,
      rows,
      bytes: rows * DIMS,
      metaBytes: 0,
      model: 'test/embedder',
      dims: DIMS,
      checksum: 'fnv1a32:00000000:00000000',
    },
    meta,
    i8: Buffer.alloc(ids.length * DIMS, 1),
  };
}

async function monthWith(iface: string, native: string) {
  const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const env = await openTestMemory({
    log: {
      info() {},
      debug() {},
      error() {},
      warn: (message: string, fields?: Record<string, unknown>) => warnings.push({ message, fields }),
    },
  });
  const seen = (await env.memoryDb.observe(dm(iface, native), null)) as { ok: boolean; placeId: string };
  assert.equal(seen.ok, true, JSON.stringify(seen));
  const key = { ...placeCollection('vectors', seen.placeId), partition: MONTH };
  // The first write makes the month (the whole-month path), the second appends to it.
  await writeUnitUpdate(env.memoryDb, { op: 'vectors', key, delta: delta(['r1', 'r2'], 0) });
  await writeUnitUpdate(env.memoryDb, { op: 'vectors', key, delta: delta(['r3', 'r4'], 2) });
  const db = dbOf(env.memoryDb.readHandle()!);
  const audiences = db
    .prepare('SELECT item_id, audience_id, scope_kind, scope_iface FROM vectors ORDER BY item_id')
    .all()
    .map((row) => ({ ...row }));
  return { env, warnings, audiences, placeId: seen.placeId };
}

test('an appended vector of a cli DM keeps the audience of its DM place', async () => {
  const { env, warnings, audiences, placeId } = await monthWith('cli', 'owner');
  try {
    assert.equal(placeId, 'cli:dm:owner');
    assert.deepEqual(
      audiences.map((row) => [row.item_id, row.audience_id]),
      [
        ['r1', 'aud:dm:cli:dm:owner'],
        ['r2', 'aud:dm:cli:dm:owner'],
        ['r3', 'aud:dm:cli:dm:owner'],
        ['r4', 'aud:dm:cli:dm:owner'],
      ]
    );
    assert.deepEqual(
      warnings.filter((one) => one.fields?.code === 'AUDIENCE_CONFLICT'),
      []
    );
  } finally {
    await env.close();
  }
});

test('an appended vector of a discord DM keeps the audience of its DM place', async () => {
  const { env, audiences } = await monthWith('discord', '555');
  try {
    assert.deepEqual(
      audiences.map((row) => row.audience_id),
      Array(4).fill('aud:dm:discord:dm:555')
    );
  } finally {
    await env.close();
  }
});

const MODEL = 'test/embedder';
const GROUP = 'discord:guild:1';

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
