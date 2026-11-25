// What the persona knows about themselves reads through the same reader as what they know about anyone. Real
// temporary databases, synthetic ids only.
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import path, { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { observationOf } from '../../../../src/memory/db/observe-event.ts';
import { observe } from '../../../../src/memory/db/observe.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { personDetail, listPeople, ownerNamesOf } from '../../../../src/memory/db/people-read.ts';
import type { PersonDetail, PersonFilters, PersonListing } from '../../../../src/memory/db/people-read.ts';
import { dmContext, groupContext, internalContext } from '../../../../src/memory/db/scope.ts';
import type { Context } from '../../../../src/memory/db/scope.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../../../../src/memory/db/types.ts';
import {
  addAccount,
  addClaim,
  addDmPlace,
  ANNA,
  ANNA_ACCOUNTS,
  ANNA_PLACES,
  BORIS,
  BORIS_ACCOUNT,
  addPerson,
  seedOpaqueWorld,
} from '../../../fixtures/memory-db/opaque-people.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { parseRequest } from '../../../../bin/neptunia-request.ts';
import { createConsole } from '../../../../src/interface/commands/console.ts';
import type { Answer } from '../../../../src/interface/commands/console.ts';
import { parseCommandLine } from '../../../../src/interface/commands/table.ts';
import { openTestMemory } from '../../../fixtures/memory-db/service.ts';
import type { TestMemory } from '../../../fixtures/memory-db/service.ts';
import {
  ALEX,
  KAI,
  MIRA,
  ROOM,
  addEntity,
  addSource,
  candidate,
  commit,
  sameAs,
  semanticWorld,
  successor,
  worksOn,
} from '../../../fixtures/memory-db/semantic-world.ts';
import type { World } from '../../../fixtures/memory-db/semantic-world.ts';
import type { Page } from '../../../../src/memory/db/inspection.ts';
import { wrongly } from '../../../fixtures/loose-types.ts';
import { databaseDigest } from '../../../fixtures/memory-db/browser-world.ts';

const SELF = 'person:self';
const AT = Date.parse('2026-11-05T10:00:00Z');

function withDb(body: (handle: MemoryHandle, db: Db) => void): void {
  const handle = openMemoryDb(path.join(tempDir('nep-self-'), 'memory.db'));
  try {
    body(handle, dbOf(handle));
  } finally {
    handle.close();
  }
}

/** One line in a channel of `iface`, by the account `author` under the name `name`, seen with the persona's id being `selfId`. */
function line(
  handle: MemoryHandle,
  iface: string,
  { id, author, name, selfId }: { id: string; author: string; name: string; selfId: string | null }
): void {
  const envelope = observationOf(
    {
      kind: 'message.received',
      iface,
      at: AT,
      chat: { id: 'room', kind: 'channel', chatType: 'channel' },
      message: { id, at: AT, content: 'a synthetic line', author: { id: author, name } },
    },
    { selfId, connection: `conn:${iface}` }
  );
  assert.ok(envelope, 'the event is an observable line');
  observe(handle, envelope, { now: () => AT });
}

const accountOf = (db: Db, iface: string, native: string) =>
  db.prepare('SELECT id, person_id, link, kind FROM accounts WHERE iface = ? AND native_key = ?').get(iface, native);

const DM_PLACE = 'place:dm-someone';

/** A claim about the persona under `audience`, as a memory session and the units store it: `subject_kind` `self`. */
function selfClaim(db: Db, id: string, audience: string): void {
  if (audience === `aud:dm:${DM_PLACE}` && !db.prepare('SELECT 1 AS ok FROM places WHERE id = ?').get(DM_PLACE)) {
    addAccount(db, {
      id: 'account:someone',
      iface: 'discord',
      authority: 'discord/global',
      native: 'someone',
      person: null,
    });
    addDmPlace(db, {
      id: DM_PLACE,
      iface: 'discord',
      authority: 'discord/global',
      account: 'account:someone',
      person: null,
    });
  }
  addClaim(db, id, SELF, audience);
  db.prepare("UPDATE claims SET subject_kind = 'self', kind = 'self_fact' WHERE id = ?").run(id);
}

test('the owner reads every claim about the persona through the reader that reads anyone', () => {
  // Bug: `personDetail` asks `subject_kind = 'person'`, so `/memory users show person:self` holds none of the persona's
  // own facts.
  withDb((handle, db) => {
    line(handle, 'discord', { id: 'm1', author: 'her-id', name: 'Someone', selfId: 'her-id' });
    selfClaim(db, 'claim:self-group', 'aud:group:discord');
    selfClaim(db, 'claim:self-dm', `aud:dm:${DM_PLACE}`);
    selfClaim(db, 'claim:self-internal', 'aud:internal');
    const view = personDetail(db, SELF, internalContext());
    assert.ok(view.found);
    assert.deepEqual(view.records.map((record) => record.id).sort(), [
      'claim:self-dm',
      'claim:self-group',
      'claim:self-internal',
    ]);
    assert.deepEqual(
      view.accounts.map((account) => account.id),
      [accountOf(db, 'discord', 'her-id')?.id]
    );
  });
});

test('an outward context reads of the persona only what its audience holds, as of anyone', () => {
  // Bug: reading the persona's facts through the person's reader opens a private chat's fact about them to a group.
  withDb((_handle, db) => {
    db.prepare("INSERT OR IGNORE INTO people (id, kind) VALUES (?, 'self')").run(SELF);
    selfClaim(db, 'claim:self-group', 'aud:group:discord');
    selfClaim(db, 'claim:self-dm', `aud:dm:${DM_PLACE}`);
    const inGroup = personDetail(db, SELF, groupContext('discord'));
    assert.ok(inGroup.found);
    assert.deepEqual(
      inGroup.records.map((record) => record.id),
      ['claim:self-group']
    );
    const elsewhere = personDetail(db, SELF, dmContext('person:stranger', 'discord', 'place:dm-stranger'));
    // The persona is read like any other person, and a group's fact is public knowledge in a DM; another DM's fact
    // about them stays closed.
    assert.ok(elsewhere.found);
    assert.deepEqual(
      elsewhere.records.map((record) => record.id),
      ['claim:self-group']
    );
  });
});

// The owner's browser over semantic memory, from the owner's line to the answer, over the real memory service and a database the
// one writer filled (tests/fixtures/memory-db/semantic-world.ts). Plan 2026-11-04-cli-and-memory task 10.2 and the S9
// gate. `/memory entities list`, `show`, `names` and `relations` answer the typed reader of src/memory/db/entities-read.ts.
// `/memory claims` opens a semantic version with its roles, premise versions and exact sources, and the users, places and
// graph views reach the same records. `/memory inspect` reads and exports every semantic table and FTS shadow. Every read
// runs in the owner's internal context. A chat line and argv words select the same typed ids, and no read calls a model,
// writes a row or rebuilds a projection. Each audience test opens the DM's record through the internal context first, so
// what a group context misses is refused and never unwritten. Synthetic content only.
//
// The contract this file is typed against, beside tests/src/memory/db/entities-read.test.ts:
//   /memory entities list [--kind] [--name] [--recorded-before] [--limit] [--cursor]   args: kind, name, recorded-before
//   /memory entities show <entity> [--recorded-before]                                 args: entity
//   /memory entities names <entity>                                                    answers { names }
//   /memory entities relations <entity> [--predicates] [--mode] [--recorded-before] [--limit] [--cursor]
//   An entity nobody may read answers `invalid` with the code ENTITY_NOT_FOUND.
//   domainDetail of a semantic claim version adds `semantic: { assertion, arguments, dependencies }`, catalog rows of
//   `semantic_assertion_versions`, `semantic_arguments` and `semantic_dependencies`, and links each premise version
//   (role `premise`) and each version resting on it (role `dependent`). A plain version has no `semantic`.
//   personDetail and placeDetail list a semantic version whose reference argument names the person or the place as
//   `{ table: 'semantic_assertion_versions', id }` among their records.
//   The chat's bare `/memory entities` is a panel over `memory.entities.list`, each row prefilling
//   `/memory entities show <id>`.
describe('semantic versions in /memory', () => {
  const BOUNDS = { pageRows: 25, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 };

  type Version = { claimId: string; versionId: string };
  const written = (result: object): Version => result as Version;

  /** What the seed wrote, by name, and the contexts the core would issue for the group and the two DMs. */
  type Seeded = {
    open: string;
    secret: string;
    edited: string;
    lumen: string;
    orbis: string;
    hidden: string;
    lumenName: Version;
    hiddenName: Version;
    moth: Version;
    works1: Version;
    works2: Version;
    kai: Version;
    mira: Version;
    event: Version;
    dmMeeting: Version;
    hiddenWork: Version;
    kite: string;
    kyte: string;
    contexts: World['contexts'];
  };

  type Rig = {
    memory: TestMemory;
    db: Db;
    ops: Array<string>;
    dir: string;
    seeded: Seeded;
    /** One command as argv words, as `neptunia memory ...` hands them over. */
    say(...words: Array<string>): Promise<Answer>;
    /** One command as the chat's line. */
    line(text: string): Promise<Answer>;
    run(command: { name: string; args: Record<string, unknown> }): Promise<Answer>;
  };

  const label = (entityId: string, role: 'alias', text: string, sources: Array<string>) =>
    candidate(
      'entity.label',
      'label',
      [
        { role: 'entity', position: 0, ref: { kind: 'entity', id: entityId } },
        { role, position: 0, literal: text },
        { role: 'language', position: 0, literal: 'en' },
      ],
      sources
    );

  /**
   * A public project, a public event and a project only Alex's DM knows; a DM alias; a relation changed from positive to
   * negative; a public and a private inference resting on its first version; an event with four roles held in the room; a
   * DM meeting in the room; two public concepts declared the same; and an edited revision of the public line the facts cite.
   */
  function seed(world: World): Seeded {
    const open = addSource(world, 'public', 'Alex works on Lumen; Orbis met in the room with Mira speaking');
    const secret = addSource(world, 'alex', 'Mira helps on Lumen; Hidden is mine');
    const lumen = addEntity(world, 'project', 'Lumen', [open]);
    const orbis = addEntity(world, 'event', 'Orbis', [open]);
    const hidden = addEntity(world, 'project', 'Hidden', [secret], world.contexts.alex);
    const moth = written(commit(world, label(lumen.entityId, 'alias', 'Moth', [secret]), world.contexts.alex));
    const works1 = written(commit(world, worksOn(ALEX, lumen.entityId, [open])));
    const inferred = { how: 'inferred', dependencies: [{ versionId: works1.versionId, role: 'supports' as const }] };
    const kai = written(commit(world, worksOn(KAI, lumen.entityId, [open], inferred)));
    const mira = written(commit(world, worksOn(MIRA, lumen.entityId, [secret], inferred), world.contexts.alex));
    const event = written(
      commit(
        world,
        candidate(
          'event.occurrence',
          'nary',
          [
            { role: 'event', position: 0, ref: { kind: 'entity', id: orbis.entityId } },
            { role: 'organizer', position: 0, ref: { kind: 'person', id: ALEX } },
            { role: 'speaker', position: 0, ref: { kind: 'person', id: MIRA } },
            { role: 'project', position: 0, ref: { kind: 'entity', id: lumen.entityId } },
            { role: 'location', position: 0, ref: { kind: 'place', id: ROOM } },
          ],
          [open]
        )
      )
    );
    const dmMeeting = written(
      commit(
        world,
        candidate(
          'event.occurrence',
          'nary',
          [
            { role: 'event', position: 0, ref: { kind: 'entity', id: hidden.entityId } },
            { role: 'attendee', position: 0, ref: { kind: 'person', id: ALEX } },
            { role: 'location', position: 0, ref: { kind: 'place', id: ROOM } },
          ],
          [secret]
        ),
        world.contexts.alex
      )
    );
    const hiddenWork = written(commit(world, worksOn(ALEX, hidden.entityId, [secret]), world.contexts.alex));
    const works2 = written(
      commit(world, worksOn(ALEX, lumen.entityId, [open], successor(works1, { polarity: 'negative' })))
    );
    const kite = addEntity(world, 'concept', 'Kite', [open]).entityId;
    const kyte = addEntity(world, 'concept', 'Kyte', [open]).entityId;
    commit(world, sameAs(kyte, kite, [open]));
    const edited = 'src:edited';
    world.db
      .prepare(
        `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, author_kind, occurred_at,
         recorded_at, text, scope_kind, scope_iface, scope_dm, audience_id)
       SELECT ?, kind, iface, native_id, 2, place_id, author_account, author_kind, occurred_at, recorded_at, 'edited later',
         scope_kind, scope_iface, scope_dm, audience_id FROM sources WHERE id = ?`
      )
      .run(edited, open);
    return {
      open,
      secret,
      edited,
      lumen: lumen.entityId,
      orbis: orbis.entityId,
      hidden: hidden.entityId,
      lumenName: lumen,
      hiddenName: hidden,
      moth,
      works1,
      works2,
      kai,
      mira,
      event,
      dmMeeting,
      hiddenWork,
      kite,
      kyte,
      contexts: world.contexts,
    };
  }

  const rigs: Array<TestMemory> = [];
  after(async () => {
    for (const memory of rigs) await memory.close();
  });

  /** The seed through the writer on a file, then the real service over that file with the console on it. */
  async function rig(): Promise<Rig> {
    const world = semanticWorld();
    const seeded = seed(world);
    world.handle.close();
    const dir = dirname(world.file);
    mkdirSync(join(dir, 'config'), { recursive: true });
    const memory = await openTestMemory({ dataDir: dir, config: { memoryDb: { inspection: BOUNDS } } });
    rigs.push(memory);
    const db = memory.memoryDb.database();
    assert.ok(db);
    const ops: Array<string> = [];
    const desk = createConsole({
      runOp: (op) => {
        ops.push(op);
        return Promise.resolve({ status: 'failed', code: 'NOT_FOR_A_BROWSER_READ', summary: '', data: null });
      },
      ownerReads: { lessons: () => '' },
      places: () => [],
      selfId: () => null,
      hot: memory.hot,
      privateDir: dir,
      dataDir: memory.dataDir,
      memoryDb: memory.memoryDb,
      usage: null,
      metrics: { samples: () => [] },
      chatLines: () => [],
      now: () => Date.UTC(2026, 10, 5, 12),
    });
    const run = async (command: { name: string; args: Record<string, unknown> }): Promise<Answer> => {
      const real = globalThis.fetch;
      globalThis.fetch = () => Promise.reject(new Error('a memory read reached the network'));
      try {
        return await desk.run(command.name, command.args, { id: 'owner' });
      } finally {
        globalThis.fetch = real;
      }
    };
    return {
      memory,
      db,
      ops,
      dir,
      seeded,
      run,
      say: (...words) => {
        const parsed = parseRequest(words).parsed;
        assert.ok(parsed.ok, parsed.ok ? '' : `${words.join(' ')}: ${parsed.reason}`);
        return run(parsed);
      },
      line: (text) => {
        const parsed = parseCommandLine(text);
        assert.ok(parsed.ok, parsed.ok ? '' : `${text}: ${parsed.reason}`);
        return run(parsed);
      },
    };
  }

  function data<TData>(answer: Answer): TData {
    assert.equal(answer.status, 'ok', answer.text.slice(0, 300));
    return JSON.parse(answer.text) as TData;
  }

  // ---- the users and places views --------------------------------------------------------------------------------------

  test('/memory users show lists the semantic versions that name the person, a DM one only for the owner', async () => {
    // Bug: a person's detail lists plain claims only, so the facts in which they play a role cannot be reached from them.
    const one = await rig();
    const { works2, event, dmMeeting, hiddenWork, contexts } = one.seeded;
    const semanticIds = (records: Array<{ table: string; id: string }>) =>
      records.filter((record) => record.table === 'semantic_assertion_versions').map((record) => record.id);
    const owner = data<{ records: Array<{ table: string; id: string }> }>(
      await one.say('memory', 'users', 'show', ALEX)
    );
    for (const version of [works2, event, dmMeeting, hiddenWork])
      assert.ok(semanticIds(owner.records).includes(version.versionId), version.versionId);
    const group = personDetail(one.db, ALEX, contexts.group);
    assert.ok(group.found);
    assert.ok(semanticIds(group.records).includes(event.versionId));
    assert.ok(!semanticIds(group.records).includes(hiddenWork.versionId));
    assert.ok(!semanticIds(group.records).includes(dmMeeting.versionId));
  });
});

// src/memory/db/people-read.ts: the owner's reader of people, accounts and anonymous participants. Who someone is stays what
// was stored: a shared name is a search term and links nothing, an unlinked account and an anonymous participant stay
// discoverable on their own, and a merge keeps its history. The context decides before anything is counted. Plan
// 2026-11-04-cli-and-memory task 8. Contract:
//   listPeople(db: Db, request: { context: Context; filters: { name: string | null; interfaceId: string | null;
//     authorityId: string | null }; limit: number; cursor: string | null }): Page<PersonListing>
//   personDetail(db: Db, personId: string, context: Context): PersonDetail
//   PersonListing = { kind: 'person'; id; names; accountIds; mergedInto: string | null }
//     | { kind: 'account'; id; interfaceId; authorityId; nativeId; generation; names }
//     | { kind: 'participant'; id; authorityId; display; scopePlaceId }
//   PersonDetail = { found: true; person: { id; requestedId; mergedFrom }; names; accounts: Array<PrivateAccount>;
//     links: Array<{ id; accountId; personId; state; by; validFromAt; validToAt }>; merges: Array<{ id; fromPerson; intoPerson;
//     at; by; reason }>; participants; memberships; affinity: { score; eventIds }; privatePlaces: Array<PrivatePlace>;
//     records: Array<{ table; id; audienceId; retiredAt }> } | { found: false; code: 'PERSON_NOT_FOUND' }
// A cursor from another context or filter throws an Error with `code` INSPECTION_BAD_CURSOR.

const UNLINKED = 'account:u1';
const ANONYMOUS = 'participant:p1';
const MERGED = 'person:merged-away';
const READ_AT = '2026-11-01T00:00:00.000Z';
const OLD_AT = '2026-10-01T00:00:00.000Z';

function seed(db: Db): void {
  seedOpaqueWorld(db);
  addAccount(db, {
    id: UNLINKED,
    iface: 'discord',
    authority: 'discord/global',
    native: 'n9',
    person: null,
    link: 'proposed',
  });
  db.prepare("UPDATE accounts SET names = ? WHERE id = 'account:a11'").run(JSON.stringify(['Ελένη']));
  db.prepare('UPDATE accounts SET names = ? WHERE id = ?').run(JSON.stringify(['Ελένη']), BORIS_ACCOUNT);
  db.prepare('UPDATE accounts SET names = ? WHERE id = ?').run(JSON.stringify(['Ελένη', 'Noël']), UNLINKED);
  db.prepare(
    `INSERT INTO participants (id, authority_id, scope_place_id, token_kind, native_token, continuity, display, recorded_at)
     VALUES (?, 'discord/global', 'place:room-1', 'thread_token', 'token-1', 'unknown', 'Ανώνυμος', ?)`
  ).run(ANONYMOUS, READ_AT);
  addPerson(db, MERGED);
  db.prepare(
    `INSERT INTO people_merges (id, from_person, into_person, at, by, reason)
     VALUES ('merge:1', ?, ?, ?, 'owner', 'same person')`
  ).run(MERGED, ANNA, READ_AT);
  db.prepare(
    `INSERT INTO account_person_links (id, account_id, person_id, state, by, reason, valid_from_at, valid_to_at, recorded_at)
     VALUES ('link:revoked', 'account:a11', ?, 'revoked', 'owner', 'wrong person', ?, ?, ?)`
  ).run(BORIS, OLD_AT, READ_AT, OLD_AT);
  db.prepare(
    `INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, audience_id, scope_kind, retired_at, created_at)
     VALUES ('claim:retired-anna', 'person', ?, 'detail', 'retired words', 'current', 1, 'aud:group:discord', 'group', ?, ?)`
  ).run(ANNA, READ_AT, OLD_AT);
}

function withWorld(body: (db: Db) => void): void {
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    seed(db);
    body(db);
  } finally {
    handle.close();
  }
}

