// Her skill calls in a turn: what a call is resolved against, the gateway's check, the plan of one call before its
// step does anything, an inner turn's gate, and the call made with its journal lines, marks and notes; a step's
// planned calls made in segments. createTurnRunner (src/behavior/turn.ts) builds it once per runner with
// createSkillCalls; the tool round and the attempt call its functions.

import type { Conversation } from '../protocol/events.ts';
import { turnBoundary } from '../tools/publication.ts';
import type { ConversationRef } from '../protocol/adapter.ts';
import { placeOfConversation } from '../memory/addresses.ts';
import type { Context } from '../memory/db/scope.ts';
import { DESTINATION_REQUIRED } from '../behavior/inner-output.ts';
import { POSTING_SKILLS } from '../behavior/inner.ts';
import type { Snapshot } from '../behavior/snapshot.ts';
import type { TurnRoutes } from '../behavior/turn-ability-route.ts';
import { segments } from '../behavior/tool-step.ts';
import { isIntentionId } from '../intentions/model.ts';
import { log } from '../log.ts';
import { callArgsText } from '../tools/call-args.ts';
import { CODE } from '../tools/codes.ts';
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
import type { CallEnvelope, Lookup, LookupRing, SearchRefs } from './calls.ts';
import { clampWithEllipsis } from '../memory/clamp.ts';
import { journalResultOf, portError, postedOf } from './journal.ts';
import type { JournalOp } from './journal.ts';
import type { CallMark, JournalNotes, NotesDraft } from './journal-notes.ts';
import { untaggedNote } from './mentions.ts';
import { inCommunity, snapshotOfDraft } from './routing.ts';
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
    privateChannelId: string | null;
  }) => ReturnType<NonNullable<CallView['fileOf']>>;
  budget: (args: { agent: unknown }) => unknown;
} | null;

/** What createSkillCalls reads: the dependencies, the runner's state and the functions of the other topic modules. */
export type SkillCallsContext = {
  hot: { readonly config: CallsConfig; readonly prompts: { labels?: CallsLabels } | null | undefined };
  store: Parameters<typeof callViewOf>[0]['store'];
  /** The learned stemmer, read at the moment of use; null while no memory is open (src/memory/db/stems.ts#loadStemmer). */
  stemmer?: () => { stem: (word: string) => string } | null;
  skills: SkillMap | null;
  selfIdOf: () => string;
  clock: () => number;
  iface: CallsPort;
  conversationOf: (channel: { id: string }) => ConversationRef;
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

/** Whether a message argument is `last`, her own most recent message (any case, as src/tools/impl/message.ts reads it). */
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
type CallChannel = Pick<Conversation, 'id' | 'rootId'> & { name?: unknown };

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
  ref?: { conversationId?: string; messageId?: string } | null;
  values?: unknown;
  voice?: { text: unknown; durationSecs: unknown } | null;
  intentionId?: unknown;
  error?: { code?: string; cause?: unknown } | null;
  note?: string;
};

/** A call's result with its skill. */
export type CallOutcome = CallAnswer & { skill: string };

type RenderArgs = Parameters<Sends['renderPost']>[1];

