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
import { createMemoryUpdater } from '../src/memory/update.js';
import { createWarmup } from '../src/memory/warmup.js';
import { createSpontaneous } from '../src/behavior/spontaneous.js';
import { buildDrawPrompt } from '../src/behavior/prompt.js';
import { familyOf, ImageGenError } from '../src/llm/images.js';
import { createLlm } from '../src/llm/openrouter.js';
import { ROLE_DEFAULTS } from '../src/llm/roles.js';
import { createMetrics } from '../src/ops/metrics.js';
import { resolveCommand } from '../src/ops/index.js';
import { getOp } from '../src/ops/registry.js';
import { splitPath } from '../src/ops/shared.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { createDiscordInterface } from '../src/interface/discord.js';
import { tempDir } from './fixtures/tmp.js';

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
    ['one heading', '## Rules\n\n- existing\n', 'new one', '## Rules\n\n- existing\n- new one\n', ['existing', 'new one']],
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
  assert.deepEqual(setPath({ roles: { voice: 'v' } }, ['roles', 'agent.web'], 'w'), { roles: { voice: 'v', 'agent.web': 'w' } });
  assert.deepEqual(unsetPath({ roles: { 'agent.web': 'w', voice: 'v' } }, ['roles', 'agent.web']), { roles: { voice: 'v' } });
  const reference = { roles: { 'agent.web': 'w', agent: { x: 1 } }, llm: { keyByRole: { 'agent.dev': 'K' } } };
  assert.deepEqual(splitPath('roles.agent.web', reference), ['roles', 'agent.web'], 'the longest own key wins');
  assert.deepEqual(splitPath('roles.agent.x', reference), ['roles', 'agent', 'x']);
  assert.deepEqual(splitPath('llm.keyByRole.agent.dev', reference), ['llm', 'keyByRole', 'agent.dev']);
  assert.deepEqual(splitPath('roles.new.key', reference), ['roles', 'new', 'key'], 'a key the reference lacks: every dot separates');
  assert.deepEqual(splitPath('roles.agent.web'), ['roles', 'agent', 'web'], 'no reference: every dot separates');
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
  assert.ok(text.includes('interests: 40 stored'), 'the top-5 interest topics stay short by construction, so this is not truncated');
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
      roles: { voice: 'anthropic/claude-opus-4.6' },
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
    forgetDeps: null,
    forgetResult: null,
    forgetUser(guildId, userId, deps) {
      forgotten.push([String(guildId), String(userId)]);
      this.forgetDeps = deps;
      profiles.delete(`${guildId}:${userId}`);
      privates.delete(`${guildId}:${userId}`);
      return Promise.resolve(this.forgetResult ?? { vault: `/data/vault/forget-${userId}`, counts: { profile: 1, journal: 5 } });
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
    forgetPrivate(guildId, userId) {
      forgottenPrivate.push([String(guildId), String(userId)]);
      privates.delete(`${guildId}:${userId}`);
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
    listGuilds() {
      return [];
    },
    wipeCalls: [],
    vaultCalls: [],
    vaultGuild(guildId, opts) {
      this.vaultCalls.push([String(guildId), opts]);
      return '/data/vault/wipe-1';
    },
    wipeGuild(guildId, opts) {
      this.wipeCalls.push([String(guildId), opts]);
      return { users: 2, channels: 1, loreRemoved: 3, loreKept: 1, bufferMessages: 5, privateLayers: 1, recordFiles: 4, archiveFiles: 2, backfillFiles: 1 };
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
    client: extra.client ?? {},
    spontaneous: extra.spontaneous ?? {},
    calibrator: extra.calibrator ?? { ratio: 1 },
    getGuildId: extra.getGuildId ?? (() => 'g1'),
    isWarmingUp: extra.isWarmingUp,
    turns: extra.turns,
    memory: extra.memory,
    pending: extra.pending,
    warmup: extra.warmup,
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
  assert.equal(admin.isAllowed('memory.wipe', { userId: '42' }), true);
  assert.equal(admin.isAllowed('memory.wipe', { userId: '999' }), false);
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

  const result = await admin.run('set', { path: 'roles.voice', value: '"openrouter/test-model"' }, {});

  assert.deepEqual(readLocal(rootDir), { roles: { voice: 'openrouter/test-model' } });
  assert.equal(hot.reloadConfigCalls, 1);
  assert.ok(result.includes('Set roles.voice'));
});

test('run: set falls back to the raw string when the value is not valid JSON', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await admin.run('set', { path: 'roles.voice', value: 'plain-text-model' }, {});
  assert.deepEqual(readLocal(rootDir), { roles: { voice: 'plain-text-model' } });
});

test('run: set rejects an unknown config path and writes nothing', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await assert.rejects(
    () => admin.run('set', { path: 'llm.doesNotExist', value: '1' }, {}),
    /unknown config path/,
  );
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
});

test('run: unset removes a previously set override', async () => {
  const rootDir = makeRoot();
  const { admin, hot } = makeAdmin(rootDir);

  await admin.run('set', { path: 'roles.voice', value: '"temp-model"' }, {});
  await admin.run('unset', { path: 'roles.voice' }, {});

  assert.deepEqual(readLocal(rootDir), {});
  assert.equal(hot.reloadConfigCalls, 2);
});

test('run: set and unset read a role name with a dot as one key, never a path', async () => {
  const rootDir = makeRoot();
  const { admin, hot } = makeAdmin(rootDir);
  hot.config.roles = { ...hot.config.roles, 'agent.web': 'openrouter/a/b', 'agent.dev': 'openrouter/c/d' };
  hot.config.llm.keyByRole = { 'agent.web': 'OPENROUTER_AGENT_KEY' };

  const result = await admin.run('set', { path: 'roles.agent.web', value: 'openrouter/x-ai/web-model' }, {});
  assert.ok(result.startsWith('Set roles.agent.web = "openrouter/x-ai/web-model"'), result);
  await admin.run('set', { path: 'llm.keyByRole.agent.web', value: 'OPENROUTER_OTHER_KEY' }, {});
  assert.deepEqual(readLocal(rootDir), { roles: { 'agent.web': 'openrouter/x-ai/web-model' }, llm: { keyByRole: { 'agent.web': 'OPENROUTER_OTHER_KEY' } } });

  await admin.run('unset', { path: 'roles.agent.web' }, {});
  assert.deepEqual(readLocal(rootDir), { llm: { keyByRole: { 'agent.web': 'OPENROUTER_OTHER_KEY' } } });
  await assert.rejects(() => admin.run('set', { path: 'roles.agent', value: '"x/y"' }, {}), /unknown config path: roles\.agent/);
});

test('set: a non-owner granted set cannot touch bot.owners or bot.access; an owner can', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.bot.access = { 'config.set': { everyone: false, roles: [], users: ['999'] }, 'config.unset': { everyone: false, roles: [], users: ['999'] } };
  const { admin } = makeAdmin(rootDir, { hot });
  assert.equal(admin.isAllowed('set', { userId: '999', roleIds: [] }), true, 'the non-owner holds the grant');

  const stranger = { guildId: 'g1', userId: '999' };
  await assert.rejects(() => admin.run('set', { path: 'bot.owners', value: '["42","999"]' }, stranger), /only an owner may change bot\.owners/);
  await assert.rejects(() => admin.run('set', { path: 'bot.access.set', value: '{}' }, stranger), /only an owner may change bot\.access/);
  await assert.rejects(() => admin.run('unset', { path: 'bot.owners' }, stranger), /only an owner may change bot\.owners/);
  await assert.rejects(() => admin.run('unset', { path: 'bot.access' }, stranger), /only an owner may change bot\.access/);
  await assert.rejects(() => admin.run('unset', { path: 'bot' }, stranger), /only an owner may change bot/);
  await assert.rejects(() => admin.run('set', { path: 'bot..owners', value: '["999"]' }, stranger), /only an owner/);
  await assert.rejects(() => admin.run('set', { path: 'bot.owners', value: '["999"]' }, {}), /only an owner/, 'no caller is no owner');
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false, 'nothing was written');

  const result = await admin.run('set', { path: 'bot.owners', value: '["42","7"]' }, { guildId: 'g1', userId: '42' });
  assert.match(result, /^Set bot\.owners/);
  assert.deepEqual(readLocal(rootDir), { bot: { owners: ['42', '7'] } });
});

test('set: accepts only an own leaf path of the live config and a value of the same JSON type', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.roles = { ...hot.config.roles, extractor: null };
  hot.config.features = { dryRun: false };
  const { admin } = makeAdmin(rootDir, { hot });
  const owner = { userId: '42' };

  await assert.rejects(() => admin.run('set', { path: 'toString', value: '1' }, owner), /unknown config path: toString/);
  await assert.rejects(() => admin.run('set', { path: 'llm.hasOwnProperty', value: '1' }, owner), /unknown config path: llm\.hasOwnProperty/);
  await assert.rejects(() => admin.run('set', { path: 'llm', value: '5' }, owner), /llm is a section/);
  await assert.rejects(() => admin.run('set', { path: 'llm.maxRequestsPerDay', value: '3OO' }, owner), /llm\.maxRequestsPerDay expects a number, got a string/);
  await assert.rejects(() => admin.run('set', { path: 'features.dryRun', value: '"true"' }, owner), /features\.dryRun expects a boolean, got a string/);
  await assert.rejects(() => admin.run('set', { path: 'bot.owners', value: '"42"' }, owner), /bot\.owners expects an array, got a string/);
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false, 'nothing was written');

  await admin.run('set', { path: 'llm.maxRequestsPerDay', value: '250' }, owner);
  await admin.run('set', { path: 'features.dryRun', value: 'true' }, owner);
  await admin.run('set', { path: 'roles.extractor', value: '"x/y"' }, owner); // the current value is null: any type
  await admin.run('set', { path: 'roles.voice', value: '123' }, owner); // a string setting keeps the text as typed
  assert.deepEqual(readLocal(rootDir), {
    llm: { maxRequestsPerDay: 250 },
    roles: { extractor: 'x/y', voice: '123' },
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
  hot.config.roles = { ...hot.config.roles, vision: 'anthropic/claude-haiku-4.5' };
  hot.config.features = { mediaDescriptions: false };
  return hot;
}

test('run: model.show lists each role with its own model; an unset role shows its own default, never another role\'s', async () => {
  const rootDir = makeRoot();
  const hot = makeHotWithMedia(rootDir);
  const { admin } = makeAdmin(rootDir, { hot });

  const lines = (await admin.run('model.show', {}, {})).split('\n');
  assert.ok(lines.includes('vision: anthropic/claude-haiku-4.5'));
  assert.ok(lines.includes(`analyzer: ${ROLE_DEFAULTS.analyzer}`), 'the analyzer is not the vision model');
  assert.ok(lines.includes(`reasoner: ${ROLE_DEFAULTS.reasoner}`));
  assert.deepEqual(lines.slice(0, 8).map((line) => line.split(':')[0]), ['voice', 'analyzer', 'reasoner', 'extractor', 'vision', 'video', 'embedding', 'drawing']);
  assert.deepEqual(lines.slice(8, 12), [
    `agent.web: ${ROLE_DEFAULTS['agent.web']}`,
    `agent.server: ${ROLE_DEFAULTS['agent.server']}`,
    `agent.dev: ${ROLE_DEFAULTS['agent.dev']}`,
    `agent.advice: ${ROLE_DEFAULTS['agent.advice']}`,
  ], 'the agent roles after drawing, each with its model id');
});

test('run: model.show ignores the deprecated keys of an old config.local.json', async () => {
  const rootDir = makeRoot();
  const hot = makeHotWithMedia(rootDir);
  hot.config.roles = { voice: 'anthropic/claude-opus-4.6' };
  hot.config.llm.classifierModel = 'openrouter/old-classifier';
  hot.config.mention = { followUpModel: 'openrouter/older-classifier' };
  hot.config.media = { model: 'openrouter/old-media', video: { model: 'openrouter/old-video' } };
  const { admin } = makeAdmin(rootDir, { hot });

  const lines = (await admin.run('model.show', {}, {})).split('\n');
  assert.ok(lines.includes(`analyzer: ${ROLE_DEFAULTS.analyzer}`));
  assert.ok(lines.includes(`vision: ${ROLE_DEFAULTS.vision}`));
  assert.ok(lines.includes(`video: ${ROLE_DEFAULTS.video}`));
  assert.ok(!lines.some((l) => l.includes('openrouter/old')), 'no deprecated key is shown');
  assert.ok(!lines.some((l) => /^(followup|media|classifier[.a-z]*|image):/.test(l)), 'the old role names are gone from the listing');
});

test('run: model.set writes the roles path of each role', async () => {
  const rootDir = makeRoot();
  const hot = makeHotWithMedia(rootDir);
  const changedAt = Date.UTC(2026, 9, 15, 9, 30);
  const { admin } = makeAdmin(rootDir, { hot, now: () => changedAt });

  await admin.run('model.set', { role: 'voice', id: 'anthropic/claude-opus-4.6' }, {});
  assert.deepEqual(readLocal(rootDir), { roles: { voice: 'anthropic/claude-opus-4.6' } });

  await admin.run('model.set', { role: 'analyzer', id: 'openrouter/text-model' }, {});
  await admin.run('model.set', { role: 'reasoner', id: 'openrouter/reason-model' }, {});
  await admin.run('model.set', { role: 'extractor', id: 'openrouter/cheap-model' }, {});
  await admin.run('model.set', { role: 'vision', id: 'anthropic/claude-haiku-4.5' }, {});
  await admin.run('model.set', { role: 'video', id: 'openrouter/video-model' }, {});
  await admin.run('model.set', { role: 'embedding', id: 'openai/text-embedding-3-small' }, {});
  await admin.run('model.set', { role: 'drawing', id: 'openai/gpt-image-x' }, {});
  await admin.run('model.set', { role: 'agent.web', id: 'openrouter/x-ai/web-model' }, {});
  await admin.run('model.set', { role: 'agent.server', id: 'openrouter/x-ai/server-model' }, {});
  await admin.run('model.set', { role: 'agent.dev', id: 'openrouter/anthropic/dev-model' }, {});
  await admin.run('model.set', { role: 'agent.advice', id: 'openai/advice-model' }, {});
  assert.deepEqual(readLocal(rootDir), {
    roles: {
      voice: 'anthropic/claude-opus-4.6',
      analyzer: 'openrouter/text-model',
      reasoner: 'openrouter/reason-model',
      extractor: 'openrouter/cheap-model',
      vision: 'anthropic/claude-haiku-4.5',
      video: 'openrouter/video-model',
      embedding: 'openai/text-embedding-3-small',
      drawing: 'openai/gpt-image-x',
      'agent.web': 'openrouter/x-ai/web-model',
      'agent.server': 'openrouter/x-ai/server-model',
      'agent.dev': 'openrouter/anthropic/dev-model',
      'agent.advice': 'openai/advice-model',
    },
    // The video model changed (the vision one was set to the model it already had).
    media: { recacheBefore: new Date(changedAt).toISOString() },
  });
  assert.equal(hot.reloadConfigCalls, 12);
});

test('run: model.set vision or video sets media.recacheBefore to the moment of the change and says so; other roles never do', async () => {
  const changedAt = Date.UTC(2026, 9, 15, 9, 30);
  const iso = new Date(changedAt).toISOString();
  for (const role of ['vision', 'video']) {
    const rootDir = makeRoot();
    const hot = makeHotWithMedia(rootDir);
    const { admin } = makeAdmin(rootDir, { hot, now: () => changedAt });
    const reply = await admin.run('model.set', { role, id: 'google/a-new-model' }, {});
    assert.deepEqual(readLocal(rootDir), { roles: { [role]: 'google/a-new-model' }, media: { recacheBefore: iso } }, role);
    assert.equal(hot.reloadConfigCalls, 1, `${role}: one write, one reload`);
    assert.match(reply, /^Set (vision|video) model to google\/a-new-model \(reload ok\)\n/);
    assert.ok(reply.includes(`media.recacheBefore set to ${iso}`), role);
  }
  for (const role of ['voice', 'analyzer', 'reasoner', 'extractor', 'embedding', 'drawing', 'agent.web', 'agent.server', 'agent.dev', 'agent.advice']) {
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
  assert.deepEqual(readLocal(rootDir), { roles: { vision: 'anthropic/claude-haiku-4.5' } });
});

test('run: model.set rejects an unknown role and the old role names, and writes nothing', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir) });

  for (const role of ['bogus', 'followup', 'media', 'classifier', 'classifier.text', 'classifier.media', 'image', 'talk', 'agentWeb', 'agentDev']) {
    await assert.rejects(
      () => admin.run('model.set', { role, id: 'x/y' }, {}),
      new RegExp(`unknown role: ${role.replace('.', '\\.')} \\(voice, analyzer, reasoner, extractor, vision, video, embedding, drawing, agent.web, agent.server, agent.dev, agent.advice\\)`),
      role,
    );
  }
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
});

