// The recall runner: the persona's own search (`run`, their memory.search and the `find` of conversation.read), their
// window reads (`window`) and the memory prefetch of a turn (`prefetch`), all over the memory database
// (src/memory/db/recall.js): the stretches scope-checked by the read context. While the database is not open they find
// nothing (`not-configured`, or a prefetch of the stored memory alone). Their searches run on the service's reader
// thread (`memoryDb.searchRecord`) with a signal: `recall.timeoutMs` bounds the persona's own search,
// `recall.prefetch.deadlineMs` the prefetch; a search past its bound is abandoned. Rails: `features.recall`, server
// turns and private chats run on behalf of their partner, and the daily request cap (`llm.capLeft`).
// With `features.meaningSearch` exactly true and `deps.embed` given, a search embeds the question once (recall.js
// meaningQuery; purpose `recall-query`); a failed embedding leaves words only.
// The prefetch also matches its lanes' forms against the persona's stored memory (recall.js matchMemory; read-only
// store calls, no request) and the archive (src/memory/archive.js, streamed through recall.js scanArchive). Before an
// archive entry is matched, the audience rule of the turn's channel refuses what the pull rail would (by the entry's
// `scope.channel`), and a private entry passes only on a private turn with its own member.
// Logs carry counts, ids and codes only: never a form, a name or a message.
// What a run found and chose is diagnosed from the trace file instead
// (`features.recallTrace`, data/places/<id>/recall-trace.jsonl, see traceLine):
// it is memory about real people, kept under data/ only.

import { opensPrivate } from '../memory/open-private.ts';
import { directChatPlaceIds } from '../memory/db/places-read.ts';
import { dmPlaceOfMember, personOfMember, placeOfChat, storedPersonOfMember } from '../memory/addresses.ts';
import { log } from '../log.ts';
import { oneLine } from '../memory/clamp.ts';
import { audienceAllows, isReadable } from './snapshot.ts';
import { checkPull } from './pull-fetch.ts';
import { roleModel } from '../llm/roles.ts';
import { pullPictures } from './pull.ts';
import {
  countFormsIn,
  cutStretch,
  matchMemory,
  meaningQuery,
  recallSettings,
  renderRecallWindows,
  stretchText,
  scanArchive,
} from './recall.ts';
import { fitExcerpts, focusHits, itemLines, lanePlan, lexicalKeep, rankPrefetch } from './prefetch.ts';
import { indexWords } from '../memory/record-index.ts';
import { CODE } from '../tools/codes.ts';
import { dbSettings, quotesOf, search as searchRows, window as windowRows } from '../memory/db/recall.ts';
import type { RecallMessage } from '../memory/db/recall.ts';
import { memberKeyOf } from '../memory/db/frame-reads.ts';
import type { Db } from '../memory/db/types.ts';
import { handleOf } from './handles.ts';
import { factExcerpts, prefetchFacts, searchEpisodes, searchFacts } from './recall-facts.ts';
import type { MemoryPage } from '../memory/db/semantic-types.ts';
import type { RetrievalInput } from '../memory/retrieval-input.ts';
import { currentIface } from '../memory/db/current-iface.ts';
import { isIssuedReadAllContext, issueContext, readContextSpec } from '../memory/db/scope.ts';
import { hasRecallContext, historyExclusions, recallDatabase, inRoot } from './recall-reads.ts';
import { isFiniteNumber, objOf } from '../tools/types.ts';
import { untracked } from '../loop-watch.ts';
import type { ChatInfo } from '../protocol/adapter.ts';
import type { Untyped } from '../tools/types.ts';
import type {
  EmptyStatsResult,
  NewTraceInput,
  CreateRecallInput,
  CreateRecallResult,
  StoredMemoryInput,
  WriteTraceInput,
  ScopeOfInput,
  DbReaderInput,
  ReadContextInput,
  DbQuotesInput,
  RunDbQuotesInput,
  WindowInput,
  RunInput,
  PrefetchInput,
  PrefetchOutcome,
  RecallTrace,
  ArchiveEntry,
} from './recall-run-types.ts';

// src/memory/db/recall.js declares no parameter types, so TypeScript infers `null` for every defaulted one.
const dbSearch = searchRows as (db: Untyped, args: Untyped) => Untyped;
const dbWindow = windowRows as (db: Untyped, args: Untyped) => Untyped;

const TIMEOUT = Symbol('timeout');
/** A meaning hit of the prefetch on a line of fewer words (an acknowledgement, an emoji) is no hit: its cosine comes from its neighbours. */
const MEANING_MIN_WORDS = 3;
/** How many lines apart the hits marked in one prefetch excerpt may lie (focusHits). */
const FOCUS_LINES = 6;
const DEFAULT_TIMERS = Object.freeze({
  set: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clear: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
});

/** What a failure line of the log says about an error. */
function failureFields(err: unknown) {
  return { name: objOf(err).name ?? null, code: objOf(err).code ?? null };
}

/** The input of one lane's search in the memory database. */
function laneSearch({
  reader,
  forms,
  who,
  until,
  bounded,
  vector,
  settings,
  candidates,
  ...rest
}: Untyped): Record<string, unknown> {
  return {
    ...rest,
    ctx: reader.ctx,
    plan: { forms, who, from: null, to: bounded ? until : null },
    limit: Math.ceil(candidates / 4),
    now: until,
    vector,
    settings: { ...settings, candidates },
    allowPlace: reader.allowPlace,
    model: reader.model,
  };
}

/** Whether the parsed server part asks anything. */
function asksServer(server: Untyped, retrieval: Untyped = null) {
  if (typeof retrieval?.entity === 'string' && retrieval.entity !== '') return true;
  if (!server || typeof server !== 'object') return false;
  const some = (list: Untyped) => Array.isArray(list) && list.length > 0;
  const named = [server.placeId, server.place].some((id) => typeof id === 'string' && id !== '');
  return some(server.forms) || some(server.who) || Number.isFinite(server.from) || Number.isFinite(server.to) || named;
}

