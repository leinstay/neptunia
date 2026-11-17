// The stored texts outside `sources` that the rewrite to stable names covers (src/memory/db/stable-names-texts.ts),
// planned by `planStableNamesRewrite` and applied by the write kind `stable-names-rewrite` in its one transaction: a known
// emoji name becomes its stable name, raw platform markup becomes the stable name of its id, and a structured emoji field
// takes the bare stable name. Synthetic ids and names over a temp database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { applyMediaNamesWrite } from '../src/memory/db/media-names.ts';
import { planStableNamesRewrite } from '../src/memory/db/stable-names-rewrite.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../src/memory/db/types.ts';

const T0 = Date.parse('2026-11-17T10:00:00Z');

function openTemp(): { handle: MemoryHandle; db: Db } {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'stable-names-texts-'));
  const handle = openMemoryDb(path.join(root, 'memory.db'));
  return { handle, db: dbOf(handle) };
}

/** A known custom emoji: its media row under the platform name `pog`, platform id 901. */
function pog(db: Db): void {
  const extra = JSON.stringify({ name: 'pog', animated: false });
  const insert = db.prepare(
    "INSERT INTO media (id, kind, native_ref, extra, scope_iface) VALUES ('m1', 'emoji', '901', ?, 'fake')"
  );
  insert.run(extra);
}

function rewrite(handle: MemoryHandle, db: Db): void {
  applyMemoryWrite(handle, { kind: 'stable-names-rewrite', ...planStableNamesRewrite(db), now: T0 });
}

/** One column of one row, found by its id. */
function cell(db: Db, table: string, column: string, id: string): unknown {
  return db.prepare(`SELECT ${column} AS value FROM ${table} WHERE id = ?`).get(id)?.value;
}

/** The `extra` of one row as an object. */
function extraOf(db: Db, table: string, id: string): Row {
  const value: unknown = JSON.parse(String(cell(db, table, 'extra', id)));
  return value !== null && typeof value === 'object' ? { ...value } : {};
}

function fieldOf(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? Object.entries(value).find(([name]) => name === key)?.[1] : null;
}

/** The stable name, platform name and animated flag `media_names` binds to a platform id. */
function boundOf(db: Db, nativeId: string): Array<unknown> {
  const row = db.prepare('SELECT name, platform_name, animated FROM media_names WHERE native_id = ?').get(nativeId);
  return row ? [row.name, row.platform_name, row.animated] : [];
}

test('rewrites a known emoji name in the text of a claim', () => {
  const { handle, db } = openTemp();
  pog(db);
  db.prepare("INSERT INTO claims (id, kind, text, scope_iface) VALUES ('c1', 'detail', 'loves :pog:', 'fake')").run();
  rewrite(handle, db);
  assert.equal(cell(db, 'claims', 'text', 'c1'), 'loves :e1:');
});

test('rewrites the text of a claim version and the raw markup in its extra by the emoji id', () => {
  const { handle, db } = openTemp();
  pog(db);
  const extra = JSON.stringify({ note: 'was <:pog:901>' });
  db.prepare("INSERT INTO claim_versions (id, claim_id, text, extra) VALUES ('v1', 'c1', ':pog: fan', ?)").run(extra);
  rewrite(handle, db);
  assert.equal(cell(db, 'claim_versions', 'text', 'v1'), ':e1: fan');
  assert.equal(extraOf(db, 'claim_versions', 'v1').note, 'was :e1:');
});

test('rewrites the text and the extra of a description version', () => {
  const { handle, db } = openTemp();
  pog(db);
  const extra = JSON.stringify({ reason: 'posts :pog: a lot' });
  const insert = db.prepare(
    "INSERT INTO description_versions (id, description_id, text, extra) VALUES ('d1', 'desc1', 'a :pog: person', ?)"
  );
  insert.run(extra);
  rewrite(handle, db);
  assert.equal(cell(db, 'description_versions', 'text', 'd1'), 'a :e1: person');
  assert.equal(extraOf(db, 'description_versions', 'd1').reason, 'posts :e1: a lot');
});

