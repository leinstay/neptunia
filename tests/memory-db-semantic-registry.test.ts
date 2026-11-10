// The registry of semantic kinds and predicates, stage S2: which definitions a fresh database holds, how arguments are
// checked against a predicate's roles, cardinalities, endpoints and literal types, and how a new definition version
// joins the list. A model's arbitrary string is no contract until a validated registry change makes it one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.ts';
import {
  INITIAL_ENTITY_KINDS,
  INITIAL_PREDICATES,
  checkArguments,
  readEntityKind,
  readPredicate,
  registerPredicate,
} from '../src/memory/db/semantic-registry.ts';
import type { PredicateDefinition } from '../src/memory/db/semantic-registry.ts';
import type { SemanticArgument } from '../src/memory/db/semantic-types.ts';
import { dbOf } from '../src/memory/db/types.ts';

const NOW = Date.UTC(2026, 10, 5, 10);
const opened = () => {
  const handle = openMemoryDb(':memory:');
  return { handle, db: dbOf(handle) };
};
const entity = (id: string) => ({ kind: 'entity' as const, id });
const person = (id: string) => ({ kind: 'person' as const, id });

const WORKS_ON: PredicateDefinition = {
  id: 'fixture.works_on',
  version: 1,
  assertionKind: 'relation',
  symmetric: false,
  inverse: null,
  roles: [
    { role: 'person', min: 1, max: 1, refs: ['person', 'account'], literals: [] },
    { role: 'project', min: 1, max: 1, refs: ['entity'], literals: [] },
  ],
};
const MEETING: PredicateDefinition = {
  id: 'fixture.meeting',
  version: 1,
  assertionKind: 'nary',
  symmetric: false,
  inverse: null,
  roles: [
    { role: 'event', min: 1, max: 1, refs: ['entity'], literals: [] },
    { role: 'attendee', min: 0, max: 3, refs: ['person'], literals: [] },
    { role: 'during', min: 0, max: 1, refs: [], literals: ['interval'] },
    { role: 'on', min: 0, max: 1, refs: [], literals: ['date'] },
    { role: 'note', min: 0, max: 1, refs: [], literals: ['null', 'boolean', 'number', 'string'] },
  ],
};
const relation = (project: SemanticArgument['role'] = 'project'): Array<SemanticArgument> => [
  { role: 'person', position: 0, ref: person('person:alex') },
  { role: project, position: 0, ref: entity('ent:lumen') },
];
const meeting = (...more: Array<SemanticArgument>): Array<SemanticArgument> => [
  { role: 'event', position: 0, ref: entity('ent:orbis') },
  ...more,
];

test('a fresh database holds the eight initial kinds at their first version', () => {
  // Bug: a kind the prompt offers has no definition, so every entity of it is refused.
  const { handle, db } = opened();
  for (const id of ['project', 'object', 'concept', 'organization', 'event', 'topic', 'location', 'other']) {
    assert.equal(readEntityKind(db, id, 1)?.id, id);
  }
  assert.equal(INITIAL_ENTITY_KINDS.length, 8);
  handle.close();
});

test('a fresh database holds every initial predicate with the definition the module exports', () => {
  // Bug: the seed and the validator disagree about a role, so sealed rows contradict their own contract.
  const { handle, db } = opened();
  for (const definition of INITIAL_PREDICATES) {
    assert.deepEqual(readPredicate(db, definition.id, definition.version), definition);
  }
  handle.close();
});

test('the initial predicates include the label, relation, n-ary and equivalence contracts writers depend on', () => {
  // Bug: the writer's fixed name assertion or the equivalence reader names a predicate that was never registered.
  const kinds = new Map(INITIAL_PREDICATES.map((definition) => [definition.id, definition.assertionKind]));
  assert.equal(kinds.get('entity.label'), 'label');
  assert.equal(kinds.get('project.status'), 'property');
  assert.equal(kinds.get('project.works_on'), 'relation');
  assert.equal(kinds.get('concept.part_of'), 'relation');
  assert.equal(kinds.get('event.participant'), 'relation');
  assert.equal(kinds.get('object.owned_by'), 'relation');
  assert.equal(kinds.get('identity.same_as'), 'relation');
  assert.equal(kinds.get('event.occurrence'), 'nary');
});

test('a string nobody registered reads as no kind and no predicate', () => {
  // Bug: an arbitrary model string becomes an executable predicate.
  const { handle, db } = opened();
  assert.equal(readEntityKind(db, 'dragon', 1), null);
  assert.equal(readPredicate(db, 'made.up', 1), null);
  assert.equal(readPredicate(db, 'project.works_on', 99), null);
  handle.close();
});

test('accepts arguments that fill each required role once', () => {
  // Bug: a valid relation is refused and no fact can be stored.
  assert.deepEqual(checkArguments(WORKS_ON, relation()), { ok: true });
});

