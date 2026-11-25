// Tests for src/memory/db/domain-read.ts: the owner's typed detail of each memory family. A detail keeps every stored
// field exactly and links to the exact records around it by id: a claim to all its versions, a version to the source
// revisions it rests on, a turn to the versions it read, a media row to the lines that show it. Retired and internal
// records open like any other, for a context that may read them. Contract:
//   domainDetail(db: Db, request: { family: DomainFamily; id: string; context: Context }): DomainDetail
//   domainList(db: Db, request: { family: DomainFamily; context: Context; limit: number; cursor: string | null }):
//     Page<{ family: DomainFamily; id: string }>
//   DomainFamily = 'sources' | 'claims' | 'claim_versions' | 'descriptions' | 'description_versions' | 'episodes' | 'diary'
//     | 'media' | 'publications' | 'sessions' | 'requests' | 'turns'
//   DomainDetail = { found: true; family: DomainFamily; id: string; rows: Array<InspectionRow>;
//     links: Array<{ family: DomainFamily; id: string; role: string }> } | { found: false; code: 'RECORD_NOT_FOUND' }
// `rows` holds one typed row, and for a turn one row per `turn_reads` row. Link roles: `version`, `claim`, `description`,
// `source`, `supports`, `conflicts`, `revision`, `evidence`, `publication`, `request`, `read`.
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { domainDetail, domainList, versionsOf } from '../../../../src/memory/db/domain-read.ts';
import type { DomainDetail, DomainFamily } from '../../../../src/memory/db/domain-read.ts';
import type { Page, InspectionRow } from '../../../../src/memory/db/inspection.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { groupContext, internalContext } from '../../../../src/memory/db/scope.ts';
import type { Context } from '../../../../src/memory/db/scope.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db, Row } from '../../../../src/memory/db/types.ts';
import { wrongly } from '../../../fixtures/loose-types.ts';
import {
  addAuthority,
  addDescription,
  addPlace,
  addSource,
  cell,
  databaseDigest,
} from '../../../fixtures/memory-db/browser-world.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { KINDS, fixture, observeLine, PRESENCES } from '../../../fixtures/media-memory.ts';
import { mkdirSync } from 'node:fs';
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
  addSource as semanticAddSource,
  candidate,
  commit,
  sameAs,
  semanticWorld,
  successor,
  worksOn,
} from '../../../fixtures/memory-db/semantic-world.ts';
import type { World } from '../../../fixtures/memory-db/semantic-world.ts';
import { fillStems } from '../../../../src/memory/db/stems.ts';
import type { Env, Kind, Presence } from '../../../fixtures/media-memory.ts';

const AT = '2026-11-01T00:00:00.000Z';
const LATER = '2026-11-03T00:00:00.000Z';
const INTERNAL = internalContext();
const RECEIPTS = ' [ {"native" : "m1"} ] ';
const REQUEST_TEXT = 'the system text, stored whole: ζωή';

