// Tests for interfaces/discord/pull-fetch.js: fetching another channel for a turn's
// <channel_view> -- the rails before any fetch (each with its skip code), the
// one page cut to the window that ends at the channel's newest message, the
// routed trigger and the earlier calls of the ring, the ring's marks, the
// captions (cache first, fresh ones only for a turn certain to run, in
// parallel, under a timeout; a top-up for a pull made before the turn was
// certain), the failure paths and the logs. Discord objects are plain
// fixtures shaped just enough for the code to read; the describer and the
// timers are fakes; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OverwriteType, PermissionFlagsBits, PermissionsBitField, SnowflakeUtil } from 'discord.js';
import {
  audienceAllows,
  captionPulled,
  checkPull,
  fetchPull,
  isReadableChannel,
  normalizeMessage,
} from '../src/interface/discord.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
// The owner's example: the channel's last message was at 10:00 two days ago.
const LAST = Date.UTC(2026, 9, 3, 10, 0, 0);

const GUILD_ID = '700000000000000000';
const SELF_ID = '710000000000000001';
const ROLE = { regular: '720000000000000001', muted: '720000000000000002' };
const MEMBER = { zoe: '730000000000000001', iason: '730000000000000002' };
const MIRROR_ID = '740000000000000009';

const VIEW = PermissionFlagsBits.ViewChannel;
const READ = PermissionFlagsBits.ReadMessageHistory;
const SEND = PermissionFlagsBits.SendMessages;
const REACT = PermissionFlagsBits.AddReactions;

/** The live config with the shipped `context.pull` / `elsewhere` values; `over` replaces whole blocks. */
function config({ pull = {}, features = {}, bot = {} } = {}) {
  return {
    features: { mediaDescriptions: true, channelPull: true, elsewhere: true, ...features },
    bot: { dryRunChannelId: '', ...bot },
    context: {
      pull: {
        windowMinutes: 60,
        minMessages: 5,
        maxMessages: 60,
        maxPictures: 10,
        maxNewDescriptions: 8,
        describeTimeoutMs: 15000,
        scanMessages: 20,
        maxChannels: 1,
        maxAgeDays: 0,
        sameAudience: true,
        ...pull,
      },
    },
    elsewhere: { settleSeconds: 90, settleMaxSeconds: 300, rememberPings: 20, pingMaxAgeDays: 7 },
    media: { embedTextChars: 200, video: { sites: [] } },
  };
}

/** A guild with @everyone (views at the guild level) and two plain roles. */
function fakeGuild() {
  const everyone = { id: GUILD_ID, permissions: new PermissionsBitField(VIEW) };
  const roles = [everyone, ...Object.values(ROLE).map((id) => ({ id, permissions: new PermissionsBitField(0n) }))];
  return {
    id: GUILD_ID,
    members: { me: { id: SELF_ID } },
    roles: { everyone, cache: new Map(roles.map((role) => [role.id, role])) },
    channels: { cache: new Map() },
  };
}

/**
 * A text channel of `guild`. `granted`: the bot member's flags. `overwrites`:
 * `{ id, type, allow?, deny? }` with bigint flags, applied to a role like
 * Discord does (@everyone's overwrite, then the role's own). `messages`:
 * specs `{ ts, content?, authorId?, images?, mentionsSelf? }`, turned into raw
 * messages with real snowflake ids. The page fetch honours `limit` and
 * `before`; a string fetch returns one message; `fail` makes every fetch throw.
 */
function addChannel(
  guild,
  {
    id,
    name = id,
    granted = [READ, SEND, REACT],
    overwrites = [],
    messages = [],
    thread = false,
    text = true,
    fail = false,
  }
) {
  const overwriteCache = new Map(
    overwrites.map((o) => [
      o.id,
      {
        id: o.id,
        type: o.type,
        allow: new PermissionsBitField(o.allow ?? 0n),
        deny: new PermissionsBitField(o.deny ?? 0n),
      },
    ])
  );
  const resolveRole = (role) => {
    let bits = guild.roles.everyone.permissions.bitfield | role.permissions.bitfield;
    for (const roleId of role === guild.roles.everyone ? [GUILD_ID] : [GUILD_ID, role.id]) {
      const overwrite = overwriteCache.get(roleId);
      if (overwrite?.type === OverwriteType.Role) bits = (bits & ~overwrite.deny.bitfield) | overwrite.allow.bitfield;
    }
    return new PermissionsBitField(bits);
  };
  // A member (fakeMember): @everyone's and its roles' base, @everyone's overwrite, its roles'
  // overwrites together, then its own -- Discord's order.
  const resolveMember = (member) => {
    let bits = guild.roles.everyone.permissions.bitfield;
    for (const roleId of member.roleIds) bits |= guild.roles.cache.get(roleId)?.permissions.bitfield ?? 0n;
    const base = overwriteCache.get(GUILD_ID);
    if (base) bits = (bits & ~base.deny.bitfield) | base.allow.bitfield;
    let deny = 0n;
    let allow = 0n;
    for (const roleId of member.roleIds) {
      const overwrite = overwriteCache.get(roleId);
      if (overwrite?.type !== OverwriteType.Role) continue;
      deny |= overwrite.deny.bitfield;
      allow |= overwrite.allow.bitfield;
    }
    bits = (bits & ~deny) | allow;
    const own = overwriteCache.get(member.id);
    if (own?.type === OverwriteType.Member) bits = (bits & ~own.deny.bitfield) | own.allow.bitfield;
    return new PermissionsBitField(bits);
  };
  const raws = [];
  const fetchCalls = [];
  const channel = {
    id,
    name,
    guild,
    viewable: true,
    isTextBased: () => text,
    isThread: () => thread,
    permissionOverwrites: { cache: overwriteCache },
    permissionsFor: (target) => {
      if (target === guild.members.me) return { has: (flag) => granted.includes(flag) };
      if (Array.isArray(target?.roleIds)) return resolveMember(target);
      return [...guild.roles.cache.values()].includes(target) ? resolveRole(target) : null;
    },
    get lastMessageId() {
      return raws.at(-1)?.id ?? null;
    },
    raws,
    fetchCalls,
    messages: {
      cache: new Map(),
      fetch: async (query) => {
        fetchCalls.push(query);
        if (fail) throw new Error('Missing Access');
        if (typeof query === 'string') {
          const found = raws.find((m) => m.id === query);
          if (!found) throw new Error('Unknown Message');
          return found;
        }
        const before = query.before ? BigInt(query.before) : null;
        const page = raws
          .filter((m) => before === null || BigInt(m.id) < before)
          .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
          .slice(0, query.limit);
        return new Map(page.map((m) => [m.id, m]));
      },
    },
  };
  for (const spec of [...messages].sort((a, b) => a.ts - b.ts)) raws.push(rawMessage(channel, spec));
  guild.channels.cache.set(id, channel);
  return channel;
}

/** One raw image attachment. */
function rawImage(imageId) {
  return {
    id: imageId,
    contentType: 'image/png',
    name: `${imageId}.png`,
    url: `https://cdn.example/${imageId}.png`,
    size: 1000,
  };
}

