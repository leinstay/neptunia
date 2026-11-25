// src/memory/db/person-links.ts: the owner binds accounts to one person, and a DM context reads the DMs of the person.
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import path, { join } from 'node:path';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import {
  accountNodeOf,
  applyPersonLinkWrite,
  linkedDmScopes,
  createOwnerAccounts,
} from '../../../../src/memory/db/person-links.ts';
import { createMemoryDb } from '../../../../src/memory/db/service.ts';
import type { MemoryDbService } from '../../../../src/memory/db/service.ts';
import { allowed, allowedAudience, audienceWhere, dmContext, whereFor } from '../../../../src/memory/db/scope.ts';
import { applyMemoryWrite } from '../../../../src/memory/db/session-write.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../../../../src/memory/db/types.ts';
import {
  ANNA,
  BORIS,
  BORIS_ACCOUNT,
  BORIS_PLACE,
  addAccount as addOpaqueAccount,
  recordMerge,
  seedOpaqueWorld,
  addAccount as opaqueAddAccount,
  addDmPlace,
  addPerson,
  addAccount as sourceAddAccount,
  addAccount as mergeAddAccount,
  addClaim,
  addEpisode,
} from '../../../fixtures/memory-db/opaque-people.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { withIface } from '../../../../src/memory/db/current-iface.ts';

type Handle = ReturnType<typeof openMemoryDb>;

// A DM reads through its stored place, so the fixture holds one instead of relying on a fabricated id.
const addDm = (db: ReturnType<typeof dbOf>, iface: string, native: string): void => {
  db.prepare(
    `INSERT INTO places (id, iface, kind, chat, scope_kind, partner_account, partner_person) VALUES (?, ?, 'dm', 'dm', 'dm', ?, ?)`
  ).run(`${iface}:dm:${native}`, iface, `${iface}:${native}`, `person:${iface}:${native}`);
};

/**
 * An account with the person the observation links it to. Changed with the ids-by-rows work: an account held no person
 * here, and the person id that spells it stood for it; every account has its person at creation, and a person reaches
 * its accounts through `accounts.person_id` alone.
 */
const addAccount = (db: ReturnType<typeof dbOf>, iface: string, native: string): void => {
  const person = `person:${iface}:${native}`;
  db.prepare("INSERT OR IGNORE INTO people (id, kind, status, meta) VALUES (?, 'human', 'active', 1)").run(person);
  db.prepare(
    "INSERT INTO accounts (id, iface, native_id, native_key, kind, person_id, link) VALUES (?, ?, ?, ?, 'user', ?, 'verified')"
  ).run(`${iface}:${native}`, iface, native, native, person);
};

function withDb(body: (handle: Handle) => void): void {
  const handle = openMemoryDb(path.join(tempDir('nep-links-'), 'memory.db'));
  for (const [iface, native] of [
    ['discord', '111'],
    ['discord', '222'],
    ['telegram', '111'],
    ['discord', '333'],
  ] as const) {
    addAccount(dbOf(handle), iface, native);
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
    accountId: `${account[0]}:${account[1]}`,
    target: target === 'self' ? { self: true } : { accountId: `${target[0]}:${target[1]}` },
    now: 1000,
  });

const contextOf = (handle: Handle, iface: string, native: string) => {
  const person = `person:${iface}:${native}`;
  const place = `${iface}:dm:${native}`;
  return { ...dmContext(person, iface, place), linked: linkedDmScopes(dbOf(handle), person, place) };
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
    applyMemoryWrite(handle, { kind: 'person-link', op: 'unbind', accountId: 'discord:222', now: 2000 });
    assert.equal(allowed(dmRow('discord', '222'), contextOf(handle, 'discord', '111')), false);
    const siblings = dbOf(handle)
      .prepare(
        `SELECT iface, COALESCE(native_key, native_id) AS native FROM accounts WHERE link = 'verified' AND person_id =
           (SELECT person_id FROM accounts WHERE iface = 'discord' AND native_id = '111') ORDER BY iface, native`
      )
      .all()
      .map((row) => ({ iface: row.iface, native: row.native }));
    assert.deepEqual(siblings, [{ iface: 'discord', native: '111' }]);
  });
});

