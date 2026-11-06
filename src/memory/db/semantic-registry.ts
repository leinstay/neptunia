// The registry of semantic entity kinds and predicates: the definitions a fresh database holds, how a definition is read
// and registered, and how the arguments of an assertion are checked against its predicate. A model's string is no contract
// until a validated registry change makes it one. A stored version is immutable; a change registers the next version.
// `INITIAL_*` are what schema v31 seeded: a new definition reaches a shipped database through `registerPredicate`, so these
// two lists never change. Imports nothing but types, so the migration and the writer worker can load it.

import { dbOf } from './types.ts';
import type { Db, MemoryHandle } from './types.ts';
import type { SemanticArgument, SemanticLiteral, SemanticRefKind } from './semantic-types.ts';

export type LiteralKind = 'null' | 'boolean' | 'number' | 'string' | 'date' | 'interval';
export type RoleDefinition = {
  role: string;
  min: number;
  max: number;
  refs: Array<SemanticRefKind>;
  literals: Array<LiteralKind>;
};
export type PredicateDefinition = {
  id: string;
  version: number;
  assertionKind: 'label' | 'property' | 'relation' | 'nary';
  symmetric: boolean;
  inverse: string | null;
  roles: Array<RoleDefinition>;
};
export type EntityKindDefinition = { id: string; version: number; fields: Array<string> };
type RegistryResult = { ok: true } | { ok: false; code: string };

/** How a fact came to be known, the same words a plain claim uses. */
export const ASSERTION_HOW: ReadonlyArray<string> = Object.freeze(['said', 'saw', 'claimed', 'inferred', 'taught']);
export const LABEL_PREDICATE = 'entity.label';
export const EQUIVALENCE_PREDICATE = 'identity.same_as';

const PEOPLE: Array<SemanticRefKind> = ['person', 'account', 'participant'];
const entityRole = (role: string): RoleDefinition => ({ role, min: 1, max: 1, refs: ['entity'], literals: [] });
const several = (role: string, refs: Array<SemanticRefKind>, max: number): RoleDefinition => ({
  role,
  min: 0,
  max,
  refs,
  literals: [],
});
const relation = (id: string, roles: Array<RoleDefinition>, symmetric = false): PredicateDefinition => ({
  id,
  version: 1,
  assertionKind: 'relation',
  symmetric,
  inverse: null,
  roles,
});

const kindOf = (id: string): EntityKindDefinition => ({ id, version: 1, fields: [] });
export const INITIAL_ENTITY_KINDS: ReadonlyArray<EntityKindDefinition> = Object.freeze(
  ['project', 'object', 'concept', 'organization', 'event', 'topic', 'location', 'other'].map(kindOf)
);
export const INITIAL_PREDICATES: ReadonlyArray<PredicateDefinition> = Object.freeze([
  {
    id: LABEL_PREDICATE,
    version: 1,
    assertionKind: 'label',
    symmetric: false,
    inverse: null,
    roles: [
      entityRole('entity'),
      { role: 'name', min: 0, max: 1, refs: [], literals: ['string'] },
      { role: 'alias', min: 0, max: 1, refs: [], literals: ['string'] },
      { role: 'language', min: 1, max: 1, refs: [], literals: ['string'] },
    ],
  },
  {
    id: 'project.status',
    version: 1,
    assertionKind: 'property',
    symmetric: false,
    inverse: null,
    roles: [entityRole('project'), { role: 'status', min: 1, max: 1, refs: [], literals: ['string'] }],
  },
  relation('project.works_on', [{ role: 'person', min: 1, max: 1, refs: PEOPLE, literals: [] }, entityRole('project')]),
  relation('concept.part_of', [entityRole('part'), entityRole('whole')]),
  relation('event.participant', [entityRole('event'), { role: 'person', min: 1, max: 1, refs: PEOPLE, literals: [] }]),
  relation('object.owned_by', [
    entityRole('object'),
    { role: 'owner', min: 1, max: 1, refs: [...PEOPLE, 'entity'], literals: [] },
  ]),
  relation(EQUIVALENCE_PREDICATE, [entityRole('from'), entityRole('into')], true),
  {
    id: 'event.occurrence',
    version: 1,
    assertionKind: 'nary',
    symmetric: false,
    inverse: null,
    roles: [
      entityRole('event'),
      several('organizer', PEOPLE, 16),
      several('speaker', PEOPLE, 16),
      several('attendee', PEOPLE, 64),
      several('project', ['entity'], 16),
      several('location', ['entity', 'place'], 4),
      { role: 'during', min: 0, max: 1, refs: [], literals: ['interval'] },
      { role: 'on', min: 0, max: 1, refs: [], literals: ['date'] },
    ],
  },
]);

/** The stored definition of a predicate version: everything but its key. */
export function predicateJson(definition: PredicateDefinition): string {
  const { assertionKind, symmetric, inverse, roles } = definition;
  return JSON.stringify({ assertionKind, symmetric, inverse, roles });
}
export const entityKindJson = (definition: EntityKindDefinition): string =>
  JSON.stringify({ fields: definition.fields });

