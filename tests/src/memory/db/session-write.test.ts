// Public memory-session writer regressions for cross-interface evidence and retained DM provenance.
// The shared fixture uses an in-memory SQLite database and synthetic sources only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertRows } from '../../../../src/memory/db/rows.ts';
import { messageSourceId } from '../../../../src/memory/db/ids.ts';
import { applyMemoryWrite } from '../../../../src/memory/db/session-write.ts';
import { cursorKey } from '../../../../src/memory/db/session.ts';
import * as memoryIds from '../../../../src/memory/db/ids.ts';
import { audienceWhere, groupContext, scopeWhere, whereFor } from '../../../../src/memory/db/scope.ts';
import {
  ADA,
  NOW,
  chat,
  count,
  dmPlaceOf,
  fixture,
  messageSourceOf,
  personOf,
} from '../../../fixtures/memory-db/session-rig.ts';
import { ALEX, DM_ALEX, addSource, dmAudience, semanticWorld } from '../../../fixtures/memory-db/semantic-world.ts';
import type { World } from '../../../fixtures/memory-db/semantic-world.ts';
import { freshMemoryDb } from '../../../fixtures/memory-db-copy.ts';
import { turnReadRows } from '../../../../src/memory/db/service.ts';
import { writeTurnReadRows } from '../../../../src/memory/db/session-write.ts';
import { addEntity, commit, successor, worksOn } from '../../../fixtures/memory-db/semantic-world.ts';

const GROUP = { scope_kind: 'group', scope_iface: 'discord', scope_dm: null };
const DM_ADA = { scope_kind: 'dm', scope_iface: 'discord', scope_dm: personOf(ADA) };
const runOf = (extra = {}) => ({
  id: 'run:cross-interface',
  scopeKey: 'group:discord',
  scope: GROUP,
  batchKey: 'apply|cross-interface',
  startedAt: new Date(NOW).toISOString(),
  finishedAt: new Date(NOW).toISOString(),
  outcome: 'ok',
  counts: {},
  errors: [],
  ...extra,
});
const emptyPlan = (extra: Record<string, unknown>) => ({
  claims: [],
  episodes: [],
  affinity: [],
  descriptions: [],
  ...extra,
});
function applyOf(env: ReturnType<typeof fixture>, update: object): Record<string, unknown> {
  const result = applyMemoryWrite(env.handle, {
    kind: 'session',
    mode: 'apply',
    run: runOf(),
    maxDelta: 5,
    now: NOW,
    ...update,
  });
  assert.ok(result !== null && typeof result === 'object');
  return { ...result };
}

function foreignSource(env: ReturnType<typeof fixture>, native: string): string {
  const id = messageSourceId('other', native, 1, 'seen');
  insertRows(env.db, {
    sources: [
      {
        id,
        kind: 'seen',
        iface: 'other',
        native_id: native,
        revision: 1,
        text: 'a shared interest elsewhere',
        occurred_at: new Date(NOW - 30 * 60_000).toISOString(),
        scope_kind: 'group',
        scope_iface: 'other',
        scope_dm: null,
      },
    ],
  });
  return id;
}

test('a session derives group claims, episodes and affinity from evidence on different interfaces', () => {
  // Catches a readable foreign group source being rejected or its derived rows becoming internal.
  const env = fixture();
  try {
    const local = env.say({ native: 'local-evidence', minutesAgo: 40, text: 'a shared interest' });
    const foreign = foreignSource(env, 'foreign-evidence');
    const result = applyOf(env, {
      plan: emptyPlan({
        claims: [
          {
            op: 'add',
            subjectKind: 'person',
            subjectId: personOf(ADA),
            kind: 'interest',
            text: 'shared across groups',
            how: 'said',
            sources: [local, foreign],
            when: null,
          },
        ],
        episodes: [{ subjectId: personOf(ADA), what: 'a shared moment', feeling: 'warm', sources: [local, foreign] }],
        affinity: [{ personId: personOf(ADA), delta: 2, reason: 'shared interest', sources: [local, foreign] }],
      }),
    });
    assert.deepEqual([result.added, result.episodes, result.affinity, result.rejected], [1, 1, 1, 0]);
    for (const table of ['claims', 'episodes', 'affinity_events']) {
      const row = env.db.prepare(`SELECT scope_kind, scope_iface, scope_dm, audience_id FROM ${table}`).get();
      assert.ok(row);
      assert.deepEqual(
        { ...row },
        { scope_kind: 'group', scope_iface: 'discord', scope_dm: null, audience_id: 'aud:group:discord' }
      );
    }
  } finally {
    env.done();
  }
});

