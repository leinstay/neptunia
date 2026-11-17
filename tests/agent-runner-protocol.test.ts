// Tests for src/agent-runner/protocol.ts: validation of the core's `run`,
// `cancel` and `ping` (ids, goal length, context scope, limit keys, model,
// cost, search provider, secrets -- never echoed back -- and the shared
// preamble), the decode of a line
// (bad JSON, oversize), the http form of a proxy URL, and the shapes of the
// runner's `end`, `pong`, `restarted` and `error` events, including
// the frozen RESULT_STATUSES. Pure; no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRequest,
  parseRequestLine,
  encodeLine,
  endEvent,
  restartedEvent,
  pongEvent,
  errorEvent,
  normalizeUsage,
  normalizeResult,
  SECRET_KEYS,
  httpProxyForm,
  parseRoute,
} from '../src/agent-runner/protocol.ts';
import type { Untyped } from '../src/tools/types.ts';
import type { TaskRoute } from '../src/agent-runner/protocol.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

test('validateRequest: a full run passes and is normalised', () => {
  const r = validateRequest({
    op: 'run',
    agent: 'scout',
    id: 'task-1',
    goal: '  find a meme  ',
    context: { scope: 'dm', asker: 'Theodora' },
    limits: { steps: 10, seconds: 60 },
    searchProvider: 'exa',
  });
  assert.equal(r.ok, true);
  assert.equal(loose(r.message).goal, 'find a meme');
  assert.equal(loose(r.message).context.scope, 'dm');
});

test('validateRequest: run needs the name of its agent, since one runner serves every agent of its unit', () => {
  // Bug: a run with no agent reaches a runner that cannot tell which agent's prompt to use.
  assert.equal(loose(validateRequest({ op: 'run', id: 'a', goal: 'x' })).error, 'bad-agent');
  assert.equal(loose(validateRequest({ op: 'run', agent: '../scout', id: 'a', goal: 'x' })).error, 'bad-agent');
  assert.equal(loose(loose(validateRequest({ op: 'run', agent: 'scout', id: 'a', goal: 'x' })).message).agent, 'scout');
});

test('validateRequest: run needs a non-empty goal and an id', () => {
  assert.equal(loose(validateRequest({ op: 'run', agent: 'scout', id: 'a' })).error, 'bad-goal');
  assert.equal(loose(validateRequest({ op: 'run', agent: 'scout', id: 'a', goal: '   ' })).error, 'bad-goal');
  assert.equal(loose(validateRequest({ op: 'run', goal: 'x' })).error, 'bad-id');
  assert.equal(loose(validateRequest({ op: 'run', agent: 'scout', id: 'bad id!', goal: 'x' })).error, 'bad-id');
});

test('validateRequest: a bad scope, limit, cost or search provider is refused', () => {
  assert.equal(
    loose(validateRequest({ op: 'run', agent: 'scout', id: 'a', goal: 'x', context: { scope: 'nope' } })).error,
    'bad-scope'
  );
  assert.equal(
    loose(validateRequest({ op: 'run', agent: 'scout', id: 'a', goal: 'x', limits: { steps: -1 } })).error,
    'bad-limits'
  );
  assert.equal(
    loose(validateRequest({ op: 'run', agent: 'scout', id: 'a', goal: 'x', limits: { nope: 1 } })).error,
    'bad-limits'
  );
  assert.equal(
    loose(validateRequest({ op: 'run', agent: 'scout', id: 'a', goal: 'x', searchProvider: 'Exa!' })).error,
    'bad-search-provider'
  );
});

test('validateRequest: a run carries its secrets, each a non-empty string; only the known keys', () => {
  assert.deepEqual([...SECRET_KEYS], ['openrouterKey', 'proxy', 'searchKey']);
  const full = validateRequest({
    op: 'run',
    agent: 'scout',
    id: 'a',
    goal: 'x',
    secrets: { openrouterKey: 'sk-or-1', proxy: 'http://u:p@proxy.example:8000', searchKey: 'srch-1' },
  });
  assert.equal(full.ok, true);
  assert.deepEqual(loose(full.message).secrets, {
    openrouterKey: 'sk-or-1',
    proxy: 'http://u:p@proxy.example:8000',
    searchKey: 'srch-1',
  });
  const keyOnly = validateRequest({
    op: 'run',
    agent: 'scout',
    id: 'a',
    goal: 'x',
    secrets: { openrouterKey: 'sk-or-1' },
  });
  assert.deepEqual(loose(keyOnly).message.secrets, { openrouterKey: 'sk-or-1' });
  assert.equal(
    Object.hasOwn(
      loose(validateRequest({ op: 'run', agent: 'scout', id: 'a', goal: 'x' })).message as object,
      'secrets'
    ),
    false,
    'none given: none passed on'
  );
});

