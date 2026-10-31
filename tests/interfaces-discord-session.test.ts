// Tests for the Discord session (interfaces/discord/session.ts): `start(host)` builds the client, logs in, picks
// the guild, connects the link and carries every gateway event the core uses as a protocol event. The discord.js
// client is an EventEmitter standing in for it (injected through `host.createClient`) and the link runs over the
// loopback into a real event door, so each assertion reads what the core's door receives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChannelType, Events } from 'discord.js';
import { createLoopback } from '../src/protocol/wire.ts';
import { validateEvent } from '../src/protocol/index.js';
import { openAdapterLink } from '../src/interface/link.ts';
import { createEventDoor } from '../src/interface/door.js';
import { start } from '../interfaces/discord/session.ts';
import type { InterfaceHost, RunningInterface } from '../src/protocol/host.ts';

type Fake = Record<string, unknown>;
// A chat input interaction `/nep status` of user u1 in channel c1 of the guild, with the replies it got.
function statusInteraction(guild: Fake) {
  const replies: Array<unknown> = [];
  const interaction = {
    id: 'i1',
    guildId: guild.id,
    channelId: 'c1',
    user: { id: 'u1' },
    member: undefined,
    commandName: 'nep',
    deferred: false,
    replied: false,
    isChatInputCommand: (): boolean => true,
    isAutocomplete: (): boolean => false,
    options: {
      getSubcommandGroup: (): null => null,
      getSubcommand: (): string => 'status',
      getString: (): null => null,
    },
    deferReply: () => Promise.resolve(),
    reply: (payload: unknown) => {
      replies.push(payload);
      return Promise.resolve();
    },
    editReply: (payload: unknown) => {
      replies.push(payload);
      return Promise.resolve();
    },
    followUp: () => Promise.resolve(),
  };
  return { interaction, replies };
}

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const SELF_ID = 'self1';
const LINK_TOKEN = 'link-token';
const KINDS = [
  'message.received',
  'reaction.changed',
  'voice.changed',
  'presence.changed',
  'presence.snapshot',
  'connection.changed',
  'membership.changed',
  'conversation.changed',
];

const flush = async (rounds = 10): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const asFake = (value: unknown): Fake => (value !== null && typeof value === 'object' ? (value as Fake) : {});

function textChannel(id: string, guild: Fake, extra: Fake = {}): Fake {
  return {
    id,
    guild,
    guildId: guild.id,
    name: `chan-${id}`,
    topic: null,
    parent: null,
    parentId: null,
    type: ChannelType.GuildText,
    viewable: true,
    lastMessageId: null,
    isTextBased: () => true,
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: { cache: new Map(), fetch: () => Promise.resolve(new Map()) },
    permissionOverwrites: { cache: new Map() },
    ...extra,
  };
}

function guildOf(id: string, name: string) {
  const channels = new Map<string, Fake>();
  const guild: Fake = {
    id,
    name,
    members: {
      me: { id: SELF_ID, displayName: 'Neptunia' },
      cache: new Map<string, Fake>(),
      fetch: () => Promise.resolve(null),
    },
    channels: { cache: channels },
    voiceStates: { cache: new Map() },
    presences: { cache: new Map() },
  };
  return { guild, channels };
}

function messageIn(id: string, channel: Fake, guild: Fake): Fake {
  const author = { id: 'u1', bot: false, globalName: 'Eleni', username: 'eleni', avatar: 'ah' };
  return {
    id,
    system: false,
    webhookId: null,
    author,
    member: {
      id: 'u1',
      avatar: null,
      displayName: 'Eleni',
      user: author,
      displayAvatarURL: () => 'https://cdn.example/u1/ah.png',
    },
    guild,
    guildId: guild.id,
    channel,
    channelId: channel.id,
    cleanContent: 'hello',
    content: 'hello',
    createdTimestamp: NOW,
    reference: null,
    mentions: { users: new Map() },
    attachments: new Map(),
    stickers: new Map(),
  };
}

