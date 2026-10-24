// The parity command of tools/memory-db.mjs: every store read from the JSON files and through the database, compared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../tools/memory-db.mjs';
import { MEMBER, buildDataDir, guildDir, writeJson } from './fixtures/memory-db/datadir.js';

function env() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-parity-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const lines = [];
  const io = { out: (line) => lines.push(line), err: (line) => lines.push(line) };
  return { root, data, db: path.join(root, 'memory.db'), lines, io, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('parity: after an import every read is equal and served by the database', () => {
  const e = env();
  try {
    assert.equal(main(['import', '--data', e.data, '--db', e.db], e.io), 0);
    e.lines.length = 0;
    assert.equal(main(['parity', '--data', e.data, '--db', e.db], e.io), 0);
    assert.match(e.lines.join('\n'), /differ 0/);
    assert.match(e.lines.join('\n'), /parity ok/);
    const served = Number(/from the database (\d+)/.exec(e.lines.join('\n'))[1]);
    assert.ok(served > 0, 'the database served files');
  } finally { e.done(); }
});

test('parity: a file changed after the last sync is read from the disk and counted stale, still equal', () => {
  const e = env();
  try {
    assert.equal(main(['import', '--data', e.data, '--db', e.db], e.io), 0);
    const file = path.join(guildDir(e.data), 'users', `${MEMBER}.json`);
    const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
    profile.names = ['Changed'];
    writeJson(file, profile);
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    e.lines.length = 0;
    assert.equal(main(['parity', '--data', e.data, '--db', e.db], e.io), 0);
    assert.match(e.lines.join('\n'), /stale [1-9]/);
  } finally { e.done(); }
});