/** One record of every family, with the retired, internal and revised rows a domain view tends to drop. */
function seedDomains(db: Db): void {
  addAuthority(db, 'zeta', 'zeta/one');
  addPlace(db, { id: 'place:room', iface: 'zeta', authority: 'zeta/one' });
  addPlace(db, { id: 'place:dm', iface: 'zeta', authority: 'zeta/one', chat: 'dm', kind: 'dm' });
  const line = { place: 'place:room', iface: 'zeta', audience: 'aud:group:zeta', nativeId: 'native-1' };
  addSource(db, { ...line, id: 'source:r0', revision: 0, text: 'first words' });
  addSource(db, { ...line, id: 'source:r1', revision: 1, text: 'edited words' });
  addSource(db, {
    id: 'source:gone',
    place: 'place:room',
    iface: 'zeta',
    audience: 'aud:group:zeta',
    nativeId: 'native-2',
    text: 'gone',
    retiredAt: LATER,
  });
  addSource(db, {
    id: 'source:private',
    place: 'place:dm',
    iface: 'zeta',
    audience: 'aud:dm:place:dm',
    nativeId: 'native-3',
    text: 'private',
  });
  const claim = db.prepare(
    `INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, audience_id, scope_kind, retired_at, created_at)
     VALUES (?, 'place', 'place:room', 'detail', ?, 'current', 1, ?, ?, ?, ?)`
  );
  claim.run('claim:public', 'public claim', 'aud:group:zeta', 'group', null, AT);
  claim.run('claim:retired', 'retired claim', 'aud:group:zeta', 'group', LATER, AT);
  claim.run('claim:internal', 'internal claim', 'aud:internal', 'internal', null, AT);
  claim.run('claim:private', 'private claim', 'aud:dm:place:dm', 'dm', null, AT);
  const version = db.prepare(
    `INSERT INTO claim_versions (id, claim_id, text, recorded_at, event, by, origin, retired_at) VALUES (?, ?, ?, ?, 'edit', 'synthetic', 'synthetic', ?)`
  );
  version.run('version:v1', 'claim:public', 'first text', AT, LATER);
  version.run('version:v2', 'claim:public', 'second text', LATER, null);
  version.run('version:private', 'claim:private', 'private text', AT, null);
  const evidence = db.prepare('INSERT INTO claim_version_sources (version_id, source_id, role) VALUES (?, ?, ?)');
  evidence.run('version:v1', 'source:r0', 'supports');
  evidence.run('version:v2', 'source:r1', 'supports');
  evidence.run('version:v2', 'source:gone', 'conflicts');
  evidence.run('version:private', 'source:private', 'supports');
  db.prepare(
    "INSERT INTO claim_sources (claim_id, source_id, position, id) VALUES ('claim:public', 'source:r0', 0, 'cs:1')"
  ).run();
  addDescription(db, {
    id: 'desc:1',
    subjectKind: 'place',
    subject: 'place:room',
    field: 'topic',
    audience: 'aud:group:zeta',
    text: 'the topic',
  });
  db.prepare(
    `INSERT INTO description_versions (id, description_id, text, author, written_at, chars, origin, retired_at)
     VALUES ('desc:1:v0', 'desc:1', 'the old topic', 'synthetic', ?, 13, 'synthetic', ?)`
  ).run(AT, LATER);
  db.prepare(
    `INSERT INTO episodes (id, kind, subject_id, place_id, date, what, audience_id, scope_kind, created_at)
     VALUES ('episode:1', 'group', 'person:x', 'place:room', '2026-11-01', 'it happened', 'aud:group:zeta', 'group', ?)`
  ).run(AT);
  db.prepare(
    "INSERT INTO episode_sources (episode_id, source_id, position, id) VALUES ('episode:1', 'source:r0', 0, 'es:1')"
  ).run();
  db.prepare(
    "INSERT INTO diary (id, at_ms, kind, text, status, audience_id, scope_kind) VALUES ('diary:1', 1, 'entry', 'dear diary', 'done', 'aud:group:zeta', 'group')"
  ).run();
  db.prepare(
    "INSERT INTO media (id, kind, owner, path, description, audience_id, scope_kind) VALUES ('media:1', 'image', 'synthetic', 'media/a.png', 'a picture', 'aud:group:zeta', 'group')"
  ).run();
  db.prepare(
    `INSERT INTO publications (id, row_kind, row_id, content_hash, rendered, destination_place_id, status, idempotency_key, receipts, created_at, retired_at)
     VALUES ('publication:1', 'diary', 'diary:1', 'hash-1', 'dear diary', 'place:room', 'sent', 'key-1', ?, ?, ?)`
  ).run(RECEIPTS, AT, LATER);
  db.prepare(
    `INSERT INTO session_runs (id, sweep_id, scope_key, mode, started_at, outcome, counts, result, audience_id)
     VALUES ('session:1', 'sweep:1', 'scope', 'apply', ?, 'ok', '{"a":1}', 'the result', 'aud:internal')`
  ).run(AT);
  db.prepare(
    `INSERT INTO model_requests (id, schema_version, turn_id, step, role, purpose, status, started_at, system_text, messages, response_text)
     VALUES ('request:1', 1, 'turn:1', 0, 'core', 'turn', 'ok', ?, ?, '[]', 'the reply')`
  ).run(AT, REQUEST_TEXT);
  const read = db.prepare(
    `INSERT INTO turn_reads (turn_id, step, context_id, row_kind, row_id, block, ord, version_id, revision, reader_kind) VALUES ('turn:1', '0', '', ?, ?, 'memory', ?, ?, ?, 'turn')`
  );
  read.run('claim', 'claim:public', 0, 'version:v1', null);
  read.run('source', 'source:r1', 1, null, 1);
}

