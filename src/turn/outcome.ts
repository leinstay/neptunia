// How a turn ends: runTurn around its attempts, the chain of parts of a message that holds several requests, the facts
// an addressed turn keeps for her next request, the end hook and the idle notifications, and the `selfreflection` wake's
// inputs. createTurnRunner (src/behavior/turn.js) builds it once per runner with createOutcome over its attempt
// (runTurnOnce); the runner's facade hands out runTurn and the chain and idle functions.

import type { FactInput } from '../behavior/inner.ts';
import { wakeInputs } from '../behavior/diary-turn.ts';
import { portIface } from '../interface/capabilities.ts';
import type { Reads } from '../interface/reads.ts';
import { errorCodeOf } from '../llm/openrouter.js';
import { log } from '../log.js';
import type { ConversationRef } from '../protocol/adapter.ts';
import type { Facts } from './facts.ts';
import { untoldDiagnostics } from './journal.ts';
import type { JournalNotes } from './journal-notes.ts';
import { inCommunity } from './routing.ts';
import { askedFor } from './triggers.ts';
import type { TriggerKind } from './triggers.ts';

type WakeArgs = Parameters<typeof wakeInputs>[0];

/** The conversation a turn ran in, as its end reads it. */
type EndChannel = { id: string; communityId?: string | null };

/** The trigger of a turn, as its end reads it; the attempt reads the rest. */
type EndTrigger = {
  id?: string | null;
  authorId?: string | null;
  channelId?: string | null;
  ts?: number | null;
  content?: string;
  [key: string]: unknown;
} | null;

/** What a turn was asked to do, as its end reads it; the attempt reads the rest. */
export type TurnParams = {
  conversation?: ConversationRef;
  guildId?: string | null;
  mode?: string | null;
  trigger?: EndTrigger;
  triggerKind?: TriggerKind | null;
  source?: unknown;
  added?: ReadonlyArray<unknown> | null;
  chooseMode?: ((history: Array<object>, now: number, context: { pulled: Array<object> }) => string | null) | null;
  [key: string]: unknown;
};

/** How an attempt or a turn ended (TurnOutcome in src/behavior/turn.js), and the parts of a message that split. */
export type TurnResult = {
  outcome: string;
  reason?: unknown;
  mode?: unknown;
  dryRun?: boolean;
  delivered?: boolean;
  turnId?: unknown;
  parts?: Array<string>;
  history?: unknown;
  [key: string]: unknown;
};

/** What every attempt of a turn posted in reply to and why it ended, for the end hook. */
type Ends = {
  replyTargets: Array<string>;
  reasons: Array<string>;
  factsShown: Array<string> | null;
  info: EndChannel | null;
};

/** How a turn ended, as the end hook hears it (src/behavior/missed.js). */
export type TurnEnd = {
  guildId: string | null;
  channelId: string | null;
  privateChat: boolean;
  routed: boolean;
  mode: string | null;
  trigger: {
    id: string | null;
    authorId: string | null;
    channelId: string | null;
    ts: number | null;
    content: string;
  } | null;
  triggerKind: TriggerKind | null;
  outcome: string;
  reason: string | null;
  replyTargets: Array<string>;
  dryRun: boolean;
  turnId: unknown;
};

/** What an attempt's draft holds that the facts of its end read. */
type FactsDraft = Parameters<typeof untoldDiagnostics>[0] & {
  info?: EndChannel | null;
  sendFailure?: Record<string, unknown>;
  loopCut?: { reason: string; dropped: number };
  steps?: number;
  unseenFailed?: Array<FactInput>;
};

/** A message folded into a part of a chain. */
type PartMessage = { id: string; text: string; ts: number };

/** The chain of parts running in a channel: its author, its parts, the part in progress and the folded messages. */
type Chain = { authorId: string | null; parts: Array<string>; next: number; added: Map<number, Array<PartMessage>> };

/** What createOutcome reads: the dependencies, the attempt and the functions of the other topic modules it calls. */
export type OutcomeContext = {
  hot: { readonly config: WakeArgs['config'] };
  store: { state: { data: { paused?: unknown } } };
  iface: unknown;
  ifaceReads: Reads;
  selfIdOf: () => string;
  getSelfName: (guildId: string) => string;
  clock: () => number;
  busy: { size: number; delete: (channelId: string) => unknown };
  facts: Facts['facts'];
  factsOfKind: JournalNotes['factsOfKind'];
  keepFact: JournalNotes['keepFact'];
  writeTurnRecords: (attempts: Array<unknown>) => Promise<void>;
  runTurnOnce: (args: TurnParams) => Promise<TurnResult>;
};

