// Tests of the derivation oracle (tests/oracles/skills-derive.js): a fake command tree turned into
// skills the way the owner's commands once were, kept until COMMAND_TABLE dies. The shipped registry
// no longer derives anything (src/skills/definitions.js is its source); these pin the oracle itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadSkills } from '../src/skills/registry.js';
import { commandSources, deriveSkillDefinitions } from './oracles/skills-derive.js';
import { adaptDerived } from './oracles/derived-skills.js';

/** A fake command tree: a plain leaf, a group whose `action` picks the operation, a leaf whose optional `score` does, a persona-only option. */
const FAKE_TABLE = [
  {
    name: 'note',
    description: 'd',
    options: [
      { type: 3, name: 'text', description: 'd', required: true, max_length: 50 },
      { type: 4, name: 'number', description: 'd', required: false, min_value: 1, max_value: 9 },
      { type: 5, name: 'loud', description: 'd', required: false },
    ],
    args: (o) => ({ text: o.getString('text', true), n: o.getInteger('number') ?? undefined, loud: o.getBoolean('loud') ?? false }),
  },
  {
    name: 'box',
    description: 'd',
    subcommands: [
      {
        name: 'act',
        description: 'd',
        options: [
          { type: 3, name: 'action', description: 'd', required: true, choices: [{ name: 'open', value: 'open' }, { name: 'shut', value: 'shut' }] },
          { type: 6, name: 'user', description: 'd', required: true },
        ],
        args: (o) => ({ action: o.getString('action', true), userId: o.getUser('user', true).id }),
      },
      {
        name: 'mood',
        description: 'd',
        options: [{ type: 7, name: 'channel', description: 'd', required: true }, { type: 4, name: 'score', description: 'd', required: false, min_value: -5, max_value: 5 }],
        personaOptions: [{ type: 3, name: 'why', description: 'd', required: false, max_length: 20 }],
        args: (o) => ({ channelId: o.getChannel('channel', true).id, score: o.getInteger('score') ?? undefined, why: o.getString('why') ?? undefined }),
      },
    ],
  },
];
const FAKE_MAP = {
  note: 'note.add',
  'box.act': (args) => (args.action === 'open' ? { op: 'box.open', args } : args.action === 'shut' ? { op: 'box.shut', args } : { invalid: 'action' }),
  'box.mood': (args) => ({ op: args.score === undefined ? 'box.mood.read' : 'box.mood.set', args }),
};
const fakeResolve = (key, args) => {
  const target = FAKE_MAP[key];
  if (!target) return null;
  return typeof target === 'function' ? target(args) : { op: target, args };
};
const FAKE_OPS = [
  { name: 'note.add', rights: { kind: 'write' } },
  { name: 'box.open', rights: { kind: 'write', ownerOnly: true } },
  { name: 'box.shut', rights: { kind: 'write', ownerOnly: true } },
  { name: 'box.mood.read', rights: { kind: 'read' } },
  { name: 'box.mood.set', rights: { kind: 'write' } },
];
const fakeGetOp = (name) => FAKE_OPS.find((op) => op.name === name) ?? null;

/** The definitions the fake tree derives. */
function fakeDefinitions() {
  return deriveSkillDefinitions({ ops: FAKE_OPS, sources: commandSources({ table: FAKE_TABLE, resolve: fakeResolve }), resolve: fakeResolve });
}

/** The registry over the fake tree and ops. */
function fakeRegistry() {
  return loadSkills(fakeDefinitions().map(adaptDerived), { getOp: fakeGetOp });
}

test('skills derived: one per operation of a fake ops list, from the command that runs it', () => {
  const registry = fakeRegistry();
  assert.deepEqual([...registry.keys()], FAKE_OPS.map((op) => op.name));
  assert.deepEqual([...registry.values()].map((skill) => [skill.kind, skill.ownerOnly, skill.family, skill.effects]), [
    ['write', false, 'note', 'write'],
    ['write', true, 'box', 'write'],
    ['write', true, 'box', 'write'],
    ['read', false, 'box', 'read'],
    ['write', false, 'box', 'write'],
  ]);
  // an operation no command runs cannot be a skill: a programming error
  assert.throws(() => deriveSkillDefinitions({ ops: [{ name: 'lost.op', rights: { kind: 'read' } }], sources: new Map(), resolve: fakeResolve }), /no command/);
});

test('skills derived: the argument schema is the command\'s options -- names, types, bounds, required, choices', () => {
  const registry = fakeRegistry();
  assert.deepEqual(registry.get('note.add').argsSchema, {
    type: 'object',
    properties: {
      text: { type: 'string', minLength: 1, maxLength: 50 },
      number: { type: 'integer', minimum: 1, maximum: 9 },
      loud: { type: 'boolean' },
    },
    required: ['text'],
    additionalProperties: false,
  });
  assert.equal(registry.get('note.add').dispatch.body, 'text', 'a `text` option takes the call\'s body');
  // the choice that picks the operation is fixed, not asked
  assert.deepEqual(registry.get('box.open').argsSchema, { type: 'object', properties: { user: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['user'], additionalProperties: false });
  assert.deepEqual(fakeDefinitions().find((definition) => definition.name === 'box.open').command.fixed, { action: 'open' });
  // an optional option whose presence picks the operation: left out for one, required for the other
  assert.deepEqual(Object.keys(registry.get('box.mood.read').argsSchema.properties), ['channel', 'why']);
  assert.deepEqual(registry.get('box.mood.set').argsSchema.required, ['channel', 'score']);
  assert.deepEqual(registry.get('box.mood.set').argsSchema.properties.score, { type: 'integer', minimum: -5, maximum: 5 });
  // a persona-only option is an argument of hers, mapped by the same mapper
  assert.deepEqual(registry.get('box.mood.read').argsSchema.properties.why, { type: 'string', minLength: 1, maxLength: 20 });
  assert.deepEqual(registry.get('box.mood.set').dispatch.toOp({ channel: 'c1', score: 2, why: 'α' }), { args: { channelId: 'c1', score: 2, why: 'α' }, op: 'box.mood.set' });
  assert.deepEqual(registry.get('box.shut').dispatch.toOp({ user: '7' }), { args: { action: 'shut', userId: '7' }, op: 'box.shut' });
});
