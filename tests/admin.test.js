import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
import { createMemoryUpdater } from '../src/memory/update.js';
import { createWarmup } from '../src/memory/warmup.js';
import { createSpontaneous } from '../src/behavior/spontaneous.js';
import { buildDrawPrompt } from '../src/behavior/prompt.js';
import { familyOf, ImageGenError } from '../src/llm/images.js';
import { createLlm } from '../src/llm/openrouter.js';
import { createCaseStore } from '../src/mentor/cases.js';
import { createMentorBudget } from '../src/mentor/budget.js';
import { labels } from './fixtures/labels.js';

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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-admin-'));
  fs.mkdirSync(path.join(rootDir, 'prompts'));
  fs.writeFileSync(path.join(rootDir, 'prompts', 'rules.md'), '## Rules\n\n- be kind\n');
  return rootDir;
}

function makeHot(rootDir) {
  return {
    config: {
      bot: { owners: ['42'] },
      llm: { model: 'anthropic/claude-opus-4.6', maxRequestsPerDay: 300 },
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
    forgetUser(guildId, userId) {
      forgotten.push([String(guildId), String(userId)]);
      profiles.delete(`${guildId}:${userId}`);
      privates.delete(`${guildId}:${userId}`);
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
    getBuffer() {
      return [];
    },
    listGuilds() {
      return [];
    },
    wipeCalls: [],
    wipeGuild(guildId, opts) {
      this.wipeCalls.push([String(guildId), opts]);
      return { users: 2, channels: 1, loreRemoved: 3, loreKept: 1, bufferMessages: 5 };
    },
  };
  return store;
}

function makeAdmin(rootDir, extra = {}) {
  const hot = extra.hot ?? makeHot(rootDir);
  const store = extra.store ?? makeStore();
  const admin = createAdmin({
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
    llm: extra.llm,
    warmup: extra.warmup,
    describer: extra.describer,
    lookup: extra.lookup,
    images: extra.images,
    imageFetcher: extra.imageFetcher,
    emojiBackfill: extra.emojiBackfill,
    gifBackfill: extra.gifBackfill,
    gifRecache: extra.gifRecache,
    mentor: extra.mentor,
    mentorCases: extra.mentorCases,
    mentorBudget: extra.mentorBudget,
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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-admin-'));
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

  const result = await admin.run('set', { path: 'llm.model', value: '"openrouter/test-model"' }, {});

  assert.deepEqual(readLocal(rootDir), { llm: { model: 'openrouter/test-model' } });
  assert.equal(hot.reloadConfigCalls, 1);
  assert.ok(result.includes('Set llm.model'));
});

test('run: set falls back to the raw string when the value is not valid JSON', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await admin.run('set', { path: 'llm.model', value: 'plain-text-model' }, {});
  assert.deepEqual(readLocal(rootDir), { llm: { model: 'plain-text-model' } });
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

  await admin.run('set', { path: 'llm.model', value: '"temp-model"' }, {});
  await admin.run('unset', { path: 'llm.model' }, {});

  assert.deepEqual(readLocal(rootDir), {});
  assert.equal(hot.reloadConfigCalls, 2);
});

test('set: a non-owner granted set cannot touch bot.owners or bot.access; an owner can', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.bot.access = { set: { everyone: false, roles: [], users: ['999'] }, unset: { everyone: false, roles: [], users: ['999'] } };
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
  hot.config.memory = { model: null };
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
  await admin.run('set', { path: 'memory.model', value: '"x/y"' }, owner); // the current value is null: any type
  await admin.run('set', { path: 'llm.model', value: '123' }, owner); // a string setting keeps the text as typed
  assert.deepEqual(readLocal(rootDir), {
    llm: { maxRequestsPerDay: 250, model: '123' },
    features: { dryRun: true },
    memory: { model: 'x/y' },
  });
});

// ---------------------------------------------------------------------------
// model.show / model.set
// ---------------------------------------------------------------------------

function makeHotWithMedia(rootDir) {
  const hot = makeHot(rootDir);
  hot.config.memory = { model: null };
  hot.config.media = {};
  hot.config.classifier = { media: 'anthropic/claude-haiku-4.5' };
  hot.config.features = { mediaDescriptions: false };
  return hot;
}

test('run: model.show falls back to classifier.media for classifier.text when unset', async () => {
  const rootDir = makeRoot();
  const hot = makeHotWithMedia(rootDir);
  const { admin } = makeAdmin(rootDir, { hot });

  const result = await admin.run('model.show', {}, {});
  assert.ok(result.split('\n').includes('classifier.text: anthropic/claude-haiku-4.5'));
});

test('run: model.show ignores the deprecated keys of an old config.local.json', async () => {
  const rootDir = makeRoot();
  const hot = makeHotWithMedia(rootDir);
  hot.config.classifier = {};
  hot.config.llm.classifierModel = 'openrouter/old-classifier';
  hot.config.mention = { followUpModel: 'openrouter/older-classifier' };
  hot.config.media = { model: 'openrouter/old-media', video: { model: 'openrouter/old-video' } };
  const { admin } = makeAdmin(rootDir, { hot });

  const lines = (await admin.run('model.show', {}, {})).split('\n');
  assert.ok(lines.includes('classifier.text: -'));
  assert.ok(lines.includes('classifier.media: -'));
  assert.ok(lines.includes('classifier.video: -'));
  assert.ok(!lines.some((l) => l.includes('openrouter/old')), 'no deprecated key is shown');
  assert.ok(!lines.some((l) => /^(followup|media|video|classifier):/.test(l)), 'the old role names are gone from the listing');
});

test('run: model.set writes the right config path for each role', async () => {
  const rootDir = makeRoot();
  const hot = makeHotWithMedia(rootDir);
  const { admin } = makeAdmin(rootDir, { hot });

  await admin.run('model.set', { role: 'voice', id: 'anthropic/claude-opus-4.6' }, {});
  assert.deepEqual(readLocal(rootDir), { llm: { model: 'anthropic/claude-opus-4.6' } });

  await admin.run('model.set', { role: 'analyzer', id: 'openrouter/cheap-model' }, {});
  await admin.run('model.set', { role: 'classifier.text', id: 'openrouter/text-model' }, {});
  await admin.run('model.set', { role: 'classifier.media', id: 'anthropic/claude-haiku-4.5' }, {});
  await admin.run('model.set', { role: 'classifier.video', id: 'openrouter/video-model' }, {});
  assert.deepEqual(readLocal(rootDir), {
    llm: { model: 'anthropic/claude-opus-4.6' },
    memory: { model: 'openrouter/cheap-model' },
    classifier: { text: 'openrouter/text-model', media: 'anthropic/claude-haiku-4.5', video: 'openrouter/video-model' },
  });
  assert.equal(hot.reloadConfigCalls, 5);
});

test('run: model.set rejects an unknown role, the old role names and the classifier group, and writes nothing', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir) });

  for (const role of ['bogus', 'followup', 'media', 'video', 'classifier', 'talk']) {
    await assert.rejects(
      () => admin.run('model.set', { role, id: 'x/y' }, {}),
      new RegExp(`unknown role: ${role} \\(voice, analyzer, classifier\\.text, classifier\\.media, classifier\\.video, mentor, image\\)`),
      role,
    );
  }
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
});

test('run: model.set rejects an id that does not look like a model id', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir) });

  await assert.rejects(() => admin.run('model.set', { role: 'voice', id: 'x' }, {}), /model id/);
  await assert.rejects(() => admin.run('model.set', { role: 'image', id: 'has spaces here' }, {}), /model id/);
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
});

test('run: model.set accepts a loosely-valid id (letters, digits, dot, colon, slash, dash, underscore)', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir) });

  await admin.run('model.set', { role: 'classifier.media', id: 'anthropic/claude-haiku-4.5:beta' }, {});
  assert.deepEqual(readLocal(rootDir), { classifier: { media: 'anthropic/claude-haiku-4.5:beta' } });
});

test('model show: lists the mentor role', async () => {
  const rootDir = makeRoot();
  const hot = makeHotWithMedia(rootDir);
  const { admin } = makeAdmin(rootDir, { hot });

  const unset = (await admin.run('model.show', {}, {})).split('\n');
  assert.ok(unset.includes('mentor: -'), 'an unset mentor model does not fall back to the voice model');

  hot.config.mentor = { model: 'openrouter/mentor-model' };
  const set = (await admin.run('model.show', {}, {})).split('\n');
  assert.ok(set.includes('mentor: openrouter/mentor-model'));
});

test('model show: the voice role is llm.model, never memory.model or a stale memory.voiceModel; no talk line', async () => {
  const rootDir = makeRoot();
  const hot = makeHotWithMedia(rootDir);
  hot.config.memory.model = 'openai/analyzer-model';
  hot.config.memory.voiceModel = 'openrouter/stale-voice-model';
  const { admin } = makeAdmin(rootDir, { hot });

  const lines = (await admin.run('model.show', {}, {})).split('\n');
  assert.ok(lines.includes('voice: anthropic/claude-opus-4.6'));
  assert.ok(lines.includes('analyzer: openai/analyzer-model'));
  assert.ok(!lines.some((l) => l.startsWith('talk:')), 'no talk role');
  assert.ok(!lines.some((l) => l.includes('stale-voice-model')), 'memory.voiceModel is not read');
});

test('model set image: writes image.model to config.local.json, reloads, and model show lists it', async () => {
  const rootDir = makeRoot();
  const hot = makeHotWithMedia(rootDir);
  hot.reloadConfig = function reloadConfig() {
    this.reloadConfigCalls += 1;
    this.config.image = { ...this.config.image, ...readLocal(rootDir).image };
    return true;
  };
  const { admin } = makeAdmin(rootDir, { hot });

  assert.ok((await admin.run('model.show', {}, {})).split('\n').includes('image: -'));
  const reply = await admin.run('model.set', { role: 'image', id: 'openai/gpt-image-2.5-flare' }, {});
  assert.match(reply, /^Set image model to openai\/gpt-image-2\.5-flare /);
  assert.deepEqual(readLocal(rootDir), { image: { model: 'openai/gpt-image-2.5-flare' } });
  assert.equal(hot.reloadConfigCalls, 1);
  assert.ok((await admin.run('model.show', {}, {})).split('\n').includes('image: openai/gpt-image-2.5-flare'));
});

// ---------------------------------------------------------------------------
// isAllowed
// ---------------------------------------------------------------------------

test('isAllowed: a non-owner reads bot.access off the live hot.config, role grant included', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.bot.access = { status: { everyone: false, roles: ['staff'], users: [] } };
  const { admin } = makeAdmin(rootDir, { hot });

  assert.equal(admin.isAllowed('status', { userId: '999', roleIds: ['staff'] }), true);
  assert.equal(admin.isAllowed('status', { userId: '999', roleIds: ['other'] }), false);
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

test('run: access.grant refuses pings, writing nothing', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await assert.rejects(() => admin.run('access.grant', { command: 'pings' }, {}), /pings is open to every member and cannot be granted/);
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
});

