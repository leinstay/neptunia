// Fetching another conversation for a turn: the pulled block (`<channel_view>`). A turn sometimes needs a conversation
// other than the one it speaks in -- the read-only channel a call came from, a channel someone named with an explicit
// <#id>, or any channel a route hook names -- and without it the persona would be asked about a channel it cannot see.
// The pure decisions live elsewhere: src/behavior/pull.js (the window that ends at the channel's newest message, the
// pictures that may get a caption, the `context.pull` settings) and src/behavior/elsewhere.ts (the ring of calls, the
// audience comparison). This module is the rails and the reads, `fetchPull`, which any caller can use for any
// conversation id of the turn's snapshot: the rails a pull must pass (a readable channel, allowed, not a thread, not the
// dry-run mirror, visible to everyone who can view the conversation the persona speaks in -- in a private chat, to the
// partner), one page of history, the ring's calls marked on their lines, and the captions -- the cache's first, fresh
// ones only for a turn certain to run, in parallel and never waited for past a timeout. A pull made before the turn is
// certain (a chooser can still return `not-now`) gets its fresh captions later from `captionPulled`, without reading
// the conversation again.

import type { ConversationInfo } from '../protocol/adapter.ts';
import type { Reads } from '../interface/reads.ts';
import { log } from '../log.js';
import { MINUTE_MS } from '../time.js';
import { isTooOld, pullPictures, pullSettings, pullWindow } from './pull.js';
import { elsewhereSettings, pingStatus, pingsIn } from './elsewhere.ts';
import { lineOf } from './line-of.js';
import type { Line } from './lines.ts';
import { historyLines } from './lines.ts';
import { audienceAllows, isReadable } from './snapshot.ts';
import type { Snapshot } from './snapshot.ts';

type Config = {
  bot?: { dryRunChannelId?: unknown };
  features?: { mediaDescriptions?: unknown; elsewhere?: unknown; channelPull?: unknown };
} & Record<string, unknown>;

type Timers = { set(fn: () => void, ms: number): unknown; clear(timer: unknown): void };

type Describer = {
  cachedDescriptions?(guildId: string | null, items: ReadonlyArray<object>): Map<string, string> | null | undefined;
  describeMany?(
    guildId: string | null,
    items: ReadonlyArray<object>,
    options: { maxNew: number }
  ): Promise<{ descriptions?: Map<string, string> } | null | undefined>;
};

type Item = { itemId: string };

const DEFAULT_TIMERS: Timers = Object.freeze({
  set: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clear: (timer: unknown) => clearTimeout(timer as NodeJS.Timeout),
});

/** The state of a call of the ring on a shown line. */
type PingState = 'answered' | 'skipped' | 'unanswered';

/**
 * One conversation shown to the persona beside the chat it answers. Consumed by src/behavior/prompt.js (rendering; it
 * finds the newest line shown itself) and src/behavior/turn.js (reactions, which ask the snapshot's `permissions.react`;
 * seen marks); no platform object is inside it.
 */
export type PulledChannel = {
  channelId: string;
  channelName: string | null;
  /** The persona cannot send there. */
  readOnly: boolean;
  /** Why it was pulled. */
  reason: 'routed' | 'noticed' | 'mention' | 'route' | 'recall' | null;
  /** Messages shown, oldest first: the window, the routed trigger when it was outside the window, and the earlier calls. */
  messages: Array<Line>;
  /** Ids among `messages` shown before the window. */
  earlierPingIds: Set<string>;
  /** Older messages of the conversation exist that are not shown. */
  olderNotShown: boolean;
  /** Picture and emoji item id to caption (cached or fresh). */
  descriptions: Map<string, string>;
  /** Pictures of `messages` left without a caption. */
  picturesNotSeen: number;
  /** Message id to the state of its ring call, for every shown line that is a call in the ring except the trigger itself. */
  pingState: Map<string, PingState>;
  /** The last view of this conversation shown in the turn's conversation (createPullViews), attached by the turn. */
  seenBefore?: { hashes: Map<string, string>; oldestTs: number; oldestId: string | null; shownAt: number };
};

type View = { hashes: Map<string, string>; oldestTs: number; oldestId: string | null; shownAt: number };