// The first guild has two readable channels (c1, c2), one the bot may not read (c3) and a cached thread (t1) that
// only the client's own cache holds; a second guild, when asked for, is empty.
function harness(options: { botGuildId?: string; env?: Record<string, string | undefined>; twoGuilds?: boolean } = {}) {
  const first = guildOf('g1', 'Alpha');
  const c1 = textChannel('c1', first.guild);
  const c2 = textChannel('c2', first.guild);
  const c3 = textChannel('c3', first.guild, { permissionsFor: () => ({ has: () => false }) });
  for (const channel of [c1, c2, c3]) first.channels.set(String(channel.id), channel);
  const thread = textChannel('t1', first.guild, {
    name: 'a thread',
    parentId: 'c1',
    type: ChannelType.PublicThread,
    isThread: () => true,
  });
  const guilds = [first.guild];
  if (options.twoGuilds === true) guilds.push(guildOf('g2', 'Beta').guild);

  const everyChannel = new Map<string, Fake>([...first.channels, ['t1', thread]]);
  const emitter = new EventEmitter();
  const state = { loggedInWith: null as string | null, destroyed: 0 };
  const client = Object.assign(emitter, {
    user: { id: SELF_ID, tag: 'Neptunia#0001', username: 'Neptunia' },
    application: { id: 'app1' },
    users: { cache: new Map() },
    guilds: { cache: new Map(guilds.map((guild) => [String(guild.id), guild])) },
    channels: { cache: everyChannel, fetch: (id: string) => Promise.resolve(everyChannel.get(id) ?? null) },
    isReady: () => true,
    login: (token: string) => {
      state.loggedInWith = token;
      setTimeout(() => emitter.emit(Events.ClientReady, emitter), 5);
      return Promise.resolve(token);
    },
    destroy: () => {
      state.destroyed += 1;
      return Promise.resolve();
    },
  });

  const config = {
    bot: { guildId: options.botGuildId ?? '', dryRunChannelId: '' },
    discord: { intents: { presences: false, members: false } },
    media: { embedTextChars: 200, video: { sites: [] as Array<string> } },
    context: { maxUrlChars: 200 },
  };

  const loop = createLoopback();
  const seen: Array<Fake> = [];
  const handlers: Record<string, (event: Fake) => void> = {};
  for (const kind of KINDS) handlers[kind] = (event) => void seen.push(event);
  const quiet = { info(): void {}, warn(): void {}, error(): void {} };
  const door = createEventDoor({ handlers, log: quiet });
  const link = openAdapterLink({ transport: loop.core, door, token: LINK_TOKEN, log: quiet });

  const warns: Array<string> = [];
  const listeners = new Set<(what: string) => void>();
  const host: InterfaceHost = {
    connect: () => Promise.resolve(loop.client),
    token: LINK_TOKEN,
    env: options.env ?? { DISCORD_TOKEN: 'discord-token' },
    config: () => config,
    onConfigChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    log: {
      info(): void {},
      warn: (msg) => void warns.push(msg),
      error: (msg) => void warns.push(msg),
    },
    createClient: () => client,
  };

  return {
    host,
    config,
    client,
    state,
    loop,
    link,
    warns,
    guild: first.guild,
    channel: (id: string): Fake => asFake(everyChannel.get(id)),
    events: (kind: string): Array<Fake> => seen.filter((event) => event.kind === kind),
    fire: (what = 'config'): void => {
      for (const listener of [...listeners]) listener(what);
    },
  };
}

type Harness = ReturnType<typeof harness>;

// Runs `body` against a started session and always stops it.
async function withSession(
  options: Parameters<typeof harness>[0],
  body: (h: Harness, running: RunningInterface) => Promise<void>
): Promise<void> {
  const h = harness(options);
  let running: RunningInterface | null = null;
  try {
    running = await start(h.host);
    await h.link.hello;
    await body(h, running);
  } finally {
    if (running === null) h.loop.core.close();
    else await running.stop();
  }
}

