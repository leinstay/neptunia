// `scripts/memory-convert-places.ts` over a month of vectors. The conversion renames keys inside each row's stored line,
// so the month's bytes change, and a manifest left as it was makes the month read short from then on: search skips it and
// the catch-up embeds its records again at every restart. Run as a process over the frozen synthetic database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { vectorMonthFiles } from '../src/memory/db/readers/vectors.ts';
import { storageId } from '../src/memory/db/storage-keys.ts';
import type { StorageKey } from '../src/memory/db/storage-keys.ts';
import { monthChecksum } from '../src/memory/vectors.ts';
import { convert, scene } from './fixtures/memory-db/one-server.ts';

const KEY: StorageKey = { kind: 'vectors', subject: { type: 'place', id: 'discord:guild:g1' }, partition: '2026-10' };
const OWNER = storageId(KEY);
const DIMS = 2;

function addMonth(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO storage_units (id, kind, subject_type, subject_id, scope_place_id, partition, selector, key_json, lines, offset, synced_at, retired_at)
     VALUES (?, 'vectors', 'place', 'discord:guild:g1', NULL, '2026-10', NULL, ?, 2, 1, '2026-10-01T12:00:00.000Z', NULL)`
  ).run(OWNER, JSON.stringify(KEY));
  const insert = db.prepare(
    `INSERT INTO vectors (item_id, chunk_key, model, dims, scale, norm, bytes, context, occurred_at, scope_kind, scope_iface, audience_id, owner_key)
     VALUES (?, ?, 'test/embedder', ?, 0.5, 1, ?, ?, '2026-10-01T10:00:00.000Z', 'group', 'discord', 'aud:group:discord', ?)`
  );
  let meta = '';
  for (const [row, id] of ['a', 'b'].entries()) {
    const context = { row, kind: 'record', revision: 1, channelId: 'c1', by: 'u1', participants: [], sourceIds: [id] };
    insert.run(id, `record:${id}:1`, DIMS, Uint8Array.from([1, 2]), JSON.stringify(context), OWNER);
    const line = {
      row,
      kind: 'record',
      id,
      revision: 1,
      occurredAt: '2026-10-01T10:00:00.000Z',
      channelId: 'c1',
      by: 'u1',
      participants: [],
      sourceIds: [id],
      scale: 0.5,
      norm: 1,
    };
    meta += `${JSON.stringify(line)}\n`;
  }
  const i8 = Uint8Array.from([1, 2, 1, 2]);
  const manifest = {
    v: 1,
    gen: 1,
    rows: 2,
    bytes: 4,
    metaBytes: Buffer.byteLength(meta),
    model: 'test/embedder',
    dims: DIMS,
    checksum: monthChecksum(i8, Buffer.from(meta)),
  };
  db.prepare(`INSERT INTO operational (kind, owner, value, owner_key) VALUES ('vectors', ?, ?, ?)`).run(
    OWNER,
    JSON.stringify({ manifest, gen: 1 }),
    OWNER
  );
}

test('a converted month of vectors holds a manifest that counts its converted lines', () => {
  const where = scene(addMonth);
  const { status, stderr } = convert(where);
  assert.equal(status, 0, stderr);
  const db = new DatabaseSync(where.output, { readOnly: true });
  try {
    const owner: StorageKey = {
      kind: 'vectors',
      subject: { type: 'place', id: 'discord:guild:g1' },
      partition: '2026-10',
    };
    const files = vectorMonthFiles(db, owner, { checksum: monthChecksum })!;
    assert.match(files.meta.toString('utf8'), /"placeId":"c1"/);
    assert.equal(files.manifest!.metaBytes, files.meta.length);
    assert.equal(files.manifest!.checksum, monthChecksum(files.i8, files.meta));
    assert.equal(files.manifest!.rows, 2);
  } finally {
    db.close();
  }
});