const NO_FILTERS: PersonFilters = { name: null, interfaceId: null, authorityId: null };

function everyEntry(db: Db, context: Context, filters = NO_FILTERS, limit = 2): Array<PersonListing> {
  const items: Array<PersonListing> = [];
  let cursor: string | null = null;
  for (let turn = 0; turn < 1000; turn += 1) {
    const page: Page<PersonListing> = listPeople(db, { context, filters, limit, cursor });
    items.push(...page.items);
    if (page.next === null) return items;
    cursor = page.next;
  }
  throw new Error('the pages never end');
}

const ids = (items: ReadonlyArray<{ id: string }>): Array<string> => items.map((item) => item.id).sort();

function found(view: PersonDetail): Extract<PersonDetail, { found: true }> {
  assert.equal(view.found, true);
  return view;
}
const recordsOf = (view: PersonDetail): Array<string> =>
  found(view)
    .records.map((one) => `${one.table} ${one.id}`)
    .sort();

// ---------- discovery ----------

test('the list holds each person once, and an unlinked account and an anonymous participant on their own', () => {
  // Bug: the list joins people to verified accounts, so whoever has no verified link is invisible to the owner.
  withWorld((db) => {
    const entries = everyEntry(db, internalContext());
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    assert.equal(entries.length, byId.size, 'an entry repeats across pages');
    assert.equal(byId.get(ANNA)?.kind, 'person');
    assert.equal(byId.get(UNLINKED)?.kind, 'account');
    assert.equal(byId.get(ANONYMOUS)?.kind, 'participant');
  });
});

