// health: allow file-length until 2027-02-01 -- the place rename widened lines the formatter wraps; split in the slice after the cutover
// PR 7b: `admin.run` takes the operation's name (`status.show`, `config.set`, ...); every expectation is as it was.
import { accountOf, placeOfRoot } from '../src/memory/addresses.ts';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { localPath, madeLocalPath } from './fixtures/config-local.ts';
import path from 'node:path';

import { setPath, unsetPath, buildProfileSummary } from '../src/admin.ts';
import type { Untyped } from '../src/tools/types.ts';
import { createStore } from '../src/memory/store.ts';
import { MEMORY_LIMITS } from '../src/memory/text-limits.ts';
import { createAppendStore } from '../src/memory/append-store.ts';
import { archiveEntry, createArchive } from '../src/memory/archive.ts';
import { createJournal } from '../src/memory/journal.ts';
import { PERSONA_ID } from '../src/memory/db/ids.ts';
import { buildDrawPrompt } from '../src/behavior/prompt.ts';
import { familyOf, ImageGenError } from '../src/llm/images.ts';
import { ROLE_DEFAULTS } from '../src/llm/roles.ts';
import { createMetrics } from '../src/tools/operations/metrics.ts';

import { splitPath } from '../src/tools/operations/shared.ts';
import { labels } from './fixtures/labels.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { tempDir } from './fixtures/tmp.ts';
import { makeAdmin, makeHot, makeHotWithMedia, makeRoot, mayRun, readLocal } from './fixtures/admin-rig.ts';
import { world } from './fixtures/turn-world.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { makeStore } from './fixtures/admin-store.ts';
import { chainsOf } from './fixtures/chains.ts';
import { writeUnitUpdate } from './fixtures/memory-db/unit-writes.ts';

type Field = { name: string; value: string };

// The Discord interface's capabilities object, as src/index.js injects it.

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
  const nameOf = (id: string) => (id === otherId ? 'Zoe' : null);

  const text = buildProfileSummary(profile, {}, nameOf);
  assert.ok(text.includes(`character: trusts Zoe (id:${otherId})`));
});

// ---------------------------------------------------------------------------
// createAdmin().run — fakes on a temp dir
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// rule.add / rule.list / rule.remove
// ---------------------------------------------------------------------------

/** An admin over a real store on a fresh test memory, closed after `body`. */
async function withRulesAdmin(
  body: (admin: ReturnType<typeof makeAdmin>['admin'], rootDir: string) => Promise<void>
): Promise<void> {
  const mem = await openTestMemory();
  try {
    const rootDir = makeRoot();
    const store = createStore({ dataDir: mem.dataDir, memoryDb: mem.memoryDb });
    await body(makeAdmin(rootDir, { store }).admin, rootDir);
  } finally {
    await mem.close();
    fs.rmSync(mem.dataDir, { recursive: true, force: true });
  }
}

// Changed: the rules are rows of the memory table `rules` (the owner on 2026-11-17), so `rule.add` and `rule.remove`
// write no file and reload no prompt; these replace the tests of the bullets they wrote to `prompts.local/rules.md`.
test('run: rule.add then rule.remove leave the later rule listed as 1 and write no prompt file', () =>
  withRulesAdmin(async (admin, rootDir) => {
    const baseBefore = fs.readFileSync(path.join(rootDir, 'prompts', 'rules.md'));
    await admin.run('rule.add', { text: 'be kind' }, {});
    await admin.run('rule.add', { text: 'second\nrule' }, {});
    assert.equal(await admin.run('rule.list', {}, {}), '1. be kind\n2. second rule');
    assert.equal(await admin.run('rule.remove', { number: 1 }, {}), 'Removed rule #1: be kind');
    assert.equal(await admin.run('rule.list', {}, {}), '1. second rule');
    assert.equal(fs.existsSync(path.join(rootDir, 'prompts.local')), false);
    assert.deepEqual(fs.readFileSync(path.join(rootDir, 'prompts', 'rules.md')), baseBefore);
  }));

test('run: rule.add rejects empty text', () =>
  withRulesAdmin(async (admin) => {
    await assert.rejects(() => admin.run('rule.add', { text: '   ' }, {}));
  }));

test('run: rule.remove rejects a number past the live rules', () =>
  withRulesAdmin(async (admin) => {
    await admin.run('rule.add', { text: 'only rule' }, {});
    await assert.rejects(() => admin.run('rule.remove', { number: 2 }, {}), /no rule #2/);
    await assert.rejects(() => admin.run('rule.remove', { number: 0 }, {}), /no rule #0/);
  }));

// ---------------------------------------------------------------------------
// set / unset
// ---------------------------------------------------------------------------

test('run: set writes an override to config.local.json and reloads config', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.bot.timezone = 'UTC';
  const { admin } = makeAdmin(rootDir, { hot });

  // Changed: `models.base` is retired (spec 2026-11-09-model-routes, slice 4); `bot.timezone` is the string leaf here.
  const result = await admin.run('config.set', { path: 'bot.timezone', value: '"Europe/Athens"' }, {});

  assert.deepEqual(readLocal(rootDir), { bot: { timezone: 'Europe/Athens' } });
  assert.equal(hot.reloadConfigCalls, 1);
  assert.ok(result.includes('Set bot.timezone'));
});

test('run: set falls back to the raw string when the value is not valid JSON', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.bot.timezone = 'UTC';
  const { admin } = makeAdmin(rootDir, { hot });

  // Changed: `models.base` is retired (spec 2026-11-09-model-routes, slice 4); `bot.timezone` is the string leaf here.
  await admin.run('config.set', { path: 'bot.timezone', value: 'Plain/Text' }, {});
  assert.deepEqual(readLocal(rootDir), { bot: { timezone: 'Plain/Text' } });
});

test('run: set rejects an unknown config path and writes nothing', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await assert.rejects(
    () => admin.run('config.set', { path: 'llm.doesNotExist', value: '1' }, {}),
    /unknown config path/
  );
  assert.equal(fs.existsSync(localPath(rootDir)), false);
});

test('run: unset removes a previously set override', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.bot.timezone = 'UTC';
  const { admin } = makeAdmin(rootDir, { hot });

  // Changed: `models.base` is retired (spec 2026-11-09-model-routes, slice 4); `bot.timezone` is the string leaf here.
  await admin.run('config.set', { path: 'bot.timezone', value: '"Asia/Tokyo"' }, {});
  await admin.run('config.unset', { path: 'bot.timezone' }, {});

  assert.deepEqual(readLocal(rootDir), {});
  assert.equal(hot.reloadConfigCalls, 2);
});

test('run: set and unset read a key with a dot as one key, never a path', async () => {
  const rootDir = makeRoot();
  const { admin, hot } = makeAdmin(rootDir);
  hot.config.models = {
    ...hot.config.models,
    agents: { model: { scout: 'openrouter/a/b' } },
  };
  hot.config.names = { 'x.web': 'old' };

  const result = await admin.run(
    'config.set',
    { path: 'models.agents.model.scout', value: 'openrouter/x-ai/web-model' },
    {}
  );
  assert.ok(result.startsWith('Set models.agents.model.scout = "openrouter/x-ai/web-model"'), result);
  await admin.run('config.set', { path: 'names.x.web', value: 'new' }, {});
  assert.deepEqual(readLocal(rootDir), {
    models: { agents: { model: { scout: 'openrouter/x-ai/web-model' } } },
    names: { 'x.web': 'new' },
  });

  await admin.run('config.unset', { path: 'models.agents.model.scout' }, {});
  assert.deepEqual(readLocal(rootDir), { names: { 'x.web': 'new' } });
  await assert.rejects(
    () => admin.run('config.set', { path: 'names.x', value: '"x/y"' }, {}),
    /unknown config path: names\.x/
  );
});

// The owner's decision of 2026-11-10: the caller of a typed command is always the owner, so a change of the
// owner's own keys checks no caller.
test('set: a typed config.set of bot.ownerPerson writes it whatever account the command carries', async () => {
  for (const context of [{}, { placeId: 'g1', accountId: '999' }]) {
    const rootDir = makeRoot();
    const { admin } = makeAdmin(rootDir);
    const result = await admin.run('config.set', { path: 'bot.ownerPerson', value: '"person:7"' }, context);
    assert.match(result, /^Set bot\.ownerPerson/, JSON.stringify(context));
    assert.deepEqual(readLocal(rootDir), { bot: { ownerPerson: 'person:7' } }, JSON.stringify(context));
  }
});

test('set: accepts only an own leaf path of the live config and a value of the same JSON type', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  // Changed: `models.base` is retired (spec 2026-11-09-model-routes, slice 4); `bot.ownerPerson` is the string leaf here.
  hot.config.bot = { ...hot.config.bot, spare: null };
  hot.config.tools = { ...hot.config.tools, safeMode: false };
  // An array setting, for the type check below (`bot.owners` was the array here before it was retired).
  hot.config.mention = { neverIgnore: [] };
  const { admin } = makeAdmin(rootDir, { hot });
  const owner = { accountId: '42' };

  await assert.rejects(
    () => admin.run('config.set', { path: 'toString', value: '1' }, owner),
    /unknown config path: toString/
  );
  await assert.rejects(
    () => admin.run('config.set', { path: 'llm.hasOwnProperty', value: '1' }, owner),
    /unknown config path: llm\.hasOwnProperty/
  );
  await assert.rejects(() => admin.run('config.set', { path: 'llm', value: '5' }, owner), /llm is a section/);
  await assert.rejects(
    () => admin.run('config.set', { path: 'llm.maxRequestsPerDay', value: '3OO' }, owner),
    /llm\.maxRequestsPerDay expects a number, got a string/
  );
  await assert.rejects(
    () => admin.run('config.set', { path: 'tools.safeMode', value: '"true"' }, owner),
    /tools\.safeMode expects a boolean, got a string/
  );
  await assert.rejects(
    () => admin.run('config.set', { path: 'mention.neverIgnore', value: '"42"' }, owner),
    /mention\.neverIgnore expects an array, got a string/
  );
  assert.equal(fs.existsSync(localPath(rootDir)), false, 'nothing was written');

  await admin.run('config.set', { path: 'llm.maxRequestsPerDay', value: '250' }, owner);
  await admin.run('config.set', { path: 'tools.safeMode', value: 'true' }, owner);
  await admin.run('config.set', { path: 'bot.spare', value: '"x/y"' }, owner); // the current value is null: any type
  await admin.run('config.set', { path: 'bot.ownerPerson', value: '123' }, owner); // a string setting keeps the text as typed
  assert.deepEqual(readLocal(rootDir), {
    bot: { ownerPerson: '123', spare: 'x/y' },
    llm: { maxRequestsPerDay: 250 },
    tools: { safeMode: true },
  });
});

