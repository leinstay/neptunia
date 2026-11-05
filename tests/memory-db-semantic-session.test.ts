// The memory session's answer carrying structured facts, stage S3: the two new groups of the `<memory>` object (`entities`
// and `assertions`, documented in docs/prompt-contract.md and prompts/memory-session.md), the fake model's answer through
// a real sweep, and the meeting of the writers (a session write, a unit flush, a legacy upsert) on one sealed version.
// The persona's words stay as she wrote them. Fake model, synthetic text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { sweep, validateAnswer } from '../src/memory/db/session.ts';
import { retireAbsent, writeMapping } from '../src/memory/db/upsert.ts';
import {
  ADA,
  NOW,
  baseConfig,
  chat,
  count,
  ctxOf,
  fakeLlm,
  fixture,
  memoryBlock,
  personOf,
  request,
} from './fixtures/memory-db/session-rig.ts';
import type { Fixture } from './fixtures/memory-db/session-shapes.ts';
import {
  ALEX,
  PUBLIC,
  addEntity,
  addSource,
  commit,
  semanticWorld,
  worksOn,
} from './fixtures/memory-db/semantic-world.ts';

const APPLY = baseConfig({ mode: 'apply' });
const ANSWER = {
  entities: [{ handle: 'n1', kind: 'project', name: 'Lumen', language: 'en', sources: [1] }],
  assertions: [
    {
      predicate: { id: 'project.works_on', version: 1 },
      assertionKind: 'relation',
      text: 'Ada works on Lumen, as she told us',
      arguments: [
        { role: 'person', position: 0, ref: 'Ada' },
        { role: 'project', position: 0, ref: 'n1' },
      ],
      polarity: 'positive',
      how: 'said',
      sources: [1],
    },
  ],
};
const structured = (env: Fixture) => ({
  entities: Number(count(env.db, 'semantic_entities')),
  assertions: Number(count(env.db, 'semantic_assertion_versions', "assertion_kind <> 'text'")),
  arguments: Number(count(env.db, 'semantic_arguments')),
});

test('a session answer stores a sourced project and a relation that names it by its local handle', async () => {
  // Bug: the model must guess an entity id, or the new entity and its relation land in different transactions.
  const env = fixture();
  const lines = chat(env);
  await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock(ANSWER)), config: APPLY }));
  const relation = env.db
    .prepare("SELECT version_id FROM semantic_assertion_versions WHERE predicate_id = 'project.works_on'")
    .get();
  assert.ok(relation, 'the relation was not stored');
  const roles = env.db
    .prepare('SELECT role, ref_kind, ref_id FROM semantic_arguments WHERE version_id = ? ORDER BY role')
    .all(relation.version_id);
  const entity = env.db.prepare('SELECT id FROM semantic_entities').get();
  assert.deepEqual(
    roles.map((row) => [row.role, row.ref_kind, row.ref_id]),
    [
      ['person', 'person', personOf(ADA)],
      ['project', 'entity', entity?.id],
    ]
  );
  const stored = env.db.prepare('SELECT text FROM claim_versions WHERE id = ?').get(relation.version_id);
  assert.equal(stored?.text, 'Ada works on Lumen, as she told us');
  const evidence = env.db
    .prepare('SELECT source_id FROM claim_version_sources WHERE version_id = ?')
    .all(relation.version_id);
  assert.deepEqual(
    evidence.map((row) => row.source_id),
    [lines.a]
  );
  env.done();
});

test('a shadow session writes proposals and no structured row', async () => {
  // Bug: shadow mode changes real memory while the owner still evaluates it.
  const env = fixture();
  chat(env);
  await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock(ANSWER)), config: baseConfig({ mode: 'shadow' }) }));
  assert.deepEqual(structured(env), { entities: 0, assertions: 0, arguments: 0 });
  assert.equal(count(env.db, 'decisions', "action LIKE 'proposed:%'"), 2);
  env.done();
});

test('the same batch written twice stores one entity and one relation', async () => {
  // Bug: a retried write mints a second entity with a new uuid.
  const env = fixture();
  chat(env);
  const writes: Array<Record<string, unknown>> = [];
  const write = (update: unknown) => {
    writes.push(update as Record<string, unknown>);
    return Promise.resolve(applyMemoryWrite(env.handle, update));
  };
  await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock(ANSWER)), config: APPLY, write }));
  const first = structured(env);
  assert.equal(first.entities, 1);
  const applied = writes.find((update) => update.kind === 'session' && update.plan);
  assert.ok(applied, 'the sweep wrote no plan');
  const again = applyMemoryWrite(env.handle, { ...applied, advance: null }) as { replayed?: boolean };
  assert.equal(again.replayed, true);
  assert.deepEqual(structured(env), first);
  env.done();
});

