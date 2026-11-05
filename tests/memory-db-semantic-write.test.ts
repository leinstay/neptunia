// The persona's memory writer for structured facts, stage S3: `validateSemanticCandidate` resolves one candidate or
// refuses it with a stable code, and the session operations write it in one transaction (tests/fixtures/memory-db/
// semantic-session-commit.ts). Code checks references, roles, evidence and compare-and-set; the meaning is hers, so no test
// asks the code to judge a fact. The session path and the other writers are in memory-db-semantic-session.test.ts.
// Synthetic content only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSemanticCandidate } from '../src/memory/db/semantic-write.ts';
import type { SemanticCandidate, SemanticReadSet } from '../src/memory/db/semantic-types.ts';
import {
  ALEX,
  DM_ALEX,
  KAI,
  MIRA,
  PUBLIC,
  addEntity,
  addSource,
  candidate,
  commit,
  dmAudience,
  entityCandidate,
  everythingRead,
  occurrence,
  partOf,
  sameAs,
  semanticWorld,
  successor,
  supports,
  worksOn,
} from './fixtures/memory-db/semantic-world.ts';
import type { World } from './fixtures/memory-db/semantic-world.ts';

const count = (world: World, table: string): number =>
  Number(world.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
const assertionOf = (world: World, versionId: string) =>
  world.db.prepare('SELECT * FROM semantic_assertion_versions WHERE version_id = ?').get(versionId);
const argumentsOf = (world: World, versionId: string) =>
  world.db
    .prepare(
      'SELECT role, position, ref_kind, ref_id, literal_json FROM semantic_arguments WHERE version_id = ? ORDER BY role, position'
    )
    .all(versionId)
    .map((row) => ({ ...row }));
const evidenceOf = (world: World, versionId: string) =>
  world.db
    .prepare('SELECT source_id, role FROM claim_version_sources WHERE version_id = ? ORDER BY source_id')
    .all(versionId)
    .map((row) => ({ ...row }));
const versionOf = (result: object): { claimId: string; versionId: string } =>
  result as { claimId: string; versionId: string };

/** Whether a candidate is refused with `code` and leaves every semantic table and the claims as they were. */
function assertRefused(
  world: World,
  given: SemanticCandidate | Parameters<typeof validateSemanticCandidate>[2],
  code: string,
  ctx = world.contexts.group,
  read: SemanticReadSet = everythingRead(world)
): void {
  const tables = [
    'semantic_entities',
    'semantic_assertion_versions',
    'semantic_arguments',
    'semantic_labels',
    'claims',
    'claim_versions',
  ];
  const before = tables.map((table) => count(world, table));
  assert.deepEqual(validateSemanticCandidate(world.db, ctx, given, read), { ok: false, code });
  assert.deepEqual(
    tables.map((table) => count(world, table)),
    before
  );
}

// ---- entities --------------------------------------------------------------------------------------------------------

test('creating an entity returns an opaque id and a scoped name assertion written with it', () => {
  // Bug: a name lands on the base row, or the entity exists without the evidence of its name.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'we call it Lumen');
  const { entityId, versionId } = addEntity(world, 'project', 'Lumen', [source]);
  assert.doesNotMatch(entityId, /lumen/i);
  assert.equal(assertionOf(world, versionId)?.assertion_kind, 'label');
  assert.equal(assertionOf(world, versionId)?.audience_id, PUBLIC);
  assert.deepEqual(evidenceOf(world, versionId), [{ source_id: source, role: 'supports' }]);
  const label = world.db
    .prepare('SELECT entity_id, role, language, text FROM semantic_labels WHERE version_id = ?')
    .get(versionId);
  assert.deepEqual({ ...label }, { entity_id: entityId, role: 'name', language: 'en', text: 'Lumen' });
  world.handle.close();
});

test('the entity id comes from the injected uuid, never from the model', () => {
  // Bug: a candidate that smuggles an id gets to name or overwrite an existing entity.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const smuggled = { ...entityCandidate('project', 'Lumen', [source]), id: 'ent:chosen-by-model' };
  const checked = validateSemanticCandidate(world.db, world.contexts.group, smuggled, everythingRead(world));
  assert.deepEqual(checked, { ok: false, code: 'unknown_field' });
  world.handle.close();
});

test('equal names make two entities, because a name never merges', () => {
  // Bug: the second Lumen attaches its facts to the first project.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'two projects share a name');
  const first = addEntity(world, 'project', 'Lumen', [source]);
  const second = addEntity(world, 'project', 'Lumen', [source]);
  assert.notEqual(first.entityId, second.entityId);
  assert.equal(count(world, 'semantic_entities'), 2);
  world.handle.close();
});

test('a semantic name never changes a person or a place name', () => {
  // Bug: a label assertion is mirrored onto the typed row, so a private alias renames a member.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const before = JSON.stringify([
    world.db.prepare('SELECT * FROM accounts').all(),
    world.db.prepare('SELECT * FROM places').all(),
    world.db.prepare('SELECT * FROM people').all(),
  ]);
  addEntity(world, 'project', 'Alex', [source]);
  const after = JSON.stringify([
    world.db.prepare('SELECT * FROM accounts').all(),
    world.db.prepare('SELECT * FROM places').all(),
    world.db.prepare('SELECT * FROM people').all(),
  ]);
  assert.equal(after, before);
  world.handle.close();
});

