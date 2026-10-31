// The steps of a turn: her answer's calls planned and made, her speech posted or held, and one more request while
// something is left to read and room is left; the history a turn reads, the think it keeps, the transcript of a step's
// note and the open intentions of an inner turn. createTurnRunner (src/behavior/turn.js) builds it once per runner with
// createToolRound; the attempt calls its functions.

import { setSettings } from '../behavior/diary.ts';
import { historyLines } from '../behavior/lines.ts';
import type { Line, ReactorNames } from '../behavior/lines.ts';
import { skillsInventoryText } from '../behavior/prompt.js';
import type { ReactorStore } from '../behavior/reactor-store.ts';
import { appendStep, cutToFit, deltaLines, roomLeft, stepNote, stepVerdict } from '../behavior/tool-step.js';
import { innerSettings } from '../behavior/inner.ts';
import { diagnosticText } from '../behavior/wake.ts';
import { WAKE_PURPOSE_CHARS } from '../behavior/wake.ts';
import { callReason, fill, formatTranscript } from '../format.js';
import type { Reads } from '../interface/reads.ts';
import { requestTokenLimit } from '../llm/budget.js';
import { REPLY_REQUEST } from '../llm/openrouter.js';
import { estimateMessages, estimateTools } from '../llm/tokens.js';
import { log } from '../log.js';
import { clampWithEllipsis, oneLine } from '../memory/clamp.js';
import type { ConversationRef } from '../protocol/adapter.ts';
import { CODE } from '../tools/codes.ts';
import { linksOfCalls, outcomeDetail } from '../tools/executors.ts';
import type { CallView } from '../tools/executors.ts';
import { coerceArgs, coversSpeech, toolResultText } from '../tools/tool-calls.ts';
import type { NormalCall } from '../tools/tool-calls.ts';
import type { Obj, SkillMap } from '../tools/types.ts';
import type { Act, ActArgs, ActOutcome, HeldSpeech, HoldArgs } from './act.ts';
import { CALL_STATUS_NAMES, callTextOf, defaultSkills, ifaceOption, searchHandles, speechItemsOf } from './calls.ts';
import type { CallEnvelope, SearchRefs } from './calls.ts';
import { cutOffOf, untoldDiagnostics } from './journal.ts';
import type { JournalNotes } from './journal-notes.ts';
import { snapshotOfDraft } from './routing.ts';
import {
  INNER_TERMINAL_SKILLS,
  HEARTBEAT_INTENT_SKILLS,
  LOOP_MIN_CALL_MS,
  LOOP_WHY,
  loopSettings,
} from './settings.ts';
import { resultCharsFor } from './settings.ts';
import type {
  CallContext,
  CallOutcome,
  CallPlan,
  CallRefusal,
  CallsDraft,
  PlannedCall,
  SkillCalls,
} from './skill-calls.ts';
import type { TriggerKind } from './triggers.ts';
import type { Typing } from './typing.ts';

/** The live config, as far as the tool round reads it; the settings functions read their own sections. */
export type ToolRoundConfig = Parameters<typeof resultCharsFor>[1] & {
  tools?: { callTimeoutMs?: number; markTextMaxChars?: number; resultMaxChars?: number } | null;
  bot?: { timezone?: string } | null;
  context: {
    channelMessages: number;
    reactions?: { fetchTimeoutMs?: number; fetchUsers?: number } | null;
    gapMarkerMinutes: number;
    maxMessageChars: number;
    ageAfterMinutes?: number;
    reactionsPerMessage?: number;
    replyQuoteChars?: number;
  };
  features?: { reactionNames?: unknown; seeReactions?: unknown } | null;
  diary?: unknown;
};

/** The labels, as the tool round hands them on; the text functions read their own sections. */
type RoundLabels = { task?: { continueInnerOpen?: unknown } | null; [key: string]: unknown };

/** A completion of the language model client (src/llm/openrouter.js#createLlm), as a step reads it. */
export type StepCompletion = NonNullable<Parameters<typeof cutOffOf>[0]> & {
  text?: unknown;
  toolCalls?: unknown;
  usage?: unknown;
};

/** The language model client (src/llm/openrouter.js#createLlm), as a step's follow-up request uses it. */
type RoundLlm = { complete: (messages: Array<object>, options: object) => Promise<StepCompletion> };

/** The calibrator of the token estimate (src/llm/calibrate.js), as the room of a request is judged. */
type Calibrator = { apply: (estimate: number) => number; ratio: number };

/** What createToolRound reads: the dependencies and the functions of the other topic modules it calls. */
export type ToolRoundContext = {
  hot: { readonly config: ToolRoundConfig; readonly prompts: { labels?: RoundLabels } | null | undefined };
  llm: RoundLlm;
  calibrator: Calibrator;
  clock: () => number;
  skills: SkillMap | null;
  ifaceReads: Reads;
  reactors: ReactorStore | null;
  memberOf: (communityId: string, memberId: string) => { name: string; bot: boolean } | null;
  selfIdOf: () => string;
  conversationOf: (channel: { id: string }) => ConversationRef;
  callView: SkillCalls['callView'];
  planToolCall: SkillCalls['planToolCall'];
  heartbeatOnly: SkillCalls['heartbeatOnly'];
  heartbeatChanged: SkillCalls['heartbeatChanged'];
  runCalls: SkillCalls['runCalls'];
  typingWhileCalls: Typing['typingWhileCalls'];
  holdSpeech: Act['holdSpeech'];
  act: Act['act'];
  dumpTurnRequest: JournalNotes['dumpTurnRequest'];
};

