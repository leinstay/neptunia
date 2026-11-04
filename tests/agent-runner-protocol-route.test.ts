// src/agent-runner/protocol.ts: the `route` of a `run`, the path the core decided for the task. Pure; no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequestLine, validateRequest } from '../src/agent-runner/protocol.ts';

const ROUTE = { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium', mode: 'write' };

for (const route of [
  ROUTE,
  { backend: 'codex', model: null, effort: null, mode: 'read' },
  { backend: 'opencode', model: 'vendor/model:free', effort: 'high', mode: 'full' },
  // The owner may type any model name, and claude takes this form.
  { backend: 'claude', model: 'claude-opus-4-6[1m]', effort: 'low', mode: 'sudo' },
]) {
  test(`validateRequest keeps the route ${JSON.stringify(route)}`, () => {
    // Catches: the validator drops the field, or a model the owner set is refused and every errand of that agent fails.
    const checked = validateRequest({ op: 'run', id: 'a', goal: 'x', route });
    assert.ok(checked.ok);
    assert.ok(checked.message.op === 'run');
    assert.deepEqual(checked.message.route, route);
  });
}

for (const [name, route] of [
  ['null', null],
  ['a string', 'claude'],
  ['a list', []],
  ['no backend', { model: null, effort: null, mode: 'read' }],
  ['no model', { backend: 'claude', effort: null, mode: 'read' }],
  ['no effort', { backend: 'claude', model: null, mode: 'read' }],
  ['no mode', { backend: 'claude', model: null, effort: null }],
  ['an unknown backend', { ...ROUTE, backend: 'gemini' }],
  ['an unknown effort', { ...ROUTE, effort: 'extreme' }],
  ['an unknown mode', { ...ROUTE, mode: 'root' }],
  ['a number as the model', { ...ROUTE, model: 42 }],
  ['an empty model', { ...ROUTE, model: '' }],
  ['a model with a space', { ...ROUTE, model: 'a b' }],
  ['a model that reads as a flag', { ...ROUTE, model: '--dangerously-skip-permissions' }],
  ['a key beside the four fields', { ...ROUTE, key: 'sk-SECRET' }],
] as const) {
  test(`validateRequest refuses a route with ${name} as bad-route`, () => {
    // Catches: a route the runner cannot honour reaches the engine, or a credential travels in a field that is not `secrets`.
    assert.deepEqual(validateRequest({ op: 'run', id: 'a', goal: 'x', route }), { ok: false, error: 'bad-route' });
  });
}

test('parseRequestLine keeps the task id of a refused route and names no value of it', () => {
  // Catches: the refusal has no id, so the core waits for the errand's whole time cap, or a value travels back in the error.
  const line = JSON.stringify({ op: 'run', id: 'task-r', goal: 'g', route: { ...ROUTE, key: 'sk-SECRET' } });
  assert.deepEqual(parseRequestLine(line), { ok: false, error: 'bad-route', id: 'task-r' });
});