// ---------------------------------------------------------------------------
// access.grant / access.revoke / access.list
// ---------------------------------------------------------------------------

test('run: access.grant writes everyone, a role id or a user id and names the target as plain text in the reply', async () => {
  for (const [label, args, written, reply] of [
    [
      'no role/user grants everyone; a read-only key gets no write note',
      { command: 'status' },
      { status: { everyone: true, roles: [], users: [] } },
      'Granted status to everyone (reload ok)',
    ],
    [
      'a role',
      { command: 'memory.show', roleId: '123' },
      { 'memory.show': { everyone: false, roles: ['123'], users: [] } },
      'Granted memory.show to role id:123 (reload ok)',
    ],
    [
      'a user',
      { command: 'status', userId: '456' },
      { status: { everyone: false, roles: [], users: ['456'] } },
      'Granted status to user id:456 (reload ok)',
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
    () => admin.run('access.grant', { command: 'status', roleId: '1', userId: '2' }, {}),
    /give a role or a user, not both/,
  );
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
});

test('run: access.grant rejects an unknown command key, writing nothing', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await assert.rejects(() => admin.run('access.grant', { command: 'nonsense' }, {}), /unknown command key: nonsense/);
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
});

test('run: access.list leaves out stale grants on owner-only private commands', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  const open = { everyone: true, roles: [], users: [] };
  fs.writeFileSync(
    path.join(rootDir, 'config.local.json'),
    JSON.stringify({ bot: { access: { private: open, 'private.show': open, status: open } } }),
  );
  assert.equal(await admin.run('access.list', {}, {}), 'status: everyone');

  fs.writeFileSync(path.join(rootDir, 'config.local.json'), JSON.stringify({ bot: { access: { 'private.show': open } } }));
  assert.equal(await admin.run('access.list', {}, {}), '(none)');
});

test('run: access.grant twice accumulates -- a second role does not drop the first', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await admin.run('access.grant', { command: 'status', roleId: '1' }, {});
  await admin.run('access.grant', { command: 'status', roleId: '2' }, {});

  assert.deepEqual(readLocal(rootDir), { bot: { access: { status: { everyone: false, roles: ['1', '2'], users: [] } } } });
});

test('run: access.revoke removes a previously granted role, dropping the entry once it is the last thing set', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await admin.run('access.grant', { command: 'status', roleId: '1' }, {});
  const result = await admin.run('access.revoke', { command: 'status', roleId: '1' }, {});

  assert.equal(result, 'Revoked status from role id:1 (reload ok)');
  assert.deepEqual(readLocal(rootDir), { bot: { access: {} } });
});

test('run: access.revoke with no role/user clears everyone, keeping any roles/users still set', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await admin.run('access.grant', { command: 'status' }, {});
  await admin.run('access.grant', { command: 'status', roleId: '1' }, {});
  const result = await admin.run('access.revoke', { command: 'status' }, {});

  assert.equal(result, 'Revoked status from everyone (reload ok)');
  assert.deepEqual(readLocal(rootDir), { bot: { access: { status: { everyone: false, roles: ['1'], users: [] } } } });
});

test('run: access grant/list/revoke/list round trip', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await admin.run('access.grant', { command: 'memory', roleId: 'staff' }, {});
  assert.equal(await admin.run('access.list', {}, {}), 'memory: role id:staff');

  await admin.run('access.revoke', { command: 'memory', roleId: 'staff' }, {});
  assert.equal(await admin.run('access.list', {}, {}), '(none)');
});

test('access.grant: ping says it spends balance; * says both notes; a write command the write note; a read-only key neither', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  const spends = 'Note: this opens ping, whose every call spends OpenRouter balance outside llm.maxRequestsPerDay.';
  const writes = 'Note: this opens commands that change memory or config.';

  // Keep every row: draw, emoji.status, gifs.status and gifs.recache are each the only catcher
  // of that key slipping into (or out of) the read-only set.
  for (const [command, roleId, notes] of [
    ['ping', undefined, [spends]],
    ['*', undefined, [writes, spends]],
    ['status', undefined, []],
    ['draw', undefined, [writes]],
    ['emoji.status', 'staff', []],
    ['emoji.rescan', 'staff', [writes]],
    ['gifs.recache', 'staff', [writes]],
    ['gifs.status', 'staff', []],
    ['gifs.rescan', 'staff', [writes]],
  ]) {
    const target = roleId ? `role id:${roleId}` : 'everyone';
    assert.equal(
      await admin.run('access.grant', { command, roleId }, {}),
      [`Granted ${command} to ${target} (reload ok)`, ...notes].join('\n'),
      command,
    );
  }
});

// ---------------------------------------------------------------------------
// ping: reach each role's model directly, in parallel
// ---------------------------------------------------------------------------

function fakeLlm(script) {
  const calls = [];
  return {
    calls,
    complete: async (messages, options) => {
      calls.push({ messages, options });
      return script(options, calls.length - 1);
    },
  };
}

function hotForPing(rootDir, { label = true } = {}) {
  const hot = makeHotWithMedia(rootDir);
  hot.prompts = {
    ...hot.prompts,
    labels: { ...hot.prompts.labels, ...(label ? { ping: { prompt: 'Reply with one word: pong' } } : {}) },
  };
  return hot;
}

test('run: ping pings the seven roles in parallel and reports latency, provider and tokens', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir);
  hot.config.memory.model = 'openrouter/analyzer-model'; // distinct from voice, so every role gets its own call
  hot.config.classifier.video = 'openrouter/video-model';
  const llm = fakeLlm((options) => ({
    text: 'pong',
    usage: { prompt_tokens: 5, completion_tokens: 1 },
    estimated: 6,
    finishReason: 'stop',
    provider: `provider-for-${options.model}`,
  }));
  const { admin } = makeAdmin(rootDir, { hot, llm });

  const body = await admin.run('ping', {}, {});
  const lines = body.split('\n');

  assert.equal(llm.calls.length, 4, 'voice, analyzer, media and video are four distinct models here; classifier.text falls back to classifier.media; mentor is unset');
  assert.equal(lines.length, 7, 'six role lines and the image line');
  assert.ok(lines.some((l) => l.startsWith('voice: anthropic/claude-opus-4.6 — ok,') && l.includes('provider=provider-for-anthropic/claude-opus-4.6') && l.includes('tokens 5/1')));
  assert.ok(lines.some((l) => l.startsWith('analyzer: openrouter/analyzer-model — ok,')));
  assert.ok(lines.some((l) => l.startsWith('classifier.media: anthropic/claude-haiku-4.5 — ok,')));
  assert.ok(lines.some((l) => l.startsWith('classifier.text: anthropic/claude-haiku-4.5 — ok,')));
  assert.ok(lines.some((l) => l.startsWith('classifier.video: openrouter/video-model — ok,')));
  assert.ok(llm.calls.some((c) => c.options.model === 'openrouter/video-model'));
  assert.ok(lines.includes('mentor: (no model configured)'), 'an unset mentor model never falls back to the voice model');
});

test('run: ping single-role form pings only that role\'s model (classifier.text falls back to classifier.media), or reports no model when it is unset', async () => {
  // `model` is the one model pinged, or null when the role has none and nothing is sent;
  // `line` is the start of the one-line reply, or the whole reply when nothing is sent.
  for (const [label, role, setup, model, line] of [
    ['classifier.video set', 'classifier.video', (cfg) => (cfg.classifier.video = 'openrouter/video-model'), 'openrouter/video-model', 'classifier.video: openrouter/video-model — ok,'],
    ['classifier.video unset', 'classifier.video', () => {}, null, 'classifier.video: (no model configured)'],
    ['classifier.text unset: classifier.media', 'classifier.text', () => {}, 'anthropic/claude-haiku-4.5', 'classifier.text: anthropic/claude-haiku-4.5 — ok,'],
    ['classifier.text set', 'classifier.text', (cfg) => (cfg.classifier.text = 'openrouter/text-model'), 'openrouter/text-model', 'classifier.text: openrouter/text-model — ok,'],
    ['classifier.media', 'classifier.media', () => {}, 'anthropic/claude-haiku-4.5', 'classifier.media: anthropic/claude-haiku-4.5 — ok,'],
    ['mentor set', 'mentor', (cfg) => (cfg.mentor = { model: 'openrouter/mentor-model' }), 'openrouter/mentor-model', 'mentor: openrouter/mentor-model — ok,'],
    ['mentor unset', 'mentor', () => {}, null, 'mentor: (no model configured)'],
  ]) {
    const rootDir = makeRoot();
    const hot = hotForPing(rootDir);
    setup(hot.config);
    const llm = fakeLlm(() => ({ text: 'pong', usage: {}, estimated: 1 }));
    const { admin } = makeAdmin(rootDir, { hot, llm });

    const body = await admin.run('ping', { role }, {});

    if (model === null) {
      assert.equal(llm.calls.length, 0, label);
      assert.equal(body, line, label);
    } else {
      assert.equal(llm.calls.length, 1, label);
      assert.equal(llm.calls[0].options.model, model, label);
      assert.equal(body.split('\n').length, 1, label);
      assert.ok(body.startsWith(line), `${label}: ${body}`);
    }
  }
});

test('run: ping classifier pings the three classifier roles and no other', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir);
  hot.config.classifier.text = 'openrouter/text-model';
  hot.config.classifier.video = 'openrouter/video-model';
  const llm = fakeLlm(() => ({ text: 'pong', usage: {}, estimated: 1 }));
  const describer = fakeYoutubeDescriber({ status: 'ytdlp', detail: '', keySet: false });
  const { admin } = makeAdmin(rootDir, { hot, llm, describer });

  const lines = (await admin.run('ping', { role: 'classifier' }, {})).split('\n');

  assert.equal(lines.length, 4, 'three role lines and the YouTube line');
  assert.ok(lines[0].startsWith('classifier.text: openrouter/text-model — ok,'));
  assert.ok(lines[1].startsWith('classifier.media: anthropic/claude-haiku-4.5 — ok,'));
  assert.ok(lines[2].startsWith('classifier.video: openrouter/video-model — ok,'));
  assert.equal(lines[3], 'youtube: API key — not needed (yt-dlp ok)', 'the YouTube line follows the video role');
  assert.deepEqual(llm.calls.map((c) => c.options.model).sort(), ['anthropic/claude-haiku-4.5', 'openrouter/text-model', 'openrouter/video-model']);
});

test('run: ping calls llm.complete with the ping prompt, 16 max tokens, no daily cap and no calibration', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir);
  hot.config.llm.pingTimeoutMs = 12345;
  const llm = fakeLlm(() => ({ text: 'pong', usage: {}, estimated: 1 }));
  const { admin } = makeAdmin(rootDir, { hot, llm });

  await admin.run('ping', { role: 'voice' }, {});

  assert.equal(llm.calls.length, 1);
  const [{ messages, options }] = llm.calls;
  assert.deepEqual(messages, [{ role: 'user', content: 'Reply with one word: pong' }]);
  assert.equal(options.model, 'anthropic/claude-opus-4.6');
  assert.equal(options.maxOutputTokens, 16);
  assert.equal(options.countAgainstDailyCap, false);
  assert.equal(options.skipCalibration, true);
  assert.equal(options.timeoutMs, 12345);
});

