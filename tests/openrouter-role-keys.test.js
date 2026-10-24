// Tests for the per-role OpenRouter key (`llm.keyByRole`): which key a request's role goes out
// on, the guard on the variable name, the one warning per missing name, the status card's
// read of each extra key's record, and the agents key config.json ships. No network: fetchImpl
// is always a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLlm, keyHashOf, ROLE_KEY_FALLBACKS, roleApiKey, roleKeyGroups } from '../src/llm/openrouter.js';
import { createEmbedder } from '../src/llm/embed.js';
import { AGENT_ROLES } from '../src/llm/roles.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function config(keyByRole) {
  return {
    models: { core: 'x/core', helpers: { embedding: 'x/embed' } },
    llm: {
      baseUrl: 'https://openrouter.ai/api/v1',
      temperature: 1,
      maxOutputTokens: 100,
      maxRequestTokens: 1000,
      maxRequestsPerDay: 300,
      timeoutMs: 5000,
      helperTimeoutMs: 5000,
      retries: 0,
      keyByRole,
    },
    embed: { dimensions: 2 },
  };
}

function fakeState() {
  return { data: {}, markDirty() {} };
}

function makeLlm(cfg, env) {
  const sent = [];
  const llm = createLlm({
    apiKey: 'main-key',
    env,
    getConfig: () => cfg,
    calibrator: { ratio: 1, apply: (n) => n, observe() {} },
    state: fakeState(),
    fetchImpl: async (url, init) => {
      sent.push({ url, auth: init.headers.Authorization });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5 }, data: {} }) };
    },
  });
  return { llm, sent };
}

const ask = [{ role: 'user', content: 'hello' }];

test('roleApiKey: a mapped role takes its variable, an unmapped role the main key', () => {
  const cfg = config({ core: 'OPENROUTER_VOICE_KEY_A' });
  const env = { OPENROUTER_VOICE_KEY_A: 'core-key' };
  assert.equal(roleApiKey(cfg, env, 'core', 'main'), 'core-key');
  assert.equal(roleApiKey(cfg, env, 'analyzer', 'main'), 'main');
  assert.equal(roleApiKey(cfg, env, undefined, 'main'), 'main');
  assert.equal(roleApiKey({ llm: {} }, env, 'core', 'main'), 'main', 'no map at all');
});

test('roleApiKey: a name outside OPENROUTER_* or an unset variable falls back to the main key with one warning per name, never the value', async () => {
  const env = { DISCORD_TOKEN: 'discord-secret', OPENROUTER_EMPTY_B: '', 'sk-or-v1-pasted': 'x' };
  const cfg = config({ core: 'DISCORD_TOKEN', analyzer: 'OPENROUTER_UNSET_B', vision: 'OPENROUTER_EMPTY_B', video: 'sk-or-v1-pasted' });
  const { logs } = await withCapturedLogs(() => {
    for (let i = 0; i < 3; i += 1) {
      for (const role of ['core', 'analyzer', 'vision', 'video']) assert.equal(roleApiKey(cfg, env, role, 'main'), 'main', role);
    }
  });
  const warns = logs.filter((entry) => entry.msg === 'llm: role key missing');
  assert.equal(warns.length, 4, 'one per name, however many requests');
  assert.deepEqual(warns.map((entry) => entry.role).sort(), ['analyzer', 'core', 'video', 'vision']);
  assert.equal(warns.find((entry) => entry.role === 'analyzer').name, 'OPENROUTER_UNSET_B');
  assert.equal(warns.find((entry) => entry.role === 'video').name, null, 'a name that is not a variable name is never logged');
  const text = JSON.stringify(logs);
  assert.ok(!text.includes('discord-secret') && !text.includes('sk-or-v1'), 'no value and no pasted key in the log');
});

