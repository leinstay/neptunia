// The other channels a turn's request shows: `<channel_view>`, another channel pulled into the turn, with its lines
// numbered on after the chat's, its call marks and its line against the last view of it, each channel cut to its
// share of the room. It also names the authors in view, who get the mention handles. buildRequest
// (src/behavior/prompt.js) calls them.

import { createHash } from 'node:crypto';
import { fill, formatDate, formatDuration, formatTranscript, reactorIdsOf } from '../../format.js';
import { fitSections } from '../../llm/budget.js';
import { pulledMoment } from './text.ts';
import type { Base, Room } from './head.ts';
import type { HeadSections } from './sections.ts';
import type { Cost, Fit, FormatOptions, Labels, Message, RequestInput, Section, TranscriptItem } from './types.ts';

/**
 * Another channel shown to a turn: the record src/behavior/pull-fetch.ts#fetchPull
 * returns (the one definition), read here and never changed. This module reads
 * it a little more loosely than the producer writes it: `earlierPingIds` may
 * also be an array, `channelName` null falls back to the channel id, and a
 * missing `descriptions`, `olderNotShown`, `picturesNotSeen`, `earlierPingIds`
 * or `pingState` reads as empty.
 */
export type PulledEntry = {
  readonly channelId?: unknown;
  readonly channelName?: string | null;
  readonly readOnly?: boolean;
  readonly messages?: Array<Message | null | undefined>;
  readonly earlierPingIds?: unknown;
  readonly olderNotShown?: unknown;
  readonly descriptions?: unknown;
  readonly picturesNotSeen?: unknown;
  readonly pingState?: unknown;
  readonly seenBefore?: unknown;
};

/** A pulled channel a request can show: its record, its id, its name and its messages, each once, oldest first. */
export type UsablePulled = { entry: PulledEntry; channelId: string; name: string; messages: Array<Message> };

/** A usable pulled channel with its transcript items and the ids of its earlier calls. */
export type PulledSet = UsablePulled & { items: Array<TranscriptItem>; earlierIds: Set<string> };

/** One pulled channel as its `<channel_view>` item, with what of it is shown. */
export type PulledFit = {
  text: string;
  ids: Array<string>;
  newestId: string;
  newestTs: number;
  hashes: Map<string, string | undefined>;
  oldestTs: number;
  oldestId: string;
  seen: { fresh: number; older: number } | null;
};

/** Ids as strings, from a Set or an array; anything else is empty. */
function idSet(value: unknown): Set<string> {
  const list: Array<unknown> = value instanceof Set ? [...(value as Set<unknown>)] : Array.isArray(value) ? value : [];
  return new Set(list.map(String));
}

/** The state of message `id` in a pulled channel's `pingState` (a Map), or null. */
function pingStateOf(pingState: unknown, id: unknown): string | null {
  const state: unknown = pingState instanceof Map ? (pingState as Map<string, unknown>).get(String(id)) : null;
  return typeof state === 'string' ? state : null;
}

/**
 * The ids of the members who wrote the lines a request may show -- `history`, then every
 * `messages` list of each of `sources` (the pulled channels, the neighbours) -- never the
 * persona's own lines or a bot's, each once (src/behavior/handles.js#assignHandles' `inView`);
 * the members named as reactors on her lines of `history` too.
 * `sources` are lists of `{ messages }` entries; anything else is skipped.
 */
export function authorsInView(history: Array<Message>, sources: Array<unknown>): Array<string> {
  const ids = new Set<string>();
  const add = (messages: unknown) => {
    // A source's messages as given, read loosely like any list of lines.
    for (const message of Array.isArray(messages) ? (messages as Array<Message | null | undefined>) : []) {
      if (!message || message.self || message.bot || message.authorId === undefined || message.authorId === null)
        continue;
      ids.add(String(message.authorId));
    }
  };
  add(history);
  // The members who reacted to the persona's lines are named on them like authors (reactorIdsOf).
  for (const id of reactorIdsOf(history)) ids.add(id);
  for (const source of sources)
    for (const entry of Array.isArray(source) ? (source as Array<{ messages?: unknown } | null | undefined>) : [])
      add(entry?.messages);
  return [...ids];
}