/** A predicate version, or null: a string nobody registered is no predicate. */
export function readPredicate(db: Db, id: string, version: number): PredicateDefinition | null {
  const row = db
    .prepare('SELECT definition_json FROM semantic_predicate_versions WHERE id = ? AND version = ?')
    .get(id, version);
  if (!row) return null;
  // The registry wrote this JSON from a checked definition.
  return { id, version, ...(JSON.parse(String(row.definition_json)) as Omit<PredicateDefinition, 'id' | 'version'>) };
}

/** An entity kind version, or null. */
export function readEntityKind(db: Db, id: string, version: number): EntityKindDefinition | null {
  const row = db
    .prepare('SELECT definition_json FROM semantic_entity_kinds WHERE id = ? AND version = ?')
    .get(id, version);
  if (!row) return null;
  // The registry wrote this JSON from a checked definition.
  return { id, version, ...(JSON.parse(String(row.definition_json)) as { fields: Array<string> }) };
}

const usableVersion = (version: unknown): boolean => Number.isInteger(version) && (version as number) >= 1;

function usableDefinition(definition: PredicateDefinition): boolean {
  if (typeof definition.id !== 'string' || definition.id === '' || !usableVersion(definition.version)) return false;
  if (!Array.isArray(definition.roles) || definition.roles.length === 0) return false;
  const names = new Set(definition.roles.map((definedRole) => definedRole.role));
  if (names.size !== definition.roles.length) return false;
  return definition.roles.every(
    (role) => role.min >= 0 && role.min <= role.max && role.max >= 1 && role.refs.length + role.literals.length > 0
  );
}

/** Adds a predicate version: an unusable definition and a version that exists are refused and nothing changes. */
export function registerPredicate(handle: MemoryHandle, definition: PredicateDefinition, now: number): RegistryResult {
  if (!usableDefinition(definition)) return { ok: false, code: 'bad_definition' };
  const db = dbOf(handle);
  if (readPredicate(db, definition.id, definition.version)) return { ok: false, code: 'version_exists' };
  handle.transaction(() =>
    db
      .prepare('INSERT INTO semantic_predicate_versions (id, version, definition_json, created_at) VALUES (?, ?, ?, ?)')
      .run(definition.id, definition.version, predicateJson(definition), new Date(now).toISOString())
  );
  return { ok: true };
}

/** Adds an entity kind version, on the same terms. */
export function registerEntityKind(
  handle: MemoryHandle,
  definition: EntityKindDefinition,
  now: number
): RegistryResult {
  if (typeof definition.id !== 'string' || definition.id === '' || !usableVersion(definition.version))
    return { ok: false, code: 'bad_definition' };
  const db = dbOf(handle);
  if (readEntityKind(db, definition.id, definition.version)) return { ok: false, code: 'version_exists' };
  handle.transaction(() =>
    db
      .prepare('INSERT INTO semantic_entity_kinds (id, version, definition_json, created_at) VALUES (?, ?, ?, ?)')
      .run(definition.id, definition.version, entityKindJson(definition), new Date(now).toISOString())
  );
  return { ok: true };
}

/** A date with its timezone, or a calendar day: anything else cannot be compared with another. */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;
export const validDate = (value: unknown): value is string =>
  typeof value === 'string' && DATE_SHAPE.test(value) && Number.isFinite(Date.parse(value));

function literalKindOf(literal: SemanticLiteral): LiteralKind | null {
  if (literal === null) return 'null';
  if (typeof literal === 'boolean') return 'boolean';
  if (typeof literal === 'number') return Number.isFinite(literal) ? 'number' : null;
  if (typeof literal === 'string') return 'string';
  if (typeof literal !== 'object') return null;
  if (literal.kind === 'date') return validDate(literal.value) ? 'date' : null;
  if (literal.kind !== 'interval') return null;
  const { from, to } = literal;
  if (from === null && to === null) return null;
  if ((from !== null && !validDate(from)) || (to !== null && !validDate(to))) return null;
  return from !== null && to !== null && Date.parse(from) > Date.parse(to) ? null : 'interval';
}

function checkOne(role: RoleDefinition, given: SemanticArgument): string | null {
  if ('ref' in given) return role.refs.includes(given.ref.kind) ? null : 'bad_endpoint';
  const kind = literalKindOf(given.literal);
  return kind !== null && role.literals.includes(kind) ? null : 'bad_literal';
}

/**
 * Checks arguments against a predicate: every role known, each endpoint and literal of a kind the role admits, each role
 * filled between its minimum and maximum, no role and position twice. The refusal is a stable code.
 */
export function checkArguments(
  definition: PredicateDefinition,
  given: ReadonlyArray<SemanticArgument>
): RegistryResult {
  const filled = new Map<string, Set<number>>();
  for (const argument of given) {
    const definedRole = definition.roles.find((one) => one.role === argument.role);
    if (!definedRole) return { ok: false, code: 'bad_role' };
    const code = checkOne(definedRole, argument);
    if (code !== null) return { ok: false, code };
    const positions = filled.get(definedRole.role) ?? new Set<number>();
    if (!Number.isInteger(argument.position) || argument.position < 0 || positions.has(argument.position))
      return { ok: false, code: 'bad_arity' };
    filled.set(definedRole.role, positions.add(argument.position));
  }
  for (const definedRole of definition.roles) {
    const count = filled.get(definedRole.role)?.size ?? 0;
    if (count < definedRole.min || count > definedRole.max) return { ok: false, code: 'bad_arity' };
  }
  return { ok: true };
}
