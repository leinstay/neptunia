// The interface a turn replayed by scripts/turn-replay.ts talks to. `storedLines` reads the stored lines of one place
// from a data copy's memory database up to the line that started the turn, each with the platform's message id (its
// locator's, else its message family's, else its own key). `storedChatPort` is the fake adapter
// (src/interface/fake.ts) seeded with the chat and those lines as the `message.received` events a platform's history
// read answers, so a turn of any interface reads the chat as it stood. `recordingPort` wraps an adapter: every send,
// edit, deletion and reaction is kept in `writes` and answered as delivered, typing is answered and kept nowhere, and
// nothing reaches the adapter beneath but its reads.

import { mediaMessageParts, lineMedia } from '../../src/memory/db/media-store.ts';
import { internalContext } from '../../src/memory/db/scope.ts';
import { createFakeAdapter } from '../../src/interface/fake.ts';
import type { Db } from '../../src/memory/db/types.ts';
import type { MediaRow } from '../../src/memory/db/media-store.ts';
import type { Adapter, ChatInfo, ChatRef, Delivery, MessageEvent, MessageRef } from '../../src/protocol/adapter.ts';
import type { Content } from '../../src/protocol/actions.ts';

/** A stored line as the history read answers it. */
export type StoredLine = {
  sourceId: string;
  messageId: string;
  at: number;
  text: string;
  authorId: string;
  authorName: string | null;
  self: boolean;
  replyToId: string | null;
  /** When the line's current text was stored, for a line whose current revision is a later one; else null. */
  editedAt: number | null;
  media: Array<MediaRow>;
};

type Row = Record<string, unknown>;

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function jsonOf(value: unknown): Row {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : null;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Row) : {};
  } catch {
    return {};
  }
}

function firstName(names: unknown): string | null {
  try {
    const parsed: unknown = typeof names === 'string' ? JSON.parse(names) : null;
    return Array.isArray(parsed) ? text(parsed[0]) : null;
  } catch {
    return null;
  }
}

/** The platform's id of a stored message: its locator's, else its message family's, else its own key. */
function platformIdOf(row: Row, families: ReadonlyMap<string, string>): string {
  const locator = jsonOf(JSON.stringify(jsonOf(row.extra).$messageLocator ?? null));
  return text(locator.messageId) ?? families.get(String(row.native_id)) ?? String(row.native_id ?? row.id);
}

/** The platform's id of the message a stored line replies to, when it replies to one. */
function replyIdOf(row: Row, families: ReadonlyMap<string, string>): string | null {
  const reply = jsonOf(JSON.stringify(jsonOf(row.extra).$messageReply ?? null));
  const to = text(row.reply_to);
  return text(reply.messageId) ?? (to === null ? null : (families.get(to) ?? to));
}

/** The lines a history read can reach back from the trigger: past any page a turn reads. */
const LINES_KEPT = 2000;

const familyOf = (row: Row): string =>
  JSON.stringify([
    row.native_id ?? null,
    row.iface ?? null,
    row.authority_id ?? `${String(row.iface)}/global`,
    row.native_kind ?? 'message',
    row.generation ?? 1,
  ]);

/**
 * The rows of one place that are lines as they stand now, oldest first: the rule of CURRENT_SOURCE
 * (src/memory/db/source-current.ts) applied in code, because its subqueries scan the place once per row (minutes for a
 * channel of thousands of lines). A family's newest revision, its first row, and no family a `deleted` row names.
 */
function currentRows(db: Db, placeId: string): Array<Row> {
  const rows = db
    .prepare(
      `SELECT s.rowid AS r, s.id, s.kind, s.iface, s.native_id, s.authority_id, s.native_kind, s.generation, s.revision,
         s.text, s.occurred_at, s.recorded_at, s.reply_to, s.extra, a.native_id AS author_native, a.names AS author_names
       FROM sources s LEFT JOIN accounts a ON a.id = s.author_account
       WHERE s.place_id = ? AND s.retired_at IS NULL AND s.kind IN ('seen', 'said', 'deleted')`
    )
    .all(placeId);
  const best = new Map<string, Row>();
  const deleted: Array<Row> = [];
  for (const row of rows) {
    if (row.kind === 'deleted') {
      deleted.push(row);
      continue;
    }
    const key = familyOf(row);
    const held = best.get(key);
    const revision = Number(row.revision ?? -1);
    const heldRevision = Number(held?.revision ?? -1);
    if (!held || revision > heldRevision || (revision === heldRevision && Number(row.r) < Number(held.r)))
      best.set(key, row);
  }
  const gone = (row: Row): boolean =>
    deleted.some(
      (d) =>
        d.native_id === row.native_id &&
        d.iface === row.iface &&
        (d.authority_id === null || d.authority_id === (row.authority_id ?? `${String(row.iface)}/global`)) &&
        (d.native_kind === null || d.native_kind === (row.native_kind ?? 'message')) &&
        (d.generation === null || d.generation === (row.generation ?? 1))
    );
  return [...best.values()]
    .filter((row) => !gone(row))
    .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)) || Number(a.r) - Number(b.r));
}