test('run: ping de-duplicates identical models: one call, reported for every role that uses it', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir);
  // memory.model is null in makeHotWithMedia -> analyzer falls back to the same model as voice.
  const llm = fakeLlm(() => ({ text: 'pong', usage: {}, estimated: 1 }));
  const { admin } = makeAdmin(rootDir, { hot, llm });

  const body = await admin.run('ping', {}, {});
  const lines = body.split('\n');

  assert.equal(llm.calls.length, 2, 'voice+analyzer share one model, classifier.media (and classifier.text, which falls back to it) share another: two calls');
  assert.equal(lines.length, 7, 'one line per requested role, and the image line');
  assert.ok(lines.some((l) => l.startsWith('voice: anthropic/claude-opus-4.6 — ok,')));
  assert.ok(lines.some((l) => l.startsWith('analyzer: anthropic/claude-opus-4.6 — ok,')));
  assert.ok(lines.some((l) => l.startsWith('classifier.text: anthropic/claude-haiku-4.5 — ok,')));
  assert.ok(lines.includes('classifier.video: (no model configured)'), 'no classifier.video -> skipped, like any role without a model');
});

test('ping: role voice pings llm.model as role voice; a stale memory.voiceModel is never pinged', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir);
  hot.config.memory.model = 'openai/analyzer-model';
  hot.config.memory.voiceModel = 'openrouter/stale-voice-model';
  const llm = fakeLlm(() => ({ text: 'pong', usage: {}, estimated: 1 }));
  const { admin } = makeAdmin(rootDir, { hot, llm });

  const body = await admin.run('ping', { role: 'voice' }, {});
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].options.model, 'anthropic/claude-opus-4.6');
  assert.equal(llm.calls[0].options.role, 'voice');
  assert.equal(llm.calls[0].options.countAgainstDailyCap, false);
  assert.equal(body.split('\n').length, 1);
  assert.ok(body.startsWith('voice: anthropic/claude-opus-4.6 — ok,'));

  llm.calls.length = 0;
  await admin.run('ping', {}, {});
  assert.ok(!llm.calls.some((c) => c.options.model === 'openrouter/stale-voice-model'));
  assert.ok(!llm.calls.some((c) => c.options.role === 'talk'));
});

test('ping: one voice line and no talk line, whatever the routes; talk is not a ping role', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir);
  const llm = fakeLlm((options) => ({ text: 'pong', usage: {}, estimated: 1, provider: `served-${options.role}` }));
  const { admin } = makeAdmin(rootDir, { hot, llm });

  for (const routes of [{}, { 'anthropic/@voice': { only: ['amazon-bedrock'] } }, { 'anthropic/@talk': { only: ['amazon-bedrock'] } }]) {
    hot.config.llm.providerByModel = routes;
    llm.calls.length = 0;
    const lines = (await admin.run('ping', {}, {})).split('\n');
    const label = JSON.stringify(routes);
    assert.equal(lines.filter((l) => l.startsWith('voice:')).length, 1, label);
    assert.equal(lines.filter((l) => l.startsWith('talk:')).length, 0, label);
    assert.ok(lines.some((l) => l.startsWith('voice: anthropic/claude-opus-4.6 — ok,') && l.includes('provider=served-voice')), label);
    assert.ok(!llm.calls.some((c) => c.options.role === 'talk'), label);
  }

  // `talk` names no role: like any unknown argument, every role is pinged, still without a talk line.
  const all = (await admin.run('ping', { role: 'talk' }, {})).split('\n');
  assert.equal(all.filter((l) => l.startsWith('talk:')).length, 0);
  assert.equal(all.filter((l) => l.startsWith('voice:')).length, 1);
});

test('ping: every model line comes before the youtube and web lines, the image line among the models', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir);
  hot.config.memory.model = 'openrouter/analyzer-model';
  hot.config.classifier.video = 'openrouter/video-model';
  hot.config.mentor = { model: 'openrouter/mentor-model' };
  hot.config.image = { model: 'openai/gpt-image-2.5-flare' };
  hot.config.features = { ...hot.config.features, webLookup: true };
  const llm = fakeLlm(() => ({ text: 'pong', usage: {}, estimated: 1 }));
  const describer = fakeYoutubeDescriber({ status: 'api', detail: '', keySet: true });
  const { admin } = makeAdmin(rootDir, { hot, llm, describer, lookup: fakeWebLookup(true) });

  const lines = (await admin.run('ping', {}, {})).split('\n');

  assert.deepEqual(
    lines.map((l) => l.split(':')[0]),
    ['voice', 'analyzer', 'classifier.text', 'classifier.media', 'classifier.video', 'mentor', 'image', 'youtube', 'web'],
  );
  assert.ok(!llm.calls.some((c) => c.options.model === 'openai/gpt-image-2.5-flare' || c.options.role === 'image'), 'no chat request for the image model');
});

test('ping image: the image model is checked by its listing, never with a chat request', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir);
  hot.config.image = { model: 'openai/gpt-image-2.5-flare' };
  const llm = fakeLlm(() => ({ text: 'pong', usage: {}, estimated: 1 }));
  const listed = [];
  llm.modelEndpoints = async (model) => {
    listed.push(model);
    return { ok: true, status: 200, json: { data: { architecture: { output_modalities: ['image'] }, endpoints: [{}] } } };
  };
  const { admin } = makeAdmin(rootDir, { hot, llm });

  const body = await admin.run('ping', { role: 'image' }, {});
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(listed, ['openai/gpt-image-2.5-flare']);
  assert.match(body, /^image: openai\/gpt-image-2\.5-flare — listed, image output, 1 endpoint\(s\)/);
});

// A real "wrong provider keys" 404 body captured from OpenRouter, verbatim -- see the
// module header's WHY. `error.metadata.routing_funnel` is the real location; `step` is the
// real step-name key; `endpoint_count` (snake_case) is the real count key.
const REAL_NO_ENDPOINTS_BODY =
  '{"error":{"message":"No endpoints found for anthropic/claude-opus-4.6.","code":404,"metadata":{"routing_funnel":[' +
  '{"step":"Initial Endpoints","endpoint_count":6},' +
  '{"step":"Filter by Regional Surcharge","endpoint_count":5},' +
  '{"step":"Filter by Allowed Providers","endpoint_count":2},' +
  '{"step":"Apply Manual Order","endpoint_count":2},' +
  '{"step":"Add BYOK Endpoints","endpoint_count":0}]}}}';

function throwHttpError(statusCode, bodyText) {
  const err = new Error(`OpenRouter HTTP ${statusCode}: ${bodyText}`);
  err.statusCode = statusCode;
  err.body = bodyText;
  throw err;
}

test('run: ping reports a role that returns an HTTP error with its status, a trimmed message and the real routing funnel shape', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir);
  hot.config.memory.model = 'openrouter/analyzer-model';
  const llm = fakeLlm((options) => {
    if (options.model === 'anthropic/claude-opus-4.6') throwHttpError(404, REAL_NO_ENDPOINTS_BODY);
    return { text: 'pong', usage: {}, estimated: 1 };
  });
  const { admin } = makeAdmin(rootDir, { hot, llm });

  const body = await admin.run('ping', {}, {});
  const lines = body.split('\n');

  const voiceLine = lines.find((l) => l.startsWith('voice:'));
  assert.ok(voiceLine.includes('FAIL'));
  assert.ok(voiceLine.includes('404'));
  // The last step is also the first one that hit 0 here, so only one is shown.
  assert.ok(voiceLine.includes('funnel: Add BYOK Endpoints -> 0 endpoints'));
  assert.ok(!voiceLine.includes('first hit 0 at'));
  assert.ok(lines.some((l) => l.startsWith('analyzer: openrouter/analyzer-model — ok,')));
  assert.ok(lines.some((l) => l.startsWith('classifier.media: anthropic/claude-haiku-4.5 — ok,')));
});

test('run: ping shows both the last step and the first step that hit 0 endpoints, when they differ', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir);
  const bodyText = JSON.stringify({
    error: {
      message: 'No endpoints found.',
      code: 404,
      metadata: {
        routing_funnel: [
          { step: 'Initial Endpoints', endpoint_count: 6 },
          { step: 'Filter by Regional Surcharge', endpoint_count: 0 },
          { step: 'Filter by Allowed Providers', endpoint_count: 0 },
          { step: 'Add BYOK Endpoints', endpoint_count: 0 },
        ],
      },
    },
  });
  const llm = fakeLlm(() => throwHttpError(404, bodyText));
  const { admin } = makeAdmin(rootDir, { hot, llm });

  const body = await admin.run('ping', { role: 'voice' }, {});

  assert.ok(body.includes('funnel: Add BYOK Endpoints -> 0 endpoints'));
  assert.ok(body.includes('(first hit 0 at Filter by Regional Surcharge -> 0 endpoints)'));
});

test('run: ping reports every role skipped when labels.ping.prompt is missing, without calling llm.complete', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir, { label: false });
  const llm = fakeLlm(() => ({ text: 'pong', usage: {}, estimated: 1 }));
  const { admin } = makeAdmin(rootDir, { hot, llm });

  const body = await admin.run('ping', {}, {});

  assert.equal(llm.calls.length, 0);
  const lines = body.split('\n');
  assert.equal(lines.length, 7, 'six role lines and the image line');
  assert.ok(lines.slice(0, 6).every((l) => l.includes('skipped: label missing')));
  assert.equal(lines[6], 'image: (no model configured)', 'the image check needs no label');
});

test('run: ping works while paused', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir);
  const llm = fakeLlm(() => ({ text: 'pong', usage: {}, estimated: 1 }));
  const { admin, store } = makeAdmin(rootDir, { hot, llm });
  store.state.data.paused = true;

  await assert.doesNotReject(() => admin.run('ping', {}, {}));
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

test('run: memory.affinity with a score sets it exactly, bypassing maxDeltaPerUpdate', async () => {
  const rootDir = makeRoot();
  const { admin, hot, store } = makeAdmin(rootDir);
  hot.config.relationships = { maxDeltaPerUpdate: 15, historySize: 10 };
  store.profiles.set('g1:123', { id: '123', affinity: emptyAffinity() });

  const result = await admin.run(
    'memory.affinity',
    { userId: '123', score: 77, reason: 'owner really likes them' },
    { guildId: 'g1' },
  );

  const affinity = store.getUser('g1', '123').affinity;
  assert.equal(affinity.score, 77, 'the score is set exactly, well beyond maxDeltaPerUpdate of 15');
  assert.equal(affinity.reason, 'owner really likes them');
  assert.ok(result.includes('77'));
});

