// The lines a recall test seeds a fake channel with, and how they read as a raw search hit, as the event the interface
// reads for them and as the neutral hit it answers. Shared by the recall runner's tests.
import type { ConversationInfo, MemberHit, MessageEvent, MessageHit } from '../../src/protocol/adapter.ts';
import { IFACE, message as messageEvent } from './reads-rig.ts';

// How a time becomes the id a platform bounds a search by (what interfaces/discord/reads.ts does with `after` and `before`).
const ID_EPOCH_MS = 1_420_070_400_000;

export const snowflakeAt = (ms: number | undefined): string =>
  ms !== undefined && Number.isFinite(ms) && ms > ID_EPOCH_MS
    ? ((BigInt(Math.floor(ms)) - BigInt(ID_EPOCH_MS)) << 22n).toString()
    : '0';

/** One stored line of a fake channel. */
export type Line = {
  id: string;
  ts: number;
  author: string;
  name: string;
  content: string;
  bot: boolean;
  attachment: { id: string } | null;
};

/** A message as Discord's REST gives it in a search result. */
export type RawHit = {
  id: string;
  channel_id: string;
  timestamp: string;
  content: string;
  author?: { id?: string | null; username?: string | null; global_name?: string | null; bot?: boolean };
};

/** A guild member as Discord's REST gives it in a member search. */
export type RawMember = {
  user?: { id?: string; username?: string | null; global_name?: string | null; bot?: boolean };
  nick?: string | null;
};

/** The body of a message search as Discord's REST gives it. */
export type RawSearch = { messages?: unknown; total_results?: number };

/** One stored line of a fake channel: `{ id, ts, author, content, bot, attachment }`. */
export function line(
  id: string,
  ts: number,
  {
    author = 'u1',
    name = 'Ana',
    content = `line ${id}`,
    bot = false,
    attachment = null,
  }: { author?: string; name?: string; content?: string; bot?: boolean; attachment?: { id: string } | null } = {}
): Line {
  return { id, ts, author, name, content, bot, attachment };
}

/** A raw API search hit of a stored line. */
export function rawHit(channelId: string, l: Line): RawHit {
  return {
    id: l.id,
    channel_id: channelId,
    timestamp: new Date(l.ts).toISOString(),
    author: { id: l.author, username: l.name.toLowerCase(), global_name: l.name, bot: l.bot },
    content: l.content,
  };
}

/** The stored line `l` of conversation `info` as the event the interface reads for it. */
export function eventOfLine(info: ConversationInfo, l: Line): MessageEvent {
  const event = messageEvent(info, l.id, l.ts, l.content, {
    authorId: l.author,
    authorName: l.name,
    bot: l.bot,
  });
  if (event.message.author) event.message.author.self = l.author === 'self';
  if (l.attachment) {
    event.message.attachments = [
      { id: l.attachment.id, kind: 'image', name: 'x.png', url: 'https://cdn.example/x.png', size: 10 },
    ];
  }
  return event;
}

/** A raw API search hit as the neutral hit the interface answers. */
export function neutralHit(hit: RawHit): MessageHit {
  return {
    ref: { iface: IFACE, conversationId: hit.channel_id, messageId: hit.id },
    at: Date.parse(hit.timestamp),
    text: hit.content,
    author: {
      id: hit.author?.id ?? null,
      handle: hit.author?.username ?? null,
      displayName: hit.author?.global_name ?? null,
      bot: hit.author?.bot === true,
    },
  };
}

/**
 * The neutral answer of a message search from the raw body Discord's REST gives: its hits once each, in order, and the
 * total it states (else the number of hits); null for a body without a message list.
 */
export function neutralSearch(body: RawSearch | null | undefined): { total: number; hits: Array<MessageHit> } | null {
  if (!Array.isArray(body?.messages)) return null;
  const seen = new Set<string>();
  const hits: Array<MessageHit> = [];
  for (const group of body.messages as Array<unknown>) {
    for (const raw of (Array.isArray(group) ? group : [group]) as Array<RawHit | null | undefined>) {
      if (!raw?.id || seen.has(raw.id)) continue;
      seen.add(raw.id);
      hits.push(neutralHit(raw));
    }
  }
  return { total: typeof body.total_results === 'number' ? body.total_results : hits.length, hits };
}

/** The neutral answer of a member search from the raw body Discord's REST gives (a list of guild members). */
export function neutralMembers(body: unknown): { members: Array<MemberHit> } {
  return {
    members: (Array.isArray(body) ? (body as Array<RawMember>) : []).flatMap((member) =>
      member.user?.id
        ? [
            {
              id: member.user.id,
              handle: member.user.username ?? null,
              displayName: member.user.global_name ?? null,
              nickname: member.nick ?? null,
              bot: member.user.bot === true,
            },
          ]
        : []
    ),
  };
}
