// Where a post or a reaction of a turn lands and what it carries: the line a model's `reply="#n"` points at, the
// channel a reaction goes to, the line a post about another channel links to, the text with its link, a post's
// arguments for its check. src/behavior/turn.ts asks these while it acts.

import type { Reads } from '../interface/reads.ts';
import { fill } from '../format.ts';
import type { ChatInfo } from '../protocol/adapter.ts';

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
  channel: ChatInfo,
  targetId: string,
  pulledIds: ReadonlyMap<string, string>
): Promise<{
  target: ChatInfo | null;
  source: string | null;
  reason: 'not-found' | 'cannot-react' | null;
}> {
  const source = pulledIds.get(targetId) ?? null;
  if (!source) return { target: channel, source: null, reason: null };
  const live = channel.rootId === null ? null : await reads.chatInfo({ iface: channel.iface, chatId: String(source) });
  const target = live?.chat ?? null;
  if (!target) return { target: null, source, reason: 'not-found' };
  return target.permissions.react ? { target, source, reason: null } : { target: null, source, reason: 'cannot-react' };
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
