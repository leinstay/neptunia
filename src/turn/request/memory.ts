// The memory blocks of a turn's request: `<recent>` (the last hours' lines and the members' moments), the persona's
// own exchanges on other channels in `<participation>`, and the anchored window `<earlier>` (this channel's lines
// older than the chat that matter). buildRequest and buildDiaryPlanRequest (src/behavior/prompt.js) call them.

import { fill, formatClock, formatDate, formatDuration, formatTranscript } from '../../format.js';
import { fitSections } from '../../llm/budget.js';
import { cutEpisode, earlierEpisodes, participationSettings, selectEpisodes, topEpisodes } from '../../memory/index.js';
import { oneLine } from '../../memory/clamp.js';
import {
  RECENT_EPISODES_PER_MEMBER,
  episodeKey,
  foldText,
  memberIdOf,
  recentSettings,
  recentView,
} from '../../memory/recent.js';
import { MINUTE_MS } from '../../time.js';
import { calendarDate, resolveChatText } from './text.ts';
import type { Base, Room } from './head.ts';
import type { AskedAbout, InterlocutorBlocks } from './people.ts';
import type { HeadSections } from './sections.ts';
import type { PulledView } from './pulled.ts';
import type {
  Episode,
  Fit,
  FormatOptions,
  Labels,
  MemoryRead,
  Message,
  NameOf,
  RequestConfig,
  RequestInput,
  Section,
} from './types.ts';

/** What `<recent>` did, for the turn record. */
export type RecentCounts = {
  lines: number;
  episodes: number;
  cut: number;
  hidden: number;
  repeated: number;
  unnamed: number;
};

/** One stored line of the participation store (src/memory/participation.js). */
type StoredMessage = {
  readonly id: string;
  readonly ts: number;
  readonly text?: string;
  readonly caption?: string;
  readonly name?: string;
  readonly self?: boolean;
  readonly bot?: boolean;
  readonly replyTo?: string | null;
};

/** One stored episode: a slice of a channel around the persona's own lines. */
type StoredEpisode = {
  readonly id: string;
  readonly itemId?: unknown;
  readonly messages: Array<StoredMessage>;
  readonly lastOwnAt: number;
  readonly startAt: number;
  readonly lastAt: number;
};

/** The `participation` input of a request: the store, the picks, the audience and the live channel names. */
export type ParticipationInput = {
  readonly state: unknown;
  readonly pickedIds?: Array<string>;
  readonly audience?: (channelId: string) => boolean;
  readonly channelName?: (channelId: string) => string | null;
};

/** One item of src/memory/recent.js#recentView. */
export type RecentItem =
  | {
      kind: 'line';
      at: number;
      line: { readonly text?: string; readonly channelId?: string | null; readonly itemId?: unknown };
    }
  | { kind: 'episode'; at: number; profileId: string; name: string | null; episode: Episode };

/** One `<recent>` entry: its text, its time and what it carried from memory. */
export type RecentEntry = { kind: 'line' | 'episode'; at: number; text: string; read: MemoryRead | null };

/** One `<participation>` episode as the budget offers it. */
export type ParticipationEpisode = {
  id: string;
  itemId: string | null;
  channelId: string;
  channelLine: string;
  text: string;
  budgetText: string;
  rank: number;
  lastOwnAt: number;
};

/** The `<participation>` block's pieces before the budget. */
export type ParticipationView = {
  header: string;
  episodes: Array<ParticipationEpisode>;
  offered: number;
  deduped: number;
};

/** One `<earlier>` piece: a reply parent or a stretch of the persona's saved lines. */
type AnchorPiece = {
  kind: 'reply' | 'episode';
  ids: Array<string>;
  parentIds: Array<string>;
  startAt: number;
  lastAt?: number;
  rank: number;
  text: string;
};

/** The `<earlier>` block's pieces before the budget. */
export type AnchorsView = { header: string; pieces: Array<AnchorPiece> };

/** cutEpisode over stored lines: the lines kept, and the runs it cut. */
const cutOf = (
  episode: { messages: Array<StoredMessage> },
  maxChars: number,
  keepIds: Array<string>
): Array<{ message: StoredMessage } | { skipped: number }> =>
  // cutEpisode keeps the episode's own messages, which it returns as plain objects.
  cutEpisode(episode, { maxChars, keepIds }) as Array<{ message: StoredMessage } | { skipped: number }>;

