// Tests for src/memory/db/graph.ts: the graph projection and its manifest, on a fixture of two interfaces with a group,
// a thread, a DM and a private link between two public nodes: truncation reports, re-projection after an edit, a link
// revocation and a retirement, the three contracts (a replay of the unit writes re-projects to the same rows, the
// VACUUM round trip, rebuildability), version-level evidence and the compare-and-set on claim edits. The last section
// holds the projection of semantic assertions. Synthetic text only (Greek or accented Latin for non-ASCII); the ids and
// handles are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { seedUnits } from '../../../fixtures/memory-db/seed.ts';
import { insertRows } from '../../../../src/memory/db/rows.ts';
import { OBSERVATION_VERSION, observe } from '../../../../src/memory/db/observe.ts';
import { applyMemoryWrite, newestClaimVersion } from '../../../../src/memory/db/session-write.ts';
import { DEFERRED, NODE_KINDS, PREDICATES, UNIT_OF, UNIT_ORDER } from '../../../../src/memory/db/graph-manifest.ts';
import {
  graphNodeId,
  graphPending,
  projectRow,
  rebuildGraph,
  reproject,
  walk,
} from '../../../../src/memory/db/graph.ts';
import { dmContext, groupContext, groupScope, internalContext } from '../../../../src/memory/db/scope.ts';
import { tableHashes } from '../../../fixtures/memory-db/table-hashes.ts';
import { buildDataDir } from '../../../fixtures/memory-db/datadir.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import { present, sqlOf, wrongly } from '../../../fixtures/loose-types.ts';
import type { UntypedDb } from '../../../fixtures/loose-types.ts';
import type { Context } from '../../../../src/memory/db/scope.ts';
import {
  ALEX,
  KAI,
  MIRA,
  addEntity,
  addSource,
  commit,
  occurrence,
  partOf,
  semanticWorld,
  successor,
  worksOn,
} from '../../../fixtures/memory-db/semantic-world.ts';
import type { World } from '../../../fixtures/memory-db/semantic-world.ts';

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const at = (minutes: number) => new Date(Date.parse('2026-10-24T10:00:00.000Z') + minutes * 60_000).toISOString();
const count = (db: UntypedDb, sql: string, ...params: Array<unknown>) => db.prepare(sql).get(...params).n;
const GRAPH = ['graph_nodes', 'graph_edges', 'node_access'];
const hashesOf = (db: Record<string, Untyped>, tables: Array<string>) =>
  Object.fromEntries(tableHashes(db, tables).map((entry) => [entry.table, entry.hash]));

// ---------- the manifest ----------

test('the manifest names only tables and columns the schema has, every projected table has a unit, and the spec list is whole', () => {
  const handle = openMemoryDb(':memory:');
  const db = sqlOf(handle);
  try {
    const columns = (table: string) =>
      new Set(
        db
          .prepare(`PRAGMA table_info("${table}")`)
          .all()
          .map((column) => column.name)
      );
    const has = (table: string, column: Untyped) => assert.ok(columns(table).has(column), `${table}.${column}`);
    const deferred: Record<string, unknown> = DEFERRED;
    for (const [kind, spec] of Object.entries(NODE_KINDS)) {
      if (spec.table === null) {
        assert.ok(deferred[kind], `${kind} is deferred with a reason`);
        continue;
      }
      assert.ok(columns(spec.table).size > 0, `${kind}: table ${spec.table}`);
      for (const column of [spec.key, spec.created, spec.createdFallback, spec.audience, spec.retired].filter(Boolean))
        has(spec.table, column);
      if (spec.inherits) has(spec.table, spec.inherits[1]);
    }
    for (const [name, spec] of Object.entries(PREDICATES)) {
      if (spec.table === null) {
        assert.ok(spec.deferred, `${name} is deferred with a reason`);
        continue;
      }
      for (const column of spec.columns) has(spec.table, column);
      for (const [table, list] of Object.entries(wrongly<{ also?: Record<string, Array<string>> }>(spec).also ?? {}))
        for (const column of list) has(table, column);
      for (const kind of [...spec.from, ...spec.to]) assert.ok(NODE_KINDS[kind], `${name}: node kind ${kind}`);
    }
    for (const [table, unit] of Object.entries(UNIT_OF)) {
      assert.ok(columns(table).size > 0, table);
      if (unit) {
        assert.ok(UNIT_ORDER.includes(unit[0]), `${table} -> ${unit[0]}`);
        has(table, unit[1]);
      } else assert.ok(UNIT_ORDER.includes(table), table);
    }
    // The spec's list of node kinds and predicates (section 3), node_facts deferred to its own migration. Semantic memory
    // adds `semantic_entity` and the `asserts`, `denies` and `has_role` edges of an assertion version.
    assert.deepEqual(Object.keys(NODE_KINDS).sort(), [
      'account',
      'authority',
      'claim',
      'claim_version',
      'decision',
      'description',
      'description_version',
      'diary',
      'episode',
      'intention',
      'interface',
      'media',
      'membership',
      'participant',
      'person',
      'place',
      'publication',
      'semantic_entity',
      'skill',
      'source',
      'work',
    ]);
    assert.deepEqual(Object.keys(PREDICATES).sort(), [
      'about',
      'account_of',
      'asserts',
      'authored_by',
      'contained_in',
      'continues',
      'denies',
      'derived_from',
      'follows',
      'has_membership',
      'has_role',
      'located_in',
      'membership_in',
      'mentions',
      'owned_by',
      'participant_of',
      'publication_source',
      'published_as',
      'quotes',
      'replies_to',
      'reposts',
      'supersedes',
      'version_of',
    ]);
    for (const table of ['graph_nodes', 'graph_edges', 'node_access', 'claim_version_sources'])
      assert.ok(columns(table).size > 0, table);
  } finally {
    handle.close();
  }
});

// ---------- the traversal fixture ----------

const D = 'discord/global';
const T = 'telegram/global';
const discordLine = (key: string, minutes: number, over = {}) => ({
  v: OBSERVATION_VERSION,
  iface: 'discord',
  authority: D,
  native: { kind: 'message', key, revision: 0 },
  place: { authority: D, key: 'channel:c1', kind: 'channel', chat: 'group' },
  author: { kind: 'account', key: 'alice-main' },
  occurredAt: at(minutes),
  observedAt: at(minutes),
  text: `line ${key}`,
  relations: [],
  ...over,
});
const dmPlace = { authority: D, key: 'dm:bob', kind: 'dm', chat: 'dm', partner: { key: 'bob' } };
const replyTo = (key: string) => [{ predicate: 'replies_to', target: { kind: 'message', key } }];

