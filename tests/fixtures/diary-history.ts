// The history scene of tests/diary-requests.test.ts: her diary is the truth of what she wrote. Five earlier entries,
// seven messages in all, which is more than `context.channelMessages` (4) lets the writer see. The fourth entry is a
// post of three messages: a text, a message that is one described picture, and a voice message. Between it and the
// fifth, Alice wrote a line in the diary channel `d1`; it is no part of her diary. `diary-history.json` beside this file
// holds the writer's `<chat>` block that the code before the change built for a diary turn in `d1` whose history is her
// seven messages, Alice's line taken out (`historyWorld({ alice: false })`). Memory holds the same entries as the diary
// keeps them: each entry's row with its text and its messages, her lines in the record of `d1`, the picture's and the
// voice's media rows with their attachment ids, the picture's description in the media cache, and Alice's line in the
// record. The diary's one enabled mirror is on `d1`. Synthetic text only.
import { createStore } from '../../src/memory/store.js';
import { dbOf, seedMirror } from './diary-mirror.ts';
import { GUILD, NOW, sceneHot } from './diary-requests.ts';
import type { sceneLlm } from './diary-requests.ts';
import { openTestMemory } from './memory-db/service.js';
import { world } from './turn-world.ts';
import { worldTurnRunner } from './world-runner.ts';
import type { createFakeAdapter } from '../../src/interface/fake.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** What the writer may see of a channel: fewer messages than her diary holds. */
export const CHANNEL_MESSAGES = 4;
/** The described picture of the fourth entry: its attachment id and what she saw in it. */
export const PICTURE = { id: 'att-5', description: 'a wooden pier at dusk, two boats' } as const;
const VOICE = { id: 'att-6', durationSec: 3 } as const;

type Attachment = { id: string; name: string; url: string; contentType: string; size: number; duration?: number };
type Post = { id: string; at: number; text: string; attachments: ReadonlyArray<Attachment> };

/** Her diary, oldest first: each entry and the messages it was posted as. */
const ENTRIES: ReadonlyArray<{ kind: string; posts: ReadonlyArray<Post> }> = [
  { kind: 'status', posts: [{ id: 'm1', at: NOW - 5 * DAY, text: 'πρώτη μέρα στο λιμάνι', attachments: [] }] },
  { kind: 'status', posts: [{ id: 'm2', at: NOW - 4 * DAY, text: 'δεύτερη μέρα, βροχή', attachments: [] }] },
  { kind: 'status', posts: [{ id: 'm3', at: NOW - 3 * DAY, text: 'une journée grise', attachments: [] }] },
  {
    kind: 'picture',
    posts: [
      { id: 'm4', at: NOW - 2 * DAY, text: 'βόλτα στο λιμάνι', attachments: [] },
      {
        id: 'm5',
        at: NOW - 2 * DAY + 1000,
        text: '',
        attachments: [
          { id: PICTURE.id, name: 'pier.png', url: 'https://cdn.example/pier.png', contentType: 'image/png', size: 2048 },
        ],
      },
      {
        id: 'm6',
        at: NOW - 2 * DAY + 2000,
        text: '',
        attachments: [
          {
            id: VOICE.id,
            name: 'voice-message.ogg',
            url: 'https://cdn.example/voice.ogg',
            contentType: 'audio/ogg',
            size: 4096,
            duration: VOICE.durationSec,
          },
        ],
      },
    ],
  },
  { kind: 'status', posts: [{ id: 'm7', at: NOW - DAY, text: 'ήσυχη μέρα', attachments: [] }] },
];
/** What happened to her messages after she posted them: `m7` edited to a newer text, `m4` deleted. */
export type Changes = { edited?: boolean; deleted?: boolean; reacted?: boolean };
/** The reaction three members put on `m7` (the owner, 2026-10-27: her history shows no reactions). */
const REACTION = { id: 'm7', emoji: { name: '❤️', id: null }, count: 3 } as const;
/** The newer text of `m7` and when she changed it. */
const EDIT = { id: 'm7', at: NOW - DAY + 2 * HOUR, text: 'ήσυχη μέρα, τελικά βροχή' } as const;
/** The message of the fourth entry she deleted, and when. */
const DELETED = { id: 'm4', at: NOW - 2 * DAY + 3 * HOUR } as const;