// ---------------------------------------------------------------------------
// model.show / model.set
// ---------------------------------------------------------------------------

test("run: model.show lists each role with its own model; an unset role shows its own default, never another role's", async () => {
  const rootDir = makeRoot();
  const hot = makeHotWithMedia(rootDir);
  hot.config.models = {
    ...hot.config.models,
    agents: { via: { scout: 'opencode' }, model: { scout: 'vendor/agent' } },
  };
  const { admin } = makeAdmin(rootDir, { hot });

  const lines = (await admin.run('model.show', {}, {})).split('\n');
  assert.ok(lines.includes('vision: anthropic/claude-haiku-4.5'));
  assert.ok(lines.includes(`analyzer: ${ROLE_DEFAULTS.analyzer}`), 'the analyzer is not the vision model');
  assert.ok(!lines.some((line: string) => line.startsWith('reasoner')), 'the reasoner is merged into the analyzer');
  // Changed: the development roles `thinker` and `dev` are gone (maintainer, 2026-11-16).
  assert.deepEqual(
    lines.map((line: string) => line.split(':')[0]),
    // Changed: the agents are read from disk: `code`, `scout` and `server`.
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
      'code',
      'scout',
      'server',
    ],
    'the base roles, then the errand roles under their group line'
  );
  assert.equal(lines[0], 'base:');
  assert.equal(lines[8], 'errands:');
  // Changed: an agent's line is its route, harness and model, `-` with no route (owner, 2026-11-17), and `code` comes
  // first.
  assert.deepEqual(lines.slice(10, 12), ['scout: opencode-harness vendor/agent', 'server: -']);
});

/** `hot` with a chain of one route on `main` for each role of `models`, over the chains it holds. */
function withChains(hot: ReturnType<typeof makeHotWithMedia>, models: Record<string, string>) {
  hot.config.models = { ...hot.config.models, routes: { ...hot.config.models.routes, ...chainsOf(models) } };
  return hot;
}

// Changed: an agent's model is its route's, which `/model set <agent>` writes through the subharness, so model.set
// takes the base roles alone (owner, 2026-11-17).
test("run: model.set puts the model on each route of a base role's chain", async () => {
  // Changed: a base role's model is its chain's (spec 2026-11-09-model-routes, slice 4), so the rig gives each base role
  // a chain on `main` first, and the set rewrites the model of that chain.
  const rootDir = makeRoot();
  const hot = withChains(makeHotWithMedia(rootDir), {
    analyzer: 'x/analyzer',
    video: 'x/video',
    embedding: 'x/embedding',
    drawing: 'x/drawing',
  });
  const changedAt = Date.UTC(2026, 9, 15, 9, 30);
  const { admin } = makeAdmin(rootDir, { hot, now: () => changedAt });

  await admin.run('model.set', { role: 'core', id: 'anthropic/claude-opus-4.6' }, {});
  assert.deepEqual(readLocal(rootDir), { models: { routes: chainsOf({ core: 'anthropic/claude-opus-4.6' }) } });

  await admin.run('model.set', { role: 'analyzer', id: 'openrouter/text-model' }, {});
  await admin.run('model.set', { role: 'vision', id: 'anthropic/claude-haiku-4.5' }, {});
  await admin.run('model.set', { role: 'video', id: 'openrouter/video-model' }, {});
  await admin.run('model.set', { role: 'embedding', id: 'openai/text-embedding-3-small' }, {});
  await admin.run('model.set', { role: 'drawing', id: 'openai/gpt-image-x' }, {});
  assert.deepEqual(readLocal(rootDir), {
    models: {
      routes: chainsOf({
        core: 'anthropic/claude-opus-4.6',
        analyzer: 'openrouter/text-model',
        vision: 'anthropic/claude-haiku-4.5',
        video: 'openrouter/video-model',
        embedding: 'openai/text-embedding-3-small',
        drawing: 'openai/gpt-image-x',
      }),
    },
    // The video model changed (the vision one was set to the model it already had).
    media: { recacheBefore: new Date(changedAt).toISOString() },
  });
  // Changed: the development roles `thinker` and `dev` are gone (maintainer, 2026-11-16).
  assert.equal(hot.reloadConfigCalls, 6);
});

test('run: model.set vision or video sets media.recacheBefore to the moment of the change and says so; other roles never do', async () => {
  const changedAt = Date.UTC(2026, 9, 15, 9, 30);
  const iso = new Date(changedAt).toISOString();
  const everyChain = { analyzer: 'x/a', video: 'x/v', embedding: 'x/e', drawing: 'x/d' };
  for (const role of ['vision', 'video']) {
    const rootDir = makeRoot();
    const hot = withChains(makeHotWithMedia(rootDir), everyChain);
    const { admin } = makeAdmin(rootDir, { hot, now: () => changedAt });
    const reply = await admin.run('model.set', { role, id: 'google/a-new-model' }, {});
    assert.deepEqual(
      readLocal(rootDir),
      { models: { routes: chainsOf({ [role]: 'google/a-new-model' }) }, media: { recacheBefore: iso } },
      role
    );
    assert.equal(hot.reloadConfigCalls, 1, `${role}: one write, one reload`);
    assert.match(reply, /^Set (vision|video) model to google\/a-new-model \(reload ok\)\n/);
    assert.ok(reply.includes(`media.recacheBefore set to ${iso}`), role);
  }
  // Changed: the development roles `thinker` and `dev` are gone (maintainer, 2026-11-16).
  for (const role of ['core', 'analyzer', 'embedding', 'drawing']) {
    const rootDir = makeRoot();
    const hot = withChains(makeHotWithMedia(rootDir), everyChain);
    const { admin } = makeAdmin(rootDir, { hot, now: () => changedAt });
    const reply = await admin.run('model.set', { role, id: 'google/a-new-model' }, {});
    assert.equal(readLocal(rootDir).media, undefined, role);
    assert.ok(!reply.includes('recacheBefore'), role);
  }
});

test('run: model.set vision to the model it already has leaves media.recacheBefore alone', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir) });
  await admin.run('model.set', { role: 'vision', id: 'anthropic/claude-haiku-4.5' }, {});
  assert.deepEqual(readLocal(rootDir), { models: { routes: chainsOf({ vision: 'anthropic/claude-haiku-4.5' }) } });
});

test('run: model.set refuses a base role with no chain, whose key it cannot name, and writes nothing', async () => {
  // Catches: a model written for a role with no route, which no request reads, so the set looks done and changes nothing.
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir) });
  await assert.rejects(() => admin.run('model.set', { role: 'speech', id: 'x/voice' }, {}), /no route/);
  assert.equal(fs.existsSync(localPath(rootDir)), false);
});

test('run: model.set rejects an unknown role and a role name that is no longer one, and writes nothing', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir) });

  // Changed: the development roles `thinker` and `dev` are gone (maintainer, 2026-11-16), and the agents `scout` and
  // `server` run on their routes, which model.set never writes (owner, 2026-11-17).
  for (const role of ['bogus', 'web', 'voice', 'writer', 'memory', 'byPurpose', 'thinker', 'dev', 'scout', 'server']) {
    await assert.rejects(
      () => admin.run('model.set', { role, id: 'x/y' }, {}),
      new RegExp(
        `unknown role: ${role.replace('.', '\\.')} \\(core, analyzer, vision, video, embedding, speech, drawing\\)`
      ),
      role
    );
  }
  assert.equal(fs.existsSync(localPath(rootDir)), false);
});

test('run: model.set rejects an id that does not look like a model id', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir) });

  await assert.rejects(() => admin.run('model.set', { role: 'core', id: 'x' }, {}), /model id/);
  await assert.rejects(() => admin.run('model.set', { role: 'drawing', id: 'has spaces here' }, {}), /model id/);
  assert.equal(fs.existsSync(localPath(rootDir)), false);
});

test('run: model.set accepts a loosely-valid id (letters, digits, dot, colon, slash, dash, underscore)', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir), now: () => 0 });

  await admin.run('model.set', { role: 'vision', id: 'anthropic/claude-haiku-4.5:beta' }, {});
  assert.deepEqual(readLocal(rootDir), {
    models: { routes: chainsOf({ vision: 'anthropic/claude-haiku-4.5:beta' }) },
    media: { recacheBefore: new Date(0).toISOString() },
  });
});

test('model set drawing: writes the drawing chain to config.local.json, reloads, and model show lists it', async () => {
  // Changed: the drawing model is its chain's (slice 4), so the rig starts drawing on a chain of its own.
  const rootDir = makeRoot();
  const hot = withChains(makeHotWithMedia(rootDir), { drawing: ROLE_DEFAULTS.drawing });
  hot.reloadConfig = function reloadConfig() {
    this.reloadConfigCalls += 1;
    this.config.models = {
      ...this.config.models,
      routes: { ...this.config.models?.routes, ...readLocal(rootDir).models.routes },
    };
    return true;
  };
  const { admin } = makeAdmin(rootDir, { hot });

  assert.ok((await admin.run('model.show', {}, {})).split('\n').includes(`drawing: ${ROLE_DEFAULTS.drawing}`));
  const reply = await admin.run('model.set', { role: 'drawing', id: 'openai/gpt-image-x' }, {});
  assert.match(reply, /^Set drawing model to openai\/gpt-image-x /);
  assert.deepEqual(readLocal(rootDir), { models: { routes: chainsOf({ drawing: 'openai/gpt-image-x' }) } });
  assert.equal(hot.reloadConfigCalls, 1);
  assert.ok((await admin.run('model.show', {}, {})).split('\n').includes('drawing: openai/gpt-image-x'));
});

// ---------------------------------------------------------------------------
// the rights check
// ---------------------------------------------------------------------------

// The owner's decision of 2026-11-10: a typed command is the owner's, so runSkillOp checks no caller for it.
test('runSkillOp: a typed command runs an operation that was owner-only, with no grant, whatever its account', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  for (const caller of [{ accountId: '8' }, {}]) {
    const listed = await admin.runSkillOp('access.list', {}, { placeId: 'g1', roleIds: [], ...caller });
    assert.equal(listed.status, 'ok', JSON.stringify(caller));
    assert.equal(await mayRun(admin, 'memory.journal.read', caller), true, JSON.stringify(caller));
  }
});

