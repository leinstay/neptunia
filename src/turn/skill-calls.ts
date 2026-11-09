// Her skill calls in a turn: what a call is resolved against, the gateway's check, the plan of one call before its
// step does anything, an inner turn's gate, and the call made with its journal lines, marks and notes; a step's
// planned calls made in segments. createTurnRunner (src/behavior/turn.ts) builds it once per runner with
// createSkillCalls; the tool round and the attempt call its functions.

import type { Chat } from '../protocol/events.ts';
import { turnBoundary } from '../tools/publication.ts';
import type { ChatRef } from '../protocol/adapter.ts';
import { placeOfChat } from '../memory/addresses.ts';
import type { Context } from '../memory/db/scope.ts';
import { DESTINATION_REQUIRED } from '../behavior/inner-output.ts';
import type { Snapshot } from '../behavior/snapshot.ts';
import type { TurnRoutes } from '../behavior/turn-ability-route.ts';
import { segments } from '../behavior/tool-step.ts';
import { isIntentionId } from '../intentions/model.ts';
import { log } from '../log.ts';
import { callArgsText } from '../tools/call-args.ts';
import { CODE } from '../tools/codes.ts';
import { hasTrait } from '../tools/definitions.ts';
import { executeCall, outcomeDetail, refusalStatus, resolveCall } from '../tools/executors.ts';
import type { CallResult, CallView, ExecuteDeps, Resolved, RunOperation } from '../tools/executors.ts';
import { checkSkill } from '../tools/gateway.ts';
import type { GateContext, Refusal } from '../tools/gateway.ts';
import { placeChoicesText } from '../tools/place-names.ts';
import type { HeldNote, SendHold } from '../tools/send-hold.ts';
import { objOf } from '../tools/types.ts';
import type { Obj, SkillMap } from '../tools/types.ts';
import {
  callTextOf,
  callViewOf,
  defaultSkills,
  lookupOfCall,
  lookupSettingsOf,
  MARK_TEXT_CHARS,
  PERSONA,
  valuesOf,
  WRITTEN_SKILLS,
} from './calls.ts';
import type { CallEnvelope, KnownPlace, Lookup, LookupRing, SearchRefs } from './calls.ts';
import { clampWithEllipsis } from '../memory/clamp.ts';
import { journalResultOf, portError, postedOf } from './journal.ts';
import type { JournalOp } from './journal.ts';
import type { CallMark, JournalNotes, NotesDraft } from './journal-notes.ts';
import { untaggedNote } from './mentions.ts';
import { inRoot, snapshotOfDraft } from './routing.ts';
import type { PostRefs, RenderedPost, Sends } from './sends.ts';
import type { Handles } from './handles.ts';
import { wakeRefusalCode } from '../tools/wake-tools.ts';
import { INTENT_ID_SKILLS } from './settings.ts';

/** The live config, as far as the calls read it; the gateway and the executors read their own sections. */
export type CallsConfig = { tools?: { callTimeoutMs?: number } | null };

type CallsLabels = Parameters<typeof untaggedNote>[2];

/** The interface port (src/interface/port.ts), as a call posts through it. */
type CallsPort = ExecuteDeps['port'] & { iface: string };

/** The errands service (src/errands/service.ts), as far as a call reads its files and budgets. */
type CallsErrands = {
  fileOf?: (args: {
    placeId: string | null;
    handle: string;
    dmChatId: string | null;
  }) => ReturnType<NonNullable<CallView['fileOf']>>;
  budget: (args: { agent: unknown }) => unknown;
} | null;

/** What createSkillCalls reads: the dependencies, the runner's state and the functions of the other topic modules. */
export type SkillCallsContext = {
  hot: { readonly config: CallsConfig; readonly prompts: { labels?: CallsLabels } | null | undefined };
  store: Parameters<typeof callViewOf>[0]['store'];
  /** The learned stemmer, read at the moment of use; null while no memory is open (src/memory/db/stems.ts#loadStemmer). */
  stemmer?: () => { stem: (word: string) => string } | null;
  /** The name index of the memory under a turn's context: the live places a name names (names.ts#placesNamed). */
  placesNamedFor?: (draft: CallsDraft | null, channel: CallChannel) => CallView['placesNamed'];
  /** The memory graph under a turn's context: the places it ranks for words that name no place (graph-find.ts#placesFound). */
  placesFoundFor?: (draft: CallsDraft | null, channel: CallChannel) => CallView['placesFound'];
  /** The memory's channels and threads on every interface with their native ids, read when used; none while it is closed. */
  knownPlaces?: () => ReadonlyArray<KnownPlace>;
  /** A stored place by its id as its interface knows it (frame-reads.ts#placeRefOf), null without a row or a memory. */
  placeRef?: CallView['placeRef'];
  skills: SkillMap | null;
  selfIdOf: () => string;
  clock: () => number;
  iface: CallsPort;
  chatOf: (channel: { id: string }) => ChatRef;
  images: GateContext['images'] | undefined;
  speech: GateContext['speech'] | null;
  errands: CallsErrands;
  runOp: RunOperation | null;
  runOwnOp: RunOperation | null;
  runInitiativeOp: RunOperation | null;
  routes: TurnRoutes;
  lastPostAt: Map<string, number>;
  renderPost: Sends['renderPost'];
  noteTrigger: JournalNotes['noteTrigger'];
  notePostedFrom: JournalNotes['notePostedFrom'];
  noteCall: JournalNotes['noteCall'];
  recordSaid: JournalNotes['recordSaid'];
  journalOp: JournalNotes['journalOp'];
  /** The ring of her lookups per place (src/turn/calls.ts#createLookupRing); absent: none is kept. */
  lookupRing?: LookupRing | null;
};

/** Why a call cannot run: its code, a machine reason and the values its label names. */
export type CallRefusal = { code: string; reason?: string; values?: unknown; place?: Refusal['place'] };