/**
 * The stored lines of `placeId`, oldest first, through the line whose platform id is `through`, and with `until`
 * (milliseconds) every later line written before it: what a history read gave when the turn started. Throws when the
 * place holds no such line: the turn's trigger must be among them.
 */
export function storedLines(
  db: Db,
  { placeId, through, until = null }: { placeId: string; through: string; until?: number | null }
): Array<StoredLine> {
  const rows = currentRows(db, placeId);
  const families = new Map<string, string>();
  for (const row of db.prepare('SELECT native_key, message_id FROM message_families').all())
    families.set(String(row.native_key), String(row.message_id));
  const end = rows.findIndex((row) => platformIdOf(row, families) === through);
  if (end < 0) throw new Error(`turn-port: ${placeId} holds no stored line ${through}`);
  const later = until === null ? [] : rows.slice(end + 1).filter((row) => Date.parse(String(row.occurred_at)) < until);
  const kept = [...rows.slice(Math.max(0, end + 1 - LINES_KEPT), end + 1), ...later];
  const media = lineMedia(
    db,
    kept.map((row) => String(row.id)),
    internalContext()
  );
  return kept.map((row) => ({
    sourceId: String(row.id),
    messageId: platformIdOf(row, families),
    at: Date.parse(String(row.occurred_at)),
    text: typeof row.text === 'string' ? row.text : '',
    authorId: text(row.author_native) ?? (row.kind === 'said' ? 'self' : ''),
    authorName: firstName(row.author_names),
    self: row.kind === 'said',
    replyToId: replyIdOf(row, families),
    editedAt: Number(row.revision) > 1 ? Date.parse(String(row.recorded_at)) : null,
    media: media.get(String(row.id)) ?? [],
  }));
}

/** What a platform's message carries beyond its stored line: its reactions and the messages its text links to. */
export type LineExtras = {
  reactions?: ReadonlyArray<StoredReaction>;
  messageRefs?: ReadonlyArray<{ iface: string; chatId: string; messageId: string; url: string; text: string }>;
};