test('a private derived claim keeps its DM scope when later evidence comes from another interface group', () => {
  // Catches cross-interface evidence making a private revision internal or exposing it to a group.
  const env = fixture();
  try {
    env.storeDmPlace(ADA); // No writer makes the DM place from the person id.
    const privateLine = env.say({
      native: 'private-evidence',
      minutesAgo: 40,
      text: 'a private interest',
      scope: DM_ADA,
      place: dmPlaceOf(ADA),
    });
    const foreign = foreignSource(env, 'foreign-confirmation');
    const first = applyOf(env, {
      run: runOf({
        id: 'run:private-first',
        batchKey: 'private-first',
        scope: DM_ADA,
        scopeKey: `dm:discord:${personOf(ADA)}`,
      }),
      plan: emptyPlan({
        claims: [
          {
            op: 'add',
            subjectKind: 'person',
            subjectId: personOf(ADA),
            kind: 'interest',
            text: 'private derived interest',
            how: 'said',
            sources: [privateLine, foreign],
            when: null,
          },
        ],
      }),
    });
    assert.equal(first.added, 1);
    const claim = env.db.prepare('SELECT id FROM claims').get();
    assert.ok(claim);
    const next = applyOf(env, {
      run: runOf({
        id: 'run:private-next',
        batchKey: 'private-next',
        scope: DM_ADA,
        scopeKey: `dm:discord:${personOf(ADA)}`,
      }),
      plan: emptyPlan({ claims: [{ op: 'confirm', id: claim.id, sources: [foreign] }] }),
    });
    assert.deepEqual([next.confirmed, next.rejected], [1, 0]);
    const stored = env.db.prepare('SELECT scope_kind, scope_iface, scope_dm FROM claims WHERE id = ?').get(claim.id);
    assert.deepEqual({ ...stored }, DM_ADA);
    const filter = whereFor(groupContext('other'), 'c');
    assert.deepEqual(env.db.prepare(`SELECT c.id FROM claims c WHERE ${filter.sql}`).all(...filter.params), []);
    // Runtime audience reads must preserve the same private boundary as the compatibility triple.
    const audience = env.db.prepare('SELECT audience_id FROM claims WHERE id = ?').get(claim.id);
    assert.equal(audience?.audience_id, `aud:dm:${dmPlaceOf(ADA)}`);
    const normalized = scopeWhere({ ...groupContext('other'), audienceColumn: true }, 'c');
    assert.deepEqual(env.db.prepare(`SELECT c.id FROM claims c WHERE ${normalized.sql}`).all(...normalized.params), []);
  } finally {
    env.done();
  }
});

test("a DM run with no audience writes under its partner's stored DM place, never one spelled from the partner's id", () => {
  // Bug: a partner whose id spells a DM place gets that spelled place as the run's audience, not the place stored for them.
  const env = fixture();
  try {
    env.db
      .prepare(
        `INSERT INTO places (id, iface, kind, native_id, chat, scope_kind, partner_account, partner_person)
         VALUES ('place:dm-ada', 'discord', 'dm', NULL, 'dm', 'dm', ?, ?)`
      )
      .run(`discord:${ADA}`, personOf(ADA));
    const line = env.say({ native: 'group-evidence', minutesAgo: 40, text: 'a shared interest' });
    const result = applyOf(env, {
      run: runOf({ id: 'run:dm-no-audience', batchKey: 'dm-no-audience', scope: DM_ADA, scopeKey: 'dm:discord:place' }),
      plan: emptyPlan({
        claims: [
          {
            op: 'add',
            subjectKind: 'person',
            subjectId: personOf(ADA),
            kind: 'interest',
            text: 'told in the DM',
            how: 'said',
            sources: [line],
            when: null,
          },
        ],
      }),
    });
    assert.equal(result.added, 1);
    assert.equal(env.db.prepare('SELECT audience_id FROM claims').get()?.audience_id, 'aud:dm:place:dm-ada');
  } finally {
    env.done();
  }
});