/**
 * Discord: a server, a channel in it, a thread in the channel (rows the files bring), lines observed there; a DM with
 * Bob; the persona's own line and replies to it. Telegram: one group. Alice is one person with three accounts: a main
 * Discord account (linked from 10 minutes in, no evidence: public), an alt (linked on evidence from the DM: a private
 * link between two public nodes) and a Telegram account.
 */
function traversalFixture() {
  const handle = openMemoryDb(':memory:');
  const db = sqlOf(handle);
  const opts = { now: () => NOW, log: quiet };
  insertRows(
    db,
    {
      places: [
        {
          id: 'discord:guild:g1',
          iface: 'discord',
          kind: 'guild',
          native_id: 'g1',
          parent_id: null,
          scope_kind: 'group',
          name: 'Server',
        },
        {
          id: 'discord:channel:c1',
          iface: 'discord',
          kind: 'channel',
          native_id: 'c1',
          parent_id: 'discord:guild:g1',
          scope_kind: 'group',
          name: 'general',
        },
        {
          id: 'discord:channel:t1',
          iface: 'discord',
          kind: 'thread',
          native_id: 't1',
          parent_id: 'discord:channel:c1',
          scope_kind: 'group',
          name: 'a thread',
        },
      ],
      people: [{ id: 'person:alice', kind: 'person', first_seen_at: at(0) }],
    },
    { log: quiet, at: at(0) }
  );
  const ids: Record<string, string> = {};
  const put = (name: string, envelope: Record<string, Untyped>) => {
    const done = observe(handle, envelope, opts);
    assert.equal(done.ok, true, `${name}: ${JSON.stringify(done)}`);
    ids[name] = present(done.sourceId);
    return done;
  };
  const early = put('early', discordLine('m0', 5, { text: 'before the link' }));
  put('main', discordLine('m1', 20));
  put('inThread', discordLine('m2', 21, { place: { authority: D, key: 'thread:t1', kind: 'thread', chat: 'group' } }));
  const alt = put('alt', discordLine('m3', 22, { author: { kind: 'account', key: 'alice-alt' } }));
  put(
    'evidence',
    discordLine('d1', 23, { place: dmPlace, author: { kind: 'account', key: 'bob' }, text: 'that alt is Alice' })
  );
  put('persona', discordLine('m4', 30, { author: { kind: 'self', key: 'her' } }));
  put('reply', discordLine('m5', 31, { relations: replyTo('m4') }));
  put(
    'replyToReply',
    discordLine('m6', 32, { author: { kind: 'account', key: 'alice-alt' }, relations: replyTo('m5') })
  );
  put(
    'privateReply',
    discordLine('d2', 33, { place: dmPlace, author: { kind: 'account', key: 'bob' }, relations: replyTo('m4') })
  );
  // Two lines that reply to each other: a cycle.
  put('cycleA', discordLine('y1', 40, { author: { kind: 'account', key: 'carol' }, relations: replyTo('y2') }));
  put('cycleB', discordLine('y2', 41, { author: { kind: 'account', key: 'carol' }, relations: replyTo('y1') }));
  const telegram = put('telegram', {
    ...discordLine('t-1', 25),
    iface: 'telegram',
    authority: T,
    place: { authority: T, key: 'chat:tg1', kind: 'room', chat: 'group' },
    author: { kind: 'account', authority: T, key: 'alice-tg' },
  });
  const accountOf = (done: Record<string, Untyped>) =>
    db.prepare('SELECT author_account FROM sources WHERE id = ?').get(done.sourceId).author_account;
  const accounts = { main: accountOf(early), alt: accountOf(alt), tg: accountOf(telegram) };
  // Each account gets a meta-person of its own with its first line. The links written below stand for the world this
  // fixture describes, where Alice's three accounts are linked to Alice alone, so the core's links of these accounts
  // and their edges are taken out first.
  const alice: Array<string> = [accounts.main, accounts.alt, accounts.tg].map(String);
  db.prepare("DELETE FROM account_person_links WHERE by = 'core' AND account_id IN (?, ?, ?)").run(...alice);
  db.prepare("DELETE FROM graph_edges WHERE predicate = 'account_of' AND src IN (?, ?, ?)").run(
    ...alice.map((account) => graphNodeId('account', account))
  );
  insertRows(
    db,
    {
      account_person_links: [
        {
          id: 'link:main',
          account_id: accounts.main,
          person_id: 'person:alice',
          state: 'verified',
          by: 'owner',
          evidence_id: null,
          valid_from_at: at(10),
          valid_to_at: null,
          recorded_at: at(10),
        },
        {
          id: 'link:alt',
          account_id: accounts.alt,
          person_id: 'person:alice',
          state: 'verified',
          by: 'her',
          evidence_id: ids.evidence,
          valid_from_at: null,
          valid_to_at: null,
          recorded_at: at(23),
        },
        {
          id: 'link:tg',
          account_id: accounts.tg,
          person_id: 'person:alice',
          state: 'verified',
          by: 'owner',
          evidence_id: null,
          valid_from_at: null,
          valid_to_at: null,
          recorded_at: at(25),
        },
      ],
    },
    { log: quiet, at: at(30) }
  );
  const places = {
    channel: 'discord:channel:c1',
    guild: 'discord:guild:g1',
    dm: db.prepare('SELECT place_id FROM sources WHERE id = ?').get(ids.evidence).place_id,
  };
  const ctx = {
    group: groupContext('discord'),
    telegram: groupContext('telegram'),
    dm: dmContext('person:bob-unlinked', 'discord', places.dm),
    internal: internalContext(),
  };
  return { handle, db, ids, accounts, places, ctx };
}

function rowIds(result: { rows: ReadonlyArray<{ rowId: unknown }> }): Array<string> {
  return result.rows.map((row) => {
    assert.ok(typeof row.rowId === 'string', 'a fixture graph row has a text id');
    return row.rowId;
  });
}

function handleTx(env: Record<string, Untyped>, fn: Untyped) {
  return env.handle.transaction(fn);
}

