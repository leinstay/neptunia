// `/memory bind <iface> <account> <person>` from the owner's line to the memory service (plan 2026-11-08-meta-person,
// slice 6): the console names the account by its interface and platform id, names `owner` by `bot.ownerPerson`, and
// before a merge asks one Y/n through the dialog that names the person it removes. A synthetic database and a recording
// memory service. The bind itself is tested in tests/memory-db-person-bind.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createConsole } from '../src/interface/commands/console.ts';
import type { Answer, ConsoleDeps } from '../src/interface/commands/console.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import type { Dialog } from '../src/keys/commands.ts';
import type { BindConfirm, BindInput, BindResult } from '../src/memory/db/person-bind.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { addAccount } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const OWNER = 'person:0a1b-owner';
const REMOVED = { id: 'person:3c9d-other', name: 'Dima' };
const INTO = { id: 'person:7a1e-target', name: 'Mira' };

type Bind = { input: BindInput; confirmed: boolean | null };
type Rig = { binds: Array<Bind>; asked: Array<string>; say: (line: string, answer: string | null) => Promise<Answer> };

/** A console over a database holding one account, with a service that asks its confirmation when it is given one. */
async function withConsole(body: (rig: Rig) => Promise<void>): Promise<void> {
  const dir = tempDir('nep-commands-bind-');
  const handle = openMemoryDb(path.join(dir, 'memory.db'));
  addAccount(dbOf(handle), {
    id: 'account:t1',
    iface: 'telegram',
    authority: 'telegram/global',
    native: 't1',
    person: null,
  });
  const binds: Array<Bind> = [];
  const asked: Array<string> = [];
  const memoryDb = {
    database: () => dbOf(handle),
    personBind: async (input: BindInput, confirm: BindConfirm | null): Promise<BindResult> => {
      const confirmed = confirm === null ? null : await confirm({ removed: REMOVED, into: INTO });
      binds.push({ input, confirmed });
      if (confirmed === null) return { status: 'unconfirmed', removed: REMOVED.id };
      return confirmed
        ? { status: 'merged', person: input.personId, removed: REMOVED.id }
        : { status: 'declined', removed: REMOVED.id };
    },
  };
  const deps: ConsoleDeps = {
    runOp: () => Promise.resolve({ status: 'failed', code: 'NOT_HERE', summary: '', data: null }),
    ownerReads: { lessons: () => '' },
    places: () => [],
    selfId: () => null,
    hot: { config: { bot: { ownerPerson: OWNER } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb,
    usage: null,
    metrics: { samples: () => [] },
    chatLines: () => [],
    now: () => Date.parse('2026-11-08T12:00:00Z'),
  };
  const desk = createConsole(deps);
  const say = (line: string, answer: string | null): Promise<Answer> => {
    const parsed = parseCommandLine(line);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
    const dialog: Dialog | null =
      answer === null
        ? null
        : {
            ask: (question) => {
              asked.push(question);
              return Promise.resolve(answer);
            },
          };
    return desk.run(parsed.name, parsed.args, { id: 'owner' }, dialog);
  };
  try {
    await body({ binds, asked, say });
  } finally {
    handle.close();
  }
}

test('a merge asks one Y/n that names the id and the name of the person it removes', async () => {
  // Bug: the question names only the target, or no question is asked and two people merge on the command alone.
  await withConsole(async ({ binds, asked, say }) => {
    const answer = await say(`/memory bind telegram t1 ${INTO.id}`, '');
    assert.equal(asked.length, 1);
    assert.ok(asked[0]?.includes(REMOVED.id) && asked[0]?.includes(REMOVED.name), asked[0]);
    assert.ok(asked[0]?.includes('Y/n'), asked[0]);
    assert.deepEqual(binds, [{ input: { accountId: 'account:t1', personId: INTO.id }, confirmed: true }]);
    assert.equal(answer.status, 'ok');
  });
});

test('an answer n declines the merge', async () => {
  // Bug: any answer counts as yes, so the owner cannot step back from a merge he did not mean.
  await withConsole(async ({ binds, say }) => {
    const answer = await say(`/memory bind telegram t1 ${INTO.id}`, 'n');
    assert.equal(binds[0]?.confirmed, false);
    assert.equal(answer.status, 'ok');
    assert.ok(answer.text.includes(REMOVED.id), answer.text);
  });
});

test('owner as the target names the meta-person of bot.ownerPerson', async () => {
  // Bug: the word `owner` is sent as a person id, or the account's own person is made the owner instead.
  await withConsole(async ({ binds, say }) => {
    await say('/memory bind telegram t1 owner', 'y');
    const [first] = binds;
    assert.equal(first?.input.personId, OWNER);
  });
});

test('a merge with no dialog is refused and says to run it in the chat', async () => {
  // Bug: `neptunia -p` merges two people with nobody asked.
  await withConsole(async ({ binds, say }) => {
    const answer = await say(`/memory bind telegram t1 ${INTO.id}`, null);
    assert.equal(binds[0]?.confirmed, null);
    assert.equal(answer.status, 'invalid');
  });
});

test('an account she has not met is refused before the service is asked', async () => {
  // Bug: a typo in the platform id creates a bind for an account nobody stored.
  await withConsole(async ({ binds, say }) => {
    const answer = await say(`/memory bind telegram nobody ${INTO.id}`, 'y');
    assert.equal(answer.status, 'invalid');
    assert.deepEqual(binds, []);
  });
});
