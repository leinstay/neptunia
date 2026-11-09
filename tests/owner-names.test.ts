// Her aliases are the names the owner gives her own person record, `person:self`, with `/memory users names add|remove`.
// The door reads only those: a name her memory session or the analyzer writes about her has another `author` and never
// widens it. The writer's `owner-name` op, the reader `ownerNamesOf` and the command over a person, together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createConsole } from '../src/interface/commands/console.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { ownerNamesOf, personDetail } from '../src/memory/db/people-read.ts';
import type { Db } from '../src/memory/db/types.ts';
import { internalContext } from '../src/memory/db/scope.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';

const dbOf = (memoryDb: { readHandle(): unknown }): Db => (memoryDb.readHandle() as { db: Db }).db;

/** A console over the test memory, for the owner's command lines. */
function consoleOver(memoryDb: unknown) {
  const dir = tempDir('nep-owner-names-');
  const desk = createConsole({
    runOp: () => Promise.reject(new Error('a name on a person runs no operation')),
    ownerReads: { lessons: () => '' },
    places: () => [],
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => Date.now(),
  });
  return async (line: string) => {
    const parsed = parseCommandLine(line);
    assert.ok(parsed.ok, line);
    return desk.run(parsed.name, parsed.args, { id: 'owner-1' });
  };
}

test('the owner adds a name to person:self by the command, and her names show it', async () => {
  // Bug: the command takes only an account, so her own record cannot be given a name.
  const { memoryDb, close } = await openTestMemory();
  try {
    const run = consoleOver(memoryDb);
    assert.equal((await run('/memory users names add person:self Zefira')).status, 'ok');
    assert.deepEqual(ownerNamesOf(dbOf(memoryDb), 'person:self'), ['Zefira']);
    const view = personDetail(dbOf(memoryDb), 'person:self', internalContext());
    assert.ok(view.found && view.names.includes('Zefira'));
  } finally {
    await close();
  }
});

test('the owner removes a name, and adding the same name twice keeps one', async () => {
  // Bug: a repeated add doubles the alias, or a remove leaves it behind.
  const { memoryDb, close } = await openTestMemory();
  try {
    const run = consoleOver(memoryDb);
    await run('/memory users names add person:self Zefira');
    await run('/memory users names add person:self zefira');
    assert.deepEqual(ownerNamesOf(dbOf(memoryDb), 'person:self'), ['Zefira']);
    await run('/memory users names remove person:self ZEFIRA');
    assert.deepEqual(ownerNamesOf(dbOf(memoryDb), 'person:self'), []);
  } finally {
    await close();
  }
});

test('a name for a person no row holds is not written as an owner name', async () => {
  // Bug: any word that starts with `person:` passes as a person, and the name lands on a subject nobody has.
  const { memoryDb, close } = await openTestMemory();
  try {
    const run = consoleOver(memoryDb);
    // The word is no stored person, so the command goes on to the account operation, which this console refuses.
    await run('/memory users names add person:nobody Zefira').catch(() => null);
    assert.deepEqual(ownerNamesOf(dbOf(memoryDb), 'person:nobody'), []);
  } finally {
    await close();
  }
});

test('a name her memory session wrote about her is not one of the owner names', async () => {
  // Bug: whatever someone called her in chat becomes a gate that sends lines to the classifier.
  const { memoryDb, dataDir, close } = await openTestMemory();
  try {
    await consoleOver(memoryDb)('/memory users names add person:self Zefira');
    const other = new DatabaseSync(path.join(dataDir, 'memory.db'));
    other
      .prepare(
        "INSERT INTO claims (id, subject_kind, subject_id, kind, text, author, how, created_at) VALUES ('c-session', 'person', 'person:self', 'alias', 'Bot', 'session', 'session', '2026-11-05')"
      )
      .run();
    other.close();
    assert.deepEqual(ownerNamesOf(dbOf(memoryDb), 'person:self'), ['Zefira']);
  } finally {
    await close();
  }
});