function withWorld(body: (db: Db) => void): void {
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    seedDomains(db);
    body(db);
  } finally {
    handle.close();
  }
}

type Found = Extract<DomainDetail, { found: true }>;

function open(db: Db, family: DomainFamily, id: string, context: Context = INTERNAL): Found {
  const view = domainDetail(db, { family, id, context });
  assert.ok(view.found, `${family} ${id} did not open`);
  return view;
}
const linksOf = (view: Found): Array<string> => view.links.map((one) => `${one.role} ${one.family} ${one.id}`).sort();

// ---------- exact links ----------

test('a claim links every version, the retired one too, and its claim-level sources', () => {
  // Bug: the detail reads the newest live version, so the history behind a changed claim is unreachable.
  withWorld((db) => {
    assert.deepEqual(linksOf(open(db, 'claims', 'claim:public')), [
      'source sources source:r0',
      'version claim_versions version:v1',
      'version claim_versions version:v2',
    ]);
  });
});

test('a claim version links its claim and the exact source revisions, with their evidence role', () => {
  // Bug: evidence resolves through the native id to the newest revision, not the one this version rested on.
  withWorld((db) => {
    assert.deepEqual(linksOf(open(db, 'claim_versions', 'version:v1')), [
      'claim claims claim:public',
      'supports sources source:r0',
    ]);
    assert.deepEqual(linksOf(open(db, 'claim_versions', 'version:v2')), [
      'claim claims claim:public',
      'conflicts sources source:gone',
      'supports sources source:r1',
    ]);
  });
});

test('a source links its other revisions and the versions that rest on it', () => {
  withWorld((db) => {
    assert.deepEqual(linksOf(open(db, 'sources', 'source:r0')), [
      'evidence claim_versions version:v1',
      'revision sources source:r1',
    ]);
  });
});

test('a description links all its versions, and a version links back', () => {
  withWorld((db) => {
    assert.deepEqual(linksOf(open(db, 'descriptions', 'desc:1')), [
      'version description_versions desc:1:v0',
      'version description_versions desc:1:v1',
    ]);
    assert.deepEqual(linksOf(open(db, 'description_versions', 'desc:1:v0')), ['description descriptions desc:1']);
  });
});

test('an episode links its sources', () => {
  withWorld((db) => {
    assert.deepEqual(linksOf(open(db, 'episodes', 'episode:1')), ['source sources source:r0']);
  });
});

test('a diary entry links its publications', () => {
  // Bug: publication state is read from the entry, and a receipt has no route at all.
  withWorld((db) => {
    assert.deepEqual(linksOf(open(db, 'diary', 'diary:1')), ['publication publications publication:1']);
  });
});

test('a turn links the exact versions and revisions it read, and its requests', () => {
  // Bug: a read resolves to the claim's current version, so what the turn saw is rewritten by what came after.
  withWorld((db) => {
    const turn = open(db, 'turns', 'turn:1');
    assert.equal(turn.rows.length, 2);
    assert.deepEqual(linksOf(turn), [
      'read claim_versions version:v1',
      'read sources source:r1',
      'request requests request:1',
    ]);
  });
});

