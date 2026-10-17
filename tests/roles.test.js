// Tests for src/llm/roles.js (the model roles: eight the bot's own requests go out on, three its
// OpenCode workers run on; one resolver, no cross-role fallback) and
// src/config.js#adaptLegacyModelKeys (a config.local.json written under the old model keys),
// plus the rename check: every purpose resolves, under config.json and under a deployment that
// still uses the old keys, to what the code before the rename produced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADVICE_ROLE, AGENT_ROLES, OPENCODE_ROLES, ROLES, ROLE_DEFAULTS, PURPOSE_ROLES, isRole, roleModel } from '../src/llm/roles.js';
import { adaptLegacyModelKeys, loadConfig } from '../src/config.js';
import { MEMORY_VOICE_REQUEST, REPLY_REQUEST, cacheTtlFor, hedgeSettings, resolveProvider } from '../src/llm/openrouter.js';
import { EMBED_ROLE } from '../src/llm/embed.js';
import { IMAGE_ROLE } from '../src/llm/images.js';
import { warmupRoute } from '../src/memory/warmup.js';
import { MODEL_SET_ROLES } from '../src/ops/catalog.js';
import { tempDir } from './fixtures/tmp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A scratch root with the tracked config.json and, when given, a config.local.json. */
function loadWith(local) {
  const dir = tempDir('nep-roles-');
  try {
    fs.copyFileSync(path.join(ROOT, 'config.json'), path.join(dir, 'config.json'));
    if (local !== undefined) fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify(local));
    return loadConfig(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- roleModel ---------------------------------------------------------------

test('roleModel: roles.byPurpose for the purpose, else roles.<role>, else the role default', () => {
  const config = { roles: { analyzer: 'x/analyzer', byPurpose: { split: 'x/split' } } };
  assert.equal(roleModel(config, 'analyzer', 'split'), 'x/split');
  assert.equal(roleModel(config, 'analyzer', 'address'), 'x/analyzer');
  assert.equal(roleModel(config, 'analyzer'), 'x/analyzer');
  assert.equal(roleModel(config, 'reasoner', 'lookup'), ROLE_DEFAULTS.reasoner);
});

test('roleModel: a byPurpose entry applies whatever the role, an empty or non-string one does not', () => {
  const config = { roles: { voice: 'x/voice', byPurpose: { reply: 'x/reply', describe: '', relook: 7 } } };
  assert.equal(roleModel(config, 'voice', 'reply'), 'x/reply');
  assert.equal(roleModel(config, 'vision', 'describe'), ROLE_DEFAULTS.vision);
  assert.equal(roleModel(config, 'vision', 'relook'), ROLE_DEFAULTS.vision);
  assert.equal(roleModel({ roles: { byPurpose: Object.create({ split: 'x/inherited' }) } }, 'analyzer', 'split'), ROLE_DEFAULTS.analyzer);
});

test('roleModel: a byPurpose that is not a plain object, or an entry that is not a non-empty string, leaves the role model', () => {
  const roles = { reasoner: 'x/reason' };
  for (const byPurpose of [{ lookup: '' }, { lookup: null }, { lookup: 7 }, ['x/array'], 'x/string', null]) {
    assert.equal(roleModel({ roles: { ...roles, byPurpose } }, 'reasoner', 'lookup'), 'x/reason', JSON.stringify(byPurpose));
  }
  assert.equal(roleModel({ roles: { byPurpose: { toString: 'x/proto' } } }, 'analyzer', 'constructor'), ROLE_DEFAULTS.analyzer, 'own keys only');
});

test('roleModel: an unset role takes its own default, never another role\'s model', () => {
  const config = { roles: { analyzer: 'x/analyzer', vision: 'x/vision', voice: 'x/voice' } };
  for (const role of ['reasoner', 'extractor', 'video', 'embedding', 'drawing']) {
    assert.equal(roleModel(config, role), ROLE_DEFAULTS[role], role);
  }
  assert.equal(roleModel({ roles: { reasoner: null, extractor: '' } }, 'reasoner'), ROLE_DEFAULTS.reasoner);
  assert.equal(roleModel({ roles: { reasoner: null, extractor: '' } }, 'extractor'), ROLE_DEFAULTS.extractor);
  assert.equal(roleModel(undefined, 'voice'), ROLE_DEFAULTS.voice);
});

test('roleModel: the old model keys are never read at the moment of use', () => {
  const old = { llm: { model: 'x/old' }, classifier: { text: 'x/old', reason: 'x/old', media: 'x/old' }, memory: { model: 'x/old' }, image: { model: 'x/old' } };
  for (const role of ROLES) assert.equal(roleModel(old, role), ROLE_DEFAULTS[role], role);
});

test('roleModel: undefined for a name that is not a role, unless its purpose is pinned', () => {
  assert.equal(roleModel({}, 'classifier.text'), undefined);
  assert.equal(roleModel({}, 'constructor'), undefined);
  assert.equal(roleModel({ roles: { byPurpose: { odd: 'x/odd' } } }, 'nope', 'odd'), 'x/odd');
  assert.equal(isRole('voice'), true);
  assert.equal(isRole('talk'), false);
});

test('roles: the built-in defaults equal config.json, and every role has one', () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).roles;
  const { byPurpose, ...models } = shipped;
  assert.deepEqual(models, { ...ROLE_DEFAULTS });
  assert.deepEqual(byPurpose, {});
  assert.deepEqual(Object.keys(ROLE_DEFAULTS), [...ROLES]);
  assert.deepEqual([...MODEL_SET_ROLES], [...ROLES], '/nep model set offers every role');
  for (const role of Object.values(PURPOSE_ROLES)) assert.ok(isRole(role), role);
});

