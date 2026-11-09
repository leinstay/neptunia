// `llm.subscription.fallback` with no API key (owner, 2026-11-06): the fallback sends a failed harness step to the
// direct client, which needs a key. With no core key in keys.json and none bound to the role, the step fails as if
// fallback were off, and the direct client is never called. The spawn is a fake whose stdout the test writes, as in
// tests/subharness-subscription-client.test.ts; the direct client counts its calls. No model is asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSubscriptionClient } from '../src/subharness/subscription-client.ts';
import type { SubscriptionProcess } from '../src/subharness/subscription-client.ts';
import { createToolBridge } from '../src/subharness/tool-bridge.ts';
import type { CompleteResult } from '../src/llm/openrouter.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { tempDir } from './fixtures/tmp.ts';

const FIRST = [
  { role: 'system', content: 'You are the persona.' },
  { role: 'user', content: '#3 Ann: is the trip still on?' },
];
const REPLY = { role: 'core', purpose: 'reply', maxOutputTokens: 900 };
const STEP_TIMEOUT = { timeout: 10_000 };

/** A spawn whose single run fails at once with the 429 of a spent window. */
function failingSpawn() {
  let started = 0;
  const spawn = (): SubscriptionProcess => {
    started += 1;
    const lines: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => {
        const queue = [
          JSON.stringify({
            type: 'rate_limit_event',
            rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day' },
          }),
          JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: '' }),
        ];
        return {
          next: () => {
            const line = queue.shift();
            return Promise.resolve(
              line === undefined ? { value: undefined, done: true } : { value: line, done: false }
            );
          },
        };
      },
    };
    return { lines, exited: Promise.resolve(1), kill: () => {} };
  };
  return { spawn, started: () => started };
}

function rig(options: { keys: boolean; fallback: boolean }) {
  const dir = tempDir('nep-subscription-nokey-');
  writeKeysFile(dir, {
    core: options.keys ? [{ name: 'core-1', value: 'sk-or-v1-never-leaves' }] : [],
    subharness: { key: null, modes: {}, core: { backend: 'claude', model: 'claude-opus-4-6', effort: null } },
  });
  fakeVendor(dir, 'claude', { loggedIn: true });
  let tokens = 0;
  const directCalls: Array<unknown> = [];
  const direct = {
    complete: (messages: unknown): Promise<CompleteResult> => {
      directCalls.push(messages);
      return Promise.resolve({ text: '<msg>from the api</msg>', usage: {}, estimated: 0 });
    },
  };
  const { spawn, started } = failingSpawn();
  const client = createSubscriptionClient({
    privateDir: dir,
    direct,
    bridge: createToolBridge({ token: () => `tok-${(tokens += 1)}` }),
    spawn,
    mcp: { command: '/opt/node/bin/node', args: ['/app/bin/neptunia-mcp.ts'], socketPath: '/data/run/core.sock' },
    workDir: tempDir('nep-subscription-nokey-work-'),
    getConfig: () => ({
      llm: {
        baseUrl: 'https://openrouter.invalid/api/v1',
        timeoutMs: 120_000,
        retries: 0,
        maxRequestTokens: 50_000,
        maxOutputTokens: 900,
        maxRequestsPerDay: 5000,
        subscription: { fallback: options.fallback, thinking: false, holdMs: 45_000 },
      },
    }),
    state: { data: {}, markDirty: () => {} },
    now: () => Date.UTC(2026, 10, 6, 12),
    setTimer: () => ({}),
    clearTimer: () => {},
    hostEnv: { PATH: '/usr/bin:/bin', HOME: '/home/persona' },
  });
  return { client, directCalls, started };
}

test(
  'with fallback on and no core key, a failed harness step fails and the direct client is never called',
  STEP_TIMEOUT,
  async () => {
    // Catches: the fallback making an API request with no key, which fails with a second error and may pause her.
    const { client, directCalls, started } = rig({ keys: false, fallback: true });
    await assert.rejects(client.complete(FIRST, REPLY), { code: 'subscription-exhausted' });
    assert.equal(started(), 1, 'the harness was tried');
    assert.deepEqual(directCalls, []);
  }
);

test(
  'with fallback on and a core key, a failed harness step still goes to the direct client',
  STEP_TIMEOUT,
  async () => {
    // Catches: the no-key rule switching fallback off for every deployment.
    const { client, directCalls } = rig({ keys: true, fallback: true });
    const answer = await client.complete(FIRST, REPLY);
    assert.equal(answer.text, '<msg>from the api</msg>');
    assert.equal(directCalls.length, 1);
  }
);
