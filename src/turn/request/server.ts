// The server and its places as a request shows them: the `<server>` entries of the current channel and the channels
// this turn shows beside it, the `<about_chat>` lines of how the server talks and what people taught the persona, and
// the `<lore>` entries the transcript matches. buildRequest and buildDiaryPlanRequest (src/behavior/prompt.js) call
// them.

import { fill } from '../../format.js';
import { channelActivity, isConfirmed, matchLore, renderChannel } from '../../memory/index.js';
import { ID_DIGITS } from '../../memory/mentions.ts';
import { topByRank } from '../../memory/ranking.js';
import { resolveChatText } from './text.ts';
import type { Claim, LabelGroup, Labels, Message, NameOf, RequestConfig } from './types.ts';

/** A channel's stored note (store.listChannels), or the current channel's stand-in. */
export type StoredChannel = {
  readonly id: string;
  readonly name: string;
  readonly category?: string | null;
  readonly topic?: string | null;
  readonly purpose?: string;
  readonly topics?: string;
  readonly tone?: string;
  readonly days?: Record<string, number>;
  readonly lastMessageAt?: number | null;
  readonly topWriters?: Array<{ id: string; count: number }>;
};

/** What the guild's memory holds about the server (store.getGuild), as `<about_chat>` and `<self_facts>` read it. */
export type GuildMemory = {
  readonly patterns?: string;
  readonly starters?: string;
  readonly injokes?: Array<string>;
  readonly learned?: unknown;
  readonly self?: Array<string>;
  readonly emojiUsage?: unknown;
};

/** `learnedText`'s settings from the live config. */
export type LearnedConfig = { max: number; halfLifeDays: number; confirmAfter: number | undefined };

/** One thing people taught the persona (`guild.learned`). */
type LearnedItem = Claim & { readonly text?: string; readonly from?: unknown };

/** One stored lorebook entry. */
type LoreEntry = { readonly id?: unknown; readonly title?: string; readonly text?: string };

/**
 * A stand-in channel entry for `serverItems` when the current channel has no
 * stored note yet (see below): the platform's facts (name, category, topic) read off
 * whichever `history` message actually belongs to `currentChannelId` (every
 * message `buildRequest` is given for `<chat>` comes from that one channel,
 * see src/protocol/events.js#Message) -- so the persona still knows
 * where it is even before the analyzer has touched this channel once. `null`
 * when no message carries a usable channel name (nothing to render then; a
 * channel with counters but no name never happens in practice).
 */
export function currentChannelFallback(
  currentChannelId: string | null | undefined,
  history: Array<Message>
): StoredChannel | null {
  if (!currentChannelId) return null;
  const source = [...history]
    .reverse()
    .find((m): m is Message & { channelName: string } => m.channelId === currentChannelId && Boolean(m.channelName));
  if (!source) return null;
  return {
    id: currentChannelId,
    name: source.channelName,
    category: source.channelCategory ?? null,
    topic: source.channelTopic ?? null,
    purpose: '',
    topics: '',
    tone: '',
    days: {},
    lastMessageAt: null,
    topWriters: [],
  };
}

/**
 * Render the `<server>` block: ONLY the channels that matter for this turn --
 * the current channel first, marked via `labels.server.currentMark` (its
 * stored note in full, or -- when nothing is stored for it yet, see
 * `currentChannelFallback` above -- just its platform facts and activity), then
 * the neighbour channels that actually contributed messages to
 * `<other_channels>` this turn, `neighborChannelIds` (matched by id, never by
 * name -- a rename or a same-named channel elsewhere must never cross-wire
 * two entries), each in full too. Every other stored channel note is left
 * out on purpose: on a large server most of them are irrelevant to this
 * reply and would eat most of the block's budget for nothing. A neighbour
 * id with no stored note is skipped, not synthesized -- unlike the current
 * channel, a neighbour the persona is not replying in does not need a
 * where-am-I fallback. A pulled channel (`<channel_view>`) joins the list
 * the same way: the caller puts its id ahead of the neighbours'. An entry
 * whose id is in `readOnlyIds` (a channel the bot can read but not write in)
 * carries `labels.server.readOnly` (src/memory/channels.js#renderChannel,
 * never on the current channel).
 */
