// Where a post or a reaction of a turn lands and what it carries: the line a model's `reply="#n"` points at, the
// channel a reaction goes to, the line a post about another channel links to, the text with its link, a post's
// arguments for its check, and the parts a dry-run mirror splits a long text into. src/behavior/turn.js asks these
// while it acts.

import { portLimit } from '../interface/capabilities.ts';
import type { Reads } from '../interface/reads.ts';
import { fill } from '../format.js';
import type { ConversationInfo } from '../protocol/adapter.ts';

/** Display name of the author of `messageId` in `history`, or null when the message is not there. */
export function authorNameFor(
  history: ReadonlyArray<{ id?: string; authorName?: string | null }>,
  messageId: string | null | undefined
): string | null {
  const message = history.find((m) => m.id === messageId);
  return message?.authorName ?? null;
}

/**
 * Where the model's `reply="#n"` points. `replyId`: a line of this chat, which
 * a post may quote as a platform reply. `pulledId`: a line of a pulled channel
 * (`pulledIds`, buildRequest's map of every pulled line to its channel), which
 * a post here never quotes -- the platform resolves a reply reference in the
 * channel posted to -- and links instead (createLinker). A turn that posts
 * plain (postsPlain) quotes no chat line; a pulled line is linked all the
 * same, since a link is not a platform reply.
 */
export function replyTarget(
  replyTo: number | null | undefined,
  {
    plain,
    idByIndex,
    pulledIds,
  }: { plain: boolean; idByIndex: ReadonlyMap<number, string>; pulledIds: ReadonlyMap<string, string> }
): { replyId: string | null; pulledId: string | null } {
  const id = replyTo !== null && replyTo !== undefined ? (idByIndex.get(replyTo) ?? null) : null;
  if (id === null) return { replyId: null, pulledId: null };
  if (pulledIds.has(id)) return { replyId: null, pulledId: id };
  return { replyId: plain ? null : id, pulledId: null };
}

/**
 * Where a reaction on line `targetId` goes: this channel for a chat line; for a pulled line (`pulledIds`) its own
 * channel, as the interface describes it now (`reads`), while the persona may react there
 * (`permissions.react`). A private chat holds no pulled channel to react in. Otherwise `target` is null and `reason`
 * is the code the drop is logged with: `not-found` (the channel is gone) or `cannot-react`. `source` is the pulled
 * channel's id, null for a chat line.
 */
export async function reactionChannel(
  reads: Reads,
  channel: ConversationInfo,
  targetId: string,
  pulledIds: ReadonlyMap<string, string>
): Promise<{
  target: ConversationInfo | null;
  source: string | null;
  reason: 'not-found' | 'cannot-react' | null;
}> {
  const source = pulledIds.get(targetId) ?? null;
  if (!source) return { target: channel, source: null, reason: null };
  const live =
    channel.communityId === null
      ? null
      : await reads.conversationInfo({ iface: channel.iface, conversationId: String(source) });
  const target = live?.conversation ?? null;
  if (!target) return { target: null, source, reason: 'not-found' };
  return target.permissions.react ? { target, source, reason: null } : { target: null, source, reason: 'cannot-react' };
}

/**
 * What the first post of a turn about another channel (`source`) links to
 * when it answers no pulled line: a routed call (in its own channel), else the
 * newest line of the source the request showed (buildRequest's `pulledKept`).
 * Null without a source, or when nothing of it was shown (the budget dropped
 * its block): a post never points at a line the model did not see.
 */
export function sourceLinkTarget({
  source,
  trigger,
  pulledKept,
}: {
  source: { channelId?: string | null; reason?: string | null } | null | undefined;
  trigger: { id?: string | null; channelId?: string | null } | null | undefined;
  pulledKept: ReadonlyArray<{ channelId: string; newestId?: string | null }>;
}): { channelId: string; messageId: string } | null {
  if (!source?.channelId) return null;
  const sourceId = source.channelId;
  if (source.reason === 'routed' && trigger?.id)
    return { channelId: trigger.channelId || sourceId, messageId: trigger.id };
  const newestId = pulledKept.find((shown) => shown.channelId === sourceId)?.newestId ?? null;
  return newestId ? { channelId: sourceId, messageId: newestId } : null;
}

/**
 * `text` with `link` joined through `labels.elsewhere.link` (`{text}` `{link}`);
 * without the label, a newline between them; without a link, `text` as it is.
 * Nothing is cut: an adapter whose platform limits a message splits the post itself.
 */
export function withLink(
  text: string,
  link: string | null | undefined,
  labels: { elsewhere?: { link?: unknown } | null } | null | undefined
): string {
  if (!link) return String(text);
  const template = labels?.elsewhere?.link;
  return typeof template === 'string' && template ? fill(template, { text, link }) : `${text}\n${link}`;
}

/** What a post of the reply carries, for the reader of its check: its text and/or media, the message it replies to. */
export function sendArgs({
  text = null,
  media = null,
  replyId = null,
}: {
  text?: string | null;
  media?: unknown;
  replyId?: string | null;
}): { text?: string; media?: unknown; replyTo?: string } {
  return { ...(text ? { text } : {}), ...(media ? { media } : {}), ...(replyId ? { replyTo: replyId } : {}) };
}

// The characters of one message when the adapter names no limit (`capabilities().maxChars`); the part mark is
// ` (n/m)` on the header plus the newline.
const DEFAULT_MESSAGE_CHARS = 2000;
const MIRROR_PART_MARK_CHARS = 16;

/** The room for the text of one part of a mirrored prompt: a message of `port` less its header and the part mark. */
export const mirrorPartChars = (port: unknown, headerChars: number): number =>
  portLimit(port, 'maxChars', DEFAULT_MESSAGE_CHARS) - headerChars - MIRROR_PART_MARK_CHARS;

/**
 * `text` in pieces of at most `max` code points, each cut at its last newline
 * when there is one, so a dry-run mirror of a long text fits the interface's messages.
 */
export function splitForMirror(text: string | null | undefined, max: number): Array<string> {
  const limit = Math.max(1, Math.floor(max));
  const parts: Array<string> = [];
  let rest = [...String(text ?? '')];
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const newline = window.lastIndexOf('\n');
    const cut = newline > 0 ? newline : limit;
    parts.push(rest.slice(0, cut).join(''));
    rest = rest.slice(newline > 0 ? cut + 1 : cut);
  }
  parts.push(rest.join(''));
  return parts;
}
