// Tests for src/llm/roles.js (the model roles: `models.base` for the core's own requests,
// `models.agents` for the OpenCode workers and the drawing model; one resolver, no cross-role
// fallback) and src/config.js#adaptLegacyModelKeys (a config.local.json written under the old
// model keys),
// plus the rename check: every purpose resolves, under config.json and under a deployment that
// still uses the old keys, to what the code before the rename produced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_ROLES, BASE_ROLES, OPENCODE_ROLES, ROLES, ROLE_DEFAULTS, PURPOSE_ROLES, isRole, roleConfigKeys, roleModel, roleSection } from '../src/llm/roles.js';
import { ConfigShapeError, adaptLegacyModelKeys, assertModelsShape, loadConfig, migrateModelsKeys } from '../src/config.js';
import { MEMORY_VOICE_REQUEST, REPLY_REQUEST, cacheTtlFor, hedgeSettings, resolveProvider } from '../src/llm/openrouter.js';
import { EMBED_ROLE } from '../src/llm/embed.js';
import { IMAGE_ROLE } from '../src/llm/images.js';
import { warmupRoute } from '../src/memory/warmup.js';
import { MODEL_SET_ROLES } from '../src/ops/catalog.js';
import { tempDir } from './fixtures/tmp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A scratch root with the tracked config.json (or `base` in its place) and, when given, a config.local.json. */
function loadWith(local, base) {
  const dir = tempDir('nep-roles-');
  try {
    if (base === undefined) fs.copyFileSync(path.join(ROOT, 'config.json'), path.join(dir, 'config.json'));
    else fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(base));
    if (local !== undefined) fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify(local));
    return loadConfig(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- roleModel ---------------------------------------------------------------

test('roleModel: models.base.byPurpose for the purpose, else the role\'s own key, else the role default', () => {
  const config = { models: { base: { analyzer: 'x/analyzer', byPurpose: { split: 'x/split' } } } };
  assert.equal(roleModel(config, 'analyzer', 'split'), 'x/split');
  assert.equal(roleModel(config, 'analyzer', 'address'), 'x/analyzer');
  assert.equal(roleModel(config, 'analyzer'), 'x/analyzer');
  assert.equal(roleModel(config, 'reasoner', 'lookup'), ROLE_DEFAULTS.reasoner);
});

test('roleModel: a byPurpose entry applies whatever the role, an empty or non-string one does not', () => {
  const config = { models: { base: { voice: 'x/voice', byPurpose: { reply: 'x/reply', describe: '', relook: 7 } } } };
  assert.equal(roleModel(config, 'voice', 'reply'), 'x/reply');
  assert.equal(roleModel(config, 'vision', 'describe'), ROLE_DEFAULTS.vision);
  assert.equal(roleModel(config, 'vision', 'relook'), ROLE_DEFAULTS.vision);
  assert.equal(roleModel({ models: { base: { byPurpose: Object.create({ split: 'x/inherited' }) } } }, 'analyzer', 'split'), ROLE_DEFAULTS.analyzer);
});

test('roleModel: a byPurpose that is not a plain object, or an entry that is not a non-empty string, leaves the role model', () => {
  const base = { reasoner: 'x/reason' };
  for (const byPurpose of [{ lookup: '' }, { lookup: null }, { lookup: 7 }, ['x/array'], 'x/string', null]) {
    assert.equal(roleModel({ models: { base: { ...base, byPurpose } } }, 'reasoner', 'lookup'), 'x/reason', JSON.stringify(byPurpose));
  }
  assert.equal(roleModel({ models: { base: { byPurpose: { toString: 'x/proto' } } } }, 'analyzer', 'constructor'), ROLE_DEFAULTS.analyzer, 'own keys only');
});

test('roleModel: an unset role takes its own default, never another role\'s model', () => {
  const config = { models: { base: { analyzer: 'x/analyzer', vision: 'x/vision', voice: 'x/voice' } } };
  for (const role of ['reasoner', 'extractor', 'video', 'embedding', 'drawing']) {
    assert.equal(roleModel(config, role), ROLE_DEFAULTS[role], role);
  }
  assert.equal(roleModel({ models: { base: { reasoner: null, extractor: '' } } }, 'reasoner'), ROLE_DEFAULTS.reasoner);
  assert.equal(roleModel({ models: { base: { reasoner: null, extractor: '' } } }, 'extractor'), ROLE_DEFAULTS.extractor);
  assert.equal(roleModel(undefined, 'voice'), ROLE_DEFAULTS.voice);
});

test('roleModel: the old model keys are never read at the moment of use', () => {
  const old = { llm: { model: 'x/old' }, classifier: { text: 'x/old', reason: 'x/old', media: 'x/old' }, memory: { model: 'x/old' }, image: { model: 'x/old' } };
  for (const role of ROLES) assert.equal(roleModel(old, role), ROLE_DEFAULTS[role], role);
});

test('roleModel: undefined for a name that is not a role, unless its purpose is pinned', () => {
  assert.equal(roleModel({}, 'classifier.text'), undefined);
  assert.equal(roleModel({}, 'constructor'), undefined);
  assert.equal(roleModel({ models: { base: { byPurpose: { odd: 'x/odd' } } } }, 'nope', 'odd'), 'x/odd');
  assert.equal(isRole('voice'), true);
  assert.equal(isRole('talk'), false);
  assert.equal(isRole('byPurpose'), false);
  for (const old of ['agent.web', 'agent.server', 'agent.dev', 'agent.advice', 'advice']) assert.equal(isRole(old), false, old);
});

test('roleModel: the flat roles map is never read; each role reads its own section only', () => {
  const flat = { roles: { voice: 'x/voice', 'agent.web': 'openrouter/x/web', web: 'openrouter/x/web2', drawing: 'x/draw', byPurpose: { reply: 'x/reply' } } };
  for (const role of ROLES) assert.equal(roleModel(flat, role), ROLE_DEFAULTS[role], role);
  assert.equal(roleModel(flat, 'voice', 'reply'), ROLE_DEFAULTS.voice, 'no byPurpose from the flat map');
  const crossed = { models: { base: { web: 'openrouter/x/web', drawing: 'x/draw' }, agents: { voice: 'x/voice', byPurpose: { reply: 'x/reply' } } } };
  assert.equal(roleModel(crossed, 'web'), ROLE_DEFAULTS.web, 'an agent role is read from models.agents only');
  assert.equal(roleModel(crossed, 'drawing'), ROLE_DEFAULTS.drawing);
  assert.equal(roleModel(crossed, 'voice', 'reply'), ROLE_DEFAULTS.voice, 'a base role from models.base only, byPurpose too');
  for (const models of [null, 'x', ['a'], { base: 'x', agents: [] }]) assert.equal(roleModel({ models }, 'voice'), ROLE_DEFAULTS.voice, JSON.stringify(models));
});

test('roleSection / roleConfigKeys: each role\'s section and config keys', () => {
  for (const role of BASE_ROLES) {
    assert.equal(roleSection(role), 'base', role);
    assert.deepEqual(roleConfigKeys(role), ['models', 'base', role]);
  }
  for (const role of AGENT_ROLES) {
    assert.equal(roleSection(role), 'agents', role);
    assert.deepEqual(roleConfigKeys(role), ['models', 'agents', role]);
  }
  for (const name of ['byPurpose', 'agent.web', 'talk', undefined]) {
    assert.equal(roleSection(name), undefined, String(name));
    assert.equal(roleConfigKeys(name), undefined, String(name));
  }
});

test('roles: the built-in defaults equal config.json\'s models.base and models.agents, and every role has one', () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  assert.equal(Object.hasOwn(shipped, 'roles'), false, 'no flat roles map');
  assert.deepEqual(Object.keys(shipped.models), ['base', 'agents']);
  const { byPurpose, ...base } = shipped.models.base;
  assert.deepEqual(Object.keys(base), [...BASE_ROLES]);
  assert.deepEqual(Object.keys(shipped.models.agents), [...AGENT_ROLES]);
  assert.deepEqual({ ...base, ...shipped.models.agents }, { ...ROLE_DEFAULTS });
  assert.deepEqual(byPurpose, {});
  assert.deepEqual(Object.keys(ROLE_DEFAULTS), [...ROLES]);
  assert.deepEqual([...ROLES], [...BASE_ROLES, ...AGENT_ROLES]);
  assert.deepEqual([...MODEL_SET_ROLES], [...ROLES], '/nep model set offers every role');
  for (const role of Object.values(PURPOSE_ROLES)) assert.ok(isRole(role), role);
});

