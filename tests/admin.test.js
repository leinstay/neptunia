import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  listRules,
  appendRule,
  removeRule,
  setPath,
  unsetPath,
  createAdmin,
  buildProfileSummary,
} from '../src/admin.js';
import { emptyAffinity, applyDelta } from '../src/memory/affinity.js';
import { upsertLore } from '../src/memory/lore.js';
import { createStore } from '../src/memory/store.js';
import { createAppendStore } from '../src/memory/append-store.js';
import { createArchive } from '../src/memory/archive.js';
import { createSpontaneous } from '../src/behavior/spontaneous.js';
import { buildDrawPrompt } from '../src/behavior/prompt.js';
import { familyOf, ImageGenError } from '../src/llm/images.js';
import { createLlm } from '../src/llm/openrouter.js';
import { ROLE_DEFAULTS } from '../src/llm/roles.js';
import { createMetrics } from '../src/tools/impl/metrics.ts';
import { getOp } from '../src/tools/impl/registry.ts';
import { splitPath } from '../src/tools/impl/shared.ts';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { createDiscordInterface } from '../interfaces/discord/index.js';
import { tempDir } from './fixtures/tmp.js';
import { world } from './fixtures/turn-world.ts';
import { openTestMemory } from './fixtures/memory-db/service.js';

// The Discord interface's capabilities object, as src/index.js injects it.
const DISCORD = createDiscordInterface().capabilities;

// ---------------------------------------------------------------------------
// listRules / appendRule / removeRule
// ---------------------------------------------------------------------------

test('listRules: reads the bullets under a non-Latin ## heading', () => {
  // A bullet above the heading: were the Greek heading not recognised, the no-heading
  // fallback would return it too.
  const text = '# Rules file\n\n- not a rule\n\n## Κανόνες\n\n- Rule one\n- Rule two\n';
  assert.deepEqual(listRules(text), ['Rule one', 'Rule two']);
});

test('listRules: stops at the next heading (any level) so unrelated bullets are excluded', () => {
  const text = '## Rules\n\n- Rule one\n\n### Other section\n\n- not a rule\n';
  assert.deepEqual(listRules(text), ['Rule one']);
});

test('listRules: with two ## headings, only the bullets under the last one count', () => {
  const text = '## Old section\n\n- not a rule\n\n## Rules\n\n- Rule one\n- Rule two\n';
  assert.deepEqual(listRules(text), ['Rule one', 'Rule two']);
});

test('listRules: falls back to every top-level bullet when there is no ## heading', () => {
  const text = 'Intro\n- first\n- second\n';
  assert.deepEqual(listRules(text), ['first', 'second']);
});

test('appendRule: appends the bullet as the last line, under the last of two ## headings, non-Latin text intact', () => {
  for (const [label, text, rule, expected, rules] of [
    [
      'one heading',
      '## Rules\n\n- existing\n',
      'new one',
      '## Rules\n\n- existing\n- new one\n',
      ['existing', 'new one'],
    ],
    [
      'non-Latin heading and rule text',
      '## Κανόνες\n\n- παλιός κανόνας\n',
      'ποτέ μην μιλάς αγγλικά',
      '## Κανόνες\n\n- παλιός κανόνας\n- ποτέ μην μιλάς αγγλικά\n',
      ['παλιός κανόνας', 'ποτέ μην μιλάς αγγλικά'],
    ],
    [
      'two ## headings',
      '## Old\n\n- stale\n\n## Rules\n\n- existing\n',
      'new one',
      '## Old\n\n- stale\n\n## Rules\n\n- existing\n- new one\n',
      ['existing', 'new one'],
    ],
  ]) {
    const result = appendRule(text, rule);
    assert.equal(result, expected, label);
    assert.deepEqual(listRules(result), rules, label);
  }
});

test('appendRule: collapses newlines inside the rule into single spaces', () => {
  const result = appendRule('## Rules\n', 'first line\nsecond line');
  assert.equal(listRules(result).at(-1), 'first line second line');
});

test('appendRule: creates a ## heading when the file has none at all', () => {
  const result = appendRule('Some preamble.', 'be nice');
  assert.match(result, /^## /m);
  assert.deepEqual(listRules(result), ['be nice']);
});

test('removeRule: removes the nth bullet in listRules order and reports it', () => {
  const text = '## Rules\n\n- one\n- two\n- three\n';
  const result = removeRule(text, 2);
  assert.equal(result.removed, 'two');
  assert.deepEqual(listRules(result.text), ['one', 'three']);
});

// ---------------------------------------------------------------------------
// setPath / unsetPath
// ---------------------------------------------------------------------------

test('setPath: overwrites an existing value without touching its siblings', () => {
  const result = setPath({ a: { b: 1, c: 2 } }, 'a.b', 99);
  assert.deepEqual(result, { a: { b: 99, c: 2 } });
});

test('setPath: rejects paths containing __proto__, constructor or prototype', () => {
  assert.throws(() => setPath({}, 'a.__proto__.polluted', 1));
  assert.throws(() => setPath({}, 'constructor.prototype.polluted', 1));
  assert.throws(() => setPath({}, 'a.prototype.b', 1));
});

test('setPath / unsetPath / splitPath: a key holding a dot, given as an array of keys or read against a reference, is one key', () => {
  assert.deepEqual(setPath({ routes: { a: 'v' } }, ['routes', 'x/m-6.1'], 'w'), { routes: { a: 'v', 'x/m-6.1': 'w' } });
  assert.deepEqual(unsetPath({ routes: { 'x/m-6.1': 'w', a: 'v' } }, ['routes', 'x/m-6.1']), { routes: { a: 'v' } });
  const reference = {
    routes: { 'x/m-6.1': 'w', 'x/m-6': { x: 1 } },
    llm: { providerByModel: { 'openai/gpt-6.1': 'K' } },
  };
  assert.deepEqual(splitPath('routes.x/m-6.1', reference), ['routes', 'x/m-6.1'], 'the longest own key wins');
  assert.deepEqual(splitPath('routes.x/m-6.x', reference), ['routes', 'x/m-6', 'x']);
  assert.deepEqual(splitPath('llm.providerByModel.openai/gpt-6.1', reference), [
    'llm',
    'providerByModel',
    'openai/gpt-6.1',
  ]);
  assert.deepEqual(
    splitPath('routes.new.key', reference),
    ['routes', 'new', 'key'],
    'a key the reference lacks: every dot separates'
  );
  assert.deepEqual(splitPath('routes.x/m-6.1'), ['routes', 'x/m-6', '1'], 'no reference: every dot separates');
  assert.throws(() => splitPath(['roles', '__proto__']), /forbidden path segment/);
  assert.throws(() => setPath({}, ['a', 'constructor'], 1), /forbidden path segment/);
});

test('unsetPath: removes a key and prunes an emptied parent object', () => {
  const result = unsetPath({ a: { b: 1 } }, 'a.b');
  assert.deepEqual(result, {});
});

test('unsetPath: removes a key but keeps siblings on the parent', () => {
  const result = unsetPath({ a: { b: 1, c: 2 } }, 'a.b');
  assert.deepEqual(result, { a: { c: 2 } });
});

test('unsetPath: does not mutate its input and is a no-op for a missing path', () => {
  const input = { a: { b: 1 } };
  const result = unsetPath(input, 'a.x.y');
  assert.deepEqual(input, { a: { b: 1 } });
  assert.deepEqual(result, { a: { b: 1 } });
});

// ---------------------------------------------------------------------------
// buildProfileSummary (pure)
// ---------------------------------------------------------------------------

test('buildProfileSummary: never exceeds 2000 chars, even for a huge profile, and points to the full sections', () => {
  const profile = {
    id: '123',
    names: Array.from({ length: 10 }, (_, i) => `VeryLongDisplayNameNumber${i}`),
    messageCount: 999999,
    firstSeen: '2020-01-01T00:00:00.000Z',
    lastSeen: '2026-09-20T00:00:00.000Z',
    affinity: { score: 99, reason: 'x'.repeat(500) },
    character: 'c'.repeat(5000),
    style: 's'.repeat(5000),
    relationship: 'r'.repeat(5000),
    interests: Array.from({ length: 40 }, (_, i) => ({ topic: `Topic number ${i} is quite long`, weight: i })),
    details: Array.from({ length: 40 }, (_, i) => ({ id: i, text: 'd'.repeat(200), weight: i })),
    episodes: Array.from({ length: 20 }, () => ({})),
    aliases: Array.from({ length: 15 }, (_, i) => ({ name: `AliasNumber${i}longenough`, weight: i })),
  };

  const text = buildProfileSummary(profile, {});

  assert.ok(text.length <= 2000, `expected <= 2000 chars, got ${text.length}`);
  assert.ok(text.includes('(full text: section character)'));
  assert.ok(text.includes('(full text: section style)'));
  assert.ok(text.includes('(full text: section relationship)'));
  assert.ok(text.includes('(full text: section aliases)'));
  assert.ok(
    text.includes('interests: 40 stored'),
    'the top-5 interest topics stay short by construction, so this is not truncated'
  );
});

test('buildProfileSummary: resolves <@id> tokens in free-text fields via nameOf', () => {
  const otherId = '999999999999999999';
  const profile = { id: '123', names: ['Bob'], character: `trusts <@${otherId}>` };
  const nameOf = (id) => (id === otherId ? 'Zoe' : null);

  const text = buildProfileSummary(profile, {}, nameOf);
  assert.ok(text.includes(`character: trusts Zoe (id:${otherId})`));
});

// ---------------------------------------------------------------------------
// createAdmin().run — fakes on a temp dir
// ---------------------------------------------------------------------------

function makeRoot() {
  const rootDir = tempDir('nep-admin-');
  fs.mkdirSync(path.join(rootDir, 'prompts'));
  fs.writeFileSync(path.join(rootDir, 'prompts', 'rules.md'), '## Rules\n\n- be kind\n');
  return rootDir;
}

function makeHot(rootDir) {
  return {
    config: {
      bot: { owners: ['42'] },
      models: { base: { core: 'anthropic/claude-opus-4.6' } },
      llm: { maxRequestsPerDay: 300 },
    },
    prompts: { persona: 'who she is', labels: { locale: 'en-US' } },
    promptSources: { persona: 'base', labels: 'base' },
    promptsDir: path.join(rootDir, 'prompts'),
    localPromptsDir: path.join(rootDir, 'prompts.local'),
    rootDir,
    reloadConfigCalls: 0,
    reloadPromptsCalls: 0,
    reloadConfig() {
      this.reloadConfigCalls += 1;
      return true;
    },
    reloadPrompts() {
      this.reloadPromptsCalls += 1;
      return true;
    },
  };
}

function makeStore() {
  const profiles = new Map();
  const forgotten = [];
  const privates = new Map(); // `${guildId}:${userId}` -> private layer
  const forgottenPrivate = [];
  const lore = new Map(); // guildId -> entries[]
  const channels = new Map(); // `${guildId}:${channelId}` -> channel entry
  const guilds = new Map(); // guildId -> guild notes
  const store = {
    profiles,
    forgotten,
    lore,
    channels,
    guilds,
    getChannel(guildId, channelId) {
      return channels.get(`${guildId}:${channelId}`) ?? null;
    },
    listChannels(guildId) {
      const prefix = `${guildId}:`;
      return [...channels.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);
    },
    getGuild(guildId) {
      return guilds.get(guildId) ?? { patterns: '', starters: '', injokes: [], self: [], updatedAt: null };
    },
    recent: new Map(), // guildId -> { nextId, lines }
    getRecent(guildId) {
      return structuredClone(this.recent.get(guildId) ?? { nextId: 1, lines: [] });
    },
    state: { data: { llmCount: 5, llmDay: '2026-09-20' }, markDirty() {} },
    flushCalls: 0,
    flush() {
      this.flushCalls += 1;
    },
    dropCachesCalls: 0,
    dropCaches() {
      this.dropCachesCalls += 1;
      return 0;
    },
    reloadStateCalls: 0,
    reloadState() {
      this.reloadStateCalls += 1;
    },
    validateResult: [],
    validate() {
      return this.validateResult;
    },
    getUser(guildId, userId) {
      return profiles.get(`${guildId}:${userId}`) ?? null;
    },
    getLore(guildId) {
      return lore.get(guildId) ?? [];
    },
    setLore(guildId, incoming, opts) {
      const { entries, upserted } = upsertLore(lore.get(guildId) ?? [], incoming, opts);
      lore.set(guildId, entries);
      return upserted;
    },
    removeLore(guildId, id) {
      const current = lore.get(guildId) ?? [];
      const next = current.filter((e) => e.id !== id);
      lore.set(guildId, next);
      return next.length !== current.length;
    },
    adjustAffinity(guildId, userId, delta, reason, opts) {
      const key = `${guildId}:${userId}`;
      const profile = profiles.get(key) ?? { id: String(userId), affinity: emptyAffinity() };
      profile.affinity = applyDelta(profile.affinity ?? emptyAffinity(), delta, reason, opts);
      profiles.set(key, profile);
      return profile.affinity;
    },
    privates,
    forgottenPrivate,
    getPrivate(guildId, userId) {
      return privates.get(`${guildId}:${userId}`) ?? null;
    },
    listPrivate(guildId) {
      const prefix = `${guildId}:`;
      return [...privates.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
    },
    countUsers() {
      return profiles.size;
    },
    listUserProfiles(guildId) {
      const prefix = `${guildId}:`;
      return [...profiles.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);
    },
    participation: new Map(), // guildId -> { episodes, nextId }
    getParticipation(guildId) {
      return structuredClone(this.participation.get(guildId) ?? { episodes: [], nextId: 1 });
    },
    getBuffer() {
      return [];
    },
  };
  return store;
}

function makeAdmin(rootDir, extra = {}) {
  const hot = extra.hot ?? makeHot(rootDir);
  const store = extra.store ?? makeStore();
  const admin = createAdmin({
    discord: DISCORD,
    hot,
    store,
    reads: extra.reads ?? world().reads,
    port: extra.port ?? world().port,
    selfId: extra.selfId ?? (() => 'self-id'),
    getSelfName: extra.getSelfName ?? (() => 'Persona'),
    spontaneous: extra.spontaneous ?? {},
    calibrator: extra.calibrator ?? { ratio: 1 },
    getGuildId: extra.getGuildId ?? (() => 'g1'),
    turns: extra.turns,
    memory: extra.memory,
    pending: extra.pending,
    images: extra.images,
    imageFetcher: extra.imageFetcher,
    emojiBackfill: extra.emojiBackfill,
    gifBackfill: extra.gifBackfill,
    gifRecache: extra.gifRecache,
    archive: extra.archive,
    journal: extra.journal,
    llm: extra.llm,
    embedder: extra.embedder,
    embedQueue: extra.embedQueue,
    record: extra.record,
    metrics: extra.metrics,
    lookup: extra.lookup,
    usage: extra.usage,
    errands: extra.errands,
    managementKey: extra.managementKey,
    now: extra.now,
  });
  return { admin, hot, store };
}

function readLocal(rootDir) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, 'config.local.json'), 'utf8'));
}

// ---------------------------------------------------------------------------
// owners
// ---------------------------------------------------------------------------

test('isAllowed: a listed owner id passes for any command; the admin exposes no separate owner check', () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  assert.equal(admin.isAllowed('config.set', { userId: '42' }), true);
  assert.equal(admin.isAllowed('config.set', { userId: '999' }), false);
  assert.equal(admin.isOwner, undefined);
});

// ---------------------------------------------------------------------------
// rule.add / rule.list / rule.remove
// ---------------------------------------------------------------------------

test('run: rule.add seeds prompts.local/rules.md from the base file, leaving prompts/rules.md untouched', async () => {
  const rootDir = makeRoot();
  const { admin, hot } = makeAdmin(rootDir);

  const baseBefore = fs.readFileSync(path.join(rootDir, 'prompts', 'rules.md'));
  const result = await admin.run('rule.add', { text: 'Never spoil the ending' }, { guildId: 'g1' });

  const localFile = path.join(rootDir, 'prompts.local', 'rules.md');
  assert.ok(fs.existsSync(localFile));
  const rulesText = fs.readFileSync(localFile, 'utf8');
  assert.deepEqual(listRules(rulesText), ['be kind', 'Never spoil the ending']);
  // the tracked base file is byte-identical to before
  assert.deepEqual(fs.readFileSync(path.join(rootDir, 'prompts', 'rules.md')), baseBefore);
  assert.equal(hot.reloadPromptsCalls, 1);
  assert.ok(result.includes('Rule added'));
});

test('run: rule.add rejects empty text', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  await assert.rejects(() => admin.run('rule.add', { text: '   ' }, {}));
});

test('run: rule.list lists the numbered rules; rule.remove removes one from the local layer, leaving the base file untouched', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  const baseBefore = fs.readFileSync(path.join(rootDir, 'prompts', 'rules.md'));
  await admin.run('rule.add', { text: 'second rule' }, {});
  const listed = await admin.run('rule.list', {}, {});
  assert.ok(listed.includes('1. be kind'));
  assert.ok(listed.includes('2. second rule'));

  await admin.run('rule.remove', { number: 1 }, {});
  const rulesText = fs.readFileSync(path.join(rootDir, 'prompts.local', 'rules.md'), 'utf8');
  assert.deepEqual(listRules(rulesText), ['second rule']);
  assert.deepEqual(fs.readFileSync(path.join(rootDir, 'prompts', 'rules.md')), baseBefore);
});

test('run: rule.remove rejects an out-of-range number', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  await assert.rejects(() => admin.run('rule.remove', { number: 5 }, {}), /no rule #5/);
});

test('run: rule.add seeds from an empty text when the base rules.md is missing', async () => {
  const rootDir = tempDir('nep-admin-');
  fs.mkdirSync(path.join(rootDir, 'prompts'));
  const { admin } = makeAdmin(rootDir);

  const result = await admin.run('rule.add', { text: 'only rule' }, {});

  const rulesText = fs.readFileSync(path.join(rootDir, 'prompts.local', 'rules.md'), 'utf8');
  assert.deepEqual(listRules(rulesText), ['only rule']);
  assert.ok(result.includes('Rule added'));
});

// ---------------------------------------------------------------------------
// set / unset
// ---------------------------------------------------------------------------

test('run: set writes an override to config.local.json and reloads config', async () => {
  const rootDir = makeRoot();
  const { admin, hot } = makeAdmin(rootDir);

  const result = await admin.run('set', { path: 'models.base.core', value: '"openrouter/test-model"' }, {});

  assert.deepEqual(readLocal(rootDir), { models: { base: { core: 'openrouter/test-model' } } });
  assert.equal(hot.reloadConfigCalls, 1);
  assert.ok(result.includes('Set models.base.core'));
});

test('run: set falls back to the raw string when the value is not valid JSON', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await admin.run('set', { path: 'models.base.core', value: 'plain-text-model' }, {});
  assert.deepEqual(readLocal(rootDir), { models: { base: { core: 'plain-text-model' } } });
});

test('run: set rejects an unknown config path and writes nothing', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await assert.rejects(() => admin.run('set', { path: 'llm.doesNotExist', value: '1' }, {}), /unknown config path/);
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
});

test('run: unset removes a previously set override', async () => {
  const rootDir = makeRoot();
  const { admin, hot } = makeAdmin(rootDir);

  await admin.run('set', { path: 'models.base.core', value: '"temp-model"' }, {});
  await admin.run('unset', { path: 'models.base.core' }, {});

  assert.deepEqual(readLocal(rootDir), {});
  assert.equal(hot.reloadConfigCalls, 2);
});

