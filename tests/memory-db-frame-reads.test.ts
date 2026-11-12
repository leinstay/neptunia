// Tests for src/memory/db/frame-reads.ts: whether a source's line is retired, found through the source row's `iface`
// and `native_id` columns, the source row id each line around a moment carries, and the path and author of her own
// lines, read from the place's and the account's rows. No reader cuts these out of the text of an id. Synthetic SQLite
// rows over the mind-world fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertRows } from '../src/memory/db/rows.ts';
import {
  chatPlacesOf,
  lineOfIdentity,
  linesAroundOf,
  linesSinceOf,
  ownLinesOf,
  sourceRetiredOf,
} from '../src/memory/db/frame-reads.ts';
import { internalContext } from '../src/memory/db/scope.ts';
import {
  addDm,
  addLine,
  addRoom,
  addPerson,
  noteInterface,
  openWorld,
  rootId,
} from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';
import { minute, storeProductionEdit } from './fixtures/memory-db/edited-line.ts';

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
    // The owner's decision of 2026-11-11 (a place reads in words): a line carries its place's interface and chain
    // (innermost first, with kinds) instead of a path of names, so a request can give each link its interface's noun.
    assert.equal(line?.iface, 'fake');
    assert.deepEqual(
      line?.chain.map((link) => [link.kind, link.name]),
      [
        ['channel', 'garden'],
        ['server', 'Agora'],
      ]
    );
  } finally {
    world.close();
  }
});

test("her line in a direct chat stored under an opaque id is one unnamed direct chat link with the partner's person", () => {
  // Bug: the partner was cut out of the text of the place id, which an opaque DM place does not spell.
  const world = openWorld();
  try {
    world.db.exec(`INSERT INTO people (id) VALUES ('person:7e21');
      INSERT INTO accounts (id, iface, native_id, person_id) VALUES ('account:opaque-partner', 'fake', 'u-77', 'person:7e21');
      INSERT INTO places (id, iface, kind, native_id, chat, scope_kind, partner_account, partner_person)
        VALUES ('place:opaque-dm', 'fake', 'dm', NULL, 'dm', 'dm', 'account:opaque-partner', 'person:7e21');`);
    ownLine(world, { place: 'place:opaque-dm', native: 'm-51', account: null, scope: 'dm' });
    const [line] = ownLinesOf(world.db, internalContext(), null, 5);
    // The owner's decision of 2026-11-11: the chain is the one unnamed `dm` link, no `private` and no platform id.
    assert.deepEqual(
      [line?.iface, line?.chain.map((link) => [link.id, link.kind, link.name]), line?.dm, line?.partner],
      ['fake', [['place:opaque-dm', 'dm', null]], true, 'person:7e21']
    );
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

test("every chat is a place a #handle may name: a direct chat and the command line's chat as well as a channel", () => {
  // Bug: only channels and threads were listed, so a handle of a direct chat or of the command line's chat named nothing
  // and the tools that take a place refused the places she talks in most.
  const world = openWorld();
  try {
    noteInterface(world, 'fake', [{ id: 'g1', name: 'Agora' }]);
    addRoom(world.db, { iface: 'fake', native: 'c7', root: rootId('fake', 'g1'), name: 'garden' });
    addPerson(world.db, {
      id: 'person:zoe',
      accounts: [{ id: 'fake:u1', iface: 'fake', native: 'u1', names: ['Zoé'] }],
    });
    addPerson(world.db, {
      id: 'person:owner',
      accounts: [{ id: 'cli:owner', iface: 'cli', native: 'owner', names: ['Orestis'] }],
    });
    const dm = addDm(world.db, { iface: 'fake', native: 'u1', person: 'person:zoe', account: 'fake:u1' });
    const cli = addDm(world.db, { iface: 'cli', native: 'owner', person: 'person:owner', account: 'cli:owner' });
    const listed = new Map(chatPlacesOf(world.db).map((one) => [one.id, one.nativeId]));
    assert.equal(listed.get(dm), 'u1');
    assert.equal(listed.get(cli), 'owner');
    assert.equal(listed.get(rootId('fake', 'g1')), undefined, 'a root is no chat');
  } finally {
    world.close();
  }
});

/** The scene of production's edit (fixtures/memory-db/edited-line.ts) in a room of the `fake` interface. */
function editedRoom(world: World): string {
  noteInterface(world, 'fake', [{ id: 'g1', name: 'Agora' }]);
  const room = addRoom(world.db, { iface: 'fake', native: 'c7', root: rootId('fake', 'g1'), name: 'garden' });
  storeProductionEdit(world.db, { iface: 'fake', place: room });
  return room;
}

const shown = (lines: ReadonlyArray<{ id: string; self: boolean; text: string }>) =>
  lines.map((line) => [line.id, line.self, line.text]);

const IN_ORDER = [
  ['owner-1', false, 'first words'],
  ['hers-1', true, 'the kettle is on'],
  ['owner-2', false, 'second words'],
  ['hers-2', true, 'her next words'],
];

// Bug (production, 2026-11-12): an edit stored with the moment of the edit made a read from a moment hand back the first
// revision's text at its old place, or the edit at the end of the window, so `<meanwhile>` and conversation.read showed
// her line twice or in the wrong place.
test('a read from a moment gives her edited line once, at the place it was said, with the new text', () => {
  const world = openWorld();
  try {
    const room = editedRoom(world);
    const lines = linesSinceOf(world.db, internalContext(), room, minute(0), 10);
    assert.deepEqual(shown(lines), IN_ORDER);
  } finally {
    world.close();
  }
});

test('a read around a line gives her edited line once, at the place it was said, with the new text', () => {
  const world = openWorld();
  try {
    const room = editedRoom(world);
    const lines = linesAroundOf(world.db, internalContext(), room, minute(2), 5);
    assert.deepEqual(shown(lines), IN_ORDER);
  } finally {
    world.close();
  }
});

// Bug: her newest lines elsewhere are ordered by the edit's moment, so an old line she fixed reads as her newest.
test('her newest lines in other places date an edited line by the moment it was said', () => {
  const world = openWorld();
  try {
    editedRoom(world);
    const found = ownLinesOf(world.db, internalContext(), null, 10);
    assert.deepEqual(
      found.map((line) => [line.id, line.at]),
      [
        ['hers-2', minute(3)],
        ['hers-1', minute(1)],
      ]
    );
    assert.equal(found[1]?.text, 'the kettle is on');
  } finally {
    world.close();
  }
});

// Bug: a reference to the line quotes it under the moment of its edit.
test('a line by its identity is dated by the moment it was said once it is edited', () => {
  const world = openWorld();
  try {
    editedRoom(world);
    const line = lineOfIdentity(world.db, internalContext(), 'src:fake:hers-1');
    assert.deepEqual([line?.at, line?.text, line?.self, line?.revision], [minute(1), 'the kettle is on', true, 2]);
  } finally {
    world.close();
  }
});