/** A line of a turn's history, as the steps number and keep it. */
type StepLine = {
  id?: string;
  ts?: unknown;
  self?: boolean;
  authorId?: string;
  authorName?: string | null;
  [key: string]: unknown;
};

/** A diary set's picture as the turn staged it. */
type StagedPicture = { picture: Obj; self: unknown; text: string };

/** The counts of what a turn's answers looked like, for its turn record. */
type FormatCounts = {
  thinkMissing: number;
  coerced: number;
  malformed: number;
  truncated: number;
  capped: number;
  held: number;
};

/** What an attempt's draft holds that the steps read and write. */
export type ToolRoundDraft = CallsDraft & {
  info?: { iface?: string } | null;
  inner?: {
    wake?: {
      items?: unknown;
      intentions?: unknown;
    } | null;
  } | null;
  diary?: { set?: unknown } | null;
  staged?: Array<StagedPicture>;
  tools: Array<object>;
  deletedIds?: unknown;
  searchRefs?: SearchRefs;
  handleFloor?: number | null;
  deltaTaken?: number;
  format: FormatCounts;
  held?: { step: number; items: number };
  limits?: { add: (limit: { kind: string; where: string; lost?: number; detail?: string }) => void } | null;
  loopCut?: { reason: string; dropped: number };
  steps?: number;
  loopSeen?: Array<StepLine>;
  diagnostics?: Array<{ told?: boolean }>;
  unseenFailed?: Array<object>;
  innerLoop?: { steps: number; cut: string | null; droppedCalls: number };
  innerOpenFollowUp?: boolean;
  setShort?: number;
  reactorNames?: Map<string, { name: string; bot: boolean } | null>;
  lastThink?: string | null;
  finalThink?: string | null;
};

/** What her answer said once parsed: her speech, and an inner turn's tags lowered into the calls they stand for. */
export type StepParsed = ActArgs['parsed'] &
  HoldArgs['parsed'] & {
    loweredCalls?: Array<PlannedCall>;
    skip?: unknown;
    thinkOpen?: unknown;
    untagged?: unknown;
  };

/** One answer of hers read: split into speech and calls (answerOf), the speech parsed. */
export type StepAnswer = { rawText: string; calls: Array<NormalCall>; parsed: StepParsed };

/** What a step's request numbers: its lines, where a `#N` of hers resolves. */
type Routing = {
  idByIndex: Map<number, string>;
  history: Array<StepLine>;
  lines: Array<StepLine>;
  pulledIds: ReadonlyMap<string, string> | null;
  handles?: Map<string, string> | null;
  memberNames?: Map<string, Array<string>> | null;
  channelHandles?: unknown;
};

type Routed = 'idByIndex' | 'history' | 'lines' | 'pulledIds' | 'handles' | 'channelHandles' | 'parsed' | 'set';

/** The arguments of the act and the held speech that a step's speech does not set itself. */
type StepActArgs = Omit<ActArgs, Routed> & Omit<HoldArgs, Routed>;

export type RunStepsArgs = {
  channel: CallContext['channel'];
  guildId: string;
  trigger: (CallContext['trigger'] & { content?: unknown }) | null | undefined;
  draft: ToolRoundDraft;
  transport: 'native' | 'text';
  messages: Array<object>;
  first: StepAnswer;
  readAnswer: (completion: StepCompletion, number: number) => StepAnswer;
  actArgs: StepActArgs;
  callContext: CallContext;
  envelopeOf: (call: PlannedCall) => CallEnvelope;
  routing: Routing;
  memoryOn: boolean;
  selfName: string;
  triggerKind: TriggerKind | null;
  lateMedia?: (() => string) | null;
};

/** What the steps of a turn came to: act's answers in order, whether one was cut off, whether anything was delivered. */
export type Stepped = { acts: Array<ActOutcome | HeldSpeech>; cutOff: boolean; delivered: boolean };

type TranscriptOptions = {
  selfName: string;
  handles?: Map<string, string> | null;
  memberNames?: Map<string, Array<string>> | null;
  indexOffset: number;
  media?: object;
};

export type ToolRound = {
  readHistory: (
    channel: { id: string; communityId?: string | null },
    config: ToolRoundConfig,
    options?: { inner?: boolean; draft?: ToolRoundDraft | null; guildId?: string | null }
  ) => Promise<Array<Line>>;
  noteThink: (draft: ToolRoundDraft | null | undefined, parsed: { think?: unknown } | null | undefined) => void;
  stepTranscript: (
    lines: Array<object>,
    options: TranscriptOptions
  ) => Array<{ id: string; index: number; ts: number; text: string }>;
  runSteps: (args: RunStepsArgs) => Promise<Stepped>;
};