/**
 * The `<recent>` items of a view (src/memory/recent.js#recentView), in its
 * order, each with its text and its time (`at`). A line renders through
 * `labels.recent.lineIn` (`{date}` `{time}` `{channel}` `{text}`) when it comes
 * from another channel whose name the channel map (`channels`) holds and the
 * label exists, else through `labels.recent.line` (`{date}` `{time}` `{text}`);
 * a moment through `labels.recent.episode` (`{date}` `{name}` `{what}`) --
 * the caller offers none without that label -- left out and counted
 * (`unnamed`) when the member has no name (`nameOf` gives none and the profile
 * stores none). A line's `{date}` and `{time}` are the transcript's own forms
 * of its time; a moment's `{date}` is its stored `YYYY-MM-DD` (the day it
 * happened) in the transcript's date form, never its `at` moved through a time
 * zone. Every stored `<@id>` token becomes the member's name (`nameOf`). No
 * quote and no feeling: a moment is named, not replayed.
 */
export function recentEntries(
  items: Array<RecentItem>,
  {
    labels,
    timezone,
    currentChannelId,
    channels,
    nameOf,
  }: {
    labels: Labels;
    timezone: string;
    currentChannelId: string | null;
    channels: Array<{ readonly id?: string; readonly name?: string } | null> | null | undefined;
    nameOf: NameOf;
  }
): { entries: Array<RecentEntry>; unnamed: number } {
  // The caller renders `<recent>` only with `labels.recent.header` and `line`.
  const r = labels.recent!;
  const channelNames = new Map(
    (Array.isArray(channels) ? channels : [])
      .filter((channel): channel is { id: string; name: string } => Boolean(channel?.id && channel.name))
      .map((channel) => [channel.id, channel.name])
  );
  const entries: Array<RecentEntry> = [];
  let unnamed = 0;
  for (const item of items) {
    if (item.kind === 'line') {
      const date = formatDate(item.at, timezone, labels.locale);
      const text = resolveChatText(item.line.text, nameOf);
      const time = formatClock(item.at, timezone, labels.locale);
      const channel =
        item.line.channelId !== currentChannelId ? channelNames.get(item.line.channelId ?? '') : undefined;
      const rendered =
        channel && r.lineIn ? fill(r.lineIn, { date, time, channel, text }) : fill(r.line, { date, time, text });
      entries.push({
        kind: 'line',
        at: item.at,
        text: rendered,
        read:
          typeof item.line.itemId === 'string' && item.line.itemId
            ? { kind: 'recent_line', id: item.line.itemId }
            : null,
      });
      continue;
    }
    if (!r.episode) continue;
    const name = nameOf(item.profileId) || item.name;
    if (!name) {
      unnamed += 1;
      continue;
    }
    const date = calendarDate(item.episode.date, labels.locale);
    entries.push({
      kind: 'episode',
      at: item.at,
      text: fill(r.episode, { date, name, what: resolveChatText(item.episode.what, nameOf) }),
      read:
        typeof item.episode.itemId === 'string' && item.episode.itemId
          ? { kind: 'episode', id: item.episode.itemId }
          : null,
    });
  }
  return { entries, unnamed };
}

/** The words of `text` a `<participation>` line is matched by: its folded words (foldText) of 4+ letters. */
function matchWords(text: unknown): Set<string> {
  return new Set(
    foldText(text)
      .split(/\P{L}+/u)
      .filter((word) => [...word].length >= 4)
  );
}

/**
 * How a stored participation message renders (`<participation>` and `<earlier>`): the
 * transcript's form without a `#n` index or a reply quote -- the clock time, as
 * `transcript.timeAged` once the line is `ageMinutes` old, the author (`labels.self` for the
 * persona), the text, and a stored caption as `transcript.imageDescribed`.
 */
function storedLineRenderer({
  labels,
  timezone,
  now,
  selfName,
  nameOf,
  ageMinutes,
}: {
  labels: Labels;
  timezone: string;
  now: number;
  selfName: string;
  nameOf: NameOf;
  ageMinutes: number;
}): (message: StoredMessage) => string {
  const selfLabel = fill(labels.self, { name: selfName });
  const agedTemplate = labels.transcript?.timeAged;
  return (message: StoredMessage) => {
    const clock = formatClock(message.ts, timezone, labels.locale);
    const age = now - message.ts;
    const time =
      agedTemplate && age >= ageMinutes * MINUTE_MS
        ? fill(agedTemplate, { clock, age: formatDuration(age, labels.units) })
        : `[${clock}]`;
    const caption =
      message.caption && labels.transcript?.imageDescribed
        ? fill(labels.transcript.imageDescribed, { text: message.caption })
        : '';
    const body = [resolveChatText(message.text, nameOf), caption].filter(Boolean).join(' ');
    return `${time} ${message.self ? selfLabel : String(message.name)}: ${body}`.trimEnd();
  };
}