test('an unknown kind leaves no entity', () => {
  // Bug: a rejected name leaves an orphan entity that reads as discoverable.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  assertRefused(world, entityCandidate('dragon', 'Smaug', [source]), 'unknown_kind');
  world.handle.close();
});

test('an entity with an empty name is refused', () => {
  // Bug: an unnamed entity can never be resolved, yet it holds relations.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  assertRefused(world, entityCandidate('project', '   ', [source]), 'bad_name');
  world.handle.close();
});

test('an entity with no evidence is refused', () => {
  // Bug: a fact out of nowhere is stored as if the batch had shown it.
  const world = semanticWorld();
  assertRefused(world, entityCandidate('project', 'Lumen', []), 'no_evidence');
  world.handle.close();
});

// ---- structured assertions -------------------------------------------------------------------------------------------

test('a relation keeps its exact text, roles, evidence and audience', () => {
  // Bug: normalizing the persona's words or dropping a role changes what she stored.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'Alex works on Lumen');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const text = '  Alex  works on Lumen, Ωραία \n';
  const result = versionOf(commit(world, worksOn(ALEX, entityId, [source], { text })));
  assert.equal(world.db.prepare('SELECT text FROM claim_versions WHERE id = ?').get(result.versionId)?.text, text);
  assert.deepEqual(argumentsOf(world, result.versionId), [
    { role: 'person', position: 0, ref_kind: 'person', ref_id: ALEX, literal_json: null },
    { role: 'project', position: 0, ref_kind: 'entity', ref_id: entityId, literal_json: null },
  ]);
  assert.deepEqual(evidenceOf(world, result.versionId), [{ source_id: source, role: 'supports' }]);
  assert.equal(assertionOf(world, result.versionId)?.audience_id, PUBLIC);
  world.handle.close();
});

test('a property keeps its typed literal', () => {
  // Bug: every literal becomes a string, and a false or a zero stops being one.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'Lumen is a prototype');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const result = versionOf(
    commit(
      world,
      candidate(
        'project.status',
        'property',
        [
          { role: 'project', position: 0, ref: { kind: 'entity', id: entityId } },
          { role: 'status', position: 0, literal: 'prototype' },
        ],
        [source]
      )
    )
  );
  const status = world.db
    .prepare("SELECT literal_json FROM semantic_arguments WHERE version_id = ? AND role = 'status'")
    .get(result.versionId);
  assert.equal(status?.literal_json, '"prototype"');
  world.handle.close();
});

