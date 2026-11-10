// src/memory/db/places-read.ts: the owner's reader of places to any stored depth. A server and its channels are one case of a
// general tree: several roots, equal native keys under different authorities, orphans whose parent is missing, cycles an old
// database may hold, and continuation links that are not containment. Plan 2026-11-04-cli-and-memory task 8. Contract:
//   listPlaces(db: Db, request: { context: Context; filters: { interfaceId: string | null; authorityId: string | null;
//     rootsOnly: boolean }; limit: number; cursor: string | null }): Page<PlaceListing>
//   placeDetail(db: Db, placeId: string, request: { context: Context; includeChildren: boolean }): PlaceDetail
//   PlaceListing = { id; interfaceId; authorityId; nativeKey; generation; kind; chat; name; parentId;
//     parentState: 'none' | 'stored' | 'missing'; continuesPlaceId; childCount; retiredAt }
//   PlaceDetail = { found: true; place: PlaceListing; descriptions: Array<{ id; field; text; audienceId; placeId }>;
//     descendants: Array<PlaceListing & { depth: number }>; cycles: Array<{ from; to }>; continuations: Array<string>;
//     records: Array<{ table; id }> } | { found: false; code: 'PLACE_NOT_FOUND' }
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Page } from '../src/memory/db/inspection.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { listPlaces, placeDetail } from '../src/memory/db/places-read.ts';
import type { PlaceDetail, PlaceListing } from '../src/memory/db/places-read.ts';
import { groupContext, internalContext } from '../src/memory/db/scope.ts';
import type { Context } from '../src/memory/db/scope.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { wrongly } from './fixtures/loose-types.ts';
import {
  addDescription,
  addPlace,
  addSource,
  databaseDigest,
  withoutForeignKeys,
} from './fixtures/memory-db/browser-world.ts';
import { tempDir } from './fixtures/tmp.ts';

const DEPTH = 9;
const level = (n: number): string => `place:level-${n}`;
const INTERNAL = internalContext();
const ALL = { interfaceId: null, authorityId: null, rootsOnly: false };

/** A chain deeper than six, two authorities with one native key, a cycle, an orphan, a continuation, a DM and a retired room. */
function seed(db: Db): void {
  const zeta = { iface: 'zeta', authority: 'zeta/one' };
  for (let n = 0; n < DEPTH; n += 1)
    addPlace(db, {
      id: level(n),
      ...zeta,
      kind: n === 0 ? 'server' : 'channel',
      parent: n === 0 ? null : level(n - 1),
      name: `λ${n}`,
    });
  for (let n = 0; n < DEPTH; n += 1)
    addDescription(db, {
      id: `desc:${n}`,
      subjectKind: 'place',
      subject: level(n),
      field: 'topic',
      audience: 'aud:group:zeta',
      text: `the words of level ${n}`,
    });
  addPlace(db, { id: 'place:same-a', iface: 'zeta', authority: 'zeta/one', nativeKey: 'same-key' });
  addPlace(db, { id: 'place:same-b', iface: 'zeta', authority: 'zeta/two', nativeKey: 'same-key' });
  addPlace(db, { id: 'place:other-root', iface: 'eta', authority: 'eta/one' });
  addPlace(db, { id: 'place:cycle-a', ...zeta });
  addPlace(db, { id: 'place:cycle-b', ...zeta, parent: 'place:cycle-a' });
  db.prepare("UPDATE places SET parent_id = 'place:cycle-b' WHERE id = 'place:cycle-a'").run();
  withoutForeignKeys(db, () => {
    addPlace(db, { id: 'place:orphan', ...zeta, parent: 'place:gone' });
  });
  addPlace(db, { id: 'place:old-dm', iface: 'zeta', authority: 'zeta/one', chat: 'dm', kind: 'dm' });
  addPlace(db, { id: 'place:continued', ...zeta, continues: 'place:old-dm' });
  addPlace(db, { id: 'place:retired', ...zeta, parent: level(0), retiredAt: '2026-11-03T00:00:00.000Z' });
  addDescription(db, {
    id: 'desc:private',
    subjectKind: 'place',
    subject: 'place:old-dm',
    field: 'topic',
    audience: 'aud:dm:place:old-dm',
    text: 'the private note',
  });
  addSource(db, {
    id: 'source:deep',
    place: level(DEPTH - 1),
    iface: 'zeta',
    audience: 'aud:group:zeta',
    text: 'βάθος',
  });
  db.prepare(
    `INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, audience_id, scope_kind, created_at)
     VALUES ('claim:lore', 'place', ?, 'lore', 'the lore', 'current', 1, 'aud:group:zeta', 'group', '2026-11-01T00:00:00.000Z')`
  ).run(level(1));
}

function withWorld(body: (db: Db) => void): void {
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    seed(db);
    body(db);
  } finally {
    handle.close();
  }
}