/**
 * The `<participation>` block's pieces before the budget: the slices of other
 * channels around the persona's own lines (src/memory/participation.js), or
 * null when there is no block to build -- a private chat, `features.participation`
 * off (a missing key counts as on), no `labels.participation.header` or
 * `labels.participation.episode`, or no `participation.state`. The episodes are
 * src/memory/participation.js#selectEpisodes's (`pickedIds` first, then the
 * newest; `participation.shown`, `participation.perChannel`, never the current
 * channel, only channels `audience` accepts). A line whose message id is in
 * `shownIds` (already in `<chat>`, `<other_channels>` or `<channel_view>`) is
 * dropped (counted in `deduped`); an episode left without a line of the
 * persona is dropped, and so is every episode of a channel with no name (the
 * stored note's, else `channelName(id)`). Each episode is cut to
 * `participation.episodeChars` (cutEpisode) keeping the lines that share a
 * word of 4+ letters with `candidateText`; a run of cut lines renders
 * `labels.participation.skipped` (`{count}`), nothing without the label. An
 * episode renders `labels.participation.episode` (`{when}`: the age of its
 * newest own line, formatDuration), then its lines in the transcript's form
 * without a `#n` index or a reply quote: the clock time, as
 * `transcript.timeAged` once the line is `ageMinutes` old, the author
 * (`labels.self` for the persona), the text, and a stored caption as
 * `transcript.imageDescribed`. A channel's line is `labels.participation.channel`
 * (`{channel}` `{purpose}`: the stored note's purpose) or, with no purpose,
 * `labels.participation.channelNoPurpose`. `episodes` come in budget priority
 * (the picks in their order, then the newest), each with `budgetText` (its
 * channel line and its own text: what the budget pays for) and `rank` (its
 * place in the selection's display order).
 */
// health: allow complexity until 2027-04-01 -- moved whole from src/behavior/prompt.js in stage 5d, a pure move
export function participationView(
  participation: ParticipationInput | null | undefined,
  {
    config,
    labels,
    privateChat,
    currentChannelId,
    channels,
    shownIds,
    candidateText,
    now,
    timezone,
    selfName,
    nameOf,
    ageMinutes,
  }: {
    config: RequestConfig;
    labels: Labels;
    privateChat: boolean;
    currentChannelId: string | null;
    channels: Array<{ readonly id?: string; readonly name?: string; readonly purpose?: string } | null>;
    shownIds: Set<string>;
    candidateText: string;
    now: number;
    timezone: string;
    selfName: string;
    nameOf: NameOf;
    ageMinutes: number;
  }
): ParticipationView | null {
  const p = labels.participation;
  if (privateChat || config.features?.participation === false) return null;
  if (!p?.header || !p.episode) return null;
  if (!participation || typeof participation !== 'object' || !participation.state) return null;
  const settings = participationSettings(config);
  const pickedIds = Array.isArray(participation.pickedIds) ? participation.pickedIds : [];
  // selectEpisodes groups the stored episodes, which it returns as plain objects.
  const groups = selectEpisodes(
    participation.state,
    { pickedIds, excludeChannelId: currentChannelId, audience: participation.audience, now },
    settings
  ) as Array<{ channelId: string; episodes: Array<StoredEpisode> }>;
  const stored = new Map(
    (Array.isArray(channels) ? channels : [])
      .filter((channel): channel is { id: string; name?: string; purpose?: string } => Boolean(channel?.id))
      .map((channel) => [channel.id, channel])
  );
  const liveName = typeof participation.channelName === 'function' ? participation.channelName : () => null;
  const words = matchWords(candidateText);
  const renderLine = storedLineRenderer({ labels, timezone, now, selfName, nameOf, ageMinutes });
  const episodes: Array<ParticipationEpisode> = [];
  let offered = 0;
  let deduped = 0;
  let rank = 0;
  for (const group of groups) {
    offered += group.episodes.length;
    const note = stored.get(group.channelId);
    const name = oneLine(note?.name ?? '') || oneLine(liveName(group.channelId) ?? '');
    if (!name) continue;
    const purpose = oneLine(note?.purpose ?? '');
    const channelLine =
      purpose && p.channel
        ? fill(p.channel, { channel: name, purpose })
        : p.channelNoPurpose
          ? fill(p.channelNoPurpose, { channel: name })
          : '';
    for (const episode of group.episodes) {
      const messages = episode.messages.filter((message) => !shownIds.has(message.id));
      deduped += episode.messages.length - messages.length;
      if (!messages.some((message) => message.self)) continue;
      const keepIds =
        words.size > 0
          ? messages
              .filter((message) => [...matchWords(message.text)].some((word) => words.has(word)))
              .map((message) => message.id)
          : [];
      const lines = cutOf({ messages }, settings.episodeChars, keepIds).map((item) =>
        'skipped' in item ? (p.skipped ? fill(p.skipped, { count: item.skipped }) : '') : renderLine(item.message)
      );
      const text = [
        fill(p.episode, { when: formatDuration(Math.max(0, now - episode.lastOwnAt), labels.units) }),
        ...lines.filter(Boolean),
      ].join('\n');
      episodes.push({
        id: episode.id,
        itemId: typeof episode.itemId === 'string' && episode.itemId ? episode.itemId : null,
        channelId: group.channelId,
        channelLine,
        text,
        budgetText: [channelLine, text].filter(Boolean).join('\n'),
        rank,
        lastOwnAt: episode.lastOwnAt,
      });
      rank += 1;
    }
  }
  // Budget priority: the picks in their order, then the newest; the display order stays the selection's.
  const pickIndex = (id: string) => {
    const at = pickedIds.indexOf(id);
    return at === -1 ? Infinity : at;
  };
  episodes.sort((a, b) => pickIndex(a.id) - pickIndex(b.id) || b.lastOwnAt - a.lastOwnAt);
  return { header: fill(p.header, { hours: settings.hours }), episodes, offered, deduped };
}

