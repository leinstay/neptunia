// Tests for src/tools/definitions.ts: her own table of skills over the operations: one entry per
// operation in the registry order, the effects it declares, `toArgs` on generated
// samples, the quirks of the mapping, the API names, the traits and the lists derived from them (`toolsWith`,
// `hasTrait`), and the validation of a bad table.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listOps } from '../src/tools/operations/index.ts';
import {
  INTENT_PARAMS,
  SKILL_DEFINITIONS,
  apiNameOf,
  hasTrait,
  intentArgs,
  optionsOfDefinition,
  skillNameOfApi,
  toolsWith,
  validateDefinitions,
} from '../src/tools/definitions.ts';
import type { Definition } from '../src/tools/definitions.ts';
import type { Untyped } from '../src/tools/types.ts';
import fs from 'node:fs';
import path from 'node:path';
import { buildTools } from '../src/tools/tools-json.ts';
import { buildSkills } from '../src/tools/registry.ts';
import { ROOT } from './fixtures/source-tree.ts';
import { POSTING_SKILLS } from '../src/behavior/inner/settings.ts';

// The casts through `Parameters<typeof f>` hand a function a fake that carries only the fields the test reads.

const BY_NAME = new Map(SKILL_DEFINITIONS.map((definition) => [definition.name, definition]));
const ID = '123456789012345678';
const show = (value: unknown) =>
  JSON.stringify(value, (key, inner) => (typeof inner === 'bigint' ? `${inner}n` : inner));

/** A value that satisfies `schema` for the argument `name`. */
function valueFor(name: string, schema: Untyped, ref: unknown) {
  if (ref) return ID;
  if (schema.enum) return schema.enum[0];
  if (schema.type === 'integer') return schema.minimum ?? 1;
  if (schema.type === 'boolean') return true;
  return `${name} text`;
}

/** Samples of her arguments for `definition`: the shapes the plan asks for. */
function samplesOf(definition: Untyped) {
  const { properties, required } = definition.params;
  const names = Object.keys(properties);
  const one = (name: string, value?: unknown) => ({
    [name]: value ?? valueFor(name, properties[name], definition.refs[name]),
  });
  const requiredOnly = Object.assign({}, ...required.map((name: Untyped) => one(name)));
  const samples = [{}, requiredOnly, Object.assign({}, ...names.map((name) => one(name)))];
  for (const name of names) {
    const schema = properties[name];
    samples.push(one(name), { ...requiredOnly, ...one(name) });
    for (const value of schema.enum ?? []) samples.push({ ...requiredOnly, ...one(name, value) });
    if (schema.type === 'boolean') {
      for (const value of [true, false, 'true', 'false', ' TRUE ', 'maybe'])
        samples.push({ ...requiredOnly, ...one(name, value) });
    }
    if (schema.type === 'integer') {
      for (const value of [schema.minimum ?? 0, schema.maximum ?? 1000])
        samples.push({ ...requiredOnly, ...one(name, value) });
    }
    if (definition.refs[name])
      samples.push({ ...requiredOnly, ...one(name, 123456789012345678n) }, { ...requiredOnly, ...one(name, 42) });
    samples.push({ ...requiredOnly, [name]: undefined });
  }
  return samples;
}

test('the table holds every operation, in the operations registry order', () => {
  // Two more since the board tools task.propose and task.status (PR 6c).
  // And skill.run of the executable skills, and task.cancel, task.comment and task.answer of her wake.
  // Changed: task.unblock is the 77th tool.
  // 76 since `person.link` (plan 2026-11-08-meta-person slice 8): one operation, one row.
  // 75 since `inner.status` left: it repeated the `inner` field of the owner's status card.
  // 73 since `memory.affinity.read` and `errand.status` merged into `memory.profile.read` and `errand.list`.
  assert.equal(SKILL_DEFINITIONS.length, 73);
  assert.deepEqual(
    SKILL_DEFINITIONS.map((definition) => definition.name),
    listOps().map((op) => op.name)
  );
  assert.ok(Object.isFrozen(SKILL_DEFINITIONS));
  assert.ok(Object.isFrozen(SKILL_DEFINITIONS[0].params));
  for (const definition of SKILL_DEFINITIONS) assert.equal(definition.op, definition.name);
});

