// The inner life on the owner's `/nep status` card: the `inner` field shows the inner life's status
// (mode, switch, turns, chains, dollars, next wake, last turn, open intentions) through
// `labels.status.inner`; it is absent with features.innerLife off, hidden from a member, and
// `field:inner` shows it alone. A fake inner life with the real status shape; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runOp } from '../src/ops/index.js';
import { createOpsEnv } from '../src/ops/env.js';
import { createDiscordInterface } from '../src/interface/discord.js';
import { innerLines } from '../src/ops/status.js';
import { tempDir } from './fixtures/tmp.js';

const DISCORD = createDiscordInterface().capabilities;
const AT = Date.parse('2026-10-19T12:30:00Z');

const LABELS = {
  modeLine: 'mode {mode} / {state}',
  running: 'running',
  stopped: 'stopped since {at}',
  turnsLine: 'turns {used}, chains {chains}',
  usdLine: 'usd {spent}',
  nextLine: 'next {at} ({kind})',
  nextNone: 'next: none',
  heartbeatLine: 'heartbeat {at}',
  heartbeatOff: 'heartbeat off',
  nextKinds: { queue: 'queued', intention: 'intention', review: 'review' },
  lastLine: 'last {outcome} at {at}',
  lastNone: 'last: none',
  lastErrorLine: 'error {code} at {at}',
  outcomeUnknown: '?',
  intentionsLine: 'open {pending}/{waiting}/{proposed}',
  attentionLine: 'attention {open} open, wakes {listed}/{run}/{spoken}/{skipped}/{waiting}',
  tokensLine: 'core tokens {prompt} ({cached}) + {completion}',
};

const STATUS = {
  on: true,
  mode: 'shadow',
  stopped: false,
  stoppedAt: null,
  turnsToday: 3,
  chains: 2,
  spentUsd: 0.6,
  intentions: { pending: 2, waiting: 1, proposed: 4 },
  attention: { open: 1, listed: 5, run: 4, spoken: 1, skipped: 3, waiting: 1 },
  next: { at: AT + 3600000, kind: 'review' },
  lastTurn: { at: AT, outcome: 'skip' },
};

function envOf({ innerLife = true, status = STATUS, usage = null } = {}) {
  const hot = {
    config: {
      bot: { owners: ['42'], access: { 'status.show': { everyone: false, roles: ['staff'], users: [] } } },
      features: { innerLife },
      llm: { maxRequestsPerDay: 10, probeTimeoutMs: 50 },
    },
    prompts: { labels: { status: { inner: LABELS } } },
    promptSources: {},
    rootDir: tempDir('nep-status-inner-'),
  };
  const store = { state: { data: {}, markDirty() {} }, flush() {} };
  const seen = [];
  const inner = { status: (guildId) => (seen.push(guildId), status) };
  return {
    env: createOpsEnv({ discord: DISCORD, hot, store, client: {}, getGuildId: () => 'g1', inner, usage }),
    seen,
  };
}

const show = async (env, args, userId) =>
  (await runOp('status.show', args, { env, guildId: 'g1', userId, roleIds: [] })).data.embeds[0].fields;
const showMember = async (env, args) =>
  (await runOp('status.show', args, { env, guildId: 'g1', userId: '7', roleIds: ['staff'] })).data.embeds[0].fields;

test("status inner: the owner reads the inner life's lines through the labels; field:inner shows it alone", async () => {
  const { env, seen } = envOf();
  const fields = await show(env, { field: 'inner' }, '42');
  assert.deepEqual(
    fields.map((f) => f.name),
    ['inner']
  );
  assert.deepEqual(fields[0].value.split('\n'), [
    'mode shadow / running',
    'turns 3, chains 2',
    'usd 0.60',
    'next 2026-10-19 13:30 UTC (review)',
    'last skip at 2026-10-19 12:30 UTC',
    'open 2/1/4',
    'attention 1 open, wakes 5/4/1/3/1',
  ]);
  assert.deepEqual(seen, ['g1']);
});

test("status inner: the core role's tokens today come from the usage accumulator; without a row the line is left out", async () => {
  const usage = {
    byRole: () => [
      { role: 'analyzer', requests: 9, promptTokens: 1, cachedTokens: 0, completionTokens: 1, cost: 0 },
      { role: 'core', requests: 3, promptTokens: 12000, cachedTokens: 9000, completionTokens: 800, cost: 0.4 },
    ],
  };
  const { env } = envOf({ usage });
  const lines = (await show(env, { field: 'inner' }, '42'))[0].value.split('\n');
  assert.equal(lines.at(-1), 'core tokens 12000 (9000) + 800');
  const none = envOf({ usage: { byRole: () => [] } });
  assert.ok(!(await show(none.env, { field: 'inner' }, '42'))[0].value.includes('core tokens'));
  assert.deepEqual(
    innerLines(
      { ...STATUS, attention: null },
      { status: { inner: LABELS } },
      { tokens: { prompt: 1, cached: 2, completion: 3 } }
    ).at(-1),
    'core tokens 1 (2) + 3'
  );
});

test('status inner: in the whole card, between costs.development and limits', async () => {
  const { env } = envOf();
  const names = (await show(env, {}, '42')).map((f) => f.name);
  assert.ok(
    names.indexOf('inner') > names.indexOf('costs.development') && names.indexOf('inner') < names.indexOf('limits'),
    names.join()
  );
});

