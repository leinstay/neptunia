// Tests for the per-role OpenRouter key (`llm.keyByRole`): which key a request's role goes out
// on, the guard on the variable name, the one warning per missing name, the status card's
// read of each extra key's record, and the agents key config.json ships. No network: fetchImpl
// is always a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLlm, keyHashOf, roleApiKey, roleKeyGroups, roleKeyNames } from '../src/llm/openrouter.ts';
import { createEmbedder } from '../src/llm/embed.ts';
import { OPENCODE_ROLES } from '../src/llm/roles.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function config(keyByRole: Record<string, string | Array<string>>) {
  return {
    models: { base: { core: 'x/core', embedding: 'x/embed' } },
    llm: {
      baseUrl: 'https://openrouter.ai/api/v1',
      temperature: 1,
      maxOutputTokens: 100,
      maxRequestTokens: 1000,
      maxRequestsPerDay: 300,
      timeoutMs: 5000,
      analyzerTimeoutMs: 5000,
      retries: 0,
      keyByRole,
    },
    embed: { dimensions: 2 },
  };
}

function fakeState() {
  return { data: {}, markDirty() {} };
}

// The fakes answer the few members of a Response the clients read (ok, status, json).
const asFetch = (fake: (url: unknown, init: { headers: Record<string, string> }) => Promise<object>) =>
  fake as unknown as typeof fetch;

function makeLlm(cfg: ReturnType<typeof config>, env: Record<string, string>) {
  const sent: Array<{ url: unknown; auth: string }> = [];
  const llm = createLlm({
    apiKey: 'main-key',
    env,
    getConfig: () => cfg,
    // @ts-expect-error the calibrator of this test also carries a ratio
    calibrator: { ratio: 1, apply: (n: number) => n, observe() {} },
    state: fakeState(),
    fetchImpl: asFetch(async (url, init) => {
      sent.push({ url, auth: init.headers.Authorization });
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5 }, data: {} }),
      };
    }),
  });
  return { llm, sent };
}

const ask = [{ role: 'user', content: 'hello' }];

test('roleApiKey: a mapped role takes its variable, an unmapped role the main key', () => {
  const cfg = config({ core: 'OPENROUTER_CORE_KEY_A' });
  const env = { OPENROUTER_CORE_KEY_A: 'core-key' };
  assert.equal(roleApiKey(cfg, env, 'core', 'main'), 'core-key');
  assert.equal(roleApiKey(cfg, env, 'analyzer', 'main'), 'main');
  assert.equal(roleApiKey(cfg, env, undefined, 'main'), 'main');
  assert.equal(roleApiKey({ llm: {} }, env, 'core', 'main'), 'main', 'no map at all');
});

test('roleApiKey: a name outside OPENROUTER_* or an unset variable falls back to the main key with one warning per name, never the value', async () => {
  const env = { DISCORD_TOKEN: 'discord-secret', OPENROUTER_EMPTY_B: '', 'sk-or-v1-pasted': 'x' };
  const cfg = config({
    core: 'DISCORD_TOKEN',
    analyzer: 'OPENROUTER_UNSET_B',
    vision: 'OPENROUTER_EMPTY_B',
    video: 'sk-or-v1-pasted',
  });
  const { logs } = await withCapturedLogs(() => {
    for (let i = 0; i < 3; i += 1) {
      for (const role of ['core', 'analyzer', 'vision', 'video'])
        assert.equal(roleApiKey(cfg, env, role, 'main'), 'main', role);
    }
  });
  const warns = logs.filter((entry) => entry.msg === 'llm: role key missing');
  assert.equal(warns.length, 4, 'one per name, however many requests');
  assert.deepEqual(warns.map((entry) => entry.role).sort(), ['analyzer', 'core', 'video', 'vision']);
  assert.equal(warns.find((entry) => entry.role === 'analyzer')!.name, 'OPENROUTER_UNSET_B');
  assert.equal(
    warns.find((entry) => entry.role === 'video')!.name,
    null,
    'a name that is not a variable name is never logged'
  );
  const text = JSON.stringify(logs);
  assert.ok(!text.includes('discord-secret') && !text.includes('sk-or-v1'), 'no value and no pasted key in the log');
});