export function serverItems(
  channels: Array<StoredChannel>,
  currentChannelId: string | null,
  neighborChannelIds: Array<string>,
  history: Array<Message>,
  now: number,
  activityCfg: RequestConfig['context']['channelActivity'],
  labels: Labels,
  nameOf: NameOf,
  readOnlyIds: Set<string> = new Set(),
  diaryChannelIds: Set<string> = new Set(),
  ids: Array<string | null> | null = null
): Array<string> {
  const byId = new Map<string | null, StoredChannel>(channels.map((channel) => [channel.id, channel]));
  const current = byId.get(currentChannelId) ?? currentChannelFallback(currentChannelId, history);
  const neighborEntries = [...new Set(neighborChannelIds)]
    .filter((id) => id !== currentChannelId)
    .map((id) => byId.get(id))
    .filter((channel): channel is StoredChannel => Boolean(channel));
  const ordered = current ? [current, ...neighborEntries] : neighborEntries;
  // The collector: a channel of the map that has a stored entry (the current channel's fallback has none).
  if (Array.isArray(ids)) for (const channel of ordered) ids.push(byId.has(channel.id) ? channel.id : null);
  return ordered.map((channel) =>
    renderChannel(
      {
        ...channel,
        purpose: resolveChatText(channel.purpose, nameOf),
        topics: resolveChatText(channel.topics, nameOf),
        tone: resolveChatText(channel.tone, nameOf),
      },
      labels,
      {
        current: channel.id === currentChannelId,
        activity: channelActivity(channel, now, activityCfg),
        now,
        nameOf,
        readOnly: readOnlyIds.has(channel.id),
        // A place of the persona's own diary (its mirrors): marked so it is found by name like any channel.
        diary: diaryChannelIds.has(channel.id),
      }
    )
  );
}

/** A stored `from`: a `<@id>`/`<@!id>` token or a bare id, in the shared id range. */
const TEACHER_ID_RE = new RegExp(`^(?:<@!?(${ID_DIGITS})>|(${ID_DIGITS}))$`);

/** The member id inside a stored `from` (`<@id>`/`<@!id>`, or a bare id), or null. */
function teacherId(from: unknown): string | null {
  if (typeof from !== 'string') return null;
  const match = TEACHER_ID_RE.exec(from.trim());
  return match ? (match[1] ?? match[2] ?? null) : null;
}

/**
 * The `learnedCfg` of `learnedText` read from the live config at the moment
 * of use: `memory.maxLearned` (default 20), `memory.learnedHalfLifeDays`
 * (default 720), `memory.confirmAfter` (unset when absent).
 */
export function learnedConfig(config: Pick<RequestConfig, 'memory'>): LearnedConfig {
  return {
    max:
      config.memory?.maxLearned !== undefined && Number.isInteger(config.memory.maxLearned)
        ? config.memory.maxLearned
        : 20,
    halfLifeDays: typeof config.memory?.learnedHalfLifeDays === 'number' ? config.memory.learnedHalfLifeDays : 720,
    confirmAfter: typeof config.memory?.confirmAfter === 'number' ? config.memory.confirmAfter : undefined,
  };
}

/**
 * The `labels.aboutChat.learned` line's `{text}`: the top `learnedCfg.max`
 * stored guild items (`{ id, text, from?, weight, firstSeen, lastSeen }`, the
 * same atomic items as a member's details) by RANK (decayed with
 * `learnedCfg.halfLifeDays`), in rank order, joined with `'; '`. Each item is
 * `aboutChat.learnedItem` (`{text}`/`{who}`) when its `from` resolves through
 * `nameOf` to a name, else `aboutChat.learnedItemNoFrom` (`{text}`); a missing
 * item label falls back to the next simpler form, then to the bare text. An
 * item below `learnedCfg.confirmAfter` gets `aboutChat.unsureMark` appended
 * when that label exists. `''` when there is nothing to show.
 * `learned` is `guild.learned`, `a` is `labels.aboutChat`, `learnedCfg` see `learnedConfig`.
 */
