// What a turn notes about itself as it runs: the facts kept for her next request, the outside text an attempt has seen
// and where her lines came from, the trigger and call marks on her own lines, her previous think per place, and the
// journal's and the record's lines (the request dumps, the turn records, the `said` lines, the operations).
// createTurnRunner (src/behavior/turn.js) builds it once per runner with createJournalNotes over the runner's state;
// the attempt, the calls, the act and the pulls call its functions.

import { messageLinkOf } from '../behavior/elsewhere.ts';
import type { FactInput, FactsApi, Fact } from '../behavior/inner.ts';
import { placeKey } from '../behavior/previous-think.js';
import { withCalls, withTriggers } from '../format.js';
import { SOURCE_CHARS_MAX, lineSourcesOf, textsOf } from '../intentions/sources.ts';
import { log } from '../log.js';
import { toRecordLine } from '../memory/record.js';
import { CALL_MARKS_MAX, POSTED_FROM_MAX, TRIGGER_LINKS_MAX } from './calls.ts';
import { FAILED_TURN_KEEP_MS, NO_OP, journalTurnRecord, journalUsage } from './journal.ts';
import type { JournalDraft, JournalOp } from './journal.ts';
import { inCommunity } from './routing.ts';
import type { Snapshot } from '../behavior/snapshot.ts';

/** The config keys the notes read, at the moment of use. */
export type NotesConfig = {
  context?: { failedTurnsKept?: unknown; previousThink?: { minutes?: number } | null } | null;
  features?: {
    triggerMarkers?: unknown;
    previousThink?: unknown;
    callMarkers?: unknown;
    journal?: unknown;
    offPeriods?: unknown;
    record?: unknown;
  } | null;
  journal?: { offWindowHours?: number } | null;
};

/** The journal (src/memory/journal.js#createJournal) as far as the notes use it. */
export type NotesJournal = {
  dumpRequest?: (guildId: string, dump: Record<string, unknown>) => unknown;
  turn: (guildId: string, record: Record<string, unknown>) => unknown;
  op?: (guildId: string | undefined, fields: Record<string, unknown>) => JournalOp;
};

/** The persona's record (src/memory/record.js#createRecord) as far as `said` lines use it. */
export type NotesRecord = {
  append: (guildId: string, lines: Array<object>, options: { privateUserId?: string }) => unknown;
};

/** The intention service's note of where her lines came from (src/intentions/service.ts#noteLine). */
export type NotesIntentions = { noteLine?: (postedId: string, note: ReturnType<typeof lineSourcesOf>) => void } | null;

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
  guildId?: string;
  channelId?: string;
  privateUserId?: string | null;
  seenChars?: number;
  seenTexts?: Array<string>;
  seenRead?: boolean;
  inner?: { wake?: { chainId?: string | null } | null } | null;
  info?: { id: string; communityId?: string | null } | null;
  deliveredIn?: Iterable<string> | null;
  finalThink?: unknown;
  actions?: Array<unknown>;
};

/** A completion as the request dump keeps it. */
type DumpCompletion = NonNullable<Parameters<typeof journalUsage>[0]> & { text?: unknown; toolCalls?: unknown };

/** What a request carried besides messages, when it had tools. */
type DumpSent = { tools?: unknown; toolChoice?: unknown } | null;

/** A channel the notes name: its id and the community it is in, when one. */
type NotesChannel = { id: string; communityId?: string | null };

/** One of her posted messages as a `said` line takes it. */
type SaidArgs = {
  guildId: string;
  channel: NotesChannel & { partnerId?: string | null };
  privateChat: boolean;
  trigger?: { authorId?: string | null } | null;
  draft?: (NotesDraft & { started?: { turnId: string } | null }) | null;
  op?: { opId?: string | null } | null;
  posted?: { id?: unknown; createdTimestamp?: unknown } | null;
  text: unknown;
  replyId?: string | null;
  repliedAuthorId?: string | null;
  userIds: unknown;
};

