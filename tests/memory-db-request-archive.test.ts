// src/memory/db/request-archive.ts: the records a restart cuts off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { readRequests } from '../src/memory/db/request-archive.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { tempDir } from './fixtures/tmp.ts';

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