/**
 * The pulled channels a request can show: entries with a channel id and at
 * least one message with an id and a time, one per channel (the first wins),
 * never the turn's own channel; each message once, oldest first.
 */
export function usablePulled(pulled: unknown, currentChannelId: string | null): Array<UsablePulled> {
  const out: Array<UsablePulled> = [];
  const seen = new Set<string>();
  // The `pulled` input as given, read loosely: entries without a usable channel or message are skipped.
  for (const entry of Array.isArray(pulled) ? (pulled as Array<PulledEntry | null | undefined>) : []) {
    const channelId = typeof entry?.channelId === 'string' ? entry.channelId : '';
    if (!channelId || seen.has(channelId) || channelId === currentChannelId) continue;
    const byId = new Map<string, Message>();
    for (const message of Array.isArray(entry?.messages) ? entry.messages : []) {
      if (!message || message.id === undefined || message.id === null || !Number.isFinite(message.ts)) continue;
      if (!byId.has(message.id)) byId.set(message.id, message);
    }
    if (byId.size === 0) continue;
    seen.add(channelId);
    const messages = [...byId.values()].sort((a, b) => a.ts - b.ts);
    out.push({ entry: entry!, channelId, name: entry?.channelName || channelId, messages });
  }
  return out;
}

/**
 * Every pulled channel's transcript items: ordinary chat lines
 * (`formatOptions`, so `context.maxMessageChars`), numbered on from
 * `firstIndex` and on again after each earlier channel, with the channel's own
 * captions joined to the turn's and NO attachment marker (nothing of another
 * channel is attached). A line that called the persona gets
 * `labels.pull.pingAnswered` / `pingUnanswered` / `pingSkipped` after one
 * space, by its `pingState` -- never the turn's trigger, and a state without
 * its label gets no mark (a skipped call never reads as unanswered).
 */
export function pulledTranscripts(
  pulledChannels: Array<UsablePulled>,
  {
    formatOptions,
    descriptions,
    firstIndex,
    triggerId,
    labels,
  }: {
    formatOptions: FormatOptions;
    descriptions: Map<string, string> | undefined;
    firstIndex: number;
    triggerId: string | null;
    labels: Labels;
  }
): Array<PulledSet> {
  const marks = new Map<string | null, string | undefined>([
    ['answered', labels.pull?.pingAnswered],
    ['unanswered', labels.pull?.pingUnanswered],
    ['skipped', labels.pull?.pingSkipped],
  ]);
  let offset = firstIndex;
  return pulledChannels.map((channel) => {
    const own = channel.entry.descriptions;
    const captions =
      own instanceof Map && own.size > 0
        ? new Map([...(own as Map<string, string>), ...(descriptions ?? [])])
        : descriptions;
    const items = formatTranscript(channel.messages, { ...formatOptions, descriptions: captions, indexOffset: offset });
    offset += channel.messages.length;
    for (const item of items) {
      if (triggerId !== null && item.id === triggerId) continue;
      const mark = marks.get(pingStateOf(channel.entry.pingState, item.id));
      if (mark) item.text = `${item.text} ${mark}`;
    }
    return { ...channel, items, earlierIds: idSet(channel.entry.earlierPingIds) };
  });
}

/**
 * A short hash of what a pulled line is rendered from: its text, its
 * attachments and links, its stickers and its forwarded parts -- not its
 * reactions, its age or its index, which change without the message changing.
 * An edited message hashes differently.
 */
