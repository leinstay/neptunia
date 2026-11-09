// The per-place GIF libraries of an older database become the persona's one (src/memory/db/gif-library-merge.ts) at the
// first open, where the store reads the library with no place. Plan 2026-11-04-cli-and-memory, stage B7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeGifLibraries } from '../src/memory/db/gif-library-merge.ts';
import { personaKey, placeCollection, storageId } from '../src/memory/db/storage-keys.ts';
import { storageValue } from '../src/memory/db/export.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { freshMemoryDb } from './fixtures/memory-db-copy.ts';

test('two places of one database become one entry with a counter each, and a second open changes nothing', () => {
  // Bug: `g1` of one place and `g1` of another would post each other's GIF, and a repost's counts would be lost.
  const handle = freshMemoryDb();
  const db = dbOf(handle);
  const entry = (id: string, url: string, count: number, last: number) => ({
    id,
    kind: 'link',
    url,
    itemId: `${id}-${count}`,
    count,
    last,
    firstSeen: last,
  });
  const write = (place: string, value: Record<string, unknown>) =>
    handle.transaction(() =>
      // A unit of a place as an older store wrote it, through the same writer the merge uses.
      storageWrite(db, place, value)
    );
  write('place:a', { nextId: 2, entries: { k1: entry('g1', 'https://tenor.com/view/both', 3, 100) } });
  write('place:b', {
    nextId: 3,
    entries: {
      k2: entry('g1', 'https://tenor.com/view/only-b', 1, 200),
      k3: entry('g2', 'https://tenor.com/view/both', 2, 300),
    },
  });
  assert.equal(mergeGifLibraries(db), 2);
  const library = storageValue(db, personaKey('gifs')) as {
    entries: Record<string, { id: string; url: string; places: Record<string, { count: number }> }>;
  };
  const entries = Object.values(library.entries);
  assert.equal(entries.length, 2);
  assert.equal(new Set(entries.map((one) => one.id)).size, 2, 'handles are distinct');
  const both = entries.find((one) => one.url === 'https://tenor.com/view/both');
  assert.equal(both?.places['place:a'].count, 3);
  assert.equal(both?.places['place:b'].count, 2);
  assert.equal(mergeGifLibraries(db), 0, 'nothing left to merge');
  handle.close();
});

/** Writes a library as the unit of a place, the shape an older store left. */
function storageWrite(db: ReturnType<typeof dbOf>, place: string, value: Record<string, unknown>): void {
  const key = placeCollection('gifs', place);
  const id = storageId(key);
  db.prepare('INSERT INTO storage_units(id,kind,subject_type,subject_id,key_json) VALUES (?,?,?,?,?)').run(
    id,
    'gifs',
    'place',
    place,
    JSON.stringify(key)
  );
  for (const [entryKey, entry] of Object.entries(value.entries as Record<string, object>)) {
    db.prepare(
      `INSERT INTO media (id, kind, path, scope_kind, scope_iface, extra, owner_key) VALUES (?, 'gif', ?, 'group', 'discord', ?, ?)`
      // The store's table holds a file under media/ in `path`; a link stays in the entry's `url`.
    ).run(`media:gif:${entryKey}`, null, JSON.stringify(entry), id);
  }
  db.prepare("INSERT INTO operational (kind, owner, value, owner_key) VALUES ('gifs', ?, ?, ?)").run(
    id,
    JSON.stringify({ nextId: Reflect.get(value, 'nextId'), $has: ['entries'] }),
    id
  );
}