/**
 * The last view of each pulled conversation shown in each conversation, in process only (no file: it is about the
 * current conversation, and a restart forgets it). Keyed `${destinationId}:${sourceId}`; one view holds each shown
 * line's id with its hash, the oldest window line's time and id (`oldestId`: an earlier page starts before it,
 * `fetchPull`'s `beforeId`) and when it was shown. src/behavior/turn.js reads it before building a turn's request (the
 * PulledChannel's `seenBefore`) and writes it once the request was sent and answered, from buildRequest's
 * `pulledViews`. A view older than the TTL (`context.pull.seenTtlMinutes`, read by the caller at the moment of use) is
 * ignored and pruned.
 */
export function createPullViews(): {
  previous(destinationId: string, sourceId: string, options: { now: number; ttlMinutes: number }): View | null;
  remember(
    destinationId: string,
    views: ReadonlyArray<{
      channelId: string;
      hashes: Map<string, string>;
      oldestTs: number;
      oldestId?: string | number | null;
    }>,
    now: number
  ): void;
  size(): number;
} {
  const views = new Map<string, View>();
  const prune = (now: number, ttlMs: number): void => {
    for (const [key, view] of views) if (now - view.shownAt > ttlMs) views.delete(key);
  };
  return {
    previous(destinationId, sourceId, { now, ttlMinutes }) {
      prune(now, ttlMinutes * MINUTE_MS);
      return views.get(`${destinationId}:${sourceId}`) ?? null;
    },
    remember(destinationId, shown, now) {
      for (const view of shown) {
        if (!view.channelId || !(view.hashes instanceof Map)) continue;
        const oldestId =
          view.oldestId === null || view.oldestId === undefined || view.oldestId === '' ? null : String(view.oldestId);
        views.set(`${destinationId}:${view.channelId}`, {
          hashes: view.hashes,
          oldestTs: view.oldestTs,
          oldestId,
          shownAt: now,
        });
      }
    },
    size: () => views.size,
  };
}

/** A refusal: nothing of the conversation. */
const refused = (skip: string): { channel: null; skip: string } => ({ channel: null, skip });

/**
 * Why `entry` is not one the persona may read, or null when it is. The decision is `isReadable`'s (the one rule every
 * reader obeys, neighbours included); the checks after it only name the refusal, and a refusal none of them names is
 * `not-readable`.
 */
function readableRefusal(entry: ConversationInfo, bot: Config['bot']): string | null {
  if (isReadable(entry, bot)) return null;
  if (entry.kind === 'thread') return 'thread';
  const mirror = bot?.dryRunChannelId;
  if (mirror && entry.id === mirror) return 'dry-run-channel';
  return 'not-readable';
}

/**
 * The rails a pull must pass before anything is read, in this order, each with its kebab-case skip code: a
 * `destination` that is given is a conversation of a community, or a private chat with its `partnerId`
 * (`private-chat` without one, whatever the audience rail says); the id is a conversation of the snapshot
 * (`not-found`); the conversation is one the persona may read (`isReadable`, the rule neighbours obey too), the refusal
 * named `thread`, `dry-run-channel` (`bot.dryRunChannelId`) or else `not-readable`; the audience rail toward
 * `destination` (see `audienceAllows`: in a private chat, the partner's view of it); and its newest message not older
 * than a positive `context.pull.maxAgeDays` (`too-old`; 0, the default, never refuses). No read is made: a route hook
 * or a mention scan can ask it for every candidate id (`pullTargets`' `isPullable`).
 */
export function checkPull({
  snapshot,
  channelId,
  destination = null,
  partnerId = null,
  config,
  now = Date.now(),
}: {
  snapshot: Snapshot | null;
  channelId: string;
  destination?: ConversationInfo | null;
  partnerId?: string | null;
  config: Config;
  now?: number;
}): { channel: ConversationInfo | null; skip: string | null } {
  if (destination && destination.communityId === null && partnerId === null) return refused('private-chat');
  const entry = typeof channelId === 'string' && channelId ? (snapshot?.get(channelId) ?? null) : null;
  if (entry === null) return refused('not-found');
  const unreadable = readableRefusal(entry, config.bot);
  if (unreadable) return refused(unreadable);
  if (!audienceAllows(destination, entry, config, { partnerId })) return refused('audience');
  const last = entry.lastMessageAt ?? 0;
  if (last > 0 && isTooOld(last, { maxAgeDays: pullSettings(config).maxAgeDays, now })) return refused('too-old');
  return { channel: entry, skip: null };
}