/** Where a call is made: the turn's context, as runCall reads it. */
export type CallContext = {
  channel: CallChannel;
  trigger: { id?: string; authorId?: string | null } | null | undefined;
  placeId: string;
  draft: CallsDraft | null;
  privateChat?: boolean;
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
    skills,
    selfIdOf,
    clock,
    iface: port,
    conversationOf,
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
  }: Parameters<SkillCalls['callView']>[0]): CallView {
    const fileOf =
      typeof errands?.fileOf === 'function'
        ? (handle: string) =>
            // Checked just above; the closure cannot see the check.
            errands.fileOf!({ placeId, handle, privateChannelId: inCommunity(channel) ? null : String(channel.id) })
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
      audience: { conversationId: String(channel.id) },
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
   * unknown, cut off, past the step's cap), the wake's rule (src/tools/wake-tools.ts), `refuse` (an inner tag that cannot act), an inner turn's
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
    // A wake's own set: a call outside it, and a task answer outside the selfimprovement wake, are refused before resolution.
    const wakeKind = wakeOf(draft)?.kind ?? null;
    const wakeRefusal = wakeRefusalCode(wakeKind, call.skill);
    if (wakeRefusal !== null) {
      const reason = `${String(wakeKind ?? 'selfimprovement')}:only`;
      log.info('skill: refused', { skill: call.skill, code: wakeRefusal, reason, channel: channel.id });
      log.info(`${String(wakeKind ?? 'selfimprovement')}: call refused`, { skill: call.skill, code: wakeRefusal });
      return { call, op, envelope, resolved: null, refusal: { code: wakeRefusal, reason } };
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
    // An inner turn's picture lands in its current channel, as its speech does; with none, there is nowhere to post it.
    if (
      draft?.inner &&
      (call.skill === 'draw.create' || call.skill === 'voice.say') &&
      typeof call.args?.channel !== 'string'
    ) {
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
    { privateChat, rendered }: { privateChat: boolean; rendered: RenderedPost | null }
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
    return { skill, privateChat, said };
  }

  /** The ids a resolved call aims at (its channel, message, reply target, member), for its journal line: never its text. */
  function callTarget(args: Obj | null | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of ['channel', 'message', 'reply', 'user']) {
      const value = args?.[key];
      if (typeof value === 'string') out[key] = value;
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
    const where = typeof args?.channel === 'string' ? args.channel : String(channel.id);
    if (inner.hold && OWN_MESSAGE_SKILLS.includes(skill) && isLast(args?.message) && inner.hold.holdsIn(where))
      return { refusal: { code: CODE.HELD_MESSAGE, reason: 'held' } };
    if (typeof inner.mayAct === 'function' && !inner.mayAct())
      return { refusal: { code: CODE.INNER_STOPPED, reason: 'wakes' } };
    const isPublic =
      POSTING_SKILLS.includes(String(skill)) && (inCommunity(channel) || typeof args?.channel === 'string');
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
   * message id), `unknown` (never retried) or `failed` with the code. A message or picture that reached another conversation
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
      privateChat = false,
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
        privateChat,
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
        const publicationBoundary = turnBoundary(draft, conversationOf(channel));
        // An intention's text is stored: a `#n` in it becomes the identity of the line it named (src/turn/handles.ts).
        const text = resolvedCall.args?.text;
        const executed =
          STORED_TEXT_SKILLS.includes(skill) && typeof text === 'string' && draft?.handles
            ? { ...resolvedCall, args: { ...resolvedCall.args, text: draft.handles.canonical(text) } }
            : resolvedCall;
        result = await executeCall(executed, {
          publicationBoundary,
          port,
          here: conversationOf(channel),
          refOf: (conversationId) => conversationOf({ id: String(conversationId) }),
          renderText,
          envelope,
          ...(runOp ? { runOp } : {}),
          ...(runOwnOp ? { runOwnOp } : {}),
          ...(runInitiativeOp ? { runInitiativeOp } : {}),
          opContext: {
            publicationBoundary,
            // The place the call runs in; an operation on what the tree shares asks for its top.
            placeId: placeOfConversation(store, channel),
            ...(privateChat ? { privateChat: true } : {}),
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
        });
        // A post the hold kept goes out when the wake completes: she is told so, and it has no message yet.
        const key = envelope.idempotencyKey;
        if (result.status === 'ok' && inner?.hold && key && inner.hold.countUnder(key) > 0) {
          inner.hold.note(key, heldNoteOf(skill, resolvedCall, { privateChat, rendered }));
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
      (skill === 'message.create' || skill === 'draw.create' || skill === 'voice.say') &&
      result.ref
        ? postedOf(result)
        : null;
    // Every message the turn posted, its follow-up's included (act adds them as they go out).
    const turnPosts = draft ? (draft.ownPosts ??= []) : [];
    // A resolved call's `channel` is an id the server resolved (src/tools/executors.ts#resolveCall).
    const namedChannel = args.channel as string | null | undefined;
    const where = posted ? String(result.ref?.conversationId ?? namedChannel ?? channel.id) : null;
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
          privateChat: false,
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
          privateChat: false,
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
      target: { messageId: idText(args.message) ?? idText(args.reply), placeId: where ?? idText(args.channel) },
      // The place a lookup searched, when its arguments name one: the mark says it apart from where she called from.
      searched: (skills ?? defaultSkills()).get(skill)?.kind === 'read' ? idText(args.channel) : null,
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
    return { skill, ...result, ...(note ? { note } : {}) };
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
   * or its body (`args.text`) when that is the id alone (src/tools/impl/intention.ts takes it the same way);
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