/** A raw discord.js message of `channel` written at `ts`. */
function rawMessage(
  channel,
  { ts, content = 'καλημέρα σε όλους', authorId = MEMBER.zoe, images = [], mentionsSelf = false }
) {
  return {
    id: SnowflakeUtil.generate({ timestamp: ts }).toString(),
    channelId: channel.id,
    channel: { name: channel.name },
    guild: channel.guild,
    author: { id: authorId, bot: false, globalName: 'Zoé', username: 'zoe' },
    member: { displayName: 'Zoé' },
    content,
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(images.map((imageId) => [imageId, rawImage(imageId)])),
    stickers: new Map(),
    embeds: [],
    messageSnapshots: new Map(),
    flags: { has: () => false },
    mentions: { users: new Map(mentionsSelf ? [[SELF_ID, { id: SELF_ID }]] : []) },
  };
}

/** The public main channel the persona speaks in. */
function mainChannel(guild) {
  return addChannel(guild, { id: '750000000000000001', name: 'agora', messages: [{ ts: NOW - MIN }] });
}

/** A member of `guild` holding `roleIds` besides @everyone: a private chat's partner. */
function fakeMember(guild, id, roleIds = []) {
  return { id, guild, roleIds };
}

/** A private chat (a DM channel: no guild). */
function privateChat() {
  return { id: '790000000000000001', guild: null };
}

/** Message specs every `stepMinutes` from `fromTs` to `toTs` inclusive. */
function burst(fromTs, toTs, stepMinutes, extra = {}) {
  const out = [];
  for (let ts = fromTs; ts <= toTs; ts += stepMinutes * MIN) out.push({ ts, ...extra });
  return out;
}

/** The raw id of the message of `channel` written at `ts`. */
function idAt(channel, ts) {
  return channel.raws.find((m) => m.createdTimestamp === ts).id;
}

/**
 * A describer fake: `cached` item id -> caption already in the cache; `fresh`
 * item id -> caption a request returns at once; a request for an id in
 * `fail` rejects. With `deferred`, every describeMany call waits until the
 * test settles it (`settle(i, text)`).
 */
function fakeDescriber({ cached = {}, fresh = {}, fail = [], deferred = false } = {}) {
  const calls = { cached: [], many: [] };
  const pending = [];
  return {
    calls,
    pending,
    cachedDescriptions(guildId, items) {
      calls.cached.push({ guildId, ids: items.map((item) => item.itemId) });
      return new Map(items.filter((item) => cached[item.itemId]).map((item) => [item.itemId, cached[item.itemId]]));
    },
    describeMany(guildId, items, options) {
      calls.many.push({ guildId, ids: items.map((item) => item.itemId), options });
      const id = items[0].itemId;
      if (fail.includes(id)) return Promise.reject(new Error('provider unavailable'));
      const answer = (text) => ({ descriptions: new Map(text ? [[id, text]] : []), newCount: text ? 1 : 0 });
      if (!deferred) return Promise.resolve(answer(fresh[id]));
      return new Promise((resolve) => pending.push({ id, settle: (text) => resolve(answer(text)) }));
    },
  };
}

/** Timers whose timeout fires only when the test says so. */
function manualTimers() {
  const set = [];
  return {
    set,
    timers: {
      set: (fn, ms) => {
        const timer = {
          fn,
          ms,
          unrefed: false,
          cleared: false,
          unref() {
            this.unrefed = true;
          },
        };
        set.push(timer);
        return timer;
      },
      clear: (timer) => {
        if (timer) timer.cleared = true;
      },
    },
  };
}

/**
 * Make `channel`'s page fetch serve only the messages written at or after
 * `fromTs` (an older message is then off the page, as in a busy channel),
 * while a fetch by id still finds any message; `byId` replaces what a fetch
 * by id returns.
 */
function pageFrom(channel, fromTs, { byId = null } = {}) {
  const fetch = channel.messages.fetch;
  channel.messages.fetch = async (query) => {
    if (typeof query === 'string') {
      const found = await fetch(query);
      return byId ? byId(found) : found;
    }
    const map = await fetch(query);
    return new Map([...map].filter(([, m]) => m.createdTimestamp >= fromTs));
  };
}

/** A raw message discord.js could hand over but normalizeMessage cannot read (no author). */
function unreadable(raw) {
  return { ...raw, author: null };
}

/** Wait until `predicate` holds, a macrotask at a time. */
async function until(predicate) {
  for (let i = 0; i < 1000 && !predicate(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(predicate(), 'the condition never held');
}

/** fetchPull with the usual arguments; `over` replaces any of them. */
function pull(guild, channelId, over = {}) {
  return fetchPull({
    guild,
    channelId,
    destination: guild.channels.cache.get('750000000000000001') ?? null,
    reason: 'mention',
    config: config(),
    selfId: SELF_ID,
    now: NOW,
    ...over,
  });
}

// ---- the window ------------------------------------------------------------------

test("fetchPull: the window ends at the channel's newest message", async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const diary = addChannel(guild, {
    id: '760000000000000001',
    name: 'ημερολόγιο',
    messages: [{ ts: LAST - 180 * MIN }, { ts: LAST - 150 * MIN }, ...burst(LAST - 60 * MIN, LAST, 10)],
  });
  const { result, logs } = await withCapturedLogs(() => pull(guild, diary.id));
  const { pulled, skip } = result;
  assert.equal(skip, null);
  assert.deepEqual(
    Object.keys(result).sort(),
    ['pulled', 'skip'],
    'the record and the skip code, no discord.js channel'
  );
  assert.deepEqual(
    pulled.messages.map((m) => m.ts),
    burst(LAST - 60 * MIN, LAST, 10).map((spec) => spec.ts),
    'every message of 9:00-10:00 two days ago, nothing older, nothing measured from now'
  );
  assert.equal(pulled.olderNotShown, true);
  assert.equal(pulled.messages.at(-1).id, idAt(diary, LAST));
  assert.equal(pulled.channelId, diary.id);
  assert.equal(pulled.channelName, 'ημερολόγιο');
  assert.equal(pulled.reason, 'mention');
  assert.deepEqual(diary.fetchCalls, [{ limit: 100 }], 'one page, no anchor');
  const line = logs.find((entry) => entry.msg === 'pull: channel');
  assert.equal(line.messages, 7);
  assert.equal(line.source, diary.id);
  assert.equal(line.channel, '750000000000000001');
});

test('fetchPull: an explicit anchor ends the window at that message', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const diary = addChannel(guild, {
    id: '760000000000000002',
    messages: [...burst(LAST - 300 * MIN, LAST - 120 * MIN, 20), ...burst(LAST - 30 * MIN, LAST, 10)],
  });
  const anchorId = idAt(diary, LAST - 120 * MIN);
  const cfg = config({ pull: { minMessages: 2 } });
  const { pulled } = (await withCapturedLogs(() => pull(guild, diary.id, { anchorId, reason: 'recall', config: cfg })))
    .result;
  assert.deepEqual(
    pulled.messages.map((m) => m.ts),
    [LAST - 180 * MIN, LAST - 160 * MIN, LAST - 140 * MIN, LAST - 120 * MIN],
    'the hour before the anchor, nothing after it'
  );
  assert.equal(pulled.olderNotShown, true);
  assert.equal(pulled.messages.at(-1).id, anchorId);
  assert.equal(diary.fetchCalls.length, 1);
  assert.equal(BigInt(diary.fetchCalls[0].before), BigInt(anchorId) + 1n, 'the page ends at the anchor inclusive');
});

