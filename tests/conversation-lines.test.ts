// src/memory/db/conversation-lines.ts on a real memory schema: what a session reads of the stored sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { conversationLines } from '../src/memory/db/conversation-lines.ts';
import type { Db } from '../src/memory/db/types.ts';

type Context = { after: (fn: () => void) => void };

function rig(t: Context) {
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  const db = handle.db as Db;
  const insert = db.prepare(
    `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, occurred_at, text) VALUES (?, ?, 'cli', ?, ?, ?, ?, ?)`
  );
  const add = (
    id: string,
    kind: string,
    native: string,
    at: string,
    text: string,
    revision = 1,
    place = 'cli:dm:owner'
  ) => void insert.run(id, kind, native, revision, place, at, text);
  return { db, add };
}

test('lines come oldest first, with who said them and their source and message ids', (t) => {
  // Bug: a resumed conversation reads backwards, or her lines show as the owner's.
  const { db, add } = rig(t);
  add('s2', 'said', 'n2', '2026-11-05T00:00:02.000Z', 'answer');
  add('s1', 'seen', 'n1', '2026-11-05T00:00:01.000Z', 'question');
  assert.deepEqual(conversationLines(db, 'cli:dm:owner'), [
    {
      id: 's1',
      placeId: 'cli:dm:owner',
      at: Date.parse('2026-11-05T00:00:01.000Z'),
      who: 'owner',
      text: 'question',
      nativeId: 'n1',
    },
    {
      id: 's2',
      placeId: 'cli:dm:owner',
      at: Date.parse('2026-11-05T00:00:02.000Z'),
      who: 'her',
      text: 'answer',
      nativeId: 'n2',
    },
  ]);
});

test('another place, an older revision, a deleted message and an empty line stay out', (t) => {
  // Bug: a session shows another conversation's lines, a superseded text or a message that was deleted.
  const { db, add } = rig(t);
  add('o1', 'seen', 'x', '2026-11-05T00:00:01.000Z', 'elsewhere', 1, 'discord:dm:u');
  add('r1', 'seen', 'n1', '2026-11-05T00:00:01.000Z', 'first text', 1);
  add('r2', 'seen', 'n1', '2026-11-05T00:00:01.000Z', 'edited text', 2);
  add('d1', 'seen', 'n2', '2026-11-05T00:00:02.000Z', 'deleted later');
  add('d2', 'deleted', 'n2', '2026-11-05T00:00:03.000Z', '');
  add('e1', 'seen', 'n3', '2026-11-05T00:00:04.000Z', '');
  assert.deepEqual(
    conversationLines(db, 'cli:dm:owner').map((line) => line.text),
    ['edited text']
  );
});

test('a place with no lines gives none', (t) => {
  // Bug: an empty place throws where the picker reads it.
  assert.deepEqual(conversationLines(rig(t).db, 'cli:dm:owner'), []);
});
