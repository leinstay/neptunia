// The invented data folder of the replay stand (scripts/replay-stand.ts): one Discord server with two channels and three
// members, the command line chat, the persona's own lines, three stored turns with their archived requests (a command
// line reply, a Discord reply and a diary entry), the start of the turn that answered the mention, the file journal a
// message replay reads, and a request dump. Every
// name, line and id is made up. The Discord lines go into memory the way the core stores them: the REST fixture is
// read through the Discord adapter's reads and each event is written by the observation the live message path makes.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGuild } from '../../interfaces/discord/index.ts';
import { observationOf } from '../../src/memory/db/observe-event.ts';
import { observe } from '../../src/memory/db/observe.ts';
import { openMemoryDb } from '../../src/memory/db/open.ts';
import { applyRequestArchiveWrite } from '../../src/memory/db/request-archive.ts';
import { insertRows } from '../../src/memory/db/rows.ts';
import { dbOf } from '../../src/memory/db/types.ts';
import { discordReads } from './platform-objects.ts';
import { connectDiscord } from './replay-discord.ts';
import { installStandDiscord } from './stand-discord.ts';
import type { StandDiscord } from './stand-discord.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The moment every case of the stand runs at: the clock of the preload. */
export const STAND_AT = Date.parse('2026-03-04T12:00:00.000Z');

const MINUTE = 60_000;
const DISCORD_EPOCH = 1420070400000n;

/** The snowflake of a moment `minutesBefore` the stand's moment, `seq` apart from others of that millisecond. */
const snowflake = (minutesBefore: number, seq = 0): string =>
  String(((BigInt(STAND_AT - Math.round(minutesBefore * MINUTE)) - DISCORD_EPOCH) << 22n) + BigInt(seq));

const iso = (minutesBefore: number): string => new Date(STAND_AT - Math.round(minutesBefore * MINUTE)).toISOString();

/** The ids of the invented world, for the cases that name them. */
export const WORLD = {
  guild: snowflake(60 * 24 * 90, 1),
  tea: snowflake(60 * 24 * 80, 2),
  garden: snowflake(60 * 24 * 80, 3),
  self: snowflake(60 * 24 * 100, 4),
  ada: snowflake(60 * 24 * 100, 5),
  bram: snowflake(60 * 24 * 100, 6),
  /** Ada names the persona: a mention. */
  mention: snowflake(30),
  /** The persona's answer to the mention. */
  answer: snowflake(29),
  /** Bram answers the persona's line: a reply, and the stored Discord turn's trigger. */
  reply: snowflake(10),
  turns: {
    cli: 't-stand-cli-1',
    mention: 't-stand-mention-1',
    discord: 't-stand-discord-1',
    diary: 't-stand-diary-1',
    dump: 't-stand-dump-1',
  },
};

const user = (id: string, username: string, bot = false) => ({
  id,
  username,
  global_name: username,
  discriminator: '0',
  avatar: null,
  bot,
});

const USERS = {
  self: user(WORLD.self, 'Wren', true),
  ada: user(WORLD.ada, 'Ada'),
  bram: user(WORLD.bram, 'Bram'),
};

type Line = {
  id: string;
  minutes: number;
  by: keyof typeof USERS;
  text: string;
  replyTo?: string;
  mentions?: Array<string>;
};

const TEA: Array<Line> = [
  { id: snowflake(50), minutes: 50, by: 'ada', text: 'Good morning, everyone.' },
  { id: snowflake(45), minutes: 45, by: 'bram', text: 'Morning Ada. Is the reading circle still on this week?' },
  { id: snowflake(40), minutes: 40, by: 'self', text: 'Morning both. It is, as far as I know.' },
  {
    id: WORLD.mention,
    minutes: 30,
    by: 'ada',
    text: `<@${WORLD.self}> which book are we reading this week?`,
    mentions: ['self'],
  },
  { id: WORLD.answer, minutes: 29, by: 'self', text: 'The lighthouse one, chapter three.', replyTo: WORLD.mention },
  { id: WORLD.reply, minutes: 10, by: 'bram', text: 'Could we move it to Friday?', replyTo: WORLD.answer },
  { id: snowflake(5), minutes: 5, by: 'ada', text: 'Friday works for me.' },
];

const GARDEN: Array<Line> = [{ id: snowflake(120), minutes: 120, by: 'bram', text: 'The tomatoes are finally red.' }];

/** One line as Discord's API gives a message. */
function messageOf(line: Line, channelId: string, all: ReadonlyArray<Line>): Record<string, unknown> {
  const replied = line.replyTo === undefined ? undefined : all.find((one) => one.id === line.replyTo);
  return {
    id: line.id,
    type: replied === undefined ? 0 : 19,
    channel_id: channelId,
    guild_id: WORLD.guild,
    author: USERS[line.by],
    content: line.text,
    timestamp: iso(line.minutes),
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [
      ...(line.mentions ?? []).map((key) => USERS[key as keyof typeof USERS]),
      ...(replied === undefined ? [] : [USERS[replied.by]]),
    ],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    flags: 0,
    ...(replied === undefined
      ? {}
      : {
          message_reference: { message_id: replied.id, channel_id: channelId, guild_id: WORLD.guild, type: 0 },
          referenced_message: messageOf(replied, channelId, all),
        }),
  };
}

