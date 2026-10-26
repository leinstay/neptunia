// Tests for interfaces/discord/pull-fetch.js: the pull rails over discord.js objects for the one reader that still
// takes them (the recall runner). The rails of a turn's pull over the interface's listing are in
// tests/pull-fetch-core.test.ts. Discord objects are plain fixtures shaped just enough for the code to read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OverwriteType, PermissionFlagsBits, PermissionsBitField, SnowflakeUtil } from 'discord.js';
import { audienceAllows, checkPull, isReadableChannel } from '../interfaces/discord/index.js';

const MIN = 60_000;
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
