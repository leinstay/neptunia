// The `tools.describe` operation (src/tools/impl/skills.ts): one skill in full or a family as lines,
// from the registry and the skills layer read now, rendered as a core row; a stranger gets the
// closest names; the skill is a read the persona can be granted.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runOp } from '../src/tools/impl/index.ts';
import { createOpsEnv } from '../src/tools/impl/env.ts';
import { createDiscordInterface } from '../interfaces/discord/index.js';
import { skillRegistry } from '../src/tools/registry.ts';
import { tempDir } from './fixtures/tmp.js';

const LABELS = {
  tools: {
    line: '{name}: {title} -- {whenToUse} ({access}){args}',
    args: { list: ' Arguments: {list}.', required: '{arg}*' },
    access: { allowed: 'allowed', 'not-allowed': 'off' },
    tools: { describe: { closest: 'closest: {names}' } },
  },
};

function envOf(grants = {}) {
  const hot = {
    config: { bot: { owners: ['42'], access: grants }, features: { tools: true } },
    prompts: {
      labels: LABELS,
      tools: {
        'memory.search': { title: 'Search', whenToUse: 'find old talk', whenNotToUse: '' },
        'memory.journal.read': { title: 'Journal', whenToUse: 'read it', whenNotToUse: '' },
      },
    },
    promptSources: {},
    rootDir: tempDir('nep-skills-describe-'),
  };
  const store = { state: { data: {}, markDirty() {} }, flush() {} };
  return createOpsEnv({
    discord: createDiscordInterface().capabilities,
    hot,
    store,
    selfId: () => 'self-id',
    getGuildId: () => 'g1',
  });
}

const call = (env, name) =>
  runOp('tools.describe', { name }, { env, guildId: 'g1', userId: '42', roleIds: [], actor: 'persona' });
const grant = { everyone: false, roles: [], users: ['self-id'] };

test('tools.describe is a registered read skill with a name argument that the body fills', () => {
  const skill = skillRegistry().get('tools.describe');
  assert.ok(skill);
  assert.equal(skill.kind, 'read');
  assert.deepEqual(Object.keys(skill.argsSchema.properties), ['name']);
  assert.equal(skill.dispatch.body, 'name');
});

test('tools.describe: an exact name comes back in full with its arguments and whether it is on for her', async () => {
  const env = envOf({ 'memory.search': grant });
  const result = await call(env, 'memory.search');
  assert.equal(result.status, 'ok');
  assert.equal(
    result.data.text,
    'memory.search: Search -- find old talk (allowed) Arguments: question, people, channel, when, terms, anchor, move, messages, minutes.'
  );
  const off = await call(env, 'memory.journal.read');
  assert.match(off.data.text, /\(off\)/);
});

test('tools.describe: a family is one line per skill with no arguments', async () => {
  const result = await call(envOf({ 'memory.search': grant }), 'memory');
  const lines = result.data.text.split('\n').filter(Boolean);
  assert.ok(lines.length > 3);
  assert.ok(lines.every((line) => !line.includes('Arguments')));
  assert.ok(lines.some((line) => line.startsWith('memory.search:')));
});

test('tools.describe: an unknown name is invalid unknown-skill with the closest names; no name is invalid', async () => {
  const env = envOf();
  const result = await call(env, 'memory.serch');
  assert.equal(result.status, 'invalid');
  assert.equal(result.code, 'unknown-skill');
  assert.match(result.data.text, /^closest: .*memory\.search/);
  const none = await call(env, '   ');
  assert.equal(none.status, 'invalid');
});