test('roles: the agents\' roles follow the base roles, the OpenCode ones with OpenCode model ids, resolved like any role, no purpose on them', () => {
  assert.deepEqual([...BASE_ROLES], ['voice', 'analyzer', 'reasoner', 'extractor', 'vision', 'video', 'embedding']);
  assert.deepEqual([...AGENT_ROLES], ['web', 'server', 'thinker', 'dev', 'writer', 'drawing']);
  assert.deepEqual([...OPENCODE_ROLES], ['web', 'server', 'thinker', 'dev', 'writer']);
  assert.equal(Object.hasOwn(ROLE_DEFAULTS, 'agent.advice') || Object.hasOwn(ROLE_DEFAULTS, 'advice'), false, 'no advice role');
  assert.equal(ROLE_DEFAULTS.web, 'openrouter/openai/gpt-6.1-sol');
  assert.equal(ROLE_DEFAULTS.server, 'openrouter/openai/gpt-6.1-sol');
  assert.equal(ROLE_DEFAULTS.thinker, 'openrouter/anthropic/claude-opus-5.5');
  assert.equal(ROLE_DEFAULTS.dev, 'openrouter/anthropic/claude-sonnet-5.5');
  assert.equal(ROLE_DEFAULTS.writer, 'openrouter/anthropic/claude-opus-4.6');
  assert.equal(ROLE_DEFAULTS.drawing, 'openai/gpt-image-2.5-flare', 'drawing: still a bare OpenRouter image model id');
  for (const role of OPENCODE_ROLES) assert.match(ROLE_DEFAULTS[role], /^openrouter\/[\w.-]+\/[\w.:-]+$/, `${role}: an OpenCode id, provider first`);
  for (const role of AGENT_ROLES) {
    assert.equal(roleModel({}, role), ROLE_DEFAULTS[role], role);
    assert.equal(roleModel({ models: { agents: { [role]: 'openrouter/x/y' } } }, role), 'openrouter/x/y', role);
  }
  assert.equal(roleModel({ models: { agents: { web: 'openrouter/x/web' } } }, 'server'), ROLE_DEFAULTS.server, 'never another agent role\'s model');
  assert.equal(roleModel({ models: { agents: { web: 'openrouter/x/web' }, base: { byPurpose: { web: 'x/pinned' } } } }, 'server'), ROLE_DEFAULTS.server);
  assert.ok(!Object.values(PURPOSE_ROLES).some((role) => AGENT_ROLES.includes(role)), 'no request purpose goes out on an agent role');
});

