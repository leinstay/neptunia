// Tests for the query builder's strict JSON answer (src/behavior/query-builder.ts): QUERY_PLAN_FORMAT is the answer's
// schema, and parseQueryPlan reads the object text with one field per label of the old
// lines, each null when unused: `web`, `history` and `who` (comma-separated forms), `when` (`YYYY-MM-DD[ HH:MM]` on each
// side of `..`), `when_role` (`scope` or `locator`), `recent` (`yes` or `no`) and `skills` (`inventory` or names). The
// values read as the lines' values did. An answer that is not the object, the old labelled lines and the bare `none`
// included, plans nothing with the reason `unparsed`; a blank answer stays `empty`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUERY_PLAN_FORMAT, parseQueryPlan } from '../src/behavior/query-builder.ts';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const OPTIONS = { timezone: 'UTC', now: NOW, maxForms: 8 };
const FIELDS = ['history', 'recent', 'skills', 'web', 'when', 'when_role', 'who'];

/** The object text of an answer: every field null, then `fields`. */
const answer = (fields: Record<string, unknown>) =>
  JSON.stringify({
    web: null,
    history: null,
    who: null,
    when: null,
    when_role: null,
    recent: null,
    skills: null,
    ...fields,
  });

const NOTHING_READ = { web: null, history: null, reason: 'unparsed' };

type Schema = {
  type?: unknown;
  additionalProperties?: unknown;
  required?: Array<string>;
  properties?: Record<string, unknown>;
};

test('QUERY_PLAN_FORMAT is a closed object that requires one field per label', () => {
  // Bug: a field left out of `required` is dropped by a strict provider, and every answer then reads as unparsed.
  const schema = QUERY_PLAN_FORMAT.schema as Schema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...(schema.required ?? [])].sort(), FIELDS);
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), FIELDS);
});

test('a history field becomes the history part with its forms', () => {
  const plan = parseQueryPlan(answer({ history: 'κουνέλι, κουνελιού' }), { ...OPTIONS, skillNames: ['garden'] });
  assert.deepEqual(plan.history?.forms, ['κουνέλι', 'κουνελιού']);
  assert.equal(plan.web, null);
  assert.equal(plan.reason, 'ok');
  // A null skills field is no skills line: the plan carries no `skills`.
  assert.equal(Object.hasOwn(plan, 'skills'), false);
});

test('web and history are planned in one answer', () => {
  const plan = parseQueryPlan(answer({ web: 'tomato frost date', history: 'tomate' }), OPTIONS);
  assert.equal(plan.web, 'tomato frost date');
  assert.deepEqual(plan.history?.forms, ['tomate']);
});

test('who and when belong to the history part', () => {
  const plan = parseQueryPlan(answer({ who: 'Ana', when: '2026-10-01' }), OPTIONS);
  assert.deepEqual(plan.history?.who, ['ana']);
  assert.equal(plan.history?.from, Date.UTC(2026, 9, 1));
});

test('recent and a located time qualify the history part', () => {
  const plan = parseQueryPlan(
    answer({ history: 'tomate', recent: 'yes', when: '2026-10-01', when_role: 'locator' }),
    OPTIONS
  );
  assert.equal(plan.history?.recent, true);
  assert.equal(plan.history?.locator, true);
});

test('a scope role keeps a range beside forms from being a locator, and recent no is not recent', () => {
  // Bug: the role is read off the wrong field, so a question about a day searches only the event's own words.
  const plan = parseQueryPlan(
    answer({ history: 'tomate', recent: 'no', when: '2026-10-01', when_role: 'scope' }),
    OPTIONS
  );
  assert.equal(plan.history?.locator, undefined);
  assert.equal(plan.history?.recent, undefined);
  assert.equal(plan.history?.from, Date.UTC(2026, 9, 1));
});

test('every field null plans no search', () => {
  assert.deepEqual(parseQueryPlan(answer({}), OPTIONS), { web: null, history: null, reason: 'none' });
});

test('a skills field is read beside the plan, and alone it plans no search', () => {
  const beside = parseQueryPlan(answer({ history: 'tomate', skills: 'garden' }), {
    ...OPTIONS,
    skillNames: ['garden'],
  });
  assert.deepEqual(beside.history?.forms, ['tomate']);
  assert.deepEqual([beside.skills?.state, beside.skills?.names], ['named', ['garden']]);
  const alone = parseQueryPlan(answer({ skills: 'inventory' }), { ...OPTIONS, skillNames: ['garden'] });
  assert.deepEqual([alone.web, alone.history, alone.reason, alone.skills?.state], [null, null, 'none', 'inventory']);
});

test('a date nobody can read is unparsed, as its line was', () => {
  const plan = parseQueryPlan(answer({ when: 'last spring' }), OPTIONS);
  assert.deepEqual([plan.web, plan.history, plan.reason], [null, null, 'unparsed']);
});

/** Answers that are not the object: each plans nothing, unparsed. */
const UNREADABLE = [
  'history: tomate',
  'web: tomato frost date\nhistory: tomate',
  'none',
  'tomato frost date',
  '```json\n' + answer({ history: 'tomate' }) + '\n```',
  answer({ history: 'tomate' }).slice(0, -1),
  JSON.stringify({ history: 'tomate' }),
  JSON.stringify({ web: null, history: 'tomate', who: null, when: null, when_role: null, recent: null }),
  answer({ history: ['tomate'] }),
  answer({ web: 5 }),
  answer({ when: 20261001 }),
  answer({ when_role: 'sometimes', when: '2026-10-01', history: 'tomate' }),
  answer({ recent: true, history: 'tomate' }),
  answer({ recent: 'maybe', history: 'tomate' }),
  answer({ skills: ['garden'] }),
  '[]',
  'null',
  '"history: tomate"',
];

test('an answer that is not the object, the old lines and the bare none included, plans nothing', () => {
  for (const raw of UNREADABLE) {
    assert.deepEqual(parseQueryPlan(raw, { ...OPTIONS, skillNames: ['garden'] }), NOTHING_READ, raw);
  }
});