type LogIds = { channel: string | null; source: string | null };

const refOf = (entry: ConversationInfo): { iface: string; conversationId: string } => ({
  iface: entry.iface,
  conversationId: entry.id,
});

/**
 * One page of the conversation's history ending at `anchorId` (inclusive) or at its newest message, oldest first;
 * null when the read failed. With `beforeId` (an earlier page) instead: the `limit` messages before that message
 * (exclusive). A failed read is null too and logged.
 */
async function fetchPage(
  reads: Reads,
  entry: ConversationInfo,
  { anchorId, beforeId, limit }: { anchorId: string | null; beforeId: string | null; limit: number },
  age: { maxAgeDays: number; now: number },
  logIds: LogIds
): Promise<{ lines: Array<Line>; anchorTs: number | null } | null> {
  const ref = refOf(entry);
  if (beforeId !== null) {
    try {
      return { lines: await historyLines(reads, ref, { limit, before: beforeId }), anchorTs: null };
    } catch {
      log.warn('pull: earlier page fetch failed', logIds);
      return null;
    }
  }
  if (anchorId === null) {
    try {
      return { lines: await historyLines(reads, ref, { limit }), anchorTs: null };
    } catch {
      log.warn('pull: page unreadable', logIds);
      return null;
    }
  }
  // The page ends at the anchor, the anchor included: the messages before it, then the anchor itself.
  const anchor = await reads.fetchMessages(ref, [anchorId]);
  const event = anchor?.messages[0]?.event;
  if (event === undefined) return anchor === null ? null : { lines: [], anchorTs: Number.NaN };
  const line = lineOf(event) as Line;
  // An anchor too old for the pull reads no page: the caller refuses it from its time.
  if (isTooOld(line.ts, age)) return { lines: [], anchorTs: line.ts };
  try {
    const earlier = await historyLines(reads, ref, { limit: Math.max(1, limit - 1), before: anchorId });
    return { lines: [...earlier, line], anchorTs: line.ts };
  } catch {
    log.warn('pull: page unreadable', logIds);
    return null;
  }
}

/** One message of the pulled conversation by id, as a line: the page's copy when the page holds it (no read), else one read; null when it is gone. */
async function messageById(
  reads: Reads,
  entry: ConversationInfo,
  messageId: string,
  pageById: Map<string, Line>
): Promise<Line | null> {
  const held = pageById.get(messageId);
  if (held !== undefined) return held;
  const found = await reads.fetchMessages(refOf(entry), [messageId]);
  const event = found?.messages[0]?.event;
  return event === undefined ? null : (lineOf(event) as Line);
}

/** Whether `trigger` is a line of conversation `channelId` with an id and a time. */
function isTriggerOf(
  trigger: { id?: unknown; channelId?: unknown; ts?: unknown } | null,
  channelId: string
): trigger is { id: string; channelId: string; ts: number } {
  return (
    typeof trigger?.id === 'string' &&
    trigger.id !== '' &&
    trigger.channelId === channelId &&
    typeof trigger.ts === 'number' &&
    Number.isFinite(trigger.ts)
  );
}

/**
 * Fresh captions for `items`, one single-item describeMany call each, all at once, waited for at most `timeoutMs` (an
 * unref'd timer). A caption that arrives later is not used now (its request is not cancelled: the describer still caches
 * it for the next turn). A request that fails is logged (`pull: caption failed`) and counts as answered, not late; the
 * others are kept. Every request counts against `llm.maxRequestsPerDay`.
 */
async function freshCaptions({
  describer,
  guildId,
  items,
  timeoutMs,
  timers,
  logIds,
}: {
  describer: Describer;
  guildId: string | null;
  items: ReadonlyArray<Item>;
  timeoutMs: number;
  timers: Timers;
  logIds: LogIds;
}): Promise<{ got: Map<string, string>; late: number }> {
  const got = new Map<string, string>();
  if (items.length === 0) return { got, late: 0 };
  let open = true;
  let settled = 0;
  const requests = items.map(async (item) => {
    try {
      const result = await describer.describeMany?.(guildId, [item], { maxNew: 1 });
      const text = result?.descriptions?.get(item.itemId);
      if (open && typeof text === 'string' && text) got.set(item.itemId, text);
    } catch (err) {
      log.warn('pull: caption failed', { ...logIds, error: err });
    } finally {
      if (open) settled += 1;
    }
  });
  let timer: unknown;
  const timedOut = new Promise<void>((resolve) => {
    timer = timers.set(resolve, timeoutMs);
    (timer as { unref?: () => void } | undefined)?.unref?.();
  });
  await Promise.race([Promise.all(requests), timedOut]);
  open = false;
  timers.clear(timer);
  return { got, late: items.length - settled };
}