test('every definition declares its own effects, cost and a body that is one of its arguments', () => {
  for (const definition of SKILL_DEFINITIONS) {
    const { name } = definition;
    assert.ok(definition.costClass, `${name}: costClass`);
    assert.ok(
      definition.body === null || Object.hasOwn(definition.params.properties ?? {}, definition.body),
      `${name}: body`
    );
    const optionNames = optionsOfDefinition(definition).map((option) => option.name);
    for (const option of optionNames)
      assert.ok(Object.hasOwn(definition.params.properties ?? {}, option), `${name}: option ${option}`);
  }
});

test('toArgs gives null or a plain object on every generated sample', () => {
  let compared = 0;
  for (const definition of SKILL_DEFINITIONS) {
    for (const sample of samplesOf(definition)) {
      const args = definition.toArgs(sample);
      assert.ok(
        args === null || (typeof args === 'object' && !Array.isArray(args)),
        `${definition.name}: ${show(sample)}`
      );
      compared += 1;
    }
  }
  assert.ok(compared > 700);
});

test('the expected differences: draw.create takes reply, message.create requires nothing', () => {
  assert.deepEqual(Object.keys(BY_NAME.get('draw.create')?.params.properties ?? {}), [
    'text',
    'self',
    'reply',
    // Slice 7 of the turn frame: the place argument is `place` on every tool, no platform noun.
    'place',
  ]);
  assert.deepStrictEqual(BY_NAME.get('draw.create')?.toArgs({ text: 't', reply: 'm' }), {
    text: 't',
    self: false,
    replyTo: 'm',
  });
  assert.deepEqual(BY_NAME.get('message.create')?.params.required, []);
});

test('the intent skills carry only what their operation reads', () => {
  const names = (skill: string) => Object.keys(BY_NAME.get(skill)?.params.properties ?? {});
  assert.deepEqual(names('intention.cancel'), ['id']);
  assert.deepEqual(BY_NAME.get('intention.cancel')?.params.required, ['id']);
  assert.deepEqual(names('intention.list'), []);
  assert.ok(
    !names('intention.set').includes('id') &&
      names('intention.set').includes('state') &&
      names('intention.set').includes('reason')
  );
  assert.ok(!names('intention.update').includes('attend'));
  assert.deepEqual(BY_NAME.get('intention.update')?.params.required, [], 'the id may be the bare text');
  assert.deepStrictEqual(BY_NAME.get('intention.cancel')?.toArgs({ id: 'i1' }), { action: 'cancel', id: 'i1' });
  assert.deepStrictEqual(BY_NAME.get('intention.list')?.toArgs({}), { action: 'list' });
});

test('the members a leaf needs are required: without one the arguments are null', () => {
  for (const name of ['memory.profile.read', 'alias.add', 'alias.remove', 'memory.private.read']) {
    assert.equal(BY_NAME.get(name)?.toArgs({ name: 'x' }), null, name);
    assert.equal(BY_NAME.get(name)?.toArgs({ user: ID, name: 'x' })?.accountId, ID, name);
  }
});

test('memory.profile.read reads one person or, with section changes, every person', () => {
  // Catches: the merge keeps `user` required and the list across people cannot be asked for.
  const definition = BY_NAME.get('memory.profile.read')!;
  assert.deepEqual(definition.params.required, []);
  assert.equal(definition.toArgs({ section: 'summary' }), null, 'a person section needs a person');
  const asked = definition.params.properties ?? {};
  assert.ok((asked.section?.enum ?? []).includes('changes'));
  const everyone = definition.toArgs({ section: 'changes', since: '2026-11-01', limit: 5 });
  assert.equal(everyone?.accountId, undefined);
  assert.equal(everyone?.section, 'changes');
  assert.equal(everyone?.since, '2026-11-01');
  assert.equal(everyone?.limit, 5);
  assert.equal(definition.toArgs({ section: 'changes', user: ID })?.accountId, ID);
  assert.ok(asked.since && asked.until);
});

