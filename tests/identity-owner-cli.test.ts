// The owner's command line belongs to the owner: only the `cli` principal speaks as `iface: 'cli'`, so its account is his
// from the first line, on an install nobody prepared. Each test runs the real core and the real `neptunia` command over
// fresh folders, because the link spans the observation, the writer and the setting. Synthetic ids only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { withIface } from '../src/memory/db/current-iface.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { observe } from '../src/memory/db/observe.ts';
import { accountNodeOf } from '../src/memory/db/person-links.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { nativeAuthorityOf } from '../src/protocol/identity.ts';
import { isOwnerId } from '../src/tools/operations/grants.ts';
import { query, runCli, spawnCli, startUnitsCore, until, withRig } from './fixtures/core-units.ts';
import type { Dirs, Rig } from './fixtures/core-units.ts';
import { addAccount } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const OWNER = 'person:0wner-synthetic';
const STALE = 'person:d0ub1e-synthetic';

const configOf = (dirs: Dirs): { bot: { ownerPerson: string } } =>
  JSON.parse(readFileSync(path.join(dirs.privateDir, 'config', 'config.json'), 'utf8')) as {
    bot: { ownerPerson: string };
  };

const cliAccount = (dirs: Dirs) =>
  query(dirs, "SELECT id, person_id, link FROM accounts WHERE iface = 'cli' AND native_key = 'owner'")[0];

/** The owner types one line in his chat; returns once the line is stored. */
async function firstLine({ dirs, clis }: Pick<Rig, 'dirs' | 'clis'>): Promise<void> {
  const chat = spawnCli(dirs, []);
  clis.push(chat);
  chat.type('the first line of a new install');
  await until(
    () => query(dirs, "SELECT 1 FROM sources WHERE iface = 'cli' AND kind = 'seen'").length > 0,
    () => chat.stderr()
  );
}

const ownerOn = (iface: string, native: string, config: object): boolean =>
  withIface(iface, () => isOwnerId(config, native));