test('run: set and unset read a key with a dot as one key, never a path', async () => {
  const rootDir = makeRoot();
  const { admin, hot } = makeAdmin(rootDir);
  hot.config.models = {
    ...hot.config.models,
    errands: { scout: 'openrouter/a/b' },
    development: { dev: 'openrouter/c/d' },
  };
  hot.config.names = { 'x.web': 'old' };

  const result = await admin.run('set', { path: 'models.errands.scout', value: 'openrouter/x-ai/web-model' }, {});
  assert.ok(result.startsWith('Set models.errands.scout = "openrouter/x-ai/web-model"'), result);
  await admin.run('set', { path: 'names.x.web', value: 'new' }, {});
  assert.deepEqual(readLocal(rootDir), {
    models: { errands: { scout: 'openrouter/x-ai/web-model' } },
    names: { 'x.web': 'new' },
  });

  await admin.run('unset', { path: 'models.errands.scout' }, {});
  assert.deepEqual(readLocal(rootDir), { names: { 'x.web': 'new' } });
  await assert.rejects(
    () => admin.run('set', { path: 'names.x', value: '"x/y"' }, {}),
    /unknown config path: names\.x/
  );
});

test('set: a non-owner granted set cannot touch bot.owners or bot.access; an owner can', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.bot.access = {
    'config.set': { everyone: false, roles: [], users: ['999'] },
    'config.unset': { everyone: false, roles: [], users: ['999'] },
  };
  const { admin } = makeAdmin(rootDir, { hot });
  assert.equal(admin.isAllowed('set', { userId: '999', roleIds: [] }), true, 'the non-owner holds the grant');

  const stranger = { guildId: 'g1', userId: '999' };
  await assert.rejects(
    () => admin.run('set', { path: 'bot.owners', value: '["42","999"]' }, stranger),
    /only an owner may change bot\.owners/
  );
  await assert.rejects(
    () => admin.run('set', { path: 'bot.access.set', value: '{}' }, stranger),
    /only an owner may change bot\.access/
  );
  await assert.rejects(
    () => admin.run('unset', { path: 'bot.owners' }, stranger),
    /only an owner may change bot\.owners/
  );
  await assert.rejects(
    () => admin.run('unset', { path: 'bot.access' }, stranger),
    /only an owner may change bot\.access/
  );
  await assert.rejects(() => admin.run('unset', { path: 'bot' }, stranger), /only an owner may change bot/);
  await assert.rejects(() => admin.run('set', { path: 'bot..owners', value: '["999"]' }, stranger), /only an owner/);
  await assert.rejects(
    () => admin.run('set', { path: 'bot.owners', value: '["999"]' }, {}),
    /only an owner/,
    'no caller is no owner'
  );
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false, 'nothing was written');

  const result = await admin.run('set', { path: 'bot.owners', value: '["42","7"]' }, { guildId: 'g1', userId: '42' });
  assert.match(result, /^Set bot\.owners/);
  assert.deepEqual(readLocal(rootDir), { bot: { owners: ['42', '7'] } });
});

test('set: accepts only an own leaf path of the live config and a value of the same JSON type', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.models = { ...hot.config.models, base: { ...hot.config.models.base, spare: null } };
  hot.config.features = { dryRun: false };
  const { admin } = makeAdmin(rootDir, { hot });
  const owner = { userId: '42' };

  await assert.rejects(
    () => admin.run('set', { path: 'toString', value: '1' }, owner),
    /unknown config path: toString/
  );
  await assert.rejects(
    () => admin.run('set', { path: 'llm.hasOwnProperty', value: '1' }, owner),
    /unknown config path: llm\.hasOwnProperty/
  );
  await assert.rejects(() => admin.run('set', { path: 'llm', value: '5' }, owner), /llm is a section/);
  await assert.rejects(
    () => admin.run('set', { path: 'llm.maxRequestsPerDay', value: '3OO' }, owner),
    /llm\.maxRequestsPerDay expects a number, got a string/
  );
  await assert.rejects(
    () => admin.run('set', { path: 'features.dryRun', value: '"true"' }, owner),
    /features\.dryRun expects a boolean, got a string/
  );
  await assert.rejects(
    () => admin.run('set', { path: 'bot.owners', value: '"42"' }, owner),
    /bot\.owners expects an array, got a string/
  );
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false, 'nothing was written');

  await admin.run('set', { path: 'llm.maxRequestsPerDay', value: '250' }, owner);
  await admin.run('set', { path: 'features.dryRun', value: 'true' }, owner);
  await admin.run('set', { path: 'models.base.spare', value: '"x/y"' }, owner); // the current value is null: any type
  await admin.run('set', { path: 'models.base.core', value: '123' }, owner); // a string setting keeps the text as typed
  assert.deepEqual(readLocal(rootDir), {
    llm: { maxRequestsPerDay: 250 },
    models: { base: { core: '123', spare: 'x/y' } },
    features: { dryRun: true },
  });
});

// ---------------------------------------------------------------------------
// model.show / model.set
// ---------------------------------------------------------------------------

function makeHotWithMedia(rootDir) {
  const hot = makeHot(rootDir);
  hot.config.memory = {};
  hot.config.media = {};
  hot.config.models = {
    ...hot.config.models,
    base: { ...hot.config.models.base, vision: 'anthropic/claude-haiku-4.5' },
  };
  hot.config.features = { mediaDescriptions: false };
  return hot;
}

test("run: model.show lists each role with its own model; an unset role shows its own default, never another role's", async () => {
  const rootDir = makeRoot();
  const hot = makeHotWithMedia(rootDir);
  const { admin } = makeAdmin(rootDir, { hot });

  const lines = (await admin.run('model.show', {}, {})).split('\n');
  assert.ok(lines.includes('vision: anthropic/claude-haiku-4.5'));
  assert.ok(lines.includes(`analyzer: ${ROLE_DEFAULTS.analyzer}`), 'the analyzer is not the vision model');
  assert.ok(!lines.some((line) => line.startsWith('reasoner')), 'the reasoner is merged into the analyzer');
  assert.deepEqual(
    lines.slice(0, 12).map((line) => line.split(':')[0]),
    [
      'base',
      'core',
      'analyzer',
      'vision',
      'video',
      'embedding',
      'speech',
      'drawing',
      'errands',
      'scout',
      'server',
      'development',
    ],
    'the base roles, then the errand and development roles each under their group line'
  );
  assert.equal(lines[0], 'base:');
  assert.equal(lines[8], 'errands:');
  assert.equal(lines[11], 'development:');
  assert.deepEqual(lines.slice(9, 11), [`scout: ${ROLE_DEFAULTS.scout}`, `server: ${ROLE_DEFAULTS.server}`]);
  assert.deepEqual(lines.slice(12, 14), [`thinker: ${ROLE_DEFAULTS.thinker}`, `dev: ${ROLE_DEFAULTS.dev}`]);
});

test('run: model.show ignores the deprecated keys of an old config.local.json', async () => {
  const rootDir = makeRoot();
  const hot = makeHotWithMedia(rootDir);
  hot.config.models = { base: { core: 'anthropic/claude-opus-4.6' } };
  hot.config.llm.classifierModel = 'openrouter/old-classifier';
  hot.config.mention = { followUpModel: 'openrouter/older-classifier' };
  hot.config.media = { model: 'openrouter/old-media', video: { model: 'openrouter/old-video' } };
  const { admin } = makeAdmin(rootDir, { hot });

  const lines = (await admin.run('model.show', {}, {})).split('\n');
  assert.ok(lines.includes(`analyzer: ${ROLE_DEFAULTS.analyzer}`));
  assert.ok(lines.includes(`vision: ${ROLE_DEFAULTS.vision}`));
  assert.ok(lines.includes(`video: ${ROLE_DEFAULTS.video}`));
  assert.ok(!lines.some((l) => l.includes('openrouter/old')), 'no deprecated key is shown');
  assert.ok(
    !lines.some((l) => /^(followup|media|classifier[.a-z]*|image):/.test(l)),
    'the old role names are gone from the listing'
  );
});

test('run: model.set writes the models.<group> path of each role', async () => {
  const rootDir = makeRoot();
  const hot = makeHotWithMedia(rootDir);
  const changedAt = Date.UTC(2026, 9, 15, 9, 30);
  const { admin } = makeAdmin(rootDir, { hot, now: () => changedAt });

  await admin.run('model.set', { role: 'core', id: 'anthropic/claude-opus-4.6' }, {});
  assert.deepEqual(readLocal(rootDir), { models: { base: { core: 'anthropic/claude-opus-4.6' } } });

  await admin.run('model.set', { role: 'analyzer', id: 'openrouter/text-model' }, {});
  await admin.run('model.set', { role: 'vision', id: 'anthropic/claude-haiku-4.5' }, {});
  await admin.run('model.set', { role: 'video', id: 'openrouter/video-model' }, {});
  await admin.run('model.set', { role: 'embedding', id: 'openai/text-embedding-3-small' }, {});
  await admin.run('model.set', { role: 'drawing', id: 'openai/gpt-image-x' }, {});
  await admin.run('model.set', { role: 'scout', id: 'openrouter/x-ai/web-model' }, {});
  await admin.run('model.set', { role: 'server', id: 'openrouter/x-ai/server-model' }, {});
  await admin.run('model.set', { role: 'dev', id: 'openrouter/anthropic/dev-model' }, {});
  assert.deepEqual(readLocal(rootDir), {
    models: {
      base: {
        core: 'anthropic/claude-opus-4.6',
        analyzer: 'openrouter/text-model',
        vision: 'anthropic/claude-haiku-4.5',
        video: 'openrouter/video-model',
        embedding: 'openai/text-embedding-3-small',
        drawing: 'openai/gpt-image-x',
      },
      errands: {
        scout: 'openrouter/x-ai/web-model',
        server: 'openrouter/x-ai/server-model',
      },
      development: {
        dev: 'openrouter/anthropic/dev-model',
      },
    },
    // The video model changed (the vision one was set to the model it already had).
    media: { recacheBefore: new Date(changedAt).toISOString() },
  });
  assert.equal(hot.reloadConfigCalls, 9);
});

test('run: model.set vision or video sets media.recacheBefore to the moment of the change and says so; other roles never do', async () => {
  const changedAt = Date.UTC(2026, 9, 15, 9, 30);
  const iso = new Date(changedAt).toISOString();
  for (const role of ['vision', 'video']) {
    const rootDir = makeRoot();
    const hot = makeHotWithMedia(rootDir);
    const { admin } = makeAdmin(rootDir, { hot, now: () => changedAt });
    const reply = await admin.run('model.set', { role, id: 'google/a-new-model' }, {});
    assert.deepEqual(
      readLocal(rootDir),
      { models: { base: { [role]: 'google/a-new-model' } }, media: { recacheBefore: iso } },
      role
    );
    assert.equal(hot.reloadConfigCalls, 1, `${role}: one write, one reload`);
    assert.match(reply, /^Set (vision|video) model to google\/a-new-model \(reload ok\)\n/);
    assert.ok(reply.includes(`media.recacheBefore set to ${iso}`), role);
  }
  for (const role of ['core', 'analyzer', 'embedding', 'scout', 'server', 'thinker', 'dev', 'drawing']) {
    const rootDir = makeRoot();
    const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir), now: () => changedAt });
    const reply = await admin.run('model.set', { role, id: 'google/a-new-model' }, {});
    assert.equal(readLocal(rootDir).media, undefined, role);
    assert.ok(!reply.includes('recacheBefore'), role);
  }
});

test('run: model.set vision to the model it already has leaves media.recacheBefore alone', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir) });
  await admin.run('model.set', { role: 'vision', id: 'anthropic/claude-haiku-4.5' }, {});
  assert.deepEqual(readLocal(rootDir), { models: { base: { vision: 'anthropic/claude-haiku-4.5' } } });
});

test('run: model.set rejects an unknown role and a role name that is no longer one, and writes nothing', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir) });

  for (const role of ['bogus', 'web', 'voice', 'writer', 'memory', 'byPurpose']) {
    await assert.rejects(
      () => admin.run('model.set', { role, id: 'x/y' }, {}),
      new RegExp(
        `unknown role: ${role.replace('.', '\\.')} \\(core, analyzer, vision, video, embedding, speech, drawing, scout, server, thinker, dev\\)`
      ),
      role
    );
  }
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
});

test('run: model.set rejects an id that does not look like a model id', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir) });

  await assert.rejects(() => admin.run('model.set', { role: 'core', id: 'x' }, {}), /model id/);
  await assert.rejects(() => admin.run('model.set', { role: 'drawing', id: 'has spaces here' }, {}), /model id/);
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
});

test('run: model.set accepts a loosely-valid id (letters, digits, dot, colon, slash, dash, underscore)', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir), now: () => 0 });

  await admin.run('model.set', { role: 'vision', id: 'anthropic/claude-haiku-4.5:beta' }, {});
  assert.deepEqual(readLocal(rootDir), {
    models: { base: { vision: 'anthropic/claude-haiku-4.5:beta' } },
    media: { recacheBefore: new Date(0).toISOString() },
  });
});

test('model show: the core role is models.base.core, never a stale memory.voiceModel; no voice line', async () => {
  const rootDir = makeRoot();
  const hot = makeHotWithMedia(rootDir);
  hot.config.memory.voiceModel = 'openrouter/stale-voice-model';
  const { admin } = makeAdmin(rootDir, { hot });

  const lines = (await admin.run('model.show', {}, {})).split('\n');
  assert.ok(lines.includes('core: anthropic/claude-opus-4.6'));
  assert.ok(!lines.some((l) => l.startsWith('voice:')), 'no voice role');
  assert.ok(lines.includes(`speech: ${ROLE_DEFAULTS.speech}`), 'speech is the voice model, a helper role');
  assert.ok(!lines.some((l) => l.includes('stale-voice-model')), 'memory.voiceModel is not read');
});

test('model set drawing: writes models.base.drawing to config.local.json, reloads, and model show lists it', async () => {
  const rootDir = makeRoot();
  const hot = makeHotWithMedia(rootDir);
  hot.reloadConfig = function reloadConfig() {
    this.reloadConfigCalls += 1;
    this.config.models = {
      ...this.config.models,
      base: { ...this.config.models?.base, ...readLocal(rootDir).models.base },
    };
    return true;
  };
  const { admin } = makeAdmin(rootDir, { hot });

  assert.ok((await admin.run('model.show', {}, {})).split('\n').includes(`drawing: ${ROLE_DEFAULTS.drawing}`));
  const reply = await admin.run('model.set', { role: 'drawing', id: 'openai/gpt-image-x' }, {});
  assert.match(reply, /^Set drawing model to openai\/gpt-image-x /);
  assert.deepEqual(readLocal(rootDir), { models: { base: { drawing: 'openai/gpt-image-x' } } });
  assert.equal(hot.reloadConfigCalls, 1);
  assert.ok((await admin.run('model.show', {}, {})).split('\n').includes('drawing: openai/gpt-image-x'));
});

// ---------------------------------------------------------------------------
// isAllowed
// ---------------------------------------------------------------------------

test('isAllowed: a non-owner reads bot.access off the live hot.config, role grant on the operation included', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.bot.access = { 'status.show': { everyone: false, roles: ['staff'], users: [] } };
  const { admin } = makeAdmin(rootDir, { hot });

  assert.equal(admin.isAllowed('status', { userId: '999', roleIds: ['staff'] }), true);
  assert.equal(admin.isAllowed('status', { userId: '999', roleIds: ['other'] }), false);
  hot.config.bot.access = { status: { everyone: true, roles: [], users: [] } };
  assert.equal(
    admin.isAllowed('status', { userId: '999', roleIds: [] }),
    false,
    'a grant on the old command key opens nothing'
  );
});

test('isAllowed: the commands the tree dropped (ping, reload, learned list) run nothing; isAllowed keeps an unknown key owner-only', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const open = { everyone: true, roles: [], users: [] };
  hot.config.bot.access = { '*': open, ping: open, reload: open, 'learned.list': open };
  const { admin } = makeAdmin(rootDir, { hot });

  for (const key of ['ping', 'reload', 'learned.list']) {
    assert.equal(admin.isAllowed(key, { userId: '999', roleIds: [] }), false, key);
    assert.equal(admin.operationFor(key, {}), null, key);
    const owner = await admin.runCommand(key, {}, { guildId: 'g1', userId: '42', roleIds: [] });
    assert.equal(owner.status, 'invalid', `${key}: unknown even to the owner`);
    await assert.rejects(() => admin.run(key, {}, { guildId: 'g1' }), /unknown command/, key);
  }
});

test('runCommand: the full rights check -- a member granted memory.affinity.read reads, another is denied', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.bot.access = { 'memory.affinity.read': { everyone: false, roles: [], users: ['7'] } };
  const { admin } = makeAdmin(rootDir, { hot });
  const member = { guildId: 'g1', userId: '7', roleIds: [] };

  const other = await admin.runCommand('memory.affinity', { userId: '5' }, { guildId: 'g1', userId: '8', roleIds: [] });
  assert.equal(other.status, 'denied');
  assert.equal(other.code, 'not-granted');
  assert.equal(admin.isAllowed('memory.affinity', { userId: '7' }, {}), true);
  assert.equal(admin.isAllowed('memory.affinity', { userId: '8' }, {}), false);
  const unknown = await admin.runCommand('nonsense', {}, member);
  assert.equal(unknown.status, 'invalid');
});

test('isAllowed: pings is open to a member with no grant while features.memberCommands is on, read live', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const { admin } = makeAdmin(rootDir, { hot });

  assert.equal(admin.isAllowed('pings', { userId: '999', roleIds: [] }), true, 'no features key counts as on');
  hot.config.features = { memberCommands: false };
  assert.equal(admin.isAllowed('pings', { userId: '999', roleIds: [] }), false);
  assert.equal(admin.isAllowed('pings', { userId: '42', roleIds: [] }), true, 'an owner still passes');
  hot.config.features = { memberCommands: true };
  assert.equal(admin.isAllowed('pings', { userId: '999', roleIds: [] }), true);
  assert.equal(admin.isAllowed('status', { userId: '999', roleIds: [] }), false, 'it opens nothing else');
});

/** makeStore with the pings-off list of one guild, the way src/memory/store.js keeps it. */
function storeWithPings() {
  const store = makeStore();
  store.pingsOff = new Set();
  store.isPingsOff = (guildId, userId) => store.pingsOff.has(`${guildId}:${userId}`);
  store.setPingsOff = (guildId, userId, off) => {
    if (off) store.pingsOff.add(`${guildId}:${userId}`);
    else store.pingsOff.delete(`${guildId}:${userId}`);
    return store.pingsOff.has(`${guildId}:${userId}`);
  };
  return store;
}

test('run: pings with no mode shows the state of the caller; off and on change only the caller, in the guild of the interaction', async () => {
  const rootDir = makeRoot();
  const store = storeWithPings();
  const { admin } = makeAdmin(rootDir, { store });
  const context = { guildId: 'g1', channelId: 'c1', userId: '999' };

  assert.equal(await admin.run('pings', {}, context), 'Pings: on');
  assert.equal(await admin.run('pings', { mode: 'off' }, context), 'Pings: off');
  assert.equal(await admin.run('pings', { mode: undefined }, context), 'Pings: off');
  assert.deepEqual([...store.pingsOff], ['g1:999']);
  assert.equal(await admin.run('pings', {}, { ...context, userId: '777' }), 'Pings: on', 'another member is untouched');
  assert.equal(await admin.run('pings', { mode: 'on' }, context), 'Pings: on');
  assert.deepEqual([...store.pingsOff], []);
});

test('run: pings refuses an unknown mode, writing nothing', async () => {
  const rootDir = makeRoot();
  const store = storeWithPings();
  const { admin } = makeAdmin(rootDir, { store });

  await assert.rejects(
    () => admin.run('pings', { mode: 'maybe' }, { guildId: 'g1', userId: '999' }),
    /mode must be one of: on, off/
  );
  assert.deepEqual([...store.pingsOff], []);
});

test('run: pings works while paused, a change included, reading fresh off disk first', async () => {
  const rootDir = makeRoot();
  const store = storeWithPings();
  const { admin } = makeAdmin(rootDir, { store });
  const context = { guildId: 'g1', channelId: 'c1', userId: '999' };
  store.state.data.paused = true;

  assert.equal(await admin.run('pings', { mode: 'off' }, context), 'Pings: off');
  assert.equal(await admin.run('pings', {}, context), 'Pings: off');
  assert.deepEqual([...store.pingsOff], ['g1:999']);
  assert.equal(store.dropCachesCalls, 2, 'each call reads past the caches while paused');
});

