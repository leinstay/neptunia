// The stage of a turn replayed by scripts/turn-replay.ts: the stored turn as its `turn.start` row of the `day` table
// names it, the interface it ran on as a port over the copy's stored lines through its trigger, and the parameters
// `runTurn` is called with, as the core's pipeline calls it (src/pipeline/answer.ts, follow-up.ts, private-gate.ts).
// The command line chat is the core's own construction with no client open (src/core.ts: `withStoredHistory` over
// `createCliChat`), its lines cut after the trigger. Any other place is the fake adapter of its interface seeded with
// the place, its root's chats and its lines (scripts/lib/turn-port.ts). Either is wrapped by `recordingPort`.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCliChat } from '../../src/interface/cli-chat.ts';
import { createIfaceRouter } from '../../src/interface/link.ts';
import { createFakeAdapter } from '../../src/interface/fake.ts';
import { withStoredHistory } from '../../src/chat/stored-history.ts';
import { createChatSessions } from '../../src/chat/sessions.ts';
import { createChatStore } from '../../src/chat/store.ts';
import type { SourceLine } from '../../src/chat/sessions.ts';
import { chatLines } from '../../src/memory/db/chat-lines.ts';
import { ownerConsoleName } from '../../src/memory/db/identity-links.ts';
import { lineOf } from '../../src/behavior/line-of.ts';
import type { Db } from '../../src/memory/db/types.ts';
import type { Adapter, ChatRef, MessageEvent } from '../../src/protocol/adapter.ts';
import { messageRefsOf } from '../../interfaces/discord/collect.ts';
import { createDiscordAdapter } from '../../interfaces/discord/port.ts';
import { recordingPort, storedChatPort, storedReactions } from './turn-port.ts';
import type { RecordedWrite, StoredChat } from './turn-port.ts';

/** The command line's interface and its one chat (src/interface/cli-chat.ts). */
const CLI_IFACE = 'cli';

/** A stored turn as its `turn.start` row names it. */
export type StoredTurn = {
  turnId: string;
  at: number;
  placeId: string;
  iface: string;
  mode: string | null;
  triggerKind: string | null;
  triggerId: string | null;
  authorId: string | null;
};

const textOr = (value: unknown, fallback: string | null = null): string | null =>
  typeof value === 'string' && value !== '' ? value : fallback;

/** The turn whose id is `turnId`, or the only one whose id starts with it. Throws for none or several. */
export function storedTurn(db: Db, turnId: string): StoredTurn {
  const rows = db
    .prepare("SELECT turn_id, at, place_id, scope_iface, extra FROM day WHERE what = 'turn.start' AND turn_id LIKE ?")
    .all(`${turnId.replaceAll('%', '')}%`);
  const ids = new Set(rows.map((row) => String(row.turn_id)));
  if (ids.size !== 1) throw new Error(`turn-replay: ${ids.size} stored turns start with ${turnId}`);
  const row = rows[0];
  let extra: Record<string, unknown> = {};
  try {
    extra = JSON.parse(typeof row.extra === 'string' ? row.extra : '{}') as Record<string, unknown>;
  } catch {
    // A start row with unreadable fields names its place and time alone.
  }
  const trigger = (extra.trigger ?? {}) as Record<string, unknown>;
  const placeId = String(row.place_id);
  return {
    turnId: String(row.turn_id),
    at: Date.parse(String(row.at)),
    placeId,
    iface: textOr(row.scope_iface, placeId.split(':')[0]) ?? '',
    mode: textOr(extra.mode),
    triggerKind: textOr(trigger.kind),
    triggerId: textOr(trigger.messageId),
    authorId: textOr(trigger.authorId),
  };
}

/**
 * The platform id of a stored private chat's partner, from its place row and the partner's account: what the core's
 * `dmPartnerOf` reads through the store (src/memory/addresses.ts). Null for any other place.
 */
function partnerOf(db: Db, placeId: string): string | null {
  const row = db
    .prepare(
      "SELECT a.native_id FROM places p JOIN accounts a ON a.id = p.partner_account WHERE p.id = ? AND p.kind = 'dm'"
    )
    .get(placeId);
  return typeof row?.native_id === 'string' ? row.native_id : null;
}

