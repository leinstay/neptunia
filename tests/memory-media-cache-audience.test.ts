// A description the describer cached before the message of its item was observed makes a media row of the groups, so it
// carries the audience of the groups. The repair gives the rows stored without one that same audience. Synthetic ids only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditMemory } from '../src/memory/db/audit.ts';
import { writeMediaCache } from '../src/memory/db/media-store.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { auditWorld } from './fixtures/memory-audit-world.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPAIR = path.join(ROOT, 'scripts', 'memory-repair-audit.ts');

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

test('the repair gives a group media row with no audience the audience of its groups, once', async () => {
  // Bug: the rows already written stay findings for good.
  const file = await auditWorld((raw) => {
    raw.exec(`INSERT INTO media (id, kind, native_ref, availability, extra, scope_kind, scope_iface)
      VALUES ('media:chat:ref-2', 'video', 'ref-2', 'present', '{}', 'group', 'discord')`);
  });
  const run = () => {
    const done = spawnSync(process.execPath, [REPAIR, '--db', file, '--apply'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {},
    });
    assert.equal(done.status, 0, done.stderr);
    return (JSON.parse(done.stdout) as { mediaAudiences: number }).mediaAudiences;
  };
  assert.equal(run(), 1);
  assert.equal(run(), 0);
  const handle = openMemoryDb(file, { readOnly: true });
  try {
    const db = dbOf(handle);
    const row = db.prepare("SELECT audience_id FROM media WHERE id = 'media:chat:ref-2'").get();
    assert.equal(row?.audience_id, 'aud:group:discord');
    assert.equal(auditMemory(db).findings, 0);
  } finally {
    handle.close();
  }
});