function pulledLineHash(message: Message): string {
  const ids = (list: Array<{ readonly [field: string]: unknown } | null | undefined> | undefined, key: string) =>
    Array.isArray(list)
      ? // eslint-disable-next-line @typescript-eslint/no-base-to-string -- a stored id, url or name, read as text
        list.map((item) => String(item?.[key] ?? item?.url ?? item?.name ?? ''))
      : [];
  const forwarded = Array.isArray(message.forwarded)
    ? message.forwarded.map((part) => [part?.content ?? '', ids(part?.attachments, 'id')])
    : [];
  const source = JSON.stringify([
    message.content ?? '',
    ids(message.attachments, 'id'),
    ids(message.links, 'url'),
    ids(message.stickers, 'id'),
    forwarded,
  ]);
  return createHash('sha1').update(source).digest('hex').slice(0, 12);
}

/**
 * The view of the same source channel last shown in this destination channel
 * (src/behavior/pull-fetch.ts#createPullViews, attached by src/behavior/turn.js
 * as the entry's `seenBefore`), or null when there is none or it is unusable.
 */
function seenBeforeOf(entry: PulledEntry): { hashes: Map<string, string>; oldestTs: number; shownAt: number } | null {
  // The view src/behavior/pull-fetch.ts#createPullViews keeps, read loosely: an unusable one is none.
  const seen = entry?.seenBefore as { hashes?: unknown; oldestTs?: unknown; shownAt?: unknown } | null | undefined;
  if (!seen || !(seen.hashes instanceof Map) || typeof seen.shownAt !== 'number' || !Number.isFinite(seen.shownAt))
    return null;
  return {
    hashes: seen.hashes as Map<string, string>,
    oldestTs: typeof seen.oldestTs === 'number' && Number.isFinite(seen.oldestTs) ? seen.oldestTs : Infinity,
    shownAt: seen.shownAt,
  };
}

/**
 * One pulled channel as its `<channel_view>` item, cut to `budget` tokens.
 * The item: `labels.pull.header` (`{channel}`, `{from}` = the first window line
 * kept, `{to}` = the window's newest line, `{ago}` = how long before `now` that
 * one was written: the channel's real span and age, whatever is cut), then --
 * with `seenOn` and a previous view of this channel in this destination
 * (`entry.seenBefore`) -- one line of fact about the lines kept against
 * it: `labels.pull.seenBefore` (`{fresh}` = lines not shown then or changed
 * since, by id and pulledLineHash; `{older}` = those older than the oldest
 * window line shown then; `{ago}` = how long before `now` it was shown) or,
 * with nothing fresh, `labels.pull.seenSame` (`{ago}`); no line without the
 * label. Then -- each when it applies and its label exists -- `labels.server.readOnly`,
 * `labels.pull.olderNotShown` (older messages exist, or window lines older
 * than the first one kept were cut here), `labels.pull.picturesNotSeen`
 * `{count}`; then the earlier calls under `labels.pull.earlierPings` (`{date}`
 * = the oldest one's date); then the window's lines, with
 * `labels.pull.olderNotShown` again between two kept lines whose lines in
 * between were cut (the trigger kept, newer lines cut, the newest ones kept).
 * What is kept: the trigger's line first, then the window's lines newest first
 * while they fit, then the earlier calls newest first. The trigger's line --
 * with the window's newest line when the trigger sits before the window, so
 * the header has a span -- may take up to `ceiling` even past `budget` (a call
 * is never lost to the share or the cap); then nothing else is kept. Null when
 * no window line fits: a header alone is never shown.
 * `seen` counts what the seen line said (null without one); `hashes` and
 * `oldestTs` are this view as the next one compares against it, `oldestId`
 * the line an earlier page starts before.
 */