test('truncation reports: the row cap pages with `next`, the depth cap says depth', () => {
  const env = traversalFixture();
  const { db, ctx, places } = env;
  try {
    const inPlace = (opts: { maxRows?: number; maxDepth?: number }) => {
      const result = walk(wrongly(db), ctx.group, {
        ...opts,
        from: graphNodeId('place', places.guild),
        predicates: ['contained_in', 'located_in'],
        direction: 'in',
      });
      return { ...result, rows: result.rows.filter((row) => row.kind === 'source') };
    };
    const all = inPlace({ maxRows: 1000 });
    const first = walk(wrongly(db), ctx.group, {
      from: graphNodeId('place', places.guild),
      predicates: ['contained_in', 'located_in'],
      direction: 'in',
      maxRows: 4,
    });
    assert.deepEqual([first.truncated, first.reason, first.next, first.rows.length], [true, 'rows', 4, 4]);
    const second = walk(wrongly(db), ctx.group, {
      from: graphNodeId('place', places.guild),
      predicates: ['contained_in', 'located_in'],
      direction: 'in',
      maxRows: 4,
      after: wrongly(first.next),
    });
    assert.equal(second.rows.length, 4);
    assert.deepEqual(
      [...first.rows, ...second.rows].map((row) => row.node).slice(0, 8),
      walk(wrongly(db), ctx.group, {
        from: graphNodeId('place', places.guild),
        predicates: ['contained_in', 'located_in'],
        direction: 'in',
      })
        .rows.map((row) => row.node)
        .slice(0, 8),
      'pages follow the one fixed order'
    );
    const shallow = inPlace({ maxDepth: 1 });
    assert.deepEqual([shallow.truncated, shallow.reason], [true, 'depth'], 'the server holds a channel holding more');
    assert.equal(rowIds(shallow).length, 0, 'no line sits in the server itself');
    assert.deepEqual([all.truncated, all.reason], [false, null]);
  } finally {
    env.handle.close();
  }
});

test('re-projection after an edit, a link revocation and a retirement: stale edges retired, no duplicates, the walks follow', () => {
  const env = traversalFixture();
  const { db, ids, ctx, accounts } = env;
  try {
    const live = (predicate: string, src: Untyped) =>
      db
        .prepare('SELECT dst FROM graph_edges WHERE predicate = ? AND src = ? AND retired_at IS NULL ORDER BY dst')
        .all(predicate, src)
        .map((row) => row.dst);
    const keysOf = () =>
      db.prepare('SELECT projection_key, COUNT(*) AS n FROM graph_edges GROUP BY projection_key HAVING n > 1').all();
    // An edit: a line moves to the thread (a writer upserts the row).
    const row = { ...db.prepare('SELECT * FROM sources WHERE id = ?').get(ids.main) };
    delete row.rowid;
    insertRows(db, { sources: [{ ...row, place_id: 'discord:channel:t1' }] }, { log: quiet, at: at(50) });
    const source = graphNodeId('source', ids.main);
    assert.deepEqual(live('located_in', source), [graphNodeId('place', 'discord:channel:t1')]);
    assert.equal(
      count(
        db,
        "SELECT COUNT(*) AS n FROM graph_edges WHERE predicate = 'located_in' AND src = ? AND retired_at IS NOT NULL",
        source
      ),
      1,
      'the old place edge is retired, not deleted'
    );
    assert.deepEqual(keysOf(), [], 'one edge per key');

    // A revocation: the main account's link ends, its lines leave what Alice said.
    handleTx(env, () => {
      db.prepare("UPDATE account_person_links SET state = 'revoked', valid_to_at = ? WHERE id = 'link:main'").run(
        at(60)
      );
      projectRow(wrongly(db), 'account_person_links', { account_id: accounts.main }, { at: at(60) });
    });
    assert.deepEqual(live('account_of', graphNodeId('account', accounts.main)), []);
    assert.equal(
      db
        .prepare("SELECT retired_at FROM graph_edges WHERE predicate = 'account_of' AND src = ?")
        .get(graphNodeId('account', accounts.main)).retired_at,
      at(60),
      'retired at the end of the link'
    );

    // A retirement: the reply leaves; its edges retire with it, its witness goes, the walks lose it.
    handleTx(env, () => {
      db.prepare('UPDATE sources SET retired_at = ? WHERE id = ?').run(at(70), ids.reply);
      projectRow(wrongly(db), 'sources', { id: ids.reply }, { at: at(70) });
    });
    assert.equal(
      count(
        db,
        'SELECT COUNT(*) AS n FROM graph_edges WHERE src = ? AND retired_at IS NULL',
        graphNodeId('source', ids.reply)
      ),
      0
    );
    assert.equal(
      count(
        db,
        'SELECT COUNT(*) AS n FROM graph_edges WHERE src = ? AND retired_at IS NOT ?',
        graphNodeId('source', ids.reply),
        at(70)
      ),
      0,
      "retired at the row's own time"
    );
    assert.equal(
      count(
        db,
        'SELECT COUNT(*) AS n FROM node_access WHERE node_id = ? AND evidence_id = ?',
        graphNodeId('source', ids.reply),
        graphNodeId('source', ids.reply)
      ),
      0,
      'its own witness is gone'
    );
    assert.deepEqual(
      db
        .prepare('SELECT DISTINCT audience_id FROM node_access WHERE node_id = ?')
        .all(graphNodeId('source', ids.reply))
        .map((row) => row.audience_id),
      ['aud:group:discord'],
      'the line replying to it still names it, with its own audience'
    );
    assert.deepEqual(
      rowIds({
        rows: walk(wrongly(db), ctx.group, {
          from: graphNodeId('source', ids.persona),
          predicates: ['replies_to'],
          direction: 'in',
        }).rows.filter((row) => row.node !== graphNodeId('source', ids.persona)),
      }),
      [],
      'the reply to the reply hung off the retired line'
    );
    assert.deepEqual(keysOf(), []);

    // A whole re-projection changes nothing, and twice gives the same hashes.
    const before = hashesOf(db, GRAPH);
    const first = reproject(env.handle);
    assert.ok(first.units > 20);
    assert.equal(first.retired, 0);
    assert.deepEqual(
      hashesOf(db, GRAPH),
      before,
      'the writers kept the projection exactly as a re-projection makes it'
    );
    reproject(env.handle);
    assert.deepEqual(hashesOf(db, GRAPH), before);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    env.handle.close();
  }
});

// ---------- version-level evidence and compare-and-set ----------

test('internal traversal opens a retired source without an audience witness while a group cannot', () => {
  // Catches restricting trusted internal traversal to nodes that still have outward audience witnesses.
  const env = traversalFixture();
  const { db, ids, ctx } = env;
  const node = graphNodeId('source', ids.early);
  try {
    handleTx(env, () => {
      db.prepare('UPDATE sources SET retired_at = ? WHERE id = ?').run(at(70), ids.early);
      projectRow(wrongly(db), 'sources', { id: ids.early }, { at: at(70) });
    });
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM node_access WHERE node_id = ?', node), 0);
    assert.deepEqual(rowIds(walk(wrongly(db), ctx.internal, { from: node, maxDepth: 0 })), [ids.early]);
    assert.deepEqual(rowIds(walk(wrongly(db), ctx.group, { from: node, maxDepth: 0 })), []);
  } finally {
    env.handle.close();
  }
});

