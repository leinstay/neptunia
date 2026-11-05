// src/memory/db/domain-read.ts: the owner's typed detail of each memory family. A detail keeps every stored field exactly and
// links to the exact records around it by id: a claim to all its versions, a version to the source revisions it rests on, a
// publication to its grant, a turn to the versions it read. Retired and internal records open like any other, for a context
// that may read them. Plan 2026-11-04-cli-and-memory task 10; S9 reruns this over semantic records. Contract:
//   domainDetail(db: Db, request: { family: DomainFamily; id: string; context: Context }): DomainDetail
//   domainList(db: Db, request: { family: DomainFamily; context: Context; limit: number; cursor: string | null }):
//     Page<{ family: DomainFamily; id: string }>
//   DomainFamily = 'sources' | 'claims' | 'claim_versions' | 'descriptions' | 'description_versions' | 'episodes' | 'diary'
//     | 'media' | 'publications' | 'grants' | 'sessions' | 'requests' | 'turns'
//   DomainDetail = { found: true; family: DomainFamily; id: string; rows: Array<InspectionRow>;
//     links: Array<{ family: DomainFamily; id: string; role: string }> } | { found: false; code: 'RECORD_NOT_FOUND' }
// `rows` holds one typed row, and for a turn one row per `turn_reads` row. Link roles: `version`, `claim`, `description`,
// `source`, `supports`, `conflicts`, `revision`, `evidence`, `publication`, `grant`, `request`, `read`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { domainDetail, domainList } from '../src/memory/db/domain-read.ts';
import type { DomainDetail, DomainFamily } from '../src/memory/db/domain-read.ts';
import type { Page } from '../src/memory/db/inspection.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { groupContext, internalContext } from '../src/memory/db/scope.ts';
import type { Context } from '../src/memory/db/scope.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { wrongly } from './fixtures/loose-types.ts';
import {
  addAuthority,
  addDescription,
  addPlace,
  addSource,
  cell,
  databaseDigest,
} from './fixtures/memory-db/browser-world.ts';
import { tempDir } from './fixtures/tmp.ts';

const AT = '2026-11-01T00:00:00.000Z';
const LATER = '2026-11-03T00:00:00.000Z';
const INTERNAL = internalContext();
const RECEIPTS = ' [ {"native" : "m1"} ] ';
const REQUEST_TEXT = 'the system text, stored whole: ζωή';

/** One record of every family, with the retired, internal and revised rows a domain view tends to drop. */
function seedDomains(db: Db): void {
  addAuthority(db, 'zeta', 'zeta/one');
  addPlace(db, { id: 'place:room', iface: 'zeta', authority: 'zeta/one' });
  addPlace(db, { id: 'place:dm', iface: 'zeta', authority: 'zeta/one', conversation: 'dm', kind: 'dm' });
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
    `INSERT INTO publication_grants (id, row_kind, row_id, content_hash, destinations, approved_by, approved_at)
     VALUES ('grant:1', 'diary', 'diary:1', 'hash-1', '["place:room"]', 'owner', ?)`
  ).run(AT);
  db.prepare(
    `INSERT INTO publications (id, row_kind, row_id, content_hash, rendered, destination_place_id, grant_id, status, idempotency_key, receipts, created_at, retired_at)
     VALUES ('publication:1', 'diary', 'diary:1', 'hash-1', 'dear diary', 'place:room', 'grant:1', 'sent', 'key-1', ?, ?, ?)`
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

test('a diary entry links its publications, a publication its grant, and a grant its publications', () => {
  // Bug: publication state is read from the entry, and a receipt or a grant has no route at all.
  withWorld((db) => {
    assert.deepEqual(linksOf(open(db, 'diary', 'diary:1')), ['publication publications publication:1']);
    assert.deepEqual(linksOf(open(db, 'publications', 'publication:1')), ['grant grants grant:1']);
    assert.deepEqual(linksOf(open(db, 'grants', 'grant:1')), ['publication publications publication:1']);
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
      ['grants', 'grant:1'],
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