test('a linked account lives under its person and has no entry of its own', () => {
  withWorld((db) => {
    const entries = everyEntry(db, internalContext());
    const anna = entries.find((entry) => entry.id === ANNA);
    assert.ok(anna?.kind === 'person');
    assert.deepEqual([...anna.accountIds].sort(), ANNA_ACCOUNTS);
    for (const account of ANNA_ACCOUNTS)
      assert.equal(
        entries.some((entry) => entry.id === account),
        false
      );
  });
});

test('a person merged away stays discoverable and names the survivor', () => {
  // Bug: `WHERE id NOT IN (SELECT from_person ...)` erases the old id, and the owner cannot find what was merged.
  withWorld((db) => {
    const merged = everyEntry(db, internalContext()).find((entry) => entry.id === MERGED);
    assert.ok(merged?.kind === 'person');
    assert.equal(merged.mergedInto, ANNA);
  });
});

test('an unlinked account keeps its interface, authority, native id and generation', () => {
  withWorld((db) => {
    const account = everyEntry(db, internalContext()).find((entry) => entry.id === UNLINKED);
    assert.ok(account?.kind === 'account');
    assert.deepEqual(
      [account.interfaceId, account.authorityId, account.nativeId, account.generation],
      ['discord', 'discord/global', 'n9', 1]
    );
  });
});

