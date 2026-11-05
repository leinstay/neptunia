// A month of vectors that grows by an append keeps the audience of the DM place it belongs to. The append path
// (`appendRows` through `storageMapper`) used to scope the new rows by the caller's default interface instead of the
// unit's own, so a DM of an interface other than the default was quarantined to `aud:internal` on every append.
// Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { OBSERVATION_VERSION } from '../src/memory/db/observe.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import { dmScope } from '../src/memory/db/scope.ts';
import { personId } from '../src/memory/db/ids.ts';
import { placeCollection } from '../src/memory/db/storage-keys.ts';

const DIMS = 4;
const MONTH = '2026-11';

/** An observed DM on `iface`; a DM of an interface that links no person leaves `places.partner_person` NULL. */
const dm = (iface: string, native: string) => ({
  v: OBSERVATION_VERSION,
  iface,
  authority: `${iface}/global`,
  native: { kind: 'message', key: `${native}:1`, revision: 1 },
  place: { authority: `${iface}/global`, key: `dm:${native}`, kind: 'dm', conversation: 'dm' },
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
  await env.memoryDb.writeUnit({ op: 'vectors', key, delta: delta(['r1', 'r2'], 0) });
  await env.memoryDb.writeUnit({ op: 'vectors', key, delta: delta(['r3', 'r4'], 2) });
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

test('a vector row whose given audience is not its scope is still quarantined to internal', () => {
  const handle = openMemoryDb(':memory:');
  const db = dbOf(handle);
  try {
    const warned: Array<Record<string, unknown>> = [];
    const log = { warn: (_message: string, fields: Record<string, unknown>) => warned.push(fields) };
    const row = (chunk: string, audience: string) => ({
      chunk_key: chunk,
      item_id: chunk,
      model: 'test/embedder',
      dims: DIMS,
      bytes: Buffer.alloc(DIMS, 1),
      ...dmScope(personId('discord', 'u1'), 'discord'),
      audience_id: audience,
    });
    insertRows(
      db,
      { vectors: [row('agrees', 'aud:dm:discord:dm:u1'), row('disagrees', 'aud:group:discord')] },
      { log }
    );
    const audience = (chunk: string) =>
      db.prepare('SELECT audience_id FROM vectors WHERE chunk_key = ?').get(chunk)?.audience_id;
    assert.equal(audience('agrees'), 'aud:dm:discord:dm:u1');
    assert.equal(audience('disagrees'), 'aud:internal');
    assert.deepEqual(warned, [{ table: 'vectors', code: 'AUDIENCE_CONFLICT' }]);
  } finally {
    handle.close();
  }
});