type Captions = {
  descriptions: Map<string, string>;
  pictures: number;
  captioned: number;
  notSeen: number;
  asked: number;
  fresh: number;
  late: number;
};

/**
 * The captions of a pulled conversation's lines, `known` (captions it already has) kept. Only with
 * `features.mediaDescriptions` true and a describer: the cache's for every picture and custom emoji not known yet, free;
 * then, with `requestFresh`, fresh ones (freshCaptions) for the pictures still uncaptioned among the first
 * `context.pull.maxPictures` (newest first), at most `maxNewDescriptions`. A picture whose caption failed within the
 * last hour (the describer's miss memory, which the cache does not report) is asked like any other: it takes one of
 * those slots and sends no request. Custom emoji are never pictures: no fresh caption, never counted.
 */
async function pullCaptions(
  messages: ReadonlyArray<Line>,
  {
    describer,
    guildId,
    config,
    requestFresh,
    timers,
    known = null,
    logIds,
  }: {
    describer: Describer | null;
    guildId: string | null;
    config: Config;
    requestFresh: boolean;
    timers: Timers;
    known?: Map<string, string> | null;
    logIds: LogIds;
  }
): Promise<Captions> {
  const settings = pullSettings(config);
  const { items, rest, emoji } = pullPictures(messages as Array<object>, settings.maxPictures) as unknown as {
    items: Array<Item>;
    rest: Array<Item>;
    emoji: Array<Item>;
  };
  const pictures = [...items, ...rest];
  const descriptions = new Map<string, string>(known instanceof Map ? known : []);
  let asked = 0;
  let fresh = 0;
  let late = 0;
  if (config.features?.mediaDescriptions === true && describer) {
    const unknown = [...pictures, ...emoji].filter((item) => !descriptions.has(item.itemId));
    if (unknown.length > 0 && typeof describer.cachedDescriptions === 'function') {
      for (const [id, text] of describer.cachedDescriptions(guildId, unknown) ?? []) descriptions.set(id, text);
    }
    if (requestFresh && typeof describer.describeMany === 'function') {
      const uncached = items.filter((item) => !descriptions.has(item.itemId)).slice(0, settings.maxNewDescriptions);
      asked = uncached.length;
      const result = await freshCaptions({
        describer,
        guildId,
        items: uncached,
        timeoutMs: settings.describeTimeoutMs,
        timers,
        logIds,
      });
      for (const [id, text] of result.got) descriptions.set(id, text);
      fresh = result.got.size;
      late = result.late;
    }
  }
  const captioned = pictures.filter((item) => descriptions.has(item.itemId)).length;
  return {
    descriptions,
    pictures: pictures.length,
    captioned,
    notSeen: pictures.length - captioned,
    asked,
    fresh,
    late,
  };
}

/** The caption counts of a `pull:` log line (pullCaptions' result); never a caption. */
function captionCounts(captions: Captions): Record<string, number> {
  return {
    pictures: captions.pictures,
    cached: captions.captioned - captions.fresh,
    asked: captions.asked,
    fresh: captions.fresh,
    late: captions.late,
    notSeen: captions.notSeen,
  };
}

/**
 * Fresh captions for a conversation already pulled (a PulledChannel from `fetchPull` without `turnCertain`), once the
 * turn is certain to run: no read of the conversation, the same lines and window. The cache is asked again for the
 * pictures and custom emoji still without a caption (the prefill may have cached some meanwhile), then fresh captions
 * are requested for the uncached pictures among the first `context.pull.maxPictures`, at most `maxNewDescriptions`, in
 * parallel, waited for at most `describeTimeoutMs` (a late one renders blind this turn), exactly as `fetchPull` with
 * `turnCertain` does; see pullCaptions. Only with `features.mediaDescriptions` true and a describer. Returns a new
 * record with `descriptions` merged and `picturesNotSeen` recomputed; the given one is not changed. Logs `pull:
 * captions` (`channel`, `source`, `pullReason`, the caption counts, ms).
 */
