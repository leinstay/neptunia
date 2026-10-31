// Her skill calls in a turn: what a call is resolved against, the gateway's check, the plan of one call before its
// step does anything, an inner turn's gate, and the call made with its journal lines, marks and notes; a step's
// planned calls made in segments. createTurnRunner (src/behavior/turn.js) builds it once per runner with
// createSkillCalls; the tool round and the attempt call its functions.

import { DESTINATION_REQUIRED } from '../behavior/inner-output.js';
import { POSTING_SKILLS, innerSettings } from '../behavior/inner.ts';
import type { Snapshot } from '../behavior/snapshot.ts';
import type { TurnRoutes } from '../behavior/turn-ability-route.ts';
import { segments } from '../behavior/tool-step.js';
import { isIntentionId } from '../intentions/model.ts';
import { log } from '../log.js';
import { callArgsText } from '../tools/call-args.ts';
import { CODE } from '../tools/codes.ts';
import { executeCall, outcomeDetail, refusalStatus, resolveCall } from '../tools/executors.ts';
import type { CallResult, CallView, ExecuteDeps, Resolved, RunOperation } from '../tools/executors.ts';
import { checkSkill } from '../tools/gateway.ts';
import type { GateContext } from '../tools/gateway.ts';
import type { Obj, SkillMap } from '../tools/types.ts';
import { PERSONA, WRITTEN_SKILLS, callTextOf, callViewOf, defaultSkills, valuesOf } from './calls.ts';
import type { CallEnvelope } from './calls.ts';
import { journalResultOf, portError, postedOf } from './journal.ts';
import type { JournalOp } from './journal.ts';
import type { CallMark, JournalNotes } from './journal-notes.ts';
import { untaggedNote } from './mentions.ts';
import { inCommunity, snapshotOfDraft } from './routing.ts';
import type { RenderedPost, Sends } from './sends.ts';
import { HEARTBEAT_INTENT_SKILLS, HEARTBEAT_READ_SKILLS, INTENT_ID_SKILLS } from './settings.ts';

/** The live config, as far as the calls read it; the gateway and the executors read their own sections. */
export type CallsConfig = { tools?: { callTimeoutMs?: number; markTextMaxChars?: number } | null };

type CallsLabels = Parameters<typeof untaggedNote>[2];

/** The interface port (src/interface/port.js), as a call posts through it. */
type CallsPort = ExecuteDeps['port'] & { iface: string };

/** The errands service (src/errands/service.ts), as far as a call reads its files and budgets. */
type CallsErrands = {
  fileOf?: (args: {
    guildId: string | null;
    handle: string;
    privateChannelId: string | null;
  }) => ReturnType<NonNullable<CallView['fileOf']>>;
  budget: (args: { guildId: string | null; agent: unknown }) => unknown;
} | null;

/** What createSkillCalls reads: the dependencies, the runner's state and the functions of the other topic modules. */
export type SkillCallsContext = {
  hot: { readonly config: CallsConfig; readonly prompts: { labels?: CallsLabels } | null | undefined };
  store: Parameters<typeof callViewOf>[0]['store'];
  skills: SkillMap | null;
  selfIdOf: () => string;
  clock: () => number;
  iface: CallsPort;
  images: GateContext['images'] | undefined;
  speech: GateContext['speech'] | null;
  errands: CallsErrands;
  runOp: RunOperation | null;
  runOwnOp: RunOperation | null;
  runInitiativeOp: RunOperation | null;
  routes: TurnRoutes;
  lastPostAt: Map<string, number>;
  renderPost: Sends['renderPost'];
  noteSeen: JournalNotes['noteSeen'];
  noteTrigger: JournalNotes['noteTrigger'];
  notePostedFrom: JournalNotes['notePostedFrom'];
  noteLineSources: JournalNotes['noteLineSources'];
  noteCall: JournalNotes['noteCall'];
  recordSaid: JournalNotes['recordSaid'];
  journalOp: JournalNotes['journalOp'];
};

/** Why a call cannot run: its code, a machine reason and the values its label names. */
export type CallRefusal = { code: string; reason?: string; values?: unknown };

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
};

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
  NonNullable<Parameters<JournalNotes['noteLineSources']>[0]> & {
    inner?: CallsInner | null;
    ownInitiative?: boolean;
    innerActions?: Array<InnerAction>;
    innerIntentIds?: Set<string>;
    ownPosts?: Array<string | null>;
    deliveredIn?: Set<string>;
    diary?: unknown;
    diaryVoice?: { text: unknown; durationSecs: unknown };
    turnMarks?: Array<CallMark>;
    snapshot?: Snapshot | null;
  };