test('run: memory.affinity with a score sets it exactly even from a fractional (damped) current score, with no damping', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', affinity: { score: 60.4, reason: 'was doing fine', history: [] } });

  const result = await admin.run('memory.affinity', { userId: '123', score: 70, reason: 'owner override' }, { guildId: 'g1' });

  const affinity = store.getUser('g1', '123').affinity;
  assert.equal(affinity.score, 70, 'truncating the gap to 70 - 60.4 = 9.6 -> 9 would have stranded this at 69.4');
  assert.equal(affinity.reason, 'owner override');
  assert.ok(result.includes('70'));
});

test('memory.affinity: a score with no reason stores no text of its own (nothing model-facing comes from src/)', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', affinity: emptyAffinity() });

  await admin.run('memory.affinity', { userId: '123', score: -30 }, { guildId: 'g1' });

  const affinity = store.getUser('g1', '123').affinity;
  assert.equal(affinity.score, -30);
  assert.equal(affinity.reason, '');
  assert.equal(affinity.history.at(-1).reason, '');
  const shown = await admin.run('memory.affinity', { userId: '123' }, { guildId: 'g1' });
  assert.ok(shown.split('\n').includes('reason: -'), shown);
});

test('memory.affinity: a score with no reason stores labels.affinity.ownerSet, read at the moment of use; a given reason wins', async () => {
  const rootDir = makeRoot();
  const { admin, hot, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', affinity: emptyAffinity() });

  hot.prompts = { ...hot.prompts, labels: { ...hot.prompts.labels, affinity: { ownerSet: labels.affinity.ownerSet } } };
  await admin.run('memory.affinity', { userId: '123', score: 20 }, { guildId: 'g1' });
  let affinity = store.getUser('g1', '123').affinity;
  assert.equal(affinity.score, 20);
  assert.equal(affinity.reason, labels.affinity.ownerSet);
  assert.equal(affinity.history.at(-1).reason, labels.affinity.ownerSet);

  // A live edit of the label is read by the next set.
  hot.prompts = { ...hot.prompts, labels: { ...hot.prompts.labels, affinity: { ownerSet: 'Ζωή set it' } } };
  await admin.run('memory.affinity', { userId: '123', score: 25, reason: '   ' }, { guildId: 'g1' });
  assert.equal(store.getUser('g1', '123').affinity.reason, 'Ζωή set it');

  await admin.run('memory.affinity', { userId: '123', score: 30, reason: 'owner override' }, { guildId: 'g1' });
  affinity = store.getUser('g1', '123').affinity;
  assert.equal(affinity.reason, 'owner override');
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

test('run: memory.affinity rejects an out-of-range score and writes nothing', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);

  await assert.rejects(
    () => admin.run('memory.affinity', { userId: '123', score: 150 }, { guildId: 'g1' }),
    /-100 and 100/,
  );
  assert.equal(store.getUser('g1', '123'), null);
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

  const result = await admin.run('private.show', { userId: '123' }, { guildId: 'g1' });

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

  const result = await admin.run('private.show', { userId: '42' }, { guildId: 'g1' });

  assert.match(result, /effective affinity: 100\b/);
  assert.match(result, /replies today: 7 \/ 200/);
});

test('run: private.show counts replies stored for another day as 0 today', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', names: ['Zoé'] });
  store.privates.set('g1:123', samplePrivate({ replies: { day: '2000-01-01', count: 55, noticedDay: '' } }));

  const result = await admin.run('private.show', { userId: '123' }, { guildId: 'g1' });

  assert.match(result, /replies today: 0\b/);
  assert.ok(!result.includes('55'));
});

test('run: private.show / private.forget need a user and a resolved guild', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  await assert.rejects(() => admin.run('private.show', {}, { guildId: 'g1' }), /a user is required/);
  await assert.rejects(() => admin.run('private.forget', {}, { guildId: 'g1' }), /a user is required/);

  const { admin: unresolved } = makeAdmin(rootDir, { getGuildId: () => null });
  await assert.rejects(() => unresolved.run('private.show', { userId: '123' }, {}), /no guild resolved yet/);
  await assert.rejects(() => unresolved.run('private.forget', { userId: '123' }, {}), /no guild resolved yet/);
});