test('claim edits: every new version keeps its sources; a stale base is refused and recorded; a current one or none goes through', () => {
  const handle = openMemoryDb(':memory:');
  const db = sqlOf(handle);
  try {
    insertRows(
      db,
      {
        sources: [1, 2, 3].map((n) => ({
          id: `src:${n}`,
          kind: 'seen',
          iface: 'discord',
          native_id: `n${n}`,
          revision: 1,
          text: `line ${n}`,
          occurred_at: at(n),
          recorded_at: at(n),
          ...groupScope('discord'),
        })),
        claims: [
          {
            id: 'clm:tea',
            subject_kind: 'person',
            subject_id: 'person:x',
            kind: 'interest',
            text: 'tea',
            truth: 'current',
            shown: 1,
            created_at: at(0),
            ...groupScope('discord'),
          },
        ],
        claim_versions: [{ id: 'cv:tea:1', claim_id: 'clm:tea', text: 'tea', recorded_at: at(1), event: 'add' }],
      },
      { log: quiet }
    );
    const scope = groupScope('discord');
    const write = (runId: string, claims: Array<Record<string, Untyped>>): Record<string, Untyped> =>
      wrongly<Record<string, Untyped>>(
        applyMemoryWrite(handle, {
          kind: 'session',
          mode: 'apply',
          now: NOW,
          run: {
            id: runId,
            scopeKey: 'group:discord',
            scope,
            batchKey: `apply|${runId}`,
            startedAt: at(0),
            finishedAt: at(1),
            outcome: 'ok',
            counts: {},
            errors: [],
          },
          plan: { claims, episodes: [], affinity: [], descriptions: [], people: [] },
        })
      );
    const first = write('run:1', [{ op: 'confirm', id: 'clm:tea', sources: ['src:1'], base: 'cv:tea:1' }]);
    assert.equal(first.confirmed, 1);
    const newest = newestClaimVersion(wrongly(db), 'clm:tea');
    assert.notEqual(newest, 'cv:tea:1');
    assert.deepEqual(
      db
        .prepare('SELECT source_id, role, legacy FROM claim_version_sources WHERE version_id = ?')
        .all(newest)
        .map((row) => ({ ...row })),
      [{ source_id: 'src:1', role: 'supports', legacy: 0 }]
    );

    // The session read the first version; the claim has moved on: the op is refused whole and the refusal recorded.
    const stale = write('run:2', [
      {
        op: 'revise',
        id: 'clm:tea',
        text: 'green tea',
        how: 'said',
        sources: ['src:2'],
        reason: 'said so',
        base: 'cv:tea:1',
      },
    ]);
    assert.deepEqual([stale.rejected, stale.revised], [1, 0]);
    assert.equal(db.prepare('SELECT text FROM claims WHERE id = ?').get('clm:tea').text, 'tea');
    assert.equal(
      db.prepare("SELECT action FROM decisions WHERE id = 'dec:run:2:1'").get().action,
      'rejected:stale_base'
    );
    assert.equal(newestClaimVersion(wrongly(db), 'clm:tea'), newest, 'nothing written');
    // A base of null says the session read no version: stale too, once one exists.
    assert.equal(write('run:3', [{ op: 'confirm', id: 'clm:tea', sources: ['src:2'], base: null }]).rejected, 1);

    // The current base goes through; a retire's sources speak against the claim.
    const retiring = write('run:4', [
      { op: 'retire', id: 'clm:tea', truth: 'historical', reason: 'stopped', sources: ['src:3'], base: newest },
    ]);
    assert.equal(retiring.retired, 1);
    assert.deepEqual(
      db
        .prepare('SELECT source_id, role FROM claim_version_sources WHERE version_id = ?')
        .all(newestClaimVersion(wrongly(db), 'clm:tea'))
        .map((row) => ({ ...row })),
      [{ source_id: 'src:3', role: 'conflicts' }]
    );
    // An op without a base (a caller that read no version) is not checked.
    assert.equal(write('run:5', [{ op: 'confirm', id: 'clm:tea', sources: ['src:2'] }]).confirmed, 1);

    // The graph follows: each version derives from its own sources, versions chain, the decisions are internal nodes.
    const versions = db.prepare('SELECT COUNT(*) AS n FROM graph_edges WHERE predicate = ? AND dst = ?');
    assert.equal(versions.get('version_of', graphNodeId('claim', 'clm:tea')).n, 4);
    assert.equal(
      count(
        db,
        "SELECT COUNT(*) AS n FROM graph_edges WHERE predicate = 'derived_from' AND src LIKE 'claim_version:%'"
      ),
      3
    );
    assert.equal(
      count(db, "SELECT COUNT(*) AS n FROM graph_edges WHERE predicate = 'supersedes' AND src LIKE 'claim_version:%'"),
      3
    );
    assert.equal(
      count(
        db,
        "SELECT COUNT(*) AS n FROM node_access a JOIN graph_nodes n ON n.id = a.node_id WHERE n.kind = 'decision' AND a.audience_id <> 'aud:internal'"
      ),
      0
    );
    const before = hashesOf(db, GRAPH);
    reproject(handle);
    assert.deepEqual(hashesOf(db, GRAPH), before);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    handle.close();
  }
});

// ---------- the migration and the three contracts ----------

/**
 * A data directory written into a new database by the unit writer, projected whole once, as an open of an older
 * database projected it. The unit writer of the `media.json` cache stores its rows without their graph node, so the
 * projection runs here.
 */