test('roleApiKey: OPENROUTER_CORE_KEY unset falls back to OPENROUTER_VOICE_KEY (the variable\'s name while the role was voice), one step, never the other way', async () => {
  const cfg = config({ core: 'OPENROUTER_CORE_KEY' });
  assert.deepEqual(ROLE_KEY_FALLBACKS, { OPENROUTER_CORE_KEY: 'OPENROUTER_VOICE_KEY' });
  assert.equal(roleApiKey(cfg, { OPENROUTER_VOICE_KEY: 'old-key' }, 'core', 'main'), 'old-key', 'the old variable serves');
  assert.equal(roleApiKey(cfg, { OPENROUTER_CORE_KEY: 'new-key', OPENROUTER_VOICE_KEY: 'old-key' }, 'core', 'main'), 'new-key', 'the named variable first');
  assert.equal(roleApiKey(cfg, { OPENROUTER_CORE_KEY: ' ', OPENROUTER_VOICE_KEY: 'old-key' }, 'core', 'main'), 'old-key', 'a blank named variable counts as unset');
  assert.equal(roleApiKey(config({ core: 'OPENROUTER_VOICE_KEY' }), { OPENROUTER_CORE_KEY: 'new-key' }, 'core', 'main'), 'main', 'no fallback from the old name to the new one');
  const { logs } = await withCapturedLogs(() => {
    assert.equal(roleApiKey(cfg, {}, 'core', 'main'), 'main', 'both unset: the main key');
  });
  assert.deepEqual(roleKeyGroups(cfg, { OPENROUTER_VOICE_KEY: 'old-key' }, 'main'), [{ roles: ['core'], apiKey: 'old-key' }], 'the status card sees the key the role is on');
  assert.ok(!JSON.stringify(logs).includes('old-key') && !JSON.stringify(logs).includes('new-key'));
});

test('roleKeyGroups: one group per distinct extra key with the roles on it; the main key and unset ones are left out', () => {
  const env = { OPENROUTER_C1: 'one', OPENROUTER_C2: 'two', OPENROUTER_C3: 'main' };
  const cfg = config({ core: 'OPENROUTER_C1', vision: 'OPENROUTER_C2', video: 'OPENROUTER_C1', analyzer: 'OPENROUTER_C3', extractor: 'OPENROUTER_NOPE_C' });
  assert.deepEqual(roleKeyGroups(cfg, env, 'main'), [
    { roles: ['core', 'video'], apiKey: 'one' },
    { roles: ['vision'], apiKey: 'two' },
  ]);
});

test('createLlm: the request goes out on its role key, an unmapped role on the main key; the map is read at request time', async () => {
  const cfg = config({ core: 'OPENROUTER_VOICE_D' });
  const { llm, sent } = makeLlm(cfg, { OPENROUTER_VOICE_D: 'core-key' });
  await llm.complete(ask, { role: 'core' });
  await llm.complete(ask, { role: 'analyzer', model: 'x/a' });
  assert.deepEqual(sent.map((call) => call.auth), ['Bearer core-key', 'Bearer main-key']);
  cfg.llm.keyByRole = {};
  await llm.complete(ask, { role: 'core' });
  assert.equal(sent.at(-1).auth, 'Bearer main-key', 'a hot edit applies to the next request');
});

test('createLlm: roleKeys names the extra keys by role without their values; keyInfo by role reads that key, credits stay on the main key', async () => {
  const cfg = config({ vision: 'OPENROUTER_VISION_E' });
  const { llm, sent } = makeLlm(cfg, { OPENROUTER_VISION_E: 'vision-key' });
  assert.deepEqual(llm.roleKeys(), [{ roles: ['vision'] }]);
  await llm.keyInfo({ timeoutMs: 100, role: 'vision' });
  await llm.keyInfo({ timeoutMs: 100 });
  await llm.credits({ timeoutMs: 100 });
  assert.deepEqual(sent.map((call) => call.auth), ['Bearer vision-key', 'Bearer main-key', 'Bearer main-key']);
});

