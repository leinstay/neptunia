// src/watcher/routes.ts: the degraded routes the watcher reports, read from the core's journal with no model call.
// The core logs one JSON object per line; the proxy is down from the first `proxy: switch` `proxy-down` after its
// last answer (a `proxy-back`, or `proxy: route` with `proxy`) and stays down across restarts, the YouTube check from
// its first `page` or `blocked` status after a `ytdlp` or `api` one, and a harness login from the first run of its
// backend that failed on a lost login after the last step it answered. A route down longer than
// `watcher.degradedAfterMinutes` is listed with since when and for how long; route chain switches are counted in the
// observation window. The journal is text handed in, or a fake `run` that answers for journalctl; nothing is read
// from the system.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRouteFacts, routeFacts } from '../src/watcher/routes.ts';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const HOUR = 3_600_000;
const WINDOW = { from: NOW - 12 * HOUR, to: NOW };
const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

function line(msAgo: number, msg: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ level: 'info', time: at(msAgo), msg, ...fields });
}

const facts = (lines: Array<string>, options: { thresholdMinutes?: number; proxyOn?: boolean } = {}) =>
  routeFacts(lines.join('\n'), {
    now: NOW,
    window: WINDOW,
    thresholdMinutes: options.thresholdMinutes ?? 60,
    proxyOn: options.proxyOn ?? true,
  });

test('a proxy down across restarts is listed from its first fallback, with how long', () => {
  // Catches: each restart's new `proxy-down` resets the outage, so a proxy dead for four days reads as minutes old.
  const result = facts([
    line(100 * HOUR, 'proxy: route', { route: 'proxy' }),
    line(96 * HOUR, 'proxy: switch', { change: 'proxy-down' }),
    'not a json line',
    line(50 * HOUR, 'index: paths', {}),
    line(48 * HOUR, 'proxy: switch', { change: 'proxy-down' }),
    line(1 * HOUR, 'proxy: switch', { change: 'proxy-down' }),
  ]);
  assert.deepEqual(
    result.down.map(({ route, name, since, minutes }) => ({ route, name, since, minutes })),
    [{ route: 'proxy', name: 'proxy', since: at(96 * HOUR), minutes: 96 * 60 }]
  );
});

test('a proxy that answered again after its fallback is not listed', () => {
  // Catches: a recovered proxy is reported as down for good because its old fallback is still in the journal.
  for (const back of [
    line(10 * HOUR, 'proxy: switch', { change: 'proxy-back' }),
    line(10 * HOUR, 'proxy: route', { route: 'proxy' }),
  ]) {
    const result = facts([line(20 * HOUR, 'proxy: switch', { change: 'proxy-down' }), back]);
    assert.deepEqual(result.down, [], back);
  }
});

test('a route down for less than the threshold is not listed, and a lower threshold lists it', () => {
  // Catches: one lost probe a minute before the inspection becomes a finding, or the setting is ignored.
  const lines = [line(30 * 60_000, 'proxy: switch', { change: 'proxy-down' })];
  assert.deepEqual(facts(lines, { thresholdMinutes: 60 }).down, []);
  assert.equal(facts(lines, { thresholdMinutes: 20 }).down.length, 1);
});

test('a proxy switched off is not listed whatever its journal says', () => {
  // Catches: the owner turns a dead proxy off and the watcher keeps reporting it, since `proxy off` logs nothing.
  const result = facts([line(20 * HOUR, 'proxy: switch', { change: 'proxy-down' })], { proxyOn: false });
  assert.deepEqual(result.down, []);
});

test('a YouTube check that stays blocked across starts is listed from its first blocked status', () => {
  // Catches: video links failing for days at every start never reach the report.
  const result = facts([
    line(30 * HOUR, 'youtube-check: status', { status: 'ytdlp' }),
    line(20 * HOUR, 'youtube-check: status', { status: 'blocked' }),
    line(5 * HOUR, 'youtube-check: status', { status: 'page' }),
  ]);
  assert.deepEqual(
    result.down.map(({ route, since }) => ({ route, since })),
    [{ route: 'youtube', since: at(20 * HOUR) }]
  );
  const fixed = facts([
    line(20 * HOUR, 'youtube-check: status', { status: 'blocked' }),
    line(2 * HOUR, 'youtube-check: status', { status: 'api' }),
  ]);
  assert.deepEqual(fixed.down, []);
});