test('fetchPull: an earlier page ends just before the oldest message shown last time', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const diary = addChannel(guild, { id: '760000000000000011', messages: burst(LAST - 300 * MIN, LAST, 10) });
  const beforeId = idAt(diary, LAST - 60 * MIN);
  const { result, logs } = await withCapturedLogs(() =>
    pull(guild, diary.id, { reason: 'route', direction: 'earlier', beforeId })
  );
  const { pulled, skip } = result;
  assert.equal(skip, null);
  assert.deepEqual(
    diary.fetchCalls,
    [{ before: beforeId, limit: 61 }],
    'one page before the oldest message shown, the usual limit'
  );
  assert.deepEqual(
    pulled.messages.map((m) => m.ts),
    burst(LAST - 130 * MIN, LAST - 70 * MIN, 10).map((spec) => spec.ts),
    'the hour before the last view, nothing of it and nothing newer'
  );
  assert.equal(pulled.olderNotShown, true);
  const line = logs.find((entry) => entry.msg === 'pull: channel');
  assert.equal(line.direction, 'earlier');
  assert.equal(line.beforeId, true, 'only whether there was an id, never the id');
  assert.equal('pullDirection' in line, false);
  assert.ok(!JSON.stringify(logs).includes(beforeId), 'the id itself is not logged');
});

test('fetchPull: an earlier page without a previous view falls back to the newest page and says so', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const diary = addChannel(guild, { id: '760000000000000012', messages: burst(LAST - 300 * MIN, LAST, 10) });
  const { result, logs } = await withCapturedLogs(() =>
    pull(guild, diary.id, { reason: 'route', direction: 'earlier', beforeId: null })
  );
  assert.deepEqual(diary.fetchCalls, [{ limit: 100 }], 'the newest page, as a plain pull');
  assert.equal(result.pulled.messages.at(-1).id, idAt(diary, LAST));
  const line = logs.find((entry) => entry.msg === 'pull: channel');
  assert.equal(line.direction, 'earlier');
  assert.equal(line.beforeId, false);
  assert.equal(line.pullDirection, 'earlier-no-previous');
});

test('fetchPull: a plain pull logs no direction and ignores a stray beforeId', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const diary = addChannel(guild, { id: '760000000000000013', messages: burst(LAST - 300 * MIN, LAST, 10) });
  const beforeId = idAt(diary, LAST - 60 * MIN);
  const { result, logs } = await withCapturedLogs(() => pull(guild, diary.id, { beforeId }));
  assert.deepEqual(diary.fetchCalls, [{ limit: 100 }]);
  assert.equal(result.pulled.messages.at(-1).id, idAt(diary, LAST));
  const line = logs.find((entry) => entry.msg === 'pull: channel');
  assert.equal(line.direction, null);
  assert.equal('beforeId' in line || 'pullDirection' in line, false);
});

test('fetchPull: nothing before the previous view is an empty skip, a failed earlier page a failed fetch', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const diary = addChannel(guild, { id: '760000000000000014', messages: burst(LAST - 30 * MIN, LAST, 10) });
  const first = idAt(diary, LAST - 30 * MIN);
  const empty = await withCapturedLogs(() =>
    pull(guild, diary.id, { reason: 'route', direction: 'earlier', beforeId: first })
  );
  assert.equal(empty.result.skip, 'empty');
  const broken = addChannel(guild, {
    id: '760000000000000015',
    messages: burst(LAST - 30 * MIN, LAST, 10),
    fail: true,
  });
  const failed = await withCapturedLogs(() =>
    pull(guild, broken.id, { reason: 'route', direction: 'earlier', beforeId: first })
  );
  assert.equal(failed.result.skip, 'fetch-failed');
});

test('fetchPull: a malformed anchor is not found, an anchor older than a positive maxAgeDays is too old', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const diary = addChannel(guild, { id: '760000000000000005', messages: [{ ts: NOW - 40 * DAY }, { ts: NOW - DAY }] });
  const oldId = idAt(diary, NOW - 40 * DAY);
  const { result } = await withCapturedLogs(async () => [
    await pull(guild, diary.id, { anchorId: 'ημέρα' }),
    await pull(guild, diary.id, { anchorId: oldId, config: config({ pull: { maxAgeDays: 30 } }) }),
    await pull(guild, diary.id, { anchorId: oldId }),
  ]);
  assert.equal(result[0].skip, 'not-found');
  assert.equal(result[1].skip, 'too-old');
  assert.deepEqual(
    result[2].pulled.messages.map((m) => m.id),
    [oldId],
    'maxAgeDays 0: no age limit'
  );
  assert.equal(diary.fetchCalls.length, 1, 'only the last pull fetched');
});

test('fetchPull: the bot permissions give readOnly', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const diary = addChannel(guild, { id: '760000000000000003', granted: [READ, REACT], messages: [{ ts: LAST }] });
  const talk = addChannel(guild, { id: '760000000000000004', granted: [READ, SEND], messages: [{ ts: LAST }] });
  const { result } = await withCapturedLogs(async () => [await pull(guild, diary.id), await pull(guild, talk.id)]);
  assert.equal(result[0].pulled.readOnly, true);
  assert.equal(result[1].pulled.readOnly, false);
});

// ---- skips ------------------------------------------------------------------------

test('fetchPull: an unknown, thread, unreadable or non-text channel is skipped with its reason', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const thread = addChannel(guild, { id: '760000000000000011', thread: true, messages: [{ ts: LAST }] });
  const hidden = addChannel(guild, { id: '760000000000000012', granted: [SEND], messages: [{ ts: LAST }] });
  const category = addChannel(guild, { id: '760000000000000014', text: false, messages: [{ ts: LAST }] });
  const cfg = config();
  const cases = [
    ['760000000000000099', 'not-found'],
    [thread.id, 'thread'],
    [hidden.id, 'not-readable'],
    [category.id, 'not-text'],
  ];
  for (const [channelId, code] of cases) {
    const { result, logs } = await withCapturedLogs(() => pull(guild, channelId, { config: cfg }));
    assert.deepEqual(result, { pulled: null, skip: code }, code);
    const line = logs.find((entry) => entry.msg === 'pull: skipped');
    assert.deepEqual(
      { channel: line.channel, source: line.source, reason: line.reason, pullReason: line.pullReason },
      { channel: '750000000000000001', source: channelId, reason: code, pullReason: 'mention' }
    );
  }
  for (const channel of [thread, hidden, category]) assert.deepEqual(channel.fetchCalls, [], 'nothing fetched');
});

test('fetchPull: the dry-run channel is skipped with its own reason', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const mirror = addChannel(guild, { id: MIRROR_ID, messages: [{ ts: LAST }] });
  const { result, logs } = await withCapturedLogs(() =>
    pull(guild, MIRROR_ID, { config: config({ bot: { dryRunChannelId: MIRROR_ID } }) })
  );
  assert.deepEqual(result, { pulled: null, skip: 'dry-run-channel' });
  assert.equal(logs.find((entry) => entry.msg === 'pull: skipped').reason, 'dry-run-channel');
  assert.deepEqual(mirror.fetchCalls, []);
});

test('fetchPull: an empty channel and a failed fetch return their own skip codes', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const empty = addChannel(guild, { id: '760000000000000021' });
  const broken = addChannel(guild, { id: '760000000000000022', fail: true, messages: [{ ts: LAST }] });
  const { result, logs } = await withCapturedLogs(async () => [
    await pull(guild, empty.id),
    await pull(guild, broken.id),
  ]);
  assert.deepEqual(result[0], { pulled: null, skip: 'empty' });
  assert.deepEqual(result[1], { pulled: null, skip: 'fetch-failed' });
  assert.deepEqual(
    logs.filter((entry) => entry.msg === 'pull: skipped').map((entry) => entry.reason),
    ['empty', 'fetch-failed']
  );
});

