// Schema v9 (spec 2026-10-24-memory-schema-v7, stage 3): the graph projection and its manifest, the four traversal
// examples on a fixture of two interfaces with a group, a thread, a DM and a private link between two public nodes,
// truncation reports, cycles, re-projection after an edit, a link revocation and a retirement, the three contracts
// (a replay of the unit writes re-projects to the same rows, the VACUUM round trip, rebuildability), version-level evidence and the compare-and-set on
// claim edits. Synthetic text only (Greek or accented Latin for non-ASCII); the ids and handles are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIGRATIONS, openMemoryDb, schemaVersion } from '../src/memory/db/open.js';
import { V9_TABLES } from '../src/memory/db/schema.js';
import { seedUnits } from './fixtures/memory-db/seed.js';
import { insertRows } from '../src/memory/db/rows.js';
import { OBSERVATION_VERSION, observe } from '../src/memory/db/observe.js';
import { applyMemoryWrite, newestClaimVersion } from '../src/memory/db/session-write.js';
import { DEFERRED, NODE_KINDS, PREDICATES, UNIT_OF, UNIT_ORDER } from '../src/memory/db/graph-manifest.js';
import {
  continuationsOf,
  graphNodeId,
  graphPending,
  graphSettings,
  inPlace,
  projectPending,
  projectRow,
  rebuildGraph,
  repliesTo,
  reproject,
  saidBy,
  walk,
} from '../src/memory/db/graph.js';
import { dmContext, groupContext, groupScope, internalContext } from '../src/memory/db/scope.ts';
import { main, tableHashes } from '../tools/memory-db.mjs';
import { buildDataDir } from './fixtures/memory-db/datadir.js';

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const at = (minutes) => new Date(Date.parse('2026-10-24T10:00:00.000Z') + minutes * 60_000).toISOString();
const count = (db, sql, ...params) => db.prepare(sql).get(...params).n;
const GRAPH = ['graph_nodes', 'graph_edges', 'node_access'];
const hashesOf = (db, tables) => Object.fromEntries(tableHashes(db, tables).map((entry) => [entry.table, entry.hash]));
const run = (...argv) => {
  const lines = [];
  const code = main(argv, { out: (line) => lines.push(line), err: (line) => lines.push(line) });
  return { code, text: lines.join('\n') };
};

// ---------- the manifest ----------

