// The platforms of the fault run (scripts/lib/fault-run.ts) that the fake interface does not stand for: a discord.js
// client with no gateway and no REST behind it, for the real Discord interface of interfaces/discord/, and a terminal
// of two streams, for the real chat of interfaces/cli/, and a video site of a local file behind stand-ins of the tools
// the video fetcher runs. Each counts what reaches it at the place the platform would
// see it. Nothing here opens a socket to the network, and no token is real.
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { Events } from '../../interfaces/discord/index.ts';

type Obj = Record<string, unknown>;

/** Discord's channel type of a text channel of a server (discord.js `ChannelType.GuildText`). */
const GUILD_TEXT = 0;

/** A member of the fake server: a person, or the persona's bot account. */
type FakeUser = { id: string; name: string; bot: boolean };

/** What the platform received, in order: `<call>:<chat>:<what>`, each a call of the Discord interface. */
export type PlatformCalls = Array<string>;

export type FakeDiscord = {
  /** The client the session logs in with, injected through `host.createClient`. */
  client: object;
  /** Every call that reached the platform, in order. */
  calls: PlatformCalls;
  /** A member writes `text` in `chat`, naming the persona when `mention`: the gateway's event. Returns its id. */
  write(chat: string, text: string, mention: boolean): string;
  /** A member's message the platform holds from before the start, which no gateway event announces. */
  seed(chat: string, text: string): void;
  /** A member edits their message `id` in `chat` to `text`: the gateway's update event. */
  edit(chat: string, id: string, text: string): void;
};

/**
 * One server of text channels with the persona's bot in it, over no network. A send of the interface posts a message
 * and echoes it as the gateway does, an edit of the persona's message changes it and echoes the update, and a read
 * answers the newest messages the platform holds. Each call is counted in `calls`: `send:<chat>:<text>`,
 * `edit:<chat>:<text>`, `read:<chat>:<query>` for a page of history, `fetch:<chat>:<message>` for one message and
 * `typing:<chat>`. Message ids are snowflakes counted up from one base, so a page sorts by them.
 */