test('roles: config.json carries none of the old model keys', () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  assert.equal(shipped.classifier, undefined);
  assert.equal(Object.hasOwn(shipped.llm, 'model'), false);
  assert.equal(Object.hasOwn(shipped.memory, 'model'), false);
  assert.equal(Object.hasOwn(shipped.image, 'model'), false);
  assert.deepEqual(shipped.llm.hedge.roles, ['analyzer', 'reasoner']);
  assert.deepEqual(shipped.llm.cache.roles, ['voice']);
});

// ---- adaptLegacyModelKeys ----------------------------------------------------

test('adaptLegacyModelKeys: each old model key moves to its models.base / models.agents key, listed by name only', () => {
  const { config, renamed } = adaptLegacyModelKeys({
    llm: { model: 'x/voice', temperature: 1 },
    classifier: { text: 'x/a', reason: 'x/r', media: 'x/v', video: 'x/vid', embed: 'x/e', byPurpose: { split: 'x/s' } },
    memory: { model: 'x/ex', batchMessages: 5 },
    image: { model: 'x/d', maxPerDay: 3 },
  });
  assert.deepEqual(config, {
    llm: { temperature: 1 },
    memory: { batchMessages: 5 },
    image: { maxPerDay: 3 },
    models: {
      base: { voice: 'x/voice', analyzer: 'x/a', reasoner: 'x/r', extractor: 'x/ex', vision: 'x/v', video: 'x/vid', embedding: 'x/e', byPurpose: { split: 'x/s' } },
      agents: { drawing: 'x/d' },
    },
  });
  assert.deepEqual(renamed, [
    { key: 'llm.model', use: 'models.base.voice' },
    { key: 'classifier.text', use: 'models.base.analyzer' },
    { key: 'classifier.reason', use: 'models.base.reasoner' },
    { key: 'memory.model', use: 'models.base.extractor' },
    { key: 'classifier.media', use: 'models.base.vision' },
    { key: 'classifier.video', use: 'models.base.video' },
    { key: 'classifier.embed', use: 'models.base.embedding' },
    { key: 'image.model', use: 'models.agents.drawing' },
    { key: 'classifier.byPurpose', use: 'models.base.byPurpose' },
  ]);
  assert.equal(JSON.stringify(renamed).includes('x/'), false, 'never a value');
});

