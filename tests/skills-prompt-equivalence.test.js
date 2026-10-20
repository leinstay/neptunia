// The skills table (src/skills/definitions.js) against the command tree it replaced: the registry
// built from the table and an oracle registry built from what the owner's commands derive
// (src/skills/derive.js, adapted by tests/oracles/derived-skills.js) must render the very same
// bytes everywhere her prompts read them -- keys, grants, the skills index, her tool rows, the
// catalogue, the descriptions and the inventory text, and one addressed request -- with the shipped
// skill texts and labels, with safe mode on and with the core tools off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMMAND_TABLE } from '../src/ops/catalog.js';
import { resolveCommand } from '../src/ops/index.js';
import { listOps } from '../src/ops/registry.js';
import { deepMerge } from '../src/config.js';
import { loadSkills, skillRegistry } from '../src/skills/registry.js';
import { listSkills } from '../src/skills/gateway.js';
import { coreToolRows, describeRows, grantedSkillNames, skillsIndex } from '../src/skills/discovery.js';
import { buildRequest, skillsInventoryText } from '../src/behavior/prompt.js';
import { createCalibrator } from '../src/llm/tokens.js';
import { derivedDefinitions, withFeatures } from './oracles/derived-skills.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROMPTS_DIR = path.join(ROOT, 'prompts');
const BOM = String.fromCharCode(0xfeff);

const SELF = '799999999999999999';
const OWNER = '42';
const MEMBER = '77';
const NOW = Date.UTC(2026, 9, 20, 10, 0, 0);

/** The 53 operations granted to her live (the plan, section 1.1). */
const GRANTED_53 = [
  'status.show', 'draw.create', 'pings.get', 'pings.set', 'media.status', 'media.rescan', 'media.recache', 'model.show', 'route.list',
  'rule.list', 'access.list', 'alias.add', 'alias.remove', 'learning.add', 'learning.remove', 'lore.add', 'lore.list', 'lore.show',
  'lore.remove', 'memory.profile.read', 'memory.channel.read', 'memory.server.read', 'memory.recent.read', 'memory.refresh.user',
  'memory.refresh.channel', 'memory.refresh.server', 'memory.affinity.read', 'memory.journal.read', 'memory.archive.read',
  'memory.snapshot', 'memory.private.read', 'message.create', 'message.edit', 'message.delete', 'message.react.add',
  'message.react.remove', 'task.run', 'task.status', 'task.read', 'task.resolve', 'task.cancel', 'task.list', 'web.search',
  'memory.search', 'skills.describe', 'conversation.read', 'media.find', 'web.read', 'intent.set', 'intent.update', 'intent.cancel',
  'intent.list', 'media.look',
];

const TEXTS = JSON.parse(fs.readFileSync(path.join(PROMPTS_DIR, 'skills.json'), 'utf8'));
const PROMPTS = {
  ...Object.fromEntries(fs.readdirSync(PROMPTS_DIR).filter((file) => file.endsWith('.md')).map((file) => {
    const text = fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf8');
    return [path.basename(file, '.md'), (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n/g, '\n').trim()];
  })),
  labels: JSON.parse(fs.readFileSync(path.join(PROMPTS_DIR, 'labels.json'), 'utf8')),
};
const SHIPPED_CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

/** The live-like config: the shipped one, the features this test needs set here, her 53 grants. */
function configOf({ coreTools = true, safeMode = false } = {}) {
  const access = Object.fromEntries(GRANTED_53.map((name) => [name, { everyone: false, roles: [], users: [SELF] }]));
  return deepMerge(structuredClone(SHIPPED_CONFIG), {
    features: { skills: true, coreTools, intentions: true, innerLife: true },
    skills: { safeMode },
    bot: { owners: [OWNER], access },
  });
}

/** The registry the owner's command tree derives, adapted to the shape the registry loads. */
function oracleRegistry() {
  return loadSkills(withFeatures(derivedDefinitions({ ops: listOps(), table: COMMAND_TABLE, resolve: resolveCommand })));
}

