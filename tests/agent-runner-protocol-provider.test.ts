// src/agent-runner/protocol.ts: the optional `provider` of a route, the OpenRouter provider an opencode run is pinned to.
// Pure; no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, validateRequest } from '../src/agent-runner/protocol.ts';
import type { TaskRoute } from '../src/agent-runner/protocol.ts';

const PINNED: TaskRoute = {
  backend: 'opencode',
  model: 'anthropic/claude-sonnet-5',
  effort: null,
  mode: 'write',
  provider: 'anthropic',
};
const PLAIN: TaskRoute = { backend: 'opencode', model: 'anthropic/claude-sonnet-5', effort: null, mode: 'write' };

test('parseRoute keeps the provider of an opencode route', () => {
  // Catches: the fifth key is refused as an unknown key, so every pinned errand fails bad-route, or it is dropped and runs at any provider.
  assert.deepEqual(parseRoute(PINNED), PINNED);
});

for (const provider of ['anthropic', 'amazon-bedrock', 'google-vertex', 'deepinfra']) {
  test(`parseRoute accepts the provider slug ${provider}`, () => {
    // Catches: a slug with a hyphen or a digit refused by a pattern that is too narrow.
    assert.equal(parseRoute({ ...PINNED, provider })?.provider, provider);
  });
}

test('parseRoute leaves a route with no provider without the key', () => {
  // Catches: the field arriving as undefined or null on every route, so the child config gets an empty pin.
  assert.deepEqual(Object.keys(parseRoute(PLAIN) ?? {}).sort(), ['backend', 'effort', 'mode', 'model']);
});

for (const [name, provider] of [
  ['an empty string', ''],
  ['null', null],
  ['a number', 7],
  ['a name with a space', 'amazon bedrock'],
  ['a name that reads as a flag', '--dangerously-skip-permissions'],
  ['upper case', 'Anthropic'],
  ['a name past 64 characters', 'a'.repeat(65)],
] as const) {
  test(`parseRoute refuses ${name} as the provider`, () => {
    // Catches: a value that reaches the child config or a command line as it came.
    assert.equal(parseRoute({ ...PINNED, provider }), null);
  });
}

for (const backend of ['claude', 'codex'] as const) {
  test(`parseRoute refuses a provider on a ${backend} route`, () => {
    // Catches: a pin the backend cannot honour is accepted, so the errand runs unpinned while the owner thinks it is pinned.
    assert.equal(parseRoute({ ...PINNED, backend, model: 'x-model' }), null);
  });
}

test('parseRoute refuses a provider on a route with no model', () => {
  // Catches: a pin with no model to attach it to, which the child config cannot express.
  assert.equal(parseRoute({ ...PINNED, model: null }), null);
});

test('validateRequest keeps the provider of the route inside a run', () => {
  // Catches: the validator rebuilds the route from four fields and drops the pin on the way to the runner.
  const checked = validateRequest({ op: 'run', id: 'a', goal: 'x', route: PINNED });
  assert.ok(checked.ok);
  assert.ok(checked.message.op === 'run');
  assert.deepEqual(checked.message.route, PINNED);
});

test('validateRequest refuses a provider on a claude route as bad-route', () => {
  // Catches: the refusal has another code, or none, so the core cannot tell the owner what was wrong.
  const route = { ...PINNED, backend: 'claude' };
  assert.deepEqual(validateRequest({ op: 'run', id: 'a', goal: 'x', route }), { ok: false, error: 'bad-route' });
});