test('run: private.forget removes only the private layer and says so', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', names: ['Zoé'] });
  store.privates.set('g1:123', samplePrivate());

  const result = await admin.run('private.forget', { userId: '123' }, { guildId: 'g1' });

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

  await assert.rejects(() => admin.run('private.forget', { userId: '123' }, { guildId: 'g1' }), /paused.*resume/i);
  assert.deepEqual(store.forgottenPrivate, []);
  await assert.doesNotReject(() => admin.run('private.show', { userId: '123' }, { guildId: 'g1' }));
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

  const result = await admin.run('private.purge', { userId: '123' }, { guildId: 'g1' });

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

  const result = await admin.run('private.purge', { userId: '123' }, { guildId: 'g1' });

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

  await admin.run('private.purge', { userId: '123' }, { guildId: 'g1' });

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
  await assert.rejects(() => admin.run('private.purge', { userId: '123' }, { guildId: 'g1' }), /nothing was deleted/i);

  const closed = fakeDmClient(channel, { createDM: async () => { throw new Error('Cannot open a DM'); } });
  const { admin: admin2 } = makeAdmin(rootDir, { client: closed, store });
  await assert.rejects(() => admin2.run('private.purge', { userId: '123' }, { guildId: 'g1' }), /nothing was deleted/i);

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
  await assert.rejects(() => admin.run('private.purge', { userId: '123' }, { guildId: 'g1' }), /nothing was deleted/i);
  assert.deepEqual(deleted, []);
  assert.deepEqual(store.forgottenPrivate, [], 'the private memory stays');

  const flaky = fakeDmChannel(messages);
  const pageOf = flaky.messages.fetch;
  flaky.messages.fetch = async (options) => {
    if (options.before) throw new Error('page fetch failed');
    return pageOf(options);
  };
  const { admin: admin2 } = makeAdmin(rootDir, { client: fakeDmClient(flaky), store });
  const result = await admin2.run('private.purge', { userId: '123' }, { guildId: 'g1' });
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

  const result = await admin.run('private.purge', { userId: '123' }, { guildId: 'g1' });

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
  await admin.run('private.purge', { userId: '123' }, { guildId: 'g1' }).catch((err) => { purgeError = err; });
  await admin.run('private.forget', { userId: '123' }, { guildId: 'g1' }).catch((err) => { forgetError = err; });
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

    const shown = await admin.run('private.show', { userId: '123' }, { guildId: 'g1' });
    assert.match(shown.split('\n')[0], /Zoé/);
    assert.match(shown, /private affinity: 8\b/);
    assert.match(shown, /replies today: 1\b/);
    assert.match(shown, /buffer: 1\b/);
    assert.ok(!shown.includes('SECRET-BUFFERED-TEXT'));

    await admin.run('private.forget', { userId: '123' }, { guildId: 'g1' });
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

  assert.deepEqual(store.wipeCalls, [['g1', undefined]]);
  assert.ok(result.includes('users removed: 2'));
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

test('memory.forget / private.forget / memory.wipe: wait for a live-analyzer run in flight before deleting', async () => {
  const rootDir = makeRoot();
  const client = clientWithGuild('g1', 'The Server');
  for (const [key, args, deleted] of [
    ['memory.forget', { userId: '123' }, (store) => store.forgotten.length],
    ['private.forget', { userId: '123' }, (store) => store.forgottenPrivate.length],
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-admin-alias-'));
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

test('run: learned.list orders by rank, decayed with memory.learnedHalfLifeDays', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const { admin, store, dataDir } = makeRealStoreAdmin(rootDir, { hot });
  try {
    const opts = { confirmGapHours: 0 };
    // #1: heavy (weight 3) but last seen in March; #2: weight 1, seen in September.
    store.applyLearnedOps('g1', { add: ['ἀρχαῖα ἑλληνικά'] }, { ...opts, seenAt: LEARNED_DAY('2026-01-01') });
    store.applyLearnedOps('g1', { seen: [1] }, { ...opts, seenAt: LEARNED_DAY('2026-02-01') });
    store.applyLearnedOps('g1', { seen: [1] }, { ...opts, seenAt: LEARNED_DAY('2026-03-01') });
    store.applyLearnedOps('g1', { add: ['crème brûlée'] }, { ...opts, seenAt: LEARNED_DAY('2026-09-01') });

    hot.config.memory = { learnedHalfLifeDays: 720 };
    let lines = (await admin.run('learned.list', {}, { guildId: 'g1' })).split('\n');
    assert.match(lines[0], /^#1 ἀρχαῖα ἑλληνικά · seen 3 · last 2026-03-01$/);
    assert.match(lines[1], /^#2 crème brûlée /);

    hot.config.memory = { learnedHalfLifeDays: 10 };
    lines = (await admin.run('learned.list', {}, { guildId: 'g1' })).split('\n');
    assert.match(lines[0], /^#2 crème brûlée /, 'a short half-life lets the recent item outrank the heavy old one');
    assert.match(lines[1], /^#1 /);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('run: learned.add stores a new item without from, confirmed at once (memory.confirmAfter 3), firstSeen == lastSeen == now', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.memory = { confirmAfter: 3 };
  const { admin, store, dataDir } = makeRealStoreAdmin(rootDir, { hot });
  try {
    const before = Date.now();
    await admin.run('learned.add', { text: '  ο φάρος ανάβει στις εννιά  ' }, { guildId: 'g1' });
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
    await admin.run('learned.add', { text: 'crème brûlée' }, { guildId: 'g1' });
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
    await admin.run('learned.add', { text: 'ο φάρος' }, { guildId: 'g1' });
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
    await admin.run('learned.add', { text: 'première' }, { guildId: 'g1' });
    assert.equal(store.getGuild('g1').learned[0].weight, 3);

    // Within confirmGapHours: a sighting would not bump it, so neither does the repeat.
    await admin.run('learned.add', { text: 'Première' }, { guildId: 'g1' });
    assert.equal(store.getGuild('g1').learned[0].weight, 3);

    // With no gap required, a sighting bumps by exactly one -- and so does the repeat.
    hot.config.memory = { confirmAfter: 3, confirmGapHours: 0 };
    await admin.run('learned.add', { text: 'première' }, { guildId: 'g1' });
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
    const result = await admin.run('learned.remove', { id: 1 }, { guildId: 'g1' });
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

  await assert.rejects(() => admin.run('learned.add', { text: 'première' }, { guildId: 'g1' }), /paused.*resume/i);
  await assert.rejects(() => admin.run('learned.remove', { id: 1 }, { guildId: 'g1' }), /paused.*resume/i);
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
// status / reload
// ---------------------------------------------------------------------------

test('run: status reports dry-run on, logging only, when no mirror channel is configured', async () => {
  const rootDir = makeRoot();
  const { admin, hot } = makeAdmin(rootDir);
  hot.config.features = { dryRun: true };
  hot.config.bot.dryRunChannelId = '';

  const body = await admin.run('status', {}, {});
  assert.equal(body.split('\n')[0], 'dry-run: on → log');
});

test('run: status shows the initiate cooldown only while it holds', async () => {
  const rootDir = makeRoot();
  const { admin, hot, store } = makeAdmin(rootDir);
  hot.config.spontaneous = { initiateCooldownHours: [2, 4] };
  const until = Date.now() + 3_600_000;
  const cooldownLines = (body) => body.split('\n').filter((line) => line.startsWith('initiate cooldown'));

  assert.deepEqual(cooldownLines(await admin.run('status', {}, {})), [], 'none stored');
  store.state.data.spontaneousInitiateUntil = { g1: until };
  assert.deepEqual(cooldownLines(await admin.run('status', {}, {})), [`initiate cooldown until ${new Date(until).toISOString()}`]);
  store.state.data.spontaneousInitiateUntil = { g1: Date.now() - 1000 };
  assert.deepEqual(cooldownLines(await admin.run('status', {}, {})), [], 'already over');
});

// ---------------------------------------------------------------------------
// interject / initiate
// ---------------------------------------------------------------------------

function fakeSpontaneous(forceResult) {
  const calls = [];
  return {
    calls,
    force: async (channel, mode) => {
      calls.push([channel.id, mode]);
      return forceResult ?? { ok: true };
    },
  };
}

test('run: interject and initiate use the context channel when no channel argument is given', async () => {
  for (const mode of ['interject', 'initiate']) {
    const rootDir = makeRoot();
    const spontaneous = fakeSpontaneous();
    const client = { channels: { fetch: async (id) => ({ id }) } };
    const { admin } = makeAdmin(rootDir, { spontaneous, client });

    const result = await admin.run(mode, {}, { channelId: 'c1' });

    assert.deepEqual(spontaneous.calls, [['c1', mode]], mode);
    assert.ok(result.includes(`${mode} on c1`), `${mode}: ${result}`);
  }
});

test('run: interject uses the channel argument when given, overriding the context channel', async () => {
  const rootDir = makeRoot();
  const spontaneous = fakeSpontaneous();
  const client = { channels: { fetch: async (id) => ({ id }) } };
  const { admin } = makeAdmin(rootDir, { spontaneous, client });

  await admin.run('interject', { channelId: 'other' }, { channelId: 'c1' });

  assert.deepEqual(spontaneous.calls, [['other', 'interject']]);
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

test('pause: stops a mentor run and waits for it before flushing', async () => {
  const rootDir = makeRoot();
  let resolveIdle;
  const idlePromise = new Promise((resolve) => {
    resolveIdle = resolve;
  });
  const calls = [];
  let running = true;
  const mentor = {
    isRunning: () => running,
    stop: () => {
      calls.push('stop');
      return { ok: true };
    },
    waitIdle: () => {
      calls.push('waitIdle');
      return idlePromise;
    },
  };
  const { admin, store } = makeAdmin(rootDir, { mentor });

  const pausePromise = admin.run('pause', {}, {});
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ['stop', 'waitIdle'], 'the run is stopped first, then waited for');
  assert.equal(store.dropCachesCalls, 0, 'must not drop caches before the mentor run ended');
  const flushesBefore = store.flushCalls;

  running = false;
  resolveIdle();
  const result = await pausePromise;
  assert.equal(store.dropCachesCalls, 1);
  assert.ok(store.flushCalls > flushesBefore, 'flushed after the mentor run ended');
  assert.match(result, /mentor run .*stopped/i);
  assert.match(result, /resume/i);

  // Nothing runs: no stop, and the reply says nothing about the mentor.
  const idleCalls = [];
  const idleMentor = {
    isRunning: () => false,
    stop: () => idleCalls.push('stop'),
    waitIdle: () => (idleCalls.push('waitIdle'), Promise.resolve()),
  };
  const { admin: idleAdmin } = makeAdmin(makeRoot(), { mentor: idleMentor });
  const idleResult = await idleAdmin.run('pause', {}, {});
  assert.deepEqual(idleCalls, []);
  assert.doesNotMatch(idleResult, /mentor/i);
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-admin-data-'));
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-admin-portrait-'));
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
        llm: { model: 'x/y', maxRequestTokens: 50000, safetyMargin: 0.9 },
        memory: { fieldChars: 400, mainChannelIds: [] },
        warmup: { minMessages: 2, contextBefore: 1, maxChannelShare: 1 },
      },
      prompts: { profile: 'PROFILE {{name}}', 'character-card': 'CARD {{name}}', labels },
    };
    const warmup = createWarmup({
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-admin-voice-'));
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
    hot.config.llm.model = 'x/y';
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-admin-timers-'));
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
    ['memory.affinity', { userId: '123', score: 5 }],
    ['memory.wipe', { confirm: 'The Server' }],
    ['lore.add', { title: 'Y', keys: 'y', text: 'z' }],
    ['lore.remove', { id: loreId }],
    ['interject', {}],
    ['initiate', {}],
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
  await assert.doesNotReject(() => admin.run('reload', {}, {}));
  await assert.doesNotReject(() => admin.run('set', { path: 'llm.model', value: '"x/y"' }, {}));
  await assert.doesNotReject(() => admin.run('unset', { path: 'llm.model' }, {}));
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
// warmup -- people stays read-only; run/user/users/channel/channels/server
// write under data/ and are guarded by assertNotPaused().
// ---------------------------------------------------------------------------

function fakeWarmup(overrides = {}) {
  const calls = {
    peopleReport: 0,
    run: 0,
    stop: 0,
    runPerson: 0,
    runChannel: 0,
    runServer: 0,
    runUsers: 0,
    runChannels: 0,
    status: 0,
    reset: 0,
    refreshPortrait: 0,
  };
  return {
    calls,
    run: async (guildId) => {
      calls.run += 1;
      calls.lastRunGuildId = guildId;
      return overrides.run ?? { ok: true };
    },
    stop: () => {
      calls.stop += 1;
      return overrides.stop ?? { ok: true };
    },
    runPerson: async (guildId, userId) => {
      calls.runPerson += 1;
      calls.lastRunPersonId = userId;
      return (
        overrides.runPerson ?? {
          ok: true,
          outcome: {
            ok: true,
            member: { id: userId, name: 'Alice', messages: 40, firstTs: 1000, lastTs: 5000 },
            answer: {
              character: 'friendly and curious',
              style: 'short',
              interests: [{ topic: 'games', note: 'plays a lot', times: 3 }],
              details: [{ text: 'lives nearby', times: 1 }],
              episodes: [],
              aliases: ['Al'],
            },
            sample: { ownCount: 10, contextCount: 5 },
            tokensUsed: 1234,
            chunks: 1,
          },
        }
      );
    },
    runChannel: async (guildId, channelId) => {
      calls.runChannel += 1;
      calls.lastRunChannelId = channelId;
      return (
        overrides.runChannel ?? {
          ok: true,
          outcome: {
            ok: true,
            channel: { id: channelId, name: 'general' },
            result: { purpose: 'general chat', topics: 'everything', tone: 'casual' },
          },
        }
      );
    },
    runServer: async (guildId) => {
      calls.runServer += 1;
      calls.lastRunServerGuildId = guildId;
      return (
        overrides.runServer ?? {
          ok: true,
          outcome: { ok: true, counts: { patternsChars: 120, startersChars: 40, injokes: 3, lore: 2 } },
        }
      );
    },
    runUsers: async (guildId) => {
      calls.runUsers += 1;
      calls.lastRunUsersGuildId = guildId;
      return overrides.runUsers ?? { ok: true, count: 5 };
    },
    runChannels: async (guildId) => {
      calls.runChannels += 1;
      calls.lastRunChannelsGuildId = guildId;
      return overrides.runChannels ?? { ok: true, count: 8 };
    },
    status: async () => {
      calls.status += 1;
      return (
        overrides.status ?? {
          phase: 'running',
          doneChannels: 1,
          channelsEligible: 2,
          donePeople: 3,
          peopleEligible: 5,
          doneServer: false,
          tokensUsed: 1000,
          requests: 4,
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: null,
          aborted: null,
          nextTarget: 'person: Bob (id:2)',
        }
      );
    },
    reset: () => {
      calls.reset += 1;
      return overrides.reset ?? { ok: true };
    },
    refreshPortrait: async (guildId, userId, reason, opts) => {
      calls.refreshPortrait += 1;
      calls.lastRefreshUserId = userId;
      calls.lastRefreshOpts = opts;
      return overrides.refreshPortrait ?? { ok: true, userId };
    },
    peopleReport: async () => {
      calls.peopleReport += 1;
      return (
        overrides.peopleReport ?? {
          ok: true,
          people: [{ id: '1', name: 'Alice', messages: 40, firstTs: 1000, lastTs: 5000, byChannel: { c1: 40 } }],
          totals: { channelsRead: 3, messagesRead: 500, belowThreshold: 2 },
        }
      );
    },
  };
}

// ---------------------------------------------------------------------------
// warmup.run / users / channels / server / status / reset / memory.refresh
// -- the write path
// ---------------------------------------------------------------------------

test('run: warmup.run starts the whole run in the background and replies at once', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  const body = await admin.run('warmup.run', {}, { guildId: 'g1' });
  assert.equal(warmup.calls.run, 1);
  assert.equal(warmup.calls.lastRunGuildId, 'g1');
  assert.match(body, /warmup started/);
  assert.match(body, /warmup status/);
});

test('run: warmup.run is refused while a warmup is already in flight', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup, isWarmingUp: () => true });

  const body = await admin.run('warmup.run', {}, { guildId: 'g1' });
  assert.equal(warmup.calls.run, 0);
  assert.equal(body, 'a warmup is running: follow it with /nep warmup status, end it with /nep warmup stop');
});

test('run: warmup.run is refused while paused', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  await admin.run('pause', {}, {});
  await assert.rejects(() => admin.run('warmup.run', {}, { guildId: 'g1' }), /paused/);
  assert.equal(warmup.calls.run, 0);
});

test('run: warmup.users with a member profiles exactly that member now, synchronously, and summarizes what was written', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  const body = await admin.run('warmup.users', { userId: '1' }, { guildId: 'g1' });
  assert.equal(warmup.calls.runPerson, 1);
  assert.equal(warmup.calls.lastRunPersonId, '1');
  assert.equal(warmup.calls.runUsers, 0, 'a member given must not also start the background bulk redo');
  assert.match(body, /profiled Alice \(id:1\)/);
  assert.match(body, /sample: 10 own \/ 5 context lines/);
  assert.match(body, /tokens used: 1234/);
  assert.match(body, /interests: 1, details: 1, episodes: 0, aliases: 1/);
  assert.match(body, /character: friendly and curious/);
});

test('run: warmup.users with a member is refused while paused', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  await admin.run('pause', {}, {});
  await assert.rejects(() => admin.run('warmup.users', { userId: '1' }, { guildId: 'g1' }), /paused/);
  assert.equal(warmup.calls.runPerson, 0);
});

test('run: warmup.users with no member starts a background redo of every qualifying member', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  const body = await admin.run('warmup.users', {}, { guildId: 'g1' });
  assert.equal(warmup.calls.runUsers, 1);
  assert.equal(warmup.calls.lastRunUsersGuildId, 'g1');
  assert.equal(warmup.calls.runPerson, 0, 'no member given must not also profile one synchronously');
  assert.equal(body, 'started 5 members');
});

test('run: warmup.users with no member is refused while paused', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  await admin.run('pause', {}, {});
  await assert.rejects(() => admin.run('warmup.users', {}, { guildId: 'g1' }), /paused/);
  assert.equal(warmup.calls.runUsers, 0);
});

test('run: warmup.channels with a channel describes exactly that channel now, synchronously, and reports the note written', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  const body = await admin.run('warmup.channels', { channelId: 'c1' }, { guildId: 'g1' });
  assert.equal(warmup.calls.runChannel, 1);
  assert.equal(warmup.calls.lastRunChannelId, 'c1');
  assert.equal(warmup.calls.runChannels, 0, 'a channel given must not also start the background bulk redo');
  assert.match(body, /described #general \(id:c1\)/);
  assert.match(body, /purpose: general chat/);
  assert.match(body, /topics: everything/);
  assert.match(body, /tone: casual/);
});

test('run: warmup.channels with a channel is refused while paused', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  await admin.run('pause', {}, {});
  await assert.rejects(() => admin.run('warmup.channels', { channelId: 'c1' }, { guildId: 'g1' }), /paused/);
  assert.equal(warmup.calls.runChannel, 0);
});

test('run: warmup.channels with no channel starts a background redo of every readable channel', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  const body = await admin.run('warmup.channels', {}, { guildId: 'g1' });
  assert.equal(warmup.calls.runChannels, 1);
  assert.equal(warmup.calls.runChannel, 0, 'no channel given must not also describe one synchronously');
  assert.equal(body, 'started 8 channels');
});

test('run: warmup.channels with no channel is refused while paused', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  await admin.run('pause', {}, {});
  await assert.rejects(() => admin.run('warmup.channels', {}, { guildId: 'g1' }), /paused/);
  assert.equal(warmup.calls.runChannels, 0);
});

test('run: warmup.server is refused while paused', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  await admin.run('pause', {}, {});
  await assert.rejects(() => admin.run('warmup.server', {}, { guildId: 'g1' }), /paused/);
  assert.equal(warmup.calls.runServer, 0);
});

test('run: warmup.reset is refused while paused and never touches warmup progress', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  await admin.run('pause', {}, {});
  await assert.rejects(() => admin.run('warmup.reset', {}, { guildId: 'g1' }), /paused/);
  assert.equal(warmup.calls.reset, 0);
});

test('run: memory.refresh forces a portrait refresh, ignoring the hours rail', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  const body = await admin.run('memory.refresh', { userId: '1' }, { guildId: 'g1' });
  assert.equal(warmup.calls.refreshPortrait, 1);
  assert.equal(warmup.calls.lastRefreshUserId, '1');
  assert.deepEqual(warmup.calls.lastRefreshOpts, { force: true });
  assert.match(body, /refreshed/);
});

