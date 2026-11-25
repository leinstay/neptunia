// Tests for src/tools/registry.ts: the persona's skills, one per entry of the tools table over the operation that runs
// it, checked at load, with their texts from config/tools.json. Nothing here executes a skill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../../src/tools/operations/index.ts';
import { listOps } from '../../../src/tools/operations/registry.ts';
import { SKILL_DEFINITIONS } from '../../../src/tools/definitions.ts';
import {
  loadSkills,
  skillRegistry,
  skillNames,
  describeSkill,
  skillArgTexts,
  missingDefinitions,
} from '../../../src/tools/registry.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { asRecord } from '../../fixtures/records.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';

const OWNER = '42';

/** One structural definition, the fields a test does not care about filled in. */
// A skill as the loader is asked to take it: the tests below also hand it invalid ones.
function def(over?: Record<string, unknown>) {
  return {
    name: 'x.read',
    family: 'x',
    op: null,
    argsSchema: { type: 'object', properties: {}, additionalProperties: false },
    effects: 'read',
    sharedState: false,
    costClass: 'free',
    targets: null,
    interfaceCapability: null,
    ...over,
  } as unknown as NonNullable<Parameters<typeof loadSkills>[0]>[number];
}

// ---- the catalogue: one skill per operation -------------------------------------------

// No member rights layer exists, so a skill holds no `ownerOnly` of its own.
test('skills registry: one skill per table entry, of the name and kind of its operation; no other skill exists', () => {
  const registry = skillRegistry();
  // The operations of the owner's console alone have no entry in the persona's table, so no skill.
  const tools = SKILL_DEFINITIONS.map((definition) => definition.name);
  assert.deepEqual([...registry.keys()], tools);
  assert.deepEqual(skillNames(), tools);
  for (const op of listOps().filter((one) => tools.includes(one.name))) {
    const skill = registry.get(op.name);
    assert.equal(skill?.opBacked, true, op.name);
    assert.equal(skill?.op, op.name, op.name);
    assert.equal(skill?.kind, op.rights.kind, op.name);
    assert.equal(Object.hasOwn(skill ?? {}, 'ownerOnly'), false, op.name);
    assert.equal(skill?.family, op.name.split('.')[0], op.name);
  }
  // No interface-only skill exists, and those abilities are operations behind commands.
  for (const gone of ['draw', 'message.send', 'skills.list', 'access.request', 'talk.interject', 'skill.allow'])
    assert.equal(registry.has(gone), false, gone);
  for (const name of [
    'message.create',
    'message.edit',
    'message.delete',
    'message.react.add',
    'message.react.remove',
    'draw.create',
    'memory.profile.read',
  ])
    assert.ok(registry.has(name), name);
  // A console operation runs for the owner and is no skill of the persona's.
  for (const name of ['status.show', 'tools.describe', 'lore.add']) assert.equal(registry.has(name), false, name);
  assert.equal(registry.get('draw.create')?.costClass, 'paid');
});

// An operation declares its kind alone, and the skill inherits it.
test('skills registry: a definition is checked at load; a skill takes the kind of its operation', () => {
  assert.throws(() => loadSkills([def({ op: 'no.such.op' })]), /unknown operation/);
  assert.throws(() => loadSkills([def(), def()]), /twice/);
  assert.throws(() => loadSkills([def({ effects: 'launch' })]), /effects/);
  assert.throws(() => loadSkills([def({ costClass: 'cheap' })]), /costClass/);
  assert.throws(() => loadSkills([def({ targets: 'everyone' })]), /targets/);
  assert.throws(() => loadSkills([def({ argsSchema: null })]), /argsSchema/);
  assert.throws(() => loadSkills([def({ dispatch: { op: 'x' } })]), /toOp/);
  const ops: Record<string, Untyped> = { 'fake.op': { name: 'fake.op', rights: { kind: 'write' } } };
  assert.deepEqual(
    [...loadSkills([def({ op: 'fake.op' })], { getOp: (name) => ops[name] ?? null }).values()].map(
      (skill) => skill.kind
    ),
    ['write']
  );
});

test('skills registry: the texts come from config/tools.json by operation name; a skill without them has empty texts', () => {
  const skill = skillRegistry().get('message.edit');
  const texts = { 'message.edit': { title: 'Διόρθωση', whenToUse: 'όταν', whenNotToUse: 'ποτέ' } };
  assert.deepEqual(
    ['title', 'whenToUse', 'whenNotToUse'].map(
      (key) =>
        describeSkill(skill as unknown as Parameters<typeof describeSkill>[0], texts)[
          key as keyof ReturnType<typeof describeSkill>
        ]
    ),
    ['Διόρθωση', 'όταν', 'ποτέ']
  );
  assert.deepEqual(
    ['title', 'whenToUse', 'whenNotToUse'].map(
      (key) =>
        describeSkill(skillRegistry().get('memory.restore') as unknown as Parameters<typeof describeSkill>[0], {})[
          key as keyof ReturnType<typeof describeSkill>
        ]
    ),
    ['', '', '']
  );
  assert.equal(describeSkill(skill as unknown as Parameters<typeof describeSkill>[0], undefined).title, '');
});

test('skills registry: every `args` key of config/tools.json names a property of its skill (skillArgTexts keeps them all)', () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'config', 'tools.json');
  const texts: Record<string, unknown> = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [name, entry] of Object.entries(texts)) {
    if (asRecord(entry)?.args === undefined) continue;
    const skill = skillRegistry().get(name);
    assert.ok(skill, `${name}: no such skill`);
    assert.deepEqual(
      Object.keys(skillArgTexts(skill, texts)).sort(),
      Object.keys(asRecord(entry).args).sort(),
      `${name}: an args key that is no property, or an empty text`
    );
  }
});

test('skills registry: missingDefinitions names the table entries with no registered skill, none when whole', () => {
  assert.deepEqual(missingDefinitions(skillRegistry()), []);
  const partial = new Map([...skillRegistry()].filter(([name]) => name !== 'lore.list' && name !== 'errand.scout'));
  assert.deepEqual(missingDefinitions(partial).sort(), ['errand.scout', 'lore.list']);
});

test('skills registry: config/tools.json has the title and when-to-use of every tool (when-not-to-use optional), and no key that is not one', () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'config', 'tools.json');
  const texts: Record<string, Untyped> = JSON.parse(fs.readFileSync(file, 'utf8'));
  // The texts are the model's, so an operation of the console alone has none.
  const ops = SKILL_DEFINITIONS.map((definition) => definition.name);
  for (const name of ops) {
    for (const key of ['title', 'whenToUse']) {
      assert.equal(typeof texts[name]?.[key], 'string', `${name}.${key}`);
      const entry = asRecord(texts[name]);
      assert.ok(entry[key].trim(), `${name}.${key} is empty`);
    }
    // `whenNotToUse` is optional: left out where it would say nothing the title does not.
    if (texts[name] && Object.hasOwn(texts[name], 'whenNotToUse'))
      assert.ok(String(texts[name].whenNotToUse).trim(), `${name}.whenNotToUse is empty`);
  }
  assert.deepEqual(
    Object.keys(texts).filter((name) => !ops.includes(name)),
    [],
    'a key that is no tool'
  );
  assert.equal(Object.hasOwn(texts, 'memory.affinity.set'), false);
});

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy([OWNER]);