test('roleKeyGroups: one group per distinct extra key with the roles on it; the main key and unset ones are left out', () => {
  const env = { OPENROUTER_C1: 'one', OPENROUTER_C2: 'two', OPENROUTER_C3: 'main' };
  const cfg = config({
    core: 'OPENROUTER_C1',
    vision: 'OPENROUTER_C2',
    video: 'OPENROUTER_C1',
    analyzer: 'OPENROUTER_C3',
    embedding: 'OPENROUTER_NOPE_C',
  });
  assert.deepEqual(roleKeyGroups(cfg, env, 'main'), [
    { roles: ['core', 'video'], apiKey: 'one' },
    { roles: ['vision'], apiKey: 'two' },
  ]);
});

test('createLlm: the request goes out on its role key, an unmapped role on the main key; the map is read at request time', async () => {
  const cfg = config({ core: 'OPENROUTER_CORE_D' });
  const { llm, sent } = makeLlm(cfg, { OPENROUTER_CORE_D: 'core-key' });
  await llm.complete(ask, { role: 'core' });
  await llm.complete(ask, { role: 'analyzer', model: 'x/a' });
  assert.deepEqual(
    sent.map((call) => call.auth),
    ['Bearer core-key', 'Bearer main-key']
  );
  cfg.llm.keyByRole = {};
  await llm.complete(ask, { role: 'core' });
  assert.equal(sent.at(-1)!.auth, 'Bearer main-key', 'a hot edit applies to the next request');
});

test('createLlm: roleKeys names the extra keys by role without their values; keyInfo by role reads that key, credits stay on the main key', async () => {
  const cfg = config({ vision: 'OPENROUTER_VISION_E' });
  const { llm, sent } = makeLlm(cfg, { OPENROUTER_VISION_E: 'vision-key' });
  assert.deepEqual(llm.roleKeys(), [{ roles: ['vision'] }]);
  await llm.keyInfo({ timeoutMs: 100, role: 'vision' });
  await llm.keyInfo({ timeoutMs: 100 });
  await llm.credits({ timeoutMs: 100 });
  assert.deepEqual(
    sent.map((call) => call.auth),
    ['Bearer vision-key', 'Bearer main-key', 'Bearer main-key']
  );
});

test('config.json: the development agents share OPENROUTER_DEV_KEY and her memory session has its own key; the errand roles are unmapped', async () => {
  // Stage AB: scout, server and drawing leave the shipped map; they get a key from a keys.json binding only.
  // PR 7c: the shipped settings live in config/config.json.
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8')) as {
    llm: { keyByRole: Record<string, string> };
  };
  assert.deepEqual(shipped.llm.keyByRole, {
    thinker: 'OPENROUTER_DEV_KEY',
    dev: 'OPENROUTER_DEV_KEY',
    memory: 'OPENROUTER_MEMORY_KEY',
  });
  assert.deepEqual(
    Object.keys(shipped.llm.keyByRole).sort(),
    [...OPENCODE_ROLES.filter((role) => role !== 'scout' && role !== 'server'), 'memory'].sort(),
    'the development roles have a key, and her memory session its own'
  );
  const cfg = config(shipped.llm.keyByRole);
  const { llm, sent } = makeLlm(cfg, { OPENROUTER_ERRAND_KEY: 'agent-key', OPENROUTER_DEV_KEY: 'dev-key' });
  assert.deepEqual(
    llm.roleKeys(),
    [{ roles: ['dev', 'thinker'] }],
    'only the development key; a set errand variable is unread'
  );
  await llm.keyInfo({ timeoutMs: 100, role: 'server' });
  await llm.keyInfo({ timeoutMs: 100, role: 'dev' });
  await llm.complete(ask, { role: 'core' });
  assert.deepEqual(
    sent.map((call) => call.auth),
    ['Bearer main-key', 'Bearer dev-key', 'Bearer main-key'],
    "each dedicated key is read, the bot's requests stay on the main key"
  );
  assert.equal(llm.keyHash({ role: 'scout' }), keyHashOf('main-key'));
  assert.equal(llm.keyHash({ role: 'dev' }), keyHashOf('dev-key'));
  const { result: devOnly } = await withCapturedLogs(() =>
    makeLlm(cfg, { OPENROUTER_DEV_KEY: 'dev-key' }).llm.roleKeys()
  );
  assert.deepEqual(devOnly, [{ roles: ['dev', 'thinker'] }], 'the development key alone');
  const { result: unset } = await withCapturedLogs(() => makeLlm(cfg, {}).llm.roleKeys());
  assert.deepEqual(unset, [], 'neither set: no line, the main key is never shown as theirs');
});