/** The stored key of the line whose platform id is `messageId` in `placeId`, and its time. */
function triggerLine(db: Db, placeId: string, messageId: string): { nativeId: string; at: number } {
  const row = db
    .prepare(
      `SELECT native_id, occurred_at FROM sources WHERE place_id = ? AND kind IN ('seen', 'said')
         AND (native_id = ? OR json_extract(extra, '$."$messageLocator".messageId') = ?)
       ORDER BY rowid LIMIT 1`
    )
    .get(placeId, messageId, messageId);
  if (!row) throw new Error(`turn-replay: ${placeId} holds no line ${messageId}`);
  return { nativeId: String(row.native_id), at: Date.parse(String(row.occurred_at)) };
}

/** The chat of a stored place as its interface describes it, and the other chats of its root. */
function chatsOf(db: Db, placeId: string): { chat: StoredChat; others: Array<StoredChat>; rootPlace: string | null } {
  const row = db.prepare('SELECT * FROM places WHERE id = ?').get(placeId);
  if (!row) throw new Error(`turn-replay: no stored place ${placeId}`);
  const parent = textOr(row.parent_id);
  const rootRow = parent === null ? null : db.prepare('SELECT native_id FROM places WHERE id = ?').get(parent);
  const rootId = textOr(rootRow?.native_id);
  const of = (one: Record<string, unknown>): StoredChat => ({
    id: String(one.native_id),
    kind: one.kind === 'dm' ? 'dm' : one.kind === 'thread' ? 'thread' : 'channel',
    name: textOr(one.name),
    rootId,
    topic: textOr(one.topic),
  });
  const siblings =
    parent === null
      ? []
      : db
          .prepare('SELECT * FROM places WHERE parent_id = ? AND id <> ? AND chat IS NOT NULL AND gone_at IS NULL')
          .all(parent, placeId);
  return { chat: of(row), others: siblings.map(of), rootPlace: parent };
}

/**
 * The custom emoji a root's members used, from the place memory's `emojiUsage` (src/memory/emoji-usage.ts): the stand-in
 * for the root's emoji list, which the interface reads live and memory does not keep.
 */
function usedEmoji(db: Db, rootPlace: string | null): Map<string, string> {
  const names = new Map<string, string>();
  if (rootPlace === null) return names;
  const row = db.prepare("SELECT value FROM operational WHERE kind = 'place' AND owner = ?").get(rootPlace);
  try {
    const usage = (
      JSON.parse(typeof row?.value === 'string' ? row.value : '{}') as {
        emojiUsage?: Record<string, { name?: unknown }>;
      }
    ).emojiUsage;
    for (const [id, entry] of Object.entries(usage ?? {}))
      if (typeof entry?.name === 'string' && entry.name !== '') names.set(id, entry.name);
  } catch {
    // An unreadable place row offers no emoji.
  }
  return names;
}

/** The interface the stored turn ran on, its writes kept, and the chat reference of the turn. */
export type Stage = {
  port: Adapter;
  writes: Array<RecordedWrite>;
  chat: ChatRef;
  rootPlace: string | null;
  rootNative: string | null;
  close: () => void;
};

