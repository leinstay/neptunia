// src/memory/db/person-links.ts: the owner binds accounts to one person, and a DM context reads the DMs of the person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { accountLinks, linkedDmScopes } from '../src/memory/db/person-links.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import { allowed, allowedAudience, audienceWhere, dmContext, whereFor } from '../src/memory/db/scope.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { tempDir } from './fixtures/tmp.ts';

type Handle = ReturnType<typeof openMemoryDb>;

// A DM reads through its stored place, so the fixture holds one instead of relying on a fabricated id.
const addDm = (db: ReturnType<typeof dbOf>, iface: string, native: string): void => {
  db.prepare(
    `INSERT INTO places (id, iface, kind, conversation, scope_kind, partner_account, partner_person) VALUES (?, ?, 'dm', 'dm', 'dm', ?, ?)`
  ).run(`${iface}:dm:${native}`, iface, `${iface}:${native}`, `person:${iface}:${native}`);
};

function withDb(body: (handle: Handle) => void): void {
  const handle = openMemoryDb(path.join(tempDir('nep-links-'), 'memory.db'));
  const insert = dbOf(handle).prepare(
    "INSERT INTO accounts (id, iface, native_id, native_key, kind) VALUES (?, ?, ?, ?, 'user')"
  );
  for (const [iface, native] of [
    ['discord', '111'],
    ['discord', '222'],
    ['telegram', '111'],
    ['discord', '333'],
  ] as const) {
    insert.run(`${iface}:${native}`, iface, native, native);
    addDm(dbOf(handle), iface, native);
  }
  try {
    body(handle);
  } finally {
    handle.close();
  }
}

const bind = (handle: Handle, account: [string, string], target: [string, string] | 'self') =>
  applyMemoryWrite(handle, {
    kind: 'person-link',
    op: 'bind',
    iface: account[0],
    native: account[1],
    target: target === 'self' ? { self: true } : { iface: target[0], native: target[1] },
    now: 1000,
  });

const contextOf = (handle: Handle, iface: string, native: string) => {
  const person = `person:${iface}:${native}`;
  return { ...dmContext(person, iface), linked: linkedDmScopes(dbOf(handle), iface, person) };
};
const dmRow = (iface: string, native: string) => ({
  scope_kind: 'dm',
  scope_iface: iface,
  scope_dm: `person:${iface}:${native}`,
});

test('a DM reads the DM history of the person across every account the owner bound', () => {
  // Bug: a person with two accounts cannot recall their own other DM, or a third person's DM leaks through the link.
  withDb((handle) => {
    bind(handle, ['discord', '222'], ['discord', '111']);
    bind(handle, ['telegram', '111'], ['discord', '111']);
    const ctx = contextOf(handle, 'discord', '111');
    assert.equal(allowed(dmRow('discord', '222'), ctx), true);
    assert.equal(allowed(dmRow('telegram', '111'), ctx), true);
    assert.equal(allowed(dmRow('discord', '333'), ctx), false);
    assert.equal(allowedAudience({ audience_id: 'aud:dm:telegram:dm:111' }, ctx), true);
    assert.equal(allowedAudience({ audience_id: 'aud:dm:discord:dm:333' }, ctx), false);
    // The SQL forms hold the same set as the row checks.
    assert.deepEqual(whereFor(ctx).params.slice(0, 6).sort(), [
      'discord',
      'discord',
      'person:discord:111',
      'person:discord:222',
      'person:telegram:111',
      'telegram',
    ]);
    assert.ok(audienceWhere(ctx).params.includes('aud:dm:telegram:dm:111'));
  });
});

test('equal native ids on two interfaces stay two people until the owner binds them', () => {
  // Bug: `telegram:111` reads the DMs of `discord:111` because their native ids match.
  withDb((handle) => {
    const ctx = contextOf(handle, 'telegram', '111');
    assert.equal(allowed(dmRow('discord', '111'), ctx), false);
    assert.deepEqual(ctx.linked, []);
  });
});

test('an unbound account leaves the person, and the DMs stop being shared', () => {
  // Bug: revoking a wrong link keeps exposing the private history through a stale row.
  withDb((handle) => {
    bind(handle, ['discord', '222'], ['discord', '111']);
    applyMemoryWrite(handle, { kind: 'person-link', op: 'unbind', iface: 'discord', native: '222', now: 2000 });
    assert.equal(allowed(dmRow('discord', '222'), contextOf(handle, 'discord', '111')), false);
    assert.deepEqual(accountLinks(dbOf(handle), 'discord', '111').accounts, [{ iface: 'discord', native: '111' }]);
  });
});

test('both accounts of a person share one affinity score', () => {
  // Bug: the second account keeps its own score, so the same friend is a stranger on the other account.
  withDb((handle) => {
    dbOf(handle).prepare("INSERT INTO people (id, affinity) VALUES ('person:discord:111', 40)").run();
    dbOf(handle).prepare("UPDATE accounts SET person_id = 'person:discord:111' WHERE id = 'discord:111'").run();
    bind(handle, ['discord', '222'], ['discord', '111']);
    const row = dbOf(handle)
      .prepare(
        `SELECT p.affinity AS score FROM accounts a JOIN people p ON p.id = a.person_id WHERE a.id = 'discord:222'`
      )
      .get() as { score: number };
    assert.equal(row.score, 40);
  });
});

test('the persona herself can hold several accounts, and an unknown account is refused', () => {
  // Bug: her second account is treated as a stranger, or a typo makes a link to nobody.
  withDb((handle) => {
    bind(handle, ['discord', '333'], 'self');
    const person = dbOf(handle).prepare("SELECT person_id FROM accounts WHERE id = 'discord:333'").get() as {
      person_id: string;
    };
    assert.equal(person.person_id, 'person:self');
    assert.throws(() => bind(handle, ['discord', '999'], ['discord', '111']), /UNKNOWN_ACCOUNT/);
  });
});

test('a DM context the service issues carries the DMs of the person, and a bind through the service takes effect', async () => {
  // Bug: the binding is stored but every turn's context still reads only the one account's DMs.
  const dataDir = tempDir('nep-links-service-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  const insert = dbOf(seed).prepare(
    "INSERT INTO accounts (id, iface, native_id, native_key, kind) VALUES (?, ?, ?, ?, 'user')"
  );
  insert.run('discord:111', 'discord', '111', '111');
  insert.run('telegram:222', 'telegram', '222', '222');
  addDm(dbOf(seed), 'discord', '111');
  addDm(dbOf(seed), 'telegram', '222');
  seed.close();
  const service = createMemoryDb({
    dataDir,
    hot: { config: {} },
    log: { info() {}, warn() {}, error() {} },
    embed: () => Promise.resolve([]),
  });
  await service.open();
  try {
    await service.personLink({
      op: 'bind',
      iface: 'telegram',
      native: '222',
      target: { iface: 'discord', native: '111' },
    });
    const ctx = service.issueContext({ kind: 'dm', iface: 'discord', person: 'person:discord:111' });
    assert.deepEqual(
      ctx.linked?.map((one) => one.person),
      ['person:telegram:222']
    );
    assert.equal(allowed(dmRow('telegram', '222'), ctx), true);
  } finally {
    await service.close();
  }
});