export function fitPulledChannel(
  channel: PulledSet,
  {
    budget,
    ceiling = budget,
    cost,
    labels,
    timezone,
    now,
    readOnly,
    triggerId,
    seenOn = false,
  }: {
    budget: number;
    ceiling?: number;
    cost: Cost;
    labels: Labels;
    timezone: string;
    now: number;
    readOnly: boolean;
    triggerId: string | null;
    seenOn?: boolean;
  }
): PulledFit | null {
  // A channel is pulled into the request only with `labels.pull.header`.
  const p = labels.pull!;
  const windowItems = channel.items.filter((item) => !channel.earlierIds.has(String(item.id)));
  const earlierItems = channel.items.filter((item) => channel.earlierIds.has(String(item.id)));
  if (windowItems.length === 0) return null;
  const picturesNotSeen = channel.entry.picturesNotSeen;
  const notSeen =
    typeof picturesNotSeen === 'number' && Number.isFinite(picturesNotSeen)
      ? Math.max(0, Math.floor(picturesNotSeen))
      : 0;
  const newestWindow = windowItems.at(-1)!;
  const windowAt = new Map(windowItems.map((item, i) => [item.id, i]));
  const hashById = new Map(channel.messages.map((message) => [String(message.id), pulledLineHash(message)]));
  const previous = seenOn ? seenBeforeOf(channel.entry) : null;

  // The kept lines against the previous view: new or changed ones, and those of them older than it.
  const seenCounts = (keep: Set<string>) => {
    if (!previous) return null;
    const fresh = channel.items.filter(
      (item) => keep.has(item.id) && previous.hashes.get(String(item.id)) !== hashById.get(String(item.id))
    );
    return { fresh: fresh.length, older: fresh.filter((item) => item.ts < previous.oldestTs).length };
  };
  const seenLine = (counts: { fresh: number; older: number } | null) => {
    if (!counts || !previous) return null;
    const ago = formatDuration(Math.max(0, now - previous.shownAt), labels.units);
    if (counts.fresh === 0) return p.seenSame ? fill(p.seenSame, { ago }) : null;
    return p.seenBefore ? fill(p.seenBefore, { fresh: counts.fresh, older: counts.older, ago }) : null;
  };

  const render = (keep: Set<string>) => {
    const keptWindow = windowItems.filter((item) => keep.has(item.id));
    if (keptWindow.length === 0) return null;
    const keptEarlier = earlierItems.filter((item) => keep.has(item.id));
    const lines = [
      fill(p.header, {
        channel: channel.name,
        from: pulledMoment(keptWindow[0].ts, timezone, labels.locale),
        to: pulledMoment(newestWindow.ts, timezone, labels.locale),
        ago: formatDuration(Math.max(0, now - newestWindow.ts), labels.units),
      }),
    ];
    const seen = seenLine(seenCounts(keep));
    if (seen) lines.push(seen);
    if (readOnly && labels.server?.readOnly) lines.push(fill(labels.server.readOnly));
    const older = channel.entry.olderNotShown === true || keptWindow[0] !== windowItems[0];
    if (older && p.olderNotShown) lines.push(fill(p.olderNotShown));
    if (notSeen > 0 && p.picturesNotSeen) lines.push(fill(p.picturesNotSeen, { count: notSeen }));
    if (keptEarlier.length > 0) {
      if (p.earlierPings)
        lines.push(fill(p.earlierPings, { date: formatDate(keptEarlier[0].ts, timezone, labels.locale) }));
      lines.push(...keptEarlier.map((item) => item.text));
    }
    keptWindow.forEach((item, i) => {
      // Lines cut between two kept ones are not shown either.
      if (i > 0 && (windowAt.get(item.id) ?? NaN) - (windowAt.get(keptWindow[i - 1].id) ?? NaN) > 1 && p.olderNotShown)
        lines.push(fill(p.olderNotShown));
      lines.push(item.text);
    });
    return lines.join('\n');
  };
  const fitted = (keep: Set<string>): PulledFit => {
    const kept = windowItems.filter((item) => keep.has(item.id));
    // fitted runs only on a set render found a window line in.
    const newest = kept.at(-1)!;
    const ids = [...earlierItems, ...windowItems].filter((item) => keep.has(item.id)).map((item) => item.id);
    const counts = seenCounts(keep);
    return {
      text: render(keep)!,
      ids,
      newestId: newest.id,
      newestTs: newest.ts,
      hashes: new Map(ids.map((id) => [String(id), hashById.get(String(id))])),
      oldestTs: kept[0].ts,
      oldestId: kept[0].id,
      seen: seenLine(counts) ? counts : null,
    };
  };

  const keep = new Set<string>();
  const pinned = triggerId !== null ? channel.items.find((item) => item.id === triggerId) : undefined;
  if (pinned) {
    const floor = new Set([pinned.id, ...(windowAt.has(pinned.id) ? [] : [newestWindow.id])]);
    const floorCost = cost(render(floor)!);
    if (floorCost <= ceiling) {
      if (floorCost > budget) return fitted(floor);
      for (const id of floor) keep.add(id);
    }
  }
  if (!(budget > 0)) return null;
  for (const group of [windowItems, earlierItems]) {
    for (let i = group.length - 1; i >= 0; i -= 1) {
      const { id } = group[i];
      if (keep.has(id)) continue;
      keep.add(id);
      const text = render(keep);
      if (text !== null && cost(text) <= budget) continue;
      keep.delete(id);
      break;
    }
  }
  const text = render(keep);
  if (text === null || cost(text) > budget) return null;
  return fitted(keep);
}