test('adaptLegacyModelKeys: a new key set too wins, the old one is dropped', () => {
  const { config } = adaptLegacyModelKeys({ classifier: { text: 'x/old' }, image: { model: 'x/old-d' }, models: { base: { analyzer: 'x/new' }, agents: { drawing: 'x/new-d' } } });
  assert.deepEqual(config, { image: {}, models: { base: { analyzer: 'x/new' }, agents: { drawing: 'x/new-d' } } });
});

test('adaptLegacyModelKeys: a current config passes unchanged, never mutated', () => {
  const local = { models: { base: { analyzer: 'x/a' } }, llm: { cache: { roles: ['voice', 'analyzer'] }, providerByModel: { 'x/@analyzer': { only: ['p'] } } } };
  const before = structuredClone(local);
  const { config, renamed } = adaptLegacyModelKeys(local);
  assert.deepEqual(config, before);
  assert.deepEqual(renamed, []);
  assert.deepEqual(local, before);
  assert.deepEqual(adaptLegacyModelKeys(undefined), { config: undefined, renamed: [] });
});

test('adaptLegacyModelKeys: old role names in the hedge and cache lists and the route keys are renamed', () => {
  const { config, renamed } = adaptLegacyModelKeys({
    classifier: { text: 'x/a' },
    llm: {
      hedge: { roles: ['classifier.text', 'classifier.reason'] },
      cache: { roles: ['voice', 'classifier.text', 'analyzer'] },
      providerByModel: { 'g/': { only: ['a'] }, 'g/@classifier.video': { only: ['b'] }, 'i/@image': { only: ['c'] }, 'o/@analyzer': { only: ['d'] } },
    },
  });
  assert.deepEqual(config.llm.hedge.roles, ['analyzer', 'reasoner']);
  assert.deepEqual(config.llm.cache.roles, ['voice', 'analyzer', 'extractor']);
  assert.deepEqual(config.llm.providerByModel, { 'g/': { only: ['a'] }, 'g/@video': { only: ['b'] }, 'i/@drawing': { only: ['c'] }, 'o/@extractor': { only: ['d'] } });
  assert.deepEqual(renamed.slice(1), [
    { key: 'llm.hedge.roles: classifier.text', use: 'analyzer' },
    { key: 'llm.hedge.roles: classifier.reason', use: 'reasoner' },
    { key: 'llm.cache.roles: classifier.text', use: 'analyzer' },
    { key: 'llm.cache.roles: analyzer', use: 'extractor' },
    { key: 'llm.providerByModel: g/@classifier.video', use: 'g/@video' },
    { key: 'llm.providerByModel: i/@image', use: 'i/@drawing' },
    { key: 'llm.providerByModel: o/@analyzer', use: 'o/@extractor' },
  ]);
});

test('adaptLegacyModelKeys: an old analyzer entry is the extractor only while memory.model or a classifier key is present', () => {
  const lists = { cache: { roles: ['analyzer'] }, providerByModel: { 'o/@analyzer': { only: ['d'] } } };
  const plain = adaptLegacyModelKeys({ llm: structuredClone(lists) }).config.llm;
  assert.deepEqual(plain.cache.roles, ['analyzer']);
  assert.deepEqual(Object.keys(plain.providerByModel), ['o/@analyzer']);
  const withMemory = adaptLegacyModelKeys({ memory: { model: null }, llm: structuredClone(lists) }).config.llm;
  assert.deepEqual(withMemory.cache.roles, ['extractor']);
  assert.deepEqual(Object.keys(withMemory.providerByModel), ['o/@extractor']);
  const withClassifier = adaptLegacyModelKeys({ classifier: { byPurpose: {} }, llm: structuredClone(lists) }).config.llm;
  assert.deepEqual(withClassifier.cache.roles, ['extractor']);
});

test('adaptLegacyModelKeys: a renamed route whose new key exists is dropped, the new one wins', () => {
  const { config } = adaptLegacyModelKeys({ llm: { providerByModel: { 'g/@classifier.video': { only: ['old'] }, 'g/@video': { only: ['new'] } } } });
  assert.deepEqual(config.llm.providerByModel, { 'g/@video': { only: ['new'] } });
});

test('adaptLegacyModelKeys: the flat roles map and the old agent role keys are not adapted (assertModelsShape refuses them)', () => {
  const local = { roles: { agentWeb: 'openrouter/x/web', voice: 'x/v' }, llm: { keyByRole: { agentServer: 'OPENROUTER_OTHER_KEY', 'agent.dev': 'OPENROUTER_DEV_KEY' } } };
  const { config, renamed } = adaptLegacyModelKeys(local);
  assert.deepEqual(config, local);
  assert.deepEqual(renamed, []);
});