/** The `message.received` event a platform's history read gives for a stored line. */
export function eventOfStored(
  line: StoredLine,
  iface: string,
  chat: MessageEvent['chat'],
  extras: LineExtras = {}
): MessageEvent {
  const parts = mediaMessageParts(line.media, line.messageId);
  // The media parts are the rows a platform's message carries, in the field shapes the adapter's events have.
  const asParts = (rows: Array<Row>) => rows as unknown as MessageEvent['message']['attachments'];
  return {
    kind: 'message.received',
    iface,
    at: line.at,
    id: `${iface}:message:${line.messageId}`,
    chat,
    message: {
      id: line.messageId,
      author: { id: line.authorId, name: line.authorName, self: line.self, bot: false },
      content: line.text,
      sourceText: line.text,
      system: false,
      at: line.at,
      ...(line.editedAt === null ? {} : { editedAt: line.editedAt }),
      replyToId: line.replyToId,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: asParts(parts.attachments),
      links: asParts(parts.links),
      forwarded: [],
      stickers: asParts(parts.stickers),
      emojis: asParts(parts.emojis),
      reactions: (extras.reactions ?? []).map(({ emoji, count, mine }) => ({ emoji, count, mine })),
      ...(extras.messageRefs && extras.messageRefs.length > 0 ? { messageRefs: [...extras.messageRefs] } : {}),
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
  };
}

/** One reaction on a message: its key as the interface shows it, how many put it, whether she did, and who. */
export type StoredReaction = { emoji: string; count: number; mine: boolean; accounts: Array<string> };

/**
 * The reactions on the messages of chat `chatId` of `iface`, by platform message id, from the reaction events the
 * memory database's `ingest` kept (`<iface>:reaction:<message>:<account>:<emoji>:add|remove:<ms>`), in the order they
 * were committed. A custom emoji is named by `emojiName(id)` and left out when it has no name.
 */
export function storedReactions(
  db: Db,
  {
    iface,
    chatId,
    selfId,
    emojiName,
  }: { iface: string; chatId: string; selfId: string; emojiName: (id: string) => string | null }
): Map<string, Array<StoredReaction>> {
  const rows = db
    .prepare(
      `SELECT event_id FROM ingest WHERE kind = 'reaction.changed' AND conversation = ? AND event_id LIKE ?
       ORDER BY committed_at, seq`
    )
    .all(chatId, `${iface}:reaction:%`);
  const by = new Map<string, Map<string, Set<string>>>();
  for (const row of rows) {
    const parts = String(row.event_id).split(':');
    const [, , messageId, accountId, emoji, change] = parts;
    if (!messageId || !accountId || !emoji || (change !== 'add' && change !== 'remove')) continue;
    const name = /^\d+$/.test(emoji) ? emojiName(emoji) : emoji;
    if (name === null) continue;
    const key = /^\d+$/.test(emoji) ? `:${name}:` : name;
    const emojis = by.get(messageId) ?? new Map<string, Set<string>>();
    const accounts = emojis.get(key) ?? new Set<string>();
    if (change === 'add') accounts.add(accountId);
    else accounts.delete(accountId);
    emojis.set(key, accounts);
    by.set(messageId, emojis);
  }
  const out = new Map<string, Array<StoredReaction>>();
  for (const [messageId, emojis] of by) {
    const list = [...emojis]
      .filter(([, accounts]) => accounts.size > 0)
      .map(([emoji, accounts]) => ({
        emoji,
        count: accounts.size,
        mine: accounts.has(selfId),
        accounts: [...accounts],
      }));
    if (list.length > 0) out.set(messageId, list);
  }
  return out;
}

/** The chat of a stored place as an interface describes it: the fields a history event and a chat read carry. */
export type StoredChat = Pick<ChatInfo, 'id' | 'kind' | 'name' | 'rootId' | 'topic'> & Partial<ChatInfo>;

/**
 * A fake adapter of `iface` holding the chat `chat` (and `others`, the other chats of its root, for the listing) with
 * the stored lines of `placeId` through `through` (and before `until`) as its history, each with `extrasOf` its line.
 */
export function storedChatPort({
  db,
  iface,
  selfId,
  chat,
  others = [],
  placeId,
  through,
  until = null,
  extrasOf = () => ({}),
  now = () => 0,
}: {
  db: Db;
  iface: string;
  selfId: string;
  chat: StoredChat;
  others?: ReadonlyArray<StoredChat>;
  placeId: string;
  through: string;
  /** With it, the lines written after the trigger and before this moment too (storedLines). */
  until?: number | null;
  /** What each line's message carries beyond the line; its reactors are seeded for the reactors read. */
  extrasOf?: (line: StoredLine) => LineExtras;
  now?: () => number;
}): ReturnType<typeof createFakeAdapter> {
  const adapter = createFakeAdapter({ iface, selfId, now });
  const filled = (info: StoredChat): ChatInfo => ({
    iface,
    permissions: { read: true, send: true, attach: true, react: true },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
    audience: null,
    ...info,
  });
  for (const info of [chat, ...others]) adapter.seedChat(filled(info));
  const record = { id: chat.id, kind: chat.kind, rootId: chat.rootId, name: chat.name, topic: chat.topic };
  for (const line of storedLines(db, { placeId, through, until })) {
    const extras = extrasOf(line);
    adapter.seedEvent(eventOfStored(line, iface, record, extras));
    for (const reaction of extras.reactions ?? [])
      adapter.seedReactors({ iface, chatId: chat.id, messageId: line.messageId }, reaction.emoji, reaction.accounts);
  }
  return adapter;
}

/** A write the replayed turn asked of its interface, stamped with the wall clock (`wall`) for the report's timings. */
export type RecordedWrite = { op: 'send' | 'edit' | 'delete' | 'react' | 'unreact'; at: number; args: Array<unknown> };

/**
 * `adapter` with its writes kept in `writes` and answered as delivered (see the head of this file), the delivery stamped
 * `now()`. The message ids of the sends are `replay-<n>`.
 */
export function recordingPort<TAdapter extends Adapter>(
  adapter: TAdapter,
  now: () => number,
  wall: () => number = Date.now
): { port: TAdapter; writes: Array<RecordedWrite> } {
  const writes: Array<RecordedWrite> = [];
  let sent = 0;
  const done = (ref: MessageRef) => Promise.resolve({ status: 'ok' as const, ref, at: now() });
  const port: TAdapter = {
    ...adapter,
    send(chat: ChatRef, content: Content, options: { idempotencyKey?: string } = {}): Promise<Delivery> {
      writes.push({ op: 'send', at: wall(), args: [chat, content] });
      sent += 1;
      const ref = { iface: chat.iface, chatId: chat.chatId, messageId: `replay-${sent}` };
      return Promise.resolve({
        status: 'ok',
        ref,
        parts: [ref],
        at: now(),
        idempotencyKey: options.idempotencyKey ?? `replay-send-${sent}`,
        error: null,
      });
    },
    edit(message: MessageRef, content: Content) {
      writes.push({ op: 'edit', at: wall(), args: [message, content] });
      return done(message);
    },
    delete(message: MessageRef) {
      writes.push({ op: 'delete', at: wall(), args: [message] });
      return done(message);
    },
    react(message: MessageRef, emoji: string) {
      writes.push({ op: 'react', at: wall(), args: [message, emoji] });
      return done(message);
    },
    unreact(message: MessageRef, emoji: string) {
      writes.push({ op: 'unreact', at: wall(), args: [message, emoji] });
      return done(message);
    },
    typing: () => Promise.resolve({ status: 'ok' as const }),
  };
  return { port, writes };
}
