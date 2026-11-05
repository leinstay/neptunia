// What a turn notes about itself as it runs: the facts kept for her next request, the outside text an attempt has seen
// and where her lines came from, the trigger and call marks on her own lines (seeded from the journal at start), her previous think per place, and the
// journal's and the record's lines (the request dumps, the turn records, the `said` lines, the operations).
// createTurnRunner (src/behavior/turn.js) builds it once per runner with createJournalNotes over the runner's state;
// the attempt, the calls, the act and the pulls call its functions.

import { messageLinkOf } from '../behavior/elsewhere.ts';
import type { FactInput, FactsApi, Fact } from '../behavior/inner.ts';
import { placeKey } from '../behavior/previous-think.ts';
import { withCalls, withTriggers } from '../format.ts';
import { log } from '../log.ts';
import { toRecordLine } from '../memory/record.ts';
import { outcomeDetail } from '../tools/executors.ts';
import { CALL_MARKS_MAX, POSTED_FROM_MAX, TRIGGER_LINKS_MAX } from './calls.ts';
import { FAILED_TURN_KEEP_MS, NO_OP, journalTurnRecord } from './journal.ts';
import type { JournalDraft, JournalOp } from './journal.ts';
import { inCommunity } from './routing.ts';
import type { Snapshot } from '../behavior/snapshot.ts';

/** The config keys the notes read, at the moment of use. */
export type NotesConfig = Record<string, unknown>;

// Production values, config cut of 2026-10-31.
/** The failed turns told per conversation, the newest. */
const FAILED_TURNS_KEPT = 3;
/** How old her previous think may be, in minutes, to be carried into a new turn. */
const PREVIOUS_THINK_MINUTES = 30;

/** The journal (src/memory/journal.ts#createJournal) as far as the notes use it. */
export type NotesJournal = {
  turn: (placeId: string, record: Record<string, unknown>) => unknown;
  op?: (placeId: string | undefined, fields: Record<string, unknown>) => JournalOp;
};

/** The persona's record (src/memory/record.ts#createRecord) as far as `said` lines use it. */
export type NotesRecord = {
  append: (placeId: string, lines: Array<object>) => unknown;
};

/** What her previous think store (src/behavior/previous-think.js#createThinkStore) answers. */
type ThinkPick =
  | { think: null; why: string; turnId?: string | null; source?: undefined }
  | {
      think: string;
      source: { turnId: string | null; relation: string; ageMs: number };
      why?: undefined;
      turnId?: undefined;
    };

/** Her previous think per place (src/behavior/previous-think.js#createThinkStore). */
export type ThinkStore = {
  record: (entry: {
    turnId: string | null;
    at: number;
    think: unknown;
    failed: boolean;
    isPrivate: boolean;
    inner: boolean;
    ran: string;
    delivered: Array<string>;
  }) => void;
  select: (place: string, at: { now: number; minutes: number; isPrivate: boolean }) => ThinkPick;
};

/** A skill call of hers as a call mark (in src/format.js#withCalls's shape). */
export type CallMark = object;

/** The ids an attempt is known by: the journal's, or the turn key of one that is not journalled. */
type TurnIds = {
  started?: { turnId: string; attemptId: string } | null;
  turnKey?: { turnId?: string | null } | null;
};

/** What an attempt's draft holds that the notes read and write. */
export type NotesDraft = TurnIds & {
  placeId?: string;
  conversationId?: string;
  privateAccountId?: string | null;
  inner?: { wake?: { chainId?: string | null } | null } | null;
  info?: { id: string; rootId?: string | null } | null;
  deliveredIn?: Iterable<string> | null;
  finalThink?: unknown;
  actions?: Array<unknown>;
};

/** A channel the notes name: its id and the community it is in, when one. */
type NotesChannel = { id: string; rootId?: string | null };

/** One of her posted messages as a `said` line takes it. */
type SaidArgs = {
  placeId: string;
  channel: NotesChannel & { partnerId?: string | null };
  privateChat: boolean;
  trigger?: { authorId?: string | null } | null;
  draft?: (NotesDraft & { started?: { turnId: string } | null }) | null;
  op?: { opId?: string | null } | null;
  posted?: { id?: unknown; createdTimestamp?: unknown } | null;
  text: unknown;
  replyId?: string | null;
  repliedAuthorId?: string | null;
  accountIds: unknown;
  /** What she voiced, when the post is a voice message. */
  voiced?: string;
};