function everyPlace(db: Db, context: Context = INTERNAL, filters = ALL, limit = 3): Array<PlaceListing> {
  const items: Array<PlaceListing> = [];
  let cursor: string | null = null;
  for (let turn = 0; turn < 1000; turn += 1) {
    const page: Page<PlaceListing> = listPlaces(db, { context, filters, limit, cursor });
    items.push(...page.items);
    if (page.next === null) return items;
    cursor = page.next;
  }
  throw new Error('the pages never end');
}

function found(view: PlaceDetail): Extract<PlaceDetail, { found: true }> {
  assert.equal(view.found, true);
  return view;
}
const idsOf = (items: ReadonlyArray<{ id: string }>): Array<string> => items.map((one) => one.id).sort();
const entry = (db: Db, id: string): PlaceListing | undefined => everyPlace(db).find((one) => one.id === id);

// ---------- the list ----------

test('every place of every interface is listed exactly once across pages, retired and orphaned ones included', () => {
  // Bug: the list starts at the interface's server, so a root DM, an orphan or a second interface is invisible.
  withWorld((db) => {
    const direct = db
      .prepare('SELECT id FROM places ORDER BY id')
      .all()
      .map((row) => String(row.id));
    const listed = everyPlace(db).map((one) => one.id);
    assert.equal(new Set(listed).size, listed.length, 'a place repeats across pages');
    assert.deepEqual([...listed].sort(), direct);
  });
});

test('equal native keys under different authorities stay two places, and the authority filter selects one before paging', () => {
  // Bug: a place is keyed by its native key, and the second authority's room overwrites the first.
  withWorld((db) => {
    const same = everyPlace(db).filter((one) => one.nativeKey === 'same-key');
    assert.deepEqual(idsOf(same), ['place:same-a', 'place:same-b']);
    const two = { ...ALL, authorityId: 'zeta/two' };
    const page = listPlaces(db, { context: INTERNAL, filters: two, limit: 1, cursor: null });
    assert.deepEqual([page.items.map((one) => one.id), page.total, page.next], [['place:same-b'], 1, null]);
  });
});

test('the interface filter applies before the count', () => {
  withWorld((db) => {
    const page = listPlaces(db, { context: INTERNAL, filters: { ...ALL, interfaceId: 'eta' }, limit: 5, cursor: null });
    assert.deepEqual([page.items.map((one) => one.id), page.total], [['place:other-root'], 1]);
  });
});

test('roots are the places without a stored parent, an orphan among them, and a cycle is not lost from the list', () => {
  // Bug: `parent_id IS NULL` hides the orphan, and following parents to a top never ends for a cycle.
  withWorld((db) => {
    const roots = idsOf(everyPlace(db, INTERNAL, { ...ALL, rootsOnly: true }));
    assert.ok(roots.includes(level(0)));
    assert.ok(roots.includes('place:orphan'));
    assert.ok(roots.includes('place:other-root'));
    assert.equal(roots.includes(level(1)), false);
    assert.ok(everyPlace(db).some((one) => one.id === 'place:cycle-a'));
  });
});

test('a listing says how its parent stands', () => {
  // Bug: a dangling parent id reads as an ordinary one, and expanding it opens nothing.
  withWorld((db) => {
    assert.equal(entry(db, level(0))?.parentState, 'none');
    assert.equal(entry(db, level(1))?.parentState, 'stored');
    assert.equal(entry(db, 'place:orphan')?.parentState, 'missing');
    assert.equal(entry(db, 'place:orphan')?.parentId, 'place:gone');
  });
});

test('a listing keeps its authority, native key, generation and chat', () => {
  withWorld((db) => {
    const dm = entry(db, 'place:old-dm');
    assert.deepEqual(
      [dm?.interfaceId, dm?.authorityId, dm?.nativeKey, dm?.generation, dm?.chat, dm?.kind],
      ['zeta', 'zeta/one', 'place:old-dm', 1, 'dm', 'dm']
    );
    assert.equal(entry(db, 'place:retired')?.retiredAt, '2026-11-03T00:00:00.000Z');
  });
});

// ---------- depth ----------

test('a listing counts its children, retired ones too', () => {
  withWorld((db) => {
    assert.equal(entry(db, level(0))?.childCount, 2);
    assert.equal(entry(db, level(DEPTH - 1))?.childCount, 0);
  });
});

test('include-children gathers the descriptions of the place and every descendant', () => {
  // Bug: `/memory server` reads one level, so a channel's description under a category is lost.
  withWorld((db) => {
    const view = found(placeDetail(db, level(0), { context: INTERNAL, includeChildren: true }));
    assert.deepEqual(
      view.descriptions.map((one) => [one.placeId, one.text]).sort(),
      Array.from({ length: DEPTH }, (_, n) => [level(n), `the words of level ${n}`]).sort()
    );
    const deepest = view.descendants.find((one) => one.id === level(DEPTH - 1));
    assert.equal(deepest?.depth, DEPTH - 1);
  });
});

test('without include-children a place shows its own descriptions and no descendant', () => {
  withWorld((db) => {
    const view = found(placeDetail(db, level(3), { context: INTERNAL, includeChildren: false }));
    assert.deepEqual(
      view.descriptions.map((one) => one.id),
      ['desc:3']
    );
    assert.deepEqual(view.descendants, []);
  });
});