test('run: access.grant refuses the pings operations, writing nothing', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await assert.rejects(
    () => admin.run('access.grant', { command: 'pings.set' }, {}),
    /pings\.set is open to every member and cannot be granted/
  );
  await assert.rejects(
    () => admin.run('access.grant', { command: 'pings' }, {}),
    /pings covers no grantable read operation/
  );
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
});

// ---------------------------------------------------------------------------
// access.grant / access.revoke / access.list
// ---------------------------------------------------------------------------

test('run: access.grant writes everyone, a role id or a user id and names the target as plain text in the reply', async () => {
  for (const [label, args, written, reply] of [
    [
      'no role/user grants everyone; a read operation gets no write note',
      { command: 'status.show' },
      { 'status.show': { everyone: true, roles: [], users: [] } },
      'Granted status.show to everyone (reload ok)',
    ],
    [
      'a role',
      { command: 'memory.profile.read', roleId: '123' },
      { 'memory.profile.read': { everyone: false, roles: ['123'], users: [] } },
      'Granted memory.profile.read to role id:123 (reload ok)',
    ],
    [
      'a user',
      { command: 'status.show', userId: '456' },
      { 'status.show': { everyone: false, roles: [], users: ['456'] } },
      'Granted status.show to user id:456 (reload ok)',
    ],
  ]) {
    const rootDir = makeRoot();
    const { admin } = makeAdmin(rootDir);

    const result = await admin.run('access.grant', args, {});

    assert.deepEqual(readLocal(rootDir), { bot: { access: written } }, label);
    assert.equal(result, reply, label);
  }
});

test('run: access.grant rejects both a role and a user at once, writing nothing', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await assert.rejects(
    () => admin.run('access.grant', { command: 'status.show', roleId: '1', userId: '2' }, {}),
    /give a role or a user, not both/
  );
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
});

test('run: access.grant rejects an unknown operation and an old command key, writing nothing', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await assert.rejects(() => admin.run('access.grant', { command: 'nonsense' }, {}), /unknown operation: nonsense/);
  await assert.rejects(
    () => admin.run('access.grant', { command: 'memory.show' }, {}),
    /unknown operation: memory\.show/
  );
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
});

test('run: access.list leaves out stale grants: owner-only operations and old command keys', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  const open = { everyone: true, roles: [], users: [] };
  fs.writeFileSync(
    path.join(rootDir, 'config.local.json'),
    JSON.stringify({
      bot: { access: { private: open, 'memory.private.read': open, status: open, 'status.show': open } },
    })
  );
  assert.equal(await admin.run('access.list', {}, {}), 'status.show: everyone');

  fs.writeFileSync(
    path.join(rootDir, 'config.local.json'),
    JSON.stringify({ bot: { access: { 'memory.private.read': open } } })
  );
  assert.equal(await admin.run('access.list', {}, {}), '(none)');
});

test('run: access.grant twice accumulates -- a second role does not drop the first', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await admin.run('access.grant', { command: 'status.show', roleId: '1' }, {});
  await admin.run('access.grant', { command: 'status.show', roleId: '2' }, {});

  assert.deepEqual(readLocal(rootDir), {
    bot: { access: { 'status.show': { everyone: false, roles: ['1', '2'], users: [] } } },
  });
});

test('run: access.revoke removes a previously granted role, dropping the entry once it is the last thing set', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await admin.run('access.grant', { command: 'status.show', roleId: '1' }, {});
  const result = await admin.run('access.revoke', { command: 'status.show', roleId: '1' }, {});

  assert.equal(result, 'Revoked status.show from role id:1 (reload ok)');
  assert.deepEqual(readLocal(rootDir), { bot: { access: {} } });
});

test('run: access.revoke with no role/user clears everyone, keeping any roles/users still set', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await admin.run('access.grant', { command: 'status.show' }, {});
  await admin.run('access.grant', { command: 'status.show', roleId: '1' }, {});
  const result = await admin.run('access.revoke', { command: 'status.show' }, {});

  assert.equal(result, 'Revoked status.show from everyone (reload ok)');
  assert.deepEqual(readLocal(rootDir), {
    bot: { access: { 'status.show': { everyone: false, roles: ['1'], users: [] } } },
  });
});

test('run: access grant/list/revoke/list round trip -- a group is stored as its read operations, named with their source', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  const reads = [
    'memory.profile.read',
    'memory.channel.read',
    'memory.server.read',
    'memory.recent.read',
    'memory.affinity.read',
  ];

  const granted = await admin.run('access.grant', { command: 'memory', roleId: 'staff' }, {});
  assert.equal(granted.split('\n')[0], `Granted memory to role id:staff as ${reads.join(', ')} (reload ok)`);
  assert.deepEqual(
    Object.keys(readLocal(rootDir).bot.access).sort(),
    [...reads].sort(),
    'no write, no owner-only op, not the pattern'
  );
  assert.equal(
    await admin.run('access.list', {}, {}),
    reads.map((name) => `${name}: role id:staff (expanded from memory, reads only)`).join('\n')
  );

  // a revoke of the pattern removes the target from every operation under it
  assert.equal(
    await admin.run('access.revoke', { command: 'memory', roleId: 'staff' }, {}),
    `Revoked memory (${reads.join(', ')}) from role id:staff (reload ok)`
  );
  assert.equal(await admin.run('access.list', {}, {}), '(none)');
  assert.equal(await admin.run('access.revoke', { command: 'memory', roleId: 'staff' }, {}), 'Nothing to revoke');
});

test("run: the owner's step after the migration -- revoke * everyone, then grant memory.profile.read everyone", async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  await admin.run('access.grant', { command: '*' }, {});
  await admin.run('access.grant', { command: 'config.set', userId: '9' }, {});

  await admin.run('access.revoke', { command: '*' }, {});
  await admin.run('access.grant', { command: 'memory.profile.read' }, {});

  assert.equal(await admin.run('access.list', {}, {}), 'config.set: user id:9\nmemory.profile.read: everyone');
});

test('migrateAccess: once per guild, the old command-key grants re-expanded under the operations, with a journal record', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.features = { journal: true };
  const journal = fakeJournal();
  const store = makeStore();
  store.updateGuild = (guildId, fields) => store.guilds.set(guildId, { ...store.getGuild(guildId), ...fields });
  const { admin } = makeAdmin(rootDir, { hot, journal, store });
  const open = { everyone: true, roles: [], users: [] };
  fs.writeFileSync(
    path.join(rootDir, 'config.local.json'),
    JSON.stringify({
      bot: {
        access: {
          memory: { everyone: false, roles: ['staff'], users: [] },
          set: { everyone: false, roles: [], users: ['9'] },
          'memory.journal': open,
          ping: open,
        },
      },
    })
  );

  assert.equal((await admin.migrateAccess('g1')).migrated, true);

  const access = readLocal(rootDir).bot.access;
  assert.deepEqual(access['memory.profile.read'], {
    everyone: false,
    roles: ['staff'],
    users: [],
    via: { 'role:staff': 'memory' },
  });
  assert.deepEqual(access['memory.affinity.read'].roles, ['staff']);
  assert.deepEqual(access['config.set'], { everyone: false, roles: [], users: ['9'] });
  for (const key of [
    'memory',
    'set',
    'memory.journal',
    'ping',
    'memory.journal.read',
    'memory.affinity.set',
    'memory.refresh.user',
  ]) {
    assert.equal(Object.hasOwn(access, key), false, key);
  }
  assert.equal(store.getGuild('g1').accessMigrated, 1);
  const records = journal.calls.filter(([kind]) => kind === 'system');
  assert.equal(records.length, 1);
  assert.equal(records[0][2].event, 'access-migrated');
  assert.match(
    records[0][2].note,
    /memory -> memory\.profile\.read, memory\.channel\.read, memory\.server\.read, memory\.recent\.read, memory\.affinity\.read/
  );
  assert.match(records[0][2].note, /memory\.journal -> nothing; dropped \(owner-only\): memory\.journal\.read/);
  assert.match(records[0][2].note, /ping -> nothing; dropped \(owner-only\): ping/);

  // once: the flag holds, nothing is rewritten or recorded again
  assert.equal((await admin.migrateAccess('g1')).migrated, false);
  assert.equal(journal.calls.filter(([kind]) => kind === 'system').length, 1);
  assert.deepEqual(readLocal(rootDir).bot.access, access);
});

test('access.grant: a write operation gets the write note; a read operation none; a group or * names what it covers and says writes stay closed', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  const writes = 'Note: this opens commands that change memory or config.';
  const readsOnly = 'Note: a group or * opens only the read operations that exist now; grant a write by its name.';

  for (const [command, roleId, notes] of [
    ['status.show', undefined, []],
    ['draw.create', undefined, [writes]],
    ['media.status', 'staff', []],
    ['media.rescan', 'staff', [writes]],
    ['media.recache', 'staff', [writes]],
    ['lore.add', 'staff', [writes]],
  ]) {
    const target = roleId ? `role id:${roleId}` : 'everyone';
    assert.equal(
      await admin.run('access.grant', { command, roleId }, {}),
      [`Granted ${command} to ${target} (reload ok)`, ...notes].join('\n'),
      command
    );
  }

  const star = (await admin.run('access.grant', { command: '*', roleId: 'mods' }, {})).split('\n');
  assert.match(star[0], /^Granted \* to role id:mods as status\.show, /);
  assert.equal(star[1], readsOnly);
  const access = readLocal(rootDir).bot.access;
  for (const name of ['draw.create', 'config.set', 'memory.journal.read', 'pings.get', 'access.list']) {
    assert.ok(!(access[name]?.roles ?? []).includes('mods'), `* never covers ${name}`);
  }
  assert.ok(access['memory.profile.read'].roles.includes('mods'));
});

// ---------------------------------------------------------------------------
// memory.show / memory.affinity
// ---------------------------------------------------------------------------

test('run: memory.affinity only reads -- the attitude changes through the memory analyzer alone, never by hand', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', affinity: { score: 12, reason: 'kind words', history: [] } });

  // a score in the arguments (an old caller) reaches no write: the view, the score as it was
  const result = await admin.run('memory.affinity', { userId: '123', score: 77, reason: 'by hand' }, { guildId: 'g1' });
  assert.ok(result.includes('score: 12'), result);
  assert.equal(store.getUser('g1', '123').affinity.score, 12);
  assert.equal(getOp('memory.affinity.set'), null, 'no operation sets it');
});

test('memory.affinity / alias.add / alias.remove: a member with no profile is refused and none is created', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  const writes = [];
  store.applyProfileOps = (...call) => writes.push(call);
  const adjustAffinity = store.adjustAffinity.bind(store);
  store.adjustAffinity = (...call) => {
    writes.push(call);
    return adjustAffinity(...call);
  };

  await assert.rejects(
    () => admin.run('memory.affinity', { userId: '555', score: 10 }, { guildId: 'g1' }),
    /^Error: no profile for 555$/
  );
  await assert.rejects(
    () => admin.run('alias.add', { userId: '555', name: 'Ari' }, { guildId: 'g1' }),
    /^Error: no profile for 555$/
  );
  await assert.rejects(
    () => admin.run('alias.remove', { userId: '555', name: 'Ari' }, { guildId: 'g1' }),
    /^Error: no profile for 555$/
  );
  assert.deepEqual(writes, []);
  assert.equal(store.getUser('g1', '555'), null);
});

test('run: memory.affinity falls back to the single served guild when context.guildId is absent', async () => {
  const rootDir = makeRoot();
  const client = { guilds: { cache: new Map([['g1', { id: 'g1', name: 'The Server' }]]) } };
  const { admin, store } = makeAdmin(rootDir, { client, getGuildId: () => 'g1' });
  store.profiles.set('g1:123', { id: '123', affinity: { score: 5, reason: 'ok so far', history: [] } });

  const result = await admin.run('memory.affinity', { userId: '123' }, {});
  assert.ok(result.includes('score: 5'));
});

// ---------------------------------------------------------------------------
// private.show and the private-aware memory commands
// ---------------------------------------------------------------------------

function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

function samplePrivate(overrides = {}) {
  return {
    relationship: 'trusts the persona with plans',
    interests: [
      {
        topic: 'astronomy',
        note: 'owns a telescope',
        weight: 3,
        firstSeen: '2026-09-01T00:00:00.000Z',
        lastSeen: '2026-09-20T00:00:00.000Z',
      },
    ],
    details: [
      {
        id: 1,
        text: 'studies at night',
        weight: 2,
        firstSeen: '2026-09-01T00:00:00.000Z',
        lastSeen: '2026-09-10T00:00:00.000Z',
      },
    ],
    detailsSeq: 2,
    episodes: [
      {
        date: '2026-09-15',
        what: 'shared a café story',
        quote: 'crème brûlée',
        weight: 2,
        addedAt: '2026-09-15T00:00:00.000Z',
      },
    ],
    affinity: { score: 12, reason: 'kind in private', history: [] },
    firstSeen: '2026-09-01T00:00:00.000Z',
    lastSeen: '2026-09-20T00:00:00.000Z',
    replies: { day: utcToday(), count: 7, noticedDay: '' },
    buffer: [
      { id: 'm1', content: 'SECRET-BUFFERED-TEXT', ts: 1 },
      { id: 'm2', content: 'another buffered line', ts: 2 },
    ],
    ...overrides,
  };
}

test('run: private.show renders the private layer under the public name, with both scores and replies', async () => {
  const rootDir = makeRoot();
  const { admin, hot, store } = makeAdmin(rootDir);
  hot.config.private = { maxPerUserPerDay: 100, maxPerOwnerPerDay: 200 };
  store.profiles.set('g1:123', {
    id: '123',
    names: ['Zoé', 'old name'],
    affinity: { score: 50, reason: 'public reason', history: [] },
  });
  store.privates.set('g1:123', samplePrivate());

  const result = await admin.run('memory.private', { action: 'show', userId: '123' }, { guildId: 'g1' });

  assert.match(result.split('\n')[0], /Zoé/);
  assert.match(result, /trusts the persona with plans/);
  assert.match(result, /astronomy/);
  assert.match(result, /owns a telescope/);
  assert.match(result, /studies at night/);
  assert.match(result, /shared a café story/);
  assert.match(result, /private affinity: 12\b/);
  assert.match(result, /kind in private/);
  assert.match(result, /effective affinity: 62\b/);
  assert.match(result, /replies today: 7 \/ 100/);
  assert.ok(!result.includes('SECRET-BUFFERED-TEXT'), 'the buffer contents are never shown');
  assert.ok(!result.includes('another buffered line'), 'the buffer contents are never shown');
  assert.ok(!result.includes('public reason'), 'the public affinity reason is not part of the private view');
});

test('run: private.show clamps the effective score and uses the owner cap for an owner', async () => {
  const rootDir = makeRoot();
  const { admin, hot, store } = makeAdmin(rootDir);
  hot.config.private = { maxPerUserPerDay: 100, maxPerOwnerPerDay: 200 };
  store.profiles.set('g1:42', { id: '42', names: ['Owner'], affinity: { score: 90, reason: '', history: [] } });
  store.privates.set('g1:42', samplePrivate({ affinity: { score: 30, reason: '', history: [] } }));

  const result = await admin.run('memory.private', { action: 'show', userId: '42' }, { guildId: 'g1' });

  assert.match(result, /effective affinity: 100\b/);
  assert.match(result, /replies today: 7 \/ 200/);
});

test('run: private.show counts replies stored for another day as 0 today', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', names: ['Zoé'] });
  store.privates.set('g1:123', samplePrivate({ replies: { day: '2000-01-01', count: 55, noticedDay: '' } }));

  const result = await admin.run('memory.private', { action: 'show', userId: '123' }, { guildId: 'g1' });

  assert.match(result, /replies today: 0\b/);
  assert.ok(!result.includes('55'));
});

test('run: private.show needs a user and a resolved guild', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  await assert.rejects(() => admin.run('memory.private', { action: 'show' }, { guildId: 'g1' }), /a user is required/);

  const { admin: unresolved } = makeAdmin(rootDir, { getGuildId: () => null });
  await assert.rejects(
    () => unresolved.run('memory.private', { action: 'show', userId: '123' }, {}),
    /no guild resolved yet/
  );
});

test('run: memory.show never shows the private layer', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', {
    id: '123',
    names: ['Zoé'],
    relationship: 'public text',
    affinity: { score: 50, reason: '', history: [] },
  });
  store.privates.set('g1:123', samplePrivate());

  const summary = await admin.run('memory.show', { userId: '123' }, { guildId: 'g1' });
  const raw = await admin.run('memory.show', { userId: '123', section: 'raw' }, { guildId: 'g1' });
  for (const text of [summary, raw]) {
    assert.ok(!text.includes('trusts the persona with plans'));
    assert.ok(!text.includes('astronomy'));
  }
});

function clientWithGuild(guildId, name) {
  return { guilds: { cache: new Map([[guildId, { id: guildId, name }]]) } };
}

// The following memory.show tests exercise `section: 'raw'` (see
// src/admin.js#rawMemoryShowView). The other sections are covered further
// below.

test('run: memory.show section:raw also prints the stored episodes (date, weight, what, quote)', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', {
    id: '123',
    episodes: [
      { date: '2026-01-01', what: 'promised to help', quote: 'I got you', feeling: 'touched', weight: 4, addedAt: 'x' },
    ],
  });

  const result = await admin.run('memory.show', { userId: '123', section: 'raw' }, { guildId: 'g1' });

  assert.ok(result.includes('episodes:'));
  assert.ok(result.includes('2026-01-01'));
  assert.ok(result.includes('weight 4'));
  assert.ok(result.includes('promised to help'));
  assert.ok(result.includes('I got you'));
});

test('run: memory.show section:raw lists every stored interest in rank order and marks the divider between shown and hidden', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.memory = { maxInterests: 1, interestHalfLifeDays: 180 };
  const { admin, store } = makeAdmin(rootDir, { hot });
  store.profiles.set('g1:123', {
    id: '123',
    interests: [
      { topic: 'Ancient favorite', note: '', weight: 10, firstSeen: 'a', lastSeen: '2021-01-01T00:00:00.000Z' },
      { topic: 'Fresh interest', note: '', weight: 1, firstSeen: 'a', lastSeen: '2026-09-20T00:00:00.000Z' },
    ],
  });

  const result = await admin.run('memory.show', { userId: '123', section: 'raw' }, { guildId: 'g1' });

  assert.ok(result.includes('Fresh interest'), 'both stored interests are listed');
  assert.ok(result.includes('Ancient favorite'));
  const lines = result.split('\n');
  const freshLine = lines.findIndex((l) => l.trim().startsWith('Fresh interest [weight'));
  const dividerLine = lines.findIndex((l) => l.includes('not shown'));
  const ancientLine = lines.findIndex((l) => l.trim().startsWith('Ancient favorite [weight'));
  assert.ok(
    freshLine >= 0 && dividerLine > freshLine && ancientLine > dividerLine,
    'the freshest ranks first, above the divider; the ancient heavy one sits below it'
  );
});

// ---------------------------------------------------------------------------
// memory.show -- sectioned view: summary (default), character/style/
// relationship, affinity, aliases/interests/details/episodes with order/limit
// ---------------------------------------------------------------------------

test('run: memory.show order:recent sorts a list section newest lastSeen first, no divider', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', {
    id: '123',
    interests: [
      { topic: 'Old', note: '', weight: 5, firstSeen: 'a', lastSeen: '2020-01-01T00:00:00.000Z' },
      { topic: 'New', note: '', weight: 1, firstSeen: 'a', lastSeen: '2026-09-01T00:00:00.000Z' },
    ],
  });

  const result = await admin.run(
    'memory.show',
    { userId: '123', section: 'interests', order: 'recent' },
    { guildId: 'g1' }
  );
  const lines = result.split('\n');
  assert.ok(lines[0].startsWith('New'), 'the newer lastSeen sorts first under order:recent');
  assert.ok(lines[1].startsWith('Old'));
  assert.ok(!result.includes('not shown'), 'order:recent never shows the shown/stored divider');
});