/**
 * The `<participation>` block's text from the episodes the budget kept: the
 * header, then per channel (in the selection's order) its channel line once
 * and its episodes. '' when none was kept.
 */
export function participationText(view: ParticipationView, keptEpisodes: Array<ParticipationEpisode>): string {
  if (keptEpisodes.length === 0) return '';
  const lines = [view.header];
  let channelId: string | null = null;
  for (const episode of [...keptEpisodes].sort((a, b) => a.rank - b.rank)) {
    if (episode.channelId !== channelId && episode.channelLine) lines.push(episode.channelLine);
    channelId = episode.channelId;
    lines.push(episode.text);
  }
  return lines.join('\n');
}

/**
 * Whether a request keeps the anchored chat window (`<earlier>`): `features.anchoredWindow`
 * exactly true (a missing key counts as off), a server turn, and `labels.participation.earlierHeader`
 * to head the block. Off, the reply parents stay at the head of `<chat>` and there is no `<earlier>`:
 * the request is the one the count-based window always made.
 */
export function anchoredOn(config: RequestConfig, labels: Labels, privateChat: boolean): boolean {
  return config.features?.anchoredWindow === true && !privateChat && Boolean(labels.participation?.earlierHeader);
}

/**
 * The `<earlier>` block's pieces before the budget: the anchors, lines of the current channel
 * that matter but that the count-based window (`context.channelMessages`) no longer holds.
 *
 * - `reply`: a reply parent (`replyParent: true`, prepended to `history` by the turn,
 *   src/behavior/turn.js#withReplyParents) -- what the trigger or a window line answers. It keeps
 *   its `<chat>` number (formatTranscript over the whole `history`, every other line skipped), so a
 *   window line's reply marker and a message link still name it; the bare clock, never
 *   `transcript.timeAged`.
 * - `episode`: the persona's own saved stretch of this channel (src/memory/participation.js#
 *   earlierEpisodes: her episodes cut to their lines older than the window's first line and
 *   younger than `participation.earlierHours`, the newest `participation.earlierShown`), only with
 *   `features.participation` on. Cut to `participation.episodeChars` (cutEpisode, a run of cut
 *   lines as `labels.participation.skipped`), its lines in the `<participation>` form with the bare
 *   clock; a line that is also a reply parent carries its `#n`.
 *
 * A line is an OPEN request when it is addressed to the persona -- a reply parent that mentions
 * `selfId` (a mention or a reply ping) or replies to a line of hers, a saved line that replies to
 * a line of hers with no line of hers after it in its episode -- and no line of hers in `history`
 * or in the episodes replies to it or was posted by the turn it started (`triggerId`). It ends
 * with `labels.participation.earlierOpen` when that label is set.
 *
 * Priority for the budget (`pieces` come in it): the trigger's parent, then the pieces holding an
 * open request, then the other parents, then the episodes, each newest first. Every piece has
 * `text`, `ids` (the messages it shows), `parentIds` (the reply parents among them) and
 * `startAt`. Null when there is nothing to show.
 */