const messageIdsOf = (h: Harness): Array<unknown> =>
  h.events('message.received').map((event) => asFake(event.message).id);

// ---- the guild and the token ------------------------------------------------------------------

test('says hello with the only guild the bot is in as its community when bot.guildId is unset', async () => {
  await withSession({}, async (h) => {
    assert.deepEqual((await h.link.hello).community, { id: 'g1', name: 'Alpha' });
  });
});

test('says hello with the configured guild as its community when the bot is in two and bot.guildId names one', async () => {
  await withSession({ twoGuilds: true, botGuildId: 'g2' }, async (h) => {
    assert.deepEqual((await h.link.hello).community, { id: 'g2', name: 'Beta' });
  });
});

test('says hello with the persona account id and its display name in the served guild', async () => {
  await withSession({}, async (h) => {
    assert.deepEqual((await h.link.hello).self, { id: SELF_ID, name: 'Neptunia' });
  });
});

test('sends the cached members of the served guild as membership.changed events once opened', async () => {
  const h = harness();
  const members = asFake(h.guild.members).cache as Map<string, Fake>;
  members.set('u5', {
    id: 'u5',
    guild: { id: 'g1' },
    avatar: null,
    displayName: 'Μαρία',
    user: { id: 'u5', bot: false, avatar: null, username: 'maria' },
    displayAvatarURL: () => 'https://cdn.example/u5/default.png',
  });
  const running = await start(h.host);
  try {
    await h.link.hello;
    running.open();
    await until(() => h.events('membership.changed').some((event) => event.userId === 'u5'));
    const event = h.events('membership.changed').find((entry) => entry.userId === 'u5') ?? {};
    assert.equal(event.communityId, 'g1');
    assert.equal(asFake(event.member).name, 'Μαρία');
    assert.deepEqual(validateEvent(event), { ok: true });
  } finally {
    await running.stop();
  }
});

test('rejects naming both guilds when the bot is in two and bot.guildId is unset', async () => {
  const h = harness({ twoGuilds: true });
  await assert.rejects(start(h.host), (error: Error) => {
    assert.match(error.message, /g1/);
    assert.match(error.message, /g2/);
    return true;
  });
  h.loop.core.close();
});

test('rejects with missing DISCORD_TOKEN and never logs in when the environment holds no token', async () => {
  const h = harness({ env: {} });
  await assert.rejects(start(h.host), /missing DISCORD_TOKEN/);
  assert.equal(h.state.loggedInWith, null);
  h.loop.core.close();
});

test('logs in with the DISCORD_TOKEN of the host environment', async () => {
  await withSession({ env: { DISCORD_TOKEN: 'secret-1' } }, (h) => {
    assert.equal(h.state.loggedInWith, 'secret-1');
    return Promise.resolve();
  });
});

// ---- buffering until open ---------------------------------------------------------------------

test('holds a message until open and then delivers it as a valid message.received without raw', async () => {
  await withSession({}, async (h, running) => {
    h.client.emit(Events.MessageCreate, messageIn('m1', h.channel('c1'), h.guild));
    await flush();
    assert.equal(h.events('message.received').length, 0);
    running.open();
    await until(() => h.events('message.received').length === 1);
    const event = h.events('message.received')[0] ?? {};
    assert.equal(validateEvent(event).ok, true);
    assert.equal('raw' in event, false);
    assert.equal(asFake(event.message).id, 'm1');
  });
});

test('drops the oldest events past 1,000 held before open and warns', async () => {
  await withSession({}, async (h, running) => {
    const channel = h.channel('c1');
    for (let i = 1; i <= 1002; i += 1) h.client.emit(Events.MessageCreate, messageIn(`m${i}`, channel, h.guild));
    assert.ok(h.warns.length > 0, 'a warn on overflow');
    running.open();
    await until(() => messageIdsOf(h).includes('m1002'));
    await flush();
    const ids = messageIdsOf(h);
    assert.equal(ids.includes('m1'), false);
    assert.equal(ids.includes('m2'), false);
    assert.ok(ids.length <= 1000, `${ids.length} events were delivered`);
  });
});

