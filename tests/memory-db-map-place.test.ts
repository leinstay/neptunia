// Round trips of src/memory/db/map/lore.ts, the lorebook <-> rows, and the graph of places and memberships the sync writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lore from '../src/memory/db/map/lore.ts';
import { assertRoundTrip, generated, plain, roundTrip } from './fixtures/memory-db/roundtrip.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import { reproject } from '../src/memory/db/graph.ts';
import { tableHashes } from '../scripts/memory-db.ts';
import { sqlOf } from './fixtures/loose-types.ts';

const GUILD = '300000000000000001';
const PLACE = `discord:guild:${GUILD}`;
const CTX = { iface: 'discord', subjectId: PLACE, subjectNativeId: GUILD };

const loreFile = () => [
  {
    id: 'harbour-9f8e7d6c5b4a',
    title: 'The harbour',
    keys: ['harbour', 'port', 'λιμάνι'],
    text: 'Where the boats sleep.',
    always: false,
    source: 'owner',
    weight: 2,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
  {
    id: '715474998364',
    title: '715474998364',
    keys: [],
    text: 'A number as a name.',
    always: true,
    source: 'analyzer',
    weight: 1,
    createdAt: 'a',
    updatedAt: 'b',
  },
];

test('lore entries become lore claims about the guild, the source is the author', () => {
  const rows = assertRoundTrip(lore, 'lore.json', loreFile(), CTX);
  assert.equal(rows.claims.length, 2);
  const [first, second] = rows.claims;
  assert.deepEqual(
    [
      first.id,
      first.kind,
      first.subject_kind,
      first.subject_id,
      first.text,
      first.weight,
      first.author,
      first.first_seen_at,
      first.last_seen_at,
      first.scope_kind,
      first.position,
    ],
    [
      'lore:harbour-9f8e7d6c5b4a',
      'lore',
      'place',
      `discord:guild:${GUILD}`,
      'Where the boats sleep.',
      2,
      'owner',
      '2026-09-01T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
      'group',
      0,
    ]
  );
  assert.equal(second.author, 'analyzer');
  const extra = JSON.parse(String(first.extra));
  assert.deepEqual(Object.keys(extra).sort(), ['always', 'keys', 'title']);
});

test('an empty lorebook, odd ids and repeated ids come back as they were', () => {
  for (const value of [
    [],
    [{ title: 'no id' }],
    [{ id: '', title: 'empty id' }],
    [{ id: 5, title: 'number id' }],
    [
      { id: 'a', title: '1' },
      { id: 'a', title: '2' },
    ],
  ]) {
    assert.deepEqual(roundTrip(lore, 'lore.json', value, CTX).back, value, JSON.stringify(value));
  }
});

test('the generated fixtures with every key path of the live lorebook round trip', () => {
  for (const [index, value] of generated('lore').entries()) {
    assertRoundTrip(lore, 'lore.json', plain(value), CTX, `generated lore ${index}`);
  }
});

// Schema v9: the sync writes units in no guaranteed order, and a projection never fails the typed write.
test('graph: a channel written before its guild and a membership before its account keep their edges; a rolled-back write leaves nothing behind', () => {
  const handle = openMemoryDb(':memory:');
  const db = sqlOf(handle);
  const quiet = { warn() {} };
  const node = (id: string) => db.prepare('SELECT kind, row_id, created_at FROM graph_nodes WHERE id = ?').get(id);
  const graph = () =>
    Object.fromEntries(
      tableHashes(db, ['graph_nodes', 'graph_edges', 'node_access']).map((entry) => [entry.table, entry.hash])
    );
  try {
    // A write rolled back on the same connection: the next one does not trust a row that went with it.
    for (let i = 0; i < 2; i += 1) {
      db.exec('BEGIN');
      insertRows(
        db,
        {
          places: [
            {
              id: 'telegram:channel:x',
              iface: 'telegram',
              kind: 'channel',
              native_id: 'x',
              parent_id: 'telegram:guild:y',
              scope_kind: 'group',
            },
          ],
        },
        { log: quiet }
      );
      db.exec('ROLLBACK');
    }
    insertRows(
      db,
      {
        places: [
          {
            id: 'discord:channel:c1',
            iface: 'discord',
            kind: 'channel',
            native_id: 'c1',
            parent_id: 'discord:guild:g1',
            scope_kind: 'group',
          },
        ],
      },
      { log: quiet }
    );
    assert.deepEqual(
      { ...node('place:discord:guild:g1') },
      { kind: 'place', row_id: 'discord:guild:g1', created_at: '1970-01-01T00:00:00.000Z' },
      'the missing guild is a placeholder node'
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM graph_edges WHERE predicate = 'contained_in' AND retired_at IS NULL").get()
        .n,
      1,
      'the edge is kept'
    );
    insertRows(
      db,
      {
        places: [
          {
            id: 'discord:guild:g1',
            iface: 'discord',
            kind: 'guild',
            native_id: 'g1',
            parent_id: null,
            scope_kind: 'group',
            seen_from_at: '2026-10-01T00:00:00.000Z',
          },
        ],
        memberships: [
          {
            id: 'm:1',
            account_id: 'discord:u1',
            place_id: 'discord:guild:g1',
            valid_from_at: '2026-10-02T00:00:00.000Z',
          },
        ],
      },
      { log: quiet }
    );
    assert.equal(
      node('place:discord:guild:g1').created_at,
      '2026-10-01T00:00:00.000Z',
      'the guild row fills its node in'
    );
    assert.equal(
      node('account:discord:u1').created_at,
      '1970-01-01T00:00:00.000Z',
      'the account a membership names before it arrives'
    );
    insertRows(db, { accounts: [{ id: 'discord:u1', iface: 'discord', native_id: 'u1' }] }, { log: quiet });
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS n FROM graph_nodes WHERE id IN ('place:discord:guild:g1', 'account:discord:u1')")
        .get().n,
      2,
      'one node each, not two'
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM graph_edges WHERE predicate IN ('has_membership', 'membership_in') AND retired_at IS NULL"
        )
        .get().n,
      2
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'graph_pending'").get().n, 0, 'nothing failed');
    const before = graph();
    reproject(handle);
    assert.deepEqual(graph(), before, 'whatever the order, the writers left what a re-projection makes');
  } finally {
    handle.close();
  }
});