test('on a raw install the first line of the command line makes the owner person, and the line already sits under it', async () => {
  // Bug: `neptunia setup` provisions a client and nothing else, so the owner stays a stranger on his own chat, she gives
  // him a tracked person of her own, and his facts split between the chat and every other interface.
  await withRig({}, async ({ dirs, llm, clis, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    await firstLine({ dirs, clis });
    const account = cliAccount(dirs);
    assert.match(String(account?.person_id), /^person:/, 'the account has a person from its first line');
    assert.equal(account?.link, 'verified');
    assert.deepEqual(
      query(dirs, 'SELECT partner_person FROM places WHERE partner_account = ?', account?.id),
      [{ partner_person: account?.person_id }],
      'the DM of the chat names him as well'
    );
    assert.deepEqual(
      query(dirs, "SELECT scope_dm FROM sources WHERE iface = 'cli' AND kind = 'seen'"),
      [{ scope_dm: account?.person_id }],
      'the first line itself is scoped to his person'
    );
    await until(() => configOf(dirs).bot.ownerPerson === account?.person_id, 'bot.ownerPerson names him');
    assert.equal(ownerOn('cli', 'owner', configOf(dirs)), true);
  });
});

test('with an owner person set, the first line of the command line joins it and creates nobody', async () => {
  // Bug: an install whose owner was bound on another interface first ends up with two of him.
  await withRig({ config: { bot: { ownerPerson: OWNER } } }, async ({ dirs, llm, clis, cores }) => {
    const seed = openMemoryDb(path.join(dirs.dataDir, 'memory.db'));
    addAccount(dbOf(seed), { id: 'fake:u1', iface: 'fake', authority: 'fake/global', native: 'u1', person: OWNER });
    seed.close();
    cores.push(await startUnitsCore(dirs, llm));
    const before = query(dirs, "SELECT id FROM people WHERE id <> 'person:self'");
    await firstLine({ dirs, clis });
    assert.equal(cliAccount(dirs)?.person_id, OWNER);
    assert.deepEqual(query(dirs, "SELECT id FROM people WHERE id <> 'person:self'"), before);
    assert.equal(ownerOn('cli', 'owner', configOf(dirs)), true);
    assert.equal(ownerOn('fake', 'u1', configOf(dirs)), true);
  });
});

test('a proposal of hers for the command line resolves to the owner at the next line', async () => {
  // Bug: an install that already ran has the tracked person she made for the owner, and that proposal stands for good.
  await withRig({ config: { bot: { ownerPerson: OWNER } } }, async ({ dirs, llm, clis, cores }) => {
    const seed = openMemoryDb(path.join(dirs.dataDir, 'memory.db'));
    const db = dbOf(seed);
    addAccount(db, { id: 'fake:u1', iface: 'fake', authority: 'fake/global', native: 'u1', person: OWNER });
    addAccount(db, {
      id: 'cli:owner',
      iface: 'cli',
      authority: 'cli/global',
      native: 'owner',
      person: null,
      link: 'proposed',
    });
    db.prepare("INSERT INTO people (id, kind, status) VALUES (?, 'person', 'active')").run(STALE);
    db.prepare(
      `INSERT INTO account_person_links (id, account_id, person_id, state, by, reason, valid_from_at, recorded_at)
       VALUES ('link:stale', 'cli:owner', ?, 'proposed', 'her', 'synthetic', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`
    ).run(STALE);
    seed.close();
    cores.push(await startUnitsCore(dirs, llm));
    await firstLine({ dirs, clis });

    assert.equal(cliAccount(dirs)?.id, 'cli:owner');
    assert.equal(query(dirs, "SELECT id FROM accounts WHERE iface = 'cli'").length, 1, 'no second account of the chat');
    assert.equal(cliAccount(dirs)?.person_id, OWNER);
    assert.equal(
      query(dirs, "SELECT 1 FROM account_person_links WHERE id = 'link:stale' AND valid_to_at IS NULL").length,
      0,
      'her proposal is closed'
    );
    assert.deepEqual(query(dirs, 'SELECT from_person, into_person FROM people_merges'), [
      { from_person: STALE, into_person: OWNER },
    ]);
  });
});

test('/memory bind names the account of the command line by its native words', async () => {
  // Bug: the observation stores the chat under `cli/global` and the console looks under `cli/local`, so every bind that
  // names the chat answers that she has not met it.
  await withRig({}, async ({ dirs, llm, clis, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    await firstLine({ dirs, clis });
    // The bind names an account by interface and platform id and binds it to a person: here the chat's own account to
    // the owner, which it already belongs to, so only the lookup under `cli/local` is at stake.
    const bound = await runCli(dirs, ['-p', '/memory bind cli owner owner']);
    assert.equal(bound.code, 0, bound.stdout + bound.stderr.slice(-2000));
    assert.equal(cliAccount(dirs)?.person_id, configOf(dirs).bot.ownerPerson);
  });
});

test('a line of the command line is stored under the authority its address names', () => {
  // Bug: `observationOf` spells `<iface>/global` while every reader asks `nativeAuthorityOf`, so `accountNodeOf` misses.
  const handle = openMemoryDb(path.join(tempDir('nep-cli-authority-'), 'memory.db'));
  try {
    const at = Date.parse('2026-11-05T10:00:00Z');
    const envelope = observationOf(
      {
        kind: 'message.received',
        iface: 'cli',
        at,
        chat: { id: 'cli:dm:owner', kind: 'dm', chatType: 'dm', partnerId: 'owner' },
        message: { id: 'line-1', at, content: 'a synthetic line', author: { id: 'owner', name: 'owner' } },
      },
      { connection: 'conn:cli', direct: true }
    );
    assert.ok(envelope);
    observe(handle, envelope, { now: () => at });
    assert.equal(
      accountNodeOf(dbOf(handle), {
        interfaceId: 'cli',
        authorityId: nativeAuthorityOf('cli'),
        nativeId: 'owner',
        generation: 1,
      }),
      'cli:owner'
    );
  } finally {
    handle.close();
  }
});
