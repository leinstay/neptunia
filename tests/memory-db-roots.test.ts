// src/memory/db/roots.ts (new): the places of the roots an interface names in `hello`
// (`root` and `roots`, each `{ id, name }`, src/protocol/envelope.ts). The core calls
//   noteRoots(handle, { iface, roots, at })
// at every hello it takes (src/core.ts, `connectInterface` and the served interface's greeting), with the whole list the
// hello carried. A root's place is the server place `<iface>:server:<id>` (kind `server`, authority
// `<iface>/global`), so <spatial_awareness> shows its name and its channels point at a parent a reader shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { placeChainInDb } from '../src/memory/db/place-tree.ts';
import { noteRoots } from '../src/memory/db/roots.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../src/memory/db/types.ts';

const AT = '2026-11-06T10:00:00.000Z';
const LATER = '2026-11-06T11:00:00.000Z';
const SERVER = 'discord:server:g1';

function serverRows(db: Db, native: string) {
  return db.prepare("SELECT id, name, retired_at FROM places WHERE kind = 'server' AND native_id = ?").all(native);
}

function withDb(run: (handle: MemoryHandle, db: Db) => void): void {
  const handle = openMemoryDb(':memory:');
  try {
    run(handle, dbOf(handle));
  } finally {
    handle.close();
  }
}