test('config.json: the errand agents share OPENROUTER_AGENT_KEY, the development agents share OPENROUTER_DEV_KEY: two key lines; an unset one logs once and shows none', async () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  assert.deepEqual(shipped.llm.keyByRole, { web: 'OPENROUTER_AGENT_KEY', server: 'OPENROUTER_AGENT_KEY', drawing: 'OPENROUTER_AGENT_KEY', thinker: 'OPENROUTER_DEV_KEY', dev: 'OPENROUTER_DEV_KEY', writer: 'OPENROUTER_DEV_KEY', memory: 'OPENROUTER_MEMORY_KEY' });
  assert.deepEqual(Object.keys(shipped.llm.keyByRole).sort(), [...AGENT_ROLES, 'memory'].sort(), 'every agent role has its own key, the pictures on the agents key, and her memory session its own');
  const cfg = config(shipped.llm.keyByRole);
  const { llm, sent } = makeLlm(cfg, { OPENROUTER_AGENT_KEY: 'agent-key', OPENROUTER_DEV_KEY: 'dev-key' });
  assert.deepEqual(llm.roleKeys(), [{ roles: ['drawing', 'server', 'web'] }, { roles: ['dev', 'thinker', 'writer'] }], 'the agents key, then the development key');
  await llm.keyInfo({ timeoutMs: 100, role: 'server' });
  await llm.keyInfo({ timeoutMs: 100, role: 'dev' });
  await llm.complete(ask, { role: 'core' });
  assert.deepEqual(sent.map((call) => call.auth), ['Bearer agent-key', 'Bearer dev-key', 'Bearer main-key'], 'each dedicated key is read, the bot\'s requests stay on the main key');
  assert.equal(llm.keyHash({ role: 'web' }), keyHashOf('agent-key'));
  assert.equal(llm.keyHash({ role: 'dev' }), keyHashOf('dev-key'));
  const { result: devOnly } = await withCapturedLogs(() => makeLlm(cfg, { OPENROUTER_DEV_KEY: 'dev-key' }).llm.roleKeys());
  assert.deepEqual(devOnly, [{ roles: ['dev', 'thinker', 'writer'] }], 'an unset OPENROUTER_AGENT_KEY: no agents line');
  const { result: unset } = await withCapturedLogs(() => makeLlm(cfg, {}).llm.roleKeys());
  assert.deepEqual(unset, [], 'neither set: no line, the main key is never shown as theirs');
});

test('config.json: no role is on the simulator key OPENROUTER_SIM_KEY (the advice role is gone); the bot\'s requests stay on the main key', async () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  assert.ok(!Object.values(shipped.llm.keyByRole).includes('OPENROUTER_SIM_KEY'));
  const cfg = config(shipped.llm.keyByRole);
  const { llm, sent } = makeLlm(cfg, { OPENROUTER_AGENT_KEY: 'agent-key', OPENROUTER_DEV_KEY: 'dev-key', OPENROUTER_SIM_KEY: 'sim-key' });
  assert.deepEqual(llm.roleKeys(), [{ roles: ['drawing', 'server', 'web'] }, { roles: ['dev', 'thinker', 'writer'] }], 'a set OPENROUTER_SIM_KEY adds no role line');
  await llm.complete(ask, { role: 'core' });
  assert.deepEqual(sent.map((call) => call.auth), ['Bearer main-key']);
});

test('createEmbedder: an embedding request honours the role map', async () => {
  const sent = [];
  const embedder = createEmbedder({
    apiKey: 'main-key',
    env: { OPENROUTER_EMBED_F: 'embed-key' },
    state: fakeState(),
    now: () => Date.UTC(2026, 9, 15, 12),
    fetchImpl: async (url, init) => {
      sent.push(init.headers.Authorization);
      return { ok: true, status: 200, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }], usage: {} }) };
    },
  });
  await embedder.embed(['a'], { config: config({ embedding: 'OPENROUTER_EMBED_F' }) });
  await embedder.embed(['a'], { config: config({ core: 'OPENROUTER_EMBED_F' }) });
  assert.deepEqual(sent, ['Bearer embed-key', 'Bearer main-key']);
});