test("config.json: no role is on the simulator key OPENROUTER_SIM_KEY (the advice role is gone); the bot's requests stay on the main key", async () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8')) as {
    llm: { keyByRole: Record<string, string> };
  };
  assert.ok(!Object.values(shipped.llm.keyByRole).includes('OPENROUTER_SIM_KEY'));
  const cfg = config(shipped.llm.keyByRole);
  const { llm, sent } = makeLlm(cfg, {
    OPENROUTER_ERRAND_KEY: 'agent-key',
    OPENROUTER_DEV_KEY: 'dev-key',
    OPENROUTER_SIM_KEY: 'sim-key',
  });
  assert.deepEqual(llm.roleKeys(), [{ roles: ['dev', 'thinker'] }], 'a set OPENROUTER_SIM_KEY adds no role line');
  await llm.complete(ask, { role: 'core' });
  assert.deepEqual(
    sent.map((call) => call.auth),
    ['Bearer main-key']
  );
});

test('createEmbedder: an embedding request honours the role map', async () => {
  const sent: Array<string> = [];
  const embedder = createEmbedder({
    apiKey: 'main-key',
    env: { OPENROUTER_EMBED_F: 'embed-key' },
    state: fakeState(),
    now: () => Date.UTC(2026, 9, 15, 12),
    fetchImpl: asFetch(async (url, init) => {
      sent.push(init.headers.Authorization);
      return { ok: true, status: 200, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }], usage: {} }) };
    }),
  });
  await embedder.embed(['a'], { config: config({ embedding: 'OPENROUTER_EMBED_F' }) });
  await embedder.embed(['a'], { config: config({ core: 'OPENROUTER_EMBED_F' }) });
  assert.deepEqual(sent, ['Bearer embed-key', 'Bearer main-key']);
});

// ---- Key lists and the failover to a backup key (plan 0.5) ----

const CORE = 'OPENROUTER_CORE_KEY';
const BACKUP = 'OPENROUTER_CORE_BACKUP_KEY';
const BOTH = { [CORE]: 'core-a', [BACKUP]: 'core-b' };

test('roleKeyNames: a role takes a string or a list of variable names, the first primary; unset or foreign names are left out', () => {
  const env = { OPENROUTER_P: 'p', OPENROUTER_Q: 'q', OPENROUTER_BLANK: ' ', DISCORD_TOKEN: 'secret' };
  const cfg = config({
    vision: ['OPENROUTER_P', 'OPENROUTER_Q'],
    video: 'OPENROUTER_Q',
    analyzer: ['DISCORD_TOKEN', 'OPENROUTER_BLANK', 'OPENROUTER_P'],
  });
  assert.deepEqual(roleKeyNames(cfg, env, 'vision'), ['OPENROUTER_P', 'OPENROUTER_Q']);
  assert.deepEqual(roleKeyNames(cfg, env, 'video'), ['OPENROUTER_Q']);
  // Bug caught: a config typo in a list sending another secret to OpenRouter, or an empty backup being "switched" to.
  assert.deepEqual(roleKeyNames(cfg, env, 'analyzer'), ['OPENROUTER_P']);
  assert.deepEqual(roleKeyNames(cfg, env, 'drawing'), [], 'an unmapped role has no list: it is on the main key');
});

