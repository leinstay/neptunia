// A description the describer cached before the message of its item was observed makes a media row of the groups, so it
// carries the audience of the groups. Synthetic ids only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { auditMemory } from '../src/memory/db/audit.ts';
import { writeMediaCache } from '../src/memory/db/media-store.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { tempDir } from './fixtures/tmp.ts';

test('a cached description of an item not observed yet makes a row in the audience of the groups', () => {
  // Bug: the row names the groups and no audience, so the audit reports it and a read by audience never finds it.
  const handle = openMemoryDb(path.join(tempDir('nep-media-cache-'), 'memory.db'));
  try {
    const db = dbOf(handle);
    writeMediaCache(db, {
      owner: 'unit:media-cache',
      iface: 'chat',
      value: { 'ref-1': { text: 'a synthetic description', ts: 1 } },
      at: '2026-11-05T10:00:00.000Z',
    });
    const row = db.prepare("SELECT scope_kind, scope_iface, audience_id FROM media WHERE native_ref = 'ref-1'").get();
    assert.deepEqual({ ...row }, { scope_kind: 'group', scope_iface: 'chat', audience_id: 'aud:group:chat' });
    assert.equal(auditMemory(db).checks.audienceDerived, 0);
  } finally {
    handle.close();
  }
});