// health: allow function-length until 2027-04-01 -- the steps share the runner state of src/behavior/turn.js, moved whole in stage 5b
export function createToolRound(ctx: ToolRoundContext): ToolRound {
  const {
    hot,
    llm,
    calibrator,
    clock,
    skills,
    ifaceReads,
    reactors,
    memberOf,
    selfIdOf,
    conversationOf,
    callView,
    planToolCall,
    heartbeatOnly,
    heartbeatChanged,
    runCalls,
    typingWhileCalls,
    holdSpeech,
    act,
    dumpTurnRequest,
  } = ctx;

  /**
   * The lines of `channel` a turn reads under `config` (src/behavior/lines.ts#historyLines over the interface's
   * `history`): with the reactor store (`reactors`), features.reactionNames and features.seeReactions on (a
   * missing key counts as on), the persona's lines carry who reacted to them, the missing reactors
   * read within `context.reactions.fetchTimeoutMs`. An inner turn reads a bounded recent slice (innerLife.chatMessages).
   * Throws when the interface cannot read the history.
   */
  function readHistory(
    channel: { id: string; communityId?: string | null },
    config: ToolRoundConfig,
    { inner = false, draft = null, guildId = null }: NonNullable<Parameters<ToolRound['readHistory']>[2]> = {}
  ): Promise<Array<Line>> {
    const namesOn = reactors && config.features?.reactionNames !== false && config.features?.seeReactions !== false;
    const communityId = channel.communityId ?? guildId;
    const names: ReactorNames | null = namesOn
      ? {
          store: reactors,
          budgetMs: config.context.reactions?.fetchTimeoutMs ?? 2000,
          fetchUsers: config.context.reactions?.fetchUsers ?? 10,
          known: (memberId) => (communityId ? memberOf(communityId, memberId) : null),
          cache: draft
            ? (draft.reactorNames ??= new Map<string, { name: string; bot: boolean } | null>())
            : new Map<string, { name: string; bot: boolean } | null>(),
          selfId: selfIdOf(),
          communityId: communityId ?? null,
          log,
        }
      : null;
    return historyLines(ifaceReads, conversationOf(channel), {
      limit: inner ? innerSettings(config).chatMessages : config.context.channelMessages,
      names,
    });
  }

  /**
   * Keep the think of the answer just parsed: `lastThink` is the step's (null when it had none, so the
   * next step carries nothing older), `finalThink` the turn's last one that had a think, which the turn
   * exports to its places when it ends.
   */
  function noteThink(draft: ToolRoundDraft | null | undefined, parsed: { think?: unknown } | null | undefined): void {
    if (!draft) return;
    draft.lastThink = typeof parsed?.think === 'string' && parsed.think.trim() ? parsed.think : null;
    if (draft.lastThink) draft.finalThink = draft.lastThink;
  }

  /**
   * The open-intentions line of an inner turn's continuation (`labels.task.continueInnerOpen`,
   * `{list}`): the intentions the turn woke for (the wake's `intentionIds`, their records in
   * `wake.intentions`) that no `intention.*` call of the turn has named yet (intentionNamed), as
   * `<id>: <purpose>` items joined by `; `. '' when none is left or the label is missing.
   */
  function openIntentionsText(draft: ToolRoundDraft | null, labels: RoundLabels): string {
    const template = labels?.task?.continueInnerOpen;
    const wake = draft?.inner?.wake;
    if (typeof template !== 'string' || !template.trim() || !wake) return '';
    const named = draft.innerIntentIds ?? new Set();
    const byId = new Map(
      (isList(wake.intentions) ? wake.intentions : []).map((record) => [objOf(record).id, objOf(record)])
    );
    const ids = [
      ...new Set(
        (isList(wake.items) ? wake.items : []).flatMap((item) => {
          const intentionIds = objOf(item).intentionIds;
          return isList(intentionIds) ? intentionIds : [];
        })
      ),
    ];
    const items = ids
      // A Set answers false for an id of another type.
      .filter((id) => id && !named.has(id as string) && byId.has(id))
      .map((id) => `${String(id)}: ${clampWithEllipsis(oneLine(byId.get(id)?.purpose ?? ''), WAKE_PURPOSE_CHARS)}`);
    return items.length > 0 ? fill(template, { list: items.join('; ') }) : '';
  }

  /**
   * Lines of a step's note rendered like the chat (formatTranscript with the turn's options), numbered from `indexOffset`.
   * `media` carries what a re-rendered line shows now (`videos`, `descriptions`); a delta's new lines need none.
   */
  function stepTranscript(
    lines: Array<object>,
    { selfName, handles, memberNames = null, indexOffset, media = {} }: TranscriptOptions
  ): Array<{ id: string; index: number; ts: number; text: string }> {
    const config = hot.config;
    const handleOf =
      handles instanceof Map ? new Map([...handles].map(([handle, id]) => [String(id), handle])) : undefined;
    return formatTranscript(lines, {
      timezone: config.bot?.timezone ?? 'UTC',
      gapMinutes: config.context?.gapMarkerMinutes,
      maxChars: config.context?.maxMessageChars,
      selfName,
      labels: hot.prompts?.labels ?? {},
      now: clock(),
      ageMinutes: config.context?.ageAfterMinutes ?? 60,
      seeReactions: config.features?.seeReactions !== false,
      reactionsPerMessage: config.context?.reactionsPerMessage,
      replyQuoteChars: config.context?.replyQuoteChars,
      handles: handleOf,
      memberNames: memberNames ?? undefined,
      indexOffset,
      ...media,
    });
  }

  /**
   * The steps of one turn, for every kind of chat turn (a reply, a follow-up, a mention, a name, a private chat, a part of a
   * split message, a finished errand, an interjection, an initiative, an overheard line, an inner turn, a heartbeat).
   * `first` is the reply request's answer (readAnswer's); the request in hand is `messages`, append-only from then on.
   *
   * An answer with no tool call posts its speech (act) and ends the turn. An answer with calls plans them in her order
   * (planToolCall: the journal's `proposed`, a call that cannot run refused with a result, the step's cap, the
   * heartbeat and destination rules, the argument repair, the resolution and the gateway), runs them in segments
   * (runCalls: reads together, every other call alone) and only then lets her speech go out -- when every call worked
   * and its result is an effect or an accepted errand (src/behavior/tool-step.js#stepVerdict). Otherwise the speech
   * is held, never posted later, and the next request says so. A step that left something to read (a `data` result, a
   * call that did not work, an inner turn's open intention) is followed by one more request, when room is left
   * (src/behavior/tool-step.js#roomLeft): the previous messages, her answer, one result for every call, and a note
   * (the speech held, the lines that came in meanwhile numbered past every number in use, the messages that did not go
   * out, the last-step notice, an inner turn's open intentions, what the parser did with her answer). The first user
   * message is never rebuilt. `tools.loop.maxSteps` (an inner turn's: `innerLife.loop`) counts those requests and the
   * last of them is always the final one, which cannot call: its calls get a `loop-cap` result that only the journal
   * keeps, and its speech is held unless it has no calls (an inner turn's one terminal call, if it went through,
   * lets it go out). The same goes for a request the time budget (`timeBudgetMs`, from the first call) or the room
   * of the request (the tokens: the results are cut to fit, 400 characters each at least) made the last. A heartbeat
   * turn ends with its one intention change. Logs `skills: loop` (`steps`, `calls`, `ms`).
   *
   * Resolves `{ acts, cutOff, delivered }`: act's answers in order, whether a step was cut off with nothing complete,
   * and whether anything reached the chat (her speech, a post, a picture, an errand accepted).
   */
  async function runSteps(args: RunStepsArgs): Promise<Stepped> {
    // The typing lease of the calls (typingWhileCalls): started with the first step that has calls, stopped when no
    // request follows and whatever the outcome.
    const typing = { stop: () => {}, started: false };
    try {
      return await runStepsIn({ ...args, typing });
    } finally {
      typing.stop();
    }
  }

  // health: allow function-length until 2027-04-01 -- moved whole from src/behavior/turn.js in stage 5b, a pure move
  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/turn.js in stage 5b, a pure move
  async function runStepsIn({
    channel,
    guildId,
    trigger,
    draft,
    transport,
    messages: requestMessages,
    first,
    readAnswer,
    actArgs,
    callContext,
    envelopeOf,
    routing,
    memoryOn,
    selfName,
    triggerKind,
    lateMedia = null,
    typing,
  }: RunStepsArgs & { typing: { stop: () => void; started: boolean } }): Promise<Stepped> {
    const inner = Boolean(draft.inner);
    // A diary post (draft.diary): only draw.create runs; its pictures are staged and posted with the messages.
    const diary = Boolean(draft.diary);
    const registry = skills ?? defaultSkills();
    const definitionOf = (name: string) => registry.get(name) ?? null;
    const settings = loopSettings(hot.config, { inner, diary });
    // The pictures staged so far as the set the post carries (a single picture is a set of one), or null.
    const stagedSet = () =>
      diary && (draft.staged?.length ?? 0) > 0
        ? { pictures: (draft.staged ?? []).map(({ picture, self, text }) => ({ ...picture, self, text })) }
        : null;
    // The most one call may run: an inner turn's own (innerLife.loop.callTimeoutMs), else tools.callTimeoutMs (read now).
    // loopSettings gives an inner turn its own callTimeoutMs.
    const callTimeoutCap = (inner ? settings.callTimeoutMs : (hot.config.tools?.callTimeoutMs ?? 120000)) as number;
    const tools = transport === 'native' && draft.tools.length > 0 ? { tools: draft.tools, toolChoice: 'auto' } : {};
    const acts: Array<ActOutcome | HeldSpeech> = [];
    let messages = requestMessages;
    // What the request in hand numbers: its lines (the delta's too), where a `#N` of hers resolves.
    let routed: Routing = { ...routing };
    let answer = first;
    // The continuation requests made so far (0: the reply's own answer is in hand).
    let step = 0;
    // Set when the request that gave `answer` was the final one: `steps`, `time` or `tokens`.
    let finalReason: string | null = null;
    let loopStartedAt: number | null = null;
    let openTaken = false;
    let delivered = false;
    let cutOff = false;
    let made = 0;
    // The results no request has followed yet, and the inner actions of the calls that gave them.
    let unseen: Array<CallOutcome> = [];
    let ranActions: NonNullable<ToolRoundDraft['innerActions']> = [];
    const knownIds = new Set(
      [...(routing.history ?? []), ...(routing.lines ?? [])]
        .map((line) => line?.id)
        .filter((id): id is string => typeof id === 'string' && id !== '')
    );
    if (trigger?.id) knownIds.add(String(trigger.id));
    const viewOf = (r: Routing): CallView =>
      callView({
        channel,
        snapshot: snapshotOfDraft(draft),
        guildId,
        idByIndex: r.idByIndex,
        lines: r.lines,
        pulledIds: r.pulledIds,
        memoryOn,
        channelHandles: r.channelHandles,
        memberHandles: r.handles,
        trigger,
        deletedIds: draft.deletedIds,
        searchRefs: draft.searchRefs ?? null,
      });
    const contextOf = (r: Routing, timeoutMs: number | null = null): CallContext => ({
      ...callContext,
      idByIndex: r.idByIndex,
      lines: r.lines,
      pulledIds: r.pulledIds,
      handles: r.handles ?? null,
      memberNames: r.memberNames ?? null,
      channelHandles: r.channelHandles ?? null,
      timeoutMs,
    });

    /** The lines that came in since the last request, her own left out (tool-step.js#deltaLines); a failed fetch gives none. */
    const deltaOf = async (): Promise<{ text: string; lines: Array<StepLine>; idByIndex: Map<number, string> }> => {
      const none = { text: '', lines: [], idByIndex: new Map<number, string>() };
      let fetched: unknown;
      try {
        fetched = await readHistory(channel, hot.config, { inner, draft, guildId });
      } catch (err) {
        log.warn('skills: continuation fetch failed', { channel: channel.id, error: err });
        return none;
      }
      // readHistory answers the history's lines.
      const fresh = (isList(fetched) ? (fetched as ReadonlyArray<StepLine | null>) : [])
        .filter(
          (line): line is StepLine & { id: string } =>
            Boolean(line) && typeof line?.id === 'string' && line.id !== '' && !knownIds.has(line.id)
        )
        .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
      for (const line of fresh) knownIds.add(line.id);
      const numbered = deltaLines({
        lines: fresh.filter((line) => line.self !== true),
        floor: draft.handleFloor ?? 0,
        taken: Math.max(draft.deltaTaken ?? 0, draft.searchRefs ? draft.searchRefs.next - 1 : 0),
        // A post whose id the port did not answer is kept as null, which matches no line.
        ownIds: (draft.ownPosts ?? []) as Array<string>,
      });
      if (numbered.lines.length === 0) return none;
      draft.deltaTaken = numbered.next - 1;
      searchHandles(draft).advance(numbered.next);
      const items = stepTranscript(numbered.lines, {
        selfName,
        handles: routed.handles,
        memberNames: routed.memberNames,
        indexOffset: numbered.offset,
      });
      // deltaLines hands back lines of the history it was given.
      const lines = numbered.lines as Array<StepLine>;
      return { text: items.map((item) => item.text).join('\n'), lines, idByIndex: numbered.idByIndex };
    };

    for (;;) {
      const { parsed } = answer;
      const records = answer.calls;
      const loweredCalls = parsed.loweredCalls ?? [];
      const isFinal: boolean = finalReason !== null;
      const room = roomLeft({
        step,
        maxSteps: settings.maxSteps,
        elapsedMs: loopStartedAt === null ? 0 : clock() - loopStartedAt,
        timeBudgetMs: settings.timeBudgetMs,
      });
      if (records.length === 0 && speechItemsOf(parsed) === 0 && !stagedSet()) break;

      // 1. Her calls, planned in her order and made.
      const plans: Array<CallPlan & { record: NormalCall; coerced: Array<{ arg: string; to: boolean | number }> }> = [];
      let results: Array<CallOutcome> = [];
      // Only an inner turn's last answer still makes one call: a post or a change of an intention.
      const terminalAt =
        isFinal && inner
          ? records.findIndex((record) => !record.problem && INNER_TERMINAL_SKILLS.includes(record.name))
          : -1;
      if (records.length > 0) {
        if (loopStartedAt === null) loopStartedAt = clock();
        if (!typing.started) {
          typing.started = true;
          typing.stop = typingWhileCalls(channel, triggerKind, draft);
        }
        const view = { ...viewOf(routed), links: await linksOfCalls(ifaceReads, records) };
        // A heartbeat turn makes one intention change: the first intent call of a step is planned, a second one is refused.
        let changePlanned = false;
        for (const record of records) {
          const preRefuse = preRefusalOf(record, {
            isFinal,
            terminalAt,
            room,
            maxCallsPerStep: settings.maxCallsPerStep,
            finalReason,
            diary,
          });
          const coercion = preRefuse
            ? { args: record.args, coerced: [] }
            : coerceArgs(record.args, registry.get(record.name)?.argsSchema);
          const second =
            !preRefuse && heartbeatOnly(draft) && HEARTBEAT_INTENT_SKILLS.includes(record.name) && changePlanned;
          if (second)
            log.info('heartbeat: call refused', {
              skill: record.name,
              code: CODE.HEARTBEAT_ONLY,
              reason: 'one-change',
            });
          if (!preRefuse && heartbeatOnly(draft) && HEARTBEAT_INTENT_SKILLS.includes(record.name)) changePlanned = true;
          const call: PlannedCall = {
            skill: record.name,
            // coerceArgs answers an object for the object a normalized call carries.
            args: coercion.args as Obj,
            body: '',
            toolCallId: record.id,
            index: record.index,
            ...(coercion.coerced.length > 0 ? { coerced: coercion.coerced.map((item) => item.arg) } : {}),
            ...(preRefuse ? { preRefuse } : {}),
            ...(second ? { refuse: { code: CODE.HEARTBEAT_ONLY, reason: 'heartbeat:one-change' } } : {}),
          };
          const planned = await planToolCall({ call, channel, envelope: envelopeOf(call), draft, view });
          plans.push({ ...planned, record, coerced: coercion.coerced });
          draft.format.coerced += coercion.coerced.length;
          if (record.problem === CODE.MALFORMED_CALL) draft.format.malformed += 1;
          if (record.problem === CODE.TRUNCATED_CALL) draft.format.truncated += 1;
          if (preRefuse?.code === CODE.LOOP_CAP) draft.format.capped += 1;
        }
        const leftMs = settings.timeBudgetMs - (clock() - loopStartedAt);
        const actionsBefore = draft.innerActions?.length ?? 0;
        results = await runCalls(
          plans,
          contextOf(routed, Math.min(callTimeoutCap, Math.max(LOOP_MIN_CALL_MS, leftMs)))
        );
        ranActions = draft.innerActions?.slice(actionsBefore) ?? [];
        made += results.length;
      }

      // 2. Her speech: out after the calls when every one of them worked and needs no reading, else held.
      // What there is to say now: her messages, reactions and GIF, and a diary post's staged pictures (one item).
      const heldItems = speechItemsOf(parsed) + (stagedSet() ? 1 : 0);
      let speak =
        records.length === 0
          ? true
          : stepVerdict(
              results.map((result) => ({ name: result.skill, result })),
              { definitionOf }
            ).speak;
      if (isFinal && records.length > 0)
        speak = terminalAt >= 0 && coversSpeech(definitionOf(results[terminalAt].skill), results[terminalAt]);
      let loweredResults: Array<CallOutcome> = [];
      const deliveries: Array<{ n: number; total: number; code: string }> = [];
      if (speak && heldItems > 0) {
        const posted = await postSpeech({ parsed, loweredCalls });
        loweredResults = posted.loweredResults;
        deliveries.push(...posted.deliveries);
        if (posted.acted) {
          acts.push(posted.acted);
          if (posted.acted.delivered === true) delivered = true;
        }
      } else if (heldItems > 0) {
        draft.held = { step: step + 1, items: heldItems };
        draft.format.held += 1;
        log.info('turn: speech held', { channel: channel.id, step, items: heldItems });
      }
      const stepResults = [...results, ...loweredResults];
      // A staged picture reached no chat yet: the post that carries it says so.
      if (
        stepResults.some(
          (result) =>
            result.status === 'ok' &&
            result.code !== CODE.STAGED &&
            ['effect', 'job'].includes(definitionOf(result.skill)?.result ?? '')
        )
      )
        delivered = true;
      const posted = stepResults.some((result) => result.skill === 'message.create' && result.status === 'ok');

      // 3. What follows: a request when something is left to read and room is left, else the end.
      const verdict = stepVerdict(
        results.map((result) => ({ name: result.skill, result })),
        { definitionOf }
      );
      // A note on a post that went out (a tag that named nobody) is something to read too: she may edit the post.
      const fresh =
        records.length > 0 &&
        (verdict.fresh || results.some((result) => typeof result.note === 'string' && result.note !== ''));
      const labels = hot.prompts?.labels ?? {};
      // The room the calls left: the time they took counts.
      const left = roomLeft({
        step,
        maxSteps: settings.maxSteps,
        elapsedMs: loopStartedAt === null ? 0 : clock() - loopStartedAt,
        timeBudgetMs: settings.timeBudgetMs,
      });
      // An inner turn that posted: the intentions it woke for that no intent call has named yet. They ride every note that follows a post; a post
      // that left nothing to read earns one request of its own for them, once per turn.
      const openLine = inner && posted && !isFinal ? openIntentionsText(draft, labels) : '';
      const openAlone = openLine !== '' && !fresh && !openTaken && left.run && left.next !== 'none';
      // Under the full stop (features.tools off) she is silent: nothing more is asked of her.
      const stopped = results.some((result) => result.code === CODE.SKILLS_OFF);
      const next: string =
        isFinal || stopped || heartbeatChanged(draft, stepResults) ? 'none' : fresh || openAlone ? left.next : 'none';
      if (next === 'none') {
        typing.stop();
        unseen = stepResults;
        break;
      }
      if (openAlone) {
        openTaken = true;
        draft.innerOpenFollowUp = true;
      }

      // 4. The request that follows: the messages so far, her answer, a result for every call, the note.
      const delta = await deltaOf();
      // Media the request showed as not ready that is ready now (lateMediaTeller), told once.
      const lateText = lateMedia ? lateMedia() : '';
      // Why a call did not work, in detail: the argument that was wrong, what the skill takes (the operation's own message is her data already).
      // callReason (src/format.js) words the reason as a line of text.
      const detailOf = (result: Obj): string =>
        (callReason as (mark: object, labels: unknown) => string)(
          {
            detail: outcomeDetail(result, {
              argNames: registry.get(String(result.skill))?.dispatch?.options?.map((option) => option.name) ?? null,
            }),
          },
          labels
        );
      const resultTexts = results.map((result, i) =>
        toolResultText(result, labels, {
          maxChars: resultCharsFor(result, hot.config),
          coerced: plans[i].coerced,
          // A skill result's rows are the catalogue rows skillsInventoryText renders.
          rowsText: (rows, words) =>
            skillsInventoryText(rows as Parameters<typeof skillsInventoryText>[0], words as object),
          reasonOf: detailOf,
        })
      );
      const notice = !speak && heldItems > 0;
      const diagnostics = untoldDiagnostics(draft)
        .map((diagnostic) => diagnosticText(diagnostic, labels))
        .filter(Boolean)
        .map((line) => `- ${line}`);
      const build = (last: boolean, texts: Array<string>): Array<object> =>
        appendStep({
          transport,
          messages,
          rawText: answer.rawText,
          calls: records,
          results: texts.map((text, i) => ({ text, status: results[i]?.status })),
          note: stepNote({
            labels,
            held: notice,
            deltaText: delta.text,
            lateText,
            deliveries,
            last,
            terminal: inner,
            open: openLine,
            diagnostics,
          }),
        });
      let last: boolean = next === 'final';
      let reason: string | null = last ? (step >= settings.maxSteps - 1 ? LOOP_WHY.steps : LOOP_WHY.time) : null;
      let sent = build(last, resultTexts);
      // The request must fit under the cap with its tools: the results are cut to fit, and the request is the last one.
      const limit = requestTokenLimit(hot.config);
      const cost = (list: Array<object>): number =>
        // The request's messages, as appendStep builds them.
        calibrator.apply(estimateMessages(list as Array<{ content: string }>)) +
        (transport === 'native' ? estimateTools(draft.tools) : 0);
      if (cost(sent) > limit) {
        const excessChars = Math.ceil(((cost(sent) - limit) * 3.5) / Math.max(0.1, calibrator.ratio));
        last = true;
        reason = LOOP_WHY.tokens;
        sent = build(true, cutToFit(resultTexts, excessChars));
        if (cost(sent) > limit) {
          log.warn('skills: loop cap', { channel: channel.id, reason, step, dropped: results.length });
          draft.loopCut = { reason, dropped: (draft.loopCut?.dropped ?? 0) + results.length };
          draft.limits?.add({ kind: 'loop-cap', where: 'tools.loop', lost: results.length, detail: reason });
          unseen = stepResults;
          break;
        }
      }
      let completion: StepCompletion;
      try {
        completion = await llm.complete(sent, {
          ...REPLY_REQUEST,
          ...(draft.started ? { limits: draft.limits } : {}),
          ...ifaceOption(draft),
          ...tools,
        });
      } catch (err) {
        log.warn('skills: follow-up failed', {
          channel: channel.id,
          skill: results[0]?.skill ?? null,
          step: step + 1,
          error: err,
        });
        unseen = stepResults;
        break;
      }
      step += 1;
      draft.steps = step;
      // The delta's lines went out in that request: she saw them (noteSpokeSaw).
      (draft.loopSeen ??= []).push(...delta.lines);
      dumpTurnRequest(
        guildId,
        draft,
        sent.slice(0, 2),
        completion,
        step,
        'tools' in tools ? tools : null,
        sent.slice(2)
      );
      // The answer completed with the note on: what the parser said is told, and the results are read.
      for (const diagnostic of draft.diagnostics ?? []) diagnostic.told = true;
      for (const action of ranActions) action.presented = true;
      unseen = [];
      ranActions = [];
      messages = sent;
      routed = {
        ...routed,
        idByIndex: new Map([...routed.idByIndex, ...delta.idByIndex]),
        lines: [...routed.lines, ...delta.lines],
        history: [...routed.history, ...delta.lines],
      };
      if (last) finalReason = reason;
      answer = readAnswer(completion, step + 1);
      log.info('skills: follow-up answered', {
        channel: channel.id,
        step,
        calls: answer.calls.length,
        usage: completion.usage,
        messages: answer.parsed.messages.length,
        reactions: answer.parsed.reactions.length,
        gif: Boolean(answer.parsed.gif),
        final: last,
      });
      const quiet = answer.parsed.skip || speechItemsOf(answer.parsed) === 0;
      const cut = cutOffOf(completion, answer.parsed, {
        channelId: channel.id,
        empty: Boolean(quiet) && answer.calls.length === 0,
        followUp: true,
      });
      if (cut && !cut.kept && answer.calls.length === 0) {
        cutOff = true;
        break;
      }
    }

    // The end: calls no request followed are either dropped (a fact for her next request) or failed unseen (a fact too).
    const dropped = unseen.filter((result) => result.code === CODE.LOOP_CAP);
    if (dropped.length > 0) {
      const why = finalReason ?? LOOP_WHY.extraCall;
      log.info('skills: loop cap', { channel: channel.id, reason: why, step, dropped: dropped.length });
      draft.limits?.add({ kind: 'loop-cap', where: 'tools.loop', lost: dropped.length, detail: why });
      draft.loopCut = { reason: draft.loopCut?.reason ?? why, dropped: (draft.loopCut?.dropped ?? 0) + dropped.length };
    }
    // A final answer whose speech was held with no call capped (only calls that ran): nothing was dropped, she still wrote it.
    if (!inner) {
      (draft.unseenFailed ??= []).push(
        ...unseen
          .filter((result) => result.status !== 'ok' && result.code !== CODE.LOOP_CAP)
          .map((result) => ({
            kind: 'callFailed',
            skill: result.skill,
            status: CALL_STATUS_NAMES.has(result.status) ? result.status : 'failed',
            code: typeof result.code === 'string' && result.code ? result.code : null,
            ...callTextOf(result, hot.config.tools?.markTextMaxChars ?? 200),
          }))
      );
    }
    if (loopStartedAt !== null)
      log.info('skills: loop', { channel: channel.id, steps: step, calls: made, ms: clock() - loopStartedAt });
    // An inner turn's loop end state, for its result (`inner.loop`): the steps made, the bound that cut it with calls dropped, how many.
    if (inner)
      draft.innerLoop = { steps: step, cut: draft.loopCut?.reason ?? null, droppedCalls: draft.loopCut?.dropped ?? 0 };
    return { acts, cutOff, delivered };

    /** Her speech of a step posted: the messages, reactions, GIF and picture through act, then an inner turn's lowered speech as calls. */
    async function postSpeech({
      parsed,
      loweredCalls,
    }: {
      parsed: StepParsed;
      loweredCalls: Array<PlannedCall>;
    }): Promise<{
      acted: ActOutcome | HeldSpeech | null;
      loweredResults: Array<CallOutcome>;
      deliveries: Array<{ n: number; total: number; code: string }>;
    }> {
      let acted: ActOutcome | HeldSpeech | null = null;
      const set = stagedSet();
      // A set kind with fewer pictures staged than `diary.set.minPosted` is not posted at all, not even its messages.
      if (diary && draft.diary?.set) {
        const staged = draft.staged?.length ?? 0;
        const minPosted = setSettings(hot.config.diary).minPosted;
        if (staged < minPosted) {
          log.info('turn: set short', { channel: channel.id, pictures: staged, wanted: minPosted });
          draft.setShort = staged;
          return { acted: null, loweredResults: [], deliveries: [] };
        }
      }
      const spoken = parsed.messages.length > 0 || parsed.reactions.length > 0 || parsed.gif || set;
      if (spoken) {
        // The arguments the attempt gave, completed with what this step numbers: what act and holdSpeech each take.
        const speech = {
          ...actArgs,
          parsed,
          set,
          idByIndex: routed.idByIndex,
          history: routed.history,
          lines: routed.lines,
          pulledIds: routed.pulledIds,
          handles: routed.handles,
          channelHandles: routed.channelHandles,
        } as ActArgs & HoldArgs;
        acted = await (diary ? holdSpeech : act)(speech);
      }
      const out: {
        acted: ActOutcome | HeldSpeech | null;
        loweredResults: Array<CallOutcome>;
        deliveries: Array<{ n: number; total: number; code: string }>;
      } = { acted, loweredResults: [], deliveries: [] };
      if (loweredCalls.length === 0) return out;
      // The tags of an inner turn are her speech: each planned (the journal, the gate) and made like a call, with no result to give back.
      const view = { ...viewOf(routed), links: await linksOfCalls(ifaceReads, loweredCalls) };
      const lowered: Array<CallPlan> = [];
      for (const call of loweredCalls)
        lowered.push(await planToolCall({ call, channel, envelope: envelopeOf(call), draft, view }));
      out.loweredResults = await runCalls(lowered, contextOf(routed, callTimeoutCap));
      const messagesSent = out.loweredResults.filter(
        (result, i) => lowered[i].call.skill === 'message.create' && !lowered[i].call.args.gif
      );
      const failed = messagesSent.filter((result) => result.status !== 'ok');
      if (failed.length > 0)
        out.deliveries.push({
          n: messagesSent.length - failed.length,
          total: messagesSent.length,
          code: failed[0].code ?? CODE.ERROR,
        });
      return out;
    }
  }

  /**
   * Why a call of a step cannot run, decided before it is planned: `{ code, reason, values? }`, or null when it can. A
   * call the transport could not read or no skill has is refused with its own code (`malformed-call`, `truncated-call`,
   * `unknown-skill`); a call past what the step allows (the final request's, the time's, the step's cap of calls) is
   * `loop-cap` with `what` saying which; in a diary post anything but `draw.create` is `diary-draw-only`. An inner turn's last answer still makes its one terminal call (`terminalAt`).
   */
  function preRefusalOf(
    record: NormalCall,
    {
      isFinal,
      terminalAt,
      room,
      maxCallsPerStep,
      finalReason,
      diary = false,
    }: {
      isFinal: boolean;
      terminalAt: number;
      room: { run: boolean; capReason: string | null };
      maxCallsPerStep: number;
      finalReason: string | null;
      diary?: boolean;
    }
  ): CallRefusal | null {
    if (record.problem)
      return { code: record.problem, reason: record.problem === CODE.UNKNOWN_SKILL ? record.name : '' };
    // A diary post makes pictures, and may say one thing aloud; nothing else.
    if (diary && record.name !== 'draw.create' && record.name !== 'voice.say')
      return { code: CODE.DIARY_DRAW_ONLY, reason: record.name };
    // A final step has its reason, and a step out of room its own or the time.
    const capped = (what: string | null | undefined): CallRefusal => ({ code: CODE.LOOP_CAP, reason: what as string });
    if (isFinal) return record.index === terminalAt ? null : capped(finalReason);
    if (!room.run) return capped(room.capReason ?? LOOP_WHY.time);
    if (record.index >= maxCallsPerStep) return capped(LOOP_WHY.extraCall);
    return null;
  }

  return { readHistory, noteThink, stepTranscript, runSteps };
}

/** Whether a value is a list. */
function isList(value: unknown): value is ReadonlyArray<unknown> {
  return Array.isArray(value);
}

/** A value as a record whose fields are read as untrusted. */
function objOf(value: unknown): { id?: unknown; purpose?: unknown; intentionIds?: unknown } {
  return value !== null && typeof value === 'object' ? value : {};
}