// ---------- a name is a search term ----------

test('a name finds every holder of it and joins none of them', () => {
  // Bug: a name search resolves to one person, or groups the accounts that share the spelling.
  withWorld((db) => {
    const before = databaseDigest(db);
    const hits = everyEntry(db, internalContext(), { ...NO_FILTERS, name: 'Ελένη' });
    assert.deepEqual(ids(hits), [ANNA, BORIS, UNLINKED].sort());
    assert.deepEqual(databaseDigest(db), before);
    const anna = hits.find((entry) => entry.id === ANNA);
    assert.ok(anna?.kind === 'person');
    assert.equal(anna.accountIds.includes(UNLINKED), false);
    const unlinked = found(personDetail(db, ANNA, internalContext())).accounts.map((one) => one.id);
    assert.equal(unlinked.includes(UNLINKED), false);
  });
});

test('a name also finds an anonymous participant by its display, and an unknown name finds nobody', () => {
  withWorld((db) => {
    assert.deepEqual(ids(everyEntry(db, internalContext(), { ...NO_FILTERS, name: 'Ανώνυμος' })), [ANONYMOUS]);
    assert.deepEqual(ids(everyEntry(db, internalContext(), { ...NO_FILTERS, name: 'nobody-of-that-name' })), []);
  });
});