test('rewrites what, quote, feeling and extra of an episode', () => {
  const { handle, db } = openTemp();
  pog(db);
  const insert = db.prepare(
    `INSERT INTO episodes (id, kind, what, quote, feeling, extra, scope_iface)
     VALUES ('ep1', 'profile', 'sent :pog:', 'just :pog:', 'glad :pog:', ?, 'fake')`
  );
  insert.run(JSON.stringify({ summary: 'a night of :pog:' }));
  rewrite(handle, db);
  const row = db.prepare("SELECT what, quote, feeling FROM episodes WHERE id = 'ep1'").get();
  assert.deepEqual([row?.what, row?.quote, row?.feeling], ['sent :e1:', 'just :e1:', 'glad :e1:']);
  assert.equal(extraOf(db, 'episodes', 'ep1').summary, 'a night of :e1:');
});

test('rewrites the reason of an affinity event', () => {
  const { handle, db } = openTemp();
  pog(db);
  db.prepare(
    "INSERT INTO affinity_events (id, reason, scope_iface) VALUES ('af1', 'answered with :pog:', 'fake')"
  ).run();
  rewrite(handle, db);
  assert.equal(cell(db, 'affinity_events', 'reason', 'af1'), 'answered with :e1:');
});

test('rewrites the reason and the extra of a decision', () => {
  const { handle, db } = openTemp();
  pog(db);
  const extra = JSON.stringify({ note: 'kept :pog:' });
  db.prepare("INSERT INTO decisions (id, reason, extra) VALUES ('dc1', 'liked :pog:', ?)").run(extra);
  rewrite(handle, db);
  assert.equal(cell(db, 'decisions', 'reason', 'dc1'), 'liked :e1:');
  assert.equal(extraOf(db, 'decisions', 'dc1').note, 'kept :e1:');
});

test('rewrites the emoji fields of a journal action: a bare name to a bare name, a token and raw markup to a token', () => {
  const { handle, db } = openTemp();
  pog(db);
  const extra = JSON.stringify({
    input: { to: 'msg-1', emoji: 'pog' },
    result: { emoji: '<:pog:901>' },
    intent: { text: 'react with :pog:' },
  });
  db.prepare("INSERT INTO day (id, what, extra, scope_iface) VALUES ('j1', 'action', ?, 'fake')").run(extra);
  rewrite(handle, db);
  const stored = extraOf(db, 'day', 'j1');
  const emojiFields = [fieldOf(stored.input, 'emoji'), fieldOf(stored.result, 'emoji')];
  assert.deepEqual(emojiFields, ['e1', ':e1:']);
  assert.equal(fieldOf(stored.intent, 'text'), 'react with :e1:');
});

test('rewrites the emoji of each reaction of a journal turn', () => {
  const { handle, db } = openTemp();
  pog(db);
  const extra = JSON.stringify({ reactions: [{ to: 1, emoji: ':pog:' }] });
  db.prepare("INSERT INTO day (id, what, extra, scope_iface) VALUES ('j2', 'turn', ?, 'fake')").run(extra);
  rewrite(handle, db);
  const reactions = extraOf(db, 'day', 'j2').reactions;
  const first: unknown = Array.isArray(reactions) ? reactions[0] : null;
  assert.equal(fieldOf(first, 'emoji'), ':e1:');
});

test('rewrites raw markup of an emoji nothing stores in a diary entry and issues its name by the id', () => {
  const { handle, db } = openTemp();
  db.prepare("INSERT INTO diary (id, text, scope_iface) VALUES ('dy1', 'today <:blush:931> happened', 'fake')").run();
  rewrite(handle, db);
  assert.equal(cell(db, 'diary', 'text', 'dy1'), 'today :e1: happened');
  assert.deepEqual(boundOf(db, '931'), ['e1', 'blush', 0]);
});

