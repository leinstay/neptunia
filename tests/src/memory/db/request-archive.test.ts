// src/memory/db/request-archive.ts: the records a restart cuts off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { readRequests, recoverRequestArchive } from '../../../../src/memory/db/request-archive.ts';
import { applyMemoryWrite } from '../../../../src/memory/db/session-write.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../../../../src/memory/db/types.ts';
import { NOW, ROOT, copyOf, seededPlaces } from '../../../fixtures/memory-db/place-writes.ts';
import { tempDir } from '../../../fixtures/tmp.ts';

test('a request a restart cut off is recorded as unknown with no answer invented, and nothing asks again', () => {
  // Bug: a request in flight stays pending for ever, gets a made-up answer, or is sent again to fill the archive.
  const handle = openMemoryDb(path.join(tempDir('nep-archive-'), 'memory.db'));
  applyMemoryWrite(handle, {
    kind: 'request-archive',
    op: 'start',
    record: { id: 'r1', at: 5, system_text: 's', messages: '[]' },
  });
  applyMemoryWrite(handle, { kind: 'request-archive', op: 'interrupt', at: 9 });
  const [row] = readRequests(dbOf(handle));
  assert.equal(row?.status, 'unknown');
  assert.equal(row?.response_text, null);
  handle.close();
});

// ---------- the describer's entries cut by a restart ----------

const DESCRIBED = { text: 'a cat on a synthetic sofa', ts: NOW - 1000, describedAt: NOW - 1000, model: 'vision-model' };

const put = (handle: MemoryHandle, key: string, entry: Row, now = NOW): unknown =>
  applyMemoryWrite(handle, { kind: 'media-entry', op: 'put', placeId: ROOT, key, entry, iface: 'discord', now });

const rowsHolding = (db: Db, key: string): Array<Row> =>
  db
    .prepare('SELECT * FROM media ORDER BY rowid')
    .all()
    .filter((row) =>
      Object.hasOwn((JSON.parse(typeof row.extra === 'string' ? row.extra : '{}') as { cache?: Row }).cache ?? {}, key)
    );

// Bug: a GIF watch cut by a restart leaves its item with no text, no miss and no mark, and nothing watches it again.
// The describer marks the entry `pending` before its request goes out, and the start that marks the cut requests
// `unknown` turns such an entry into a miss with the reason `interrupted`, so the line shows that it could not be
// watched and the describer's handling of a miss applies.
test('at the start an entry still pending from before a restart becomes a miss with the reason interrupted', () => {
  const handle = copyOf(seededPlaces());
  try {
    put(handle, 'gif-cut', { pending: true, ts: NOW - 500 });
    recoverRequestArchive(handle, { now: NOW });
    const [row] = rowsHolding(dbOf(handle), 'gif-cut');
    const cache = (JSON.parse(String(row?.extra)) as { cache: Record<string, Row> }).cache;
    assert.deepEqual(cache['gif-cut'], { miss: true, ts: NOW, reason: 'interrupted' });
  } finally {
    handle.close();
  }
});

// Bug: an entry with a description that a stop cut while it was described again keeps no trace of the attempt. The
// start follows how a failed refresh is recorded (src/memory/describe.ts, `refreshFailedAt`): the start keeps the old
// text, takes the mark away and stamps the failed attempt, so the line still shows the old text and the attempt is not
// retried before the miss time.
test('at the start a described entry still pending from before a restart keeps its text and is stamped refreshFailedAt', () => {
  const handle = copyOf(seededPlaces());
  try {
    put(handle, 'att-again', { ...DESCRIBED, pending: true });
    recoverRequestArchive(handle, { now: NOW });
    const [row] = rowsHolding(dbOf(handle), 'att-again');
    const cache = (JSON.parse(String(row?.extra)) as { cache: Record<string, Row> }).cache;
    assert.deepEqual(cache['att-again'], { ...DESCRIBED, refreshFailedAt: NOW });
    assert.equal(row?.description, DESCRIBED.text);
  } finally {
    handle.close();
  }
});