export function createFakeDiscord(options: {
  self: { id: string; name: string };
  root: { id: string; name: string };
  chats: ReadonlyArray<string>;
  members: ReadonlyArray<{ id: string; name: string }>;
}): FakeDiscord {
  const gateway = new EventEmitter();
  const calls: PlatformCalls = [];
  let nextId = 1_000_000_000_000_000_000n;
  const newId = (): string => {
    nextId += 1n;
    return String(nextId);
  };
  // Each message a later moment than the one before, as Discord's snowflakes order them: two lines of one millisecond
  // would leave the order of a chat to chance.
  let lastAt = 0;
  const stamp = (): number => {
    lastAt = Math.max(Date.now(), lastAt + 1);
    return lastAt;
  };
  const people = new Map<string, FakeUser>(options.members.map((one) => [one.id, { ...one, bot: false }]));
  const selfUser: FakeUser = { ...options.self, bot: true };
  const userOf = (one: FakeUser): Obj => ({ id: one.id, bot: one.bot, globalName: one.name, username: one.name });
  const memberOf = (one: FakeUser): Obj => ({
    id: one.id,
    displayName: one.name,
    user: userOf(one),
    avatar: null,
    displayAvatarURL: () => null,
  });
  const channels = new Map<string, Obj>();
  const held = new Map<string, Map<string, Obj>>();
  const guild: Obj = {
    id: options.root.id,
    name: options.root.name,
    members: {
      me: memberOf(selfUser),
      cache: new Map([...people.values()].map((one) => [one.id, memberOf(one)])),
      fetch: () => Promise.resolve(null),
    },
    channels: { cache: channels },
    roles: { cache: new Map() },
    voiceStates: { cache: new Map() },
    presences: { cache: new Map() },
  };
  /** A message of `author` in `channel`, as discord.js hands one over. */
  function messageOf(channel: Obj, author: FakeUser, id: string, text: string, mention: boolean): Obj {
    const message: Obj = {
      id,
      system: false,
      webhookId: null,
      author: userOf(author),
      member: memberOf(author),
      guild,
      guildId: guild.id,
      channel,
      channelId: channel.id,
      cleanContent: text,
      content: text,
      createdTimestamp: stamp(),
      editedTimestamp: null,
      reference: null,
      mentions: { users: new Map(mention ? [[selfUser.id, userOf(selfUser)]] : []) },
      attachments: new Map(),
      stickers: new Map(),
      embeds: [],
      reactions: { cache: new Map() },
    };
    message.edit = (payload: Obj): Promise<Obj> => {
      const before = { ...message };
      const changed = typeof payload.content === 'string' ? payload.content : '';
      calls.push(`edit:${String(channel.id)}:${changed}`);
      Object.assign(message, { content: changed, cleanContent: changed, editedTimestamp: stamp() });
      gateway.emit(Events.MessageUpdate, before, message);
      return Promise.resolve(message);
    };
    return message;
  }
  for (const id of options.chats) {
    const messages = new Map<string, Obj>();
    held.set(id, messages);
    const channel: Obj = {
      id,
      guild,
      guildId: guild.id,
      name: `room-${id}`,
      topic: null,
      parent: null,
      parentId: null,
      type: GUILD_TEXT,
      viewable: true,
      lastMessageId: null,
      isTextBased: () => true,
      isThread: () => false,
      isDMBased: () => false,
      permissionsFor: () => ({ has: () => true }),
      permissionOverwrites: { cache: new Map() },
      sendTyping: (): Promise<void> => {
        calls.push(`typing:${id}`);
        return Promise.resolve();
      },
      send: (payload: Obj): Promise<Obj> => {
        const text = typeof payload.content === 'string' ? payload.content : '';
        calls.push(`send:${id}:${text}`);
        const posted = messageOf(channel, selfUser, newId(), text, false);
        if (typeof payload.nonce === 'string') posted.nonce = payload.nonce;
        messages.set(String(posted.id), posted);
        gateway.emit(Events.MessageCreate, posted);
        return Promise.resolve(posted);
      },
      messages: {
        cache: messages,
        fetch: (query: unknown): Promise<unknown> => {
          if (typeof query === 'string') {
            calls.push(`fetch:${id}:${query}`);
            const found = messages.get(query);
            return found === undefined
              ? Promise.reject(Object.assign(new Error('Unknown Message'), { status: 404 }))
              : Promise.resolve(found);
          }
          // The page of the newest messages, newest first, as discord.js answers a query of a `limit` alone.
          const asked = query as { limit: number };
          calls.push(`read:${id}:${JSON.stringify(asked)}`);
          const newest = [...messages.values()].slice(-asked.limit).reverse();
          return Promise.resolve(new Map(newest.map((one) => [String(one.id), one])));
        },
      },
    };
    channels.set(id, channel);
  }
  /** A message of the first member in `chat`, held by the platform. */
  function memberMessage(chat: string, text: string, mention: boolean): Obj {
    const channel = channels.get(chat);
    const author = [...people.values()][0];
    if (channel === undefined || author === undefined) throw new Error(`fault-run: no chat ${chat} or no member`);
    const message = messageOf(channel, author, newId(), text, mention);
    held.get(chat)?.set(String(message.id), message);
    return message;
  }
  const client = Object.assign(gateway, {
    user: { id: selfUser.id, tag: `${selfUser.name}#0001`, username: selfUser.name },
    application: { id: 'fault-run-app' },
    users: { cache: new Map([...people.values()].map((one) => [one.id, userOf(one)])) },
    guilds: { cache: new Map([[String(guild.id), guild]]) },
    channels: { cache: channels, fetch: (id: string) => Promise.resolve(channels.get(id) ?? null) },
    isReady: () => true,
    login: (): Promise<string> => {
      setTimeout(() => gateway.emit(Events.ClientReady, gateway), 1);
      return Promise.resolve('logged-in');
    },
    destroy: (): Promise<void> => Promise.resolve(),
  });
  return {
    client,
    calls,
    seed(chat, text) {
      memberMessage(chat, text, false);
    },
    write(chat, text, mention) {
      const message = memberMessage(chat, text, mention);
      gateway.emit(Events.MessageCreate, message);
      return String(message.id);
    },
    edit(chat, id, text) {
      const message = held.get(chat)?.get(id);
      if (message === undefined) throw new Error(`fault-run: no message ${id} in ${chat}`);
      const before = { ...message };
      Object.assign(message, { content: text, cleanContent: text, editedTimestamp: stamp() });
      gateway.emit(Events.MessageUpdate, before, message);
    },
  };
}

