// Public memory-session writer regressions for cross-interface evidence and retained DM provenance.
// The shared fixture uses an in-memory SQLite database and synthetic sources only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertRows } from '../src/memory/db/rows.ts';
import { messageSourceId } from '../src/memory/db/ids.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { groupContext, scopeWhere, whereFor } from '../src/memory/db/scope.ts';
import { ADA, NOW, dmPlaceOf, fixture, personOf } from './fixtures/memory-db/session-rig.ts';

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