test('interface and authority filters apply before the count and the page', () => {
  // Bug: the filter runs over a page already cut, so a matching person on page two reads as absent.
  withWorld((db) => {
    const filters = { ...NO_FILTERS, interfaceId: 'telegram' };
    const entries = everyEntry(db, internalContext(), filters, 1);
    assert.deepEqual(ids(entries), [ANNA, BORIS].sort());
    assert.equal(listPeople(db, { context: internalContext(), filters, limit: 1, cursor: null }).total, 2);
    const authority = { ...NO_FILTERS, authorityId: 'discord/global' };
    assert.equal(
      everyEntry(db, internalContext(), authority).some((entry) => entry.id === BORIS),
      false
    );
  });
});

// ---------- detail ----------

test('detail shows the accounts of a person across interfaces, two equal native ids apart', () => {
  // Bug: accounts are keyed by native id, and account:a11 and account:a21 (both `n1`) collapse into one.
  withWorld((db) => {
    const view = found(personDetail(db, ANNA, internalContext()));
    assert.deepEqual(ids(view.accounts), ANNA_ACCOUNTS);
    const natives = view.accounts.filter((one) => one.nativeId === 'n1').map((one) => one.interfaceId);
    assert.deepEqual(natives.sort(), ['discord', 'telegram']);
  });
});

