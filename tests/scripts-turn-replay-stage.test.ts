// The stage of a replayed turn (scripts/lib/turn-stage.ts): the stored turn found by its id or a prefix only it has,
// and the command line chat as the core builds it with no client open, its history cut after the trigger.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { stageOf, storedTurn, triggerOf } from '../scripts/lib/turn-stage.ts';
import { freshMemoryDb } from './fixtures/memory-db-copy.ts';
import { tempDir } from './fixtures/tmp.ts';

type Db = InstanceType<typeof DatabaseSync>;

const START = Date.parse('2026-03-04T10:02:30.000Z');

/** The command line chat with three of the owner's lines a minute apart and a turn that answered the second. */
function seed(db: Db): void {
  db.prepare(
    `INSERT INTO places (id, iface, kind, native_id, scope_kind, chat, partner_account) VALUES ('cli:dm:owner', 'cli', 'dm', 'cli:dm:owner', 'dm', 'dm', 'cli:owner')`
  ).run();
  db.prepare(
    `INSERT INTO accounts (id, iface, native_id, names) VALUES ('cli:owner', 'cli', 'owner', '["Νίκος"]')`
  ).run();
  const line = db.prepare(
    `INSERT INTO sources (id, kind, iface, native_id, place_id, author_account, text, occurred_at, recorded_at, observed_at, extra)
     VALUES (?, 'seen', 'cli', ?, 'cli:dm:owner', 'cli:owner', ?, ?, ?, ?, ?)`
  );
  for (const [n, text] of [
    [1, 'Γεια'],
    [2, 'Τι νέα;'],
    [3, 'Αντίο'],
  ] as const) {
    const at = `2026-03-04T10:0${n}:00.000Z`;
    const extra = JSON.stringify({
      $messageLocator: { v: 1, iface: 'cli', chatId: 'cli:dm:owner', messageId: `live-${n}` },
    });
    line.run(`source:${n}`, `key-${n}`, text, at, at, at, extra);
  }
  const start = db.prepare(
    `INSERT INTO day (id, at, what, place_id, turn_id, scope_iface, extra) VALUES (?, ?, 'turn.start', 'cli:dm:owner', ?, 'cli', ?)`
  );
  const extra = JSON.stringify({ mode: 'reply', trigger: { kind: 'private', messageId: 'live-2', authorId: 'owner' } });
  start.run('day:1', new Date(START).toISOString(), 't-aaaa-1111', extra);
  start.run('day:2', new Date(START).toISOString(), 't-aaaa-2222', extra);
}

test('finds a stored turn by a prefix only it has and reads its trigger', () => {
  const handle = freshMemoryDb();
  seed(handle.db as Db);
  const turn = storedTurn(handle.db as Db, 't-aaaa-1');
  assert.deepEqual(
    [turn.turnId, turn.placeId, turn.iface, turn.triggerKind, turn.triggerId, turn.at],
    ['t-aaaa-1111', 'cli:dm:owner', 'cli', 'private', 'live-2', START]
  );
  handle.close();
});

test('refuses a prefix two stored turns share', () => {
  const handle = freshMemoryDb();
  seed(handle.db as Db);
  assert.throws(() => storedTurn(handle.db as Db, 't-aaaa'), /2 stored turns/);
  handle.close();
});

test('serves the command line chat up to its trigger and makes the trigger line of the history', async () => {
  const handle = freshMemoryDb();
  const db = handle.db as Db;
  seed(db);
  const turn = storedTurn(db, 't-aaaa-1111');
  const stage = stageOf({
    db,
    dataDir: tempDir('nep-stage-'),
    turn,
    selfId: 'self',
    now: () => START,
    tmpDir: tempDir('nep-stage-tmp-'),
  });
  const page = await stage.port.history(stage.chat, { limit: 10 });
  const texts = page.status === 'ok' ? page.events.map((event) => event.message.content) : [];
  assert.deepEqual(texts, ['Γεια', 'Τι νέα;']);
  const trigger = await triggerOf(stage, turn, db);
  assert.equal(trigger.content, 'Τι νέα;');
  handle.close();
});

test('serves a place of another interface from its stored lines written before the turn', async () => {
  const handle = freshMemoryDb();
  const db = handle.db as Db;
  seed(db);
  db.prepare(
    `INSERT INTO places (id, iface, kind, native_id, scope_kind, chat) VALUES ('discord:channel:900', 'discord', 'channel', '900', 'group', 'group')`
  ).run();
  const line = db.prepare(
    `INSERT INTO sources (id, kind, iface, native_id, place_id, text, occurred_at, recorded_at, observed_at)
     VALUES (?, 'said', 'discord', ?, 'discord:channel:900', ?, ?, ?, ?)`
  );
  for (const [id, text, at] of [
    ['9001', 'Πρώτο', '2026-03-04T09:00:00.000Z'],
    ['9002', 'Δεύτερο', '2026-03-04T10:00:00.000Z'],
    ['9003', 'Μετά', '2026-03-04T11:00:00.000Z'],
  ] as const)
    line.run(`source:d${id}`, id, text, at, at, at);
  const turn = storedTurn(db, 't-aaaa-1111');
  const stage = stageOf({
    db,
    dataDir: tempDir('nep-stage-'),
    turn,
    selfId: 'self',
    now: () => START,
    tmpDir: tempDir('nep-stage-tmp-'),
  });
  const page = await stage.port.history({ iface: 'discord', chatId: '900' }, { limit: 10 });
  assert.equal(page.status, 'ok');
  const texts = page.status === 'ok' ? page.events.map(({ message }) => message.content) : [];
  assert.deepEqual(texts, ['Πρώτο', 'Δεύτερο']);
  handle.close();
});