test('an answer with an unknown group says so', () => {
  // Bug: a misspelled group is ignored in silence and she believes the fact was kept.
  const env = fixture();
  chat(env);
  const given = request(env, APPLY);
  const { counts } = validateAnswer({ relationships: [{ a: 1 }] }, { maps: given.maps, people: given.people });
  assert.equal(counts.dropped.unknown_group, 1);
  env.done();
});

const BAD_OPS: ReadonlyArray<[string, Record<string, unknown>, string]> = [
  ['an unknown field on an entity', { entities: [{ ...ANSWER.entities[0], id: 'ent:x' }] }, 'unknown_field'],
  ['an entity with no sources', { entities: [{ ...ANSWER.entities[0], sources: [] }] }, 'no_sources'],
  [
    'an entity citing a line outside the batch',
    { entities: [{ ...ANSWER.entities[0], sources: [999] }] },
    'unknown_source',
  ],
  [
    'an assertion citing a line outside the batch',
    { assertions: [{ ...ANSWER.assertions[0], sources: [999] }] },
    'unknown_source',
  ],
  [
    'an assertion naming a handle nobody gave',
    {
      assertions: [
        {
          ...ANSWER.assertions[0],
          arguments: [
            { role: 'person', position: 0, ref: 'Ada' },
            { role: 'project', position: 0, ref: 'n9' },
          ],
        },
      ],
    },
    'unknown_ref',
  ],
  [
    'an unknown field on an assertion',
    { assertions: [{ ...ANSWER.assertions[0], audience: 'aud:none' }] },
    'unknown_field',
  ],
];

for (const [name, answer, code] of BAD_OPS) {
  test(`drops ${name} with the reason ${code}`, () => {
    // Bug: the op is repaired or half kept, so a fact is stored with evidence she never gave.
    const env = fixture();
    chat(env);
    const given = request(env, APPLY);
    const { plan, counts } = validateAnswer(answer, { maps: given.maps, people: given.people });
    assert.equal(counts.dropped[code], 1);
    assert.deepEqual([plan.entities?.length ?? 0, plan.assertions?.length ?? 0], [0, 0]);
    env.done();
  });
}

test('a rejected kind leaves no entity and rejects the relation that named it, each with its own decision', async () => {
  // Bug: the relation saves with a dangling reference, or the sweep claims both were kept.
  const env = fixture();
  chat(env);
  const bad = { ...ANSWER, entities: [{ ...ANSWER.entities[0], kind: 'dragon' }] };
  await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock(bad)), config: APPLY }));
  assert.deepEqual(structured(env), { entities: 0, assertions: 0, arguments: 0 });
  assert.equal(count(env.db, 'decisions', "action = 'rejected:unknown_kind'"), 1);
  assert.equal(count(env.db, 'decisions', "action = 'rejected:unknown_ref'"), 1);
  env.done();
});

test('a rejected relation does not undo the entity beside it', async () => {
  // Bug: one bad op rolls back the whole answer, and the cursor moves past lost facts.
  const env = fixture();
  chat(env);
  const bad = { ...ANSWER, assertions: [{ ...ANSWER.assertions[0], predicate: { id: 'made.up', version: 1 } }] };
  await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock(bad)), config: APPLY }));
  assert.equal(count(env.db, 'semantic_entities'), 1);
  assert.equal(count(env.db, 'semantic_assertion_versions', "predicate_id = 'made.up'"), 0);
  assert.equal(count(env.db, 'decisions', "action = 'rejected:unknown_predicate'"), 1);
  env.done();
});

test('a plain claim add also snapshots how, truth and audience on its version', async () => {
  // Bug: a new prose fact is left without a snapshot and a later reader falls back to the mutable parent.
  const env = fixture();
  chat(env);
  const plain = {
    claims: [
      { op: 'add', subject: 'Ada', kind: 'interest', text: 'Ada likes café mornings', how: 'said', sources: [1] },
    ],
  };
  await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock(plain)), config: APPLY }));
  const version = env.db
    .prepare("SELECT id FROM claim_versions WHERE origin = 'session' AND text = 'Ada likes café mornings'")
    .get();
  const snapshot = env.db.prepare('SELECT * FROM semantic_assertion_versions WHERE version_id = ?').get(version?.id);
  assert.deepEqual(
    [snapshot?.assertion_kind, snapshot?.how, snapshot?.truth_state, snapshot?.polarity, snapshot?.audience_id],
    ['text', 'said', 'current', 'unknown', PUBLIC]
  );
  env.done();
});