test('validateRequest / parseRequestLine: refused secrets come back as a code, never the secret', () => {
  const secret = 'sk-or-v1-VERYSECRET';
  const bad = [
    { openrouterKey: '' },
    { openrouterKey: 42 },
    // Stage Z: secrets holding the proxy alone are valid (tests/proxy-harness.test.ts); an empty set is not.
    {},
    { openrouterKey: secret, proxy: '' },
    { openrouterKey: secret, searchKey: ['x'] },
    { openrouterKey: secret, other: 'x' },
    { openrouterKey: `${secret} with space` },
    { openrouterKey: secret.repeat(200) },
    'sk-or-v1-VERYSECRET',
  ];
  for (const secrets of bad) {
    const checked = validateRequest({ op: 'run', agent: 'scout', id: 'a', goal: 'x', secrets });
    assert.deepEqual(checked, { ok: false, error: 'bad-secrets' }, JSON.stringify(secrets).slice(0, 60));
    assert.ok(!JSON.stringify(checked).includes('VERYSECRET'));
  }
  // A run refused for another reason while carrying good secrets: the refusal and its error event name no secret.
  const line = JSON.stringify({
    op: 'run',
    agent: 'scout',
    id: 'task-7',
    goal: '',
    secrets: { openrouterKey: secret, proxy: 'http://u:VERYSECRET@p.example:1', searchKey: secret },
  });
  const parsed = parseRequestLine(line);
  assert.deepEqual(parsed, { ok: false, error: 'bad-goal', id: 'task-7' });
  assert.ok(!encodeLine(errorEvent(parsed.error, parsed.id)).includes('VERYSECRET'));
  const badSecrets = parseRequestLine(
    JSON.stringify({
      op: 'run',
      agent: 'scout',
      id: 'task-8',
      goal: 'g',
      secrets: { openrouterKey: secret, extra: secret },
    })
  );
  assert.deepEqual(badSecrets, { ok: false, error: 'bad-secrets', id: 'task-8' });
  assert.ok(!encodeLine(errorEvent(badSecrets.error, badSecrets.id)).includes('VERYSECRET'));
});

test('httpProxyForm: a socks5h URL becomes the http one with the same credentials, host and port; http stays; anything else is null', () => {
  assert.equal(httpProxyForm('socks5h://user:pa%40ss@proxy.example:1080'), 'http://user:pa%40ss@proxy.example:1080');
  assert.equal(httpProxyForm('socks5h://proxy.example:9000'), 'http://proxy.example:9000');
  assert.equal(httpProxyForm(' http://u:p@proxy.example:8000 '), 'http://u:p@proxy.example:8000');
  assert.equal(httpProxyForm('https://proxy.example:8443'), 'https://proxy.example:8443');
  assert.equal(httpProxyForm('socks5h://proxy.example'), null, 'no port: no http form');
  assert.equal(httpProxyForm('socks4://proxy.example:1080'), null);
  assert.equal(httpProxyForm('not a url'), null);
  assert.equal(httpProxyForm(''), null);
  assert.equal(httpProxyForm(undefined), null);
});

test('validateRequest: goal over the cap is refused', () => {
  const long = 'a'.repeat(4001);
  assert.equal(loose(validateRequest({ op: 'run', agent: 'scout', id: 'a', goal: long })).error, 'goal-too-long');
});

test('validateRequest: cancel and ping', () => {
  assert.deepEqual(loose(validateRequest({ op: 'cancel', id: 'task-9' })).message, { op: 'cancel', id: 'task-9' });
  assert.deepEqual(loose(validateRequest({ op: 'ping' })).message, { op: 'ping', ids: [] });
  assert.deepEqual(loose(validateRequest({ op: 'ping', ids: ['a', 'a', 'b'] })).message.ids, ['a', 'b']);
  assert.equal(loose(validateRequest({ op: 'ping', ids: ['bad id'] })).error, 'bad-ids');
  assert.equal(loose(validateRequest({ op: 'what' })).error, 'bad-op');
  assert.equal(loose(validateRequest('x')).error, 'not-an-object');
});

