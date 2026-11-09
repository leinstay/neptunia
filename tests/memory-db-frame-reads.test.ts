// Tests for src/memory/db/frame-reads.ts: whether a source's line is retired, found through the source row's `iface`
// and `native_id` columns, the source row id each line around a moment carries, and the path and author of her own
// lines, read from the place's and the account's rows. No reader cuts these out of the text of an id. Synthetic SQLite
// rows over the mind-world fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertRows } from '../src/memory/db/rows.ts';
import { linesAroundOf, ownLinesOf, sourceRetiredOf } from '../src/memory/db/frame-reads.ts';
import { internalContext } from '../src/memory/db/scope.ts';
import { addLine, addRoom, noteInterface, openWorld, rootId } from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';

const AT = '2026-11-01T10:00:00.000Z';

/** A room of the `fake` interface and one line in it stored under `id`, with message id `native` at `revision`. */
function roomWithLine(world: World, { id, native, revision = 1 }: { id: string; native: string; revision?: number }) {
  noteInterface(world, 'fake', [{ id: 'g1', name: 'Agora' }]);
  const room = addRoom(world.db, { iface: 'fake', native: 'c7', root: rootId('fake', 'g1'), name: 'garden' });
  insertRows(world.db, {
    sources: [
      {
        id,
        kind: 'seen',
        iface: 'fake',
        native_id: native,
        native_kind: 'message',
        revision,
        place_id: room,
        author_account: null,
        occurred_at: AT,
        recorded_at: AT,
        text: 'το κουνέλι',
        scope_kind: 'group',
        scope_iface: 'fake',
        scope_dm: null,
      },
    ],
  });
  return room;
}

test('the line of a source stored under an opaque id is live while its message stands', () => {
  // Bug: the reader cut the message id out of the source id's text, so a line stored under an opaque id read as gone.
  const world = openWorld();
  try {
    roomWithLine(world, { id: 'source:opaque-1', native: 'm-42', revision: 2 });
    assert.equal(sourceRetiredOf(world.db, internalContext(), 'source:opaque-1'), false);
  } finally {
    world.close();
  }
});

test('the line of a source is retired when its message was deleted', () => {
  // Bug: a deleted message read by its source keeps its lookup in <recall> as if the line were there.
  const world = openWorld();
  try {
    const room = roomWithLine(world, { id: 'source:opaque-2', native: 'm-43' });
    insertRows(world.db, {
      sources: [
        {
          id: 'source:opaque-2-deleted',
          kind: 'deleted',
          iface: 'fake',
          native_id: 'm-43',
          native_kind: 'message',
          revision: 2,
          place_id: room,
          occurred_at: AT,
          recorded_at: AT,
          text: '',
          scope_kind: 'group',
          scope_iface: 'fake',
          scope_dm: null,
        },
      ],
    });
    assert.equal(sourceRetiredOf(world.db, internalContext(), 'source:opaque-2'), true);
  } finally {
    world.close();
  }
});

test('a source id no row holds is retired', () => {
  // Bug: a source id of the `src:` shape is respelled into a message id and finds a line of another source.
  const world = openWorld();
  try {
    roomWithLine(world, { id: 'source:opaque-3', native: 'm-44' });
    assert.equal(sourceRetiredOf(world.db, internalContext(), 'src:fake:m-44:1:seen'), true);
  } finally {
    world.close();
  }
});

test('a line around a moment carries the id of its source row', () => {
  // Bug: a reader of the line respelled a source id from its interface and message id, a row that may not exist.
  const world = openWorld();
  try {
    const room = roomWithLine(world, { id: 'source:opaque-4', native: 'm-45', revision: 3 });
    const lines = linesAroundOf(world.db, internalContext(), room, Date.parse(AT), 2);
    assert.deepEqual(
      lines.map((line) => [line.id, line.sourceId]),
      [['m-45', 'source:opaque-4']]
    );
  } finally {
    world.close();
  }
});

/** Her line `native` in the place `place`, written by the account `account`, scoped as `scope`. */
function ownLine(
  world: World,
  { place, native, account, scope }: { place: string; native: string; account: string | null; scope: 'group' | 'dm' }
) {
  insertRows(world.db, {
    sources: [
      {
        id: `source:${native}`,
        kind: 'said',
        iface: 'fake',
        native_id: native,
        native_kind: 'message',
        revision: 1,
        place_id: place,
        author_account: account,
        author_kind: 'self',
        occurred_at: AT,
        recorded_at: AT,
        text: 'η αυλή',
        scope_kind: scope,
        scope_iface: 'fake',
        scope_dm: scope === 'dm' ? 'person:7e21' : null,
      },
    ],
  });
}

test('her line in a room stored under an opaque id has a path that starts with the interface of its row', () => {
  // Bug: the path took the interface from the text of the place id, so a room stored as `place:...` sat under `place`.
  const world = openWorld();
  try {
    noteInterface(world, 'fake', [{ id: 'g1', name: 'Agora' }]);
    world.db
      .prepare(
        `INSERT INTO places (id, iface, kind, native_id, parent_id, chat, scope_kind, name)
         VALUES ('place:opaque-room', 'fake', 'channel', 'c8', ?, 'group', 'group', 'garden')`
      )
      .run(rootId('fake', 'g1'));
    ownLine(world, { place: 'place:opaque-room', native: 'm-50', account: null, scope: 'group' });
    const [line] = ownLinesOf(world.db, internalContext(), null, 5);
    assert.deepEqual(line?.path, ['fake', 'Agora', 'garden']);
  } finally {
    world.close();
  }
});

