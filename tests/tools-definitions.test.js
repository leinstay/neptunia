// Tests for src/tools/definitions.ts: her own table of skills over the operations: one entry per
// operation in the registry order, the effects and features it declares, `toArgs` on generated
// samples, the quirks of the mapping, the API names and the validation of a bad table.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listOps } from '../src/tools/impl/index.ts';
import { OP_EFFECTS } from '../src/tools/impl/effects.ts';
import { FEATURE_SKILLS } from '../src/tools/access.ts';
import {
  API_NAMES,
  INTENT_PARAMS,
  SKILL_DEFINITIONS,
  apiNameOf,
  intentArgs,
  optionsOfDefinition,
  skillNameOfApi,
  validateDefinitions,
} from '../src/tools/definitions.ts';

const BY_NAME = new Map(SKILL_DEFINITIONS.map((definition) => [definition.name, definition]));
const ID = '123456789012345678';
const show = (value) => JSON.stringify(value, (key, inner) => (typeof inner === 'bigint' ? `${inner}n` : inner));

/** A value that satisfies `schema` for the argument `name`. */
function valueFor(name, schema, ref) {
  if (ref) return ID;
  if (schema.enum) return schema.enum[0];
  if (schema.type === 'integer') return schema.minimum ?? 1;
  if (schema.type === 'boolean') return true;
  return `${name} text`;
}

/** Samples of her arguments for `definition`: the shapes the plan asks for. */
function samplesOf(definition) {
  const { properties, required } = definition.params;
  const names = Object.keys(properties);
  const one = (name, value) => ({ [name]: value ?? valueFor(name, properties[name], definition.refs[name]) });
  const requiredOnly = Object.assign({}, ...required.map((name) => one(name)));
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
  assert.equal(SKILL_DEFINITIONS.length, 67);
  assert.deepEqual(
    SKILL_DEFINITIONS.map((definition) => definition.name),
    listOps().map((op) => op.name)
  );
  assert.ok(Object.isFrozen(SKILL_DEFINITIONS));
  assert.ok(Object.isFrozen(SKILL_DEFINITIONS[0].params));
  for (const definition of SKILL_DEFINITIONS) assert.equal(definition.op, definition.name);
});