const REFUSALS: ReadonlyArray<[string, PredicateDefinition, Array<SemanticArgument>, string]> = [
  ['a missing required role', WORKS_ON, [{ role: 'person', position: 0, ref: person('person:alex') }], 'bad_arity'],
  [
    'a role filled more often than its maximum',
    WORKS_ON,
    [...relation(), { role: 'project', position: 1, ref: entity('ent:orbis') }],
    'bad_arity',
  ],
  ['an unknown role', WORKS_ON, relation('venue'), 'bad_role'],
  [
    'an endpoint of a kind the role does not admit',
    WORKS_ON,
    [
      { role: 'person', position: 0, ref: entity('ent:alex') },
      { role: 'project', position: 0, ref: entity('ent:lumen') },
    ],
    'bad_endpoint',
  ],
  [
    'a literal in a role that takes references',
    WORKS_ON,
    [
      { role: 'person', position: 0, literal: 'Alex' },
      { role: 'project', position: 0, ref: entity('ent:lumen') },
    ],
    'bad_literal',
  ],
  [
    'two arguments at one role and position',
    MEETING,
    meeting(
      { role: 'attendee', position: 0, ref: person('person:alex') },
      { role: 'attendee', position: 0, ref: person('person:mira') }
    ),
    'bad_arity',
  ],
  [
    'a date with no timezone',
    MEETING,
    meeting({ role: 'on', position: 0, literal: { kind: 'date', value: '2026-11-05 10:00:00' } }),
    'bad_literal',
  ],
  [
    'a date that is no date',
    MEETING,
    meeting({ role: 'on', position: 0, literal: { kind: 'date', value: 'next tuesday' } }),
    'bad_literal',
  ],
  [
    'an interval that ends before it starts',
    MEETING,
    meeting({
      role: 'during',
      position: 0,
      literal: { kind: 'interval', from: '2026-11-05T10:00:00.000Z', to: '2026-11-04T10:00:00.000Z' },
    }),
    'bad_literal',
  ],
  [
    'an interval with neither end',
    MEETING,
    meeting({ role: 'during', position: 0, literal: { kind: 'interval', from: null, to: null } }),
    'bad_literal',
  ],
  [
    'a number that is not finite',
    MEETING,
    meeting({ role: 'note', position: 0, literal: Number.POSITIVE_INFINITY }),
    'bad_literal',
  ],
  [
    'a string in a role that takes an interval',
    MEETING,
    meeting({ role: 'during', position: 0, literal: 'last week' }),
    'bad_literal',
  ],
];

for (const [name, definition, given, code] of REFUSALS) {
  test(`refuses ${name} with the stable code ${code}`, () => {
    // Bug: a malformed payload reaches the seal, where it can never be corrected.
    assert.deepEqual(checkArguments(definition, given), { ok: false, code });
  });
}

test('keeps null, false, zero and an empty string as the literals they are', () => {
  // Bug: a truthiness check turns a stored false or zero into a missing role.
  for (const literal of [null, false, 0, '']) {
    assert.deepEqual(
      checkArguments(MEETING, meeting({ role: 'note', position: 0, literal })),
      { ok: true },
      String(literal)
    );
  }
});

test('accepts an open-ended interval and several attendees up to the maximum', () => {
  // Bug: a meeting with no end time or with three people cannot be recorded jointly.
  assert.deepEqual(
    checkArguments(
      MEETING,
      meeting(
        { role: 'during', position: 0, literal: { kind: 'interval', from: '2026-11-05T10:00:00.000Z', to: null } },
        { role: 'attendee', position: 0, ref: person('person:alex') },
        { role: 'attendee', position: 1, ref: person('person:mira') },
        { role: 'attendee', position: 2, ref: person('person:kai') }
      )
    ),
    { ok: true }
  );
});

test('a new predicate version joins the registry beside the old one', () => {
  // Bug: a new version replaces the old definition and sealed assertions lose their contract.
  const { handle, db } = opened();
  assert.deepEqual(registerPredicate(handle, WORKS_ON, NOW), { ok: true });
  const second = { ...WORKS_ON, version: 2, roles: WORKS_ON.roles.slice(0, 1) };
  assert.deepEqual(registerPredicate(handle, second, NOW), { ok: true });
  assert.deepEqual(readPredicate(db, WORKS_ON.id, 1), WORKS_ON);
  assert.deepEqual(readPredicate(db, WORKS_ON.id, 2), second);
  handle.close();
});

test('refuses to register a predicate version that exists and leaves the stored one', () => {
  // Bug: a repeated registration quietly redefines a sealed contract.
  const { handle, db } = opened();
  registerPredicate(handle, WORKS_ON, NOW);
  assert.deepEqual(registerPredicate(handle, { ...WORKS_ON, symmetric: true }, NOW), {
    ok: false,
    code: 'version_exists',
  });
  assert.equal(readPredicate(db, WORKS_ON.id, 1)?.symmetric, false);
  handle.close();
});

const BAD_DEFINITIONS: ReadonlyArray<[string, PredicateDefinition]> = [
  ['no roles', { ...WORKS_ON, id: 'bad.one', roles: [] }],
  ['a version below one', { ...WORKS_ON, id: 'bad.two', version: 0 }],
  [
    'a minimum above its maximum',
    { ...WORKS_ON, id: 'bad.three', roles: [{ role: 'x', min: 2, max: 1, refs: ['person'], literals: [] }] },
  ],
  [
    'a role that admits nothing',
    { ...WORKS_ON, id: 'bad.four', roles: [{ role: 'x', min: 1, max: 1, refs: [], literals: [] }] },
  ],
  ['two roles of one name', { ...WORKS_ON, id: 'bad.five', roles: [WORKS_ON.roles[0], WORKS_ON.roles[0]] }],
];

for (const [name, definition] of BAD_DEFINITIONS) {
  test(`refuses a predicate definition with ${name}`, () => {
    // Bug: an unusable definition becomes immutable the moment it is stored.
    const { handle, db } = opened();
    assert.deepEqual(registerPredicate(handle, definition, NOW), { ok: false, code: 'bad_definition' });
    assert.equal(readPredicate(db, definition.id, definition.version), null);
    handle.close();
  });
}
