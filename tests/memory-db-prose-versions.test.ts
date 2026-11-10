// The write kind `prose-versions` (src/memory/db/prose-versions.ts): the previous texts of a prose owner written as
// their rows directly instead of through the versions mapper of a unit write. The first test writes the same histories
// through the unit write and through the write kind, over copies of one seeded database, and compares every table
// column by column.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { addChannelPlace } from './fixtures/memory-db/opaque-people.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';
import { NOW, ROOT, versions } from './fixtures/memory-db/profile-writes.ts';

test('a version write of a kind outside the prose kinds is refused with a code', async () => {
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'discord' });
  try {
    await assert.rejects(
      memory.memoryDb.writeProseVersions({
        versionKind: 'media' as never,
        subjectId: ROOT,
        itemId: 'x',
        value: {},
      }),
      { code: 'PROSE_VERSIONS_KIND' }
    );
  } finally {
    await memory.close();
  }
});

test("a channel's history is filed under the descriptions of its stored place when the place id spells nothing", () => {
  const dir = tempDataDir();
  const handle = openMemoryDb(path.join(dir, 'memory.db'));
  try {
    const db = dbOf(handle);
    addChannelPlace(db, { id: 'place:9b23', iface: 'discord', authority: 'discord/global', native: 'room-n' });
    applyMemoryWrite(handle, {
      kind: 'prose-versions',
      versionKind: 'channels',
      subjectId: 'place:9b23',
      itemId: 'room-n',
      value: versions('purpose', ['a room']),
      now: NOW,
    });
    const ids = db
      .prepare("SELECT DISTINCT description_id AS id FROM description_versions WHERE writer = 'versions'")
      .all()
      .map((row) => row.id);
    assert.deepEqual(ids, ['desc:place:9b23:purpose']);
  } finally {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