test('the manifest names only tables and columns the schema has, every projected table has a unit, and the spec list is whole', () => {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
  try {
    const columns = (table) =>
      new Set(
        db
          .prepare(`PRAGMA table_info("${table}")`)
          .all()
          .map((column) => column.name)
      );
    const has = (table, column) => assert.ok(columns(table).has(column), `${table}.${column}`);
    for (const [kind, spec] of Object.entries(NODE_KINDS)) {
      if (spec.table === null) {
        assert.ok(DEFERRED[kind], `${kind} is deferred with a reason`);
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
      for (const [table, list] of Object.entries(spec.also ?? {})) for (const column of list) has(table, column);
      for (const kind of [...spec.from, ...spec.to]) assert.ok(NODE_KINDS[kind], `${name}: node kind ${kind}`);
    }
    for (const [table, unit] of Object.entries(UNIT_OF)) {
      assert.ok(columns(table).size > 0, table);
      if (unit) {
        assert.ok(UNIT_ORDER.includes(unit[0]), `${table} -> ${unit[0]}`);
        has(table, unit[1]);
      } else assert.ok(UNIT_ORDER.includes(table), table);
    }
    // The spec's list of node kinds and predicates (section 3), node_facts deferred to its own migration.
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
      'skill',
      'source',
      'work',
    ]);
    assert.deepEqual(Object.keys(PREDICATES).sort(), [
      'about',
      'account_of',
      'authored_by',
      'contained_in',
      'continues',
      'derived_from',
      'follows',
      'has_membership',
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
    for (const table of V9_TABLES) assert.ok(columns(table).size > 0, table);
    assert.deepEqual(graphSettings({}), { maxDepth: 6, maxRows: 2000 });
    assert.deepEqual(graphSettings({ graph: { maxDepth: 3, maxRows: 10 } }), { maxDepth: 3, maxRows: 10 });
  } finally {
    handle.close();
  }
});

// ---------- the traversal fixture ----------

const D = 'discord/global';
const T = 'telegram/global';
const discordLine = (key, minutes, over = {}) => ({
  v: OBSERVATION_VERSION,
  iface: 'discord',
  authority: D,
  native: { kind: 'message', key, revision: 0 },
  place: { authority: D, key: 'channel:c1', kind: 'channel', conversation: 'group' },
  author: { kind: 'account', key: 'alice-main' },
  occurredAt: at(minutes),
  observedAt: at(minutes),
  text: `line ${key}`,
  relations: [],
  ...over,
});
const dmPlace = { authority: D, key: 'dm:bob', kind: 'dm', conversation: 'dm', partner: { key: 'bob' } };
const replyTo = (key) => [{ predicate: 'replies_to', target: { kind: 'message', key } }];

/**
 * Discord: a server, a channel in it, a thread in the channel (rows the files bring), lines observed there; a DM with
 * Bob; her own line and replies to it. Telegram: one group. Alice is one person with three accounts: her main Discord
 * account (linked from 10 minutes in, no evidence: public), an alt (linked on evidence from the DM: a private link
 * between two public nodes) and her Telegram account.
 */
function traversalFixture() {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
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
  const ids = {};
  const put = (name, envelope) => {
    const done = observe(handle, envelope, opts);
    assert.equal(done.ok, true, `${name}: ${JSON.stringify(done)}`);
    ids[name] = done.sourceId;
    return done;
  };
  const early = put('early', discordLine('m0', 5, { text: 'before the link' }));
  put('main', discordLine('m1', 20));
  put(
    'inThread',
    discordLine('m2', 21, { place: { authority: D, key: 'thread:t1', kind: 'thread', conversation: 'group' } })
  );
  const alt = put('alt', discordLine('m3', 22, { author: { kind: 'account', key: 'alice-alt' } }));
  put(
    'evidence',
    discordLine('d1', 23, { place: dmPlace, author: { kind: 'account', key: 'bob' }, text: 'that alt is Alice' })
  );
  put('her', discordLine('m4', 30, { author: { kind: 'self', key: 'her' } }));
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
    place: { authority: T, key: 'chat:tg1', kind: 'room', conversation: 'group' },
    author: { kind: 'account', authority: T, key: 'alice-tg' },
  });
  const accountOf = (done) =>
    db.prepare('SELECT author_account FROM sources WHERE id = ?').get(done.sourceId).author_account;
  const accounts = { main: accountOf(early), alt: accountOf(alt), tg: accountOf(telegram) };
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

const rowIds = (result) => result.rows.map((row) => row.rowId);

test("everything a person said anywhere: accounts verified at the line's time; the private link and the other interface stay out of a group", () => {
  const env = traversalFixture();
  const { db, ids, ctx } = env;
  try {
    const group = saidBy(db, ctx.group, 'person:alice');
    assert.deepEqual(
      rowIds(group),
      [ids.main, ids.inThread, ids.reply],
      'her main account from the link on; the line before the link is not hers yet'
    );
    assert.equal(group.truncated, false);
    assert.ok(!rowIds(group).includes(ids.early));
    assert.ok(
      !rowIds(group).includes(ids.alt) && !rowIds(group).includes(ids.replyToReply),
      'the alt is linked on DM evidence: invisible in a group'
    );
    assert.ok(!rowIds(group).includes(ids.telegram), 'the Telegram account is another interface');
    // The private link's existence does not show either: not from the alt, not from the person.
    const fromAlt = walk(db, ctx.group, { from: graphNodeId('account', env.accounts.alt), predicates: ['account_of'] });
    assert.deepEqual(
      fromAlt.rows.map((row) => row.node),
      [graphNodeId('account', env.accounts.alt)],
      'the alt is a public node, its link is not'
    );
    const toPerson = walk(db, ctx.group, {
      from: graphNodeId('person', 'person:alice'),
      predicates: ['account_of'],
      direction: 'in',
    });
    assert.deepEqual(toPerson.rows.map((row) => row.rowId).sort(), ['person:alice', env.accounts.main].sort());
    assert.equal(
      walk(db, ctx.group, { from: graphNodeId('place', env.places.dm) }).rows.length,
      0,
      'the DM place is not even a start in a group'
    );

    // The DM sees the private link (and the group lines); Telegram sees only its own; internal sees all.
    assert.deepEqual(rowIds(saidBy(db, ctx.dm, 'person:alice')), [
      ids.main,
      ids.inThread,
      ids.alt,
      ids.reply,
      ids.replyToReply,
    ]);
    assert.deepEqual(rowIds(saidBy(db, ctx.telegram, 'person:alice')), [ids.telegram]);
    assert.deepEqual(rowIds(saidBy(db, ctx.internal, 'person:alice')), [
      ids.main,
      ids.inThread,
      ids.alt,
      ids.telegram,
      ids.reply,
      ids.replyToReply,
    ]);
    // Her own lines are said by her person row directly.
    assert.deepEqual(rowIds(saidBy(db, ctx.group, 'person:self')), [ids.her]);
  } finally {
    env.handle.close();
  }
});