test('detail shows every link of the person, the revoked one with its window', () => {
  // Bug: the reader takes `accounts.person_id`, the present only, and the owner cannot see a link undone.
  withWorld((db) => {
    const revoked = found(personDetail(db, BORIS, internalContext())).links.find((one) => one.id === 'link:revoked');
    assert.deepEqual(revoked, {
      id: 'link:revoked',
      accountId: 'account:a11',
      personId: BORIS,
      state: 'revoked',
      by: 'owner',
      validFromAt: OLD_AT,
      validToAt: READ_AT,
    });
  });
});

test('detail shows the merge history, from the survivor and from the old id', () => {
  withWorld((db) => {
    const survivor = found(personDetail(db, ANNA, internalContext()));
    assert.deepEqual(survivor.merges, [
      { id: 'merge:1', fromPerson: MERGED, intoPerson: ANNA, at: READ_AT, by: 'owner', reason: 'same person' },
    ]);
    assert.deepEqual(survivor.person.mergedFrom, [MERGED]);
    const old = found(personDetail(db, MERGED, internalContext()));
    assert.equal(old.person.id, ANNA);
    assert.equal(old.person.requestedId, MERGED);
  });
});

test('detail opens exact records by id, the private-only ones and the retired ones included', () => {
  // Bug: the detail reads the public profile, so a person known only in DMs has no records, and retired ones are gone.
  withWorld((db) => {
    assert.deepEqual(recordsOf(personDetail(db, ANNA, internalContext())), [
      'affinity_events affinity:a21',
      'claims claim:a11',
      'claims claim:about-anna-in-his-dm',
      'claims claim:public',
      'claims claim:retired-anna',
      'descriptions description:a12',
      'episodes episode:a21',
    ]);
    const retired = found(personDetail(db, ANNA, internalContext())).records.find(
      (one) => one.id === 'claim:retired-anna'
    );
    assert.equal(retired?.retiredAt, READ_AT);
    assert.equal(retired?.audienceId, 'aud:group:discord');
  });
});