test('fetchPull: a channel quieter than maxAgeDays is skipped, maxAgeDays 0 pulls it whatever its age', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const old = addChannel(guild, {
    id: '760000000000000031',
    messages: burst(NOW - 280 * DAY, NOW - 280 * DAY + 30 * MIN, 10),
  });
  const { result } = await withCapturedLogs(async () => [
    await pull(guild, old.id, { config: config({ pull: { maxAgeDays: 30 } }) }),
    await pull(guild, old.id, { config: config({ pull: { maxAgeDays: 0 } }) }),
  ]);
  assert.deepEqual(result[0], { pulled: null, skip: 'too-old' });
  assert.equal(old.fetchCalls.length, 1, 'only the second pull fetched: the too-old refusal made no request');
  assert.equal(result[1].skip, null);
  assert.equal(result[1].pulled.messages.length, 4);
});

// ---- the audience rail ----------------------------------------------------------

test('fetchPull: the audience rail blocks a narrower source', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const narrow = addChannel(guild, {
    id: '760000000000000041',
    overwrites: [
      { id: GUILD_ID, type: OverwriteType.Role, deny: VIEW },
      { id: ROLE.regular, type: OverwriteType.Role, allow: VIEW },
    ],
    messages: [{ ts: LAST }],
  });
  const { result, logs } = await withCapturedLogs(() => pull(guild, narrow.id));
  assert.deepEqual(result, { pulled: null, skip: 'audience' });
  assert.equal(logs.find((entry) => entry.msg === 'pull: skipped').reason, 'audience');
  assert.deepEqual(narrow.fetchCalls, []);
});

test('fetchPull: a role denied on a source @everyone can view still blocks it', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const source = addChannel(guild, {
    id: '760000000000000042',
    overwrites: [{ id: ROLE.muted, type: OverwriteType.Role, deny: VIEW }],
    messages: [{ ts: LAST }],
  });
  const { result } = await withCapturedLogs(() => pull(guild, source.id));
  assert.equal(result.skip, 'audience', 'members of the muted role see the main channel but not the source');
});

test('audienceAllows: same audience passes, a narrower source or no destination does not unless the rail is off', () => {
  const guild = fakeGuild();
  const main = mainChannel(guild);
  const open = addChannel(guild, { id: '760000000000000044' });
  const narrow = addChannel(guild, {
    id: '760000000000000045',
    overwrites: [{ id: MEMBER.zoe, type: OverwriteType.Member, deny: VIEW }],
  });
  assert.equal(audienceAllows(main, open, config()), true);
  assert.equal(audienceAllows(main, narrow, config()), false, 'a member denied on the source only');
  assert.equal(audienceAllows(null, open, config()), false, 'no destination never qualifies');
  assert.equal(audienceAllows(main, narrow, config({ pull: { sameAudience: false } })), true);
  assert.equal(audienceAllows(null, narrow, config({ pull: { sameAudience: false } })), true);
});

test('checkPull: the rails without a request, the channel when they pass', () => {
  const guild = fakeGuild();
  const main = mainChannel(guild);
  const diary = addChannel(guild, { id: '760000000000000046', granted: [READ], messages: [{ ts: LAST }] });
  assert.deepEqual(checkPull({ guild, channelId: diary.id, destination: main, config: config(), now: NOW }), {
    channel: diary,
    skip: null,
  });
  assert.deepEqual(checkPull({ guild, channelId: diary.id, destination: null, config: config(), now: NOW }), {
    channel: null,
    skip: 'audience',
  });
  assert.deepEqual(checkPull({ guild, channelId: undefined, destination: main, config: config(), now: NOW }), {
    channel: null,
    skip: 'not-found',
  });
  const privateChat = { id: '790000000000000001', guild: null };
  const railOff = config({ pull: { sameAudience: false } });
  assert.deepEqual(
    checkPull({ guild, channelId: diary.id, destination: privateChat, config: railOff, now: NOW }),
    { channel: null, skip: 'private-chat' },
    'a private chat never pulls, even with the audience rail off'
  );
  assert.deepEqual(checkPull({ guild, channelId: diary.id, destination: null, config: railOff, now: NOW }), {
    channel: diary,
    skip: null,
  });
  assert.deepEqual(diary.fetchCalls, []);
});

test('audienceAllows: a private chat lets in exactly the sources its partner can view, whatever the audience rail', () => {
  const guild = fakeGuild();
  const open = addChannel(guild, { id: '760000000000000047' });
  const closed = addChannel(guild, {
    id: '760000000000000048',
    overwrites: [
      { id: GUILD_ID, type: OverwriteType.Role, deny: VIEW },
      { id: ROLE.regular, type: OverwriteType.Role, allow: VIEW },
    ],
  });
  const named = addChannel(guild, {
    id: '760000000000000049',
    overwrites: [{ id: MEMBER.zoe, type: OverwriteType.Member, deny: VIEW }],
  });
  const zoe = fakeMember(guild, MEMBER.zoe, [ROLE.regular]);
  const iason = fakeMember(guild, MEMBER.iason);
  for (const rail of [config(), config({ pull: { sameAudience: false } })]) {
    assert.equal(audienceAllows(privateChat(), open, rail, { partner: iason }), true);
    assert.equal(audienceAllows(privateChat(), closed, rail, { partner: zoe }), true, 'her role views it');
    assert.equal(
      audienceAllows(privateChat(), closed, rail, { partner: iason }),
      false,
      'he holds no role that views it'
    );
    assert.equal(audienceAllows(privateChat(), named, rail, { partner: zoe }), false, 'denied by name');
    assert.equal(audienceAllows(privateChat(), named, rail, { partner: iason }), true);
    assert.equal(audienceAllows(privateChat(), open, rail), false, 'no partner never qualifies');
  }
});

test('checkPull: a private chat with its partner passes what the partner can view, refuses the rest as audience', () => {
  const guild = fakeGuild();
  const open = addChannel(guild, { id: '760000000000000050', granted: [READ], messages: [{ ts: LAST }] });
  const closed = addChannel(guild, {
    id: '760000000000000051',
    overwrites: [{ id: MEMBER.iason, type: OverwriteType.Member, deny: VIEW }],
    messages: [{ ts: LAST }],
  });
  const iason = fakeMember(guild, MEMBER.iason);
  const dm = privateChat();
  assert.deepEqual(
    checkPull({ guild, channelId: open.id, destination: dm, partner: iason, config: config(), now: NOW }),
    { channel: open, skip: null }
  );
  assert.deepEqual(
    checkPull({ guild, channelId: closed.id, destination: dm, partner: iason, config: config(), now: NOW }),
    { channel: null, skip: 'audience' }
  );
  assert.deepEqual(
    checkPull({
      guild,
      channelId: closed.id,
      destination: dm,
      partner: iason,
      config: config({ pull: { sameAudience: false } }),
      now: NOW,
    }),
    { channel: null, skip: 'audience' },
    'the partner rule holds with the audience rail off'
  );
  assert.deepEqual(checkPull({ guild, channelId: open.id, destination: dm, config: config(), now: NOW }), {
    channel: null,
    skip: 'private-chat',
  });
  assert.deepEqual(
    checkPull({ guild, channelId: '760000000000000059', destination: dm, partner: iason, config: config(), now: NOW }),
    { channel: null, skip: 'not-found' }
  );
});