export async function captionPulled(
  pulled: PulledChannel,
  {
    describer = null,
    guildId = null,
    config,
    destination = null,
    timers = DEFAULT_TIMERS,
  }: {
    describer?: Describer | null;
    guildId?: string | null;
    config: Config;
    destination?: { id: string } | null;
    timers?: Timers;
  }
): Promise<PulledChannel> {
  if (!Array.isArray(pulled.messages)) return pulled;
  const started = Date.now();
  const logIds: LogIds = { channel: destination?.id ?? null, source: pulled.channelId };
  const captions = await pullCaptions(pulled.messages, {
    describer,
    guildId,
    config,
    requestFresh: true,
    timers,
    known: pulled.descriptions,
    logIds,
  });
  log.info('pull: captions', {
    ...logIds,
    pullReason: pulled.reason ?? null,
    ...captionCounts(captions),
    ms: Date.now() - started,
  });
  return { ...pulled, descriptions: captions.descriptions, picturesNotSeen: captions.notSeen };
}

/** What a pull shows: the lines, their ids, the ones shown before the window, and where the window starts. */
type Shown = { lines: Array<Line>; ids: Set<string>; beforeWindow: Set<string>; windowStart: number };

/** Adds a line to what is shown, once; `early` puts it before the window. */
function addShown(shown: Shown, line: Line, early: boolean): void {
  shown.lines.push(line);
  shown.ids.add(line.id);
  if (early) shown.beforeWindow.add(line.id);
}

/** Adds the ring's earlier calls that were read, before the window; how many were added. */
function addRingCalls(shown: Shown, read: ReadonlyArray<Line | null>): number {
  let added = 0;
  for (const message of read) {
    if (!message || !Number.isFinite(message.ts) || message.ts >= shown.windowStart || shown.ids.has(message.id))
      continue;
    addShown(shown, message, true);
    added += 1;
  }
  return added;
}

type Ring = { messageId: string; channelId: string; ts: number; answeredAt?: number; skippedAt?: number };

type Opened = {
  page: Array<Line>;
  anchorTs: number | null;
  before: string | null;
  earlierPull: boolean;
  window: ReturnType<typeof pullWindow>;
};

/**
 * One page of the conversation (ending at the anchor, before the oldest line of the last view, or the newest) cut to
 * the window; a skip code when the anchor is unknown or too old, the page unreadable or empty.
 */
async function openPage({
  reads,
  channel,
  anchorId,
  direction,
  beforeId,
  config,
  nowMs,
  logIds,
}: {
  reads: Reads;
  channel: ConversationInfo;
  anchorId: string | null;
  direction: 'earlier' | null;
  beforeId: string | null;
  config: Config;
  nowMs: number;
  logIds: LogIds;
}): Promise<Opened | { skip: string }> {
  const settings = pullSettings(config);
  const anchor = anchorId !== null && anchorId !== '' ? String(anchorId) : null;
  const limit = Math.min(100, Math.max(settings.maxMessages, settings.minMessages) + 1);
  const earlierPull = direction === 'earlier';
  const before = earlierPull && anchor === null && typeof beforeId === 'string' && beforeId !== '' ? beforeId : null;
  const age = { maxAgeDays: settings.maxAgeDays, now: nowMs };
  const fetched = await fetchPage(reads, channel, { anchorId: anchor, beforeId: before, limit }, age, logIds);
  if (fetched === null) return { skip: 'fetch-failed' };
  if (anchor !== null && !Number.isFinite(fetched.anchorTs)) return { skip: 'not-found' };
  const anchorTs = anchor === null ? null : fetched.anchorTs;
  if (anchorTs !== null && isTooOld(anchorTs, age)) return { skip: 'too-old' };
  const page = fetched.lines;
  const window = pullWindow(page, {
    anchorTs,
    windowMinutes: settings.windowMinutes,
    minMessages: settings.minMessages,
    maxMessages: settings.maxMessages,
    pageFull: page.length >= limit,
    ...age,
  });
  if (window.skip) return { skip: window.skip };
  return { page, anchorTs, before, earlierPull, window };
}

/**
 * The lines a pull shows: the window, the routed trigger as the conversation holds it now (a deleted one is
 * `trigger-gone`) and the ring's unanswered calls older than the window, each taken from the page or read by id.
 */
