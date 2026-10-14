import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits, SnowflakeUtil } from 'discord.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import {
  nextDelayMs,
  isActiveHour,
  msUntilActive,
  chooseMode,
  forcedMode,
  pickChannel,
  isChannelDead,
  createSpontaneous,
  chooseRoomMode,
  someoneAround,
  initiateCooldownUntil,
} from '../src/behavior/spontaneous.js';

function snowflake(ts) {
  return SnowflakeUtil.generate({ timestamp: ts }).toString();
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const SPONTANEOUS_CFG = {
  channels: [],
  minIntervalMinutes: 25,
  maxIntervalMinutes: 420,
  burstChance: 0.15,
  burstMinutes: [3, 15],
  activeHours: { from: 10, to: 3 },
  liveWindowMinutes: 15,
  liveMinMessages: 4,
  deadAfterMinutes: 90,
  initiateChance: 0.35,
  eavesdropChance: 0.02,
  eavesdropDelayMs: [5000, 40000],
  minGapMinutes: 12,
};

function scripted(values) {
  const queue = [...values];
  return () => {
    if (queue.length === 0) throw new Error('scripted rng ran out of values');
    return queue.shift();
  };
}

// ---------------------------------------------------------------------------
// nextDelayMs

test('nextDelayMs: burst branch returns ms inside cfg.burstMinutes', () => {
  const rng = scripted([0.1, 0]); // < burstChance (0.15), then min of the burst range
  const ms = nextDelayMs(SPONTANEOUS_CFG, rng);
  assert.equal(ms, SPONTANEOUS_CFG.burstMinutes[0] * MINUTE);
});

test('nextDelayMs: non-burst branch is log-uniform between min and max minutes', () => {
  // Log-uniform: a roll u lands on min * (max / min) ** u minutes, so equal steps of
  // the roll multiply the delay by the same factor and the middle roll is the
  // geometric mean of min and max (about 102 minutes here), not the arithmetic
  // mean (222.5 minutes) a linear draw would give.
  const min = SPONTANEOUS_CFG.minIntervalMinutes;
  const max = SPONTANEOUS_CFG.maxIntervalMinutes;
  const delay = (roll) => nextDelayMs(SPONTANEOUS_CFG, scripted([0.99, roll])); // 0.99 skips the burst branch

  assert.ok(Math.abs(delay(0.5) - Math.sqrt(min * max) * MINUTE) < 1e-3, 'rng 0.5 lands on the geometric mean');
  for (let i = 0; i <= 10; i++) {
    const roll = i / 10;
    const ms = delay(roll);
    assert.ok(Math.abs(ms - min * (max / min) ** roll * MINUTE) < 1e-3, `rng ${roll}: ${ms} ms is not log-uniform`);
    assert.ok(ms >= min * MINUTE - 1e-6 && ms <= max * MINUTE + 1e-6, `rng ${roll}: ${ms} ms out of bounds`);
  }
});

// ---------------------------------------------------------------------------
// isActiveHour

test('isActiveHour: normal (non-wrapping) window', () => {
  const hours = { from: 9, to: 17 };
  assert.equal(isActiveHour(9, hours), true);
  assert.equal(isActiveHour(16, hours), true);
  assert.equal(isActiveHour(17, hours), false);
  assert.equal(isActiveHour(8, hours), false);
});

test('isActiveHour: window wraps over midnight', () => {
  const hours = { from: 10, to: 3 };
  assert.equal(isActiveHour(10, hours), true);
  assert.equal(isActiveHour(23, hours), true);
  assert.equal(isActiveHour(0, hours), true);
  assert.equal(isActiveHour(2, hours), true);
  assert.equal(isActiveHour(3, hours), false);
  assert.equal(isActiveHour(9, hours), false);
});

test('isActiveHour: from === to means always active', () => {
  const hours = { from: 5, to: 5 };
  for (let h = 0; h < 24; h++) assert.equal(isActiveHour(h, hours), true);
});

// ---------------------------------------------------------------------------
// msUntilActive

test('msUntilActive: 0 when already inside an active hour', () => {
  // 2026-01-05T12:00:00Z -> UTC hour 12, inside 10-20
  const now = Date.UTC(2026, 0, 5, 12, 0, 0);
  const ms = msUntilActive(now, 'UTC', { from: 10, to: 20 }, () => 0.5);
  assert.equal(ms, 0);
});

test('msUntilActive: lands inside the active window when currently asleep', () => {
  // 2026-01-05T05:00:00Z -> UTC hour 5, outside the wide 10-to-3 window used in config.json
  const now = Date.UTC(2026, 0, 5, 5, 0, 0);
  for (const rngValue of [0, 0.5, 1]) {
    const ms = msUntilActive(now, 'UTC', { from: 10, to: 3 }, () => rngValue);
    assert.ok(ms > 0, 'should be positive since the persona is asleep');
    const wakeHour = new Date(now + ms).getUTCHours();
    assert.equal(isActiveHour(wakeHour, { from: 10, to: 3 }), true, `hour ${wakeHour} should be active`);
  }
});

// ---------------------------------------------------------------------------
// chooseMode

function msg({ ts, self = false, bot = false, authorId = 'u1' }) {
  return { ts, self, bot, authorId };
}

test('chooseMode: empty history may initiate, chance-gated', () => {
  assert.equal(chooseMode([], 1000, SPONTANEOUS_CFG, () => 0), 'initiate');
  assert.equal(chooseMode([], 1000, SPONTANEOUS_CFG, () => 0.99), null);
});

test('chooseMode: interjects when the channel is live', () => {
  const now = 1_000_000;
  const history = [
    msg({ ts: now - 10 * MINUTE, authorId: 'a' }),
    msg({ ts: now - 8 * MINUTE, authorId: 'b' }),
    msg({ ts: now - 5 * MINUTE, authorId: 'a' }),
    msg({ ts: now - 1 * MINUTE, authorId: 'c' }),
  ];
  assert.equal(chooseMode(history, now, SPONTANEOUS_CFG, () => 0), 'interject');
});

test('chooseMode: bot messages within the live window do not count toward interjecting', () => {
  const now = 1_000_000;
  const history = [
    msg({ ts: now - 10 * MINUTE, bot: true }),
    msg({ ts: now - 8 * MINUTE, bot: true }),
    msg({ ts: now - 5 * MINUTE, bot: true }),
    msg({ ts: now - 1 * MINUTE, authorId: 'c' }),
  ];
  assert.equal(chooseMode(history, now, SPONTANEOUS_CFG, () => 0), null);
});

test('chooseMode: initiates after a long silence, chance-gated', () => {
  const now = 1_000_000;
  const history = [msg({ ts: now - SPONTANEOUS_CFG.deadAfterMinutes * MINUTE - 1 })];
  assert.equal(chooseMode(history, now, SPONTANEOUS_CFG, () => 0), 'initiate');
  assert.equal(chooseMode(history, now, SPONTANEOUS_CFG, () => 0.99), null);
});

test('chooseMode: quiet-but-not-dead, non-live channel does nothing', () => {
  const now = 1_000_000;
  const history = [msg({ ts: now - 20 * MINUTE })]; // not live (>15min window), not dead (<90min)
  assert.equal(chooseMode(history, now, SPONTANEOUS_CFG, () => 0), null);
});

test('chooseMode: own last line followed by a dead silence may still initiate on a winning roll', () => {
  const now = 10_000_000;
  const history = [
    msg({ ts: now - 3 * HOUR, authorId: 'a' }),
    msg({ ts: now - SPONTANEOUS_CFG.deadAfterMinutes * MINUTE - 1, self: true }),
  ];
  assert.equal(chooseMode(history, now, SPONTANEOUS_CFG, () => 0), 'initiate');
});

test('chooseMode: own recent last line means null even with a live window (never interjects on itself)', () => {
  const now = 10_000_000;
  const history = [
    msg({ ts: now - 10 * MINUTE, authorId: 'a' }),
    msg({ ts: now - 8 * MINUTE, authorId: 'b' }),
    msg({ ts: now - 5 * MINUTE, authorId: 'a' }),
    msg({ ts: now - 3 * MINUTE, authorId: 'c' }),
    msg({ ts: now - 1 * MINUTE, self: true }),
  ];
  assert.equal(chooseMode(history, now, SPONTANEOUS_CFG, () => 0), null);
});

// ---------------------------------------------------------------------------
// pickChannel

test('pickChannel: with probability 0.7 picks the most recently active candidate', () => {
  const now = 1000;
  const candidates = [
    { channel: 'old', lastActivity: now - HOUR },
    { channel: 'newest', lastActivity: now - MINUTE },
    { channel: 'mid', lastActivity: now - 30 * MINUTE },
  ];
  assert.equal(pickChannel(candidates, now, scripted([0.1])), 'newest');
});

test('pickChannel: otherwise a uniformly random channel among those active in 24h', () => {
  const now = 1000;
  const candidates = [
    { channel: 'a', lastActivity: now - HOUR },
    { channel: 'b', lastActivity: now - 2 * HOUR },
  ];
  // rng[0] = 0.9 -> skip the 0.7 "most recent" branch; rng[1] picks the index
  assert.equal(pickChannel(candidates, now, scripted([0.9, 0])), 'a');
  assert.equal(pickChannel(candidates, now, scripted([0.9, 0.99])), 'b');
});

test('pickChannel: falls back to a uniformly random candidate when none were active in 24h', () => {
  const now = 1000;
  const candidates = [
    { channel: 'a', lastActivity: now - 2 * 24 * HOUR },
    { channel: 'b', lastActivity: now - 3 * 24 * HOUR },
  ];
  assert.equal(pickChannel(candidates, now, scripted([0])), 'a');
  assert.equal(pickChannel(candidates, now, scripted([0.99])), 'b');
});

// ---------------------------------------------------------------------------
// createSpontaneous / tick()

function fakeChannel(id, guild, overrides = {}) {
  return {
    id,
    name: `chan-${id}`,
    guild,
    isTextBased: () => true,
    isThread: () => false,
    viewable: true,
    lastMessageId: null,
    permissionsFor: () => ({ has: () => true }),
    ...overrides,
  };
}

function fakeGuild(id) {
  const guild = { id, members: { me: {} } };
  guild.channels = { cache: new Map() };
  return guild;
}

function baseConfig(spontaneousOverrides = {}, features = {}, mention) {
  return {
    bot: { timezone: 'UTC' },
    features,
    spontaneous: { ...SPONTANEOUS_CFG, ...spontaneousOverrides },
    ...(mention ? { mention } : {}),
  };
}

function fakeStore(initialData = {}) {
  let dirtyCalls = 0;
  return {
    state: {
      data: initialData,
      markDirty: () => {
        dirtyCalls += 1;
      },
    },
    get dirtyCalls() {
      return dirtyCalls;
    },
  };
}

function fakeTurns({ runTurn, isBusy, isAnyBusy, lastPostAt } = {}) {
  return {
    runTurn: runTurn ?? (async () => ({ outcome: 'spoke' })),
    isBusy: isBusy ?? (() => false),
    isAnyBusy: isAnyBusy ?? (() => false),
    lastPostAt: lastPostAt ?? (() => 0),
  };
}

test('tick: schedules a first run for a guild with no entry yet, without firing', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const store = fakeStore();
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });
  // Active hour (10 UTC is inside default 10-to-3 window) so a due entry would fire; here there's no entry at all.
  const now = () => Date.UTC(2026, 0, 5, 12, 0, 0);

  const spontaneous = createSpontaneous({ hot: { config: baseConfig() }, store, client, turns, getGuildId: () => 'g1', rng: () => 0.5, now });
  await spontaneous.tick();

  assert.equal(calls, 0);
  assert.equal(typeof store.state.data.spontaneous.g1, 'number');
  assert.ok(store.state.data.spontaneous.g1 > now());
});