/** The channel a call is made from. */
type CallChannel = { id: string; communityId?: string | null; name?: unknown };

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
  guildId: string;
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
    guildId: string;
    idByIndex: ViewArgs['idByIndex'];
    lines: ViewArgs['lines'];
    pulledIds: ViewArgs['pulledIds'];
    memoryOn: boolean;
    channelHandles?: unknown;
    memberHandles?: unknown;
    trigger?: { content?: unknown } | null;
    deletedIds?: unknown;
    searchRefs?: ViewArgs['searchRefs'];
  }) => CallView;
  planToolCall: (args: {
    call: PlannedCall;
    channel: CallChannel;
    envelope: CallEnvelope;
    draft: CallsDraft | null;
    view: CallView;
  }) => Promise<CallPlan>;
  heartbeatOnly: (draft: CallsDraft | null | undefined) => boolean;
  heartbeatChanged: (
    draft: CallsDraft | null | undefined,
    results: ReadonlyArray<{ status: string; skill: string }>
  ) => boolean;
  innerVerdict: (
    inner: CallsInner,
    skill: string,
    at: { channel: CallChannel; args: Obj | null | undefined }
  ) => { proposed?: true; refusal?: CallRefusal; public?: boolean } | null;
  runCall: (plan: CallPlan, context: CallContext) => Promise<CallOutcome>;
  runCalls: (plans: ReadonlyArray<CallPlan>, context: CallContext) => Promise<Array<CallOutcome>>;
  intentionNamed: (skill: string, args: Obj | null | undefined) => string | null;
};

