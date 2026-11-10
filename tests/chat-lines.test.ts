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

test('a line that replies to another carries the message id and the number of the line it answers', (t) => {
  // Bug: the owner's chat lost which line her reply answered, and her `<chat>` lost it after a restart.
  const { db, add } = rig(t);
  add('s1', 'seen', 'n1', '2026-11-05T00:00:01.000Z', 'question');
  add('s2', 'seen', 'n2', '2026-11-05T00:00:02.000Z', 'another');
  add('s3', 'said', 'n3', '2026-11-05T00:00:03.000Z', 'answer');
  db.prepare("UPDATE sources SET reply_to = 'n1' WHERE id = 's3'").run();
  db.prepare("UPDATE sources SET reply_to = 'gone' WHERE id = 's2'").run();
  const lines = chatLines(db, 'cli:dm:owner');
  assert.deepEqual(
    lines.map((line) => [line.nativeId, line.replyToId ?? null, line.replyNumber ?? null]),
    [
      ['n1', null, null],
      ['n2', 'gone', null],
      ['n3', 'n1', 1],
    ]
  );
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

/** Gives the stored line `id` the message route a line written through message families holds, with `reply` its parent. */
function routed(db: Db, id: string, messageId: string, reply: string | null = null): void {
  const route = { v: 1, origin: 'protocol-message', iface: 'cli', chatId: 'cli:dm:owner' };
  const extra = {
    $messageLocator: { ...route, messageId },
    ...(reply === null ? {} : { $messageReply: { iface: 'cli', chatId: 'cli:dm:owner', messageId: reply } }),
  };
  db.prepare('UPDATE sources SET extra = ? WHERE id = ?').run(JSON.stringify(extra), id);
}

test('a line written through message families goes by its platform id and names its parent by the parent platform id', (t) => {
  // Bug (2026-11-08): the chat client knew a line by the platform's id and the store by the row's own key, so the line
  // stood twice in her `<chat>` and a reply named a parent no client line held.
  const { db, add } = rig(t);
  add('s1', 'seen', 'key-1', '2026-11-05T00:00:01.000Z', 'question');
  add('s2', 'said', 'key-2', '2026-11-05T00:00:02.000Z', 'answer');
  add('s3', 'seen', 'key-3', '2026-11-05T00:00:03.000Z', 'late reply');
  db.prepare("UPDATE sources SET reply_to = 'key-1' WHERE id = 's2'").run();
  db.prepare("UPDATE sources SET reply_to = 'key-gone' WHERE id = 's3'").run();
  routed(db, 's1', 'cli-1');
  routed(db, 's2', 'cli-2', 'cli-1');
  routed(db, 's3', 'cli-3', 'cli-gone');
  assert.deepEqual(
    chatLines(db, 'cli:dm:owner').map((line) => [line.nativeId, line.replyToId ?? null, line.replyNumber ?? null]),
    [
      ['cli-1', null, null],
      ['cli-2', 'cli-1', 1],
      ['cli-3', 'cli-gone', null],
    ]
  );
});

test("a line's number is found by its platform id when the row keeps a key of its own", (t) => {
  // Bug: her `#N` of a stored line, whose history id is the platform's, drew no number in the owner's chat.
  const { db, add } = rig(t);
  add('s1', 'seen', 'key-1', '2026-11-05T00:00:01.000Z', 'one');
  add('s2', 'said', 'key-2', '2026-11-05T00:00:02.000Z', 'two');
  routed(db, 's2', 'cli-2');
  assert.equal(lineNumberOf(db, 'cli:dm:owner', 'cli-2'), 2);
});