test('tick: fires a turn once it is due and inside active hours', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const t = Date.UTC(2026, 0, 5, 12, 0, 0); // hour 12, inside 10-to-3
  const store = fakeStore({ spontaneous: { g1: t } }); // already due
  let seenChannel = null;
  const turns = fakeTurns({
    runTurn: async ({ channel: ch }) => {
      seenChannel = ch;
      return { outcome: 'spoke' };
    },
  });

  const spontaneous = createSpontaneous({ hot: { config: baseConfig() }, store, client, turns, getGuildId: () => 'g1', rng: () => 0.1, now: () => t });
  await spontaneous.tick();

  assert.equal(seenChannel, channel);
  assert.ok(store.state.data.spontaneous.g1 > t, 'should have been rescheduled to the future');
});

test('tick: reschedules to a wake time when due but outside active hours', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const t = Date.UTC(2026, 0, 5, 5, 0, 0); // hour 5, outside 10-to-3
  const store = fakeStore({ spontaneous: { g1: t } });
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });

  const spontaneous = createSpontaneous({ hot: { config: baseConfig() }, store, client, turns, getGuildId: () => 'g1', rng: () => 0.5, now: () => t });
  await spontaneous.tick();

  assert.equal(calls, 0);
  assert.ok(store.state.data.spontaneous.g1 > t);
});

test('tick: does nothing when features.spontaneous is false', async () => {
  const guild = fakeGuild('g1');
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const store = fakeStore();
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });

  const spontaneous = createSpontaneous({
    hot: { config: baseConfig({}, { spontaneous: false }) },
    store,
    client,
    turns,
    getGuildId: () => 'g1',
    rng: () => 0.5,
    now: () => Date.UTC(2026, 0, 5, 12, 0, 0),
  });
  await spontaneous.tick();

  assert.equal(calls, 0);
  assert.equal(store.state.data.spontaneous, undefined);
});

test('tick: never runs two spontaneous turns for the same guild concurrently', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const store = fakeStore({ spontaneous: { g1: t } });

  let calls = 0;
  const resolvers = [];
  const turns = fakeTurns({
    runTurn: () =>
      new Promise((resolve) => {
        calls += 1;
        resolvers.push(resolve);
      }),
  });

  const spontaneous = createSpontaneous({ hot: { config: baseConfig() }, store, client, turns, getGuildId: () => 'g1', rng: () => 0.1, now: () => t });

  const both = Promise.all([spontaneous.tick(), spontaneous.tick()]);
  await Promise.resolve(); // let both ticks run up to their awaits
  await Promise.resolve();
  assert.equal(calls, 1, 'the second tick should see the guild already running and skip it');

  for (const resolve of resolvers) resolve({ outcome: 'spoke' });
  await both;
});

test('tick: pulls the next run in sooner when a turn found nothing to say', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const store = fakeStore({ spontaneous: { g1: t } });
  const turns = fakeTurns({ runTurn: async () => ({ outcome: 'not-now' }) });

  const spontaneous = createSpontaneous({ hot: { config: baseConfig() }, store, client, turns, getGuildId: () => 'g1', rng: () => 0.5, now: () => t });
  await spontaneous.tick();

  const scheduled = store.state.data.spontaneous.g1;
  assert.ok(scheduled > t && scheduled <= t + 40 * MINUTE, `expected a 10-40min pull-in, got ${scheduled - t}ms`);
});

test('tick: does nothing while the served guild has not been resolved yet', async () => {
  const guild = fakeGuild('g1');
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const store = fakeStore();
  const turns = fakeTurns();

  const spontaneous = createSpontaneous({
    hot: { config: baseConfig() },
    store,
    client,
    turns,
    getGuildId: () => null,
    rng: () => 0.5,
    now: () => Date.now(),
  });
  await spontaneous.tick();

  assert.deepEqual(store.state.data.spontaneous ?? {}, {}, 'an unresolved instance must not get a schedule entry');
});

test('tick: does nothing when the resolved guild is not (or no longer) in the client\'s cache', async () => {
  const client = { guilds: { cache: new Map() } };
  const store = fakeStore();
  const turns = fakeTurns();

  const spontaneous = createSpontaneous({
    hot: { config: baseConfig() },
    store,
    client,
    turns,
    getGuildId: () => 'g1',
    rng: () => 0.5,
    now: () => Date.now(),
  });
  await spontaneous.tick();

  assert.deepEqual(store.state.data.spontaneous ?? {}, {});
});

// ---------------------------------------------------------------------------
// onMessage (eavesdrop)

function eagerEavesdropConfig(features = {}) {
  return baseConfig({ eavesdropChance: 1, eavesdropDelayMs: [0, 0] }, features);
}

async function flushTimers() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test('onMessage: eavesdrops when spontaneous and eavesdrop are both on (missing features block counts as on)', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });
  const now = () => Date.UTC(2026, 0, 5, 12, 0, 0);

  const spontaneous = createSpontaneous({
    hot: { config: eagerEavesdropConfig() },
    store: fakeStore(),
    client: {},
    turns,
    getGuildId: () => 'g1',
    rng: () => 0,
    now,
  });
  spontaneous.onMessage(channel, { self: false, bot: false });
  await flushTimers();

  assert.equal(calls, 1);
});