test('every definition declares its own effects, cost, feature and a body that is one of its arguments', () => {
  for (const definition of SKILL_DEFINITIONS) {
    const { name } = definition;
    assert.equal(definition.effects, OP_EFFECTS[name], `${name}: effects table`);
    assert.equal(
      definition.feature,
      Object.hasOwn(FEATURE_SKILLS, name) ? FEATURE_SKILLS[name] : null,
      `${name}: feature`
    );
    assert.ok(definition.costClass, `${name}: costClass`);
    assert.ok(
      definition.body === null || Object.hasOwn(definition.params.properties, definition.body),
      `${name}: body`
    );
    const optionNames = optionsOfDefinition(definition).map((option) => option.name);
    for (const option of optionNames)
      assert.ok(Object.hasOwn(definition.params.properties, option), `${name}: option ${option}`);
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
  assert.deepEqual(Object.keys(BY_NAME.get('draw.create').params.properties), ['text', 'self', 'reply', 'channel']);
  assert.deepStrictEqual(BY_NAME.get('draw.create').toArgs({ text: 't', reply: 'm' }), {
    text: 't',
    self: false,
    replyTo: 'm',
  });
  assert.deepEqual(BY_NAME.get('message.create').params.required, []);
});

test('the intent skills carry only what their operation reads', () => {
  const names = (skill) => Object.keys(BY_NAME.get(skill).params.properties);
  assert.deepEqual(names('intent.cancel'), ['id']);
  assert.deepEqual(BY_NAME.get('intent.cancel').params.required, ['id']);
  assert.deepEqual(names('intent.list'), []);
  assert.ok(
    !names('intent.set').includes('id') &&
      names('intent.set').includes('state') &&
      names('intent.set').includes('reason')
  );
  assert.ok(!names('intent.update').includes('attend'));
  assert.deepEqual(BY_NAME.get('intent.update').params.required, [], 'the id may be the bare text');
  assert.deepStrictEqual(BY_NAME.get('intent.cancel').toArgs({ id: 'i1' }), { action: 'cancel', id: 'i1' });
  assert.deepStrictEqual(BY_NAME.get('intent.list').toArgs({}), { action: 'list' });
});

test('the members a leaf needs are required: without one the arguments are null', () => {
  for (const name of [
    'memory.profile.read',
    'memory.affinity.read',
    'alias.add',
    'alias.remove',
    'memory.private.read',
  ]) {
    assert.equal(BY_NAME.get(name).toArgs({ name: 'x' }), null, name);
    assert.equal(BY_NAME.get(name).toArgs({ user: ID, name: 'x' }).userId, ID, name);
  }
});

test('the quirks of the mapping are kept', () => {
  assert.deepStrictEqual(BY_NAME.get('lore.list').toArgs({}), { query: undefined });
  assert.deepStrictEqual(BY_NAME.get('status.show').toArgs({}), { field: null });
  assert.deepStrictEqual(BY_NAME.get('learning.remove').toArgs({ number: 3 }), { id: 3 });
  assert.deepStrictEqual(BY_NAME.get('memory.restore').toArgs({ id: 'a' }), { itemId: 'a' });
  assert.deepStrictEqual(BY_NAME.get('message.delete').toArgs({ message: 'm' }), {
    messageId: 'm',
    channelId: undefined,
  });
  assert.deepStrictEqual(BY_NAME.get('web.read').toArgs({ message: 'm' }), { url: undefined, message: 'm' });
  assert.deepStrictEqual(BY_NAME.get('draw.create').toArgs({ text: 't', channel: 5 }), {
    text: 't',
    self: false,
    channelId: '5',
  });
  assert.deepStrictEqual(BY_NAME.get('task.read').toArgs({ id: 'i' }), { id: 'i', action: 'read', from: undefined });
  assert.deepStrictEqual(BY_NAME.get('media.status').toArgs({ kind: 'gifs' }), { kind: 'gifs', action: 'status' });
  assert.deepStrictEqual(intentArgs('add')({ text: 't', settle: 0, channel: 7 }), {
    action: 'add',
    text: 't',
    settle: 0,
    channelId: '7',
  });
  assert.equal(BY_NAME.get('intent.set').params, INTENT_PARAMS.set);
  assert.equal(BY_NAME.get('intent.update').params, INTENT_PARAMS.update);
});

test('the result of a skill: job for the two background ones, data for a read, effect for the rest', () => {
  for (const definition of SKILL_DEFINITIONS) {
    const expected = ['task.run', 'media.recache'].includes(definition.name)
      ? 'job'
      : definition.effects === 'read'
        ? 'data'
        : 'effect';
    assert.equal(definition.result, expected, definition.name);
  }
});

test('the API names: 67, well-formed, unique, a round trip, no longer than 64', () => {
  const apis = SKILL_DEFINITIONS.map((definition) => definition.api);
  assert.equal(apis.length, 67);
  assert.equal(new Set(apis).size, 67);
  assert.equal(Object.keys(API_NAMES).length, 67);
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
  for (const definition of SKILL_DEFINITIONS) {
    for (const [name, schema] of Object.entries(definition.params.properties)) {
      const isRef =
        schema.type === 'string' && schema.maxLength === 100 && ['channel', 'attend', 'user', 'role'].includes(name);
      assert.equal(Object.hasOwn(definition.refs, name), isRef, `${definition.name}.${name}`);
    }
  }
});

test('validateDefinitions accepts the table and throws on bad input', () => {
  assert.equal(validateDefinitions(), SKILL_DEFINITIONS);
  const first = SKILL_DEFINITIONS[0];
  const second = SKILL_DEFINITIONS[1];
  const copy = (definition, change) => ({ ...definition, ...change });
  assert.throws(() => validateDefinitions('no'), /list/);
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
  assert.throws(() => validateDefinitions([copy(first, { feature: 3 })]), /feature/);
});

test('voice.say: a paid skill of hers only behind features.speech, text required, no owner command', () => {
  const definition = BY_NAME.get('voice.say');
  assert.equal(definition.effects, 'paid');
  assert.equal(definition.feature, 'speech');
  assert.equal(definition.body, 'text');
  assert.deepEqual(definition.params.required, ['text']);
  assert.deepEqual(Object.keys(definition.params.properties), ['text', 'channel', 'reply']);
  assert.deepStrictEqual(definition.toArgs({ text: 't', reply: 'm' }), { text: 't', replyTo: 'm' });
});