test('a revise appends a snapshot and leaves the sealed text of the version before it', async () => {
  // Bug: the session's own `INSERT OR REPLACE` hits the seal, or a new row inherits the old snapshot.
  const env = fixture();
  chat(env);
  const add = {
    claims: [{ op: 'add', subject: 'Ada', kind: 'interest', text: 'Ada likes tea', how: 'said', sources: [1] }],
  };
  await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock(add)), config: APPLY }));
  const first = env.db.prepare("SELECT id, claim_id FROM claim_versions WHERE text = 'Ada likes tea'").get();
  assert.ok(first);
  env.say({ native: 'm6', minutesAgo: 50, text: 'actually coffee' });
  const given = request(env, APPLY);
  const handle = [...given.maps.claims].find(([, id]) => id === first.claim_id)?.[0];
  assert.ok(handle, 'the request did not offer the stored claim');
  const revise = {
    claims: [
      { op: 'revise', id: handle, text: 'Ada likes coffee', how: 'said', sources: [1], reason: 'she corrected it' },
    ],
  };
  await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock(revise)), config: APPLY }), { ignoreSweepCap: true });
  assert.equal(env.db.prepare('SELECT text FROM claim_versions WHERE id = ?').get(first.id)?.text, 'Ada likes tea');
  assert.equal(count(env.db, 'semantic_assertion_versions', "how = 'said' AND assertion_kind = 'text'"), 2);
  env.done();
});

// ---- the other writers on one sealed version -------------------------------------------------------------------------

function sealedVersion() {
  const world = semanticWorld();
  const source = addSource(world, 'public', 'Alex works on Lumen');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const result = commit(world, worksOn(ALEX, entityId, [source], { text: 'her exact words' })) as {
    claimId: string;
    versionId: string;
  };
  const read = () => ({
    version: { ...world.db.prepare('SELECT * FROM claim_versions WHERE id = ?').get(result.versionId) },
    evidence: world.db
      .prepare('SELECT * FROM claim_version_sources WHERE version_id = ?')
      .all(result.versionId)
      .map((row) => ({ ...row })),
    assertion: {
      ...world.db.prepare('SELECT * FROM semantic_assertion_versions WHERE version_id = ?').get(result.versionId),
    },
  });
  return { world, source, result, read };
}

const UNIT = 'guilds/g1/archive/2026-11.jsonl';
const FLUSHED_AT = new Date(NOW).toISOString();

test('a unit flush that carries a sealed id succeeds and leaves the version byte for byte', () => {
  // Bug: the seal's trigger aborts the whole flush and a member's history stops saving, or the flush rewrites her words.
  const { world, result, read } = sealedVersion();
  const before = read();
  writeMapping(
    world.db,
    {
      people: [{ id: 'person:flushed', first_seen_at: FLUSHED_AT }],
      claim_versions: [
        { id: result.versionId, claim_id: result.claimId, text: 'a file wrote this', recorded_at: FLUSHED_AT },
      ],
    },
    UNIT,
    { at: FLUSHED_AT }
  );
  assert.deepEqual(read(), before);
  assert.equal(world.db.prepare("SELECT COUNT(*) AS n FROM people WHERE id = 'person:flushed'").get()?.n, 1);
  world.handle.close();
});

test('a unit flush that leaves the claim out of its file does not retire a session version', () => {
  // Bug: retireAbsent reaches the sealed row, and an unrelated flush hides what her session learned.
  const { world, result, read } = sealedVersion();
  const before = read();
  retireAbsent(world.db, UNIT, { claims: [] }, FLUSHED_AT);
  assert.deepEqual(read(), before);
  assert.equal(world.db.prepare('SELECT retired_at FROM claims WHERE id = ?').get(result.claimId)?.retired_at, null);
  world.handle.close();
});

test('a repair of the parent claim leaves its sealed version, and a later version reads after it in history', () => {
  // Bug: the parent's new prose is taken for the version's, so history reads words she never sealed.
  const { world, source, result, read } = sealedVersion();
  const before = read();
  world.db.prepare('UPDATE claims SET text = ? WHERE id = ?').run('the parent changed', result.claimId);
  const entity = String(
    world.db
      .prepare("SELECT ref_id FROM semantic_arguments WHERE version_id = ? AND role = 'project'")
      .get(result.versionId)?.ref_id
  );
  const next = commit(
    world,
    worksOn(ALEX, entity, [source], {
      claimId: result.claimId,
      baseVersionId: result.versionId,
      text: 'her later words',
    })
  ) as { versionId: string };
  assert.deepEqual(read(), before);
  const history = world.db
    .prepare('SELECT id, text FROM claim_versions WHERE claim_id = ? ORDER BY recorded_at, rowid')
    .all(result.claimId);
  assert.deepEqual(
    history.map((row) => row.text),
    ['her exact words', 'her later words']
  );
  assert.equal(history.at(-1)?.id, next.versionId);
  world.handle.close();
});