test('onMessage: the eavesdrop timer re-checks warmup, both switches and active hours when it fires', async () => {
  const cases = [
    ['warmup', (ctx) => { ctx.warming = true; }],
    ['eavesdrop off', (ctx) => { ctx.config.features.eavesdrop = false; }],
    ['spontaneous off', (ctx) => { ctx.config.features.spontaneous = false; }],
    ['outside active hours', (ctx) => { ctx.time = Date.UTC(2026, 0, 5, 5, 0, 0); }],
  ];
  for (const [label, change] of cases) {
    const channel = fakeChannel('c1', fakeGuild('g1'));
    let calls = 0;
    const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });
    const ctx = { warming: false, time: Date.UTC(2026, 0, 5, 12, 0, 0), config: eagerEavesdropConfig({}) };
    const spontaneous = createSpontaneous({
      hot: { config: ctx.config },
      store: fakeStore(),
      client: {},
      turns,
      getGuildId: () => 'g1',
      isWarmingUp: () => ctx.warming,
      rng: () => 0,
      now: () => ctx.time,
    });
    spontaneous.onMessage(channel, { self: false, bot: false });
    change(ctx);
    await flushTimers();
    assert.equal(calls, 0, label);
  }
});

test('onMessage: the eavesdrop chooser reads config.spontaneous when the timer fires', async () => {
  const channel = fakeChannel('c1', fakeGuild('g1'));
  const config = eagerEavesdropConfig();
  config.spontaneous.initiateChance = 0;
  let chosen;
  const turns = fakeTurns({
    runTurn: async ({ chooseMode: choose }) => {
      chosen = choose([], Date.UTC(2026, 0, 5, 12, 0, 0));
      return { outcome: 'spoke' };
    },
  });
  const hot = { config };
  const spontaneous = createSpontaneous({ hot, store: fakeStore(), client: {}, turns, getGuildId: () => 'g1', rng: () => 0, now: () => Date.UTC(2026, 0, 5, 12, 0, 0) });
  spontaneous.onMessage(channel, { self: false, bot: false });
  hot.config = eagerEavesdropConfig();
  hot.config.spontaneous.initiateChance = 1; // a reload between scheduling and firing
  await flushTimers();
  assert.equal(chosen, 'initiate');
});

test('onMessage: ignores a message from a guild other than the one this instance serves', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });
  const now = () => Date.UTC(2026, 0, 5, 12, 0, 0);

  const spontaneous = createSpontaneous({
    hot: { config: eagerEavesdropConfig() },
    store: fakeStore(),
    client: {},
    turns,
    getGuildId: () => 'some-other-guild',
    rng: () => 0,
    now,
  });
  spontaneous.onMessage(channel, { self: false, bot: false });
  await flushTimers();

  assert.equal(calls, 0);
});

test('onMessage: no eavesdrop in the dry-run mirror or a channel whose history the bot cannot read', async () => {
  const guild = fakeGuild('g1');
  const read = PermissionFlagsBits.ReadMessageHistory;
  const channels = {
    mirror: fakeChannel('mirror1', guild),
    unreadable: fakeChannel('c2', guild, { permissionsFor: () => ({ has: (flag) => flag !== read }) }),
    open: fakeChannel('c3', guild),
  };
  const config = eagerEavesdropConfig();
  config.bot = { ...config.bot, dryRunChannelId: 'mirror1' };
  const spontaneous = createSpontaneous({
    hot: { config },
    store: fakeStore(),
    client: {},
    turns: fakeTurns(),
    getGuildId: () => 'g1',
    rng: () => 0,
    now: () => Date.UTC(2026, 0, 5, 12, 0, 0),
  });
  const scheduled = Object.fromEntries(Object.entries(channels).map(([name, channel]) => [name, spontaneous.onMessage(channel, { self: false, bot: false })]));
  spontaneous.stop();

  assert.deepEqual(scheduled, { mirror: false, unreadable: false, open: true });
});

// ---------------------------------------------------------------------------
// status / stop / force

test('force: fires even when every feature switch is off (the owner\'s explicit command bypasses them)', async () => {
  let seen = null;
  const turns = fakeTurns({ runTurn: async (args) => { seen = args; return { outcome: 'spoke' }; } });
  const config = baseConfig({}, { spontaneous: false, eavesdrop: false });
  const spontaneous = createSpontaneous({
    hot: { config },
    store: fakeStore(),
    client: { guilds: { cache: new Map() } },
    turns,
  });
  const channel = { id: 'c1' };
  const result = await spontaneous.force(channel, 'initiate');
  assert.equal(result.outcome, 'spoke');
  assert.equal(seen.channel, channel);
});

test('force: forwards mode straight to turns.runTurn, with forced: true', async () => {
  let seen = null;
  const turns = fakeTurns({ runTurn: async (args) => { seen = args; return { outcome: 'spoke' }; } });
  const spontaneous = createSpontaneous({
    hot: { config: baseConfig() },
    store: fakeStore(),
    client: { guilds: { cache: new Map() } },
    turns,
  });
  const channel = { id: 'c1' };
  const result = await spontaneous.force(channel, 'interject');
  assert.equal(result.outcome, 'spoke');
  assert.equal(seen.channel, channel);
  assert.equal(seen.mode, 'interject');
  assert.equal(seen.forced, true);
});

test('forcedMode: a turn someone asked for starts a topic in an empty or quiet channel, else joins in -- never nothing', () => {
  const cfg = { deadAfterMinutes: 30 };
  const now = 10 * 60 * MINUTE;
  assert.equal(forcedMode([], now, cfg), 'initiate');
  assert.equal(forcedMode([{ ts: now - 31 * MINUTE, self: false }], now, cfg), 'initiate');
  assert.equal(forcedMode([{ ts: now - 5 * MINUTE, self: false }], now, cfg), 'interject');
  // her own last line, or a lone line: still a turn, she was asked
  assert.equal(forcedMode([{ ts: now - 5 * MINUTE, self: true }], now, cfg), 'interject');
});

test('force: without a mode the turn picks it from the channel (forcedMode); the one who asked rides along as the requester', async () => {
  let seen = null;
  const turns = fakeTurns({ runTurn: async (args) => { seen = args; return { outcome: 'spoke' }; } });
  const spontaneous = createSpontaneous({
    hot: { config: baseConfig() },
    store: fakeStore(),
    client: { guilds: { cache: new Map() } },
    turns,
  });
  const channel = { id: 'c1' };
  await spontaneous.force(channel, null, { requester: { id: '42', roleIds: [] } });
  assert.deepEqual([seen.mode, seen.forced, seen.requester], ['auto', true, { id: '42', roleIds: [] }]);
  assert.equal(seen.chooseMode([], Date.now()), 'initiate', 'an empty channel: a topic of her own');
  await spontaneous.force(channel, 'interject');
  assert.equal('requester' in seen, false, 'nobody asked: no requester');
});

test('stop: clears pending eavesdrop timers without throwing', async () => {
  const idle = createSpontaneous({
    hot: { config: baseConfig() },
    store: fakeStore(),
    client: { guilds: { cache: new Map() } },
    turns: fakeTurns(),
  });
  assert.doesNotThrow(() => idle.stop(), 'nothing pending');

  // Two schedulers each schedule one eavesdrop (chance 1, delay 0); only one is stopped.
  function eavesdropping() {
    const counter = { calls: 0 };
    const spontaneous = createSpontaneous({
      hot: { config: eagerEavesdropConfig() },
      store: fakeStore(),
      client: {},
      turns: fakeTurns({ runTurn: async () => { counter.calls += 1; return { outcome: 'spoke' }; } }),
      getGuildId: () => 'g1',
      rng: () => 0,
      now: () => Date.UTC(2026, 0, 5, 12, 0, 0),
    });
    spontaneous.onMessage(fakeChannel('c1', fakeGuild('g1')), { self: false, bot: false });
    return { spontaneous, counter };
  }
  const control = eavesdropping();
  const stopped = eavesdropping();
  assert.doesNotThrow(() => stopped.spontaneous.stop(), 'one eavesdrop pending');
  await flushTimers();

  assert.equal(control.counter.calls, 1, 'without stop() the pending eavesdrop fires');
  assert.equal(stopped.counter.calls, 0, 'stop() cleared the pending eavesdrop timer');
});

// ---------------------------------------------------------------------------
// Dead channels (spontaneous.maxChannelSilenceHours) never start a
// spontaneous turn on their own -- a direct ping there is unaffected (that
// path never goes through channelCandidates at all).

test('isChannelDead: silent longer than a positive maxChannelSilenceHours is dead, a non-positive or missing value means no limit', () => {
  const now = 1_000_000_000;
  const silent100h = { lastMessageId: snowflake(now - 100 * HOUR) };
  const ancient = { lastMessageId: snowflake(now - 5000 * HOUR) };
  const rows = [
    ['silent longer than maxChannelSilenceHours is dead', silent100h, { maxChannelSilenceHours: 72 }, true],
    ['maxChannelSilenceHours 0 means no limit', ancient, { maxChannelSilenceHours: 0 }, false],
    ['a negative maxChannelSilenceHours means no limit', ancient, { maxChannelSilenceHours: -5 }, false],
    ['a missing maxChannelSilenceHours means no limit', ancient, {}, false],
  ];
  for (const [label, channel, cfg, dead] of rows) {
    assert.equal(isChannelDead(channel, now, cfg), dead, label);
  }
});