/** The ports of the stored turn's place (see the head of this file). */
export function stageOf({
  db,
  dataDir,
  turn,
  selfId,
  now,
  tmpDir,
}: {
  db: Db;
  dataDir: string;
  turn: StoredTurn;
  selfId: string;
  now: () => number;
  tmpDir: string;
}): Stage {
  if (turn.triggerId === null) throw new Error(`turn-replay: ${turn.turnId} names no trigger message`);
  if (turn.iface === CLI_IFACE) {
    const through = triggerLine(db, turn.placeId, turn.triggerId);
    const sessionsFile = path.join(tmpDir, 'sessions.json');
    const stored = path.join(dataDir, 'cli', 'sessions.json');
    if (fs.existsSync(stored)) fs.copyFileSync(stored, sessionsFile);
    const sessions = createChatSessions({
      store: createChatStore({ file: sessionsFile, readLines: (placeId) => chatLines(db, placeId) }),
      now,
      newId: randomUUID,
    });
    const shown = (placeId: string): ReadonlyArray<SourceLine> => {
      const lines = sessions.shown(placeId);
      const end = lines.findIndex((line) => line.nativeId === through.nativeId);
      return end < 0 ? lines.filter((line) => line.at <= through.at) : lines.slice(0, end + 1);
    };
    const cli = withStoredHistory(
      createCliChat({ live: () => null, now, newId: randomUUID }),
      shown,
      (placeId) => partnerOf(db, placeId),
      () => ownerConsoleName(db)
    );
    const { port, writes } = recordingPort(cli, now);
    return {
      port,
      writes,
      chat: { iface: CLI_IFACE, chatId: turn.placeId },
      rootPlace: null,
      rootNative: null,
      close: () => {},
    };
  }
  const { chat, others, rootPlace } = chatsOf(db, turn.placeId);
  const emoji = usedEmoji(db, rootPlace);
  const reactions = storedReactions(db, {
    iface: turn.iface,
    chatId: chat.id,
    selfId,
    emojiName: (id) => emoji.get(id) ?? null,
  });
  // The links of a line's text to other messages, as the Discord interface reads them off the text it delivers.
  const refsOf = (text: string) => (turn.iface === 'discord' ? messageRefsOf(text) : []);
  const served = storedChatPort({
    db,
    iface: turn.iface,
    selfId,
    chat,
    others,
    placeId: turn.placeId,
    through: turn.triggerId,
    until: turn.at,
    extrasOf: (line) => ({ reactions: reactions.get(line.messageId) ?? [], messageRefs: refsOf(line.text) }),
    now,
  });
  const rootNative = chat.rootId ?? null;
  if (rootNative !== null)
    served.seedEmoji(
      rootNative,
      [...emoji].map(([id, name]) => ({ id, name, animated: false, url: `https://cdn.discordapp.com/emojis/${id}` }))
    );
  // What the interface declares, which the request reads (its emoji line, its media pick): the Discord adapter's own
  // declaration, read off an adapter with no client. Another interface keeps the fake's.
  const declared = turn.iface === 'discord' ? createDiscordAdapter({}).capabilities() : null;
  const { port: storedPort, writes } = recordingPort(served, now);
  const recorded = declared === null ? storedPort : { ...storedPort, capabilities: () => declared };
  // The command line answers as its own interface, as the core routes it. With no chat open it is the kept chat.
  const cli = recordingPort(createCliChat({ live: () => null, now, newId: randomUUID }), now);
  const empty = createFakeAdapter({ iface: 'none' });
  const port = createIfaceRouter(
    recorded,
    (name) => (name === CLI_IFACE ? cli.port : null),
    () => [recorded, cli.port, empty]
  );
  return {
    port,
    writes,
    chat: { iface: turn.iface, chatId: chat.id },
    rootPlace,
    rootNative,
    close: () => {},
  };
}

/** The trigger line the turn answers, as the pipeline normalizes it: the port's own history event of it. */
export async function triggerOf(stage: Stage, turn: StoredTurn, db: Db): Promise<Record<string, unknown>> {
  const page = await stage.port.history(stage.chat, { limit: 100 });
  const events: Array<MessageEvent> = page.status === 'ok' ? page.events : [];
  const id = turn.triggerId ?? '';
  const nativeId = turn.iface === CLI_IFACE ? triggerLine(db, turn.placeId, id).nativeId : id;
  const event = events.find((one) => one.message.id === id || one.message.id === nativeId);
  if (event === undefined) throw new Error(`turn-replay: the history of ${turn.placeId} lacks the trigger ${id}`);
  return lineOf(event);
}

/** The parameters `runTurn` takes for the stored turn, as the pipeline passes them. */
export function turnParamsOf(
  turn: StoredTurn,
  stage: Stage,
  trigger: Record<string, unknown>,
  memoryContext: unknown
): Record<string, unknown> {
  const triggerKind = turn.triggerKind ?? (turn.iface === CLI_IFACE ? 'private' : 'mention');
  return {
    chat: stage.chat,
    mode: 'reply',
    trigger,
    triggerKind,
    ...(memoryContext !== null ? { memoryContext } : {}),
  };
}