/** One call of hers as it is planned: a tool call of her answer, or an inner turn's tag lowered to its call. */
export type PlannedCall = {
  skill: string;
  args: Obj;
  body: string | boolean;
  toolCallId?: string;
  index?: number;
  coerced?: Array<unknown>;
  preRefuse?: CallRefusal;
  refuse?: CallRefusal;
  lowered?: unknown;
};

/** An inner turn, as its calls read it (src/behavior/inner.ts). */
type CallsInner = {
  shadow?: boolean;
  mayAct?: () => boolean;
  currentChannel?: string | null;
  wake?: { kind?: string | null } | null;
  /** A live wake turn's hold: her posts wait in it for the wake's completion (src/tools/send-hold.ts). */
  hold?: SendHold | null;
};

/** The skills that act on a message of hers named by `message`: `last` after a held post names the held message. */
const OWN_MESSAGE_SKILLS: ReadonlyArray<string> = [
  'message.edit',
  'message.delete',
  'message.react.add',
  'message.react.remove',
];

/** The skills whose `text` is stored as a record of hers: an intention made or changed. */
const STORED_TEXT_SKILLS: ReadonlyArray<string> = ['intention.set', 'intention.update'];

/** Whether a message argument is `last`, her own most recent message (any case, as src/tools/operations/message.ts reads it). */
const isLast = (value: unknown): boolean => typeof value === 'string' && value.trim().toLowerCase() === 'last';

/** One call of an inner turn as its action record keeps it. */
export type InnerAction = {
  skill: string;
  status: 'proposed' | 'executed' | 'refused';
  result: string;
  code?: string;
  text?: string;
  target: Record<string, string>;
  intentionId?: string;
  createdId?: string;
  state?: string;
  presented?: boolean;
};

/** What an attempt's draft holds that the calls read and write. */
export type CallsDraft = NonNullable<Parameters<JournalNotes['journalOp']>[0]> &
  NotesDraft & {
    memoryContext?: Context;
    nowhere?: boolean;
    inner?: CallsInner | null;
    ownInitiative?: boolean;
    innerActions?: Array<InnerAction>;
    innerIntentIds?: Set<string>;
    ownPosts?: Array<string | null>;
    deliveredIn?: Set<string>;
    selfreflection?: unknown;
    selfreflectionVoice?: { text: unknown; durationSecs: unknown };
    turnMarks?: Array<CallMark>;
    snapshot?: Snapshot | null;
    /** The turn's handle registry (src/turn/handles.ts). */
    handles?: Handles | null;
    /** Whom a private chat's or the command line's reads are judged by (setup.ts): the partner, or the owner's account. */
    readerId?: string | null;
    /** The place a framed request was built for: a lookup of hers is kept for `<recall>` there (src/turn/calls.ts). */
    framePlace?: { id: string; path: Array<string> } | null;
    /** How a line's identity in her posted words is read back (src/turn/sends.ts#renderPost). */
    frameRefs?: PostRefs | null;
    /** Her skills the tools array offered, name to the version offered (src/turn/phases/request/build.ts). */
    offeredSkills?: Map<string, string>;
    /** The skills she read in this turn, each as first read: a second call answers from here. */
    procedures?: Map<string, { text: string; versionId: string }>;
  };

/** The turn's registry of the lines a memory.search quoted (src/turn/calls.ts#searchHandles), when it has one. */
const searchRefsOf = (draft: CallsDraft | null | undefined): SearchRefs | undefined =>
  draft ? (Reflect.get(draft, 'searchRefs') as SearchRefs | undefined) : undefined;

/** The stored source ids of the lines quoted since `before` (the numbers the registry held then), each once. */
function quotedSince(draft: CallsDraft | null | undefined, before: ReadonlySet<number>): Array<string> {
  const refs = searchRefsOf(draft);
  if (!refs) return [];
  const ids = [...refs.byNumber].filter(([n]) => !before.has(n)).map(([, ref]) => ref.stored?.sourceId);
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))];
}

/** The wake an inner turn's draft runs under; nothing on any other turn. */
const wakeOf = (draft: CallsDraft | null | undefined) => draft?.inner?.wake;

/** The channel a call is made from, as the interface described it. */
type CallChannel = Pick<Chat, 'id' | 'rootId'> & { name?: unknown };

type ViewArgs = Parameters<typeof callViewOf>[0];

/** A planned call: its plan, its journal operation, its envelope, what it resolved to or why it was refused. */
export type CallPlan = {
  call: PlannedCall;
  op: JournalOp | Readonly<JournalOp>;
  envelope: CallEnvelope;
  resolved: Resolved | null;
  refusal: CallRefusal | null;
};

/** What a call's result carries beside its status, as the turn reads it. */
type CallAnswer = CallResult & {
  ref?: { chatId?: string; messageId?: string } | null;
  values?: unknown;
  voice?: { text: unknown; durationSecs: unknown } | null;
  intentionId?: unknown;
  error?: { code?: string; cause?: unknown } | null;
  note?: string;
};

/** The operation a skill entry of the tools array runs (src/tools/operations/skill.ts#cmdRead). */
const READ_SKILL = 'skill.read';

/** The skill a call reads when it is a `skill.read` of a skill the tools array offered, else null. */
function offeredRead(draft: CallsDraft | null | undefined, skill: string, args: Obj | null | undefined): string | null {
  const name = skill === READ_SKILL && typeof args?.name === 'string' ? args.name : '';
  return name !== '' && draft?.offeredSkills?.has(name) === true ? name : null;
}

/**
 * The answer kept from the first read in this turn of the procedure a call reads (docs/skills.md), null when this read
 * is the first or the call reads no offered skill: a second call answers the text the first one read.
 */
