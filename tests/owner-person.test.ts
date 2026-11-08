// The owner's rights come from the person: src/tools/operations/grants.ts#isOwnerId asks the accounts the owner bound
// (src/memory/db/person-links.ts#createOwnerAccounts), and `bot.owners` holds only until the owner person is bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { withIface } from '../src/memory/db/current-iface.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { createOwnerAccounts } from '../src/memory/db/person-links.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { isOwnerCaller, isOwnerId, useOwnerAccounts } from '../src/tools/operations/grants.ts';
import { rightsRefusal } from '../src/tools/operations/rights.ts';
import { mention, query, runCli, startUnitsCore, startedUnit, until, withRig } from './fixtures/core-units.ts';
import { tempDir } from './fixtures/tmp.ts';

type Handle = ReturnType<typeof openMemoryDb>;

const OWNER_PERSON = 'person:discord:111';
const OWNER_ONLY = { name: 'bot.pause', rights: { kind: 'write' as const, ownerOnly: true } };

function withAccounts(body: (handle: Handle) => void): void {
  const handle = openMemoryDb(path.join(tempDir('nep-owner-'), 'memory.db'));
  const insert = dbOf(handle).prepare(
    "INSERT INTO accounts (id, iface, native_id, native_key, person_id, kind) VALUES (?, ?, ?, ?, ?, 'user')"
  );
  for (const [iface, native] of [
    ['discord', '111'],
    ['discord', '222'],
    ['telegram', '111'],
    ['telegram', '555'],
  ] as const) {
    dbOf(handle).prepare('INSERT OR IGNORE INTO people (id) VALUES (?)').run(`person:${iface}:${native}`);
    insert.run(`${iface}:${native}`, iface, native, native, `person:${iface}:${native}`);
  }
  const stop = useOwnerAccounts(createOwnerAccounts({ database: () => dbOf(handle), home: () => 'discord' }));
  try {
    body(handle);
  } finally {
    stop();
    handle.close();
  }
}

function link(handle: Handle, op: 'bind' | 'unbind', iface: string, native: string, target: object = {}): unknown {
  return applyMemoryWrite(handle, { kind: 'person-link', op, accountId: `${iface}:${native}`, target, now: 1000 });
}

const ownerOn = (iface: string, native: string, config: object): boolean =>
  withIface(iface, () => isOwnerId(config, native));

test('an equal native id on a second interface has no owner rights once the owner person is bound', () => {
  // Bug: the bare string comparison hands the owner's rights to whoever holds the same number on another platform.
  withAccounts((handle) => {
    link(handle, 'bind', 'discord', '111', { owner: true });
    const config = { bot: { ownerPerson: OWNER_PERSON, owners: ['111'] } };
    assert.equal(ownerOn('discord', '111', config), true);
    assert.equal(ownerOn('telegram', '111', config), false);
    assert.equal(
      withIface('telegram', () => rightsRefusal(OWNER_ONLY, { accountId: '111', config })),
      'owner-only'
    );
  });
});

test('every account bound to the owner person has the owner rights, and an unbound one loses them', () => {
  // Bug: the owner's second account stays a stranger, or keeps the rights after the owner undid the binding.
  withAccounts((handle) => {
    link(handle, 'bind', 'discord', '111', { owner: true });
    link(handle, 'bind', 'telegram', '555', { accountId: 'discord:111' });
    const config = { bot: { ownerPerson: OWNER_PERSON, owners: [] } };
    assert.equal(ownerOn('telegram', '555', config), true);
    assert.equal(
      withIface('telegram', () => rightsRefusal(OWNER_ONLY, { accountId: '555', config })),
      null
    );
    assert.equal(
      withIface('telegram', () => isOwnerCaller(config, { accountId: '555' })),
      true
    );
    link(handle, 'unbind', 'telegram', '555');
    assert.equal(ownerOn('telegram', '555', config), false);
  });
});

test('a bot.owners id stops counting on any account once another person is the owner person', () => {
  // Bug: the old list stays a second way in after the explicit migration.
  withAccounts((handle) => {
    link(handle, 'bind', 'discord', '111', { owner: true });
    assert.equal(ownerOn('discord', '222', { bot: { ownerPerson: OWNER_PERSON, owners: ['222'] } }), false);
  });
});

test('an account on the owner person gets no rights from a link the owner did not write', () => {
  // Bug: a link written by an import or a memory session would hand out the owner's rights; only `/memory bind` may.
  withAccounts((handle) => {
    link(handle, 'bind', 'discord', '111', { owner: true });
    dbOf(handle)
      .prepare("UPDATE accounts SET person_id = ?, link = 'verified', linked_by = NULL WHERE id = 'discord:222'")
      .run(OWNER_PERSON);
    assert.equal(ownerOn('discord', '222', { bot: { ownerPerson: OWNER_PERSON } }), false);
  });
});

test('before the owner person is bound, bot.owners holds on the home interface alone', () => {
  // Bug: the fallback would let an equal id on a second interface pass while the migration has not happened.
  withAccounts(() => {
    const config = { bot: { owners: ['111'] } };
    assert.equal(ownerOn('discord', '111', config), true);
    assert.equal(ownerOn('telegram', '111', config), false);
    assert.equal(isOwnerId(config, '111'), true);
  });
});

test('a bound owner person with no account reader passes nobody', () => {
  // Bug: with the memory database out of reach the check would fall open to the bare list.
  assert.equal(isOwnerId({ bot: { ownerPerson: OWNER_PERSON, owners: ['111'] } }, '111'), false);
});

test('/memory bind <iface> <account> owner makes that person the owner person in the running core', async () => {
  // Bug: the core never installs the account reader, or the command leaves the setting unwritten, and the owner
  // locks himself out of every interface at the migration.
  await withRig({}, async ({ dirs, llm, units, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    const author = 'u1';
    await unit.emit(mention('m1', 'hello'));
    await until(() => query(dirs, 'SELECT 1 FROM accounts WHERE native_key = ?', author).length > 0, 'her first sight');

    const unmet = await runCli(dirs, ['-p', '/memory bind fake nobody owner']);
    assert.notEqual(unmet.code, 0);

    const bound = await runCli(dirs, ['-p', `/memory bind fake ${author} owner`]);
    assert.equal(bound.code, 0, bound.stdout + bound.stderr.slice(-2000));
    const local = JSON.parse(readFileSync(path.join(dirs.privateDir, 'config', 'config.json'), 'utf8')) as {
      bot: { ownerPerson: string };
    };
    // A person's id is opaque and spells no account, so the setting is compared with the account's stored person.
    const [account] = query(dirs, 'SELECT person_id FROM accounts WHERE native_key = ?', author) as Array<{
      person_id: string;
    }>;
    assert.equal(local.bot.ownerPerson, account?.person_id);
    assert.equal(ownerOn('fake', author, local), true);
    assert.equal(ownerOn('fake', 'someone-else', local), false);
    assert.equal(ownerOn('telegram', author, local), false);
  });
});
