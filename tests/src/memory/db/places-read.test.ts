// Tests for src/memory/db/places-read.ts.
import { after, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseRequest } from '../../../../bin/neptunia-request.ts';
import { createConsole } from '../../../../src/interface/commands/console.ts';
import type { Answer } from '../../../../src/interface/commands/console.ts';
import { parseCommandLine } from '../../../../src/interface/commands/table.ts';
import { placeDetail, listPlaces } from '../../../../src/memory/db/places-read.ts';
import type { PlaceDetail, PlaceListing } from '../../../../src/memory/db/places-read.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db } from '../../../../src/memory/db/types.ts';
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
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { groupContext, internalContext } from '../../../../src/memory/db/scope.ts';
import type { Context } from '../../../../src/memory/db/scope.ts';
import { wrongly } from '../../../fixtures/loose-types.ts';
import {
  addDescription,
  addPlace,
  addSource as readAddSource,
  databaseDigest,
  withoutForeignKeys,
} from '../../../fixtures/memory-db/browser-world.ts';
import { tempDir } from '../../../fixtures/tmp.ts';

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

  test('/memory places show lists the semantic versions held in the place, a DM one only for the owner', async () => {
    const one = await rig();
    const { event, dmMeeting, contexts } = one.seeded;
    const semanticIds = (records: Array<{ table: string; id: string }>) =>
      records
        .filter((record) => record.table === 'semantic_assertion_versions')
        .map((record) => record.id)
        .sort();
    const owner = data<{ records: Array<{ table: string; id: string }> }>(
      await one.say('memory', 'places', 'show', ROOM)
    );
    assert.deepEqual(semanticIds(owner.records), [event.versionId, dmMeeting.versionId].sort());
    const group = placeDetail(one.db, ROOM, { context: contexts.group, includeChildren: false });
    assert.ok(group.found);
    assert.deepEqual(semanticIds(group.records), [event.versionId]);
  });
});

// src/memory/db/places-read.ts: the owner's reader of places to any stored depth. A server and its channels are one case of a
// general tree: several roots, equal native keys under different authorities, orphans whose parent is missing, cycles an old
// database may hold, and continuation links that are not containment. Plan 2026-11-04-cli-and-memory task 8. Contract:
//   listPlaces(db: Db, request: { context: Context; filters: { interfaceId: string | null; authorityId: string | null;
//     rootsOnly: boolean }; limit: number; cursor: string | null }): Page<PlaceListing>
//   placeDetail(db: Db, placeId: string, request: { context: Context; includeChildren: boolean }): PlaceDetail
//   PlaceListing = { id; interfaceId; authorityId; nativeKey; generation; kind; chat; name; parentId;
//     parentState: 'none' | 'stored' | 'missing'; continuesPlaceId; childCount; retiredAt }
//   PlaceDetail = { found: true; place: PlaceListing; descriptions: Array<{ id; field; text; audienceId; placeId }>;
//     descendants: Array<PlaceListing & { depth: number }>; cycles: Array<{ from; to }>; continuations: Array<string>;
//     records: Array<{ table; id }> } | { found: false; code: 'PLACE_NOT_FOUND' }

const DEPTH = 9;
const level = (n: number): string => `place:level-${n}`;
const INTERNAL = internalContext();
const ALL = { interfaceId: null, authorityId: null, rootsOnly: false };