// ---- events through the link ------------------------------------------------------------------

test('carries the avatar of a message author on message.received', async () => {
  await withSession({}, async (h, running) => {
    running.open();
    h.client.emit(Events.MessageCreate, messageIn('m5', h.channel('c1'), h.guild));
    await until(() => h.events('message.received').length === 1);
    const author = asFake(asFake(h.events('message.received')[0]?.message).author);
    assert.deepEqual(author.avatar, { hash: 'ah', url: 'https://cdn.example/u1/ah.png' });
  });
});

test('turns MessageReactionAdd into a reaction.changed that was added', async () => {
  await withSession({}, async (h, running) => {
    running.open();
    const reaction = { message: messageIn('m6', h.channel('c1'), h.guild), emoji: { name: '🔥', id: null }, count: 1 };
    h.client.emit(Events.MessageReactionAdd, reaction, { id: 'u2' });
    await until(() => h.events('reaction.changed').length === 1);
    const event = h.events('reaction.changed')[0] ?? {};
    assert.equal(event.added, true);
    assert.equal(event.messageId, 'm6');
    assert.equal(event.userId, 'u2');
    assert.equal(asFake(event.emoji).name, '🔥');
  });
});

test('gives no voice.changed for a voice state of another guild', async () => {
  await withSession({}, async (h, running) => {
    running.open();
    const state = (guildId: string, userId: string): Fake => ({
      id: userId,
      guild: { id: guildId },
      channelId: 'v1',
      member: { id: userId, displayName: 'Zoe' },
    });
    h.client.emit(Events.VoiceStateUpdate, { channelId: null }, state('g9', 'u8'));
    h.client.emit(Events.VoiceStateUpdate, { channelId: null }, state('g1', 'u5'));
    await until(() => h.events('voice.changed').length >= 1);
    await flush();
    assert.deepEqual(
      h.events('voice.changed').map((event) => [event.communityId, event.userId]),
      [['g1', 'u5']]
    );
  });
});

test('turns ShardDisconnect into a connection.changed that is lost', async () => {
  await withSession({}, async (h, running) => {
    running.open();
    h.client.emit(Events.ShardDisconnect, { code: 1006 }, 0);
    const lost = (): boolean => h.events('connection.changed').some((event) => event.state === 'lost');
    await until(lost);
    assert.equal(lost(), true);
  });
});

test('turns GuildMemberUpdate into a membership.changed with the avatar hash and url', async () => {
  await withSession({}, async (h, running) => {
    running.open();
    const member: Fake = {
      id: 'u3',
      guild: { id: 'g1' },
      avatar: null,
      displayName: 'Eleni',
      user: { id: 'u3', bot: false, avatar: 'h3', username: 'eleni' },
      displayAvatarURL: (options: { size: number }) => `https://cdn.example/u3/h3.png?size=${options.size}`,
    };
    h.client.emit(Events.GuildMemberUpdate, {}, member);
    await until(() => h.events('membership.changed').length === 1);
    const event = h.events('membership.changed')[0] ?? {};
    assert.equal(event.change, 'updated');
    assert.equal(event.communityId, 'g1');
    assert.equal(event.userId, 'u3');
    assert.deepEqual(asFake(event.member).avatar, { hash: 'h3', url: 'https://cdn.example/u3/h3.png?size=256' });
  });
});