test('detail lists the actual DM places through the private reader', () => {
  withWorld((db) => {
    assert.deepEqual(ids(found(personDetail(db, ANNA, internalContext())).privatePlaces), ANNA_PLACES);
  });
});

test('detail reports the affinity history by event id', () => {
  withWorld((db) => {
    assert.deepEqual(found(personDetail(db, ANNA, internalContext())).affinity.eventIds, ['affinity:a21']);
  });
});

test('a person with no records at all is found, and empty', () => {
  withWorld((db) => {
    addPerson(db, 'person:blank');
    const view = found(personDetail(db, 'person:blank', internalContext()));
    assert.deepEqual([view.accounts, view.links, view.merges, view.records], [[], [], [], []]);
  });
});

test('a person nobody stored is a named refusal and not an empty profile', () => {
  withWorld((db) => {
    assert.deepEqual(personDetail(db, 'person:unknown', internalContext()), { found: false, code: 'PERSON_NOT_FOUND' });
  });
});

// ---------- the context decides first ----------

test('a group context sees no private place, private record or private count', () => {
  // Bug: the owner's view is filtered after the counting, so a preview leaks how much a DM holds.
  withWorld((db) => {
    const view = found(personDetail(db, ANNA, groupContext('discord')));
    assert.deepEqual(view.privatePlaces, []);
    assert.deepEqual(view.records.map((one) => one.id).sort(), ['claim:public', 'claim:retired-anna']);
    assert.deepEqual(view.affinity.eventIds, []);
  });
});

