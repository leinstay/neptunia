// What a turn looks up before its reply request: the memory prefetch of its trigger, the search classifier with the web
// and server searches it asks for, the turn planner that stands in for the classifiers, the splitter of a message that
// holds several requests, and the directory and partner a turn's searches and mentions read. createTurnRunner
// (src/behavior/turn.js) builds it once per runner with createLookup; the attempt calls its functions.

import { askPlanner, parsePlannerAnswer } from '../behavior/planner.js';
import { prefetchLanes, prefetchOn, wakeLanes } from '../behavior/prefetch.js';
import { fillPromptTemplate } from '../behavior/prompt.js';
import { fallbackLookupPlan, parseLookupAnswer, recallSettings } from '../behavior/recall.js';
import type { Snapshot } from '../behavior/snapshot.ts';
import { parseSplitAnswer, splitSettings } from '../behavior/split.js';
import type { Reads } from '../interface/reads.ts';
import { railReason, roleRequestOptions } from '../llm/openrouter.js';
import { roleModel } from '../llm/roles.js';
import { log } from '../log.js';
import type { MemberInfo } from '../protocol/adapter.ts';
import { zonedDay } from '../time.js';
import { CODE } from '../tools/codes.ts';
import type { JournalNotes } from './journal-notes.ts';
import { journalled } from './journal.ts';
import type { ClassifierContextInput } from './lookup-input.ts';
import { lookupClassifierInput } from './lookup-input.ts';
import { mentionDirectory } from './mentions.ts';
import type { ClassifierLlm, Rewatch } from './rewatch.ts';
import { DIRECT_CALLS } from './triggers.ts';
import type { TriggerKind } from './triggers.ts';

/** The live config, as far as the lookup reads it; the settings functions read their own sections. */
export type LookupConfig = ClassifierContextInput['config'] & {
  web?: { search?: { maxPerTurn?: number; classifierMaxOutputTokens?: number; contextMessages?: number } | null };
  bot?: { timezone?: string; nameTriggers?: Array<string> } | null;
  features?: { privateLikeServer?: unknown } | null;
};

/** The web lookup (src/web/lookup.js#createLookup), as the search on a question uses it. */
export type LookupWeb = {
  hasSearch?: () => boolean;
  webCapLeft?: () => number;
  search: (guildId: string, query: string) => Promise<{ text?: unknown; sources?: unknown } | null>;
};

/** What recall's server search found: its summary, the stretch it quoted and the people in it. */
type RecallFound = { text?: unknown; stretch?: unknown; people?: unknown } | null;

/** The recall runner (src/behavior/recall-run.js#createRecall), as the searches and the prefetch use it. */
export type LookupRecall = {
  available?: () => unknown;
  run?: (input: Record<string, unknown>) => Promise<RecallFound>;
  prefetch?: (
    input: Record<string, unknown>
  ) => Promise<{ status?: unknown; excerpts?: ReadonlyArray<unknown>; ms?: unknown } | null>;
} | null;

/** The memory store, as the lookup reads its profiles. */
type LookupStore = { listUserProfiles?: (guildId: string) => Array<object> | null };

/** What a preparation step writes: its start, its result and its failure (createPrepLedger's). */
type PrepOp = NonNullable<Parameters<typeof journalled>[0]>;

/** What a step's result is judged on when the journal says whether it reached the request. */
type PrepResult = { excerpts: number; summaryChars: number; stretch: unknown };

/** The attempt's journal step: one preparation operation of a stage, or null when the journal does not follow. */
export type JournalStep = (
  stage: string,
  name: string,
  fields: { input: object },
  offeredOf?: (result: PrepResult) => unknown
) => PrepOp | null;

/** What createLookup reads: the dependencies and the functions of the other topic modules it calls. */
export type LookupContext = {
  hot: {
    readonly prompts: { labels: object; lookup?: string | null; planner?: string | null };
  };
  store: LookupStore;
  llm: ClassifierLlm;
  clock: () => number;
  lookup: LookupWeb | undefined;
  recall: LookupRecall;
  membersOf: ((communityId: string) => Iterable<unknown>) | null;
  selfIdOf: () => string;
  ifaceReads: Reads;
  discoveryPrompt: (config: unknown) => { index: string; names: Array<string> };
  classifierContext: Rewatch['classifierContext'];
  linkCalls: JournalNotes['linkCalls'];
};

type Channel = { id: string; communityId?: string | null };

