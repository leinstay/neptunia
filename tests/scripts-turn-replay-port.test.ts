// The interface a replayed turn talks to (scripts/lib/turn-port.ts): its history is the stored lines of the copy up to
// the line that started the turn, and every write it is asked for is kept in a list and answered as delivered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { recordingPort, storedChatPort, storedLines, storedReactions } from '../scripts/lib/turn-port.ts';
import { freshMemoryDb } from './fixtures/memory-db-copy.ts';

type Db = InstanceType<typeof DatabaseSync>;

const PLACE = 'fake:channel:1';

/** Three lines of one channel, a minute apart, each with its platform id in its locator. */
function seed(db: Db): void {
  db.prepare(
    `INSERT INTO accounts (id, iface, native_id, names) VALUES ('fake:member-1', 'fake', 'member-1', '["Ελένη"]')`
  ).run();
  const line = db.prepare(
    `INSERT INTO sources (id, kind, iface, native_id, place_id, author_account, text, occurred_at, recorded_at, observed_at, extra)
     VALUES (?, 'seen', 'fake', ?, ?, 'fake:member-1', ?, ?, ?, ?, ?)`
  );
  for (const [n, text] of [
    [1, 'Γεια'],
    [2, 'Τι κάνεις;'],
    [3, 'Καληνύχτα'],
  ] as const) {
    const at = `2026-03-04T10:0${n}:00.000Z`;
    const extra = JSON.stringify({ $messageLocator: { v: 1, iface: 'fake', chatId: '1', messageId: `p-${n}` } });
    line.run(`src:${n}`, `key-${n}`, PLACE, text, at, at, at, extra);
  }
}

test('serves the stored lines up to the line that started the turn and none after it', () => {
  const handle = freshMemoryDb();
  seed(handle.db as Db);
  const lines = storedLines(handle.db as Db, { placeId: PLACE, through: 'p-2' });
  assert.deepEqual(
    lines.map((line) => line.messageId),
    ['p-1', 'p-2']
  );
  handle.close();
});

test('answers the history read of a seeded chat with those lines as message events', async () => {
  const handle = freshMemoryDb();
  seed(handle.db as Db);
  const port = storedChatPort({
    db: handle.db as Db,
    iface: 'fake',
    selfId: 'self',
    chat: { id: '1', kind: 'channel', name: 'γενικό', rootId: 'root-1', topic: null },
    placeId: PLACE,
    through: 'p-2',
  });
  const page = await port.history({ iface: 'fake', chatId: '1' }, { limit: 10 });
  assert.equal(page.status, 'ok');
  const events = page.status === 'ok' ? page.events : [];
  assert.deepEqual(
    events.map((event) => [event.message.id, event.message.content, event.message.author?.name]),
    [
      ['p-1', 'Γεια', 'Ελένη'],
      ['p-2', 'Τι κάνεις;', 'Ελένη'],
    ]
  );
  handle.close();
});

// Regression: the live history of a turn also held the lines written after its trigger and before the turn started
// (her reply of the turn before), and a replay cut at the trigger lost them.
test('serves a line written after the trigger when it was stored before the turn started', () => {
  const handle = freshMemoryDb();
  seed(handle.db as Db);
  const lines = storedLines(handle.db as Db, {
    placeId: PLACE,
    through: 'p-1',
    until: Date.parse('2026-03-04T10:02:30.000Z'),
  });
  assert.deepEqual(
    lines.map((line) => line.messageId),
    ['p-1', 'p-2']
  );
  handle.close();
});

test('marks a line whose current text is a later revision as edited at that revision', () => {
  const handle = freshMemoryDb();
  const db = handle.db as Db;
  seed(db);
  db.prepare(
    `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, text, occurred_at, recorded_at, observed_at, extra)
     SELECT 'src:2b', 'seen', iface, native_id, 2, place_id, author_account, 'Τι κάνεις, φίλε;', occurred_at,
       '2026-03-04T10:05:00.000Z', '2026-03-04T10:05:00.000Z', extra FROM sources WHERE id = 'src:2'`
  ).run();
  const [, second] = storedLines(db, { placeId: PLACE, through: 'p-2' });
  assert.equal(second.text, 'Τι κάνεις, φίλε;');
  assert.equal(second.editedAt, Date.parse('2026-03-04T10:05:00.000Z'));
  handle.close();
});

test('rebuilds the reactions on a line from the stored reaction events, a removed one gone', () => {
  const handle = freshMemoryDb();
  const db = handle.db as Db;
  const event = db.prepare(
    `INSERT INTO ingest (principal, seq, event_id, kind, conversation, committed_at) VALUES ('fake', ?, ?, 'reaction.changed', '1', ?)`
  );
  event.run(1, 'fake:reaction:p-1:member-1:👍:add:1', '2026-03-04T10:01:10.000Z');
  event.run(2, 'fake:reaction:p-1:self:👍:add:2', '2026-03-04T10:01:20.000Z');
  event.run(3, 'fake:reaction:p-1:member-2:900:add:3', '2026-03-04T10:01:30.000Z');
  event.run(4, 'fake:reaction:p-1:member-1:👍:remove:4', '2026-03-04T10:01:40.000Z');
  const reactions = storedReactions(db, {
    iface: 'fake',
    chatId: '1',
    selfId: 'self',
    emojiName: (id) => (id === '900' ? 'γάτα' : null),
  });
  assert.deepEqual(reactions.get('p-1'), [
    { emoji: '👍', count: 1, mine: true, accounts: ['self'] },
    { emoji: ':γάτα:', count: 1, mine: false, accounts: ['member-2'] },
  ]);
  handle.close();
});

test('refuses a turn whose line the place does not hold', () => {
  const handle = freshMemoryDb();
  seed(handle.db as Db);
  assert.throws(() => storedLines(handle.db as Db, { placeId: PLACE, through: 'p-9' }), /p-9/);
  handle.close();
});

test('keeps a send and a reaction as writes, answers them delivered and sends nothing', async () => {
  const inner = createFakeAdapter({ iface: 'fake' });
  const { port, writes } = recordingPort(inner, () => 1_000);
  const delivery = await port.send({ iface: 'fake', chatId: '1' }, { text: 'Γεια σου' }, { idempotencyKey: 'k-1' });
  const reacted = await port.react({ iface: 'fake', chatId: '1', messageId: 'p-1' }, '👍');
  assert.equal(delivery.status, 'ok');
  assert.equal(reacted.status, 'ok');
  assert.deepEqual(
    writes.map((write) => write.op),
    ['send', 'react']
  );
  assert.equal(inner.calls.length, 0);
});

test('lets a read through to the interface beneath', async () => {
  const inner = createFakeAdapter({ iface: 'fake' });
  const { port, writes } = recordingPort(inner, () => 1_000);
  await port.chatInfo({ iface: 'fake', chatId: '1' });
  assert.deepEqual(
    inner.calls.map((call) => call.op),
    ['chatInfo']
  );
  assert.equal(writes.length, 0);
});