test('run: memory.refresh is refused while paused', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  await admin.run('pause', {}, {});
  await assert.rejects(() => admin.run('memory.refresh', { userId: '1' }, { guildId: 'g1' }), /paused/);
  assert.equal(warmup.calls.refreshPortrait, 0);
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
// ping: the YouTube line after the video role (src/memory/youtube-check.js)
// ---------------------------------------------------------------------------

function fakeYoutubeDescriber(result) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    checkYoutube: async () => {
      calls += 1;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test('run: ping video appends the YouTube line right after the video line, one per status', async () => {
  const cases = [
    [{ status: 'ytdlp', detail: 'duration 19s', keySet: false }, 'youtube: API key — not needed (yt-dlp ok)'],
    [{ status: 'api', detail: 'duration 19s', keySet: true }, 'youtube: API key — ok'],
    [{ status: 'page', detail: 'duration 19s', keySet: false }, 'youtube: API key — missing (page only, unreliable)'],
    [
      { status: 'page', detail: 'duration 19s', keySet: true },
      'youtube: API key — failed (page only, unreliable)',
    ],
    [{ status: 'blocked', detail: '', keySet: false }, 'youtube: API key — missing (blocked)'],
    [
      { status: 'blocked', detail: 'ytdlp=download api=download page=download', keySet: true },
      'youtube: API key — failed (blocked)',
    ],
  ];
  for (const [result, expected] of cases) {
    const rootDir = makeRoot();
    const hot = hotForPing(rootDir);
    hot.config.classifier.video = 'openrouter/video-model';
    const llm = fakeLlm(() => ({ text: 'pong', usage: {}, estimated: 1 }));
    const describer = fakeYoutubeDescriber(result);
    const { admin } = makeAdmin(rootDir, { hot, llm, describer });

    const lines = (await admin.run('ping', { role: 'classifier.video' }, {})).split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith('classifier.video: openrouter/video-model — ok,'));
    assert.equal(lines[1], expected);
    assert.equal(describer.calls, 1);
  }
});

// ---------------------------------------------------------------------------
// ping: the web line (src/web/lookup.js), no network call
// ---------------------------------------------------------------------------

function fakeWebLookup(hasKey) {
  let searches = 0;
  return {
    hasSearch: () => hasKey,
    search: async () => {
      searches += 1;
      return null;
    },
    get searches() {
      return searches;
    },
  };
}

test('run: ping classifier appends the web line last: key ok, no key, or lookup off', async () => {
  const cases = [
    [true, true, 'web: API key — ok'],
    [true, false, 'web: API key — missing'],
    [false, true, 'web: API key — off'],
    [undefined, true, 'web: API key — off'],
  ];
  for (const [webLookup, hasKey, expected] of cases) {
    const rootDir = makeRoot();
    const hot = hotForPing(rootDir);
    if (webLookup !== undefined) hot.config.features = { ...hot.config.features, webLookup };
    else if (hot.config.features) delete hot.config.features.webLookup;
    const llm = fakeLlm(() => ({ text: 'pong', usage: {}, estimated: 1 }));
    const lookup = fakeWebLookup(hasKey);
    const { admin } = makeAdmin(rootDir, { hot, llm, lookup });

    const lines = (await admin.run('ping', { role: 'classifier' }, {})).split('\n');
    assert.equal(lines.at(-1), expected);
    assert.equal(lines.filter((l) => l.startsWith('web:')).length, 1);
    assert.equal(lookup.searches, 0, 'no search request');
    assert.ok(llm.calls.every((c) => c.options.maxOutputTokens === 16), 'only the model pings');
  }
});

// ---------------------------------------------------------------------------
// ping: the image line, checked against the provider's public model listing
// ---------------------------------------------------------------------------

const IMAGE_MODEL = 'openai/gpt-image-2.5-flare';
const FAKE_KEY = 'sk-or-v1-fakekeyfortests0000';

/** A fake fetch: records every call and answers with `respond(url, init)`. */
function fakeListingFetch(respond) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond(url, init);
  };
  impl.calls = calls;
  return impl;
}