test('an n-ary event holds every role in one version', () => {
  // Bug: pairwise rows replace a joint assertion, so one role can be retired or hidden alone.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'Alex organized Orbis, Mira spoke, on Lumen');
  const event = addEntity(world, 'event', 'Orbis meeting', [source]);
  const lumen = addEntity(world, 'project', 'Lumen', [source]);
  const result = versionOf(
    commit(
      world,
      occurrence(event.entityId, { organizer: [ALEX], speaker: [MIRA], project: [lumen.entityId] }, [source])
    )
  );
  assert.deepEqual(
    argumentsOf(world, result.versionId).map((row) => [row.role, row.ref_id]),
    [
      ['event', event.entityId],
      ['organizer', ALEX],
      ['project', lumen.entityId],
      ['speaker', MIRA],
    ]
  );
  assert.equal(
    world.db.prepare('SELECT COUNT(DISTINCT claim_id) AS n FROM claim_versions WHERE id = ?').get(result.versionId)?.n,
    1
  );
  world.handle.close();
});

test('each version snapshots how, truth, polarity and validity for itself', () => {
  // Bug: a historical reader takes them from the mutable parent claim and rewrites the past.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const first = versionOf(
    commit(
      world,
      worksOn(ALEX, entityId, [source], {
        how: 'claimed',
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: '2026-06-01T00:00:00.000Z',
      })
    )
  );
  const second = versionOf(
    commit(
      world,
      worksOn(ALEX, entityId, [source], { ...successor(first), how: 'said', state: 'historical', polarity: 'negative' })
    )
  );
  const old = assertionOf(world, first.versionId);
  assert.deepEqual(
    [old?.how, old?.truth_state, old?.polarity, old?.valid_from_at, old?.valid_to_at],
    ['claimed', 'current', 'positive', '2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z']
  );
  const next = assertionOf(world, second.versionId);
  assert.deepEqual([next?.how, next?.truth_state, next?.polarity], ['said', 'historical', 'negative']);
  assert.equal(second.claimId, first.claimId);
  world.handle.close();
});

test('a changed fact appends a successor and keeps the old version byte for byte', () => {
  // Bug: a revision overwrites the old text, so evidence points at words nobody wrote.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const other = addSource(world, 'public', 'two');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const first = versionOf(commit(world, worksOn(ALEX, entityId, [source], { text: 'first words' })));
  const row = { ...world.db.prepare('SELECT * FROM claim_versions WHERE id = ?').get(first.versionId) };
  const second = versionOf(
    commit(world, worksOn(ALEX, entityId, [other], { ...successor(first), text: 'second words' }))
  );
  assert.notEqual(second.versionId, first.versionId);
  assert.deepEqual({ ...world.db.prepare('SELECT * FROM claim_versions WHERE id = ?').get(first.versionId) }, row);
  assert.deepEqual(evidenceOf(world, first.versionId), [{ source_id: source, role: 'supports' }]);
  world.handle.close();
});

// ---- refusals --------------------------------------------------------------------------------------------------------

const OTHER_FIELDS: ReadonlyArray<[string, (given: SemanticCandidate) => object, string]> = [
  ['an unknown field', (given) => ({ ...given, audience: 'aud:none' }), 'unknown_field'],
  ['a field that picks a destination', (given) => ({ ...given, destination: 'place:room' }), 'unknown_field'],
  ['an unknown predicate', (given) => ({ ...given, predicate: { id: 'made.up', version: 1 } }), 'unknown_predicate'],
  [
    'a predicate version nobody registered',
    (given) => ({ ...given, predicate: { id: 'project.works_on', version: 99 } }),
    'unknown_predicate',
  ],
  ['a kind the predicate does not have', (given) => ({ ...given, assertionKind: 'nary' }), 'bad_assertion_kind'],
  ['wrong arity', (given) => ({ ...given, arguments: given.arguments.slice(0, 1) }), 'bad_arity'],
  ['an unknown way of knowing', (given) => ({ ...given, how: 'dreamed' }), 'bad_how'],
  ['an empty text', (given) => ({ ...given, text: '  ' }), 'no_text'],
  ['no evidence', (given) => ({ ...given, evidence: [] }), 'no_evidence'],
  ['a source that does not exist', (given) => ({ ...given, evidence: supports('src:invented') }), 'unknown_source'],
  [
    'a validity that ends before it starts',
    (given) => ({ ...given, validFrom: '2026-02-01T00:00:00.000Z', validTo: '2026-01-01T00:00:00.000Z' }),
    'bad_interval',
  ],
  [
    'an endpoint that does not exist',
    (given) => ({
      ...given,
      arguments: [given.arguments[0], { role: 'project', position: 0, ref: { kind: 'entity', id: 'ent:none' } }],
    }),
    'unknown_ref',
  ],
  [
    'an endpoint of the wrong typed home',
    (given) => ({
      ...given,
      arguments: [{ role: 'person', position: 0, ref: { kind: 'person', id: 'place:room' } }, given.arguments[1]],
    }),
    'unknown_ref',
  ],
];