test('errand.list takes the filters and the id, and errand.status and memory.affinity.read are gone', () => {
  const definition = BY_NAME.get('errand.list')!;
  const properties = definition.params.properties ?? {};
  for (const key of ['id', 'state', 'since', 'until', 'limit']) assert.ok(properties[key], key);
  assert.deepEqual(properties.state?.enum, ['queued', 'running', 'done', 'failed', 'cancelled']);
  assert.deepEqual(definition.toArgs({ state: 'done', limit: 3 })?.state, 'done');
  assert.equal(BY_NAME.has('errand.status'), false);
  assert.equal(BY_NAME.has('memory.affinity.read'), false);
});

test('the quirks of the mapping are kept', () => {
  assert.deepStrictEqual(BY_NAME.get('lore.list')?.toArgs({}), { query: undefined });
  assert.deepStrictEqual(BY_NAME.get('status.show')?.toArgs({}), { field: null });
  assert.deepStrictEqual(BY_NAME.get('learning.remove')?.toArgs({ number: 3 }), { id: 3 });
  assert.deepStrictEqual(BY_NAME.get('memory.restore')?.toArgs({ id: 'a' }), { itemId: 'a' });
  assert.deepStrictEqual(BY_NAME.get('message.delete')?.toArgs({ message: 'm' }), {
    messageId: 'm',
    placeId: undefined,
  });
  assert.deepStrictEqual(BY_NAME.get('web.read')?.toArgs({ message: 'm' }), { url: undefined, message: 'm' });
  assert.deepStrictEqual(BY_NAME.get('draw.create')?.toArgs({ text: 't', place: 5 }), {
    text: 't',
    self: false,
    placeId: '5',
  });
  assert.deepStrictEqual(BY_NAME.get('errand.read')?.toArgs({ id: 'i' }), { id: 'i', action: 'read', from: undefined });
  assert.deepStrictEqual(BY_NAME.get('media.status')?.toArgs({ kind: 'gifs' }), { kind: 'gifs', action: 'status' });
  assert.deepStrictEqual(intentArgs('add')({ text: 't', settle: 0, place: 7 }), {
    action: 'add',
    text: 't',
    settle: 0,
    placeId: '7',
  });
  assert.equal(BY_NAME.get('intention.set')?.params, INTENT_PARAMS.set);
  assert.equal(BY_NAME.get('intention.update')?.params, INTENT_PARAMS.update);
});

test('the result of a skill: job for the two background ones, data for a read, effect for the rest', () => {
  for (const definition of SKILL_DEFINITIONS) {
    const expected = ['errand.run', 'media.recache'].includes(definition.name)
      ? 'job'
      : definition.effects === 'read'
        ? 'data'
        : 'effect';
    assert.equal(definition.result, expected, definition.name);
  }
});