test('loadConfig: config.local.json is read through the adapter, config.json as it is', () => {
  const { config, renamed } = loadWith({ classifier: { text: 'x/a' }, memory: { model: 'x/e' } });
  assert.equal(config.models.base.analyzer, 'x/a');
  assert.equal(config.models.base.extractor, 'x/e');
  assert.equal(config.models.base.voice, ROLE_DEFAULTS.voice);
  assert.equal(config.classifier, undefined);
  assert.equal(Object.hasOwn(config.memory, 'model'), false);
  assert.deepEqual(renamed.map(({ key }) => key), ['classifier.text', 'memory.model']);
  assert.deepEqual(loadWith(undefined).renamed, []);
});

// ---- the flat roles map is refused at load -----------------------------------

test('loadConfig: a config.local.json that still holds roles is refused with the exact moves, never read', () => {
  const local = {
    roles: { voice: 'x/voice', byPurpose: { split: 'x/s' }, drawing: 'x/d', 'agent.web': 'openrouter/x/web', agentDev: 'openrouter/x/dev', 'agent.advice': 'x/advice' },
    llm: { keyByRole: { 'agent.web': 'OPENROUTER_AGENT_KEY', 'agent.advice': 'OPENROUTER_SIM_KEY' } },
  };
  assert.throws(() => loadWith(local), (err) => {
    assert.ok(err instanceof ConfigShapeError);
    assert.equal(err.name, 'ConfigShapeError');
    assert.match(err.message, /^config\.local\.json: /);
    for (const key of ['models.base', 'models.agents', 'voice, analyzer, reasoner, extractor, vision, video, embedding, byPurpose', 'web, server, thinker, dev, writer, drawing']) {
      assert.ok(err.message.includes(key), key);
    }
    for (const move of [
      '"roles.voice" -> "models.base.voice"',
      '"roles.byPurpose" -> "models.base.byPurpose"',
      '"roles.drawing" -> "models.agents.drawing"',
      '"roles.agent.web" -> "models.agents.web"',
      '"roles.agentDev" -> "models.agents.dev"',
      'drop "roles.agent.advice"',
      '"llm.keyByRole.agent.web" -> "llm.keyByRole.web"',
      'drop "llm.keyByRole.agent.advice"',
      'tools/migrate-models-config.mjs config.local.json --write',
    ]) assert.ok(err.message.includes(move), move);
    assert.equal(err.message.includes('x/voice') || err.message.includes('openrouter/'), false, 'never a value');
    return true;
  });
  assert.throws(() => loadWith({ roles: {} }), ConfigShapeError, 'an empty roles map too');
  assert.throws(() => loadWith({ llm: { keyByRole: { 'agent.server': 'OPENROUTER_AGENT_KEY' } } }), /"llm\.keyByRole\.agent\.server" -> "llm\.keyByRole\.server"/, 'an old agent role key alone');
  assert.throws(() => loadWith({ roles: { odd: 'x/o' } }), /"roles\.odd" has no new key/);
});

test('loadConfig: a config.json that still holds roles is refused too; the migrated shape loads', () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const { models, ...rest } = shipped;
  const { web, server, dev, drawing } = models.agents;
  const old = { ...rest, roles: { ...models.base, drawing, 'agent.web': web, 'agent.server': server, 'agent.dev': dev, 'agent.advice': 'x/advice' } };
  assert.throws(() => loadWith(undefined, old), (err) => err instanceof ConfigShapeError && /^config\.json: /.test(err.message));
  const migrated = migrateModelsKeys(old);
  assert.deepEqual(migrated.unknown, []);
  assert.deepEqual(migrated.conflicts, []);
  assert.deepEqual(migrated.config.models, { base: models.base, agents: { drawing, web, server, dev } });
  assert.deepEqual(loadWith({ models: { base: { voice: 'x/v' }, agents: { web: 'openrouter/x/w' } } }).config.models.agents.web, 'openrouter/x/w');
  assert.equal(roleModel(loadWith(undefined, migrated.config).config, 'drawing'), ROLE_DEFAULTS.drawing);
});

test('assertModelsShape: a current layer, a non-object and the new keyByRole names pass', () => {
  for (const layer of [undefined, null, [], 'x', {}, { models: { base: {} } }, { llm: { keyByRole: { web: 'K', server: 'K', dev: 'D', voice: 'V' } } }]) {
    assert.doesNotThrow(() => assertModelsShape(layer, 'config.local.json'), JSON.stringify(layer));
  }
});