test("what happened in a place: the lines of the place and of every place inside it, never another audience's", () => {
  const env = traversalFixture();
  const { db, ids, ctx, places } = env;
  try {
    const server = inPlace(db, ctx.group, places.guild);
    assert.deepEqual(
      rowIds(server).sort(),
      [ids.early, ids.main, ids.inThread, ids.alt, ids.her, ids.reply, ids.replyToReply, ids.cycleA, ids.cycleB].sort()
    );
    assert.equal(inPlace(db, ctx.telegram, places.guild).rows.length, 0, 'a Discord server is not seen from Telegram');
    assert.deepEqual(rowIds(inPlace(db, ctx.dm, places.dm)).sort(), [ids.evidence, ids.privateReply].sort());
    assert.equal(inPlace(db, ctx.group, places.dm).rows.length, 0);
  } finally {
    env.handle.close();
  }
});

test('who replied to her line: replies and replies to replies; a private reply only in its DM; a cycle ends', () => {
  const env = traversalFixture();
  const { db, ids, ctx } = env;
  try {
    assert.deepEqual(rowIds(repliesTo(db, ctx.group, ids.her)), [ids.reply, ids.replyToReply]);
    assert.deepEqual(
      rowIds(repliesTo(db, ctx.dm, ids.her)).sort(),
      [ids.reply, ids.privateReply, ids.replyToReply].sort()
    );
    const cycle = repliesTo(db, ctx.group, ids.cycleA);
    assert.deepEqual(rowIds(cycle), [ids.cycleB], 'the cycle comes back to its start and stops there');
    assert.equal(cycle.truncated, false);
    const both = walk(db, ctx.group, {
      from: graphNodeId('source', ids.cycleA),
      predicates: ['replies_to'],
      direction: 'both',
    });
    assert.deepEqual(
      both.rows.map((row) => row.rowId),
      [ids.cycleA, ids.cycleB],
      'each node once, whatever the direction'
    );
  } finally {
    env.handle.close();
  }
});

test('the DM that continued a group, and the group that grew out of the DM: only the DM sees the chain', () => {
  const env = traversalFixture();
  const { db, ctx, places } = env;
  try {
    // A second group channel; no writer fills the column yet, so the test sets it and projects as a writer would.
    insertRows(
      db,
      {
        places: [
          {
            id: 'discord:channel:c3',
            iface: 'discord',
            kind: 'channel',
            native_id: 'c3',
            parent_id: places.guild,
            scope_kind: 'group',
          },
        ],
      },
      { log: quiet }
    );
    handleTx(env, () => {
      db.prepare('UPDATE places SET continues_place_id = ? WHERE id = ?').run(places.channel, places.dm);
      db.prepare('UPDATE places SET continues_place_id = ? WHERE id = ?').run(places.dm, 'discord:channel:c3');
      projectRow(db, 'places', { id: places.dm });
      projectRow(db, 'places', { id: 'discord:channel:c3' });
    });
    assert.deepEqual(rowIds(continuationsOf(db, ctx.dm, places.channel)), [places.dm, 'discord:channel:c3']);
    assert.deepEqual(
      rowIds(continuationsOf(db, ctx.group, places.channel)),
      [],
      'a group never learns a DM went on from it, nor what grew out of that DM'
    );
    assert.deepEqual(rowIds(continuationsOf(db, ctx.internal, places.channel)), [places.dm, 'discord:channel:c3']);
  } finally {
    env.handle.close();
  }
});

function handleTx(env, fn) {
  return env.handle.transaction(fn);
}