// ---------------------------------------------------------------------------
// access.grant / access.revoke / access.list
// ---------------------------------------------------------------------------

// The owner's decision of 2026-11-10: only he types commands, and a grant names the persona alone.
// Changed: the tool is `memory.search`, since `status.show` is an operation of the console and no tool of hers.
test('run: access.grant stores her id alone under the operation name', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  await admin.run('access.grant', { command: 'memory.search' }, {});
  assert.deepEqual(readLocal(rootDir), { bot: { access: { 'memory.search': { users: ['self-id'] } } } });
});

// The owner's decision of 2026-11-10: only he types commands, and a grant names the persona alone.
test('run: access.grant takes no role or other user: a stray target argument still grants her alone', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  await admin.run('access.grant', { command: 'memory.search', roleId: '123' }, {});
  await admin.run('access.grant', { command: 'lore.list', accountId: '456' }, {});
  assert.deepEqual(readLocal(rootDir), {
    bot: { access: { 'memory.search': { users: ['self-id'] }, 'lore.list': { users: ['self-id'] } } },
  });
});

// The owner's decision of 2026-11-10: only he types commands, and a grant names the persona alone.
test('run: access.grant refuses and writes nothing while no interface has said who she is', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { selfId: () => null });
  await assert.rejects(() => admin.run('access.grant', { command: 'memory.search' }, {}));
  assert.equal(fs.existsSync(localPath(rootDir)), false);
});

test('run: access.grant rejects an unknown tool and an old command key, writing nothing', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await assert.rejects(() => admin.run('access.grant', { command: 'nonsense' }, {}), /nonsense/);
  await assert.rejects(() => admin.run('access.grant', { command: 'memory.show' }, {}), /memory\.show/);
  assert.equal(fs.existsSync(localPath(rootDir)), false);
});

// The owner's decision of 2026-11-10: only he types commands, and a grant names the persona alone.
test('run: access.list names her grants alone; a key held by everyone, a role or another user is left out', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  const people = {
    'memory.search': { everyone: true, roles: [], users: [] },
    'lore.list': { everyone: false, roles: ['r1'], users: ['u-9'] },
  };
  fs.writeFileSync(
    madeLocalPath(rootDir),
    JSON.stringify({ bot: { access: { ...people, 'memory.private.read': { users: ['self-id'] } } } })
  );
  assert.equal(await admin.run('access.list', {}, {}), 'memory.private.read: user id:self-id');

  fs.writeFileSync(madeLocalPath(rootDir), JSON.stringify({ bot: { access: people } }));
  assert.equal(await admin.run('access.list', {}, {}), '(none)');
});

// The owner's decision of 2026-11-10: only he types commands, and a grant names the persona alone.
test('run: access.revoke of her last grant deletes the entry, even one that still holds everyone or a role', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  fs.writeFileSync(
    madeLocalPath(rootDir),
    JSON.stringify({ bot: { access: { 'memory.search': { everyone: true, roles: ['r1'], users: ['self-id'] } } } })
  );
  await admin.run('access.revoke', { command: 'memory.search' }, {});
  assert.deepEqual(readLocal(rootDir), { bot: { access: {} } });
});

// The owner's decision of 2026-11-10: only he types commands, and a grant names the persona alone.
test('run: access grant, list and revoke of a group: her reads under it, named with their source, revoked together', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await admin.run('access.grant', { command: 'memory' }, {});
  const keys = Object.keys(readLocal(rootDir).bot.access);
  assert.ok(keys.length > 0 && keys.every((key) => key.startsWith('memory.')), keys.join(', '));
  const lines = (await admin.run('access.list', {}, {})).split('\n');
  assert.deepEqual(
    lines,
    keys.map((key) => `${key}: user id:self-id (expanded from memory, reads only)`)
  );

  await admin.run('access.revoke', { command: 'memory' }, {});
  assert.equal(await admin.run('access.list', {}, {}), '(none)');
  assert.equal(await admin.run('access.revoke', { command: 'memory' }, {}), 'Nothing to revoke');
});

// Changed: the alias writes left with `alias.add` and `alias.remove`, so the affinity read is the one write path left.
test('memory.profile.read affinity: a member with no profile is refused and none is created', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  const writes: Array<Array<unknown>> = [];
  const adjustAffinity = store.adjustAffinity.bind(store);
  store.adjustAffinity = (...call: Parameters<typeof adjustAffinity>) => {
    writes.push(call);
    return adjustAffinity(...call);
  };

  await assert.rejects(
    () => admin.run('memory.profile.read', { accountId: '555', section: 'affinity', score: 10 }, { placeId: 'g1' }),
    /^Error: no profile for 555$/
  );
  assert.deepEqual(writes, []);
  assert.equal(store.getUser(accountOf(store, '555')), null);
});

test('run: memory.profile.read section affinity is refused when the context names no place, whatever is served', async () => {
  // The fallback to the single served guild pinned the home place the owner removed: the console names the one place.
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('123', { id: '123', affinity: { score: 5, reason: 'ok so far', history: [] } });

  await assert.rejects(
    () => admin.run('memory.profile.read', { accountId: '123', section: 'affinity' }, {}),
    /no place resolved yet/
  );
  assert.ok(
    (await admin.run('memory.profile.read', { accountId: '123', section: 'affinity' }, { placeId: 'g1' })).includes(
      'score: 5'
    )
  );
});

// ---------------------------------------------------------------------------
// private.show and the private-aware memory commands
// ---------------------------------------------------------------------------

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
    buffer: [
      { id: 'm1', content: 'SECRET-BUFFERED-TEXT', ts: 1 },
      { id: 'm2', content: 'another buffered line', ts: 2 },
    ],
    ...overrides,
  };
}

// PR 7d: the per-person reply caps are gone with their count, so the view carries no replies line.
test('run: private.show renders the private layer under the public name, with both scores', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('123', {
    id: '123',
    names: ['Zoé', 'old name'],
    affinity: { score: 50, reason: 'public reason', history: [] },
  });
  store.privates.set('123', samplePrivate());

  const result = await admin.run('memory.private.read', { action: 'show', accountId: '123' }, { placeId: 'g1' });

  assert.match(result.split('\n')[0], /Zoé/);
  assert.match(result, /trusts the persona with plans/);
  assert.match(result, /astronomy/);
  assert.match(result, /owns a telescope/);
  assert.match(result, /studies at night/);
  assert.match(result, /shared a café story/);
  assert.match(result, /private affinity: 12\b/);
  assert.match(result, /kind in private/);
  assert.match(result, /effective affinity: 62\b/);
  assert.ok(!result.includes('SECRET-BUFFERED-TEXT'), 'the buffer contents are never shown');
  assert.ok(!result.includes('another buffered line'), 'the buffer contents are never shown');
  assert.ok(!result.includes('public reason'), 'the public affinity reason is not part of the private view');
});

test('run: private.show clamps the effective score for an owner', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('42', { id: '42', names: ['Owner'], affinity: { score: 90, reason: '', history: [] } });
  store.privates.set('42', samplePrivate({ affinity: { score: 30, reason: '', history: [] } }));

  const result = await admin.run('memory.private.read', { action: 'show', accountId: '42' }, { placeId: 'g1' });

  assert.match(result, /effective affinity: 100\b/);
});

test('run: private.show needs a user', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  await assert.rejects(
    () => admin.run('memory.private.read', { action: 'show' }, { placeId: 'g1' }),
    /a user is required/
  );
  // The half that wanted a resolved guild is gone with the guild: a private layer is read by person.
});

test('run: memory.show never shows the private layer', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('123', {
    id: '123',
    names: ['Zoé'],
    relationship: 'public text',
    affinity: { score: 50, reason: '', history: [] },
  });
  store.privates.set('123', samplePrivate());

  const summary = await admin.run('memory.profile.read', { accountId: '123' }, { placeId: 'g1' });
  const raw = await admin.run('memory.profile.read', { accountId: '123', section: 'raw' }, { placeId: 'g1' });
  for (const text of [summary, raw]) {
    assert.ok(!text.includes('trusts the persona with plans'));
    assert.ok(!text.includes('astronomy'));
  }
});

function clientWithGuild(placeId: string, name: string) {
  return { guilds: { cache: new Map([[placeId, { id: placeId, name }]]) } };
}

// The following memory.show tests exercise `section: 'raw'` (see
// src/admin.js#rawMemoryShowView). The other sections are covered further
// below.

test('run: memory.show section:raw also prints the stored episodes (date, weight, what, quote)', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('123', {
    id: '123',
    episodes: [
      { date: '2026-01-01', what: 'promised to help', quote: 'I got you', feeling: 'touched', weight: 4, addedAt: 'x' },
    ],
  });

  const result = await admin.run('memory.profile.read', { accountId: '123', section: 'raw' }, { placeId: 'g1' });

  assert.ok(result.includes('episodes:'));
  assert.ok(result.includes('2026-01-01'));
  assert.ok(result.includes('weight 4'));
  assert.ok(result.includes('promised to help'));
  assert.ok(result.includes('I got you'));
});

// PR 7d: `memory.maxInterests` is the constant MEMORY_LIMITS.maxInterests, so that many fresh interests fill the shown part.
test('run: memory.show section:raw lists every stored interest in rank order and marks the divider between shown and hidden', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  const fresh = Array.from({ length: MEMORY_LIMITS.maxInterests }, (_, n) => ({
    topic: `Fresh interest ${n}`,
    note: '',
    weight: 1,
    firstSeen: 'a',
    lastSeen: '2026-09-20T00:00:00.000Z',
  }));
  store.profiles.set('123', {
    id: '123',
    interests: [
      { topic: 'Ancient favorite', note: '', weight: 10, firstSeen: 'a', lastSeen: '2021-01-01T00:00:00.000Z' },
      ...fresh,
    ],
  });

  const result = await admin.run('memory.profile.read', { accountId: '123', section: 'raw' }, { placeId: 'g1' });
  assert.ok(result.includes('Fresh interest'), 'both stored interests are listed');
  assert.ok(result.includes('Ancient favorite'));
  const lines = result.split('\n');
  const freshLine = lines.findIndex((l: string) => /^Fresh interest \d+ \[weight/.test(l.trim()));
  const dividerLine = lines.findIndex((l: string) => l.includes('not shown'));
  const ancientLine = lines.findIndex((l: string) => l.trim().startsWith('Ancient favorite [weight'));
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
  store.profiles.set('123', {
    id: '123',
    interests: [
      { topic: 'Old', note: '', weight: 5, firstSeen: 'a', lastSeen: '2020-01-01T00:00:00.000Z' },
      { topic: 'New', note: '', weight: 1, firstSeen: 'a', lastSeen: '2026-09-01T00:00:00.000Z' },
    ],
  });

  const result = await admin.run(
    'memory.profile.read',
    { accountId: '123', section: 'interests', order: 'recent' },
    { placeId: 'g1' }
  );
  const lines = result.split('\n');
  assert.ok(lines[0].startsWith('New'), 'the newer lastSeen sorts first under order:recent');
  assert.ok(lines[1].startsWith('Old'));
  assert.ok(!result.includes('not shown'), 'order:recent never shows the shown/stored divider');
});