/** What createJournalNotes reads: the dependencies and the runner's state the notes keep. */
export type JournalNotesContext = {
  hot: { readonly config: NotesConfig };
  clock: () => number;
  journal: NotesJournal | null;
  record: NotesRecord | null;
  iface: unknown;
  /** The facts store of the moment: the inner life's when it is on, else the runner's own. */
  facts: () => FactsApi;
  triggerLinks: Map<string, string>;
  callMarks: Array<CallMark>;
  postedFromLinks: Map<string, string>;
  thinks: ThinkStore;
  readOffPeriods: (placeId: string, options?: { windowHours?: number }) => Promise<unknown>;
  liveChannelName: (
    channel: NotesChannel | null | undefined,
    snapshot?: Snapshot | null
  ) => (placeId: string) => string | null;
};

type FactScopeOf = { placeId: string | null; privateChat?: boolean };

export type JournalNotes = {
  factsOfKind: (placeId: string | null, scope: FactScopeOf, kind: string, at: number) => Array<Fact>;
  keepFact: (
    placeId: string | null,
    scope: FactScopeOf,
    kind: string,
    payload: Record<string, unknown>,
    at: number
  ) => void;
  noteTrigger: (postedId: unknown, triggerId: unknown) => void;
  linkTriggers: (lines: Array<object>) => Array<object>;
  earlierThinkFor: (args: {
    channel: NotesChannel;
    placeId: string | null;
    isPrivate: boolean;
    draft: NotesDraft;
    mode: string | null | undefined;
  }) => { text: string; relation: 'earlier'; ageMs: number } | null;
  recordTurnThink: (
    args: { placeId?: string | null; inner?: unknown },
    draft: NotesDraft,
    result: { outcome?: string } | null | undefined
  ) => void;
  noteCall: (mark: CallMark) => void;
  notePostedFrom: (postedId: unknown, originId: unknown) => void;
  seedTriggerLinks: (pairs: unknown) => void;
  seedCallMarks: (marks: { calls?: unknown; postedFrom?: unknown } | null | undefined) => void;
  linkCalls: (
    lines: Array<object>,
    options: { channel: NotesChannel; snapshot?: Snapshot | null; placeId: string | null; extra?: unknown }
  ) => Array<object>;
  journalOn: () => boolean;
  offPeriodsFor: (placeId: string) => Promise<unknown>;
  writeTurnRecords: (
    attempts: Iterable<{ draft: JournalDraft & { placeId: string }; result: Parameters<typeof journalTurnRecord>[1] }>
  ) => Promise<void>;
  recordSaid: (args: SaidArgs) => void;
  journalOp: (
    draft: (NotesDraft & { started?: { turnId: string } | null }) | null | undefined,
    name: string,
    by: string,
    fields?: Record<string, unknown>
  ) => JournalOp | Readonly<JournalOp>;
};

/** The `code` of a thrown value, when it has one. */
function codeOf(error: unknown): unknown {
  // A thrown value is anything; its code is read when it has one, as a Node error does.
  return (error as { code?: unknown } | null)?.code ?? null;
}