/** One lane of a prefetch, and the prefetch of a trigger: its lanes and the search they make. */
type Lane = { kind: string; text: string; words: string };
type Prefetching = { lanes: Array<Lane>; pending: Promise<unknown> };

/** A server search a lookup answer asks for. */
type ServerPart = NonNullable<ReturnType<typeof parseLookupAnswer>['server']>;

/** The request's `lookup` input: the web search's result, with what the server search found. */
export type LookupInput = Record<string, unknown> | null;

/** An offer of the planner: the lines it lists, with their ages for the episodes. */
type Offer = { lines?: Array<string>; ages?: Array<string>; ids?: unknown } | null | undefined;

/** The answer of one attempt's planner, with the offers it was sent. */
export type PlanResult = Awaited<ReturnType<typeof askPlanner>> & {
  offer: { channel: Offer; episodes: Offer; media: Offer; lookup: boolean };
};

/** One attempt's turn planner (createTurnPlan). */
export type TurnPlan = {
  early: boolean;
  result: Promise<PlanResult>;
  readonly started: boolean;
  offerChannels: (offer: Offer) => void;
  start: (inputs: {
    transcriptBlock?: string;
    candidateBlock?: string | null;
    episodes?: Offer;
    media?: Offer;
    lookup?: boolean;
  }) => void;
  abandon: (reason?: string) => void;
};

type LookupArgs = {
  config: LookupConfig;
  guildId: string;
  channel: Channel;
  snapshot?: Snapshot | null;
  partner?: { id?: string | null } | null;
  selfId: string | null;
  selfName: string;
  history: ClassifierContextInput['history'];
  chatHistory: ClassifierContextInput['history'];
  trigger: ClassifierContextInput['trigger'];
  descriptions?: Map<string, unknown>;
  videos?: Map<string, unknown>;
  reads?: Map<string, unknown>;
  webOn: boolean;
  serverOn: boolean;
  onSearch?: (() => void) | null;
  onSkills?: ((skills: NonNullable<ReturnType<typeof parseLookupAnswer>['skills']>) => void) | null;
  journalStep?: JournalStep | null;
  triggerKind?: TriggerKind | null;
  limits?: { add: (limit: { kind: string; where: string; detail: string }) => void } | null;
  planned?: PlanResult | null;
  turnContext?: (() => unknown) | null;
};

export type Lookup = {
  startPrefetch: (args: {
    config: LookupConfig;
    channel: Channel;
    snapshot?: Snapshot | null;
    guildId: string;
    guild: unknown;
    partner?: { id?: string | null } | null;
    trigger: { id?: string; authorId?: string | null } | null;
    candidate?: { content?: string | null; authorId?: string | null } | null;
    triggerKind?: TriggerKind | null;
    mode?: string | null;
    history: Array<object>;
    selfId: string | null;
    selfName: string;
    nameOf?: ((id: string) => string | null) | null;
    journalStep?: JournalStep | null;
    wake?: { intentions?: ReadonlyArray<{ purpose?: unknown } | null> } | null;
  }) => Prefetching | null;
  recallAvailable: () => boolean;
  turnDirectory: (args: { guildId: string; memoryOn: boolean }) => () => ReturnType<typeof mentionDirectory>;
  privatePartner: (args: {
    guildId: string;
    userId: string | null | undefined;
    config: LookupConfig;
  }) => Promise<MemberInfo | null>;
  createTurnPlan: (args: {
    config: LookupConfig;
    channelId: string;
    selfName: string;
    triggerKind: TriggerKind | null;
    limits: unknown;
    early: boolean;
  }) => TurnPlan;
  lookupGate: (args: { config: LookupConfig; webOn: boolean; serverOn: boolean }) => {
    webCan: boolean;
    skip: string | null;
  };
  maybeLookup: (args: LookupArgs) => Promise<LookupInput>;
  maybeSplit: (args: {
    config: LookupConfig;
    channelId: string;
    selfName: string;
    history: ClassifierContextInput['history'];
    trigger: ClassifierContextInput['trigger'];
    descriptions?: Map<string, unknown>;
    prompt: string;
    isLate: () => boolean;
  }) => Promise<Array<string> | null>;
};