test('roleKeyNames: the core defaults to the main key then the backup when the backup variable is set, else the main key alone', () => {
  assert.deepEqual(roleKeyNames(config({}), BOTH, 'core'), [CORE, BACKUP]);
  assert.deepEqual(roleKeyNames(config({}), { [CORE]: 'core-a' }, 'core'), [CORE]);
  assert.deepEqual(
    roleKeyNames(config({}), { ...BOTH, [BACKUP]: '' }, 'core'),
    [CORE],
    'a blank backup counts as unset'
  );
  // An explicit entry replaces the default.
  assert.deepEqual(roleKeyNames(config({ core: 'OPENROUTER_P' }), { ...BOTH, OPENROUTER_P: 'p' }, 'core'), [
    'OPENROUTER_P',
  ]);
});

test('roleApiKey: OPENROUTER_CORE_BACKUP_KEY is an allowed variable name, and a list resolves to its first set key', () => {
  const env = { OPENROUTER_P: 'p', [BACKUP]: 'core-b' };
  assert.equal(roleApiKey(config({ core: [BACKUP] }), env, 'core', 'main'), 'core-b');
  assert.equal(roleApiKey(config({ core: ['OPENROUTER_UNSET_Z', 'OPENROUTER_P'] }), env, 'core', 'main'), 'p');
});

/** A fetch that answers each request by its key: the list of [status, body] per key, in order, last one repeating. */
function keyedFetch(script: Record<string, Array<[number, string]>>) {
  const sent: Array<string> = [];
  const used: Record<string, number> = {};
  const fake = asFetch((_url, init) => {
    const key = init.headers.Authorization.replace('Bearer ', '');
    sent.push(key);
    const steps = script[key] ?? [[200, '']];
    const [status, body] = steps[Math.min(used[key] ?? 0, steps.length - 1)];
    used[key] = (used[key] ?? 0) + 1;
    return Promise.resolve({
      ok: status === 200,
      status,
      text: () => Promise.resolve(body),
      json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5 }, data: {} }),
    });
  });
  return { fake, sent };
}

function failoverLlm(script: Record<string, Array<[number, string]>>, env: Record<string, string> = BOTH, retries = 0) {
  const clock = { at: Date.parse('2026-11-02T09:00:00Z') };
  const cfg = config({});
  cfg.llm.retries = retries;
  const { fake, sent } = keyedFetch(script);
  const llm = createLlm({
    apiKey: 'core-a',
    env,
    getConfig: () => cfg,
    // @ts-expect-error the calibrator of this test also carries a ratio
    calibrator: { ratio: 1, apply: (n: number) => n, observe() {} },
    state: fakeState(),
    fetchImpl: fake,
    now: () => clock.at,
  });
  return { llm, sent, clock };
}

const CREDITS_429 = '{"error":{"message":"Your credit balance is too low"}}';

test('createLlm: a 402 on the core key repeats the same request once on the backup at once, and later requests stay on it', async () => {
  const { llm, sent } = failoverLlm({ 'core-a': [[402, '{"error":{"message":"Payment Required"}}']] });
  const answer = await llm.complete(ask, { role: 'core' });
  assert.equal(answer.text, 'ok');
  assert.deepEqual(sent, ['core-a', 'core-b'], 'one failed send, one repeat');
  await llm.complete(ask, { role: 'core' });
  // Bug caught: probing the exhausted key before every request.
  assert.deepEqual(sent, ['core-a', 'core-b', 'core-b'], 'no check on the old key');
});

test('createLlm: a 429 naming credits switches the key without the retry backoff; a plain rate limit does not switch', async () => {
  const credits = failoverLlm({ 'core-a': [[429, CREDITS_429]] }, BOTH, 2);
  await credits.llm.complete(ask, { role: 'core' });
  // Bug caught: the 429 retried on the same empty key after a backoff sleep.
  assert.deepEqual(credits.sent, ['core-a', 'core-b']);
  const rate = failoverLlm(
    {
      'core-a': [
        [429, '{"error":{"message":"Rate limit exceeded"}}'],
        [200, ''],
      ],
    },
    BOTH,
    1
  );
  await rate.llm.complete(ask, { role: 'core' });
  assert.ok(!rate.sent.includes('core-b'), `rate limit stayed on the first key: ${rate.sent.join(',')}`);
});

