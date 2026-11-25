// Tests for src/tools/definitions.ts: the persona's own table of skills over the operations: one entry per
// operation in the registry order, the effects it declares, `toArgs` on generated
// samples, the quirks of the mapping, the API names, the traits and the lists derived from them (`toolsWith`,
// `hasTrait`), and the validation of a bad table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listOps } from '../../../src/tools/operations/index.ts';
import {
  EFFECT_CLASSES,
  INTENT_PARAMS,
  SKILL_DEFINITIONS,
  currentToolName,
  apiNameOf,
  hasTrait,
  intentArgs,
  optionsOfDefinition,
  skillNameOfApi,
  toolsWith,
  validateDefinitions,
} from '../../../src/tools/definitions.ts';
import type { Definition } from '../../../src/tools/definitions.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import fs from 'node:fs';
import path from 'node:path';
import { buildTools } from '../../../src/tools/tools-json.ts';
import { buildSkills, skillRegistry } from '../../../src/tools/registry.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';
import { ROOT } from '../../fixtures/source-tree.ts';
import { ROUTE_ROLES } from '../../../src/llm/route-text.ts';
import { POSTING_SKILLS } from '../../../src/behavior/inner/settings.ts';

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

/** Samples of the persona's arguments for `definition`, in the shapes each schema takes. */
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