test('every link of every record opens, whatever its state', () => {
  // Bug: a link names a family or id its own reader then cannot open.
  withWorld((db) => {
    const seeds: Array<[DomainFamily, string]> = [
      ['claims', 'claim:public'],
      ['claims', 'claim:retired'],
      ['claims', 'claim:internal'],
      ['sources', 'source:gone'],
      ['descriptions', 'desc:1'],
      ['episodes', 'episode:1'],
      ['diary', 'diary:1'],
      ['media', 'media:1'],
      ['publications', 'publication:1'],
      ['sessions', 'session:1'],
      ['requests', 'request:1'],
      ['turns', 'turn:1'],
    ];
    const seen = new Set<string>();
    const queue = [...seeds];
    while (queue.length > 0) {
      const [family, id] = queue.pop() ?? ['claims', ''];
      if (seen.has(`${family} ${id}`)) continue;
      seen.add(`${family} ${id}`);
      for (const link of open(db, family, id).links) queue.push([link.family, link.id]);
    }
    assert.ok(seen.has('claim_versions version:v1'));
    assert.ok(seen.has('sources source:r1'));
  });
});

// ---------- full fields ----------

test('a detail keeps every stored column, exactly', () => {
  // Bug: a receipt is parsed and printed again, a request's system text is clipped for the screen.
  withWorld((db) => {
    const publication = open(db, 'publications', 'publication:1').rows[0];
    assert.deepEqual(cell(publication, 'receipts'), { kind: 'text', value: RECEIPTS });
    assert.deepEqual(cell(publication, 'retired_at'), { kind: 'text', value: LATER });
    const request = open(db, 'requests', 'request:1').rows[0];
    assert.deepEqual(cell(request, 'system_text'), { kind: 'text', value: REQUEST_TEXT });
    const session = open(db, 'sessions', 'session:1').rows[0];
    assert.deepEqual(cell(session, 'result'), { kind: 'text', value: 'the result' });
    const columns = db
      .prepare('SELECT name FROM pragma_table_xinfo(?)')
      .all('model_requests')
      .map((one) => one.name);
    assert.deepEqual(
      request.values.map((one) => one.column),
      columns
    );
  });
});

test('a turn holds one typed row per read, each with its locator', () => {
  withWorld((db) => {
    const turn = open(db, 'turns', 'turn:1');
    assert.deepEqual(new Set(turn.rows.map((row) => row.locator.kind)), new Set(['primary']));
  });
});

// ---------- lists ----------

for (const [family, expected] of [
  ['claims', ['claim:internal', 'claim:private', 'claim:public', 'claim:retired']],
  ['claim_versions', ['version:private', 'version:v1', 'version:v2']],
  ['media', ['media:1']],
  ['sessions', ['session:1']],
  ['requests', ['request:1']],
  ['turns', ['turn:1']],
] as const) {
  test(`the ${family} list reaches each record once across pages, retired and internal included`, () => {
    withWorld((db) => {
      const ids: Array<string> = [];
      let cursor: string | null = null;
      for (let turn = 0; turn < 100; turn += 1) {
        const page: Page<{ family: DomainFamily; id: string }> = domainList(db, {
          family,
          context: INTERNAL,
          limit: 1,
          cursor,
        });
        ids.push(...page.items.map((one) => one.id));
        assert.equal(page.total, expected.length);
        cursor = page.next;
        if (cursor === null) break;
      }
      assert.deepEqual(ids.sort(), expected);
    });
  });
}

test('a cursor is bound to its family and context', () => {
  withWorld((db) => {
    const first = domainList(db, { family: 'claims', context: INTERNAL, limit: 1, cursor: null });
    const code = { code: 'INSPECTION_BAD_CURSOR' };
    assert.throws(() => domainList(db, { family: 'sources', context: INTERNAL, limit: 1, cursor: first.next }), code);
    assert.throws(
      () => domainList(db, { family: 'claims', context: groupContext('zeta'), limit: 1, cursor: first.next }),
      code
    );
  });
});

// ---------- the context decides first ----------

