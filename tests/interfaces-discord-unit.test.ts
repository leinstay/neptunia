// The Discord session (interfaces/discord/session.ts) as its unit runs it: started through `start(host)` against a
// core whose interfaces are units (tests/fixtures/core-units.ts), over the core's real socket, with its token from
// `<private>/clients/discord.token` and its own data folder. The core never hands it an admin, so a `/nep` interaction
// goes to the core as `command.requested` under the Discord principal. The core runs it when `clients.json` grants
// that principal the permission `commands`, and answers through the `command.result` action, which the session turns
// into the interaction's reply. Without the permission the core refuses the event. The session keeps its events in
// the outbox of its data folder until the core acknowledges them, so a core restart loses none once the session
// reconnects. The discord.js client is an EventEmitter standing in for it (`host.createClient`). No Discord and no
// provider is reached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChannelType, Events } from 'discord.js';
import { start } from '../interfaces/discord/session.ts';
import type { InterfaceHost, RunningInterface } from '../src/protocol/host.ts';
import { MAX_FRAME_BYTES, connectSocket } from '../src/protocol/wire.ts';
import { query, seenIds, settle, startUnitsCore, until, withRig } from './fixtures/core-units.ts';
import type { Client, Dirs, LogEntry } from './fixtures/core-units.ts';

type Fake = Record<string, unknown>;

const SELF_ID = 'self1';
const OWNER_ID = 'u1';
/** A rule of the private layer, printed by `/nep rule list`: data the test put there, not a label. */
const RULE = 'zeta rule seventy one';

/** The owner, the served guild and the rule the command lists. */
const CONFIG = { bot: { owners: [OWNER_ID], guildId: 'g1' } };

const discordClient = (permissions: ReadonlyArray<string>): Client => ({
  name: 'discord',
  kind: 'interface',
  iface: 'discord',
  permissions,
});

function writeRules(dirs: Dirs): void {
  mkdirSync(join(dirs.privateDir, 'prompts.local'), { recursive: true });
  writeFileSync(join(dirs.privateDir, 'prompts.local', 'rules.md'), `## Rules\n\n- ${RULE}\n`);
}

function textChannel(id: string, guild: Fake): Fake {
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
  };
}

/** A member's message in `channel` that does not call the persona. */
function messageIn(id: string, channel: Fake, guild: Fake): Fake {
  const author = { id: 'u2', bot: false, globalName: 'Eleni', username: 'eleni', avatar: null };
  return {
    id,
    system: false,
    webhookId: null,
    author,
    member: { id: 'u2', avatar: null, displayName: 'Eleni', user: author, displayAvatarURL: () => '' },
    guild,
    guildId: guild.id,
    channel,
    channelId: channel.id,
    cleanContent: `line ${id}`,
    content: `line ${id}`,
    createdTimestamp: Date.now(),
    reference: null,
    mentions: { users: new Map() },
    attachments: new Map(),
    stickers: new Map(),
  };
}

/** The `/nep rule list` interaction of the owner in c1, with every payload it was answered with. */
function ruleListInteraction(guild: Fake) {
  const replies: Array<unknown> = [];
  const answer = (payload: unknown): Promise<void> => {
    replies.push(payload);
    return Promise.resolve();
  };
  const interaction = {
    id: 'i1',
    guildId: guild.id,
    channelId: 'c1',
    channel: { name: 'chan-c1', isThread: () => false },
    user: { id: OWNER_ID, username: 'owner' },
    member: { roles: [] },
    commandName: 'nep',
    deferred: false,
    replied: false,
    isChatInputCommand: (): boolean => true,
    isAutocomplete: (): boolean => false,
    options: {
      getSubcommandGroup: (): string => 'rule',
      getSubcommand: (): string => 'list',
      getString: (): null => null,
    },
    deferReply: () => Promise.resolve(),
    reply: answer,
    editReply: answer,
    followUp: answer,
  };
  const texts = (): Array<string> =>
    replies.map((payload) => {
      if (typeof payload === 'string') return payload;
      const content: unknown = payload !== null && typeof payload === 'object' ? Reflect.get(payload, 'content') : null;
      return typeof content === 'string' ? content : '';
    });
  return { interaction, texts };
}

/** The stand-in discord.js client of one guild g1 with the readable channel c1. */
function gateway() {
  const channels = new Map<string, Fake>();
  const guild: Fake = {
    id: 'g1',
    name: 'Alpha',
    members: { me: { id: SELF_ID, displayName: 'Nova' }, cache: new Map(), fetch: () => Promise.resolve(null) },
    channels: { cache: channels },
    roles: { cache: new Map() },
    voiceStates: { cache: new Map() },
    presences: { cache: new Map() },
    commands: { set: () => Promise.resolve([]) },
  };
  const c1 = textChannel('c1', guild);
  channels.set('c1', c1);
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    user: { id: SELF_ID, tag: 'Nova#0001', username: 'Nova' },
    application: { id: 'app1' },
    users: { cache: new Map() },
    guilds: { cache: new Map([['g1', guild]]) },
    channels: { cache: channels, fetch: (id: string) => Promise.resolve(channels.get(id) ?? null) },
    isReady: () => true,
    login: (token: string) => {
      setTimeout(() => emitter.emit(Events.ClientReady, emitter), 5);
      return Promise.resolve(token);
    },
    destroy: () => Promise.resolve(),
  });
  return { client, guild, c1 };
}