/** Alice's line in the diary channel, after the fourth entry. */
const ALICE = { id: 'a1', at: NOW - 2 * DAY + HOUR, text: 'ωραία φωτογραφία!' } as const;

/** Whether a post is her voice message: one audio attachment and no text. */
const isVoice = (post: { text: string; attachments?: ReadonlyArray<Attachment> }) =>
  post.text === '' && post.attachments?.length === 1 && post.attachments[0]?.contentType.startsWith('audio/') === true;

/** A message as discord.js hands it over: hers, or Alice's. */
function stub(
  post: {
    id: string;
    at: number;
    text: string;
    attachments?: ReadonlyArray<Attachment>;
    editedAt?: number;
    reactions?: ReadonlyArray<{ emoji: { name: string; id: null }; count: number }>;
  },
  self: boolean
) {
  const author = self
    ? { id: 'self-id', bot: true, globalName: 'Bot', username: 'Bot' }
    : { id: 'u1', bot: false, globalName: 'Alice', username: 'Alice' };
  return {
    id: post.id,
    channelId: 'd1',
    author,
    member: { displayName: author.globalName },
    cleanContent: post.text,
    createdTimestamp: post.at,
    editedTimestamp: post.editedAt ?? null,
    reactions: { cache: new Map((post.reactions ?? []).map((reaction, index) => [String(index), reaction])) },
    reference: null,
    attachments: new Map((post.attachments ?? []).map((attachment) => [attachment.id, attachment])),
    stickers: new Map(),
    // A message that is one audio file she recorded is a voice message, as the platform flags it.
    flags: { has: (flag: string) => flag === 'IsVoiceMessage' && isVoice(post) },
  };
}

/**
 * The world of the scene: the community's other conversation and the diary channel. With `history`, `d1` holds her
 * seven messages, and Alice's line too when `alice`; without it `d1` is empty, so a history can only come from memory.
 */
export function historyWorld({
  history,
  alice = false,
  edited = false,
  deleted = false,
  reacted = false,
}: { history: boolean; alice?: boolean } & Changes): void {
  world().channel({ id: 'c1', name: 'general', guildId: GUILD });
  // The channel shows what the platform holds now: an edited message's newest text, no deleted message.
  const own = ENTRIES.flatMap((entry) => entry.posts)
    .filter((post) => !(deleted && post.id === DELETED.id))
    .map((post) => (edited && post.id === EDIT.id ? { ...post, text: EDIT.text, editedAt: EDIT.at } : post))
    .map((post) =>
      reacted && post.id === REACTION.id
        ? { ...post, reactions: [{ emoji: REACTION.emoji, count: REACTION.count }] }
        : post
    )
    .map((post) => stub(post, true));
  const lines = alice ? [...own, stub(ALICE, false)].sort((a, b) => a.createdTimestamp - b.createdTimestamp) : own;
  world().channel({ id: 'd1', name: 'journal', guildId: GUILD, historyMessages: history ? lines : [] });
}

/** The scene's settings: the requests scene's, with the writer seeing `CHANNEL_MESSAGES` messages of a channel. */
export function historyHot(): { config: Record<string, unknown>; prompts: Record<string, unknown> } {
  const base = sceneHot();
  // sceneHot's sections are plain objects; the scene lays its own keys over them.
  const context = base.config.context as Record<string, unknown>;
  const features = base.config.features as Record<string, unknown>;
  return {
    ...base,
    config: {
      ...base.config,
      context: { ...context, channelMessages: CHANNEL_MESSAGES },
      // A picture of the history shows what she saw in it (`[image: …]`).
      features: { ...features, mediaDescriptions: true },
    },
  };
}

/** A record line of the diary channel: hers (`said`) or Alice's (`seen`). */
function recordLine(post: { id: string; at: number; text: string; attachments?: ReadonlyArray<Attachment> }, self: boolean) {
  const occurredAt = new Date(post.at).toISOString();
  const media = (post.attachments ?? []).map((attachment) => (attachment.contentType.startsWith('audio/') ? 'voice' : 'image'));
  return {
    v: 1,
    id: `rec-${post.id}`,
    kind: self ? 'said' : 'seen',
    messageId: post.id,
    revision: 1,
    occurredAt,
    recordedAt: occurredAt,
    guildId: GUILD,
    scope: { channel: 'd1' },
    ...(self ? {} : { by: 'u1' }),
    text: post.text,
    ...(media.length > 0 ? { media } : {}),
    origin: 'live',
  };
}