// health: allow complexity until 2027-04-01 -- moved whole from src/behavior/prompt.js in stage 5d, a pure move
export function anchorsView(
  participation: ParticipationInput | null | undefined,
  {
    config,
    labels,
    currentChannelId,
    history,
    trigger,
    selfId,
    now,
    timezone,
    selfName,
    nameOf,
    formatOptions,
  }: {
    config: RequestConfig;
    labels: Labels;
    currentChannelId: string | null;
    history: Array<Message>;
    trigger: Message | null | undefined;
    selfId: string | null;
    now: number;
    timezone: string;
    selfName: string;
    nameOf: NameOf;
    formatOptions: FormatOptions;
  }
): AnchorsView | null {
  // Only a request that anchoredOn holds true for builds `<earlier>`: `labels.participation` is there.
  const p = labels.participation!;
  const settings = participationSettings(config);
  const parents = history.filter((message) => message.replyParent === true);
  const windowLines = history.filter((message) => message.replyParent !== true);
  const indexOf = new Map(history.map((message, i) => [message.id, i + 1]));
  const starts = windowLines.map((message) => message?.ts).filter(Number.isFinite);
  const state =
    config.features?.participation !== false && participation && typeof participation === 'object'
      ? participation.state
      : null;
  // earlierEpisodes cuts the stored episodes, which it returns as plain objects.
  const episodes = (
    state && starts.length > 0
      ? earlierEpisodes(state, { channelId: currentChannelId ?? '', before: Math.min(...starts), now }, settings)
      : []
  ) as Array<StoredEpisode>;

  // Her lines and what they answer: a reply target, or the message that started their turn.
  const herIds = new Set<string | null | undefined>();
  const answered = new Set<string | null | undefined>();
  for (const message of history) {
    if (!message.self) continue;
    herIds.add(message.id);
    if (message.replyToId) answered.add(message.replyToId);
    if (message.triggerId) answered.add(message.triggerId);
  }
  for (const episode of episodes) {
    for (const message of episode.messages) {
      if (!message.self) continue;
      herIds.add(message.id);
      if (message.replyTo) answered.add(message.replyTo);
    }
  }
  const openParent = (m: Message) =>
    !m.self &&
    !m.bot &&
    !answered.has(m.id) &&
    ((selfId && (m.mentionedUserIds ?? []).includes(selfId)) || herIds.has(m.replyToId));
  const openStored = (episode: StoredEpisode, i: number) => {
    const m = episode.messages[i];
    return (
      !m.self &&
      herIds.has(m.replyTo) &&
      !answered.has(m.id) &&
      !episode.messages.slice(i + 1).some((later) => later.self)
    );
  };
  const mark = p.earlierOpen ? ` ${p.earlierOpen}` : '';

  const pieces: Array<AnchorPiece> = [];
  for (const parent of parents) {
    const open = openParent(parent);
    const line =
      formatTranscript(history, {
        ...formatOptions,
        now: undefined,
        // formatTranscript hands back the messages of `history`.
        skip: (message: object) => (message as Message).id !== parent.id,
      })[0].text + (open ? mark : '');
    pieces.push({
      kind: 'reply',
      ids: [parent.id],
      parentIds: [parent.id],
      startAt: parent.ts,
      rank: parent.id === trigger?.replyToId ? 0 : open ? 1 : 2,
      text: line,
    });
  }
  const renderLine = storedLineRenderer({ labels, timezone, now, selfName, nameOf, ageMinutes: Infinity });
  for (const episode of episodes) {
    const openIds = new Set(episode.messages.filter((_, i) => openStored(episode, i)).map((m) => m.id));
    const keepIds = [...openIds, ...episode.messages.filter((m) => indexOf.has(m.id)).map((m) => m.id)];
    const items = cutOf(episode, settings.episodeChars, keepIds);
    const shown = items
      .filter((item): item is { message: StoredMessage } => !('skipped' in item))
      .map((item) => item.message.id);
    const text = items
      .map((item) => {
        if ('skipped' in item) return p.skipped ? fill(p.skipped, { count: item.skipped }) : '';
        const number = indexOf.has(item.message.id) ? `#${indexOf.get(item.message.id)} ` : '';
        return `${number}${renderLine(item.message)}${openIds.has(item.message.id) ? mark : ''}`;
      })
      .filter(Boolean)
      .join('\n');
    pieces.push({
      kind: 'episode',
      ids: shown,
      parentIds: shown.filter((id) => indexOf.has(id)),
      startAt: episode.startAt,
      lastAt: episode.lastAt,
      rank: shown.some((id) => openIds.has(id)) ? 1 : 3,
      text,
    });
  }
  if (pieces.length === 0) return null;
  const newest = (piece: AnchorPiece) => piece.lastAt ?? piece.startAt;
  pieces.sort((x, y) => x.rank - y.rank || newest(y) - newest(x));
  return { header: fill(p.earlierHeader, { hours: settings.earlierHours }), pieces };
}