test('status inner: absent with features.innerLife off, hidden from a member', async () => {
  const off = envOf({ innerLife: false });
  assert.ok(!(await show(off.env, {}, '42')).some((f) => f.name === 'inner'));
  assert.deepEqual(off.seen, [], 'nothing read');
  const { env, seen } = envOf();
  assert.ok(!(await showMember(env, {})).some((f) => f.name === 'inner'));
  assert.ok(
    !(await showMember(env, { field: 'inner' })).some((f) => f.name === 'inner'),
    'a member asking for it gets the card without it'
  );
  assert.deepEqual(seen, []);
});

test('status inner: a stopped inner life, no wake known, no turn yet', () => {
  const lines = innerLines(
    {
      ...STATUS,
      mode: 'live',
      stopped: true,
      stoppedAt: AT,
      next: null,
      lastTurn: null,
      intentions: null,
      attention: null,
    },
    { status: { inner: LABELS } }
  );
  assert.deepEqual(lines, [
    'mode live / stopped since 2026-10-19 12:30 UTC',
    'turns 3, chains 2',
    'usd 0.60',
    'next: none',
    'last: none',
  ]);
  assert.equal(
    innerLines({ ...STATUS, lastTurn: { at: AT, outcome: null } }, { status: { inner: LABELS } })[4],
    'last ? at 2026-10-19 12:30 UTC'
  );
  assert.deepEqual(innerLines(STATUS, {}), [], 'no labels, no lines');
});

test('innerLines: the last failed turn shows its code and moment after the last-turn line; none without one', () => {
  const lines = innerLines({ ...STATUS, lastError: { at: AT, code: 'provider-limit' } }, { status: { inner: LABELS } });
  assert.equal(lines[5], 'error provider-limit at 2026-10-19 12:30 UTC');
  assert.equal(
    innerLines({ ...STATUS, lastError: null }, { status: { inner: LABELS } }).some((line) => line.startsWith('error ')),
    false
  );
});

test('status inner: the next heartbeat has its own line; off says so; a status without the field adds nothing', () => {
  const labels = { status: { inner: LABELS } };
  const lines = (heartbeat) => innerLines({ ...STATUS, heartbeat }, labels);
  assert.ok(lines({ nextAt: AT + 7200000, lastAt: null }).includes('heartbeat 2026-10-19 14:30 UTC'));
  assert.ok(lines(null).includes('heartbeat off'));
  assert.ok(!lines({ nextAt: null, lastAt: null }).some((line) => line.startsWith('heartbeat')));
  assert.ok(!innerLines(STATUS, labels).some((line) => line.startsWith('heartbeat')));
});

test('status.show part: her call defaults to the overview, a part holds its fields, models are named and never probed, a member sees only what a member may', async () => {
  const { env } = envOf();
  const persona = async (args, userId = '42') =>
    (
      await runOp('status.show', args, {
        env,
        guildId: 'g1',
        userId,
        roleIds: userId === '42' ? [] : ['staff'],
        actor: 'persona',
      })
    ).data.embeds[0].fields;
  assert.deepEqual(
    (await persona({})).map((f) => f.name),
    ['state', 'limits'],
    'no part: the short overview'
  );
  assert.deepEqual(
    (await persona({ part: 'limits' })).map((f) => f.name),
    ['limits', 'costs.base']
  );
  assert.deepEqual(
    (await persona({ part: 'models' })).map((f) => f.name),
    ['models.base', 'models.errands', 'models.development']
  );
  assert.deepEqual(
    (await persona({ part: 'errands' })).map((f) => f.name),
    ['tasks', 'costs.errands', 'costs.development']
  );
  assert.deepEqual(
    (await persona({ part: 'inner' })).map((f) => f.name),
    ['inner']
  );
  assert.deepEqual(
    (await persona({ part: 'memory' })).map((f) => f.name),
    ['memory']
  );
  assert.ok((await persona({ part: 'all' })).length > 8, 'all is the whole card');
  const owner = (await runOp('status.show', {}, { env, guildId: 'g1', userId: '42', roleIds: [] })).data.embeds[0]
    .fields;
  assert.ok(owner.length > 8, 'the owner command without a part keeps the whole card');
  assert.deepEqual(
    (await persona({ part: 'inner' }, '7')).map((f) => [f.name, f.value]),
    [['inner', '-']],
    'a member gets nothing of the owner parts'
  );
  assert.deepEqual(
    (await persona({}, '7')).map((f) => f.name),
    ['state', 'limits']
  );
});

test('status.show part=features: each boolean switch of the live config, sorted, on or off', async () => {
  const { env } = envOf();
  env.hot.config.features = { innerLife: true, zeta: false, alpha: true, mode: 'x' };
  const fields = (
    await runOp(
      'status.show',
      { part: 'features' },
      { env, guildId: 'g1', userId: '7', roleIds: ['staff'], actor: 'persona' }
    )
  ).data.embeds[0].fields;
  assert.deepEqual(
    fields.map((f) => [f.name, f.value.split('\n')]),
    [['features', ['alpha on', 'innerLife on', 'zeta off']]]
  );
});