const channel = (id: string, name: string, position: number) => ({
  id,
  type: 0,
  guild_id: WORLD.guild,
  name,
  position,
  parent_id: null,
  topic: null,
  nsfw: false,
  permission_overwrites: [],
  rate_limit_per_user: 0,
  last_message_id: null,
});

const member = (key: keyof typeof USERS) => ({
  user: USERS[key],
  nick: null,
  roles: [],
  joined_at: iso(60 * 24 * 60),
  deaf: false,
  mute: false,
  flags: 0,
});

/** The REST fixture of the invented server. */
export function standDiscord(): StandDiscord {
  return {
    self: USERS.self,
    guild: {
      id: WORLD.guild,
      name: 'Lantern Hall',
      icon: null,
      owner_id: WORLD.ada,
      afk_timeout: 300,
      verification_level: 0,
      default_message_notifications: 0,
      explicit_content_filter: 0,
      roles: [
        {
          id: WORLD.guild,
          name: '@everyone',
          color: 0,
          hoist: false,
          position: 0,
          permissions: '68608',
          managed: false,
          mentionable: false,
          flags: 0,
        },
      ],
      emojis: [],
      stickers: [],
      features: [],
      mfa_level: 0,
      system_channel_flags: 0,
      premium_tier: 0,
      preferred_locale: 'en-US',
      nsfw_level: 0,
    },
    channels: [channel(WORLD.tea, 'tea-room', 0), channel(WORLD.garden, 'garden', 1)],
    members: [member('self'), member('ada'), member('bram')],
    messages: {
      [WORLD.tea]: TEA.map((line) => messageOf(line, WORLD.tea, TEA)),
      [WORLD.garden]: GARDEN.map((line) => messageOf(line, WORLD.garden, GARDEN)),
    },
  };
}

/** The settings of the invented deployment: the server, the command line owner and placeholder keys of no provider. */
function settings(): Record<string, unknown> {
  return {
    bot: { placeId: WORLD.guild, timezone: 'UTC' },
    models: { routes: { core: [{ via: 'api', key: 'stand', model: 'stand/core-model' }] } },
  };
}

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** The Discord lines of the fixture written into `db` as the live message path writes them. */
async function observeDiscord(handle: ReturnType<typeof openMemoryDb>, fixture: StandDiscord): Promise<void> {
  installStandDiscord(fixture);
  const discord: unknown = createRequire(path.join(ROOT, 'package.json'))('discord.js');
  const config = { bot: { placeId: WORLD.guild } };
  const connection: { client: { destroy: () => Promise<void> } } = await connectDiscord({
    discord,
    token: 'stand-token',
    configuredGuildId: WORLD.guild,
    resolveGuild,
    log: quiet,
  });
  try {
    const { reads } = discordReads(connection.client, () => config);
    for (const chatId of [WORLD.garden, WORLD.tea]) {
      const page = await reads.history({ iface: 'discord', chatId }, { limit: 100 });
      const events = [...(page?.events ?? [])].sort((a, b) => Number(a.message.at) - Number(b.message.at));
      for (const event of events) {
        const direct = event.message.id === WORLD.mention || event.message.id === WORLD.reply;
        const envelope = observationOf(event, { selfId: WORLD.self, direct });
        const done = observe(handle, envelope, { now: () => Number(event.message.at), log: quiet });
        if (done.ok !== true) throw new Error(`replay-stand: a line was refused: ${String(done.code)}`);
      }
    }
  } finally {
    await connection.client.destroy();
  }
}

/** The director's answer of the diary turn: a scene on the first seed set. */
const SCENE = JSON.stringify({
  set: 1,
  used: [],
  scene: 'A small harbour at noon. Gulls sit on the posts and the tide is low. Nets dry on a wall.',
});

/** One answered archived request of a stored turn. */
function archive(
  handle: ReturnType<typeof openMemoryDb>,
  request: { turnId: string; step: number; purpose: string; minutes: number; text: string; calls?: Array<unknown> }
): void {
  const id = `req:${request.turnId}:${request.step}`;
  applyRequestArchiveWrite(handle, {
    op: 'start',
    record: {
      id,
      turn_id: request.turnId,
      attempt_id: `${request.turnId}-1`,
      step: request.step,
      role: 'core',
      model: 'stand/core-model',
      purpose: request.purpose,
      at: STAND_AT - request.minutes * MINUTE,
      system_text: 'archived system text',
      messages: JSON.stringify([{ role: 'user', content: 'archived request' }]),
    },
  });
  dbOf(handle)
    .prepare(`UPDATE model_requests SET status = 'ok', finished_at = ?, response_text = ?, tool_calls = ? WHERE id = ?`)
    .run(iso(request.minutes), request.text, request.calls ? JSON.stringify(request.calls) : null, id);
}

/** A `turn.start` row of the day table. */
const turnStart = (turnId: string, minutes: number, placeId: string | null, iface: string, extra: unknown) => ({
  id: `day:${turnId}`,
  at: iso(minutes),
  what: 'turn.start',
  place_id: placeId,
  turn_id: turnId,
  scope_iface: iface,
  extra: JSON.stringify(extra),
});