test('both accounts of a person share one affinity score', () => {
  // Bug: the second account keeps its own score, so the same friend is a stranger on the other account.
  withDb((handle) => {
    // Changed with the ids-by-rows work: the fixture stores the person with its account, so the score is set on it.
    dbOf(handle).prepare("UPDATE people SET affinity = 40 WHERE id = 'person:discord:111'").run();
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

test('the persona can hold several accounts, and an unknown account is refused', () => {
  // Bug: their second account is treated as a stranger, or a typo makes a link to nobody.
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
  addAccount(dbOf(seed), 'discord', '111');
  addAccount(dbOf(seed), 'telegram', '222');
  addDm(dbOf(seed), 'discord', '111');
  addDm(dbOf(seed), 'telegram', '222');
  seed.close();
  const service = createMemoryDb({
    iface: () => 'discord',
    dataDir,
    hot: { config: {} },
    log: { info() {}, warn() {}, error() {} },
    embed: () => Promise.resolve([]),
  });
  await service.open();
  try {
    await service.personLink({
      op: 'bind',
      accountId: 'telegram:222',
      target: { accountId: 'discord:111' },
    });
    // The context names its own DM place, as every caller finds it in `places`: the person id does not spell it.
    const ctx = service.issueContext({
      kind: 'dm',
      iface: 'discord',
      person: 'person:discord:111',
      place: 'discord:dm:111',
    });
    assert.deepEqual(
      ctx.linked?.map((one) => one.person),
      ['person:telegram:222']
    );
    assert.equal(allowed(dmRow('telegram', '222'), ctx), true);
  } finally {
    await service.close();
  }
});

// ---------- concrete accounts ----------
// src/memory/db/person-links.ts over concrete accounts: a neutral address resolves to one account node, and a binding names
// the node, so equal native ids in two authorities or two generations stay apart.
// Contract:
//   accountNodeOf(db: Db, address: AccountAddress): string | null
//   applyPersonLinkWrite(handle, { op, accountId, target: { accountId } | { personId } | { self: true } })

function withAccountsWorld(body: (db: Db, handle: MemoryHandle) => void): void {
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    seedOpaqueWorld(db);
    addOpaqueAccount(db, {
      id: 'account:second-authority',
      iface: 'discord',
      authority: 'discord/other',
      native: 'n1',
      person: null,
    });
    addOpaqueAccount(db, {
      id: 'account:reused',
      iface: 'discord',
      authority: 'discord/global',
      native: 'n1',
      generation: 2,
      person: null,
    });
    body(db, handle);
  } finally {
    handle.close();
  }
}

const personOf = (db: Db, account: string): unknown =>
  db.prepare('SELECT person_id FROM accounts WHERE id = ?').get(account)?.person_id ?? null;

test('a neutral address resolves to the account of exactly its interface, authority, native id and generation', () => {
  // Bug: the native lookup orders by generation and has no authority, so it answers whichever row sorts first.
  withAccountsWorld((db) => {
    const of = (authorityId: string, nativeId: string, generation: number): string | null =>
      accountNodeOf(db, { interfaceId: 'discord', authorityId, nativeId, generation });
    assert.equal(of('discord/global', 'n1', 1), 'account:a11');
    assert.equal(of('discord/global', 'n1', 2), 'account:reused');
    assert.equal(of('discord/other', 'n1', 1), 'account:second-authority');
  });
});

test('an address nobody stored resolves to nothing, on any of its four parts', () => {
  // Bug: a near match answers: another interface's equal native id, or the newest generation for an old one.
  withAccountsWorld((db) => {
    const base = { interfaceId: 'discord', authorityId: 'discord/global', nativeId: 'n1', generation: 1 };
    assert.equal(accountNodeOf(db, { ...base, interfaceId: 'matrix' }), null);
    assert.equal(accountNodeOf(db, { ...base, authorityId: 'discord/unknown' }), null);
    assert.equal(accountNodeOf(db, { ...base, nativeId: 'n404' }), null);
    assert.equal(accountNodeOf(db, { ...base, generation: 9 }), null);
  });
});

test('a binding that names the account node touches that account and not the one with an equal native id', () => {
  // Bug: `iface` and `native` pick the newest generation, so the owner binds a stranger's recycled account.
  withAccountsWorld((db, handle) => {
    applyPersonLinkWrite(handle, {
      op: 'bind',
      accountId: 'account:second-authority',
      target: { accountId: BORIS_ACCOUNT },
      now: 1000,
    });
    assert.equal(personOf(db, 'account:second-authority'), BORIS);
    assert.equal(personOf(db, 'account:a11'), ANNA);
    assert.equal(personOf(db, 'account:reused'), null);
  });
});

test('a binding can name an opaque person directly', () => {
  // Bug: the only target is another account, so a person whose accounts all left cannot be bound again.
  withAccountsWorld((db, handle) => {
    const written = applyPersonLinkWrite(handle, {
      op: 'bind',
      accountId: 'account:reused',
      target: { personId: ANNA },
      now: 1000,
    });
    assert.equal(written.person, ANNA);
    assert.equal(personOf(db, 'account:reused'), ANNA);
  });
});

test('an unbind of a concrete account leaves it with a person of its own, not one spelled from its native id', () => {
  // Bug: `personId(iface, native)` gives the same id to both generations of a reused native id.
  withAccountsWorld((db, handle) => {
    const first = applyPersonLinkWrite(handle, { op: 'unbind', accountId: 'account:a11', now: 1000 });
    applyPersonLinkWrite(handle, { op: 'bind', accountId: 'account:reused', target: { personId: BORIS }, now: 1000 });
    const second = applyPersonLinkWrite(handle, { op: 'unbind', accountId: 'account:reused', now: 2000 });
    assert.notEqual(first.person, second.person);
    assert.notEqual(first.person, ANNA);
    assert.equal(personOf(db, 'account:a11'), first.person);
  });
});

test('a binding that names an unknown account or person is refused', () => {
  // Bug: a typo makes a link to a person nobody knows.
  withAccountsWorld((_db, handle) => {
    assert.throws(
      () => applyPersonLinkWrite(handle, { op: 'bind', accountId: 'account:none', target: { personId: ANNA } }),
      /UNKNOWN_ACCOUNT/
    );
    assert.throws(
      () => applyPersonLinkWrite(handle, { op: 'bind', accountId: 'account:a11', target: { personId: 'person:none' } }),
      /UNKNOWN_PERSON/
    );
  });
});

// ---------- a merge and the DMs it opens ----------
// Only the owner's merge widens an outward DM context.

function withMergeWorld(body: (handle: MemoryHandle) => void): void {
  const handle = openMemoryDb(':memory:');
  try {
    seedOpaqueWorld(dbOf(handle));
    body(handle);
  } finally {
    handle.close();
  }
}

test('a merge written by a session gives neither side the DMs of the other', () => {
  // Bug: a model's wrong merge opens one person's private memory in the DM of another.
  withMergeWorld((handle) => {
    recordMerge(dbOf(handle), BORIS, ANNA, 'session');
    const db = dbOf(handle);
    assert.equal(
      linkedDmScopes(db, ANNA, null).some((one) => one.place === BORIS_PLACE),
      false
    );
    assert.deepEqual(
      linkedDmScopes(db, BORIS, null).map((one) => one.place),
      [BORIS_PLACE]
    );
  });
});

test('a merge written by the owner gives the survivor the DMs of the merged person', () => {
  // Bug: the owner's own decision never reaches a DM context.
  withMergeWorld((handle) => {
    recordMerge(dbOf(handle), BORIS, ANNA, 'owner');
    assert.ok(linkedDmScopes(dbOf(handle), ANNA, null).some((one) => one.place === BORIS_PLACE));
  });
});

// src/memory/db/person-links.ts over opaque identities: the DMs a context reads come from stored accounts and places,
// never from the spelling of a person id. Over the real memory service, so a bind or an unbind is seen by the next
// context it issues. Plan 2026-11-04-cli-and-memory task 4.
describe('contexts of opaque persons', () => {
  const opened: Array<MemoryDbService> = [];
  after(async () => {
    for (const service of opened) await service.close();
  });

  function serviceOver(seed: (handle: ReturnType<typeof openMemoryDb>) => void): MemoryDbService {
    const dataDir = tempDir('nep-links-opaque-');
    const handle = openMemoryDb(path.join(dataDir, 'memory.db'));
    seed(handle);
    handle.close();
    const service = createMemoryDb({
      iface: () => 'discord',
      dataDir,
      hot: { config: { memoryDb: { session: { mode: 'off' } } } },
      log: { info() {}, debug() {}, warn() {}, error() {} },
      worker: false,
    });
    service.tick();
    opened.push(service);
    return service;
  }

  const worldService = (): MemoryDbService => serviceOver((handle) => seedOpaqueWorld(dbOf(handle)));
  const personaIn = (service: MemoryDbService) =>
    service.issueContext({ kind: 'dm', iface: 'discord', person: ANNA, place: 'place:dm-a11' });

  test('a context issued for an opaque person carries the actual DM places of every linked account', () => {
    // Bug: `linkedDmScopes` answers nothing for an id that does not start with `person:<iface>:`.
    const ctx = personaIn(worldService());
    assert.deepEqual(ctx.linked?.map((one) => one.place).sort(), ['place:dm-a12', 'place:dm-a21']);
    assert.equal(allowedAudience({ audience_id: 'aud:dm:place:dm-a12' }, ctx), true);
    assert.equal(allowedAudience({ audience_id: 'aud:dm:place:dm-a21' }, ctx), true);
    assert.equal(allowedAudience({ audience_id: `aud:dm:${BORIS_PLACE}` }, ctx), false);
  });

  test('the scope columns of a linked DM on another interface pass the same context', () => {
    // Bug: the triple check knows only the chat's interface, so the audience and the triple disagree.
    const ctx = personaIn(worldService());
    assert.equal(allowed({ scope_kind: 'dm', scope_iface: 'telegram', scope_dm: ANNA }, ctx), true);
    assert.equal(allowed({ scope_kind: 'dm', scope_iface: 'telegram', scope_dm: BORIS }, ctx), false);
  });

  test('a context issued after an unbind stops reading that DM, and the one issued before keeps what it was given', async () => {
    // Bug: a revoked link stays readable because the place list comes from a cached person.
    const service = worldService();
    const before = personaIn(service);
    await service.personLink({ op: 'unbind', accountId: 'account:a12' });
    const next = personaIn(service);
    assert.equal(allowedAudience({ audience_id: 'aud:dm:place:dm-a12' }, next), false);
    assert.equal(allowedAudience({ audience_id: 'aud:dm:place:dm-a21' }, next), true);
    assert.equal(allowedAudience({ audience_id: 'aud:dm:place:dm-a12' }, before), true);
  });

  test('a context issued after a bind reads the DM the link brought', async () => {
    // Bug: a binding reaches only the accounts seen when the person was first read.
    const service = serviceOver((handle) => {
      const db = dbOf(handle);
      seedOpaqueWorld(db);
      opaqueAddAccount(db, {
        id: 'account:new',
        iface: 'matrix',
        authority: 'matrix/global',
        native: 'n5',
        person: null,
      });
      addDmPlace(db, {
        id: 'place:dm-new',
        iface: 'matrix',
        authority: 'matrix/global',
        account: 'account:new',
        person: null,
      });
    });
    assert.equal(allowedAudience({ audience_id: 'aud:dm:place:dm-new' }, personaIn(service)), false);
    await service.personLink({ op: 'bind', accountId: 'account:new', target: { accountId: 'account:a11' } });
    assert.equal(allowedAudience({ audience_id: 'aud:dm:place:dm-new' }, personaIn(service)), true);
  });

  test('a context of the survivor of an owner merge reads the DMs of the merged person', () => {
    // Bug: the link read of an account compares `person_id` to the one id it was given and never follows `people_merges`.
    const service = serviceOver((handle) => {
      const db = dbOf(handle);
      seedOpaqueWorld(db);
      opaqueAddAccount(db, {
        id: 'account:merged',
        iface: 'matrix',
        authority: 'matrix/global',
        native: 'n6',
        person: 'person:merged',
      });
      addDmPlace(db, {
        id: 'place:dm-merged',
        iface: 'matrix',
        authority: 'matrix/global',
        account: 'account:merged',
        person: 'person:merged',
      });
      addPerson(db, 'person:merged');
      recordMerge(dbOf(handle), 'person:merged', ANNA, 'owner');
    });
    assert.equal(allowedAudience({ audience_id: 'aud:dm:place:dm-merged' }, personaIn(service)), true);
  });

  test('a context issued for a person id that was merged away reads as its survivor', () => {
    // Bug: a turn holding the old id gets a context with no linked DMs from the moment of the merge.
    const service = serviceOver((handle) => {
      const db = dbOf(handle);
      seedOpaqueWorld(db);
      addPerson(db, 'person:old');
      recordMerge(dbOf(handle), 'person:old', ANNA, 'owner');
    });
    const ctx = service.issueContext({ kind: 'dm', iface: 'discord', person: 'person:old', place: 'place:dm-a11' });
    assert.equal(allowedAudience({ audience_id: 'aud:dm:place:dm-a21' }, ctx), true);
  });

  test('another person with an equal native id on another interface is not linked', () => {
    // Bug: `telegram n1` and `discord n1`, both of another person, are joined through the number and Boris's `telegram n2` follows `discord n2`.
    const ctx = worldService().issueContext({ kind: 'dm', iface: 'telegram', person: BORIS, place: BORIS_PLACE });
    assert.deepEqual(ctx.linked ?? [], []);
    assert.equal(allowedAudience({ audience_id: 'aud:dm:place:dm-a12' }, ctx), false);
  });

  test("a context reads the DM of the account its person id spells when it was issued in the person's other DM", () => {
    // Bug: the linked DMs leave out the account whose id the person id spells, not the place the context was issued in.
    const service = serviceOver((handle) => {
      const db = dbOf(handle);
      opaqueAddAccount(db, {
        id: 'discord:n7',
        iface: 'discord',
        authority: 'discord/global',
        native: 'n7',
        person: 'person:discord:n7',
      });
      opaqueAddAccount(db, {
        id: 'account:n8',
        iface: 'discord',
        authority: 'discord/global',
        native: 'n8',
        person: 'person:discord:n7',
      });
      for (const [id, account] of [
        ['place:dm-n7', 'discord:n7'],
        ['place:dm-n8', 'account:n8'],
      ] as const)
        addDmPlace(db, { id, iface: 'discord', authority: 'discord/global', account, person: 'person:discord:n7' });
    });
    const ctx = service.issueContext({
      kind: 'dm',
      iface: 'discord',
      person: 'person:discord:n7',
      place: 'place:dm-n8',
    });
    assert.deepEqual(
      ctx.linked?.map((one) => one.place),
      ['place:dm-n7']
    );
  });
});

// The owner check reads one source of truth: the live row of `account_person_links` the owner wrote. The account's
// `link` and `linked_by` columns are a copy that a profile write once reset, so they decide nothing. Real temporary
// databases, synthetic ids only.

const OWNER = 'person:0a0a0a0a-synthetic';

function sourceWithDb(body: (db: Db) => void): void {
  const handle = openMemoryDb(path.join(tempDir('nep-owner-source-'), 'memory.db'));
  try {
    body(dbOf(handle));
  } finally {
    handle.close();
  }
}

const boundOn = (db: Db, native: string): boolean =>
  withIface('discord', () =>
    createOwnerAccounts({ database: () => db, home: () => 'discord' }).isBoundTo(OWNER, native)
  );

test('keeps the owner their rights when a profile write emptied the link columns of their account', () => {
  // Bug: an older unit write set `linked_by` to null on every flush, and the check read that column, so the owner lost
  // their rights on their own account at their next line while their link row still said they bound it.
  sourceWithDb((db) => {
    sourceAddAccount(db, {
      id: 'account:o1',
      iface: 'discord',
      authority: 'discord/global',
      native: 'o1',
      person: OWNER,
    });
    db.prepare("UPDATE accounts SET linked_by = NULL, linked_at = NULL WHERE id = 'account:o1'").run();
    assert.equal(boundOn(db, 'o1'), true);
  });
});

test("refuses an account whose columns name the owner while its live link is only the persona's proposal", () => {
  // Bug: the columns and the link rows disagree, and the copy wins over the record of who linked the account.
  sourceWithDb((db) => {
    sourceAddAccount(db, {
      id: 'account:o2',
      iface: 'discord',
      authority: 'discord/global',
      native: 'o2',
      person: OWNER,
      link: 'proposed',
    });
    db.prepare("UPDATE accounts SET person_id = ?, link = 'verified', linked_by = 'owner' WHERE id = 'account:o2'").run(
      OWNER
    );
    db.prepare("UPDATE account_person_links SET by = 'her' WHERE account_id = 'account:o2'").run();
    assert.equal(boundOn(db, 'o2'), false);
  });
});

test('refuses an account whose owner link was closed', () => {
  sourceWithDb((db) => {
    sourceAddAccount(db, {
      id: 'account:o3',
      iface: 'discord',
      authority: 'discord/global',
      native: 'o3',
      person: OWNER,
    });
    db.prepare(
      "UPDATE account_person_links SET valid_to_at = '2026-11-02T00:00:00.000Z' WHERE account_id = 'account:o3'"
    ).run();
    assert.equal(boundOn(db, 'o3'), false);
  });
});

// The owner's merge of one person into another (`kind: 'person-merge'` through the one writer, `/memory users merge` from
// their line): everything stored about the person who goes moves to the person who stays, and nothing moves out of the
// chat it was said in. One `people_merges` row records it, and running it again changes nothing. Real
// temporary databases over the synthetic opaque world.

const NOW = Date.parse('2026-11-05T12:00:00Z');
const AT = '2026-11-01T00:00:00.000Z';
const CAROL = 'person:c4r01-synthetic';
const CAROL_PLACE = 'place:dm-c31';

/** The opaque world, with Boris's line and vector in Boris's DM, a group fact about Boris, and Carol's DM that mentions Boris. */
function seedWorld(db: Db): void {
  seedOpaqueWorld(db);
  addClaim(db, 'claim:b21-public', BORIS, 'aud:group:discord');
  addEpisode(db, 'episode:b21', BORIS, BORIS_PLACE);
  mergeAddAccount(db, {
    id: 'account:c31',
    iface: 'telegram',
    authority: 'telegram/global',
    native: 'n3',
    person: CAROL,
  });
  addDmPlace(db, {
    id: CAROL_PLACE,
    iface: 'telegram',
    authority: 'telegram/global',
    account: 'account:c31',
    person: CAROL,
  });
  addClaim(db, 'claim:about-boris-in-carols-dm', BORIS, `aud:dm:${CAROL_PLACE}`);
  db.prepare("UPDATE claims SET from_person = ? WHERE id = 'claim:about-anna-in-his-dm'").run(BORIS);
  db.prepare(
    `INSERT INTO sources (id, kind, iface, place_id, author_account, author_kind, occurred_at, recorded_at, text,
       audience_id, scope_kind, scope_iface, scope_dm)
     VALUES ('source:b21', 'seen', 'telegram', ?, ?, 'account', ?, ?, 'a synthetic line', ?, 'dm', 'telegram', ?)`
  ).run(BORIS_PLACE, BORIS_ACCOUNT, AT, AT, `aud:dm:${BORIS_PLACE}`, BORIS);
  db.prepare(
    `INSERT INTO vectors (source_rowid, item_id, chunk_key, model, dims, context, occurred_at, scope_kind, scope_iface,
       scope_dm, audience_id)
     VALUES ((SELECT rowid FROM sources WHERE id = 'source:b21'), 'source:b21', 'chunk:b21', 'test/embedder', 4, '{}', ?,
       'dm', 'telegram', ?, ?)`
  ).run(AT, BORIS, `aud:dm:${BORIS_PLACE}`);
  db.prepare('UPDATE people SET affinity = 40 WHERE id = ?').run(ANNA);
  db.prepare('UPDATE people SET affinity = 5 WHERE id = ?').run(BORIS);
  for (const person of [ANNA, BORIS])
    db.prepare(
      `INSERT INTO relationship_daily (person_id, day, audience_id, addressed_by_them, addressed_by_her, meaningful)
       VALUES (?, '2026-11-01', 'aud:group:discord', 2, 1, 0)`
    ).run(person);
}

function withWorld(body: (handle: MemoryHandle, db: Db) => void): void {
  const handle = openMemoryDb(join(tempDir('nep-merge-'), 'memory.db'));
  try {
    seedWorld(dbOf(handle));
    body(handle, dbOf(handle));
  } finally {
    handle.close();
  }
}

type Merged = { ok: true; id: string; survivor: string; moved: Record<string, number> };

const merge = (handle: MemoryHandle, from: string, into: string, by = 'owner'): Merged =>
  applyMemoryWrite(handle, { kind: 'person-merge', from, into, by, reason: 'the same person', now: NOW }) as Merged;

test('the owner keeps their rights on every account when their owner person is the one merged away', () => {
  // Bug: `bot.ownerPerson` still names the person who went, and `isBoundTo` compares it with the survivor's id.
  withWorld((handle, db) => {
    merge(handle, BORIS, ANNA);
    const owner = createOwnerAccounts({ database: () => db, home: () => 'telegram' });
    assert.equal(
      withIface('telegram', () => owner.isBoundTo(BORIS, 'n2')),
      true
    );
    assert.equal(
      withIface('discord', () => owner.isBoundTo(BORIS, 'n1')),
      true
    );
    assert.equal(
      withIface('telegram', () => owner.isBoundTo(BORIS, 'n3')),
      false
    );
  });
});
