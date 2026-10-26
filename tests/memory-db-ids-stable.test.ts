// A database written before the ids took their interface from the event reads exactly as before: a data directory in
// the layout the Discord-era engine wrote goes through the unit writers, and every person, account, place and source
// keeps the id it had. An observed Discord message of the same member and channel then lands on those rows and mints
// none. Synthetic ids only (tests/fixtures/memory-db).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.js';
import { observationOf } from '../src/memory/db/observe-event.js';
import { observe } from '../src/memory/db/observe.js';
import { seedUnits } from './fixtures/memory-db/seed.js';
import { CHANNEL, GUILD, MEMBER, buildDataDir } from './fixtures/memory-db/datadir.js';

type Row = Record<string, unknown>;
type Handle = ReturnType<typeof openMemoryDb>;
type Db = { prepare(sql: string): { all(): Array<Row>; get(): Row } };

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const quiet = { info(): void {}, debug(): void {}, warn(): void {}, error(): void {} };

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
    assert.deepEqual(idsOf(handle, 'places'), [
      `discord:channel:${CHANNEL}`,
      `discord:dm:${MEMBER}`,
      `discord:guild:${GUILD}`,
    ]);
    assert.deepEqual(idsOf(handle, 'sources'), [
      'src:discord:400000000000000001:1:seen',
      'src:discord:400000000000000001:2:seen',
      'src:discord:400000000000000002:1:seen',
      'src:discord:400000000000000005:1:seen',
      'src:turn:turn-1:1',
    ]);
  });
});

test('finds the member of a seeded database by the same person key', () => {
  withSeeded((handle) => {
    const keys = (handle.db as Db)
      .prepare("SELECT node_id FROM external_keys WHERE authority_id = 'discord/global' AND object_kind = 'person'")
      .all()
      .map((row) => row.node_id);
    assert.deepEqual(keys, [`person:discord:${MEMBER}`]);
    assert.ok(idsOf(handle, 'people').includes(`person:discord:${MEMBER}`));
  });
});

test('lands an observed Discord message of the same member and channel on the rows that exist', () => {
  withSeeded((handle) => {
    const event = {
      kind: 'message.received',
      iface: 'discord',
      at: NOW,
      id: 'discord:message:400000000000000077',
      conversation: { id: CHANNEL, kind: 'channel', communityId: GUILD, name: 'general' },
      message: {
        id: '400000000000000077',
        author: { id: MEMBER, name: 'Ada', self: false, bot: false },
        content: 'καλημέρα',
        at: NOW,
        replyToId: null,
        attachments: [],
        links: [],
        stickers: [],
      },
    };
    const envelope = observationOf(event);
    observe(handle, envelope, { now: () => NOW, log: quiet });
    assert.deepEqual(idsOf(handle, 'accounts'), [`discord:${MEMBER}`], 'no second account');
    assert.equal(idsOf(handle, 'places').length, 3, 'no second place');
    assert.equal(idsOf(handle, 'sources').includes('src:discord:400000000000000077:1:seen'), true);
  });
});
