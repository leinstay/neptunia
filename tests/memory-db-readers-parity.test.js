// The reader-parity command of tools/memory-db.mjs: the memory modules' reads from the files and from the database
// over one frozen snapshot, compared function by function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../tools/memory-db.mjs';
import { GUILD, readerEnv } from './fixtures/memory-db/readers.js';
import { seen } from './fixtures/memory-db/datadir.js';

const FUNCTIONS = [
  'archive.find', 'archive.iterate', 'intentions.archived', 'intentions.get', 'intentions.list', 'journal.findTurn', 'journal.pending',
  'journal.read', 'journal.timeline', 'journal.turnOperations', 'record.iterate', 'record.newestRevision', 'tasks.costs', 'tasks.get',
  'tasks.open', 'tasks.recent', 'vectors.has', 'vectors.search', 'vectors.stats',
];

async function run(args) {
  const lines = [];
  const code = await main(args, { out: (line) => lines.push(line), err: (line) => lines.push(line) });
  return { code, text: lines.join('\n'), lines };
}

test('reader-parity: every read of the fixture is equal both ways, 100 %', async () => {
  const env = await readerEnv();
  try {
    const { code, text, lines } = await run(['reader-parity', '--data', env.data, '--db', env.dbFile, '--days', '5']);
    assert.equal(code, 0, text);
    assert.match(text, /reader parity ok/);
    for (const fn of FUNCTIONS) {
      const line = lines.find((entry) => entry.startsWith(`${fn} `));
      assert.ok(line, `${fn} compared`);
      const [, compared, equal, differ] = /compared (\d+) {2}equal (\d+) {2}differ (\d+)/.exec(line).map(Number);
      assert.ok(compared > 0 && equal === compared && differ === 0, line);
    }
  } finally { env.done(); }
});

test('reader-parity: a file changed after the import is a difference, named by key path only, exit 1', async () => {
  const env = await readerEnv();
  try {
    const day = path.join(env.data, 'guilds', GUILD, 'record', '2026-10', '2026-10-21.jsonl');
    fs.appendFileSync(day, `${JSON.stringify(seen('400000000000000031', 1, 'a secret late line', { occurredAt: '2026-10-21T09:00:00.000Z' }))}\n`);
    const { code, text } = await run(['reader-parity', '--data', env.data, '--db', env.dbFile]);
    assert.equal(code, 1);
    assert.match(text, /record\.iterate +compared \d+ {2}equal \d+ {2}differ [1-9]/);
    assert.match(text, /reader parity FAILED/);
    assert.doesNotMatch(text, /secret late line/);
  } finally { env.done(); }
});

test('reader-parity: refuses a database a live process holds unless --live, and a bad --days', async () => {
  const env = await readerEnv();
  try {
    fs.writeFileSync(`${env.dbFile}.lock`, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const refused = await run(['reader-parity', '--data', env.data, '--db', env.dbFile]);
    assert.equal(refused.code, 2);
    assert.match(refused.text, /live process/);
    assert.equal((await run(['reader-parity', '--data', env.data, '--db', env.dbFile, '--live'])).code, 0);
    fs.rmSync(`${env.dbFile}.lock`);
    assert.equal((await run(['reader-parity', '--data', env.data, '--db', env.dbFile, '--days', '0'])).code, 2);
  } finally { env.done(); }
});