/**
 * The `<earlier>` block from the budget's kept items (the header, then a subsequence of
 * `view.pieces`' texts in their order): the header, then the kept pieces oldest first,
 * `labels.participation.earlierGap` between two of them when the label is there. A reply parent
 * that a kept episode already shows is not repeated. `parentIds` the reply parents shown; ''
 * text when the header or every piece was cut.
 */
export function anchorsText(
  view: AnchorsView,
  keptItems: Array<string>,
  labels: Labels
): { text: string; parentIds: Array<string> } {
  const none = { text: '', parentIds: [] };
  if (keptItems.length < 2 || keptItems[0] !== view.header) return none;
  const kept: Array<AnchorPiece> = [];
  let next = 1;
  for (const piece of view.pieces) {
    if (next < keptItems.length && keptItems[next] === piece.text) {
      kept.push(piece);
      next += 1;
    }
  }
  const inEpisodes = new Set(kept.filter((piece) => piece.kind === 'episode').flatMap((piece) => piece.ids));
  const shown = kept
    .filter((piece) => piece.kind === 'episode' || !inEpisodes.has(piece.ids[0]))
    .sort((x, y) => x.startAt - y.startAt);
  if (shown.length === 0) return none;
  const gap = labels.participation?.earlierGap;
  const text = [view.header, shown.map((piece) => piece.text).join(gap ? `\n${gap}\n` : '\n')].join('\n');
  return { text, parentIds: [...new Set(shown.flatMap((piece) => piece.parentIds))] };
}

/** The `<participation>` and `<earlier>` pieces of a request before the budget. */
export type MemoryViews = {
  participationBuilt: ParticipationView | null;
  participationOffered: boolean;
  earlierBuilt: AnchorsView | null;
};

/**
 * `<participation>`, the persona's own exchanges on other channels without a line the request already shows, and
 * `<earlier>`, the anchors of this channel (features.anchoredWindow). Neither in a private chat.
 */
export function memoryViews(given: RequestInput & Base & PulledView): MemoryViews {
  const { config, history, neighbors, trigger, currentChannelId, channels, now, selfName } = given;
  const { labels, privateChat, timezone, nameOf, anchored, formatOptions, pulledChannels } = given;
  // `<participation>`: the persona's own exchanges on other channels (never in a private chat).
  // A line already shown in the chat, a neighbour or a pulled channel is not shown again.
  const shownIds = new Set([
    ...history.map((message) => message.id),
    ...pulledChannels.flatMap((channel) => channel.messages.map((message) => message.id)),
    ...(privateChat ? [] : (neighbors ?? [])).flatMap((neighbor) =>
      (neighbor.messages ?? []).map((message) => message.id)
    ),
  ]);
  const participationCandidate =
    trigger ?? [...history].reverse().find((message) => !message.self && !message.bot) ?? null;
  const participationBuilt = participationView(given.participation, {
    config,
    labels,
    privateChat,
    currentChannelId,
    channels,
    shownIds,
    candidateText: participationCandidate?.content ?? '',
    now,
    timezone,
    selfName,
    nameOf,
    ageMinutes: config.context.ageAfterMinutes ?? 60,
  });
  const participationOffered = Boolean(participationBuilt && participationBuilt.episodes.length > 0);
  // `<earlier>`: the anchors, this channel's lines the chat window let go of but that matter
  // (features.anchoredWindow; never in a private chat).
  const earlierBuilt = anchored
    ? anchorsView(given.participation, {
        config,
        labels,
        currentChannelId,
        history,
        trigger,
        selfId: given.selfId ?? null,
        now,
        timezone,
        selfName,
        nameOf,
        formatOptions,
      })
    : null;
  return { participationBuilt, participationOffered, earlierBuilt };
}

/** `<recent>` before the budget: its header, its entries in the view's order and what the view left out. */
export type RecentBuilt = {
  header: string;
  entries: Array<RecentEntry>;
  hidden: number;
  repeated: number;
  unnamed: number;
};