export function learnedText(
  learned: unknown,
  a: LabelGroup,
  learnedCfg: Partial<LearnedConfig>,
  nameOf?: NameOf | null
): string {
  if (!Array.isArray(learned) || learned.length === 0) return '';
  // topByRank keeps the stored items it is given, which it returns as plain objects.
  const top = topByRank(learned as Array<LearnedItem>, learnedCfg.max, learnedCfg.halfLifeDays) as Array<LearnedItem>;
  return top
    .map((item) => {
      const text = resolveChatText(item?.text, nameOf) ?? '';
      const id = teacherId(item?.from);
      const who = id && typeof nameOf === 'function' ? nameOf(id) : null;
      const noFrom = a.learnedItemNoFrom ? fill(a.learnedItemNoFrom, { text }) : text;
      const line = who && a.learnedItem ? fill(a.learnedItem, { text, who }) : noFrom;
      return !isConfirmed(item, learnedCfg.confirmAfter) && a.unsureMark ? line + a.unsureMark : line;
    })
    .join('; ');
}

/**
 * The `<about_chat>` lines: how this server talks (`patterns`), how people
 * start conversations (`starters`), the in-jokes, then what people taught the
 * persona (`guild.learned`, see `learnedText` above) -- the last one only when
 * `labels.aboutChat.learned` exists, so an older labels.json simply never
 * renders it. Every stored text is token-resolved via `nameOf`.
 * `learnedCfg` carries `max`/`halfLifeDays`/`confirmAfter`, read by the
 * caller from `memory.maxLearned`/`memory.learnedHalfLifeDays`/
 * `memory.confirmAfter` at the moment of use.
 */
export function aboutChatItems(
  guildMemory: GuildMemory | null | undefined,
  labels: Labels,
  nameOf: NameOf,
  learnedCfg: Partial<LearnedConfig> = {},
  ids: Array<string | null> | null = null
): Array<string> {
  const a = labels.aboutChat;
  const items: Array<string> = [];
  // The collector: the two prose notes of the guild are rows of their own; the lists have no stable item ids.
  const push = (text: string, id: string | null = null) => {
    items.push(text);
    if (Array.isArray(ids)) ids.push(id);
  };
  if (guildMemory?.patterns)
    push(fill(a.patterns, { text: resolveChatText(guildMemory.patterns, nameOf) }), 'patterns');
  if (guildMemory?.starters)
    push(fill(a.starters, { text: resolveChatText(guildMemory.starters, nameOf) }), 'starters');
  if (guildMemory?.injokes?.length) {
    push(fill(a.injokes, { text: guildMemory.injokes.map((text) => resolveChatText(text, nameOf)).join('; ') }));
  }
  if (a?.learned) {
    const text = learnedText(guildMemory?.learned, a, learnedCfg, nameOf);
    if (text) push(fill(a.learned, { text }));
  }
  return items;
}

/**
 * Render the `<lore>` block's entries: whatever `matchLore` (src/memory/lore.js)
 * surfaces from the last `lore.scanMessages` transcript messages plus the
 * trigger, via `labels.lore.entry`. `[]` when there is no stored lore, no
 * match, or `labels.lore.entry` is missing (an older labels.json never
 * breaks -- the block is simply omitted). `text` is token-resolved via
 * `nameOf`; `title` never is (it is the lorebook's identity, not a mention).
 */
export function loreItems(
  loreEntries: unknown,
  history: Array<Message>,
  trigger: Message | null | undefined,
  labels: Labels,
  loreCfg: RequestConfig['lore'],
  nameOf: NameOf,
  ids: Array<string | null> | null = null
): Array<string> {
  const entry = labels.lore?.entry;
  if (!entry) return [];
  // The stored lorebook (store.getLore), read loosely like any stored list.
  const entries = Array.isArray(loreEntries) ? (loreEntries as Array<LoreEntry>) : [];
  if (entries.length === 0) return [];

  const scan = Math.max(0, loreCfg?.scanMessages ?? 30);
  const recentTexts = history
    .slice(-scan)
    .map((m) => m.content ?? '')
    .filter(Boolean);
  if (trigger?.content) recentTexts.push(trigger.content);

  // matchLore keeps the entries it is given, which it returns as plain objects.
  const matched = matchLore(entries, recentTexts, { maxMatches: loreCfg?.maxMatches ?? 8 }) as Array<LoreEntry>;
  if (Array.isArray(ids)) for (const lore of matched) ids.push(typeof lore.id === 'string' && lore.id ? lore.id : null);
  return matched.map((lore) => fill(entry, { title: lore.title, text: resolveChatText(lore.text, nameOf) }));
}