test('migrateModelsKeys: every roles key to its new path, agent.advice dropped, keyByRole renamed; key names only, input untouched', () => {
  const layer = {
    bot: { owners: [] },
    roles: {
      voice: 'a/voice', analyzer: 'a/an', reasoner: 'a/re', extractor: 'a/ex', vision: 'a/vi', video: 'a/vd', embedding: 'a/em',
      byPurpose: { lookup: 'a/lk' }, drawing: 'a/dr', 'agent.web': 'openrouter/a/web', 'agent.server': 'openrouter/a/srv', 'agent.dev': 'openrouter/a/dev', 'agent.advice': 'a/adv',
    },
    llm: { temperature: 1, keyByRole: { 'agent.web': 'OPENROUTER_AGENT_KEY', agentServer: 'OPENROUTER_AGENT_KEY', 'agent.dev': 'OPENROUTER_DEV_KEY', 'agent.advice': 'OPENROUTER_SIM_KEY', voice: 'OPENROUTER_VOICE_KEY' } },
    features: {},
  };
  const before = structuredClone(layer);
  const { config, moves, unknown, conflicts } = migrateModelsKeys(layer);
  assert.deepEqual(layer, before, 'the input is not mutated');
  assert.deepEqual(unknown, []);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(config, {
    bot: { owners: [] },
    models: {
      base: { voice: 'a/voice', analyzer: 'a/an', reasoner: 'a/re', extractor: 'a/ex', vision: 'a/vi', video: 'a/vd', embedding: 'a/em', byPurpose: { lookup: 'a/lk' } },
      agents: { drawing: 'a/dr', web: 'openrouter/a/web', server: 'openrouter/a/srv', dev: 'openrouter/a/dev' },
    },
    llm: { temperature: 1, keyByRole: { web: 'OPENROUTER_AGENT_KEY', server: 'OPENROUTER_AGENT_KEY', dev: 'OPENROUTER_DEV_KEY', voice: 'OPENROUTER_VOICE_KEY' } },
    features: {},
  });
  assert.deepEqual(Object.keys(config), ['bot', 'models', 'llm', 'features'], 'models where roles stood');
  assert.deepEqual(moves.find((move) => move.from === 'roles.agent.advice'), { from: 'roles.agent.advice', to: null });
  assert.deepEqual(moves.find((move) => move.from === 'llm.keyByRole.agentServer'), { from: 'llm.keyByRole.agentServer', to: 'llm.keyByRole.server' });
  assert.equal(moves.length, 13 + 4);
  assert.equal(JSON.stringify(moves).includes('a/'), false, 'never a value');
  assert.doesNotThrow(() => assertModelsShape(config, 'config.local.json'), 'the result loads');
  assert.deepEqual(migrateModelsKeys(config).moves, [], 'a second run moves nothing');
});

test('migrateModelsKeys: an unknown roles key or a move onto a set key is reported and left in place', () => {
  const { config, moves, unknown, conflicts } = migrateModelsKeys({ models: { base: { voice: 'new/v' } }, roles: { voice: 'old/v', odd: 'x/o', analyzer: 'x/a' } });
  assert.deepEqual(unknown, ['roles.odd']);
  assert.deepEqual(conflicts, ['roles.voice -> models.base.voice']);
  assert.deepEqual(moves, [{ from: 'roles.analyzer', to: 'models.base.analyzer' }]);
  assert.deepEqual(config, { models: { base: { voice: 'new/v', analyzer: 'x/a' } }, roles: { voice: 'old/v', odd: 'x/o' } });
  assert.throws(() => assertModelsShape(config, 'config.local.json'), ConfigShapeError);
  const keys = migrateModelsKeys({ llm: { keyByRole: { web: 'A', 'agent.web': 'B' } } });
  assert.deepEqual(keys.conflicts, ['llm.keyByRole.agent.web -> llm.keyByRole.web']);
  assert.deepEqual(keys.config.llm.keyByRole, { web: 'A', 'agent.web': 'B' });
  assert.deepEqual(migrateModelsKeys({ roles: 'x' }).unknown, ['roles']);
  assert.deepEqual(migrateModelsKeys(undefined), { config: undefined, moves: [], unknown: [], conflicts: [] });
});

// ---- the rename keeps every purpose where it was -----------------------------