/** How `<recent>` is built and fitted: once now, and again when `<people>` shows fewer moments. */
export type Recent = {
  recentCap: number;
  interlocutorId: string | null;
  buildRecent: (askedShown: Set<string>) => RecentBuilt;
  recentSectionOf: (built: RecentBuilt | null, cap: number) => Section | null;
  recentBuilt: RecentBuilt | null;
  recentSection: Section | null;
};

/**
 * `<recent>`: the last `memory.recentHours`, built when the caller hands the store's lines over with the switch on
 * and the labels present. A moment `<people>` shows is left out: those the interlocutor's block keeps, and those of
 * the members asked about.
 */
// health: allow complexity until 2027-04-01 -- moved from buildRequest in src/behavior/prompt.js in stage 5d, a pure split
export function recentOf(given: RequestInput & Base & Room & InterlocutorBlocks & HeadSections & AskedAbout): Recent {
  const { config, now, trigger, channels, currentChannelId, labels, privateChat, interlocutor, nameOf } = given;
  const { timezone, episodesOn, caps, cost, limit, interlocutorShown, fixedSection, interlocutorSection } = given;
  const { askedAbout, askedIntended } = given;
  const recentCfg = recentSettings(config);
  const recentOn = Boolean(
    recentCfg && labels.recent?.header && labels.recent?.line && Array.isArray(given.recentLines)
  );
  const recentCap = caps.recent ?? 1200;
  const interlocutorId = memberIdOf(interlocutor?.id);
  const recentFocus = [trigger?.authorId, interlocutorId, ...askedAbout.map((profile) => profile?.id)]
    .map(memberIdOf)
    .filter((id): id is string => Boolean(id));
  const recentAudience =
    typeof given.recentAudience === 'function'
      ? // The turn's rule of which channels' lines this turn may show.
        (given.recentAudience as (channelId: string | null) => boolean)
      : (channelId: string | null) => channelId === currentChannelId;
  const recentProfiles: Array<unknown> =
    recentOn && !privateChat && episodesOn && labels.recent?.episode && Array.isArray(given.candidateProfiles)
      ? (given.candidateProfiles as Array<unknown>)
      : [];
  const interlocutorKeys = new Set(
    recentProfiles.length > 0 &&
      interlocutorId !== null &&
      interlocutorShown.episodes > 0 &&
      fitSections([fixedSection, interlocutorSection], limit, cost).kept.interlocutor.length > 0
      ? topEpisodes(interlocutor?.episodes, interlocutorShown.episodes).map((ep) => episodeKey(interlocutorId, ep))
      : []
  );
  // buildRecent runs only while `<recent>` is on: its settings and labels are there.
  const buildRecent = (askedShown: Set<string>): RecentBuilt => {
    const view = recentView({
      lines: given.recentLines,
      profiles: recentProfiles,
      now,
      hours: recentCfg!.hours,
      focusIds: recentFocus,
      excludeEpisodeKeys: new Set([...interlocutorKeys, ...askedShown]),
      isShown: recentAudience,
      perMember: RECENT_EPISODES_PER_MEMBER,
    });
    // recentView's items: the stored lines and moments it chose, which it returns as plain objects.
    const items = view.items as Array<RecentItem>;
    const { entries, unnamed } = recentEntries(items, { labels, timezone, currentChannelId, channels, nameOf });
    return {
      header: fill(labels.recent!.header, { hours: recentCfg!.hours }),
      entries,
      hidden: view.hidden,
      repeated: view.repeated,
      unnamed,
    };
  };
  // One item per entry after the header, in the view's order: the budget keeps them from the top.
  const recentSectionOf = (built: RecentBuilt | null, cap: number): Section | null =>
    built && built.entries.length > 0
      ? { name: 'recent', cap, keep: 'first', items: [built.header, ...built.entries.map((entry) => entry.text)] }
      : null;
  const recentBuilt = recentOn ? buildRecent(askedIntended) : null;
  const recentSection = recentSectionOf(recentBuilt, recentCap);
  return { recentCap, interlocutorId, buildRecent, recentSectionOf, recentBuilt, recentSection };
}

/** The `<participation>` and `<earlier>` sections, each the header then one item per piece. */
export type MemorySections = { participationSection: Section | null; earlierSection: Section | null };

/**
 * `<participation>`: the header, then one item per episode in budget priority, each paying for its channel line.
 * `<earlier>`: the header, then one item per anchor in its priority order.
 */