function seededAtBaseline() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-graph-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const file = path.join(root, 'memory.db');
  const handle = openMemoryDb(file);
  assert.equal(seedUnits(handle, data, wrongly({ log: quiet })).errors, 0);
  reproject(handle);
  handle.close();
  return { root, data, file, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('v9 contracts: a replay of the unit writes projects the same rows; reproject idempotent; rebuild equal; the VACUUM round trip', () => {
  const env = seededAtBaseline();
  try {
    const handle = openMemoryDb(env.file);
    assert.equal(
      seedUnits(handle, env.data, wrongly({ log: quiet })).errors,
      0,
      'a full pass also finishes the pending projection'
    );
    assert.equal(graphPending(handle), false);
    handle.close();

    // Every unit written again: the projection the writers keep is the same rows as before.
    const writer = openMemoryDb(env.file);
    const before = hashesOf(writer.db, GRAPH);
    const replay = seedUnits(writer, env.data, wrongly({ log: quiet }));
    assert.equal(replay.errors, 0);
    assert.ok(replay.units > 10);
    assert.deepEqual(hashesOf(writer.db, GRAPH), before, 'a replay re-projects to the same rows');
    // Reproject twice: the same hashes; rebuild: every graph table equal.
    reproject(writer);
    assert.deepEqual(hashesOf(writer.db, GRAPH), before);
    reproject(writer);
    assert.deepEqual(hashesOf(writer.db, GRAPH), before);
    rebuildGraph(writer);
    assert.deepEqual(hashesOf(writer.db, GRAPH), before);
    assert.deepEqual(sqlOf(writer).prepare('PRAGMA foreign_key_check').all(), []);
    writer.close();

    // The round trip: a VACUUM INTO copy hashes like its source, table by table.
    const copy = path.join(env.root, 'copy.db');
    const source = openMemoryDb(env.file, { readOnly: true });
    sqlOf(source).exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
    const original = tableHashes(source.db);
    source.close();
    const restored = openMemoryDb(copy, { readOnly: true });
    try {
      const again = tableHashes(restored.db);
      assert.ok(original.length > 50);
      assert.deepEqual(again, original);
    } finally {
      restored.close();
    }
  } finally {
    env.done();
  }
});

test('rebuild drops the stale history the typed tables do not hold, and nothing else', () => {
  const env = traversalFixture();
  const { db, ids } = env;
  try {
    const row = { ...db.prepare('SELECT * FROM sources WHERE id = ?').get(ids.main) };
    delete row.rowid;
    insertRows(db, { sources: [{ ...row, place_id: 'discord:channel:t1' }] }, { log: quiet, at: at(50) });
    const stale = count(db, 'SELECT COUNT(*) AS n FROM graph_edges WHERE retired_at IS NOT NULL');
    assert.equal(stale, 1);
    const live = db
      .prepare('SELECT projection_key, audience_id FROM graph_edges WHERE retired_at IS NULL ORDER BY projection_key')
      .all()
      .map((r) => ({ ...r }));
    rebuildGraph(env.handle);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM graph_edges WHERE retired_at IS NOT NULL'), 0);
    assert.deepEqual(
      db
        .prepare('SELECT projection_key, audience_id FROM graph_edges WHERE retired_at IS NULL ORDER BY projection_key')
        .all()
        .map((r) => ({ ...r })),
      live
    );
  } finally {
    env.handle.close();
  }
});

// ---------- an edge whose id no longer matches its tuple ----------

/**
 * The traversal world with one live edge of the line `main` given an id that is not the hash of its tuple, the way a
 * text rewrite of its ends leaves it, its witnesses following that id. Returns the edge's projection key and true id.
 */
function staleEdgeFixture(retired: boolean) {
  const env = traversalFixture();
  const { db, ids } = env;
  const edge = db
    .prepare(
      "SELECT id, projection_key FROM graph_edges WHERE owner_key = ? AND predicate = 'authored_by' AND retired_at IS NULL"
    )
    .get(`sources:${ids.main}`);
  const id = String(edge.id);
  db.prepare('UPDATE graph_edges SET id = ?, retired_at = ? WHERE id = ?').run(
    'edge:stale',
    retired ? at(40) : null,
    id
  );
  db.prepare("UPDATE node_access SET evidence_id = 'edge:stale' WHERE evidence_id = ?").run(id);
  return { env, key: String(edge.projection_key), id };
}

function assertProjectsAndHeals(retired: boolean) {
  const { env, key, id } = staleEdgeFixture(retired);
  const { db, ids } = env;
  try {
    const codes: Array<unknown> = [];
    const log = { warn: (_message: string, fields: Record<string, unknown>) => codes.push(fields.code) };
    const projected = projectRow(env.handle, 'sources', { id: ids.main }, { at: at(60), log });
    assert.deepEqual(codes, []);
    assert.equal(projected, 1);
    assert.equal(graphPending(env.handle), false);
    const held = db.prepare('SELECT id, retired_at FROM graph_edges WHERE projection_key = ?').all(key);
    assert.deepEqual(
      held.map((row) => ({ id: String(row.id), retired: row.retired_at === null ? null : String(row.retired_at) })),
      [{ id, retired: null }]
    );
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM node_access WHERE evidence_id = 'edge:stale'"), 0);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM node_access WHERE evidence_id = ?', id), 2);
  } finally {
    env.handle.close();
  }
}

test('a unit whose live edge holds its key under a stale id projects and replaces that edge', () => {
  // Bug: the upsert misses the stale id and hits the unique projection key, so the unit rolls back and stays pending.
  assertProjectsAndHeals(false);
});

test('a unit whose retired edge holds its key under a stale id projects and replaces that edge', () => {
  // Bug: only live edges are looked up for the key, so a retired stale edge still blocks the projection.
  assertProjectsAndHeals(true);
});

// Schema v9: the sync writes units in no guaranteed order, and a projection never fails the typed write.
test('graph: a channel written before its guild and a membership before its account keep their edges; a rolled-back write leaves nothing behind', () => {
  const handle = openMemoryDb(':memory:');
  const db = sqlOf(handle);
  const quiet = { warn() {} };
  const node = (id: string) => db.prepare('SELECT kind, row_id, created_at FROM graph_nodes WHERE id = ?').get(id);
  const graph = () =>
    Object.fromEntries(
      tableHashes(db, ['graph_nodes', 'graph_edges', 'node_access']).map((entry) => [entry.table, entry.hash])
    );
  try {
    // A write rolled back on the same connection: the next one does not trust a row that went with it.
    for (let i = 0; i < 2; i += 1) {
      db.exec('BEGIN');
      insertRows(
        db,
        {
          places: [
            {
              id: 'telegram:channel:x',
              iface: 'telegram',
              kind: 'channel',
              native_id: 'x',
              parent_id: 'telegram:guild:y',
              scope_kind: 'group',
            },
          ],
        },
        { log: quiet }
      );
      db.exec('ROLLBACK');
    }
    insertRows(
      db,
      {
        places: [
          {
            id: 'discord:channel:c1',
            iface: 'discord',
            kind: 'channel',
            native_id: 'c1',
            parent_id: 'discord:guild:g1',
            scope_kind: 'group',
          },
        ],
      },
      { log: quiet }
    );
    assert.deepEqual(
      { ...node('place:discord:guild:g1') },
      { kind: 'place', row_id: 'discord:guild:g1', created_at: '1970-01-01T00:00:00.000Z' },
      'the missing guild is a placeholder node'
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM graph_edges WHERE predicate = 'contained_in' AND retired_at IS NULL").get()
        .n,
      1,
      'the edge is kept'
    );
    insertRows(
      db,
      {
        places: [
          {
            id: 'discord:guild:g1',
            iface: 'discord',
            kind: 'guild',
            native_id: 'g1',
            parent_id: null,
            scope_kind: 'group',
            seen_from_at: '2026-10-01T00:00:00.000Z',
          },
        ],
        memberships: [
          {
            id: 'm:1',
            account_id: 'discord:u1',
            place_id: 'discord:guild:g1',
            valid_from_at: '2026-10-02T00:00:00.000Z',
          },
        ],
      },
      { log: quiet }
    );
    assert.equal(
      node('place:discord:guild:g1').created_at,
      '2026-10-01T00:00:00.000Z',
      'the guild row fills its node in'
    );
    assert.equal(
      node('account:discord:u1').created_at,
      '1970-01-01T00:00:00.000Z',
      'the account a membership names before it arrives'
    );
    insertRows(db, { accounts: [{ id: 'discord:u1', iface: 'discord', native_id: 'u1' }] }, { log: quiet });
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS n FROM graph_nodes WHERE id IN ('place:discord:guild:g1', 'account:discord:u1')")
        .get().n,
      2,
      'one node each, not two'
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM graph_edges WHERE predicate IN ('has_membership', 'membership_in') AND retired_at IS NULL"
        )
        .get().n,
      2
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'graph_pending'").get().n, 0, 'nothing failed');
    const before = graph();
    reproject(handle);
    assert.deepEqual(graph(), before, 'whatever the order, the writers left what a re-projection makes');
  } finally {
    handle.close();
  }
});