/**
 * The authors of the pulled lines kept (`fitPulledChannel`'s `ids` over each
 * channel's `messages`), newest line first, each once: members only, never the
 * persona and never a bot.
 */
export function pulledAuthors(pulledFits: Array<{ ids: Array<string>; messages: Array<Message> }>): Array<string> {
  const out: Array<string> = [];
  for (const fit of pulledFits) {
    const byId = new Map(fit.messages.map((message) => [message.id, message]));
    for (const id of [...fit.ids].reverse()) {
      const message = byId.get(id);
      if (!message || message.self || message.bot || message.authorId === undefined || message.authorId === null)
        continue;
      const authorId = String(message.authorId);
      if (!out.includes(authorId)) out.push(authorId);
    }
  }
  return out;
}

/** The pulled channels a request offers, their transcripts and how a routed call's line is found among them. */
export type PulledView = {
  source: RequestInput['source'];
  routed: boolean;
  offered: Array<UsablePulled>;
  pulledChannels: Array<UsablePulled>;
  chatTrigger: TranscriptItem | null;
  pulledTriggerId: string | null;
  pulledSets: Array<PulledSet>;
  pulledIds: Map<string, string>;
  offeredNeighbors: RequestInput['neighbors'];
  pulledChannelIds: Set<string>;
  readOnlyIds: Set<string>;
};

/**
 * Another channel pulled into this turn (`<channel_view>`), with its lines numbered on after the chat's and mapped
 * back through `idByIndex` (filled here) and `pulledIds`; and the neighbours and read-only channels a server turn
 * shows.
 */