// ---------- modes, idempotent runs, the cursor and the evidence of a session write ----------

const sessionRunOf = (extra = {}) => ({
  id: 'run:t',
  sweepId: 'sweep:t',
  scopeKey: 'group:discord',
  scope: GROUP,
  batchKey: 'apply|group:discord|0|9|0',
  startedAt: new Date(NOW).toISOString(),
  finishedAt: new Date(NOW).toISOString(),
  cursorFrom: 0,
  cursorTo: 9,
  sourcesN: 1,
  outcome: 'ok',
  counts: {},
  errors: [],
  ...extra,
});
const sessionEmptyPlan = (extra: Record<string, unknown> = {}) => ({
  claims: [],
  episodes: [],
  affinity: [],
  descriptions: [],
  ...extra,
});
type Applied = Record<string, number | boolean | undefined>; // what a session write answers: the counts the tests read
const sessionApplyOf = (env: ReturnType<typeof fixture>, update: object) =>
  applyMemoryWrite(env.handle, {
    kind: 'session',
    mode: 'apply',
    run: sessionRunOf(),
    maxDelta: 5,
    now: NOW,
    ...update,
  }) as Applied;

test('modes: the writer itself refuses any mode but shadow and apply', () => {
  const env = fixture();
  try {
    const ids = chat(env);
    const plan = sessionEmptyPlan({
      claims: [
        {
          op: 'add',
          subjectKind: 'self',
          subjectId: memoryIds.SELF_PERSON,
          kind: 'self_fact',
          text: 'a fact',
          how: 'saw',
          sources: [ids.a],
          when: null,
        },
      ],
    });
    for (const mode of ['draft', 'off', undefined])
      assert.throws(
        () => sessionApplyOf(env, { plan, mode }),
        (error: NodeJS.ErrnoException) => error.code === 'BAD_MODE',
        `mode ${mode}`
      );
    assert.throws(
      () => applyMemoryWrite(env.handle, { kind: 'other' }),
      (error: NodeJS.ErrnoException) => error.code === 'BAD_UPDATE'
    );
    assert.deepEqual(
      [count(env.db, 'session_runs'), count(env.db, 'claims', "author = 'her'"), count(env.db, 'decisions')],
      [0, 0, 0],
      'a refusal writes nothing'
    );
    assert.equal(sessionApplyOf(env, { plan }).added, 1);
    // shadow proposes
    assert.equal(
      (
        applyMemoryWrite(env.handle, {
          kind: 'session',
          mode: 'shadow',
          run: sessionRunOf({ id: 'run:s', batchKey: 'shadow|x' }),
          plan,
          now: NOW,
        }) as Applied
      ).proposed,
      1
    );
  } finally {
    env.done();
  }
});

test('a run is applied once: a retried batch returns the first result and changes nothing, affinity above all', () => {
  const env = fixture();
  try {
    const ids = chat(env);
    const plan = sessionEmptyPlan({
      episodes: [{ subjectId: personOf(ADA), what: 'a kind moment', feeling: '', sources: [ids.a] }],
      affinity: [{ personId: personOf(ADA), delta: 3, reason: 'kind', sources: [ids.a] }],
      claims: [
        {
          op: 'add',
          subjectKind: 'person',
          subjectId: personOf(ADA),
          kind: 'detail',
          text: 'new fact',
          how: 'said',
          sources: [ids.a],
          when: null,
        },
      ],
    });
    const cursor = cursorKey('apply', 'group:discord');
    const update = { plan, advance: { key: cursor, value: 9, expect: 0 } };
    const first = sessionApplyOf(env, update);
    assert.deepEqual([first.added, first.episodes, first.affinity, first.replayed], [1, 1, 1, undefined]);
    assert.equal(env.db.prepare('SELECT affinity FROM people WHERE id = ?').get(personOf(ADA))!.affinity, 8);
    const again = sessionApplyOf(env, update);
    assert.deepEqual([again.replayed, again.added, again.affinity], [true, 1, 1], 'the first result comes back');
    const otherRun = sessionApplyOf(env, { ...update, run: sessionRunOf({ id: 'run:retry' }) });
    assert.equal(otherRun.replayed, true, 'a retry under another run id is the same batch');
    assert.equal(
      env.db.prepare('SELECT affinity FROM people WHERE id = ?').get(personOf(ADA))!.affinity,
      8,
      'the attitude moved once'
    );
    assert.deepEqual(
      [
        count(env.db, 'affinity_events'),
        count(env.db, 'episodes'),
        count(env.db, 'claims', "author = 'her'"),
        count(env.db, 'session_runs'),
      ],
      [1, 1, 1, 1]
    );
    assert.equal(env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursor)!.value, '9');
    // the same event id never applies twice, whatever the batch key
    const sameEvent = sessionApplyOf(env, { run: sessionRunOf({ batchKey: 'apply|other' }), plan });
    assert.equal(sameEvent.duplicate, 1);
    assert.equal(env.db.prepare('SELECT affinity FROM people WHERE id = ?').get(personOf(ADA))!.affinity, 8);
  } finally {
    env.done();
  }
});