test('run: memory.show respects a custom limit, capping a list section', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', {
    id: '123',
    interests: Array.from({ length: 5 }, (_, i) => ({
      topic: `T${i}`,
      note: '',
      weight: 1,
      firstSeen: 'a',
      lastSeen: 'a',
    })),
  });

  const result = await admin.run('memory.show', { userId: '123', section: 'interests', limit: 2 }, { guildId: 'g1' });
  assert.equal(result.split('\n').length, 2);
});

// ---------------------------------------------------------------------------
// alias.add / alias.remove -- real store.js/aliases.js,
// so these prove the actual store integration, not a re-implementation.
// ---------------------------------------------------------------------------

function makeRealStoreAdmin(rootDir, extra = {}) {
  const dataDir = tempDir('nep-admin-alias-');
  const realStore = createStore({ dataDir });
  const hot = extra.hot ?? makeHot(rootDir);
  const { admin } = makeAdmin(rootDir, { ...extra, hot, store: realStore });
  return { admin, store: realStore, hot, dataDir };
}

test('run: alias.add creates a new alias already confirmed, firstSeen == lastSeen == now', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.memory = { confirmAfter: 3 };
  const { admin, store, dataDir } = makeRealStoreAdmin(rootDir, { hot });
  try {
    store.touchUser('g1', '123', 'Bob', Date.now());
    const before = Date.now();
    await admin.run('alias.add', { userId: '123', name: 'Ari' }, { guildId: 'g1' });
    const after = Date.now();

    const alias = store.getUser('g1', '123').aliases.find((a) => a.name === 'Ari');
    assert.ok(alias, 'the alias was stored');
    assert.ok(alias.weight >= 3, 'confirmed at once (memory.confirmAfter is 3 in this test)');
    assert.equal(alias.firstSeen, alias.lastSeen, 'firstSeen and lastSeen land on the same instant');
    const seenMs = Date.parse(alias.lastSeen);
    assert.ok(seenMs >= before && seenMs <= after, 'that instant is "now"');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('run: alias.add reads memory.confirmAfter and gives at least that weight', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.memory = { confirmAfter: 4 };
  const { admin, store, dataDir } = makeRealStoreAdmin(rootDir, { hot });
  try {
    store.touchUser('g1', '123', 'Bob', Date.now());
    await admin.run('alias.add', { userId: '123', name: 'Ari' }, { guildId: 'g1' });
    const alias = store.getUser('g1', '123').aliases.find((a) => a.name === 'Ari');
    assert.ok(alias.weight >= 4);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('run: alias.add is idempotent -- a second call does not keep bumping the weight', async () => {
  const rootDir = makeRoot();
  const { admin, store, dataDir } = makeRealStoreAdmin(rootDir);
  try {
    store.touchUser('g1', '123', 'Bob', Date.now());
    await admin.run('alias.add', { userId: '123', name: 'Ari' }, { guildId: 'g1' });
    const weightAfterFirst = store.getUser('g1', '123').aliases.find((a) => a.name === 'Ari').weight;

    await admin.run('alias.add', { userId: '123', name: 'Ari' }, { guildId: 'g1' });
    const weightAfterSecond = store.getUser('g1', '123').aliases.find((a) => a.name === 'Ari').weight;

    assert.equal(weightAfterSecond, weightAfterFirst, 'already-confirmed alias is left alone by a repeat add');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('run: alias.add leaves the 40-character clamp to the store, boundary-safe, and stays idempotent', async () => {
  const rootDir = makeRoot();
  const { admin, store, dataDir } = makeRealStoreAdmin(rootDir);
  try {
    store.touchUser('g1', '123', 'Bob', Date.now());
    const longName = 'x'.repeat(60);
    await admin.run('alias.add', { userId: '123', name: longName }, { guildId: 'g1' });
    const [alias] = store.getUser('g1', '123').aliases;
    assert.equal(alias.name.length, 40);
    assert.equal(alias.name, 'x'.repeat(40));
    const weight = alias.weight;
    await admin.run('alias.add', { userId: '123', name: longName }, { guildId: 'g1' });
    assert.equal(store.getUser('g1', '123').aliases[0].weight, weight, 'a repeat add of the long name is left alone');

    // 39 letters, then a mathematical Greek omega (two UTF-16 units) right at the 40th position.
    const astral = `${'y'.repeat(39)}\u{1D6C0}tail`;
    await admin.run('alias.add', { userId: '123', name: astral }, { guildId: 'g1' });
    const stored = store.getUser('g1', '123').aliases.find((a) => a.name.startsWith('y'));
    assert.ok(stored, 'the long name was stored');
    assert.ok(!/[\uD800-\uDBFF]$/.test(stored.name), 'never cut inside a surrogate pair');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("run: alias.add ignores a name equal, case-insensitively, to one of the member's display names", async () => {
  const rootDir = makeRoot();
  const { admin, store, dataDir } = makeRealStoreAdmin(rootDir);
  try {
    store.touchUser('g1', '123', 'Bob', Date.now());
    const result = await admin.run('alias.add', { userId: '123', name: 'bob' }, { guildId: 'g1' });
    assert.deepEqual(store.getUser('g1', '123').aliases, []);
    assert.equal(result, '(none)');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('run: alias.remove removes an alias case-insensitively and reports the resulting list', async () => {
  const rootDir = makeRoot();
  const { admin, store, dataDir } = makeRealStoreAdmin(rootDir);
  try {
    store.touchUser('g1', '123', 'Bob', Date.now());
    await admin.run('alias.add', { userId: '123', name: 'Ari' }, { guildId: 'g1' });
    const result = await admin.run('alias.remove', { userId: '123', name: 'ARI' }, { guildId: 'g1' });

    assert.deepEqual(store.getUser('g1', '123').aliases, []);
    assert.equal(result, '(none)');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('run: alias.add/alias.remove are refused while paused', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await admin.run('pause', {}, {});

  await assert.rejects(
    () => admin.run('alias.add', { userId: '123', name: 'Ari' }, { guildId: 'g1' }),
    /paused.*resume/i
  );
  await assert.rejects(
    () => admin.run('alias.remove', { userId: '123', name: 'Ari' }, { guildId: 'g1' }),
    /paused.*resume/i
  );
});

// ---------------------------------------------------------------------------
// learned.list / learned.add / learned.remove -- real store.js/details.js,
// the guild's list of things people taught the persona.
// ---------------------------------------------------------------------------

const LEARNED_DAY = (iso) => Date.parse(`${iso}T12:00:00.000Z`);

test('run: learned.add stores a new item without from, confirmed at once (memory.confirmAfter 3), firstSeen == lastSeen == now', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.memory = { confirmAfter: 3 };
  const { admin, store, dataDir } = makeRealStoreAdmin(rootDir, { hot });
  try {
    const before = Date.now();
    await admin.run('learning.add', { text: '  ο φάρος ανάβει στις εννιά  ' }, { guildId: 'g1' });
    const after = Date.now();
    const learned = store.getGuild('g1').learned;
    assert.equal(learned.length, 1);
    const [item] = learned;
    assert.equal(item.text, 'ο φάρος ανάβει στις εννιά');
    assert.equal(item.weight, 3, 'confirmed at once, and no further');
    assert.equal('from' in item, false);
    assert.equal(item.firstSeen, item.lastSeen, 'every sighting lands on the same instant');
    const seenMs = Date.parse(item.lastSeen);
    assert.ok(seenMs >= before && seenMs <= after);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('run: learned.add reads memory.confirmAfter and confirms up to exactly that weight', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.memory = { confirmAfter: 4 };
  const { admin, store, dataDir } = makeRealStoreAdmin(rootDir, { hot });
  try {
    await admin.run('learning.add', { text: 'crème brûlée' }, { guildId: 'g1' });
    assert.equal(store.getGuild('g1').learned[0].weight, 4);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('run: learned.add confirms an existing unconfirmed item in place (same id and text)', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.memory = { confirmAfter: 3 };
  const { admin, store, dataDir } = makeRealStoreAdmin(rootDir, { hot });
  try {
    store.applyLearnedOps('g1', { add: ['Ο Φάρος'] }, { seenAt: LEARNED_DAY('2026-09-01') });
    await admin.run('learning.add', { text: 'ο φάρος' }, { guildId: 'g1' });
    const learned = store.getGuild('g1').learned;
    assert.equal(learned.length, 1);
    assert.equal(learned[0].id, 1);
    assert.equal(learned[0].weight, 3);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('run: a repeat learned.add of a confirmed item is one ordinary sighting, never more', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.memory = { confirmAfter: 3, confirmGapHours: 12 };
  const { admin, store, dataDir } = makeRealStoreAdmin(rootDir, { hot });
  try {
    await admin.run('learning.add', { text: 'première' }, { guildId: 'g1' });
    assert.equal(store.getGuild('g1').learned[0].weight, 3);

    // Within confirmGapHours: a sighting would not bump it, so neither does the repeat.
    await admin.run('learning.add', { text: 'Première' }, { guildId: 'g1' });
    assert.equal(store.getGuild('g1').learned[0].weight, 3);

    // With no gap required, a sighting bumps by exactly one -- and so does the repeat.
    hot.config.memory = { confirmAfter: 3, confirmGapHours: 0 };
    await admin.run('learning.add', { text: 'première' }, { guildId: 'g1' });
    const learned = store.getGuild('g1').learned;
    assert.equal(learned.length, 1);
    assert.equal(learned[0].weight, 4);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('run: learned.remove deletes the item by id and reports it', async () => {
  const rootDir = makeRoot();
  const { admin, store, dataDir } = makeRealStoreAdmin(rootDir);
  try {
    store.applyLearnedOps('g1', { add: ['première', 'δεύτερο'] }, { seenAt: LEARNED_DAY('2026-09-01') });
    const result = await admin.run('learning.remove', { id: 1 }, { guildId: 'g1' });
    assert.deepEqual(
      store.getGuild('g1').learned.map((i) => i.id),
      [2]
    );
    assert.match(result, /#1/);
    assert.match(result, /première/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('run: learned.add/learned.remove are refused while paused', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await admin.run('pause', {}, {});

  await assert.rejects(() => admin.run('learning.add', { text: 'première' }, { guildId: 'g1' }), /paused.*resume/i);
  await assert.rejects(() => admin.run('learning.remove', { id: 1 }, { guildId: 'g1' }), /paused.*resume/i);
});

// ---------------------------------------------------------------------------
// lore: add / list / show / remove
// ---------------------------------------------------------------------------

test('run: lore.add saves an owner entry, splitting comma-separated keys', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);

  const result = await admin.run(
    'lore.add',
    { title: 'Founders Day', keys: ' founders , founding day ', text: 'The server was founded then.' },
    { guildId: 'g1' }
  );

  assert.ok(result.includes('Founders Day'));
  const [entry] = store.getLore('g1');
  assert.equal(entry.title, 'Founders Day');
  assert.deepEqual(entry.keys, ['founders', 'founding day']);
  assert.equal(entry.source, 'owner');
});

test('run: lore.add overwrites an existing analyzer entry and it becomes an owner entry', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.setLore('g1', [{ title: 'Founders Day', keys: ['founders'], text: 'analyzer text' }], {
    source: 'analyzer',
    now: 1000,
  });

  await admin.run(
    'lore.add',
    { title: 'Founders Day', keys: 'founders', text: 'owner text', always: true },
    { guildId: 'g1' }
  );

  const [entry] = store.getLore('g1');
  assert.equal(entry.text, 'owner text');
  assert.equal(entry.source, 'owner');
  assert.equal(entry.always, true);
});

test('run: lore.remove deletes an entry by id and reports its title', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.setLore('g1', [{ title: 'The Flood', keys: ['flood'], text: 'It flooded.' }], {
    source: 'analyzer',
    now: 1000,
  });
  const [{ id }] = store.getLore('g1');

  const result = await admin.run('lore.remove', { id }, { guildId: 'g1' });
  assert.ok(result.includes('The Flood'));
  assert.deepEqual(store.getLore('g1'), []);
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

test('status: the card carries the fields in order and the member variant drops the storage line, memory and speed', async () => {
  const rootDir = makeRoot();
  const journalDir = tempDir('nep-status-journal-');
  const dayFile = path.join(journalDir, 'today.jsonl');
  fs.writeFileSync(dayFile, '{}\n');
  const journal = { dayFile: () => dayFile, stalled: () => true };
  const archive = { stats: () => ({ pending: 3 }) };
  const client = { ws: { ping: 41.6 }, guilds: { cache: new Map() } };
  const { admin, hot, store } = makeAdmin(rootDir, { journal, archive, client });
  hot.config.media = { video: { maxPerDay: 40 } };
  hot.config.recall = { maxPerDay: 100 };
  hot.config.web = { maxPerDay: 60 };
  hot.config.context = { ...hot.config.context, channelMessages: 60 };
  store.state.data.paused = true;
  store.state.data.pausedAt = '2026-10-13T08:30:00.000Z';
  store.state.data.pausedBy = '42';

  const owner = await admin.run('status', {}, { userId: '42' });
  assert.equal(owner.text, '', 'the card alone, no long form');
  assert.equal(owner.embeds.length, 1);
  const fields = owner.embeds[0].fields;
  assert.deepEqual(
    fields.map((f) => f.name),
    [
      'state',
      'tasks',
      'models.base',
      'keys.base',
      'costs.base',
      'models.errands',
      'costs.errands',
      'models.development',
      'costs.development',
      'limits',
      'memory',
      'speed',
    ]
  );
  const value = (name) => fields.find((f) => f.name === name).value;
  const stateLines = value('state').split('\n');
  assert.deepEqual(
    stateLines.slice(0, 3),
    [
      'paused since 2026-10-13 08:30 UTC by <@42>',
      'storage: append store stalled; 3 archive copies pending',
      // The gateway's latency is no longer shown (the interface gives the core no such figure): the connection field
      // is the last reconnect alone.
      'last reconnect none',
    ],
    'the state, then the connection'
  );
  assert.match(stateLines[3], /^uptime (\d+d )?(\d+h )?\d+m$/, 'the uptime last');
  assert.equal(stateLines.length, 4);
  assert.equal(value('tasks'), 'archive drain: 3 pending');
  assert.equal(
    value('models.base'),
    [
      'core · anthropic/claude-opus-4.6',
      `memory · ${ROLE_DEFAULTS.core}`,
      `analyzer · ${ROLE_DEFAULTS.analyzer}`,
      `vision · ${ROLE_DEFAULTS.vision}`,
      `video · ${ROLE_DEFAULTS.video}`,
      `embedding · ${ROLE_DEFAULTS.embedding}`,
      `speech · ${ROLE_DEFAULTS.speech}`,
      `drawing · ${ROLE_DEFAULTS.drawing}`,
    ].join('\n'),
    'no llm client: one line per base role with its own model, unprobed, drawing last'
  );
  assert.equal(
    value('models.errands'),
    [`scout · ${ROLE_DEFAULTS.scout}`, `server · ${ROLE_DEFAULTS.server}`].join('\n'),
    'one line per errand role with its own model'
  );
  assert.equal(
    value('models.development'),
    [`thinker · ${ROLE_DEFAULTS.thinker}`, `dev · ${ROLE_DEFAULTS.dev}`].join('\n'),
    'one line per development role with its own model'
  );
  assert.match(value('limits'), /^requests \d+\/300\nvideos 0\/40\nrecall 0\/100\nlookups 0\/60\nresets 00:00 UTC$/);
  assert.deepEqual(
    value('memory')
      .split('\n')
      .map((line) => line.slice(0, line.indexOf(':'))),
    [
      'chat window',
      'record',
      'index',
      'archive',
      'profiles',
      'server notes',
      'channels',
      'recent lines',
      'participation fragments',
    ]
  );
  assert.match(value('memory'), /^chat window: last 60 messages in the active channel\n/);
  assert.ok(!/buffer|pending|journal/.test(value('memory')), 'no buffer, archive queue or journal line in memory');
  assert.equal(value('speed'), 'not available', 'no metrics wired');
  for (const field of fields) assert.ok(field.value.length > 0 && field.value.length <= 1024, field.name);

  const member = await admin.run('status', {}, { userId: '999' });
  const memberFields = member.embeds[0].fields;
  assert.deepEqual(
    memberFields.map((f) => f.name),
    ['state', 'tasks', 'models.base', 'models.errands', 'models.development', 'limits']
  );
  assert.deepEqual(
    memberFields[0].value.split('\n').slice(0, 2),
    ['paused since 2026-10-13 08:30 UTC by <@42>', 'last reconnect none'],
    'no storage line for a member'
  );
  assert.equal(member.text, '', 'a member never gets the long form');
});

test('status: the owner card shows the limit of each key with its usage under it, then today by role, with no credits read; a member gets neither field and no read', async () => {
  const rootDir = makeRoot();
  const reads = [];
  const key = {
    label: 'sk-or-v1-hidden',
    limit: 30,
    limit_reset: 'daily',
    budgets: [
      {
        scope: 'key_limit',
        limit_usd: 30,
        spend_usd: 8.45,
        reset_interval: 'daily',
        resets_at: '2026-10-16T00:00:00.000Z',
        include_byok: true,
      },
    ],
    usage_daily: 0.1,
  };
  const llm = {
    async keyInfo(options) {
      reads.push(['key', options?.timeoutMs]);
      return { ok: true, status: 200, json: { data: key } };
    },
    async credits() {
      reads.push(['credits']);
      return { ok: true, status: 200, json: { data: {} } };
    },
  };
  let rows = [
    { role: 'core', requests: 38, promptTokens: 974_000, cachedTokens: 342_000, completionTokens: 9_300, cost: 4.03 },
  ];
  const usage = { byRole: () => rows };
  const { admin, hot } = makeAdmin(rootDir, { llm, usage });
  hot.prompts.labels = labels;
  hot.config.llm.probeTimeoutMs = 1234;

  const fieldOf = async (name) =>
    (await admin.run('status', {}, { userId: '42' })).embeds[0].fields.find((f) => f.name === name).value;
  assert.deepEqual((await fieldOf('keys.base')).split('\n'), [
    'main 8.45/30.00 USD (resets daily at 2026-10-16 00:00 UTC; BYOK in)',
    'usage day 0.10 USD',
    'sim: not set',
  ]);
  assert.deepEqual(
    (await fieldOf('costs.base')).split('\n'),
    ['core: 38 req, in 974k (cached 342k), out 9.3k, 4.03 USD'],
    'no header, no total'
  );
  assert.deepEqual(
    reads,
    [
      ['key', 1234],
      ['key', 1234],
    ],
    'the key read with the probe timeout, once per card; never the credits'
  );

  // Too many roles for one field: whole lines are cut from the bottom.
  rows = Array.from({ length: 40 }, (_, i) => ({
    role: `role-${i}`,
    requests: 1,
    promptTokens: 1000,
    cachedTokens: 0,
    completionTokens: 10,
    cost: 0.01,
  }));
  const long = await fieldOf('costs.base');
  assert.ok(long.length <= 1024);
  assert.match(
    long.split('\n').at(-1),
    /^role-\d+: 1 req, in 1\.0k \(cached 0\), out 10, 0\.01 USD$/,
    'the last line is whole'
  );
  rows = [];
  assert.equal(await fieldOf('costs.base'), 'today by role: none');

  const member = await admin.run('status', {}, { userId: '999' });
  assert.ok(!member.embeds[0].fields.some((f) => f.name.startsWith('costs')), 'no costs field for a member');
  assert.equal(reads.length, 4, 'a member card sends no account read');
});

test('status: the field option renders that field alone and runs only its work', async () => {
  const rootDir = makeRoot();
  const reads = [];
  const llm = fakeProbeLlm(() => ({ provider: 'Prov' }));
  llm.keyInfo = async () => {
    reads.push('key');
    return { ok: true, status: 200, json: { data: { limit: 10, limit_remaining: 10 } } };
  };
  llm.activity = async () => {
    reads.push('activity');
    return { ok: true, status: 200, json: { data: [] } };
  };
  llm.keyHash = () => 'h';
  const usage = {
    byRole: () => [{ role: 'core', requests: 1, promptTokens: 1, cachedTokens: 0, completionTokens: 1, cost: 0.5 }],
  };
  const { admin, hot } = makeAdmin(rootDir, {
    llm,
    usage,
    images: fakeImages({ quota: { used: 0, cap: 5 } }),
    managementKey: 'mgmt-test',
  });
  probeConfig(hot);
  hot.prompts.labels.status.costs = labels.status.costs;
  hot.config.llm.maxRequestsPerDay = 300;

  const only = async (field, userId = '42') => (await admin.run('status', { field }, { userId })).embeds[0].fields;
  const limits = await only('limits');
  assert.deepEqual(
    limits.map((f) => f.name),
    ['limits']
  );
  assert.match(limits[0].value, /^requests \d+\/300\n/);
  assert.deepEqual(
    [llm.calls.length, llm.listings.length, reads.length],
    [0, 0, 0],
    'no probe, no listing, no key read'
  );

  assert.deepEqual(
    (await only('costs.base')).map((f) => f.name),
    ['costs.base']
  );
  assert.deepEqual([llm.calls.length, reads.length], [0, 0], 'the role costs read no key');

  const keys = await only('keys.base');
  assert.deepEqual(
    keys.map((f) => f.name),
    ['keys.base']
  );
  assert.deepEqual(reads.sort(), ['activity', 'key'], 'the key and its activity read once each');
  assert.equal(llm.calls.length, 0, 'no model probe for the key field');

  assert.deepEqual(
    (await only('models.errands')).map((f) => f.name),
    ['models.errands']
  );
  assert.deepEqual(
    (await only('models.development')).map((f) => f.name),
    ['models.development']
  );
  assert.deepEqual([llm.calls.length, llm.listings.length], [0, 0], 'the errand and development fields probe nothing');
  assert.deepEqual(
    (await only('models.base')).map((f) => f.name),
    ['models.base']
  );
  assert.ok(llm.calls.length > 0, 'the models.base field probes');
  assert.equal(llm.listings.length, 1, 'the models.base field reads the drawing listing');

  // An owner-only field asked by a member, or an unknown one: the whole card the caller may see.
  hot.config.bot.access = { 'status.show': { everyone: true, roles: [], users: [] } };
  assert.deepEqual(
    (await only('memory', '999')).map((f) => f.name),
    ['state', 'tasks', 'models.base', 'models.errands', 'models.development', 'limits']
  );
  assert.equal((await only('nonsense')).length, 12);
});

/** A clock the test moves by hand. */
function handClock(start) {
  const state = { at: start };
  const now = () => state.at;
  now.advance = (ms) => {
    state.at += ms;
  };
  return now;
}

test('status: the memory field shows the coverage of every kind of memory, computed at most once a minute', async () => {
  const rootDir = makeRoot();
  const now = handClock(Date.parse('2026-10-14T12:00:00.000Z'));
  // The record: four messages on four days since the first one.
  const record = { stats: async () => ({ messages: 4, days: 4, first: '2026-09-30' }) };
  const archiveEntries = [
    { event: 'backfill', observedAt: { date: '2026-03-01', precision: 'day' } },
    { event: 'evicted', observedAt: { date: '2026-10-13T10:00:00.000Z', precision: 'time' } },
    { event: 'evicted', observedAt: { date: '2026-05-02', precision: 'day' } },
    { event: 'replaced', observedAt: { date: '2026-06-01', precision: 'approx' } },
  ];
  const archive = {
    stats: () => ({ pending: 0 }),
    async *iterate() {
      yield* archiveEntries;
    },
  };
  const coverageAsked = [];
  const embedQueue = {
    async indexSummary() {
      return { rows: 1234, missing: 5 };
    },
    async coverage(guildId, options) {
      coverageAsked.push([guildId, options.hours]);
      return { messages: 200, indexed: 150, missing: 50, oldestMissing: '2026-10-12T08:00:00.000Z' };
    },
  };
  const { admin, hot, store } = makeAdmin(rootDir, { record, archive, embedQueue, now });
  hot.config.features = { meaningSearch: true, embedIndex: true };
  hot.config.embed = { catchUpHours: 48 };
  store.profiles.set('g1:u1', {
    id: 'u1',
    character: 'Ήσυχη και αστεία',
    episodes: [{}, {}, {}],
    details: [{}, {}],
    aliases: [{}],
    realName: { name: 'Éloïse' },
  });
  store.profiles.set('g1:u2', { id: 'u2', character: '', episodes: [{}], details: [], aliases: [] });
  store.profiles.set('g1:u3', { id: 'u3', character: 'Ζωηρός', episodes: [], details: [], aliases: [] });
  store.lore.set('g1', [{ id: 1 }, { id: 2 }]);
  store.guilds.set('g1', {
    patterns: '',
    starters: '',
    injokes: ['α', 'β'],
    self: ['γ'],
    learned: [{}, {}, {}],
    updatedAt: null,
  });
  store.channels.set('g1:c1', { id: 'c1', purpose: 'chat', topics: '', tone: '' });
  store.channels.set('g1:c2', { id: 'c2', purpose: '', topics: '', tone: '' });
  store.channels.set('g1:c3', { id: 'c3', purpose: '', topics: '', tone: 'calm' });
  store.channels.set('g1:c4', { id: 'c4' });
  store.recent.set('g1', {
    nextId: 3,
    lines: [{ at: Date.parse('2026-10-12T10:00:00.000Z') }, { at: Date.parse('2026-10-14T09:00:00.000Z') }],
  });
  store.participation.set('g1', {
    nextId: 3,
    episodes: [
      { startAt: Date.parse('2026-10-13T23:00:00.000Z'), lastAt: Date.parse('2026-10-14T01:00:00.000Z') },
      { startAt: Date.parse('2026-10-10T10:00:00.000Z'), lastAt: Date.parse('2026-10-10T11:00:00.000Z') },
    ],
  });
  const memoryLines = async () =>
    (await admin.run('status', {}, { userId: '42' })).embeds[0].fields
      .find((f) => f.name === 'memory')
      .value.split('\n');

  assert.deepEqual(await memoryLines(), [
    'record: 4 messages · 2026-09-30..2026-10-14 · 27% of days have lines',
    'index: 1234 rows · 75% of record messages indexed (last 48 h) · oldest missing 2026-10-12',
    'archive: 4 entries · evicted 2, replaced 1, backfill 1 · observed 2026-03-01..2026-10-13',
    'profiles: 3 · 67% with a portrait · 4 episodes (1.3 per profile) · 2 details · 1 aliases · 1 real names set',
    'server notes: 2 lore entries · 3 lessons · 1 self facts · 2 in-jokes',
    'channels: 2 with notes / 4 seen (50%)',
    'recent lines: 2 · 2026-10-12..2026-10-14',
    'participation fragments: 2 · 2026-10-10..2026-10-14',
  ]);
  assert.deepEqual(coverageAsked, [['g1', 48]]);

  // Within the minute the cached field is shown, whatever changed.
  store.profiles.set('g1:u4', { id: 'u4', character: 'Νέος', episodes: [], details: [], aliases: [] });
  now.advance(30_000);
  assert.equal((await memoryLines())[3].split(' · ')[0], 'profiles: 3', 'cached');
  assert.equal(coverageAsked.length, 1, 'no second coverage read');
  now.advance(31_000);
  assert.equal((await memoryLines())[3].split(' · ')[0], 'profiles: 4', 'a minute later it is read again');
  assert.equal(coverageAsked.length, 2);

  hot.config.features = { meaningSearch: true, embedIndex: false };
  now.advance(61_000);
  assert.equal((await memoryLines())[1], 'index: off', 'one index switch off');
  embedQueue.coverage = async () => ({ messages: 0, indexed: 0, missing: 0, oldestMissing: null });
  hot.config.features = { meaningSearch: true, embedIndex: true };
  now.advance(61_000);
  assert.equal((await memoryLines())[1], 'index: 1234 rows · - of record messages indexed (last 48 h) · none missing');
});

test('status: the speed field gives the median and the mean of the last 24 h with the count, the planner only while it is on', async () => {
  const rootDir = makeRoot();
  const now = handClock(Date.parse('2026-10-14T12:00:00.000Z'));
  const metrics = createMetrics({ dataDir: path.join(rootDir, 'data'), now });
  metrics.record('reply', 4000);
  metrics.record('reply', 6000);
  metrics.record('reply without recall', 4000);
  metrics.record('meaning search', 120);
  metrics.record('planner', 700);
  const { admin, hot } = makeAdmin(rootDir, { metrics, now });
  const speedLines = async () =>
    (await admin.run('status', {}, { userId: '42' })).embeds[0].fields
      .find((f) => f.name === 'speed')
      .value.split('\n');

  const off = await speedLines();
  assert.deepEqual(off, [
    'reply: median 5.0 s · mean 5.0 s (2)',
    'reply with recall: -',
    'reply without recall: median 4.0 s · mean 4.0 s (1)',
    'recall total: -',
    'discord search: -',
    'record match: -',
    'memory match: -',
    'meaning search: median 120 ms · mean 120 ms (1)',
    'recall summary: -',
    'analyzer batch: -',
    'embedding flush: -',
  ]);
  hot.config.features = { turnPlanner: true };
  assert.equal(
    (await speedLines()).find((line) => line.startsWith('planner')),
    'planner: median 700 ms · mean 700 ms (1)'
  );
});

test("status: the speed field ends with today's missed-answer figures from the journal, while it is on", async () => {
  const rootDir = makeRoot();
  const now = handClock(Date.parse('2026-10-14T12:00:00.000Z'));
  const asked = [];
  const journal = {
    dayFile: () => path.join(rootDir, 'no-day.jsonl'),
    stalled: () => false,
    read: async (guildId, query) => {
      asked.push([guildId, query]);
      return [
        { kind: 'answer', event: 'fact', reason: 'gate-failed', messageId: 'm1' },
        { kind: 'answer', event: 'fact', reason: 'turn-error', messageId: 'm2' },
        { kind: 'answer', event: 'verdict', verdict: 'owed', messageId: 'm1' },
        { kind: 'answer', event: 'recovery', outcome: 'spoke', messageIds: ['m1'] },
      ];
    },
  };
  const { admin, hot } = makeAdmin(rootDir, { journal, now });
  const speed = async (userId = '42') =>
    (await admin.run('status', {}, { userId })).embeds[0].fields.find((f) => f.name === 'speed')?.value;
  hot.config.features = { ...hot.config.features, journal: true };
  assert.equal(await speed(), 'not available\nmissed: 2 candidates, 1 owed, 1 recovered');
  assert.deepEqual(asked, [['g1', { day: '2026-10-14', kind: 'answer', n: Number.MAX_SAFE_INTEGER }]]);
  assert.equal(await speed('999'), undefined, 'a member has no speed field');
  hot.config.features = { ...hot.config.features, journal: false };
  assert.equal(await speed(), 'not available', 'no journal, no line');
});

test('status: the storage line flags a journal that stopped writing while turns happen', async () => {
  const rootDir = makeRoot();
  let lastWriteMs = null;
  const journal = { stats: async () => ({ lastWriteMs }), stalled: () => false };
  const metrics = createMetrics({ dataDir: path.join(rootDir, 'data') });
  const { admin, hot } = makeAdmin(rootDir, { journal, metrics });
  const storage = async () =>
    (await admin.run('status', {}, { userId: '42' })).embeds[0].fields[0].value.split('\n')[1];

  hot.config.features = { journal: true };
  assert.equal(await storage(), 'storage ok', 'no turn in the last hour: nothing to judge');
  metrics.record('reply', 3000);
  assert.equal(await storage(), 'storage: journal not written today while turns happen');
  lastWriteMs = Date.now() - 2 * 3_600_000;
  assert.match(
    await storage(),
    /^storage: journal not written since \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC while turns happen$/
  );
  lastWriteMs = Date.now();
  assert.equal(await storage(), 'storage ok');
  hot.config.features = { journal: false };
  lastWriteMs = Date.now() - 2 * 3_600_000;
  assert.equal(await storage(), 'storage ok', 'the journal switched off is not expected to write');
});

/** A fake llm client for the status probes: `complete` answers each role through `answer` (a
 * function of the role, throwing to fail), recording every call; `modelEndpoints` returns `listing`. */
function fakeProbeLlm(
  answer,
  listing = {
    ok: true,
    status: 200,
    json: { data: { architecture: { output_modalities: ['image'] }, endpoints: [{}, {}] } },
  }
) {
  const calls = [];
  const listings = [];
  return {
    calls,
    listings,
    async complete(messages, options) {
      calls.push({ messages, options });
      return answer(options.role);
    },
    async modelEndpoints(model, options) {
      listings.push({ model, options });
      return listing;
    },
  };
}

/** The probe tests' config: a model per role (the drawing model included), the probe timeout and label. */
function probeConfig(hot) {
  hot.config.models = {
    base: {
      core: 'anthropic/claude-opus-4.6',
      analyzer: 'x/text',
      vision: 'x/media',
      video: 'x/video',
      embedding: 'x/embed',
      drawing: 'openai/gpt-image-1',
    },
  };
  hot.config.llm.probeTimeoutMs = 1234;
  hot.prompts.labels.status = { probe: 'Answer with one word: Ωmega' };
}

/** The models field's lines. */
const roleLinesOf = (value) => value.split('\n');

test('status: the card lists one item per line in every field, the models one line per role with no heading', async () => {
  const rootDir = makeRoot();
  const journal = { dayFile: () => path.join(rootDir, 'none.jsonl'), stalled: () => false };
  const archive = { stats: () => ({ pending: 2 }) };
  const emojiBackfill = { isRunning: () => true };
  const gifBackfill = { isRunning: () => true };
  const llm = fakeProbeLlm(() => ({ provider: 'Prov', usage: { prompt_tokens: 9, completion_tokens: 1 } }));
  const client = { ws: { ping: 12 }, guilds: { cache: new Map() } };
  const { admin, hot } = makeAdmin(rootDir, {
    journal,
    archive,
    emojiBackfill,
    gifBackfill,
    images: fakeImages({ quota: { used: 2, cap: 5 } }),
    llm,
    client,
  });
  probeConfig(hot);
  hot.config.media = { video: { maxPerDay: 40 } };
  hot.config.recall = { maxPerDay: 100 };
  hot.config.web = { maxPerDay: 60 };

  const { embeds } = await admin.run('status', {}, { userId: '42' });
  const lines = (name) => embeds[0].fields.find((f) => f.name === name).value.split('\n');
  assert.deepEqual(
    embeds[0].fields.map((f) => f.name),
    [
      'state',
      'tasks',
      'models.base',
      'keys.base',
      'costs.base',
      'models.errands',
      'costs.errands',
      'models.development',
      'costs.development',
      'limits',
      'memory',
      'speed',
    ]
  );
  // No gateway latency any more (the interface gives the core no such figure): the connection field is the last reconnect.
  assert.deepEqual(lines('state').slice(0, 3), ['running', 'storage: 2 archive copies pending', 'last reconnect none']);
  assert.match(lines('state')[3], /^uptime /);
  assert.deepEqual(lines('tasks'), ['emoji backfill running', 'GIF backfill running', 'archive drain: 2 pending']);
  assert.deepEqual(
    lines('limits').map((line) => line.replace(/^requests \d+/, 'requests N')),
    ['requests N/300', 'images 2/5', 'videos 0/40', 'recall 0/100', 'lookups 0/60', 'resets 00:00 UTC']
  );
  const head = (line) => line.split(' · ').slice(0, 2).join(' · ');
  for (const name of ['models.base', 'models.errands', 'models.development']) {
    assert.ok(!lines(name).some((line) => line.startsWith('**')), `${name}: no bold heading`);
    assert.ok(!lines(name).some((line) => line.startsWith(' ')), `${name}: no detail line under a role`);
  }
  assert.deepEqual(
    lines('models.base').map(head),
    [
      'core · anthropic/claude-opus-4.6',
      `memory · ${ROLE_DEFAULTS.core}`,
      'analyzer · x/text',
      'vision · x/media',
      'video · x/video',
      'embedding · x/embed',
      `speech · ${ROLE_DEFAULTS.speech}`,
      'drawing · openai/gpt-image-1',
    ],
    'each line starts with its role and its model, drawing last'
  );
  assert.deepEqual(lines('models.errands').map(head), [
    `scout · ${ROLE_DEFAULTS.scout}`,
    `server · ${ROLE_DEFAULTS.server}`,
  ]);
  assert.deepEqual(lines('models.development').map(head), [
    `thinker · ${ROLE_DEFAULTS.thinker}`,
    `dev · ${ROLE_DEFAULTS.dev}`,
  ]);
  for (const field of embeds[0].fields) assert.ok(field.value.length > 0 && field.value.length <= 1024, field.name);
});

test('status: the limits field names the web search engine (one word), off when no search can run', async () => {
  const rootDir = makeRoot();
  const lookup = {
    engine: 'exa',
    ready: true,
    searchEngine() {
      return this.engine;
    },
    hasSearch() {
      return this.ready;
    },
  };
  const { admin, hot } = makeAdmin(rootDir, { lookup });
  hot.config.features = { ...hot.config.features, webLookup: true };
  hot.config.web = { maxPerDay: 60, search: { enabled: true } };
  const searchLine = async () => {
    const { embeds } = await admin.run('status', { field: 'limits' }, { userId: '42' });
    return embeds[0].fields[0].value.split('\n').filter((line) => line.startsWith('search'));
  };
  assert.deepEqual(await searchLine(), ['search: exa']);
  lookup.engine = 'openrouter';
  assert.deepEqual(await searchLine(), ['search: openrouter']);
  lookup.engine = 'brave';
  lookup.ready = false;
  assert.deepEqual(await searchLine(), ['search: off'], 'the chosen engine cannot run (no Brave key)');
  lookup.ready = true;
  hot.config.web.search.enabled = false;
  assert.deepEqual(await searchLine(), ['search: off']);
  hot.config.web.search.enabled = true;
  hot.config.features.webLookup = false;
  assert.deepEqual(await searchLine(), ['search: off']);
});

test("status: the owner card probes every role's model and shows its provider and latency, or the failure", async () => {
  const rootDir = makeRoot();
  const funnel = JSON.stringify({
    error: {
      metadata: {
        routing_funnel: [
          { step: 'model', endpoint_count: 3 },
          { step: 'provider', endpoint_count: 0 },
        ],
      },
    },
  });
  const llm = fakeProbeLlm((role) => {
    if (role === 'vision') throw Object.assign(new Error('HTTP 503: upstream down'), { body: funnel });
    return { provider: 'Prov', usage: { prompt_tokens: 9, completion_tokens: 1 } };
  });
  const { admin, hot } = makeAdmin(rootDir, { images: fakeImages({ quota: { used: 2, cap: 5 } }), llm });
  probeConfig(hot);
  const modelOf = { core: 'anthropic/claude-opus-4.6', analyzer: 'x/text', vision: 'x/media', video: 'x/video' };

  const { result, logs } = await withCapturedLogs(() => admin.run('status', {}, { userId: '42' }));
  const lines = roleLinesOf(result.embeds[0].fields.find((f) => f.name === 'models.base').value);
  const errands = roleLinesOf(result.embeds[0].fields.find((f) => f.name === 'models.errands').value);
  const development = roleLinesOf(result.embeds[0].fields.find((f) => f.name === 'models.development').value);

  assert.deepEqual(
    llm.calls.map((call) => call.options.role).sort(),
    Object.keys(modelOf).sort(),
    'one probe per role model'
  );
  for (const { messages, options } of llm.calls) {
    assert.deepEqual(messages, [{ role: 'user', content: 'Answer with one word: Ωmega' }]);
    assert.equal(options.model, modelOf[options.role]);
    assert.equal(options.countAgainstDailyCap, false, 'never counted against llm.maxRequestsPerDay');
    assert.equal(options.skipCalibration, true);
    assert.equal(options.origin, 'status');
    assert.equal(options.timeoutMs, 1234);
  }
  assert.deepEqual(llm.listings, [{ model: 'openai/gpt-image-1', options: { timeoutMs: 1234 } }]);

  assert.match(lines[0], /^core · anthropic\/claude-opus-4\.6 · Prov · ok \d+ ms$/);
  assert.equal(lines[1], `memory · ${ROLE_DEFAULTS.core} · not checked (memory)`);
  assert.match(lines[2], /^analyzer · x\/text · Prov · ok \d+ ms$/);
  assert.ok(
    lines.includes('vision · x/media · failed: HTTP 503: upstream down (funnel: provider -> 0 endpoints)'),
    'the failing role shows its reason and the routing funnel'
  );
  assert.deepEqual(
    errands,
    [`scout · ${ROLE_DEFAULTS.scout}`, `server · ${ROLE_DEFAULTS.server}`],
    'just role and model'
  );
  assert.deepEqual(
    development,
    [`thinker · ${ROLE_DEFAULTS.thinker}`, `dev · ${ROLE_DEFAULTS.dev}`],
    'just role and model'
  );
  assert.match(lines.at(-1), /^drawing · openai\/gpt-image-1 · listed, image output, 2 endpoint\(s\), \d+ ms$/);
  assert.ok(
    !llm.calls.some((call) => ['scout', 'server', 'thinker', 'dev'].includes(call.options.role)),
    'no request goes out on an OpenCode role'
  );

  const probed = logs.filter((entry) => entry.msg === 'status: probed');
  assert.equal(probed.length, 1);
  assert.equal(probed[0].ok, 3);
  assert.equal(probed[0].failed, 1);
});

test('status: the member card shows the models one line per role without probing', async () => {
  const rootDir = makeRoot();
  const llm = fakeProbeLlm(() => ({ provider: 'Prov' }));
  const { admin, hot } = makeAdmin(rootDir, { images: fakeImages({ quota: { used: 2, cap: 5 } }), llm });
  probeConfig(hot);
  hot.config.bot.access = { 'status.show': { everyone: true, roles: [], users: [] } };

  const { embeds } = await admin.run('status', {}, { userId: '999' });
  const valueOf = (name) => embeds[0].fields.find((f) => f.name === name).value;
  assert.equal(
    valueOf('models.base'),
    [
      'core · anthropic/claude-opus-4.6',
      `memory · ${ROLE_DEFAULTS.core}`,
      'analyzer · x/text',
      'vision · x/media',
      'video · x/video',
      'embedding · x/embed',
      `speech · ${ROLE_DEFAULTS.speech}`,
      'drawing · openai/gpt-image-1',
    ].join('\n')
  );
  assert.equal(
    valueOf('models.errands'),
    [`scout · ${ROLE_DEFAULTS.scout}`, `server · ${ROLE_DEFAULTS.server}`].join('\n')
  );
  assert.equal(
    valueOf('models.development'),
    [`thinker · ${ROLE_DEFAULTS.thinker}`, `dev · ${ROLE_DEFAULTS.dev}`].join('\n')
  );
  assert.equal(llm.calls.length, 0, 'no probe request');
  assert.equal(llm.listings.length, 0, 'no listing request');
});

test('status: identical probes are sent once, each role shows its own model, the overrides follow their role, the embedding role gets an embedding probe', async () => {
  const rootDir = makeRoot();
  const llm = fakeProbeLlm(() => ({ provider: 'Prov', usage: { prompt_tokens: 9, completion_tokens: 1 } }));
  const embedCalls = [];
  const embedder = {
    async embed(texts, options) {
      embedCalls.push({ texts, options });
      return [new Float32Array(8)];
    },
  };
  const { admin, hot } = makeAdmin(rootDir, { images: fakeImages({ quota: { used: 0, cap: 5 } }), llm, embedder });
  probeConfig(hot);
  Object.assign(hot.config.models.base, { video: 'x/media' });
  hot.config.models.byPurpose = { lookup: 'x/pinned', describe: 'x/seen' };
  // A role-specific route keeps the video role's probe apart although its model is the vision one.
  hot.config.llm.providerByModel = { 'x/@video': { only: ['video-host'] } };

  const { result, logs } = await withCapturedLogs(() => admin.run('status', {}, { userId: '42' }));
  const lines = roleLinesOf(result.embeds[0].fields.find((f) => f.name === 'models.base').value);

  assert.deepEqual(
    llm.calls.map((call) => [call.options.role, call.options.model]).sort(),
    [
      ['analyzer', 'x/text'],
      ['core', 'anthropic/claude-opus-4.6'],
      ['video', 'x/media'],
      ['vision', 'x/media'],
    ],
    'one chat probe per (model, route)'
  );
  assert.deepEqual(
    embedCalls.map((call) => call.texts),
    [['Answer with one word: Ωmega']],
    'one embedding request of one input'
  );
  assert.equal(embedCalls[0].options.countAgainstDailyCap, false);
  assert.equal(embedCalls[0].options.origin, 'status');
  assert.equal(embedCalls[0].options.timeoutMs, 1234);
  assert.equal(embedCalls[0].options.config, hot.config);
  assert.equal(
    llm.calls.some((call) => call.options.model === 'x/embed'),
    false,
    'the embedding model is never sent a chat completion'
  );

  assert.equal(lines[3], 'byPurpose lookup · x/pinned', 'an override of a lookup purpose follows the analyzer');
  assert.equal(lines[5], 'byPurpose describe · x/seen', 'a vision override follows the vision role');
  assert.match(lines[7], /^embedding · x\/embed · - · ok \d+ ms$/, 'an embedding answer names no provider');
  assert.equal(logs.find((entry) => entry.msg === 'status: probed').requests, 5);
});

test('status: without an embedding client the embedding role is shown unchecked; an embedding failure shows its reason', async () => {
  const rootDir = makeRoot();
  const llm = fakeProbeLlm(() => ({ provider: 'Prov' }));
  const none = makeAdmin(rootDir, { llm });
  probeConfig(none.hot);
  const unchecked = await none.admin.run('status', {}, { userId: '42' });
  assert.ok(
    unchecked.embeds[0].fields
      .find((f) => f.name === 'models.base')
      .value.split('\n')
      .includes('embedding · x/embed · not checked (no embedding client)')
  );

  const embedder = {
    embed: async () => {
      throw Object.assign(new Error('HTTP 404: no such model'), { statusCode: 404 });
    },
  };
  const failing = makeAdmin(makeRoot(), { llm, embedder });
  probeConfig(failing.hot);
  const { result } = await withCapturedLogs(() => failing.admin.run('status', {}, { userId: '42' }));
  assert.ok(
    result.embeds[0].fields
      .find((f) => f.name === 'models.base')
      .value.split('\n')
      .includes('embedding · x/embed · failed: HTTP 404: no such model')
  );
});

// ---------------------------------------------------------------------------
// interject / initiate
// ---------------------------------------------------------------------------

function fakeSpontaneous(forceResult) {
  const calls = [];
  return {
    calls,
    force: async (conversation, mode, options) => {
      calls.push([conversation.conversationId, mode, options]);
      return forceResult ?? { ok: true };
    },
  };
}

test('run: message create gives the persona a turn in the context channel, the one who asked its requester', async () => {
  const rootDir = makeRoot();
  const spontaneous = fakeSpontaneous();
  world().channel({ id: 'c1' });
  const { admin } = makeAdmin(rootDir, { spontaneous });

  const result = await admin.run('message.create', {}, { channelId: 'c1', userId: '42', roleIds: ['r1'] });

  // No mode: the turn reads the channel and joins it or starts a topic itself.
  assert.deepEqual(spontaneous.calls, [['c1', null, { requester: { id: '42', roleIds: ['r1'] } }]]);
  assert.ok(result.includes('message create on c1'), result);
});

test('run: message create uses the channel argument when given, overriding the context channel; a text from a person changes nothing', async () => {
  const rootDir = makeRoot();
  const spontaneous = fakeSpontaneous();
  world().channel({ id: 'other' });
  const { admin } = makeAdmin(rootDir, { spontaneous });

  // The mode is the server's: a person always gets her turn, whatever text the arguments carry.
  await admin.run('message.create', { channelId: 'other', text: 'Σ' }, { channelId: 'c1' });

  assert.deepEqual(spontaneous.calls, [['other', null, { requester: null }]]);
});

// ---------------------------------------------------------------------------
// pause / resume
// ---------------------------------------------------------------------------

test('run: pause sets paused/pausedAt first, flushes, and drops caches', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);

  const result = await admin.run('pause', {}, {});

  assert.equal(store.state.data.paused, true);
  assert.ok(store.state.data.pausedAt);
  assert.ok(store.flushCalls >= 1);
  assert.equal(store.dropCachesCalls, 1);
  assert.match(result, /paused/i);
  assert.match(result, /resume/i);
});

test('run: pause is idempotent -- a second call just reports the state without dropping caches again', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);

  await admin.run('pause', {}, {});
  const pausedAt = store.state.data.pausedAt;
  const dropsAfterFirst = store.dropCachesCalls;

  const result = await admin.run('pause', {}, {});

  assert.equal(store.state.data.pausedAt, pausedAt, 'pausedAt is not bumped by a repeat pause');
  assert.equal(store.dropCachesCalls, dropsAfterFirst, 'nothing is dropped again');
  assert.match(result, /already paused/i);
});

test('run: pause clears the pending-ping queue', async () => {
  const rootDir = makeRoot();
  let clearCalls = 0;
  const pending = {
    clear: () => {
      clearCalls += 1;
    },
  };
  const { admin } = makeAdmin(rootDir, { pending });

  await admin.run('pause', {}, {});

  assert.equal(clearCalls, 1);
});

test('run: pause waits for a turn already in flight before dropping caches', async () => {
  const rootDir = makeRoot();
  let resolveIdle;
  const idlePromise = new Promise((resolve) => {
    resolveIdle = resolve;
  });
  const turns = { waitIdle: () => idlePromise };
  const { admin, store } = makeAdmin(rootDir, { turns });

  const pausePromise = admin.run('pause', {}, {});
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.dropCachesCalls, 0, 'must not drop caches before the in-flight turn finished');

  resolveIdle();
  await pausePromise;
  assert.equal(store.dropCachesCalls, 1);
});

test('/nep pause: no timer-driven writer (spontaneous.tick, store.flush) writes memory while paused', async () => {
  const mem = await openTestMemory();
  try {
    const writes = [];
    const memoryDb = {
      ...mem.memoryDb,
      writeUnit: (update) => {
        writes.push(update.owner);
        return mem.memoryDb.writeUnit(update);
      },
    };
    const realStore = createStore({ dataDir: mem.dataDir, memoryDb });
    const guildId = 'g1';
    realStore.touchUser(guildId, 'u1', 'Alice', 1000);
    realStore.updateGuild(guildId, { patterns: 'x' });
    realStore.flush();
    await realStore.flushSettled({});
    const before = writes.length;
    assert.ok(before > 0, 'the writes before the pause reached the database');

    realStore.state.data.paused = true;

    const spontaneous = createSpontaneous({
      discord: DISCORD,
      hot: { config: {} },
      store: realStore,
      client: { guilds: { cache: new Map() } },
      turns: {
        runTurn: async () => ({ outcome: 'spoke' }),
        isBusy: () => false,
        isAnyBusy: () => false,
        lastPostAt: () => 0,
      },
      getGuildId: () => guildId,
    });

    // Mirrors index.js's periodic timers firing once, back to back.
    await spontaneous.tick();
    realStore.flush();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(writes.slice(before), [], 'nothing was written while paused');
  } finally {
    await mem.close();
    fs.rmSync(mem.dataDir, { recursive: true, force: true });
  }
});

test('run: resume refuses when data/ has an invalid file, naming the path, and leaves paused untouched', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  await admin.run('pause', {}, {});
  store.validateResult = ['guilds/g1/users/u1.json'];

  const result = await admin.run('resume', {}, {});

  assert.match(result, /invalid json/i);
  assert.ok(result.includes('guilds/g1/users/u1.json'));
  assert.equal(store.state.data.paused, true, 'stays paused');
});

test('run: resume clears the flags and reports plain confirmation', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  await admin.run('pause', {}, {});

  const result = await admin.run('resume', {}, {});

  assert.equal(store.state.data.paused, undefined);
  assert.equal(store.state.data.pausedAt, undefined);
  assert.equal(store.reloadStateCalls, 1);
  assert.equal(result, 'Resumed.');
});

test('run: resume starts a catch-up pass of the meaning index for the guild; pause and a refused resume do not', async () => {
  const rootDir = makeRoot();
  const passes = [];
  const embedQueue = {
    catchUp: async (guildId) => {
      passes.push(guildId);
      return null;
    },
  };
  const { admin, store } = makeAdmin(rootDir, { embedQueue });
  await admin.run('pause', {}, { guildId: 'g1' });
  store.validateResult = ['guilds/g1/users/u1.json'];
  await admin.run('resume', {}, { guildId: 'g1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(passes, [], 'still paused: no pass');
  store.validateResult = [];
  assert.equal(await admin.run('resume', {}, { guildId: 'g1' }), 'Resumed.');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(passes, ['g1']);
});

test('run: every command that writes data/ is refused while paused, with a hint to resume', async () => {
  const rootDir = makeRoot();
  const client = clientWithGuild('g1', 'The Server');
  const { admin, store } = makeAdmin(rootDir, { client });
  store.profiles.set('g1:123', { id: '123', character: 'chatty' });
  store.setLore('g1', [{ title: 'X', keys: ['xx'], text: 'y' }], { source: 'owner', now: 1 });
  const [{ id: loreId }] = store.getLore('g1');

  await admin.run('pause', {}, {});

  const attempts = [
    ['lore.add', { title: 'Y', keys: 'y', text: 'z' }],
    ['lore.remove', { id: loreId }],
    ['message.create', {}],
  ];
  for (const [key, args] of attempts) {
    await assert.rejects(
      () => admin.run(key, args, { guildId: 'g1', channelId: 'c1' }),
      /paused.*resume/i,
      `${key} must be refused while paused`
    );
  }
});

test('run: read-only and config commands keep working while paused', async () => {
  const rootDir = makeRoot();
  const client = clientWithGuild('g1', 'The Server');
  const { admin, store } = makeAdmin(rootDir, { client });
  store.profiles.set('g1:123', { id: '123', character: 'chatty' });
  store.setLore('g1', [{ title: 'X', keys: ['xx'], text: 'y' }], { source: 'owner', now: 1 });

  await admin.run('pause', {}, {});

  await assert.doesNotReject(() => admin.run('status', {}, {}));
  await assert.doesNotReject(() => admin.run('memory.show', { userId: '123' }, { guildId: 'g1' }));
  await assert.doesNotReject(() => admin.run('memory.affinity', { userId: '123' }, { guildId: 'g1' }));
  await assert.doesNotReject(() => admin.run('lore.list', {}, { guildId: 'g1' }));
  await assert.doesNotReject(() => admin.run('model.show', {}, {}));
  await assert.doesNotReject(() => admin.run('rule.list', {}, {}));
  await assert.doesNotReject(() => admin.run('set', { path: 'models.base.core', value: '"x/y"' }, {}));
  await assert.doesNotReject(() => admin.run('unset', { path: 'models.base.core' }, {}));
  await assert.doesNotReject(() => admin.run('model.set', { role: 'core', id: 'x/y' }, {}));
});

test('run: memory.show/lore.list/lore.show drop caches first while paused, so a hand-edit is always seen', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', character: 'chatty' });
  store.setLore('g1', [{ title: 'X', keys: ['xx'], text: 'y' }], { source: 'owner', now: 1 });
  const [{ id: loreId }] = store.getLore('g1');

  await admin.run('pause', {}, {});
  const dropsAfterPause = store.dropCachesCalls;

  await admin.run('memory.show', { userId: '123' }, { guildId: 'g1' });
  assert.equal(store.dropCachesCalls, dropsAfterPause + 1);

  await admin.run('lore.list', {}, { guildId: 'g1' });
  assert.equal(store.dropCachesCalls, dropsAfterPause + 2);

  await admin.run('lore.show', { id: loreId }, { guildId: 'g1' });
  assert.equal(store.dropCachesCalls, dropsAfterPause + 3);

  await admin.run('memory.affinity', { userId: '123' }, { guildId: 'g1' });
  assert.equal(store.dropCachesCalls, dropsAfterPause + 4);
});

// ---------------------------------------------------------------------------
// draw / the image lines of status and model.show (src/llm/images.js)
// ---------------------------------------------------------------------------

/** A fake image client: records every generate() call, answers with `picture` or throws `error`. */
function fakeImages({ picture, error, quota } = {}) {
  const calls = [];
  return {
    calls,
    familyOf,
    async generate(args) {
      calls.push(args);
      if (error) throw error;
      return (
        picture ?? {
          buffer: Buffer.from('fake-png'),
          mediaType: 'image/png',
          cost: 0.042,
          usage: {},
          model: 'openai/image-model',
          seconds: 12.3,
        }
      );
    },
    quota: () => quota ?? { used: 3, cap: 50, userUsed: 0, userCap: 50, spent: false, userSpent: false },
  };
}

/** A fake imageFetcher: records every fetchAsDataUrl() call and answers `result`. */
function fakeImageFetcher(result = { dataUrl: 'data:image/png;base64,QUFB' }) {
  const calls = [];
  return {
    calls,
    async fetchAsDataUrl(url, opts) {
      calls.push({ url, opts });
      return result;
    },
  };
}

function hotForDraw(rootDir, { model = 'openai/image-model', ...image } = {}) {
  const hot = makeHot(rootDir);
  hot.config.models = { ...hot.config.models, base: { ...hot.config.models?.base, drawing: model } };
  hot.config.image = { maxPromptChars: 800, reference: 'avatar', referenceMaxBytes: 4000000, ...image };
  hot.config.context = { vision: { fetchTimeoutMs: 7000 } };
  hot.prompts = {
    ...hot.prompts,
    draw: 'Picture by {{name}}.\n\n{{appearance}}\n\nRequest: {{request}}',
    appearance: '{{name}} has silver hair.',
  };
  return hot;
}

function drawClient() {
  const guild = { id: 'g1', name: 'The Server', members: { me: { displayName: 'Persona' } } };
  // The address of her large avatar is the interface's to give (`memberInfo` of herself).
  world().member('g1', {
    id: 'self-id',
    name: 'Persona',
    avatar: { hash: null, url: null, largeUrl: 'https://cdn.example/avatar.png' },
  });
  return {
    guilds: { cache: new Map([['g1', guild]]) },
    user: { id: 'self-id', username: 'persona-bot' },
  };
}

test('run: draw builds the prompt as a turn does and answers with the picture as a file', async () => {
  const rootDir = makeRoot();
  const hot = hotForDraw(rootDir);
  const images = fakeImages();
  const imageFetcher = fakeImageFetcher();
  const { admin } = makeAdmin(rootDir, { hot, images, imageFetcher, client: drawClient() });

  const result = await admin.run('draw', { text: 'a lighthouse at dusk', self: false }, { guildId: 'g1' });

  assert.equal(images.calls.length, 1);
  assert.deepEqual(images.calls[0], {
    prompt: buildDrawPrompt({
      prompts: hot.prompts,
      selfName: 'Persona',
      request: 'a lighthouse at dusk',
      self: false,
    }),
    reference: null,
    userId: null,
  });
  assert.ok(!images.calls[0].prompt.includes('silver hair'), 'no appearance without self');
  assert.equal(imageFetcher.calls.length, 0, 'no avatar fetched without self');
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, 'image.png');
  assert.ok(Buffer.isBuffer(result.files[0].attachment));
  assert.equal(result.files[0].attachment.toString(), 'fake-png');
  assert.ok(!result.text.includes('\n'), 'one line');
  assert.match(result.text, /openai\/image-model/);
  assert.match(result.text, /12\.3s/);
  assert.match(result.text, /0\.042/);
});

test('run: draw clamps the request to image.maxPromptChars before building the prompt', async () => {
  const rootDir = makeRoot();
  const hot = hotForDraw(rootDir, { maxPromptChars: 5 });
  const images = fakeImages();
  const { admin } = makeAdmin(rootDir, { hot, images, client: drawClient() });

  await admin.run('draw', { text: 'άλφαβήτα', self: false }, { guildId: 'g1' });

  assert.equal(
    images.calls[0].prompt,
    buildDrawPrompt({ prompts: hot.prompts, selfName: 'Persona', request: 'άλφαβ', self: false })
  );
});

test('run: draw with self adds the appearance and sends the avatar as the reference', async () => {
  const rootDir = makeRoot();
  const hot = hotForDraw(rootDir);
  const images = fakeImages();
  const imageFetcher = fakeImageFetcher();
  const client = drawClient();
  const { admin } = makeAdmin(rootDir, { hot, images, imageFetcher, client });

  await admin.run('draw', { text: 'at the beach', self: true }, { guildId: 'g1' });

  assert.deepEqual(imageFetcher.calls, [
    { url: 'https://cdn.example/avatar.png', opts: { maxBytes: 4000000, timeoutMs: 7000 } },
  ]);
  assert.equal(images.calls[0].reference, 'data:image/png;base64,QUFB');
  assert.equal(images.calls[0].userId, null);
  assert.equal(
    images.calls[0].prompt,
    buildDrawPrompt({ prompts: hot.prompts, selfName: 'Persona', request: 'at the beach', self: true })
  );
  assert.ok(images.calls[0].prompt.includes('Persona has silver hair.'));
});

test('run: draw with self but image.reference none sends no reference', async () => {
  const rootDir = makeRoot();
  const hot = hotForDraw(rootDir, { reference: 'none' });
  const images = fakeImages();
  const imageFetcher = fakeImageFetcher();
  const { admin } = makeAdmin(rootDir, { hot, images, imageFetcher, client: drawClient() });

  await admin.run('draw', { text: 'at the beach', self: true }, { guildId: 'g1' });

  assert.equal(imageFetcher.calls.length, 0);
  assert.equal(images.calls[0].reference, null);
  assert.ok(images.calls[0].prompt.includes('Persona has silver hair.'), 'the appearance is still described');
});

test('run: draw still generates when the avatar cannot be fetched, and says so', async () => {
  const rootDir = makeRoot();
  const hot = hotForDraw(rootDir);
  const images = fakeImages();
  const imageFetcher = fakeImageFetcher(null);
  const { admin } = makeAdmin(rootDir, { hot, images, imageFetcher, client: drawClient() });

  const result = await admin.run('draw', { text: 'at the beach', self: true }, { guildId: 'g1' });

  assert.equal(images.calls.length, 1);
  assert.equal(images.calls[0].reference, null);
  assert.match(result.text, /no avatar reference/);
});

test('run: draw with an unsupported image model is a not-configured refusal with the reason, and never generates', async () => {
  const rootDir = makeRoot();
  const hot = hotForDraw(rootDir, { model: 'someone/else-model' });
  const images = fakeImages();
  const { admin } = makeAdmin(rootDir, { hot, images, client: drawClient() });

  await assert.rejects(
    () => admin.run('draw', { text: 'a cat' }, { guildId: 'g1' }),
    (err) => err.code === 'not-configured' && /someone\/else-model/.test(err.message) && /unsupported/.test(err.message)
  );
  assert.equal(images.calls.length, 0);
});

test('run: draw reports a failed generation with its reason and HTTP status', async () => {
  const rootDir = makeRoot();
  const hot = hotForDraw(rootDir);
  const error = new ImageGenError('moderation', 'image refused by moderation (HTTP 400)', {
    statusCode: 400,
    body: 'provider text',
  });
  const { admin } = makeAdmin(rootDir, { hot, images: fakeImages({ error }), client: drawClient() });

  await assert.rejects(
    () => admin.run('draw', { text: 'a cat' }, { guildId: 'g1' }),
    (err) => /moderation/.test(err.message) && /400/.test(err.message) && !err.message.includes('provider text')
  );
});

test('run: draw is refused while paused', async () => {
  const rootDir = makeRoot();
  const images = fakeImages();
  const { admin } = makeAdmin(rootDir, { hot: hotForDraw(rootDir), images, client: drawClient() });

  await admin.run('pause', {}, {});
  await assert.rejects(() => admin.run('draw', { text: 'a cat' }, { guildId: 'g1' }), /paused/);
  assert.equal(images.calls.length, 0);
});

test('run: access.grant refuses private memory and access management (owner-only), writing nothing', async () => {
  // [group, the operations or keys under it, the refusal of each]: an owner-only operation is
  // refused by name; a group holding only owner-only operations covers nothing.
  const ownerOnly = /is owner-only and cannot be granted/;
  for (const [group, commands, refusal] of [
    ['memory.private', ['memory.private.read'], ownerOnly],
    ['memory.private', ['memory.private'], /covers no grantable read operation/],
    ['access', ['access.grant', 'access.revoke', 'access.list'], ownerOnly],
    ['access', ['access'], /covers no grantable read operation/],
  ]) {
    const rootDir = makeRoot();
    const { admin } = makeAdmin(rootDir);

    for (const command of commands) {
      await assert.rejects(() => admin.run('access.grant', { command }, {}), refusal, `${group}: ${command}`);
      await assert.rejects(
        () => admin.run('access.grant', { command, roleId: '1' }, {}),
        refusal,
        `${group}: ${command} to a role`
      );
      await assert.rejects(
        () => admin.run('access.grant', { command, userId: '2' }, {}),
        refusal,
        `${group}: ${command} to a user`
      );
    }
    assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false, `${group}: nothing was written`);
  }
});

// ---------------------------------------------------------------------------
// emoji.status / emoji.rescan -- the custom emoji ranking and its history backfill
// ---------------------------------------------------------------------------

function fakeEmojiBackfill(result = { ok: true, channels: 3, messages: 120, emoji: 17 }, { running = false } = {}) {
  return {
    calls: [],
    async run(guildId, opts) {
      this.calls.push([guildId, opts]);
      return result;
    },
    isRunning: () => running,
  };
}

test('run: emoji.rescan runs the backfill forced and replies with the counts', async () => {
  const rootDir = makeRoot();
  const emojiBackfill = fakeEmojiBackfill();
  const { admin } = makeAdmin(rootDir, { emojiBackfill });

  const body = await admin.run('media', { kind: 'emoji', action: 'rescan' }, { guildId: 'g1' });
  assert.deepEqual(emojiBackfill.calls, [['g1', { force: true }]]);
  assert.equal(body, 'Emoji rescan done: 3 channels, 120 messages read, 17 emoji uses counted.');
});

test('run: emoji.rescan is refused while paused and without the backfill', async () => {
  const rootDir = makeRoot();
  const emojiBackfill = fakeEmojiBackfill();
  const { admin } = makeAdmin(rootDir, { emojiBackfill });
  await admin.run('pause', {}, {});
  await assert.rejects(() => admin.run('media', { kind: 'emoji', action: 'rescan' }, { guildId: 'g1' }), /paused/);
  assert.equal(emojiBackfill.calls.length, 0);

  const { admin: bare } = makeAdmin(rootDir);
  assert.equal(
    await bare.run('media', { kind: 'emoji', action: 'rescan' }, { guildId: 'g1' }),
    'the emoji backfill is not available'
  );
});

// ---------------------------------------------------------------------------
// gifs.status / gifs.rescan -- the GIF library and its history backfill
// ---------------------------------------------------------------------------

function fakeGifBackfill(
  result = { ok: true, channels: 3, messages: 120, gifs: 9, described: 4 },
  { running = false } = {}
) {
  return {
    calls: [],
    async run(guildId, opts) {
      this.calls.push([guildId, opts]);
      return result;
    },
    isRunning: () => running,
  };
}

test('run: gifs.rescan is refused while paused and without the backfill', async () => {
  const rootDir = makeRoot();
  const gifBackfill = fakeGifBackfill();
  const { admin } = makeAdmin(rootDir, { gifBackfill });
  await admin.run('pause', {}, {});
  await assert.rejects(() => admin.run('media', { kind: 'gifs', action: 'rescan' }, { guildId: 'g1' }), /paused/);
  assert.equal(gifBackfill.calls.length, 0);

  const { admin: bare } = makeAdmin(rootDir);
  assert.equal(
    await bare.run('media', { kind: 'gifs', action: 'rescan' }, { guildId: 'g1' }),
    'the GIF backfill is not available'
  );
});

test('run: gifs.status counts the library by caption format: watched with fields, old format, unwatched', async () => {
  const rootDir = makeRoot();
  const store = makeStore();
  const entry = (n) => ({
    id: `g${n}`,
    kind: 'link',
    url: `https://tenor.com/view/danse-${n}`,
    itemId: `m${n}#e0`,
    count: 5 - n,
    last: 1,
  });
  store.getGifs = () => ({
    nextId: 5,
    entries: Object.fromEntries([1, 2, 3, 4].map((n) => [`m${n}#e0`, entry(n)])),
    backfill: null,
  });
  store.getMediaCache = () => ({
    'm1#e0': {
      text: 'a cat lifts its chin',
      reaction: 'agreement',
      action: 'a cat lifts its chin',
      screen: 'oui.',
      ts: 1,
      watched: true,
      gif: true,
    },
    'm2#e0': { text: 'a caracal stares', ts: 1, watched: true, gif: true },
    'm3#e0': { text: 'a still', ts: 1, gif: true },
  });
  const { admin } = makeAdmin(rootDir, { store });
  const out = await admin.run('media', { kind: 'gifs', action: 'status' }, { guildId: 'g1' });
  assert.ok(
    out.includes('caption format: 1 watched with fields, 1 watched in the old format (to re-describe), 2 unwatched'),
    out
  );
  assert.equal(out.includes('oui.'), false, 'counts only, no field text');
});

// gifs.recache -- the GIF library re-described by watching

function fakeGifRecache(result = { ok: true, dropped: 4, queued: 50 }, { running = false } = {}) {
  return {
    calls: [],
    idleWaits: 0,
    start(guildId) {
      this.calls.push(guildId);
      return result;
    },
    isRunning: () => running,
    async waitIdle() {
      this.idleWaits += 1;
    },
  };
}

test('run: gifs.recache is refused while paused and without the recache; pause waits for a run in flight', async () => {
  const rootDir = makeRoot();
  const gifRecache = fakeGifRecache();
  const { admin } = makeAdmin(rootDir, { gifRecache });
  await admin.run('pause', {}, {});
  assert.equal(gifRecache.idleWaits, 1, '/nep pause waits for the recache');
  await assert.rejects(() => admin.run('media', { kind: 'gifs', action: 'recache' }, { guildId: 'g1' }), /paused/);
  assert.equal(gifRecache.calls.length, 0);

  const { admin: bare } = makeAdmin(rootDir);
  assert.equal(
    await bare.run('media', { kind: 'gifs', action: 'recache' }, { guildId: 'g1' }),
    'the GIF recache is not available'
  );
});

// media kind:pictures action:recache -- the cached descriptions of an older model described again

function fakeMediaRecache(result = { ok: true, picked: 12, days: 7 }) {
  return {
    calls: [],
    start() {
      throw new Error('the GIF run is not asked for');
    },
    startMedia(guildId, options) {
      this.calls.push({ guildId, options });
      return typeof result === 'function' ? result(options) : result;
    },
    isRunning: () => false,
    async waitIdle() {},
  };
}

test('run: media pictures recache starts the media run with days (default 7) and replies at once with how many are queued', async () => {
  const rootDir = makeRoot();
  const gifRecache = fakeMediaRecache((options) => ({ ok: true, picked: 12, days: options.days }));
  const { admin } = makeAdmin(rootDir, { gifRecache });

  const reply = await admin.run('media', { kind: 'pictures', action: 'recache' }, { guildId: 'g1' });
  assert.deepEqual(gifRecache.calls[0], { guildId: 'g1', options: { days: 7 } });
  assert.match(reply, /^Media recache started: 12 cached descriptions used in the last 7 days/);
  await admin.run('media', { kind: 'pictures', action: 'recache', days: 30 }, { guildId: 'g1' });
  assert.deepEqual(gifRecache.calls[1].options, { days: 30 });
});

test('run: media pictures recache refuses days out of 1..60, a run in flight, pictures off; status and rescan have no pictures kind', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { gifRecache: fakeMediaRecache() });
  for (const days of [0, 61, 2.5, '7']) {
    await assert.rejects(
      () => admin.run('media', { kind: 'pictures', action: 'recache', days }, { guildId: 'g1' }),
      /days must be a whole number from 1 to 60/,
      String(days)
    );
  }
  await assert.rejects(
    () => admin.run('media', { kind: 'pictures', action: 'status' }, { guildId: 'g1' }),
    /kind must be one of: emoji, gifs/
  );

  const { admin: busy } = makeAdmin(rootDir, { gifRecache: fakeMediaRecache({ ok: false, reason: 'running' }) });
  assert.match(await busy.run('media', { kind: 'pictures', action: 'recache' }, { guildId: 'g1' }), /already running/);
  const { admin: off } = makeAdmin(rootDir, { gifRecache: fakeMediaRecache({ ok: false, reason: 'off' }) });
  assert.match(
    await off.run('media', { kind: 'pictures', action: 'recache' }, { guildId: 'g1' }),
    /features\.mediaDescriptions is off/
  );
  const { admin: bare } = makeAdmin(rootDir);
  assert.equal(
    await bare.run('media', { kind: 'pictures', action: 'recache' }, { guildId: 'g1' }),
    'the media recache is not available'
  );
});

// ---------------------------------------------------------------------------
// route.list / route.set / route.remove: llm.providerByModel from Discord
// ---------------------------------------------------------------------------

test('run: route.set without a role writes { only, allow_fallbacks: false } under the bare prefix and reloads', async () => {
  const rootDir = makeRoot();
  fs.writeFileSync(path.join(rootDir, 'config.local.json'), JSON.stringify({ llm: { model: 'x/kept' } }));
  const { admin, hot } = makeAdmin(rootDir);

  const result = await admin.run('route.set', { model: 'google/', providers: 'google-vertex' }, {});

  assert.deepEqual(readLocal(rootDir), {
    llm: { model: 'x/kept', providerByModel: { 'google/': { only: ['google-vertex'], allow_fallbacks: false } } },
  });
  assert.equal(hot.reloadConfigCalls, 1);
  assert.match(result, /google\//);
});

test('run: route.set with a role writes "<prefix>@<role>"; a dotted model id stays one key; fallbacks true is kept', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await admin.run('route.set', { model: 'google/', providers: 'google-vertex' }, {});
  await admin.run(
    'route.set',
    { model: 'google/', providers: ' google-ai-studio , google-vertex ,', role: 'video' },
    {}
  );
  await admin.run(
    'route.set',
    { model: 'anthropic/claude-sonnet-4.6', providers: 'amazon-bedrock', role: 'core', fallbacks: true },
    {}
  );

  assert.deepEqual(readLocal(rootDir).llm.providerByModel, {
    'google/': { only: ['google-vertex'], allow_fallbacks: false },
    'google/@video': { only: ['google-ai-studio', 'google-vertex'], allow_fallbacks: false },
    'anthropic/claude-sonnet-4.6@core': { only: ['amazon-bedrock'], allow_fallbacks: true },
  });
});

test('run: route.set validates the prefix, the providers and the role, writing nothing on an error', async () => {
  const rootDir = makeRoot();
  const { admin, hot } = makeAdmin(rootDir);
  const bad = [
    [{ model: '', providers: 'google-vertex' }, /model/],
    [{ model: '   ', providers: 'google-vertex' }, /model/],
    [{ model: 'google/@core', providers: 'google-vertex' }, /@/],
    [{ model: 'google /x', providers: 'google-vertex' }, /space/],
    [{ model: '__proto__', providers: 'google-vertex' }, /model/],
    [{ model: 'google/', providers: '' }, /provider/],
    [{ model: 'google/', providers: ' , ' }, /provider/],
    [{ model: 'google/', providers: 'Google-Vertex' }, /provider/],
    [{ model: 'google/', providers: 'google_vertex' }, /provider/],
    [{ model: 'google/', providers: 'google-vertex', role: 'bogus' }, /unknown role: bogus/],
    [{ model: 'google/', providers: 'google-vertex', role: 'web' }, /unknown role: web/],
    // An agent role's OpenCode worker never reads llm.providerByModel: no route may name it.
    [{ model: 'openrouter/', providers: 'openai', role: 'scout' }, /unknown role: scout/],
    [{ model: 'openrouter/', providers: 'openai', role: 'dev' }, /unknown role: dev/],
    [{ model: 'openrouter/', providers: 'openai', role: 'thinker' }, /unknown role: thinker/],
    [{ model: 'google/', providers: 'google-vertex', byok: 'yes' }, /byok must be true or false/],
    [{ model: 'google/', providers: 'google-vertex', byok: 'TRUE' }, /byok must be true or false/],
    [{ model: 'google/', providers: 'google-vertex', byok: 1 }, /byok must be true or false/],
  ];
  for (const [args, message] of bad) {
    await assert.rejects(() => admin.run('route.set', args, {}), message, JSON.stringify(args));
  }
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
  assert.equal(hot.reloadConfigCalls, 0);
});

test('run: route.set byok true writes byok: true and says byok: on; false or absent writes no key and says byok: off', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  const on = await admin.run('route.set', { model: 'anthropic/', providers: 'amazon-bedrock', byok: 'true' }, {});
  const off = await admin.run('route.set', { model: 'google/', providers: 'google-vertex', byok: 'false' }, {});
  const absent = await admin.run('route.set', { model: 'openai/', providers: 'openai' }, {});
  // A persona's call carries the flag as a boolean.
  await admin.run('route.set', { model: 'x-ai/', providers: 'xai', byok: true }, {});

  assert.deepEqual(readLocal(rootDir).llm.providerByModel, {
    'anthropic/': { only: ['amazon-bedrock'], allow_fallbacks: false, byok: true },
    'google/': { only: ['google-vertex'], allow_fallbacks: false },
    'openai/': { only: ['openai'], allow_fallbacks: false },
    'x-ai/': { only: ['xai'], allow_fallbacks: false, byok: true },
  });
  assert.match(on, /fallbacks: off, byok: on /);
  assert.match(off, /fallbacks: off, byok: off /);
  assert.match(absent, /fallbacks: off, byok: off /);
});

test('run: route.remove deletes only the named key; an unknown route is an error and writes nothing', async () => {
  const rootDir = makeRoot();
  const { admin, hot } = makeAdmin(rootDir);
  await admin.run('route.set', { model: 'google/', providers: 'google-vertex' }, {});
  await admin.run('route.set', { model: 'google/', providers: 'google-ai-studio', role: 'video' }, {});

  const result = await admin.run('route.remove', { model: 'google/', role: 'video' }, {});
  assert.match(result, /google\/@video/);
  assert.deepEqual(readLocal(rootDir).llm.providerByModel, {
    'google/': { only: ['google-vertex'], allow_fallbacks: false },
  });
  assert.equal(hot.reloadConfigCalls, 3);

  const before = fs.readFileSync(path.join(rootDir, 'config.local.json'), 'utf8');
  await assert.rejects(
    () => admin.run('route.remove', { model: 'google/', role: 'core' }, {}),
    /no route google\/@core/
  );
  await assert.rejects(() => admin.run('route.remove', { model: 'google/', role: 'bogus' }, {}), /unknown role/);
  assert.equal(fs.readFileSync(path.join(rootDir, 'config.local.json'), 'utf8'), before);
  assert.equal(hot.reloadConfigCalls, 3);

  await admin.run('route.remove', { model: 'google/' }, {});
  assert.deepEqual(readLocal(rootDir), {}, 'the emptied map and llm object are pruned');
});

function hotForRoutes(rootDir) {
  const hot = makeHotWithMedia(rootDir);
  hot.config.llm.provider = null;
  hot.config.models = {
    base: {
      core: 'anthropic/claude-opus-4.6',
      analyzer: 'google/gemini-3.8-flash',
      vision: 'google/gemini-3.8-flash',
      video: 'google/gemini-3.8-flash',
      embedding: 'openai/text-embedding-x',
      drawing: 'openai/gpt-image-x',
    },
  };
  hot.config.image = { provider: { only: ['openai'] } };
  hot.config.media = { video: { provider: { order: ['google-ai-studio'], allow_fallbacks: false } } };
  return hot;
}

test('run: route.list renders every route (prefix, role or any, providers, fallbacks, byok) and the route each role gets', async () => {
  const rootDir = makeRoot();
  const hot = hotForRoutes(rootDir);
  hot.config.llm.provider = { ignore: ['some-provider'] };
  const { admin } = makeAdmin(rootDir, { hot });
  await admin.run('route.set', { model: 'google/', providers: 'google-vertex' }, {});
  await admin.run('route.set', { model: 'google/', providers: 'google-ai-studio', role: 'video' }, {});
  await admin.run(
    'route.set',
    { model: 'anthropic/', providers: 'amazon-bedrock,anthropic', role: 'core', fallbacks: true, byok: 'true' },
    {}
  );

  const lines = (await admin.run('route.list', {}, {})).split('\n');

  assert.deepEqual(lines, [
    'routes:',
    '  anthropic/ | core | only amazon-bedrock, anthropic | fallbacks: on | byok: on',
    '  google/ | any | only google-vertex | fallbacks: off | byok: off',
    '  google/ | video | only google-ai-studio | fallbacks: off | byok: off',
    'by role:',
    '  core: anthropic/claude-opus-4.6 -> anthropic/@core (only amazon-bedrock, anthropic, fallbacks: on, byok)',
    '  analyzer: google/gemini-3.8-flash -> google/ (only google-vertex, fallbacks: off)',
    '  vision: google/gemini-3.8-flash -> google/ (only google-vertex, fallbacks: off)',
    '  video: google/gemini-3.8-flash -> google/@video (only google-ai-studio, fallbacks: off); direct-URL videos: media.video.provider (order google-ai-studio, fallbacks: off)',
    '  embedding: openai/text-embedding-x -> llm.provider (ignore some-provider, fallbacks: on)',
    `  speech: ${ROLE_DEFAULTS.speech} -> llm.provider (ignore some-provider, fallbacks: on)`,
    '  drawing: openai/gpt-image-x -> image.provider (only openai, fallbacks: on)',
    `  scout: ${ROLE_DEFAULTS.scout} -> OpenCode's own routing (llm.providerByModel not read)`,
    `  server: ${ROLE_DEFAULTS.server} -> OpenCode's own routing (llm.providerByModel not read)`,
    `  thinker: ${ROLE_DEFAULTS.thinker} -> OpenCode's own routing (llm.providerByModel not read)`,
    `  dev: ${ROLE_DEFAULTS.dev} -> OpenCode's own routing (llm.providerByModel not read)`,
  ]);
});

test('access: route.list is read-only, route.set and route.remove open a write; none is open to a non-owner by default', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  for (const key of ['route.list', 'route.set', 'route.remove'])
    assert.equal(admin.isAllowed(key, { userId: '999' }), false, key);
  assert.equal(admin.isAllowed('route.set', { userId: '42' }), true, 'the owner');

  assert.ok(!(await admin.run('access.grant', { command: 'route.list' }, {})).includes('Note:'));
  assert.ok((await admin.run('access.grant', { command: 'route.set', roleId: '7' }, {})).includes('Note:'));
  assert.ok((await admin.run('access.grant', { command: 'route.remove', userId: '8' }, {})).includes('Note:'));
  assert.ok((await admin.run('access.grant', { command: 'route' }, {})).includes('Note:'));
});

// ---------------------------------------------------------------------------
// memory.recent
// ---------------------------------------------------------------------------

const RECENT_NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const HOUR = 3600 * 1000;

function recentLine(id, hoursAgo, text, extra = {}) {
  return { id, at: RECENT_NOW - hoursAgo * HOUR, addedAt: null, channelId: 'c1', text, who: [], weight: 2, ...extra };
}

function makeRecentAdmin(t, lines, config = {}) {
  t.mock.method(Date, 'now', () => RECENT_NOW);
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.memory = { recentHours: 72 };
  Object.assign(hot.config, config);
  const store = makeStore();
  store.recent.set('g1', { nextId: 100, lines });
  return { ...makeAdmin(rootDir, { hot, store }), store, hot };
}

test('run: memory.recent lists the live lines newest first and leaves out the expired ones', async (t) => {
  const { admin } = makeRecentAdmin(t, [
    recentLine(1, 10, 'older line'),
    recentLine(2, 1, 'newest line'),
    recentLine(3, 100, 'expired line'),
    recentLine(4, 5, 'middle line'),
  ]);

  const rows = (await admin.run('memory.recent', {}, { guildId: 'g1' })).split('\n');

  assert.equal(rows.length, 4, 'the header and three live lines');
  assert.match(rows[0], /3/);
  assert.ok(rows[1].includes('newest line'));
  assert.ok(rows[2].includes('middle line'));
  assert.ok(rows[3].includes('older line'));
  assert.ok(!rows.join('\n').includes('expired line'));
});

test('run: memory.recent resolves <@id> tokens, names the channel from its note and shows the weight', async (t) => {
  const otherId = '999999999999999999';
  const { admin, store } = makeRecentAdmin(t, [recentLine(1, 1, `joked with <@${otherId}>`, { weight: 3 })]);
  store.profiles.set(`g1:${otherId}`, { id: otherId, names: ['Zoe'] });
  store.channels.set('g1:c1', { id: 'c1', name: 'general' });

  const text = await admin.run('memory.recent', {}, { guildId: 'g1' });

  assert.ok(text.includes(`joked with Zoe (id:${otherId})`));
  assert.ok(!text.includes('<@'));
  assert.ok(text.includes('#general'));
  assert.ok(text.includes('w3'));
});

test('run: memory.recent shows the time in the configured time zone', async (t) => {
  const { admin, hot } = makeRecentAdmin(t, [
    { ...recentLine(1, 0, 'late line'), at: Date.UTC(2026, 9, 5, 22, 30, 0) },
  ]);
  hot.config.bot.timezone = 'Europe/Athens';

  const text = await admin.run('memory.recent', {}, { guildId: 'g1' });

  assert.ok(text.includes('2026-10-06 01:30'), text);
});

test('run: memory.recent answers one short line with the switch off or with no live line', async (t) => {
  const off = makeRecentAdmin(t, [recentLine(1, 1, 'a line')], { features: { recent: false } });
  const offText = await off.admin.run('memory.recent', {}, { guildId: 'g1' });
  assert.ok(!offText.includes('\n'));
  assert.ok(!offText.includes('a line'));

  const none = makeRecentAdmin(t, [recentLine(1, 100, 'expired line')]);
  const noneText = await none.admin.run('memory.recent', {}, { guildId: 'g1' });
  assert.ok(!noneText.includes('\n'));
  assert.ok(!noneText.includes('expired line'));
  assert.notEqual(noneText, offText);
});

test('run: memory.recent works while paused, writes nothing and is open to a granted read-only access', async (t) => {
  const { admin, store, hot } = makeRecentAdmin(t, [recentLine(1, 1, 'a line')]);
  store.state.data.paused = true;
  hot.config.bot.access = { 'memory.recent.read': { everyone: false, roles: ['123'], users: [] } };

  const text = await admin.run('memory.recent', {}, { guildId: 'g1' });

  assert.ok(text.includes('a line'));
  assert.equal(store.flushCalls, 0);
  assert.equal(admin.isAllowed('memory.recent', { userId: '7', roleIds: ['123'] }), true);
  assert.equal(admin.isAllowed('memory.recent', { userId: '7', roleIds: [] }), false);
});

// ---------------------------------------------------------------------------
// memory.archive / memory.restore
// ---------------------------------------------------------------------------

test('admin: memory restore re-inserts an episode and writes a restored event, idempotent', async () => {
  const rootDir = makeRoot();
  const mem = await openTestMemory();
  const dataDir = mem.dataDir;
  const appendStore = createAppendStore({ fsyncMs: 0, log: { info() {}, warn() {}, error() {} } });
  const archive = createArchive({
    appendStore,
    dataDir,
    log: { info() {}, warn() {}, error() {} },
    memoryDb: mem.memoryDb,
  });
  const store = createStore({ dataDir, archive, memoryDb: mem.memoryDb });
  const { admin } = makeAdmin(rootDir, { store, archive });
  try {
    const opts = { maxEpisodes: 1, maxNew: 3, now: Date.UTC(2026, 9, 12) };
    store.touchUser('g1', 'u1', 'Zoé', opts.now);
    store.addEpisodes('g1', 'u1', [{ date: '2026-10-01', what: 'Έχασε στο σκάκι', quote: 'ξανά', weight: 1 }], opts);
    const [old] = store.getUser('g1', 'u1').episodes;
    store.addEpisodes('g1', 'u1', [{ date: '2026-10-12', what: 'Κέρδισε στο σκάκι', weight: 3 }], opts);
    await store.settleArchive('g1');
    assert.deepEqual(
      store.getUser('g1', 'u1').episodes.map((ep) => ep.what),
      ['Κέρδισε στο σκάκι'],
      'evicted and archived'
    );

    const listed = await admin.run('memory.archive', { userId: 'u1' }, { guildId: 'g1' });
    assert.match(listed, new RegExp(`evicted\\s+episode\\s+${old.itemId}`));
    assert.match(listed, /Έχασε στο σκάκι/);
    assert.equal(
      await admin.run('memory.archive', { kind: 'episode' }, { guildId: 'g1' }),
      '(none)',
      'nothing at the server level'
    );

    const reply = await admin.run('memory.restore', { itemId: old.itemId }, { guildId: 'g1' });
    assert.match(reply, /restored/);
    const episodes = store.getUser('g1', 'u1').episodes;
    const back = episodes.find((ep) => ep.itemId === old.itemId);
    assert.ok(back, 'the episode is hot again under its own id');
    assert.deepEqual(
      [back.date, back.what, back.quote, back.weight, back.addedAt],
      [old.date, old.what, old.quote, old.weight, old.addedAt]
    );
    assert.equal(episodes.length, 2, 'not pinned, and no cap applied by the restore itself');
    let lines = await archive.find('g1', old.itemId);
    assert.deepEqual(
      lines.map((entry) => [entry.event, entry.by]),
      [
        ['evicted', 'store'],
        ['restored', 'owner'],
      ]
    );

    // Again: the item is hot already, nothing is written.
    const again = await admin.run('memory.restore', { itemId: old.itemId }, { guildId: 'g1' });
    assert.match(again, /already/);
    assert.equal(store.getUser('g1', 'u1').episodes.length, 2);
    lines = await archive.find('g1', old.itemId);
    assert.equal(lines.length, 2);

    await assert.rejects(admin.run('memory.restore', { itemId: 'ep-none' }, { guildId: 'g1' }), /no archived item/);
  } finally {
    await appendStore.close();
    await mem.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// the journal: system records, /nep journal
// ---------------------------------------------------------------------------

/** A journal fake: records every write and call; `read` serves `days[day]` filtered like the real one. */
function fakeJournal(days = {}) {
  const calls = [];
  return {
    calls,
    system: async (guildId, record) => {
      calls.push(['system', guildId, record]);
    },
    read: async (guildId, { day, kind = null, n = 50 }) => {
      calls.push(['read', guildId, { day, kind, n }]);
      return (days[day] ?? []).filter((record) => !kind || record.kind === kind).slice(-n);
    },
    forgetUser: async (guildId, userId) => {
      calls.push(['forgetUser', guildId, userId]);
      return { files: 2, dropped: 5 };
    },
    removeGuild: async (guildId) => {
      calls.push(['removeGuild', guildId]);
      return { files: 3 };
    },
  };
}

/** A client whose channels collect what is sent to them (nothing should be). */
function sendingClient() {
  const sent = [];
  return {
    sent,
    channels: {
      fetch: async (id) => ({
        id,
        send: async (message) => {
          sent.push([id, message]);
        },
      }),
    },
  };
}

test('admin: pause and resume write system records and post nothing to the chat', async () => {
  const rootDir = makeRoot();
  const journal = fakeJournal();
  const client = sendingClient();
  const hot = makeHot(rootDir);
  hot.config.features = { journal: true };
  hot.config.journal = {};
  const { admin } = makeAdmin(rootDir, { hot, client, journal });

  const paused = await admin.run('pause', {}, { guildId: 'g1' });
  assert.match(paused, /^Paused./);
  assert.equal(client.sent.length, 0);
  const pauseRecord = journal.calls.find(([name]) => name === 'system');
  assert.deepEqual(pauseRecord, ['system', 'g1', { event: 'pause', by: 'owner' }]);

  const resumed = await admin.run('resume', {}, { guildId: 'g1' });
  assert.equal(resumed, 'Resumed.');
  assert.equal(client.sent.length, 0);
  const records = journal.calls.filter(([name]) => name === 'system').map(([, , record]) => record);
  assert.deepEqual(records, [
    { event: 'pause', by: 'owner' },
    { event: 'resume', by: 'owner' },
  ]);

  // A repeat pause or resume that changes nothing records nothing.
  await admin.run('resume', {}, { guildId: 'g1' });
  assert.equal(journal.calls.filter(([name]) => name === 'system').length, 2);

  // With the journal off nothing is recorded, and still nothing is posted.
  hot.config.features.journal = false;
  await admin.run('pause', {}, { guildId: 'g1' });
  assert.equal(client.sent.length, 0);
  assert.equal(journal.calls.filter(([name]) => name === 'system').length, 2);
});

test('admin: journal lists the last n records of a day as short lines', async () => {
  const rootDir = makeRoot();
  const day = '2026-10-12';
  const journal = fakeJournal({
    [day]: [
      { kind: 'turn.start', occurredAt: `${day}T10:00:00.000Z`, mode: 'reply', trigger: { kind: 'mention' } },
      { kind: 'action', occurredAt: `${day}T10:00:05.000Z`, name: 'post', phase: 'started' },
      { kind: 'action', occurredAt: `${day}T10:00:06.000Z`, name: 'post', phase: 'succeeded' },
      {
        kind: 'turn',
        occurredAt: `${day}T10:00:07.000Z`,
        mode: 'reply',
        outcome: 'spoke',
        seen: { messageIds: ['m1', 'm2'] },
        think: 'Η Ελένη ρωτά.',
      },
      {
        kind: 'memory',
        occurredAt: `${day}T10:05:00.000Z`,
        batch: { messageIds: ['m1'], consumed: 6 },
        changed: { users: ['u1'] },
        episodes: [],
      },
      { kind: 'system', occurredAt: `${day}T11:00:00.000Z`, event: 'pause', by: 'owner' },
    ],
  });
  const { admin } = makeAdmin(rootDir, { journal });

  const all = await admin.run('memory.journal', { day, n: 3 }, { guildId: 'g1' });
  const lines = all.split('\n');
  assert.deepEqual(lines.slice(1), [
    '10:00:07 turn reply spoke 2 msgs, think: Η Ελένη ρωτά.',
    '10:05:00 memory batch 6 lines, users 1, episodes 0',
    '11:00:00 system pause owner',
  ]);
  assert.match(lines[0], /2026-10-12/);
  assert.deepEqual(journal.calls.at(-1), ['read', 'g1', { day, kind: null, n: 3 }]);

  const actions = await admin.run('memory.journal', { day, kind: 'action' }, { guildId: 'g1' });
  assert.deepEqual(actions.split('\n').slice(1), ['10:00:05 action post started', '10:00:06 action post succeeded']);
  assert.deepEqual(journal.calls.at(-1)[2], { day, kind: 'action', n: 20 });

  // Today (UTC) by default; nothing there is said plainly.
  const today = await admin.run('memory.journal', {}, { guildId: 'g1' });
  assert.equal(journal.calls.at(-1)[2].day, new Date(Date.now()).toISOString().slice(0, 10));
  assert.match(today, /no journal records/);

  await assert.rejects(admin.run('memory.journal', { day: '12.10.2026' }, { guildId: 'g1' }), /YYYY-MM-DD/);
  await assert.rejects(admin.run('memory.journal', { day, n: 51 }, { guildId: 'g1' }), /1\.\.50/);
  await assert.rejects(admin.run('memory.journal', { day, kind: 'lore' }, { guildId: 'g1' }), /kind/);
  // Owner-only: no grant opens it.
  assert.equal(admin.isAllowed('memory.journal', { userId: '42' }), true);
  const openHot = makeHot(rootDir);
  const open = { everyone: true, roles: [], users: [] };
  openHot.config.bot.access = { '*': open, 'memory.profile.read': open, 'memory.journal.read': open };
  const { admin: granted } = makeAdmin(rootDir, { hot: openHot, journal });
  assert.equal(granted.isAllowed('memory.show', { userId: '7' }), true);
  assert.equal(granted.isAllowed('memory.journal', { userId: '7' }), false);
});

// ---------------------------------------------------------------------------
// memory.snapshot
// ---------------------------------------------------------------------------

test('admin: memory snapshot flushes and copies data under the writer lock', async () => {
  const rootDir = makeRoot();
  const dataDir = path.join(rootDir, 'data');
  fs.mkdirSync(path.join(dataDir, 'guilds', 'g1', 'journal'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), '{"paused":false}');
  fs.writeFileSync(path.join(dataDir, 'guilds', 'g1', 'guild.json'), '{"self":["Ζωή"]}');
  fs.writeFileSync(path.join(dataDir, 'guilds', 'g1', 'journal', '2026-10-13.jsonl'), '{"kind":"turn"}\n');
  fs.mkdirSync(path.join(dataDir, 'snapshots', 'older'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'snapshots', 'older', 'state.json'), '{}');

  const order = [];
  let locked = false;
  const journal = {
    ...fakeJournal(),
    async withWriterLock(fn) {
      order.push('lock');
      locked = true;
      try {
        return await fn();
      } finally {
        locked = false;
        order.push('unlock');
      }
    },
  };
  const store = makeStore();
  store.flush = () => {
    order.push(`flush:${locked}`);
  };
  const { admin } = makeAdmin(rootDir, { journal, store });
  const realCp = fs.promises.cp;
  fs.promises.cp = async (...args) => {
    order.push(`copy:${locked}`);
    return realCp(...args);
  };
  let reply;
  try {
    reply = await admin.run('memory.snapshot', {}, { guildId: 'g1', userId: '42' });
  } finally {
    fs.promises.cp = realCp;
  }

  assert.equal(order[0], 'flush:false');
  assert.equal(order[1], 'lock');
  assert.ok(order.slice(2, -1).every((step) => step === 'copy:true'));
  assert.ok(order.includes('copy:true'));
  assert.equal(order.at(-1), 'unlock');

  const made = fs.readdirSync(path.join(dataDir, 'snapshots')).filter((name) => name !== 'older');
  assert.equal(made.length, 1);
  const dest = path.join(dataDir, 'snapshots', made[0]);
  assert.equal(fs.readFileSync(path.join(dest, 'guilds', 'g1', 'guild.json'), 'utf8'), '{"self":["Ζωή"]}');
  assert.equal(
    fs.readFileSync(path.join(dest, 'guilds', 'g1', 'journal', '2026-10-13.jsonl'), 'utf8'),
    '{"kind":"turn"}\n'
  );
  assert.ok(fs.existsSync(path.join(dest, 'state.json')));
  // Earlier snapshots are never copied into a new one.
  assert.ok(!fs.existsSync(path.join(dest, 'snapshots')));
  assert.ok(reply.includes(dest));
  const bytes =
    Buffer.byteLength('{"paused":false}') +
    Buffer.byteLength('{"self":["Ζωή"]}') +
    Buffer.byteLength('{"kind":"turn"}\n');
  assert.ok(reply.includes(`${bytes} bytes`));
});

test('admin: memory snapshot is owner-only and cannot be granted', async () => {
  const rootDir = makeRoot();
  const { admin, hot } = makeAdmin(rootDir);
  hot.config.bot.access = { memory: { everyone: true } };
  assert.equal(admin.isAllowed('memory.snapshot', { userId: '7' }), false);
  assert.equal(admin.isAllowed('memory.snapshot', { userId: '42' }), true);
});
