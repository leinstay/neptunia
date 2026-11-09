// A database written before the ids took their interface from the event reads exactly as before: a data directory in
// the layout the Discord-era engine wrote goes through the unit writers, and every account, place and source keeps the
// id it had. Synthetic ids only (tests/fixtures/memory-db).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { seedUnits } from './fixtures/memory-db/seed.ts';
import { CHANNEL, GUILD, MEMBER, buildDataDir } from './fixtures/memory-db/datadir.ts';

type Row = Record<string, unknown>;
type Handle = ReturnType<typeof openMemoryDb>;
type Db = { prepare(sql: string): { all(): Array<Row>; get(): Row } };

function withSeeded(body: (handle: Handle) => void): void {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ids-'));
  const handle = openMemoryDb(join(root, 'memory.db'));
  try {
    buildDataDir(root);
    assert.equal(seedUnits(handle, root).errors, 0);
    body(handle);
  } finally {
    handle.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const idsOf = (handle: Handle, table: string): Array<unknown> =>
  (handle.db as Db)
    .prepare(`SELECT id FROM ${table} ORDER BY id`)
    .all()
    .map((row) => row.id);

test('keeps the id of the account, the places and the sources of a seeded database', () => {
  withSeeded((handle) => {
    assert.deepEqual(idsOf(handle, 'accounts'), [`discord:${MEMBER}`]);
    // Changed with ids-by-links slice 3: the member's private file spells a DM place no row holds, and no writer makes a
    // place from that spelling, so the seeded database holds the channel and the server only.
    assert.deepEqual(idsOf(handle, 'places'), [`discord:channel:${CHANNEL}`, `discord:guild:${GUILD}`]);
    assert.deepEqual(idsOf(handle, 'sources'), [
      'src:discord:400000000000000001:1:seen',
      'src:discord:400000000000000001:2:seen',
      'src:discord:400000000000000002:1:seen',
      'src:discord:400000000000000005:1:seen',
      'src:turn:turn-1:1',
    ]);
  });
});