test('the API names: 73, well-formed, unique, a round trip, no longer than 64', () => {
  // Two more since the board tools task.propose and task.status (PR 6c).
  const apis = SKILL_DEFINITIONS.map((definition) => definition.api);
  // Changed: task.unblock is the 77th tool.
  // 75 since `inner.status` left, 73 since the two merged reads.
  assert.equal(apis.length, 73);
  assert.equal(new Set(apis).size, 73);
  for (const definition of SKILL_DEFINITIONS) {
    assert.match(definition.api, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.equal(apiNameOf(definition.name), definition.api);
    assert.equal(skillNameOfApi(definition.api), definition.name);
  }
  assert.equal(apiNameOf('draw.create'), 'draw_create');
  assert.equal(apiNameOf('nothing.here'), null);
  assert.equal(skillNameOfApi('nothing_here'), null);
  assert.equal(apiNameOf('constructor'), null);
});

test('a reference argument is a reference, and only those', () => {
  // Slice 7: the tool argument `channel` is named `place`.
  for (const definition of SKILL_DEFINITIONS) {
    for (const [name, schema] of Object.entries(definition.params.properties ?? {})) {
      const isRef =
        schema.type === 'string' && schema.maxLength === 100 && ['place', 'attend', 'user', 'role'].includes(name);
      assert.equal(Object.hasOwn(definition.refs, name), isRef, `${definition.name}.${name}`);
    }
  }
});

test('validateDefinitions accepts the table and throws on bad input', () => {
  assert.equal(validateDefinitions(), SKILL_DEFINITIONS);
  const first = SKILL_DEFINITIONS[0];
  const second = SKILL_DEFINITIONS[1];
  const copy = (definition: Record<string, unknown> | undefined, change: Record<string, unknown>) => ({
    ...definition,
    ...change,
  });
  assert.throws(() => validateDefinitions('no' as unknown as Parameters<typeof validateDefinitions>[0]), /list/);
  assert.throws(() => validateDefinitions([copy(first, { name: '' })]), /name/);
  assert.throws(() => validateDefinitions([first, copy(second, { name: first.name })]), /twice/);
  assert.throws(() => validateDefinitions([first, copy(second, { api: first.api })]), /used twice/);
  assert.throws(() => validateDefinitions([copy(first, { api: 'bad name' })]), /api name/);
  assert.throws(() => validateDefinitions([copy(first, { api: 'a'.repeat(65) })]), /api name/);
  assert.throws(() => validateDefinitions([copy(first, { body: 'nothing' })]), /body/);
  assert.throws(() => validateDefinitions([copy(BY_NAME.get('rule.remove'), { body: 'number' })]), /body/);
  assert.throws(() => validateDefinitions([copy(first, { refs: { nothing: 'channel' } })]), /ref/);
  assert.throws(() => validateDefinitions([copy(first, { refs: { field: 'thing' } })]), /kind/);
  assert.throws(() => validateDefinitions([copy(first, { effects: 'loud' })]), /effects/);
  assert.throws(() => validateDefinitions([copy(first, { costClass: 'dear' })]), /costClass/);
  assert.throws(() => validateDefinitions([copy(first, { result: 'maybe' })]), /result/);
  assert.throws(() => validateDefinitions([copy(first, { params: null })]), /params/);
  assert.throws(() => validateDefinitions([copy(first, { toArgs: null })]), /toArgs/);
});

test('voice.say: a paid skill of hers, text required, no owner command', () => {
  const definition = BY_NAME.get('voice.say');
  assert.equal(definition?.effects, 'paid');
  assert.equal(definition?.body, 'text');
  assert.deepEqual(definition?.params.required, ['text']);
  // Slice 7: the tool argument `channel` is named `place`.
  assert.deepEqual(Object.keys(definition?.params.properties ?? {}), ['text', 'place', 'reply']);
  assert.deepStrictEqual(definition?.toArgs({ text: 't', reply: 'm' }), { text: 't', replyTo: 'm' });
});

// ---- slice 7 of the turn frame: the tools speak of a place, never of a platform -----------------------------------

/** The tools that name where they act, each by its argument `place` (plan 2026-11-06-turn-frame, slice 7 (b)). */
const PLACE_TOOLS: ReadonlyArray<string> = [
  'draw.create',
  'voice.say',
  'memory.channel.read',
  'message.create',
  'message.edit',
  'message.delete',
  'message.react.add',
  'message.react.remove',
  'intention.set',
  'intention.update',
  'memory.search',
  'conversation.read',
];

/** A platform's noun as a word of its own, in either number. A tool's own name is taken out before the match. */
const PLATFORM_WORD = /\b(?:channel|server|root|discord)s?\b/i;

/** A non-platform word spelled the same, where a tool means it: the errand agent named `server` and the machine she runs on. */
const MACHINE_SERVER: ReadonlySet<string> = new Set(['errand_run', 'watcher_read']);
const NOT_A_MACHINE = /\b(?:channel|root|discord)s?\b/i;

/** `text` without the names of the tools it refers to (`memory.server.read`, `memory_server_read`) and its `{{fill}}`s. */
function withoutToolNames(text: string): string {
  let rest = text.replace(/\{\{[^{}]*\}\}/g, '');
  for (const definition of SKILL_DEFINITIONS) {
    rest = rest.replaceAll(definition.name, '');
    rest = rest.replaceAll(definition.api, '');
  }
  return rest;
}

test('no tool description, argument name or argument text names a platform', () => {
  // Bug: the tools array, the first part of the cached prefix and the same for every interface, tells a Telegram turn
  // about "this server's channels", and she names a place by a word that exists on one platform only.
  const texts: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'tools.json'), 'utf8'));
  const tools = buildTools(
    SKILL_DEFINITIONS.map((definition) => definition.name),
    { registry: buildSkills({ table: SKILL_DEFINITIONS }), texts }
  );
  const found: Array<string> = [];
  for (const tool of tools) {
    const { name, description, parameters } = tool.function;
    const word = MACHINE_SERVER.has(name) ? NOT_A_MACHINE : PLATFORM_WORD;
    if (word.test(withoutToolNames(description))) found.push(`${name}: description`);
    const properties = (parameters as { properties?: Record<string, { description?: string }> }).properties ?? {};
    for (const [arg, schema] of Object.entries(properties)) {
      if (PLATFORM_WORD.test(arg)) found.push(`${name}: argument ${arg}`);
      if (word.test(withoutToolNames(schema.description ?? ''))) found.push(`${name}: text of ${arg}`);
    }
  }
  assert.deepEqual(found, []);
});