test('turns UserUpdate into a membership.changed for a member the guild cache holds', async () => {
  await withSession({}, async (h, running) => {
    running.open();
    const member: Fake = {
      id: 'u4',
      guild: { id: 'g1' },
      avatar: null,
      displayName: 'Nikos',
      user: { id: 'u4', bot: false, avatar: 'h4', username: 'nikos' },
      displayAvatarURL: () => 'https://cdn.example/u4/h4.png',
    };
    (asFake(h.guild.members).cache as Map<string, Fake>).set('u4', member);
    h.client.emit(Events.UserUpdate, {}, { id: 'u4' });
    await until(() => h.events('membership.changed').length === 1);
    const event = h.events('membership.changed')[0] ?? {};
    assert.equal(event.userId, 'u4');
    assert.equal(asFake(asFake(event.member).avatar).hash, 'h4');
  });
});

// ---- conversations ----------------------------------------------------------------------------

test('turns ChannelUpdate into a conversation.changed that is updated, with the new name', async () => {
  await withSession({}, async (h, running) => {
    running.open();
    h.client.emit(Events.ChannelUpdate, {}, textChannel('c7', h.guild, { name: 'general' }));
    await until(() => h.events('conversation.changed').some((event) => asFake(event.conversation).id === 'c7'));
    const event = h.events('conversation.changed').find((entry) => asFake(entry.conversation).id === 'c7') ?? {};
    assert.equal(event.change, 'updated');
    assert.equal(asFake(event.conversation).name, 'general');
    assert.equal(asFake(event.conversation).kind, 'channel');
  });
});

test('turns ChannelCreate into a conversation.changed that is created', async () => {
  await withSession({}, async (h, running) => {
    running.open();
    h.client.emit(Events.ChannelCreate, textChannel('c8', h.guild, { name: 'fresh' }));
    const created = (): boolean =>
      h
        .events('conversation.changed')
        .some((event) => asFake(event.conversation).id === 'c8' && event.change === 'created');
    await until(created);
    assert.equal(created(), true);
  });
});

test('turns ChannelDelete into a conversation.changed that is deleted', async () => {
  await withSession({}, async (h, running) => {
    running.open();
    h.client.emit(Events.ChannelDelete, textChannel('c1', h.guild, { name: 'chan-c1' }));
    const deleted = (): boolean =>
      h
        .events('conversation.changed')
        .some((event) => asFake(event.conversation).id === 'c1' && event.change === 'deleted');
    await until(deleted);
    assert.equal(deleted(), true);
  });
});

test('announces each readable channel and each cached thread as updated at connect, and no unreadable one', async () => {
  await withSession({}, async (h, running) => {
    running.open();
    await until(() => h.events('conversation.changed').length >= 3);
    await flush();
    const updated = h.events('conversation.changed').filter((event) => event.change === 'updated');
    const ids = updated.map((event) => asFake(event.conversation).id);
    assert.deepEqual([...new Set(ids)].sort(), ['c1', 'c2', 't1']);
    const thread = asFake(updated.find((event) => asFake(event.conversation).id === 't1')?.conversation);
    assert.equal(thread.kind, 'thread');
    assert.equal(thread.parentId, 'c1');
  });
});

// ---- the end -------------------------------------------------------------------------------------

test('closes the link and destroys the client on stop', async () => {
  const h = harness();
  const running = await start(h.host);
  await h.link.hello;
  let closedWith: string | null = null;
  h.loop.core.onClose((reason) => {
    closedWith = reason;
  });
  await running.stop();
  await until(() => closedWith !== null);
  assert.equal(closedWith, 'peer-closed');
  assert.equal(h.state.destroyed, 1);
});

// ---- no slash command (PR 7b) -----------------------------------------------------------------

