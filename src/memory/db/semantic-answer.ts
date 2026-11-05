// The two structured groups of a memory session's answer, `entities` and `assertions` (docs/prompt-contract.md, "Memory
// session answer"). session.ts#validateAnswer hands them here: anything that does not hold is dropped and counted, never
// repaired, and a reference is resolved to a typed id or to a handle of this answer's own new entities. What only the
// database can judge (a kind, a predicate, a role) is left to the writer, which refuses it with its own decision.

import { SELF_PERSON } from './ids.ts';
import type { Row } from './types.ts';

const ENTITY_FIELDS = new Set(['handle', 'kind', 'name', 'language', 'sources']);
const ASSERTION_FIELDS = new Set([
  'predicate',
  'assertionKind',
  'text',
  'arguments',
  'polarity',
  'how',
  'state',
  'validFrom',
  'validTo',
  'sources',
  'premises',
]);
const ARGUMENT_FIELDS = new Set(['role', 'position', 'ref', 'literal']);
const PREMISE_FIELDS = new Set(['handle', 'role']);

const isObject = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const words = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';
const onlyFields = (given: Row, allowed: ReadonlySet<string>): boolean =>
  Object.keys(given).every((key) => allowed.has(key));

/** What the session's validation lends this one: its list of a group, its evidence check and its resolvers. */
export type SemanticAnswerTools = {
  list: (key: string) => Array<unknown>;
  sourcesOf: (list: unknown) => Array<string> | null;
  person: (subject: unknown) => { id: string } | null;
  places: ReadonlyMap<string, string> | undefined;
  priorVersions: ReadonlyMap<string, string> | undefined;
  keep: (group: 'entities' | 'assertions', entry: Row) => void;
  drop: (reason: string) => void;
};

/** A `ref` of the answer: a handle of this answer, a place handle, herself or a person of this page. */
function refOf(given: unknown, handles: ReadonlySet<string>, tools: SemanticAnswerTools): Row | null {
  if (typeof given !== 'string') return null;
  const word = given.trim();
  if (handles.has(word)) return { handle: word };
  const place = tools.places?.get(word);
  if (place !== undefined) return { kind: 'place', id: place };
  if (word.toLowerCase() === 'self') return { kind: 'person', id: SELF_PERSON };
  const person = tools.person(word);
  return person === null ? null : { kind: 'person', id: person.id };
}

function argumentsOf(given: unknown, handles: ReadonlySet<string>, tools: SemanticAnswerTools): Array<Row> | string {
  if (!Array.isArray(given)) return 'bad_arity';
  const out: Array<Row> = [];
  for (const one of given as Array<unknown>) {
    if (!isObject(one) || !onlyFields(one, ARGUMENT_FIELDS)) return 'unknown_field';
    const { role, position } = one;
    if (!Object.hasOwn(one, 'ref')) {
      if (!Object.hasOwn(one, 'literal')) return 'bad_arity';
      out.push({ role, position, literal: one.literal });
      continue;
    }
    if (Object.hasOwn(one, 'literal')) return 'bad_arity';
    const ref = refOf(one.ref, handles, tools);
    if (ref === null) return 'unknown_ref';
    out.push({ role, position, ref });
  }
  return out;
}

function premisesOf(given: unknown, tools: SemanticAnswerTools): Array<Row> | string {
  if (given === undefined) return [];
  if (!Array.isArray(given)) return 'unknown_version';
  const out: Array<Row> = [];
  for (const one of given as Array<unknown>) {
    if (!isObject(one) || !onlyFields(one, PREMISE_FIELDS)) return 'unknown_field';
    const versionId = tools.priorVersions?.get(String(one.handle));
    if (versionId === undefined) return 'unknown_version';
    out.push({ versionId, role: one.role });
  }
  return out;
}

function validateEntities(tools: SemanticAnswerTools): Set<string> {
  const handles = new Set<string>();
  for (const item of tools.list('entities')) {
    if (!isObject(item)) tools.drop('bad_op');
    else if (!onlyFields(item, ENTITY_FIELDS)) tools.drop('unknown_field');
    else if (!words(item.handle) || handles.has(String(item.handle))) tools.drop('bad_handle');
    else if (!words(item.name) || !words(item.language)) tools.drop('bad_name');
    else {
      const sources = tools.sourcesOf(item.sources);
      if (!sources) continue;
      handles.add(String(item.handle));
      tools.keep('entities', { ...item, sources });
    }
  }
  return handles;
}

/** The structured groups of an answer: an op is kept whole or dropped by its one reason. */
export function validateSemanticAnswer(tools: SemanticAnswerTools): void {
  const handles = validateEntities(tools);
  for (const item of tools.list('assertions')) {
    if (!isObject(item)) tools.drop('bad_op');
    else if (!onlyFields(item, ASSERTION_FIELDS)) tools.drop('unknown_field');
    else if (!words(item.text)) tools.drop('no_text');
    else {
      const sources = tools.sourcesOf(item.sources);
      if (!sources) continue;
      const given = argumentsOf(item.arguments, handles, tools);
      if (typeof given === 'string') {
        tools.drop(given);
        continue;
      }
      const premises = premisesOf(item.premises, tools);
      if (typeof premises === 'string') {
        tools.drop(premises);
        continue;
      }
      tools.keep('assertions', {
        predicate: item.predicate,
        assertionKind: item.assertionKind,
        text: item.text,
        polarity: item.polarity,
        how: item.how,
        state: item.state ?? 'current',
        validFrom: item.validFrom ?? null,
        validTo: item.validTo ?? null,
        arguments: given,
        dependencies: premises,
        sources,
      });
    }
  }
}