for (const [name, change, code] of OTHER_FIELDS) {
  test(`refuses a relation with ${name}`, () => {
    // Bug: a malformed operation is dropped in silence or part of it is stored.
    const world = semanticWorld();
    const source = addSource(world, 'public', 'one');
    const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
    assertRefused(world, change(worksOn(ALEX, entityId, [source])) as SemanticCandidate, code);
    world.handle.close();
  });
}

test('refuses a source this run was not shown', () => {
  // Bug: the model cites a real source id that it read about nowhere.
  const world = semanticWorld();
  const shown = addSource(world, 'public', 'shown');
  const unseen = addSource(world, 'public', 'unseen');
  const { entityId } = addEntity(world, 'project', 'Lumen', [shown]);
  assertRefused(world, worksOn(ALEX, entityId, [unseen]), 'unread_source', world.contexts.group, {
    sourceIds: [shown],
    versionIds: [],
  });
  world.handle.close();
});

test('refuses a premise version this run was not shown', () => {
  // Bug: a dependency on a version the read record cannot prove was on screen.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const premise = versionOf(commit(world, worksOn(ALEX, entityId, [source])));
  assertRefused(
    world,
    worksOn(MIRA, entityId, [source], { dependencies: [{ versionId: premise.versionId, role: 'supports' }] }),
    'unread_version',
    world.contexts.group,
    { sourceIds: [source], versionIds: [] }
  );
  world.handle.close();
});

test('refuses evidence the issued context cannot read, even when the read set names it', () => {
  // Bug: a group session is handed a DM source id and copies a private fact into public memory.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const secret = addSource(world, 'alex', 'a private line');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  assertRefused(world, worksOn(ALEX, entityId, [secret]), 'out_of_scope');
  world.handle.close();
});

test('refuses an entity endpoint the issued context cannot see', () => {
  // Bug: a group write learns a private entity exists from a successful reference to it.
  const world = semanticWorld();
  const secret = addSource(world, 'alex', 'a private project');
  const source = addSource(world, 'public', 'one');
  const hidden = addEntity(world, 'project', 'Hidden', [secret], world.contexts.alex);
  assertRefused(world, worksOn(ALEX, hidden.entityId, [source]), 'unknown_ref');
  world.handle.close();
});

test('refuses a stale base at validation', () => {
  // Bug: a revision built on an old read overwrites what another writer just learned.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const first = versionOf(commit(world, worksOn(ALEX, entityId, [source])));
  commit(world, worksOn(ALEX, entityId, [source], successor(first)));
  assertRefused(world, worksOn(ALEX, entityId, [source], successor(first)), 'stale_base');
  world.handle.close();
});

test('refuses a stale base at the write and stores nothing when another write got in first', () => {
  // Bug: the check runs on a state nobody re-read and the write commits a successor on a base that moved.
  // The session operations validate and write in one transaction, so the race of two connections cannot be staged; the
  // base that moved is the whole case.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const first = versionOf(commit(world, worksOn(ALEX, entityId, [source])));
  commit(world, worksOn(ALEX, entityId, [source], successor(first)));
  const before = count(world, 'claim_versions');
  assert.throws(() => commit(world, worksOn(ALEX, entityId, [source], successor(first))), /stale_base/);
  assert.equal(count(world, 'claim_versions'), before);
  world.handle.close();
});

test('refuses a claim id with no base and a base with no claim id', () => {
  // Bug: half of a compare-and-set reads as a new fact and skips the check.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const first = versionOf(commit(world, worksOn(ALEX, entityId, [source])));
  assertRefused(
    world,
    worksOn(ALEX, entityId, [source], { claimId: first.claimId, baseVersionId: null }),
    'stale_base'
  );
  assertRefused(
    world,
    worksOn(ALEX, entityId, [source], { claimId: null, baseVersionId: first.versionId }),
    'stale_base'
  );
  world.handle.close();
});