/** The memory of the scene: the service and the real store over it. */
export type HistoryMemory = {
  memory: Awaited<ReturnType<typeof openTestMemory>>;
  store: ReturnType<typeof createStore>;
};

/**
 * Memory as her diary keeps it (see the head of this file). The mirror is seeded only once the `mirrors` table exists,
 * so before schema v15 the scene fails where the turn needs its conversation.
 */
export async function historyMemory({ edited = false, deleted = false }: Changes = {}): Promise<HistoryMemory> {
  const memory = await openTestMemory({ now: () => NOW });
  const store = createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb });
  store.touchChannel(GUILD, 'd1', { name: 'journal' }, NOW - DAY);
  store.touchChannel(GUILD, 'c1', { name: 'general' }, NOW - DAY);
  for (const entry of ENTRIES) {
    const [first] = entry.posts;
    if (!first) continue;
    // The store's JSDoc types `search` as a string; a post with no search stores null, as the diary turn records it.
    const entryPost: Record<string, unknown> = {
        at: first.at,
        kind: entry.kind,
        gist: entry.posts.map((post) => post.text).filter(Boolean).join(' '),
        picture: entry.posts.some((post) => post.attachments.some((a) => a.contentType.startsWith('image/')))
          ? PICTURE.description
          : null,
        messageIds: entry.posts.map((one) => one.id),
        search: null,
      };
    store.appendDiaryPost(GUILD, entryPost as Parameters<typeof store.appendDiaryPost>[1], { max: 40 });
  }
  // The describer's cache: what she saw in the picture, by its attachment id.
  const cache = store.getMediaCache(GUILD) as Record<string, unknown>;
  cache[PICTURE.id] = { text: PICTURE.description, ts: NOW - 2 * DAY + 5000 };
  store.markMediaCacheDirty(GUILD);
  store.flush();
  await store.flushSettled({});
  for (const post of [...ENTRIES.flatMap((entry) => entry.posts).map((one) => ({ post: one, self: true })), { post: ALICE, self: false }]) {
    const day = new Date(post.post.at).toISOString().slice(0, 10);
    await memory.memoryDb.writeUnit({
      kind: 'unit',
      op: 'lines',
      owner: `guilds/${GUILD}/record/${day.slice(0, 7)}/${day}.jsonl`,
      iface: 'fake',
      lines: [recordLine(post.post, post.self)],
    });
  }
  // The record keeps what happened later: the edit as her line's second revision, the deletion as a `deleted` line.
  const later = (at: number, line: Record<string, unknown>) => {
    const day = new Date(at).toISOString().slice(0, 10);
    return memory.memoryDb.writeUnit({
      kind: 'unit',
      op: 'lines',
      owner: `guilds/${GUILD}/record/${day.slice(0, 7)}/${day}.jsonl`,
      iface: 'fake',
      lines: [line],
    });
  };
  if (edited) {
    const first = ENTRIES.flatMap((entry) => entry.posts).find((post) => post.id === EDIT.id);
    if (first)
      await later(EDIT.at, {
        ...recordLine({ ...first, text: EDIT.text }, true),
        id: `rec-${EDIT.id}-2`,
        revision: 2,
        recordedAt: new Date(EDIT.at).toISOString(),
      });
  }
  if (deleted)
    await later(DELETED.at, {
      v: 1,
      id: `rec-${DELETED.id}-deleted`,
      kind: 'deleted',
      messageId: DELETED.id,
      occurredAt: new Date(DELETED.at).toISOString(),
      guildId: GUILD,
      scope: { channel: 'd1' },
    });
  const db = dbOf(memory.memoryDb);
  // Each entry's full text, as the diary media job fills it in: her messages of the entry, in order.
  for (const entry of ENTRIES) {
    const [first] = entry.posts;
    if (!first) continue;
    const text = entry.posts.map((post) => post.text).filter(Boolean).join('\n');
    db.prepare('UPDATE diary SET text = ? WHERE at_ms = ?').run(text, first.at);
  }
  // The fourth entry's media rows, with the attachment ids its messages carry and the picture's description.
  const fourth = db.prepare("SELECT id, scope_kind, scope_iface, audience_id FROM diary WHERE kind = 'picture'").all()[0];
  if (fourth) {
    const media = db.prepare(
      `INSERT INTO media (id, kind, owner, path, native_ref, description, sha1, bytes, mime, scope_kind, scope_iface, scope_dm, extra, audience_id)
        VALUES (?, 'diary', ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?)`
    );
    media.run(
      `media:diary:${String(fourth.id)}-1`,
      fourth.id,
      `media/diary/${String(fourth.id)}-1.png`,
      JSON.stringify({ url: 'https://cdn.example/pier.png', messageId: 'm5', attachmentId: PICTURE.id }),
      PICTURE.description,
      2048,
      'image/png',
      fourth.scope_kind,
      fourth.scope_iface,
      null,
      fourth.audience_id
    );
    media.run(
      `media:diary:${String(fourth.id)}-2`,
      fourth.id,
      `media/diary/${String(fourth.id)}-2.ogg`,
      JSON.stringify({ url: 'https://cdn.example/voice.ogg', messageId: 'm6', attachmentId: VOICE.id }),
      null,
      4096,
      'audio/ogg',
      fourth.scope_kind,
      fourth.scope_iface,
      JSON.stringify({ voice: true, durationSec: VOICE.durationSec }),
      fourth.audience_id
    );
  }
  const hasMirrors = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mirrors'").all();
  if (hasMirrors.length > 0) seedMirror(memory.memoryDb, { iface: 'fake', conversationId: 'd1', name: 'journal', at: NOW });
  return { memory, store };
}