test('run: model.set rejects an id that does not look like a model id', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir) });

  await assert.rejects(() => admin.run('model.set', { role: 'voice', id: 'x' }, {}), /model id/);
  await assert.rejects(() => admin.run('model.set', { role: 'drawing', id: 'has spaces here' }, {}), /model id/);
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
});

test('run: model.set accepts a loosely-valid id (letters, digits, dot, colon, slash, dash, underscore)', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir), now: () => 0 });

  await admin.run('model.set', { role: 'vision', id: 'anthropic/claude-haiku-4.5:beta' }, {});
  assert.deepEqual(readLocal(rootDir), { roles: { vision: 'anthropic/claude-haiku-4.5:beta' }, media: { recacheBefore: new Date(0).toISOString() } });
});

test('model show: the voice role is roles.voice, never the extractor or a stale memory.voiceModel; no talk line', async () => {
  const rootDir = makeRoot();
  const hot = makeHotWithMedia(rootDir);
  hot.config.roles.extractor = 'openai/extractor-model';
  hot.config.memory.voiceModel = 'openrouter/stale-voice-model';
  const { admin } = makeAdmin(rootDir, { hot });

  const lines = (await admin.run('model.show', {}, {})).split('\n');
  assert.ok(lines.includes('voice: anthropic/claude-opus-4.6'));
  assert.ok(lines.includes('extractor: openai/extractor-model'));
  assert.ok(!lines.some((l) => l.startsWith('talk:')), 'no talk role');
  assert.ok(!lines.some((l) => l.includes('stale-voice-model')), 'memory.voiceModel is not read');
});

test('model set drawing: writes roles.drawing to config.local.json, reloads, and model show lists it', async () => {
  const rootDir = makeRoot();
  const hot = makeHotWithMedia(rootDir);
  hot.reloadConfig = function reloadConfig() {
    this.reloadConfigCalls += 1;
    this.config.roles = { ...this.config.roles, ...readLocal(rootDir).roles };
    return true;
  };
  const { admin } = makeAdmin(rootDir, { hot });

  assert.ok((await admin.run('model.show', {}, {})).split('\n').includes(`drawing: ${ROLE_DEFAULTS.drawing}`));
  const reply = await admin.run('model.set', { role: 'drawing', id: 'openai/gpt-image-x' }, {});
  assert.match(reply, /^Set drawing model to openai\/gpt-image-x /);
  assert.deepEqual(readLocal(rootDir), { roles: { drawing: 'openai/gpt-image-x' } });
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
  assert.equal(admin.isAllowed('status', { userId: '999', roleIds: [] }), false, 'a grant on the old command key opens nothing');
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

  await assert.rejects(() => admin.run('pings', { mode: 'maybe' }, { guildId: 'g1', userId: '999' }), /mode must be one of: on, off/);
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

  await assert.rejects(() => admin.run('access.grant', { command: 'pings.set' }, {}), /pings\.set is open to every member and cannot be granted/);
  await assert.rejects(() => admin.run('access.grant', { command: 'pings' }, {}), /pings covers no grantable read operation/);
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
    /give a role or a user, not both/,
  );
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
});

test('run: access.grant rejects an unknown operation and an old command key, writing nothing', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await assert.rejects(() => admin.run('access.grant', { command: 'nonsense' }, {}), /unknown operation: nonsense/);
  await assert.rejects(() => admin.run('access.grant', { command: 'memory.show' }, {}), /unknown operation: memory\.show/);
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
});

test('run: access.list leaves out stale grants: owner-only operations and old command keys', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  const open = { everyone: true, roles: [], users: [] };
  fs.writeFileSync(
    path.join(rootDir, 'config.local.json'),
    JSON.stringify({ bot: { access: { private: open, 'memory.private.read': open, status: open, 'status.show': open } } }),
  );
  assert.equal(await admin.run('access.list', {}, {}), 'status.show: everyone');

  fs.writeFileSync(path.join(rootDir, 'config.local.json'), JSON.stringify({ bot: { access: { 'memory.private.read': open } } }));
  assert.equal(await admin.run('access.list', {}, {}), '(none)');
});

test('run: access.grant twice accumulates -- a second role does not drop the first', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await admin.run('access.grant', { command: 'status.show', roleId: '1' }, {});
  await admin.run('access.grant', { command: 'status.show', roleId: '2' }, {});

  assert.deepEqual(readLocal(rootDir), { bot: { access: { 'status.show': { everyone: false, roles: ['1', '2'], users: [] } } } });
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
  assert.deepEqual(readLocal(rootDir), { bot: { access: { 'status.show': { everyone: false, roles: ['1'], users: [] } } } });
});

test('run: access grant/list/revoke/list round trip -- a group is stored as its read operations, named with their source', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  const reads = ['memory.profile.read', 'memory.channel.read', 'memory.server.read', 'memory.recent.read', 'memory.affinity.read'];

  const granted = await admin.run('access.grant', { command: 'memory', roleId: 'staff' }, {});
  assert.equal(granted.split('\n')[0], `Granted memory to role id:staff as ${reads.join(', ')} (reload ok)`);
  assert.deepEqual(Object.keys(readLocal(rootDir).bot.access).sort(), [...reads].sort(), 'no write, no owner-only op, not the pattern');
  assert.equal(await admin.run('access.list', {}, {}), reads.map((name) => `${name}: role id:staff (expanded from memory, reads only)`).join('\n'));

  // a revoke of the pattern removes the target from every operation under it
  assert.equal(await admin.run('access.revoke', { command: 'memory', roleId: 'staff' }, {}), `Revoked memory (${reads.join(', ')}) from role id:staff (reload ok)`);
  assert.equal(await admin.run('access.list', {}, {}), '(none)');
  assert.equal(await admin.run('access.revoke', { command: 'memory', roleId: 'staff' }, {}), 'Nothing to revoke');
});

test('run: the owner\'s step after the migration -- revoke * everyone, then grant memory.profile.read everyone', async () => {
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
    JSON.stringify({ bot: { access: { memory: { everyone: false, roles: ['staff'], users: [] }, set: { everyone: false, roles: [], users: ['9'] }, 'memory.journal': open, ping: open } } }),
  );

  assert.equal((await admin.migrateAccess('g1')).migrated, true);

  const access = readLocal(rootDir).bot.access;
  assert.deepEqual(access['memory.profile.read'], { everyone: false, roles: ['staff'], users: [], via: { 'role:staff': 'memory' } });
  assert.deepEqual(access['memory.affinity.read'].roles, ['staff']);
  assert.deepEqual(access['config.set'], { everyone: false, roles: [], users: ['9'] });
  for (const key of ['memory', 'set', 'memory.journal', 'ping', 'memory.journal.read', 'memory.affinity.set', 'memory.refresh.user']) {
    assert.equal(Object.hasOwn(access, key), false, key);
  }
  assert.equal(store.getGuild('g1').accessMigrated, 1);
  const records = journal.calls.filter(([kind]) => kind === 'system');
  assert.equal(records.length, 1);
  assert.equal(records[0][2].event, 'access-migrated');
  assert.match(records[0][2].note, /memory -> memory\.profile\.read, memory\.channel\.read, memory\.server\.read, memory\.recent\.read, memory\.affinity\.read/);
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
    ['memory.refresh.user', 'staff', [writes]],
  ]) {
    const target = roleId ? `role id:${roleId}` : 'everyone';
    assert.equal(await admin.run('access.grant', { command, roleId }, {}), [`Granted ${command} to ${target} (reload ok)`, ...notes].join('\n'), command);
  }

  const star = (await admin.run('access.grant', { command: '*', roleId: 'mods' }, {})).split('\n');
  assert.match(star[0], /^Granted \* to role id:mods as status\.show, /);
  assert.equal(star[1], readsOnly);
  const access = readLocal(rootDir).bot.access;
  for (const name of ['draw.create', 'config.set', 'lore.add', 'memory.journal.read', 'memory.wipe', 'pings.get', 'access.list']) {
    assert.ok(!(access[name]?.roles ?? []).includes('mods'), `* never covers ${name}`);
  }
  assert.ok(access['memory.profile.read'].roles.includes('mods'));
});

// ---------------------------------------------------------------------------
// memory.forget / memory.show / memory.affinity
// ---------------------------------------------------------------------------

test('run: memory.forget calls store.forgetUser, clears the profile and says the private memory went too', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', character: 'chatty' });

  const result = await admin.run('memory.forget', { userId: '123' }, { guildId: 'g1' });

  assert.deepEqual(store.forgotten, [['g1', '123']]);
  assert.equal(store.getUser('g1', '123'), null);
  assert.ok(result.includes('Forgot 123'));
  assert.match(result, /private memory/i, 'the reply says the private memory went too');
});

