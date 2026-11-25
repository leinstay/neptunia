// The steps of a multi-step skill scenario (scripts/lib/replay-skills.ts): the burst of a step played as the live
// queue plays it (`burstTurns`, over src/behavior/pending.ts), a line of the persona the scenario seeds (`seededSelfLine`),
// and what a turn leaves in the scenario's channel for the next one (`carriedLines`): the persona's sent messages as their lines
// and their reactions on the lines they name, read off the writes the turn's port recorded.

import { detectTrigger } from '../../src/behavior/mention.ts';
import { addPending, followUpSlot, popOldest } from '../../src/behavior/pending.ts';
import type { PendingPing } from '../../src/behavior/pending.ts';
import type { Line } from '../../src/behavior/lines.ts';
import { MAX_MESSAGE_CHARS } from '../../src/format.ts';
import { clampChars, oneLine } from '../../src/memory/clamp.ts';
import { tokenIds } from '../../src/memory/mentions.ts';
import type { Untyped } from '../../src/tools/types.ts';
import type { RecordedWrite } from './turn-port.ts';

/** A line of the persona a scenario seeds: its text, its time, their account and the channel. */
export type SeededSelfLineInput = {
  text: string;
  at: number;
  selfId: string;
  selfName: string;
  channel: { id: string };
};

/** A call waiting for its own turn as src/pipeline/pending-queue.ts#queuedFor lists it. */
export type QueuedCall = { id: string; text: string; author?: string };

/** The turns a step's burst gets, in order, with the calls each finds waiting, and what the queue replaced or dropped. */
export type BurstTurnsResult = {
  turns: Array<{
    line: Record<string, Untyped>;
    kind: PendingPing['kind'];
    queued: Array<QueuedCall>;
  }>;
  replaced: Array<{ id: string; by: string }>;
  dropped: Array<{ id: string; reason: string }>;
};

/** The list fields of a normalized message (src/protocol/events.ts#Message), empty on a line built here. */
const EMPTY_LINE_LISTS = Object.freeze([
  'mentionedAccountIds',
  'mentionedChannelIds',
  'attachments',
  'links',
  'forwarded',
  'stickers',
  'emojis',
  'reactions',
]);

/** The persona's line as one of their turns leaves it in the chat: `selfName` as its author, the fields a line built here lacks empty. */
function ownLine(line: Record<string, Untyped>, selfName: string): Line {
  const out: Record<string, Untyped> = {
    channelName: null,
    authorName: selfName,
    bot: false,
    replyToId: null,
    replyPingAccountId: null,
    forwardedFrom: null,
    ...line,
    self: true,
  };
  for (const key of EMPTY_LINE_LISTS) if (!Array.isArray(out[key])) out[key] = [];
  return out as Line;
}

/** Discord's epoch, the start of a snowflake's milliseconds. */
const DISCORD_EPOCH = 1420070400000n;

/**
 * The id of the `seq`-th line of the persona at `ts`: a Discord snowflake of that moment with `seq` in its low bits, so it
 * sorts among the platform's ids by moment and never meets a scenario message's id, whose low bits are 0.
 */
function ownLineId(ts: number, seq: number): string {
  return String(((BigInt(Math.floor(ts)) - DISCORD_EPOCH) << 22n) + BigInt(seq));
}

/**
 * A line of the persona's seeded into a skill scenario (scripts/replay.ts `--skills`, a step
 * `{ self }` or a burst item `{ self: true }`): `text` as if the persona had said it at `at` in
 * `channel`, no turn run for it. Shaped as their lines carried from a turn (ownLine, `selfName` as author; its id a
 * snowflake of its moment), the text as given with `mentionedAccountIds` the members its `<@id>` tags name
 * (src/memory/mentions.ts#tokenIds) -- and, since no turn posted it, no link to a trigger and no
 * call mark. Pure.
 */
export function seededSelfLine({ text, at, selfId, selfName, channel }: SeededSelfLineInput): Line {
  const content = String(text ?? '');
  const line = {
    id: ownLineId(at, 1),
    placeId: String(channel.id),
    ts: at,
    authorId: String(selfId),
    content,
    mentionedAccountIds: tokenIds(content),
    replyToId: null,
  };
  return ownLine(line, selfName);
}

/** The pending queue's cap when `mention.maxPending` is not set (config.json's value). */
const MAX_PENDING = 6;

/**
 * The turns one step of a skill scenario gets when its messages (`incoming`, normalized lines in
 * arrival order, all of one channel) come in a burst, as the live queue gives them
 * (src/behavior/pipeline.ts, src/behavior/pending.ts). How each message calls the persona is read as the
 * live pipeline reads it (src/behavior/mention.ts#detectTrigger:
 * a tag of theirs among `mentionedAccountIds`, a reply to a line of theirs in `history` or the burst); a message that
 * does not call them is a
 * follow-up the address classifier said `yes` to (it is never asked here). The first message finds
 * their attention free and starts a turn; the rest come in while that turn runs: a call waits in the
 * queue (addPending, `mention.maxPending` the cap: the oldest waiting entry is `dropped`, reason
 * `full`), a follow-up takes the channel's one follow-up slot (followUpSlot: a newer one takes an
 * older one's place, which is `replaced` -- live, a missed-answer candidate -- by the newer's id).
 * The queue is then drained oldest first (popOldest), each entry its own turn. Each turn's
 * `queued` is what still waits besides it, arrival order, as src/pipeline/pending-queue.ts#queuedFor lists
 * it: the trigger author's own as `{ id, text }`, another member's as `{ id, text, author }`
 * (their display name), the text on one line cut to `MAX_MESSAGE_CHARS`. Not modelled: the
 * address classifier, the per-author rail, the merge classifier folding a call into an earlier one, a follow-up's window and
 * staleness checks. Pure; nothing handed in is changed.
 */
