// The write kind `prose-versions` (src/memory/db/prose-versions.ts): the previous texts of a prose owner written as
// their rows directly instead of through the versions mapper of a unit write. The first test writes the same histories
// through the unit write and through the write kind, over copies of one seeded database, and compares every table
// column by column.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { CHANNEL, NOW, ROOT, versions, writeBoth } from './fixtures/memory-db/profile-writes.ts';

test('version histories of an account, a channel, a place and a lore entry store the same rows both ways', async () => {
  const { unit, direct } = await writeBoth([
    {
      of: 'versions',
      versionKind: 'users',
      subjectId: 'discord:111',
      itemId: 'discord:111',
      value: versions('character', ['one', 'two']),
    },
    {
      of: 'versions',
      versionKind: 'channels',
      subjectId: CHANNEL,
      itemId: CHANNEL,
      value: versions('purpose', ['a room']),
    },
    { of: 'versions', versionKind: 'place', subjectId: ROOT, itemId: ROOT, value: versions('patterns', ['p']) },
    {
      of: 'versions',
      versionKind: 'lore',
      subjectId: ROOT,
      itemId: 'a-title-0123456789ab',
      value: versions('text', []),
    },
    {
      of: 'versions',
      versionKind: 'users',
      subjectId: 'discord:111',
      itemId: 'discord:111',
      value: versions('character', ['two']),
    },
  ]);
  assert.equal(direct[0], unit[0]);
  assert.deepEqual(direct[1], unit[1]);
});

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