function listing(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function listedBody(modalities, endpoints) {
  return { data: { id: IMAGE_MODEL, architecture: { output_modalities: modalities }, endpoints } };
}

/** A ping-ready hot config with the image model set, drawing on, and a base URL with a trailing slash. */
function hotForImagePing(rootDir, { model = IMAGE_MODEL, imageGeneration = true } = {}) {
  const hot = hotForPing(rootDir);
  hot.config.llm.baseUrl = 'https://openrouter.ai/api/v1/';
  hot.config.image = { model };
  hot.config.features = { ...hot.config.features, imageGeneration };
  return hot;
}

/** `llm` with the real client's `modelEndpoints` (src/llm/openrouter.js) over `fetchImpl` and FAKE_KEY:
 * the listing GET goes out exactly as in production, while chat completions stay fake. */
function withListing(llm, hot, fetchImpl) {
  const real = createLlm({
    apiKey: FAKE_KEY,
    getConfig: () => hot.config,
    calibrator: { apply: (n) => n, observe() {} },
    state: { data: {}, markDirty() {} },
    fetchImpl,
  });
  return Object.assign(llm, { modelEndpoints: real.modelEndpoints });
}

function imageAdmin(rootDir, { hot, fetchImpl, llm } = {}) {
  const config = hot ?? hotForImagePing(rootDir);
  return makeAdmin(rootDir, {
    hot: config,
    llm: withListing(llm ?? fakeLlm(() => ({ text: 'pong', usage: {}, estimated: 1 })), config, fetchImpl),
  });
}

test('ping: image listed with image output reports the endpoint count and latency', async () => {
  const rootDir = makeRoot();
  const fetchImpl = fakeListingFetch(() => listing(200, listedBody(['image', 'text'], [{}, {}])));
  const { admin } = imageAdmin(rootDir, { fetchImpl });

  const body = await admin.run('ping', { role: 'image' }, {});

  assert.match(body, /^image: openai\/gpt-image-2\.5-flare — listed, image output, 2 endpoint\(s\), \d+ ms$/);
  assert.equal(fetchImpl.calls.length, 1);
  const [{ url, init }] = fetchImpl.calls;
  assert.equal(url, 'https://openrouter.ai/api/v1/models/openai/gpt-image-2.5-flare/endpoints');
  assert.equal(init.method, 'GET');
  assert.equal(init.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.ok(init.signal instanceof AbortSignal, 'the request carries a timeout signal');
});

test('ping: the image check sends no chat completion and leaves state untouched', async () => {
  const rootDir = makeRoot();
  const fetchImpl = fakeListingFetch(() => listing(200, listedBody(['image'], [{}])));
  const llm = fakeLlm(() => ({ text: 'pong', usage: {}, estimated: 1 }));
  const calibrator = { ratio: 1 };
  const images = { familyOf, quota: () => { throw new Error('the image caps must not be read'); }, generate: async () => { throw new Error('no generation'); } };
  const hot = hotForImagePing(rootDir);
  const { admin, store } = makeAdmin(rootDir, { hot, llm: withListing(llm, hot, fetchImpl), calibrator, images });
  const before = structuredClone(store.state.data);
  let dirtied = 0;
  store.state.markDirty = () => {
    dirtied += 1;
  };

  const body = await admin.run('ping', { role: 'image' }, {});

  assert.equal(llm.calls.length, 0, 'no chat completion');
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(store.state.data, before);
  assert.equal(dirtied, 0);
  assert.deepEqual(calibrator, { ratio: 1 });
  assert.ok(!body.includes(FAKE_KEY), 'the key never reaches the reply');
  assert.ok(!body.includes('Bearer'));
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

function hotForDraw(rootDir, image = {}) {
  const hot = makeHot(rootDir);
  hot.config.image = { model: 'openai/image-model', maxPromptChars: 800, reference: 'avatar', referenceMaxBytes: 4000000, ...image };
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

// ---------------------------------------------------------------------------
// mentor: the owner's interface to the manual mentor (src/mentor/*)
// ---------------------------------------------------------------------------

const MENTOR_NOW = Date.parse('2026-09-30T12:00:00.000Z');

/** A fake mentor: `run`/`check` resolve at once with a `done` that never settles, so a handler
 * that awaited it would never finish. */
/** A moment as the mentor's resolveAnchor returns it: two messages up to the trigger, an answer of two. */
function sampleMoment(messageId = '800000000000000004') {
  return {
    channelId: '500000000000000001',
    messageId,
    triggerId: '800000000000000003',
    history: [
      { id: '800000000000000002', authorId: 'bot', self: true, content: 'ναι' },
      { id: '800000000000000003', authorId: 'u1', self: false, content: 'é'.repeat(1580) },
    ],
    original: ['you are right, but', 'no'],
  };
}

function fakeMentor({ run, check, status, stopOk = false, resolveAnchor } = {}) {
  const calls = [];
  return {
    calls,
    async readAnchor(ref, context) {
      calls.push(['resolveAnchor', ref, context]);
      if (resolveAnchor) return resolveAnchor(ref, context);
      return sampleMoment(/^\d+$/.test(ref) ? ref : '800000000000000004');
    },
    async run(caseId) {
      calls.push(['run', caseId]);
      if (run) return run(caseId);
      return { started: true, done: new Promise(() => {}) };
    },
    async check() {
      calls.push(['check']);
      if (check) return check();
      return { started: true, cases: 2, done: new Promise(() => {}) };
    },
    stop() {
      calls.push(['stop']);
      return { ok: stopOk };
    },
    status() {
      return status ? status() : { running: false };
    },
    isRunning: () => false,
  };
}

/** An admin with a real case store on a temp dir, a real budget over the fake store's state and a fake mentor. */
function makeMentorAdmin(extra = {}) {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.features = { mentor: true };
  hot.config.mentor = { model: 'mentor/model-a', maxTokensPerDay: 1000 };
  const store = makeStore();
  const now = () => MENTOR_NOW;
  const mentorCases = createCaseStore({ dataDir: path.join(rootDir, 'data'), now });
  const mentorBudget = createMentorBudget({ state: store.state, getConfig: () => hot.config, now });
  const mentor = extra.mentor ?? fakeMentor();
  const { admin } = makeAdmin(rootDir, { hot, store, mentor, mentorCases, mentorBudget });
  return { admin, hot, store, mentor, mentorCases, mentorBudget, rootDir };
}

/** A finished run as the mentor saves it, trimmed to what the report reads. */
function sampleMentorRun(caseId, { passed = true, overall = 7, target = 'reply' } = {}) {
  return {
    caseId,
    caseText: 'Answer a greeting with one short line.',
    target,
    kind: 'run',
    startedAt: '2026-09-30T11:00:00.000Z',
    finishedAt: '2026-09-30T11:05:00.000Z',
    models: { mentor: 'mentor/model-a', voice: 'voice/model', analyzer: 'voice/model' },
    reference: { profile: null, samples: 0 },
    situations: [],
    dropped: 0,
    repeated: [],
    medians: { human: overall, character: overall, rules: overall, goal: overall, overall },
    passed,
    reasons: passed ? [] : ['human below the bar'],
    tokens: { spent: 120, left: 880 },
  };
}

const MENTOR_KEYS = [
  'mentor.add',
  'mentor.anchor',
  'mentor.cases',
  'mentor.remove',
  'mentor.run',
  'mentor.check',
  'mentor.stop',
  'mentor.show',
  'mentor.wrong',
  'mentor.status',
];
const MENTOR_ARGS = { text: 'Answer a greeting with one short line.', message: '800000000000000009', id: 1, reason: 'it was fine' };

test('run: mentor.add reads the moment of the message and stores a reply case with it as moment 1', async () => {
  const { admin, mentor, mentorCases } = makeMentorAdmin();
  const link = 'https://discord.com/channels/1/500000000000000001/800000000000000004';

  assert.equal(
    await admin.run('mentor.add', { message: ` ${link} `, text: 'Too quick to concede before objecting.' }, { guildId: 'g1', channelId: '500000000000000007' }),
    'case 1 added (reply), moment 1: 2 messages up to the trigger, an answer of 2 messages',
  );
  // The link as given (trimmed), with the channel the command was typed in (for a bare id).
  assert.deepEqual(mentor.calls, [['resolveAnchor', link, { channelId: '500000000000000007' }]]);
  const [item] = mentorCases.list('g1');
  assert.deepEqual([item.id, item.target, item.state, item.text], [1, 'reply', 'new', 'Too quick to concede before objecting.']);
  assert.deepEqual(item.anchors, [{ id: 1, ...sampleMoment(), addedAt: new Date(MENTOR_NOW).toISOString() }]);
  // A target given by an older client is ignored: every new case is a reply case.
  await admin.run('mentor.add', { message: '800000000000000005', text: 'Remember the pet named Héloïse.', target: 'memory' }, { guildId: 'g1' });
  assert.equal(mentorCases.get('g1', 2).target, 'reply');
});

test('run: mentor.anchor adds a moment to a case, up to mentor.anchor.max read now', async () => {
  const { admin, mentor, mentorCases, hot } = makeMentorAdmin();
  await admin.run('mentor.add', { message: '800000000000000004', text: 'Answer a greeting with one short line.' }, { guildId: 'g1' });
  hot.config.mentor.anchor = { max: 2 };

  assert.equal(
    await admin.run('mentor.anchor', { id: 1, message: '800000000000000005' }, { guildId: 'g1', channelId: '500000000000000001' }),
    'case 1: moment 2: 2 messages up to the trigger, an answer of 2 messages (2 of 2)',
  );
  assert.deepEqual(mentor.calls.at(-1), ['resolveAnchor', '800000000000000005', { channelId: '500000000000000001' }]);
  assert.deepEqual(mentorCases.get('g1', 1).anchors.map((a) => [a.id, a.messageId]), [[1, '800000000000000004'], [2, '800000000000000005']]);

  // Full: refused before the message is read.
  const reads = mentor.calls.length;
  await assert.rejects(() => admin.run('mentor.anchor', { id: 1, message: '800000000000000006' }, { guildId: 'g1' }), /at most 2 \(mentor\.anchor\.max\)/);
  assert.equal(mentor.calls.length, reads);
  // The same message twice is refused by the case store.
  hot.config.mentor.anchor = { max: 5 };
  await assert.rejects(() => admin.run('mentor.anchor', { id: 1, message: '800000000000000005' }, { guildId: 'g1' }), /already a moment of case 1/);
  // An unknown case, or no message, is refused before anything is read.
  await assert.rejects(() => admin.run('mentor.anchor', { id: 9, message: '800000000000000006' }, { guildId: 'g1' }), /^Error: no case 9$/);
  await assert.rejects(() => admin.run('mentor.anchor', { id: 1 }, { guildId: 'g1' }), /message link or id is required/);
  assert.equal(mentor.calls.length, reads + 1);
  assert.equal(mentorCases.get('g1', 1).anchors.length, 2);
});

test('run: mentor.cases lists the active cases, one line each, with the last score or - and the text clipped to 80', async () => {
  const { admin, mentorCases, rootDir } = makeMentorAdmin();
  const long = `Keep replies short in the evening; ${'every message stays under a dozen words '.repeat(3)}`.trim();
  mentorCases.add('g1', { text: long, target: 'reply' });
  // A memory case stored by an earlier version (`add` takes reply cases only) is still listed as it is.
  mentorCases.add('g1', { text: 'Remember the pet named Héloïse.', target: 'reply' });
  const casesFile = path.join(rootDir, 'data', 'guilds', 'g1', 'mentor', 'cases.json');
  const stored = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
  stored.cases[1].target = 'memory';
  fs.writeFileSync(casesFile, JSON.stringify(stored));
  mentorCases.add('g1', { text: 'A retired case that is not listed.', target: 'reply' });
  mentorCases.saveRun('g1', sampleMentorRun(2, { passed: true, overall: 7, target: 'memory' }));
  mentorCases.retire('g1', 3);
  mentorCases.add('g1', { text: 'Too quick to concede before objecting.', target: 'reply', anchor: sampleMoment() });

  const lines = (await admin.run('mentor.cases', {}, { guildId: 'g1' })).split('\n');
  assert.deepEqual(lines, [
    `1 [new] reply - ${long.slice(0, 77)}...`,
    '2 [passing] memory 7 Remember the pet named Héloïse.',
    '4 [new] reply - moments 1 Too quick to concede before objecting.',
  ]);
});

test('run: mentor.remove retires a case; an unknown id is refused', async () => {
  const { admin, mentorCases } = makeMentorAdmin();
  mentorCases.add('g1', { text: 'Answer a greeting with one short line.', target: 'reply' });

  assert.equal(await admin.run('mentor.remove', { id: 1 }, { guildId: 'g1' }), 'case 1 retired');
  assert.equal(mentorCases.get('g1', 1).state, 'retired');
  await assert.rejects(() => admin.run('mentor.remove', { id: 9 }, { guildId: 'g1' }), /^Error: no case 9$/);
});

/** `n` reply cases in the real case store, ids 1..n. */
function seedMentorCases(mentorCases, n) {
  for (let i = 0; i < n; i += 1) mentorCases.add('g1', { text: 'Answer a greeting with one short line.', target: 'reply' });
}

test('run: mentor.run starts the run and replies at once, without waiting for it to finish', async () => {
  const { admin, mentor, hot, mentorCases } = makeMentorAdmin();
  seedMentorCases(mentorCases, 3);
  hot.config.bot.dryRunChannelId = '700000000000000001';
  const reply = await admin.run('mentor.run', { id: 3 }, { guildId: 'g1' });
  assert.equal(reply, 'run started for case 3; the report will come to the admin channel');
  assert.deepEqual(mentor.calls, [['run', 3]]);
});

test('run: mentor.wrong records the owner feedback on the last run', async () => {
  const { admin, mentorCases } = makeMentorAdmin();
  mentorCases.add('g1', { text: 'Answer a greeting with one short line.', target: 'reply' });
  const saved = mentorCases.saveRun('g1', sampleMentorRun(1));

  assert.equal(await admin.run('mentor.wrong', { id: 1, reason: 'the second answer was the natural one' }, { guildId: 'g1' }), 'noted for case 1');
  const [entry] = mentorCases.recentFeedback('g1', 5);
  assert.equal(entry.caseId, 1);
  assert.equal(entry.runId, saved.id);
  assert.equal(entry.reason, 'the second answer was the natural one');
});

/** A saved run with its own outcome and finish time; one scored answer of two. */
function finishedMentorRun(caseId, finishedAt, extra = {}) {
  return {
    ...sampleMentorRun(caseId, { passed: false, overall: 5 }),
    situations: [{ n: 1, title: 't', lines: [], transcript: '', answers: [{ id: 's1a1', score: { overall: 5 } }, { id: 's1a2', score: null }] }],
    tokens: { spent: 450, left: 550 },
    finishedAt,
    ...extra,
  };
}

test('mentor.status: an unreadable run file gives "last: cannot be read"', async () => {
  const { admin, mentorCases, rootDir } = makeMentorAdmin();
  mentorCases.add('g1', { text: 'First case text here.', target: 'reply' });
  mentorCases.add('g1', { text: 'Second case text here.', target: 'reply' });
  mentorCases.saveRun('g1', finishedMentorRun(1, '2026-09-30T11:05:00.000Z'));
  const broken = mentorCases.saveRun('g1', finishedMentorRun(2, '2026-09-30T11:10:00.000Z'));
  fs.writeFileSync(path.join(rootDir, 'data', 'guilds', 'g1', 'mentor', 'runs', '2', `${broken.id}.json`),'{ not json');

  const lines = (await admin.run('mentor.status', {}, { guildId: 'g1' })).split('\n');
  assert.equal(lines.at(-2), 'running: no');
  assert.equal(lines.at(-1), 'last: cannot be read');
});

test('run: mentor add/anchor/remove/run/check/wrong are refused while paused; cases/show/status/stop are not', async () => {
  const { admin, mentor, mentorCases, store } = makeMentorAdmin();
  mentorCases.add('g1', { text: 'Answer a greeting with one short line.', target: 'reply' });
  mentorCases.saveRun('g1', sampleMentorRun(1));
  store.state.data.paused = true;

  for (const key of ['mentor.add', 'mentor.anchor', 'mentor.remove', 'mentor.run', 'mentor.check', 'mentor.wrong']) {
    await assert.rejects(() => admin.run(key, MENTOR_ARGS, { guildId: 'g1' }), /paused.*resume/i, key);
  }
  assert.deepEqual(mentor.calls, [], 'the mentor is never started while paused');
  assert.equal(mentorCases.list('g1').length, 1);
  assert.equal(mentorCases.get('g1', 1).state, 'passing');
  assert.deepEqual(mentorCases.recentFeedback('g1', 5), []);

  for (const key of ['mentor.cases', 'mentor.show', 'mentor.status', 'mentor.stop']) {
    await assert.doesNotReject(() => admin.run(key, MENTOR_ARGS, { guildId: 'g1' }), key);
  }
});

test('run: access.grant refuses the private, mentor and access groups and their commands (owner-only), writing nothing', async () => {
  // Each group's refusal names that group: keep every row.
  for (const [group, commands, refusal] of [
    ['private', ['private.show', 'private.forget', 'private'], /private memory is owner-only/],
    ['mentor', ['mentor', ...MENTOR_KEYS], /the mentor is owner-only/],
    ['access', ['access', 'access.grant', 'access.revoke', 'access.list'], /access management is owner-only/],
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

  const body = await admin.run('emoji.rescan', {}, { guildId: 'g1' });
  assert.deepEqual(emojiBackfill.calls, [['g1', { force: true }]]);
  assert.equal(body, 'Emoji rescan done: 3 channels, 120 messages read, 17 emoji uses counted.');
});

test('run: emoji.rescan is refused while paused and without the backfill', async () => {
  const rootDir = makeRoot();
  const emojiBackfill = fakeEmojiBackfill();
  const { admin } = makeAdmin(rootDir, { emojiBackfill });
  await admin.run('pause', {}, {});
  await assert.rejects(() => admin.run('emoji.rescan', {}, { guildId: 'g1' }), /paused/);
  assert.equal(emojiBackfill.calls.length, 0);

  const { admin: bare } = makeAdmin(rootDir);
  assert.equal(await bare.run('emoji.rescan', {}, { guildId: 'g1' }), 'the emoji backfill is not available');
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
  await assert.rejects(() => admin.run('gifs.rescan', {}, { guildId: 'g1' }), /paused/);
  assert.equal(gifBackfill.calls.length, 0);

  const { admin: bare } = makeAdmin(rootDir);
  assert.equal(await bare.run('gifs.rescan', {}, { guildId: 'g1' }), 'the GIF backfill is not available');
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
  const out = await admin.run('gifs.status', {}, { guildId: 'g1' });
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
  await assert.rejects(() => admin.run('gifs.recache', {}, { guildId: 'g1' }), /paused/);
  assert.equal(gifRecache.calls.length, 0);

  const { admin: bare } = makeAdmin(rootDir);
  assert.equal(await bare.run('gifs.recache', {}, { guildId: 'g1' }), 'the GIF recache is not available');
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
  await admin.run('route.set', { model: 'google/', providers: ' google-ai-studio , google-vertex ,', role: 'classifier.video' }, {});
  await admin.run('route.set', { model: 'anthropic/claude-sonnet-4.6', providers: 'amazon-bedrock', role: 'voice', fallbacks: true }, {});

  assert.deepEqual(readLocal(rootDir).llm.providerByModel, {
    'google/': { only: ['google-vertex'], allow_fallbacks: false },
    'google/@classifier.video': { only: ['google-ai-studio', 'google-vertex'], allow_fallbacks: false },
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
  ];
  for (const [args, message] of bad) {
    await assert.rejects(() => admin.run('route.set', args, {}), message, JSON.stringify(args));
  }
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
  assert.equal(hot.reloadConfigCalls, 0);
});

test('run: route.remove deletes only the named key; an unknown route is an error and writes nothing', async () => {
  const rootDir = makeRoot();
  const { admin, hot } = makeAdmin(rootDir);
  await admin.run('route.set', { model: 'google/', providers: 'google-vertex' }, {});
  await admin.run('route.set', { model: 'google/', providers: 'google-ai-studio', role: 'classifier.video' }, {});

  const result = await admin.run('route.remove', { model: 'google/', role: 'classifier.video' }, {});
  assert.match(result, /google\/@classifier\.video/);
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

function hotForRoutes(rootDir) {
  const hot = makeHotWithMedia(rootDir);
  hot.config.llm.provider = null;
  hot.config.classifier = { text: null, media: 'google/gemini-3.8-flash', video: 'google/gemini-3.8-flash' };
  hot.config.mentor = { model: null };
  hot.config.image = { model: 'openai/gpt-image-x', provider: { only: ['openai'] } };
  hot.config.media = { video: { provider: { order: ['google-ai-studio'], allow_fallbacks: false } } };
  return hot;
}

test('run: route.list renders every route (prefix, role or any, providers, fallbacks) and the route each role gets', async () => {
  const rootDir = makeRoot();
  const hot = hotForRoutes(rootDir);
  hot.config.llm.provider = { ignore: ['some-provider'] };
  const { admin } = makeAdmin(rootDir, { hot });
  await admin.run('route.set', { model: 'google/', providers: 'google-vertex' }, {});
  await admin.run('route.set', { model: 'google/', providers: 'google-ai-studio', role: 'classifier.video' }, {});
  await admin.run('route.set', { model: 'anthropic/', providers: 'amazon-bedrock,anthropic', role: 'analyzer', fallbacks: true }, {});

  const lines = (await admin.run('route.list', {}, {})).split('\n');

  assert.deepEqual(lines, [
    'routes:',
    '  anthropic/ | analyzer | only amazon-bedrock, anthropic | fallbacks: on',
    '  google/ | any | only google-vertex | fallbacks: off',
    '  google/ | classifier.video | only google-ai-studio | fallbacks: off',
    'by role:',
    '  voice: anthropic/claude-opus-4.6 -> llm.provider (ignore some-provider, fallbacks: on)',
    '  analyzer: anthropic/claude-opus-4.6 -> anthropic/@analyzer (only amazon-bedrock, anthropic, fallbacks: on)',
    '  classifier.text: google/gemini-3.8-flash -> google/ (only google-vertex, fallbacks: off)',
    '  classifier.media: google/gemini-3.8-flash -> google/ (only google-vertex, fallbacks: off)',
    '  classifier.video: google/gemini-3.8-flash -> google/@classifier.video (only google-ai-studio, fallbacks: off); direct-URL videos: media.video.provider (order google-ai-studio, fallbacks: off)',
    '  mentor: (no model configured)',
    '  image: openai/gpt-image-x -> image.provider (only openai, fallbacks: on)',
  ]);
});

test('run: route.list shows a route key still written with the old role name talk as the route of the voice role', async () => {
  const rootDir = makeRoot();
  const hot = hotForRoutes(rootDir);
  hot.config.llm.providerByModel = { 'anthropic/@talk': { only: ['amazon-bedrock'], allow_fallbacks: false } };
  const { admin } = makeAdmin(rootDir, { hot });

  const lines = (await admin.run('route.list', {}, {})).split('\n');
  assert.ok(lines.includes('  voice: anthropic/claude-opus-4.6 -> anthropic/@talk (only amazon-bedrock, fallbacks: off)'));
  assert.ok(lines.includes('  analyzer: anthropic/claude-opus-4.6 -> none'), 'the old name is the voice role only');
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

test('run: ping sends each role as its own role and pings a shared model once per distinct route', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir);
  // memory.model null -> the analyzer shares the voice model; classifier.text falls back to classifier.media.
  const llm = fakeLlm((options) => ({ text: 'pong', usage: {}, estimated: 1, provider: `served-${options.role}` }));
  const { admin } = makeAdmin(rootDir, { hot, llm });

  const plain = (await admin.run('ping', {}, {})).split('\n');
  assert.deepEqual(llm.calls.map((c) => c.options.role), ['voice', 'classifier.text'], 'no routes: one call per model, as the first role using it');
  assert.ok(plain.some((l) => l.startsWith('analyzer: anthropic/claude-opus-4.6 — ok,') && l.includes('provider=served-voice')));

  hot.config.llm.providerByModel = { 'anthropic/@analyzer': { only: ['amazon-bedrock'] } };
  llm.calls.length = 0;
  const routed = (await admin.run('ping', {}, {})).split('\n');
  assert.deepEqual(llm.calls.map((c) => c.options.role), ['voice', 'analyzer', 'classifier.text'], 'the analyzer route differs from voice: its own call');
  assert.ok(routed.some((l) => l.startsWith('voice: anthropic/claude-opus-4.6 — ok,') && l.includes('provider=served-voice')));
  assert.ok(routed.some((l) => l.startsWith('analyzer: anthropic/claude-opus-4.6 — ok,') && l.includes('provider=served-analyzer')));
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
  hot.config.bot.access = { 'memory.recent': { everyone: false, roles: ['123'], users: [] } };

  const text = await admin.run('memory.recent', {}, { guildId: 'g1' });

  assert.ok(text.includes('a line'));
  assert.equal(store.flushCalls, 0);
  assert.equal(admin.isAllowed('memory.recent', { userId: '7', roleIds: ['123'] }), true);
  assert.equal(admin.isAllowed('memory.recent', { userId: '7', roleIds: [] }), false);
});
