// Tests for tools/lib/warmup.mjs: the pure part of tools/warmup.mjs -- the argument rules, the
// refusal while the bot runs, the plan of a run and its estimate, and the report lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  BOT_STOP_COMMAND,
  DEFAULT_USD_PER_KTOK,
  assertBotStopped,
  formatPeople,
  formatStatus,
  formatUserWritten,
  formatWarmupPhase,
  humanizeAgo,
  parseWarmupArgs,
  warmupEstimate,
  warmupPlan,
} from '../tools/lib/warmup.mjs';
import { CliError } from '../tools/lib/cli.mjs';

// ---- arguments ---------------------------------------------------------------------------------

test('warmup args: every subcommand with its own flags', () => {
  assert.deepEqual(parseWarmupArgs(['run', '--spend', '12', '--max-usd', '10']), {
    sub: 'run', guildId: undefined, userId: undefined, channelId: undefined, spend: '12', maxUsd: 10, usdPerKTok: DEFAULT_USD_PER_KTOK, dryRun: false, data: undefined,
  });
  assert.equal(parseWarmupArgs(['users', '--user', '123456789012345678']).userId, '123456789012345678');
  assert.equal(parseWarmupArgs(['channels', '--channel', '42', '--dry-run']).dryRun, true);
  assert.equal(parseWarmupArgs(['server', '--guild', '777']).guildId, '777');
  assert.equal(parseWarmupArgs(['people']).sub, 'people');
  assert.equal(parseWarmupArgs(['status', '--guild', '777']).sub, 'status');
  assert.equal(parseWarmupArgs(['reset']).sub, 'reset');
  assert.equal(parseWarmupArgs(['run', '--usd-per-ktok', '0.02']).usdPerKTok, 0.02);
});

test('warmup args: a missing or unknown subcommand, a flag of another subcommand or a bad value is a CliError', () => {
  const bad = [
    [],
    ['warm'],
    ['run', 'extra'],
    ['run', '--user', '1'],
    ['users', '--channel', '1'],
    ['channels', '--user', '1'],
    ['people', '--spend', '1'],
    ['status', '--dry-run'],
    ['reset', '--max-usd', '1'],
    ['users', '--user', 'alice'],
    ['channels', '--channel', '12x'],
    ['run', '--max-usd', '-1'],
    ['run', '--max-usd', 'many'],
    ['run', '--usd-per-ktok', '0'],
    ['run', '--spend'],
    ['run', '--force'],
  ];
  for (const argv of bad) assert.throws(() => parseWarmupArgs(argv), CliError, argv.join(' '));
});

// ---- the running bot ---------------------------------------------------------------------------

test('warmup: refused while the bot runs (its journal marker), naming the stop command', () => {
  const guildDir = path.join('data', 'guilds', '777');
  const seen = [];
  const exists = (file) => {
    seen.push(file);
    return file === path.join(guildDir, 'journal', '.running');
  };
  assert.throws(
    () => assertBotStopped(guildDir, { exists }),
    (err) => err instanceof CliError && err.message.includes(BOT_STOP_COMMAND) && err.message.includes('systemctl stop neptunia-bot'),
  );
  assert.deepEqual(seen, [path.join(guildDir, 'journal', '.running')]);
  assert.doesNotThrow(() => assertBotStopped(guildDir, { exists: () => false }));
});

// ---- the plan and the estimate -----------------------------------------------------------------

const progress = { channels: ['c1'], people: ['p1'], server: false };

test('warmup plan: run skips what is done, a redo takes every target, a single target is one request', () => {
  const channels = ['c1', 'c2', 'c3'];
  const people = [{ id: 'p1' }, { id: 'p2' }];
  assert.deepEqual(warmupPlan({ sub: 'run', done: progress, channels, people }), { channels: 2, people: 1, server: 1, requests: 4 });
  assert.deepEqual(warmupPlan({ sub: 'run', done: { channels, people: ['p1', 'p2'], server: true }, channels, people }), { channels: 0, people: 0, server: 0, requests: 0 });
  assert.deepEqual(warmupPlan({ sub: 'users', done: progress, channels, people }), { channels: 0, people: 2, server: 0, requests: 2 });
  assert.deepEqual(warmupPlan({ sub: 'users', userId: 'p9', done: progress, channels, people }), { channels: 0, people: 1, server: 0, requests: 1 });
  assert.deepEqual(warmupPlan({ sub: 'channels', done: progress, channels, people }), { channels: 3, people: 0, server: 0, requests: 3 });
  assert.deepEqual(warmupPlan({ sub: 'channels', channelId: 'c1', done: progress, channels, people }), { channels: 1, people: 0, server: 0, requests: 1 });
  assert.deepEqual(warmupPlan({ sub: 'server', done: { ...progress, server: true }, channels, people }), { channels: 0, people: 0, server: 1, requests: 1 });
});