test('a group context opens neither a private nor an internal record, nor links to one', () => {
  // Bug: a public claim's page shows the private source it rests on, or a list counts what the group cannot open.
  withWorld((db) => {
    const group = groupContext('zeta');
    const closed = { found: false, code: 'RECORD_NOT_FOUND' };
    assert.deepEqual(domainDetail(db, { family: 'claims', id: 'claim:private', context: group }), closed);
    assert.deepEqual(domainDetail(db, { family: 'claims', id: 'claim:internal', context: group }), closed);
    assert.deepEqual(domainDetail(db, { family: 'sources', id: 'source:private', context: group }), closed);
    assert.deepEqual(domainDetail(db, { family: 'claim_versions', id: 'version:private', context: group }), closed);
    const page = domainList(db, { family: 'claims', context: group, limit: 50, cursor: null });
    assert.deepEqual(page.items.map((one) => one.id).sort(), ['claim:public', 'claim:retired']);
    assert.equal(page.total, 2);
  });
});

for (const family of ['requests', 'sessions', 'turns'] as const) {
  test(`${family} are the owner's alone`, () => {
    // Bug: a recorded request holds the persona's whole prompt, DMs included, and has no audience column to filter on.
    withWorld((db) => {
      const page = domainList(db, { family, context: groupContext('zeta'), limit: 50, cursor: null });
      assert.deepEqual([page.items, page.total], [[], 0]);
    });
  });
}

test('a call without a valid context is refused', () => {
  withWorld((db) => {
    const bad = wrongly<Context>({});
    assert.throws(() => domainDetail(db, { family: 'claims', id: 'claim:public', context: bad }));
    assert.throws(() => domainList(db, { family: 'claims', context: bad, limit: 1, cursor: null }));
  });
});

test('a record nobody stored, and a family nobody knows, are refused by name', () => {
  withWorld((db) => {
    assert.deepEqual(domainDetail(db, { family: 'claims', id: 'claim:unknown', context: INTERNAL }), {
      found: false,
      code: 'RECORD_NOT_FOUND',
    });
    assert.throws(
      () =>
        domainDetail(db, { family: wrongly<DomainFamily>('claims; DROP TABLE claims'), id: 'x', context: INTERNAL }),
      {
        code: 'INSPECTION_UNKNOWN_FAMILY',
      }
    );
  });
});

// ---------- no write ----------

test('the reader runs over a read-only connection and changes no row, turn_reads included', () => {
  // Bug: opening a record is recorded as a read of that record, and inspection writes evidence.
  const file = join(tempDir('nep-domain-read-'), 'memory.db');
  const writer = openMemoryDb(file);
  seedDomains(dbOf(writer));
  writer.close();
  const reader = openMemoryDb(file, { readOnly: true });
  try {
    const db = dbOf(reader);
    const before = databaseDigest(db);
    open(db, 'claims', 'claim:public');
    open(db, 'claim_versions', 'version:v2');
    open(db, 'turns', 'turn:1');
    open(db, 'requests', 'request:1');
    open(db, 'publications', 'publication:1');
    domainList(db, { family: 'sources', context: INTERNAL, limit: 5, cursor: null });
    assert.deepEqual(databaseDigest(db), before);
  } finally {
    reader.close();
  }
});

// ---------- the media of a line ----------

// Bug: `/memory media show` lists no links of a media row, so the owner cannot see which
// lines show it. The record of a media row links each line that shows it.
test('owner browser: a media row opens with a link to each line that shows it', () => {
  const env = fixture();
  try {
    const source = observeLine(env, KINDS[0], 'full');
    const row = env.db
      .prepare(
        "SELECT media_id FROM media_links WHERE owner_kind = 'source' AND owner_id = ? ORDER BY position LIMIT 1"
      )
      .get(source);
    assert.ok(row);
    const detail = domainDetail(env.db, { family: 'media', id: String(row.media_id), context: internalContext() });
    assert.equal(detail.found, true);
    const links = detail.found ? detail.links : [];
    assert.deepEqual(
      links.filter((link) => link.family === 'sources').map((link) => link.id),
      [source]
    );
  } finally {
    env.done();
  }
});

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
  const open = semanticAddSource(world, 'public', 'Alex works on Lumen; Orbis met in the room with Mira speaking');
  const secret = semanticAddSource(world, 'alex', 'Mira helps on Lumen; Hidden is mine');
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
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const text = (value: string) => ({ kind: 'text', value });