test('fetchPull: a private chat with its partner fetches a channel the partner can view, nothing of one they cannot', async () => {
  const guild = fakeGuild();
  const open = addChannel(guild, { id: '760000000000000052', messages: burst(NOW - 30 * MIN, NOW - 10 * MIN, 10) });
  const closed = addChannel(guild, {
    id: '760000000000000053',
    overwrites: [{ id: MEMBER.iason, type: OverwriteType.Member, deny: VIEW }],
    messages: [{ ts: LAST }],
  });
  const iason = fakeMember(guild, MEMBER.iason);
  const { result } = await withCapturedLogs(async () => [
    await pull(guild, open.id, { destination: privateChat(), partner: iason }),
    await pull(guild, closed.id, { destination: privateChat(), partner: iason }),
    await pull(guild, open.id, { destination: privateChat() }),
  ]);
  assert.equal(result[0].skip, null);
  assert.equal(result[0].pulled.channelId, open.id);
  assert.equal(result[0].pulled.messages.length, 3);
  assert.deepEqual(result[1], { pulled: null, skip: 'audience' });
  assert.deepEqual(closed.fetchCalls, []);
  assert.deepEqual(result[2], { pulled: null, skip: 'private-chat' });
});

test('checkPull: refuses exactly the channels isReadableChannel refuses', () => {
  const guild = fakeGuild();
  const main = mainChannel(guild);
  const bot = { dryRunChannelId: MIRROR_ID };
  const channels = [
    addChannel(guild, { id: '760000000000000091', messages: [{ ts: LAST }] }),
    addChannel(guild, { id: '760000000000000092', thread: true, messages: [{ ts: LAST }] }),
    addChannel(guild, { id: '760000000000000093', granted: [SEND], messages: [{ ts: LAST }] }),
    addChannel(guild, { id: '760000000000000094', messages: [{ ts: LAST }] }),
    addChannel(guild, { id: MIRROR_ID, messages: [{ ts: LAST }] }),
    addChannel(guild, { id: '760000000000000095', text: false, messages: [{ ts: LAST }] }),
  ];
  const readableCodes = new Set(['not-text', 'thread', 'dry-run-channel', 'not-readable']);
  for (const channel of channels) {
    const { skip } = checkPull({ guild, channelId: channel.id, destination: main, config: config({ bot }), now: NOW });
    assert.equal(readableCodes.has(skip), !isReadableChannel(channel, bot), `${channel.id}: ${skip}`);
  }
});

// ---- the routed trigger and the ring --------------------------------------------

test('fetchPull: a routed trigger outside the window is added', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const diary = addChannel(guild, {
    id: '760000000000000051',
    granted: [READ, REACT],
    messages: [{ ts: LAST - 240 * MIN, mentionsSelf: true }, ...burst(LAST - 50 * MIN, LAST, 10)],
  });
  const triggerRaw = diary.raws[0];
  // The copy messageCreate handed over, before an edit: the page's copy is shown instead.
  const trigger = { ...normalizeMessage(triggerRaw, SELF_ID), content: 'πριν από την αλλαγή' };
  const pings = [{ messageId: trigger.id, channelId: diary.id, ts: trigger.ts, answeredAt: null, skippedAt: null }];
  const { pulled } = (await withCapturedLogs(() => pull(guild, diary.id, { reason: 'routed', trigger, pings }))).result;
  assert.equal(pulled.messages[0].id, trigger.id, 'the call comes first, before the window');
  assert.equal(pulled.messages.length, 7);
  assert.notEqual(pulled.messages[0], trigger, "the page's copy, not the given one");
  assert.equal(pulled.messages[0].content, 'καλημέρα σε όλους');
  assert.deepEqual(
    [...pulled.earlierPingIds],
    [trigger.id],
    'shown before the window, so the window keeps its own span'
  );
  assert.equal(pulled.pingState.has(trigger.id), false, 'the trigger itself carries no mark');
  assert.deepEqual(diary.fetchCalls, [{ limit: 100 }], 'the page holds the trigger: never fetched by id');
});

test('fetchPull: a routed trigger deleted before the pull is not shown', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const diary = addChannel(guild, {
    id: '760000000000000054',
    granted: [READ, REACT],
    messages: [
      { ts: LAST - 240 * MIN, mentionsSelf: true },
      ...burst(LAST - 50 * MIN, LAST, 10),
      { ts: LAST - 25 * MIN, mentionsSelf: true },
    ],
  });
  const older = normalizeMessage(diary.raws[0], SELF_ID);
  const inside = normalizeMessage(
    diary.raws.find((m) => m.createdTimestamp === LAST - 25 * MIN),
    SELF_ID
  );
  // Both calls are deleted during the settle wait.
  diary.raws.splice(
    diary.raws.findIndex((m) => m.id === inside.id),
    1
  );
  diary.raws.splice(0, 1);
  const { result, logs } = await withCapturedLogs(async () => [
    await pull(guild, diary.id, { reason: 'routed', trigger: inside }),
    await pull(guild, diary.id, { reason: 'routed', trigger: older }),
  ]);
  assert.deepEqual(result[0], { pulled: null, skip: 'trigger-gone' });
  assert.deepEqual(result[1], { pulled: null, skip: 'trigger-gone' });
  assert.deepEqual(
    diary.fetchCalls,
    [{ limit: 100 }, { limit: 100 }, older.id],
    'a call inside the page span is known gone without a request; one older than the page is asked for once'
  );
  assert.deepEqual(
    logs.filter((entry) => entry.msg === 'pull: skipped').map((entry) => [entry.reason, entry.pullReason]),
    [
      ['trigger-gone', 'routed'],
      ['trigger-gone', 'routed'],
    ]
  );
});

test('fetchPull: a routed trigger older than the page is fetched by id and shown before the window', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const diary = addChannel(guild, {
    id: '760000000000000055',
    granted: [READ, REACT],
    messages: [{ ts: LAST - 240 * MIN, mentionsSelf: true }, ...burst(LAST - 50 * MIN, LAST, 10)],
  });
  const trigger = { ...normalizeMessage(diary.raws[0], SELF_ID), content: 'πριν από την αλλαγή' };
  pageFrom(diary, LAST - 50 * MIN);
  const { pulled, skip } = (await withCapturedLogs(() => pull(guild, diary.id, { reason: 'routed', trigger }))).result;
  assert.equal(skip, null);
  assert.deepEqual(diary.fetchCalls, [{ limit: 100 }, trigger.id]);
  assert.equal(pulled.messages[0].id, trigger.id);
  assert.equal(pulled.messages[0].content, 'καλημέρα σε όλους', 'the copy the channel holds now');
  assert.deepEqual([...pulled.earlierPingIds], [trigger.id]);
  assert.equal(pulled.messages.length, 7);
});