/** What createJournalNotes reads: the dependencies and the runner's state the notes keep. */
export type JournalNotesContext = {
  hot: { readonly config: NotesConfig };
  clock: () => number;
  journal: NotesJournal | null;
  record: NotesRecord | null;
  intentions: NotesIntentions;
  iface: unknown;
  /** The facts store of the moment: the inner life's when it is on, else the runner's own. */
  facts: () => FactsApi;
  triggerLinks: Map<string, string>;
  callMarks: Array<CallMark>;
  postedFromLinks: Map<string, string>;
  thinks: ThinkStore;
  readOffPeriods: (guildId: string, options: { windowHours?: number }) => Promise<unknown>;
  liveChannelName: (
    channel: NotesChannel | null | undefined,
    snapshot?: Snapshot | null
  ) => (channelId: string) => string | null;
};

type FactScopeOf = { channelId: string | null; privateChat?: boolean };

export type JournalNotes = {
  factsOfKind: (guildId: string, scope: FactScopeOf, kind: string, at: number) => Array<Fact>;
  keepFact: (guildId: string, scope: FactScopeOf, kind: string, payload: Record<string, unknown>, at: number) => void;
  noteSeen: (draft: NotesDraft | null | undefined, value: unknown, options?: { read?: boolean }) => void;
  noteLineSources: (draft: NotesDraft | null | undefined, postedId: unknown, text: string) => void;
  noteTrigger: (postedId: unknown, triggerId: unknown) => void;
  linkTriggers: (lines: Array<object>) => Array<object>;
  earlierThinkFor: (args: {
    channel: NotesChannel;
    guildId: string | null;
    isPrivate: boolean;
    draft: NotesDraft;
    mode: string | null | undefined;
  }) => { text: string; relation: 'earlier'; ageMs: number } | null;
  recordTurnThink: (
    args: { guildId?: string | null; inner?: unknown },
    draft: NotesDraft,
    result: { outcome?: string; dryRun?: unknown } | null | undefined
  ) => void;
  noteCall: (mark: CallMark) => void;
  notePostedFrom: (postedId: unknown, originId: unknown) => void;
  linkCalls: (
    lines: Array<object>,
    options: { channel: NotesChannel; snapshot?: Snapshot | null; guildId: string | null; extra?: unknown }
  ) => Array<object>;
  journalOn: () => boolean;
  dumpTurnRequest: (
    guildId: string,
    draft: (NotesDraft & { started?: { turnId: string; attemptId: string } | null }) | null | undefined,
    messages: unknown,
    completion: DumpCompletion,
    step?: number | null,
    sent?: DumpSent,
    later?: unknown
  ) => void;
  offPeriodsFor: (guildId: string, config: NotesConfig) => Promise<unknown>;
  writeTurnRecords: (
    attempts: Iterable<{ draft: JournalDraft & { guildId: string }; result: Parameters<typeof journalTurnRecord>[1] }>
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

export function createJournalNotes(ctx: JournalNotesContext): JournalNotes {
  const {
    hot,
    clock,
    journal,
    record,
    intentions,
    iface,
    facts,
    triggerLinks,
    callMarks,
    postedFromLinks,
    thinks,
    readOffPeriods,
    liveChannelName,
  } = ctx;

  const failedKept = (): number => {
    const kept = hot.config.context?.failedTurnsKept;
    // Number.isInteger is true only for a number.
    return Number.isInteger(kept) && (kept as number) >= 0 ? (kept as number) : 3;
  };
  /** The facts of `kind` of the conversation `scope` still in their window, oldest first. */
  function factsOfKind(guildId: string, scope: FactScopeOf, kind: string, at: number): Array<Fact> {
    return facts()
      .pending(guildId, scope)
      .filter((fact) => fact.kind === kind && fact.channelId === scope.channelId && at - fact.at < FAILED_TURN_KEEP_MS);
  }
  /** A fact of `kind` kept (at most `failedKept()` of the kind per conversation, the newest; one per message). */
  function keepFact(
    guildId: string,
    scope: FactScopeOf,
    kind: string,
    payload: Record<string, unknown>,
    at: number
  ): void {
    const kept = failedKept();
    if (kept <= 0) return;
    const store = facts();
    if (payload.messageId)
      store.markTold(
        guildId,
        factsOfKind(guildId, scope, kind, at)
          .filter((fact) => fact.messageId === payload.messageId)
          .map((fact) => fact.id)
      );
    const fact: FactInput = { kind, ...scope, at, ...payload };
    store.add(guildId, fact);
    const live = factsOfKind(guildId, scope, kind, at);
    const over = live.slice(0, Math.max(0, live.length - kept)).map((fact) => fact.id);
    if (over.length > 0) store.markTold(guildId, over);
  }

  /**
   * Outside text the attempt `draft` has seen (src/intentions/sources.ts): someone's message, the
   * retrieved memory, a read's result; `read` marks outside material (a read, a page, a lookup, an
   * errand's result). At most SOURCE_CHARS_MAX characters in all.
   */
  function noteSeen(draft: NotesDraft | null | undefined, value: unknown, { read = false } = {}): void {
    if (!draft) return;
    const left = SOURCE_CHARS_MAX - (draft.seenChars ?? 0);
    const texts = left > 0 ? textsOf(value, left) : [];
    if (texts.length === 0) return;
    (draft.seenTexts ??= []).push(...texts);
    draft.seenChars = (draft.seenChars ?? 0) + texts.reduce((sum, text) => sum + text.length, 0);
    if (read) draft.seenRead = true;
  }

  /**
   * Where her line `postedId` (its `text` as she wrote it) came from, noted with the intention
   * service for the candidates the analyzer may find in it (src/intentions/sources.ts#lineSourcesOf:
   * what the turn had seen before it went out, its turn, an inner turn's chain). Never throws.
   */
  function noteLineSources(draft: NotesDraft | null | undefined, postedId: unknown, text: string): void {
    if (typeof intentions?.noteLine !== 'function' || typeof postedId !== 'string' || !postedId) return;
    try {
      intentions.noteLine(
        postedId,
        lineSourcesOf({
          text,
          external: draft?.seenTexts ?? [],
          read: draft?.seenRead === true,
          turnId: draft?.started?.turnId ?? draft?.turnKey?.turnId ?? null,
          inner: Boolean(draft?.inner),
          chainId: draft?.inner?.wake?.chainId ?? null,
        })
      );
    } catch (err) {
      log.warn('turn: line sources not noted', { error: err });
    }
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
    if (hot.config.features?.triggerMarkers === false) return lines;
    return withTriggers(lines, triggerLinks);
  }

  /** Whether her previous think is carried at all (features.previousThink, read now; a missing key counts as on). */
  function previousThinkOn(): boolean {
    return hot.config.features?.previousThink !== false;
  }

  /**
   * The key of the place a channel is (interface + server or private chat + channel).
   */
  function placeOf(channel: NotesChannel, guildId: string | null = null): string {
    return placeKey({
      guildId: inCommunity(channel) ? (guildId ?? channel.communityId ?? null) : null,
      channelId: channel.id,
    });
  }

  /**
   * The think a NEW turn's first request carries (an inner turn imports none), chosen once, logged
   * `turn: previous think` with the source (turn id, relation, age) or why there is none. Null when
   * nothing is carried.
   */
  function earlierThinkFor({
    channel,
    guildId,
    isPrivate,
    draft,
    mode,
  }: {
    channel: NotesChannel;
    guildId: string | null;
    isPrivate: boolean;
    draft: NotesDraft;
    mode: string | null | undefined;
  }): { text: string; relation: 'earlier'; ageMs: number } | null {
    if (!previousThinkOn() || draft.inner || mode === 'diary') return null;
    const picked = thinks.select(placeOf(channel, guildId), {
      now: clock(),
      minutes: hot.config.context?.previousThink?.minutes ?? 0,
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
    args: { guildId?: string | null; inner?: unknown },
    draft: NotesDraft,
    result: { outcome?: string; dryRun?: unknown } | null | undefined
  ): void {
    try {
      const channel = draft.info;
      const outcome = result?.outcome ?? 'error';
      if (!channel || result?.dryRun === true || !previousThinkOn()) return;
      const failed = outcome === 'error' || outcome === 'refused';
      if (!failed && outcome !== 'spoke' && outcome !== 'skip') return;
      const guildId = args.guildId ?? channel.communityId ?? null;
      const delivered = [...(draft.deliveredIn ?? [])].map((id) =>
        placeKey({ guildId: inCommunity(channel) ? guildId : null, channelId: id })
      );
      thinks.record({
        turnId: draft.started?.turnId ?? draft.turnKey?.turnId ?? null,
        at: clock(),
        think: draft.finalThink ?? null,
        failed,
        isPrivate: !inCommunity(channel),
        inner: Boolean(args.inner),
        ran: placeOf(channel, guildId),
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
   * channel names read live from the guild of `channel` (the turn's), the message links built in
   * `guildId` (`@me` for a message of the private chat itself). `lines` as they are with
   * features.callMarkers off (a missing key counts as on, read now).
   */
  function linkCalls(
    lines: Array<object>,
    {
      channel,
      snapshot = null,
      guildId,
      extra = null,
    }: { channel: NotesChannel; snapshot?: Snapshot | null; guildId: string | null; extra?: unknown }
  ): Array<object> {
    if (hot.config.features?.callMarkers === false) return lines;
    const turnMarks: Array<CallMark> = Array.isArray(extra) ? (extra as Array<CallMark>) : [];
    if (callMarks.length === 0 && turnMarks.length === 0 && postedFromLinks.size === 0) return lines;
    const privateId = inCommunity(channel) ? null : String(channel.id);
    return withCalls(
      lines,
      { calls: turnMarks.length > 0 ? [...callMarks, ...turnMarks] : callMarks, postedFrom: postedFromLinks },
      {
        nameOf: liveChannelName(channel, snapshot),
        linkOf: (channel, message) => messageLinkOf(iface, channel === privateId ? null : guildId, channel, message),
      }
    );
  }

  /** Whether the journal is written now: one injected and features.journal exactly true (read now). */
  function journalOn(): boolean {
    return Boolean(journal) && hot.config.features?.journal === true;
  }

  /**
   * The journal's request dump (journal.keepRequests) of one request of the turn: the message
   * list as sent and the raw answer; `step` (1, 2, ...) for a request after a call (the
   * follow-up, the tool loop's steps), none for the reply's own. Fire-and-forget, only for a
   * started turn with the journal on; a failure is logged with a count of one, never the contents.
   * `sent` (`{ tools, toolChoice }`) is what the request carried besides messages, when it had tools.
   * `later` (the messages after the first two, when the turn's steps appended any) is stored with the dump.
   */
  function dumpTurnRequest(
    guildId: string,
    draft: (NotesDraft & { started?: { turnId: string; attemptId: string } | null }) | null | undefined,
    messages: unknown,
    completion: DumpCompletion,
    step: number | null = null,
    sent: DumpSent = null,
    later: unknown = null
  ): void {
    if (!draft?.started || !journalOn() || typeof journal?.dumpRequest !== 'function') return;
    const started = draft.started;
    const target = journal;
    Promise.resolve()
      .then(() =>
        // The check above found dumpRequest on this journal.
        target.dumpRequest!(guildId, {
          turnId: started.turnId,
          attemptId: started.attemptId,
          ...(step !== null ? { step } : {}),
          request: { messages },
          raw: completion.text,
          usage: journalUsage(completion),
          privateUserId: draft.privateUserId ?? null,
          // A request that carried tools: the definitions and the choice sent, the answer's calls.
          ...(Array.isArray(sent?.tools) && sent.tools.length > 0
            ? { tools: sent.tools, toolChoice: sent.toolChoice ?? 'auto' }
            : {}),
          ...(Array.isArray(completion.toolCalls) && completion.toolCalls.length > 0
            ? { toolCalls: completion.toolCalls }
            : {}),
          ...(Array.isArray(later) && later.length > 0 ? { later } : {}),
        })
      )
      .catch((error: unknown) =>
        log.warn('journal: dump failed', { code: codeOf(error), failed: 1, ...(step !== null ? { step } : {}) })
      );
  }

  /**
   * The off periods `<now>` shows (src/memory/journal.js#offPeriods): read only with the journal
   * on and features.offPeriods on (a missing key counts as on), over the last
   * `journal.offWindowHours` hours (24 when unset), all read now; null otherwise. Never throws.
   */
  async function offPeriodsFor(guildId: string, config: NotesConfig): Promise<unknown> {
    if (!journalOn() || config.features?.offPeriods === false) return null;
    return readOffPeriods(guildId, { windowHours: config.journal?.offWindowHours ?? 24 });
  }

  /** The turn records of runTurn's attempts, in order; a failed append is the journal's to log. */
  async function writeTurnRecords(
    attempts: Iterable<{ draft: JournalDraft & { guildId: string }; result: Parameters<typeof journalTurnRecord>[1] }>
  ): Promise<void> {
    for (const { draft, result } of attempts) {
      // writeTurnRecords runs only for a runner whose journal is on (runTurn checks journalOn first).
      await journal!.turn(draft.guildId, journalTurnRecord(draft, result));
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
    guildId,
    channel,
    privateChat,
    trigger,
    draft,
    op,
    posted,
    text,
    replyId,
    repliedAuthorId,
    userIds,
  }: SaidArgs): void {
    if (!record || hot.config.features?.record !== true) return;
    if (typeof posted?.id !== 'string' || !posted.id) return;
    const privateUserId = privateChat ? (draft?.privateUserId ?? trigger?.authorId ?? channel.partnerId ?? null) : null;
    if (privateChat && !privateUserId) return;
    const line = toRecordLine(
      {
        id: posted.id,
        channelId: channel.id,
        content: text,
        ts: Number.isFinite(posted.createdTimestamp) ? posted.createdTimestamp : clock(),
        replyToId: replyId ?? null,
        replyToAuthorId: repliedAuthorId ?? null,
        mentionedUserIds: userIds,
      },
      { kind: 'said', now: clock, turnId: draft?.started?.turnId ?? null, opId: op?.opId ?? null }
    );
    const failed = (err: unknown): void =>
      log.warn('turn: record failed', { channel: channel.id, lines: 1, code: codeOf(err) });
    try {
      Promise.resolve(record.append(guildId, [line], privateUserId ? { privateUserId } : {})).catch(failed);
    } catch (err) {
      failed(err);
    }
  }

  /**
   * One side effect of the attempt `draft` as a journal operation (src/memory/journal.js#op):
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
    const handle = journal.op(draft.guildId, {
      turnId: draft.started.turnId,
      name,
      by,
      channelId: draft.channelId,
      privateUserId: draft.privateUserId,
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

  return {
    factsOfKind,
    keepFact,
    noteSeen,
    noteLineSources,
    noteTrigger,
    linkTriggers,
    earlierThinkFor,
    recordTurnThink,
    noteCall,
    notePostedFrom,
    linkCalls,
    journalOn,
    dumpTurnRequest,
    offPeriodsFor,
    writeTurnRecords,
    recordSaid,
    journalOp,
  };
}