// ---------- the graph follows its rows ----------
// Bug: a projection of a row that is gone writes nothing, so the row's node and its own witness stay; and the version
// of an archive entry of an episode is linked to a claim node no row holds.

const nodesOf = (db: UntypedDb, node: string): number =>
  count(db, 'SELECT COUNT(*) AS n FROM graph_nodes WHERE id = ?', node);
const witnessesOf = (db: UntypedDb, node: string): number =>
  count(db, 'SELECT COUNT(*) AS n FROM node_access WHERE node_id = ?', node);

test('a projection of a media row that is gone removes its node and its witness', () => {
  const handle = openMemoryDb(':memory:');
  const db = sqlOf(handle);
  try {
    db.prepare(
      "INSERT INTO media (id, kind, native_ref, scope_iface) VALUES ('media:fake:q1', 'image', 'q1', 'fake')"
    ).run();
    projectRow(handle, 'media', { id: 'media:fake:q1' }, { at: at(0) });
    const node = graphNodeId('media', 'media:fake:q1');
    assert.equal(witnessesOf(db, node), 1);
    db.prepare("DELETE FROM media WHERE id = 'media:fake:q1'").run();
    projectRow(handle, 'media', { id: 'media:fake:q1' }, { at: at(1) });
    assert.equal(nodesOf(db, node), 0);
    assert.equal(witnessesOf(db, node), 0);
  } finally {
    handle.close();
  }
});

// An account has no witness of its own (its producer writes none), so a claim is the kind here: it has its own witness,
// and the supersedes edge of the claim it replaced names it and witnesses it too.
test('a projection of a row that is gone keeps its node while an edge names it and drops only its own witness', () => {
  const handle = openMemoryDb(':memory:');
  const db = sqlOf(handle);
  try {
    db.prepare("INSERT INTO claims (id, created_at) VALUES ('clm:new', ?)").run(at(0));
    db.prepare("INSERT INTO claims (id, created_at, superseded_by) VALUES ('clm:old', ?, 'clm:new')").run(at(0));
    projectRow(handle, 'claims', { id: 'clm:new' }, { at: at(0) });
    projectRow(handle, 'claims', { id: 'clm:old' }, { at: at(0) });
    const node = graphNodeId('claim', 'clm:new');
    const own = (n: string): number =>
      count(db, 'SELECT COUNT(*) AS n FROM node_access WHERE node_id = ? AND evidence_id = ?', n, n);
    assert.equal(own(node), 1);
    const byEdge = witnessesOf(db, node) - own(node);
    assert.ok(byEdge > 0);
    db.prepare("DELETE FROM claims WHERE id = 'clm:new'").run();
    projectRow(handle, 'claims', { id: 'clm:new' }, { at: at(1) });
    assert.equal(nodesOf(db, node), 1);
    assert.equal(own(node), 0);
    assert.equal(witnessesOf(db, node), byEdge);
  } finally {
    handle.close();
  }
});

/** The node the `version_of` edge of the claim version `id` ends at. */
const versionTarget = (db: UntypedDb, id: string): unknown =>
  db
    .prepare("SELECT dst FROM graph_edges WHERE src = ? AND predicate = 'version_of'")
    .get(graphNodeId('claim_version', id))?.dst;

test('the version of an archive entry of an episode is linked to the episode and makes no claim node', () => {
  const handle = openMemoryDb(':memory:');
  const db = sqlOf(handle);
  try {
    db.prepare("INSERT INTO episodes (id, kind, what, created_at) VALUES ('ep:p1', 'participation', 'a walk', ?)").run(
      at(0)
    );
    projectRow(handle, 'episodes', { id: 'ep:p1' }, { at: at(0) });
    db.prepare(
      "INSERT INTO claim_versions (id, claim_id, text, recorded_at) VALUES ('cv:p1', 'ep:p1', 'a walk', ?)"
    ).run(at(1));
    projectRow(handle, 'claim_versions', { id: 'cv:p1', claim_id: 'ep:p1' }, { at: at(1) });
    assert.equal(versionTarget(db, 'cv:p1'), graphNodeId('episode', 'ep:p1'));
    assert.equal(nodesOf(db, graphNodeId('claim', 'ep:p1')), 0);
  } finally {
    handle.close();
  }
});

test('the version of a claim is linked to the claim', () => {
  const handle = openMemoryDb(':memory:');
  const db = sqlOf(handle);
  try {
    db.prepare("INSERT INTO claims (id, created_at) VALUES ('clm:k1', ?)").run(at(0));
    db.prepare(
      "INSERT INTO claim_versions (id, claim_id, text, recorded_at) VALUES ('cv:k1', 'clm:k1', 'likes tea', ?)"
    ).run(at(1));
    projectRow(handle, 'claims', { id: 'clm:k1' }, { at: at(1) });
    assert.equal(versionTarget(db, 'cv:k1'), graphNodeId('claim', 'clm:k1'));
  } finally {
    handle.close();
  }
});

// ---------- the semantic assertions ----------