const FAMILIES = ['status', 'draw', 'pings', 'media', 'model', 'route', 'rule', 'access', 'alias', 'learning', 'lore', 'memory', 'message', 'task', 'web', 'skills', 'conversation', 'intent', 'inner', 'places', 'config', 'bot'];

/** A row without the registry fields that only renamed or are new (`dispatch`, `opBacked`, `api`, `feature`, `result`): every other field is compared. */
function plain(row) {
  const { dispatch, command, opBacked, derived, api, feature, result, ...rest } = row;
  return rest;
}

/** Everything her prompts read off `registry`, for one config. */
function bundleOf(registry, config) {
  const audience = { conversationId: 'c-here' };
  const catalogue = (requester) => listSkills({ config, selfId: SELF, texts: TEXTS, requester, audience, registry });
  const asOwner = catalogue({ id: OWNER });
  const asMember = catalogue({ id: MEMBER });
  const granted = grantedSkillNames({ config, selfId: SELF, registry });
  const tools = coreToolRows({ config, selfId: SELF, registry, texts: TEXTS }).map(plain);
  const names = [...registry.keys()];
  const describe = [...names, ...FAMILIES, 'Memory', ' lore ', 'nonsense', 'memry.profile', 'x']
    .map((name) => describeRows({ config, selfId: SELF, registry, texts: TEXTS, name }))
    .map((answer) => ({ ...answer, rows: answer.rows.map(plain) }));
  const labels = PROMPTS.labels;
  return {
    keys: names,
    skills: names.map((name) => {
      const { dispatch, api, result, ...rest } = registry.get(name);
      return { ...rest, body: dispatch.body, options: dispatch.options };
    }),
    granted,
    index: skillsIndex(registry, TEXTS),
    indexBare: skillsIndex(registry, {}),
    tools,
    asOwner,
    asMember,
    describe,
    inventory: [skillsInventoryText(asOwner, labels), skillsInventoryText(asMember, labels), skillsInventoryText(tools, labels)],
    describeTexts: describe.map((answer) => skillsInventoryText(answer.rows, labels)),
    messages: buildRequest({
      config,
      prompts: PROMPTS,
      calibrator: createCalibrator(),
      mode: 'reply',
      forced: false,
      now: NOW,
      selfName: 'Nept',
      history: [{ id: '1', ts: NOW - 60_000, authorId: MEMBER, authorName: 'Ana', self: false, content: 'what can you do?', attachments: [], stickers: [], replyToId: null }],
      neighbors: [],
      trigger: { id: '1', ts: NOW - 60_000, authorId: MEMBER, authorName: 'Ana', self: false, content: 'what can you do?', attachments: [], stickers: [], replyToId: null },
      triggerKind: 'mention',
      guildMemory: {},
      interlocutor: null,
      otherProfiles: [],
      currentChannelId: 'c-here',
      skillsInventory: asMember,
      skillsGranted: granted,
      skillsTools: tools,
    }).messages,
  };
}

const SCENES = [
  ['live features, her 53 grants', {}, 53],
  ['safe mode on', { safeMode: true }, 0],
  ['features.coreTools off', { coreTools: false }, 51],
];

for (const [label, options, grantedCount] of SCENES) {
  test(`skills table: the registry renders the same bytes as the derived one (${label})`, () => {
    const config = configOf(options);
    const actual = bundleOf(skillRegistry(), config);
    const oracle = bundleOf(oracleRegistry(), config);
    assert.equal(actual.granted.length, grantedCount, 'the scene grants what it should');
    for (const key of Object.keys(oracle)) assert.equal(JSON.stringify(actual[key]), JSON.stringify(oracle[key]), key);
  });
}

test('skills table: the scenes are not empty -- the request carries the granted names, the tool rows and the catalogue', () => {
  const messages = bundleOf(skillRegistry(), configOf()).messages;
  const text = JSON.stringify(messages);
  for (const part of ['<skills_granted>', '<skills_tools>', '<skills>', 'media.look']) assert.ok(text.includes(part), part);
  assert.equal(skillRegistry().size, 73);
});