test('truncation reports: the row cap pages with `next`, the depth cap says depth', () => {
  const env = traversalFixture();
  const { db, ctx, places } = env;
  try {
    const all = inPlace(db, ctx.group, places.guild, { maxRows: 1000 });
    const first = walk(db, ctx.group, {
      from: graphNodeId('place', places.guild),
      predicates: ['contained_in', 'located_in'],
      direction: 'in',
      maxRows: 4,
    });
    assert.deepEqual([first.truncated, first.reason, first.next, first.rows.length], [true, 'rows', 4, 4]);
    const second = walk(db, ctx.group, {
      from: graphNodeId('place', places.guild),
      predicates: ['contained_in', 'located_in'],
      direction: 'in',
      maxRows: 4,
      after: first.next,
    });
    assert.equal(second.rows.length, 4);
    assert.deepEqual(
      [...first.rows, ...second.rows].map((row) => row.node).slice(0, 8),
      walk(db, ctx.group, {
        from: graphNodeId('place', places.guild),
        predicates: ['contained_in', 'located_in'],
        direction: 'in',
      })
        .rows.map((row) => row.node)
        .slice(0, 8),
      'pages follow the one fixed order'
    );
    const shallow = inPlace(db, ctx.group, places.guild, { maxDepth: 1 });
    assert.deepEqual([shallow.truncated, shallow.reason], [true, 'depth'], 'the server holds a channel holding more');
    assert.equal(rowIds(shallow).length, 0, 'no line sits in the server itself');
    assert.deepEqual([all.truncated, all.reason], [false, null]);
    assert.equal(
      inPlace(db, ctx.group, places.guild, { config: { graph: { maxDepth: 1 } } }).reason,
      'depth',
      'graph.maxDepth from the config is the default'
    );
  } finally {
    env.handle.close();
  }
});

