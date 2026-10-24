// Export (src/memory/db/export.js) and the tool around it (tools/memory-db.mjs): the old layout comes back from the
// database alone, byte-exact where the store writes bytes, and verify says which files differ without any value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { openMemoryDb } from '../src/memory/db/open.js';
import { exportAll } from '../src/memory/db/export.js';
import { syncOnce } from '../src/memory/db/sync.js';
import { diffPaths, main } from '../tools/memory-db.mjs';
import { MEMBER, buildDataDir, guildDir, vectorMonth } from './fixtures/memory-db/datadir.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

function setup() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-export-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const dbFile = path.join(root, 'memory.db');
  const handle = openMemoryDb(dbFile);
  syncOnce(handle, data);
  handle.close();
  return { root, data, dbFile, g: guildDir(data), done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const run = (...argv) => {
  const lines = [];
  const code = main(argv, { out: (line) => lines.push(line), err: (line) => lines.push(line) });
  return { code, lines, text: lines.join('\n') };
};

test('export writes JSON as the store does, and vectors byte for byte', () => {
  const env = setup();
  try {
    const out = path.join(env.root, 'out');
    assert.equal(run('export', '--db', env.dbFile, '--to', out).code, 0);
    const exported = guildDir(out);
    for (const rel of ['users/' + MEMBER + '.json', 'guild.json', 'voice.json', 'participation.json']) {
      const text = fs.readFileSync(path.join(exported, rel), 'utf8');
      assert.equal(text, JSON.stringify(JSON.parse(text), null, 2), `${rel} is written with 2-space indent and no final newline`);
      assert.deepEqual(JSON.parse(text), JSON.parse(fs.readFileSync(path.join(env.g, rel), 'utf8')), rel);
    }
    const month = vectorMonth();
    assert.ok(fs.readFileSync(path.join(exported, 'vectors/2026-10/1.i8')).equals(month.i8));
    assert.equal(fs.readFileSync(path.join(exported, 'vectors/2026-10/1.jsonl'), 'utf8'), month.meta);
    const rebuilt = fs.readFileSync(path.join(exported, 'record/2026-10/2026-10-20.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const live = fs.readFileSync(path.join(env.g, 'record/2026-10/2026-10-20.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(rebuilt, live);
  } finally {
    env.done();
  }
});

test('operational rows are exported verbatim and a retired row is not exported', () => {
  const env = setup();
  try {
    const db = new DatabaseSync(env.dbFile);
    db.prepare("UPDATE operational SET value = ? WHERE kind = 'inner'").run(JSON.stringify({ v: 1, stopped: true, queue: [{ n: 'Καλημέρα' }] }));
    db.prepare("UPDATE sources SET retired_at = '2026-10-24T00:00:00.000Z' WHERE native_id = '400000000000000002'").run();
    db.close();
    const out = path.join(env.root, 'out');
    assert.equal(run('export', '--db', env.dbFile, '--to', out).code, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(guildDir(out), 'inner.json'), 'utf8')), { v: 1, stopped: true, queue: [{ n: 'Καλημέρα' }] });
    const lines = fs.readFileSync(path.join(guildDir(out), 'record/2026-10/2026-10-20.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.messageId), ['400000000000000001', '400000000000000001']);
  } finally {
    env.done();
  }
});

test('export refuses a directory that is not empty', () => {
  const env = setup();
  try {
    const result = run('export', '--db', env.dbFile, '--to', env.data);
    assert.equal(result.code, 2);
    assert.match(result.text, /not empty/);
  } finally {
    env.done();
  }
});

test('verify says ok for an equal layout and fails, with key paths only, for a difference', () => {
  const env = setup();
  try {
    const ok = run('verify', '--data', env.data, '--db', env.dbFile);
    assert.equal(ok.code, 0, ok.text);
    assert.match(ok.text, /verify ok/);
    const file = path.join(env.g, 'users', `${MEMBER}.json`);
    const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
    profile.character = 'A secret new character text';
    profile.details[0].weight = 99;
    fs.writeFileSync(file, JSON.stringify(profile, null, 2));
    fs.writeFileSync(path.join(env.g, 'channels', 'extra-live-only.json'), '{}');
    fs.rmSync(path.join(env.g, 'recent.json'));
    const bad = run('verify', '--data', env.data, '--db', env.dbFile);
    assert.equal(bad.code, 1);
    assert.match(bad.text, /verify FAILED/);
    assert.match(bad.text, /user\s+equal 0\s+differs 1/);
    assert.match(bad.text, /\$\.details\[0\]\.weight/);
    assert.match(bad.text, /\$\.character/);
    assert.match(bad.text, /channel\s+equal 1\s+differs 0\s+missing 1/);
    assert.match(bad.text, /recent\s+equal 0\s+differs 0\s+missing 0\s+extra 1/);
    assert.ok(!bad.text.includes('A secret new character text'), 'no value is printed');
  } finally {
    env.done();
  }
});

test('diffPaths names key paths and never values', () => {
  const paths = diffPaths({ a: { b: [1, 2] }, c: 'x', only: 1 }, { a: { b: [1, 3] }, c: 'y' });
  assert.deepEqual(paths, ['$.a.b[1] (number vs number)', '$.c (string vs string)', '$.only (only in rebuilt)']);
});

test('stats lists row counts per table with retired rows and scope kinds', () => {
  const env = setup();
  try {
    const { code, lines } = run('stats', '--db', env.dbFile);
    assert.equal(code, 0);
    const claims = lines.find((line) => line.startsWith('claims '));
    assert.match(claims, /retired \d+/);
    assert.match(claims, /scope .*group=\d+/);
    assert.ok(lines.some((line) => /^sources\s+\d+/.test(line)));
    assert.ok(lines.some((line) => /^ledger_tasks\s+0/.test(line)));
  } finally {
    env.done();
  }
});

test('ledger-import copies the ledger rows as JSON records and leaves the source alone', () => {
  const env = setup();
  try {
    const ledgerFile = path.join(env.root, 'ledger.db');
    const ledger = new DatabaseSync(ledgerFile);
    ledger.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT); INSERT INTO tasks VALUES ('t-1', 'A café task', 'done');");
    ledger.exec('CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, type TEXT); INSERT INTO events (task_id, type) VALUES (\'t-1\', \'created\');');
    ledger.close();
    const before = fs.readFileSync(ledgerFile);
    const result = run('ledger-import', '--ledger', ledgerFile, '--db', env.dbFile);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /tasks 1/);
    assert.ok(fs.readFileSync(ledgerFile).equals(before));
    const db = new DatabaseSync(env.dbFile, { readOnly: true });
    assert.deepEqual(JSON.parse(db.prepare("SELECT record FROM ledger_tasks WHERE id = 't-1'").get().record), { id: 't-1', title: 'A café task', status: 'done' });
    assert.equal(JSON.parse(db.prepare('SELECT record FROM ledger_events').get().record).type, 'created');
    db.close();
  } finally {
    env.done();
  }
});

test('an export of a database with nothing imported is empty and a bad command is a usage error', () => {
  const env = setup();
  try {
    const fresh = path.join(env.root, 'fresh.db');
    openMemoryDb(fresh).close();
    const out = path.join(env.root, 'empty-out');
    assert.equal(exportAll(openMemoryDb(fresh, { readOnly: true }), out).files, 0);
    assert.equal(run('nonsense').code, 2);
    assert.equal(run('import', '--data').code, 2);
  } finally {
    env.done();
  }
});