// The graph projection of semantic assertions. An entity is a node, each reference argument of a version is a
// `has_role` edge from the version's node, and a binary relation also gets a navigation shortcut: `asserts` when positive,
// `denies` when negative, `graph_edges.evidence_id` naming the exact version. The tests walk through the public traversal
// (graph.ts#walk) under issued contexts, so what a context cannot reach here it cannot discover. Each adversarial test
// first proves the private edge through the internal context. Synthetic content only.

const entityNode = (id: string): string => graphNodeId('semantic_entity', id);
const personNode = (id: string): string => graphNodeId('person', id);
const versionNode = (id: string): string => graphNodeId('claim_version', id);
const written = (result: object): { claimId: string; versionId: string } =>
  result as { claimId: string; versionId: string };

function reached(
  world: World,
  ctx: Context,
  from: string,
  predicates: Array<string>,
  direction: 'out' | 'in' | 'both' = 'both'
): Array<string> {
  return walk(world.db, ctx, { from, predicates, direction, maxDepth: 1, maxRows: 100 })
    .rows.map((row) => String(row.node))
    .filter((node) => node !== from)
    .sort();
}
const edgesOf = (world: World, versionId: string) =>
  world.db
    .prepare(
      'SELECT predicate, src, dst, audience_id, retired_at FROM graph_edges WHERE evidence_id = ? ORDER BY predicate, src, dst'
    )
    .all(versionId)
    .map((row) => ({ ...row }));
const liveEdges = (world: World, versionId: string) =>
  edgesOf(world, versionId).filter((row) => row.retired_at === null);

test('the manifest declares the entity node and the three semantic edges', () => {
  // Bug: a projected kind is absent from the manifest, so the owner's inventory reports it as nothing.
  assert.ok(NODE_KINDS.semantic_entity);
  for (const predicate of ['has_role', 'asserts', 'denies']) {
    assert.ok((PREDICATES as Record<string, unknown>)[predicate], `${predicate} is not in the manifest`);
  }
});

test('a relation projects one role edge per reference and one shortcut, all naming its exact version', () => {
  // Bug: a shortcut with no version cannot open the assertion, its evidence or its audience.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'Alex works on Lumen');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const fact = written(commit(world, worksOn(ALEX, entityId, [source])));
  assert.deepEqual(
    edgesOf(world, fact.versionId).map((row) => [row.predicate, row.src, row.dst]),
    [
      ['asserts', personNode(ALEX), entityNode(entityId)],
      // The query orders by dst, and `person:` sorts before `semantic_entity:`.
      ['has_role', versionNode(fact.versionId), personNode(ALEX)],
      ['has_role', versionNode(fact.versionId), entityNode(entityId)],
    ]
  );
  world.handle.close();
});

test('an entity with a name and no relation is still a node its own audience can reach', () => {
  // Bug: only related entities project, and an isolated identity vanishes from navigation.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'we call it Lumen');
  const lumen = addEntity(world, 'project', 'Lumen', [source]);
  assert.deepEqual(reached(world, world.contexts.group, entityNode(lumen.entityId), ['has_role']), [
    versionNode(lumen.versionId),
  ]);
  world.handle.close();
});

test('public and DM assertions with identical endpoints and predicate stay two witnesses', () => {
  // Bug: deduplicating by endpoint and predicate lets one audience inherit the other's witness.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'Alex works on Lumen');
  const secret = addSource(world, 'alex', 'I work on Lumen, between us');
  const { entityId } = addEntity(world, 'project', 'Lumen', [open]);
  const pub = written(commit(world, worksOn(ALEX, entityId, [open])));
  const dm = written(commit(world, worksOn(ALEX, entityId, [secret]), world.contexts.alex));
  const shortcut = (versionId: string) => liveEdges(world, versionId).filter((row) => row.predicate === 'asserts');
  assert.equal(shortcut(pub.versionId).length, 1);
  assert.equal(shortcut(dm.versionId).length, 1);
  assert.notEqual(shortcut(pub.versionId)[0]?.audience_id, shortcut(dm.versionId)[0]?.audience_id);
  world.handle.close();
});

test('two conflicting current versions of different claims both remain as witnesses', () => {
  // Bug: a later assertion overwrites an earlier one at the same endpoints, and a dispute disappears.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'Alex works on Lumen');
  const other = addSource(world, 'public', 'no he does not');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const said = written(commit(world, worksOn(ALEX, entityId, [source])));
  const disputed = written(commit(world, worksOn(ALEX, entityId, [other], { state: 'disputed' })));
  assert.equal(liveEdges(world, said.versionId).length, 3);
  assert.equal(liveEdges(world, disputed.versionId).length, 3);
  world.handle.close();
});

test('a negative relation projects a denial and no affirmative shortcut', () => {
  // Bug: "Alex did not attend" reads as an attendance edge in every later traversal.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'Alex is not on Lumen');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const fact = written(commit(world, worksOn(ALEX, entityId, [source], { polarity: 'negative' })));
  const predicates = edgesOf(world, fact.versionId).map((row) => row.predicate);
  assert.ok(predicates.includes('denies'));
  assert.ok(!predicates.includes('asserts'));
  assert.deepEqual(reached(world, world.contexts.group, personNode(ALEX), ['asserts']), []);
  world.handle.close();
});

test('an n-ary event keeps its version as the hub and projects no pairwise shortcut', () => {
  // Bug: pairwise edges replace the joint assertion, so a role reads as an independent fact.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'Alex organized Orbis and Mira spoke');
  const event = addEntity(world, 'event', 'Orbis meeting', [source]);
  const fact = written(commit(world, occurrence(event.entityId, { organizer: [ALEX], speaker: [MIRA] }, [source])));
  const edges = edgesOf(world, fact.versionId);
  assert.ok(edges.every((row) => row.predicate === 'has_role' && row.src === versionNode(fact.versionId)));
  assert.deepEqual(
    edges.map((row) => row.dst).sort(),
    [entityNode(event.entityId), personNode(ALEX), personNode(MIRA)].sort()
  );
  world.handle.close();
});

test('one person in two roles of one event makes two role edges', () => {
  // Bug: the edge's identity leaves out role and position, so the second role silently collapses into the first.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'Alex organized Orbis and spoke');
  const event = addEntity(world, 'event', 'Orbis meeting', [source]);
  const fact = written(commit(world, occurrence(event.entityId, { organizer: [ALEX], speaker: [ALEX] }, [source])));
  assert.equal(edgesOf(world, fact.versionId).filter((row) => row.dst === personNode(ALEX)).length, 2);
  world.handle.close();
});