// Each request kind as its call site sends it: the role, the purpose (none for the requests
// named by their role alone), whether it is an in-turn helper (hedged when its role is listed),
// and `cache: false` where the caller turns the marker off.
const CALLS = {
  reply: { role: REPLY_REQUEST.role, purpose: REPLY_REQUEST.purpose },
  'memory-voice': { role: MEMORY_VOICE_REQUEST.role, purpose: MEMORY_VOICE_REQUEST.purpose, cache: MEMORY_VOICE_REQUEST.cache },
  ...Object.fromEntries(['address', 'room', 'merge', 'route-channel', 'participation-pick', 'rewatch', 'split', 'gif-pick', 'lookup', 'planner', 'recall-summary', 'search-summary', 'read-link', 'diary-plan']
    .map((purpose) => [purpose, { role: PURPOSE_ROLES[purpose], purpose, helper: true }])),
  'memory-batch': { role: 'extractor' },
  warmup: { warmup: true },
  backfill: { role: PURPOSE_ROLES.backfill, purpose: 'backfill', cache: false },
  describe: { role: PURPOSE_ROLES.describe, purpose: 'describe', helper: true },
  relook: { role: PURPOSE_ROLES.relook, purpose: 'relook', helper: true },
  video: { role: 'video' },
  'embed-index': { role: EMBED_ROLE },
  'recall-query': { role: EMBED_ROLE, purpose: 'recall-query' },
  drawing: { role: IMAGE_ROLE, image: true },
};

/** One row per CALLS entry: the model, role, provider route, hedge and cache TTL it gets now. */
function resolveAll(config) {
  const hedge = hedgeSettings(config);
  const rows = {};
  for (const [name, call] of Object.entries(CALLS)) {
    const routed = call.warmup ? warmupRoute(config) : { role: call.role, model: roleModel(config, call.role, call.purpose) };
    const fallback = call.image ? config.image?.provider : config.llm?.provider;
    rows[name] = {
      model: routed.model,
      role: routed.role,
      route: resolveProvider(routed.model, { byModel: config.llm?.providerByModel, fallback, role: routed.role }) ?? null,
      hedge: Boolean(call.helper && hedge && hedge.afterMs > 0 && hedge.roles.includes(routed.role)),
      cache: cacheTtlFor(config, routed.role, routed.model, call.cache),
    };
  }
  return rows;
}

// Recorded from the code before the rename (src/behavior/mention.js#helperModel and the
// classifier*Model resolvers, src/memory/warmup.js#warmupRoute, `llm.model` for a request
// without a model, `image.model`) on the same configs: [model, role, route, hedge, cache].
const ANTHROPIC = { only: ['anthropic'] };
const OPENAI = { only: ['openai'] };
const VERTEX = { only: ['google-vertex'] };
const STUDIO = { only: ['google-ai-studio'] };
const OPUS = 'anthropic/claude-opus-4.6';
const SONNET = 'anthropic/claude-sonnet-4.6';
const HAIKU = 'anthropic/claude-haiku-4.5';
const SOL = 'openai/gpt-6.1-sol';
const FLASH = 'google/gemini-3.8-flash';
const EMBED = 'openai/text-embedding-3-large';
const FLARE = 'openai/gpt-image-2.5-flare';
const TEXT_PURPOSES = ['address', 'room', 'merge', 'route-channel', 'participation-pick', 'rewatch', 'split', 'gif-pick'];
const REASON_PURPOSES = ['lookup', 'planner', 'recall-summary', 'search-summary', 'read-link', 'diary-plan'];

function beforeTable({ voice, text, reason, analyzer, media, video, embed, image }) {
  return {
    reply: [voice[0], 'voice', voice[1], false, '1h'],
    'memory-voice': [voice[0], 'voice', voice[1], false, null],
    ...Object.fromEntries(TEXT_PURPOSES.map((purpose) => [purpose, [text[0], 'classifier.text', text[1], true, null]])),
    ...Object.fromEntries(REASON_PURPOSES.map((purpose) => [purpose, [reason[0], 'classifier.reason', reason[1], true, null]])),
    'memory-batch': [analyzer[0], 'analyzer', analyzer[1], false, null],
    warmup: [analyzer[0], 'analyzer', analyzer[1], false, null],
    backfill: [analyzer[0], 'analyzer', analyzer[1], false, null],
    describe: [media[0], 'classifier.media', media[1], false, null],
    relook: [media[0], 'classifier.media', media[1], false, null],
    video: [video[0], 'classifier.video', video[1], false, null],
    'embed-index': [embed[0], 'classifier.embed', embed[1], false, null],
    'recall-query': [embed[0], 'classifier.embed', embed[1], false, null],
    drawing: [image[0], 'image', image[1], false, null],
  };
}