test('createLlm: a 500 or a 400 never switches the key', async () => {
  const { llm, sent } = failoverLlm({ 'core-a': [[400, 'credit balance']] });
  await assert.rejects(llm.complete(ask, { role: 'core' }), { statusCode: 400 });
  assert.deepEqual(sent, ['core-a']);
});

test('createLlm: the backup failing too within a minute fails with keys-exhausted after exactly two sends', async () => {
  const { llm, sent } = failoverLlm({ 'core-a': [[402, '']], 'core-b': [[402, '']] });
  await assert.rejects(llm.complete(ask, { role: 'core' }), { code: 'keys-exhausted' });
  assert.deepEqual(sent, ['core-a', 'core-b'], 'each key tried once, nothing more');
});

test('createLlm: the last key failing after a minute switches back to the first and tries once more', async () => {
  const { llm, sent, clock } = failoverLlm({
    'core-a': [
      [402, ''],
      [200, ''],
    ],
    'core-b': [
      [200, ''],
      [402, ''],
    ],
  });
  await llm.complete(ask, { role: 'core' }); // a fails, b answers
  clock.at += 5 * 60_000; // the first key's credits reset
  await llm.complete(ask, { role: 'core' }); // b fails, back to a
  assert.deepEqual(sent, ['core-a', 'core-b', 'core-b', 'core-a']);
});

test('createLlm: with no backup variable a 402 on the main key fails with its own error, not keys-exhausted', async () => {
  const { llm, sent } = failoverLlm({ 'core-a': [[402, '']] }, { [CORE]: 'core-a' });
  await assert.rejects(llm.complete(ask, { role: 'core' }), { statusCode: 402 });
  assert.deepEqual(sent, ['core-a']);
});

test('createLlm: a role mapped to a list fails over within it; the core is untouched', async () => {
  const env = { ...BOTH, OPENROUTER_V1: 'v-one', OPENROUTER_V2: 'v-two' };
  const clock = { at: 0 };
  const cfg = config({ vision: ['OPENROUTER_V1', 'OPENROUTER_V2'] });
  const { fake, sent } = keyedFetch({ 'v-one': [[402, '']] });
  const llm = createLlm({
    apiKey: 'core-a',
    env,
    getConfig: () => cfg,
    // @ts-expect-error the calibrator of this test also carries a ratio
    calibrator: { ratio: 1, apply: (n: number) => n, observe() {} },
    state: fakeState(),
    fetchImpl: fake,
    now: () => clock.at,
  });
  await llm.complete(ask, { role: 'vision', model: 'x/v' });
  await llm.complete(ask, { role: 'core' });
  assert.deepEqual(sent, ['v-one', 'v-two', 'core-a']);
});

test('createLlm: the switch is logged by variable name with role and status, and no log line holds a key value', async () => {
  const { llm } = failoverLlm({ 'core-a': [[402, '']] });
  const { logs } = await withCapturedLogs(() => llm.complete(ask, { role: 'core' }));
  const entry = logs.find((line) => line.msg === 'llm: key switched');
  assert.deepEqual([entry?.role, entry?.from, entry?.to, entry?.status], ['core', CORE, BACKUP, 402]);
  assert.ok(!JSON.stringify(logs).match(/core-[ab]/), 'names only');
});

test('createLlm: keyStates names the key each listed role is on and when it last switched', async () => {
  const { llm, clock } = failoverLlm({ 'core-a': [[402, '']] });
  const before = llm.keyStates().find((s) => s.role === 'core');
  assert.deepEqual(before, { role: 'core', key: CORE, switchedAt: null });
  await llm.complete(ask, { role: 'core' });
  assert.deepEqual(
    llm.keyStates().find((s) => s.role === 'core'),
    { role: 'core', key: BACKUP, switchedAt: clock.at }
  );
  assert.ok(!JSON.stringify(llm.keyStates()).match(/core-[ab]/), 'never a value');
});
