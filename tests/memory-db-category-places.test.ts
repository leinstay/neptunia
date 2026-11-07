// A grouping of rooms in a platform's sidebar is no place. An old interface's envelope that declares one stores nothing
// for it, the protocol drops the field, and the migration `dropCategoryPlaces` takes the stored rows out of the tree.
// Real temporary databases, synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MIGRATIONS, openMemoryDb } from '../src/memory/db/open.ts';
import { projectRow } from '../src/memory/db/graph.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { observe } from '../src/memory/db/observe.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { validateEvent } from '../src/protocol/index.ts';
import { addAuthority } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const AT = '2026-11-01T00:00:00.000Z';
const IFACE = 'other';
const AUTHORITY = 'other/global';
const quiet = { info() {}, warn() {}, error() {} };

function eventIn(conversation: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'message.received',
    iface: IFACE,
    at: NOW,
    id: 'other:message:m1',
    conversation,
    message: {
      id: 'm1',
      author: { id: 'u1', name: 'Eleni', self: false, bot: false },
      content: 'γεια',
      at: NOW,
      replyToId: null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedConversationIds: [] },
  };
}

/** An old interface's room: declared under a category, with the root as the envelope's top. */
const ROOM_IN_CATEGORY = { id: 'c1', kind: 'channel', chatType: 'channel', parentId: 'cat1', parentKind: 'category' };

function stored(conversation: Record<string, unknown>): Array<Record<string, unknown>> {
  const handle = openMemoryDb(':memory:');
  try {
    const result = observe(handle, observationOf(eventIn(conversation)), { now: () => NOW, log: quiet });
    assert.equal(result.ok, true, JSON.stringify(result));
    return dbOf(handle)
      .prepare('SELECT id, kind, native_key, parent_id FROM places')
      .all()
      .map((row) => ({ ...row }));
  } finally {
    handle.close();
  }
}

test('an envelope that declares a category parent stores the room under the root and no category row', () => {
  // Bug: an interface build from before the change brings the sidebar grouping back into the tree.
  const rows = stored({ ...ROOM_IN_CATEGORY, rootId: 'g1' });
  assert.equal(rows.filter((row) => row.kind === 'category').length, 0);
  const root = rows.find((row) => row.native_key === 'server:g1');
  const room = rows.find((row) => row.native_key === 'channel:c1');
  assert.equal(room?.parent_id, root?.id);
});

test('an envelope that declares a category parent and no root stores the room with no parent', () => {
  // Bug: with no top to fall back on, the category is stored after all, or the observation is refused and the line lost.
  const rows = stored(ROOM_IN_CATEGORY);
  assert.deepEqual(
    rows.map((row) => [row.native_key, row.parent_id]),
    [['channel:c1', null]]
  );
});

test('a conversation with a category field passes validateEvent with the field dropped', () => {
  // Bug: the door refuses every event of an old interface build, or the field travels on into the core.
  const conversation: Record<string, unknown> = { id: 'c1', kind: 'channel', rootId: 'g1', category: 'Rooms' };
  assert.equal(validateEvent(eventIn(conversation)).ok, true);
  assert.equal('category' in conversation, false);
});

// ---- the migration ----

/** The file of a database one step before `dropCategoryPlaces`, the whole list while the migration does not exist. */
function databaseBefore(): { file: string; migrations: typeof MIGRATIONS } {
  const at = MIGRATIONS.findIndex((step) => typeof step === 'function' && step.name === 'dropCategoryPlaces');
  return {
    file: path.join(tempDir('nep-category-'), 'memory.db'),
    migrations: at === -1 ? MIGRATIONS : MIGRATIONS.slice(0, at),
  };
}

/** One place row, projected into the graph as the writer projects it. */
function addPlace(db: Db, id: string, kind: string, parent: string | null): void {
  const conversation = kind === 'server' || kind === 'category' || kind === 'workspace' ? null : 'group';
  db.prepare(
    `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, conversation, scope_kind, parent_id, seen_from_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'group', ?, ?)`
  ).run(id, IFACE, kind, id, `${kind}:${id}`, AUTHORITY, conversation, parent, AT);
  projectRow(db, 'places', { id }, { at: AT });
}

/** A root with a category holding two rooms and a thread under one of them, and a room outside the category. */
function seedCategoryTree(db: Db): void {
  addAuthority(db, IFACE, AUTHORITY);
  addPlace(db, 'root', 'server', null);
  addPlace(db, 'cat', 'category', 'root');
  addPlace(db, 'room-a', 'channel', 'cat');
  addPlace(db, 'room-b', 'channel', 'cat');
  addPlace(db, 'thread', 'thread', 'room-a');
  addPlace(db, 'room-c', 'channel', 'root');
}

/** The live `contained_in` targets of a place in the graph. */
function containers(db: Db, id: string): Array<string> {
  return db
    .prepare(
      `SELECT dst.row_id AS target FROM graph_edges edge
       JOIN graph_nodes src ON src.id = edge.src JOIN graph_nodes dst ON dst.id = edge.dst
       WHERE edge.predicate = 'contained_in' AND edge.retired_at IS NULL AND src.row_id = ?`
    )
    .all(id)
    .map((row) => String(row.target));
}

const parentOf = (db: Db, id: string): unknown =>
  db.prepare('SELECT parent_id FROM places WHERE id = ?').get(id)?.parent_id;

function migratedCategoryTree<T>(read: (db: Db) => T): T {
  const { file, migrations } = databaseBefore();
  const before = openMemoryDb(file, { migrations });
  try {
    seedCategoryTree(dbOf(before));
    assert.deepEqual(containers(dbOf(before), 'room-a'), ['cat'], 'the seed holds the old edge');
  } finally {
    before.close();
  }
  const after = openMemoryDb(file);
  try {
    return read(dbOf(after));
  } finally {
    after.close();
  }
}

test('dropCategoryPlaces moves the rooms of a category to the root and leaves a thread under its room', () => {
  // Bug: the rows move but the projected edges still point at the deleted node, or the walk flattens the thread too.
  migratedCategoryTree((db) => {
    for (const room of ['room-a', 'room-b']) {
      assert.equal(parentOf(db, room), 'root', room);
      assert.deepEqual(containers(db, room), ['root'], room);
    }
    assert.equal(parentOf(db, 'thread'), 'room-a');
    assert.deepEqual(containers(db, 'thread'), ['room-a']);
    assert.equal(parentOf(db, 'room-c'), 'root');
  });
});

test('dropCategoryPlaces leaves no category row or node and no category column', () => {
  // Bug: the row is deleted and its graph node stays, or the column survives for a later reader to fill.
  migratedCategoryTree((db) => {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM places WHERE kind = 'category'").get()?.n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM graph_nodes WHERE row_id = 'cat'").get()?.n, 0);
    const columns = db
      .prepare('PRAGMA table_info(places)')
      .all()
      .map((row) => row.name);
    assert.equal(columns.includes('category'), false);
  });
});

test('dropCategoryPlaces refuses a category with a child that is no room or thread, naming the row', () => {
  // Bug: a nested container is silently reparented, and a tree the migration never saw is rewritten on production.
  const { file, migrations } = databaseBefore();
  const before = openMemoryDb(file, { migrations });
  try {
    seedCategoryTree(dbOf(before));
    addPlace(dbOf(before), 'nested', 'workspace', 'cat');
  } finally {
    before.close();
  }
  assert.throws(() => openMemoryDb(file).close(), /\bcat\b/);
});