test('isChannelDead: within the window is not dead', () => {
  const now = 1_000_000_000;
  const channel = { lastMessageId: snowflake(now - 10 * HOUR) };
  assert.equal(isChannelDead(channel, now, { maxChannelSilenceHours: 72 }), false);
});

test('tick: a dead channel is never a candidate, a fresh one still is', async () => {
  const guild = fakeGuild('g1');
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const dead = fakeChannel('dead', guild, { lastMessageId: snowflake(t - 100 * HOUR) });
  const fresh = fakeChannel('fresh', guild, { lastMessageId: snowflake(t - HOUR) });
  guild.channels.cache.set(dead.id, dead);
  guild.channels.cache.set(fresh.id, fresh);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const store = fakeStore({ spontaneous: { g1: t } });
  let seenChannel = null;
  const turns = fakeTurns({ runTurn: async ({ channel }) => { seenChannel = channel; return { outcome: 'spoke' }; } });

  const spontaneous = createSpontaneous({
    hot: { config: baseConfig({ maxChannelSilenceHours: 72 }) },
    store,
    client,
    turns,
    getGuildId: () => 'g1',
    rng: () => 0.1,
    now: () => t,
  });
  await spontaneous.tick();

  assert.equal(seenChannel, fresh, 'the dead channel must never be picked');
});

test('tick: every channel dead means no candidates -- "not now" without breaking the schedule', async () => {
  const guild = fakeGuild('g1');
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const dead = fakeChannel('dead', guild, { lastMessageId: snowflake(t - 200 * HOUR) });
  guild.channels.cache.set(dead.id, dead);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const store = fakeStore({ spontaneous: { g1: t } });
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });

  const spontaneous = createSpontaneous({
    hot: { config: baseConfig({ maxChannelSilenceHours: 72 }) },
    store,
    client,
    turns,
    getGuildId: () => 'g1',
    rng: () => 0.5,
    now: () => t,
  });
  await spontaneous.tick();

  assert.equal(calls, 0);
  assert.ok(store.state.data.spontaneous.g1 > t, 'rescheduled (the pull-in path), the periodic schedule is not broken');
});

test('tick: a hot change to maxChannelSilenceHours is picked up without recreating the scheduler', async () => {
  const guild = fakeGuild('g1');
  const t0 = Date.UTC(2026, 0, 5, 12, 0, 0);
  const old = fakeChannel('old', guild, { lastMessageId: snowflake(t0 - 100 * HOUR) });
  guild.channels.cache.set(old.id, old);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const store = fakeStore({ spontaneous: { g1: t0 } });
  const turns = fakeTurns();
  const hot = { config: baseConfig({ maxChannelSilenceHours: 0 }) };
  let now = t0;

  const spontaneous = createSpontaneous({ hot, store, client, turns, getGuildId: () => 'g1', rng: () => 0.1, now: () => now });

  let seenChannel = null;
  turns.runTurn = async ({ channel }) => {
    seenChannel = channel;
    return { outcome: 'spoke' };
  };
  await spontaneous.tick();
  assert.equal(seenChannel, old, 'no limit yet: the old channel is a candidate');

  hot.config = baseConfig({ maxChannelSilenceHours: 72 });
  store.state.data.spontaneous.g1 = now; // due again
  seenChannel = null;
  await spontaneous.tick();
  assert.equal(seenChannel, null, 'now limited: the same old channel is no longer a candidate');
});

// ---------------------------------------------------------------------------
// One attention (mention.oneAtATime) -- while a turn is running
// anywhere, the spontaneous scheduler treats every channel as unavailable.

test('tick: turns.isAnyBusy() true blocks every channel when oneAtATime is on (default) -- "not now"', async () => {
  const guild = fakeGuild('g1');
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const channel = fakeChannel('c1', guild, { lastMessageId: snowflake(t - MINUTE) });
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const store = fakeStore({ spontaneous: { g1: t } });
  let calls = 0;
  const turns = fakeTurns({
    isAnyBusy: () => true,
    runTurn: async () => { calls += 1; return { outcome: 'spoke' }; },
  });

  const spontaneous = createSpontaneous({ hot: { config: baseConfig() }, store, client, turns, getGuildId: () => 'g1', rng: () => 0.5, now: () => t });
  await spontaneous.tick();

  assert.equal(calls, 0);
  assert.ok(store.state.data.spontaneous.g1 > t, 'the periodic schedule keeps advancing');
});

test('tick: mention.oneAtATime=false lets a spontaneous tick proceed even while busy elsewhere', async () => {
  const guild = fakeGuild('g1');
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const channel = fakeChannel('c1', guild, { lastMessageId: snowflake(t - MINUTE) });
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const store = fakeStore({ spontaneous: { g1: t } });
  let seenChannel = null;
  const turns = fakeTurns({
    isAnyBusy: () => true,
    runTurn: async ({ channel: ch }) => { seenChannel = ch; return { outcome: 'spoke' }; },
  });

  const spontaneous = createSpontaneous({
    hot: { config: baseConfig({}, {}, { oneAtATime: false }) },
    store,
    client,
    turns,
    getGuildId: () => 'g1',
    rng: () => 0.5,
    now: () => t,
  });
  await spontaneous.tick();

  assert.equal(seenChannel, channel);
});

// ---------------------------------------------------------------------------
// /nep pause -- no spontaneous activity, nothing may go dirty

test('tick: does nothing while store.state.data.paused is true, not even the first-schedule write', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const store = fakeStore({ paused: true });
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });

  const spontaneous = createSpontaneous({
    hot: { config: baseConfig() },
    store,
    client,
    turns,
    getGuildId: () => 'g1',
    rng: () => 0.1,
    now: () => Date.UTC(2026, 0, 5, 12, 0, 0),
  });
  await spontaneous.tick();

  assert.equal(calls, 0);
  assert.equal(store.state.data.spontaneous, undefined, 'must not even set up the schedule while paused');
  assert.equal(store.dirtyCalls, 0);
});

test('tick: does nothing while a run was already due, when store.state.data.paused flips true', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const store = fakeStore({ paused: true, spontaneous: { g1: t } }); // already due
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });

  const spontaneous = createSpontaneous({ hot: { config: baseConfig() }, store, client, turns, getGuildId: () => 'g1', rng: () => 0.1, now: () => t });
  await spontaneous.tick();

  assert.equal(calls, 0);
  assert.equal(store.state.data.spontaneous.g1, t, 'the schedule is left exactly as it was');
});

test('onMessage: does not schedule an eavesdrop while store.state.data.paused is true', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });
  const now = () => Date.UTC(2026, 0, 5, 12, 0, 0);

  const spontaneous = createSpontaneous({
    hot: { config: eagerEavesdropConfig() },
    store: fakeStore({ paused: true }),
    client: {},
    turns,
    getGuildId: () => 'g1',
    rng: () => 0,
    now,
  });
  spontaneous.onMessage(channel, { self: false, bot: false });
  await flushTimers();

  assert.equal(calls, 0);
});

test('onMessage (eavesdrop): does not schedule while busy elsewhere and oneAtATime is on', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  let calls = 0;
  const turns = fakeTurns({ isAnyBusy: () => true, runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });
  const now = () => Date.UTC(2026, 0, 5, 12, 0, 0);

  const spontaneous = createSpontaneous({
    hot: { config: eagerEavesdropConfig() },
    store: fakeStore(),
    client: {},
    turns,
    getGuildId: () => 'g1',
    rng: () => 0,
    now,
  });
  spontaneous.onMessage(channel, { self: false, bot: false });
  await flushTimers();

  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// isWarmingUp -- the mute hook the memory warmup runner
// (src/memory/warmup.js) uses. Same shape as the paused tests above.

test('tick: does nothing while isWarmingUp() is true, not even the first-schedule write', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const store = fakeStore();
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });

  const spontaneous = createSpontaneous({
    hot: { config: baseConfig() },
    store,
    client,
    turns,
    getGuildId: () => 'g1',
    isWarmingUp: () => true,
    rng: () => 0.1,
    now: () => Date.UTC(2026, 0, 5, 12, 0, 0),
  });
  await spontaneous.tick();

  assert.equal(calls, 0);
  assert.equal(store.state.data.spontaneous, undefined, 'must not even set up the schedule while warming up');
  assert.equal(store.dirtyCalls, 0);
});

test('tick: does nothing while a run was already due, when isWarmingUp() is true', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const store = fakeStore({ spontaneous: { g1: t } }); // already due
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });

  const spontaneous = createSpontaneous({
    hot: { config: baseConfig() },
    store,
    client,
    turns,
    getGuildId: () => 'g1',
    isWarmingUp: () => true,
    rng: () => 0.1,
    now: () => t,
  });
  await spontaneous.tick();

  assert.equal(calls, 0);
  assert.equal(store.state.data.spontaneous.g1, t, 'the schedule is left exactly as it was');
});

