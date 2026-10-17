// Tests for src/agent-runner/protocol.js: validation of the core's `run`,
// `cancel` and `ping` (ids, goal length, context scope, limit keys, model,
// cost, search provider, secrets -- never echoed back), the decode of a line
// (bad JSON, oversize), the http form of a proxy URL, and the shapes of the
// runner's `progress`, `end`, `pong`, `restarted` and `error` events, including
// the frozen RESULT_STATUSES. Pure; no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESULT_STATUSES, OPS, validateRequest, parseRequestLine, encodeLine,
  progressEvent, endEvent, restartedEvent, pongEvent, errorEvent, normalizeUsage, normalizeResult,
  SECRET_KEYS, httpProxyForm,
} from '../src/agent-runner/protocol.js';

test('RESULT_STATUSES: the three final states, frozen', () => {
  assert.deepEqual([...RESULT_STATUSES], ['done', 'failed', 'cancelled']);
  assert.ok(Object.isFrozen(RESULT_STATUSES));
  assert.ok(Object.isFrozen(OPS));
});

test('validateRequest: a full run passes and is normalised', () => {
  const r = validateRequest({
    op: 'run', id: 'task-1', goal: '  find a meme  ',
    context: { scope: 'dm', asker: 'Theodora' },
    limits: { steps: 10, usd: 0.5, seconds: 60 },
    tools: ['search', 'search', 'fetch'], model: 'x-ai/grok-4.7',
    cost: { input: 2, output: 6 }, searchProvider: 'exa',
  });
  assert.equal(r.ok, true);
  assert.equal(r.message.goal, 'find a meme');
  assert.deepEqual(r.message.tools, ['search', 'fetch']);
  assert.deepEqual(r.message.cost, { input: 2, output: 6 });
  assert.equal(r.message.context.scope, 'dm');
});

test('validateRequest: run needs a non-empty goal and an id', () => {
  assert.equal(validateRequest({ op: 'run', id: 'a' }).error, 'bad-goal');
  assert.equal(validateRequest({ op: 'run', id: 'a', goal: '   ' }).error, 'bad-goal');
  assert.equal(validateRequest({ op: 'run', goal: 'x' }).error, 'bad-id');
  assert.equal(validateRequest({ op: 'run', id: 'bad id!', goal: 'x' }).error, 'bad-id');
});

test('validateRequest: a bad scope, limit, cost or search provider is refused', () => {
  assert.equal(validateRequest({ op: 'run', id: 'a', goal: 'x', context: { scope: 'nope' } }).error, 'bad-scope');
  assert.equal(validateRequest({ op: 'run', id: 'a', goal: 'x', limits: { steps: -1 } }).error, 'bad-limits');
  assert.equal(validateRequest({ op: 'run', id: 'a', goal: 'x', limits: { nope: 1 } }).error, 'bad-limits');
  assert.equal(validateRequest({ op: 'run', id: 'a', goal: 'x', cost: { input: -1, output: 2 } }).error, 'bad-cost');
  assert.equal(validateRequest({ op: 'run', id: 'a', goal: 'x', searchProvider: 'Exa!' }).error, 'bad-search-provider');
});

test('validateRequest: a run carries its secrets, each a non-empty string; only the known keys', () => {
  assert.deepEqual([...SECRET_KEYS], ['openrouterKey', 'proxy', 'searchKey']);
  const full = validateRequest({ op: 'run', id: 'a', goal: 'x', secrets: { openrouterKey: 'sk-or-1', proxy: 'http://u:p@proxy.example:8000', searchKey: 'srch-1' } });
  assert.equal(full.ok, true);
  assert.deepEqual(full.message.secrets, { openrouterKey: 'sk-or-1', proxy: 'http://u:p@proxy.example:8000', searchKey: 'srch-1' });
  const keyOnly = validateRequest({ op: 'run', id: 'a', goal: 'x', secrets: { openrouterKey: 'sk-or-1' } });
  assert.deepEqual(keyOnly.message.secrets, { openrouterKey: 'sk-or-1' });
  assert.equal(Object.hasOwn(validateRequest({ op: 'run', id: 'a', goal: 'x' }).message, 'secrets'), false, 'none given: none passed on');
});