test('parseRequestLine: bad JSON, oversize, and a valid id surfaced on a bad message', () => {
  assert.equal(loose(parseRequestLine('{not json')).error, 'bad-json');
  assert.equal(loose(parseRequestLine('x'.repeat(1_000_001))).error, 'line-too-long');
  const r = parseRequestLine(JSON.stringify({ op: 'run', agent: 'scout', id: 'task-5', goal: '' }));
  assert.equal(r.ok, false);
  assert.equal(r.id, 'task-5');
});

test('endEvent: status clamped to a known one, result and usage normalised', () => {
  const e = endEvent({
    id: 'a',
    status: 'weird',
    result: { text: 'ok', sources: ['u', 'u'], files: [{ path: '/p', bytes: 3 }] },
    usage: { usd: 0.1 },
  });
  assert.equal(e.status, 'failed');
  assert.deepEqual(e.result.sources, ['u']);
  assert.equal(e.result.files[0].name, '');
  assert.equal(e.usage.usd, 0.1);
  const ok = endEvent({ id: 'a', status: 'done', result: { text: 'hi' } });
  assert.equal(ok.status, 'done');
  assert.equal(ok.error, undefined);
});

test('restarted, pong and error events', () => {
  assert.deepEqual(restartedEvent('a'), {
    id: 'a',
    event: 'end',
    status: 'failed',
    result: { text: '', sources: [], files: [] },
    usage: { input: 0, output: 0, usd: 0, steps: 0, seconds: 0 },
    error: 'restarted',
  });
  assert.deepEqual(pongEvent({ unit: 'scout', busy: true, queued: 2 }), {
    event: 'pong',
    unit: 'scout',
    busy: true,
    queued: 2,
  });
  assert.deepEqual(errorEvent('bad-op'), { event: 'error', error: 'bad-op' });
  assert.deepEqual(errorEvent('bad-goal', 'a'), { id: 'a', event: 'error', error: 'bad-goal' });
});

test('normalizeUsage and normalizeResult: non-numbers and non-objects default', () => {
  assert.deepEqual(normalizeUsage(null), { input: 0, output: 0, usd: 0, steps: 0, seconds: 0 });
  assert.deepEqual(normalizeResult('x'), { text: '', sources: [], files: [] });
});

test('encodeLine: one JSON object and a newline', () => {
  assert.equal(encodeLine({ a: 1 }), '{"a":1}\n');
});

// The owner on 2026-11-16: a recent line is kept whole; the limit of 200 is gone.
test('validateRequest: context.recent passes as { author, text } lines, the latest 20 kept, each whole; a malformed line refuses bad-recent', () => {
  const line = (i: Untyped) => ({ author: `Ελένη ${i}`, text: `γραμμή ${i}`, extra: 'dropped' });
  const many = Array.from({ length: 25 }, (_, i) => line(i));
  const ok = validateRequest({
    op: 'run',
    agent: 'scout',
    id: 't1',
    goal: 'g',
    context: { scope: 'group', channel: 'c1', recent: many },
  });
  assert.equal(ok.ok, true);
  assert.equal(loose(ok.message).context.recent.length, 20);
  assert.deepEqual(
    loose(ok.message).context.recent[0],
    { author: 'Ελένη 5', text: 'γραμμή 5' },
    'the earliest dropped, other keys too'
  );
  assert.equal(loose(ok.message).context.channel, 'c1');
  const long = validateRequest({
    op: 'run',
    agent: 'scout',
    id: 't1',
    goal: 'g',
    context: { recent: [{ author: 'a'.repeat(300), text: 'b'.repeat(3000) }] },
  });
  assert.deepEqual(
    [loose(long).message.context.recent[0].author.length, loose(long).message.context.recent[0].text.length],
    [300, 3000]
  );
  assert.deepEqual(
    loose(validateRequest({ op: 'run', agent: 'scout', id: 't1', goal: 'g', context: { recent: [] } })).message.context
      .recent,
    []
  );
  for (const bad of [
    'text',
    [{ author: 'a' }],
    [{ author: 'a', text: 3 }],
    [null],
    [['a', 'b']],
    [{ author: 'a', text: 'b' }, 'c'],
  ]) {
    assert.deepEqual(
      validateRequest({ op: 'run', agent: 'scout', id: 't1', goal: 'g', context: { recent: bad } }),
      { ok: false, error: 'bad-recent' },
      JSON.stringify(bad)
    );
  }
});