export type Outcome = {
  runTurn: (params: TurnParams) => Promise<TurnResult>;
  recordTurnFacts: (args: { guildId?: string | null }, draft: FactsDraft, result: TurnResult | undefined) => void;
  notifyIdle: () => void;
  /**
   * The parts of the chain running in `channelId` not started yet, when its message is
   * `authorId`'s: `{ index, text }` in order (1-based indices). Empty otherwise. Read only.
   */
  waitingParts: (channelId: unknown, authorId: unknown) => Array<{ index: number; text: string }>;
  /**
   * Fold `message` (`{ id, text, ts }`) into part `index` of `authorId`'s chain in `channelId`,
   * so that part's request names it (`labels.task.added`). False -- nothing changed -- when no
   * such chain runs or the part has started.
   */
  addToPart: (channelId: unknown, authorId: unknown, index: unknown, message: PartMessage) => boolean;
  /**
   * Resolves once no turn is in flight anywhere -- immediately if that is
   * already true. Used by admin.js's `/nep pause` to wait out a turn
   * that was already running when the pause was requested, instead of
   * aborting it.
   */
  waitIdle: () => Promise<void>;
  /** Called (never awaited by runTurn) every time a turn finishes anywhere, once the channel is freed. */
  setOnIdle: (fn: (() => unknown) | null) => void;
  /**
   * Called (never awaited, never thrown into the turn) once every runTurn has ended, with how
   * it ended (noteTurnEnd): src/behavior/missed.js resolves and records from it.
   */
  setOnTurnEnd: (fn: ((end: TurnEnd) => unknown) | null) => void;
};