function procedureKept(
  draft: CallsDraft | null | undefined,
  skill: string,
  args: Obj | null | undefined
): CallAnswer | null {
  const name = offeredRead(draft, skill, args);
  const kept = name === null ? undefined : draft?.procedures?.get(name);
  return kept === undefined ? null : { status: 'ok', data: { text: kept.text } };
}

/** Keeps the text of a first read of an offered skill that worked, with the version the tools array offered. */
function keepProcedure(
  draft: CallsDraft | null | undefined,
  skill: string,
  args: Obj | null | undefined,
  answer: CallAnswer
): void {
  const name = offeredRead(draft, skill, args);
  const text = objOf(answer.data).text;
  if (draft == null || name === null || answer.status !== 'ok' || typeof text !== 'string') return;
  (draft.procedures ??= new Map()).set(name, { text, versionId: draft.offeredSkills?.get(name) ?? '' });
}

/** A call's result with its skill. */
export type CallOutcome = CallAnswer & { skill: string };

type RenderArgs = Parameters<Sends['renderPost']>[1];

/** Where a call is made: the turn's context, as runCall reads it. */
export type CallContext = {
  channel: CallChannel;
  trigger: { id?: string; authorId?: string | null } | null | undefined;
  placeId: string;
  draft: CallsDraft | null;
  dmChat?: boolean;
  idByIndex?: ReadonlyMap<number, string> | null;
  pulledIds?: ReadonlyMap<string, string> | null;
  lines?: RenderArgs['lines'];
  knownNames?: RenderArgs['knownNames'];
  directory?: RenderArgs['directory'];
  handles?: Map<string, string> | null;
  memberNames?: Map<string, Array<string>> | null;
  channelHandles?: unknown;
  timeoutMs?: number | null;
  inTurn?: ExecuteDeps['inTurn'] | null;
};

export type SkillCalls = {
  callView: (args: {
    channel: CallChannel;
    snapshot?: Snapshot | null;
    placeId: string;
    idByIndex: ViewArgs['idByIndex'];
    lines: ViewArgs['lines'];
    pulledIds: ViewArgs['pulledIds'];
    memoryOn: boolean;
    channelHandles?: unknown;
    memberHandles?: unknown;
    trigger?: { content?: unknown } | null;
    deletedIds?: unknown;
    searchRefs?: ViewArgs['searchRefs'];
    /** The reader of a private chat or the command line, whom the places a read may name are judged by. */
    partnerId?: string | null;
    /** The turn's draft, whose memory context the name index is read under. */
    draft?: CallsDraft | null;
  }) => CallView;
  planToolCall: (args: {
    call: PlannedCall;
    channel: CallChannel;
    envelope: CallEnvelope;
    draft: CallsDraft | null;
    view: CallView;
  }) => Promise<CallPlan>;
  innerVerdict: (
    inner: CallsInner,
    skill: string,
    at: { channel: CallChannel; args: Obj | null | undefined }
  ) => { proposed?: true; refusal?: CallRefusal; public?: boolean } | null;
  runCall: (plan: CallPlan, context: CallContext) => Promise<CallOutcome>;
  runCalls: (plans: ReadonlyArray<CallPlan>, context: CallContext) => Promise<Array<CallOutcome>>;
  intentionNamed: (skill: string, args: Obj | null | undefined) => string | null;
};