/** (a) the old config.json alone. */
const BEFORE_DEFAULTS = beforeTable({
  voice: [OPUS, null], text: [SONNET, null], reason: [SONNET, null], analyzer: [OPUS, null],
  media: [HAIKU, null], video: [FLASH, null], embed: [EMBED, null], image: [FLARE, null],
});

/** (b) the old config.json under the owner's server overrides (OWNER_LOCAL). */
const BEFORE_OWNER = beforeTable({
  voice: [OPUS, ANTHROPIC], text: [SOL, OPENAI], reason: [SOL, OPENAI], analyzer: [SOL, OPENAI],
  media: [FLASH, VERTEX], video: [FLASH, STUDIO], embed: [EMBED, null], image: [FLARE, null],
});

/** The owner's server config.local.json model settings, written under the old keys. */
const OWNER_LOCAL = {
  classifier: { text: SOL, media: FLASH },
  memory: { model: SOL },
  llm: {
    cache: { roles: ['voice', 'classifier.text', 'analyzer'] },
    providerByModel: { 'anthropic/': ANTHROPIC, 'openai/gpt-6': OPENAI, 'google/': VERTEX, 'google/@classifier.video': STUDIO },
  },
};

/** Each old request role with its new name. */
const NEW_ROLE = {
  voice: 'voice',
  'classifier.text': 'analyzer',
  'classifier.reason': 'reasoner',
  analyzer: 'extractor',
  'classifier.media': 'vision',
  'classifier.video': 'video',
  'classifier.embed': 'embedding',
  image: 'drawing',
};

function assertSameAsBefore(after, before, models = {}) {
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  for (const [name, [model, role, route, hedge, cache]] of Object.entries(before)) {
    const row = after[name];
    assert.equal(row.model, models[name] ?? model, `${name}: model`);
    assert.equal(row.role, NEW_ROLE[role], `${name}: role`);
    assert.deepEqual(row.route, route, `${name}: route`);
    assert.equal(row.hedge, hedge, `${name}: hedge`);
    assert.equal(row.cache, cache, `${name}: cache`);
  }
}

test('rename: the owner\'s server config resolves every purpose exactly as before', () => {
  const { config } = loadWith(OWNER_LOCAL);
  assertSameAsBefore(resolveAll(config), BEFORE_OWNER);
});

test('rename: config.json alone resolves every purpose as before, but for the new built-in defaults', () => {
  const { config } = loadWith(undefined);
  // The defaults the new roles ship with (the owner's effective models): the gate and reasoning
  // helpers leave the Sonnet default, the memory extractor leaves the voice model it used to
  // fall back to, and the picture describer leaves the Haiku default.
  const changed = {
    ...Object.fromEntries([...TEXT_PURPOSES, ...REASON_PURPOSES].map((purpose) => [purpose, SOL])),
    'memory-batch': SOL,
    warmup: SOL,
    backfill: SOL,
    describe: FLASH,
    relook: FLASH,
  };
  assertSameAsBefore(resolveAll(config), BEFORE_DEFAULTS, changed);
});

// ---- the call sites ----------------------------------------------------------

/** Every .js/.mjs file under src/ and tools/, as [relative path, text]. */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.m?js$/.test(name)) out.push([path.relative(ROOT, full), fs.readFileSync(full, 'utf8')]);
    }
  };
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'tools'));
  return out;
}

test('call sites: every request role is one of the roles, every purpose goes out on its own role', () => {
  const chatRoles = new Set(['system', 'user', 'assistant']);
  let pairs = 0;
  for (const [file, text] of sources()) {
    for (const [, role] of text.matchAll(/\brole: '([\w.-]+)'/g)) {
      if (!chatRoles.has(role)) assert.ok(isRole(role), `${file}: role '${role}'`);
      assert.ok(!OPENCODE_ROLES.includes(role), `${file}: no request of the bot goes out on the OpenCode role '${role}'`);
    }
    for (const [, role, purpose] of text.matchAll(/roleModel\([\w.]+, '([\w-]+)', '([\w-]+)'\)/g)) {
      assert.equal(PURPOSE_ROLES[purpose], role, `${file}: roleModel for ${purpose}`);
      pairs += 1;
    }
    for (const [, role, purpose] of text.matchAll(/helperRequestOptions\([\w.]+, \{\s*role: '([\w-]+)'[^}]*?purpose: '([\w-]+)'/g)) {
      assert.equal(PURPOSE_ROLES[purpose], role, `${file}: helper request for ${purpose}`);
      pairs += 1;
    }
  }
  assert.ok(pairs >= 30, `found ${pairs} role/purpose pairs`);
});
