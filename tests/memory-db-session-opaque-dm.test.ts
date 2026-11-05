// A memory session of a DM whose partner is an opaque person (src/memory/db/session-write.ts, session.ts#scopesOf): the
// triple of such a DM spells no conversation, so the sweep finds the DM by its stored audience and the writer narrows on
// audience ids. A fact learned there stays that partner's and no one else's. Synthetic content only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audienceWhere } from '../src/memory/db/scope.ts';
import { scopesOf, sweep } from '../src/memory/db/session.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { baseConfig, fakeLlm, memoryBlock, prompts } from './fixtures/memory-db/session-rig.ts';
import { ALEX, DM_ALEX, addSource, dmAudience, semanticWorld } from './fixtures/memory-db/semantic-world.ts';
import type { World } from './fixtures/memory-db/semantic-world.ts';

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

test('the sweep finds a DM with an opaque partner as its own scope, and its answer stays in that DM', async () => {
  // Bug: the sweep drops the scope as malformed, so nothing said in this DM is ever remembered.
  const world = semanticWorld();
  addSource(world, 'alex', 'between us');
  const found = scopesOf(world.db).find((one) => one.scope.scope_dm === ALEX);
  assert.equal(found?.audienceId, dmAudience(DM_ALEX));
  const answer = {
    claims: [{ op: 'add', subject: ALEX, kind: 'detail', text: NOTE, how: 'said', sources: [1] }],
  };
  await sweep({
    db: world.db,
    write: (update: unknown) => Promise.resolve(applyMemoryWrite(world.handle, update)),
    llm: fakeLlm(memoryBlock(answer)),
    hot: { config: baseConfig({ mode: 'apply', settleMinutes: 0 }), prompts },
    env: { OPENROUTER_MEMORY_KEY: 'k' },
    now: () => Date.UTC(2026, 10, 5, 12),
    log: {},
    selfName: 'Nep',
  });
  const row = world.db.prepare('SELECT audience_id FROM claims WHERE text = ?').get(NOTE);
  assert.equal(row?.audience_id, dmAudience(DM_ALEX));
  world.handle.close();
});