// The guild's application commands as Discord holds them, by id: `fetch` lists them, `delete` removes one by its id or
// its object, `set` replaces them all. `sets` is every list `set` was given. With `fetchFails` the guild refuses the
// listing the way Discord refuses a bot invited without the `applications.commands` scope (error 50001).
function registeredCommands(names: ReadonlyArray<string>, options: { fetchFails?: boolean } = {}) {
  const held = new Map<string, Fake>(names.map((name, index) => [`cmd${index + 1}`, { id: `cmd${index + 1}`, name }]));
  const sets: Array<unknown> = [];
  const idOf = (command: unknown): string => (typeof command === 'string' ? command : String(asFake(command).id));
  const manager = {
    fetch: (): Promise<Map<string, Fake>> =>
      options.fetchFails === true
        ? Promise.reject(Object.assign(new Error('Missing Access'), { code: 50001 }))
        : Promise.resolve(new Map(held)),
    delete: (command: unknown): Promise<void> => {
      held.delete(idOf(command));
      return Promise.resolve();
    },
    set: (tree: unknown): Promise<Array<unknown>> => {
      sets.push(tree);
      held.clear();
      const list = Array.isArray(tree) ? (tree as Array<unknown>) : [];
      list.forEach((command, index) => held.set(`new${index + 1}`, { ...asFake(command), id: `new${index + 1}` }));
      return Promise.resolve([]);
    },
  };
  return { held, sets, manager };
}

const registersNothing = (sets: ReadonlyArray<unknown>): boolean =>
  sets.every((tree) => Array.isArray(tree) && tree.length === 0);

test('deletes the /nep the guild still has at its first connect and registers no command', async () => {
  const h = harness();
  const commands = registeredCommands(['nep']);
  h.guild.commands = commands.manager;
  const running = await start(h.host);
  try {
    await h.link.hello;
    running.open();
    await until(() => commands.held.size === 0);
    await flush(20);
    assert.equal(commands.held.size, 0);
    assert.equal(registersNothing(commands.sets), true, `set was given ${JSON.stringify(commands.sets)}`);
  } finally {
    await running.stop();
  }
});

test('registers no command when it opens under a core whose interfaces run as units', async () => {
  const h = harness();
  Object.assign(h.config, { interfaces: { mode: 'units' } });
  const commands = registeredCommands([]);
  h.guild.commands = commands.manager;
  const running = await start(h.host);
  try {
    await h.link.hello;
    running.open();
    await flush(40);
    assert.equal(commands.held.size, 0);
    assert.equal(registersNothing(commands.sets), true, `set was given ${JSON.stringify(commands.sets)}`);
  } finally {
    await running.stop();
  }
});

test('logs the number of slash commands it deleted', async () => {
  const h = harness();
  const commands = registeredCommands(['nep', 'luna']);
  h.guild.commands = commands.manager;
  const infos: Array<Fake> = [];
  h.host.log = { ...h.host.log, info: (_msg: string, meta?: unknown) => void infos.push(asFake(meta)) };
  const running = await start(h.host);
  try {
    await h.link.hello;
    running.open();
    await until(() => infos.some((meta) => meta.deleted === 2));
    assert.equal(
      infos.some((meta) => meta.deleted === 2),
      true
    );
  } finally {
    await running.stop();
  }
});

test('starts and carries messages when the guild refuses to list its commands', async () => {
  const h = harness();
  h.guild.commands = registeredCommands(['nep'], { fetchFails: true }).manager;
  const running = await start(h.host);
  try {
    await h.link.hello;
    running.open();
    h.client.emit(Events.MessageCreate, messageIn('m9', h.channel('c1'), h.guild));
    await until(() => messageIdsOf(h).includes('m9'));
    assert.deepEqual(messageIdsOf(h), ['m9']);
  } finally {
    await running.stop();
  }
});

test('an interaction for /nep sends no command to the core', async () => {
  await withSession({}, async (h, running) => {
    running.open();
    const kinds: Array<unknown> = [];
    h.loop.core.onEnvelope((value) => {
      if (value.type === 'event') kinds.push(asFake(value.body).kind);
    });
    const { interaction } = statusInteraction(h.guild);
    h.client.emit(Events.InteractionCreate, interaction);
    await flush(40);
    assert.equal(kinds.includes('command.requested'), false);
  });
});