/** What a sample's place rule reads: the memory's connection, the turn's live view and its chat. */
type SamplePlaceInput = {
  db: { prepare(sql: string): { get(...params: Array<unknown>): Record<string, unknown> | undefined } } | null;
  snapshot: { get: (id: string) => ChatInfo | undefined } | null;
  channel: ChatInfo;
  partnerId: string | null;
  config: object;
};

/**
 * Which places a sample of the persona's own search may read: a sample hands them a stretch of a channel with no
 * word of theirs behind it, so it keeps to the chats the turn's live view allows (readable, the audience rule of
 * `context.pull.sameAudience`). The view holds a chat by the native id of its place's row (`places.native_id`), read
 * once per place. A stored place the view does not hold, their DM among them, stays with the read context.
 */
function samplePlaceRule(given: Record<keyof SamplePlaceInput, unknown>) {
  // The runner's inputs are untyped; these are the shapes `run` is given.
  const { db, snapshot, channel, partnerId, config } = given as SamplePlaceInput;
  const nativeOfPlace = db?.prepare('SELECT native_id FROM places WHERE id = ?') ?? null;
  const natives = new Map<unknown, string>();
  const nativeOf = (placeId: unknown): string => {
    if (!natives.has(placeId)) {
      const native = nativeOfPlace?.get(placeId)?.native_id;
      natives.set(placeId, typeof native === 'string' ? native : '');
    }
    return natives.get(placeId) ?? '';
  };
  return (placeId: unknown): boolean => {
    const entry = snapshot?.get(nativeOf(placeId)) ?? null;
    return entry === null || (isReadable(entry) && audienceAllows(channel, entry, config, { partnerId }));
  };
}

/** A fresh stats record of one run. */
function emptyStats(): EmptyStatsResult {
  return {
    memory: 0,
    archived: 0,
    record: 0,
    meaning: 0,
    meaningMs: 0,
    planned: 0,
    queries: 0,
    failed: 0,
    hits: 0,
    inChatDropped: 0,
    kept: 0,
    clusters: 0,
    selfClusters: 0,
    windows: 0,
    summary: null,
    ms: 0,
  };
}

/** The start (epoch ms, UTC) of the month `months - 1` months before the month of `ms`: the last `months` archive segments. */
function monthsBack(ms: number, months: Untyped) {
  const day = new Date(ms);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth() - (months - 1), 1);
}

/** An epoch-ms time as an ISO string, or null. */
function isoOf(ms: unknown) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** A fresh trace record of one run, completed by traceLine. */
function newTrace({ started, placeId, candidate, server }: NewTraceInput): RecallTrace {
  const from = Number.isFinite(server?.from) ? server.from : null;
  const to = Number.isFinite(server?.to) ? server.to : null;
  return {
    at: isoOf(started),
    placeId,
    triggerId: typeof candidate?.id === 'string' ? candidate.id : null,
    forms: Array.isArray(server?.forms) ? [...server.forms] : [],
    who: Array.isArray(server?.who) ? [...server.who] : [],
    when:
      from !== null || to !== null
        ? { from: isoOf(from), to: isoOf(to), role: server?.locator === true ? 'locator' : 'scope' }
        : null,
    clusters: [],
    summary: { answer: null, stretch: null, text: null, note: null },
    skipped: null,
    people: [],
    plan: [],
    memory: [],
    record: [],
    meaning: null,
  };
}

/**
 * The trace line of a finished run: `{ at, placeId, triggerId, forms, who, when, hits, inChatDropped, clusters,
 * summary, lookupChars, skipped, people, plan, memory, record, meaning }`. `summary.answer` is `quotes` once the
 * persona's own search ran, else null. `skipped`: the reason code of a gate of `run` that stopped it, else null.
 * `when`: null without a range, else `{ from, to, role }`, `role` `scope` (a hard bound) or `locator`. The other
 * fields keep the shape of the line: `hits` and `inChatDropped` from the result's stats, `lookupChars` the characters
 * of its `text` and `stretch`, and `clusters`, `people`, `plan`, `memory` and `record` empty, `meaning` null.
 */
function traceLine(trace: RecallTrace, out: Untyped) {
  const text = typeof out?.text === 'string' ? out.text : null;
  const stretch = out?.stretch ?? null;
  return {
    at: trace.at,
    placeId: trace.placeId,
    triggerId: trace.triggerId,
    forms: trace.forms,
    who: trace.who,
    when: trace.when,
    hits: out?.stats?.hits ?? 0,
    inChatDropped: out?.stats?.inChatDropped ?? 0,
    clusters: trace.clusters,
    summary: {
      answer: trace.summary.answer,
      stretch: stretch
        ? {
            n: trace.summary.stretch,
            placeId: stretch.placeId,
            channelName: stretch.channelName ?? null,
            lines: stretch.lines,
          }
        : null,
      text,
      note: trace.summary.note ?? null,
    },
    lookupChars: [...(text ?? '')].length + [...(stretch?.lines ?? '')].length,
    skipped: trace.skipped,
    people: trace.people,
    plan: trace.plan,
    memory: trace.memory,
    record: trace.record,
    meaning: trace.meaning,
  };
}

export type { RecallStretch } from './recall-run-types.ts';

/**
 * The recall runner for the turn (task R2 wires it beside the web search).
 */
