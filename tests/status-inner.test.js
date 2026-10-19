// The inner life on the owner's `/nep status` card: the `inner` field shows the inner life's status
// (mode, switch, turns, chains, dollars, posts, next wake, last turn, open intentions) through
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
  turnsLine: 'turns {used}/{cap}, chains {chains}',
  usdLine: 'usd {spent} + {held} / {cap}',
  postsLine: 'posts {used}/{cap}',
  nextLine: 'next {at} ({kind})',
  nextNone: 'next: none',
  nextKinds: { queue: 'queued', intention: 'intention', review: 'review' },
  lastLine: 'last {outcome} at {at}',
  lastNone: 'last: none',
  outcomeUnknown: '?',
  intentionsLine: 'open {pending}/{waiting}/{proposed}',
};

const STATUS = {
  on: true,
  mode: 'shadow',
  stopped: false,
  stoppedAt: null,
  budgets: { day: { used: 3, cap: 24 }, usd: { used: 0.9, cap: 4 }, posts: { used: 1, cap: 2 } },
  chains: 2,
  spentUsd: 0.6,
  heldUsd: 0.3,
  intentions: { pending: 2, waiting: 1, proposed: 4 },
  next: { at: AT + 3600000, kind: 'review' },
  lastTurn: { at: AT, outcome: 'skip' },
};

function envOf({ innerLife = true, status = STATUS } = {}) {
  const hot = {
    config: { bot: { owners: ['42'], access: { 'status.show': { everyone: false, roles: ['staff'], users: [] } } }, features: { innerLife }, llm: { maxRequestsPerDay: 10, probeTimeoutMs: 50 } },
    prompts: { labels: { status: { inner: LABELS } } },
    promptSources: {},
    rootDir: tempDir('nep-status-inner-'),
  };
  const store = { state: { data: {}, markDirty() {} }, flush() {} };
  const seen = [];
  const inner = { status: (guildId) => (seen.push(guildId), status) };
  return { env: createOpsEnv({ discord: DISCORD, hot, store, client: {}, getGuildId: () => 'g1', inner }), seen };
}

const show = async (env, args, userId) => (await runOp('status.show', args, { env, guildId: 'g1', userId, roleIds: [] })).data.embeds[0].fields;
const showMember = async (env, args) => (await runOp('status.show', args, { env, guildId: 'g1', userId: '7', roleIds: ['staff'] })).data.embeds[0].fields;

test('status inner: the owner reads the inner life\'s lines through the labels; field:inner shows it alone', async () => {
  const { env, seen } = envOf();
  const fields = await show(env, { field: 'inner' }, '42');
  assert.deepEqual(fields.map((f) => f.name), ['inner']);
  assert.deepEqual(fields[0].value.split('\n'), [
    'mode shadow / running',
    'turns 3/24, chains 2',
    'usd 0.60 + 0.30 / 4',
    'posts 1/2',
    'next 2026-10-19 13:30 UTC (review)',
    'last skip at 2026-10-19 12:30 UTC',
    'open 2/1/4',
  ]);
  assert.deepEqual(seen, ['g1']);
});

test('status inner: in the whole card, between costs.agents and limits', async () => {
  const { env } = envOf();
  const names = (await show(env, {}, '42')).map((f) => f.name);
  assert.ok(names.indexOf('inner') > names.indexOf('costs.agents') && names.indexOf('inner') < names.indexOf('limits'), names.join());
});

test('status inner: absent with features.innerLife off, hidden from a member', async () => {
  const off = envOf({ innerLife: false });
  assert.ok(!(await show(off.env, {}, '42')).some((f) => f.name === 'inner'));
  assert.deepEqual(off.seen, [], 'nothing read');
  const { env, seen } = envOf();
  assert.ok(!(await showMember(env, {})).some((f) => f.name === 'inner'));
  assert.ok(!(await showMember(env, { field: 'inner' })).some((f) => f.name === 'inner'), 'a member asking for it gets the card without it');
  assert.deepEqual(seen, []);
});

test('status inner: a stopped inner life, no wake known, no turn yet', () => {
  const lines = innerLines({ ...STATUS, mode: 'live', stopped: true, stoppedAt: AT, next: null, lastTurn: null, intentions: null }, { status: { inner: LABELS } });
  assert.deepEqual(lines, ['mode live / stopped since 2026-10-19 12:30 UTC', 'turns 3/24, chains 2', 'usd 0.60 + 0.30 / 4', 'posts 1/2', 'next: none', 'last: none']);
  assert.equal(innerLines({ ...STATUS, lastTurn: { at: AT, outcome: null } }, { status: { inner: LABELS } })[5], 'last ? at 2026-10-19 12:30 UTC');
  assert.deepEqual(innerLines(STATUS, {}), [], 'no labels, no lines');
});