// health: allow function-length until 2027-04-01 -- the calls share the runner state of src/behavior/turn.js, moved whole in stage 5b
export function createSkillCalls(ctx: SkillCallsContext): SkillCalls {
  const {
    hot,
    store,
    skills,
    selfIdOf,
    clock,
    iface,
    images,
    speech,
    errands,
    runOp,
    runOwnOp,
    runInitiativeOp,
    routes,
    lastPostAt,
    renderPost,
    noteSeen,
    noteTrigger,
    notePostedFrom,
    noteLineSources,
    noteCall,
    recordSaid,
    journalOp,
  } = ctx;

  // `${skill}:${originChannelId}` -> when a destructive skill call of hers was last dispatched
  // from that channel (tools.destructiveCooldownMinutes, src/tools/gateway.ts); in process.
  const destructiveRuns = new Map<string, number>();

  /** What a `<call>` of the persona is resolved against: callViewOf over this runner's store, id and registry. */
  function callView({
    channel,
    snapshot = null,
    guildId,
    idByIndex,
    lines,
    pulledIds,
    memoryOn,
    channelHandles = null,
    memberHandles = null,
    trigger = null,
    deletedIds = null,
    searchRefs = null,
  }: Parameters<SkillCalls['callView']>[0]): CallView {
    const fileOf =
      typeof errands?.fileOf === 'function'
        ? (handle: string) =>
            // Checked just above; the closure cannot see the check.
            errands.fileOf!({ guildId, handle, privateChannelId: inCommunity(channel) ? null : String(channel.id) })
        : null;
    return callViewOf({
      channel,
      snapshot,
      guildId,
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
        // An inner turn's wake envelope (innerLife.wakes.<kind>): its wake kind and the calls it made so far.
        ...(draft?.inner?.wake?.kind
          ? { wakeKind: String(draft.inner.wake.kind), wakeActions: draft.innerActions ?? [] }
          : {}),
        lastRunAt: destructiveRuns.get(`${resolved.skill}:${envelope.originChannelId}`) ?? null,
        now: clock(),
        ...(images ? { images } : {}),
        ...(speech ? { speech } : {}),
        // An errand's caps are its budget (src/errands/service.ts#budget), in the turn's guild.
        ...(errands
          ? { tasks: { budget: (agent: unknown) => errands.budget({ guildId: channel.communityId ?? null, agent }) } }
          : {}),
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
   * unknown, cut off, past the step's cap), the heartbeat rule, `refuse` (an inner tag that cannot act), an inner turn's
   * destination for a picture --, resolved on the server's side (`view`: callView's) and checked (checkCall). Resolves
   * `{ call, op, envelope, resolved, refusal }`: `resolved` null and `refusal` (`{ code, reason }`) when anything said
   * no -- logged `skill: refused`. Nothing runs here.
   */
  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/turn.js in stage 5b, a pure move
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
    // A heartbeat may inspect memory before changing an intention; other calls are refused before resolution.
    if (
      heartbeatOnly(draft) &&
      !HEARTBEAT_INTENT_SKILLS.includes(call.skill) &&
      !HEARTBEAT_READ_SKILLS.includes(call.skill)
    ) {
      log.info('skill: refused', {
        skill: call.skill,
        code: CODE.HEARTBEAT_ONLY,
        reason: 'heartbeat:only',
        channel: channel.id,
      });
      log.info('heartbeat: call refused', { skill: call.skill, code: CODE.HEARTBEAT_ONLY });
      return { call, op, envelope, resolved: null, refusal: { code: CODE.HEARTBEAT_ONLY, reason: 'heartbeat:only' } };
    }
    // An inner turn's tag that cannot act (src/behavior/inner-output.js): refused before anything is resolved or done.
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
      return { call, op, envelope, resolved: null, refusal: { code: resolved.code, reason: resolved.reason } };
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

  /** Whether this turn is a heartbeat held to intention changes only (`innerLife.heartbeat.intentionsOnly`, read now). */
  function heartbeatOnly(draft: CallsDraft | null | undefined): boolean {
    return draft?.inner?.wake?.kind === 'heartbeat' && innerSettings(hot.config).heartbeat.intentionsOnly === true;
  }

  /**
   * Whether `results` (the calls of one step) hold the intention change that ends a heartbeat turn held to
   * intention changes only: an intent call that went through. Nothing is asked of the model after it.
   */
  function heartbeatChanged(
    draft: CallsDraft | null | undefined,
    results: ReadonlyArray<{ status: string; skill: string }>
  ): boolean {
    return (
      heartbeatOnly(draft) &&
      results.some((result) => result.status === 'ok' && HEARTBEAT_INTENT_SKILLS.includes(result.skill))
    );
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
   * runs; live, a stopped inner life (`mayAct`, asked now) refuses it (`inner-stopped`). No count of posts refuses a call.
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
    if (typeof inner.mayAct === 'function' && !inner.mayAct())
      return { refusal: { code: CODE.INNER_STOPPED, reason: 'innerLife' } };
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
  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/turn.js in stage 5b, a pure move
  async function runCall(
    plan: CallPlan,
    {
      channel,
      trigger,
      guildId,
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
    // Her written text (message.create / message.edit) rendered as a `<msg>` of this turn is.
    let rendered: RenderedPost | null = null;
    const renderText = (text: string): RenderedPost =>
      (rendered = renderPost(text, {
        channel,
        snapshot: snapshotOfDraft(draft),
        guildId,
        privateChat,
        idByIndex,
        pulledIds,
        lines,
        knownNames,
        directory,
        handles,
        channelHandles,
      }));
    let result: CallAnswer;
    // A refusal keeps its machine reason (a schema path, an option name): the call mark says why (outcomeDetail).
    const refusedWith = (refusal: CallRefusal): CallAnswer => ({
      status: refusalStatus(refusal.code),
      code: refusal.code,
      ...(refusal.reason ? { reason: refusal.reason } : {}),
      ...(refusal.values ? { values: refusal.values } : {}),
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
        result = await executeCall(resolvedCall, {
          port: iface,
          refOf: (conversationId) => ({ iface: iface.iface, conversationId: String(conversationId) }),
          renderText,
          envelope,
          ...(runOp ? { runOp } : {}),
          ...(runOwnOp ? { runOwnOp } : {}),
          ...(runInitiativeOp ? { runInitiativeOp } : {}),
          opContext: { guildId, channelId: String(channel.id), ...(privateChat ? { privateChat: true } : {}) },
          // The live config, for the wake envelope's check at the capabilities a skill reaches (src/tools/access.ts).
          config: hot.config,
          timeoutMs:
            typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
              ? timeoutMs
              : (hot.config.tools?.callTimeoutMs ?? 120000),
          // Her in-turn tools (features.coreTools): run here, in the turn, over its context.
          ...(inTurn ? { inTurn } : {}),
        });
      }
    }
    // What a read of hers returned is outside material her later lines of the turn may repeat.
    if (
      ran &&
      result.status === 'ok' &&
      typeof result.data?.text === 'string' &&
      result.data.text &&
      (skills ?? defaultSkills()).get(skill)?.effects === 'read'
    )
      noteSeen(draft, result.data.text, { read: true });
    if (inner && draft) {
      // The intention a call of hers named, however it went: the open-intentions line of the next
      // step (openIntentionsText) no longer lists it; the action record carries it, and the state
      // an intention.update set (`done`, `pending`), for the feedback facts (src/behavior/inner.ts#feedbackFacts).
      const named = intentionNamed(skill, plan.resolved?.args ?? call.args ?? {});
      const state = skill === 'intention.update' ? (plan.resolved?.args?.state ?? call.args?.state ?? null) : null;
      (draft.innerActions ??= []).push({
        skill,
        status: innerGate?.proposed ? 'proposed' : ran ? 'executed' : 'refused',
        result: result.status,
        ...(result.code ? { code: result.code } : {}),
        ...(result.status !== 'ok' ? callTextOf(result, hot.config.tools?.markTextMaxChars ?? 200) : {}),
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
    if (op.opId) {
      if (result.status === 'ok') await op.succeeded(journalResultOf(result));
      else if (result.status === 'unknown') await op.unknown({ code: result.code ?? null, ...valuesOf(result) });
      else
        await op.failed(result.code ?? CODE.ERROR, {
          status: result.status,
          ...(typeof result.reason === 'string' && result.reason ? { reason: result.reason } : {}),
          ...valuesOf(result),
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
      // A voice message a diary turn posted through her operation: the post keeps its text as voiced and its length.
      if (skill === 'voice.say' && draft?.diary && result.voice)
        draft.diaryVoice = { text: result.voice.text, durationSecs: result.voice.durationSecs };
      if (skill === 'message.create') {
        // A posted message.create carries the text it was resolved with.
        noteLineSources(draft, posted.id, args.text as string);
        recordSaid({
          guildId,
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
          userIds: (rendered as RenderedPost | null)?.userIds ?? [],
        });
      }
    }
    const idText = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
    // A shadow inner turn leaves no lasting mark on her transcript (nobody saw it); its calls that
    // did not work are marked for the rest of this turn only (`draft.turnMarks`), so she hears why
    // and may correct the call within the loop.
    const markCall = inner?.shadow && draft ? (mark: CallMark) => (draft.turnMarks ??= []).push(mark) : noteCall;
    markCall({
      channelId: String(channel.id),
      at: clock(),
      skill,
      status: result.status,
      // Why it did not work, when it did not (the mark words it through labels.transcript.callReasons;
      // without a specific phrase, the operation's own message before the generic one: one line,
      // tools.markTextMaxChars, read now). In process only: the journal keeps the code and reason,
      // never that message.
      detail: outcomeDetail(result, {
        textChars: hot.config.tools?.markTextMaxChars ?? 200,
        argNames: (skills ?? defaultSkills()).get(skill)?.dispatch?.options?.map((option) => option.name) ?? null,
      }),
      target: { messageId: idText(args.message) ?? idText(args.reply), channelId: where ?? idText(args.channel) },
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
              mentionedIds: ((rendered as RenderedPost | null)?.userIds ?? []) as Array<string>,
            },
            hot.prompts?.labels
          )
        : '';
    return { skill, ...result, ...(note ? { note } : {}) };
  }

  /**
   * The planned calls of one step made (runCall over `context`), in segments (src/behavior/tool-step.js#segments): a
   * run of consecutive reads together, every other call, a refusal included, alone, in her written order. Resolves the
   * results in the order of `plans`, one for each. The first result of the turn that a model role's route moved carries
   * the route line (turnRoutes).
   */
  async function runCalls(plans: ReadonlyArray<CallPlan>, context: CallContext): Promise<Array<CallOutcome>> {
    const results = new Array<CallOutcome>(plans.length);
    const reads = (plan: CallPlan): boolean =>
      Boolean(plan.resolved) && (skills ?? defaultSkills()).get(plan.call.skill)?.kind === 'read';
    let at = 0;
    // segments (src/behavior/tool-step.js) hands back the plans it was given, in segments.
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

  return { callView, planToolCall, heartbeatOnly, heartbeatChanged, innerVerdict, runCall, runCalls, intentionNamed };
}