type SemanticDetail = {
  id: string;
  links: Array<{ family: string; id: string; role: string }>;
  rows: Array<InspectionRow>;
  semantic?: { assertion: InspectionRow; arguments: Array<InspectionRow>; dependencies: Array<InspectionRow> };
};

describe('commands memory semantic', () => {
  after(async () => {
    for (const memory of rigs) await memory.close();
  });

  // ---- /memory claims over semantic versions ---------------------------------------------------------------------------

  test('/memory claims version opens a semantic version with its epistemic row, roles, premises and exact sources', async () => {
    // Bug: the claim route shows the version's text only, so the owner cannot see who plays which role or what it rests on.
    const one = await rig();
    const { kai, works1, open } = one.seeded;
    const detail = data<SemanticDetail>(await one.say('memory', 'claims', 'version', kai.versionId));
    assert.ok(detail.semantic);
    const { assertion, arguments: args, dependencies } = detail.semantic;
    assert.deepEqual(
      ['truth_state', 'polarity', 'how', 'predicate_id'].map((column) => cell(assertion, column)),
      [text('current'), text('positive'), text('inferred'), text('project.works_on')]
    );
    assert.deepEqual(
      args.map((row) => [cell(row, 'role'), cell(row, 'ref_kind'), cell(row, 'ref_id')]).sort(),
      [
        [text('person'), text('person'), text(KAI)],
        [text('project'), text('entity'), text(one.seeded.lumen)],
      ].sort()
    );
    assert.deepEqual(
      dependencies.map((row) => [cell(row, 'premise_version_id'), cell(row, 'role')]),
      [[text(works1.versionId), text('supports')]]
    );
    assert.ok(
      detail.links.some(
        (link) => link.family === 'claim_versions' && link.id === works1.versionId && link.role === 'premise'
      )
    );
    assert.ok(detail.links.some((link) => link.family === 'sources' && link.id === open && link.role === 'supports'));
  });

  test('/memory claims version names the exact revision a fact cites, and that source names its later revision', async () => {
    // Bug: the evidence link follows the line to its newest edit, so the fact appears to rest on words it never read.
    const one = await rig();
    const { works1, open, edited } = one.seeded;
    const detail = data<SemanticDetail>(await one.say('memory', 'claims', 'version', works1.versionId));
    const sources = detail.links.filter((link) => link.family === 'sources').map((link) => link.id);
    assert.deepEqual(sources, [open]);
    const source = data<SemanticDetail>(await one.say('memory', 'sources', 'show', open));
    assert.ok(source.links.some((link) => link.id === edited && link.role === 'revision'));
  });

  test('/memory claims versions opens every version of a changed fact with its own polarity and its dependents', async () => {
    const one = await rig();
    const { works1, works2, kai, mira } = one.seeded;
    const { versions } = data<{ versions: Array<SemanticDetail> }>(
      await one.say('memory', 'claims', 'versions', works1.claimId)
    );
    assert.deepEqual(
      versions.map((version) => version.id),
      [works1.versionId, works2.versionId]
    );
    assert.deepEqual(
      versions.map((version) => (version.semantic ? cell(version.semantic.assertion, 'polarity') : null)),
      [text('positive'), text('negative')]
    );
    const firstVersion = versions[0];
    const dependents = firstVersion?.links
      .filter((link) => link.role === 'dependent')
      .map((link) => link.id)
      .sort();
    assert.deepEqual(dependents, [kai.versionId, mira.versionId].sort());
    assert.deepEqual(
      data(await one.say('memory', 'claims', 'versions', works1.claimId)),
      json(versionsOf(one.db, { family: 'claims', id: works1.claimId, context: INTERNAL }))
    );
  });

  test('/memory claims show opens a semantic claim with every version it holds', async () => {
    const one = await rig();
    const { works1, works2 } = one.seeded;
    const detail = data<SemanticDetail>(await one.say('memory', 'claims', 'show', works1.claimId));
    assert.deepEqual(
      detail.links.filter((link) => link.role === 'version').map((link) => link.id),
      [works1.versionId, works2.versionId]
    );
  });

  test('a plain claim version opens with no semantic payload', async () => {
    // Bug: an empty semantic block on a plain version reads as a structured fact with no roles.
    const one = await rig();
    const db = one.db;
    db.prepare(
      `INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, audience_id, scope_kind, created_at)
     VALUES ('claim:plain', 'place', ?, 'detail', 'a plain fact', 'current', 1, 'aud:internal', 'internal', '2026-11-01T00:00:00.000Z')`
    ).run(ROOM);
    db.prepare(
      `INSERT INTO claim_versions (id, claim_id, text, recorded_at, event, by, origin) VALUES ('version:plain', 'claim:plain', 'a plain fact', '2026-11-01T00:00:00.000Z', 'edit', 's', 's')`
    ).run();
    const detail = data<SemanticDetail>(await one.say('memory', 'claims', 'version', 'version:plain'));
    assert.equal(detail.id, 'version:plain');
    assert.equal(detail.semantic, undefined);
  });

  test('a public premise shows a group its public dependent and never the DM one', async () => {
    // Bug: the dependent link is not filtered, so a group learns that a hidden conclusion rests on a public fact.
    const one = await rig();
    const { works1, kai, mira, contexts } = one.seeded;
    const dependents = (context: Context) => {
      const detail = domainDetail(one.db, { family: 'claim_versions', id: works1.versionId, context });
      return detail.found
        ? detail.links
            .filter((link) => link.role === 'dependent')
            .map((link) => link.id)
            .sort()
        : null;
    };
    assert.deepEqual(dependents(INTERNAL), [kai.versionId, mira.versionId].sort());
    assert.deepEqual(dependents(contexts.group), [kai.versionId]);
    assert.deepEqual(dependents(contexts.mira), [kai.versionId]);
  });

  test('the name claim of a DM entity is not opened for a group by any claim route', async () => {
    const one = await rig();
    const { hiddenName, contexts } = one.seeded;
    assert.equal(domainDetail(one.db, { family: 'claims', id: hiddenName.claimId, context: INTERNAL }).found, true);
    for (const family of ['claims', 'claim_versions'] as const) {
      const id = family === 'claims' ? hiddenName.claimId : hiddenName.versionId;
      assert.deepEqual(domainDetail(one.db, { family, id, context: contexts.group }), {
        found: false,
        code: 'RECORD_NOT_FOUND',
      });
    }
    assert.deepEqual(versionsOf(one.db, { family: 'claims', id: hiddenName.claimId, context: contexts.group }), {
      found: false,
      code: 'RECORD_NOT_FOUND',
    });
  });
});

async function withLine(kind: Kind, presence: Presence, body: (env: Env, source: string) => void | Promise<void>) {
  const env = fixture();
  try {
    const source = observeLine(env, kind, presence);
    fillStems(env.db);
    await body(env, source);
  } finally {
    env.done();
  }
}

for (const kind of KINDS) {
  for (const presence of PRESENCES) {
    test(`owner browser: a ${kind.name} opens with its media and its text form, ${presence}`, () =>
      withLine(kind, presence, (env, source) => {
        const detail = domainDetail(env.db, { family: 'sources', id: source, context: internalContext() }) as Row;
        assert.equal(detail.found, true);
        const media = detail.media as Array<{ kind: string; description: string | null; availability: string }>;
        assert.ok(Array.isArray(media) && media.length >= 1, 'the record lists its media');
        assert.equal(media[0].kind, kind.stored);
        assert.equal(media[0].availability, presence === 'absent' ? 'unknown' : 'present');
        assert.equal((media[0].description ?? '').includes(kind.first.word), presence !== 'absent');
      }));
  }
}