test('refuses a premise chain that comes back to the claim being written', () => {
  // Bug: A rests on B and B on an earlier A, so review of a changed premise never settles and the reasoning is circular.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const a = versionOf(commit(world, worksOn(ALEX, entityId, [source])));
  const b = versionOf(
    commit(world, worksOn(MIRA, entityId, [source], { dependencies: [{ versionId: a.versionId, role: 'supports' }] }))
  );
  assertRefused(
    world,
    worksOn(ALEX, entityId, [source], {
      ...successor(a),
      dependencies: [{ versionId: b.versionId, role: 'supports' }],
    }),
    'premise_cycle'
  );
  world.handle.close();
});

test('refuses a successor that names its own base as its premise', () => {
  // Bug: a fact justifies itself by its earlier wording, and its dependency path never reaches evidence.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const a = versionOf(commit(world, worksOn(ALEX, entityId, [source])));
  assertRefused(
    world,
    worksOn(ALEX, entityId, [source], {
      ...successor(a),
      dependencies: [{ versionId: a.versionId, role: 'supports' }],
    }),
    'premise_cycle'
  );
  world.handle.close();
});

test('refuses a premise that names no stored version, even when the read set lists it', () => {
  // Bug: a dependency on nothing passes the read check and fails only at the foreign key, as an unexplained throw.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  assertRefused(
    world,
    worksOn(KAI, entityId, [source], { dependencies: [{ versionId: 'cv:absent', role: 'supports' }] }),
    'unknown_version',
    world.contexts.group,
    { sourceIds: [source], versionIds: ['cv:absent'] }
  );
  world.handle.close();
});

test('refuses an equivalence that closes a loop between visible entities', () => {
  // Bug: resolving A to B to A hangs every reader of the merged identity.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const a = addEntity(world, 'project', 'A', [source]);
  const b = addEntity(world, 'project', 'B', [source]);
  const c = addEntity(world, 'project', 'C', [source]);
  commit(world, sameAs(a.entityId, b.entityId, [source]));
  commit(world, sameAs(b.entityId, c.entityId, [source]));
  assertRefused(world, sameAs(c.entityId, a.entityId, [source]), 'equivalence_loop');
  assertRefused(world, sameAs(a.entityId, a.entityId, [source]), 'equivalence_loop');
  world.handle.close();
});

test('a failure inside the write leaves no claim, version, argument or evidence', () => {
  // Bug: a projection failure after the claim insert commits half a fact.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const tables = [
    'claims',
    'claim_versions',
    'claim_version_sources',
    'semantic_assertion_versions',
    'semantic_arguments',
    'graph_edges',
  ];
  const before = tables.map((table) => count(world, table));
  // The temporary trigger stands in for any failure at the last step of the transaction.
  world.db.exec(`CREATE TEMP TRIGGER fail_seal BEFORE INSERT ON semantic_assertion_versions
    WHEN new.assertion_kind = 'relation' BEGIN SELECT RAISE(ABORT, 'the seal failed'); END;`);
  assert.throws(() => commit(world, worksOn(ALEX, entityId, [source])), /the seal failed/);
  assert.deepEqual(
    tables.map((table) => count(world, table)),
    before
  );
  world.handle.close();
});

// ---- audiences -------------------------------------------------------------------------------------------------------

test('private evidence makes a new assertion private', () => {
  // Bug: the session's public scope wins, and a line from a DM becomes a public fact.
  const world = semanticWorld();
  const secret = addSource(world, 'alex', 'between us');
  const { entityId } = addEntity(world, 'project', 'Lumen', [addSource(world, 'public', 'one')]);
  const result = versionOf(commit(world, worksOn(ALEX, entityId, [secret]), world.contexts.alex));
  assert.equal(assertionOf(world, result.versionId)?.audience_id, dmAudience(DM_ALEX));
  world.handle.close();
});

