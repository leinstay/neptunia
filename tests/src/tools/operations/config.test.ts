// PR 7b: `admin.run` takes the operation's name (`status.show`, `config.set`, ...); every expectation is as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { localPath } from '../../../fixtures/config-local.ts';
import { makeAdmin, makeHot, makeRoot, readLocal } from '../../../fixtures/admin-rig.ts';

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

// The caller of a typed command is always the owner, so a change of the
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
  // An array setting, for the type check below.
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