// health: allow function-length until 2027-04-01 -- the closure holds its whole operation, grown by the one dependency that names the loop watch
export function createRecall({
  hot,
  store,
  llm,
  memberName = () => null,
  describer = null,
  archive = null,
  embed = null,
  memoryDb = null,
  iface = '',
  now = Date.now,
  timers = DEFAULT_TIMERS,
  track = untracked,
  mediaNameOf,
}: CreateRecallInput): CreateRecallResult {
  /** One search of the database: on the reader thread, or synchronously over a memory that offers only `database()`. */
  function searchDb(db: Untyped, input: Untyped, signal: AbortSignal): Promise<Untyped> {
    if (typeof memoryDb?.searchRecord === 'function') return memoryDb.searchRecord(input, { signal });
    return Promise.resolve().then(() => dbSearch(db, input));
  }

  /** Whether `llm.maxRequestsPerDay` is spent today. */
  function capSpent() {
    return typeof llm?.capLeft === 'function' && llm.capLeft() <= 0;
  }

  /**
   * Whether a run could search now: the switch on and the daily request cap not spent. Read only; for a caller
   * deciding whether to offer the persona's own search at all.
   */
  function available(): boolean {
    try {
      const settings = recallSettings(hot.config);
      return Boolean(settings) && !capSpent();
    } catch {
      return false;
    }
  }

  async function storedMemory({
    config,
    settings,
    placeId,
    channel,
    server,
    allowEntry,
    privateAccountId,
    privatePlaces = [],
    signal,
    source = archive,
  }: StoredMemoryInput) {
    const forms = Array.isArray(server.forms) ? server.forms : [];
    const who = Array.isArray(server.who) ? server.who : [];
    if (settings.memoryItems <= 0 || (forms.length === 0 && who.length === 0)) return [];
    try {
      const profiles = typeof store.listUserProfiles === 'function' ? (store.listUserProfiles() ?? []) : [];
      const ranged = Number.isFinite(server.from) || Number.isFinite(server.to);
      const switchedOff = new Set<string>();
      const allow = (entry: ArchiveEntry) => !switchedOff.has(entry?.itemKind) && allowEntry(entry);
      // Entries are recorded after what they observed: the months from `from` on, the private archive after the place's.
      const stream = (query: Untyped) =>
        (async function* (): AsyncGenerator<ArchiveEntry> {
          // The place's archive and each direct chat `context.memory.openPrivate` opens, then the private one.
          for (const place of [placeId, ...privatePlaces.filter((dm) => dm !== placeId)])
            yield* source.iterate(place, query);
          if (privateAccountId) yield* source.iterate(placeId, { ...query, privateAccountId });
        })();
      let archived: Array<Untyped> = [];
      if (typeof source?.iterate === 'function' && (ranged || settings.archiveMonths > 0)) {
        const from = Number.isFinite(server.from)
          ? server.from
          : monthsBack(now(), Math.max(1, settings.archiveMonths));
        try {
          archived = await scanArchive(stream({ from: new Date(from).toISOString() }), {
            forms,
            who,
            profiles,
            from: server.from ?? null,
            to: server.to ?? null,
            timezone: config.bot?.timezone,
            allow,
            max: settings.memoryItems,
            signal,
          });
        } catch (err) {
          log.warn('recall: archive failed', { channel: channel.id, name: objOf(err).name ?? null });
        }
      }
      return matchMemory({
        forms,
        who,
        profiles,
        lore: typeof store.getLore === 'function' ? (store.getLore(placeId) ?? []) : [],
        learned: typeof store.getPlace === 'function' ? (store.getPlace(placeId)?.learned ?? []) : [],
        archived,
        from: server.from ?? null,
        to: server.to ?? null,
        max: settings.memoryItems,
        timezone: config.bot?.timezone,
      });
    } catch (err) {
      log.warn('recall: memory failed', { channel: channel.id, name: objOf(err).name ?? null });
      return [];
    }
  }

  /**
   * The run's trace line appended to data/places/<placeId>/recall-trace.jsonl
   * (store.appendRecallTrace, capped at `maxLines`); nothing without that
   * store call. A write that throws logs `recall: trace failed` and costs the
   * run nothing.
   */
  function writeTrace({ placeId, trace, out, maxLines }: WriteTraceInput) {
    if (typeof store.appendRecallTrace !== 'function' || !placeId) return;
    try {
      store.appendRecallTrace(placeId, traceLine(trace, out), { maxLines });
    } catch (err) {
      log.warn('recall: trace failed', { placeId, name: objOf(err).name ?? null });
    }
  }

  /** The cached captions of the windows' pictures and custom emoji, or undefined (cache only, never a request). */
  function cachedCaptions(config: Untyped, placeId: string | null, windows: Untyped) {
    if (!placeId || typeof describer?.cachedDescriptions !== 'function') return undefined;
    const { items, rest, emoji } = pullPictures(
      windows.flatMap((w: Untyped) => w.messages),
      0
    );
    const wanted = [...items, ...rest, ...emoji];
    if (wanted.length === 0) return undefined;
    try {
      return describer.cachedDescriptions(placeId, wanted) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * What a run may read toward `channel` (the turn's; a private chat on behalf of `partnerId`):
   * `privateAccountId`, the partner of a private chat (else null): a private entry is its member's alone, read only on
   * a private turn with that member, the partner of the DM place `placeId` the turn stands in; `privatePlaces`, the
   * direct chats `context.memory.openPrivate` opens; `allowEntry` (an archive entry, by its `scope`: a channel's entry
   * passes when the pull rail, judged once per channel, lets that channel's lines reach this turn).
   */
  function scopeOf({ config, snapshot, channel, partnerId, placeId }: ScopeOfInput) {
    const judged = new Map();
    const sourceOf = (id: Untyped) => {
      if (!judged.has(id)) {
        let source = null;
        try {
          const verdict = checkPull({ snapshot, placeId: id, destination: channel, partnerId, config, now: now() });
          source = verdict.skip === null ? verdict.channel : null;
        } catch {
          source = null;
        }
        judged.set(id, source);
      }
      return judged.get(id);
    };
    const privateAccountId = !inRoot(channel) && typeof partnerId === 'string' && partnerId ? partnerId : null;
    const openPrivate = opensPrivate(config);
    const db = openPrivate ? recallDatabase(memoryDb) : null;
    const privatePlaces = db ? directChatPlaceIds(db as Db) : [];
    const allowScope = (scope: Untyped) => {
      // A private item is its partner's: named by their id, or by the DM place this private turn stands in, and every
      // one with `context.memory.openPrivate`.
      if (scope?.private === true)
        return (
          openPrivate || (privateAccountId !== null && (scope.user === privateAccountId || scope.place === placeId))
        );
      return typeof scope?.channel !== 'string' || sourceOf(scope.channel) !== null;
    };
    const allowEntry = (entry: Untyped) => allowScope(entry?.scope);
    return { privateAccountId, privatePlaces, allowEntry };
  }

  function profilesFor(placeId: string | null): Array<Untyped> {
    if (!placeId || typeof store.listUserProfiles !== 'function') return [];
    return store.listUserProfiles() ?? [];
  }

  function namesFor(placeId: string | null, profiles: Array<Untyped>) {
    const stored = new Map<string, Untyped>(
      profiles.filter((profile) => profile?.id).map((profile) => [String(profile.id), profile])
    );
    return (id: Untyped) => {
      const name = stored.get(String(id))?.names?.[0];
      return (typeof name === 'string' && name ? name : null) ?? (placeId ? memberName(placeId, String(id)) : null);
    };
  }

  function dbReader({
    db = null,
    config,
    snapshot,
    placeId,
    channel,
    partnerId,
    asker = null,
    memoryContext = null,
  }: DbReaderInput) {
    const { privateAccountId } = scopeOf({ config, snapshot, channel, partnerId, placeId });
    const nameOf = namesFor(placeId, profilesFor(placeId));
    const ctx = readContext({ config, channel, privateAccountId, asker, memoryContext });
    const placeExists = db?.prepare('SELECT id FROM places WHERE id = ?');
    const knownPlaces = new Map<string, boolean>();
    return {
      nameOf,
      ctx,
      model: roleModel(config, 'embedding', 'recall-query') ?? null,
      channelNameOf: (id: Untyped) => snapshot?.get(id)?.name ?? null,
      allowPlace: (placeId: string) => {
        if (!knownPlaces.has(placeId)) knownPlaces.set(placeId, Boolean(placeExists?.get(placeId)));
        return knownPlaces.get(placeId) === true;
      },
    };
  }

  /**
   * The read context of a db read (see dbReader): the turn's own when it fits, else one issued for this read; an issued internal or open context spans every audience.
   */
  function readContext({ channel, privateAccountId, asker, memoryContext = null }: ReadContextInput) {
    const spec = readContextSpec({
      chatIface: currentIface(),
      home: iface,
      chatId: channel?.id,
      privateAccountId,
      personOf: (on, platformId) => personOfMember(store, platformId, on),
      dmPlaceOf: (on, platformId) => dmPlaceOfMember(store, platformId, on),
      chatPlaceOf: (on, chatId) => placeOfChat(store, { id: chatId }, on),
    });
    const fits =
      memoryContext &&
      typeof memoryContext === 'object' &&
      typeof memoryContext.id === 'string' &&
      memoryContext.id.length > 0 &&
      (isIssuedReadAllContext(memoryContext) ||
        (!memoryContext.internal &&
          (privateAccountId
            ? memoryContext.kind === 'dm' && spec.kind === 'dm' && memoryContext.person === spec.person
            : memoryContext.kind === 'group')));
    const issued = fits
      ? memoryContext
      : typeof memoryDb?.issueContext === 'function'
        ? memoryDb.issueContext(spec)
        : issueContext({ ...spec, now });
    const askerPerson = privateAccountId || !asker ? null : storedPersonOfMember(store, String(asker), spec.iface);
    return askerPerson === null ? issued : { ...issued, asker: [askerPerson] };
  }

  /**
   * The stretches of db windows as `recall.run` returns them (decorated, each line with the text forms of its own media,
   * cut to `recall.stretchChars`). Never a request.
   */
  function dbQuotes({ db, config, settings, selfName, windows, decorate }: DbQuotesInput) {
    const shown = windows.map((window: Untyped) =>
      typeof decorate === 'function' ? { ...window, messages: decorate(window.messages) } : window
    );
    const render = {
      labels: hot.prompts.labels,
      timezone: config.bot?.timezone,
      selfName,
      seeReactions: true,
    };
    // Each author by the handle of the person behind their stored account, as the persona's request names them.
    const handleOfAuthor = (message: RecallMessage): string | null => {
      const iface = message.stored?.iface;
      if (!iface || message.authorId === null || message.authorId === undefined) return null;
      const native = String(message.authorId);
      return handleOf(memberKeyOf(db as Db, iface, native) ?? `${iface}:${native}`);
    };
    return quotesOf(shown, { render, stretchChars: settings.stretchChars, handleOf: handleOfAuthor, mediaNameOf });
  }

  /**
   * The persona's own search over the memory database (`quotes`): the question embedded once when
   * the meaning search is on (a failure leaves words only, `degraded`), then src/memory/db/recall.js#search inside the
   * turn's read context, the turn's own chat left out. Resolves the result of `run`, plus `hidden`.
   */
  async function runDbQuotes({
    db,
    config,
    settings,
    snapshot,
    placeId,
    channel,
    partnerId,
    selfName,
    history,
    historyRef,
    candidate,
    terms = '',
    server,
    decorate,
    started,
    memoryContext = null,
    retrieval = null,
    lines = 0,
  }: RunDbQuotesInput) {
    const stats = emptyStats();
    const reader = dbReader({
      db,
      config,
      snapshot,
      placeId,
      channel,
      partnerId,
      asker: candidate?.authorId ?? null,
      memoryContext,
    });
    let vector = null;
    let degraded = false;
    // The persona's question is embedded, else their terms: a word of one language meets a description in another.
    const asked = meaningQuery({ candidate, lines: [], withReply: false, nameOf: reader.nameOf });
    const termsText = oneLine(terms);
    const queryText = asked?.text ?? termsText;
    if (typeof embed === 'function' && settings.meaningCandidates > 0) {
      if (queryText) {
        const embedStarted = now();
        const controller = new AbortController();
        const timer = timers.set(() => controller.abort(), settings.timeoutMs);
        timer?.unref?.();
        try {
          [vector] = await embed([queryText], { config, purpose: 'recall-query', signal: controller.signal });
          stats.meaningMs = now() - embedStarted;
        } catch (err) {
          degraded = true;
          vector = null;
          log.warn('recall: meaning failed', { channel: channel.id, stage: 'embed', name: objOf(err).name ?? null });
        } finally {
          timers.clear(timer);
        }
      }
    }
    const exclusions = historyExclusions({ history, historyRef, context: reader.ctx, channel });
    const controller = new AbortController();
    let timer: Untyped = null;
    const deadline = new Promise((resolve) => {
      timer = timers.set(() => resolve(TIMEOUT), Math.max(1, started + settings.timeoutMs - now()));
      timer?.unref?.();
    });
    const searching = searchDb(
      db,
      {
        ctx: reader.ctx,
        plan: server,
        limit: settings.maxClusters,
        now: now(),
        vector,
        settings: dbSettings(config),
        exclusions,
        nameOf: reader.nameOf,
        selfName,
        channelNameOf: reader.channelNameOf,
        allowPlace: reader.allowPlace,
        model: reader.model,
        // A sample of lines answers only a call that names no words: a search for words that found none says so.
        sampleTime: !asked && !termsText,
        mediaBar: settings.prefetch,
        hitLines: lines,
        samplePlace: samplePlaceRule({ db, snapshot, channel, partnerId, config }),
      },
      controller.signal
    );
    // A search left behind at the deadline rejects with nobody waiting.
    searching.catch(() => {});
    const found = await Promise.race([searching, deadline]).finally(() => timers.clear(timer));
    if (found === TIMEOUT) {
      controller.abort();
      return null;
    }
    stats.hits = found.hits.length;
    stats.meaning = found.stats.meaning;
    stats.windows = found.windows.length;
    const quotes = dbQuotes({
      db,
      ctx: reader.ctx,
      config,
      settings,
      placeId,
      selfName,
      windows: found.windows,
      decorate,
    });
    stats.kept = quotes.length;
    stats.summary = 'quotes';
    // The stored facts and episodes are met by the meaning of the question only, never of the terms. A run for `lines`
    // (a read's `find`) wants the lines alone.
    const factsVector = asked ? vector : null;
    const facts = lines === 0;
    const page = !facts
      ? null
      : await searchFacts({
          db,
          ctx: reader.ctx,
          text: candidate?.content,
          retrieval,
          config,
          prefetch: settings.prefetch,
          now,
          vector: factsVector,
          model: reader.model,
        });
    log.info('recall: quoted', {
      channel: channel.id,
      windows: found.windows.length,
      quoted: quotes.length,
      hidden: found.hidden,
      sampled: found.sampled === true,
      totalMs: now() - started,
    });
    return {
      text: null,
      stretch: null,
      quotes,
      hidden: found.hidden === true,
      sampled: found.sampled === true,
      far: found.far === true,
      lines: Array.isArray(found.lines) ? found.lines : [],
      people: [],
      assertions: page?.assertions ?? [],
      factsCut: page?.next != null,
      episodes:
        db && facts ? searchEpisodes({ db, ctx: reader.ctx, vector: factsVector, model: reader.model, config }) : [],
      stats: { ...stats, ms: now() - started },
      outcome: { kind: 'searched', degraded, failed: 0, total: 1 },
    };
  }

  /**
   * A window read of the persona's own `memory.search` (`anchor`, `move`, `messages`, `minutes`): the lines of the
   * anchor's place up or down in time order, inside the turn's read context (src/memory/db/recall.js#window). The
   * `anchor` is a message id (a `#N` the executor already resolved). Resolves `{ quotes, outcome, stopped }`; `outcome`
   * `not-configured` while the database is not open, `unknown-anchor` for an anchor the turn cannot open or that does
   * not exist, `error` for a throw. Counts no daily run: it reads the local database only. `asker` is the user id of
   * whoever asked and `memoryContext` the turn's execution context, as for `run`.
   */
  async function window({
    placeId = null,
    snapshot = null,
    channel,
    partnerId = null,
    selfName = '',
    history = [],
    historyRef,
    anchor,
    resolvedAnchor,
    move = 'up',
    messages = null,
    minutes = null,
    decorate = null,
    asker = null,
    memoryContext = null,
  }: WindowInput) {
    const started = now();
    const stats = emptyStats();
    const out = (extra: Untyped) => ({
      text: null,
      stretch: null,
      people: [],
      stats: { ...stats, ms: now() - started },
      ...extra,
    });
    try {
      const config = hot.config;
      const settings = recallSettings(config);
      const db = recallDatabase(memoryDb);
      if (!settings || !db) return out({ outcome: { kind: 'not-configured' } });
      if (!hasRecallContext({ channel, partnerId, memoryContext })) return out({ outcome: { kind: 'not-configured' } });
      const reader = dbReader({ db, config, snapshot, placeId, channel, partnerId, asker, memoryContext });
      const exclusions = historyExclusions({ history, historyRef, context: reader.ctx, channel });
      const found = dbWindow(db, {
        ctx: reader.ctx,
        anchor,
        resolvedAnchor,
        move,
        messages,
        minutes,
        settings: dbSettings(config),
        nameOf: reader.nameOf,
        selfName,
        channelNameOf: reader.channelNameOf,
        exclusions,
        allowPlace: reader.allowPlace,
      });
      if (found.unknown) return out({ outcome: { kind: 'unknown-anchor' } });
      const quotes = dbQuotes({
        db,
        ctx: reader.ctx,
        config,
        settings,
        placeId,
        selfName,
        windows: found.windows,
        decorate,
      });
      log.info('recall: window', {
        channel: channel.id,
        move: move === 'down' ? 'down' : 'up',
        lines: found.windows.at(0)?.messages.length ?? 0,
        stopped: found.stopped,
      });
      return out({
        quotes,
        stopped: found.stopped,
        outcome: { kind: 'searched', degraded: false, failed: 0, total: 1 },
      });
    } catch (err) {
      log.warn('recall: failed', {
        channel: channel?.id ?? null,
        reason: 'error',
        status: null,
        ...failureFields(err),
      });
      return out({ outcome: { kind: 'error' } });
    }
  }

  /** The persona's own search past `recall.timeoutMs`: a warning, the journal's failure and the outcome they read. */
  async function quotesTimedOut(chatId: unknown, op: Untyped, empty: (extra: object) => Untyped) {
    log.warn('recall: failed', { channel: chatId, reason: 'timeout', status: null, name: null, code: null });
    if (op) await op.failed(CODE.TIMEOUT);
    return empty({ outcome: { kind: 'timeout' } });
  }

  async function run({
    placeId = null,
    snapshot = null,
    channel,
    partnerId = null,
    selfName,
    history = [],
    historyRef,
    candidate = null,
    terms = '',
    server = null,
    op = null,
    decorate = null,
    memoryContext = null,
    retrieval = null,
    lines = 0,
  }: RunInput) {
    const started = now();
    const chatId = channel?.id ?? null;
    const stats = emptyStats();
    const empty = (extra = {}) => ({
      text: null,
      stretch: null,
      people: [],
      stats: { ...stats, ms: now() - started },
      ...extra,
    });
    let trace: Untyped = null;
    let traceMaxLines: Untyped = null;
    const skip = (reason: string) => {
      log.info('recall: skipped', { channel: chatId, reason });
      if (trace) trace.skipped = reason;
      // The daily limits are named to the persona's own search (`outcome`); other gates are no news to them.
      return finish(empty(reason === 'daily-cap' || reason === 'daily' ? { outcome: { kind: 'daily-cap' } } : {}));
    };
    const finish = (out: Untyped) => {
      if (trace) writeTrace({ placeId, trace, out, maxLines: traceMaxLines });
      return out;
    };
    // The journal's closing line of a run that started (`op`): what it found, never the text.
    const opResult = (out: Untyped, status: Untyped) => ({
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
      // Every run past the switch is traced, one skipped by a gate below included (its reason in `skipped`).
      trace = newTrace({ started, placeId: chatId, candidate, server });
      traceMaxLines = settings.traceMaxLines;
      if (!hasRecallContext({ channel, partnerId, memoryContext })) return skip('private-chat');
      if (!asksServer(server, retrieval)) return skip('no-query');
      if (capSpent()) return skip('daily-cap');
      await op?.started();

      // The persona's own search over the memory database.
      const db = recallDatabase(memoryDb);
      if (!db) {
        if (op) await op.failed(CODE.NOT_CONFIGURED);
        return finish(empty({ outcome: { kind: 'not-configured' } }));
      }
      const found = await runDbQuotes({
        db,
        config,
        settings,
        snapshot,
        placeId,
        channel,
        partnerId,
        selfName,
        history,
        historyRef,
        candidate,
        terms,
        server,
        decorate,
        started,
        memoryContext,
        retrieval,
        lines,
      });
      if (found === null) return finish(await quotesTimedOut(chatId, op, empty));
      if (trace) trace.summary = { answer: 'quotes', stretch: null, text: null, note: null };
      if (op) await op.succeeded(opResult(found, 'ok'));
      return finish(found);
    } catch (err) {
      log.warn('recall: failed', {
        channel: chatId,
        reason: 'error',
        status: null,
        ...failureFields(err),
      });
      if (op) await op.failed(CODE.ERROR);
      return finish(empty({ outcome: { kind: 'error' } }));
    }
  }

  /**
   * A read-only source (`deps.record` / `deps.archive`) whose reads the lanes of one prefetch
   * share: each `iterate(id, query)` is read once (the first caller's), every other caller with
   * the same arguments gets the same lines. Null without the source.
   */
  function sharedSource(source: Untyped) {
    if (typeof source?.iterate !== 'function') return null;
    const reads = new Map();
    return {
      async *iterate(id: Untyped, query = {}) {
        const key = JSON.stringify([id, query]);
        if (!reads.has(key)) {
          reads.set(
            key,
            (async () => {
              const lines = [];
              for await (const line of source.iterate(id, query)) lines.push(line);
              return lines;
            })()
          );
        }
        yield* await reads.get(key);
      },
    };
  }

  /** The prefetch's fused units as excerpts: a stored item as it is, a stretch cut around its best hits. */
  function renderUnits(
    units: ReturnType<typeof rankPrefetch>,
    config: Untyped,
    placeId: string | null,
    decorate: Untyped,
    render: Parameters<typeof renderRecallWindows>[1],
    excerptChars: number,
    nameOf: Untyped,
    captionsFromCache: boolean
  ): Array<Untyped> {
    const rendered: Array<Untyped> = [];
    for (const unit of units) {
      if (unit.kind === 'memory') {
        const item = unit.item;
        rendered.push({
          source: 'memory',
          kind: item.kind,
          date: item.date ?? null,
          accountId: item.accountId ?? null,
          who: item.accountId ? nameOf(item.accountId) : null,
          id: item.itemId ?? null,
          lines: item.text,
          text: item.text,
        });
        continue;
      }
      // Only the best hit and the hits close to it are marked, so a long stretch with many hits is cut around them.
      const unitWindow = unit.window;
      const focus = focusHits(
        unitWindow.messages.map((m: Untyped) => m.id),
        unit.hitIds,
        FOCUS_LINES
      );
      const focused = { ...unitWindow, hitIds: new Set(focus) };
      const window = typeof decorate === 'function' ? { ...focused, messages: decorate(focused.messages) } : focused;
      // A stored line carries its own media's text forms; only a window of live messages asks the describer's cache.
      if (captionsFromCache) window.descriptions = cachedCaptions(config, placeId, [window]);
      const [shown] = renderRecallWindows([window], render);
      const lines = cutStretch(shown?.lines ?? [], excerptChars);
      if (lines.length === 0) continue;
      const text = stretchText(lines, window.messages, render?.labels, mediaNameOf);
      const ids = lines.map((line) => line.id);
      rendered.push({
        source: 'history',
        placeId: window.placeId,
        // The stored place of the stretch, read from its lines: a turn finds a hit's stored line by it.
        place: window.messages.find((m: Untyped) => typeof m?.stored?.placeId === 'string')?.stored?.placeId ?? null,
        channelName: window.channelName ?? null,
        startTs: lines[0].ts,
        endTs: lines[lines.length - 1].ts,
        id: unit.hitIds[0] ?? ids[0],
        ids,
        hitIds: focus.filter((id) => ids.includes(id)),
        lines: text,
        text,
      });
    }
    return rendered;
  }

  /** A prefetch's facts under the context its own reads use, anchored on who is speaking. */
  function readPrefetchFacts(
    db: Untyped,
    config: Untyped,
    settings: Untyped,
    where: Omit<DbReaderInput, 'db' | 'config'>,
    retrieval: RetrievalInput | null,
    text: unknown,
    laneVectors: unknown
  ): Promise<MemoryPage | null> {
    const reader = dbReader({ db, config, ...where });
    const asker: unknown = where.asker;
    const speaker =
      typeof asker === 'string' && asker !== '' ? personOfMember(store, asker, String(reader.ctx.iface)) : null;
    return prefetchFacts({
      db,
      ctx: reader.ctx,
      retrieval,
      text,
      speaker: speaker === null ? [] : [speaker],
      config,
      prefetch: settings.prefetch,
      now,
      laneVectors,
      model: reader.model,
    });
  }

  async function prefetch({
    placeId = null,
    snapshot = null,
    channel,
    partnerId = null,
    selfId,
    selfName,
    history = [],
    historyRef,
    lanes = [],
    at = null,
    decorate = null,
    asker = null,
    memoryContext = null,
    retrieval = null,
  }: PrefetchInput): Promise<PrefetchOutcome | null> {
    const started = now();
    const list = Array.isArray(lanes) ? lanes.filter((lane) => lane && typeof lane.kind === 'string') : [];
    const basis = list.map((lane) => lane.kind);
    const chatId = channel?.id ?? null;
    let timer = null;
    const finish = (status: Untyped, extra: Record<string, unknown> = {}) => {
      const out: PrefetchOutcome = { status, basis, excerpts: [], ms: now() - started, ...extra };
      log.info('recall: prefetched', {
        channel: chatId,
        status,
        lanes: basis.length,
        excerpts: out.excerpts.length,
        candidates: out.stats?.candidates ?? 0,
        searches: out.stats?.searches ?? 0,
        failed: out.stats?.failed ?? 0,
        meaning: out.stats?.meaning ?? 0,
        partial: out.partial === true,
        ms: out.ms,
      });
      return out;
    };
    try {
      const config = hot.config;
      const settings = recallSettings(config);
      if (!settings || list.length === 0) return null;
      if (!hasRecallContext({ channel, partnerId, memoryContext }))
        return finish('unavailable', { reason: 'private-chat' });
      const p = settings.prefetch;
      const until = isFiniteNumber(at) ? at : now();
      const bounded = isFiniteNumber(at);
      const controller = new AbortController();
      const signal = controller.signal;
      const scope = scopeOf({ config, snapshot, channel, partnerId, placeId });
      const { privateAccountId, privatePlaces, allowEntry } = scope;
      const profiles = profilesFor(placeId);
      const nameOf = namesFor(placeId, profiles);
      const channelNameOf = (id: Untyped) => snapshot?.get(id)?.name ?? null;
      // A replay's moment bounds the archive too: an entry recorded after it did not exist yet.
      const archiveShared = sharedSource(
        bounded && typeof archive?.iterate === 'function'
          ? {
              async *iterate(id: Untyped, query: Untyped) {
                for await (const entry of archive.iterate(id, query))
                  if (!(Date.parse(entry?.recordedAt) > until)) yield entry;
              },
            }
          : archive
      );
      const trigger = list.find((lane) => lane.kind === 'message')?.words ?? '';
      const plans = list.map((lane) =>
        lanePlan(lane, {
          profiles,
          selfId,
          selfName,
          maxForms: settings.maxForms,
          shortWords: p.shortWords,
          minFormsMatched: p.minFormsMatched,
          trigger,
        })
      );
      // A source of a live turn's moment only: nothing after `at` (a replay's past moment).
      const inTime = (window: Untyped) => ({
        ...window,
        messages: window.messages.filter((m: Untyped) => !(m.ts > until)),
      });
      // By task, not by arrival: the fusion breaks a tie by list order, and the reader's answers come when they come.
      const settled = new Map<number, Untyped>();
      const stats = { searches: 0, failed: 0, meaning: 0 };
      const task = (name: string, work: Untyped) => {
        const at = stats.searches;
        stats.searches += 1;
        return work().then(
          (result: Untyped) => {
            if (result && !signal.aborted) settled.set(at, result);
          },
          (err: Untyped) => {
            stats.failed += 1;
            if (!signal.aborted)
              log.warn('recall: prefetch failed', {
                channel: chatId,
                stage: name,
                ...failureFields(err),
              });
          }
        );
      };
      const stages: Record<string, number> = {};
      const timed = (name: string, promise: Untyped) => {
        const at = now();
        return promise.finally(() => {
          stages[name] = Math.max(stages[name] ?? 0, now() - at);
        });
      };
      // The database answers the words and the meaning of every lane (while it is not open, the stored memory alone).
      const db = recallDatabase(memoryDb);
      const dbMeaning = Boolean(db) && typeof embed === 'function';
      // One embedding request for every lane's text.
      const laneVectors = dbMeaning
        ? timed(
            'embed',
            embed(
              list.map((lane) => oneLine(lane.text)),
              { config, purpose: 'recall-query', signal }
            )
          )
        : Promise.resolve(null);
      laneVectors.catch(() => {});
      const tasks: Array<Untyped> = [];
      plans.forEach((plan, i) => {
        tasks.push(
          task('memory', async () => {
            const used = plan;
            if (!used || !placeId) return null;
            const forms = [...used.phrases, ...used.forms];
            if (forms.length === 0 && used.who.length === 0) return null;
            const memory = await timed(
              'memory',
              storedMemory({
                config,
                settings,
                placeId,
                channel,
                server: { forms, who: used.who, from: null, to: bounded ? until : null },
                allowEntry,
                privateAccountId,
                privatePlaces,
                signal,
                source: archiveShared,
              })
            );
            const relevant = (item: Untyped) =>
              countFormsIn([item.text], used.phrases) > 0 ||
              countFormsIn([item.text], used.forms) >= Math.max(1, used.need);
            return { lane: list[i].kind, memory: memory.filter(relevant) };
          })
        );
      });
      if (db) {
        // One search of the database per lane: words, letters, meaning and people fused, the stretches built around the
        // hits. A word hit is relevant by lexicalKeep (its terms and phrases, its cosine when the meaning search found
        // it); a meaning hit by the same floors the vector files use, with a term of the lane or a strong cosine.
        const reader = dbReader({ db, config, snapshot, placeId, channel, partnerId, asker, memoryContext });
        const exclusions = historyExclusions({ history, historyRef, context: reader.ctx, channel });
        list.forEach((lane, i) => {
          const plan = plans[i];
          const forms = plan ? [...plan.phrases, ...plan.forms] : [];
          if (forms.length === 0 && !((plan?.who?.length ?? 0) > 0)) return;
          tasks.push(
            task('db', async () => {
              const vector = dbMeaning ? ((await laneVectors.catch(() => null))?.[i] ?? null) : null;
              const found = await timed(
                'record',
                searchDb(
                  db,
                  laneSearch({
                    reader,
                    forms,
                    who: plan?.who,
                    until,
                    bounded,
                    vector,
                    settings: dbSettings(config),
                    candidates: p.candidates,
                    exclusions,
                    nameOf,
                    selfName,
                    channelNameOf,
                  }),
                  signal
                )
              );
              if (signal.aborted) return null;
              const windows = found.windows.map(inTime);
              const shown = new Map<string, Untyped>(
                windows.flatMap((window: Untyped) => window.messages.map((m: Untyped): [string, Untyped] => [m.id, m]))
              );
              const byScore = [...found.hits]
                .filter((hit) => shown.has(hit.messageId))
                .sort((a, b) => b.score - a.score);
              const cosines = vector
                ? new Map(byScore.filter((hit) => hit.cosine !== null).map((hit) => [hit.messageId, hit.cosine]))
                : null;
              const lexical = byScore
                .filter(
                  (hit) =>
                    (hit.streams.includes('words') || hit.streams.includes('trigram')) &&
                    lexicalKeep({ messageId: hit.messageId, terms: hit.terms, phrases: hit.phrases }, cosines, p)
                )
                .map((hit) => hit.messageId);
              // An item's own words and meaning count as a line's would, at the message that shows it.
              const items = itemLines(found.mediaHits, shown, p);
              const meant = byScore
                .filter(
                  (hit) =>
                    hit.streams.includes('meaning') &&
                    hit.cosine >= p.minMeaningScore &&
                    indexWords(shown.get(hit.messageId).content).length >= MEANING_MIN_WORDS &&
                    (hit.cosine >= p.strongMeaningScore || hit.terms > 0)
                )
                .map((hit) => hit.messageId);
              stats.meaning += meant.length + items.meaning.length;
              return {
                lane: lane.kind,
                windows,
                lexical: [...lexical, ...items.lexical],
                meaning: [...meant, ...items.meaning],
              };
            })
          );
        });
      }
      if (tasks.length === 0) return finish('none', { stats: { ...stats, candidates: 0 } });
      // The stored facts of the same moment, through the one retrieval service: they share this deadline and token budget.
      const facts: { page: MemoryPage | null } = { page: null };
      const factsRead = (
        db
          ? readPrefetchFacts(
              db,
              config,
              settings,
              { snapshot, placeId, channel, partnerId, asker, memoryContext },
              retrieval,
              trigger || list[0].words,
              dbMeaning ? laneVectors : null
            )
          : Promise.resolve(null)
      ).then((page: MemoryPage | null) => {
        if (!signal.aborted) facts.page = page;
      });
      const deadline = new Promise((resolve) => {
        // Not unref'd: a turn waits for it, and it is short.
        timer = timers.set(() => resolve(TIMEOUT), p.deadlineMs);
      });
      const outcome = await Promise.race([Promise.all([...tasks, factsRead]), deadline]);
      const timedOut = outcome === TIMEOUT;
      if (timedOut) controller.abort();
      const found = [...settled.keys()].sort((a, b) => a - b).map((at) => settled.get(at));
      const units = rankPrefetch(found);
      const render = {
        labels: hot.prompts?.labels ?? {},
        timezone: config.bot?.timezone,
        selfName,
        seeReactions: true,
        indexed: false,
      };
      const rendered = renderUnits(units, config, placeId, decorate, render, p.excerptChars, nameOf, !db);
      // Facts come after the windows: they take the room the windows leave, so they can never hide a plain line.
      rendered.push(...factExcerpts(facts.page));
      const excerpts = fitExcerpts(rendered, p).map(({ text, ...excerpt }) => excerpt);
      const extra = {
        excerpts,
        stats: { ...stats, candidates: units.length, stages },
        ...(timedOut ? { partial: true } : {}),
      };
      if (excerpts.length > 0) return finish('ok', extra);
      if (timedOut) return finish('timeout', extra);
      if (stats.failed >= stats.searches) return finish('unavailable', { ...extra, reason: 'failed' });
      return finish('none', extra);
    } catch (err) {
      log.warn('recall: prefetch failed', { channel: chatId, stage: 'run', ...failureFields(err) });
      return finish('unavailable', { reason: 'error' });
    } finally {
      if (timer !== null) timers.clear(timer);
    }
  }

  return {
    run: (args) => track('recall.run', () => run(args)),
    available,
    prefetch: (args) => track('recall.prefetch', () => prefetch(args)),
    window,
  };
}