test('validateRequest: a run carries the shared preamble trimmed; a blank one is dropped, none given none passed on', () => {
  // Stage X: the preamble has no cap, so the constant this line pinned is gone (tests/preamble-no-cap.test.ts).
  const ok = validateRequest({
    op: 'run',
    agent: 'scout',
    id: 'a',
    goal: 'x',
    preamble: '  Shared text for every agent.\n',
  });
  assert.equal(ok.ok, true);
  assert.equal(loose(ok.message).preamble, 'Shared text for every agent.');
  assert.equal(
    loose(validateRequest({ op: 'run', agent: 'scout', id: 'a', goal: 'x', preamble: 'é'.repeat(8000) })).message
      .preamble.length,
    8000,
    'at the cap: kept'
  );
  assert.equal(
    Object.hasOwn(
      loose(validateRequest({ op: 'run', agent: 'scout', id: 'a', goal: 'x', preamble: '   ' })).message as object,
      'preamble'
    ),
    false
  );
  assert.equal(
    Object.hasOwn(
      loose(validateRequest({ op: 'run', agent: 'scout', id: 'a', goal: 'x' })).message as object,
      'preamble'
    ),
    false
  );
});

test('validateRequest / parseRequestLine: a non-string preamble is refused with its code, never its text', () => {
  for (const preamble of [42, null, ['PREAMBLE-TEXT'], { text: 'PREAMBLE-TEXT' }, true]) {
    assert.deepEqual(
      validateRequest({ op: 'run', agent: 'scout', id: 'a', goal: 'x', preamble }),
      { ok: false, error: 'bad-preamble' },
      JSON.stringify(preamble)
    );
  }
  // Stage X: the owner removed the preamble cap, so the over-long case and its `preamble-too-long` code are gone; the
  // refusal that leaks no text is checked on a non-string preamble instead.
  const parsed = parseRequestLine(
    JSON.stringify({ op: 'run', agent: 'scout', id: 'task-p', goal: 'g', preamble: { text: 'PREAMBLE-TEXT' } })
  );
  assert.deepEqual(parsed, { ok: false, error: 'bad-preamble', id: 'task-p' });
  assert.ok(!encodeLine(errorEvent(parsed.error, parsed.id)).includes('PREAMBLE-TEXT'));
});

// src/agent-runner/protocol.ts: the optional `provider` of a route, the OpenRouter provider an opencode run is pinned to.
// Pure; no I/O.

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
  const checked = validateRequest({ op: 'run', agent: 'scout', id: 'a', goal: 'x', route: PINNED });
  assert.ok(checked.ok);
  assert.ok(checked.message.op === 'run');
  assert.deepEqual(checked.message.route, PINNED);
});

test('validateRequest refuses a provider on a claude route as bad-route', () => {
  // Catches: the refusal has another code, or none, so the core cannot tell the owner what was wrong.
  const route = { ...PINNED, backend: 'claude' };
  assert.deepEqual(validateRequest({ op: 'run', agent: 'scout', id: 'a', goal: 'x', route }), {
    ok: false,
    error: 'bad-route',
  });
});

// src/agent-runner/protocol.ts: the `route` of a `run`, the path the core decided for the task. Pure; no I/O.

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
    const checked = validateRequest({ op: 'run', agent: 'scout', id: 'a', goal: 'x', route });
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
    assert.deepEqual(validateRequest({ op: 'run', agent: 'scout', id: 'a', goal: 'x', route }), {
      ok: false,
      error: 'bad-route',
    });
  });
}

test('parseRequestLine keeps the task id of a refused route and names no value of it', () => {
  // Catches: the refusal has no id, so the core waits for the errand's whole time cap, or a value travels back in the error.
  const line = JSON.stringify({
    op: 'run',
    agent: 'scout',
    id: 'task-r',
    goal: 'g',
    route: { ...ROUTE, key: 'sk-SECRET' },
  });
  assert.deepEqual(parseRequestLine(line), { ok: false, error: 'bad-route', id: 'task-r' });
});
