// The recall runner: the server part of a lookup. When the lookup classifier
// names word forms, name forms or a date range (src/behavior/recall.js
// parseLookupAnswer), this module searches the server's own history through
// Discord's search (src/discord/search.js) and has one helper request
// (prompts/recall-summary.md) say what that history answers, optionally
// singling out one stretch the persona gets verbatim. Steps: the people the
// name forms point at (stored profiles, Discord's member search for a Latin
// form), the queries one after another (discord.js's REST client runs the
// requests of one guild's search route strictly one at a time -- a
// SequentialHandler per route bucket and guild in @discordjs/rest -- so
// sending them together would only queue them there), the hits filtered
// (other bots, channels the pull rail refuses for this destination, the
// turn's own chat), clustered, the windows around the clusters fetched
// together (channel routes, queued per channel), captioned from the media
// cache only, then the summary. Rails: `features.recall`, server turns and
// private chats run on behalf of their partner (the pull rail then keeps what
// the partner can view), the daily request cap (`llm.capLeft`), `recall.maxPerDay` runs a day
// (state.json `recallDay`/`recallCount`), and `recall.timeoutMs` for the
// whole run, after which it is abandoned. Inside that budget: no search is
// sent once half of it is gone, a search still out at 60 % is cut (what the
// earlier ones found is kept), and the summary is asked only when at least
// `recall.minSummaryMs` is left. A summary that fails, times out or is
// skipped never costs the result: the verbatim stretch of the first-ranked
// window (recall.js fallbackWindow) is returned without a text.
// Before any Discord request the same forms are matched against the
// persona's stored memory (recall.js matchMemory; read-only store calls, no
// request), under the gates the reply prompt applies to each store, and the
// items go to the summary as `<memory>`: they alone are enough to ask it,
// but they are notes, not chat, so they are never returned verbatim. The
// archive (src/memory/archive.js) is a fifth source of those items, streamed
// over the months asked (recall.js scanArchive); the record
// (src/memory/record.js) of the last days is read for a dated or "recently"
// question (recall.js matchRecord) and its windows join Discord's. Before any
// archive entry or record line is matched, the audience rule of the turn's
// channel refuses what the pull rail would (by the entry's `scope.channel`,
// the line's channel), and a private entry or line passes only on a private
// turn with its own member.
// Logs carry counts, ids and codes only: never a form, a name or a message.
// What a run found and chose is diagnosed from the trace file instead
// (`features.recallTrace`, data/guilds/<id>/recall-trace.jsonl, see traceLine):
// it is memory about real people, kept under data/ only.

import { log } from '../log.js';
import { audienceOf } from '../discord/collect.js';
import { audienceAllows, checkPull } from '../discord/pull-fetch.js';
import { fetchAround, searchMembers, searchMessages } from '../discord/search.js';
import { helperRequestOptions, railReason } from '../llm/openrouter.js';
import { oneLine } from '../memory/clamp.js';
import { liveRecent, recentSettings } from '../memory/recent.js';
import { bumpDaily, countToday } from '../time.js';
import { audienceCovers } from './elsewhere.js';
import { classifierTextModel } from './mention.js';
import { pullPictures } from './pull.js';
import {
  buildRecallRequest,
  clusterHits,
  clusterScore,
  cutStretch,
  dropChatHits,
  fallbackWindow,
  isRecentCue,
  matchMemory,
  matchRecord,
  mergeWindows,
  parseRecallAnswer,
  queryKey,
  rankClusters,
  rareFormKeys,
  recallContext,
  recallSettings,
  renderRecallWindows,
  sampleOffsets,
  scanArchive,
  searchPlan,
} from './recall.js';

/** The state.json fields of the daily recall counter. */
export const RECALL_DAILY = Object.freeze({ dayKey: 'recallDay', countKey: 'recallCount' });
/** The share of `recall.timeoutMs` after which no further search is sent. */
const SEARCH_SHARE = 0.5;
/** The share of `recall.timeoutMs` at which a search still out is cut: the windows and the summary need the rest. */
const PREPARE_SHARE = 0.6;
const TIMEOUT = Symbol('timeout');
const DEFAULT_TIMERS = Object.freeze({
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (timer) => clearTimeout(timer),
});
// A name form Discord's member search can match: Latin letters (at least one), digits, `.`, `_`, `'`, `-`, spaces.
const LATIN_FORM_RE = /^[\p{Script=Latin}\p{N} ._'-]+$/u;
const LATIN_LETTER_RE = /\p{Script=Latin}/u;

/** Whether the parsed server part asks anything. */
function asksServer(server) {
  if (!server || typeof server !== 'object') return false;
  const some = (list) => Array.isArray(list) && list.length > 0;
  return some(server.forms) || some(server.who) || Number.isFinite(server.from) || Number.isFinite(server.to);
}

/** A raw search hit (src/discord/search.js) as the clustering reads it; `queries` the keys of the queries that found it. */
function hitFrom(raw) {
  return {
    id: raw.id,
    channelId: raw.channel_id,
    ts: Date.parse(raw.timestamp),
    authorId: raw.author?.id ?? null,
    bot: raw.author?.bot === true,
    username: raw.author?.username ?? null,
    queries: new Set(),
  };
}

/** A fresh stats record of one run. */
function emptyStats() {
  return { memory: 0, archived: 0, record: 0, planned: 0, queries: 0, failed: 0, hits: 0, inChatDropped: 0, kept: 0, clusters: 0, selfClusters: 0, windows: 0, summary: null, ms: 0 };
}

/** The start (epoch ms, UTC) of the month `months - 1` months before the month of `ms`: the last `months` archive segments. */
function monthsBack(ms, months) {
  const day = new Date(ms);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth() - (months - 1), 1);
}