test('run: memory.show respects a custom limit, capping a list section', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('123', {
    id: '123',
    interests: Array.from({ length: 5 }, (_, i) => ({
      topic: `T${i}`,
      note: '',
      weight: 1,
      firstSeen: 'a',
      lastSeen: 'a',
    })),
  });

  const result = await admin.run(
    'memory.profile.read',
    { accountId: '123', section: 'interests', limit: 2 },
    { placeId: 'g1' }
  );
  assert.equal(result.split('\n').length, 2);
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
    { placeId: 'g1' }
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
    { placeId: 'g1' }
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

  const result = await admin.run('lore.remove', { id }, { placeId: 'g1' });
  assert.ok(result.includes('The Flood'));
  assert.deepEqual(store.getLore('g1'), []);
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test('status: the card carries the fields in order and the member variant drops the storage line, memory and speed', async () => {
  const rootDir = makeRoot();
  const journalDir = tempDir('nep-status-journal-');
  const dayFile = path.join(journalDir, 'today.jsonl');
  fs.writeFileSync(dayFile, '{}\n');
  const journal = { dayFile: () => dayFile, stalled: () => true };
  const archive = { stats: () => ({ pending: 3 }) };
  const client = { ws: { ping: 41.6 }, guilds: { cache: new Map() } };
  const { admin, hot, store } = makeAdmin(rootDir, { journal, archive, client });
  hot.config.context = { ...hot.config.context, channelMessages: 60 };
  hot.config.models = {
    ...hot.config.models,
    agents: { via: { scout: 'claude' }, model: { scout: 'claude-sonnet-4.6' } },
  };
  store.state.data.paused = true;
  store.state.data.pausedAt = '2026-10-13T08:30:00.000Z';
  store.state.data.pausedBy = '42';

  const owner = await admin.run('status.show', {}, { accountId: '42' });
  assert.equal(owner.text, '', 'the card alone, no long form');
  const fields = owner.fields;
  assert.deepEqual(
    fields.map((f: Field) => f.name),
    [
      'state',
      'tasks',
      'models.base',
      'keys.base',
      'costs.base',
      'models.errands',
      'costs.errands',
      // Changed: the development fields are gone with the development agents (maintainer, 2026-11-16).
      'inner',
      'limits',
      'memory',
      'speed',
    ]
  );
  const value = (name: string) => fields.find((f: Field) => f.name === name).value;
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
      // Changed: an optional role with no chain is off (spec 2026-11-09-model-routes, slice 4).
      'vision · no model configured',
      'video · no model configured',
      `embedding · ${ROLE_DEFAULTS.embedding}`,
      'speech · no model configured',
      'drawing · no model configured',
    ].join('\n'),
    'no llm client: one line per base role with its own model, unprobed, drawing last'
  );
  assert.equal(
    value('models.errands'),
    // Changed: an agent's line is its route, harness and model (owner, 2026-11-17).
    // Changed: the agents are read from disk: `code`, `scout` and `server`.
    ['code · no model configured', 'scout · claude-harness · claude-sonnet-4.6', 'server · no model configured'].join(
      '\n'
    ),
    'one line per errand agent with its route'
  );
  // PR 7d: the daily caps of videos, recall and lookups are gone, so the limits field is the request rail alone.
  assert.match(value('limits'), /^requests \d+\/300\nresets 00:00 UTC$/);
  assert.deepEqual(
    value('memory')
      .split('\n')
      .map((line: string) => line.slice(0, line.indexOf(':'))),
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

  const member = await admin.run('status.show', {}, { accountId: '999' });
  const memberFields = member.fields;
  assert.deepEqual(
    memberFields.map((f: Field) => f.name),
    ['state', 'tasks', 'models.base', 'models.errands', 'limits']
  );
  assert.deepEqual(
    memberFields[0].value.split('\n').slice(0, 2),
    ['paused since 2026-10-13 08:30 UTC by <@42>', 'last reconnect none'],
    'no storage line for a member'
  );
  assert.equal(member.text, '', 'a member never gets the long form');
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test('status: the owner card shows the limit of each key with its usage under it, then today by role, with no credits read; a member gets neither field and no read', async () => {
  const rootDir = makeRoot();
  const reads: Array<Untyped> = [];
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
    async keyInfo(options: Untyped) {
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

  const fieldOf = async (name: string) =>
    (await admin.run('status.show', {}, { accountId: '42' })).fields.find((f: Field) => f.name === name).value;
  // Changed: the simulator key's line left the card with the simulation.
  assert.deepEqual((await fieldOf('keys.base')).split('\n'), [
    'main 8.45/30.00 USD (resets daily at 2026-10-16 00:00 UTC; BYOK in)',
    'usage day 0.10 USD',
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

  const member = await admin.run('status.show', {}, { accountId: '999' });
  assert.ok(!member.fields.some((f: Field) => f.name.startsWith('costs')), 'no costs field for a member');
  assert.equal(reads.length, 4, 'a member card sends no account read');
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test('status: the field option renders that field alone and runs only its work', async () => {
  const rootDir = makeRoot();
  const reads: Array<Untyped> = [];
  const llm: ProbeLlm = fakeProbeLlm(() => ({ provider: 'Prov' }));
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

  const only = async (field: string, accountId = '42') =>
    (await admin.run('status.show', { field }, { accountId })).fields;
  const limits = await only('limits');
  assert.deepEqual(
    limits.map((f: Field) => f.name),
    ['limits']
  );
  assert.match(limits[0].value, /^requests \d+\/300\n/);
  assert.deepEqual(
    [llm.calls.length, llm.listings.length, reads.length],
    [0, 0, 0],
    'no probe, no listing, no key read'
  );

  assert.deepEqual(
    (await only('costs.base')).map((f: Field) => f.name),
    ['costs.base']
  );
  assert.deepEqual([llm.calls.length, reads.length], [0, 0], 'the role costs read no key');

  const keys = await only('keys.base');
  assert.deepEqual(
    keys.map((f: Field) => f.name),
    ['keys.base']
  );
  assert.deepEqual(reads.sort(), ['activity', 'key'], 'the key and its activity read once each');
  assert.equal(llm.calls.length, 0, 'no model probe for the key field');

  assert.deepEqual(
    (await only('models.errands')).map((f: Field) => f.name),
    ['models.errands']
  );
  // Changed: the development fields are gone with the development agents (maintainer, 2026-11-16).
  assert.deepEqual([llm.calls.length, llm.listings.length], [0, 0], 'the errand field probes nothing');
  assert.deepEqual(
    (await only('models.base')).map((f: Field) => f.name),
    ['models.base']
  );
  assert.ok(llm.calls.length > 0, 'the models.base field probes');
  assert.equal(llm.listings.length, 1, 'the models.base field reads the drawing listing');

  // An owner-only field asked by a member, or an unknown one: the whole card the caller may see.
  hot.config.bot.access = { 'status.show': { everyone: true, roles: [], users: [] } };
  assert.deepEqual(
    (await only('memory', '999')).map((f: Field) => f.name),
    ['state', 'tasks', 'models.base', 'models.errands', 'limits']
  );
  // PR 7d: the inner life is code, so the whole card carries its `inner` field too.
  // Changed: the development fields are gone with the development agents (maintainer, 2026-11-16).
  assert.equal((await only('nonsense')).length, 11);
});

/** A clock the test moves by hand. */
function handClock(start: number) {
  const state = { at: start };
  const now = () => state.at;
  now.advance = (ms: number) => {
    state.at += ms;
  };
  return now;
}

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
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
  const coverageAsked: Array<Untyped> = [];
  const embedQueue = {
    indexSummary() {
      return Promise.resolve({ rows: 1234, missing: 5 });
    },
    async coverage(placeId: string, options: Untyped) {
      coverageAsked.push([placeId, options.hours]);
      return { messages: 200, indexed: 150, missing: 50, oldestMissing: '2026-10-12T08:00:00.000Z' as string | null };
    },
  };
  const { admin, store } = makeAdmin(rootDir, { record, archive, embedQueue, now });
  // PR 7d: the index switches are code and `embed.catchUpHours` is the constant 72.
  store.profiles.set('u1', {
    id: 'u1',
    character: 'Ήσυχη και αστεία',
    episodes: [{}, {}, {}],
    details: [{}, {}],
    aliases: [{}],
    realName: { name: 'Éloïse' },
  });
  store.profiles.set('u2', { id: 'u2', character: '', episodes: [{}], details: [], aliases: [] });
  store.profiles.set('u3', { id: 'u3', character: 'Ζωηρός', episodes: [], details: [], aliases: [] });
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
    (await admin.run('status.show', {}, { accountId: '42' })).fields
      .find((f: Field) => f.name === 'memory')
      .value.split('\n');

  assert.deepEqual(await memoryLines(), [
    'record: 4 messages · 2026-09-30..2026-10-14 · 27% of days have lines',
    'index: 1234 rows · 75% of record messages indexed (last 72 h) · oldest missing 2026-10-12',
    'archive: 4 entries · evicted 2, replaced 1, backfill 1 · observed 2026-03-01..2026-10-13',
    'profiles: 3 · 67% with a portrait · 4 episodes (1.3 per profile) · 2 details · 1 aliases · 1 real names set',
    'server notes: 2 lore entries · 3 lessons · 1 self facts · 2 in-jokes',
    'channels: 2 with notes / 4 seen (50%)',
    'recent lines: 2 · 2026-10-12..2026-10-14',
    'participation fragments: 2 · 2026-10-10..2026-10-14',
  ]);
  assert.deepEqual(coverageAsked, [['g1', 72]]);

  // Within the minute the cached field is shown, whatever changed.
  store.profiles.set('u4', { id: 'u4', character: 'Νέος', episodes: [], details: [], aliases: [] });
  now.advance(30_000);
  assert.equal((await memoryLines())[3].split(' · ')[0], 'profiles: 3', 'cached');
  assert.equal(coverageAsked.length, 1, 'no second coverage read');
  now.advance(31_000);
  assert.equal((await memoryLines())[3].split(' · ')[0], 'profiles: 4', 'a minute later it is read again');
  assert.equal(coverageAsked.length, 2);

  embedQueue.coverage = async () => ({ messages: 0, indexed: 0, missing: 0, oldestMissing: null });
  now.advance(61_000);
  assert.equal((await memoryLines())[1], 'index: 1234 rows · - of record messages indexed (last 72 h) · none missing');
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test('status: the speed field gives the median and the mean of the last 24 h with the count', async () => {
  const rootDir = makeRoot();
  const now = handClock(Date.parse('2026-10-14T12:00:00.000Z'));
  const metrics = createMetrics({ dataDir: path.join(rootDir, 'data'), now });
  metrics.record('reply', 4000);
  metrics.record('reply', 6000);
  metrics.record('reply without recall', 4000);
  metrics.record('meaning search', 120);
  const { admin } = makeAdmin(rootDir, { metrics, now });
  const speedLines = async () =>
    (await admin.run('status.show', {}, { accountId: '42' })).fields
      .find((f: Field) => f.name === 'speed')
      .value.split('\n');

  assert.deepEqual(await speedLines(), [
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
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test("status: the speed field ends with today's missed-answer figures from the journal", async () => {
  const rootDir = makeRoot();
  const now = handClock(Date.parse('2026-10-14T12:00:00.000Z'));
  const asked: Array<Untyped> = [];
  const journal = {
    dayFile: () => path.join(rootDir, 'no-day.jsonl'),
    stalled: () => false,
    read: async (placeId: string, query: Untyped) => {
      asked.push([placeId, query]);
      return [
        { kind: 'answer', event: 'fact', reason: 'gate-failed', messageId: 'm1' },
        { kind: 'answer', event: 'fact', reason: 'turn-error', messageId: 'm2' },
        { kind: 'answer', event: 'verdict', verdict: 'owed', messageId: 'm1' },
        { kind: 'answer', event: 'recovery', outcome: 'spoke', messageIds: ['m1'] },
      ];
    },
  };
  const { admin } = makeAdmin(rootDir, { journal, now });
  const speed = async (accountId = '42') =>
    (await admin.run('status.show', {}, { accountId })).fields.find((f: Field) => f.name === 'speed')?.value;
  assert.equal(await speed(), 'not available\nmissed: 2 candidates, 1 owed, 1 recovered');
  assert.deepEqual(asked, [['g1', { day: '2026-10-14', kind: 'answer', n: Number.MAX_SAFE_INTEGER }]]);
  assert.equal(await speed('999'), undefined, 'a member has no speed field');
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test('status: the card reads every top place, never only the first', async () => {
  // Bug: a second server's memory and missed answers are invisible on the owner's card.
  const rootDir = makeRoot();
  const store = makeStore();
  store.topPlaces = () => ['g1', 'g2'];
  store.guilds.set('g1', { name: 'One', injokes: [], self: [], learned: [] });
  store.guilds.set('g2', { name: 'Two', injokes: [], self: [], learned: [] });
  store.channels.set('g1:c1', { id: 'c1', purpose: 'chat' });
  store.channels.set('g2:c8', { id: 'c8', purpose: '' });
  store.channels.set('g2:c9', { id: 'c9', purpose: '' });
  const asked: Array<unknown> = [];
  const journal = {
    ...fakeJournal(),
    read: async (placeId: string) => {
      asked.push(placeId);
      return [];
    },
  };
  const { admin } = makeAdmin(rootDir, { store, journal });
  const card = (await admin.run('status.show', {}, { accountId: '42' })).fields;
  const memory = card.find((f: Field) => f.name === 'memory').value;

  assert.match(memory, /One\n[\s\S]*channels: 1 with notes \/ 1 seen/);
  assert.match(memory, /Two\n[\s\S]*channels: 0 with notes \/ 2 seen/);
  assert.deepEqual(asked, ['g1', 'g2']);
});

test('status: the storage line flags a journal that stopped writing while turns happen', async () => {
  const rootDir = makeRoot();
  let lastWriteMs: number | null = null;
  const journal = { stats: async () => ({ lastWriteMs }), stalled: () => false };
  const metrics = createMetrics({ dataDir: path.join(rootDir, 'data') });
  const { admin } = makeAdmin(rootDir, { journal, metrics });
  const storage = async () => (await admin.run('status.show', {}, { accountId: '42' })).fields[0].value.split('\n')[1];

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
});

/** A fake llm client for the status probes: `complete` answers each role through `answer` (a
 * function of the role, throwing to fail), recording every call; `modelEndpoints` returns `listing`. */
type ProbeLlm = ReturnType<typeof fakeProbeLlm> & Record<string, Untyped>;

function fakeProbeLlm(
  answer: Untyped,
  listing = {
    ok: true,
    status: 200,
    json: { data: { architecture: { output_modalities: ['image'] }, endpoints: [{}, {}] } },
  }
) {
  const calls: Array<Untyped> = [];
  const listings: Array<Untyped> = [];
  return {
    calls,
    listings,
    async complete(messages: Untyped, options: Untyped) {
      calls.push({ messages, options });
      return answer(options.role);
    },
    async modelEndpoints(model: string, options: Untyped) {
      listings.push({ model, options });
      return listing;
    },
  };
}

/** The probe tests' config: a model per role (the drawing model included), the probe timeout and label. */
function probeConfig(hot: Untyped) {
  // Changed: each role runs on its chain (slice 4); speech, which the old config left on its default, gets one too.
  hot.config.models = {
    routes: chainsOf({
      core: 'anthropic/claude-opus-4.6',
      analyzer: 'x/text',
      vision: 'x/media',
      video: 'x/video',
      embedding: 'x/embed',
      speech: ROLE_DEFAULTS.speech,
      drawing: 'openai/gpt-image-1',
    }),
  };
  hot.config.llm.probeTimeoutMs = 1234;
  hot.prompts.labels.status = { probe: 'Answer with one word: Ωmega' };
}

/** The models field's lines. */
const roleLinesOf = (value: Untyped) => value.split('\n');

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test('status: the card lists one item per line in every field, the models one line per role with no heading', async () => {
  const rootDir = makeRoot();
  const journal = { dayFile: () => path.join(rootDir, 'none.jsonl'), stalled: () => false };
  const archive = { stats: () => ({ pending: 2 }) };
  const emojiBackfill = { isRunning: () => true };
  const gifBackfill = { isRunning: () => true };
  const llm: ProbeLlm = fakeProbeLlm(() => ({ provider: 'Prov', usage: { prompt_tokens: 9, completion_tokens: 1 } }));
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

  const { fields } = await admin.run('status.show', {}, { accountId: '42' });
  const lines = (name: string) => fields.find((f: Field) => f.name === name).value.split('\n');
  assert.deepEqual(
    fields.map((f: Field) => f.name),
    [
      'state',
      'tasks',
      'models.base',
      'keys.base',
      'costs.base',
      'models.errands',
      'costs.errands',
      // Changed: the development fields are gone with the development agents (maintainer, 2026-11-16).
      'inner',
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
    lines('limits').map((line: string) => line.replace(/^requests \d+/, 'requests N')),
    // PR 7d: the daily caps are gone, so the request rail is the one limit left; the inner life is code (`inner`).
    ['requests N/300', 'resets 00:00 UTC']
  );
  const head = (line: string) => line.split(' · ').slice(0, 2).join(' · ');
  for (const name of ['models.base', 'models.errands']) {
    assert.ok(!lines(name).some((line: string) => line.startsWith('**')), `${name}: no bold heading`);
    assert.ok(!lines(name).some((line: string) => line.startsWith(' ')), `${name}: no detail line under a role`);
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
  // Changed: an agent's line is its route, harness and model, and these rigs give no agent a route (owner, 2026-11-17).
  // Changed: the agents are read from disk: `code`, `scout` and `server`.
  assert.deepEqual(lines('models.errands').map(head), [
    'code · no model configured',
    'scout · no model configured',
    'server · no model configured',
  ]);
  for (const field of fields) assert.ok(field.value.length > 0 && field.value.length <= 1024, field.name);
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
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
  hot.config.web = { quickSearch: { enabled: true } };
  const searchLine = async () => {
    const { fields } = await admin.run('status.show', { field: 'limits' }, { accountId: '42' });
    return fields[0].value.split('\n').filter((line: string) => line.startsWith('search'));
  };
  assert.deepEqual(await searchLine(), ['search: exa']);
  lookup.engine = 'openrouter';
  assert.deepEqual(await searchLine(), ['search: openrouter']);
  lookup.engine = 'brave';
  lookup.ready = false;
  assert.deepEqual(await searchLine(), ['search: off'], 'the chosen engine cannot run (no Brave key)');
  lookup.ready = true;
  hot.config.web.quickSearch.enabled = false;
  assert.deepEqual(await searchLine(), ['search: off']);
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
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
  const llm: ProbeLlm = fakeProbeLlm((role: string) => {
    if (role === 'vision') throw Object.assign(new Error('HTTP 503: upstream down'), { body: funnel });
    return { provider: 'Prov', usage: { prompt_tokens: 9, completion_tokens: 1 } };
  });
  const { admin, hot } = makeAdmin(rootDir, { images: fakeImages({ quota: { used: 2, cap: 5 } }), llm });
  probeConfig(hot);
  const modelOf = { core: 'anthropic/claude-opus-4.6', analyzer: 'x/text', vision: 'x/media', video: 'x/video' };

  const { result, logs } = await withCapturedLogs(() => admin.run('status.show', {}, { accountId: '42' }));
  const lines = roleLinesOf(result.fields.find((f: Field) => f.name === 'models.base').value);
  const errands = roleLinesOf(result.fields.find((f: Field) => f.name === 'models.errands').value);

  assert.deepEqual(
    llm.calls.map((call) => call.options.role).sort(),
    Object.keys(modelOf).sort(),
    'one probe per role model'
  );
  for (const { messages, options } of llm.calls) {
    assert.deepEqual(messages, [{ role: 'user', content: 'Answer with one word: Ωmega' }]);
    assert.equal(options.model, modelOf[options.role as keyof typeof modelOf]);
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
    // Changed: an agent's line is its route, and this rig gives no agent a route (owner, 2026-11-17).
    // Changed: the agents are read from disk: `code`, `scout` and `server`.
    ['code · no model configured', 'scout · no model configured', 'server · no model configured'],
    'just role and model'
  );
  assert.match(lines.at(-1), /^drawing · openai\/gpt-image-1 · listed, image output, 2 endpoint\(s\), \d+ ms$/);
  assert.ok(
    !llm.calls.some((call) => ['scout', 'server'].includes(call.options.role)),
    'no request goes out on an OpenCode role'
  );

  const probed = logs.filter((entry) => entry.msg === 'status: probed');
  assert.equal(probed.length, 1);
  assert.equal(probed[0].ok, 3);
  assert.equal(probed[0].failed, 1);
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test('status: the member card shows the models one line per role without probing', async () => {
  const rootDir = makeRoot();
  const llm: ProbeLlm = fakeProbeLlm(() => ({ provider: 'Prov' }));
  const { admin, hot } = makeAdmin(rootDir, { images: fakeImages({ quota: { used: 2, cap: 5 } }), llm });
  probeConfig(hot);
  hot.config.bot.access = { 'status.show': { everyone: true, roles: [], users: [] } };

  const { fields } = await admin.run('status.show', {}, { accountId: '999' });
  const valueOf = (name: string) => fields.find((f: Field) => f.name === name).value;
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
    // Changed: an agent's line is its route, and this rig gives no agent a route (owner, 2026-11-17).
    // Changed: the agents are read from disk: `code`, `scout` and `server`.
    ['code · no model configured', 'scout · no model configured', 'server · no model configured'].join('\n')
  );
  assert.equal(llm.calls.length, 0, 'no probe request');
  assert.equal(llm.listings.length, 0, 'no listing request');
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test('status: identical probes are sent once, each role shows its own model, the overrides follow their role, the embedding role gets an embedding probe', async () => {
  const rootDir = makeRoot();
  const llm: ProbeLlm = fakeProbeLlm(() => ({ provider: 'Prov', usage: { prompt_tokens: 9, completion_tokens: 1 } }));
  const embedCalls: Array<Untyped> = [];
  const embedder = {
    async embed(texts: Untyped, options: Untyped) {
      embedCalls.push({ texts, options });
      return [new Float32Array(8)];
    },
  };
  const { admin, hot } = makeAdmin(rootDir, { images: fakeImages({ quota: { used: 0, cap: 5 } }), llm, embedder });
  probeConfig(hot);
  Object.assign(hot.config.models.routes, chainsOf({ video: 'x/media' }));
  hot.config.models.byPurpose = { lookup: 'x/pinned', describe: 'x/seen' };
  // A role-specific route keeps the video role's probe apart although its model is the vision one.
  hot.config.llm.providerByModel = { 'x/@video': { only: ['video-host'] } };

  const { result, logs } = await withCapturedLogs(() => admin.run('status.show', {}, { accountId: '42' }));
  const lines = roleLinesOf(result.fields.find((f: Field) => f.name === 'models.base').value);

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
  assert.equal(logs.find((entry) => entry.msg === 'status: probed')?.requests, 5);
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test('status: without an embedding client the embedding role is shown unchecked; an embedding failure shows its reason', async () => {
  const rootDir = makeRoot();
  const llm: ProbeLlm = fakeProbeLlm(() => ({ provider: 'Prov' }));
  const none = makeAdmin(rootDir, { llm });
  probeConfig(none.hot);
  const unchecked = await none.admin.run('status.show', {}, { accountId: '42' });
  assert.ok(
    unchecked.fields
      .find((f: Field) => f.name === 'models.base')
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
  const { result } = await withCapturedLogs(() => failing.admin.run('status.show', {}, { accountId: '42' }));
  assert.ok(
    result.fields
      .find((f: Field) => f.name === 'models.base')
      .value.split('\n')
      .includes('embedding · x/embed · failed: HTTP 404: no such model')
  );
});

// ---------------------------------------------------------------------------
// pause / resume
// ---------------------------------------------------------------------------

test('run: pause sets paused/pausedAt first, flushes, and drops caches', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);

  const result = await admin.run('bot.pause', {}, {});

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

  await admin.run('bot.pause', {}, {});
  const pausedAt = store.state.data.pausedAt;
  const dropsAfterFirst = store.dropCachesCalls;

  const result = await admin.run('bot.pause', {}, {});

  assert.equal(store.state.data.pausedAt, pausedAt, 'pausedAt is not bumped by a repeat pause');
  assert.equal(store.dropCachesCalls, dropsAfterFirst, 'nothing is dropped again');
  assert.match(result, /already paused/i);
});

test('run: pause waits for a turn already in flight before dropping caches', async () => {
  const rootDir = makeRoot();
  let resolveIdle: () => void = () => {};
  const idlePromise = new Promise<void>((resolve) => {
    resolveIdle = resolve;
  });
  const turns = { waitIdle: () => idlePromise };
  const { admin, store } = makeAdmin(rootDir, { turns });

  const pausePromise = admin.run('bot.pause', {}, {});
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.dropCachesCalls, 0, 'must not drop caches before the in-flight turn finished');

  resolveIdle();
  await pausePromise;
  assert.equal(store.dropCachesCalls, 1);
});

test('/nep pause: no timer-driven writer (store.flush) writes memory while paused', async () => {
  const mem = await openTestMemory();
  try {
    const writes: Array<Untyped> = [];
    const memoryDb = {
      ...mem.memoryDb,
      writeUnit: (update: Untyped) => {
        writes.push(update.owner);
        return writeUnitUpdate(mem.memoryDb, update);
      },
      // A place's notes have their own write kind (src/memory/db/place-notes.ts), so the store's flush reaches it there.
      writePlaceNotes: (notes: Untyped) => {
        writes.push(notes.placeId);
        return mem.memoryDb.writePlaceNotes(notes);
      },
    };
    const realStore = createStore({ dataDir: mem.dataDir, memoryDb });
    const placeId = 'g1';
    realStore.touchUser(accountOf(realStore, 'u1'), 'Alice', 1000);
    realStore.updatePlace(placeOfRoot(realStore, placeId), { patterns: 'x' });
    realStore.flush();
    await realStore.flushSettled({});
    const before = writes.length;
    assert.ok(before > 0, 'the writes before the pause reached the database');

    realStore.state.data.paused = true;

    // Mirrors index.js's periodic store timer firing once.
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
  await admin.run('bot.pause', {}, {});
  store.validateResult = ['guilds/g1/users/u1.json'];

  const result = await admin.run('bot.resume', {}, {});

  assert.match(result, /invalid json/i);
  assert.ok(result.includes('guilds/g1/users/u1.json'));
  assert.equal(store.state.data.paused, true, 'stays paused');
});

test('run: resume clears the flags and reports plain confirmation', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  await admin.run('bot.pause', {}, {});

  const result = await admin.run('bot.resume', {}, {});

  assert.equal(store.state.data.paused, undefined);
  assert.equal(store.state.data.pausedAt, undefined);
  assert.equal(store.reloadStateCalls, 1);
  assert.equal(result, 'Resumed.');
});

test('run: resume starts a catch-up pass of the meaning index for the guild; pause and a refused resume do not', async () => {
  const rootDir = makeRoot();
  const passes: Array<Untyped> = [];
  const embedQueue = {
    catchUp: async (placeId: string) => {
      passes.push(placeId);
      return null;
    },
  };
  const { admin, store } = makeAdmin(rootDir, { embedQueue });
  await admin.run('bot.pause', {}, { placeId: 'g1' });
  store.validateResult = ['guilds/g1/users/u1.json'];
  await admin.run('bot.resume', {}, { placeId: 'g1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(passes, [], 'still paused: no pass');
  store.validateResult = [];
  assert.equal(await admin.run('bot.resume', {}, { placeId: 'g1' }), 'Resumed.');
  await new Promise((resolve) => setImmediate(resolve));
  // The pass names no place: every place that holds a record.
  assert.deepEqual(passes, [undefined]);
});

test('run: every command that writes data/ is refused while paused, with a hint to resume', async () => {
  const rootDir = makeRoot();
  const client = clientWithGuild('g1', 'The Server');
  const { admin, store } = makeAdmin(rootDir, { client });
  store.profiles.set('123', { id: '123', character: 'chatty' });
  store.setLore('g1', [{ title: 'X', keys: ['xx'], text: 'y' }], { source: 'owner', now: 1 });
  const [{ id: loreId }] = store.getLore('g1');

  await admin.run('bot.pause', {}, {});

  const attempts: Array<[string, Record<string, unknown>]> = [
    ['lore.add', { title: 'Y', keys: 'y', text: 'z' }],
    ['lore.remove', { id: loreId }],
    ['message.create', {}],
  ];
  for (const [key, args] of attempts) {
    await assert.rejects(
      () => admin.run(key, args, { placeId: 'c1' }),
      /paused.*resume/i,
      `${key} must be refused while paused`
    );
  }
});

test('run: read-only and config commands keep working while paused', async () => {
  const rootDir = makeRoot();
  const client = clientWithGuild('g1', 'The Server');
  const { admin, store } = makeAdmin(rootDir, { client });
  store.profiles.set('123', { id: '123', character: 'chatty' });
  store.setLore('g1', [{ title: 'X', keys: ['xx'], text: 'y' }], { source: 'owner', now: 1 });

  await admin.run('bot.pause', {}, {});

  await assert.doesNotReject(() => admin.run('status.show', {}, {}));
  await assert.doesNotReject(() => admin.run('memory.profile.read', { accountId: '123' }, { placeId: 'g1' }));
  await assert.doesNotReject(() => admin.run('lore.list', {}, { placeId: 'g1' }));
  await assert.doesNotReject(() => admin.run('model.show', {}, {}));
  await assert.doesNotReject(() => admin.run('rule.list', {}, {}));
  // Changed: `models.base` is retired (spec 2026-11-09-model-routes, slice 4); `llm.maxRequestsPerDay` is the leaf here.
  await assert.doesNotReject(() => admin.run('config.set', { path: 'llm.maxRequestsPerDay', value: '250' }, {}));
  await assert.doesNotReject(() => admin.run('config.unset', { path: 'llm.maxRequestsPerDay' }, {}));
  await assert.doesNotReject(() => admin.run('model.set', { role: 'core', id: 'x/y' }, {}));
});

test('run: memory.show/lore.list/lore.show drop caches first while paused, so a hand-edit is always seen', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('123', { id: '123', character: 'chatty' });
  store.setLore('g1', [{ title: 'X', keys: ['xx'], text: 'y' }], { source: 'owner', now: 1 });
  const [{ id: loreId }] = store.getLore('g1');

  await admin.run('bot.pause', {}, {});
  const dropsAfterPause = store.dropCachesCalls;

  await admin.run('memory.profile.read', { accountId: '123' }, { placeId: 'g1' });
  assert.equal(store.dropCachesCalls, dropsAfterPause + 1);

  await admin.run('lore.list', {}, { placeId: 'g1' });
  assert.equal(store.dropCachesCalls, dropsAfterPause + 2);

  await admin.run('lore.show', { id: loreId }, { placeId: 'g1' });
  assert.equal(store.dropCachesCalls, dropsAfterPause + 3);
});

// ---------------------------------------------------------------------------
// draw / the image lines of status and model.show (src/llm/images.ts)
// ---------------------------------------------------------------------------

/** A fake image client: records every generate() call, answers with `picture` or throws `error`. */
function fakeImages({ picture, error, quota }: { picture?: Untyped; error?: Error; quota?: Untyped } = {}) {
  const calls: Array<Untyped> = [];
  return {
    calls,
    familyOf,
    async generate(args: Untyped) {
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
function fakeImageFetcher(result: { dataUrl: string } | null = { dataUrl: 'data:image/png;base64,QUFB' }) {
  const calls: Array<Untyped> = [];
  return {
    calls,
    async fetchAsDataUrl(url: string, opts: Untyped) {
      calls.push({ url, opts });
      return result;
    },
  };
}

function hotForDraw(rootDir: string, { model = 'openai/image-model', ...image }: Record<string, unknown> = {}) {
  const hot = makeHot(rootDir);
  // Changed: the drawing model is its chain's (spec 2026-11-09-model-routes, slice 4).
  hot.config.models = {
    ...hot.config.models,
    routes: { ...hot.config.models?.routes, ...chainsOf({ drawing: model }) },
  };
  hot.config.image = { referenceMaxBytes: 4000000, ...image };
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

  const result = await admin.run('draw.create', { text: 'a lighthouse at dusk', self: false }, { placeId: 'g1' });

  assert.equal(images.calls.length, 1);
  assert.deepEqual(images.calls[0], {
    prompt: buildDrawPrompt({
      prompts: hot.prompts,
      selfName: 'Persona',
      request: 'a lighthouse at dusk',
      self: false,
    }),
    reference: null,
    accountId: null,
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

// The owner on 2026-11-16: the drawing scene is kept whole; the limit of 1600 is gone.
test('run: draw builds the prompt from the whole request', async () => {
  const rootDir = makeRoot();
  const hot = hotForDraw(rootDir);
  const images = fakeImages();
  const { admin } = makeAdmin(rootDir, { hot, images, client: drawClient() });
  const text = 'άλφαβήτα '.repeat(300).trim();

  await admin.run('draw.create', { text, self: false }, { placeId: 'g1' });

  assert.equal(
    images.calls[0].prompt,
    buildDrawPrompt({ prompts: hot.prompts, selfName: 'Persona', request: text, self: false })
  );
});

// The owner on 2026-11-17: a picture of herself is drawn with `appearance.png` of the data folder as its reference; the
// avatar is no longer fetched for drawing. The bytes are the test's own.
test('run: draw with self adds the appearance and sends appearance.png of the data folder as the reference', async () => {
  const rootDir = makeRoot();
  const dataDir = path.join(rootDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'appearance.png'), Buffer.from('LOOK-PNG-BYTES'));
  const hot = hotForDraw(rootDir);
  const images = fakeImages();
  const imageFetcher = fakeImageFetcher();
  const client = drawClient();
  const { admin } = makeAdmin(rootDir, { hot, images, imageFetcher, client });

  await admin.run('draw.create', { text: 'at the beach', self: true }, { placeId: 'g1' });

  assert.equal(imageFetcher.calls.length, 0, 'no avatar fetched for drawing');
  const [sent] = images.calls;
  assert.equal(sent.reference, `data:image/png;base64,${Buffer.from('LOOK-PNG-BYTES').toString('base64')}`);
  assert.equal(images.calls[0].accountId, null);
  assert.equal(
    images.calls[0].prompt,
    buildDrawPrompt({ prompts: hot.prompts, selfName: 'Persona', request: 'at the beach', self: true })
  );
  assert.ok(images.calls[0].prompt.includes('Persona has silver hair.'));
});

// The owner on 2026-11-17: `image.reference` is removed, so its test of `none` is deleted; the avatar is no longer
// fetched for drawing, so a picture of herself with no `appearance.png` goes without a reference and no avatar note.
test('run: draw with self and no appearance.png generates with no reference', async () => {
  const rootDir = makeRoot();
  const hot = hotForDraw(rootDir);
  const images = fakeImages();
  const imageFetcher = fakeImageFetcher();
  const { admin } = makeAdmin(rootDir, { hot, images, imageFetcher, client: drawClient() });

  await admin.run('draw.create', { text: 'at the beach', self: true }, { placeId: 'g1' });

  assert.equal(images.calls.length, 1);
  const [sent] = images.calls;
  assert.equal(sent.reference, null);
  assert.equal(imageFetcher.calls.length, 0, 'no avatar fetched for drawing');
});

test('run: draw with an unsupported image model is a not-configured refusal with the reason, and never generates', async () => {
  const rootDir = makeRoot();
  const hot = hotForDraw(rootDir, { model: 'someone/else-model' });
  const images = fakeImages();
  const { admin } = makeAdmin(rootDir, { hot, images, client: drawClient() });

  await assert.rejects(
    () => admin.run('draw.create', { text: 'a cat' }, { placeId: 'g1' }),
    (err: Error & { code?: string }) =>
      err.code === 'not-configured' && /someone\/else-model/.test(err.message) && /unsupported/.test(err.message)
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
    () => admin.run('draw.create', { text: 'a cat' }, { placeId: 'g1' }),
    (err: Error) => /moderation/.test(err.message) && /400/.test(err.message) && !err.message.includes('provider text')
  );
});

test('run: draw is refused while paused', async () => {
  const rootDir = makeRoot();
  const images = fakeImages();
  const { admin } = makeAdmin(rootDir, { hot: hotForDraw(rootDir), images, client: drawClient() });

  await admin.run('bot.pause', {}, {});
  await assert.rejects(() => admin.run('draw.create', { text: 'a cat' }, { placeId: 'g1' }), /paused/);
  assert.equal(images.calls.length, 0);
});

// ---------------------------------------------------------------------------
// memory.recent
// ---------------------------------------------------------------------------

const RECENT_NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const HOUR = 3600 * 1000;

function recentLine(id: number, hoursAgo: number, text: string, extra: Record<string, unknown> = {}) {
  return { id, at: RECENT_NOW - hoursAgo * HOUR, addedAt: null, placeId: 'c1', text, who: [], weight: 2, ...extra };
}

function makeRecentAdmin(t: TestContext, lines: Array<Untyped>, config: Record<string, unknown> = {}) {
  t.mock.method(Date, 'now', () => RECENT_NOW);
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
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

  const rows = (await admin.run('memory.recent.read', {}, { placeId: 'g1' })).split('\n');

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
  store.profiles.set(`${otherId}`, { id: otherId, names: ['Zoe'] });
  store.channels.set('g1:c1', { id: 'c1', name: 'general' });

  const text = await admin.run('memory.recent.read', {}, { placeId: 'g1' });

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

  const text = await admin.run('memory.recent.read', {}, { placeId: 'g1' });

  assert.ok(text.includes('2026-10-06 01:30'), text);
});

test('run: memory.recent answers one short line with no live line', async (t) => {
  const none = makeRecentAdmin(t, [recentLine(1, 100, 'expired line')]);
  const noneText = await none.admin.run('memory.recent.read', {}, { placeId: 'g1' });
  assert.ok(!noneText.includes('\n'));
  assert.ok(!noneText.includes('expired line'));
});

// The owner's decision of 2026-11-10 cut the grants to a role, and with them this test's check of one.
test('run: memory.recent works while paused and writes nothing', async (t) => {
  const { admin, store } = makeRecentAdmin(t, [recentLine(1, 1, 'a line')]);
  store.state.data.paused = true;

  const text = await admin.run('memory.recent.read', {}, { placeId: 'g1' });

  assert.ok(text.includes('a line'));
  assert.equal(store.flushCalls, 0);
});

// ---------------------------------------------------------------------------
// memory.archive / memory.restore
// ---------------------------------------------------------------------------

// The real store hands its records back as plain objects; these read their fields through Untyped.
const userOf = (store: { getUser: (accountId: string) => object | null }, accountId: string): Untyped =>
  store.getUser(accountOf(store, accountId));

test('admin: memory restore re-inserts an episode and writes a restored event, idempotent', async () => {
  const rootDir = makeRoot();
  const mem = await openTestMemory();
  const dataDir = mem.dataDir;
  const log = { info() {}, warn() {}, error() {} };
  const appendStore = createAppendStore({ fsyncMs: 0, log });
  const archive = createArchive({
    appendStore,
    dataDir,
    log,
    memoryDb: mem.memoryDb,
  });
  const store = createStore({ dataDir, archive, memoryDb: mem.memoryDb });
  const { admin } = makeAdmin(rootDir, { store, archive });
  try {
    const now = Date.UTC(2026, 9, 12);
    store.touchUser(accountOf(store, 'u1'), 'Zoé', now);
    // The engine has no episode writer, so the evicted episode is filed in the archive the way the store files one:
    // a member's public item under the persona, scoped to the member.
    const old = {
      itemId: 'ep-old-chess',
      date: '2026-10-01',
      what: 'Έχασε στο σκάκι',
      quote: 'ξανά',
      weight: 1,
      addedAt: '2026-10-01T10:00:00.000Z',
    };
    await archive.append(null, [
      archiveEntry(old, {
        itemKind: 'episode',
        event: 'evicted',
        scope: { user: accountOf(store, 'u1') },
        now: () => now,
      }),
    ]);

    const listed = await admin.run('memory.archive.read', { accountId: 'u1' }, { placeId: 'g1' });
    assert.match(listed, new RegExp(`evicted\\s+episode\\s+${old.itemId}`));
    assert.match(listed, /Έχασε στο σκάκι/);
    assert.equal(
      await admin.run('memory.archive.read', { kind: 'episode' }, { placeId: 'g1' }),
      '(none)',
      'nothing at the server level'
    );

    const reply = await admin.run('memory.restore', { itemId: old.itemId }, { placeId: 'g1' });
    assert.match(reply, /restored/);
    const episodes = userOf(store, 'u1').episodes;
    const back = episodes.find((ep: Untyped) => ep.itemId === old.itemId);
    assert.ok(back, 'the episode is hot again under its own id');
    assert.deepEqual(
      [back.date, back.what, back.quote, back.weight, back.addedAt],
      [old.date, old.what, old.quote, old.weight, old.addedAt]
    );
    assert.equal(episodes.length, 1, 'the restore adds the one archived episode');
    let lines = await archive.find(old.itemId);
    assert.deepEqual(
      lines.map((entry: Untyped) => [entry.event, entry.by]),
      [
        ['evicted', 'store'],
        ['restored', 'owner'],
      ]
    );

    // Again: the item is hot already, nothing is written.
    const again = await admin.run('memory.restore', { itemId: old.itemId }, { placeId: 'g1' });
    assert.match(again, /already/);
    assert.equal(userOf(store, 'u1').episodes.length, 1);
    lines = await archive.find(old.itemId);
    assert.equal(lines.length, 2);

    await assert.rejects(admin.run('memory.restore', { itemId: 'ep-none' }, { placeId: 'g1' }), /no archived item/);
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
function fakeJournal(days: Record<string, Array<Untyped>> = {}) {
  const calls: Array<Untyped> = [];
  return {
    calls,
    system: async (record: Untyped) => {
      calls.push(['system', record]);
    },
    read: async (placeId: string, { day, kind = null, n = 50 }: { day: string; kind?: string | null; n?: number }) => {
      calls.push(['read', placeId, { day, kind, n }]);
      return (days[day] ?? []).filter((record: Untyped) => !kind || record.kind === kind).slice(-n);
    },
    forgetUser: async (placeId: string, accountId: string) => {
      calls.push(['forgetUser', placeId, accountId]);
      return { files: 2, dropped: 5 };
    },
    removeGuild: async (placeId: string) => {
      calls.push(['removeGuild', placeId]);
      return { files: 3 };
    },
  };
}

/** A client whose channels collect what is sent to them (nothing should be). */
function sendingClient() {
  const sent: Array<Untyped> = [];
  return {
    sent,
    channels: {
      fetch: async (id: string) => ({
        id,
        send: async (message: Untyped) => {
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
  hot.config.journal = {};
  const { admin } = makeAdmin(rootDir, { hot, client, journal });

  const paused = await admin.run('bot.pause', {}, { placeId: 'g1' });
  assert.match(paused, /^Paused./);
  assert.equal(client.sent.length, 0);
  const pauseRecord = journal.calls.find(([name]) => name === 'system');
  // A system record is the persona's: no place in its call.
  assert.deepEqual(pauseRecord, ['system', { event: 'pause', by: 'owner' }]);

  const resumed = await admin.run('bot.resume', {}, { placeId: 'g1' });
  assert.equal(resumed, 'Resumed.');
  assert.equal(client.sent.length, 0);
  const records = journal.calls.filter(([name]) => name === 'system').map(([, record]) => record);
  assert.deepEqual(records, [
    { event: 'pause', by: 'owner' },
    { event: 'resume', by: 'owner' },
  ]);

  // A repeat pause or resume that changes nothing records nothing.
  await admin.run('bot.resume', {}, { placeId: 'g1' });
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

  const all = await admin.run('memory.journal.read', { day, n: 3 }, { placeId: 'g1' });
  const lines = all.split('\n');
  assert.deepEqual(lines.slice(1), [
    '10:00:07 turn reply spoke 2 msgs, think: Η Ελένη ρωτά.',
    '10:05:00 memory batch 6 lines, users 1, episodes 0',
    '11:00:00 system pause owner',
  ]);
  assert.match(lines[0], /2026-10-12/);
  assert.deepEqual(journal.calls.at(-1), ['read', 'g1', { day, kind: null, n: 3 }]);

  const actions = await admin.run('memory.journal.read', { day, kind: 'action' }, { placeId: 'g1' });
  assert.deepEqual(actions.split('\n').slice(1), ['10:00:05 action post started', '10:00:06 action post succeeded']);
  assert.deepEqual(journal.calls.at(-1)[2], { day, kind: 'action', n: 20 });

  // Today (UTC) by default; nothing there is said plainly.
  const today = await admin.run('memory.journal.read', {}, { placeId: 'g1' });
  assert.equal(journal.calls.at(-1)[2].day, new Date(Date.now()).toISOString().slice(0, 10));
  assert.match(today, /no journal records/);

  await assert.rejects(admin.run('memory.journal.read', { day: '12.10.2026' }, { placeId: 'g1' }), /YYYY-MM-DD/);
  await assert.rejects(admin.run('memory.journal.read', { day, n: 51 }, { placeId: 'g1' }), /1\.\.50/);
  await assert.rejects(admin.run('memory.journal.read', { day, kind: 'lore' }, { placeId: 'g1' }), /kind/);
});

// ---------------------------------------------------------------------------
// the journal and the archive read in a turn with no place (a heartbeat)
// ---------------------------------------------------------------------------

const NO_PLACE_DAY = '2026-11-14';
const NO_PLACE_AT = Date.parse(`${NO_PLACE_DAY}T09:00:00.000Z`);

/**
 * An admin over a real memory database, journal and archive, with one community the store knows as a top place
 * (noted the way an interface's hello notes its roots). `place` is that community's id.
 */
async function memoryWithCommunity() {
  const mem = await openTestMemory();
  const log = { info() {}, warn() {}, error() {} };
  const appendStore = createAppendStore({ fsyncMs: 0, log });
  const archive = createArchive({ appendStore, dataDir: mem.dataDir, log, memoryDb: mem.memoryDb });
  const journal = createJournal({ dataDir: mem.dataDir, memoryDb: mem.memoryDb, now: () => NO_PLACE_AT });
  const store = createStore({ dataDir: mem.dataDir, archive, memoryDb: mem.memoryDb });
  store.noteRoots('discord', [{ id: '900000000000000001', name: 'Λιμάνι' }]);
  await new Promise((resolve) => setImmediate(resolve));
  const place = placeOfRoot(store, '900000000000000001', 'discord');
  const { admin } = makeAdmin(makeRoot(), { store, archive, journal });
  const close = async () => {
    await appendStore.close();
    await mem.close();
    fs.rmSync(mem.dataDir, { recursive: true, force: true });
  };
  return { admin, store, archive, journal, place, close };
}

/** One archived detail whose text carries `marker`, filed with `scope`. */
const archivedFact = (marker: string, scope: Record<string, unknown>) =>
  archiveEntry(
    { itemId: `detail-${marker}`, text: `${marker} το είπε στο λιμάνι`, weight: 1 },
    { itemKind: 'detail', event: 'evicted', scope, now: () => NO_PLACE_AT }
  );

test('memory.journal.read in a turn with no place reads the persona journal and no place of hers', async () => {
  // Catches: the read refused with no place resolved yet, or a no-place read that falls into some community's journal.
  const { admin, journal, place, close } = await memoryWithCommunity();
  try {
    await journal.inner(PERSONA_ID, { event: 'wake', reason: 'marker-persona-ilios' });
    await journal.action(place, { name: 'marker-place-thalassa', phase: 'succeeded' });

    const text = await admin.run('memory.journal.read', { day: NO_PLACE_DAY }, { placeId: null });

    assert.deepEqual(
      [text.includes('marker-persona-ilios'), text.includes('marker-place-thalassa')],
      [true, false],
      text
    );
  } finally {
    await close();
  }
});

test('memory.archive.read in a turn with no place lists the persona and community archives, never a private entry', async () => {
  // Catches: the read refused with no place, a community archive left unread, or a private entry of a direct chat shown.
  const { admin, archive, place, close } = await memoryWithCommunity();
  const dm = 'discord:dm:900000000000000077';
  try {
    await archive.append(null, [archivedFact('marker-persona-asteri', {})]);
    await archive.append(place, [archivedFact('marker-community-kyma', {})]);
    await archive.append(dm, [archivedFact('marker-private-mystiko', { place: dm, private: true })]);

    const text = await admin.run('memory.archive.read', {}, { placeId: null });

    assert.deepEqual(
      ['marker-persona-asteri', 'marker-community-kyma', 'marker-private-mystiko'].map((marker) =>
        text.includes(marker)
      ),
      [true, true, false],
      text
    );
  } finally {
    await close();
  }
});

test('memory.archive.read in a turn with no place lists the community entry about the person user names', async () => {
  // Catches: a no-place read that drops the person filter, or skips the community archive when a person is asked for.
  const { admin, archive, store, place, close } = await memoryWithCommunity();
  try {
    const asked = accountOf(store, '900000000000000011');
    const other = accountOf(store, '900000000000000012');
    await archive.append(place, [
      archivedFact('marker-asked-pyrgos', { user: asked }),
      archivedFact('marker-other-vrachos', { user: other }),
    ]);

    const text = await admin.run('memory.archive.read', { accountId: '900000000000000011' }, { placeId: null });

    assert.deepEqual(
      [text.includes('marker-asked-pyrgos'), text.includes('marker-other-vrachos')],
      [true, false],
      text
    );
  } finally {
    await close();
  }
});

test('memory.journal.read in a turn of a place reads that place journal and none of the persona journal', async () => {
  // Catches: a fix that reads the persona journal, alone or beside the place, in a turn that has a place.
  const { admin, journal, place, close } = await memoryWithCommunity();
  try {
    await journal.inner(PERSONA_ID, { event: 'wake', reason: 'marker-persona-ilios' });
    await journal.action(place, { name: 'marker-place-thalassa', phase: 'succeeded' });

    const text = await admin.run('memory.journal.read', { day: NO_PLACE_DAY }, { placeId: place });

    assert.deepEqual(
      [text.includes('marker-persona-ilios'), text.includes('marker-place-thalassa')],
      [false, true],
      text
    );
  } finally {
    await close();
  }
});