export function pulledView(given: RequestInput & Base): PulledView {
  const { trigger, history, neighbors, currentChannelId, descriptions } = given;
  const { privateChat, labels, chatItems, formatOptions, idByIndex } = given;
  // Another channel pulled into this turn (`<channel_view>`): never in a private chat, and
  // shown only when the labels can head it. Its lines are numbered on after the chat's and
  // map back through idByIndex and pulledIds. A routed turn answers a call that lives there.
  const source = privateChat ? null : (given.source ?? null);
  const routed = source?.reason === 'routed';
  const offered = usablePulled(given.pulled, currentChannelId);
  const pulledChannels = labels.pull?.header ? offered : [];
  const chatTrigger = trigger ? (chatItems.find((item) => item.id === trigger.id) ?? null) : null;
  const pulledTriggerId = trigger && !chatTrigger ? trigger.id : null;
  const pulledSets = pulledTranscripts(pulledChannels, {
    formatOptions,
    descriptions,
    firstIndex: history.length,
    triggerId: pulledTriggerId,
    labels,
  });
  const pulledIds = new Map<string, string>();
  for (const channel of pulledSets) {
    for (const item of channel.items) {
      idByIndex.set(item.index, item.id);
      pulledIds.set(item.id, channel.channelId);
    }
  }
  // A private chat has no neighbouring channels (and no server map, below).
  const offeredNeighbors = privateChat ? [] : neighbors;
  const pulledChannelIds = new Set(pulledChannels.map((channel) => channel.channelId));
  // Channels the bot can read but not write in, marked in `<server>` and on a pulled header.
  // The channel ids the turn hands over, a Set or an array.
  const givenReadOnly = (
    given.readOnlyIds instanceof Set || Array.isArray(given.readOnlyIds) ? given.readOnlyIds : []
  ) as Iterable<string>;
  const readOnlyIds = new Set([
    ...(privateChat ? [] : givenReadOnly),
    ...pulledChannels.filter((channel) => channel.entry.readOnly === true).map((channel) => channel.channelId),
  ]);
  return {
    source,
    routed,
    offered,
    pulledChannels,
    chatTrigger,
    pulledTriggerId,
    pulledSets,
    pulledIds,
    offeredNeighbors,
    pulledChannelIds,
    readOnlyIds,
  };
}

/** The pulled channels as fitted, each with its messages, what they took and their section. */
export type PulledFits = {
  pulledFits: Array<PulledFit & { channelId: string; messages: Array<Message> }>;
  pulledTaken: number;
  pulledSection: Section;
};

/**
 * The pulled block's room: what the sections fitted ahead of it leave (the chat included, except on a routed turn), at
 * most `context.caps.pulled`, shared evenly between the channels, each cut to its share here.
 */
export function fitPulled(given: RequestInput & Base & PulledView & Room & HeadSections): PulledFits {
  const { config, now, labels, timezone, caps, cost, limit, routed, pulledSets, pulledTriggerId, readOnlyIds } = given;
  const { head, chatSection } = given;
  // The pulled block's room: what the sections fitted ahead of it leave (the chat included,
  // except on a routed turn), at most context.caps.pulled, shared evenly between the
  // channels. Each channel is cut to its share here -- the call's own line may go past the
  // share and the cap, never past what the request has left (`free`, exactly what the main
  // pass leaves the block) -- so the main pass keeps every channel whole and the block can
  // never fail the request.
  const pulledCap = caps.pulled ?? 4000;
  const pulledFits = [];
  let pulledTaken = 0;
  if (pulledSets.length > 0) {
    const ahead = routed ? head : [...head, chatSection];
    const free = Math.max(0, limit - fitSections(ahead, limit, cost).used);
    const room = Math.min(pulledCap, free);
    const share = Math.floor(room / pulledSets.length);
    for (const channel of pulledSets) {
      const fitted = fitPulledChannel(channel, {
        budget: Math.min(share, Math.max(0, room - pulledTaken)),
        ceiling: free - pulledTaken,
        cost,
        labels,
        timezone,
        now,
        readOnly: readOnlyIds.has(channel.channelId),
        triggerId: pulledTriggerId,
        // features.pullSeenMarker (a missing key counts as on), read now.
        seenOn: config.features?.pullSeenMarker !== false,
      });
      if (!fitted) continue;
      pulledTaken += cost(fitted.text);
      pulledFits.push({ ...fitted, channelId: channel.channelId, messages: channel.messages });
    }
  }
  const pulledSection: Section = {
    name: 'pulled',
    cap: Math.max(pulledCap, pulledTaken),
    keep: 'first',
    items: pulledFits.map((fit) => fit.text),
  };
  return { pulledFits, pulledTaken, pulledSection };
}