/** The stored turns, their lines of the command line and their archived requests. */
function storedTurns(handle: ReturnType<typeof openMemoryDb>): void {
  const at = STAND_AT - 20 * MINUTE;
  const owner = observationOf(
    {
      iface: 'cli',
      at,
      chat: { id: 'cli:dm:owner', kind: 'dm', partnerId: 'owner', name: 'owner' },
      message: {
        id: 'cli-line-1',
        at,
        content: 'What is on the calendar today?',
        author: { id: 'owner', name: 'owner' },
      },
    },
    { direct: true }
  );
  const seen = observe(handle, owner, { now: () => at, log: quiet });
  if (seen.ok !== true) throw new Error(`replay-stand: the command line line was refused: ${String(seen.code)}`);
  const { cli, discord, diary } = WORLD.turns;
  insertRows(
    handle.db,
    {
      day: [
        turnStart(cli, 19.9, 'cli:dm:owner', 'cli', {
          mode: 'reply',
          trigger: { kind: 'mention', messageId: 'cli-line-1', authorId: 'owner' },
        }),
        turnStart(WORLD.turns.mention, 29.9, `discord:channel:${WORLD.tea}`, 'discord', {
          mode: 'reply',
          trigger: { kind: 'mention', messageId: WORLD.mention, authorId: WORLD.ada },
        }),
        turnStart(discord, 9.9, `discord:channel:${WORLD.tea}`, 'discord', {
          mode: 'reply',
          trigger: { kind: 'reply', messageId: WORLD.reply, authorId: WORLD.bram },
        }),
        turnStart(diary, 60, null, 'discord', { mode: 'diary' }),
      ],
    },
    { at: iso(9) }
  );
  archive(handle, { turnId: cli, step: 1, purpose: 'reply', minutes: 19.8, text: '<msg>Reading circle at six.</msg>' });
  archive(handle, {
    turnId: discord,
    step: 1,
    purpose: 'reply',
    minutes: 9.8,
    text: '',
    calls: [{ id: 'call_1', name: 'memory_search', arguments: '{"query":"reading circle"}' }],
  });
  archive(handle, {
    turnId: discord,
    step: 2,
    purpose: 'reply',
    minutes: 9.7,
    text: '<msg>Friday is fine by me.</msg>',
  });
  archive(handle, {
    turnId: diary,
    step: 1,
    purpose: 'diary-scene',
    minutes: 59.9,
    text: SCENE,
  });
  archive(handle, {
    turnId: diary,
    step: 2,
    purpose: 'reply',
    minutes: 59.8,
    text: '<msg>Tea, a lighthouse, rain.</msg>',
  });
}

/** The file journal of the server: the Discord turn's start, which a message replay reads its kind from, and a dump. */
function fileJournal(dataDir: string): void {
  const dir = path.join(dataDir, 'guilds', WORLD.guild, 'journal');
  fs.mkdirSync(path.join(dir, 'requests', '2026-03-04'), { recursive: true });
  const start = {
    kind: 'turn.start',
    turnId: WORLD.turns.discord,
    at: iso(9.9),
    mode: 'reply',
    scope: { channel: WORLD.tea },
    trigger: { kind: 'reply', messageId: WORLD.reply, authorId: WORLD.bram },
  };
  fs.writeFileSync(path.join(dir, '2026-03-04.jsonl'), `${JSON.stringify(start)}\n`);
  const dump = {
    model: 'stand/core-model',
    purpose: 'reply',
    system: 'dumped system text',
    user: 'dumped user text',
    later: [],
  };
  const requests = path.join(dir, 'requests', '2026-03-04');
  fs.writeFileSync(path.join(requests, `${WORLD.turns.dump}-1.json`), JSON.stringify(dump));
  const step = { ...dump, later: [{ role: 'assistant', content: '', tool_calls: [{ id: 'call_1' }] }] };
  fs.writeFileSync(path.join(requests, `${WORLD.turns.dump}-1-s1.json`), JSON.stringify(step));
}

/**
 * Writes the invented data folder into `dataDir` (which must not exist) and the REST fixture beside it at
 * `discordFile`.
 */
export async function buildStandWorld(dataDir: string, discordFile: string): Promise<void> {
  fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config', 'config.json'), `${JSON.stringify(settings(), null, 2)}\n`);
  fs.writeFileSync(path.join(dataDir, 'keys.json'), `${JSON.stringify({ keys: { stand: 'stand-placeholder' } })}\n`);
  fs.mkdirSync(path.join(dataDir, 'interfaces', 'discord'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'interfaces', 'discord', 'credentials.json'), '{"token":"stand-token"}\n');
  const fixture = standDiscord();
  fs.writeFileSync(discordFile, `${JSON.stringify(fixture)}\n`);
  const handle = openMemoryDb(path.join(dataDir, 'memory.db'));
  try {
    await observeDiscord(handle, fixture);
    storedTurns(handle);
  } finally {
    handle.close();
  }
  fileJournal(dataDir);
}
