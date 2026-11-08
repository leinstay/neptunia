// src/memory/db/chat-lines.ts on a real memory schema: what a session reads of the stored sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { chatLines, lineNumberOf } from '../src/memory/db/chat-lines.ts';
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
  // Bug: a resumed chat reads backwards, or her lines show as the owner's.
  const { db, add } = rig(t);
  add('s2', 'said', 'n2', '2026-11-05T00:00:02.000Z', 'answer');
  add('s1', 'seen', 'n1', '2026-11-05T00:00:01.000Z', 'question');
  // Each line also carries `number`, its place in the chat's whole stored history, which the owner's chat draws as `#N`.
  assert.deepEqual(chatLines(db, 'cli:dm:owner'), [
    {
      id: 's1',
      placeId: 'cli:dm:owner',
      at: Date.parse('2026-11-05T00:00:01.000Z'),
      who: 'owner',
      text: 'question',
      nativeId: 'n1',
      number: 1,
    },
    {
      id: 's2',
      placeId: 'cli:dm:owner',
      at: Date.parse('2026-11-05T00:00:02.000Z'),
      who: 'her',
      text: 'answer',
      nativeId: 'n2',
      number: 2,
    },
  ]);
});

test('another place, an older revision, a deleted message and an empty line stay out', (t) => {
  // Bug: a session shows another chat's lines, a superseded text or a message that was deleted.
  const { db, add } = rig(t);
  add('o1', 'seen', 'x', '2026-11-05T00:00:01.000Z', 'elsewhere', 1, 'discord:dm:u');
  add('r1', 'seen', 'n1', '2026-11-05T00:00:01.000Z', 'first text', 1);
  add('r2', 'seen', 'n1', '2026-11-05T00:00:01.000Z', 'edited text', 2);
  add('d1', 'seen', 'n2', '2026-11-05T00:00:02.000Z', 'deleted later');
  add('d2', 'deleted', 'n2', '2026-11-05T00:00:03.000Z', '');
  add('e1', 'seen', 'n3', '2026-11-05T00:00:04.000Z', '');
  assert.deepEqual(
    chatLines(db, 'cli:dm:owner').map((line) => line.text),
    ['edited text']
  );
});

test('a place with no lines gives none', (t) => {
  // Bug: an empty place throws where the picker reads it.
  assert.deepEqual(chatLines(rig(t).db, 'cli:dm:owner'), []);
});

test('each line is numbered by its place in the whole stored chat, the oldest line first, ties by row', (t) => {
  // Bug: the number counts from the oldest line of a read, so the same line shows another number on another page.
  const { db, add } = rig(t);
  add('b', 'said', 'n2', '2026-11-05T00:00:01.000Z', 'second row of the same time');
  add('c', 'seen', 'n3', '2026-11-05T00:00:02.000Z', 'third');
  add('a', 'seen', 'n1', '2026-11-05T00:00:00.000Z', 'first');
  assert.deepEqual(
    chatLines(db, 'cli:dm:owner').map((line) => [line.id, line.number]),
    [
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]
  );
});

test('a chat longer than one read keeps the numbers of its whole history on the newest lines', (t) => {
  // Bug: past the bound of one read the oldest line read becomes #1, and every number shifts as the chat grows.
  const { db, add } = rig(t);
  const total = 5003;
  for (let n = 1; n <= total; n += 1)
    add(`s${n}`, 'seen', `n${n}`, new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString(), `line ${n}`);
  const lines = chatLines(db, 'cli:dm:owner');
  assert.equal(lines.at(-1)?.number, total);
  assert.equal(lines.at(-1)?.id, `s${total}`);
  const oldest = lines[0];
  assert.equal(oldest?.number, Number(oldest?.id.slice(1)));
});

test("a line's number by its message id is the number the session reads for it", (t) => {
  // Bug: her `#N` in the owner's chat named another line than the one the chat draws with that number.
  const { db, add } = rig(t);
  add('s1', 'seen', 'n1', '2026-11-05T00:00:01.000Z', 'one');
  add('s2', 'said', 'n2', '2026-11-05T00:00:02.000Z', 'two');
  add('o1', 'seen', 'n9', '2026-11-05T00:00:01.500Z', 'elsewhere', 1, 'other:dm:x');
  add('s3', 'seen', 'n3', '2026-11-05T00:00:03.000Z', 'three');
  const numbers = chatLines(db, 'cli:dm:owner').map((line) => [line.nativeId, line.number]);
  assert.deepEqual(
    numbers.map(([native]) => [native, lineNumberOf(db, 'cli:dm:owner', String(native))]),
    numbers
  );
});

test('a message id the place does not hold has no number', (t) => {
  const { db, add } = rig(t);
  add('s1', 'seen', 'n1', '2026-11-05T00:00:01.000Z', 'one');
  assert.equal(lineNumberOf(db, 'cli:dm:owner', 'missing'), null);
  assert.equal(lineNumberOf(db, 'other:dm:x', 'n1'), null);
});