test('a cycle ends with an explicit reference and each place once', () => {
  // Bug: a recursive read loops until the stack or the row cap, or stops silently as if the tree ended.
  withWorld((db) => {
    const view = found(placeDetail(db, 'place:cycle-a', { context: INTERNAL, includeChildren: true }));
    assert.deepEqual(
      view.descendants.map((one) => one.id),
      ['place:cycle-b']
    );
    assert.deepEqual(view.cycles, [{ from: 'place:cycle-b', to: 'place:cycle-a' }]);
  });
});

test('a self-parent is a cycle too', () => {
  withWorld((db) => {
    addPlace(db, { id: 'place:self', iface: 'zeta', authority: 'zeta/one' });
    db.prepare("UPDATE places SET parent_id = 'place:self' WHERE id = 'place:self'").run();
    const view = found(placeDetail(db, 'place:self', { context: INTERNAL, includeChildren: true }));
    assert.deepEqual([view.descendants, view.cycles], [[], [{ from: 'place:self', to: 'place:self' }]]);
  });
});

test('a continuation link is shown as one and is not containment', () => {
  // Bug: `continues_place_id` is read as a second parent, and a group appears inside the DM it grew from.
  withWorld((db) => {
    assert.equal(entry(db, 'place:continued')?.continuesPlaceId, 'place:old-dm');
    assert.equal(entry(db, 'place:continued')?.parentState, 'none');
    assert.deepEqual(
      found(placeDetail(db, 'place:old-dm', { context: INTERNAL, includeChildren: true })).continuations,
      ['place:continued']
    );
  });
});

test('detail opens the exact records of a place by id, its lines and its lore', () => {
  withWorld((db) => {
    assert.deepEqual(found(placeDetail(db, level(DEPTH - 1), { context: INTERNAL, includeChildren: false })).records, [
      { table: 'sources', id: 'source:deep' },
    ]);
    assert.deepEqual(found(placeDetail(db, level(1), { context: INTERNAL, includeChildren: false })).records, [
      { table: 'claims', id: 'claim:lore' },
    ]);
  });
});

test('a place nobody stored is a named refusal, and so is expanding it', () => {
  withWorld((db) => {
    assert.deepEqual(placeDetail(db, 'place:unknown', { context: INTERNAL, includeChildren: true }), {
      found: false,
      code: 'PLACE_NOT_FOUND',
    });
  });
});

// ---------- the context decides first ----------

test('a group context neither lists nor counts a DM place', () => {
  // Bug: the list is filtered after the total, and a preview shows how many private chats exist.
  withWorld((db) => {
    const context = groupContext('zeta');
    const page = listPlaces(db, { context, filters: ALL, limit: 500, cursor: null });
    assert.equal(
      page.items.some((one) => one.id === 'place:old-dm'),
      false
    );
    assert.equal(page.total, page.items.length);
    assert.equal(found(placeDetail(db, 'place:old-dm', { context, includeChildren: false })).descriptions.length, 0);
  });
});

test('the owner reads the private description the group cannot', () => {
  withWorld((db) => {
    assert.deepEqual(
      found(placeDetail(db, 'place:old-dm', { context: INTERNAL, includeChildren: false })).descriptions.map(
        (one) => one.text
      ),
      ['the private note']
    );
  });
});

test('a call without a valid context is refused', () => {
  withWorld((db) => {
    const bad = wrongly<Context>({});
    assert.throws(() => listPlaces(db, { context: bad, filters: ALL, limit: 5, cursor: null }));
    assert.throws(() => placeDetail(db, level(0), { context: bad, includeChildren: false }));
  });
});

test('a cursor is bound to its context and filters', () => {
  withWorld((db) => {
    const first = listPlaces(db, { context: INTERNAL, filters: ALL, limit: 1, cursor: null });
    const code = { code: 'INSPECTION_BAD_CURSOR' };
    assert.throws(
      () => listPlaces(db, { context: groupContext('zeta'), filters: ALL, limit: 1, cursor: first.next }),
      code
    );
    assert.throws(
      () => listPlaces(db, { context: INTERNAL, filters: { ...ALL, rootsOnly: true }, limit: 1, cursor: first.next }),
      code
    );
  });
});

test('an empty database lists nothing and completes', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const page = listPlaces(dbOf(handle), { context: INTERNAL, filters: ALL, limit: 5, cursor: null });
    assert.deepEqual([page.items, page.total, page.next], [[], 0, null]);
  } finally {
    handle.close();
  }
});

// ---------- no write ----------

test('the reader runs over a read-only connection and changes no row', () => {
  const file = join(tempDir('nep-places-read-'), 'memory.db');
  const writer = openMemoryDb(file);
  seed(dbOf(writer));
  writer.close();
  const reader = openMemoryDb(file, { readOnly: true });
  try {
    const db = dbOf(reader);
    const before = databaseDigest(db);
    for (const place of everyPlace(db)) {
      placeDetail(db, place.id, { context: INTERNAL, includeChildren: true });
    }
    assert.deepEqual(databaseDigest(db), before);
  } finally {
    reader.close();
  }
});