/** A chain deeper than six, two authorities with one native key, a cycle, an orphan, a continuation, a DM and a retired room. */
function seed(db: Db): void {
  const zeta = { iface: 'zeta', authority: 'zeta/one' };
  for (let n = 0; n < DEPTH; n += 1)
    addPlace(db, {
      id: level(n),
      ...zeta,
      kind: n === 0 ? 'server' : 'channel',
      parent: n === 0 ? null : level(n - 1),
      name: `λ${n}`,
    });
  for (let n = 0; n < DEPTH; n += 1)
    addDescription(db, {
      id: `desc:${n}`,
      subjectKind: 'place',
      subject: level(n),
      field: 'topic',
      audience: 'aud:group:zeta',
      text: `the words of level ${n}`,
    });
  addPlace(db, { id: 'place:same-a', iface: 'zeta', authority: 'zeta/one', nativeKey: 'same-key' });
  addPlace(db, { id: 'place:same-b', iface: 'zeta', authority: 'zeta/two', nativeKey: 'same-key' });
  addPlace(db, { id: 'place:other-root', iface: 'eta', authority: 'eta/one' });
  addPlace(db, { id: 'place:cycle-a', ...zeta });
  addPlace(db, { id: 'place:cycle-b', ...zeta, parent: 'place:cycle-a' });
  db.prepare("UPDATE places SET parent_id = 'place:cycle-b' WHERE id = 'place:cycle-a'").run();
  withoutForeignKeys(db, () => {
    addPlace(db, { id: 'place:orphan', ...zeta, parent: 'place:gone' });
  });
  addPlace(db, { id: 'place:old-dm', iface: 'zeta', authority: 'zeta/one', chat: 'dm', kind: 'dm' });
  addPlace(db, { id: 'place:continued', ...zeta, continues: 'place:old-dm' });
  addPlace(db, { id: 'place:retired', ...zeta, parent: level(0), retiredAt: '2026-11-03T00:00:00.000Z' });
  addDescription(db, {
    id: 'desc:private',
    subjectKind: 'place',
    subject: 'place:old-dm',
    field: 'topic',
    audience: 'aud:dm:place:old-dm',
    text: 'the private note',
  });
  readAddSource(db, {
    id: 'source:deep',
    place: level(DEPTH - 1),
    iface: 'zeta',
    audience: 'aud:group:zeta',
    text: 'βάθος',
  });
  db.prepare(
    `INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, audience_id, scope_kind, created_at)
     VALUES ('claim:lore', 'place', ?, 'lore', 'the lore', 'current', 1, 'aud:group:zeta', 'group', '2026-11-01T00:00:00.000Z')`
  ).run(level(1));
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

function everyPlace(db: Db, context: Context = INTERNAL, filters = ALL, limit = 3): Array<PlaceListing> {
  const items: Array<PlaceListing> = [];
  let cursor: string | null = null;
  for (let turn = 0; turn < 1000; turn += 1) {
    const page: Page<PlaceListing> = listPlaces(db, { context, filters, limit, cursor });
    items.push(...page.items);
    if (page.next === null) return items;
    cursor = page.next;
  }
  throw new Error('the pages never end');
}

function found(view: PlaceDetail): Extract<PlaceDetail, { found: true }> {
  assert.equal(view.found, true);
  return view;
}
const idsOf = (items: ReadonlyArray<{ id: string }>): Array<string> => items.map((one) => one.id).sort();
const entry = (db: Db, id: string): PlaceListing | undefined => everyPlace(db).find((one) => one.id === id);

// ---------- the list ----------

test('every place of every interface is listed exactly once across pages, retired and orphaned ones included', () => {
  // Bug: the list starts at the interface's server, so a root DM, an orphan or a second interface is invisible.
  withWorld((db) => {
    const direct = db
      .prepare('SELECT id FROM places ORDER BY id')
      .all()
      .map((row) => String(row.id));
    const listed = everyPlace(db).map((one) => one.id);
    assert.equal(new Set(listed).size, listed.length, 'a place repeats across pages');
    assert.deepEqual([...listed].sort(), direct);
  });
});

test('equal native keys under different authorities stay two places, and the authority filter selects one before paging', () => {
  // Bug: a place is keyed by its native key, and the second authority's room overwrites the first.
  withWorld((db) => {
    const same = everyPlace(db).filter((one) => one.nativeKey === 'same-key');
    assert.deepEqual(idsOf(same), ['place:same-a', 'place:same-b']);
    const two = { ...ALL, authorityId: 'zeta/two' };
    const page = listPlaces(db, { context: INTERNAL, filters: two, limit: 1, cursor: null });
    assert.deepEqual([page.items.map((one) => one.id), page.total, page.next], [['place:same-b'], 1, null]);
  });
});

test('the interface filter applies before the count', () => {
  withWorld((db) => {
    const page = listPlaces(db, { context: INTERNAL, filters: { ...ALL, interfaceId: 'eta' }, limit: 5, cursor: null });
    assert.deepEqual([page.items.map((one) => one.id), page.total], [['place:other-root'], 1]);
  });
});

test('roots are the places without a stored parent, an orphan among them, and a cycle is not lost from the list', () => {
  // Bug: `parent_id IS NULL` hides the orphan, and following parents to a top never ends for a cycle.
  withWorld((db) => {
    const roots = idsOf(everyPlace(db, INTERNAL, { ...ALL, rootsOnly: true }));
    assert.ok(roots.includes(level(0)));
    assert.ok(roots.includes('place:orphan'));
    assert.ok(roots.includes('place:other-root'));
    assert.equal(roots.includes(level(1)), false);
    assert.ok(everyPlace(db).some((one) => one.id === 'place:cycle-a'));
  });
});

test('a listing says how its parent stands', () => {
  // Bug: a dangling parent id reads as an ordinary one, and expanding it opens nothing.
  withWorld((db) => {
    assert.equal(entry(db, level(0))?.parentState, 'none');
    assert.equal(entry(db, level(1))?.parentState, 'stored');
    assert.equal(entry(db, 'place:orphan')?.parentState, 'missing');
    assert.equal(entry(db, 'place:orphan')?.parentId, 'place:gone');
  });
});

test('a listing keeps its authority, native key, generation and chat', () => {
  withWorld((db) => {
    const dm = entry(db, 'place:old-dm');
    assert.deepEqual(
      [dm?.interfaceId, dm?.authorityId, dm?.nativeKey, dm?.generation, dm?.chat, dm?.kind],
      ['zeta', 'zeta/one', 'place:old-dm', 1, 'dm', 'dm']
    );
    assert.equal(entry(db, 'place:retired')?.retiredAt, '2026-11-03T00:00:00.000Z');
  });
});

// ---------- depth ----------

test('a listing counts its children, retired ones too', () => {
  withWorld((db) => {
    assert.equal(entry(db, level(0))?.childCount, 2);
    assert.equal(entry(db, level(DEPTH - 1))?.childCount, 0);
  });
});

test('include-children gathers the descriptions of the place and every descendant', () => {
  // Bug: `/memory server` reads one level, so a channel's description under a category is lost.
  withWorld((db) => {
    const view = found(placeDetail(db, level(0), { context: INTERNAL, includeChildren: true }));
    assert.deepEqual(
      view.descriptions.map((one) => [one.placeId, one.text]).sort(),
      Array.from({ length: DEPTH }, (_, n) => [level(n), `the words of level ${n}`]).sort()
    );
    const deepest = view.descendants.find((one) => one.id === level(DEPTH - 1));
    assert.equal(deepest?.depth, DEPTH - 1);
  });
});

test('without include-children a place shows its own descriptions and no descendant', () => {
  withWorld((db) => {
    const view = found(placeDetail(db, level(3), { context: INTERNAL, includeChildren: false }));
    assert.deepEqual(
      view.descriptions.map((one) => one.id),
      ['desc:3']
    );
    assert.deepEqual(view.descendants, []);
  });
});

test('a cycle ends with an explicit reference and each place once', () => {
  // Bug: a recursive read loops until the stack or the row cap, or stops silently as if the tree ended.
  withWorld((db) => {
    const view = found(placeDetail(db, 'place:cycle-a', { context: INTERNAL, includeChildren: true }));
    assert.deepEqual(
      view.descendants.map((one) => one.id),
      ['place:cycle-b']
    );
    assert.deepEqual(view.cycles, [{ from: 'place:cycle-b', to: 'place:cycle-a' }]);
  });
});

test('a self-parent is a cycle too', () => {
  withWorld((db) => {
    addPlace(db, { id: 'place:self', iface: 'zeta', authority: 'zeta/one' });
    db.prepare("UPDATE places SET parent_id = 'place:self' WHERE id = 'place:self'").run();
    const view = found(placeDetail(db, 'place:self', { context: INTERNAL, includeChildren: true }));
    assert.deepEqual([view.descendants, view.cycles], [[], [{ from: 'place:self', to: 'place:self' }]]);
  });
});

test('a continuation link is shown as one and is not containment', () => {
  // Bug: `continues_place_id` is read as a second parent, and a group appears inside the DM it grew from.
  withWorld((db) => {
    assert.equal(entry(db, 'place:continued')?.continuesPlaceId, 'place:old-dm');
    assert.equal(entry(db, 'place:continued')?.parentState, 'none');
    assert.deepEqual(
      found(placeDetail(db, 'place:old-dm', { context: INTERNAL, includeChildren: true })).continuations,
      ['place:continued']
    );
  });
});

test('detail opens the exact records of a place by id, its lines and its lore', () => {
  withWorld((db) => {
    assert.deepEqual(found(placeDetail(db, level(DEPTH - 1), { context: INTERNAL, includeChildren: false })).records, [
      { table: 'sources', id: 'source:deep' },
    ]);
    assert.deepEqual(found(placeDetail(db, level(1), { context: INTERNAL, includeChildren: false })).records, [
      { table: 'claims', id: 'claim:lore' },
    ]);
  });
});

test('a place nobody stored is a named refusal, and so is expanding it', () => {
  withWorld((db) => {
    assert.deepEqual(placeDetail(db, 'place:unknown', { context: INTERNAL, includeChildren: true }), {
      found: false,
      code: 'PLACE_NOT_FOUND',
    });
  });
});

// ---------- the context decides first ----------

test('a group context neither lists nor counts a DM place', () => {
  // Bug: the list is filtered after the total, and a preview shows how many private chats exist.
  withWorld((db) => {
    const context = groupContext('zeta');
    const page = listPlaces(db, { context, filters: ALL, limit: 500, cursor: null });
    assert.equal(
      page.items.some((one) => one.id === 'place:old-dm'),
      false
    );
    assert.equal(page.total, page.items.length);
    assert.equal(found(placeDetail(db, 'place:old-dm', { context, includeChildren: false })).descriptions.length, 0);
  });
});

test('the owner reads the private description the group cannot', () => {
  withWorld((db) => {
    assert.deepEqual(
      found(placeDetail(db, 'place:old-dm', { context: INTERNAL, includeChildren: false })).descriptions.map(
        (one) => one.text
      ),
      ['the private note']
    );
  });
});

test('a call without a valid context is refused', () => {
  withWorld((db) => {
    const bad = wrongly<Context>({});
    assert.throws(() => listPlaces(db, { context: bad, filters: ALL, limit: 5, cursor: null }));
    assert.throws(() => placeDetail(db, level(0), { context: bad, includeChildren: false }));
  });
});

test('a cursor is bound to its context and filters', () => {
  withWorld((db) => {
    const first = listPlaces(db, { context: INTERNAL, filters: ALL, limit: 1, cursor: null });
    const code = { code: 'INSPECTION_BAD_CURSOR' };
    assert.throws(
      () => listPlaces(db, { context: groupContext('zeta'), filters: ALL, limit: 1, cursor: first.next }),
      code
    );
    assert.throws(
      () => listPlaces(db, { context: INTERNAL, filters: { ...ALL, rootsOnly: true }, limit: 1, cursor: first.next }),
      code
    );
  });
});

test('an empty database lists nothing and completes', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const page = listPlaces(dbOf(handle), { context: INTERNAL, filters: ALL, limit: 5, cursor: null });
    assert.deepEqual([page.items, page.total, page.next], [[], 0, null]);
  } finally {
    handle.close();
  }
});

// ---------- no write ----------

test('the reader runs over a read-only connection and changes no row', () => {
  const file = join(tempDir('nep-places-read-'), 'memory.db');
  const writer = openMemoryDb(file);
  seed(dbOf(writer));
  writer.close();
  const reader = openMemoryDb(file, { readOnly: true });
  try {
    const db = dbOf(reader);
    const before = databaseDigest(db);
    for (const place of everyPlace(db)) {
      placeDetail(db, place.id, { context: INTERNAL, includeChildren: true });
    }
    assert.deepEqual(databaseDigest(db), before);
  } finally {
    reader.close();
  }
});