async function gatherShown({
  reads,
  channel,
  opened,
  trigger,
  pings,
  config,
  nowMs,
}: {
  reads: Reads;
  channel: ConversationInfo;
  opened: Opened;
  trigger: { id?: unknown; channelId?: unknown; ts?: unknown } | null;
  pings: ReadonlyArray<Ring>;
  config: Config;
  nowMs: number;
}): Promise<
  | { skip: string }
  | {
      shown: Shown;
      ring: ReturnType<typeof pingsIn>;
      earlier: number;
      wanted: Array<unknown>;
      triggerId: string | null;
    }
> {
  const { page, anchorTs, before, window } = opened;
  const windowLines = window.messages as Array<Line>;
  const shown: Shown = {
    lines: [...windowLines],
    ids: new Set(windowLines.map((line) => line.id)),
    beforeWindow: new Set<string>(),
    windowStart: windowLines[0].ts,
  };
  const pageById = new Map(page.map((line) => [line.id, line]));
  const byId = (messageId: string): Promise<Line | null> => messageById(reads, channel, messageId, pageById);
  const triggerId = isTriggerOf(trigger, channel.id) ? trigger.id : null;
  if (isTriggerOf(trigger, channel.id) && !shown.ids.has(trigger.id)) {
    // The page's span: from its oldest message to the anchor, the earlier page's newest one, or now.
    const pageEnd = anchorTs ?? (before !== null ? (page.at(-1) as Line).ts : null);
    const deleted = !pageById.has(trigger.id) && trigger.ts > page[0].ts && (pageEnd === null || trigger.ts <= pageEnd);
    const line = deleted ? null : await byId(trigger.id);
    if (!line) return { skip: 'trigger-gone' };
    addShown(shown, line, line.ts < shown.windowStart);
  }
  const ring = pingsIn(pings, channel.id, { now: nowMs, maxAgeMs: elsewhereSettings(config).pingMaxAgeMs });
  const wanted = ring.filter(
    (entry) =>
      pingStatus(entry) === 'unanswered' &&
      entry.messageId !== triggerId &&
      !shown.ids.has(entry.messageId) &&
      entry.ts < shown.windowStart
  );
  const earlier = addRingCalls(shown, await Promise.all(wanted.map((entry) => byId(entry.messageId))));
  shown.lines.sort((a, b) => a.ts - b.ts);
  return { shown, ring, earlier, wanted, triggerId };
}

/**
 * Read one conversation for a turn's `<channel_view>`: the hook any caller uses for any conversation id (a routed
 * call's source, a noticed comment's source, an explicit `<#id>`, a route hook's id, a recall's anchor).
 *
 * The rails of `checkPull` come first; a refusal returns its code and reads nothing. Then one page of history
 * (`min(100, max(maxMessages, minMessages) + 1)` messages ending at `anchorId` inclusive, else at the newest message)
 * is cut by pullWindow: the window ends at that message whatever its age. More skip codes: `not-found` for an anchor
 * the interface does not know, `too-old` for an anchor older than a positive `maxAgeDays`, `fetch-failed` when the page
 * could not be read, `empty` when nothing is at or before the anchor, `trigger-gone` when the `trigger` no longer
 * exists.
 *
 * The `trigger` (a line of this conversation, a routed call; a trigger of another conversation is ignored) is always
 * shown, as the conversation holds it now: the page's copy (its reactions, its edited text) when the page holds it;
 * when the page lacks it although its time falls inside the page's span it was deleted (`trigger-gone`); otherwise
 * (older than the page, or newer than an explicit anchor) it is read by id, and `trigger-gone` when that finds nothing.
 * A trigger outside the window and older than it is listed in `earlierPingIds` (shown before the window, so the
 * window's span stays what it is); one newer than an explicit anchor follows the window. The ring's unanswered calls of
 * this conversation older than the window are added too (`earlierPingIds`; each taken from the page or read by id,
 * dropped when gone). `pingState` marks every shown line that is a call of the ring, by id, with its state (answered,
 * skipped by choice, or unanswered); the trigger itself carries no mark.
 *
 * Captions (see pullCaptions): the cache's for every picture and custom emoji of the shown lines, free; then, only when
 * `turnCertain` is true, fresh ones for the uncached pictures among the first `context.pull.maxPictures`, at most
 * `maxNewDescriptions`, in parallel, waited for at most `describeTimeoutMs`; a late one renders blind this turn. A pull
 * made before the turn is certain gets them later from `captionPulled`. Pictures left without a caption are counted in
 * `picturesNotSeen`.
 *
 * With `direction: 'earlier'` and a `beforeId` (the oldest window line of the last view of this conversation shown in
 * the destination, createPullViews), the page is the one before that message instead of the newest one; the window then
 * ends at that page's newest message. `earlier` without a `beforeId` pulls the newest page (`pullDirection:
 * 'earlier-no-previous'` in the log); a `beforeId` without `earlier` is ignored. An anchor wins over both.
 *
 * Logs `pull: channel` or `pull: skipped` with ids and counts, never message text or captions. Settings are read from
 * `config` (the caller's live config) at the call.
 */