// ---------------------------------------------------------------------------
// Noticed comments: a read-only channel (the bot reads it, cannot write in it)
// is a candidate whose turn speaks in the main channel (memory.mainChannelIds),
// every rail checked on that destination, no counter of its own.

const NOTICE_T = Date.UTC(2026, 0, 5, 12, 0, 0); // hour 12, inside 10-to-3
const SEND = PermissionFlagsBits.SendMessages;
const VIEW = PermissionFlagsBits.ViewChannel;

/** A guild with @everyone (its id is the guild's), one more role and the bot member. */
function noticeGuild() {
  const everyone = { id: 'g1' };
  const regular = { id: 'r1' };
  return {
    id: 'g1',
    members: { me: { id: 'self1' } },
    roles: { everyone, cache: new Map([[everyone.id, everyone], [regular.id, regular]]) },
    channels: { cache: new Map() },
  };
}

/** A text channel of `guild`, no overwrites: `send` for the bot, `viewers` the roles that view it, `lastTs` its newest message. */
function noticeChannel(guild, id, { send = true, viewers = ['g1', 'r1'], lastTs = null } = {}) {
  const me = guild.members.me;
  const channel = fakeChannel(id, guild, {
    lastMessageId: lastTs === null ? null : snowflake(lastTs),
    permissionOverwrites: { cache: new Map() },
    permissionsFor: (target) =>
      target === me ? { has: (flag) => send || flag !== SEND } : { has: (flag) => flag === VIEW && viewers.includes(target?.id) },
  });
  guild.channels.cache.set(id, channel);
  return channel;
}

/**
 * The read-only source `s1` (newest message `sourceAgoMs` before NOTICE_T) and the main channel
 * `d1` (no message: dead as a candidate of its own under maxChannelSilenceHours 72, still a
 * destination), a schedule due now, a recording runTurn. Options adjust config, prompts, the
 * state, the turn runner's view and the clock.
 */
function noticeScene({
  spontaneous: spontaneousOverrides = {},
  features = {},
  mention,
  prompts = { elsewhere: 'ELSEWHERE TASK' },
  data = {},
  sourceAgoMs = 3 * MINUTE,
  sourceViewers = ['g1', 'r1'],
  mainCanSend = true,
  lastPostAt = () => 0,
  isBusy = () => false,
  isAnyBusy = () => false,
  result = { outcome: 'spoke' },
  rng = () => 0.1,
  t = NOTICE_T,
} = {}) {
  const guild = noticeGuild();
  const source = noticeChannel(guild, 's1', { send: false, viewers: sourceViewers, lastTs: NOTICE_T - sourceAgoMs });
  const main = noticeChannel(guild, 'd1', { send: mainCanSend });
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const config = {
    ...baseConfig({ maxChannelSilenceHours: 72, ...spontaneousOverrides }, features, mention),
    memory: { mainChannelIds: ['d1'] },
  };
  const store = fakeStore({ spontaneous: { g1: NOTICE_T }, ...data });
  const calls = [];
  const turns = fakeTurns({
    runTurn: async (args) => {
      calls.push(args);
      return result;
    },
    lastPostAt,
    isBusy,
    isAnyBusy,
  });
  const hot = { config, prompts };
  const spontaneous = createSpontaneous({ hot, store, client, turns, getGuildId: () => 'g1', rng, now: () => t });
  return { guild, source, main, client, config, hot, store, calls, spontaneous };
}

/** `count` member messages of the source, one a minute, the newest `newestAgoMs` before NOTICE_T. */
function sourceMessages(count, newestAgoMs = 3 * MINUTE) {
  return Array.from({ length: count }, (_, i) => msg({ ts: NOTICE_T - newestAgoMs - (count - 1 - i) * MINUTE, authorId: `u${i}` }));
}

/** What a turn's chooser answers for the source pulled with `messages`. */
function chooseWith(args, messages) {
  return args.chooseMode([], NOTICE_T, { pulled: [{ channelId: 's1', messages }] });
}

test('spontaneous: a read-only channel with unseen messages is a tick candidate speaking in the main channel', async () => {
  const scene = noticeScene();
  const { logs } = await withCapturedLogs(() => scene.spontaneous.tick());

  assert.equal(scene.calls.length, 1);
  const [args] = scene.calls;
  assert.equal(args.channel, scene.main, 'the words go to the main channel');
  assert.deepEqual(args.source, { channelId: 's1', reason: 'noticed' });
  assert.equal(args.mode, 'auto');
  // The tick path keeps the ordinary liveness: liveMinMessages member lines after the seen mark.
  assert.equal(chooseWith(args, sourceMessages(4)), 'elsewhere');
  assert.equal(chooseWith(args, sourceMessages(3)), null, 'fewer than liveMinMessages: not now');
  assert.equal(args.chooseMode([], NOTICE_T, { pulled: [] }), null, 'a source that was not pulled: not now');

  const [firing] = logs.filter((entry) => entry.msg === 'spontaneous: firing a turn');
  assert.equal(firing.channel, 'd1');
  assert.equal(firing.source, 's1');
  assert.ok(scene.store.state.data.spontaneous.g1 > NOTICE_T, 'rescheduled like any tick');
});

test('spontaneous: the noticed chooser counts only lines after the seen mark, read when it runs', async () => {
  const scene = noticeScene();
  await scene.spontaneous.tick();
  const [args] = scene.calls;
  const lines = sourceMessages(6); // 8..3 minutes ago
  assert.equal(chooseWith(args, lines), 'elsewhere');
  scene.store.state.data.elsewhereSeen = { s1: NOTICE_T - 5 * MINUTE }; // only three lines are newer
  assert.equal(chooseWith(args, lines), null);
});

test('spontaneous: a source already seen is not a candidate', async () => {
  const scene = noticeScene({ data: { elsewhereSeen: { s1: NOTICE_T - 3 * MINUTE } } });
  await scene.spontaneous.tick();
  assert.equal(scene.calls.length, 0);

  const newer = noticeScene({ data: { elsewhereSeen: { s1: NOTICE_T - 4 * MINUTE } } });
  await newer.spontaneous.tick();
  assert.equal(newer.calls.length, 1, 'a message newer than the mark makes it a candidate again');
});

test('spontaneous: a read-only candidate needs the main channel\'s minGapMinutes', async () => {
  const postedAgo = (age) => (id) => (id === 'd1' ? NOTICE_T - age : 0);
  const recent = noticeScene({ lastPostAt: postedAgo(5 * MINUTE) });
  await recent.spontaneous.tick();
  assert.equal(recent.calls.length, 0, 'the persona posted in the main channel 5 minutes ago');

  const old = noticeScene({ lastPostAt: postedAgo(13 * MINUTE) });
  await old.spontaneous.tick();
  assert.equal(old.calls.length, 1);

  const sourceOnly = noticeScene({ lastPostAt: (id) => (id === 's1' ? NOTICE_T : 0) });
  await sourceOnly.spontaneous.tick();
  assert.equal(sourceOnly.calls.length, 1, 'the source\'s own stamp is not the rail');
});

test('spontaneous: a source still mid-burst is not a candidate', async () => {
  const burst = noticeScene({ sourceAgoMs: 30 * 1000 });
  await burst.spontaneous.tick();
  assert.equal(burst.calls.length, 0, 'the last message is younger than elsewhere.settleSeconds');

  const settled = noticeScene({ sourceAgoMs: 90 * 1000 });
  await settled.spontaneous.tick();
  assert.equal(settled.calls.length, 1);

  const quiet = noticeScene({ sourceAgoMs: 20 * MINUTE });
  await quiet.spontaneous.tick();
  assert.equal(quiet.calls.length, 0, 'new content that went quiet past the live window is not live');
});

test('spontaneous: without prompts.elsewhere no source is a candidate', async () => {
  for (const [label, prompts] of [['missing', {}], ['empty', { elsewhere: '  \n' }], ['no prompts', null]]) {
    const scene = noticeScene({ prompts });
    await scene.spontaneous.tick();
    assert.equal(scene.calls.length, 0, label);
  }
});

test('spontaneous: features.elsewhere off or a source the audience rail refuses gives no candidate', async () => {
  const off = noticeScene({ features: { elsewhere: false } });
  await off.spontaneous.tick();
  assert.equal(off.calls.length, 0, 'features.elsewhere off');

  const narrower = noticeScene({ sourceViewers: ['r1'] });
  await narrower.spontaneous.tick();
  assert.equal(narrower.calls.length, 0, 'someone who views the main channel cannot view the source');
});