test('fetchPull: a trigger already in the window is kept once, a trigger of another channel never enters', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const diary = addChannel(guild, { id: '760000000000000052', messages: burst(LAST - 30 * MIN, LAST, 10) });
  const other = addChannel(guild, { id: '760000000000000053', messages: [{ ts: LAST - 300 * MIN }] });
  const inside = normalizeMessage(diary.raws[1], SELF_ID);
  const foreign = normalizeMessage(other.raws[0], SELF_ID);
  const { result } = await withCapturedLogs(async () => [
    await pull(guild, diary.id, { trigger: inside }),
    await pull(guild, diary.id, { trigger: foreign }),
  ]);
  assert.equal(result[0].pulled.messages.filter((m) => m.id === inside.id).length, 1);
  assert.equal(result[0].pulled.messages.length, 4);
  assert.equal(
    result[1].pulled.messages.some((m) => m.id === foreign.id),
    false
  );
});

test('fetchPull: an unanswered ring ping outside the window is fetched and marked', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const diary = addChannel(guild, {
    id: '760000000000000061',
    messages: [
      { ts: LAST - 300 * MIN, mentionsSelf: true },
      { ts: LAST - 280 * MIN, mentionsSelf: true },
      { ts: LAST - 260 * MIN, mentionsSelf: true },
      ...burst(LAST - 50 * MIN, LAST, 10),
    ],
  });
  const [unanswered, answered, skipped] = diary.raws;
  const ring = [
    {
      messageId: unanswered.id,
      channelId: diary.id,
      ts: unanswered.createdTimestamp,
      answeredAt: null,
      skippedAt: null,
    },
    {
      messageId: answered.id,
      channelId: diary.id,
      ts: answered.createdTimestamp,
      answeredAt: LAST - 270 * MIN,
      skippedAt: null,
    },
    {
      messageId: skipped.id,
      channelId: diary.id,
      ts: skipped.createdTimestamp,
      answeredAt: null,
      skippedAt: LAST - 250 * MIN,
    },
    {
      messageId: '769999999999999999',
      channelId: '760000000000000099',
      ts: LAST - 100 * MIN,
      answeredAt: null,
      skippedAt: null,
    },
  ];
  // Only the newest page is served, so the call outside it must be fetched by id.
  const page = diary.messages.fetch;
  diary.messages.fetch = async (query) => {
    if (typeof query === 'string') return page(query);
    const map = await page(query);
    return new Map([...map].filter(([, m]) => m.createdTimestamp >= LAST - 50 * MIN));
  };
  const { result, logs } = await withCapturedLogs(() => pull(guild, diary.id, { pings: ring }));
  const { pulled } = result;
  assert.deepEqual(
    pulled.messages.map((m) => m.id),
    [unanswered.id, ...diary.raws.slice(3).map((m) => m.id)]
  );
  assert.deepEqual([...pulled.earlierPingIds], [unanswered.id]);
  assert.deepEqual([...pulled.pingState], [[unanswered.id, 'unanswered']]);
  assert.ok(diary.fetchCalls.includes(unanswered.id), 'fetched by id');
  assert.equal(
    diary.fetchCalls.includes(answered.id) || diary.fetchCalls.includes(skipped.id),
    false,
    'answered and skipped calls stay out'
  );
  const line = logs.find((entry) => entry.msg === 'pull: channel');
  assert.deepEqual([line.earlier, line.earlierGone, line.pings], [1, 0, 1]);
});

test('fetchPull: an earlier call already on the page is taken from it, an expired or vanished one is left out', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const diary = addChannel(guild, {
    id: '760000000000000062',
    messages: [{ ts: LAST - 9 * DAY }, { ts: LAST - 200 * MIN }, ...burst(LAST - 50 * MIN, LAST, 10)],
  });
  const [expired, onPage] = diary.raws;
  const ring = [
    { messageId: expired.id, channelId: diary.id, ts: expired.createdTimestamp, answeredAt: null, skippedAt: null },
    { messageId: onPage.id, channelId: diary.id, ts: onPage.createdTimestamp, answeredAt: null, skippedAt: null },
    { messageId: '760000000000000777', channelId: diary.id, ts: LAST - 190 * MIN, answeredAt: null, skippedAt: null },
  ];
  const { result, logs } = await withCapturedLogs(() => pull(guild, diary.id, { pings: ring, now: LAST + MIN }));
  const { pulled } = result;
  assert.deepEqual([...pulled.earlierPingIds], [onPage.id]);
  assert.equal(pulled.messages[0].id, onPage.id);
  assert.equal(diary.fetchCalls.includes(onPage.id), false, 'no second request for a message the page holds');
  assert.equal(diary.fetchCalls.includes(expired.id), false, 'an expired ring entry is not fetched');
  assert.ok(diary.fetchCalls.includes('760000000000000777'), 'a deleted call is asked for once and dropped');
  const line = logs.find((entry) => entry.msg === 'pull: channel');
  assert.deepEqual([line.earlier, line.earlierGone], [1, 1], 'the deleted call is counted as gone');
});

test('fetchPull: ring calls inside the window are marked answered, skipped or unanswered', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const diary = addChannel(guild, { id: '760000000000000063', messages: burst(LAST - 50 * MIN, LAST, 10) });
  const [a, b, c] = diary.raws;
  const entry = (raw, answeredAt, skippedAt) => ({
    messageId: raw.id,
    channelId: diary.id,
    ts: raw.createdTimestamp,
    answeredAt,
    skippedAt,
  });
  const ring = [entry(a, LAST - 45 * MIN, null), entry(b, null, LAST - 35 * MIN), entry(c, null, null)];
  const { pulled } = (await withCapturedLogs(() => pull(guild, diary.id, { pings: ring }))).result;
  assert.deepEqual(
    [...pulled.pingState],
    [
      [a.id, 'answered'],
      [b.id, 'skipped'],
      [c.id, 'unanswered'],
    ]
  );
  assert.equal(pulled.earlierPingIds.size, 0);
});

// ---- captions ------------------------------------------------------------------

/** A channel whose `count` messages in the last half hour before LAST carry one image each, `p1` oldest. */
function pictureChannel(guild, id, count) {
  const messages = [];
  for (let i = 1; i <= count; i += 1) messages.push({ ts: LAST - (count - i) * MIN, images: [`p${i}`] });
  return addChannel(guild, { id, messages });
}

test('fetchPull: cached captions are used for every picture, fresh ones only within maxPictures and maxNewDescriptions', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const channel = pictureChannel(guild, '760000000000000071', 5);
  const describer = fakeDescriber({
    cached: { p4: 'λεζάντα p4', p1: 'λεζάντα p1' },
    fresh: { p5: 'νέα p5', p3: 'νέα p3' },
  });
  const cfg = config({ pull: { maxPictures: 3, maxNewDescriptions: 1 } });
  const { result, logs } = await withCapturedLogs(() =>
    pull(guild, channel.id, { config: cfg, describer, turnCertain: true })
  );
  const { pulled } = result;
  assert.deepEqual(
    describer.calls.cached,
    [{ guildId: GUILD_ID, ids: ['p5', 'p4', 'p3', 'p2', 'p1'] }],
    'the cache is asked for every picture'
  );
  assert.deepEqual(describer.calls.many, [{ guildId: GUILD_ID, ids: ['p5'], options: { maxNew: 1 } }]);
  assert.deepEqual([...pulled.descriptions].sort(), [
    ['p1', 'λεζάντα p1'],
    ['p4', 'λεζάντα p4'],
    ['p5', 'νέα p5'],
  ]);
  assert.equal(pulled.picturesNotSeen, 2, 'p3 (no fresh slot left) and p2 (past maxPictures, not cached)');
  const line = logs.find((entry) => entry.msg === 'pull: channel');
  assert.deepEqual(
    {
      pictures: line.pictures,
      cached: line.cached,
      asked: line.asked,
      fresh: line.fresh,
      late: line.late,
      notSeen: line.notSeen,
    },
    { pictures: 5, cached: 2, asked: 1, fresh: 1, late: 0, notSeen: 2 }
  );
});