/** The last message's time of a window, or -Infinity. */
function windowEnd(window) {
  const messages = window?.messages ?? [];
  return messages.length > 0 && Number.isFinite(messages[messages.length - 1].ts) ? messages[messages.length - 1].ts : -Infinity;
}

/** An epoch-ms time as an ISO string, or null. */
function isoOf(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * A fresh trace record of one run (`features.recallTrace`), filled as the
 * run goes (clusters, summary) and completed by traceLine.
 */
function newTrace({ started, channelId, candidate, server }) {
  const from = Number.isFinite(server?.from) ? server.from : null;
  const to = Number.isFinite(server?.to) ? server.to : null;
  return {
    at: isoOf(started),
    channelId,
    triggerId: typeof candidate?.id === 'string' ? candidate.id : null,
    forms: Array.isArray(server?.forms) ? [...server.forms] : [],
    who: Array.isArray(server?.who) ? [...server.who] : [],
    when: from !== null || to !== null ? { from: isoOf(from), to: isoOf(to) } : null,
    clusters: [],
    summary: { answer: null, stretch: null, text: null },
  };
}

/**
 * The trace line of a finished run: `{ at, channelId, triggerId, forms, who,
 * when, hits, inChatDropped, clusters, summary, lookupChars }`. `summary`
 * `{ answer, stretch, text }`: `answer` `text` | `nothing` | `fallback` (null
 * when no summary was asked or reached), `stretch` null or `{ n, channelId,
 * channelName, lines }` (the `<found>` section number and the very lines the
 * persona gets), `text` the summary's text. `lookupChars`: the characters
 * the run hands to the turn (the text and the stretch lines; the turn's own
 * labels around them not counted).
 */
function traceLine(trace, out) {
  const text = typeof out?.text === 'string' ? out.text : null;
  const stretch = out?.stretch ?? null;
  return {
    at: trace.at,
    channelId: trace.channelId,
    triggerId: trace.triggerId,
    forms: trace.forms,
    who: trace.who,
    when: trace.when,
    hits: out?.stats?.hits ?? 0,
    inChatDropped: out?.stats?.inChatDropped ?? 0,
    clusters: trace.clusters,
    summary: {
      answer: trace.summary.answer,
      stretch: stretch ? { n: trace.summary.stretch, channelId: stretch.channelId, channelName: stretch.channelName ?? null, lines: stretch.lines } : null,
      text,
    },
    lookupChars: [...(text ?? '')].length + [...(stretch?.lines ?? '')].length,
  };
}

/** The kind of a failed summary request: `timeout` for a request cut at its limit, else `failed`. */
function summaryFailure(err) {
  return err?.name === 'TimeoutError' ? 'timeout' : 'failed';
}

/**
 * @typedef {object} RecallStretch
 * @property {string} channelId
 * @property {string|null} channelName
 * @property {number} startTs   The time of its first kept line.
 * @property {string} lines     The window rendered without `#n` indices (captions included, matched lines marked),
 *                              cut to `recall.stretchChars` by whole lines from its far ends, never a matched one.
 */

/**
 * The recall runner for the turn (task R2 wires it beside the web search).
 * @param {object} deps
 * @param {{ config: object, prompts: object }} deps.hot  Live config + prompts; read at the moment of use.
 * @param {object} deps.store      `state` (`data`, `markDirty`) and `listUserProfiles` (src/memory/store.js);
 *   read only, when present: `getLore`, `getGuild` (its `learned`), `getRecent`. Never `getPrivate`.
 * @param {object} deps.llm        From createLlm(): `complete`, `capLeft`.
 * @param {object|null} [deps.describer]  From createDescriber (src/memory/describe.js): only its
 *   `cachedDescriptions` is used, never a fresh caption.
 * @param {{ iterate: Function }|null} [deps.archive]  From createArchive (src/memory/archive.js): only
 *   `iterate` is used (read only). Without it the archive is not searched.
 * @param {{ iterate: Function }|null} [deps.record]  From createRecord (src/memory/record.js): only
 *   `iterate` is used (read only). Without it the record is not read.
 * @param {() => number} [deps.now]
 * @param {{ set: Function, clear: Function }} [deps.timers]  setTimeout / clearTimeout (tests inject fakes).
 * @returns {{ run: (args: { guild: object, guildId?: string, channel: object, partner?: object|null, selfId: string, selfName: string,
 *   history?: object[], candidate: { authorName?: string, content?: string }, server: { forms: string[], who: string[],
 *   from: number|null, to: number|null }|null }) => Promise<{ text: string|null, stretch: RecallStretch|null,
 *   people: { id: string, name: string, username: string, count: number, newestTs: number|null }[], stats: object }>,
 *   available: () => boolean }}
 */
export function createRecall({ hot, store, llm, describer = null, archive = null, record = null, now = Date.now, timers = DEFAULT_TIMERS }) {
  /** Whether `llm.maxRequestsPerDay` is spent today: the summary would be refused. */
  function capSpent() {
    return typeof llm?.capLeft === 'function' && llm.capLeft() <= 0;
  }

  /** The summary prompt, or null when it is missing or blank. */
  function summaryPrompt() {
    const prompt = hot.prompts?.['recall-summary'];
    return typeof prompt === 'string' && prompt.trim() ? prompt : null;
  }

  /** Whether `recall.maxPerDay` runs are spent today (read only). */
  function dailySpent(settings) {
    return countToday(store.state.data, RECALL_DAILY, now()) >= settings.maxPerDay;
  }

  /**
   * Whether a run could search now: the switch on, the summary prompt
   * present, the daily request cap and `recall.maxPerDay` not spent. Read
   * only; for a caller deciding whether to ask for the server part at all.
   * @returns {boolean}
   */
  function available() {
    try {
      const settings = recallSettings(hot.config);
      return Boolean(settings) && summaryPrompt() !== null && !capSpent() && !dailySpent(settings);
    } catch {
      return false;
    }
  }

  /**
   * The people the `who` forms point at, at most `maxPeople`: per form, the
   * stored profiles with that name or alias (exact, any case), then -- for a
   * Latin form no profile matched -- Discord's member search (prefix match),
   * other bots left out. A member search is not sent once `searchUntil` is
   * past; `beforeRequest` runs before each one.
   */
  async function findPeople({ guild, guildId, who, maxPeople, selfId, signal, searchUntil, beforeRequest }) {
    const found = new Map();
    if (maxPeople <= 0 || !Array.isArray(who) || who.length === 0) return [];
    let profiles = null;
    for (const form of who) {
      if (found.size >= maxPeople || signal.aborted) break;
      profiles ??= store.listUserProfiles?.(guildId) ?? [];
      let matched = false;
      for (const profile of profiles) {
        if (!profile?.id) continue;
        const names = [...(Array.isArray(profile.names) ? profile.names : []), ...(Array.isArray(profile.aliases) ? profile.aliases : []).map((a) => a?.name)];
        if (!names.some((name) => typeof name === 'string' && oneLine(name).toLowerCase() === form)) continue;
        matched = true;
        if (found.has(profile.id) || found.size >= maxPeople) continue;
        found.set(profile.id, { id: profile.id, name: oneLine(profile.names?.[0]) || form, username: '' });
      }
      if (matched || found.size >= maxPeople || !LATIN_FORM_RE.test(form) || !LATIN_LETTER_RE.test(form) || now() >= searchUntil) continue;
      beforeRequest();
      const members = await searchMembers(guild, form, maxPeople, { signal });
      for (const member of members ?? []) {
        if (member.bot && member.id !== selfId) continue;
        const known = found.get(member.id);
        if (known) {
          known.username ||= member.username ?? '';
          continue;
        }
        if (found.size >= maxPeople) break;
        found.set(member.id, { id: member.id, name: member.nick ?? member.globalName ?? member.username ?? '', username: member.username ?? '' });
      }
    }
    return [...found.values()];
  }

  /**
   * The recent lines this turn may show: the live ones (`memory.recentHours`,
   * none with `features.recent` off), from the turn's own channel or a channel
   * whose audience covers it -- the rule of the turn's `<recent>` block
   * (src/behavior/turn.js recentInput, server side). In a private chat: from
   * a channel its `partner` can view (the pull rail's private-chat rule,
   * src/discord/pull-fetch.js#audienceAllows), as its hits are.
   */
  function shownRecentLines(config, guild, guildId, channel, partner) {
    const settings = recentSettings(config);
    if (!settings || typeof store.getRecent !== 'function') return [];
    const lines = liveRecent(store.getRecent(guildId)?.lines, { now: now(), hours: settings.hours });
    if (lines.length === 0) return [];
    const here = channel.guild ? audienceOf(channel) : null;
    const covers = (source) => (channel.guild ? audienceCovers(here, audienceOf(source)) : audienceAllows(channel, source, config, { partner }));
    const allowed = new Map();
    const shown = (id) => {
      if (typeof id !== 'string' || !id) return false;
      if (id === channel.id) return true;
      if (!allowed.has(id)) allowed.set(id, covers(guild?.channels?.cache?.get?.(id) ?? null));
      return allowed.get(id);
    };
    return lines.filter((line) => shown(line.channelId));
  }

  /**
   * The stored memory the forms point at (recall.js matchMemory), at most
   * `recall.memoryItems`, with the display names of the stored members, or
   * no item. Read-only store calls, no request. The gates are the reply
   * prompt's: nothing with `features.memory` off; members' moments with
   * `features.episodes` on, lore with `features.lore` on, learned items with
   * memory on (all three guild-wide), recent lines by shownRecentLines. A
   * private layer is never read. A store read that throws gives no item.
   * The archive (`deps.archive`): the entries recorded since the start of
   * the `when:` range, else over the last `recall.archiveMonths` months (0:
   * none without a range), streamed through recall.js scanArchive with
   * `allowEntry` applied before matching; archived episodes, recent lines and
   * participation episodes under the same switches as their hot stores. On a
   * private turn the partner's own private archive is read too. An archive
   * read that throws logs `recall: archive failed` and costs only its items.
   * `recent` ranks as a vague "recently" (isRecentCue).
   */
  async function storedMemory({ config, settings, guild, guildId, channel, partner, server, recent, allowEntry, privateUserId, signal }) {
    const none = { items: [], nameOf: () => null };
    const forms = Array.isArray(server.forms) ? server.forms : [];
    const who = Array.isArray(server.who) ? server.who : [];
    if (settings.memoryItems <= 0 || config.features?.memory === false || (forms.length === 0 && who.length === 0)) return none;
    try {
      const features = config.features ?? {};
      const profiles = typeof store.listUserProfiles === 'function' ? (store.listUserProfiles(guildId) ?? []) : [];
      const names = new Map(profiles.filter((p) => p?.id).map((p) => [String(p.id), typeof p.names?.[0] === 'string' ? p.names[0] : null]));
      const ranged = Number.isFinite(server.from) || Number.isFinite(server.to);
      let archived = [];
      if (typeof archive?.iterate === 'function' && (ranged || settings.archiveMonths > 0)) {
        const from = Number.isFinite(server.from) ? server.from : monthsBack(now(), Math.max(1, settings.archiveMonths));
        const query = { from: new Date(from).toISOString() };
        // Entries are recorded after what they observed: the months from the range's start on.
        const entries = (async function* () {
          yield* archive.iterate(guildId, query);
          if (privateUserId) yield* archive.iterate(guildId, { ...query, privateUserId });
        })();
        const switchedOff = new Set([
          ...(features.episodes === false ? ['episode'] : []),
          ...(features.recent === false ? ['recent'] : []),
          ...(features.participation === false ? ['participation'] : []),
        ]);
        try {
          archived = await scanArchive(entries, {
            forms,
            who,
            profiles,
            from: server.from ?? null,
            to: server.to ?? null,
            timezone: config.bot?.timezone,
            recent,
            allow: (entry) => !switchedOff.has(entry?.itemKind) && allowEntry(entry),
            max: settings.memoryItems,
            signal,
          });
        } catch (err) {
          log.warn('recall: archive failed', { channel: channel.id, name: err?.name ?? null });
        }
      }
      const items = matchMemory({
        forms,
        who,
        profiles: features.episodes !== false ? profiles : profiles.map((p) => ({ ...p, episodes: [] })),
        lore: features.lore !== false && typeof store.getLore === 'function' ? (store.getLore(guildId) ?? []) : [],
        learned: typeof store.getGuild === 'function' ? (store.getGuild(guildId)?.learned ?? []) : [],
        recentLines: shownRecentLines(config, guild, guildId, channel, partner),
        archived,
        from: server.from ?? null,
        to: server.to ?? null,
        max: settings.memoryItems,
        timezone: config.bot?.timezone,
        recent,
      });
      return { items, nameOf: (id) => names.get(String(id)) ?? null };
    } catch (err) {
      log.warn('recall: memory failed', { channel: channel.id, name: err?.name ?? null });
      return none;
    }
  }

  /**
   * The record windows of a dated or "recently" question (recall.js
   * matchRecord), or none: without `deps.record`, with `recall.recordDays`
   * 0, or for a question with neither a `when:` range nor a recent cue. The
   * forms are the server forms and the name forms; the members are the
   * people found, matched by id and by their stored names and aliases. Read
   * through `allowLine` (the audience and private-owner rule) before
   * matching; on a private turn the partner's private record is read after
   * the guild's. At most `recall.maxClusters` windows. A read that throws
   * logs `recall: record failed` and gives none.
   */
  async function recordWindowsFor({ settings, guild, guildId, server, people, recent, allowLine, privateUserId, ownIds, selfName, signal, channelId }) {
    const ranged = Number.isFinite(server.from) || Number.isFinite(server.to);
    if (typeof record?.iterate !== 'function' || settings.recordDays <= 0 || (!ranged && !recent)) return [];
    try {
      const profiles = typeof store.listUserProfiles === 'function' ? (store.listUserProfiles(guildId) ?? []) : [];
      const ids = new Set(people.map((p) => String(p.id)));
      const stored = new Map(profiles.filter((p) => p?.id).map((p) => [String(p.id), p]));
      const aliases = [...ids].flatMap((id) => {
        const profile = stored.get(id);
        if (!profile) return [];
        return [...(Array.isArray(profile.names) ? profile.names : []), ...(Array.isArray(profile.aliases) ? profile.aliases : []).map((a) => a?.name)].filter((name) => typeof name === 'string' && name);
      });
      const source = {
        async *iterate(id, query) {
          yield* record.iterate(id, query);
          if (privateUserId) yield* record.iterate(id, { ...query, privateUserId });
        },
      };
      const found = await matchRecord(guildId, {
        record: source,
        range: { from: server.from ?? null, to: server.to ?? null },
        participants: [...ids],
        forms: [...(server.forms ?? []), ...(server.who ?? [])],
        aliases,
        recordDays: settings.recordDays,
        recordContext: settings.recordContext,
        now: now(),
        maxWindows: settings.maxClusters,
        allowLine,
        exclude: ownIds,
        recent,
        nameOf: (id) => {
          const profile = stored.get(String(id));
          return (typeof profile?.names?.[0] === 'string' ? profile.names[0] : null) ?? guild?.members?.cache?.get?.(id)?.displayName ?? null;
        },
        selfName,
        channelNameOf: (id) => guild?.channels?.cache?.get?.(id)?.name ?? null,
        signal,
      });
      return found.windows;
    } catch (err) {
      log.warn('recall: record failed', { channel: channelId, name: err?.name ?? null });
      return [];
    }
  }

  /**
   * The run's trace line appended to data/guilds/<guildId>/recall-trace.jsonl
   * (store.appendRecallTrace, capped at `maxLines`); nothing without that
   * store call. A write that throws logs `recall: trace failed` and costs the
   * run nothing.
   */
  function writeTrace({ guildId, channelId, trace, out, maxLines }) {
    if (typeof store.appendRecallTrace !== 'function' || !guildId) return;
    try {
      store.appendRecallTrace(guildId, traceLine(trace, out), { maxLines });
    } catch (err) {
      log.warn('recall: trace failed', { channel: channelId, name: err?.name ?? null });
    }
  }

  /** The cached captions of the windows' pictures and custom emoji, or undefined (cache only, never a request). */
  function cachedCaptions(config, guildId, windows) {
    if (config.features?.mediaDescriptions !== true || typeof describer?.cachedDescriptions !== 'function') return undefined;
    const { items, rest, emoji } = pullPictures(windows.flatMap((w) => w.messages), 0);
    const wanted = [...items, ...rest, ...emoji];
    if (wanted.length === 0) return undefined;
    try {
      return describer.cachedDescriptions(guildId, wanted) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The search, the windows and the summary; null once `signal` is aborted
   * (the run was abandoned). The Discord searches carry `searchSignal`
   * (aborted with `signal`, or at the PREPARE_SHARE mark: a search cut there
   * counts as failed and ends the searching). Once the windows are read,
   * `progress.fallback(kind)` gives the answer without a summary. `trace`
   * (the run's trace record, or null with `features.recallTrace` off) gets
   * the clusters and the summary's answer as they are known.
   */
  async function recallWith({ config, settings, prompt, guild, guildId, channel, partner, selfId, selfName, history, context, contextDescriptions, candidate, server, signal, searchSignal, progress, started, stats, trace }) {
    const channelId = channel.id;
    const searchUntil = started + settings.timeoutMs * SEARCH_SHARE;
    let counted = false;
    const beforeRequest = () => {
      if (counted) return;
      counted = true;
      bumpDaily(store.state.data, RECALL_DAILY, now());
      store.state.markDirty();
    };
    const result = (extra = {}) => ({ text: null, stretch: null, people: [], stats: { ...stats, ms: now() - started }, ...extra });

    // The pull rail toward this turn's channel, judged once per channel: Discord hits, record
    // lines and archived items of a channel it refuses never reach the summary.
    const judged = new Map();
    const sourceOf = (id) => {
      if (!judged.has(id)) {
        let source = null;
        try {
          const verdict = checkPull({ guild, channelId: id, destination: channel, partner, config, now: now() });
          source = verdict.skip === null ? verdict.channel : null;
        } catch {
          source = null;
        }
        judged.set(id, source);
      }
      return judged.get(id);
    };
    // A private entry or line is its member's alone: only a private turn with that member reads it.
    const privateUserId = !channel.guild && typeof partner?.id === 'string' && partner.id ? partner.id : null;
    const allowScope = (scope) => {
      if (scope?.private === true) return privateUserId !== null && scope.user === privateUserId;
      return typeof scope?.channel !== 'string' || sourceOf(scope.channel) !== null;
    };
    const allowEntry = (entry) => allowScope(entry?.scope);
    const allowLine = (line) => (line?.scope?.private === true ? allowScope(line.scope) : typeof line?.scope?.channel === 'string' && allowScope(line.scope));
    const recent = isRecentCue(server, { now: now(), recordDays: settings.recordDays });

    // 0. Stored memory (the archive included): no request, before the first Discord one so it always fits the budget.
    const memory = await storedMemory({ config, settings, guild, guildId, channel, partner, server, recent, allowEntry, privateUserId, signal });
    if (signal.aborted) return null;
    stats.memory = memory.items.length;
    stats.archived = memory.items.filter((item) => item.kind.startsWith('archived ')).length;

    // 1. People.
    const people = await findPeople({ guild, guildId, who: server.who ?? [], maxPeople: settings.maxPeople, selfId, signal: searchSignal, searchUntil, beforeRequest });
    if (signal.aborted) return null;

    // 2. The queries: never past the oldest line of the turn's own chat (a private chat is
    // not part of the server: it bounds nothing).
    const own = channel.guild && Array.isArray(history) ? history.filter((m) => m?.id) : [];
    const ownIds = new Set(own.map((m) => m.id));
    const oldest = own.reduce((min, m) => (Number.isFinite(m.ts) && m.ts < min ? m.ts : min), Infinity);
    const plan = searchPlan({
      forms: server.forms ?? [],
      who: server.who ?? [],
      memberIds: people.map((p) => p.id),
      from: server.from ?? null,
      to: server.to ?? null,
      maxForms: settings.maxForms,
      before: Number.isFinite(oldest) ? oldest : null,
    });
    const peopleOut = () => people.map((p) => ({ count: 0, newestTs: null, ...p }));

    // 2b. The record of the last days, for a dated or "recently" question: no request.
    const recordWindows = await recordWindowsFor({ settings, guild, guildId, server, people, recent, allowLine, privateUserId, ownIds, selfName, signal, channelId });
    if (signal.aborted) return null;
    if (plan.length === 0 && memory.items.length === 0 && recordWindows.length === 0) {
      log.info('recall: skipped', { channel: channelId, reason: Number.isFinite(server.from) ? 'visible' : 'no-query' });
      return result({ people: peopleOut() });
    }

    // 3. One query after another, newest first; a range alone is sampled across its total.
    // Each query's total on the whole server is kept: a form found that rarely weighs more (step 5).
    const hits = new Map();
    const totals = new Map();
    const queue = [...plan];
    stats.planned = plan.length;
    while (queue.length > 0) {
      if (signal.aborted) return null;
      if (searchSignal.aborted || (stats.queries > 0 && now() >= searchUntil)) break;
      const query = queue.shift();
      beforeRequest();
      const page = await searchMessages(guild, query, { signal: searchSignal });
      stats.queries += 1;
      if (signal.aborted) return null;
      if (!page) {
        stats.failed += 1;
        continue;
      }
      // A message several queries find is one hit carrying every key, each by the query's kind
      // (form / who / author / range): clusterHits ranks by the topic (form) keys first.
      const key = queryKey(query);
      if (!query.offset) totals.set(key, page.total);
      for (const raw of page.hits) {
        if (!hits.has(raw.id)) hits.set(raw.id, hitFrom(raw));
        hits.get(raw.id).queries.add(key);
      }
      if (query.kind === 'range' && !query.offset) {
        const more = sampleOffsets(page.total, settings.dateSamples)
          .filter((offset) => offset > 0)
          .map((offset) => ({ ...query, offset }));
        queue.push(...more);
        stats.planned += more.length;
      }
    }
    stats.hits = hits.size;

    // 4. Dropped: other bots, the turn's own chat, channels the pull rail refuses here (sourceOf, judged once each).
    // The turn's own chat first, before clustering: those lines are in `<chat>` already.
    const unseen = dropChatHits([...hits.values()], ownIds);
    stats.inChatDropped = unseen.dropped;
    const kept = unseen.hits.filter((hit) => Number.isFinite(hit.ts) && !(hit.bot && hit.authorId !== selfId) && sourceOf(hit.channelId) !== null);
    stats.kept = kept.length;
    for (const person of people) {
      const theirs = kept.filter((hit) => hit.authorId === person.id);
      person.count = theirs.length;
      person.newestTs = theirs.length > 0 ? Math.max(...theirs.map((hit) => hit.ts)) : null;
      person.username ||= theirs.find((hit) => hit.username)?.username ?? '';
    }

    // 5. Clusters (a form whose search totals at most `recall.rareHits` is rare): `recall.selfExtra`
    // more than will be kept, 6. a window around each (other bots and the turn's own chat left
    // out; a window that reached into the chat is marked `overlapsChat`, one holding the persona's
    // own line `self`), 7. the final `recall.maxClusters` re-ranked with `recall.selfBonus` for `self`.
    const candidates = clusterHits(kept, {
      gapMinutes: settings.clusterGapMinutes,
      maxClusters: settings.maxClusters + settings.selfExtra,
      keepOldest: settings.keepOldest,
      rareForms: rareFormKeys(totals, settings.rareHits),
    });
    const normalizeOptions = { selfId, embedTextChars: config.media?.embedTextChars, videoSites: config.media?.video?.sites };
    const fetched = await Promise.all(
      candidates.map(async (cluster) => {
        const source = judged.get(cluster.channelId);
        const messages = await fetchAround(source, cluster.middleId, settings.windowMessages, normalizeOptions);
        if (!messages) return null;
        const shown = messages.filter((m) => !m.bot && !ownIds.has(m.id));
        const marked = { ...cluster, self: shown.some((m) => m.self === true), overlapsChat: messages.some((m) => ownIds.has(m.id)) };
        return {
          cluster: marked,
          window: { channelId: cluster.channelId, channelName: source.name ?? null, messages: shown, hitIds: cluster.ids, overlapsChat: marked.overlapsChat },
        };
      }),
    );
    if (signal.aborted) return null;
    const ready = fetched.filter(Boolean);
    const chosen = rankClusters(
      ready.map((entry) => entry.cluster),
      { maxClusters: settings.maxClusters, keepOldest: settings.keepOldest, selfBonus: settings.selfBonus },
    );
    const windowOf = new Map(ready.map((entry) => [entry.cluster, entry.window]));
    stats.clusters = chosen.length;
    stats.selfClusters = chosen.filter((cluster) => cluster.self).length;
    if (trace) {
      const chosenSet = new Set(chosen);
      const markedOf = new Map(ready.map((entry) => [entry.cluster.middleId, entry.cluster]));
      trace.clusters = candidates.map((cluster) => {
        const marked = markedOf.get(cluster.middleId) ?? null;
        return {
          channelId: cluster.channelId,
          from: isoOf(cluster.startTs),
          to: isoOf(cluster.endTs),
          score: clusterScore(marked ?? cluster, settings.selfBonus),
          queries: cluster.queries,
          self: marked?.self === true,
          overlapsChat: marked?.overlapsChat === true,
          kept: marked !== null && chosenSet.has(marked),
        };
      });
    }
    const windows = mergeWindows(chosen.map((cluster) => windowOf.get(cluster)));
    // The record's windows join them by time (Discord's order kept), unless the search already shows all their lines.
    const shownIds = new Set(windows.flatMap((window) => window.messages.map((m) => m.id)));
    for (const window of recordWindows) {
      if (!window.messages.some((m) => !shownIds.has(m.id))) continue;
      const at = windows.findIndex((other) => windowEnd(other) < windowEnd(window));
      if (at === -1) windows.push(window);
      else windows.splice(at, 0, window);
      stats.record += 1;
    }
    stats.windows = windows.length;
    const descriptions = cachedCaptions(config, guildId, windows);
    for (const window of windows) window.descriptions = descriptions;
    log.info('recall: searched', {
      channel: channelId,
      memory: stats.memory,
      archived: stats.archived,
      record: stats.record,
      planned: stats.planned,
      queries: stats.queries,
      failed: stats.failed,
      hits: stats.hits,
      inChatDropped: stats.inChatDropped,
      kept: stats.kept,
      clusters: stats.clusters,
      selfClusters: stats.selfClusters,
      windows: stats.windows,
      people: people.length,
      ms: now() - started,
    });

    // 7. The summary.
    const render = {
      labels: hot.prompts.labels,
      timezone: config.bot?.timezone,
      selfName,
      gapMinutes: config.context?.gapMarkerMinutes,
      maxChars: config.context?.maxMessageChars ?? 800,
      seeReactions: config.features?.seeReactions !== false,
      reactionsPerMessage: config.context?.reactionsPerMessage,
    };
    /** One window as a stretch (no indices, cut to `recall.stretchChars`), or null. */
    const stretchOf = (window) => {
      if (!window || settings.stretchChars <= 0) return null;
      const [shown] = renderRecallWindows([window], { ...render, indexed: false });
      const lines = cutStretch(shown?.lines ?? [], settings.stretchChars);
      if (lines.length === 0) return null;
      return { channelId: window.channelId, channelName: window.channelName, startTs: lines[0].ts, lines: lines.map((line) => line.text).join('\n') };
    };
    // Stored memory alone is enough to ask the summary.
    const messages =
      windows.length > 0 || memory.items.length > 0
        ? buildRecallRequest({
            prompt,
            selfName,
            question: candidate ?? {},
            people,
            windows,
            memory: memory.items,
            // The chat lines before the question: what the question refers to.
            context: recallContext(Array.isArray(context) ? context : history, candidate, settings.contextMessages),
            contextDescriptions,
            replyQuoteChars: config.context?.replyQuoteChars,
            nameOf: memory.nameOf,
            answerChars: settings.answerChars,
            memoryTokens: settings.memoryTokens,
            now: now(),
            ...render,
          })
        : null;
    if (!messages) {
      log.info('recall: skipped', { channel: channelId, reason: 'no-hits' });
      return result({ people: peopleOut() });
    }
    // Without a summary the search still answers: the first-ranked window verbatim, no text
    // (stored memory alone gives nothing then: its items are notes, not chat).
    let asked = null;
    const fallback = (kind) => {
      stats.summary = kind;
      const chosenWindow = fallbackWindow(windows);
      const stretch = stretchOf(chosenWindow);
      if (trace) trace.summary = { answer: 'fallback', stretch: stretch ? windows.indexOf(chosenWindow) + 1 : null, text: null };
      log.info('recall: summary', { channel: channelId, ms: asked === null ? 0 : now() - asked, answer: 'fallback', stretch: stretch !== null, summary: kind });
      return result({ stretch, people: peopleOut() });
    };
    progress.fallback = fallback;
    if (started + settings.timeoutMs - now() < settings.minSummaryMs) return fallback('skipped');
    // A run on stored memory alone sent no Discord request: its summary is what counts it.
    beforeRequest();
    asked = now();
    let completion;
    try {
      completion = await llm.complete(messages, {
        model: classifierTextModel(config),
        ...helperRequestOptions(config, {
          role: 'classifier.text',
          maxOutputTokens: settings.maxOutputTokens,
          purpose: 'recall-summary',
          signal,
          timeoutMs: Math.max(1, started + settings.timeoutMs - asked),
          long: true,
        }),
      });
    } catch (err) {
      if (signal.aborted) return null;
      log.warn('recall: failed', { channel: channelId, reason: railReason(err), status: err?.statusCode ?? null, name: err?.name ?? null });
      return fallback(summaryFailure(err));
    }
    if (signal.aborted) return null;
    stats.summary = 'answered';
    const answer = parseRecallAnswer(completion?.text, { answerChars: settings.answerChars, count: windows.length });
    const stretch = answer.stretch !== null ? stretchOf(windows[answer.stretch - 1]) : null;
    if (trace) trace.summary = { answer: answer.text ? 'text' : 'nothing', stretch: stretch ? answer.stretch : null, text: answer.text };
    log.info('recall: summary', { channel: channelId, ms: now() - asked, answer: answer.text ? 'text' : 'nothing', stretch: stretch !== null });
    return result({ text: answer.text, stretch, people: peopleOut() });
  }

  /**
   * One server search for a turn. Per call, with `hot.config` / `hot.prompts`
   * read at that moment: nothing (no log) with `features.recall` off; `recall:
   * skipped` with `reason` `private-chat` (no guild, or a channel without a
   * guild and no `partner`: a private chat searches only on behalf of its
   * partner, the discord.js GuildMember of `guild` it talks to, keeping the
   * hits of channels that member can view and not bounded by its own chat),
   * `no-query` (no form, name form or range), `no-prompt` (no
   * `prompts['recall-summary']`), `daily-cap` (`llm.capLeft()` spent) or
   * `daily` (`recall.maxPerDay` runs today), each before any request; later
   * `visible` (the range lies inside the turn's own chat) or `no-hits`
   * (nothing left to read), either only when no stored memory matched
   * either (storedMemory; `stats.memory` its items, `stats.archived` those
   * from the archive, also on `recall: searched`) and the record gave no
   * window (recordWindowsFor; `stats.record` the record windows that joined
   * the search's, also on `recall: searched`): matched memory or a record
   * window alone still asks the summary. The first
   * request of a run (a Discord one, or the summary of a run on memory
   * alone) bumps `recallDay`/`recallCount` once. Never rejects: a failure logs `recall:
   * failed` (`reason`: the rail code of a failed summary request, `timeout`
   * when `recall.timeoutMs` ran out -- the run is abandoned, its requests
   * aborted -- or `error`). Once the windows are read the result is never
   * lost: when the summary request fails, times out (its own limit or the
   * run's) or is skipped (less than `recall.minSummaryMs` left), the run
   * resolves `text` null with `stretch` the first-ranked window
   * (fallbackWindow), `stats.summary` `failed` | `timeout` | `skipped`, and
   * logs `recall: summary` with `answer: 'fallback'`; an answered summary
   * sets `stats.summary` `answered`. Resolves `text` null when nothing was
   * found or the helper answered `nothing` (and when the summary of a run
   * on stored memory alone gives no answer); `stretch` is the window the
   * helper named, else null; `people` the members the name forms found,
   * with how many of their messages were kept and the newest one's time.
   * `history` is the turn's own chat (the window and the reply parents it
   * fetched): its ids are left out of the hits (`stats.inChatDropped`) and
   * mark a window that reaches into it. `context` (default `history`) is
   * where the summary's `<context>` lines come from: the last
   * `recall.contextMessages` before `candidate`, with `contextDescriptions`
   * as their captions. With `features.recallTrace` true every run past the
   * gates above appends its trace record (store.appendRecallTrace; see
   * traceLine). `op` (optional, a journal operation: src/memory/journal.js#op,
   * as the turn hands it) is started once the gates above passed, before the
   * first request, and closed with the run: `succeeded` with `status` (`ok`,
   * or `timeout` when the run ran out yet left its fallback stretch), `hits`
   * (the search hits), `kept`, `summaryChars` and `stretch` (whether a
   * stretch is returned); `failed` with `timeout` (nothing left) or `error`.
   */
  async function run({ guild, guildId = guild?.id ?? null, channel, partner = null, selfId, selfName, history = [], context = null, contextDescriptions, candidate = null, server = null, op = null } = {}) {
    const started = now();
    const channelId = channel?.id ?? null;
    const stats = emptyStats();
    const empty = () => ({ text: null, stretch: null, people: [], stats: { ...stats, ms: now() - started } });
    const skip = (reason) => {
      log.info('recall: skipped', { channel: channelId, reason });
      return empty();
    };
    let controller = null;
    let timer = null;
    let cut = null;
    let trace = null;
    let traceMaxLines = null;
    const finish = (out) => {
      if (trace) writeTrace({ guildId, channelId, trace, out, maxLines: traceMaxLines });
      return out;
    };
    // The journal's closing line of a run that started (`op`): what it found, never the text.
    const opResult = (out, status) => ({
      status,
      hits: out?.stats?.hits ?? stats.hits,
      kept: out?.stats?.kept ?? stats.kept,
      summaryChars: typeof out?.text === 'string' ? out.text.length : 0,
      stretch: Boolean(out?.stretch),
    });
    try {
      const config = hot.config;
      const settings = recallSettings(config);
      if (!settings) return empty();
      if (!guild || (!channel?.guild && !partner)) return skip('private-chat');
      if (!asksServer(server)) return skip('no-query');
      const prompt = summaryPrompt();
      if (!prompt) return skip('no-prompt');
      if (capSpent()) return skip('daily-cap');
      if (dailySpent(settings)) return skip('daily');
      if (config.features?.recallTrace === true) {
        trace = newTrace({ started, channelId, candidate, server });
        traceMaxLines = settings.traceMaxLines;
      }
      if (op) await op.started();

      controller = new AbortController();
      const searching = new AbortController();
      controller.signal.addEventListener('abort', () => searching.abort(), { once: true });
      const deadline = new Promise((resolve) => {
        timer = timers.set(() => resolve(TIMEOUT), settings.timeoutMs);
        timer?.unref?.();
      });
      cut = timers.set(() => searching.abort(), Math.floor(settings.timeoutMs * PREPARE_SHARE));
      cut?.unref?.();
      const progress = { fallback: null };
      const work = recallWith({
        config,
        settings,
        prompt,
        guild,
        guildId,
        channel,
        partner,
        selfId,
        selfName,
        history,
        context,
        contextDescriptions,
        candidate,
        server,
        signal: controller.signal,
        searchSignal: searching.signal,
        progress,
        started,
        stats,
        trace,
      });
      work.catch(() => {});
      const outcome = await Promise.race([work, deadline]);
      if (outcome === TIMEOUT) {
        controller.abort();
        log.warn('recall: failed', { channel: channelId, reason: 'timeout', status: null, name: null });
        const fallen = progress.fallback ? progress.fallback('timeout') : null;
        if (op) await (fallen ? op.succeeded(opResult(fallen, 'timeout')) : op.failed('timeout'));
        return finish(fallen ?? empty());
      }
      const out = outcome ?? empty();
      if (op) await op.succeeded(opResult(out, 'ok'));
      return finish(out);
    } catch (err) {
      controller?.abort();
      log.warn('recall: failed', { channel: channelId, reason: 'error', status: null, name: err?.name ?? null });
      if (op) await op.failed('error');
      return finish(empty());
    } finally {
      if (timer !== null) timers.clear(timer);
      if (cut !== null) timers.clear(cut);
    }
  }

  return { run, available };
}