test('spontaneous: a read-only candidate meets the destination\'s rails: spontaneous.channels, canSend, one attention', async () => {
  const rows = [
    ['spontaneous.channels without the main channel', { spontaneous: { channels: ['s1'] } }, 0],
    ['spontaneous.channels with the main channel', { spontaneous: { channels: ['d1'] } }, 1],
    ['the main channel cannot send', { mainCanSend: false }, 0],
    ['a turn runs elsewhere (one attention)', { isAnyBusy: () => true }, 0],
    ['a turn runs in the main channel', { isBusy: (id) => id === 'd1', mention: { oneAtATime: false } }, 0],
  ];
  for (const [label, options, expected] of rows) {
    const scene = noticeScene(options);
    await scene.spontaneous.tick();
    assert.equal(scene.calls.length, expected, label);
  }
});

test('spontaneous: noticeElsewhere rolls eavesdropChance like any message', async () => {
  const member = { self: false, bot: false };
  const hit = noticeScene({ rng: () => 0.01 }); // below eavesdropChance 0.02
  const { logs } = await withCapturedLogs(async () => {
    assert.equal(hit.spontaneous.noticeElsewhere(hit.source, member), true);
  });
  assert.deepEqual(
    logs.filter((entry) => entry.msg === 'spontaneous: noticed').map(({ source, destination }) => ({ source, destination })),
    [{ source: 's1', destination: 'd1' }],
  );
  assert.equal(hit.calls.length, 0, 'noticeElsewhere runs no turn itself');

  const miss = noticeScene({ rng: () => 0.02 });
  assert.equal(miss.spontaneous.noticeElsewhere(miss.source, member), false, 'a roll at the chance misses');

  const rows = [
    ['the persona\'s own line', {}, { self: true, bot: false }],
    ['a bot', {}, { self: false, bot: true }],
    ['features.eavesdrop off', { features: { eavesdrop: false } }, member],
    ['features.spontaneous off', { features: { spontaneous: false } }, member],
    ['asleep', { t: Date.UTC(2026, 0, 5, 5, 0, 0) }, member],
    ['paused', { data: { paused: true } }, member],
    ['main channel posted 5 minutes ago', { lastPostAt: (id) => (id === 'd1' ? NOTICE_T - 5 * MINUTE : 0) }, member],
    ['no prompts.elsewhere', { prompts: {} }, member],
  ];
  for (const [label, options, normalized] of rows) {
    const scene = noticeScene({ rng: () => 0, ...options });
    assert.equal(scene.spontaneous.noticeElsewhere(scene.source, normalized), false, label);
  }
  const writable = noticeScene({ rng: () => 0 });
  assert.equal(writable.spontaneous.noticeElsewhere(writable.main, member), false, 'a channel the bot can send in is not a source');
});

test('spontaneous: runNoticed re-checks the rails when it fires', async () => {
  const ok = noticeScene();
  const before = structuredClone(ok.store.state.data);
  const result = await ok.spontaneous.runNoticed(ok.source);
  assert.equal(result.outcome, 'spoke');
  assert.equal(ok.calls.length, 1);
  const [args] = ok.calls;
  assert.equal(args.channel, ok.main);
  assert.deepEqual(args.source, { channelId: 's1', reason: 'noticed' });
  assert.equal(chooseWith(args, sourceMessages(1)), 'elsewhere', 'the eavesdrop roll was the gate: one new member line is enough');
  assert.deepEqual(ok.store.state.data, before, 'the schedule and the state are untouched: no counter of its own');

  const again = await ok.spontaneous.runNoticed(ok.source);
  assert.equal(again.outcome, 'spoke', 'no cap of its own');

  const rows = [
    ['paused', { data: { paused: true } }, 'paused'],
    ['asleep', { t: Date.UTC(2026, 0, 5, 5, 0, 0) }, 'asleep'],
    ['features.eavesdrop off', { features: { eavesdrop: false } }, 'off'],
    ['features.elsewhere off', { features: { elsewhere: false } }, 'off'],
    ['the audience rail', { sourceViewers: ['r1'] }, 'audience'],
    ['no prompts.elsewhere', { prompts: { elsewhere: '' } }, 'no-prompt'],
    ['the main channel cannot send', { mainCanSend: false }, 'no-destination'],
    ['main channel minGapMinutes', { lastPostAt: (id) => (id === 'd1' ? NOTICE_T - MINUTE : 0) }, 'gap'],
    ['one attention', { isAnyBusy: () => true }, 'busy'],
    ['already seen', { data: { elsewhereSeen: { s1: NOTICE_T } } }, 'seen'],
  ];
  for (const [label, options, reason] of rows) {
    const scene = noticeScene(options);
    const refused = await scene.spontaneous.runNoticed(scene.source);
    assert.equal(refused.reason, reason, label);
    assert.equal(scene.calls.length, 0, label);
  }
});

// ---------------------------------------------------------------------------
// Room questions: chooseRoomMode, onMessage with { room }, eavesdropReady

function roomLine({ id, ts, self = false, bot = false, authorId = 'u1' }) {
  return { id, ts, self, bot, authorId };
}

test('chooseRoomMode: interject while no own line follows the focus', () => {
  const history = [
    roomLine({ id: 'm1', ts: 1000, self: true }),
    roomLine({ id: 'm2', ts: 2000, authorId: 'a' }),
    roomLine({ id: 'm3', ts: 3000, authorId: 'b' }),
  ];
  assert.equal(chooseRoomMode(history, 'm2'), 'interject', 'members talking after it change nothing');
  assert.equal(chooseRoomMode(history, 'm3'), 'interject', 'the focus as the last line');
  assert.equal(chooseRoomMode([roomLine({ id: 'm9', ts: 1 })], 'm9'), 'interject', 'a quiet channel: no liveness needed');
});

test('chooseRoomMode: null once the persona spoke after it', () => {
  const history = [
    roomLine({ id: 'm2', ts: 2000, authorId: 'a' }),
    roomLine({ id: 'm3', ts: 3000, self: true }),
    roomLine({ id: 'm4', ts: 4000, authorId: 'b' }),
  ];
  assert.equal(chooseRoomMode(history, 'm2'), null);
  assert.equal(chooseRoomMode(history, 'gone'), null, 'a focus no longer in the history');
  assert.equal(chooseRoomMode([], 'm2'), null);
});

/** A spontaneous scheduler for the room tests: the ordinary eavesdrop rails pass at noon. */
function roomScene({ rng, config = baseConfig({ eavesdropDelayMs: [0, 0] }), store = fakeStore(), turns: turnOptions = {}, getGuildId = () => 'g1' } = {}) {
  const calls = [];
  const turns = fakeTurns({ runTurn: async (args) => { calls.push(args); return { outcome: 'spoke' }; }, ...turnOptions });
  const channel = fakeChannel('c1', fakeGuild('g1'));
  const hot = { config };
  const spontaneous = createSpontaneous({ hot, store, client: {}, turns, getGuildId, rng, now: () => Date.UTC(2026, 0, 5, 12, 0, 0) });
  return { spontaneous, channel, calls, hot, store };
}

test('spontaneous: a room line is scheduled without a roll and with its focus', async () => {
  // One rng value only: the delay. A chance roll would take 0.5 >= eavesdropChance (0.02) and refuse.
  const scene = roomScene({ rng: scripted([0.5]) });
  const focus = { id: 'm7', self: false, bot: false, authorId: 'u1', ts: Date.UTC(2026, 0, 5, 11, 59, 0) };
  assert.equal(scene.spontaneous.onMessage(scene.channel, focus, { room: true }), true);
  await flushTimers();
  assert.equal(scene.calls.length, 1);
  const [args] = scene.calls;
  assert.equal(args.channel, scene.channel);
  assert.equal(args.mode, 'auto');
  assert.equal(args.focus, focus);
  assert.equal(args.chooseMode([roomLine({ id: 'm7', ts: 1 })], 2), 'interject', 'the room chooser, no liveness');
  assert.equal(args.chooseMode([roomLine({ id: 'm7', ts: 1 }), roomLine({ id: 'm8', ts: 2, self: true })], 3), null);
});

test('spontaneous: onMessage returns whether it scheduled', async () => {
  const hit = roomScene({ rng: scripted([0, 0]), config: baseConfig({ eavesdropChance: 0.5, eavesdropDelayMs: [0, 0] }) });
  assert.equal(hit.spontaneous.onMessage(hit.channel, { self: false, bot: false }), true, 'a won roll');
  const miss = roomScene({ rng: scripted([0.9]), config: baseConfig({ eavesdropChance: 0.5 }) });
  assert.equal(miss.spontaneous.onMessage(miss.channel, { self: false, bot: false }), false, 'a lost roll');
  const paused = roomScene({ rng: () => 0, store: fakeStore({ paused: true }) });
  assert.equal(paused.spontaneous.onMessage(paused.channel, { self: false, bot: false }, { room: true }), false, 'paused');
  const busy = roomScene({ rng: () => 0, turns: { isAnyBusy: () => true } });
  assert.equal(busy.spontaneous.onMessage(busy.channel, { self: false, bot: false }, { room: true }), false, 'a room line still meets the rails');
  const own = roomScene({ rng: () => 0 });
  assert.equal(own.spontaneous.onMessage(own.channel, { self: true, bot: false }, { room: true }), false, 'its own line');
  await flushTimers();
  assert.equal(hit.calls.length, 1);
  assert.equal(hit.calls[0].focus, undefined, 'an ordinary eavesdrop carries no focus');
  for (const scene of [miss, paused, busy, own]) assert.equal(scene.calls.length, 0);
});