// ---- audiences -------------------------------------------------------------------------------------------------------

test('a public hub with a private incident fact shows a group only the public neighbour', () => {
  // Bug: a visible endpoint authorizes the edge, and the private neighbour is found through the public entity.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'Alex works on Lumen');
  const secret = addSource(world, 'alex', 'Mira works on Lumen too, quietly');
  const { entityId } = addEntity(world, 'project', 'Lumen', [open]);
  commit(world, worksOn(ALEX, entityId, [open]));
  commit(world, worksOn(MIRA, entityId, [secret]), world.contexts.alex);
  const from = entityNode(entityId);
  assert.deepEqual(
    reached(world, world.contexts.internal, from, ['asserts']),
    [personNode(ALEX), personNode(MIRA)].sort()
  );
  assert.deepEqual(reached(world, world.contexts.group, from, ['asserts']), [personNode(ALEX)]);
  assert.deepEqual(reached(world, world.contexts.mira, from, ['asserts']), [personNode(ALEX)]);
  assert.deepEqual(reached(world, world.contexts.groups, from, ['asserts']), [personNode(ALEX)]);
  world.handle.close();
});

test('a private version node gives a group no role edge and no access witness', () => {
  // Bug: the node is projected with its parent's audience, so a group can open a private version by id.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'one');
  const secret = addSource(world, 'alex', 'between us');
  const { entityId } = addEntity(world, 'project', 'Lumen', [open]);
  const dm = written(commit(world, worksOn(MIRA, entityId, [secret]), world.contexts.alex));
  const node = versionNode(dm.versionId);
  assert.ok(reached(world, world.contexts.internal, node, ['has_role'], 'out').length > 0);
  assert.deepEqual(reached(world, world.contexts.group, node, ['has_role'], 'out'), []);
  const access = world.db
    .prepare('SELECT audience_id FROM node_access WHERE node_id = ?')
    .all(node)
    .map((row) => row.audience_id);
  assert.ok(access.length > 0);
  assert.ok(access.every((audience) => String(audience).startsWith('aud:dm:')));
  world.handle.close();
});

test('an entity known only privately has no group witness on its node', () => {
  // Bug: the entity node is public by default, and its existence shows in every inventory.
  const world = semanticWorld();
  const secret = addSource(world, 'alex', 'a private project');
  const hidden = addEntity(world, 'project', 'Hidden', [secret], world.contexts.alex);
  const access = world.db
    .prepare('SELECT audience_id FROM node_access WHERE node_id = ?')
    .all(entityNode(hidden.entityId))
    .map((row) => row.audience_id);
  assert.ok(access.length > 0);
  assert.ok(access.every((audience) => String(audience).startsWith('aud:dm:')));
  world.handle.close();
});

// ---- retirement and rebuild ------------------------------------------------------------------------------------------

test('a successor retires the witnesses of its own base and of no other claim', () => {
  // Bug: retiring by endpoint and predicate removes a separately justified assertion of the same pair.
  const world = semanticWorld();
  const one = addSource(world, 'public', 'one');
  const two = addSource(world, 'public', 'two');
  const { entityId } = addEntity(world, 'project', 'Lumen', [one]);
  const first = written(commit(world, worksOn(ALEX, entityId, [one])));
  const second = written(commit(world, worksOn(ALEX, entityId, [two])));
  const gone = written(commit(world, worksOn(ALEX, entityId, [one], successor(first, { state: 'retired' }))));
  assert.deepEqual(liveEdges(world, first.versionId), []);
  assert.equal(liveEdges(world, second.versionId).length, 3);
  assert.equal(liveEdges(world, gone.versionId).filter((row) => row.predicate === 'asserts').length, 0);
  world.handle.close();
});

test('a retired version stays openable through its own node and evidence', () => {
  // Bug: retirement deletes the node, so history and evidence cannot be inspected.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const first = written(commit(world, worksOn(ALEX, entityId, [source])));
  commit(world, worksOn(ALEX, entityId, [source], successor(first, { state: 'retired' })));
  assert.equal(
    world.db.prepare('SELECT COUNT(*) AS n FROM graph_nodes WHERE id = ?').get(versionNode(first.versionId))?.n,
    1
  );
  assert.ok(edgesOf(world, first.versionId).length > 0, 'its edges keep their retirement time');
  world.handle.close();
});

test('a rebuild regenerates the same semantic graph from typed authority', () => {
  // Bug: a semantic edge exists only because of the incremental path, and a rebuild loses memory's navigation.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'one');
  const secret = addSource(world, 'alex', 'between us');
  const { entityId } = addEntity(world, 'project', 'Lumen', [open]);
  const event = addEntity(world, 'event', 'Orbis', [open]);
  const first = written(commit(world, worksOn(ALEX, entityId, [open])));
  commit(world, worksOn(ALEX, entityId, [open], successor(first, { polarity: 'negative' })));
  commit(world, worksOn(MIRA, entityId, [secret]), world.contexts.alex);
  commit(world, occurrence(event.entityId, { attendee: [ALEX, MIRA, KAI] }, [open]));
  const shape = () => ({
    edges: world.db
      .prepare(
        "SELECT projection_key, predicate, src, dst, audience_id, evidence_id, retired_at IS NOT NULL AS retired FROM graph_edges WHERE predicate IN ('has_role', 'asserts', 'denies') ORDER BY projection_key"
      )
      .all()
      .map((row) => ({ ...row })),
    access: world.db
      .prepare(
        "SELECT node_id, audience_id, evidence_id FROM node_access WHERE node_id LIKE 'semantic_entity:%' OR node_id LIKE 'claim_version:%' ORDER BY 1, 2, 3"
      )
      .all()
      .map((row) => ({ ...row })),
  });
  const before = shape();
  assert.ok(before.edges.length > 0);
  rebuildGraph(world.handle, {});
  assert.deepEqual(shape(), before);
  world.handle.close();
});

test('a cycle of part-of relations ends a walk', () => {
  // Bug: A in B in A loops the traversal until its row cap and hides everything else.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const a = addEntity(world, 'concept', 'A', [source]);
  const b = addEntity(world, 'concept', 'B', [source]);
  commit(world, partOf(a.entityId, b.entityId, [source]));
  commit(world, partOf(b.entityId, a.entityId, [source]));
  const { rows, truncated } = walk(world.db, world.contexts.group, {
    from: entityNode(a.entityId),
    predicates: ['asserts'],
    direction: 'out',
    maxDepth: 10,
    maxRows: 100,
  });
  assert.equal(truncated, false);
  assert.equal(new Set(rows.map((row) => row.node)).size, rows.length);
  world.handle.close();
});
