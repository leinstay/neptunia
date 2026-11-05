// src/agent-runner/backend.ts: an opencode run pinned to an OpenRouter provider. OpenCode reads its config from the file
// `OPENCODE_CONFIG` and from the inline `OPENCODE_CONFIG_CONTENT` and merges the two, so the test merges them the same
// way at the moment of the spawn and asserts on the result. OpenRouter's request body gets the model's `options`
// (the `openrouter` key of the AI SDK provider options), so `provider.openrouter.models.<id>.options.provider` is the
// block that reaches OpenRouter. The child is a fake; no request goes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import type { spawn } from 'node:child_process';
import { createBackend } from '../src/agent-runner/backend.ts';
import type { BackendName, BackendRunOptions } from '../src/agent-runner/backend.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { tempDir } from './fixtures/tmp.ts';

type Json = Record<string, unknown>;

const MODEL = 'anthropic/claude-sonnet-5';
const STEPS = JSON.stringify({ agent: { build: { steps: 12 } } });

const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** OpenCode's merge: objects join key by key, anything else is replaced by the later file. */
function merged(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const before = out[key];
    out[key] = isJson(before) && isJson(value) ? merged(before, value) : value;
  }
  return out;
}

type Spawned = { config: Json; file: string | undefined; args: ReadonlyArray<string> };

/** One run on a fake child; the config the child would load is read while it runs. */
async function runOnce(
  name: BackendName,
  options: Partial<BackendRunOptions>
): Promise<{ spawned: Array<Spawned>; error: string | undefined }> {
  const base = tempDir('nep-oc-provider-');
  const binary = path.join(base, 'fake-binary');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const spawned: Array<Spawned> = [];
  const impl = (_binary: string, args: Array<string>, spawnOptions: { env: Record<string, string> }) => {
    const { OPENCODE_CONFIG: file, OPENCODE_CONFIG_CONTENT: inline } = spawnOptions.env;
    const fromFile = file === undefined ? {} : (JSON.parse(fs.readFileSync(file, 'utf8')) as Json);
    const fromEnv = inline === undefined ? {} : (JSON.parse(inline) as Json);
    spawned.push({ config: merged(fromFile, fromEnv), file, args });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      pid: undefined,
      kill: () => true,
    });
    child.stdin.resume();
    child.stdin.on('end', () => setImmediate(() => child.emit('close', 0)));
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const backend = createBackend(name, { binary, spawnImpl: wrongly<typeof spawn>(impl) });
  const result = await backend.run('the task', { cwd: base, timeoutMs: 20_000, ...options });
  return { spawned, error: result.error };
}

/** The `options` OpenCode would hand OpenRouter for `model`, or undefined. */
function optionsOf(config: Json, model: string): unknown {
  const provider = config.provider;
  const openrouter = isJson(provider) ? provider.openrouter : undefined;
  const models = isJson(openrouter) ? openrouter.models : undefined;
  const entry = isJson(models) ? models[model] : undefined;
  return isJson(entry) ? entry.options : undefined;
}

test('a pinned opencode run sends OpenRouter the provider order with that provider alone and no fallback', async () => {
  // Catches: the pin never reaches the child, or it lists a provider as a preference while fallbacks stay on, so an
  // Anthropic model still runs at Bedrock when Anthropic is busy.
  const { spawned } = await runOnce('opencode', { model: `openrouter/${MODEL}`, provider: 'anthropic' });
  assert.equal(spawned.length, 1);
  assert.deepEqual(optionsOf(spawned[0].config, MODEL), { provider: { order: ['anthropic'], allow_fallbacks: false } });
});

test('the pin is keyed by the model id without the openrouter/ prefix opencode is started with', async () => {
  // Catches: the block filed under `openrouter/anthropic/...`, a key OpenCode never looks up, so the pin does nothing.
  const { spawned } = await runOnce('opencode', { model: `openrouter/${MODEL}`, provider: 'anthropic' });
  const provider = spawned[0].config.provider;
  const openrouter = isJson(provider) ? provider.openrouter : undefined;
  const models = isJson(openrouter) ? openrouter.models : undefined;
  assert.deepEqual(Object.keys(isJson(models) ? models : {}), [MODEL]);
});

test('the pin goes to the model of the run and to no other', async () => {
  // Catches: the block written for a wildcard or for every model, so a second model in the same config is pinned too.
  const { spawned } = await runOnce('opencode', { model: 'openrouter/deepseek/deepseek-v4', provider: 'deepinfra' });
  assert.equal(optionsOf(spawned[0].config, MODEL), undefined);
  assert.deepEqual(optionsOf(spawned[0].config, 'deepseek/deepseek-v4'), {
    provider: { order: ['deepinfra'], allow_fallbacks: false },
  });
});

test('an opencode run with no provider sends no provider block at all', async () => {
  // Catches: an empty or default block on every run, which changes how all unpinned errands are routed.
  const { spawned } = await runOnce('opencode', { model: `openrouter/${MODEL}` });
  assert.equal(Object.hasOwn(spawned[0].config, 'provider'), false);
});

test('a pin keeps the system prompt of the build agent in the same config', async () => {
  // Catches: the pin overwrites the config file that carries the preamble, or the preamble overwrites the pin.
  const { spawned } = await runOnce('opencode', {
    model: `openrouter/${MODEL}`,
    provider: 'anthropic',
    system: 'SYSTEM',
  });
  assert.deepEqual(spawned[0].config.agent, { build: { prompt: 'SYSTEM' } });
  assert.deepEqual(optionsOf(spawned[0].config, MODEL), { provider: { order: ['anthropic'], allow_fallbacks: false } });
});

test('a pin keeps the step cap that runAgent passes in OPENCODE_CONFIG_CONTENT', async () => {
  // Catches: the pin replaces the inline config, so the run loses its steps cap and can loop past it.
  const { spawned } = await runOnce('opencode', {
    model: `openrouter/${MODEL}`,
    provider: 'anthropic',
    env: { OPENCODE_CONFIG_CONTENT: STEPS },
  });
  assert.deepEqual(spawned[0].config.agent, { build: { steps: 12 } });
  assert.deepEqual(optionsOf(spawned[0].config, MODEL), { provider: { order: ['anthropic'], allow_fallbacks: false } });
});

test('the config file of a pinned run is gone when the run ends', async () => {
  // Catches: the config left in the temp folder after the run, one file per errand.
  const { spawned } = await runOnce('opencode', { model: `openrouter/${MODEL}`, provider: 'anthropic' });
  const file = spawned[0].file;
  // The pin may travel in the file or inline; only a file there is has to be removed.
  assert.equal(file === undefined ? false : fs.existsSync(file), false);
});

test('the pin adds no argument to the opencode command line', async () => {
  // Catches: the provider passed as a flag opencode does not have, so the child exits 1 on every pinned run.
  const pinned = await runOnce('opencode', { model: `openrouter/${MODEL}`, provider: 'anthropic' });
  const plain = await runOnce('opencode', { model: `openrouter/${MODEL}` });
  assert.deepEqual(pinned.spawned[0].args, plain.spawned[0].args);
});

for (const name of ['claude', 'codex'] as const) {
  test(`a provider on a ${name} run is refused as provider-unsupported and nothing is spawned`, async () => {
    // Catches: the pin silently dropped, so the run goes out unpinned while the owner believes it is pinned.
    const { spawned, error } = await runOnce(name, { model: 'some-model', provider: 'anthropic' });
    assert.equal(error, 'provider-unsupported');
    assert.deepEqual(spawned, []);
  });
}