test('roles: the agent roles follow drawing, the OpenCode ones with OpenCode model ids, resolved like any role, no purpose on them', () => {
  assert.deepEqual([...AGENT_ROLES], ['agent.web', 'agent.server', 'agent.dev', 'agent.advice']);
  assert.deepEqual([...OPENCODE_ROLES], ['agent.web', 'agent.server', 'agent.dev']);
  assert.equal(ADVICE_ROLE, 'agent.advice');
  assert.deepEqual(ROLES.slice(ROLES.indexOf('drawing') + 1), [...AGENT_ROLES]);
  assert.equal(ROLE_DEFAULTS['agent.web'], 'openrouter/openai/gpt-6.1-sol');
  assert.equal(ROLE_DEFAULTS['agent.server'], 'openrouter/openai/gpt-6.1-sol');
  assert.equal(ROLE_DEFAULTS['agent.dev'], 'openrouter/anthropic/claude-opus-5.5');
  assert.equal(ROLE_DEFAULTS['agent.advice'], 'openai/gpt-6-astra', 'the advice role: a bare OpenRouter id (its tools call OpenRouter directly)');
  for (const role of OPENCODE_ROLES) assert.match(ROLE_DEFAULTS[role], /^openrouter\/[\w.-]+\/[\w.:-]+$/, `${role}: an OpenCode id, provider first`);
  for (const role of AGENT_ROLES) {
    assert.equal(roleModel({}, role), ROLE_DEFAULTS[role], role);
    assert.equal(roleModel({ roles: { [role]: 'openrouter/x/y' } }, role), 'openrouter/x/y', role);
  }
  assert.equal(roleModel({ roles: { 'agent.web': 'openrouter/x/web' } }, 'agent.server'), ROLE_DEFAULTS['agent.server'], 'never another agent role\'s model');
  assert.equal(roleModel({ roles: { 'agent.dev': 'openrouter/x/dev' } }, 'agent.advice'), ROLE_DEFAULTS['agent.advice'], 'nor the advice role another\'s');
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

test('adaptLegacyModelKeys: each old model key moves to its roles key, listed by name only', () => {
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
    roles: { voice: 'x/voice', analyzer: 'x/a', reasoner: 'x/r', extractor: 'x/ex', vision: 'x/v', video: 'x/vid', embedding: 'x/e', drawing: 'x/d', byPurpose: { split: 'x/s' } },
  });
  assert.deepEqual(renamed, [
    { key: 'llm.model', use: 'roles.voice' },
    { key: 'classifier.text', use: 'roles.analyzer' },
    { key: 'classifier.reason', use: 'roles.reasoner' },
    { key: 'memory.model', use: 'roles.extractor' },
    { key: 'classifier.media', use: 'roles.vision' },
    { key: 'classifier.video', use: 'roles.video' },
    { key: 'classifier.embed', use: 'roles.embedding' },
    { key: 'image.model', use: 'roles.drawing' },
    { key: 'classifier.byPurpose', use: 'roles.byPurpose' },
  ]);
  assert.equal(JSON.stringify(renamed).includes('x/'), false, 'never a value');
});