test('warmup estimate: every request at the per-request cap, within the budget left and --max-usd', () => {
  const config = { warmup: { maxRequestTokens: 100_000, maxTokens: 1_000_000 } };
  assert.deepEqual(warmupEstimate({ config, tokensUsed: 0, requests: 3, usdPerKTok: 0.01 }), {
    requests: 3, tokens: 300_000, usd: 3, ceiling: 300_000, limitedBy: 'requests',
  });
  assert.deepEqual(warmupEstimate({ config, tokensUsed: 900_000, requests: 3, usdPerKTok: 0.01 }), {
    requests: 3, tokens: 100_000, usd: 1, ceiling: 1_000_000, limitedBy: 'budget',
  });
  assert.deepEqual(warmupEstimate({ config, tokensUsed: 100_000, requests: 3, maxUsd: 0.5, usdPerKTok: 0.01 }), {
    requests: 3, tokens: 50_000, usd: 0.5, ceiling: 150_000, limitedBy: 'max-usd',
  });
  assert.deepEqual(warmupEstimate({ config, tokensUsed: 1_200_000, requests: 3, usdPerKTok: 0.01 }), {
    requests: 3, tokens: 0, usd: 0, ceiling: 1_200_000, limitedBy: 'budget',
  });
  assert.deepEqual(warmupEstimate({ config, tokensUsed: 0, requests: 0, usdPerKTok: 0.01 }), {
    requests: 0, tokens: 0, usd: 0, ceiling: 0, limitedBy: 'requests',
  });
  // No budget set: only the requests and --max-usd bound it, as the engine reads a missing one.
  assert.equal(warmupEstimate({ config: { warmup: { maxRequestTokens: 10 } }, tokensUsed: 5, requests: 2, usdPerKTok: 1 }).tokens, 20);
});

// ---- report lines ------------------------------------------------------------------------------

test('warmup people: one line per qualifying member, then the totals', () => {
  const text = formatPeople({
    ok: true,
    people: [{ id: '1', name: 'Ζωή', messages: 40, firstTs: Date.parse('2026-09-01T10:00:00Z'), lastTs: Date.parse('2026-10-01T10:00:00Z'), byChannel: { c1: 30, c2: 10 } }],
    totals: { channelsRead: 3, messagesRead: 500, belowThreshold: 2 },
  });
  assert.equal(text.split('\n')[0], '1. Ζωή (id:1) — 40 messages, 2026-09-01..2026-10-01, top channels: c1:30, c2:10');
  assert.match(text, /channels read: 3\nmessages read: 500\npeople below the threshold: 2/);
  assert.equal(formatPeople({ ok: false, message: 'no guild resolved yet' }), 'no guild resolved yet');
});

test('warmup user: the summary of what was written, or why nothing was', () => {
  const text = formatUserWritten({
    ok: true,
    member: { id: '1', name: 'Zoé' },
    answer: { character: 'Calm.', interests: [{}], details: [{}, {}], episodes: [], aliases: ['Z'] },
    sample: { ownCount: 10, contextCount: 5 },
    tokensUsed: 1234,
    chunks: 2,
  });
  assert.match(text, /^profiled Zoé \(id:1\)\nsample: 10 own \/ 5 context lines, 2 chunks\ntokens used: 1234\n/);
  assert.match(text, /interests: 1, details: 2, episodes: 0, aliases: 1\ncharacter: Calm\.$/);
  assert.equal(formatUserWritten({ ok: false, reason: 'nothing-to-sample' }), 'nothing-to-sample');
});

test('warmup status: phase, progress, tokens against the budget, next target', () => {
  const text = formatStatus(
    {
      phase: 'idle', doneChannels: 1, channelsEligible: null, donePeople: 3, peopleEligible: null, doneServer: false,
      tokensUsed: 1000, requests: 4, startedAt: '2026-10-01T00:00:00.000Z', finishedAt: null, aborted: 'budget', nextTarget: null,
      activity: { phase: 'idle', detail: null, lastActivityAt: null },
    },
    { maxTokens: 6_000_000, now: 0 },
  );
  assert.deepEqual(text.split('\n'), [
    'phase: idle',
    'last activity: never',
    'channels: 1/?',
    'people: 3/?',
    'server: pending',
    'tokens used: 1000 / 6000000',
    'requests: 4',
    'started: 2026-10-01T00:00:00.000Z',
    'finished: -',
    'aborted: budget',
    'next target: -',
  ]);
});

test('warmup phase: the activity snapshot read as a line, the coarse phase without one', () => {
  assert.equal(formatWarmupPhase({ activity: { phase: 'fetching', detail: { channelsFetched: 2, channelsTotal: 5 } } }), 'fetching history, 2/5 channels');
  assert.equal(formatWarmupPhase({ activity: { phase: 'person', detail: { id: '1', name: 'Ζωή', index: 2, total: 4, chunk: { k: 1, n: 2 } } } }), 'profiling Ζωή (id:1) (2 of 4), chunk 1/2');
  assert.equal(formatWarmupPhase({ activity: { phase: 'aborted', detail: { reason: 'budget' } } }), 'aborted (budget)');
  assert.equal(formatWarmupPhase({ phase: 'finished' }), 'finished');
  assert.equal(humanizeAgo(1000, 61_000), '1 min ago');
  assert.equal(humanizeAgo(undefined, 5), 'never');
});