for (const name of PLACE_TOOLS) {
  test(`${name} names where it acts by place, and the place reaches its operation as placeId`, () => {
    // Bug: a tool keeps \`channel\` beside \`place\`, or the renamed argument is dropped on its way to the operation.
    const definition = BY_NAME.get(name);
    assert.ok(definition, name);
    const schemas = definition.params.properties ?? {};
    const properties = Object.keys(schemas);
    assert.deepEqual(
      [properties.includes('place'), properties.includes('channel')],
      [true, false],
      properties.join(',')
    );
    const required = Object.fromEntries(
      (definition.params.required ?? []).map((arg) => [arg, valueFor(arg, schemas[arg], null)])
    );
    const args = definition.toArgs({ ...required, place: 'fake:channel:c9' });
    assert.equal(args?.placeId, 'fake:channel:c9', show(args));
  });
}

test('the posting tools are the text post, the picture and the voice message, and only they post', () => {
  // Catches: a posting tool dropped from the one declaration, which every posting list reads.
  assert.deepEqual([...toolsWith('posts')].sort(), ['draw.create', 'message.create', 'voice.say']);
  assert.deepEqual([...POSTING_SKILLS].sort(), ['draw.create', 'message.create', 'voice.say']);
});

test('a tool that attaches a file also posts, and edits are written but never post', () => {
  // Catches: a file post that the posting checks miss, or an edit counted as a new line of hers.
  for (const name of toolsWith('attaches')) assert.ok(hasTrait(name, 'posts'), name);
  assert.equal(hasTrait('message.edit', 'written'), true);
  assert.equal(hasTrait('message.edit', 'posts'), false);
});

test('hasTrait answers false for a name no tool has, an inherited property name included', () => {
  // Catches: a lookup through a plain object, where `constructor` would be found.
  assert.equal(hasTrait('nothing.here', 'self'), false);
  assert.equal(hasTrait('constructor', 'self'), false);
});

test('validateDefinitions refuses an unknown trait and a repeated one', () => {
  // Catches: a misspelt trait that silently drops a tool from the list it was meant to join.
  const first: Definition = SKILL_DEFINITIONS[0];
  const withTraits = (traits: ReadonlyArray<string>) => [{ ...first, traits }];
  assert.throws(() => validateDefinitions(withTraits(['postss'])), /unknown trait postss/);
  assert.throws(() => validateDefinitions(withTraits(['posts', 'posts'])), /trait posts twice/);
  assert.throws(() => validateDefinitions([{ ...first, traits: null }]), /traits must be a list/);
});