test('spontaneous: eavesdropReady is the eavesdrop rails as one boolean, with no roll', () => {
  const rng = () => {
    throw new Error('eavesdropReady never rolls');
  };
  assert.equal(roomScene({ rng }).spontaneous.eavesdropReady(roomScene({ rng }).channel), true);
  const rows = [
    ['paused', { store: fakeStore({ paused: true }) }],
    ['features.eavesdrop off', { config: baseConfig({}, { eavesdrop: false }) }],
    ['features.spontaneous off', { config: baseConfig({}, { spontaneous: false }) }],
    ['asleep', { config: baseConfig({ activeHours: { from: 14, to: 16 } }) }],
    ['minGapMinutes', { turns: { lastPostAt: () => Date.UTC(2026, 0, 5, 11, 55, 0) } }],
    ['one attention', { turns: { isAnyBusy: () => true } }],
    ['spontaneous.channels', { config: baseConfig({ channels: ['other'] }) }],
    ['another guild', { getGuildId: () => 'g2' }],
  ];
  for (const [label, options] of rows) {
    const scene = roomScene({ rng, ...options });
    assert.equal(scene.spontaneous.eavesdropReady(scene.channel), false, label);
  }
  const readOnly = roomScene({ rng });
  const cannotSend = fakeChannel('c2', fakeGuild('g1'), { permissionsFor: () => ({ has: () => false }) });
  assert.equal(readOnly.spontaneous.eavesdropReady(cannotSend), false, 'a channel the bot cannot send in');
});

// ---------------------------------------------------------------------------
// Server presence (spontaneous.someoneAroundMinutes): a tick starts a turn of
// the persona's own only when somebody wrote somewhere on the server lately.

test('someoneAround: open when any channel saw a message within the window, closed when all are older', () => {
  const now = 1_000_000_000;
  const cfg = { someoneAroundMinutes: 120 };
  const old = { lastActivity: now - 150 * MINUTE };
  const recent = { lastActivity: now - 100 * MINUTE };
  assert.equal(someoneAround([old, recent], now, cfg), true, 'one recent channel is enough');
  assert.equal(someoneAround([old, { lastActivity: now - 121 * MINUTE }], now, cfg), false, 'every channel older than the window');
  assert.equal(someoneAround([{ lastActivity: 0 }], now, cfg), false, 'a channel without messages');
  assert.equal(someoneAround([], now, cfg), false, 'no channels at all');
});

test('someoneAround: a channel whose last message is the persona\'s own post does not count', () => {
  const now = 1_000_000_000;
  const cfg = { someoneAroundMinutes: 120 };
  const own = { lastActivity: now - 10 * MINUTE, ownPostAt: now - 10 * MINUTE + 300 };
  const answered = { lastActivity: now - 5 * MINUTE, ownPostAt: now - 10 * MINUTE };
  assert.equal(someoneAround([own], now, cfg), false, 'the persona\'s own post is the newest message');
  assert.equal(someoneAround([own, answered], now, cfg), true, 'somebody wrote after the persona\'s post');
});

test('someoneAround: a non-positive, missing or non-number someoneAroundMinutes means no gate', () => {
  const now = 1_000_000_000;
  const dead = [{ lastActivity: now - 500 * HOUR }];
  for (const cfg of [{ someoneAroundMinutes: 0 }, { someoneAroundMinutes: -5 }, {}, { someoneAroundMinutes: '120' }]) {
    assert.equal(someoneAround(dead, now, cfg), true, JSON.stringify(cfg));
  }
});

function presenceScene({ ages, someoneAroundMinutes, lastPostAt }) {
  const guild = fakeGuild('g1');
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  for (const [id, minutes] of Object.entries(ages)) {
    guild.channels.cache.set(id, fakeChannel(id, guild, { lastMessageId: snowflake(t - minutes * MINUTE) }));
  }
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const store = fakeStore({ spontaneous: { g1: t } });
  const calls = [];
  const turns = fakeTurns({ runTurn: async (args) => { calls.push(args); return { outcome: 'spoke' }; }, lastPostAt });
  const spontaneous = createSpontaneous({
    hot: { config: baseConfig({ someoneAroundMinutes, maxChannelSilenceHours: 72 }) },
    store,
    client,
    turns,
    getGuildId: () => 'g1',
    rng: () => 0.1,
    now: () => t,
  });
  return { t, store, calls, spontaneous };
}

test('tick: nobody wrote anywhere within someoneAroundMinutes -- skipped, logged, pulled in like "not now"', async () => {
  const scene = presenceScene({ ages: { c1: 150, c2: 300 }, someoneAroundMinutes: 120 });
  const { logs } = await withCapturedLogs(() => scene.spontaneous.tick());

  assert.equal(scene.calls.length, 0, 'no turn starts on a silent server');
  const skipped = logs.filter((entry) => entry.msg === 'spontaneous: skipped');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'nobody-around');
  assert.equal(skipped[0].guildId, 'g1');
  const scheduled = scene.store.state.data.spontaneous.g1;
  assert.ok(scheduled > scene.t && scheduled <= scene.t + 40 * MINUTE, `expected a 10-40min pull-in, got ${scheduled - scene.t}ms`);
});

test('tick: one channel with a message inside someoneAroundMinutes opens the gate for the whole server', async () => {
  const scene = presenceScene({ ages: { c1: 150, c2: 30 }, someoneAroundMinutes: 120 });
  await scene.spontaneous.tick();
  assert.equal(scene.calls.length, 1);
});

test('tick: someoneAroundMinutes 0 never gates a tick', async () => {
  const scene = presenceScene({ ages: { c1: 150, c2: 300 }, someoneAroundMinutes: 0 });
  await scene.spontaneous.tick();
  assert.equal(scene.calls.length, 1);
});

test('tick: the persona\'s own recent post (turns.lastPostAt) does not keep the server "alive"', async () => {
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  // c1's newest message is the persona's own, 20 minutes ago; c2 last heard a member 300 minutes ago.
  const lastPostAt = (channelId) => (channelId === 'c1' ? t - 20 * MINUTE + 500 : 0);
  const scene = presenceScene({ ages: { c1: 20, c2: 300 }, someoneAroundMinutes: 120, lastPostAt });
  await scene.spontaneous.tick();
  assert.equal(scene.calls.length, 0);
});

// ---------------------------------------------------------------------------
// initiate cooldown (spontaneous.initiateCooldownHours)

const LIVE_AT = (t) => [
  msg({ ts: t - 10 * MINUTE, authorId: 'a' }),
  msg({ ts: t - 8 * MINUTE, authorId: 'b' }),
  msg({ ts: t - 5 * MINUTE, authorId: 'a' }),
  msg({ ts: t - 1 * MINUTE, authorId: 'c' }),
];

/**
 * A due tick whose turn runs the chooser it was given on `history(t)` (an empty
 * channel by default, so a won roll initiates) and resolves `result(mode)`.
 */
function cooldownScene({
  range,
  data = {},
  history = () => [],
  result = (mode) => (mode ? { outcome: 'spoke', mode, delivered: true } : { outcome: 'not-now' }),
  rng = () => 0.5,
  overrides = {},
} = {}) {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const clock = { t: Date.UTC(2026, 0, 5, 12, 0, 0) };
  const store = fakeStore({ spontaneous: { g1: clock.t }, ...data });
  const chosen = [];
  const calls = [];
  const turns = fakeTurns({
    runTurn: async (args) => {
      calls.push(args);
      const mode = args.mode === 'auto' ? args.chooseMode(history(clock.t), clock.t) : args.mode;
      chosen.push(mode);
      return result(mode);
    },
  });
  const spontaneousCfg = { initiateChance: 1, ...overrides };
  if (range !== undefined) spontaneousCfg.initiateCooldownHours = range;
  const hot = { config: baseConfig(spontaneousCfg) };
  const spontaneous = createSpontaneous({ hot, store, client, turns, getGuildId: () => 'g1', rng, now: () => clock.t });
  return { spontaneous, store, chosen, calls, clock, channel, hot };
}