test('the cursor moves by compare-and-set in the transaction of the write: a stale cursor writes nothing', () => {
  const env = fixture();
  try {
    const ids = chat(env);
    const cursor = cursorKey('apply', 'group:discord');
    const plan = sessionEmptyPlan({
      episodes: [{ subjectId: personOf(ADA), what: 'x', feeling: '', sources: [ids.a] }],
    });
    env.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(cursor, '4');
    assert.throws(
      () => sessionApplyOf(env, { plan, advance: { key: cursor, value: 9, expect: 0 } }),
      (error: NodeJS.ErrnoException) => error.code === 'CURSOR_CONFLICT'
    );
    assert.deepEqual(
      [count(env.db, 'episodes'), count(env.db, 'session_runs'), count(env.db, 'decisions')],
      [0, 0, 0],
      'the writes rolled back with it'
    );
    assert.equal(env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursor)!.value, '4');
    sessionApplyOf(env, { plan, advance: { key: cursor, value: 9, expect: 4 } });
    assert.equal(env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursor)!.value, '9');
  } finally {
    env.done();
  }
});

test('evidence: an op with a source that does not exist is rejected whole; a revision needs its reason', () => {
  const env = fixture();
  try {
    const ids = chat(env);
    env.claim({ id: 'cl-ada', subjectId: personOf(ADA), text: 'likes café mornings' });
    const plan = sessionEmptyPlan({
      claims: [
        {
          op: 'add',
          subjectKind: 'person',
          subjectId: personOf(ADA),
          kind: 'detail',
          text: 'half evidence',
          how: 'said',
          sources: [ids.a, 'src:missing'],
          when: null,
        },
        { op: 'revise', id: 'cl-ada', text: 'likes tea', how: 'said', sources: [ids.a], reason: '' },
        { op: 'retire', id: 'cl-ada', truth: 'historical', sources: [ids.a] },
        { op: 'confirm', id: 'cl-ada', sources: [] },
      ],
      affinity: [{ personId: personOf(ADA), delta: 2, reason: '', sources: [ids.a] }],
      episodes: [{ subjectId: personOf(ADA), what: 'x', feeling: '', sources: ['src:missing'] }],
    });
    const counts = sessionApplyOf(env, { plan });
    assert.equal(counts.rejected, 6);
    assert.deepEqual(
      [counts.added, counts.revised, counts.retired, counts.confirmed, counts.episodes, counts.affinity],
      [0, 0, 0, 0, 0, 0]
    );
    assert.deepEqual(
      [
        count(env.db, 'claims', "author = 'her'"),
        count(env.db, 'claim_sources'),
        count(env.db, 'episodes'),
        count(env.db, 'affinity_events'),
      ],
      [0, 0, 0, 0]
    );
    assert.equal(env.db.prepare("SELECT text FROM claims WHERE id = 'cl-ada'").get()!.text, 'likes café mornings');
    assert.deepEqual(
      env.db
        .prepare('SELECT action FROM decisions ORDER BY id')
        .all()
        .map((row) => row.action),
      [
        'rejected:unknown_source',
        'rejected:no_reason',
        'rejected:no_reason',
        'rejected:unknown_source',
        'rejected:unknown_source',
        'rejected:no_reason',
      ]
    );
  } finally {
    env.done();
  }
});