test('a lost harness login is listed per backend until a step of that backend answers', () => {
  // Catches: one backend's answered step clears another backend's lost login, or a login failure is never cleared.
  const result = facts([
    line(10 * HOUR, 'subscription: run failed', { backend: 'claude', code: 'subscription-login' }),
    line(9 * HOUR, 'subscription: run failed', { backend: 'codex', code: 'not-logged-in' }),
    line(8 * HOUR, 'subscription: step', { backend: 'codex', finish: 'stop' }),
    line(7 * HOUR, 'subscription: run failed', { backend: 'claude', code: 'timeout' }),
  ]);
  assert.deepEqual(
    result.down.map(({ route, name, since }) => ({ route, name, since })),
    [{ route: 'harness-login', name: 'claude', since: at(10 * HOUR) }]
  );
});

test('route chain switches are counted per role and route within the observation window only', () => {
  // Catches: a role living on its fallback route all day goes unreported, or yesterday's switches are counted again.
  const result = facts([
    line(30 * HOUR, 'llm: route switched', { role: 'core', from: 'a', to: 'b', code: 'http_502' }),
    line(6 * HOUR, 'llm: route switched', { role: 'core', from: 'a', to: 'b', code: 'http_502' }),
    line(2 * HOUR, 'llm: route switched', { role: 'core', from: 'a', to: 'b', code: 'timeout' }),
    line(1 * HOUR, 'llm: route switched', { role: 'vision', from: 'c', to: 'd', code: 'http_429' }),
  ]);
  assert.deepEqual(result.switches, [
    { role: 'core', from: 'a', to: 'b', count: 2, last: at(2 * HOUR) },
    { role: 'vision', from: 'c', to: 'd', count: 1, last: at(1 * HOUR) },
  ]);
});

test('an empty journal lists nothing', () => {
  // Catches: no line at all is read as a route that was never up.
  const result = facts([]);
  assert.deepEqual(result.down, []);
  assert.deepEqual(result.switches, []);
  assert.equal(result.unavailable, null);
});

test('readRouteFacts reads the core unit through journalctl with the configured threshold', async () => {
  // Catches: the worker reads another unit's journal, the whole unfiltered journal, or ignores the setting.
  const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  const result = await readRouteFacts({
    run: (command, args) => {
      calls.push({ command, args });
      return Promise.resolve({ code: 0, stdout: line(30 * 60_000, 'proxy: switch', { change: 'proxy-down' }) + '\n' });
    },
    env: { NEPTUNIA_UNIT_SCOPE: 'system' },
    now: NOW,
    window: WINDOW,
    config: { proxy: { enabled: true }, watcher: { degradedAfterMinutes: 10 } },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, 'journalctl');
  const args = calls[0]?.args ?? [];
  assert.equal(args[args.indexOf('-u') + 1], 'neptunia-core.service');
  assert.ok(args.includes('-g'), 'filtered by message');
  assert.equal(args.includes('--user'), false);
  assert.equal(result.thresholdMinutes, 10);
  assert.equal(result.down.length, 1);
});

test('readRouteFacts names a journal it cannot read as unavailable', async () => {
  // Catches: a watcher without journal access reports every route as healthy.
  const cases: Array<[() => Promise<{ code: number; stdout: string; stderr?: string }>, string]> = [
    [
      () =>
        Promise.resolve({
          code: 1,
          stdout: '',
          stderr: 'No journal files were opened due to insufficient permissions.',
        }),
      'journal-permission',
    ],
    [
      () => Promise.reject(Object.assign(new Error('spawn journalctl ENOENT'), { code: 'ENOENT' })),
      'journalctl-ENOENT',
    ],
  ];
  for (const [run, code] of cases) {
    const result = await readRouteFacts({ run, env: {}, now: NOW, window: WINDOW, config: {} });
    assert.equal(result.unavailable, code);
    assert.deepEqual(result.down, []);
  }
});

test('journalctl answering no entries is an empty journal, not an unavailable one', async () => {
  // Catches: journalctl's exit code 1 for a filter that matched nothing is reported as a missing journal.
  const result = await readRouteFacts({
    run: () => Promise.resolve({ code: 1, stdout: '', stderr: '-- No entries --' }),
    env: {},
    now: NOW,
    window: WINDOW,
    config: {},
  });
  assert.equal(result.unavailable, null);
});
