// Tests for src/memory/db/frame-reads.ts: whether a source's line is retired, found through the source row's `iface`
// and `native_id` columns, and the source row id each line around a moment carries. No reader cuts these out of the
// text of a source id. Synthetic SQLite rows over the mind-world fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertRows } from '../src/memory/db/rows.ts';
import { linesAroundOf, sourceRetiredOf } from '../src/memory/db/frame-reads.ts';
import { internalContext } from '../src/memory/db/scope.ts';
import { addRoom, noteInterface, openWorld, rootId } from './fixtures/memory-db/mind-world.ts';
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