test('run: memory.affinity only reads -- the attitude changes through the memory analyzer alone, never by hand', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', affinity: { score: 12, reason: 'kind words', history: [] } });

  // a score in the arguments (an old caller) reaches no write: the view, the score as it was
  const result = await admin.run('memory.affinity', { userId: '123', score: 77, reason: 'by hand' }, { guildId: 'g1' });
  assert.ok(result.includes('score: 12'), result);
  assert.equal(store.getUser('g1', '123').affinity.score, 12);
  assert.equal(resolveCommand('memory.affinity', { userId: '123', score: 77 }).op, 'memory.affinity.read');
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

  await assert.rejects(() => admin.run('memory.affinity', { userId: '555', score: 10 }, { guildId: 'g1' }), /^Error: no profile for 555$/);
  await assert.rejects(() => admin.run('alias.add', { userId: '555', name: 'Ari' }, { guildId: 'g1' }), /^Error: no profile for 555$/);
  await assert.rejects(() => admin.run('alias.remove', { userId: '555', name: 'Ari' }, { guildId: 'g1' }), /^Error: no profile for 555$/);
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
// private.show / private.forget and the private-aware memory commands
// ---------------------------------------------------------------------------

function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

function samplePrivate(overrides = {}) {
  return {
    relationship: 'trusts the persona with plans',
    interests: [{ topic: 'astronomy', note: 'owns a telescope', weight: 3, firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-20T00:00:00.000Z' }],
    details: [{ id: 1, text: 'studies at night', weight: 2, firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-10T00:00:00.000Z' }],
    detailsSeq: 2,
    episodes: [{ date: '2026-09-15', what: 'shared a café story', quote: 'crème brûlée', weight: 2, addedAt: '2026-09-15T00:00:00.000Z' }],
    affinity: { score: 12, reason: 'kind in private', history: [] },
    firstSeen: '2026-09-01T00:00:00.000Z',
    lastSeen: '2026-09-20T00:00:00.000Z',
    replies: { day: utcToday(), count: 7, noticedDay: '' },
    buffer: [{ id: 'm1', content: 'SECRET-BUFFERED-TEXT', ts: 1 }, { id: 'm2', content: 'another buffered line', ts: 2 }],
    ...overrides,
  };
}

test('run: private.show renders the private layer under the public name, with both scores, replies and buffer size', async () => {
  const rootDir = makeRoot();
  const { admin, hot, store } = makeAdmin(rootDir);
  hot.config.private = { maxPerUserPerDay: 100, maxPerOwnerPerDay: 200 };
  store.profiles.set('g1:123', { id: '123', names: ['Zoé', 'old name'], affinity: { score: 50, reason: 'public reason', history: [] } });
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
  assert.match(result, /buffer: 2\b/);
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

test('run: private.show / private.forget need a user and a resolved guild', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  await assert.rejects(() => admin.run('memory.private', { action: 'show' }, { guildId: 'g1' }), /a user is required/);
  await assert.rejects(() => admin.run('memory.private', { action: 'forget' }, { guildId: 'g1' }), /a user is required/);

  const { admin: unresolved } = makeAdmin(rootDir, { getGuildId: () => null });
  await assert.rejects(() => unresolved.run('memory.private', { action: 'show', userId: '123' }, {}), /no guild resolved yet/);
  await assert.rejects(() => unresolved.run('memory.private', { action: 'forget', userId: '123' }, {}), /no guild resolved yet/);
});

test('run: private.forget removes only the private layer and says so', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', names: ['Zoé'] });
  store.privates.set('g1:123', samplePrivate());

  const result = await admin.run('memory.private', { action: 'forget', userId: '123' }, { guildId: 'g1' });

  assert.deepEqual(store.forgottenPrivate, [['g1', '123']]);
  assert.deepEqual(store.forgotten, [], 'the public profile is never forgotten');
  assert.ok(store.getUser('g1', '123'), 'the public profile stays');
  assert.equal(store.getPrivate('g1', '123'), null);
  assert.match(result, /private memory/i);
  assert.match(result, /123/);
  assert.match(result, /public profile is kept/i);
});

test('run: private.forget is refused while paused; private.show keeps working', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', names: ['Zoé'] });
  store.privates.set('g1:123', samplePrivate());

  await admin.run('pause', {}, {});

  await assert.rejects(() => admin.run('memory.private', { action: 'forget', userId: '123' }, { guildId: 'g1' }), /paused.*resume/i);
  assert.deepEqual(store.forgottenPrivate, []);
  await assert.doesNotReject(() => admin.run('memory.private', { action: 'show', userId: '123' }, { guildId: 'g1' }));
});

// ---------------------------------------------------------------------------
// private.purge
// ---------------------------------------------------------------------------

const BOT_ID = '900';

/** A fake DM channel over `messages` (newest first, numeric snowflake ids): `messages.fetch`
 * pages like discord.js (`{ limit, before }` -> a Map, newest first) and records every call. */
function fakeDmChannel(messages) {
  const fetchCalls = [];
  return {
    fetchCalls,
    messages: {
      async fetch(options) {
        fetchCalls.push({ ...options });
        const older = options.before ? messages.filter((m) => BigInt(m.id) < BigInt(options.before)) : messages;
        return new Map(older.slice(0, options.limit).map((m) => [m.id, m]));
      },
    },
  };
}

/** `count` fake messages, newest first; `isBot(i)` picks the persona's own. Each records its delete. */
function fakeDmMessages(count, isBot, { failDelete = () => false } = {}) {
  const deleted = [];
  const messages = [];
  for (let i = 0; i < count; i += 1) {
    const id = String(100000 + count - i); // descending ids: newest first
    messages.push({
      id,
      author: { id: isBot(i) ? BOT_ID : '123' },
      async delete() {
        if (failDelete(i)) throw new Error('delete failed');
        deleted.push(id);
      },
    });
  }
  return { messages, deleted };
}

function fakeDmClient(channel, { fetchUser, createDM } = {}) {
  const userFetches = [];
  return {
    userFetches,
    user: { id: BOT_ID },
    users: {
      async fetch(userId) {
        userFetches.push(userId);
        if (fetchUser) return fetchUser(userId);
        return { id: userId, createDM: createDM ?? (async () => channel) };
      },
    },
  };
}

test('run: private.purge pages through the DM, deletes only its own messages and forgets the private layer', async () => {
  const rootDir = makeRoot();
  // 150 messages, 60 of them the persona's (every i % 5 < 2), spread over both pages
  const { messages, deleted } = fakeDmMessages(150, (i) => i % 5 < 2);
  const channel = fakeDmChannel(messages);
  const client = fakeDmClient(channel);
  const { admin, store } = makeAdmin(rootDir, { client });
  store.profiles.set('g1:123', { id: '123', names: ['Zoé'] });
  store.privates.set('g1:123', samplePrivate());

  const result = await admin.run('memory.private', { action: 'purge', userId: '123' }, { guildId: 'g1' });

  assert.deepEqual(client.userFetches, ['123']);
  assert.equal(channel.fetchCalls.length, 2, 'a full page of 100, then a short page of 50');
  assert.equal(channel.fetchCalls[0].limit, 100);
  assert.equal(channel.fetchCalls[0].before, undefined);
  assert.equal(channel.fetchCalls[1].before, messages[99].id, 'the second page starts before the oldest of the first');
  assert.equal(deleted.length, 60);
  const ownIds = messages.filter((m) => m.author.id === BOT_ID).map((m) => m.id);
  assert.deepEqual(deleted, ownIds, 'every own message deleted, in order, and nothing else');
  assert.deepEqual(store.forgottenPrivate, [['g1', '123']]);
  assert.ok(store.getUser('g1', '123'), 'the public profile stays');
  assert.match(result, /\b60\b/);
  assert.match(result, /\b0 failed\b/);
  assert.ok(result.split('\n').length <= 2, 'two lines at most');
});

test('run: private.purge counts a failing delete and carries on', async () => {
  const rootDir = makeRoot();
  const { messages, deleted } = fakeDmMessages(10, () => true, { failDelete: (i) => i === 3 || i === 7 });
  const client = fakeDmClient(fakeDmChannel(messages));
  const { admin, store } = makeAdmin(rootDir, { client });
  store.privates.set('g1:123', samplePrivate());

  const result = await admin.run('memory.private', { action: 'purge', userId: '123' }, { guildId: 'g1' });

  assert.equal(deleted.length, 8);
  assert.match(result, /\b8\b/);
  assert.match(result, /\b2 failed\b/);
  assert.deepEqual(store.forgottenPrivate, [['g1', '123']]);
});

test('run: private.purge stops scanning at private.purgeMaxMessages', async () => {
  const rootDir = makeRoot();
  const { messages, deleted } = fakeDmMessages(350, () => true);
  const channel = fakeDmChannel(messages);
  const { admin, hot } = makeAdmin(rootDir, { client: fakeDmClient(channel) });
  hot.config.private = { purgeMaxMessages: 150 };

  await admin.run('memory.private', { action: 'purge', userId: '123' }, { guildId: 'g1' });

  assert.equal(deleted.length, 150);
  assert.equal(channel.fetchCalls.length, 2);
});

test('run: private.purge with a user that cannot be fetched or a DM that cannot be opened deletes nothing', async () => {
  const rootDir = makeRoot();
  const { messages, deleted } = fakeDmMessages(5, () => true);
  const channel = fakeDmChannel(messages);

  const unknown = fakeDmClient(channel, { fetchUser: async () => { throw new Error('Unknown User'); } });
  const { admin, store } = makeAdmin(rootDir, { client: unknown });
  store.privates.set('g1:123', samplePrivate());
  await assert.rejects(() => admin.run('memory.private', { action: 'purge', userId: '123' }, { guildId: 'g1' }), /nothing was deleted/i);

  const closed = fakeDmClient(channel, { createDM: async () => { throw new Error('Cannot open a DM'); } });
  const { admin: admin2 } = makeAdmin(rootDir, { client: closed, store });
  await assert.rejects(() => admin2.run('memory.private', { action: 'purge', userId: '123' }, { guildId: 'g1' }), /nothing was deleted/i);

  assert.equal(channel.fetchCalls.length, 0);
  assert.deepEqual(deleted, []);
  assert.deepEqual(store.forgottenPrivate, [], 'the private memory stays');
});

test('run: private.purge whose first history page fails deletes nothing; a later failure keeps what was done', async () => {
  const rootDir = makeRoot();
  const { messages, deleted } = fakeDmMessages(150, () => true);

  const broken = fakeDmChannel(messages);
  broken.messages.fetch = async () => { throw new Error('Missing Access'); };
  const { admin, store } = makeAdmin(rootDir, { client: fakeDmClient(broken) });
  store.privates.set('g1:123', samplePrivate());
  await assert.rejects(() => admin.run('memory.private', { action: 'purge', userId: '123' }, { guildId: 'g1' }), /nothing was deleted/i);
  assert.deepEqual(deleted, []);
  assert.deepEqual(store.forgottenPrivate, [], 'the private memory stays');

  const flaky = fakeDmChannel(messages);
  const pageOf = flaky.messages.fetch;
  flaky.messages.fetch = async (options) => {
    if (options.before) throw new Error('page fetch failed');
    return pageOf(options);
  };
  const { admin: admin2 } = makeAdmin(rootDir, { client: fakeDmClient(flaky), store });
  const result = await admin2.run('memory.private', { action: 'purge', userId: '123' }, { guildId: 'g1' });
  assert.equal(deleted.length, 100, 'the first page was purged');
  assert.deepEqual(store.forgottenPrivate, [['g1', '123']]);
  assert.match(result, /\b100\b/);
});

test('run: private.purge keeps the private memory when a pause lands while it is deleting', async () => {
  const rootDir = makeRoot();
  const { messages, deleted } = fakeDmMessages(3, () => true);
  const { admin, store } = makeAdmin(rootDir, { client: fakeDmClient(fakeDmChannel(messages)) });
  store.privates.set('g1:123', samplePrivate());
  const firstDelete = messages[0].delete;
  messages[0].delete = async () => {
    store.state.data.paused = true;
    return firstDelete();
  };

  const result = await admin.run('memory.private', { action: 'purge', userId: '123' }, { guildId: 'g1' });

  assert.equal(deleted.length, 3);
  assert.deepEqual(store.forgottenPrivate, [], 'nothing under data/ is written while paused');
  assert.match(result, /paused/i);
  assert.ok(result.split('\n').length <= 2, 'two lines at most');
});

test('run: private.purge is refused while paused, with the same message as private.forget', async () => {
  const rootDir = makeRoot();
  const { messages, deleted } = fakeDmMessages(5, () => true);
  const client = fakeDmClient(fakeDmChannel(messages));
  const { admin, store } = makeAdmin(rootDir, { client });
  store.privates.set('g1:123', samplePrivate());

  await admin.run('pause', {}, {});

  let purgeError;
  let forgetError;
  await admin.run('memory.private', { action: 'purge', userId: '123' }, { guildId: 'g1' }).catch((err) => { purgeError = err; });
  await admin.run('memory.private', { action: 'forget', userId: '123' }, { guildId: 'g1' }).catch((err) => { forgetError = err; });
  assert.ok(purgeError && forgetError);
  assert.equal(purgeError.message, forgetError.message);
  assert.deepEqual(client.userFetches, []);
  assert.deepEqual(deleted, []);
  assert.deepEqual(store.forgottenPrivate, []);
});

test('run: memory.show never shows the private layer', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', names: ['Zoé'], relationship: 'public text', affinity: { score: 50, reason: '', history: [] } });
  store.privates.set('g1:123', samplePrivate());

  const summary = await admin.run('memory.show', { userId: '123' }, { guildId: 'g1' });
  const raw = await admin.run('memory.show', { userId: '123', section: 'raw' }, { guildId: 'g1' });
  for (const text of [summary, raw]) {
    assert.ok(!text.includes('trusts the persona with plans'));
    assert.ok(!text.includes('astronomy'));
  }
});

test('run: private.show / private.forget / memory.forget against the real store', async () => {
  const rootDir = makeRoot();
  const { admin, store, dataDir } = makeRealStoreAdmin(rootDir);
  try {
    store.touchUser('g1', '123', 'Zoé', Date.parse('2026-09-01T00:00:00.000Z'));
    store.applyPrivateOps('g1', '123', {});
    store.adjustPrivateAffinity('g1', '123', 8, 'nice in private', { maxDelta: Infinity, historySize: 10, now: 1 });
    store.pushPrivateBuffer('g1', '123', { id: 'm1', content: 'SECRET-BUFFERED-TEXT', ts: 1 });
    store.bumpPrivateReplies('g1', '123', utcToday());
    store.flush();

    const shown = await admin.run('memory.private', { action: 'show', userId: '123' }, { guildId: 'g1' });
    assert.match(shown.split('\n')[0], /Zoé/);
    assert.match(shown, /private affinity: 8\b/);
    assert.match(shown, /replies today: 1\b/);
    assert.match(shown, /buffer: 1\b/);
    assert.ok(!shown.includes('SECRET-BUFFERED-TEXT'));

    await admin.run('memory.private', { action: 'forget', userId: '123' }, { guildId: 'g1' });
    assert.equal(store.getPrivate('g1', '123'), null);
    assert.ok(store.getUser('g1', '123'), 'the public profile stays');

    store.applyPrivateOps('g1', '123', {});
    store.flush();
    await admin.run('memory.forget', { userId: '123' }, { guildId: 'g1' });
    assert.equal(store.getUser('g1', '123'), null);
    assert.equal(store.getPrivate('g1', '123'), null, 'memory.forget removes the private layer too');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// memory.wipe
// ---------------------------------------------------------------------------

function clientWithGuild(guildId, name) {
  return { guilds: { cache: new Map([[guildId, { id: guildId, name }]]) } };
}

test('run: memory.wipe with a missing confirmation changes nothing', async () => {
  const rootDir = makeRoot();
  const client = clientWithGuild('g1', 'The Server');
  const { admin, store } = makeAdmin(rootDir, { client });

  const result = await admin.run('memory.wipe', {}, { guildId: 'g1' });

  assert.equal(store.wipeCalls.length, 0);
  assert.ok(result.includes('The Server'));
});

test('run: memory.wipe with the exact guild name wipes the guild and reports the counts', async () => {
  const rootDir = makeRoot();
  const client = clientWithGuild('g1', 'The Server');
  const { admin, store } = makeAdmin(rootDir, { client });

  const result = await admin.run('memory.wipe', { confirm: 'The Server' }, { guildId: 'g1' });

  assert.deepEqual(store.wipeCalls, [['g1', { vault: '/data/vault/wipe-1', vaultDir: 'vault' }]]);
  for (const part of [
    'profiles removed: 2', 'private memory removed: 1 private layers', 'record files removed: 4', 'archive files removed: 2',
    'backfill files removed: 1', 'journal: kept (no journal is running)', 'snapshots that lost this server: 0',
    'errand files removed: 0',
  ]) {
    assert.ok(result.includes(part), part);
  }
  assert.ok(result.includes('channels removed: 1'));
  assert.ok(result.includes('lore removed: 3 (kept: 1)'));
  assert.ok(result.includes('buffer messages cleared: 5'));
});

test('run: memory.wipe trims the confirmation text but stays case-sensitive', async () => {
  const rootDir = makeRoot();
  const client = clientWithGuild('g1', 'The Server');
  const { admin, store } = makeAdmin(rootDir, { client });

  await admin.run('memory.wipe', { confirm: '  The Server  ' }, { guildId: 'g1' });
  assert.equal(store.wipeCalls.length, 1);

  await admin.run('memory.wipe', { confirm: 'the server' }, { guildId: 'g1' });
  assert.equal(store.wipeCalls.length, 1, 'a case mismatch must not run the wipe');
});

/** A fake live analyzer whose `waitIdle` resolves only when `finish()` is called. */
function inFlightAnalyzer() {
  let finish;
  const idle = new Promise((resolve) => {
    finish = resolve;
  });
  return { waits: 0, waitIdle() { this.waits += 1; return idle; }, finish: () => finish() };
}

test('memory.forget / memory.private action:forget / memory.wipe: wait for a live-analyzer run in flight before deleting', async () => {
  const rootDir = makeRoot();
  const client = clientWithGuild('g1', 'The Server');
  for (const [key, args, deleted] of [
    ['memory.forget', { userId: '123' }, (store) => store.forgotten.length],
    ['memory.private', { action: 'forget', userId: '123' }, (store) => store.forgottenPrivate.length],
    ['memory.wipe', { confirm: 'The Server' }, (store) => store.wipeCalls.length],
  ]) {
    const memory = inFlightAnalyzer();
    const { admin, store } = makeAdmin(rootDir, { client, memory });
    const pending = admin.run(key, args, { guildId: 'g1' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(memory.waits, 1, key);
    assert.equal(deleted(store), 0, `${key}: nothing deleted while the analyzer runs`);
    memory.finish();
    await pending;
    assert.equal(deleted(store), 1, `${key}: deleted once it landed`);
  }
});

test('memory.forget: a pause that lands while waiting for the analyzer refuses the delete', async () => {
  const rootDir = makeRoot();
  const memory = inFlightAnalyzer();
  const { admin, store } = makeAdmin(rootDir, { memory });
  const pending = admin.run('memory.forget', { userId: '123' }, { guildId: 'g1' });
  await new Promise((resolve) => setImmediate(resolve));
  store.state.data.paused = true;
  memory.finish();
  await assert.rejects(pending, /paused -- run \/nep resume first/);
  assert.deepEqual(store.forgotten, []);
});

// The following memory.show tests exercise `section: 'raw'` (see
// src/admin.js#rawMemoryShowView). The other sections are covered further
// below.

test('run: memory.show section:raw also prints the stored episodes (date, weight, what, quote)', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', {
    id: '123',
    episodes: [{ date: '2026-01-01', what: 'promised to help', quote: 'I got you', feeling: 'touched', weight: 4, addedAt: 'x' }],
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
  assert.ok(freshLine >= 0 && dividerLine > freshLine && ancientLine > dividerLine, 'the freshest ranks first, above the divider; the ancient heavy one sits below it');
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

  const result = await admin.run('memory.show', { userId: '123', section: 'interests', order: 'recent' }, { guildId: 'g1' });
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
    interests: Array.from({ length: 5 }, (_, i) => ({ topic: `T${i}`, note: '', weight: 1, firstSeen: 'a', lastSeen: 'a' })),
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

test('run: alias.add ignores a name equal, case-insensitively, to one of the member\'s display names', async () => {
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
    /paused.*resume/i,
  );
  await assert.rejects(
    () => admin.run('alias.remove', { userId: '123', name: 'Ari' }, { guildId: 'g1' }),
    /paused.*resume/i,
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
    assert.deepEqual(store.getGuild('g1').learned.map((i) => i.id), [2]);
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

  const result = await admin.run('lore.add', { title: 'Founders Day', keys: ' founders , founding day ', text: 'The server was founded then.' }, { guildId: 'g1' });

  assert.ok(result.includes('Founders Day'));
  const [entry] = store.getLore('g1');
  assert.equal(entry.title, 'Founders Day');
  assert.deepEqual(entry.keys, ['founders', 'founding day']);
  assert.equal(entry.source, 'owner');
});

test('run: lore.add overwrites an existing analyzer entry and it becomes an owner entry', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.setLore('g1', [{ title: 'Founders Day', keys: ['founders'], text: 'analyzer text' }], { source: 'analyzer', now: 1000 });

  await admin.run('lore.add', { title: 'Founders Day', keys: 'founders', text: 'owner text', always: true }, { guildId: 'g1' });

  const [entry] = store.getLore('g1');
  assert.equal(entry.text, 'owner text');
  assert.equal(entry.source, 'owner');
  assert.equal(entry.always, true);
});

test('run: lore.remove deletes an entry by id and reports its title', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.setLore('g1', [{ title: 'The Flood', keys: ['flood'], text: 'It flooded.' }], { source: 'analyzer', now: 1000 });
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
  const { admin, hot, store } = makeAdmin(rootDir, { journal, archive, client, isWarmingUp: () => true });
  hot.config.roles = { ...hot.config.roles, extractor: 'x/extractor' };
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
  assert.deepEqual(fields.map((f) => f.name), ['state', 'tasks', 'models', 'limits', 'keys', 'costs', 'memory', 'speed']);
  const value = (name) => fields.find((f) => f.name === name).value;
  const stateLines = value('state').split('\n');
  assert.deepEqual(stateLines.slice(0, 4), [
    'paused since 2026-10-13 08:30 UTC by <@42>',
    'storage: append store stalled; 3 archive copies pending',
    'gateway 42 ms',
    'last reconnect none',
  ], 'the state, then the connection');
  assert.match(stateLines[4], /^uptime (\d+d )?(\d+h )?\d+m$/, 'the uptime last');
  assert.equal(stateLines.length, 5);
  assert.equal(value('tasks'), 'archive drain: 3 pending', 'a warmup is not a long task of the card');
  assert.equal(
    value('models'),
    [
      'voice · anthropic/claude-opus-4.6',
      `analyzer · ${ROLE_DEFAULTS.analyzer}`,
      `reasoner · ${ROLE_DEFAULTS.reasoner}`,
      'extractor · x/extractor',
      `vision · ${ROLE_DEFAULTS.vision}`,
      `video · ${ROLE_DEFAULTS.video}`,
      `embedding · ${ROLE_DEFAULTS.embedding}`,
      `drawing · ${ROLE_DEFAULTS.drawing}`,
      `agent.web · ${ROLE_DEFAULTS['agent.web']}`,
      `agent.server · ${ROLE_DEFAULTS['agent.server']}`,
      `agent.dev · ${ROLE_DEFAULTS['agent.dev']}`,
      `agent.advice · ${ROLE_DEFAULTS['agent.advice']}`,
    ].join('\n'),
    'no llm client: one line per role with its own model, unprobed',
  );
  assert.match(value('limits'), /^requests \d+\/300\nvideos 0\/40\nrecall 0\/100\nlookups 0\/60\nresets 00:00 UTC$/);
  assert.deepEqual(
    value('memory').split('\n').map((line) => line.slice(0, line.indexOf(':'))),
    ['chat window', 'record', 'index', 'archive', 'profiles', 'server notes', 'channels', 'recent lines', 'participation fragments'],
  );
  assert.match(value('memory'), /^chat window: last 60 messages in the active channel\n/);
  assert.ok(!/buffer|pending|journal/.test(value('memory')), 'no buffer, archive queue or journal line in memory');
  assert.equal(value('speed'), 'not available', 'no metrics wired');
  for (const field of fields) assert.ok(field.value.length > 0 && field.value.length <= 1024, field.name);

  const member = await admin.run('status', {}, { userId: '999' });
  const memberFields = member.embeds[0].fields;
  assert.deepEqual(memberFields.map((f) => f.name), ['state', 'tasks', 'models', 'limits']);
  assert.deepEqual(memberFields[0].value.split('\n').slice(0, 2), ['paused since 2026-10-13 08:30 UTC by <@42>', 'gateway 42 ms'], 'no storage line for a member');
  assert.equal(member.text, '', 'a member never gets the long form');
});

test('status: the owner card shows the limit of each key with its usage under it, then today by role, with no credits read; a member gets neither field and no read', async () => {
  const rootDir = makeRoot();
  const reads = [];
  const key = {
    label: 'sk-or-v1-hidden',
    limit: 30,
    limit_reset: 'daily',
    budgets: [{ scope: 'key_limit', limit_usd: 30, spend_usd: 8.45, reset_interval: 'daily', resets_at: '2026-10-16T00:00:00.000Z', include_byok: true }],
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
  let rows = [{ role: 'voice', requests: 38, promptTokens: 974_000, cachedTokens: 342_000, completionTokens: 9_300, cost: 4.03 }];
  const usage = { byRole: () => rows };
  const { admin, hot } = makeAdmin(rootDir, { llm, usage });
  hot.prompts.labels = labels;
  hot.config.llm.probeTimeoutMs = 1234;

  const fieldOf = async (name) => (await admin.run('status', {}, { userId: '42' })).embeds[0].fields.find((f) => f.name === name).value;
  assert.deepEqual((await fieldOf('keys')).split('\n'), [
    'main 8.45/30.00 USD (resets daily at 2026-10-16 00:00 UTC; BYOK in)',
    'usage day 0.10 USD',
    'sim: not set',
  ]);
  assert.deepEqual((await fieldOf('costs')).split('\n'), [
    'voice: 38 req, in 974k (cached 342k), out 9.3k, 4.03 USD',
  ], 'no header, no total');
  assert.deepEqual(reads, [['key', 1234], ['key', 1234]], 'the key read with the probe timeout, once per card; never the credits');

  // Too many roles for one field: whole lines are cut from the bottom.
  rows = Array.from({ length: 40 }, (_, i) => ({ role: `role-${i}`, requests: 1, promptTokens: 1000, cachedTokens: 0, completionTokens: 10, cost: 0.01 }));
  const long = await fieldOf('costs');
  assert.ok(long.length <= 1024);
  assert.match(long.split('\n').at(-1), /^role-\d+: 1 req, in 1\.0k \(cached 0\), out 10, 0\.01 USD$/, 'the last line is whole');
  rows = [];
  assert.equal(await fieldOf('costs'), 'today by role: none');

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
  const usage = { byRole: () => [{ role: 'voice', requests: 1, promptTokens: 1, cachedTokens: 0, completionTokens: 1, cost: 0.5 }] };
  const { admin, hot } = makeAdmin(rootDir, { llm, usage, images: fakeImages({ quota: { used: 0, cap: 5 } }), managementKey: 'mgmt-test' });
  probeConfig(hot);
  hot.prompts.labels.status.costs = labels.status.costs;
  hot.config.llm.maxRequestsPerDay = 300;

  const only = async (field, userId = '42') => (await admin.run('status', { field }, { userId })).embeds[0].fields;
  const limits = await only('limits');
  assert.deepEqual(limits.map((f) => f.name), ['limits']);
  assert.match(limits[0].value, /^requests \d+\/300\n/);
  assert.deepEqual([llm.calls.length, llm.listings.length, reads.length], [0, 0, 0], 'no probe, no listing, no key read');

  assert.deepEqual((await only('costs')).map((f) => f.name), ['costs']);
  assert.deepEqual([llm.calls.length, reads.length], [0, 0], 'the role costs read no key');

  const keys = await only('keys');
  assert.deepEqual(keys.map((f) => f.name), ['keys']);
  assert.deepEqual(reads.sort(), ['activity', 'key'], 'the key and its activity read once each');
  assert.equal(llm.calls.length, 0, 'no model probe for the key field');

  assert.deepEqual((await only('models')).map((f) => f.name), ['models']);
  assert.ok(llm.calls.length > 0, 'the models field probes');

  // An owner-only field asked by a member, or an unknown one: the whole card the caller may see.
  hot.config.bot.access = { 'status.show': { everyone: true, roles: [], users: [] } };
  assert.deepEqual((await only('memory', '999')).map((f) => f.name), ['state', 'tasks', 'models', 'limits']);
  assert.equal((await only('nonsense')).length, 8);
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
  // The record: four day files over two months, the month indexes naming four messages.
  const recordBase = path.join(rootDir, 'data', 'guilds', 'g1', 'record');
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(recordBase, rel)), { recursive: true });
    fs.writeFileSync(path.join(recordBase, rel), text);
  };
  write('2026-09/2026-09-30.jsonl', '{}\n');
  write('2026-09/ids.json', JSON.stringify(['m1:1']));
  for (const day of ['05', '12', '14']) write(`2026-10/2026-10-${day}.jsonl`, '{}\n');
  write('2026-10/ids.json', JSON.stringify(['m2:1', 'm2:2', 'm3:1', 'm3:deleted', 'm4:1']));
  write('2026-10/notes.txt', 'not a day file');
  const record = { dayFile: (guildId, iso) => path.join(rootDir, 'data', 'guilds', guildId, 'record', iso.slice(0, 7), `${iso.slice(0, 10)}.jsonl`) };
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
  store.profiles.set('g1:u1', { id: 'u1', character: 'Ήσυχη και αστεία', episodes: [{}, {}, {}], details: [{}, {}], aliases: [{}], realName: { name: 'Éloïse' } });
  store.profiles.set('g1:u2', { id: 'u2', character: '', episodes: [{}], details: [], aliases: [] });
  store.profiles.set('g1:u3', { id: 'u3', character: 'Ζωηρός', episodes: [], details: [], aliases: [] });
  store.lore.set('g1', [{ id: 1 }, { id: 2 }]);
  store.guilds.set('g1', { patterns: '', starters: '', injokes: ['α', 'β'], self: ['γ'], learned: [{}, {}, {}], updatedAt: null });
  store.channels.set('g1:c1', { id: 'c1', purpose: 'chat', topics: '', tone: '' });
  store.channels.set('g1:c2', { id: 'c2', purpose: '', topics: '', tone: '' });
  store.channels.set('g1:c3', { id: 'c3', purpose: '', topics: '', tone: 'calm' });
  store.channels.set('g1:c4', { id: 'c4' });
  store.recent.set('g1', { nextId: 3, lines: [{ at: Date.parse('2026-10-12T10:00:00.000Z') }, { at: Date.parse('2026-10-14T09:00:00.000Z') }] });
  store.participation.set('g1', {
    nextId: 3,
    episodes: [
      { startAt: Date.parse('2026-10-13T23:00:00.000Z'), lastAt: Date.parse('2026-10-14T01:00:00.000Z') },
      { startAt: Date.parse('2026-10-10T10:00:00.000Z'), lastAt: Date.parse('2026-10-10T11:00:00.000Z') },
    ],
  });
  const memoryLines = async () => (await admin.run('status', {}, { userId: '42' })).embeds[0].fields.find((f) => f.name === 'memory').value.split('\n');

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
  const speedLines = async () => (await admin.run('status', {}, { userId: '42' })).embeds[0].fields.find((f) => f.name === 'speed').value.split('\n');

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
  assert.equal((await speedLines()).find((line) => line.startsWith('planner')), 'planner: median 700 ms · mean 700 ms (1)');
});

test('status: the speed field ends with today\'s missed-answer figures from the journal, while it is on', async () => {
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
  const speed = async (userId = '42') => (await admin.run('status', {}, { userId })).embeds[0].fields.find((f) => f.name === 'speed')?.value;
  hot.config.features = { ...hot.config.features, journal: true };
  assert.equal(await speed(), 'not available\nmissed: 2 candidates, 1 owed, 1 recovered');
  assert.deepEqual(asked, [['g1', { day: '2026-10-14', kind: 'answer', n: Number.MAX_SAFE_INTEGER }]]);
  assert.equal(await speed('999'), undefined, 'a member has no speed field');
  hot.config.features = { ...hot.config.features, journal: false };
  assert.equal(await speed(), 'not available', 'no journal, no line');
});

test('status: the storage line flags a journal that stopped writing while turns happen', async () => {
  const rootDir = makeRoot();
  const journalDir = tempDir('nep-status-journal-');
  const journal = { dayFile: (guildId, iso) => path.join(journalDir, `${iso.slice(0, 10)}.jsonl`), stalled: () => false };
  const metrics = createMetrics({ dataDir: path.join(rootDir, 'data') });
  const { admin, hot } = makeAdmin(rootDir, { journal, metrics });
  const storage = async () => (await admin.run('status', {}, { userId: '42' })).embeds[0].fields[0].value.split('\n')[1];

  hot.config.features = { journal: true };
  assert.equal(await storage(), 'storage ok', 'no turn in the last hour: nothing to judge');
  metrics.record('reply', 3000);
  assert.equal(await storage(), 'storage: journal not written today while turns happen');
  const today = journal.dayFile('g1', new Date().toISOString());
  fs.writeFileSync(today, '{}\n');
  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
  fs.utimesSync(today, twoHoursAgo, twoHoursAgo);
  assert.match(await storage(), /^storage: journal not written since \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC while turns happen$/);
  fs.utimesSync(today, new Date(), new Date());
  assert.equal(await storage(), 'storage ok');
  hot.config.features = { journal: false };
  fs.utimesSync(today, twoHoursAgo, twoHoursAgo);
  assert.equal(await storage(), 'storage ok', 'the journal switched off is not expected to write');
});

/** A fake llm client for the status probes: `complete` answers each role through `answer` (a
 * function of the role, throwing to fail), recording every call; `modelEndpoints` returns `listing`. */
function fakeProbeLlm(answer, listing = { ok: true, status: 200, json: { data: { architecture: { output_modalities: ['image'] }, endpoints: [{}, {}] } } }) {
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
  hot.config.roles = {
    voice: 'anthropic/claude-opus-4.6',
    analyzer: 'x/text',
    reasoner: 'x/reason',
    extractor: 'x/extractor',
    vision: 'x/media',
    video: 'x/video',
    embedding: 'x/embed',
    drawing: 'openai/gpt-image-1',
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
  const { admin, hot } = makeAdmin(rootDir, { journal, archive, emojiBackfill, gifBackfill, isWarmingUp: () => true, images: fakeImages({ quota: { used: 2, cap: 5 } }), llm, client });
  probeConfig(hot);
  hot.config.media = { video: { maxPerDay: 40 } };
  hot.config.recall = { maxPerDay: 100 };
  hot.config.web = { maxPerDay: 60 };

  const { embeds } = await admin.run('status', {}, { userId: '42' });
  const lines = (name) => embeds[0].fields.find((f) => f.name === name).value.split('\n');
  assert.deepEqual(embeds[0].fields.map((f) => f.name), ['state', 'tasks', 'models', 'limits', 'keys', 'costs', 'memory', 'speed']);
  assert.deepEqual(lines('state').slice(0, 4), ['running', 'storage: 2 archive copies pending', 'gateway 12 ms', 'last reconnect none']);
  assert.match(lines('state')[4], /^uptime /);
  assert.deepEqual(lines('tasks'), ['emoji backfill running', 'GIF backfill running', 'archive drain: 2 pending']);
  assert.deepEqual(lines('limits').map((line) => line.replace(/^requests \d+/, 'requests N')), [
    'requests N/300',
    'images 2/5',
    'videos 0/40',
    'recall 0/100',
    'lookups 0/60',
    'resets 00:00 UTC',
  ]);
  assert.ok(!lines('models').some((line) => line.startsWith('**')), 'no bold heading');
  assert.deepEqual(roleLinesOf(embeds[0].fields.find((f) => f.name === 'models').value).map((line) => line.split(' · ').slice(0, 2).join(' · ')), [
    'voice · anthropic/claude-opus-4.6',
    'analyzer · x/text',
    'reasoner · x/reason',
    'extractor · x/extractor',
    'vision · x/media',
    'video · x/video',
    'embedding · x/embed',
    'drawing · openai/gpt-image-1',
    `agent.web · ${ROLE_DEFAULTS['agent.web']}`,
    `agent.server · ${ROLE_DEFAULTS['agent.server']}`,
    `agent.dev · ${ROLE_DEFAULTS['agent.dev']}`,
    `agent.advice · ${ROLE_DEFAULTS['agent.advice']}`,
  ], 'each line starts with its role and its model');
  assert.ok(!lines('models').some((line) => line.startsWith(' ')), 'no detail line under a role');
  for (const field of embeds[0].fields) assert.ok(field.value.length > 0 && field.value.length <= 1024, field.name);
});

test('status: the limits field names the web search engine (one word), off when no search can run', async () => {
  const rootDir = makeRoot();
  const lookup = { engine: 'exa', ready: true, searchEngine() { return this.engine; }, hasSearch() { return this.ready; } };
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

test('status: the owner card probes every role\'s model and shows its provider and latency, or the failure', async () => {
  const rootDir = makeRoot();
  const funnel = JSON.stringify({ error: { metadata: { routing_funnel: [{ step: 'model', endpoint_count: 3 }, { step: 'provider', endpoint_count: 0 }] } } });
  const llm = fakeProbeLlm((role) => {
    if (role === 'vision') throw Object.assign(new Error('HTTP 503: upstream down'), { body: funnel });
    return { provider: 'Prov', usage: { prompt_tokens: 9, completion_tokens: 1 } };
  });
  const { admin, hot } = makeAdmin(rootDir, { images: fakeImages({ quota: { used: 2, cap: 5 } }), llm });
  probeConfig(hot);
  const modelOf = { voice: 'anthropic/claude-opus-4.6', analyzer: 'x/text', reasoner: 'x/reason', extractor: 'x/extractor', vision: 'x/media', video: 'x/video' };

  const { result, logs } = await withCapturedLogs(() => admin.run('status', {}, { userId: '42' }));
  const lines = roleLinesOf(result.embeds[0].fields.find((f) => f.name === 'models').value);

  assert.deepEqual(llm.calls.map((call) => call.options.role).sort(), Object.keys(modelOf).sort(), 'one probe per role model');
  for (const { messages, options } of llm.calls) {
    assert.deepEqual(messages, [{ role: 'user', content: 'Answer with one word: Ωmega' }]);
    assert.equal(options.model, modelOf[options.role]);
    assert.equal(options.countAgainstDailyCap, false, 'never counted against llm.maxRequestsPerDay');
    assert.equal(options.skipCalibration, true);
    assert.equal(options.origin, 'status');
    assert.equal(options.timeoutMs, 1234);
  }
  assert.deepEqual(llm.listings, [{ model: 'openai/gpt-image-1', options: { timeoutMs: 1234 } }]);

  assert.match(lines[0], /^voice · anthropic\/claude-opus-4\.6 · Prov · ok \d+ ms$/);
  assert.match(lines[1], /^analyzer · x\/text · Prov · ok \d+ ms$/);
  assert.ok(lines.includes('vision · x/media · failed: HTTP 503: upstream down (funnel: provider -> 0 endpoints)'), 'the failing role shows its reason and the routing funnel');
  assert.match(lines.at(-5), /^drawing · openai\/gpt-image-1 · listed, image output, 2 endpoint\(s\), \d+ ms$/);
  assert.deepEqual(lines.slice(-4), [
    `agent.web · ${ROLE_DEFAULTS['agent.web']} · not probed (runs on OpenCode)`,
    `agent.server · ${ROLE_DEFAULTS['agent.server']} · not probed (runs on OpenCode)`,
    `agent.dev · ${ROLE_DEFAULTS['agent.dev']} · not probed (runs on OpenCode)`,
    `agent.advice · ${ROLE_DEFAULTS['agent.advice']} · not probed (used outside the bot)`,
  ], 'the agent roles last, never probed');
  assert.ok(!llm.calls.some((call) => call.options.role.startsWith('agent')), 'no request goes out on an agent role');

  const probed = logs.filter((entry) => entry.msg === 'status: probed');
  assert.equal(probed.length, 1);
  assert.equal(probed[0].ok, 5);
  assert.equal(probed[0].failed, 1);
});

test('status: the member card shows the models one line per role without probing', async () => {
  const rootDir = makeRoot();
  const llm = fakeProbeLlm(() => ({ provider: 'Prov' }));
  const { admin, hot } = makeAdmin(rootDir, { images: fakeImages({ quota: { used: 2, cap: 5 } }), llm });
  probeConfig(hot);
  hot.config.bot.access = { 'status.show': { everyone: true, roles: [], users: [] } };

  const { embeds } = await admin.run('status', {}, { userId: '999' });
  const models = embeds[0].fields.find((f) => f.name === 'models').value;
  assert.equal(
    models,
    [
      'voice · anthropic/claude-opus-4.6',
      'analyzer · x/text',
      'reasoner · x/reason',
      'extractor · x/extractor',
      'vision · x/media',
      'video · x/video',
      'embedding · x/embed',
      'drawing · openai/gpt-image-1',
      `agent.web · ${ROLE_DEFAULTS['agent.web']}`,
      `agent.server · ${ROLE_DEFAULTS['agent.server']}`,
      `agent.dev · ${ROLE_DEFAULTS['agent.dev']}`,
      `agent.advice · ${ROLE_DEFAULTS['agent.advice']}`,
    ].join('\n'),
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
  // The extractor on the voice's model and the reasoner on the analyzer's: one probe for each pair.
  Object.assign(hot.config.roles, { reasoner: 'x/text', extractor: 'anthropic/claude-opus-4.6', video: 'x/media', byPurpose: { lookup: 'x/pinned', describe: 'x/seen' } });
  // A role-specific route keeps the video role's probe apart although its model is the vision one.
  hot.config.llm.providerByModel = { 'x/@video': { only: ['video-host'] } };

  const { result, logs } = await withCapturedLogs(() => admin.run('status', {}, { userId: '42' }));
  const lines = roleLinesOf(result.embeds[0].fields.find((f) => f.name === 'models').value);

  assert.deepEqual(llm.calls.map((call) => [call.options.role, call.options.model]).sort(), [
    ['analyzer', 'x/text'],
    ['video', 'x/media'],
    ['vision', 'x/media'],
    ['voice', 'anthropic/claude-opus-4.6'],
  ], 'one chat probe per (model, route); the reasoner shares the analyzer probe, the extractor the voice one');
  assert.deepEqual(embedCalls.map((call) => call.texts), [['Answer with one word: Ωmega']], 'one embedding request of one input');
  assert.equal(embedCalls[0].options.countAgainstDailyCap, false);
  assert.equal(embedCalls[0].options.origin, 'status');
  assert.equal(embedCalls[0].options.timeoutMs, 1234);
  assert.equal(embedCalls[0].options.config, hot.config);
  assert.equal(llm.calls.some((call) => call.options.model === 'x/embed'), false, 'the embedding model is never sent a chat completion');

  assert.match(lines[2], /^reasoner · x\/text · Prov · ok \d+ ms$/, 'its own line, no marker of another role');
  assert.equal(lines[3], 'byPurpose lookup · x/pinned', 'a reasoner override follows the reasoner');
  assert.match(lines[4], /^extractor · anthropic\/claude-opus-4\.6 · Prov · ok \d+ ms$/);
  assert.equal(lines[6], 'byPurpose describe · x/seen', 'a vision override follows the vision role');
  assert.match(lines[8], /^embedding · x\/embed · - · ok \d+ ms$/, 'an embedding answer names no provider');
  assert.equal(logs.find((entry) => entry.msg === 'status: probed').requests, 5);
});

test('status: without an embedding client the embedding role is shown unchecked; an embedding failure shows its reason', async () => {
  const rootDir = makeRoot();
  const llm = fakeProbeLlm(() => ({ provider: 'Prov' }));
  const none = makeAdmin(rootDir, { llm });
  probeConfig(none.hot);
  const unchecked = await none.admin.run('status', {}, { userId: '42' });
  assert.ok(unchecked.embeds[0].fields.find((f) => f.name === 'models').value.split('\n').includes('embedding · x/embed · not checked (no embedding client)'));

  const embedder = { embed: async () => { throw Object.assign(new Error('HTTP 404: no such model'), { statusCode: 404 }); } };
  const failing = makeAdmin(makeRoot(), { llm, embedder });
  probeConfig(failing.hot);
  const { result } = await withCapturedLogs(() => failing.admin.run('status', {}, { userId: '42' }));
  assert.ok(result.embeds[0].fields.find((f) => f.name === 'models').value.split('\n').includes('embedding · x/embed · failed: HTTP 404: no such model'));
});

// ---------------------------------------------------------------------------
// interject / initiate
// ---------------------------------------------------------------------------

function fakeSpontaneous(forceResult) {
  const calls = [];
  return {
    calls,
    force: async (channel, mode, options) => {
      calls.push([channel.id, mode, options]);
      return forceResult ?? { ok: true };
    },
  };
}

test('run: message create gives the persona a turn in the context channel, the one who asked its requester', async () => {
  const rootDir = makeRoot();
  const spontaneous = fakeSpontaneous();
  const client = { channels: { fetch: async (id) => ({ id }) } };
  const { admin } = makeAdmin(rootDir, { spontaneous, client });

  const result = await admin.run('message.create', {}, { channelId: 'c1', userId: '42', roleIds: ['r1'] });

  // No mode: the turn reads the channel and joins it or starts a topic itself.
  assert.deepEqual(spontaneous.calls, [['c1', null, { requester: { id: '42', roleIds: ['r1'] } }]]);
  assert.ok(result.includes('message create on c1'), result);
});

test('run: message create uses the channel argument when given, overriding the context channel; a text from a person changes nothing', async () => {
  const rootDir = makeRoot();
  const spontaneous = fakeSpontaneous();
  const client = { channels: { fetch: async (id) => ({ id }) } };
  const { admin } = makeAdmin(rootDir, { spontaneous, client });

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
  const pending = { clear: () => { clearCalls += 1; } };
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

test('run: pause waits for an in-flight live-analyzer run before dropping caches', async () => {
  const rootDir = makeRoot();
  let resolveIdle;
  const idlePromise = new Promise((resolve) => {
    resolveIdle = resolve;
  });
  const memory = { waitIdle: () => idlePromise };
  const { admin, store } = makeAdmin(rootDir, { memory });

  const pausePromise = admin.run('pause', {}, {});
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.dropCachesCalls, 0, 'must not drop caches before the in-flight analyzer run finished');

  resolveIdle();
  await pausePromise;
  assert.equal(store.dropCachesCalls, 1);
});

test('run: pause waits for an in-flight warmup run before dropping caches', async () => {
  const rootDir = makeRoot();
  let resolveIdle;
  const idlePromise = new Promise((resolve) => {
    resolveIdle = resolve;
  });
  const warmup = { waitIdle: () => idlePromise };
  const { admin, store } = makeAdmin(rootDir, { warmup });

  const pausePromise = admin.run('pause', {}, {});
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.dropCachesCalls, 0, 'must not drop caches before the in-flight warmup run finished');

  resolveIdle();
  await pausePromise;
  assert.equal(store.dropCachesCalls, 1);
});

// /nep pause: a live-analyzer run() already in flight when the pause
// arrives (an LLM call can take 30-90s) must be allowed to finish and apply
// normally -- its result must land on disk BEFORE the flush + dropCaches, or
// the eventual applyMemoryUpdate would re-read a profile from disk, mutate it
// and mark it dirty AFTER the owner started editing files under data/ --
// exactly the overwrite this feature exists to prevent. Real store + real
// createMemoryUpdater, only the LLM is faked, so this exercises the actual
// buffer-shift + flush + running.delete() sequence run() performs internally.
function minimalMemoryHot() {
  return {
    config: {
      bot: { timezone: 'UTC' },
      context: { gapMarkerMinutes: 20, maxMessageChars: 800 },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      memory: { batchMessages: 10, minBatchMessages: 1, maxBatchAgeMinutes: 180, maxOutputTokens: 700, fieldChars: 400 },
      features: {},
    },
    prompts: { memory: 'memory system prompt', labels },
  };
}

function slimBufferMessage(overrides = {}) {
  return {
    id: 'm1',
    channelId: 'c1',
    channelName: 'general',
    authorId: 'u2',
    authorName: 'Bob',
    self: false,
    bot: false,
    content: 'hi',
    ts: Date.now(),
    replyToId: null,
    attachments: [],
    links: [],
    stickers: [],
    emojis: [],
    direct: false,
    ...overrides,
  };
}

test('run: pause waits for an in-flight live-analyzer run to finish -- its result is on disk before pause completes, nothing is written after', async () => {
  const rootDir = makeRoot();
  const dataDir = tempDir('nep-admin-data-');
  try {
    const realStore = createStore({ dataDir });
    const guildId = 'g1';
    realStore.pushBuffer(guildId, slimBufferMessage(), 100);

    let resolveLlm;
    const llm = {
      complete: () =>
        new Promise((resolve) => {
          resolveLlm = () => resolve({ text: JSON.stringify({ guild: { patterns: 'set by the in-flight run' } }), usage: {}, estimated: 1 });
        }),
    };
    const calibrator = { ratio: 1, apply: (n) => n, observe: () => {} };
    const memory = createMemoryUpdater({ hot: minimalMemoryHot(), store: realStore, llm, calibrator, getSelfName: () => 'Nept' });

    const runPromise = memory.run(guildId); // in flight: the fake LLM has not resolved yet
    await new Promise((resolve) => setTimeout(resolve, 0)); // let run() reach the pending llm.complete() call

    const { admin } = makeAdmin(rootDir, { store: realStore, memory });
    let pauseResolved = false;
    const pausePromise = admin.run('pause', {}, {}).then((r) => {
      pauseResolved = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(pauseResolved, false, 'pause must wait for the in-flight analyzer run, not race ahead of it');

    resolveLlm(); // the LLM resolves late, after pause was already requested
    await runPromise;
    await pausePromise;

    assert.equal(pauseResolved, true);
    assert.equal(realStore.getGuild(guildId).patterns, 'set by the in-flight run', 'the analyzer result was applied');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'guilds', guildId, 'guild.json'), 'utf8'));
    assert.equal(onDisk.patterns, 'set by the in-flight run', 'and flushed to disk before pause completed');
    assert.deepEqual(realStore.getBuffer(guildId), [], 'the buffer was shifted by the completed run, not left for a later write');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// /nep pause and a portrait refresh in flight (src/memory/warmup.js#refreshPortrait, started by
// src/memory/portrait.js's scheduler, a cue or the owner): pause waits for it through
// warmup.waitIdle, and a refresh whose answer arrives after the pause writes nothing.
test('run: pause waits for a portrait refresh in flight and nothing is written after it', async () => {
  const rootDir = makeRoot();
  const dataDir = tempDir('nep-admin-portrait-');
  try {
    const realStore = createStore({ dataDir });
    const guildId = 'g1';
    const t0 = Date.UTC(2026, 9, 1, 12);
    realStore.touchUser(guildId, 'u1', 'Ἀλκμήνη', t0);
    realStore.applyProfileOps(guildId, 'u1', { character: 'μιλάει πολύ', style: 'σύντομα' }, { fieldChars: 400 });
    realStore.flush();
    const windows = [
      {
        id: 'c1',
        name: 'general',
        category: null,
        topic: null,
        messages: Array.from({ length: 5 }, (_, i) => ({
          ...slimBufferMessage({ id: `m${i}`, authorId: 'u1', authorName: 'Ἀλκμήνη', content: `γεια ${i}`, ts: t0 + i * 60_000 }),
          forwarded: [],
        })),
      },
    ];

    let resolveLlm;
    let sent = 0;
    const llm = {
      complete: () => {
        sent += 1;
        return new Promise((resolve) => {
          resolveLlm = () => resolve({ text: JSON.stringify({ character: 'νέος χαρακτήρας', style: 'νέο ύφος' }), usage: {}, estimated: 1, finishReason: 'stop' });
        });
      },
    };
    const warmupHot = {
      config: {
        bot: { timezone: 'UTC' },
        context: { gapMarkerMinutes: 20, maxMessageChars: 800 },
        roles: { voice: 'x/y', extractor: 'x/y' },
        llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
        memory: { fieldChars: 400, mainChannelIds: [] },
        warmup: { minMessages: 2, contextBefore: 1, maxChannelShare: 1 },
      },
      prompts: { profile: 'PROFILE {{name}}', 'character-card': 'CARD {{name}}', labels },
    };
    const warmup = createWarmup({
      discord: DISCORD,
      hot: warmupHot,
      store: realStore,
      client: { user: { id: 'self' }, guilds: { cache: new Map() } },
      llm,
      calibrator: { ratio: 1, apply: (n) => n, observe: () => {} },
      getSelfName: () => 'Nept',
      now: () => t0 + 30 * 3_600_000,
    });

    const refresh = warmup.refreshPortrait(guildId, 'u1', '', { windows });
    for (let i = 0; i < 50 && sent === 0; i += 1) await Promise.resolve();
    assert.equal(sent, 1, 'the refresh request is in flight');
    const onDiskBefore = fs.readFileSync(path.join(dataDir, 'guilds', guildId, 'users', 'u1.json'), 'utf8');

    const { admin } = makeAdmin(rootDir, { store: realStore, warmup });
    let pauseResolved = false;
    const pausePromise = admin.run('pause', {}, {}).then((r) => {
      pauseResolved = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(pauseResolved, false, 'pause must wait for the refresh in flight');

    resolveLlm();
    const outcome = await refresh;
    await pausePromise;

    assert.equal(pauseResolved, true);
    assert.deepEqual([outcome.ok, outcome.reason], [false, 'paused']);
    assert.equal(realStore.getUser(guildId, 'u1').character, 'μιλάει πολύ', 'the answer that came after the pause is not stored');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'guilds', guildId, 'users', 'u1.json'), 'utf8'));
    assert.equal(onDisk.character, 'μιλάει πολύ');
    assert.equal(onDisk.portraitRefreshedAt, undefined);
    assert.notEqual(JSON.stringify(onDisk), onDiskBefore, 'only the attempt stamp written before the pause reached the disk');
    assert.ok(onDisk.portraitAttemptAt);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// /nep pause and a voice run in flight (src/memory/update.js#runVoice, the two-stage analyzer's
// stage B): pause waits for it through memory.waitIdle, and an answer that arrives after the pause
// writes nothing -- neither the text nor any change to the queued item.
test('run: pause waits for a voice run in flight and nothing is written after it', async () => {
  const rootDir = makeRoot();
  const dataDir = tempDir('nep-admin-voice-');
  try {
    const realStore = createStore({ dataDir });
    const guildId = 'g1';
    const t0 = Date.UTC(2026, 9, 1, 12);
    realStore.touchUser(guildId, 'u2', 'Ἀλκμήνη', t0);
    realStore.updateVoiceQueue(guildId, () => [{ id: 'q-0', kind: 'relationship', userId: 'u2', brief: ['έγιναν φίλοι'], createdAt: t0, attempts: 0, misses: 0, nextAt: t0 }]);
    realStore.flush();
    const queueFile = path.join(dataDir, 'guilds', guildId, 'voice.json');
    const queueBefore = fs.readFileSync(queueFile, 'utf8');

    let resolveLlm;
    let sent = 0;
    const llm = {
      complete: () => {
        sent += 1;
        return new Promise((resolve) => {
          resolveLlm = () => resolve({ text: JSON.stringify({ items: { 1: 'φίλοι πια' } }), usage: {}, estimated: 1, finishReason: 'stop' });
        });
      },
    };
    const hot = minimalMemoryHot();
    hot.config.roles = { voice: 'x/y' };
    hot.config.features.memoryTwoStage = true;
    hot.config.memory.voice = { maxPerDay: 100 };
    hot.prompts['memory-voice'] = 'VOICE {{name}}';
    const calibrator = { ratio: 1, apply: (n) => n, observe: () => {} };
    const memory = createMemoryUpdater({ hot, store: realStore, llm, calibrator, getSelfName: () => 'Nept', now: () => t0 + 60_000 });

    const voice = memory.runVoice(guildId);
    for (let i = 0; i < 50 && sent === 0; i += 1) await Promise.resolve();
    assert.equal(sent, 1, 'the voice request is in flight');

    const { admin } = makeAdmin(rootDir, { store: realStore, memory });
    let pauseResolved = false;
    const pausePromise = admin.run('pause', {}, {}).then((r) => {
      pauseResolved = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(pauseResolved, false, 'pause must wait for the voice run in flight');

    resolveLlm();
    const outcome = await voice;
    await pausePromise;

    assert.equal(pauseResolved, true);
    assert.equal(outcome.reason, 'paused');
    assert.equal(fs.readFileSync(queueFile, 'utf8'), queueBefore, 'the queued item is left exactly as it was');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'guilds', guildId, 'users', 'u2.json'), 'utf8'));
    assert.equal(onDisk.relationship, '', 'the answer that came after the pause is not stored');
    assert.equal(realStore.getUser(guildId, 'u2').relationship, '');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('/nep pause: no timer-driven writer (spontaneous.tick, memory.tick, store.flush) touches data/ while paused', async () => {
  const dataDir = tempDir('nep-admin-timers-');
  try {
    const realStore = createStore({ dataDir });
    const guildId = 'g1';
    realStore.touchUser(guildId, 'u1', 'Alice', 1000);
    realStore.updateGuild(guildId, { patterns: 'x' });
    realStore.pushBuffer(guildId, slimBufferMessage(), 100);
    realStore.flush();

    const userFile = path.join(dataDir, 'guilds', guildId, 'users', 'u1.json');
    const guildFile = path.join(dataDir, 'guilds', guildId, 'guild.json');
    const bufferFile = path.join(dataDir, 'guilds', guildId, 'buffer.json');
    const before = {
      user: fs.statSync(userFile).mtimeMs,
      guild: fs.statSync(guildFile).mtimeMs,
      buffer: fs.statSync(bufferFile).mtimeMs,
    };

    realStore.state.data.paused = true;

    const spontaneous = createSpontaneous({
      discord: DISCORD,
      hot: { config: {} },
      store: realStore,
      client: { guilds: { cache: new Map() } },
      turns: { runTurn: async () => ({ outcome: 'spoke' }), isBusy: () => false, isAnyBusy: () => false, lastPostAt: () => 0 },
      getGuildId: () => guildId,
    });
    const memory = createMemoryUpdater({
      hot: { config: {} },
      store: realStore,
      llm: { complete: async () => { throw new Error('the analyzer must never be called while paused'); } },
      calibrator: { ratio: 1, apply: (n) => n, observe: () => {} },
      getSelfName: () => 'Nept',
    });

    // Mirrors index.js's three periodic timers firing once, back to back.
    await spontaneous.tick();
    await memory.tick();
    realStore.flush();

    assert.equal(fs.statSync(userFile).mtimeMs, before.user);
    assert.equal(fs.statSync(guildFile).mtimeMs, before.guild);
    assert.equal(fs.statSync(bufferFile).mtimeMs, before.buffer);
    assert.equal(JSON.parse(fs.readFileSync(bufferFile, 'utf8')).length, 1, 'the buffered message is left exactly as it was');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
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
  const embedQueue = { catchUp: async (guildId) => { passes.push(guildId); return null; } };
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
    ['memory.forget', { userId: '123' }],
    ['memory.wipe', { confirm: 'The Server' }],
    ['lore.add', { title: 'Y', keys: 'y', text: 'z' }],
    ['lore.remove', { id: loreId }],
    ['message.create', {}],
  ];
  for (const [key, args] of attempts) {
    await assert.rejects(
      () => admin.run(key, args, { guildId: 'g1', channelId: 'c1' }),
      /paused.*resume/i,
      `${key} must be refused while paused`,
    );
  }

  assert.equal(store.forgotten.length, 0);
  assert.equal(store.wipeCalls.length, 0);
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
  await assert.doesNotReject(() => admin.run('set', { path: 'roles.voice', value: '"x/y"' }, {}));
  await assert.doesNotReject(() => admin.run('unset', { path: 'roles.voice' }, {}));
  await assert.doesNotReject(() => admin.run('model.set', { role: 'voice', id: 'x/y' }, {}));
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
// memory.refresh -- a member's portrait, a channel's notes, the server notes, through the warmup
// engine's live paths (src/memory/warmup.js); refused while paused or while a warmup runs.
// ---------------------------------------------------------------------------

function fakeWarmup(overrides = {}) {
  const calls = { refreshChannelNotes: 0, refreshServerNotes: 0, refreshPortrait: 0, runChannel: 0, runServer: 0 };
  return {
    calls,
    refreshChannelNotes: async (guildId, channelId) => {
      calls.refreshChannelNotes += 1;
      calls.lastChannel = [guildId, channelId];
      return overrides.refreshChannelNotes ?? { ok: true, changed: true, sample: 160, authors: 12, days: 30 };
    },
    refreshServerNotes: async (guildId) => {
      calls.refreshServerNotes += 1;
      calls.lastServerGuildId = guildId;
      return overrides.refreshServerNotes ?? { ok: true, changed: false, sample: 150, authors: 20, days: 30 };
    },
    // The warmup passes: a refresh must never take them (whole history, the persona muted).
    runChannel: async () => {
      calls.runChannel += 1;
      return { ok: false };
    },
    runServer: async () => {
      calls.runServer += 1;
      return { ok: false };
    },
    refreshPortrait: async (guildId, userId, reason, opts) => {
      calls.refreshPortrait += 1;
      calls.lastRefreshUserId = userId;
      calls.lastRefreshOpts = opts;
      return overrides.refreshPortrait ?? { ok: true, userId };
    },
  };
}

test('run: memory.refresh kind:user forces a portrait refresh, ignoring the hours rail', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  const body = await admin.run('memory.refresh', { kind: 'user', userId: '1' }, { guildId: 'g1' });
  assert.equal(warmup.calls.refreshPortrait, 1);
  assert.equal(warmup.calls.lastRefreshUserId, '1');
  assert.deepEqual(warmup.calls.lastRefreshOpts, { force: true });
  assert.match(body, /refreshed/);
  await assert.rejects(() => admin.run('memory.refresh', { kind: 'user' }, { guildId: 'g1' }), /a user is required/);
});

test('run: memory.refresh kind:channel rewrites stored notes from a fresh sample, never through the warmup pass', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin, store } = makeAdmin(rootDir, { warmup });
  store.channels.set('g1:c1', { id: 'c1', name: 'general', purpose: 'chat', topics: '', tone: '' });

  const body = await admin.run('memory.refresh', { kind: 'channel', channelId: 'c1' }, { guildId: 'g1' });
  assert.deepEqual(warmup.calls.lastChannel, ['g1', 'c1']);
  assert.equal(warmup.calls.runChannel + warmup.calls.runServer + warmup.calls.refreshServerNotes, 0);
  assert.equal(body, 'Channel notes rewritten from a fresh sample (sample: 160 messages, 12 authors, 30 days).');
  await assert.rejects(() => admin.run('memory.refresh', { kind: 'channel' }, { guildId: 'g1' }), /a channel is required/);
});

test('run: memory.refresh kind:channel on a channel with no notes points to the tool and sends nothing', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin, store } = makeAdmin(rootDir, { warmup });
  store.channels.set('g1:c2', { id: 'c2', name: 'quiet', purpose: '', topics: '', tone: '' });

  for (const channelId of ['c2', 'c9']) {
    const body = await admin.run('memory.refresh', { kind: 'channel', channelId }, { guildId: 'g1' });
    assert.match(body, /no notes yet/, channelId);
    assert.match(body, new RegExp(`tools/warmup\\.mjs channels --channel ${channelId}`), channelId);
  }
  assert.equal(warmup.calls.refreshChannelNotes + warmup.calls.runChannel, 0);
});

test('run: memory.refresh relays why a sampled refresh wrote nothing', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup({
    refreshChannelNotes: { ok: false, reason: 'over-limit', fields: ['topics'] },
    refreshServerNotes: { ok: false, reason: 'llm-error', detail: 'HTTP 502' },
  });
  const { admin, store } = makeAdmin(rootDir, { warmup });
  store.channels.set('g1:c1', { id: 'c1', name: 'general', purpose: 'chat' });

  assert.equal(await admin.run('memory.refresh', { kind: 'channel', channelId: 'c1' }, { guildId: 'g1' }), 'Refresh not performed: over-limit (topics)');
  assert.equal(await admin.run('memory.refresh', { kind: 'server' }, { guildId: 'g1' }), 'Refresh not performed: llm-error (HTTP 502)');
});

test('run: memory.refresh kind:server rewrites the server notes from a fresh sample, never through the warmup pass', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  const body = await admin.run('memory.refresh', { kind: 'server' }, { guildId: 'g1' });
  assert.equal(warmup.calls.refreshServerNotes, 1);
  assert.equal(warmup.calls.lastServerGuildId, 'g1');
  assert.equal(warmup.calls.runServer + warmup.calls.runChannel, 0, 'the lore rebuild stays the tool\'s');
  assert.equal(body, 'Server notes checked against a fresh sample, nothing to change (sample: 150 messages, 20 authors, 30 days).');
});

test('run: memory.refresh of every kind is refused while paused, and while a warmup runs', async () => {
  for (const args of [{ kind: 'user', userId: '1' }, { kind: 'channel', channelId: 'c1' }, { kind: 'server' }]) {
    const paused = fakeWarmup();
    const first = makeAdmin(makeRoot(), { warmup: paused });
    first.store.channels.set('g1:c1', { id: 'c1', purpose: 'chat' });
    await first.admin.run('pause', {}, {});
    await assert.rejects(() => first.admin.run('memory.refresh', args, { guildId: 'g1' }), /paused/, args.kind);

    const busy = fakeWarmup();
    const second = makeAdmin(makeRoot(), { warmup: busy, isWarmingUp: () => true });
    second.store.channels.set('g1:c1', { id: 'c1', purpose: 'chat' });
    assert.match(await second.admin.run('memory.refresh', args, { guildId: 'g1' }), /^Refresh not performed: a warmup is running/, args.kind);

    for (const warmup of [paused, busy]) {
      const { calls } = warmup;
      assert.equal(calls.refreshChannelNotes + calls.refreshServerNotes + calls.refreshPortrait + calls.runChannel + calls.runServer, 0, args.kind);
    }
  }
});

test('run: memory.wipe is refused while a warmup is in flight', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { isWarmingUp: () => true });
  await assert.rejects(
    () => admin.run('memory.wipe', { confirm: 'Guild' }, { guildId: 'g1' }),
    /warmup is running/,
  );
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
  hot.config.roles = { ...hot.config.roles, drawing: model };
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
  const avatarCalls = [];
  return {
    avatarCalls,
    guilds: { cache: new Map([['g1', guild]]) },
    user: {
      username: 'persona-bot',
      displayAvatarURL(opts) {
        avatarCalls.push(opts);
        return 'https://cdn.example/avatar.png';
      },
    },
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
    prompt: buildDrawPrompt({ prompts: hot.prompts, selfName: 'Persona', request: 'a lighthouse at dusk', self: false }),
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
    buildDrawPrompt({ prompts: hot.prompts, selfName: 'Persona', request: 'άλφαβ', self: false }),
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

  assert.deepEqual(client.avatarCalls, [{ extension: 'png', size: 1024, forceStatic: true }]);
  assert.deepEqual(imageFetcher.calls, [
    { url: 'https://cdn.example/avatar.png', opts: { maxBytes: 4000000, timeoutMs: 7000 } },
  ]);
  assert.equal(images.calls[0].reference, 'data:image/png;base64,QUFB');
  assert.equal(images.calls[0].userId, null);
  assert.equal(
    images.calls[0].prompt,
    buildDrawPrompt({ prompts: hot.prompts, selfName: 'Persona', request: 'at the beach', self: true }),
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

test('run: draw with an unsupported image model answers with a message and never generates', async () => {
  const rootDir = makeRoot();
  const hot = hotForDraw(rootDir, { model: 'someone/else-model' });
  const images = fakeImages();
  const { admin } = makeAdmin(rootDir, { hot, images, client: drawClient() });

  const result = await admin.run('draw', { text: 'a cat' }, { guildId: 'g1' });

  assert.equal(typeof result, 'string');
  assert.match(result, /someone\/else-model/);
  assert.match(result, /unsupported/);
  assert.equal(images.calls.length, 0);
});

test('run: draw reports a failed generation with its reason and HTTP status', async () => {
  const rootDir = makeRoot();
  const hot = hotForDraw(rootDir);
  const error = new ImageGenError('moderation', 'image refused by moderation (HTTP 400)', { statusCode: 400, body: 'provider text' });
  const { admin } = makeAdmin(rootDir, { hot, images: fakeImages({ error }), client: drawClient() });

  await assert.rejects(
    () => admin.run('draw', { text: 'a cat' }, { guildId: 'g1' }),
    (err) => /moderation/.test(err.message) && /400/.test(err.message) && !err.message.includes('provider text'),
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
    ['memory.private', ['memory.private.read', 'memory.private.forget', 'memory.private.purge'], ownerOnly],
    ['memory.private', ['memory.private'], /covers no grantable read operation/],
    ['access', ['access.grant', 'access.revoke', 'access.list'], ownerOnly],
    ['access', ['access'], /covers no grantable read operation/],
  ]) {
    const rootDir = makeRoot();
    const { admin } = makeAdmin(rootDir);

    for (const command of commands) {
      await assert.rejects(() => admin.run('access.grant', { command }, {}), refusal, `${group}: ${command}`);
      await assert.rejects(() => admin.run('access.grant', { command, roleId: '1' }, {}), refusal, `${group}: ${command} to a role`);
      await assert.rejects(() => admin.run('access.grant', { command, userId: '2' }, {}), refusal, `${group}: ${command} to a user`);
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
  assert.equal(await bare.run('media', { kind: 'emoji', action: 'rescan' }, { guildId: 'g1' }), 'the emoji backfill is not available');
});

// ---------------------------------------------------------------------------
// gifs.status / gifs.rescan -- the GIF library and its history backfill
// ---------------------------------------------------------------------------

function fakeGifBackfill(result = { ok: true, channels: 3, messages: 120, gifs: 9, described: 4 }, { running = false } = {}) {
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
  assert.equal(await bare.run('media', { kind: 'gifs', action: 'rescan' }, { guildId: 'g1' }), 'the GIF backfill is not available');
});

test('run: gifs.status counts the library by caption format: watched with fields, old format, unwatched', async () => {
  const rootDir = makeRoot();
  const store = makeStore();
  const entry = (n) => ({ id: `g${n}`, kind: 'link', url: `https://tenor.com/view/danse-${n}`, itemId: `m${n}#e0`, count: 5 - n, last: 1 });
  store.getGifs = () => ({ nextId: 5, entries: Object.fromEntries([1, 2, 3, 4].map((n) => [`m${n}#e0`, entry(n)])), backfill: null });
  store.getMediaCache = () => ({
    'm1#e0': { text: 'a cat lifts its chin', reaction: 'agreement', action: 'a cat lifts its chin', screen: 'oui.', ts: 1, watched: true, gif: true },
    'm2#e0': { text: 'a caracal stares', ts: 1, watched: true, gif: true },
    'm3#e0': { text: 'a still', ts: 1, gif: true },
  });
  const { admin } = makeAdmin(rootDir, { store });
  const out = await admin.run('media', { kind: 'gifs', action: 'status' }, { guildId: 'g1' });
  assert.ok(out.includes('caption format: 1 watched with fields, 1 watched in the old format (to re-describe), 2 unwatched'), out);
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
  assert.equal(await bare.run('media', { kind: 'gifs', action: 'recache' }, { guildId: 'g1' }), 'the GIF recache is not available');
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
    await assert.rejects(() => admin.run('media', { kind: 'pictures', action: 'recache', days }, { guildId: 'g1' }), /days must be a whole number from 1 to 60/, String(days));
  }
  await assert.rejects(() => admin.run('media', { kind: 'pictures', action: 'status' }, { guildId: 'g1' }), /kind must be one of: emoji, gifs/);

  const { admin: busy } = makeAdmin(rootDir, { gifRecache: fakeMediaRecache({ ok: false, reason: 'running' }) });
  assert.match(await busy.run('media', { kind: 'pictures', action: 'recache' }, { guildId: 'g1' }), /already running/);
  const { admin: off } = makeAdmin(rootDir, { gifRecache: fakeMediaRecache({ ok: false, reason: 'off' }) });
  assert.match(await off.run('media', { kind: 'pictures', action: 'recache' }, { guildId: 'g1' }), /features\.mediaDescriptions is off/);
  const { admin: bare } = makeAdmin(rootDir);
  assert.equal(await bare.run('media', { kind: 'pictures', action: 'recache' }, { guildId: 'g1' }), 'the media recache is not available');
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
  await admin.run('route.set', { model: 'google/', providers: ' google-ai-studio , google-vertex ,', role: 'video' }, {});
  await admin.run('route.set', { model: 'anthropic/claude-sonnet-4.6', providers: 'amazon-bedrock', role: 'voice', fallbacks: true }, {});

  assert.deepEqual(readLocal(rootDir).llm.providerByModel, {
    'google/': { only: ['google-vertex'], allow_fallbacks: false },
    'google/@video': { only: ['google-ai-studio', 'google-vertex'], allow_fallbacks: false },
    'anthropic/claude-sonnet-4.6@voice': { only: ['amazon-bedrock'], allow_fallbacks: true },
  });
});

test('run: route.set validates the prefix, the providers and the role, writing nothing on an error', async () => {
  const rootDir = makeRoot();
  const { admin, hot } = makeAdmin(rootDir);
  const bad = [
    [{ model: '', providers: 'google-vertex' }, /model/],
    [{ model: '   ', providers: 'google-vertex' }, /model/],
    [{ model: 'google/@voice', providers: 'google-vertex' }, /@/],
    [{ model: 'google /x', providers: 'google-vertex' }, /space/],
    [{ model: '__proto__', providers: 'google-vertex' }, /model/],
    [{ model: 'google/', providers: '' }, /provider/],
    [{ model: 'google/', providers: ' , ' }, /provider/],
    [{ model: 'google/', providers: 'Google-Vertex' }, /provider/],
    [{ model: 'google/', providers: 'google_vertex' }, /provider/],
    [{ model: 'google/', providers: 'google-vertex', role: 'bogus' }, /unknown role: bogus/],
    [{ model: 'google/', providers: 'google-vertex', role: 'classifier' }, /unknown role/],
    [{ model: 'google/', providers: 'google-vertex', role: 'talk' }, /unknown role: talk/],
    // An agent role's OpenCode worker never reads llm.providerByModel: no route may name it.
    [{ model: 'openrouter/', providers: 'openai', role: 'agent.web' }, /unknown role: agent\.web/],
    [{ model: 'openrouter/', providers: 'openai', role: 'agent.dev' }, /unknown role: agent\.dev/],
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
  assert.deepEqual(readLocal(rootDir).llm.providerByModel, { 'google/': { only: ['google-vertex'], allow_fallbacks: false } });
  assert.equal(hot.reloadConfigCalls, 3);

  const before = fs.readFileSync(path.join(rootDir, 'config.local.json'), 'utf8');
  await assert.rejects(() => admin.run('route.remove', { model: 'google/', role: 'voice' }, {}), /no route google\/@voice/);
  await assert.rejects(() => admin.run('route.remove', { model: 'google/', role: 'bogus' }, {}), /unknown role/);
  assert.equal(fs.readFileSync(path.join(rootDir, 'config.local.json'), 'utf8'), before);
  assert.equal(hot.reloadConfigCalls, 3);

  await admin.run('route.remove', { model: 'google/' }, {});
  assert.deepEqual(readLocal(rootDir), {}, 'the emptied map and llm object are pruned');
});

test('run: route.remove edits a route config.local.json still keeps under an old role name, written back under the new one', async () => {
  const rootDir = makeRoot();
  fs.writeFileSync(path.join(rootDir, 'config.local.json'), JSON.stringify({
    classifier: { media: 'x/kept' },
    llm: { providerByModel: { 'google/': { only: ['google-vertex'] }, 'google/@classifier.video': { only: ['google-ai-studio'] }, 'openai/@analyzer': { only: ['openai'] } } },
  }));
  const { admin } = makeAdmin(rootDir);

  const result = await admin.run('route.remove', { model: 'google/', role: 'video' }, {});
  assert.match(result, /google\/@video/);
  assert.deepEqual(readLocal(rootDir), {
    classifier: { media: 'x/kept' },
    llm: { providerByModel: { 'google/': { only: ['google-vertex'] }, 'openai/@extractor': { only: ['openai'] } } },
  }, 'the old memory analyzer route is the extractor one while the file still uses the old model keys');
});

function hotForRoutes(rootDir) {
  const hot = makeHotWithMedia(rootDir);
  hot.config.llm.provider = null;
  hot.config.roles = {
    voice: 'anthropic/claude-opus-4.6',
    analyzer: 'google/gemini-3.8-flash',
    reasoner: 'google/gemini-3.8-flash',
    extractor: 'anthropic/claude-opus-4.6',
    vision: 'google/gemini-3.8-flash',
    video: 'google/gemini-3.8-flash',
    embedding: 'openai/text-embedding-x',
    drawing: 'openai/gpt-image-x',
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
  await admin.run('route.set', { model: 'anthropic/', providers: 'amazon-bedrock,anthropic', role: 'extractor', fallbacks: true, byok: 'true' }, {});

  const lines = (await admin.run('route.list', {}, {})).split('\n');

  assert.deepEqual(lines, [
    'routes:',
    '  anthropic/ | extractor | only amazon-bedrock, anthropic | fallbacks: on | byok: on',
    '  google/ | any | only google-vertex | fallbacks: off | byok: off',
    '  google/ | video | only google-ai-studio | fallbacks: off | byok: off',
    'by role:',
    '  voice: anthropic/claude-opus-4.6 -> llm.provider (ignore some-provider, fallbacks: on)',
    '  analyzer: google/gemini-3.8-flash -> google/ (only google-vertex, fallbacks: off)',
    '  reasoner: google/gemini-3.8-flash -> google/ (only google-vertex, fallbacks: off)',
    '  extractor: anthropic/claude-opus-4.6 -> anthropic/@extractor (only amazon-bedrock, anthropic, fallbacks: on, byok)',
    '  vision: google/gemini-3.8-flash -> google/ (only google-vertex, fallbacks: off)',
    '  video: google/gemini-3.8-flash -> google/@video (only google-ai-studio, fallbacks: off); direct-URL videos: media.video.provider (order google-ai-studio, fallbacks: off)',
    '  embedding: openai/text-embedding-x -> llm.provider (ignore some-provider, fallbacks: on)',
    '  drawing: openai/gpt-image-x -> image.provider (only openai, fallbacks: on)',
    `  agent.web: ${ROLE_DEFAULTS['agent.web']} -> OpenCode's own routing (llm.providerByModel not read)`,
    `  agent.server: ${ROLE_DEFAULTS['agent.server']} -> OpenCode's own routing (llm.providerByModel not read)`,
    `  agent.dev: ${ROLE_DEFAULTS['agent.dev']} -> OpenCode's own routing (llm.providerByModel not read)`,
    `  agent.advice: ${ROLE_DEFAULTS['agent.advice']} -> not routed by the bot (llm.providerByModel not read)`,
  ]);
});

test('run: route.list shows a route key still written with the old role name talk as the route of the voice role', async () => {
  const rootDir = makeRoot();
  const hot = hotForRoutes(rootDir);
  hot.config.llm.providerByModel = { 'anthropic/@talk': { only: ['amazon-bedrock'], allow_fallbacks: false } };
  const { admin } = makeAdmin(rootDir, { hot });

  const lines = (await admin.run('route.list', {}, {})).split('\n');
  assert.ok(lines.includes('  voice: anthropic/claude-opus-4.6 -> anthropic/@talk (only amazon-bedrock, fallbacks: off)'));
  assert.ok(lines.includes('  extractor: anthropic/claude-opus-4.6 -> none'), 'the old name is the voice role only');
});

test('access: route.list is read-only, route.set and route.remove open a write; none is open to a non-owner by default', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  for (const key of ['route.list', 'route.set', 'route.remove']) assert.equal(admin.isAllowed(key, { userId: '999' }), false, key);
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
  const { admin, hot } = makeRecentAdmin(t, [{ ...recentLine(1, 0, 'late line'), at: Date.UTC(2026, 9, 5, 22, 30, 0) }]);
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
  const dataDir = tempDir('nep-admin-archive-');
  const appendStore = createAppendStore({ fsyncMs: 0, log: { info() {}, warn() {}, error() {} } });
  const archive = createArchive({ appendStore, dataDir, log: { info() {}, warn() {}, error() {} } });
  const store = createStore({ dataDir, archive });
  const { admin } = makeAdmin(rootDir, { store, archive });
  try {
    const opts = { maxEpisodes: 1, maxNew: 3, now: Date.UTC(2026, 9, 12) };
    store.touchUser('g1', 'u1', 'Zoé', opts.now);
    store.addEpisodes('g1', 'u1', [{ date: '2026-10-01', what: 'Έχασε στο σκάκι', quote: 'ξανά', weight: 1 }], opts);
    const [old] = store.getUser('g1', 'u1').episodes;
    store.addEpisodes('g1', 'u1', [{ date: '2026-10-12', what: 'Κέρδισε στο σκάκι', weight: 3 }], opts);
    await store.settleArchive('g1');
    assert.deepEqual(store.getUser('g1', 'u1').episodes.map((ep) => ep.what), ['Κέρδισε στο σκάκι'], 'evicted and archived');

    const listed = await admin.run('memory.archive', { userId: 'u1' }, { guildId: 'g1' });
    assert.match(listed, new RegExp(`evicted\\s+episode\\s+${old.itemId}`));
    assert.match(listed, /Έχασε στο σκάκι/);
    assert.equal(await admin.run('memory.archive', { kind: 'episode' }, { guildId: 'g1' }), '(none)', 'nothing at the server level');

    const reply = await admin.run('memory.restore', { itemId: old.itemId }, { guildId: 'g1' });
    assert.match(reply, /restored/);
    const episodes = store.getUser('g1', 'u1').episodes;
    const back = episodes.find((ep) => ep.itemId === old.itemId);
    assert.ok(back, 'the episode is hot again under its own id');
    assert.deepEqual([back.date, back.what, back.quote, back.weight, back.addedAt], [old.date, old.what, old.quote, old.weight, old.addedAt]);
    assert.equal(episodes.length, 2, 'not pinned, and no cap applied by the restore itself');
    let lines = await archive.find('g1', old.itemId);
    assert.deepEqual(lines.map((entry) => [entry.event, entry.by]), [['evicted', 'store'], ['restored', 'owner']]);

    // Again: the item is hot already, nothing is written.
    const again = await admin.run('memory.restore', { itemId: old.itemId }, { guildId: 'g1' });
    assert.match(again, /already/);
    assert.equal(store.getUser('g1', 'u1').episodes.length, 2);
    lines = await archive.find('g1', old.itemId);
    assert.equal(lines.length, 2);

    await assert.rejects(admin.run('memory.restore', { itemId: 'ep-none' }, { guildId: 'g1' }), /no archived item/);
  } finally {
    await appendStore.close();
  }
});

// ---------------------------------------------------------------------------
// the journal: system records, /nep journal, forget and wipe
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
  assert.deepEqual(records, [{ event: 'pause', by: 'owner' }, { event: 'resume', by: 'owner' }]);

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
      { kind: 'turn', occurredAt: `${day}T10:00:07.000Z`, mode: 'reply', outcome: 'spoke', seen: { messageIds: ['m1', 'm2'] }, think: 'Η Ελένη ρωτά.' },
      { kind: 'memory', occurredAt: `${day}T10:05:00.000Z`, batch: { messageIds: ['m1'], consumed: 6 }, changed: { users: ['u1'] }, episodes: [] },
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

test('admin: memory forget rewrites the journal and writes a forget record', async () => {
  const rootDir = makeRoot();
  const journal = fakeJournal();
  const hot = makeHot(rootDir);
  hot.config.features = { journal: true };
  const client = clientWithGuild('g1', 'The Server');
  const { admin, store } = makeAdmin(rootDir, { hot, journal, client });
  store.profiles.set('g1:123', { id: '123' });

  const result = await admin.run('memory.forget', { userId: '123' }, { guildId: 'g1' });
  assert.ok(result.includes('Forgot 123'));
  assert.deepEqual(store.forgotten, [['g1', '123']]);
  assert.equal(store.forgetDeps.journal, journal, 'the store runs the journal part under the lock');
  const forget = journal.calls.find(([name]) => name === 'system');
  assert.deepEqual([forget[1], forget[2].event, forget[2].by, forget[2].participants], ['g1', 'forget', 'owner', ['123']]);
  assert.match(result, /journal records: 5/i);

  // The wipe empties the journal, then records itself.
  const wiped = await admin.run('memory.wipe', { confirm: 'The Server' }, { guildId: 'g1' });
  assert.ok(journal.calls.some(([name, guildId]) => name === 'removeGuild' && guildId === 'g1'));
  const wipe = journal.calls.filter(([name]) => name === 'system').at(-1)[2];
  assert.deepEqual([wipe.event, wipe.by], ['wipe', 'owner']);
  assert.match(wiped, /journal files removed: 3/);
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
  assert.equal(fs.readFileSync(path.join(dest, 'guilds', 'g1', 'journal', '2026-10-13.jsonl'), 'utf8'), '{"kind":"turn"}\n');
  assert.ok(fs.existsSync(path.join(dest, 'state.json')));
  // Earlier snapshots are never copied into a new one.
  assert.ok(!fs.existsSync(path.join(dest, 'snapshots')));
  assert.ok(reply.includes(dest));
  const bytes = Buffer.byteLength('{"paused":false}') + Buffer.byteLength('{"self":["Ζωή"]}') + Buffer.byteLength('{"kind":"turn"}\n');
  assert.ok(reply.includes(`${bytes} bytes`));
});

test('admin: memory snapshot is owner-only and cannot be granted', async () => {
  const rootDir = makeRoot();
  const { admin, hot } = makeAdmin(rootDir);
  hot.config.bot.access = { memory: { everyone: true } };
  assert.equal(admin.isAllowed('memory.snapshot', { userId: '7' }), false);
  assert.equal(admin.isAllowed('memory.snapshot', { userId: '42' }), true);
});

// ---------------------------------------------------------------------------
// memory.forget / memory.wipe: the vault
// ---------------------------------------------------------------------------

test('admin: memory forget reports the vault path and per-store counts', async () => {
  const rootDir = makeRoot();
  const journal = fakeJournal();
  const hot = makeHot(rootDir);
  hot.config.memory = { vaultDir: 'κρύπτη' };
  hot.prompts.labels = { ...hot.prompts.labels, memory: { redaction: 'κάποιος' } };
  const { admin, store } = makeAdmin(rootDir, { hot, journal });
  store.forgetResult = {
    vault: '/data/κρύπτη/forget-123-2026-10-13T12-00-00-000Z',
    counts: { profile: 1, private: 1, voice: 2, recent: 3, participation: 4, versions: 1, archive: 5, record: 6, journal: 7, requests: 8, snapshots: 9, diary: 10, backfill: 11, errands: 12, errandLines: 13 },
  };

  const reply = await admin.run('memory.forget', { userId: '123' }, { guildId: 'g1' });

  assert.deepEqual([store.forgetDeps.journal, store.forgetDeps.vaultDir, store.forgetDeps.redaction], [journal, 'κρύπτη', 'κάποιος']);
  assert.ok(reply.includes('Vault: /data/κρύπτη/forget-123-2026-10-13T12-00-00-000Z'));
  for (const part of [
    'profile: 1', 'private memory: 1', 'voice items: 2', 'recent lines: 3', 'participation messages: 4', 'version files: 1',
    'archive entries: 5', 'record lines: 6', 'journal records: 7', 'request dumps: 8', 'snapshots: 9', 'diary posts redacted: 10',
    'backfill candidates: 11', 'errands: 12, errand lines: 13',
  ]) {
    assert.ok(reply.includes(part), part);
  }

  // A job cut short: the reply says it finishes at the next start and still names the vault.
  store.forgetUser = () => Promise.reject(Object.assign(new Error('disk full'), { code: 'ENOSPC', vault: '/data/κρύπτη/forget-123-x' }));
  const cut = await admin.run('memory.forget', { userId: '123' }, { guildId: 'g1' });
  assert.match(cut, /next start/);
  assert.ok(cut.includes('/data/κρύπτη/forget-123-x'));
});

test('admin: memory wipe reports the vault path', async () => {
  const rootDir = makeRoot();
  const order = [];
  const journal = {
    ...fakeJournal(),
    async withWriterLock(fn) {
      order.push('lock');
      try {
        return await fn();
      } finally {
        order.push('unlock');
      }
    },
    removeGuild: async () => {
      order.push('journal');
      return { files: 3 };
    },
  };
  const hot = makeHot(rootDir);
  hot.config.memory = { vaultDir: 'κρύπτη' };
  const client = clientWithGuild('g1', 'The Server');
  const { admin, store } = makeAdmin(rootDir, { hot, journal, client });
  store.vaultGuild = (guildId, opts) => {
    order.push(['vault', guildId, opts.vaultDir]);
    return '/data/κρύπτη/wipe-2026-10-13T12-00-00-000Z';
  };
  const wipeGuild = store.wipeGuild.bind(store);
  store.wipeGuild = (guildId, opts) => {
    order.push('wipe');
    return { ...wipeGuild(guildId, opts), snapshots: 2, vault: opts.vault };
  };

  const reply = await admin.run('memory.wipe', { confirm: 'The Server' }, { guildId: 'g1' });

  assert.deepEqual(order, ['lock', ['vault', 'g1', 'κρύπτη'], 'journal', 'wipe', 'unlock'], 'the vault before anything is deleted');
  assert.deepEqual(store.wipeCalls, [['g1', { vault: '/data/κρύπτη/wipe-2026-10-13T12-00-00-000Z', vaultDir: 'κρύπτη' }]]);
  assert.ok(reply.includes('Vault: /data/κρύπτη/wipe-2026-10-13T12-00-00-000Z'));
  assert.ok(reply.includes('snapshots that lost this server: 2'));
});