// health: allow function-length until 2027-04-01 -- the lookup shares the runner state of src/behavior/turn.js, moved whole in stage 5b
export function createLookup(ctx: LookupContext): Lookup {
  const {
    hot,
    store,
    llm,
    clock,
    lookup,
    recall,
    membersOf,
    selfIdOf,
    ifaceReads,
    discoveryPrompt,
    classifierContext,
    linkCalls,
  } = ctx;

  // Trigger key -> the prefetch already started for it (startPrefetch): a later attempt of the
  // same turn, or the same part of a split message, reuses it instead of searching again.
  const prefetchMemo = new Map<string, Promise<unknown>>();
  /** The most triggers whose prefetch is remembered (the oldest forgotten first). */
  const PREFETCH_MEMO = 16;

  /**
   * The automatic memory prefetch of a turn (src/behavior/prefetch.js, read now): with prefetchOn
   * and the recall runner's `prefetch`, the lanes of this turn's trigger (prefetchLanes: none for
   * a turn no person's new message opened, nor for a trivial one -- logged `recall: prefetch
   * skipped` with its `reason`), searched once per trigger and text (`prefetchMemo`) over the
   * served guild (a private chat on its `partner`'s behalf), the persona's lines marked with her
   * calls (linkCalls). A journal step `memory-prefetch` of the stage `prefetch` (`input.lanes`;
   * `status`, `excerpts`, `ms`) when it starts. Resolves never rejecting. Null when nothing runs,
   * else `{ lanes, pending }`.
   */
  function startPrefetch({
    config,
    channel,
    snapshot = null,
    guildId,
    guild,
    partner,
    trigger,
    candidate,
    triggerKind,
    mode,
    history,
    selfId,
    selfName,
    nameOf,
    journalStep,
    wake = null,
  }: Parameters<Lookup['startPrefetch']>[0]): Prefetching | null {
    if (!prefetchOn(config) || typeof recall?.prefetch !== 'function' || !guild) return null;
    const settings = recallSettings(config)?.prefetch;
    if (!settings) return null;
    // An inner turn has no message: its lane is the purposes of the intentions it woke for.
    const purposes = mode === 'inner' ? (wake?.intentions ?? []).map((record) => record?.purpose) : null;
    const { lanes, skip } = purposes
      ? // wakeLanes reads each purpose as text, as the intentions keep it.
        wakeLanes(purposes as Array<string>)
      : prefetchLanes({
          trigger,
          candidate,
          triggerKind,
          mode,
          history,
          settings,
          selfId,
          selfName,
          selfNames: config.bot?.nameTriggers ?? [],
          nameOf,
        });
    if (skip) {
      if (skip !== 'no-trigger') log.info('recall: prefetch skipped', { channel: channel.id, reason: skip });
      return null;
    }
    const key = purposes
      ? `${channel.id}:inner:${lanes[0]?.text ?? ''}`
      : `${channel.id}:${trigger?.id}:${candidate?.content ?? ''}`;
    const memo = prefetchMemo.get(key);
    if (prefetchMemo.has(key) && memo) return { lanes, pending: memo };
    const basis = lanes.map((lane) => lane.kind);
    const op =
      journalStep?.('prefetch', 'memory-prefetch', { input: { lanes: basis } }, (result) => result.excerpts > 0) ??
      null;
    const pending = (async () => {
      await op?.started();
      try {
        // Checked above: the recall runner has `prefetch`.
        const found = await recall.prefetch!({
          guildId,
          snapshot,
          channel,
          partnerId: partner?.id ?? null,
          selfId,
          selfName,
          history,
          lanes,
          asker: candidate?.authorId ?? null,
          decorate: (lines: Array<object>) => linkCalls(lines, { channel, snapshot, guildId }),
        });
        op?.succeeded({ status: found?.status ?? null, excerpts: found?.excerpts?.length ?? 0, ms: found?.ms ?? null });
        return found;
      } catch (err) {
        log.warn('recall: prefetch failed', { channel: channel.id, stage: 'turn', name: nameOfError(err) });
        op?.failed(CODE.ERROR);
        return { status: 'unavailable', basis, excerpts: [] };
      }
    })();
    prefetchMemo.set(key, pending);
    // The memo is not empty while it is over its size.
    while (prefetchMemo.size > PREFETCH_MEMO) prefetchMemo.delete(prefetchMemo.keys().next().value as string);
    return { lanes, pending };
  }

  /**
   * Whether the server search (`recall`) could run now: wired, and its
   * `available()` (the switch, its prompt, the daily caps; read only) says
   * yes. A throw counts as no.
   */
  function recallAvailable(): boolean {
    if (typeof recall?.available !== 'function' || typeof recall.run !== 'function') return false;
    try {
      return recall.available() === true;
    } catch {
      return false;
    }
  }

  /**
   * The fallback directory of one turn (mentionDirectory) as a thunk, built on its first call
   * and kept for the turn: the members of the served community the member directory holds (only the members
   * the interface already told the core of, no read) and, with memory on, the stored
   * profiles. A failure to build it logs `turn: directory failed` and gives an empty one.
   */
  function turnDirectory({
    guildId,
    memoryOn,
  }: {
    guildId: string;
    memoryOn: boolean;
  }): () => ReturnType<typeof mentionDirectory> {
    let built: ReturnType<typeof mentionDirectory> | null = null;
    return () => {
      if (built) return built;
      try {
        const members = typeof membersOf === 'function' ? membersOf(guildId) : [];
        const profiles =
          memoryOn && typeof store.listUserProfiles === 'function' ? (store.listUserProfiles(guildId) ?? []) : [];
        built = mentionDirectory({ members, profiles, selfId: selfIdOf() || null });
      } catch (err) {
        log.warn('turn: directory failed', { guildId, error: err });
        built = [];
      }
      return built;
    };
  }

  /**
   * A private chat's partner as a member of the served community (`memberInfo`), for a private chat that works
   * like a server turn on their behalf: features.privateLikeServer (read from `config`, the turn's live
   * config; a missing key counts as on, only false turns it off). Null with the switch off or without a user id.
   * A read the interface does not answer, an error answer and a user who is no member (the member left) are null
   * and log `turn: partner failed`. Never rejects.
   */
  async function privatePartner({
    guildId,
    userId,
    config,
  }: Parameters<Lookup['privatePartner']>[0]): Promise<MemberInfo | null> {
    if (config.features?.privateLikeServer === false || !userId) return null;
    const found = await ifaceReads.memberInfo({ communityId: guildId, memberId: String(userId) });
    if (found?.member) return found.member;
    log.warn('turn: partner failed', { guildId, userId });
    return null;
  }

  /**
   * `work()` as a promise that never rejects: a throw or a rejection logs
   * `lookup: failed` with the `part` it was (`web` / `server`) and gives null.
   */
  function settleLookupPart<TValue>(
    work: () => TValue | Promise<TValue>,
    channelId: string,
    part: string
  ): Promise<TValue | null> {
    return Promise.resolve()
      .then(work)
      .catch((err: unknown) => {
        log.warn('lookup: failed', { channel: channelId, part, error: err });
        return null;
      });
  }

  /**
   * One attempt's turn planner (src/behavior/planner.js, features.turnPlanner
   * exactly true): the one request that stands in for the route, the
   * participation pick, the re-watch and the search classifiers. The pull's
   * route step registers its channel list (`offerChannels`, ignored once the
   * planner started) and waits on `result` for its pick; the participation,
   * re-watch and lookup stages wait on `result` too. `start(inputs)` sends
   * the request once -- `transcriptBlock`, `candidateBlock`, the `episodes`
   * and `media` offers (`{ lines, ids }` / rewatchOffer's, null when not
   * offered) and `lookup` (true when the search classifier would have been
   * asked); later calls do nothing. `abandon(reason)` settles `result` with
   * every block missing when the planner never started (a deadline passed
   * first, or the attempt ended), so no stage waits forever. `early` is true
   * on a turn whose pull is awaited before its preparation (a source, or a
   * mode still to choose): its route step starts the planner itself.
   * `result` never rejects: askPlanner's `{ outcome, reason, blocks }` plus
   * `offer` (`channel`, `episodes`, `media`: the offers sent, null when not;
   * `lookup`: boolean), what each consumer maps the block's numbers back with.
   */
  function createTurnPlan({
    config,
    channelId,
    selfName,
    triggerKind,
    limits,
    early,
  }: Parameters<Lookup['createTurnPlan']>[0]): TurnPlan {
    let channelOffer: Offer = null;
    let started = false;
    let settle: (value: PlanResult) => void = () => {};
    const result = new Promise<PlanResult>((resolve) => {
      settle = resolve;
    });
    const unused = (reason: string): PlanResult => ({
      outcome: 'skipped',
      reason,
      blocks: parsePlannerAnswer(''),
      offer: { channel: null, episodes: null, media: null, lookup: false },
    });
    const offered = (offer: Offer): Offer => (Array.isArray(offer?.lines) && offer.lines.length > 0 ? offer : null);
    return {
      early,
      result,
      get started() {
        return started;
      },
      offerChannels(offer) {
        if (!started) channelOffer = offered(offer);
      },
      start({
        transcriptBlock = '',
        candidateBlock = null,
        episodes = null,
        media = null,
        lookup: lookupWanted = false,
      }) {
        if (started) return;
        started = true;
        const offer = {
          channel: channelOffer,
          episodes: offered(episodes),
          media: offered(media),
          lookup: lookupWanted === true,
        };
        const discovery = discoveryPrompt(config);
        askPlanner({
          llm,
          config,
          prompt: hot.prompts?.planner,
          selfName,
          today: zonedDay(clock(), config.bot?.timezone),
          skills: discovery.index,
          skillNames: discovery.names,
          offer: {
            channels: offer.channel?.lines,
            episodes: offer.episodes?.lines,
            episodeAges: offer.episodes?.ages,
            media: offer.media?.lines,
            lookup: offer.lookup,
          },
          transcriptBlock,
          candidateBlock,
          channelId,
          kind: triggerKind,
          now: clock,
          // The attempt's limits (src/llm/limits.js#createLimits), as askPlanner adds to them.
          limits: limits as { add: (...args: Array<unknown>) => unknown } | null,
        }).then(
          (asked) => settle({ ...asked, offer }),
          () => settle(unused('error'))
        );
      },
      abandon(reason = 'late') {
        if (started) return;
        started = true;
        settle(unused(reason));
      },
    };
  }

  /**
   * Which side of a lookup can run now (maybeLookup's gates, shared with the
   * turn planner's offer): the web side under `webOn` unless
   * `web.search.maxPerTurn` is below 1 (`no-slot`), the search has no key
   * (`no-key`) or its daily slots are spent (`cap`); `skip` is that code, or
   * `no-search`, when neither the web side nor the server side (`serverOn`)
   * can run, else null. Read only.
   */
  function lookupGate({ config, webOn, serverOn }: Parameters<Lookup['lookupGate']>[0]): {
    webCan: boolean;
    skip: string | null;
  } {
    const searchCfg = config.web?.search ?? {};
    let webSkip: string | null = null;
    if (webOn) {
      // The web side is on only with a lookup (the attempt's webOn).
      const web = lookup!;
      if ((searchCfg.maxPerTurn ?? 1) < 1) webSkip = 'no-slot';
      else if (typeof web.hasSearch === 'function' && !web.hasSearch()) webSkip = 'no-key';
      else if (typeof web.webCapLeft === 'function' && !(web.webCapLeft() > 0)) webSkip = 'cap';
    }
    const webCan = Boolean(webOn) && webSkip === null;
    return { webCan, skip: !webCan && !serverOn ? (webSkip ?? 'no-search') : null };
  }

  /**
   * The searches on a question: the web search (`webOn`: features.webLookup, web.search.enabled, a lookup with
   * `search`) and the search of the server's own history (`serverOn`: recall wired and available, a server turn or a
   * private chat with its `partner`; the community searched is the `snapshot`'s). One cheap classifier call
   * (prompts.lookup, `{{name}}` = the persona's display name, `{{today}}` = the injected clock's date `YYYY-MM-DD` in
   * `bot.timezone`, the zone its `when:` range is read in; on the `analyzer` model role (roleModel), its answer capped
   * at `web.search.classifierMaxOutputTokens`) reads the last `web.search.contextMessages` messages of `history` before
   * the trigger (with the pictures' captions, the video states and the read links this turn already has; on a routed
   * turn the caller passes the source channel's lines, where the call was written) and the trigger itself, and answers
   * `none` or labelled lines (src/behavior/recall.js#parseLookupAnswer, `when:` read in `bot.timezone`, forms capped at
   * `recall.maxForms`). The web side runs only under its own gates: `web.search.maxPerTurn` below 1 (`no-slot`), no
   * search key (`no-key`), its daily slots spent (`cap`: the lookup's `webCapLeft()`, when it has one; read only); the
   * classifier is not asked when neither side can run (`lookup: skipped` with the web side's reason, or `no-prompt`
   * without prompts.lookup). Then what the answer asks for runs in parallel: a `web` query goes to lookup.search (at
   * most one per turn), a `server` part to `recall.run` (`history` = `chatHistory`, the turn's own chat with its reply
   * parents: what `<chat>` shows; `context` = `history`, the lines this classifier read, with their `descriptions`;
   * `candidate` = the trigger); a part the answer asks for whose side cannot run is not run, and a failing part logs
   * `lookup: failed` and counts as nothing. Resolves the `lookup` input of the request (see createTurnRunner) or null.
   * The query, the forms and the transcript are data: never logged (`lookup: classified` carries codes and counts
   * only); an empty or blank answer is a failed call (`lookup: classifier failed`, `reason: 'empty'`). A failed call
   * (it threw, or answered nothing) on a direct call (`triggerKind` in DIRECT_CALLS) with `serverOn` and
   * recall.fallbackOnClassifierFailure on runs the server search on the question's own words instead
   * (fallbackLookupPlan over the stored profiles; `lookup: fallback` with `reason` `classifier-failed` | `empty` and
   * the counts, a `helper-fallback` entry on `limits`); never the web search; else no search. Its request is an
   * `analyzer` request (roleRequestOptions). `onSearch()` is called once the answer asks for a search that runs, before
   * it starts (the turn's deadline grows to pace.prepareSearchMs; until the answer the turn holds its deadline on this
   * call, see createDeadline's `hold`).
   * With the turn planner (`planned`: the attempt's createTurnPlan result)
   * no classifier is asked here: the planner's lookup block stands in for its
   * answer -- `ok` runs what it asks for; `none`, a planner that skipped or a
   * block it never offered run nothing; `invalid`, `missing` or a failed
   * planner call take the failed classifier's fallback above (`reason` the
   * state or the failure code; the `helper-fallback` entry is the planner's,
   * `where: 'planner:lookup'`).
   * Skills discovery (discoveryPrompt, read now): the classifier's `{{skills}}`
   * is filled with the registry's lines, and a `skills:` line of its answer
   * (parseLookupAnswer's `skills`) is handed to `onSkills` before any search
   * runs; with the planner the turn reads the planner's own `skills:` line.
   * An `agent:` line of the answer (a classifier prompt that still has one) is ignored: the
   * classifier never creates or suggests an errand, only the persona's own `errand.run` call does.
   * `lookup: classified` carries `route` -- what runs: `fast` (a web search), `memory` (a server
   * search), `+`-joined in that order, else `none`. `turnContext()` (optional) gives the turn's
   * execution context for the server search's database reads (turnContextOf).
   */
  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/turn.js in stage 5b, a pure move
  async function maybeLookup({
    config,
    guildId,
    channel,
    snapshot = null,
    partner = null,
    selfId,
    selfName,
    history,
    chatHistory,
    trigger,
    descriptions,
    videos,
    reads,
    webOn,
    serverOn,
    onSearch,
    onSkills = null,
    journalStep = null,
    triggerKind = null,
    limits = null,
    planned = null,
    turnContext = null,
  }: LookupArgs): Promise<LookupInput> {
    const channelId = channel.id;
    const prompt = hot.prompts?.lookup;
    const searchCfg = config.web?.search ?? {};
    const { webCan, skip: gateSkip } = lookupGate({ config, webOn, serverOn });
    let skip: string | null = null;
    if (!planned && !prompt) skip = 'no-prompt';
    else skip = gateSkip;
    if (skip) {
      log.info('lookup: skipped', { channel: channelId, reason: skip });
      return null;
    }

    // The chat around the question, with the pages this turn already read.
    const { triggerText, user } = lookupClassifierInput({
      config,
      labels: hot.prompts.labels,
      selfName,
      history,
      trigger,
      descriptions,
      videos,
      reads,
    });
    if (planned) {
      if (planned.offer?.lookup !== true || planned.outcome === 'skipped') return null;
      if (planned.outcome === 'failed') return fallback(planned.reason);
      const answer = planned.blocks.lookup;
      // The planner's lookup block reads the server part as parseLookupAnswer does.
      if (answer.state === 'ok') return runSearches({ web: answer.web, server: answer.server as ServerPart | null });
      return answer.state === 'none' ? null : fallback(answer.state);
    }

    // Read once: the request and its empty-answer warning name the same model.
    const model = roleModel(config, 'analyzer', 'lookup');
    // Skills discovery: the registry's lines fill `{{skills}}`, its names bound the `skills:` line.
    const discovery = discoveryPrompt(config);
    let completion;
    try {
      completion = await llm.complete(
        [
          {
            role: 'system',
            content: fillPromptTemplate(prompt, {
              today: zonedDay(clock(), config.bot?.timezone),
              name: selfName ?? '',
              skills: discovery.index,
            }),
          },
          { role: 'user', content: user },
        ],
        {
          model,
          ...roleRequestOptions(config, {
            role: 'analyzer',
            maxOutputTokens: searchCfg.classifierMaxOutputTokens ?? 2000,
            purpose: 'lookup',
          }),
        }
      );
    } catch (err) {
      // The client throws an Error, with the HTTP status when the provider answered one.
      const failure = err as { statusCode?: unknown; name?: unknown };
      log.warn('lookup: classifier failed', {
        channel: channelId,
        status: failure.statusCode ?? null,
        name: failure.name,
      });
      return fallback('classifier-failed');
    }
    if (!String(completion.text ?? '').trim()) {
      // Nothing at all (typically a reasoning model that spent its whole
      // output cap thinking) is a failed call, not a silent "none".
      log.warn('lookup: classifier failed', { channel: channelId, reason: 'empty', model: model ?? null });
      return fallback('empty');
    }
    const parsed = parseLookupAnswer(completion.text, {
      timezone: config.bot?.timezone,
      now: clock(),
      maxForms: recallSettings(config)?.maxForms,
      skillNames: discovery.names,
    });
    // The `skills:` line goes to the turn, whatever the searches do (src/tools/discovery.ts).
    if (parsed.skills) onSkills?.(parsed.skills);
    const { web, server } = parsed;
    const route =
      [webCan && web ? 'fast' : null, serverOn && server ? 'memory' : null].filter(Boolean).join('+') || 'none';
    // Codes and counts only, never the query, a form or a name.
    log.info('lookup: classified', {
      channel: channelId,
      picked: Boolean(web || server),
      parse: parsed.reason,
      web: Boolean(parsed.web),
      server: Boolean(server),
      forms: server?.forms.length ?? 0,
      who: server?.who.length ?? 0,
      ranged: Boolean(server && (server.from !== null || server.to !== null)),
      route,
    });
    return runSearches({ web, server });

    /**
     * The failed classifier's fallback (`reason`: `classifier-failed` | `empty`): on a direct call
     * (DIRECT_CALLS) with the server search possible and recall.fallbackOnClassifierFailure on, a
     * recall on the question's own words (fallbackLookupPlan); never the web side. Null otherwise.
     */
    async function fallback(reason: string | null): Promise<LookupInput> {
      if (!serverOn || !DIRECT_CALLS.has(triggerKind)) return null;
      const settings = recallSettings(config);
      if (!settings?.fallbackOnClassifierFailure) return null;
      const plan = fallbackLookupPlan({
        text: triggerText,
        profiles: store.listUserProfiles?.(guildId) ?? [],
        selfId,
        selfName,
        maxForms: settings.maxForms,
      });
      if (!plan) return null;
      // Counts only, never a form or a name.
      log.info('lookup: fallback', { channel: channelId, reason, forms: plan.forms.length, who: plan.who.length });
      // The planner records its own fallen-back blocks (src/behavior/planner.js#askPlanner).
      // The fallback's reason is the failure's code or the planner block's state.
      if (!planned) limits?.add({ kind: 'helper-fallback', where: 'lookup', detail: reason as string });
      return runSearches({ web: null, server: plan });
    }

    /** The searches asked for (`web` query, `server` part), those whose side can run, in parallel. */
    // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/turn.js in stage 5b, a pure move
    async function runSearches({
      web,
      server,
    }: {
      web: string | null;
      server: ServerPart | null;
    }): Promise<LookupInput> {
      const runWeb = webCan && Boolean(web);
      const runServer = serverOn && Boolean(server);
      if (!runWeb && !runServer) return null;
      onSearch?.();
      // The journal: each search the answer asks for is an operation of the engine (journalStep).
      const webOp = runWeb ? (journalStep?.('lookup', 'lookup', { input: { query: web } }) ?? null) : null;
      const recallOp =
        runServer && server
          ? (journalStep?.(
              'lookup',
              'recall',
              { input: { forms: server.forms, who: server.who, from: server.from, to: server.to } },
              (result) => result.summaryChars > 0 || result.stretch === true
            ) ?? null)
          : null;
      const [webResult, found] = await Promise.all([
        runWeb
          ? settleLookupPart(
              () =>
                journalled(
                  webOp,
                  // runWeb holds only with a web query and the lookup (webCan).
                  () => lookup!.search(guildId, web as string),
                  (result) =>
                    result
                      ? {
                          result: { results: Array.isArray(result.sources) ? result.sources.length : 0 },
                          offered: Boolean(result.text),
                        }
                      : { failed: CODE.NO_RESULT }
                ),
              channelId,
              'web'
            )
          : null,
        runServer
          ? settleLookupPart(
              () =>
                // runServer holds only with recall wired and available (serverOn).
                recall!.run!({
                  ...(recallOp ? { op: recallOp } : {}),
                  guildId,
                  snapshot,
                  channel,
                  partnerId: partner?.id ?? null,
                  selfId,
                  selfName,
                  history: chatHistory,
                  context: history,
                  contextDescriptions: descriptions,
                  candidate: trigger,
                  server,
                  // Her lines in the found stretches show her skill calls like her chat lines.
                  decorate: (lines: Array<object>) => linkCalls(lines, { channel, snapshot, guildId }),
                  // The turn's execution context, issued when the search runs.
                  ...(typeof turnContext === 'function' ? { memoryContext: turnContext() } : {}),
                }),
              channelId,
              'server'
            )
          : null,
      ]);
      // A server search that found nothing leaves no server part.
      const serverPart =
        found && (found.text || found.stretch)
          ? {
              text: found.text ?? null,
              stretch: found.stretch ?? null,
              people: Array.isArray(found.people) ? (found.people as Array<unknown>) : [],
            }
          : null;
      if (!serverPart) return webResult ?? null;
      return { ...(webResult ?? {}), server: serverPart };
    }
  }

  /**
   * The splitter (src/behavior/split.js): whether the call `trigger` holds
   * several requests. One cheap classifier call (`prompt`, prompts/split.md,
   * `{{name}}` = the persona's display name, `{{maxTasks}}` = split.maxTasks;
   * on the `analyzer` model role (roleModel), its answer capped at split.maxOutputTokens, a
   * `analyzer` request: roleRequestOptions, purpose `split`) reads the last
   * `split.contextMessages` messages of `history` before the trigger (the
   * captions this turn has at its start) and the trigger itself, and answers
   * `one` or 2..maxTasks lines `- <part>` (parseSplitAnswer). Resolves the
   * parts, or null for one request: `one`, a failed call (`split: failed`
   * with the rail's code or `llm-error` and the HTTP status), an empty or
   * unparsable answer (`split: failed`, `empty` / `unparsed`). Every answer
   * that parsed logs `split: verdict` (`parts`: 1 for `one`, `ms`, and `late`
   * once the turn went on without it, `isLate()`). Codes and counts only,
   * never a part. Never throws.
   */
  async function maybeSplit({
    config,
    channelId,
    selfName,
    history,
    trigger,
    descriptions,
    prompt,
    isLate,
  }: Parameters<Lookup['maybeSplit']>[0]): Promise<Array<string> | null> {
    const settings = splitSettings(config);
    const startedAt = clock();
    let completion;
    try {
      const { triggerText, transcriptBlock } = classifierContext({
        config,
        selfName,
        history,
        trigger,
        contextMessages: settings.contextMessages,
        descriptions,
      });
      completion = await llm.complete(
        [
          {
            role: 'system',
            content: fillPromptTemplate(prompt, { name: selfName ?? '', maxTasks: settings.maxTasks }),
          },
          {
            role: 'user',
            content: `${transcriptBlock}<candidate>\n${trigger.authorName}: ${triggerText}\n</candidate>`,
          },
        ],
        {
          model: roleModel(config, 'analyzer', 'split'),
          ...roleRequestOptions(config, {
            role: 'analyzer',
            maxOutputTokens: settings.maxOutputTokens,
            purpose: 'split',
          }),
        }
      );
    } catch (err) {
      // A thrown value carries its HTTP status when the provider answered one.
      const status = (err as { statusCode?: unknown } | null | undefined)?.statusCode ?? null;
      log.warn('split: failed', { channel: channelId, reason: railReason(err), status });
      return null;
    }
    const { parts, reason } = parseSplitAnswer(completion?.text, settings);
    const late = isLate() ? { late: true } : {};
    if (reason === 'empty' || reason === 'unparsed') {
      log.warn('split: failed', { channel: channelId, reason, status: null, ...late });
      return null;
    }
    log.info('split: verdict', { channel: channelId, parts: parts?.length ?? 1, ms: clock() - startedAt, ...late });
    return parts;
  }

  return {
    startPrefetch,
    recallAvailable,
    turnDirectory,
    privatePartner,
    createTurnPlan,
    lookupGate,
    maybeLookup,
    maybeSplit,
  };
}

/** The name of a thrown value, when it has one. */
function nameOfError(err: unknown): unknown {
  // A thrown value is anything; its name is read when it has one, as an Error does.
  return (err as { name?: unknown } | null | undefined)?.name ?? null;
}