export async function fetchPull({
  reads,
  snapshot,
  guildId = null,
  channelId,
  destination = null,
  partnerId = null,
  reason = null,
  anchorId = null,
  direction = null,
  beforeId = null,
  trigger = null,
  pings = [],
  config,
  now = Date.now(),
  describer = null,
  turnCertain = false,
  timers = DEFAULT_TIMERS,
}: {
  reads: Reads;
  snapshot: Snapshot | null;
  guildId?: string | null;
  channelId: string;
  destination?: ConversationInfo | null;
  partnerId?: string | null;
  reason?: PulledChannel['reason'];
  anchorId?: string | null;
  direction?: 'earlier' | null;
  beforeId?: string | null;
  trigger?: { id?: unknown; channelId?: unknown; ts?: unknown } | null;
  pings?: ReadonlyArray<Ring>;
  config: Config;
  now?: number;
  describer?: Describer | null;
  turnCertain?: boolean;
  timers?: Timers;
}): Promise<{ pulled: PulledChannel | null; skip: string | null }> {
  const started = Date.now();
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const logIds: LogIds = { channel: destination?.id ?? null, source: typeof channelId === 'string' ? channelId : null };
  const skipWith = (skip: string): { pulled: null; skip: string } => {
    log.info('pull: skipped', { ...logIds, reason: skip, pullReason: reason });
    return { pulled: null, skip };
  };

  const checked = checkPull({ snapshot, channelId, destination, partnerId, config, now: nowMs });
  if (checked.skip !== null || checked.channel === null) return skipWith(checked.skip ?? 'not-found');
  const channel = checked.channel;

  const opened = await openPage({ reads, channel, anchorId, direction, beforeId, config, nowMs, logIds });
  if ('skip' in opened) return skipWith(opened.skip);
  const { window, earlierPull, before } = opened;
  const gathered = await gatherShown({ reads, channel, opened, trigger, pings, config, nowMs });
  if ('skip' in gathered) return skipWith(gathered.skip);
  const { shown, ring, earlier, wanted, triggerId } = gathered;

  const pingState = new Map<string, PingState>();
  for (const entry of ring) {
    if (entry.messageId === triggerId || !shown.ids.has(entry.messageId)) continue;
    pingState.set(entry.messageId, pingStatus(entry));
  }

  // Captions: the cache's for every picture and emoji, fresh ones only for a turn certain to run.
  const captions = await pullCaptions(shown.lines, {
    describer,
    guildId,
    config,
    requestFresh: turnCertain === true,
    timers,
    logIds,
  });

  const pulled: PulledChannel = {
    channelId: channel.id,
    channelName: channel.name ?? null,
    readOnly: !channel.permissions.send,
    reason,
    messages: shown.lines,
    earlierPingIds: shown.beforeWindow,
    olderNotShown: window.olderNotShown,
    descriptions: captions.descriptions,
    picturesNotSeen: captions.notSeen,
    pingState,
  };
  log.info('pull: channel', {
    ...logIds,
    pullReason: reason,
    direction: earlierPull ? 'earlier' : null,
    ...(earlierPull ? { beforeId: before !== null } : {}),
    ...(earlierPull && before === null ? { pullDirection: 'earlier-no-previous' } : {}),
    messages: shown.lines.length,
    earlier,
    earlierGone: wanted.length - earlier,
    olderNotShown: window.olderNotShown,
    ...captionCounts(captions),
    pings: pingState.size,
    ms: Date.now() - started,
  });
  return { pulled, skip: null };
}