test('the table names registered operations, in the operations registry order, and leaves out the console ones', () => {
  assert.equal(SKILL_DEFINITIONS.length, 51);
  const names = SKILL_DEFINITIONS.map((definition) => definition.name);
  const ops = listOps().map((op) => op.name);
  // An operation of the console alone has no entry, so the table is the registry less those, in its order.
  assert.deepEqual(
    names,
    ops.filter((name) => names.includes(name))
  );
  // The owner's agent operations, `agent.list`, `agent.enable` and `agent.disable`, are no tools of the persona's.
  assert.deepEqual(
    ops.filter((name) => !names.includes(name)),
    [
      'status.show',
      'model.show',
      'route.list',
      'rule.list',
      'access.list',
      'lore.add',
      'lore.remove',
      'agent.list',
      'agent.enable',
      'agent.disable',
      'tools.describe',
    ]
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
    // The people a picture shows besides the persona are a required list.
    'people',
    'reply',
    // The place argument is `place` on every tool, no platform noun.
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
  for (const name of ['memory.profile.read', 'memory.private.read']) {
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

test('the quirks of the mapping are kept', () => {
  assert.deepStrictEqual(BY_NAME.get('lore.list')?.toArgs({}), { query: undefined });
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
  assert.deepStrictEqual(intentArgs('add')({ text: 't', settle: 0, place: 7 }), {
    action: 'add',
    text: 't',
    settle: 0,
    placeId: '7',
  });
  assert.equal(BY_NAME.get('intention.set')?.params, INTENT_PARAMS.set);
  assert.equal(BY_NAME.get('intention.update')?.params, INTENT_PARAMS.update);
});

test('the result of a skill: job for the background one, data for a read, effect for the rest', () => {
  for (const definition of SKILL_DEFINITIONS) {
    // The three errand tools are the background jobs.
    const expected = ['errand.server', 'errand.scout', 'errand.code'].includes(definition.name)
      ? 'job'
      : definition.effects === 'read'
        ? 'data'
        : 'effect';
    assert.equal(definition.result, expected, definition.name);
  }
});

test('the API names: 51, well-formed, unique, a round trip, no longer than 64', () => {
  const apis = SKILL_DEFINITIONS.map((definition) => definition.api);
  assert.equal(apis.length, 51);
  assert.equal(new Set(apis).size, 51);
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
  // The first entry is `config.set`, whose arguments are `path` and `value`.
  assert.throws(() => validateDefinitions([copy(first, { refs: { path: 'thing' } })]), /kind/);
  assert.throws(() => validateDefinitions([copy(first, { effects: 'loud' })]), /effects/);
  assert.throws(() => validateDefinitions([copy(first, { costClass: 'dear' })]), /costClass/);
  assert.throws(() => validateDefinitions([copy(first, { result: 'maybe' })]), /result/);
  assert.throws(() => validateDefinitions([copy(first, { params: null })]), /params/);
  assert.throws(() => validateDefinitions([copy(first, { toArgs: null })]), /toArgs/);
});

test("voice.say: a paid skill of the persona's, text required, no owner command", () => {
  const definition = BY_NAME.get('voice.say');
  assert.equal(definition?.effects, 'paid');
  assert.equal(definition?.body, 'text');
  assert.deepEqual(definition?.params.required, ['text']);
  assert.deepEqual(Object.keys(definition?.params.properties ?? {}), ['text', 'place', 'reply']);
  assert.deepStrictEqual(definition?.toArgs({ text: 't', reply: 'm' }), { text: 't', replyTo: 'm' });
});

// ---- the tools speak of a place, never of a platform --------------------------------------------------------------

/** The tools that name where they act, each by its argument `place`. */
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

/** A non-platform word spelled the same, where a tool means it: the errand agent named `server` and the machine the persona runs on. */
// The server agent has a tool of its own, `errand.server`.
const MACHINE_SERVER: ReadonlySet<string> = new Set(['errand_server']);

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
  // about "this server's channels", and the persona names a place by a word that exists on one platform only.
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
  // Catches: a file post that the posting checks miss, or an edit counted as a new line of the persona's.
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

test('route.set and route.remove offer every role the routing knows, in its order', () => {
  // Catches: the schema keeps a list of its own, so a role the routing reads, such as linter, cannot be named.
  for (const name of ['route.set', 'route.remove']) {
    const properties = BY_NAME.get(name)?.params.properties ?? {};
    assert.deepEqual(properties.role?.enum, [...ROUTE_ROLES], name);
  }
});

test('skills effects: one effect class per operation, by its actual effect, in one table', () => {
  // The effect class is read from each tool's definition, the one place it is declared.
  const effectOf = (name: string) => SKILL_DEFINITIONS.find((definition) => definition.name === name)?.effects;
  // The operations of the console alone have no row and no effect class.
  const tools = listOps().filter((op) => effectOf(op.name) !== undefined);
  for (const op of tools) {
    const effect = effectOf(op.name);
    assert.ok(effect !== undefined && EFFECT_CLASSES.includes(effect), `${op.name} has no effect class`);
  }
  assert.deepEqual(
    SKILL_DEFINITIONS.map((definition) => definition.name).sort(),
    tools.map((op) => op.name).sort(),
    'no row for an operation that does not exist'
  );
  const of = (effect: string) =>
    SKILL_DEFINITIONS.filter((definition) => definition.effects === effect)
      .map((definition) => definition.name)
      .sort();
  assert.deepEqual(of('destructive'), ['memory.restore', 'message.delete', 'rule.remove']);
  for (const name of [
    'config.set',
    'config.unset',
    'model.set',
    'route.set',
    'route.remove',
    'access.grant',
    'access.revoke',
    'bot.pause',
    'bot.resume',
  ])
    assert.equal(effectOf(name), 'administrative', name);
  // The three errand tools are paid.
  assert.deepEqual(of('paid'), ['draw.create', 'errand.code', 'errand.scout', 'errand.server', 'voice.say']);
  for (const op of tools) if (op.rights.kind === 'read') assert.equal(effectOf(op.name), 'read', op.name);
  // a skill carries its operation's class
  assert.equal(skillRegistry().get('memory.restore')?.effects, 'destructive');
});

test("skills schemas: the persona's own table gives each skill its arguments", () => {
  const props = (name: string) => Object.keys(skillRegistry().get(name)?.argsSchema.properties ?? {});
  assert.deepEqual(props('memory.profile.read').slice(0, 1), ['user']);
  // `memory.read` stands for a tool with arguments.
  assert.deepEqual(props('memory.read'), ['subject', 'section', 'limit']);
  const create = skillRegistry().get('message.create');
  assert.deepEqual(Object.keys(create?.argsSchema.properties ?? {}), [
    'place',
    'reply',
    'text',
    'file',
    'gif',
    'media',
    'item',
  ]);
  assert.deepEqual(create?.argsSchema.required, []);
  assert.equal(create?.dispatch?.body, 'text');
  assert.ok(Object.hasOwn(skillRegistry().get('draw.create')?.argsSchema.properties ?? {}, 'place'));
  assert.deepEqual(skillRegistry().get('draw.create')?.argsSchema.properties?.self, { type: 'boolean' });
  assert.deepEqual(skillRegistry().get('route.set')?.argsSchema.properties?.fallbacks, { type: 'boolean' });
  // The boolean argument is `draw.create`'s `self`.
  assert.equal(skillRegistry().get('draw.create')?.dispatch?.toOp({ text: 't', self: true }).args?.self, true);
  assert.equal(skillRegistry().get('draw.create')?.dispatch?.toOp({ text: 't', self: false }).args?.self, false);
});

test("skills memory.search: the window arguments of the persona's call reach the operation", () => {
  const search = skillRegistry().get('memory.search');
  for (const name of ['anchor', 'move', 'messages', 'minutes'])
    assert.ok(Object.hasOwn(search?.argsSchema.properties ?? {}, name), name);
  const call = search?.dispatch?.toOp({ anchor: '#3', move: 'up', messages: 5, minutes: 30 });
  assert.equal(call?.op, 'memory.search');
  assert.deepEqual(
    {
      anchor: call?.args?.anchor,
      move: call?.args?.move,
      messages: call?.args?.messages,
      minutes: call?.args?.minutes,
    },
    { anchor: '#3', move: 'up', messages: 5, minutes: 30 }
  );
});

test('a journal that wrote the old names is read under the new ones, and any other name comes back as it is', () => {
  // `task.status` and `task.cancel` stay out of this list: a stored row of either name may come from an older board tool.
  // The one errand tool of those names filed every errand with the scout, so its names read as `errand.scout`.
  assert.deepEqual(['task.run', 'task.read', 'task.resolve', 'task.list'].map(currentToolName), [
    'errand.scout',
    'errand.read',
    'errand.resolve',
    'errand.list',
  ]);
  assert.deepEqual(['errand.run', 'errand.add'].map(currentToolName), ['errand.scout', 'errand.scout']);
  assert.deepEqual(['intent.set', 'intent.update', 'intent.cancel', 'intent.list'].map(currentToolName), [
    'intention.set',
    'intention.update',
    'intention.cancel',
    'intention.list',
  ]);
  // `skills.describe` maps to nothing, since `tools.describe` is an operation of the console and no tool of the persona's.
  assert.equal(currentToolName('skills.describe'), 'skills.describe');
  // The merged reads: a journal that wrote the old name is read under the tool that took it over.
  assert.equal(currentToolName('errand.status'), 'errand.list');
  assert.equal(currentToolName('memory.affinity.read'), 'memory.profile.read');
  assert.equal(currentToolName('message.create'), 'message.create');
  assert.equal(currentToolName(null), null);
});

const OWNER = '42';

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy([OWNER]);

// The read record of two versions of one claim, and the arguments of the memory.search tool. Real temporary
// databases; no model runs here.

const memorySearch = () => {
  const found = SKILL_DEFINITIONS.find((one) => one.name === 'memory.search');
  assert.ok(found);
  return found;
};

test('the memory.search tool takes an entity, a predicate, a moment and historical mode', () => {
  // Bug: the persona cannot ask for an exact entity or for what the persona knew then, so the persona reads a hub by its name.
  const args = memorySearch().toArgs({
    question: 'lumen',
    entity: 'ent:1',
    predicate: 'project.works_on',
    as_of: '2026-01-01',
    historical: true,
  });
  assert.deepEqual(
    [args?.question, args?.entity, args?.predicate, args?.asOf, args?.historical],
    ['lumen', 'ent:1', 'project.works_on', '2026-01-01', true]
  );
});

test('the memory.search tool has no argument for authority or destination', () => {
  // Bug: a model argument reaches the read's context or the place an answer goes to.
  const definition = memorySearch();
  const names = Object.keys(definition.params.properties ?? {});
  for (const word of ['context', 'audience', 'internal', 'destination', 'target', 'scope', 'bounds']) {
    assert.ok(!names.includes(word), word);
  }
  assert.equal(definition.params.additionalProperties, false);
  const args = definition.toArgs({ question: 'lumen', context: 'internal', destination: 'place:room' });
  assert.equal(args?.context, undefined);
  assert.equal(args?.destination, undefined);
});