test('a DM context of one person never sees another DM', () => {
  withWorld((db) => {
    const context = dmContext(BORIS, 'telegram', 'place:dm-b21');
    assert.deepEqual(
      found(personDetail(db, ANNA, context)).privatePlaces.map((one) => one.id),
      []
    );
    assert.equal(
      found(personDetail(db, ANNA, context)).records.some((one) => one.id === 'claim:a11'),
      false
    );
  });
});

test('a call without a valid context is refused, never read as the owner', () => {
  // Bug: `context?.internal !== false`, and a protocol argument obtains everything.
  withWorld((db) => {
    const bad = wrongly<Context>({});
    assert.throws(() => personDetail(db, ANNA, bad));
    assert.throws(() => listPeople(db, { context: bad, filters: NO_FILTERS, limit: 5, cursor: null }));
  });
});

test('a group list counts only what the group may know of', () => {
  // Bug: a person known only from a DM is listed, or counted in the total, for a group preview.
  withWorld((db) => {
    addPerson(db, 'person:dm-only');
    addClaim(db, 'claim:dm-only', 'person:dm-only', 'aud:dm:place:dm-b21');
    const page = listPeople(db, { context: groupContext('discord'), filters: NO_FILTERS, limit: 500, cursor: null });
    assert.equal(
      page.items.some((entry) => entry.id === 'person:dm-only'),
      false
    );
    assert.equal(page.total, page.items.length);
  });
});

// ---------- paging ----------

test('a cursor is bound to its context and filters', () => {
  withWorld((db) => {
    const filters = { ...NO_FILTERS, name: 'Ελένη' };
    const first = listPeople(db, { context: internalContext(), filters, limit: 1, cursor: null });
    const code = { code: 'INSPECTION_BAD_CURSOR' };
    assert.throws(
      () => listPeople(db, { context: groupContext('discord'), filters, limit: 1, cursor: first.next }),
      code
    );
    assert.throws(
      () => listPeople(db, { context: internalContext(), filters: NO_FILTERS, limit: 1, cursor: first.next }),
      code
    );
    assert.throws(() => listPeople(db, { context: internalContext(), filters, limit: 1, cursor: 'garbage' }), code);
  });
});

test('a page says what it left out', () => {
  withWorld((db) => {
    const page = listPeople(db, { context: internalContext(), filters: NO_FILTERS, limit: 1, cursor: null });
    assert.equal(page.items.length, 1);
    assert.equal(page.truncated, true);
    assert.equal(page.reason, 'page');
    assert.equal(page.total, everyEntry(db, internalContext()).length);
  });
});

test('an empty database lists nothing and completes', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const page = listPeople(dbOf(handle), { context: internalContext(), filters: NO_FILTERS, limit: 5, cursor: null });
    const missing = page.items.filter((entry) => entry.id !== 'person:self');
    assert.deepEqual([missing, page.next, page.truncated], [[], null, false]);
  } finally {
    handle.close();
  }
});

// ---------- no write ----------

test('the reader runs over a read-only connection and changes no row', () => {
  // Bug: a lookup repairs a link, or creates the person it was asked about, on the way through.
  const file = join(tempDir('nep-people-read-'), 'memory.db');
  const writer = openMemoryDb(file);
  seed(dbOf(writer));
  writer.close();
  const reader = openMemoryDb(file, { readOnly: true });
  try {
    const db = dbOf(reader);
    const before = databaseDigest(db);
    for (const entry of everyEntry(db, internalContext())) personDetail(db, entry.id, internalContext());
    personDetail(db, 'person:unknown', internalContext());
    assert.deepEqual(databaseDigest(db), before);
  } finally {
    reader.close();
  }
});

// The persona's aliases are the names the owner gives their own person record, `person:self`, with `/memory users names add|remove`.
// The door reads only those: a name the persona's memory session or the analyzer writes about them has another `author` and never
// widens it. The writer's `owner-name` op, the reader `ownerNamesOf` and the command over a person, together.

const namesDbOf = (memoryDb: { readHandle(): unknown }): Db => (memoryDb.readHandle() as { db: Db }).db;

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

test("a name the persona's memory session wrote about them is not one of the owner names", async () => {
  // Bug: whatever someone called the persona in chat becomes a gate that sends lines to the classifier.
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
    assert.deepEqual(ownerNamesOf(namesDbOf(memoryDb), 'person:self'), ['Zefira']);
  } finally {
    await close();
  }
});