test('a revised or confirmed claim takes its scope from the evidence of the new version; a private line on a group claim makes a private claim, the group one stays', () => {
  const env = fixture();
  try {
    env.storeDmPlace(ADA); // No writer makes the DM place from the person id.
    chat(env);
    const dmLine = env.say({
      native: 'd1',
      minutesAgo: 50,
      text: 'I moved to Lyon, keep it quiet',
      scope: DM_ADA,
      place: dmPlaceOf(ADA),
    });
    const groupLine = messageSourceOf('m5', 1, 'seen');
    env.claim({ id: 'cl-home', subjectId: personOf(ADA), kind: 'detail', text: 'lives in Athens' });
    env.claim({ id: 'cl-tea', subjectId: personOf(ADA), kind: 'interest', text: 'likes tea' });
    env.claim({ id: 'cl-chess', subjectId: personOf(ADA), kind: 'interest', text: 'plays chess' });
    const dmRun = sessionRunOf({
      id: 'run:dm',
      scope: DM_ADA,
      scopeKey: `dm:discord:${personOf(ADA)}`,
      batchKey: 'apply|dm',
    });
    const counts = sessionApplyOf(env, {
      run: dmRun,
      plan: sessionEmptyPlan({
        claims: [
          {
            op: 'revise',
            id: 'cl-home',
            text: 'lives in Lyon',
            how: 'said',
            sources: [dmLine],
            reason: 'told in private',
          },
          { op: 'confirm', id: 'cl-tea', sources: [dmLine] },
          { op: 'retire', id: 'cl-chess', truth: 'historical', reason: 'stopped', sources: [dmLine] },
        ],
      }),
    });
    assert.deepEqual([counts.revised, counts.confirmed, counts.retired, counts.derived], [1, 1, 1, 3]);
    for (const [id, text] of [
      ['cl-home', 'lives in Athens'],
      ['cl-tea', 'likes tea'],
      ['cl-chess', 'plays chess'],
    ]) {
      const old = env.db
        .prepare('SELECT text, scope_kind, last_seen_at, truth, shown FROM claims WHERE id = ?')
        .get(id);
      assert.deepEqual(
        [old!.text, old!.scope_kind, old!.last_seen_at, old!.truth, old!.shown],
        [text, 'group', '2026-10-20', 'current', 1],
        `the group claim ${id} stays as it was`
      );
      assert.equal(count(env.db, 'claim_versions', `claim_id = '${id}'`), 0);
    }
    const derived = env.db.prepare("SELECT * FROM claims WHERE author = 'her' ORDER BY text").all();
    assert.deepEqual(
      derived.map((row) => [row.text, row.scope_kind, row.scope_dm, row.truth]),
      [
        ['likes tea', 'dm', personOf(ADA), 'current'],
        ['lives in Lyon', 'dm', personOf(ADA), 'current'],
        ['plays chess', 'dm', personOf(ADA), 'historical'],
      ]
    );
    assert.equal(JSON.parse(derived[1].extra as string).derivedFrom, 'cl-home');
    assert.deepEqual(
      env.db
        .prepare('SELECT source_id FROM claim_sources WHERE claim_id = ?')
        .all(derived[1].id)
        .map((row) => row.source_id),
      [dmLine],
      'only the new evidence'
    );
    assert.deepEqual(
      env.db
        .prepare('SELECT event FROM claim_versions WHERE claim_id = ?')
        .all(derived[1].id)
        .map((row) => row.event),
      ['revise']
    );
    // a group reader never sees the private versions
    const group = whereFor(groupContext('discord'), 'c');
    const seen = env.db
      .prepare(`SELECT c.text FROM claims c WHERE c.subject_id = ? AND ${group.sql} ORDER BY c.text`)
      .all(personOf(ADA), ...group.params)
      .map((row) => row.text);
    assert.deepEqual(seen, ['lives in Athens', 'likes tea', 'plays chess'].sort());
    // a revision from group evidence stays on the group claim
    const inPlace = sessionApplyOf(env, {
      run: sessionRunOf({ id: 'run:g', batchKey: 'apply|g' }),
      plan: sessionEmptyPlan({
        claims: [
          {
            op: 'revise',
            id: 'cl-home',
            text: 'lives in Thessaloniki',
            how: 'said',
            sources: [groupLine],
            reason: 'said so',
          },
        ],
      }),
    });
    assert.deepEqual([inPlace.revised, inPlace.derived], [1, 0]);
    assert.equal(env.db.prepare("SELECT text FROM claims WHERE id = 'cl-home'").get()!.text, 'lives in Thessaloniki');
    // a group run cannot touch a private claim
    env.claim({ id: 'cl-private', subjectId: personOf(ADA), text: 'private thing', scope: DM_ADA });
    const out = sessionApplyOf(env, {
      run: sessionRunOf({ id: 'run:o', batchKey: 'apply|o' }),
      plan: sessionEmptyPlan({ claims: [{ op: 'confirm', id: 'cl-private', sources: [groupLine] }] }),
    });
    assert.deepEqual([out.rejected, out.confirmed], [1, 0]);
  } finally {
    env.done();
  }
});