// A rendered publication is the text as it was sent to the platform, in the platform's own markup, and the trigger
// `publications_content_fixed` guards it. Its markup is the outbound form, not an old format: the rewrite leaves it.
test('leaves a rendered publication byte for byte and keeps the trigger that guards it', () => {
  const { handle, db } = openTemp();
  const insert = db.prepare(
    `INSERT INTO publications (id, row_kind, row_id, content_hash, rendered, status, idempotency_key, created_at)
     VALUES ('pb1', 'diary', 'dy1', 'h1', 'out now <a:dance:907> :pog:', 'sent', 'k1', '2026-11-01T00:00:00Z')`
  );
  insert.run();
  pog(db);
  const before = db.prepare("SELECT * FROM publications WHERE id = 'pb1'").get();
  rewrite(handle, db);
  assert.deepEqual(db.prepare("SELECT * FROM publications WHERE id = 'pb1'").get(), before);
  const trigger = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?");
  assert.equal(trigger.get('publications_content_fixed')?.name, 'publications_content_fixed');
});

test('names raw markup by its id and never by the name it spells', () => {
  const { handle, db } = openTemp();
  const row = { name: 'e7', kind: 'emoji', iface: 'fake', nativeId: '901', platformName: 'pog', animated: false };
  applyMediaNamesWrite(handle, { rows: [row], now: T0 });
  db.prepare(
    "INSERT INTO claims (id, kind, text, scope_iface) VALUES ('c1', 'detail', 'was <:renamed:901>', 'fake')"
  ).run();
  rewrite(handle, db);
  assert.equal(cell(db, 'claims', 'text', 'c1'), 'was :e7:');
});

test('rewrites a known emoji name in the topic of a place', () => {
  const { handle, db } = openTemp();
  pog(db);
  db.prepare("INSERT INTO places (id, iface, kind, topic) VALUES ('p1', 'fake', 'channel', 'only :pog: here')").run();
  rewrite(handle, db);
  assert.equal(cell(db, 'places', 'topic', 'p1'), 'only :e1: here');
});

test('renames the platform-name keys of the emoji rails to stable names and keeps their times', () => {
  const { handle, db } = openTemp();
  pog(db);
  const value = JSON.stringify({ repliesSince: 2, lastUsed: { pog: 1000 } });
  db.prepare("INSERT INTO operational (kind, owner, value) VALUES ('emoji_rails', 'p1', ?)").run(value);
  rewrite(handle, db);
  const stored = db.prepare("SELECT value FROM operational WHERE kind = 'emoji_rails' AND owner = 'p1'").get()?.value;
  const rails: unknown = JSON.parse(String(stored));
  assert.deepEqual(fieldOf(rails, 'lastUsed'), { e1: 1000 });
});

test('writes nothing when a claim of the plan no longer holds the text it was planned from', () => {
  const { handle, db } = openTemp();
  pog(db);
  db.prepare("INSERT INTO sources (id, kind, iface, text) VALUES ('l1', 'seen', 'fake', ':pog: first')").run();
  db.prepare("INSERT INTO claims (id, kind, text, scope_iface) VALUES ('c1', 'detail', 'loves :pog:', 'fake')").run();
  const plan = planStableNamesRewrite(db);
  db.prepare("UPDATE claims SET text = 'loves :pog: a lot' WHERE id = 'c1'").run();
  const write = (): unknown => applyMemoryWrite(handle, { kind: 'stable-names-rewrite', ...plan, now: T0 });
  assert.throws(write, { code: 'STABLE_NAMES_STALE' });
  assert.equal(cell(db, 'sources', 'text', 'l1'), ':pog: first');
  assert.equal(cell(db, 'media', "json_extract(extra, '$.name')", 'm1'), 'pog');
});