test('adaptLegacyModelKeys: a new key set too wins, the old one is dropped', () => {
  const { config } = adaptLegacyModelKeys({ classifier: { text: 'x/old' }, roles: { analyzer: 'x/new' } });
  assert.deepEqual(config, { roles: { analyzer: 'x/new' } });
});

test('adaptLegacyModelKeys: a current config passes unchanged, never mutated', () => {
  const local = { roles: { analyzer: 'x/a' }, llm: { cache: { roles: ['voice', 'analyzer'] }, providerByModel: { 'x/@analyzer': { only: ['p'] } } } };
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

test('adaptLegacyModelKeys: the old agent role names are read as the dotted ones, one key each, the new key winning', () => {
  const local = {
    roles: { agentWeb: 'openrouter/x/web', agentDev: 'openrouter/x/dev-old', 'agent.dev': 'openrouter/x/dev-new' },
    llm: { keyByRole: { agentServer: 'OPENROUTER_OTHER_KEY' } },
  };
  const { config, renamed } = adaptLegacyModelKeys(local);
  assert.deepEqual(config.roles, { 'agent.web': 'openrouter/x/web', 'agent.dev': 'openrouter/x/dev-new' });
  assert.deepEqual(config.llm.keyByRole, { 'agent.server': 'OPENROUTER_OTHER_KEY' });
  assert.equal(Object.hasOwn(config.roles, 'agent'), false, 'never a path');
  assert.deepEqual(renamed, [
    { key: 'roles.agentWeb', use: 'roles.agent.web', role: true },
    { key: 'roles.agentDev', use: 'roles.agent.dev', role: true },
    { key: 'llm.keyByRole.agentServer', use: 'llm.keyByRole.agent.server', role: true },
  ]);
  assert.equal(JSON.stringify(renamed).includes('openrouter/'), false, 'never a value');
  assert.equal(local.roles.agentWeb, 'openrouter/x/web', 'the input is not mutated');
  const loaded = loadWith({ roles: { agentWeb: 'openrouter/x/web' } });
  assert.equal(roleModel(loaded.config, 'agent.web'), 'openrouter/x/web');
  assert.equal(Object.hasOwn(loaded.config.roles, 'agentWeb'), false);
});

test('loadConfig: config.local.json is read through the adapter, config.json as it is', () => {
  const { config, renamed } = loadWith({ classifier: { text: 'x/a' }, memory: { model: 'x/e' } });
  assert.equal(config.roles.analyzer, 'x/a');
  assert.equal(config.roles.extractor, 'x/e');
  assert.equal(config.roles.voice, ROLE_DEFAULTS.voice);
  assert.equal(config.classifier, undefined);
  assert.equal(Object.hasOwn(config.memory, 'model'), false);
  assert.deepEqual(renamed.map(({ key }) => key), ['classifier.text', 'memory.model']);
  assert.deepEqual(loadWith(undefined).renamed, []);
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
      assert.ok(!AGENT_ROLES.includes(role), `${file}: no request of the bot goes out on the agent role '${role}'`);
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