export function burstTurns(
  incoming: Array<Untyped>,
  { selfId, config, history = [] }: { selfId: string; config: Record<string, Untyped>; history?: Array<Line> }
): BurstTurnsResult {
  const lines = (Array.isArray(incoming) ? incoming : []).filter(Boolean);
  if (lines.length === 0) return { turns: [], replaced: [], dropped: [] };
  const self = String(selfId);
  const selfLines = new Set(
    [...(Array.isArray(history) ? history : []), ...lines].filter((line) => line?.self === true).map((line) => line.id)
  );
  const kindOf = (line: Untyped) =>
    detectTrigger({
      mentionsSelf: (line.mentionedAccountIds ?? []).includes(self),
      repliesToSelf: Boolean(line.replyToId) && selfLines.has(line.replyToId),
    }) ?? 'followUp';
  const maxPending = config?.mention?.maxPending ?? MAX_PENDING;
  const maxChars = MAX_MESSAGE_CHARS;
  const [first, ...rest] = lines;
  let pending: Array<PendingPing> = [];
  const replaced: Array<{ id: string; by: string }> = [];
  const dropped: Array<{ id: string; reason: string }> = [];
  for (const line of rest) {
    const kind = kindOf(line);
    const placeId = String(line.placeId ?? '');
    const slot = followUpSlot(pending, placeId, kind);
    if (!slot.admit) continue;
    const displaced = slot.replaced;
    if (displaced) {
      pending = pending.filter((ping) => ping !== displaced);
      replaced.push({ id: displaced.trigger.id, by: line.id });
    }
    const { list, evicted } = addPending(
      pending,
      { placeId, trigger: line, kind, arrivedAt: Number(line.ts) || 0 },
      maxPending
    );
    pending = list;
    if (evicted) dropped.push({ id: evicted.trigger.id, reason: 'full' });
  }
  const queuedFor = (trigger: Untyped) =>
    pending
      .filter((ping) => ping.kind !== 'overheard' && ping.trigger.id !== trigger.id)
      .sort((a, b) => a.arrivedAt - b.arrivedAt)
      .map((ping) => ({
        id: ping.trigger.id,
        text: clampChars(oneLine(ping.trigger.content), maxChars),
        ...(ping.trigger.authorId === trigger.authorId ? {} : { author: oneLine(ping.trigger.authorName ?? '') }),
      }));
  const turns: Array<{
    line: Record<string, Untyped>;
    kind: PendingPing['kind'];
    queued: Array<QueuedCall>;
  }> = [{ line: first, kind: kindOf(first), queued: queuedFor(first) }];
  while (pending.length > 0) {
    const next = popOldest(pending);
    pending = next.list;
    if (next.ping === null) break;
    turns.push({ line: next.ping.trigger, kind: next.ping.kind, queued: queuedFor(next.ping.trigger) });
  }
  return { turns, replaced, dropped };
}

/** `line` with the persona's reaction `emoji` on it, counted once. */
function withOwnReaction(line: Record<string, Untyped>, emoji: string): Record<string, Untyped> {
  const reactions: Array<Record<string, Untyped>> = Array.isArray(line.reactions) ? line.reactions : [];
  const same = reactions.find((reaction) => reaction?.emoji === emoji);
  if (same?.mine) return line;
  const next = same
    ? reactions.map((reaction) =>
        reaction === same ? { ...reaction, count: (Number(reaction.count) || 0) + 1, mine: true } : reaction
      )
    : [...reactions, { emoji, count: 1, mine: true }];
  return { ...line, reactions: next };
}

/**
 * The scenario's channel after a turn at `at`: `lines` with the persona's messages the turn sent into `channel` as their lines
 * (ownLine, at the turn's moment in the order they went out) and their reactions on the lines they name. A send or a reaction elsewhere leaves the channel as it was. Pure.
 */
export function carriedLines({
  lines,
  writes,
  at,
  channel,
  selfId,
  selfName,
}: {
  lines: ReadonlyArray<Record<string, Untyped>>;
  writes: ReadonlyArray<RecordedWrite>;
  at: number;
  channel: { id: string };
  selfId: string;
  selfName: string;
}): Array<Record<string, Untyped>> {
  let out = [...lines];
  let sent = 0;
  for (const write of writes) {
    const [ref, value] = write.args as [Record<string, Untyped>, Untyped];
    if (write.op === 'send' && String(ref?.chatId) === String(channel.id)) {
      const text = typeof value?.text === 'string' ? value.text : '';
      sent += 1;
      out.push(
        ownLine(
          {
            id: ownLineId(at, sent),
            placeId: String(channel.id),
            ts: at,
            authorId: String(selfId),
            content: text,
            mentionedAccountIds: tokenIds(text),
            replyToId: null,
          },
          selfName
        )
      );
    }
    if (write.op === 'react' && String(ref?.chatId) === String(channel.id) && typeof value === 'string')
      out = out.map((line) => (line.id === ref.messageId ? withOwnReaction(line, value) : line));
  }
  return out;
}

/**
 * The parameters of a reply turn of a scenario: its trigger and kind, and the calls still waiting after it as the live
 * drain hands them to `runTurn` (src/pipeline/pending-queue.ts#queuedFor), a function that lists them.
 */
export function replyParams(
  trigger: Record<string, unknown>,
  kind: string,
  queued: ReadonlyArray<QueuedCall>
): { mode: 'reply'; trigger: Record<string, unknown>; triggerKind: string; queued?: () => typeof queued } {
  return { mode: 'reply', trigger, triggerKind: kind, ...(queued.length > 0 ? { queued: () => queued } : {}) };
}