// health: allow function-length until 2027-04-01 -- the outcome shares the runner state of src/behavior/turn.js, moved whole in stage 5b
export function createOutcome(ctx: OutcomeContext): Outcome {
  const {
    hot,
    store,
    iface,
    ifaceReads,
    selfIdOf,
    getSelfName,
    clock,
    busy,
    facts,
    factsOfKind,
    keepFact,
    writeTurnRecords,
    runTurnOnce,
  } = ctx;

  // channelId -> the chain of parts running there (runChain): its author, its parts, the part
  // in progress (`next`, 1-based; 0 before the first) and the messages folded into a later part.
  const chains = new Map<string, Chain>();
  let onIdle: (() => unknown) | null = null; // set via setOnIdle(); see the finally block of runTurn below
  let onTurnEnd: ((end: TurnEnd) => unknown) | null = null; // set via setOnTurnEnd(); see noteTurnEnd
  let idleWaiters: Array<() => void> = []; // resolvers for waitIdle() (/nep pause), notified once busy.size hits 0

  /**
   * @param {object} params
   * @param {import('../protocol/adapter.ts').ConversationRef} [params.conversation]  absent for the selfreflection wake
   * @param {{ turnId: string, attemptId?: number }|null} [params.journalTurn]  The journal's turn and attempt (runTurn passes them on).
   * @param {string} [params.guildId]  The guild of a private chat; a server channel uses its own; with neither it throws.
   * @param {'reply'|'interject'|'initiate'|'auto'|'diary'|'inner'} params.mode  'auto' lets `chooseMode` pick
   *   between interject/initiate/nothing once the history is known (spontaneous turns); 'inner'
   *   is an inner turn (with `params.inner`).
   * @param {{ wake: import('./inner/types.ts').TurnWake, shadow: boolean, mayAct?: () => boolean, currentChannel?: string|null }|null} [params.inner]  An inner turn (src/behavior/inner.ts,
   *   docs/inner-life.md), with `mode: 'inner'` and no trigger: nobody's message is fabricated; its
   *   request carries `<wake>` (src/behavior/wake.ts over `wake`) and the task `prompts.inner`, its
   *   history is the last `innerLife.chatMessages` lines of `channel`, its prefetch searches the
   *   purposes of the intentions it woke for, no planner runs. What she writes in tags (a `<msg>`,
   *   a `<gif>`, a `<react to>`) is lowered into the calls they stand for, in the current channel
   *   (`currentChannel`: an id, or null for none, then a post is refused `destination-required`;
   *   absent: the turn's own channel; src/behavior/inner-output.js) and made with her own, after them; her calls pass
   *   the gateway as her own initiative (her grants alone) and then innerVerdict: a read runs; with
   *   `shadow` anything else is only proposed (journalled with `shadow: true`, never run, no call
   *   mark, nothing marked seen); live, `mayAct()` is asked right before each one (the kill switch)
   *   (no count of posts refuses one). An answer with no action ends
   *   `skip` with `reason: 'nothing-to-do'`; after a post that left nothing to show while an intention she woke for is
   *   still untouched, the steps make one open follow-up request (runSteps: the open line in its note,
   *   once per turn). The last step still runs one terminal action call of hers (a post, an
   *   intention change). The steps of an inner turn run under `innerLife.loop`
   *   (loopSettings with `inner`), not `tools.loop`. The result carries `inner: { actions, intentIds, loop,
   *   openFollowUp?, turnId }` (`openFollowUp: true` when that
   *   step was made; `shadow: true` in shadow mode). A
   *   call that did not work in shadow mode is marked for the rest of the turn only (`turnMarks`).
   * @param {object} [params.trigger]      Normalized message the turn answers (a call, or an
   *   overheard line).
   * @param {TriggerKind} [params.triggerKind]
   * @param {(history: object[], now: number, context: { pulled: object[] }) => string|null} [params.chooseMode]
   *   Called with this channel's history and the channels already pulled for the turn (the
   *   PulledChannel records of the pull, the source first).
   * @param {{ channelId: string, reason: 'routed'|'noticed' }|null} [params.source]  The channel
   *   this turn is about when it is not `channel` (a call from a channel the bot cannot write in,
   *   a noticed comment): pulled before anything else and shown in `<channel_view>`. When it
   *   cannot be pulled a routed turn ends in `error` (`turn: source unavailable`), a noticed one
   *   in `not-now`. `channel` is where the words go and the one marked busy; the first post
   *   links to the routed call, or to the newest line of the source shown (none when the budget
   *   dropped its block).
   * @param {object|null} [params.focus]  A normalized message of this chat put to everyone present
   *   (a room question): buildRequest appends `labels.room.focus` to the task.
   * @param {boolean} [params.forced]  True for a turn someone asked for (`/nep message create`; was `/nep interject`, `/nep
   *   initiate`) -- passed straight through to buildRequest, which appends prompts.forced (when
   *   present) to the task text so the model knows `<skip/>` is not the expected outcome this time.
   * @param {(() => { id: string, text: string, author?: string }[])|null} [params.queued]  The calls
   *   still waiting in the queue in this channel (src/behavior/pipeline.js), read when the request is
   *   built: the trigger author's own (no `author`) named under `labels.task.queued` (on a part, in
   *   `labels.task.part`'s `{others}`), another member's (`author`: their display name) under
   *   `labels.task.queuedOthers`, so the persona leaves them to their own turns; a call so named is
   *   not counted as answered by this turn (spokeAfterSeeing). Without its label a call is not
   *   named and the old rule holds for it.
   * @param {{ id: string, text: string, ts: number }[]|null} [params.added]  Later messages of the
   *   author folded into this call (src/behavior/pipeline.js): `labels.task.added` names them.
   * @param {{ author: string, text: string }[]|null} [params.missed]  A recovery turn's messages
   *   (trigger kind `missed`, src/behavior/missed.js), the trigger first: `labels.task.missed`
   *   names them.
   * @param {{ id: string, roleIds?: string[] }|null} [params.requester]  The person who asked for
   *   this turn when it is not the trigger's author (`/nep message create`, src/tools/impl/message.ts):
   *   the requester of any skill call she makes in it (callEnvelope).
   * @param {(() => boolean)|null} [params.stillDue]  Asked right before anything is posted (dry
   *   run included); false ends the turn `not-now` (`reason: 'answered-meanwhile'`), nothing posted.
   * @param {{ kind?: string|null, topic?: string|null, forced?: boolean }|null} [params.diary]  With `mode: 'diary'`
   *   (src/behavior/diary.ts, no trigger; with no `conversation` the selfreflection wake, selfreflectionOf, whose
   *   conversation and history memory gives): the post is planned first
   *   (prepareDiary: the plan request, then the search it asks for; `kind` forces the kind --
   *   a picture kind while the post may not carry a picture is refused before any request,
   *   `{ outcome: 'refused', reason: 'pictures', limit }`, diaryPictureGate --
   *   `topic` is the owner's topic for the planner and the plan, `forced` also appends
   *   prompts.forced to the task), then composed with `prompts.diary` as
   *   the task and the `<world>`, `<diary>`, `<plan>` and `<found>` blocks. Its speech keeps only
   *   `<msg>` (every reply attribute dropped, links removed, at most `diary.maxMessages` (3), a
   *   message left empty not posted) and `<skip/>`; no reaction, no GIF, no GIF pick. It runs on the
   *   step engine with `diary.loop`: only her `draw.create` calls run (any other is refused
   *   `diary-draw-only`; at most `diary.set.pictures[1]` in a step), each picture staged as it is
   *   generated and counted against the day's diary pictures then; a picture while the post may
   *   carry none is refused `daily-cap` (diaryPictureGate). A failed picture holds the post's speech
   *   with the staged pictures until her next step. Nothing is sent: her speech is held (holdSpeech), a `voice.say`
   *   keeps its file (diary-turn.ts#diaryVoiceTool), and the entry is recorded (diary-turn.ts#recordEntry; a set kind
   *   with fewer than `diary.set.minPosted` pictures staged is not: `turn: set short`, `{ outcome: 'refused', reason:
   *   'set-short' }`). Its outcome carries `diary: { kind, picture, search, messages, pictures }` and the entry
   *   (`diary.entry`) the mirrors publish (src/behavior/mirror.ts); a dry run records nothing.
   *
   * A private chat (`channel` without a guild) works like a server turn on behalf of its partner
   * (the trigger's author, fetched as a member of the served guild: privatePartner) with
   * features.privateLikeServer on (a missing key counts as on): the explicit `<#id>` mentions and
   * the route hook's ids are pulled from the served guild when the partner has View Channel on
   * them (checkPull), and the search classifier may ask for the server search (recall), its hits
   * judged by the same rule. It never has neighbours, a source or a focus, and the channels it
   * shows move no seen mark, stamp no call of the ring and count for no pending ping there: the
   * persona answered in private, not on the server. The switch off, or no partner: no pull, no
   * route hook, no server search, as before.
   * @returns {Promise<{ outcome: TurnOutcome, mode?: string, dryRun?: boolean,
   *   delivered?: boolean, reason?: string, limit?: { key: string, used: number, cap: number }|null }>}
   *   `delivered` on a
   *   `spoke` turn posted for real: whether anything reached the chat (a reaction put, a message,
   *   the GIF or a diary post's pictures posted; a send that fails stops the
   *   posting and the turn still ends `spoke` with what reached the chat); `limit` on `outcome:
   *   'refused'` (a request or token cap; a diary picture gate with `reason: 'pictures'`; a diary
   *   set short of `diary.set.minPosted` pictures has `reason: 'set-short'` and no `limit`), for
   *   the caller's limit notice. An answer of hers cut off at its output cap before any complete
   *   action (cutOffOf; the skill follow-up's too, when nothing of the turn reached the chat)
   *   ends `error` with `reason: 'cut-off'`, nothing of it posted. With the journal on (createTurnRunner's `journal`), a turn that
   *   started there carries its `turnId` and `attemptId` (not a message answered part by part,
   *   whose parts are journalled each as its own turn). A `skip`, or a `spoke`
   *   turn posted for real, stamps the calls of the ring it showed (stampShownCalls) -- every
   *   one but a routed turn's own call, which the caller stamps by this outcome.
   */
  async function runTurn(params: TurnParams): Promise<TurnResult> {
    // Every attempt that started in the journal (runTurnOnce), closed here, at the one exit.
    const attempts: Array<unknown> = [];
    // What every attempt posted in reply to and why it ended (runTurnOnce), for the end hook.
    const ends: Ends = { replyTargets: [], reasons: [], factsShown: null, info: null };
    const wake = params?.mode === 'diary' && !params.conversation ? await selfreflectionOf(params) : {};
    const tracked = { ...params, ...wake, journalAttempts: attempts, turnEnds: ends };
    let result: TurnResult | undefined;
    let thrown: unknown = null;
    try {
      const first = await runTurnOnce({ ...tracked, maySplit: true });
      result = first.outcome === 'split' ? await runChain(tracked, first) : first;
      return result;
    } catch (err) {
      thrown = err;
      throw err;
    } finally {
      noteFailedTurn(params, result, ends, thrown);
      if (attempts.length > 0) await writeTurnRecords(attempts);
      noteTurnEnd(params, result, ends);
    }
  }

  /**
   * The `selfreflection` wake (a diary turn with no conversation): the conversation, channel and history memory holds of
   * her diary's place (diary-turn.ts#wakeInputs). Only it is awaited before a turn takes its attention.
   */
  async function selfreflectionOf({
    guildId,
  }: TurnParams): Promise<{ conversation: ConversationRef; standIn: unknown; reuseHistory: unknown }> {
    // A diary turn names the guild it posts for.
    const served = guildId as string;
    const { conversation, channel, history } = await wakeInputs({
      store,
      conversationInfo: (ref) => ifaceReads.conversationInfo(ref, { audience: true, viewers: [] }),
      iface: portIface(iface),
      guildId: served,
      selfId: selfIdOf(),
      selfName: getSelfName(served),
      config: hot.config,
    });
    return { conversation, standIn: channel, reuseHistory: history };
  }

  /**
   * An addressed reply turn: the facts its request showed, and the failure entry of the very message
   * it answered, are told once a completed answer carried them (any outcome but `error`, `busy`,
   * `paused`); one that ended `error` or `refused` is kept for her next request in the channel
   * (`failedTurn`). Never throws.
   */
  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/turn.js in stage 5b, a pure move
  function noteFailedTurn(params: TurnParams, result: TurnResult | undefined, ends: Ends, thrown: unknown): void {
    try {
      const { trigger = null, triggerKind = null, mode = null } = params ?? {};
      const channel = ends.info;
      if (!channel || mode !== 'reply' || !askedFor(trigger, triggerKind) || !trigger?.id) return;
      const guildId = params.guildId ?? channel.communityId ?? null;
      const scope = { channelId: String(channel.id), privateChat: !inCommunity(channel) };
      const at = clock();
      const outcome = result?.outcome ?? 'error';
      if (outcome !== 'error' && outcome !== 'busy' && outcome !== 'paused') {
        const own = factsOfKind(guildId, scope, 'failedTurn', at)
          .filter((fact) => fact.messageId === String(trigger.id))
          .map((fact) => fact.id);
        const told = [...(ends.factsShown ?? []), ...own];
        if (told.length > 0) facts().markTold(guildId, told);
      }
      if (outcome !== 'error' && outcome !== 'refused') return;
      const code =
        typeof result?.reason === 'string' && result.reason
          ? result.reason
          : thrown
            ? errorCodeOf(thrown)
            : ends.reasons.includes('too-slow')
              ? 'too-slow'
              : ((outcome === 'refused' ? ends.reasons.at(-1) : null) ?? outcome);
      keepFact(
        guildId,
        scope,
        'failedTurn',
        { messageId: String(trigger.id), authorId: trigger.authorId ?? null, code },
        at
      );
    } catch (err) {
      log.warn('turn: failed turn not kept', { error: err });
    }
  }

  /**
   * What an addressed turn lost, as facts for her next request in the conversation: a message that did
   * not go out (`sendFailed`), calls the loop dropped (`loopCut`) and failed calls she never read the
   * result of (`callFailed`). Never throws.
   */
  function recordTurnFacts(args: { guildId?: string | null }, draft: FactsDraft, result: TurnResult | undefined): void {
    try {
      const channel = draft.info;
      if (!channel || result?.dryRun === true) return;
      const entries: Array<FactInput> = [];
      if (draft.sendFailure) entries.push({ kind: 'sendFailed', ...draft.sendFailure });
      if ((draft.loopCut?.dropped ?? 0) > 0 && draft.loopCut)
        entries.push({
          kind: 'loopCut',
          cut: draft.loopCut.reason,
          droppedCalls: draft.loopCut.dropped,
          steps: draft.steps ?? 0,
        });
      entries.push(...(draft.unseenFailed ?? []));
      // What the parser left unsaid about her answers and no later request carried.
      for (const { kind, ...rest } of untoldDiagnostics(draft))
        entries.push({ kind: 'diagnostic', diagnostic: kind, ...rest });
      if (entries.length === 0) return;
      const guildId = args.guildId ?? channel.communityId ?? null;
      const at = clock();
      for (const entry of entries)
        facts().add(guildId, { ...entry, channelId: String(channel.id), privateChat: !inCommunity(channel), at });
    } catch (err) {
      log.warn('turn: facts not kept', { error: err });
    }
  }

  /**
   * Tell the end hook (setOnTurnEnd; src/behavior/missed.js) how a turn ended, never awaited
   * and never thrown into the turn: its channel and guild, whether it was a private chat or
   * about another channel (`routed`), its trigger (`{ id, authorId, channelId, ts, content }`,
   * in process only) and kind, its outcome (`error` when it threw), its reason (the result's,
   * or `too-slow` for one dropped at its bar), the messages its posts replied to, whether it
   * was a rehearsal and its journal id.
   */
  function noteTurnEnd(params: TurnParams, result: TurnResult | undefined, ends: Ends): void {
    if (typeof onTurnEnd !== 'function') return;
    const { trigger = null, triggerKind = null, mode = null, source = null } = params ?? {};
    const channel = ends.info;
    const channelId = channel?.id ?? params?.conversation?.conversationId ?? null;
    const outcome = result?.outcome ?? 'error';
    const reason =
      typeof result?.reason === 'string'
        ? result.reason
        : outcome === 'error' && ends.reasons.includes('too-slow')
          ? 'too-slow'
          : null;
    const end: TurnEnd = {
      guildId: channel?.communityId ?? params?.guildId ?? null,
      channelId,
      privateChat: channel ? !inCommunity(channel) : false,
      routed: Boolean(source),
      mode,
      trigger: trigger
        ? {
            id: trigger.id ?? null,
            authorId: trigger.authorId ?? null,
            channelId: trigger.channelId ?? channelId,
            ts: trigger.ts ?? null,
            content: trigger.content ?? '',
          }
        : null,
      triggerKind,
      outcome,
      reason,
      replyTargets: [...new Set(ends.replyTargets)],
      dryRun: result?.dryRun === true,
      turnId: result?.turnId ?? null,
    };
    Promise.resolve()
      // Read when the hook runs, as it is set then (setOnTurnEnd).
      .then(() => (onTurnEnd as (end: TurnEnd) => unknown)(end))
      .catch((err: unknown) => log.warn('turn: onTurnEnd failed', { error: err }));
  }

  /** Why a chain ends before its next part: `paused` (/nep pause), or null. */
  function chainStop(): string | null {
    return store.state.data.paused ? 'paused' : null;
  }

  /**
   * A message that holds several requests (the splitter's `parts`), answered
   * part by part: one ordinary turn per part, in order, each with its own
   * deadline and bar. Turn k's `analyzer` requests (the search classifier, recall, the
   * route hook, the re-watch) judge part k's text instead of the whole
   * message, and its request names the part and the others
   * (buildRequest's `tasks.part`, `labels.task.part`). The first part reuses
   * the history the whole message's turn fetched and replies as any turn
   * does; the later ones fetch it afresh (the earlier answers are in it) and
   * post plain. The persona may answer a part in any way a turn allows,
   * silence included; a part that fails, is dropped at its bar or refused
   * does not stop the next. The attention stays the chain's from the
   * whole message's turn to the end -- nothing else starts in between
   * (pending calls keep queueing) -- and the idle notifications fire once, at
   * the end. A pause ends the chain before its next part (`turn:
   * chain stopped`). While it runs, the parts not started yet are the
   * author's waiting items (waitingParts); a later message of the author
   * folded into one of them (addToPart) reaches that part's request as
   * `tasks.added`. Every part logs `turn: part` with its outcome. Resolves one
   * result for the message (chainOutcome).
   */
  async function runChain(params: TurnParams, { parts, history }: TurnResult): Promise<TurnResult> {
    const { trigger } = params;
    // A message that split holds its parts, and its turn its conversation.
    const allParts = parts as Array<string>;
    const channel = { id: (params.conversation as ConversationRef).conversationId };
    const total = allParts.length;
    const chain: Chain = { authorId: trigger?.authorId ?? null, parts: allParts, next: 0, added: new Map() };
    chains.set(channel.id, chain);
    const results: Array<TurnResult> = [];
    try {
      for (let i = 0; i < total; i += 1) {
        const index = i + 1;
        const stop = i > 0 ? chainStop() : null;
        if (stop) {
          log.info('turn: chain stopped', { channel: channel.id, reason: stop, index, total });
          break;
        }
        // From here on this part is no longer waiting: nothing more is folded into it.
        chain.next = index;
        const plainPosts = i > 0;
        let result: TurnResult;
        try {
          const once = await runTurnOnce({
            ...params,
            owned: true,
            part: { index, total, parts: allParts },
            reuseHistory: i === 0 ? history : null,
            // Messages folded into the whole call before it split go with its first part.
            added: [...(i === 0 && isList(params.added) ? params.added : []), ...(chain.added.get(index) ?? [])],
            plainPosts,
          });
          result = once;
        } catch (err) {
          const code = errorCodeOf(err);
          log.error('turn: failed', { channel: channel.id, code, error: err });
          result = { outcome: 'error', reason: code };
        }
        log.info('turn: part', { channel: channel.id, index, total, outcome: result.outcome });
        results.push(result);
      }
    } finally {
      chains.delete(channel.id);
      busy.delete(channel.id);
      notifyIdle();
    }
    return chainOutcome(results);
  }

  /**
   * One result for a message answered part by part, as its caller counts a
   * turn: `spoke` when any part spoke (`delivered` when anything of any part
   * reached the chat; `dryRun` when every part that spoke was a rehearsal),
   * else the first part's `skip`, else the first part's result (a refusal
   * keeps its `limit`).
   */
  function chainOutcome(results: Array<TurnResult>): TurnResult {
    const spoke = results.filter((result) => result.outcome === 'spoke');
    if (spoke.length > 0) {
      const real = spoke.filter((result) => result.dryRun !== true);
      return {
        outcome: 'spoke',
        mode: spoke[0].mode,
        ...(real.length === 0 ? { dryRun: true } : { delivered: real.some((result) => result.delivered === true) }),
      };
    }
    return results.find((result) => result.outcome === 'skip') ?? results[0] ?? { outcome: 'error' };
  }

  /**
   * Tell whoever waits that a turn has finished: onIdle (fire-and-forget, same
   * as the caller of runTurn itself: whatever wants to run next --
   * src/behavior/pipeline.js's pending-ping drain, wired in src/index.js -- must
   * never hold up, or throw into, the turn that just freed the channel), and
   * the waitIdle() waiters once no turn is in flight anywhere.
   */
  function notifyIdle(): void {
    if (onIdle) {
      Promise.resolve()
        // Read when the hook runs, as it is set then (setOnIdle).
        .then(() => (onIdle as () => unknown)())
        .catch((err: unknown) => log.warn('turn: onIdle failed', { error: err }));
    }
    if (busy.size === 0 && idleWaiters.length > 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  return {
    runTurn,
    recordTurnFacts,
    notifyIdle,
    waitingParts: (channelId, authorId) => {
      // A Map answers undefined for a key of another type.
      const chain = chains.get(channelId as string);
      if (!chain || chain.authorId !== authorId) return [];
      return chain.parts.map((text, i) => ({ index: i + 1, text })).filter(({ index }) => index > chain.next);
    },
    addToPart: (channelId, authorId, given, message) => {
      // A Map answers undefined for a key of another type, and a part's index compares as a number.
      const chain = chains.get(channelId as string);
      const index = given as number;
      if (!chain || chain.authorId !== authorId || !(index > chain.next) || index > chain.parts.length) return false;
      chain.added.set(index, [...(chain.added.get(index) ?? []), message]);
      return true;
    },
    waitIdle: () => (busy.size === 0 ? Promise.resolve() : new Promise((resolve) => idleWaiters.push(resolve))),
    setOnIdle: (fn) => {
      onIdle = fn;
    },
    setOnTurnEnd: (fn) => {
      onTurnEnd = fn;
    },
  };
}

/** Whether a value is a list. */
function isList(value: unknown): value is ReadonlyArray<unknown> {
  return Array.isArray(value);
}