/** The host the Discord unit gets from `neptunia interface run discord`, over the rig's folders. */
function unitHost(dirs: Dirs, client: unknown): InterfaceHost {
  const quiet = { info(): void {}, warn(): void {}, error(): void {} };
  const config = {
    bot: { guildId: 'g1', commandName: 'nep', dryRunChannelId: '', owners: [OWNER_ID] },
    discord: { intents: { presences: false, members: false } },
    features: { adminCommands: true },
    media: { embedTextChars: 200, video: { sites: [] as Array<string> } },
    context: { maxUrlChars: 200 },
  };
  return {
    connect: () => connectSocket({ path: join(dirs.dataDir, 'run', 'core.sock'), maxFrameBytes: MAX_FRAME_BYTES }),
    token: readFileSync(join(dirs.privateDir, 'clients', 'discord.token'), 'utf8').trim(),
    dataDir: join(dirs.dataDir, 'interfaces', 'discord'),
    env: { DISCORD_TOKEN: 'discord-token' },
    config: () => config,
    onConfigChange: () => () => {},
    log: quiet,
    createClient: () => client,
  };
}

const eventRefused = (logs: ReadonlyArray<LogEntry>): boolean =>
  logs.some((entry) => entry.msg === 'link: event refused' && entry.principal === 'discord');

// Case 7 of PR D, with the permission.
test('a /nep interaction of the Discord unit with the commands permission is run by the core and answered', async () => {
  await withRig({ config: CONFIG, clients: [discordClient(['commands'])] }, async ({ dirs, llm, cores, logs }) => {
    writeRules(dirs);
    cores.push(await startUnitsCore(dirs, llm));
    const { client, guild } = gateway();
    let running: RunningInterface | null = null;
    try {
      running = await start(unitHost(dirs, client));
      running.open();
      await until(() => logs.some((entry) => entry.msg === 'link: hello' && entry.principal === 'discord'), 'hello');
      const { interaction, texts } = ruleListInteraction(guild);
      client.emit(Events.InteractionCreate, interaction);
      await until(
        () => texts().some((text) => text.includes(RULE)),
        () => `the answer of /nep rule list; replies: ${JSON.stringify(texts())}`
      );
      assert.equal(eventRefused(logs), false);
      assert.equal(llm.requests.length, 0, 'a command runs no turn');
    } finally {
      await running?.stop();
    }
  });
});

// Case 7 of PR D, without it.
test('a /nep interaction of the Discord unit without the commands permission is refused by the core', async () => {
  await withRig({ config: CONFIG, clients: [discordClient([])] }, async ({ dirs, llm, cores, logs }) => {
    writeRules(dirs);
    cores.push(await startUnitsCore(dirs, llm));
    const { client, guild } = gateway();
    let running: RunningInterface | null = null;
    try {
      running = await start(unitHost(dirs, client));
      running.open();
      await until(() => logs.some((entry) => entry.msg === 'link: hello' && entry.principal === 'discord'), 'hello');
      const { interaction, texts } = ruleListInteraction(guild);
      client.emit(Events.InteractionCreate, interaction);
      await until(() => eventRefused(logs), 'the refusal of the command event');
      await settle();
      assert.equal(
        texts().some((text) => text.includes(RULE)),
        false,
        'the command did not run'
      );
    } finally {
      await running?.stop();
    }
  });
});

// Case 8 of PR D.
test("the Discord unit's outbox keeps a message the core missed while restarting and delivers it once", async () => {
  await withRig({ config: CONFIG, clients: [discordClient([])] }, async ({ dirs, llm, cores }) => {
    const first = await startUnitsCore(dirs, llm);
    cores.push(first);
    const { client, guild, c1 } = gateway();
    let running: RunningInterface | null = null;
    try {
      running = await start(unitHost(dirs, client));
      running.open();
      client.emit(Events.MessageCreate, messageIn('m1', c1, guild));
      await until(() => seenIds(dirs).includes('m1'), 'm1 observed');
      await first.stop();

      // The core is down: the message waits in the outbox of the unit's data folder.
      client.emit(Events.MessageCreate, messageIn('m2', c1, guild));
      await settle(200);
      cores.push(await startUnitsCore(dirs, llm));
      // A unit that cannot reconnect is restarted by systemd and loses what it held; the Discord unit reconnects.
      if (running.reconnect === undefined) assert.fail('the Discord session has no reconnect()');
      await running.reconnect();
      await until(
        () => seenIds(dirs).includes('m2'),
        () => `m2 observed after the restart; seen: ${seenIds(dirs).join(',')}`
      );
      await settle();
      assert.deepEqual(seenIds(dirs), ['m1', 'm2'], 'each message is observed once');
      assert.deepEqual(
        query(dirs, "SELECT principal, kind FROM ingest WHERE kind = 'message.received' ORDER BY seq"),
        [
          { principal: 'discord', kind: 'message.received' },
          { principal: 'discord', kind: 'message.received' },
        ],
        'both events are numbered and ingested once'
      );
    } finally {
      await running?.stop();
    }
  });
});