test('fetchPull: cached emoji captions are used and never counted as pictures', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const emojiId = '780000000000000001';
  const channel = addChannel(guild, {
    id: '760000000000000077',
    messages: [
      { ts: LAST - MIN, images: ['p1'] },
      { ts: LAST, content: `ωραία <:kardia:${emojiId}>` },
    ],
  });
  const describer = fakeDescriber({ cached: { [`emoji:${emojiId}`]: 'λεζάντα emoji' }, fresh: { p1: 'νέα p1' } });
  const { result, logs } = await withCapturedLogs(() => pull(guild, channel.id, { describer, turnCertain: true }));
  const { pulled } = result;
  assert.equal(pulled.descriptions.get(`emoji:${emojiId}`), 'λεζάντα emoji');
  assert.ok(describer.calls.cached[0].ids.includes(`emoji:${emojiId}`), 'the cache is asked for the emoji');
  assert.deepEqual(
    describer.calls.many.map((call) => call.ids),
    [['p1']],
    'no fresh request for an emoji'
  );
  assert.equal(pulled.picturesNotSeen, 0);
  const line = logs.find((entry) => entry.msg === 'pull: channel');
  assert.deepEqual(
    [line.pictures, line.cached, line.asked, line.fresh, line.notSeen],
    [1, 0, 1, 1, 0],
    'the emoji is no picture'
  );
});

test('fetchPull: a cached caption after the eighth fresh one is still used', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const channel = pictureChannel(guild, '760000000000000072', 12);
  const fresh = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`p${i + 1}`, `νέα p${i + 1}`]));
  const describer = fakeDescriber({ cached: { p4: 'λεζάντα p4', p2: 'λεζάντα p2' }, fresh });
  const { pulled } = (await withCapturedLogs(() => pull(guild, channel.id, { describer, turnCertain: true }))).result;
  assert.deepEqual(
    describer.calls.many.map((call) => call.ids[0]),
    ['p12', 'p11', 'p10', 'p9', 'p8', 'p7', 'p6', 'p5'],
    'eight fresh requests, newest first, one picture each'
  );
  assert.equal(pulled.descriptions.get('p4'), 'λεζάντα p4', 'the ninth picture keeps its cached caption');
  assert.equal(pulled.descriptions.get('p2'), 'λεζάντα p2', 'a picture past maxPictures keeps its cached caption');
  assert.equal(pulled.descriptions.has('p3'), false);
  assert.equal(pulled.picturesNotSeen, 2, 'p3 and p1');
});

test('fetchPull: fresh captions run in parallel and a late one renders blind', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const channel = pictureChannel(guild, '760000000000000073', 3);
  const describer = fakeDescriber({ deferred: true });
  const { set, timers } = manualTimers();
  const { result, logs } = await withCapturedLogs(async () => {
    const running = pull(guild, channel.id, { describer, turnCertain: true, timers });
    await until(() => describer.pending.length === 3);
    assert.equal(set.length, 1, 'one timeout for the whole batch');
    assert.equal(set[0].ms, 15000, 'describeTimeoutMs');
    assert.equal(set[0].unrefed, true, 'the timer never keeps the process alive');
    describer.pending[0].settle('νέα p3');
    describer.pending[1].settle('νέα p2');
    await new Promise((resolve) => setImmediate(resolve));
    set[0].fn(); // the timeout: p1 is still out
    const done = await running;
    describer.pending[2].settle('νέα p1'); // too late for this turn
    await new Promise((resolve) => setImmediate(resolve));
    return done;
  });
  const { pulled } = result;
  assert.deepEqual(
    describer.calls.many.map((call) => call.ids[0]),
    ['p3', 'p2', 'p1'],
    'all three asked before any answered'
  );
  assert.deepEqual([...pulled.descriptions.keys()].sort(), ['p2', 'p3']);
  assert.equal(pulled.picturesNotSeen, 1);
  const line = logs.find((entry) => entry.msg === 'pull: channel');
  assert.deepEqual([line.asked, line.fresh, line.late], [3, 2, 1]);
});

test('fetchPull: without turnCertain only cached captions are used', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const channel = pictureChannel(guild, '760000000000000075', 3);
  const describer = fakeDescriber({ cached: { p2: 'λεζάντα p2' }, fresh: { p1: 'νέα p1', p3: 'νέα p3' } });
  const { pulled } = (await withCapturedLogs(() => pull(guild, channel.id, { describer }))).result;
  assert.deepEqual(describer.calls.many, [], 'no request before the turn is certain to run');
  assert.deepEqual([...pulled.descriptions], [['p2', 'λεζάντα p2']]);
  assert.equal(pulled.picturesNotSeen, 2);
});

test('fetchPull: mediaDescriptions off makes no describer call', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const channel = pictureChannel(guild, '760000000000000076', 2);
  const describer = fakeDescriber({ cached: { p1: 'λεζάντα p1' }, fresh: { p2: 'νέα p2' } });
  const cfg = config({ features: { mediaDescriptions: false } });
  const { pulled } = (
    await withCapturedLogs(() => pull(guild, channel.id, { config: cfg, describer, turnCertain: true }))
  ).result;
  assert.deepEqual(describer.calls, { cached: [], many: [] });
  assert.equal(pulled.descriptions.size, 0);
  assert.equal(pulled.picturesNotSeen, 2);
});

// ---- the caption top-up -----------------------------------------------------------

test('captionPulled: a top-up makes no Discord request and asks only for uncached pictures within the limits', async () => {
  const guild = fakeGuild();
  const main = mainChannel(guild);
  const channel = pictureChannel(guild, '760000000000000078', 5);
  const describer = fakeDescriber({ cached: { p4: 'λεζάντα p4' }, fresh: { p5: 'νέα p5', p3: 'νέα p3' } });
  const cfg = config({ pull: { maxPictures: 3, maxNewDescriptions: 1 } });
  const { result, logs } = await withCapturedLogs(async () => {
    const before = await pull(guild, channel.id, { config: cfg, describer });
    const requests = channel.fetchCalls.length;
    const after = await captionPulled(before.pulled, { describer, guildId: GUILD_ID, config: cfg, destination: main });
    return { before: before.pulled, after, requests };
  });
  const { before, after, requests } = result;
  assert.equal(channel.fetchCalls.length, requests, 'no Discord request');
  assert.deepEqual(
    describer.calls.many.map((call) => call.ids),
    [['p5']],
    'within maxPictures and maxNewDescriptions'
  );
  assert.deepEqual(
    describer.calls.cached.at(-1).ids,
    ['p5', 'p3', 'p2', 'p1'],
    'the cache is asked again, never for a known caption'
  );
  assert.deepEqual([...after.descriptions].sort(), [
    ['p4', 'λεζάντα p4'],
    ['p5', 'νέα p5'],
  ]);
  assert.equal(after.picturesNotSeen, 3);
  assert.equal(after.messages, before.messages, 'the same lines');
  assert.deepEqual(
    [[...before.descriptions], before.picturesNotSeen],
    [[['p4', 'λεζάντα p4']], 4],
    'the given record is not changed'
  );
  const line = logs.find((entry) => entry.msg === 'pull: captions');
  assert.deepEqual(
    { channel: line.channel, source: line.source, pullReason: line.pullReason },
    { channel: main.id, source: channel.id, pullReason: 'mention' }
  );
  assert.deepEqual([line.pictures, line.cached, line.asked, line.fresh, line.late, line.notSeen], [5, 1, 1, 1, 0, 3]);
});