test('validateRequest / parseRequestLine: refused secrets come back as a code, never the secret', () => {
  const secret = 'sk-or-v1-VERYSECRET';
  const bad = [
    { openrouterKey: '' },
    { openrouterKey: 42 },
    { proxy: 'http://proxy.example:8000' },
    { openrouterKey: secret, proxy: '' },
    { openrouterKey: secret, searchKey: ['x'] },
    { openrouterKey: secret, other: 'x' },
    { openrouterKey: `${secret} with space` },
    { openrouterKey: secret.repeat(200) },
    'sk-or-v1-VERYSECRET',
  ];
  for (const secrets of bad) {
    const checked = validateRequest({ op: 'run', id: 'a', goal: 'x', secrets });
    assert.deepEqual(checked, { ok: false, error: 'bad-secrets' }, JSON.stringify(secrets).slice(0, 60));
    assert.ok(!JSON.stringify(checked).includes('VERYSECRET'));
  }
  // A run refused for another reason while carrying good secrets: the refusal and its error event name no secret.
  const line = JSON.stringify({ op: 'run', id: 'task-7', goal: '', secrets: { openrouterKey: secret, proxy: 'http://u:VERYSECRET@p.example:1', searchKey: secret } });
  const parsed = parseRequestLine(line);
  assert.deepEqual(parsed, { ok: false, error: 'bad-goal', id: 'task-7' });
  assert.ok(!encodeLine(errorEvent(parsed.error, parsed.id)).includes('VERYSECRET'));
  const badSecrets = parseRequestLine(JSON.stringify({ op: 'run', id: 'task-8', goal: 'g', secrets: { openrouterKey: secret, extra: secret } }));
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
  assert.equal(validateRequest({ op: 'run', id: 'a', goal: long }).error, 'goal-too-long');
});

test('validateRequest: cancel and ping', () => {
  assert.deepEqual(validateRequest({ op: 'cancel', id: 'task-9' }).message, { op: 'cancel', id: 'task-9' });
  assert.deepEqual(validateRequest({ op: 'ping' }).message, { op: 'ping', ids: [] });
  assert.deepEqual(validateRequest({ op: 'ping', ids: ['a', 'a', 'b'] }).message.ids, ['a', 'b']);
  assert.equal(validateRequest({ op: 'ping', ids: ['bad id'] }).error, 'bad-ids');
  assert.equal(validateRequest({ op: 'what' }).error, 'bad-op');
  assert.equal(validateRequest('x').error, 'not-an-object');
});

test('parseRequestLine: bad JSON, oversize, and a valid id surfaced on a bad message', () => {
  assert.equal(parseRequestLine('{not json').error, 'bad-json');
  assert.equal(parseRequestLine('x'.repeat(1_000_001)).error, 'line-too-long');
  const r = parseRequestLine(JSON.stringify({ op: 'run', id: 'task-5', goal: '' }));
  assert.equal(r.ok, false);
  assert.equal(r.id, 'task-5');
});

test('progressEvent: shape, note trimmed and cut', () => {
  const e = progressEvent({ id: 'a', step: 3, tool: 'search', note: `  many   spaces  ${'x'.repeat(300)}` });
  assert.equal(e.event, 'progress');
  assert.equal(e.step, 3);
  assert.equal(e.tool, 'search');
  assert.ok(e.note.length <= 200);
  assert.equal(progressEvent({ id: 'a', step: 1 }).tool, null);
});

test('endEvent: status clamped to a known one, result and usage normalised', () => {
  const e = endEvent({ id: 'a', status: 'weird', result: { text: 'ok', sources: ['u', 'u'], files: [{ path: '/p', bytes: 3 }] }, usage: { usd: 0.1, costUnknown: 2 } });
  assert.equal(e.status, 'failed');
  assert.deepEqual(e.result.sources, ['u']);
  assert.equal(e.result.files[0].name, '');
  assert.equal(e.usage.usd, 0.1);
  assert.equal(e.usage.costUnknown, 2);
  const ok = endEvent({ id: 'a', status: 'done', result: { text: 'hi' } });
  assert.equal(ok.status, 'done');
  assert.equal(ok.error, undefined);
});