test('child links: a retired link is not a link; a link is not added twice', () => {
  const env = fixture();
  try {
    const ids = chat(env);
    env.claim({ id: 'cl-ada', subjectId: personOf(ADA), text: 'likes café mornings' });
    env.db
      .prepare(
        "INSERT INTO claim_sources (claim_id, source_id, position, retired_at) VALUES ('cl-ada', ?, 0, '2026-10-01T00:00:00.000Z')"
      )
      .run(ids.a);
    env.db.prepare("INSERT INTO claim_sources (claim_id, source_id, position) VALUES ('cl-ada', ?, 1)").run(ids.b);
    sessionApplyOf(env, {
      plan: sessionEmptyPlan({ claims: [{ op: 'confirm', id: 'cl-ada', sources: [ids.a, ids.b] }] }),
    });
    const links = env.db
      .prepare("SELECT source_id, retired_at FROM claim_sources WHERE claim_id = 'cl-ada' ORDER BY rowid")
      .all();
    assert.deepEqual(
      links.map((row) => [row.source_id, row.retired_at === null]),
      [
        [ids.a, false],
        [ids.b, true],
        [ids.a, true],
      ],
      'the retired link did not count as existing; the live one was not added twice'
    );
  } finally {
    env.done();
  }
});

// ---------- a DM whose partner is an opaque person ----------

const NOTE = 'told only in this DM';
const scopeOfAlex = { scope_kind: 'dm', scope_iface: 'discord', scope_dm: ALEX };

function writePlan(world: World, source: string, audienceId: string | null) {
  applyMemoryWrite(world.handle, {
    kind: 'session',
    mode: 'apply',
    run: {
      id: 'run:one',
      scopeKey: 'dm:discord:place',
      scope: scopeOfAlex,
      audienceId,
      startedAt: '2026-11-05T10:00:00.000Z',
      finishedAt: '2026-11-05T10:00:00.000Z',
      outcome: 'ok',
    },
    plan: {
      claims: [
        {
          op: 'add',
          subjectKind: 'person',
          subjectId: ALEX,
          kind: 'detail',
          text: NOTE,
          how: 'said',
          sources: [source],
        },
      ],
    },
    now: Date.UTC(2026, 10, 5, 10),
  });
}

const readers = (world: World, ctx: Parameters<typeof audienceWhere>[0]): number => {
  const where = audienceWhere(ctx);
  return world.db.prepare(`SELECT id FROM claims WHERE text = ? AND ${where.sql}`).all(NOTE, ...where.params).length;
};

test('a fact from a DM with an opaque partner is that DM place, and only its partner reads it', () => {
  // Bug: the triple spells no place, so the fact falls to internal and the partner's own DM never reads it again.
  const world = semanticWorld();
  writePlan(world, addSource(world, 'alex', 'between us'), dmAudience(DM_ALEX));
  const row = world.db.prepare('SELECT audience_id, scope_dm FROM claims WHERE text = ?').get(NOTE);
  assert.deepEqual([row?.audience_id, row?.scope_dm], [dmAudience(DM_ALEX), ALEX]);
  assert.equal(readers(world, world.contexts.alex), 1);
  assert.equal(readers(world, world.contexts.mira), 0);
  assert.equal(readers(world, world.contexts.group), 0);
  assert.equal(readers(world, world.contexts.groups), 0);
  world.handle.close();
});