/**
 * The neighbours, cut shorter than the chat (context.neighborMessageChars); a channel whose pulled block is shown is
 * not shown again among them, one whose block was cut still is.
 */
export function neighborItemsOf(given: RequestInput & Base & PulledView & PulledFits): Array<string> {
  const { config, descriptions, formatOptions, offeredNeighbors, pulledFits } = given;
  const neighborChars = config.context.neighborMessageChars ?? 300;
  // The neighbours' own cached captions join the chat's for their lines only, so the
  // chat keeps exactly the captions this turn gave it.
  // The describer's cached captions of the neighbours' pictures, item id to caption.
  const cached = given.neighborDescriptions instanceof Map ? (given.neighborDescriptions as Map<string, string>) : null;
  const neighborDescriptions = cached && cached.size > 0 ? new Map([...cached, ...(descriptions ?? [])]) : descriptions;
  const shownPulledIds = new Set<string | undefined>(pulledFits.map((fit) => fit.channelId));
  const neighborItems = offeredNeighbors
    .filter((neighbor) => !shownPulledIds.has(neighbor.channelId))
    .map(
      ({ channelName, messages }) =>
        `# ${channelName}\n${formatTranscript(messages, {
          ...formatOptions,
          maxChars: neighborChars,
          descriptions: neighborDescriptions,
          messageNumbers: false,
        })
          .map((item) => item.text.replace(/^#\d+ /gm, ''))
          .join('\n')}`
    );
  return neighborItems;
}

/** The pulled channels whose block survived: what of them was shown, and each one's view for the next look. */
export type PulledKept = {
  pulledKept: Array<{ channelId: string; ids: Array<string>; newestId: string; newestTs: number }>;
  pulledViews: Array<{
    channelId: string;
    hashes: Map<string, string | undefined>;
    oldestTs: number;
    oldestId: string;
  }>;
};

/**
 * The pulled channels whose block survived, with what of them was shown; the block's budget line counts what was
 * offered and not shown too, and the seen lines' counts when one was shown. Fills `fit.stats.pulled`.
 */
export function pulledKeptOf(fit: Fit, given: PulledView & PulledFits): PulledKept {
  const { kept, stats } = fit;
  const { offered, pulledFits } = given;
  const keptPulled = new Set(kept.pulled);
  const pulledKept = pulledFits
    .filter((fit) => keptPulled.has(fit.text))
    .map(({ channelId, ids, newestId, newestTs }) => ({ channelId, ids, newestId, newestTs }));
  // The block's budget line counts what was offered and not shown too: a channel cut whole,
  // or lines cut inside a channel shown.
  const pulledShownLines = pulledKept.reduce((sum, shown) => sum + shown.ids.length, 0);
  const pulledLines = offered.reduce((sum, channel) => sum + channel.messages.length, 0);
  stats.pulled = {
    ...stats.pulled,
    dropped: offered.length - pulledKept.length,
    lines: pulledLines,
    linesCut: pulledLines - pulledShownLines,
  };
  // What each kept channel showed, for the next view of it in this channel to compare against;
  // the seen lines' counts join the budget line only when one was shown.
  const keptFits = pulledFits.filter((fit) => keptPulled.has(fit.text));
  const pulledViews = keptFits.map(({ channelId, hashes, oldestTs, oldestId }) => ({
    channelId,
    hashes,
    oldestTs,
    oldestId,
  }));
  const seenFits = keptFits.filter(
    (fit): fit is (typeof keptFits)[number] & { seen: { fresh: number; older: number } } => Boolean(fit.seen)
  );
  if (seenFits.length > 0) {
    stats.pulled.seenFresh = seenFits.reduce((sum, fit) => sum + fit.seen.fresh, 0);
    stats.pulled.seenOlder = seenFits.reduce((sum, fit) => sum + fit.seen.older, 0);
  }
  return { pulledKept, pulledViews };
}