test('chooseMode: with initiateAllowed false a dead or empty channel never initiates, a live one still interjects', () => {
  const now = 10_000_000;
  const dead = [msg({ ts: now - SPONTANEOUS_CFG.deadAfterMinutes * MINUTE - 1 })];
  const cfg = { ...SPONTANEOUS_CFG, initiateChance: 1 };
  assert.equal(chooseMode([], now, cfg, () => 0, { initiateAllowed: false }), null);
  assert.equal(chooseMode(dead, now, cfg, () => 0, { initiateAllowed: false }), null);
  assert.equal(chooseMode(LIVE_AT(now), now, cfg, () => 0, { initiateAllowed: false }), 'interject');
  assert.equal(chooseMode(dead, now, cfg, () => 0, { initiateAllowed: true }), 'initiate');
});

test('initiateCooldownUntil: the stored end while it is ahead and the range is on, else null', () => {
  const data = { spontaneousInitiateUntil: { g1: 5000 } };
  const cfg = { initiateCooldownHours: [1, 2] };
  assert.equal(initiateCooldownUntil(data, 'g1', 4999, cfg), 5000);
  assert.equal(initiateCooldownUntil(data, 'g1', 5000, cfg), null, 'over at its end');
  assert.equal(initiateCooldownUntil(data, 'g2', 4999, cfg), null, 'another guild has none');
  assert.equal(initiateCooldownUntil({}, 'g1', 4999, cfg), null);
  assert.equal(initiateCooldownUntil(data, 'g1', 4999, { initiateCooldownHours: [0, 0] }), null, 'a range switched off lifts it');
  assert.equal(initiateCooldownUntil(data, 'g1', 4999, { initiateCooldownHours: 3 }), null, 'a non-array lifts it');
  assert.equal(initiateCooldownUntil(data, 'g1', 4999, { initiateCooldownHours: [2, -1] }), null, 'a non-positive max lifts it');
});

test('tick: a spoke initiate starts a cooldown drawn from initiateCooldownHours and persists it in state', async () => {
  const scene = cooldownScene({ range: [2, 4], rng: () => 0.25 });
  const dirtyBefore = scene.store.dirtyCalls;
  const { logs } = await withCapturedLogs(() => scene.spontaneous.tick());

  assert.deepEqual(scene.chosen, ['initiate']);
  const until = scene.store.state.data.spontaneousInitiateUntil.g1;
  assert.ok(until >= scene.clock.t + 2 * HOUR && until <= scene.clock.t + 4 * HOUR, `got ${(until - scene.clock.t) / HOUR}h`);
  assert.equal(until, scene.clock.t + 2.5 * HOUR, 'between([2, 4], 0.25)');
  assert.ok(scene.store.dirtyCalls > dirtyBefore);
  const started = logs.filter((entry) => entry.msg === 'spontaneous: initiate cooldown');
  assert.deepEqual(started.map(({ guildId, until: end }) => ({ guildId, until: end })), [{ guildId: 'g1', until }]);
});

test('tick: within the cooldown the chooser never initiates (null or interject), and says so once per blocked chance', async () => {
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const until = t + HOUR;
  const dead = cooldownScene({ range: [2, 4], rng: () => 0, data: { spontaneousInitiateUntil: { g1: until } } });
  const { logs } = await withCapturedLogs(() => dead.spontaneous.tick());
  assert.deepEqual(dead.chosen, [null], 'a won roll in an empty channel is held back');
  assert.equal(dead.store.state.data.spontaneousInitiateUntil.g1, until, 'the cooldown is left as it was');
  const blocked = logs.filter((entry) => entry.msg === 'spontaneous: initiate on cooldown');
  assert.deepEqual(blocked.map(({ guildId, until: end }) => ({ guildId, until: end })), [{ guildId: 'g1', until }]);

  const live = cooldownScene({ range: [2, 4], rng: () => 0, history: LIVE_AT, data: { spontaneousInitiateUntil: { g1: until } } });
  const { logs: liveLogs } = await withCapturedLogs(() => live.spontaneous.tick());
  assert.deepEqual(live.chosen, ['interject'], 'interjecting into a live conversation is not on cooldown');
  assert.equal(liveLogs.filter((entry) => entry.msg === 'spontaneous: initiate on cooldown').length, 0, 'no initiate chance, nothing blocked');
});

test('tick: once the cooldown is over an initiate is possible again', async () => {
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const scene = cooldownScene({ range: [2, 4], rng: () => 0, data: { spontaneousInitiateUntil: { g1: t } } });
  await scene.spontaneous.tick();
  assert.deepEqual(scene.chosen, ['initiate']);
  assert.equal(scene.store.state.data.spontaneousInitiateUntil.g1, t + 2 * HOUR, 'and a new cooldown starts');
});

test('tick: a spoke interject, a skipped initiate or an initiate that reached nobody starts no cooldown', async () => {
  const interject = cooldownScene({ range: [2, 4], history: LIVE_AT });
  await interject.spontaneous.tick();
  assert.deepEqual(interject.chosen, ['interject']);
  assert.equal(interject.store.state.data.spontaneousInitiateUntil?.g1, undefined);

  const skipped = cooldownScene({ range: [2, 4], result: (mode) => ({ outcome: 'skip', mode }) });
  await skipped.spontaneous.tick();
  assert.equal(skipped.store.state.data.spontaneousInitiateUntil?.g1, undefined);

  const undelivered = cooldownScene({ range: [2, 4], result: (mode) => ({ outcome: 'spoke', mode, delivered: false }) });
  await undelivered.spontaneous.tick();
  assert.equal(undelivered.store.state.data.spontaneousInitiateUntil?.g1, undefined);
});

test('tick: a rehearsed (dry-run) initiate starts the cooldown like a real one', async () => {
  const scene = cooldownScene({ range: [2, 4], rng: () => 0, result: (mode) => ({ outcome: 'spoke', mode, dryRun: true }) });
  await scene.spontaneous.tick();
  assert.equal(scene.store.state.data.spontaneousInitiateUntil.g1, scene.clock.t + 2 * HOUR);
});

test('tick: initiateCooldownHours [0, 0], a non-array or a non-positive max means no cooldown', async () => {
  for (const range of [[0, 0], 'often', [3, 0]]) {
    const scene = cooldownScene({ range });
    await scene.spontaneous.tick();
    assert.deepEqual(scene.chosen, ['initiate'], String(range));
    assert.equal(scene.store.state.data.spontaneousInitiateUntil?.g1, undefined, String(range));
  }
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const lifted = cooldownScene({ range: [0, 0], rng: () => 0, data: { spontaneousInitiateUntil: { g1: t + HOUR } } });
  await lifted.spontaneous.tick();
  assert.deepEqual(lifted.chosen, ['initiate'], 'switched off, a stored cooldown does not hold');
});

test('force: a forced initiate ignores the cooldown and starts none', async () => {
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const until = t + HOUR;
  const scene = cooldownScene({ range: [2, 4], data: { spontaneousInitiateUntil: { g1: until } } });
  const result = await scene.spontaneous.force(scene.channel, 'initiate');
  assert.equal(result.outcome, 'spoke');
  assert.equal(scene.calls[0].mode, 'initiate');
  assert.equal(scene.calls[0].forced, true);
  assert.equal(scene.store.state.data.spontaneousInitiateUntil.g1, until, 'left as it was');

  const fresh = cooldownScene({ range: [2, 4] });
  await fresh.spontaneous.force(fresh.channel, 'initiate');
  assert.equal(fresh.store.state.data.spontaneousInitiateUntil?.g1, undefined);
});

test('onMessage: the eavesdrop chooser keeps the cooldown, an eavesdrop initiate starts one, a room turn never does', async () => {
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const eager = { eavesdropChance: 1, eavesdropDelayMs: [0, 0] };

  const held = cooldownScene({ range: [2, 4], rng: () => 0, overrides: eager, data: { spontaneousInitiateUntil: { g1: t + HOUR } } });
  held.spontaneous.onMessage(held.channel, { self: false, bot: false });
  await flushTimers();
  assert.deepEqual(held.chosen, [null]);

  const free = cooldownScene({ range: [2, 4], rng: () => 0, overrides: eager });
  free.spontaneous.onMessage(free.channel, { self: false, bot: false });
  await flushTimers();
  assert.deepEqual(free.chosen, ['initiate']);
  assert.equal(free.store.state.data.spontaneousInitiateUntil.g1, t + 2 * HOUR);

  const room = cooldownScene({ range: [2, 4], rng: () => 0, overrides: eager, history: () => [{ id: 'm7', self: false }] });
  room.spontaneous.onMessage(room.channel, { id: 'm7', self: false, bot: false }, { room: true });
  await flushTimers();
  assert.deepEqual(room.chosen, ['interject']);
  assert.equal(room.store.state.data.spontaneousInitiateUntil?.g1, undefined);
});