test("her line in a direct chat stored under an opaque id has a path that ends in the partner account's native id", () => {
  // Bug: the path cut the partner out of the text of the place id, which an opaque DM place does not spell.
  const world = openWorld();
  try {
    world.db.exec(`INSERT INTO people (id) VALUES ('person:7e21');
      INSERT INTO accounts (id, iface, native_id, person_id) VALUES ('account:opaque-partner', 'fake', 'u-77', 'person:7e21');
      INSERT INTO places (id, iface, kind, native_id, chat, scope_kind, partner_account, partner_person)
        VALUES ('place:opaque-dm', 'fake', 'dm', NULL, 'dm', 'dm', 'account:opaque-partner', 'person:7e21');`);
    ownLine(world, { place: 'place:opaque-dm', native: 'm-51', account: null, scope: 'dm' });
    const [line] = ownLinesOf(world.db, internalContext(), null, 5);
    assert.deepEqual([line?.path, line?.dm, line?.partner], [['fake', 'private', 'u-77'], true, 'person:7e21']);
  } finally {
    world.close();
  }
});

test("a line's author id is the native id of its author account's row", () => {
  // Bug: the author id was cut out of the text of the account id, which an opaque account does not spell.
  const world = openWorld();
  try {
    const room = roomWithLine(world, { id: 'source:opaque-5', native: 'm-46' });
    world.db.exec(`INSERT INTO accounts (id, iface, native_id) VALUES ('account:opaque-self', 'fake', 'self-9')`);
    ownLine(world, { place: room, native: 'm-52', account: 'account:opaque-self', scope: 'group' });
    const [line] = ownLinesOf(world.db, internalContext(), null, 5);
    assert.equal(line?.authorId, 'self-9');
  } finally {
    world.close();
  }
});

/** A room of the `fake` interface that holds her lines under test. */
function gardenOf(world: World): string {
  noteInterface(world, 'fake', [{ id: 'g1', name: 'Agora' }]);
  return addRoom(world.db, { iface: 'fake', native: 'c9', root: rootId('fake', 'g1'), name: 'garden' });
}

/** One image item with `description` (null: no text form yet) linked to the stored line `source`. */
function pictureOn(world: World, source: string, description: string | null) {
  world.db
    .prepare(
      `INSERT INTO media (id, kind, availability, description, scope_kind, scope_iface)
       VALUES (?, 'image', ?, ?, 'group', 'fake')`
    )
    .run(`media:${source}`, description === null ? 'unknown' : 'present', description);
  world.db
    .prepare("INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('source', ?, 0, ?)")
    .run(source, `media:${source}`);
}

test('her picture-only line is among her own lines with the description of its media', () => {
  // Bug: a post that is only a picture has empty text, so the live-line filter dropped it and <meanwhile> never
  // listed it, though its description was stored.
  const world = openWorld();
  try {
    const room = gardenOf(world);
    addLine(world.db, {
      id: 'm-text',
      iface: 'fake',
      place: room,
      author: 'self',
      text: 'η αυλή',
      at: '2026-11-01T09:00:00.000Z',
    });
    addLine(world.db, {
      id: 'm-pic',
      iface: 'fake',
      place: room,
      author: 'self',
      text: '',
      at: '2026-11-01T10:00:00.000Z',
    });
    pictureOn(world, 'm-pic', 'a white rabbit in a garden');
    const lines = ownLinesOf(world.db, internalContext(), null, 5);
    const picture = lines.find((line) => line.id === 'm-pic');
    assert.ok(picture, 'the picture-only line is listed');
    assert.deepEqual(
      picture.media.map((item) => [item.kind, item.text]),
      [['image', 'a white rabbit in a garden']]
    );
  } finally {
    world.close();
  }
});

test('a line with empty text and no media stays out of her own lines', () => {
  // Bug: relaxing the filter for pictures must not let an empty line through as a blank entry.
  const world = openWorld();
  try {
    const room = gardenOf(world);
    addLine(world.db, {
      id: 'm-text',
      iface: 'fake',
      place: room,
      author: 'self',
      text: 'η αυλή',
      at: '2026-11-01T09:00:00.000Z',
    });
    addLine(world.db, {
      id: 'm-empty',
      iface: 'fake',
      place: room,
      author: 'self',
      text: '',
      at: '2026-11-01T10:00:00.000Z',
    });
    const ids = ownLinesOf(world.db, internalContext(), null, 5).map((line) => line.id);
    assert.deepEqual(ids, ['m-text']);
  } finally {
    world.close();
  }
});

test('a picture-only line is among the lines around a line', () => {
  // Bug: the lines around a line of hers skipped a neighbour that was only a picture, so the window had a hole.
  const world = openWorld();
  try {
    const room = gardenOf(world);
    addLine(world.db, {
      id: 'm-1',
      iface: 'fake',
      place: room,
      author: 'self',
      text: 'πρώτη',
      at: '2026-11-01T09:00:00.000Z',
    });
    addLine(world.db, {
      id: 'm-pic',
      iface: 'fake',
      place: room,
      author: 'self',
      text: '',
      at: '2026-11-01T09:01:00.000Z',
    });
    addLine(world.db, {
      id: 'm-3',
      iface: 'fake',
      place: room,
      author: 'self',
      text: 'τρίτη',
      at: '2026-11-01T09:02:00.000Z',
    });
    pictureOn(world, 'm-pic', 'a white rabbit in a garden');
    const lines = linesAroundOf(world.db, internalContext(), room, Date.parse('2026-11-01T09:01:00.000Z'), 1);
    assert.deepEqual(
      lines.map((line) => line.id),
      ['m-1', 'm-pic', 'm-3']
    );
  } finally {
    world.close();
  }
});