test('a run that names only the triple finds the one DM place of its opaque partner', () => {
  // Bug: a writer with no audience in hand files the partner's fact as internal.
  const world = semanticWorld();
  writePlan(world, addSource(world, 'alex', 'between us'), null);
  const row = world.db.prepare('SELECT audience_id FROM claims WHERE text = ?').get(NOTE);
  assert.equal(row?.audience_id, dmAudience(DM_ALEX));
  world.handle.close();
});

test('a line of another partner in the evidence puts the fact out of both DMs', () => {
  // Bug: the meet keeps the first DM and shows the second partner's words to the first.
  const world = semanticWorld();
  const one = addSource(world, 'alex', 'from Alex');
  const two = addSource(world, 'mira', 'from Mira');
  applyMemoryWrite(world.handle, {
    kind: 'session',
    mode: 'apply',
    run: { id: 'run:two', scopeKey: 'x', scope: scopeOfAlex, audienceId: dmAudience(DM_ALEX), outcome: 'ok' },
    plan: {
      claims: [
        {
          op: 'add',
          subjectKind: 'person',
          subjectId: ALEX,
          kind: 'detail',
          text: NOTE,
          how: 'said',
          sources: [one, two],
        },
      ],
    },
    now: Date.UTC(2026, 10, 5, 10),
  });
  assert.equal(
    world.db.prepare('SELECT audience_id FROM claims WHERE text = ?').get(NOTE)?.audience_id,
    'aud:internal'
  );
  world.handle.close();
});

test('a unit write is refused: no writer takes one', () => {
  const handle = freshMemoryDb();
  try {
    assert.throws(
      () =>
        applyMemoryWrite(handle, {
          kind: 'unit',
          op: 'value',
          key: { kind: 'state', subject: { type: 'persona', id: 'persona:local' } },
          value: {},
        }),
      (error: unknown) => (error as { code?: unknown }).code === 'BAD_UPDATE'
    );
  } finally {
    handle.close();
  }
});

// The read record of two versions of one claim, and the arguments of the memory.search tool. Real temporary
// databases; no model runs here.

const written = (result: object): { claimId: string; versionId: string } =>
  result as { claimId: string; versionId: string };

// Slice 5: pageReads is deleted with the heartbeat's retrieval, so the reads are the two versions and the source
// named directly; what stays under test is that `turn_reads` keeps two versions of one claim as two rows.
test('the reads of two versions of one claim stay two rows, beside their source', () => {
  // Bug: `turn_reads` keys a claim once, so a later citation of the older version cannot be proved.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const first = written(commit(world, worksOn(ALEX, entityId, [source], { text: 'then' })));
  const second = written(commit(world, worksOn(ALEX, entityId, [source], { ...successor(first), text: 'later' })));
  const reads = [
    { kind: 'claim_version', id: first.versionId, block: 'retrieved' },
    { kind: 'claim_version', id: second.versionId, block: 'retrieved' },
    { kind: 'source_id', id: source, block: 'retrieved' },
  ];
  const rows = turnReadRows(world.db, reads, { iface: 'discord' });
  const groupContext = world.contexts.group;
  world.handle.transaction(() =>
    writeTurnReadRows(
      world.db,
      'turn:1',
      's0',
      rows.map((row) => ({ ...row, context_id: String(groupContext.id) }))
    )
  );
  const stored = world.db
    .prepare("SELECT row_kind, version_id FROM turn_reads WHERE turn_id = 'turn:1' AND row_kind = 'claim_versions'")
    .all()
    .map((row) => row.version_id);
  assert.ok(stored.includes(first.versionId));
  assert.ok(stored.includes(second.versionId));
  const sources = world.db
    .prepare("SELECT row_id FROM turn_reads WHERE turn_id = 'turn:1' AND row_kind = 'sources'")
    .all();
  assert.ok(sources.some((row) => row.row_id === source));
  world.handle.close();
});