// health: allow function-length until 2027-04-01 -- the calls share the runner state of src/behavior/turn.ts, moved whole in stage 5b
export function createSkillCalls(ctx: SkillCallsContext): SkillCalls {
  const {
    hot,
    store,
    stemmer = () => null,
    placesNamedFor = () => null,
    placesFoundFor = () => null,
    knownPlaces = () => [],
    placeRef = null,
    skills,
    selfIdOf,
    clock,
    iface: port,
    chatOf,
    images,
    speech,
    errands,
    runOp,
    runOwnOp,
    runInitiativeOp,
    routes,
    lastPostAt,
    renderPost,
    noteTrigger,
    notePostedFrom,
    noteCall,
    recordSaid,
    journalOp,
    lookupRing = null,
  } = ctx;

  /**
   * The lookup a call of a read tool is, kept in the ring for `<recall>` on the next turns of the place and returned for
   * the operation's closing line, its extract cut to `context.recall.extractChars`; null for any other call.
   */
  function keptLookup(
    skill: string,
    args: Obj,
    result: CallAnswer,
    draft: CallsDraft | null | undefined,
    found: { trigger: { id?: string | null } | null | undefined; sourceIds: ReadonlyArray<string> }
  ): Lookup | null {
    const lookup = lookupOfCall({
      read: (skills ?? defaultSkills()).get(skill)?.kind === 'read' && draft?.inner?.shadow !== true,
      place: draft?.framePlace ?? null,
      turnId: draft?.started?.turnId,
      at: clock(),
      tool: skill,
      args,
      status: result.status,
      text: (result.data as { text?: unknown } | null | undefined)?.text,
      sourceIds: found.sourceIds,
      anchorIds: [found.trigger?.id],
    });
    if (lookup === null) return null;
    const settings = lookupSettingsOf(hot.config);
    lookupRing?.note(lookup, settings);
    return { ...lookup, extract: clampWithEllipsis(lookup.extract, settings.extractChars) };
  }

  /** Whether a resolved call acts in the turn's own place when it names none, and named none. */
  const placeUnnamed = (resolved: Resolved): boolean =>
    hasTrait(resolved.skill, 'here') && resolved.args.place === undefined;

  // `${skill}:${originChannelId}` -> when a destructive skill call of hers was last dispatched
  // from that channel (tools.destructiveCooldownMinutes, src/tools/gateway.ts); in process.
  const destructiveRuns = new Map<string, number>();

  /** What a `<call>` of the persona is resolved against: callViewOf over this runner's store, id and registry. */
  function callView({
    channel,
    snapshot = null,
    placeId,
    idByIndex,
    lines,
    pulledIds,
    memoryOn,
    channelHandles = null,
    memberHandles = null,
    trigger = null,
    deletedIds = null,
    searchRefs = null,
    partnerId = null,
    draft = null,
  }: Parameters<SkillCalls['callView']>[0]): CallView {
    const fileOf =
      typeof errands?.fileOf === 'function'
        ? (handle: string) =>
            // Checked just above; the closure cannot see the check.
            errands.fileOf!({ placeId, handle, dmChatId: inRoot(channel) ? null : String(channel.id) })
        : null;
    return callViewOf({
      currentIface: port.iface,
      channel,
      snapshot,
      placeId,
      idByIndex,
      lines,
      pulledIds,
      memoryOn,
      store,
      selfId: selfIdOf() || null,
      skills: skills ?? defaultSkills(),
      channelHandles,
      memberHandles,
      fileOf,
      triggerText: typeof trigger?.content === 'string' ? trigger.content : null,
      deletedIds,
      searchRefs,
      partnerId,
      config: hot.config,
      stem: stemmer?.()?.stem ?? null,
      placesNamed: placesNamedFor(draft, channel) ?? null,
      placesFound: placesFoundFor(draft, channel) ?? null,
      knownPlaces: knownPlaces(),
      placeRef,
    });
  }

  /**
   * The gateway's verdict on a resolved `<call>` (src/tools/gateway.ts#checkSkill, the live
   * config read now): the persona as principal, the envelope's requester (callEnvelope), the
   * turn's channel as the audience, the last run of a destructive skill from the origin channel
   * (`destructiveRuns`), the image client's caps as the drawing budget. A refusal logs
   * `skill: refused`.
   */
  function checkCall(
    resolved: Resolved,
    { channel, envelope, draft = null }: { channel: CallChannel; envelope: CallEnvelope; draft?: CallsDraft | null }
  ): ReturnType<typeof checkSkill> {
    const wakeKind = wakeOf(draft)?.kind;
    const verdict = checkSkill({
      skill: resolved.skill,
      args: resolved.args,
      principal: PERSONA,
      requester: envelope.requester,
      audience: { chatId: String(channel.id) },
      context: {
        config: hot.config,
        selfId: selfIdOf() || null,
        registry: skills ?? defaultSkills(),
        mixedRequesters: envelope.mixed,
        // An inner turn, or the result turn of her own errand, is her own initiative: nobody asked, her grants alone decide.
        ...(draft?.inner || draft?.ownInitiative ? { ownInitiative: true } : {}),
        // An inner turn's wake envelope (wakes.kinds.<kind>): its wake kind and the calls it made so far.
        ...(wakeKind ? { wakeKind: String(wakeKind), wakeActions: draft?.innerActions ?? [] } : {}),
        lastRunAt: destructiveRuns.get(`${resolved.skill}:${envelope.originChannelId}`) ?? null,
        now: clock(),
        ...(images ? { images } : {}),
        ...(speech ? { speech } : {}),
        // An errand's caps are its budget (src/errands/service.ts#budget).
        ...(errands ? { tasks: { budget: (agent: unknown) => errands.budget({ agent }) } } : {}),
      },
    });
    if (!verdict.ok)
      log.info('skill: refused', {
        skill: resolved.skill,
        code: verdict.code,
        reason: verdict.reason,
        channel: channel.id,
      });
    return verdict;
  }

  /**
   * One call of the persona (`call`: `{ skill, args, body, toolCallId?, index?, coerced?, preRefuse?, refuse?, lowered? }`: a
   * tool call of her answer after normalizeCalls and coerceArgs, or an inner turn's tag lowered to the call it stands
   * for) planned before anything of its step is done: its journal operation (`skill`, by the persona) writes `proposed`
   * with the skill, the envelope's invocation id, the names of its arguments, its tool call id and the arguments that
   * were read in another type, then the call is checked in this order -- `preRefuse` (a call that cannot run: unreadable,
   * unknown, cut off, past the step's cap), `refuse` (an inner tag that cannot act), the wake's rule (src/tools/wake-tools.ts), an inner turn's
   * destination for a picture --, resolved on the server's side (`view`: callView's) and checked (checkCall). Resolves
   * `{ call, op, envelope, resolved, refusal }`: `resolved` null and `refusal` (`{ code, reason }`) when anything said
   * no -- logged `skill: refused`. Nothing runs here.
   */
  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/turn.ts in stage 5b, a pure move
  async function planToolCall({
    call: given,
    channel,
    envelope,
    draft,
    view,
  }: Parameters<SkillCalls['planToolCall']>[0]): Promise<CallPlan> {
    let call = given;
    // A call of an inner turn in shadow mode is only proposed: its lines say so (no call mark is drawn from them).
    const op = journalOp(draft, 'skill', 'persona', {
      input: { skill: call.skill, invocationId: envelope.invocationId },
      ...(draft?.inner?.shadow ? { shadow: true } : {}),
    });
    if (op.opId)
      await op.proposed({
        input: {
          skill: call.skill,
          invocationId: envelope.invocationId,
          args: Object.keys(call.args ?? {}),
          body: Boolean(call.body),
          ...(typeof call.toolCallId === 'string' && call.toolCallId ? { toolCallId: call.toolCallId } : {}),
          ...(Array.isArray(call.coerced) && call.coerced.length > 0
            ? { coerced: call.coerced.filter((name) => typeof name === 'string') }
            : {}),
        },
      });
    // A call that cannot run (unreadable, unknown, cut off, past what the step allows): refused with its own code, she reads why.
    if (call.preRefuse) {
      log.info('skill: refused', {
        skill: call.skill,
        code: call.preRefuse.code,
        reason: call.preRefuse.reason,
        channel: channel.id,
      });
      return { call, op, envelope, resolved: null, refusal: { ...call.preRefuse } };
    }
    // An inner turn's tag that cannot act (src/behavior/inner-output.ts): refused before anything is resolved or done.
    if (call.refuse) {
      log.info('skill: refused', {
        skill: call.skill,
        code: call.refuse.code,
        reason: call.refuse.reason,
        channel: channel.id,
      });
      return { call, op, envelope, resolved: null, refusal: { code: call.refuse.code, reason: call.refuse.reason } };
    }
    // A wake's own set: a call outside it, and a task answer outside the selfimprovement wake, are refused before resolution.
    const wakeKind = wakeOf(draft)?.kind ?? null;
    const wakeRefusal = wakeRefusalCode(wakeKind, call.skill);
    if (wakeRefusal !== null) {
      const reason = `${String(wakeKind ?? 'selfimprovement')}:only`;
      log.info('skill: refused', { skill: call.skill, code: wakeRefusal, reason, channel: channel.id });
      log.info(`${String(wakeKind ?? 'selfimprovement')}: call refused`, { skill: call.skill, code: wakeRefusal });
      return { call, op, envelope, resolved: null, refusal: { code: wakeRefusal, reason } };
    }
    // A skill her tools array offered is read as `skill.read` of its name: the journal records the read, and her grant
    // of `skill.read` is checked as for any call. A procedure widens no permission.
    if (draft?.offeredSkills?.has(call.skill) === true)
      call = { ...call, skill: READ_SKILL, args: { name: call.skill } };
    // An inner turn's picture lands in its current channel, as its speech does; with none, there is nowhere to post it.
    if (draft?.inner && hasTrait(call.skill, 'attaches') && typeof call.args?.place !== 'string') {
      const current = draft.inner.currentChannel === undefined ? String(channel.id) : draft.inner.currentChannel;
      if (!current) {
        log.info('skill: refused', {
          skill: call.skill,
          code: DESTINATION_REQUIRED.code,
          reason: DESTINATION_REQUIRED.reason,
          channel: channel.id,
        });
        return {
          call,
          op,
          envelope,
          resolved: null,
          refusal: { code: DESTINATION_REQUIRED.code, reason: DESTINATION_REQUIRED.reason },
        };
      }
      if (String(current) !== String(channel.id)) call = { ...call, args: { ...call.args, channel: String(current) } };
    }
    const resolved = resolveCall(call, view);
    if (!resolved.ok) {
      log.info('skill: refused', {
        skill: call.skill,
        code: resolved.code,
        reason: resolved.reason,
        channel: channel.id,
      });
      // An errand's file bound for a channel nobody named (src/tools/executors.ts#resolveCall).
      if (resolved.code === CODE.FILE_ELSEWHERE)
        log.info('skills: file elsewhere refused', {
          skill: call.skill,
          code: resolved.code,
          reason: resolved.reason,
          channel: channel.id,
        });
      return {
        call,
        op,
        envelope,
        resolved: null,
        refusal: {
          code: resolved.code,
          reason: resolved.reason,
          ...(resolved.place ? { place: resolved.place } : {}),
        },
      };
    }
    // A turn that is nowhere has no place of its own: a call that takes a place needs it named. A selfreflection post's
    // picture and voice are kept for its entry, so they need none.
    if (draft?.nowhere === true && !draft.selfreflection && placeUnnamed(resolved)) {
      log.info('skill: refused', { skill: call.skill, code: CODE.PLACE_REQUIRED, reason: 'nowhere', channel: null });
      return { call, op, envelope, resolved: null, refusal: { code: CODE.PLACE_REQUIRED, reason: 'nowhere:channel' } };
    }
    // The message's own channel taken over the one she named: logged, never the ids.
    if (resolved.channelFixed)
      log.info('skills: message channel taken from the message', { skill: resolved.skill, channel: channel.id });
    const verdict = checkCall(resolved, { channel, envelope, draft });
    return {
      call,
      op,
      envelope,
      resolved: verdict.ok ? resolved : null,
      refusal: verdict.ok ? null : { code: verdict.code, reason: verdict.reason },
    };
  }

  /** `labels.tools.result.storedUntilOpen`, read now: a post kept for a chat that is not open. */
  function storedUntilOpen(): string {
    const worded = objOf(objOf(objOf(hot.prompts?.labels).tools).result).storedUntilOpen;
    return typeof worded === 'string' ? worded : '';
  }

  /** `labels.tools.result.heldUntilEnd`, read now: a held post goes out when the wake's turn ends. */
  function heldUntilEnd(): string {
    const worded = objOf(objOf(objOf(hot.prompts?.labels).tools).result).heldUntilEnd;
    return typeof worded === 'string' ? worded : '';
  }

  /**
   * What a held call's sends are for: its skill, and for a `message.create` the said line its post becomes once it is
   * sent, with the fields a sent post's line takes in runCall (her text as resolved, the reply, the replied author and
   * the members the rendering mentioned).
   */
  function heldNoteOf(
    skill: string,
    resolved: Resolved,
    { dmChat, rendered }: { dmChat: boolean; rendered: RenderedPost | null }
  ): HeldNote {
    const args: Obj = resolved.args ?? {};
    const said =
      skill === 'message.create' && typeof args.text === 'string'
        ? {
            text: args.text,
            // A resolved `reply` is a message id (src/tools/executors.ts#resolveCall).
            replyId: typeof args.reply === 'string' ? args.reply : null,
            repliedAuthorId: typeof resolved.repliedAuthorId === 'string' ? resolved.repliedAuthorId : null,
            accountIds: (rendered?.accountIds ?? []).filter((id): id is string => typeof id === 'string' && id !== ''),
          }
        : null;
    return { skill, dmChat, said };
  }

  /**
   * The ids a resolved call aims at (its place, message, reply target, member), for its journal line: never its text.
   * The place is stored under the journal's key `channel`, which the readers of the day's actions read.
   */
  function callTarget(args: Obj | null | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, stored] of [
      ['place', 'channel'],
      ['message', 'message'],
      ['reply', 'reply'],
      ['user', 'user'],
    ] as const) {
      const value = args?.[key];
      if (typeof value === 'string') out[stored] = value;
    }
    return out;
  }

  /**
   * What an inner turn's gate says of one call of hers (`inner`: the turn's `inner` parameter):
   * a read (its effect class) always runs; in shadow mode anything else is `proposed` and never
   * runs; a call on her `last` message where the turn holds a post is refused `held-message`; live, a stopped inner
   * life (`mayAct`, asked now) refuses it (`inner-stopped`). No count of posts refuses a call.
   * `public` says whether a call that runs is a public post.
   */
  function innerVerdict(
    inner: CallsInner,
    skill: string,
    { channel, args }: { channel: CallChannel; args: Obj | null | undefined }
  ): { proposed?: true; refusal?: CallRefusal; public?: boolean } | null {
    const effects = (skills ?? defaultSkills()).get(skill)?.effects ?? null;
    if (effects === 'read') return null;
    if (inner.shadow) return { proposed: true };
    // Her last message where a post of this turn is held is the held one: it has no id to act on yet.
    const where = typeof args?.place === 'string' ? args.place : String(channel.id);
    if (inner.hold && OWN_MESSAGE_SKILLS.includes(skill) && isLast(args?.message) && inner.hold.holdsIn(where))
      return { refusal: { code: CODE.HELD_MESSAGE, reason: 'held' } };
    if (typeof inner.mayAct === 'function' && !inner.mayAct())
      return { refusal: { code: CODE.INNER_STOPPED, reason: 'wakes' } };
    const isPublic = hasTrait(String(skill), 'posts') && (inRoot(channel) || typeof args?.place === 'string');
    return { public: isPublic };
  }

  /**
   * The planned call (planToolCall's) made, in its step, before her speech goes out: a refusal at the plan is
   * closed `failed` with its code (status `invalid` or `denied`, refusalStatus); otherwise the
   * gateway is asked again right before the call (the owner may have revoked it meanwhile), the
   * operation writes `started` with the ids it aims at, a destructive one is stamped for its
   * cooldown, and src/tools/executors.ts#executeCall runs it on the envelope through
   * `runOp` (`tools.callTimeoutMs`, read now); her written text (`message.create`,
   * `message.edit`) is rendered first exactly as a `<msg>` of this turn (renderPost over the
   * turn's `handles`, or `lines`, `knownNames`, `directory`, and `idByIndex`, `pulledIds`), its mentions the only members
   * notified. The operation closes `succeeded` (with the
   * message id), `unknown` (never retried) or `failed` with the code. A message or picture that reached another chat
   * stamps its lastPostAt, links its trigger, and a message is a `said` line of the record.
   * Logged `skills: called` (`skill`, `status`, `code`). Resolves the result with `skill`. Never throws.
   */
  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/turn.ts in stage 5b, a pure move
  async function runCall(
    plan: CallPlan,
    {
      channel,
      trigger,
      placeId,
      draft,
      dmChat = false,
      idByIndex = null,
      pulledIds = null,
      lines = [],
      knownNames = [],
      directory = null,
      handles = null,
      memberNames = null,
      channelHandles = null,
      timeoutMs = null,
      inTurn = null,
    }: CallContext
  ): Promise<CallOutcome> {
    const { call, op, envelope } = plan;
    const skill = call.skill;
    // The lines a memory.search quoted before this call: those it adds are the stored lines its result returned.
    const quotedBefore = new Set(searchRefsOf(draft)?.byNumber.keys() ?? []);
    // Her written text (message.create / message.edit) rendered as a `<msg>` of this turn is.
    let rendered: RenderedPost | null = null;
    const renderText = (text: string): RenderedPost =>
      (rendered = renderPost(text, {
        channel,
        snapshot: snapshotOfDraft(draft),
        placeId,
        dmChat,
        idByIndex,
        pulledIds,
        lines,
        knownNames,
        directory,
        handles,
        channelHandles,
        refs: draft?.frameRefs ?? null,
      }));
    let result: CallAnswer;
    // A refusal keeps its machine reason (a schema path, an option name): the call mark says why (outcomeDetail).
    const refusedWith = (refusal: CallRefusal): CallAnswer => ({
      status: refusalStatus(refusal.code),
      code: refusal.code,
      ...(refusal.reason ? { reason: refusal.reason } : {}),
      ...(refusal.values ? { values: refusal.values } : {}),
      // A place she named that is not one place: the places she may read, as data to call again with.
      ...(refusal.place
        ? { data: { text: placeChoicesText(refusal.place.match, hot.prompts?.labels, refusal.place.given) } }
        : {}),
    });
    // An inner turn (src/behavior/inner.ts): anything but a read is only proposed in shadow mode,
    // refused once the kill switch stopped it (asked right here, before the action), and a public
    // post past the day's cap is refused too.
    const inner = draft?.inner ?? null;
    const innerGate =
      inner && !plan.refusal ? innerVerdict(inner, skill, { channel, args: plan.resolved?.args ?? {} }) : null;
    // Whether the call was dispatched (its operation ran, whatever it answered).
    let ran = false;
    if (plan.refusal) result = refusedWith(plan.refusal);
    else if (innerGate?.proposed) result = { status: 'ok', code: CODE.SHADOW };
    else if (innerGate?.refusal) result = refusedWith(innerGate.refusal);
    else {
      // A plan without a refusal holds what its call resolved to (planToolCall).
      const resolvedCall = plan.resolved!;
      const verdict = checkCall(resolvedCall, { channel, envelope, draft });
      if (!verdict.ok) result = refusedWith(verdict);
      else {
        if (op.opId) await op.started({ target: callTarget(resolvedCall.args) });
        ran = true;
        // A destructive call counts from its dispatch, whatever comes back.
        if (resolvedCall.dispatch && (skills ?? defaultSkills()).get(skill)?.effects === 'destructive')
          destructiveRuns.set(`${skill}:${envelope.originChannelId}`, clock());
        const publicationBoundary = turnBoundary(draft, chatOf(channel));
        // An intention's text is stored: a `#n` in it becomes the identity of the line it named (src/turn/handles.ts).
        const text = resolvedCall.args?.text;
        const executed =
          STORED_TEXT_SKILLS.includes(skill) && typeof text === 'string' && draft?.handles
            ? { ...resolvedCall, args: { ...resolvedCall.args, text: draft.handles.canonical(text) } }
            : resolvedCall;
        const kept = procedureKept(draft, skill, executed.args);
        result =
          kept ??
          (await executeCall(executed, {
            publicationBoundary,
            port,
            here: chatOf(channel),
            refOf: (chatId) => chatOf({ id: String(chatId) }),
            renderText,
            envelope,
            ...(runOp ? { runOp } : {}),
            ...(runOwnOp ? { runOwnOp } : {}),
            ...(runInitiativeOp ? { runInitiativeOp } : {}),
            opContext: {
              publicationBoundary,
              // The place the call runs in (none for a turn that is nowhere); an operation on what the tree shares asks for
              // its top.
              placeId: draft?.nowhere === true ? null : placeOfChat(store, channel),
              ...(dmChat ? { dmChat: true } : {}),
              // A live wake turn's posts wait in its hold (src/tools/send-hold.ts).
              ...(inner?.hold ? { hold: inner.hold } : {}),
            },
            // The live config, for the wake envelope's check at the capabilities a skill reaches (src/tools/access.ts).
            config: hot.config,
            timeoutMs:
              typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
                ? timeoutMs
                : (hot.config.tools?.callTimeoutMs ?? 120000),
            // Her in-turn tools: run here, in the turn, over its context.
            ...(inTurn ? { inTurn } : {}),
          }));
        if (kept === null) keepProcedure(draft, skill, executed.args, result);
        // A post the hold kept goes out when the wake completes: she is told so, and it has no message yet.
        const key = envelope.idempotencyKey;
        if (result.status === 'ok' && inner?.hold && key && inner.hold.countUnder(key) > 0) {
          inner.hold.note(key, heldNoteOf(skill, resolvedCall, { dmChat, rendered }));
          result = { status: 'ok', code: CODE.HELD, data: { text: heldUntilEnd() } };
        }
      }
    }
    if (inner && draft) {
      // The intention a call of hers named, however it went: the open-intentions line of the next
      // step (openIntentionsText) no longer lists it; the action record carries it, and the state
      // an intention.update set (`done`, `pending`), for the feedback facts (src/behavior/inner.ts#feedbackFacts).
      const named = intentionNamed(skill, plan.resolved?.args ?? call.args ?? {});
      const resolvedArgs = plan.resolved?.args;
      const state = skill === 'intention.update' ? (resolvedArgs?.state ?? call.args?.state ?? null) : null;
      (draft.innerActions ??= []).push({
        skill,
        status: innerGate?.proposed ? 'proposed' : ran ? 'executed' : 'refused',
        result: result.status,
        ...(result.code ? { code: result.code } : {}),
        ...(result.status !== 'ok' ? callTextOf(result) : {}),
        target: callTarget(plan.resolved?.args ?? {}),
        ...(named ? { intentionId: named } : {}),
        ...(skill === 'intention.set' && ran && result.status === 'ok' && typeof result.intentionId === 'string'
          ? { createdId: result.intentionId }
          : {}),
        ...(typeof state === 'string' && state ? { state } : {}),
      });
      if (named) (draft.innerIntentIds ??= new Set()).add(named);
      // A proposed call never ran: the journal keeps its `proposed` line (marked shadow), no mark, no closing line.
      if (innerGate?.proposed) {
        log.info('skills: proposed', { channel: channel.id, skill, shadow: true });
        return { skill, ...result };
      }
    }
    // A lookup of hers stays for `<recall>`, and its closing line keeps it for a restart (src/memory/journal.ts#callMarksOf).
    const sourceIds = quotedSince(draft, quotedBefore);
    const lookup = keptLookup(skill, plan.resolved?.args ?? call.args ?? {}, result, draft, { trigger, sourceIds });
    const kept = lookup ? { lookup } : {};
    if (op.opId) {
      if (result.status === 'ok') await op.succeeded({ ...journalResultOf(result), ...kept });
      else if (result.status === 'unknown')
        await op.unknown({ code: result.code ?? null, ...valuesOf(result), ...kept });
      else
        await op.failed(result.code ?? CODE.ERROR, {
          status: result.status,
          ...(typeof result.reason === 'string' && result.reason ? { reason: result.reason } : {}),
          ...valuesOf(result),
          ...kept,
        });
    }
    const args: Obj = plan.resolved?.args ?? {};
    // A text that went out with its GIF failing (`partial`) was said all the same.
    const posted =
      (result.status === 'ok' || (result.status === 'partial' && result.code === CODE.GIF_FAILED)) &&
      hasTrait(skill, 'posts') &&
      result.ref
        ? postedOf(result)
        : null;
    // Every message the turn posted, its follow-up's included (act adds them as they go out).
    const turnPosts = draft ? (draft.ownPosts ??= []) : [];
    // A resolved call's `place` is an id the interface resolved (src/tools/executors.ts#resolveCall).
    const namedChannel = args.place as string | null | undefined;
    const where = posted ? String(result.ref?.chatId ?? namedChannel ?? channel.id) : null;
    if (posted && where !== null) {
      lastPostAt.set(where, clock());
      noteTrigger(posted.id, trigger?.id);
      if (!turnPosts.includes(posted.id)) turnPosts.push(posted.id);
      if (draft) (draft.deliveredIn ??= new Set()).add(where);
      if (where !== String(channel.id)) notePostedFrom(posted.id, String(channel.id));
      // A voice message a selfreflection turn posted through her operation: the post keeps its text as voiced and its length.
      if (skill === 'voice.say' && draft?.selfreflection && result.voice)
        draft.selfreflectionVoice = { text: result.voice.text, durationSecs: result.voice.durationSecs };
      // A voice message is a line of hers with no words of its own: what she voiced is its item's text form.
      if (skill === 'voice.say' && result.voice) {
        recordSaid({
          placeId,
          channel: { id: where },
          dmChat: false,
          trigger,
          draft,
          op,
          posted,
          text: '',
          replyId: null,
          repliedAuthorId: null,
          accountIds: [],
          voiced: typeof result.voice.text === 'string' ? result.voice.text : '',
        });
      }
      if (skill === 'message.create') {
        recordSaid({
          placeId,
          channel: { id: where },
          dmChat: false,
          trigger,
          draft,
          op,
          posted,
          text: args.text,
          // A resolved `reply` is a message id (src/tools/executors.ts#resolveCall).
          replyId: (args.reply as string | null | undefined) ?? null,
          repliedAuthorId: plan.resolved?.repliedAuthorId ?? null,
          // renderText sets it while the call runs; the compiler sees only its first value.
          accountIds: (rendered as RenderedPost | null)?.accountIds ?? [],
        });
      }
    }
    const idText = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
    // A shadow inner turn leaves no lasting mark on her transcript (nobody saw it); its calls that
    // did not work are marked for the rest of this turn only (`draft.turnMarks`), so she hears why
    // and may correct the call within the loop.
    const markCall = inner?.shadow && draft ? (mark: CallMark) => (draft.turnMarks ??= []).push(mark) : noteCall;
    markCall({
      placeId: String(channel.id),
      at: clock(),
      skill,
      status: result.status,
      // Why it did not work, when it did not (the mark words it through labels.transcript.callReasons;
      // without a specific phrase, the operation's own message before the generic one: one line,
      // MARK_TEXT_CHARS). In process only: the journal keeps the code and reason,
      // never that message.
      detail: outcomeDetail(result, {
        textChars: MARK_TEXT_CHARS,
        argNames: (skills ?? defaultSkills()).get(skill)?.dispatch?.options?.map((option) => option.name) ?? null,
      }),
      target: { messageId: idText(args.message) ?? idText(args.reply), placeId: where ?? idText(args.place) },
      // The place a lookup searched, when its arguments name one: the mark says it apart from where she called from.
      searched: (skills ?? defaultSkills()).get(skill)?.kind === 'read' ? idText(args.place) : null,
      postedId: posted?.id ?? null,
      posted: turnPosts,
      // The main arguments the call ran with, for the mark's line (src/tools/call-args.ts).
      args: callArgsText(skill, args),
    });
    log.info('skills: called', {
      channel: channel.id,
      skill,
      status: result.status,
      ...(result.code ? { code: result.code } : {}),
      ...(result.status !== 'ok' && result.error ? { error: portError(result) } : {}),
    });
    // A tag of hers that named a member without their handle went out as plain text: the result tells her, and the post stays ok.
    const note =
      result.status === 'ok' && WRITTEN_SKILLS.includes(skill)
        ? untaggedNote(
            typeof args.text === 'string' ? args.text : '',
            // renderText sets it while the call runs; the compiler sees only its first value.
            {
              handles,
              memberNames,
              // untaggedNote reads the ids as text, as renderPost hands them on.
              mentionedIds: ((rendered as RenderedPost | null)?.accountIds ?? []) as Array<string>,
            },
            hot.prompts?.labels
          )
        : '';
    // A post the interface kept for a chat that is not open: the result tells her it is shown when the chat opens.
    const notes = [note, result.status === 'ok' && result.deferred === true ? storedUntilOpen() : ''].filter(Boolean);
    return { skill, ...result, ...(notes.length > 0 ? { note: notes.join('\n') } : {}) };
  }

  /**
   * The planned calls of one step made (runCall over `context`), in segments (src/behavior/tool-step.ts#segments): a
   * run of consecutive reads together, every other call, a refusal included, alone, in her written order. Resolves the
   * results in the order of `plans`, one for each. The first result of the turn that a model role's route moved carries
   * the route line (turnRoutes).
   */
  async function runCalls(plans: ReadonlyArray<CallPlan>, context: CallContext): Promise<Array<CallOutcome>> {
    const results = new Array<CallOutcome>(plans.length);
    const reads = (plan: CallPlan): boolean =>
      Boolean(plan.resolved) && (skills ?? defaultSkills()).get(plan.call.skill)?.kind === 'read';
    let at = 0;
    // segments (src/behavior/tool-step.ts) hands back the plans it was given, in segments.
    for (const segment of segments(plans as Array<object>, reads as (call: object) => boolean)) {
      const made = await Promise.all((segment.calls as Array<CallPlan>).map((plan) => runCall(plan, context)));
      made.forEach((result, i) => {
        results[at + i] = result;
      });
      at += segment.calls.length;
    }
    return routes.tell(results, context);
  }

  /**
   * The intention one call of an inner turn names: `args.id` of `intention.update` / `intention.cancel`,
   * or its body (`args.text`) when that is the id alone (src/tools/operations/intention.ts takes it the same way);
   * null for any other call.
   */
  function intentionNamed(skill: string, args: Obj | null | undefined): string | null {
    if (!INTENT_ID_SKILLS.includes(skill)) return null;
    const id =
      typeof args?.id === 'string' && args.id.trim()
        ? args.id.trim()
        : isIntentionId(args?.text)
          ? String(args?.text).trim()
          : null;
    return id;
  }

  return { callView, planToolCall, innerVerdict, runCall, runCalls, intentionNamed };
}