export type FakeTerminal = {
  stdout: Writable & { columns: number; rows: number; isTTY: boolean };
  stdin: Readable;
  /** Keys typed, as a terminal sends them. */
  type(text: string): void;
  /** The rows of the last whole frame drawn, without the terminal's escape sequences and trailing blanks. */
  screen(): Array<string>;
};

/** A terminal of `columns` by `rows` cells in raw mode, as the chat of interfaces/cli/index.ts draws in one. */
export function createFakeTerminal(columns: number, rows: number): FakeTerminal {
  let last = '';
  const stdout = Object.assign(
    new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        const text = stripVTControlCharacters(String(chunk));
        // A frame is a write of whole rows. A write with no new line moves the cursor or sets a mode.
        if (text.includes('\n')) last = text;
        done();
      },
    }),
    { columns, rows, isTTY: true }
  );
  const stdin = Object.assign(new Readable({ read() {} }), {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  });
  return {
    stdout,
    stdin,
    type: (text) => void stdin.push(text),
    screen: () =>
      last
        .replace(/\n$/, '')
        .split('\n')
        .map((row) => row.trimEnd()),
  };
}

export type FakeVideoSite = {
  /** The stand-in of `yt-dlp` (`media.video.ytdlpPath`). */
  ytdlpPath: string;
  /** The stand-in of `ffmpeg` (`media.video.ffmpegPath`). */
  ffmpegPath: string;
  /** The bytes of the clip the site serves. */
  clip: Buffer;
  /** Every run of the two tools, in order: `yt-dlp probe <url>`, `yt-dlp clip <url>` or `ffmpeg <first argument>`. */
  calls(): Array<string>;
};

/**
 * A video site that is a local file: two shell scripts under `dir` stand in for `yt-dlp` and `ffmpeg`, the tools
 * src/media/fetch-video.ts runs. The probe (`--dump-single-json`) prints the metadata of a clip of `seconds`, a
 * download copies the local clip to the output path yt-dlp is given (`-o`), and ffmpeg refuses every run, as a host
 * without it would. Each run appends one line to a calls file.
 */
export function createFakeVideoSite(dir: string, seconds: number): FakeVideoSite {
  const clip = Buffer.from('a local clip in place of a video site');
  const clipPath = join(dir, 'clip.mp4');
  const callsPath = join(dir, 'calls');
  writeFileSync(clipPath, clip);
  const ytdlpPath = join(dir, 'yt-dlp');
  const ffmpegPath = join(dir, 'ffmpeg');
  const probe = JSON.stringify({ duration: seconds, title: 'local clip' });
  const ytdlp = [
    '#!/bin/sh',
    'url=""; out=""; prev=""',
    'for arg in "$@"; do [ "$prev" = "-o" ] && out="$arg"; url="$arg"; prev="$arg"; done',
    'case " $* " in',
    `  *" --dump-single-json "*) echo "yt-dlp probe $url" >> '${callsPath}'; printf '%s' '${probe}' ;;`,
    `  *) echo "yt-dlp clip $url" >> '${callsPath}'; cp '${clipPath}' "$out" ;;`,
    'esac',
    '',
  ];
  writeFileSync(ytdlpPath, ytdlp.join('\n'), { mode: 0o755 });
  writeFileSync(ffmpegPath, ['#!/bin/sh', `echo "ffmpeg $1" >> '${callsPath}'`, 'exit 1', ''].join('\n'), {
    mode: 0o755,
  });
  return {
    ytdlpPath,
    ffmpegPath,
    clip,
    calls: () => (existsSync(callsPath) ? readFileSync(callsPath, 'utf8').trim().split('\n') : []),
  };
}