// health: allow function-length until 2027-04-01 -- the notes share the runner state of src/behavior/turn.js, moved whole in stage 5b
export function createJournalNotes(ctx: JournalNotesContext): JournalNotes {
  const {
    clock,
    journal,
    record,
    iface,
    facts,
    triggerLinks,
    callMarks,
    postedFromLinks,
    thinks,
    readOffPeriods,
    liveChannelName,
  } = ctx;

  /** The facts of `kind` of the conversation `scope` still in their window, oldest first. */
  function factsOfKind(placeId: string | null, scope: FactScopeOf, kind: string, at: number): Array<Fact> {
    return facts()
      .pending(scope)
      .filter((fact) => fact.kind === kind && fact.placeId === scope.placeId && at - fact.at < FAILED_TURN_KEEP_MS);
  }
  /** A fact of `kind` kept (at most `FAILED_TURNS_KEPT` of the kind per conversation, the newest; one per message). */
  function keepFact(
    placeId: string | null,
    scope: FactScopeOf,
    kind: string,
    payload: Record<string, unknown>,
    at: number
  ): void {
    const kept = FAILED_TURNS_KEPT;
    if (kept <= 0) return;
    const store = facts();
    if (payload.messageId)
      store.markTold(
        factsOfKind(placeId, scope, kind, at)
          .filter((fact) => fact.messageId === payload.messageId)
          .map((fact) => fact.id)
      );
    const fact: FactInput = { kind, ...scope, at, ...payload };
    store.add(fact);
    const live = factsOfKind(placeId, scope, kind, at);
    const over = live.slice(0, Math.max(0, live.length - kept)).map((fact) => fact.id);
    if (over.length > 0) store.markTold(over);
  }

  /** Remember that `postedId` was posted by the turn `triggerId` started (a newer link wins). */
  function noteTrigger(postedId: unknown, triggerId: unknown): void {
    if (
      typeof postedId !== 'string' ||
      !postedId ||
      typeof triggerId !== 'string' ||
      !triggerId ||
      postedId === triggerId
    )
      return;
    triggerLinks.delete(postedId);
    triggerLinks.set(postedId, triggerId);
    // Past its cap the map has a first key.
    while (triggerLinks.size > TRIGGER_LINKS_MAX) triggerLinks.delete(triggerLinks.keys().next().value!);
  }

  /**
   * `lines` with the persona's own lines carrying the message that started their turn
   * (src/format.js#withTriggers), so every transcript built from them names it;
   * `lines` as they are with features.triggerMarkers off (a missing key counts as on, read now).
   */
  function linkTriggers(lines: Array<object>): Array<object> {
    return withTriggers(lines, triggerLinks);
  }

  /** The key of the place a channel is (interface + conversation). */
  function placeOf(channel: NotesChannel): string {
    return placeKey({ conversationId: channel.id });
  }

  /**
   * The think a NEW turn's first request carries (an inner turn imports none), chosen once, logged
   * `turn: previous think` with the source (turn id, relation, age) or why there is none. Null when
   * nothing is carried.
   */
  function earlierThinkFor({
    channel,
    placeId,
    isPrivate,
    draft,
    mode,
  }: {
    channel: NotesChannel;
    placeId: string | null;
    isPrivate: boolean;
    draft: NotesDraft;
    mode: string | null | undefined;
  }): { text: string; relation: 'earlier'; ageMs: number } | null {
    if (draft.inner || mode === 'selfreflection') return null;
    const picked = thinks.select(placeOf(channel), {
      now: clock(),
      minutes: PREVIOUS_THINK_MINUTES,
      isPrivate,
    });
    if (!picked.think) {
      log.info('turn: previous think', {
        channel: channel.id,
        none: picked.why,
        ...(picked.turnId ? { source: picked.turnId } : {}),
      });
      return null;
    }
    log.info('turn: previous think', {
      channel: channel.id,
      source: picked.source.turnId,
      relation: picked.source.relation,
      ageSeconds: Math.round(picked.source.ageMs / 1000),
    });
    return { text: picked.think, relation: 'earlier', ageMs: picked.source.ageMs };
  }

  /** The turn ended: its final think goes to the places it ran in and delivered to (previous-think.js#record). Never throws. */
  function recordTurnThink(
    args: { placeId?: string | null; inner?: unknown },
    draft: NotesDraft,
    result: { outcome?: string } | null | undefined
  ): void {
    try {
      const channel = draft.info;
      const outcome = result?.outcome ?? 'error';
      if (!channel) return;
      const failed = outcome === 'error' || outcome === 'refused';
      if (!failed && outcome !== 'spoke' && outcome !== 'skip') return;
      const delivered = [...(draft.deliveredIn ?? [])].map((id) => placeKey({ conversationId: id }));
      thinks.record({
        turnId: draft.started?.turnId ?? draft.turnKey?.turnId ?? null,
        at: clock(),
        think: draft.finalThink ?? null,
        failed,
        isPrivate: !inCommunity(channel),
        inner: Boolean(args.inner),
        ran: placeOf(channel),
        delivered,
      });
    } catch (err) {
      log.warn('turn: previous think not kept', { error: err });
    }
  }

  /** Remember one skill call of hers (in src/format.js#withCalls's shape). */
  function noteCall(mark: CallMark): void {
    callMarks.push(mark);
    if (callMarks.length > CALL_MARKS_MAX) callMarks.splice(0, callMarks.length - CALL_MARKS_MAX);
  }

  /** Remember that `postedId` was posted by a turn of channel `originId` (a newer link wins). */
  function notePostedFrom(postedId: unknown, originId: unknown): void {
    if (typeof postedId !== 'string' || !postedId || typeof originId !== 'string' || !originId) return;
    postedFromLinks.delete(postedId);
    postedFromLinks.set(postedId, originId);
    // Past its cap the map has a first key.
    while (postedFromLinks.size > POSTED_FROM_MAX) postedFromLinks.delete(postedFromLinks.keys().next().value!);
  }

  /**
   * `lines` with the persona's skill calls on her own lines (src/format.js#withCalls): the
   * channel names read live from the place of `channel` (the turn's), the message links built in
   * `placeId` (`@me` for a message of the private chat itself). `lines` as they are with
   * features.callMarkers off (a missing key counts as on, read now).
   */
  function linkCalls(
    lines: Array<object>,
    {
      channel,
      snapshot = null,
      placeId,
      extra = null,
    }: { channel: NotesChannel; snapshot?: Snapshot | null; placeId: string | null; extra?: unknown }
  ): Array<object> {
    const turnMarks: Array<CallMark> = Array.isArray(extra) ? (extra as Array<CallMark>) : [];
    if (callMarks.length === 0 && turnMarks.length === 0 && postedFromLinks.size === 0) return lines;
    const privateId = inCommunity(channel) ? null : String(channel.id);
    return withCalls(
      lines,
      { calls: turnMarks.length > 0 ? [...callMarks, ...turnMarks] : callMarks, postedFrom: postedFromLinks },
      {
        nameOf: liveChannelName(channel, snapshot),
        linkOf: (channel, message) => messageLinkOf(iface, channel === privateId ? null : placeId, channel, message),
      }
    );
  }

  /** Whether the journal is written now: one injected and features.journal exactly true (read now). */
  function journalOn(): boolean {
    return Boolean(journal);
  }

  /**
   * The off periods `<now>` shows (src/memory/journal.ts#offPeriods): read only with the journal
   * on and features.offPeriods on (a missing key counts as on), over the last
   * `DEFAULT_OFF_WINDOW_HOURS` hours of src/memory/journal.ts, all read now; null otherwise. Never throws.
   */
  async function offPeriodsFor(placeId: string): Promise<unknown> {
    if (!journalOn()) return null;
    return readOffPeriods(placeId);
  }

  /** The turn records of runTurn's attempts, in order; a failed append is the journal's to log. */
  async function writeTurnRecords(
    attempts: Iterable<{ draft: JournalDraft & { placeId: string }; result: Parameters<typeof journalTurnRecord>[1] }>
  ): Promise<void> {
    for (const { draft, result } of attempts) {
      // writeTurnRecords runs only for a runner whose journal is on (runTurn checks journalOn first).
      await journal!.turn(draft.placeId, journalTurnRecord(draft, result));
    }
  }

  /**
   * The persona's posted message `posted` as a `said` line of the record: `text` as she wrote
   * it, the message it replies to and that message's author, the members it mentions, the
   * turn's id and the post operation's (null when the journal does not follow the attempt). A
   * private chat's line goes to its partner's private record, and nowhere without a known
   * partner. Off unless a record is injected and features.record is exactly true (read now).
   * Not awaited; a refused append is logged as `turn: record failed` (counts only).
   */
  function recordSaid({
    placeId,
    channel,
    privateChat,
    trigger,
    draft,
    op,
    posted,
    text,
    replyId,
    repliedAuthorId,
    accountIds,
    voiced,
  }: SaidArgs): void {
    if (!record) return;
    if (typeof posted?.id !== 'string' || !posted.id) return;
    const privateAccountId = privateChat
      ? (draft?.privateAccountId ?? trigger?.authorId ?? channel.partnerId ?? null)
      : null;
    if (privateChat && !privateAccountId) return;
    const line = toRecordLine(
      {
        id: posted.id,
        placeId: channel.id,
        content: text,
        ts: Number.isFinite(posted.createdTimestamp) ? posted.createdTimestamp : clock(),
        replyToId: replyId ?? null,
        replyToAuthorId: repliedAuthorId ?? null,
        mentionedAccountIds: accountIds,
        ...(voiced ? { attachments: [{ kind: 'voice' }], voiced } : {}),
      },
      { kind: 'said', now: clock, turnId: draft?.started?.turnId ?? null, opId: op?.opId ?? null }
    );
    const failed = (err: unknown): void =>
      log.warn('turn: record failed', { channel: channel.id, lines: 1, code: codeOf(err) });
    try {
      Promise.resolve(record.append(placeId, [line])).catch(failed);
    } catch (err) {
      failed(err);
    }
  }

  /**
   * One side effect of the attempt `draft` as a journal operation (src/memory/journal.ts#op):
   * `name`, `by` (`persona`: her output asked for it; `engine`: preparation the engine runs on
   * its own) and `fields` (`input`, `intent`, `participants`, `sourceMessageIds`, `dryRun`).
   * NO_OP when the attempt is not journalled. Its opId joins the turn record's `actions` once
   * its `started` line is written.
   */
  function journalOp(
    draft: (NotesDraft & { started?: { turnId: string } | null }) | null | undefined,
    name: string,
    by: string,
    fields: Record<string, unknown> = {}
  ): JournalOp | Readonly<JournalOp> {
    if (!draft?.started || typeof journal?.op !== 'function') return NO_OP;
    const handle = journal.op(draft.placeId, {
      turnId: draft.started.turnId,
      name,
      by,
      placeId: draft.conversationId,
      privateAccountId: draft.privateAccountId,
      ...fields,
    });
    const actions = (draft.actions ??= []);
    const note = (): void => {
      if (!actions.includes(handle.opId)) actions.push(handle.opId);
    };
    return {
      ...handle,
      proposed: (extra: unknown) => {
        note();
        return handle.proposed(extra);
      },
      started: (extra: unknown) => {
        note();
        return handle.started(extra);
      },
    };
  }

  /**
   * Remember which message started the turn that posted each message of `pairs`
   * (`[postedId, triggerId]`, oldest first: src/memory/journal.ts#triggerLinks at start), so
   * her lines posted before a restart name their trigger too. A malformed pair is skipped; a
   * link noted since is kept over a seeded one.
   */
  function seedTriggerLinks(pairs: unknown): void {
    for (const pair of isList(pairs) ? pairs : []) {
      // A Map answers false for a key of another type.
      if (!isList(pair) || triggerLinks.has(pair[0] as string)) continue;
      noteTrigger(pair[0], pair[1]);
    }
  }

  /**
   * Remember the persona's skill calls from before a restart (src/memory/journal.ts#callMarks at
   * start: `calls` oldest first, `postedFrom` pairs), so her lines keep showing them -- a call
   * that did not work with why (its `code` and `reason` through outcomeDetail). They go
   * before the calls noted since; a post noted since keeps its channel.
   */
  function seedCallMarks(marks: { calls?: unknown; postedFrom?: unknown } | null | undefined): void {
    // A call that did not work keeps why (its journaled code and reason, outcomeDetail).
    const seeded = (isList(marks?.calls) ? marks.calls : [])
      .filter((mark): mark is Record<string, unknown> => Boolean(mark) && typeof mark === 'object')
      // outcomeDetail reads each field of a journaled mark by its type.
      .map((mark) =>
        mark.detail ? mark : { ...mark, detail: outcomeDetail(mark as Parameters<typeof outcomeDetail>[0]) }
      );
    callMarks.unshift(...seeded.slice(-CALL_MARKS_MAX));
    if (callMarks.length > CALL_MARKS_MAX) callMarks.splice(0, callMarks.length - CALL_MARKS_MAX);
    for (const pair of isList(marks?.postedFrom) ? marks.postedFrom : []) {
      // A Map answers false for a key of another type.
      if (!isList(pair) || postedFromLinks.has(pair[0] as string)) continue;
      notePostedFrom(pair[0], pair[1]);
    }
  }

  return {
    factsOfKind,
    keepFact,
    noteTrigger,
    linkTriggers,
    earlierThinkFor,
    recordTurnThink,
    noteCall,
    notePostedFrom,
    seedTriggerLinks,
    seedCallMarks,
    linkCalls,
    journalOn,
    offPeriodsFor,
    writeTurnRecords,
    recordSaid,
    journalOp,
  };
}

/** Whether a value is a list. */
function isList(value: unknown): value is ReadonlyArray<unknown> {
  return Array.isArray(value);
}