test('gives the root a named, active server place on the first hello', () => {
  // Bug: no hello names a server, so the server place is never written or stays "(unnamed)" in <spatial_awareness>.
  withDb((handle, db) => {
    noteRoots(handle, { iface: 'discord', roots: [{ id: 'g1', name: 'Root One' }], at: AT });
    const rows = serverRows(db, 'g1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, SERVER);
    assert.equal(rows[0]?.name, 'Root One');
    assert.equal(rows[0]?.retired_at, null);
  });
});

test('renames the server place and adds no second row when a later hello brings a new name', () => {
  // Bug: a renamed server keeps its first name, or the rename inserts a duplicate server place.
  withDb((handle, db) => {
    noteRoots(handle, { iface: 'discord', roots: [{ id: 'g1', name: 'Root One' }], at: AT });
    noteRoots(handle, { iface: 'discord', roots: [{ id: 'g1', name: 'Root Prime' }], at: LATER });
    const rows = serverRows(db, 'g1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.name, 'Root Prime');
  });
});

test('keeps the stored name when a later hello names the root with an empty string', () => {
  // Bug: an interface that cannot read the name yet blanks the one the place had.
  withDb((handle, db) => {
    noteRoots(handle, { iface: 'discord', roots: [{ id: 'g1', name: 'Root One' }], at: AT });
    noteRoots(handle, { iface: 'discord', roots: [{ id: 'g1', name: '' }], at: LATER });
    const rows = serverRows(db, 'g1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.name, 'Root One');
    assert.equal(rows[0]?.retired_at, null);
  });
});

test('creates an unnamed active place for a root the first hello gives no name', () => {
  // Boundary: the root exists for its channels even before anyone names it; a later hello names it.
  withDb((handle, db) => {
    noteRoots(handle, { iface: 'discord', roots: [{ id: 'g1', name: '' }], at: AT });
    assert.equal(serverRows(db, 'g1')[0]?.name, null);
    assert.equal(serverRows(db, 'g1')[0]?.retired_at, null);
    noteRoots(handle, { iface: 'discord', roots: [{ id: 'g1', name: 'Root One' }], at: LATER });
    assert.equal(serverRows(db, 'g1')[0]?.name, 'Root One');
  });
});

test('writes one place per root of a hello and leaves the others alone on a later one', () => {
  // Bug: a hello that lists only some servers retires or renames the ones it leaves out.
  withDb((handle, db) => {
    noteRoots(handle, {
      iface: 'discord',
      roots: [
        { id: 'g1', name: 'Root One' },
        { id: 'g2', name: 'Root Two' },
      ],
      at: AT,
    });
    noteRoots(handle, { iface: 'discord', roots: [{ id: 'g2', name: 'Root Two' }], at: LATER });
    assert.equal(serverRows(db, 'g1')[0]?.name, 'Root One');
    assert.equal(serverRows(db, 'g1')[0]?.retired_at, null);
    assert.equal(serverRows(db, 'g2')[0]?.name, 'Root Two');
  });
});

test('names the same native id on another interface as its own place', () => {
  // Bug: two interfaces that share a native id share one server place and one name.
  withDb((handle, db) => {
    noteRoots(handle, { iface: 'discord', roots: [{ id: 'g1', name: 'Root One' }], at: AT });
    noteRoots(handle, { iface: 'other', roots: [{ id: 'g1', name: 'Other One' }], at: AT });
    assert.equal(serverRows(db, 'g1').length, 2);
    const names = db.prepare("SELECT name FROM places WHERE id = 'discord:server:g1'").get();
    assert.equal(names?.name, 'Root One');
  });
});

test('revives a retired server place and names it when a hello names its root', () => {
  // Bug: a server place retired by an earlier unit write stays hidden although the interface serves it again.
  withDb((handle, db) => {
    db.prepare(
      `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, retired_at)
       VALUES (?, 'discord', 'server', 'g1', 'server:g1', 'discord/global', 1, ?)`
    ).run(SERVER, AT);
    noteRoots(handle, { iface: 'discord', roots: [{ id: 'g1', name: 'Root One' }], at: LATER });
    const rows = serverRows(db, 'g1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.name, 'Root One');
    assert.equal(rows[0]?.retired_at, null);
  });
});

// The day the bot joined a root (the owner's decision of 2026-11-11): an interface reports the moment with a root, as
// milliseconds since the epoch, in an event and in a hello. The writer keeps it on the root's place, and the chain read
// of the place (place-tree.ts, `joinedAt?: number | null` on a link, set only for a place with a known moment) gives it back.
//   Root = { id: string; name: string; joinedAt?: number }
const JOINED = Date.parse('2026-10-03T10:00:00Z');

test('keeps the moment a root joined on its place, and a channel under it has none', () => {
  // Bug: the moment an event reports is dropped on the way to the place, so no block can say since when she is there.
  withDb((handle, db) => {
    noteRoots(handle, { iface: 'discord', roots: [{ id: 'g1', name: 'Root One', joinedAt: JOINED }], at: AT });
    assert.equal(placeChainInDb(db, SERVER)[0]?.joinedAt, JOINED);
    db.prepare(
      `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, parent_id, name)
       VALUES ('discord:channel:c1', 'discord', 'channel', 'c1', 'channel:c1', 'discord/global', 1, ?, 'room')`
    ).run(SERVER);
    const chain = placeChainInDb(db, 'discord:channel:c1');
    assert.equal(chain[0]?.joinedAt ?? null, null);
    assert.equal(chain[1]?.joinedAt, JOINED);
  });
});

test('keeps the moment of a root through the memory writer, the way a hello reaches it', () => {
  // Bug: the writer's `roots` update rebuilds each root from id and name and loses the moment on the hello path.
  withDb((handle, db) => {
    applyMemoryWrite(handle, {
      kind: 'roots',
      iface: 'discord',
      roots: [{ id: 'g1', name: 'Root One', joinedAt: JOINED }],
      at: AT,
    });
    assert.equal(placeChainInDb(db, SERVER)[0]?.joinedAt, JOINED);
  });
});

test('a later event or hello with no moment keeps the stored one, and renames still apply', () => {
  // Bug: a hello after a restart, which cannot tell the moment again, blanks the day she joined.
  withDb((handle, db) => {
    noteRoots(handle, { iface: 'discord', roots: [{ id: 'g1', name: 'Root One', joinedAt: JOINED }], at: AT });
    noteRoots(handle, { iface: 'discord', roots: [{ id: 'g1', name: 'Root One' }], at: LATER });
    noteRoots(handle, { iface: 'discord', roots: [{ id: 'g1', name: 'Root Prime' }], at: LATER });
    const [root] = placeChainInDb(db, SERVER);
    assert.equal(root?.joinedAt, JOINED);
    assert.equal(root?.name, 'Root Prime');
  });
});

test('a root stored with no moment gets it from a later hello that carries one', () => {
  // Bug: a root written before the field existed never learns its day, so the first server stays without one.
  withDb((handle, db) => {
    noteRoots(handle, { iface: 'discord', roots: [{ id: 'g1', name: 'Root One' }], at: AT });
    assert.equal(placeChainInDb(db, SERVER)[0]?.joinedAt ?? null, null);
    noteRoots(handle, { iface: 'discord', roots: [{ id: 'g1', name: 'Root One', joinedAt: JOINED }], at: LATER });
    assert.equal(placeChainInDb(db, SERVER)[0]?.joinedAt, JOINED);
  });
});