test('restarted, pong and error events', () => {
  assert.deepEqual(restartedEvent('a'), { id: 'a', event: 'end', status: 'failed', result: { text: '', sources: [], files: [] }, usage: { input: 0, output: 0, usd: 0, steps: 0, seconds: 0 }, error: 'restarted' });
  assert.deepEqual(pongEvent({ profile: 'web', busy: true, queued: 2 }), { event: 'pong', profile: 'web', busy: true, queued: 2 });
  assert.deepEqual(errorEvent('bad-op'), { event: 'error', error: 'bad-op' });
  assert.deepEqual(errorEvent('bad-goal', 'a'), { id: 'a', event: 'error', error: 'bad-goal' });
});

test('normalizeUsage and normalizeResult: non-numbers and non-objects default', () => {
  assert.deepEqual(normalizeUsage(null), { input: 0, output: 0, usd: 0, steps: 0, seconds: 0 });
  assert.deepEqual(normalizeResult('x'), { text: '', sources: [], files: [] });
});

test('normalizeResult: the withheld paths pass, each once and cut, at most 50; none or an empty list leaves the key out', () => {
  assert.deepEqual(normalizeResult({ text: 't', withheld: ['/var/www/a', '/var/www/a', '', 7, '/home/u/.ssh/id'] }).withheld, ['/var/www/a', '/home/u/.ssh/id']);
  assert.equal(Object.hasOwn(normalizeResult({ text: 't', withheld: [] }), 'withheld'), false);
  assert.equal(Object.hasOwn(normalizeResult({ text: 't', withheld: 'x' }), 'withheld'), false);
  const many = normalizeResult({ withheld: Array.from({ length: 80 }, (_, i) => `/var/www/${i}/${'x'.repeat(300)}`) }).withheld;
  assert.equal(many.length, 50);
  assert.ok(many.every((p) => p.length === 200));
  assert.deepEqual(endEvent({ id: 'a', status: 'done', result: { text: 'ok', withheld: ['/etc/shadow'] } }).result.withheld, ['/etc/shadow'], 'the end event carries them to the core');
});

test('encodeLine: one JSON object and a newline', () => {
  assert.equal(encodeLine({ a: 1 }), '{"a":1}\n');
});

test('validateRequest: context.recent passes as { author, text } lines, the latest 20 kept, each cut; a malformed line refuses bad-recent', () => {
  const line = (i) => ({ author: `Ελένη ${i}`, text: `γραμμή ${i}`, extra: 'dropped' });
  const many = Array.from({ length: 25 }, (_, i) => line(i));
  const ok = validateRequest({ op: 'run', id: 't1', goal: 'g', context: { scope: 'group', channel: 'c1', recent: many } });
  assert.equal(ok.ok, true);
  assert.equal(ok.message.context.recent.length, 20);
  assert.deepEqual(ok.message.context.recent[0], { author: 'Ελένη 5', text: 'γραμμή 5' }, 'the earliest dropped, other keys too');
  assert.equal(ok.message.context.channel, 'c1');
  const long = validateRequest({ op: 'run', id: 't1', goal: 'g', context: { recent: [{ author: 'a'.repeat(300), text: 'b'.repeat(300) }] } });
  assert.deepEqual([long.message.context.recent[0].author.length, long.message.context.recent[0].text.length], [200, 200]);
  assert.deepEqual(validateRequest({ op: 'run', id: 't1', goal: 'g', context: { recent: [] } }).message.context.recent, []);
  for (const bad of ['text', [{ author: 'a' }], [{ author: 'a', text: 3 }], [null], [['a', 'b']], [{ author: 'a', text: 'b' }, 'c']]) {
    assert.deepEqual(validateRequest({ op: 'run', id: 't1', goal: 'g', context: { recent: bad } }), { ok: false, error: 'bad-recent' }, JSON.stringify(bad));
  }
});