test('re-projection after an edit, a link revocation and a retirement: stale edges retired, no duplicates, the walks follow', () => {
  const env = traversalFixture();
  const { db, ids, ctx, accounts } = env;
  try {
    const live = (predicate, src) =>
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
      projectRow(db, 'account_person_links', { account_id: accounts.main }, { at: at(60) });
    });
    assert.deepEqual(live('account_of', graphNodeId('account', accounts.main)), []);
    assert.equal(
      db
        .prepare("SELECT retired_at FROM graph_edges WHERE predicate = 'account_of' AND src = ?")
        .get(graphNodeId('account', accounts.main)).retired_at,
      at(60),
      'retired at the end of the link'
    );
    assert.deepEqual(rowIds(saidBy(db, ctx.group, 'person:alice')), [], 'her main account was her only public one');
    assert.deepEqual(rowIds(saidBy(db, ctx.dm, 'person:alice')), [ids.alt, ids.replyToReply], 'the alt is still hers');

    // A retirement: the reply leaves; its edges retire with it, its witness goes, the walks lose it.
    handleTx(env, () => {
      db.prepare('UPDATE sources SET retired_at = ? WHERE id = ?').run(at(70), ids.reply);
      projectRow(db, 'sources', { id: ids.reply }, { at: at(70) });
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
    assert.deepEqual(rowIds(repliesTo(db, ctx.group, ids.her)), [], 'the reply to the reply hung off the retired line');
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

test('claim edits: every new version keeps its sources; a stale base is refused and recorded; a current one or none goes through', () => {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
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
    const write = (runId, claims) =>
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
      });
    const first = write('run:1', [{ op: 'confirm', id: 'clm:tea', sources: ['src:1'], base: 'cv:tea:1' }]);
    assert.equal(first.confirmed, 1);
    const newest = newestClaimVersion(db, 'clm:tea');
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
    assert.equal(newestClaimVersion(db, 'clm:tea'), newest, 'nothing written');
    // A base of null says the session read no version: stale too, once one exists.
    assert.equal(write('run:3', [{ op: 'confirm', id: 'clm:tea', sources: ['src:2'], base: null }]).rejected, 1);

    // The current base goes through; a retire's sources speak against the claim.
    const retired = write('run:4', [
      { op: 'retire', id: 'clm:tea', truth: 'historical', reason: 'stopped', sources: ['src:3'], base: newest },
    ]);
    assert.equal(retired.retired, 1);
    assert.deepEqual(
      db
        .prepare('SELECT source_id, role FROM claim_version_sources WHERE version_id = ?')
        .all(newestClaimVersion(db, 'clm:tea'))
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

/** A data directory written into a database at schema v8, with claim links the units never make (one to a line nobody stored). */
function importedAtV8() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-v9-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const file = path.join(root, 'memory.db');
  const old = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 8) });
  assert.equal(seedUnits(old, data, { log: quiet }).errors, 0);
  assert.equal(schemaVersion(old.db), 8);
  const db = old.db;
  const source = db.prepare("SELECT id FROM sources WHERE kind = 'seen' ORDER BY rowid LIMIT 1").get().id;
  db.prepare(
    `INSERT INTO claims (id, subject_kind, subject_id, kind, text, scope_kind, scope_iface, scope_dm, audience_id, created_at)
    VALUES ('k-v9', 'person', 'person:discord:100000000000000001', 'detail', 'synthetic', 'group', 'discord', NULL, 'aud:group:discord', '2026-10-01T00:00:00.000Z')`
  ).run();
  db.prepare(
    "INSERT INTO claim_versions (id, claim_id, text, recorded_at, event) VALUES ('kv-1', 'k-v9', 'a', '2026-10-01T00:00:00.000Z', 'add'), ('kv-2', 'k-v9', 'b', '2026-10-02T00:00:00.000Z', 'revise')"
  ).run();
  db.prepare(
    "INSERT INTO claim_sources (claim_id, source_id, position) VALUES ('k-v9', ?, 0), ('k-v9', 'src:discord:never-stored:1:seen', 1), ('k-v9', ?, 2)"
  ).run(source, source);
  db.prepare(
    "INSERT INTO diary_mirrors (diary_id, iface, place_id, native_ids, posted_at) VALUES ('diary-x', 'discord', 'p1', '[\"1\"]', '2026-10-03T00:00:00.000Z')"
  ).run();
  old.close();
  return { root, data, file, source, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('v9 migration: durable ids, legacy evidence marked, the projection pending then done; foreign keys and integrity; timings', (t) => {
  const env = importedAtV8();
  try {
    const started = performance.now();
    const handle = openMemoryDb(env.file);
    const migrated = performance.now() - started;
    const { db } = handle;
    try {
      // The database goes to the newest schema; v9 is the ninth entry.
      assert.equal(schemaVersion(db), MIGRATIONS.length);
      assert.ok(MIGRATIONS.length >= 9);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      for (const table of ['claim_sources', 'episode_sources', 'diary_mirrors']) {
        assert.equal(
          count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE id IS NULL`),
          0,
          `${table}: every link has its id`
        );
        assert.equal(
          count(db, `SELECT COUNT(DISTINCT id) AS n FROM ${table}`),
          count(db, `SELECT COUNT(*) AS n FROM ${table}`),
          `${table}: ids are unique`
        );
      }
      assert.deepEqual(
        db
          .prepare("SELECT id FROM claim_sources WHERE claim_id = 'k-v9' ORDER BY position")
          .all()
          .map((row) => row.id),
        [
          'cs:k-v9:s:' + env.source,
          'cs:k-v9:s:src:discord:never-stored:1:seen',
          `cs:k-v9:s:${env.source}#dup${db.prepare("SELECT rowid AS r FROM claim_sources WHERE claim_id = 'k-v9' AND position = 2").get().r}`,
        ]
      );
      assert.equal(
        db.prepare("SELECT id FROM diary_mirrors WHERE diary_id = 'diary-x'").get().id,
        'mirror:diary-x:discord:p1'
      );
      db.prepare("INSERT INTO episode_sources (episode_id, source_id, position) VALUES ('ep-new', ?, 0)").run(
        env.source
      );
      assert.equal(
        db.prepare("SELECT id FROM episode_sources WHERE episode_id = 'ep-new'").get().id,
        `es:ep-new:s:${env.source}`,
        'a new row gets its id the same way'
      );
      // Claim-level links copied to the newest version, marked legacy; the unstored line stays claim-level only.
      assert.deepEqual(
        db
          .prepare("SELECT version_id, source_id, role, legacy FROM claim_version_sources WHERE version_id LIKE 'kv-%'")
          .all()
          .map((row) => ({ ...row })),
        [{ version_id: 'kv-2', source_id: env.source, role: 'supports', legacy: 1 }]
      );
      assert.equal(count(db, 'SELECT COUNT(*) AS n FROM claim_version_sources WHERE legacy = 0'), 0);

      // The projection: pending after the migration, done by the next full pass, in slices.
      assert.equal(graphPending(handle), true);
      assert.equal(count(db, 'SELECT COUNT(*) AS n FROM graph_edges'), 0);
      const projected = projectPending(handle, { sliceUnits: 7 });
      assert.equal(projected.done, true);
      assert.equal(graphPending(handle), false);
      t.diagnostic(
        `v9 migration of the fixture database: ${migrated.toFixed(1)} ms; the pending projection: ${projected.units} units in ${projected.ms} ms`
      );
      const sources = count(db, 'SELECT COUNT(*) AS n FROM sources');
      assert.equal(
        count(db, "SELECT COUNT(*) AS n FROM graph_nodes n JOIN sources s ON s.id = n.row_id WHERE n.kind = 'source'"),
        sources,
        'every line is a node'
      );
      assert.deepEqual(
        {
          ...db
            .prepare("SELECT kind, created_at FROM graph_nodes WHERE id = 'source:src:discord:never-stored:1:seen'")
            .get(),
        },
        { kind: 'source', created_at: '1970-01-01T00:00:00.000Z' },
        'a line a claim names but nobody stored is a placeholder node'
      );
      assert.equal(
        count(db, "SELECT COUNT(*) AS n FROM graph_edges WHERE predicate = 'located_in'"),
        sources,
        'every line is in its place'
      );
      assert.equal(
        count(
          db,
          "SELECT COUNT(*) AS n FROM graph_edges WHERE predicate = 'derived_from' AND src = 'claim_version:kv-2'"
        ),
        1
      );
      assert.equal(
        count(db, "SELECT COUNT(*) AS n FROM graph_edges WHERE predicate = 'derived_from' AND src = 'claim:k-v9'"),
        2,
        'claim-level: the stored line and the one nobody stored'
      );
      assert.equal(
        count(
          db,
          "SELECT COUNT(*) AS n FROM graph_edges WHERE predicate = 'account_of' AND retired_at IS NULL AND audience_id = 'aud:group:discord'"
        ),
        count(db, "SELECT COUNT(*) AS n FROM account_person_links WHERE state = 'verified'")
      );
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      const timed = reproject(handle);
      t.diagnostic(`reproject of the fixture database: ${timed.units} units, ${timed.edges} edges in ${timed.ms} ms`);
    } finally {
      handle.close();
    }
  } finally {
    env.done();
  }
});

test('v9 contracts: a replay of the unit writes projects the same rows; reproject idempotent; rebuild equal; the VACUUM round trip', () => {
  const env = importedAtV8();
  try {
    const handle = openMemoryDb(env.file);
    assert.equal(
      seedUnits(handle, env.data, { log: quiet }).errors,
      0,
      'a full pass also finishes the pending projection'
    );
    assert.equal(graphPending(handle), false);
    handle.close();

    // Every unit written again: the projection the writers keep is the same rows as before.
    const writer = openMemoryDb(env.file);
    const before = hashesOf(writer.db, GRAPH);
    const replay = seedUnits(writer, env.data, { log: quiet });
    assert.equal(replay.errors, 0);
    assert.ok(replay.units > 10);
    assert.deepEqual(hashesOf(writer.db, GRAPH), before, 'a replay re-projects to the same rows');
    // Reproject twice: the same hashes; rebuild: every derived table equal.
    reproject(writer);
    assert.deepEqual(hashesOf(writer.db, GRAPH), before);
    reproject(writer);
    assert.deepEqual(hashesOf(writer.db, GRAPH), before);
    const derived = ['graph_nodes', 'graph_edges', 'node_access', 'sources_fts', 'sources_tri'];
    const beforeRebuild = hashesOf(writer.db, derived);
    writer.close();
    const rebuilt = run('rebuild', '--db', env.file);
    assert.equal(rebuilt.code, 0, rebuilt.text);
    assert.match(rebuilt.text, /every derived table equal to before/, rebuilt.text);
    const reader = openMemoryDb(env.file, { readOnly: true });
    assert.deepEqual(hashesOf(reader.db, derived), beforeRebuild);
    assert.deepEqual(reader.db.prepare('PRAGMA foreign_key_check').all(), []);
    reader.close();

    // The round trip: a VACUUM INTO copy hashes like its source, table by table.
    const copy = path.join(env.root, 'copy.db');
    const source = openMemoryDb(env.file, { readOnly: true });
    source.db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
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
    const hashed = run('hash', '--db', env.file, '--tables', 'graph_edges,sources_fts,nope');
    assert.equal(hashed.code, 1);
    assert.match(hashed.text, /graph_edges +\d+ +[0-9a-f]{64}/);
    assert.match(hashed.text, /nope +no such table/);
    const stats = run('stats', '--db', env.file);
    assert.equal(stats.code, 0);
    for (const table of [
      'graph_edges',
      'node_access',
      'claim_version_sources',
      'participants',
      'capture_bundles',
      'execution_contexts',
    ])
      assert.match(stats.text, new RegExp(`^${table} `, 'm'), table);
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