export function memorySections(given: MemoryViews & Room): MemorySections {
  const { participationOffered, participationBuilt, earlierBuilt, caps } = given;
  const participationSection: Section | null =
    participationOffered && participationBuilt
      ? {
          name: 'participation',
          cap: caps.participation ?? 6000,
          keep: 'first',
          items: [participationBuilt.header, ...participationBuilt.episodes.map((episode) => episode.budgetText)],
        }
      : null;
  // `<earlier>`: the header, then one item per anchor in its priority order (anchorsView); right
  // after the chat and the pulled block it continues back in time.
  const earlierSection: Section | null = earlierBuilt
    ? {
        name: 'earlier',
        cap: caps.earlier ?? 2500,
        keep: 'first',
        items: [earlierBuilt.header, ...earlierBuilt.pieces.map((piece) => piece.text)],
      }
    : null;
  return { participationSection, earlierSection };
}

/**
 * `<recent>` as one piece: the header, then the entries kept (a subsequence of the offered ones, in their order)
 * oldest first, their reads noted. Its counts, null when it was off or its view held nothing.
 */
export function keptRecent(
  fit: Fit,
  recentBuilt: RecentBuilt | null,
  memoryReads: Array<MemoryRead>
): RecentCounts | null {
  const { kept, stats } = fit;
  let recent = null;
  if (recentBuilt) {
    const keptRecent = kept.recent ?? [];
    const shown = [];
    if (keptRecent.length >= 2 && keptRecent[0] === recentBuilt.header) {
      let next = 1;
      for (const entry of recentBuilt.entries) {
        if (next < keptRecent.length && keptRecent[next] === entry.text) {
          shown.push(entry);
          next += 1;
        }
      }
    }
    shown.sort((a, b) => a.at - b.at);
    for (const entry of shown) if (entry.read) memoryReads.push({ ...entry.read, block: 'recent' });
    kept.recent = shown.length > 0 ? [[recentBuilt.header, ...shown.map((entry) => entry.text)].join('\n')] : [];
    if (stats.recent)
      stats.recent = { ...stats.recent, kept: shown.length, dropped: recentBuilt.entries.length - shown.length };
    // Counted only when the view held something: an item, or one hidden, repeated or unnamed.
    const { entries, hidden, repeated, unnamed } = recentBuilt;
    if (entries.length > 0 || hidden + repeated + unnamed > 0) {
      recent = {
        lines: shown.filter((entry) => entry.kind === 'line').length,
        episodes: shown.filter((entry) => entry.kind === 'episode').length,
        cut: entries.length - shown.length,
        hidden,
        repeated,
        unnamed,
      };
    }
  }
  return recent;
}

/**
 * `<participation>` as one piece: the header, then the episodes kept regrouped by channel in display order, their
 * reads noted. The header alone, or episodes without it, make no block.
 */
export function keptParticipation(
  fit: Fit,
  participationBuilt: ParticipationView | null,
  memoryReads: Array<MemoryRead>
): void {
  const { kept, stats } = fit;
  if (participationBuilt) {
    const keptItems = kept.participation ?? [];
    const shown = [];
    if (keptItems.length >= 2 && keptItems[0] === participationBuilt.header) {
      let next = 1;
      for (const episode of participationBuilt.episodes) {
        if (next < keptItems.length && keptItems[next] === episode.budgetText) {
          shown.push(episode);
          next += 1;
        }
      }
    }
    const text = participationText(participationBuilt, shown);
    if (text)
      for (const episode of shown)
        if (episode.itemId) memoryReads.push({ kind: 'participation', id: episode.itemId, block: 'participation' });
    kept.participation = text ? [text] : [];
    stats.participation = {
      ...(stats.participation ?? { used: 0, kept: 0, dropped: 0 }),
      offered: participationBuilt.offered,
      shown: shown.length,
      cut: participationBuilt.offered - shown.length,
      deduped: participationBuilt.deduped,
    };
  }
}

/** `<earlier>` as one piece: the header and the anchors kept, oldest first. */
export function keptEarlier(
  fit: Fit,
  given: MemoryViews & MemorySections & { labels: Labels }
): { text: string; parentIds: Array<string> } | null {
  const { kept } = fit;
  const { earlierSection, earlierBuilt, labels } = given;
  let earlierShown = null;
  if (earlierSection && earlierBuilt) {
    earlierShown = anchorsText(earlierBuilt, kept.earlier ?? [], labels);
    kept.earlier = earlierShown.text ? [earlierShown.text] : [];
  }
  return earlierShown;
}