test('confirming a public assertion with private evidence forks a private variant and leaves the public one', () => {
  // Bug: a private confirmation changes the public claim's history or leaks that it was confirmed.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'one');
  const secret = addSource(world, 'alex', 'between us');
  const { entityId } = addEntity(world, 'project', 'Lumen', [open]);
  const pub = versionOf(commit(world, worksOn(ALEX, entityId, [open])));
  const before = world.db.prepare('SELECT COUNT(*) AS n FROM claim_versions WHERE claim_id = ?').get(pub.claimId)?.n;
  const fork = versionOf(commit(world, worksOn(ALEX, entityId, [secret], successor(pub)), world.contexts.alex));
  assert.notEqual(fork.claimId, pub.claimId);
  assert.equal(assertionOf(world, fork.versionId)?.audience_id, dmAudience(DM_ALEX));
  assert.equal(assertionOf(world, pub.versionId)?.audience_id, PUBLIC);
  assert.equal(
    world.db.prepare('SELECT COUNT(*) AS n FROM claim_versions WHERE claim_id = ?').get(pub.claimId)?.n,
    before
  );
  world.handle.close();
});

test('a privately known attendee makes a private joint variant and the public event stands whole', () => {
  // Bug: the private role is redacted and the remainder is shown as the same complete assertion.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'Orbis had Alex and Mira');
  const secret = addSource(world, 'alex', 'Kai was there too');
  const event = addEntity(world, 'event', 'Orbis meeting', [open]);
  const pub = versionOf(commit(world, occurrence(event.entityId, { attendee: [ALEX, MIRA] }, [open])));
  const joint = versionOf(
    commit(world, occurrence(event.entityId, { attendee: [ALEX, MIRA, KAI] }, [open, secret]), world.contexts.alex)
  );
  assert.notEqual(joint.claimId, pub.claimId);
  assert.equal(assertionOf(world, joint.versionId)?.audience_id, dmAudience(DM_ALEX));
  assert.equal(assertionOf(world, pub.versionId)?.audience_id, PUBLIC);
  assert.equal(argumentsOf(world, pub.versionId).filter((row) => row.ref_id === KAI).length, 0);
  world.handle.close();
});

test('a premise narrows the audience of what rests on it', () => {
  // Bug: a public conclusion drawn from a private premise reveals the premise.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'one');
  const secret = addSource(world, 'alex', 'between us');
  const { entityId } = addEntity(world, 'project', 'Lumen', [open]);
  const premise = versionOf(commit(world, worksOn(ALEX, entityId, [secret]), world.contexts.alex));
  const inferred = versionOf(
    commit(
      world,
      worksOn(MIRA, entityId, [open], {
        how: 'inferred',
        dependencies: [{ versionId: premise.versionId, role: 'supports' }],
      }),
      world.contexts.alex
    )
  );
  assert.equal(assertionOf(world, inferred.versionId)?.audience_id, dmAudience(DM_ALEX));
  world.handle.close();
});

test('an endpoint known only privately narrows the audience of the fact that names it', () => {
  // Bug: a public fact about a private entity reveals that the entity exists.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'one');
  const secret = addSource(world, 'alex', 'a private project');
  const hidden = addEntity(world, 'project', 'Hidden', [secret], world.contexts.alex);
  const whole = addEntity(world, 'concept', 'Orbis', [open]);
  const result = versionOf(commit(world, partOf(hidden.entityId, whole.entityId, [open]), world.contexts.alex));
  assert.equal(assertionOf(world, result.versionId)?.audience_id, dmAudience(DM_ALEX));
  world.handle.close();
});

test('evidence from two different DMs is readable nowhere outward', () => {
  // Bug: the fact takes the first DM's audience and shows the second partner's words to the first.
  const world = semanticWorld();
  const one = addSource(world, 'alex', 'from Alex');
  const two = addSource(world, 'mira', 'from Mira');
  const { entityId } = addEntity(world, 'project', 'Lumen', [addSource(world, 'public', 'one')]);
  const result = versionOf(commit(world, worksOn(ALEX, entityId, [one, two]), world.contexts.internal));
  assert.equal(assertionOf(world, result.versionId)?.audience_id, 'aud:internal');
  world.handle.close();
});