test('captionPulled: a late caption renders blind, and the timer is cleared when all arrive in time', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const channel = pictureChannel(guild, '760000000000000079', 2);
  const describer = fakeDescriber({ deferred: true });
  const { set, timers } = manualTimers();
  const { result } = await withCapturedLogs(async () => {
    const { pulled } = await pull(guild, channel.id, { describer });
    const late = captionPulled(pulled, { describer, guildId: GUILD_ID, config: config(), timers });
    await until(() => describer.pending.length === 2);
    assert.equal(set[0].unrefed, true, 'the timer never keeps the process alive');
    describer.pending[0].settle('νέα p2');
    await new Promise((resolve) => setImmediate(resolve));
    set[0].fn(); // the timeout: p1 is still out
    const blind = await late;
    describer.pending[1].settle('νέα p1'); // too late for this turn
    const inTime = captionPulled(pulled, { describer, guildId: GUILD_ID, config: config(), timers });
    await until(() => describer.pending.length === 4);
    describer.pending[2].settle('νέα p2');
    describer.pending[3].settle('νέα p1');
    return { blind, inTime: await inTime };
  });
  assert.deepEqual([...result.blind.descriptions.keys()], ['p2']);
  assert.equal(result.blind.picturesNotSeen, 1);
  assert.equal(result.inTime.descriptions.size, 2);
  assert.equal(set.length, 2);
  assert.equal(set[1].cleared, true, 'every caption arrived: the timer is cleared');
});

// ---- failure paths ------------------------------------------------------------------

test('fetchPull: a page message that cannot be read skips with fetch-failed', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const diary = addChannel(guild, { id: '760000000000000082', messages: burst(LAST - 30 * MIN, LAST, 10) });
  diary.raws[1] = unreadable(diary.raws[1]);
  const { result, logs } = await withCapturedLogs(() => pull(guild, diary.id));
  assert.deepEqual(result, { pulled: null, skip: 'fetch-failed' });
  const warn = logs.find((entry) => entry.msg === 'pull: page unreadable');
  assert.deepEqual([warn.level, warn.source, warn.channel], ['warn', diary.id, '750000000000000001']);
  assert.equal(logs.find((entry) => entry.msg === 'pull: skipped').reason, 'fetch-failed');
});

test('fetchPull: a caption request that fails leaves the other captions in use', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const channel = pictureChannel(guild, '760000000000000083', 3);
  const describer = fakeDescriber({ fresh: { p1: 'νέα p1', p3: 'νέα p3' }, fail: ['p2'] });
  const { result, logs } = await withCapturedLogs(() => pull(guild, channel.id, { describer, turnCertain: true }));
  const { pulled, skip } = result;
  assert.equal(skip, null);
  assert.deepEqual([...pulled.descriptions.keys()].sort(), ['p1', 'p3']);
  assert.equal(pulled.picturesNotSeen, 1);
  const warn = logs.find((entry) => entry.msg === 'pull: caption failed');
  assert.deepEqual([warn.level, warn.source, warn.channel], ['warn', channel.id, '750000000000000001']);
  const line = logs.find((entry) => entry.msg === 'pull: channel');
  assert.deepEqual([line.asked, line.fresh, line.late], [3, 2, 0], 'a failed request is answered, not late');
});

test('fetchPull: an earlier call that cannot be read is left out, the rest of the pull stands', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const diary = addChannel(guild, {
    id: '760000000000000084',
    messages: [{ ts: LAST - 300 * MIN, mentionsSelf: true }, ...burst(LAST - 50 * MIN, LAST, 10)],
  });
  const call = diary.raws[0];
  const ring = [
    { messageId: call.id, channelId: diary.id, ts: call.createdTimestamp, answeredAt: null, skippedAt: null },
  ];
  pageFrom(diary, LAST - 50 * MIN, { byId: unreadable });
  const { result, logs } = await withCapturedLogs(() => pull(guild, diary.id, { pings: ring }));
  const { pulled, skip } = result;
  assert.equal(skip, null);
  assert.ok(diary.fetchCalls.includes(call.id), 'asked for by id');
  assert.equal(pulled.earlierPingIds.size, 0);
  assert.equal(
    pulled.messages.some((m) => m.id === call.id),
    false
  );
  assert.equal(pulled.messages.length, 6);
  const warn = logs.find((entry) => entry.msg === 'pull: call unreadable');
  assert.deepEqual([warn.level, warn.source], ['warn', diary.id]);
  const line = logs.find((entry) => entry.msg === 'pull: channel');
  assert.deepEqual([line.earlier, line.earlierGone], [0, 1]);
});

// ---- logs ------------------------------------------------------------------------

test('fetchPull: the logs carry counts and codes, never message text or captions', async () => {
  const guild = fakeGuild();
  mainChannel(guild);
  const channel = addChannel(guild, {
    id: '760000000000000081',
    messages: [
      { ts: LAST - MIN, content: 'μυστικό ημερολόγιο', images: ['p1'] },
      { ts: LAST, content: 'café crème' },
    ],
  });
  const describer = fakeDescriber({ fresh: { p1: 'ιδιωτική λεζάντα' } });
  const { logs } = await withCapturedLogs(() =>
    pull(guild, channel.id, { describer, turnCertain: true, reason: 'routed' })
  );
  const line = logs.find((entry) => entry.msg === 'pull: channel');
  assert.deepEqual(
    Object.keys(line)
      .filter((key) => !['level', 'time', 'msg'].includes(key))
      .sort(),
    [
      'asked',
      'cached',
      'channel',
      'direction',
      'earlier',
      'earlierGone',
      'fresh',
      'late',
      'messages',
      'ms',
      'notSeen',
      'olderNotShown',
      'pictures',
      'pings',
      'pullReason',
      'source',
    ]
  );
  assert.equal(line.pullReason, 'routed', 'why it was pulled: the same field as on pull: skipped');
  assert.equal('reason' in line, false, '`reason` is only ever a skip code');
  assert.equal(typeof line.ms, 'number');
  const text = JSON.stringify(logs);
  for (const secret of ['μυστικό', 'café', 'ιδιωτική']) assert.equal(text.includes(secret), false, secret);
});

test('pull: a read-only channel where only the persona writes is pulled and its lines are marked self', async () => {
  const guild = fakeGuild();
  const main = mainChannel(guild);
  const diary = addChannel(guild, {
    id: '760000000000000071',
    name: 'ημερολόγιο',
    granted: [READ, REACT],
    messages: [
      { ts: LAST - 5 * MIN, authorId: SELF_ID },
      { ts: LAST, authorId: SELF_ID },
    ],
  });
  assert.deepEqual(checkPull({ guild, channelId: diary.id, destination: main, config: config(), now: NOW }), {
    channel: diary,
    skip: null,
  });
  const { result } = await withCapturedLogs(() => pull(guild, diary.id));
  assert.equal(result.skip, null);
  assert.equal(result.pulled.readOnly, true);
  assert.equal(result.pulled.messages.length, 2);
  assert.ok(result.pulled.messages.every((m) => m.self === true));
});