/** What the scene's runner offers a test: one turn at a time. */
export type HistoryRunner = { runTurn(params: Record<string, unknown>): Promise<unknown> };

/**
 * The real turn runner over the scene's world, store and settings, with the requests scene's model. `port` replaces
 * the world's interface (an adapter that answers no read is an interface that is not connected).
 */
export function historyRunner(
  llm: ReturnType<typeof sceneLlm>,
  store: HistoryMemory['store'],
  port: ReturnType<typeof createFakeAdapter> | null = null
): HistoryRunner {
  return worldTurnRunner({
    hot: historyHot(),
    store,
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    images: null,
    lookup: null,
    rng: () => 0.5,
    now: () => NOW,
    describer: cacheDescriber(store),
    ...(port ? { port } : {}),
  });
}

/**
 * A describer that only reads what the describer's cache in memory holds (the store's media cache, by attachment id)
 * and never describes anything new, as src/memory/describe.js answers for a picture it already saw.
 */
function cacheDescriber(store: HistoryMemory['store']) {
  const cached = (guildId: string, items: ReadonlyArray<{ itemId?: unknown }>) => {
    const cache = store.getMediaCache(guildId) as Record<string, { text?: unknown } | undefined>;
    const found = new Map<string, string>();
    for (const item of items) {
      const entry = typeof item.itemId === 'string' ? cache[item.itemId] : undefined;
      if (typeof item.itemId === 'string' && typeof entry?.text === 'string') found.set(item.itemId, entry.text);
    }
    return found;
  };
  return {
    cachedDescriptions: cached,
    describeMany: (guildId: string, items: ReadonlyArray<{ itemId?: unknown }>) =>
      Promise.resolve({ descriptions: cached(guildId, items), newCount: 0 }),
  };
}

/** The writer's `<chat>` block of a scene's model, its second request. */
export function chatBlock(llm: ReturnType<typeof sceneLlm>): string {
  const writer = llm.calls[1] as Array<{ role: string; content: unknown }> | undefined;
  const user = writer?.find((message) => message.role === 'user')?.content;
  const texts = Array.isArray(user)
    ? (user as Array<{ text?: unknown }>).map((part) => (typeof part.text === 'string' ? part.text : ''))
    : [typeof user === 'string' ? user : ''];
  return /<chat>\n[\s\S]*?\n<\/chat>/.exec(texts.join('\n'))?.[0] ?? '';
}
