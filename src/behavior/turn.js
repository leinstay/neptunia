// One "turn": collect context → build the request under the token cap → ask
// the model → act in the conversation like a person would (pause, typing indicator
// proportional to the text, several short messages in a row, reactions).
// Used for answering a call ('reply') and for spontaneous turns
// ('interject' / 'initiate'), in a server channel or in a private chat (a
// channel without a guild, served on behalf of the one pinned guild). A
// server turn -- and a private chat, on its partner's behalf -- may also show
// other channels it is about (`<channel_view>`):
// the read-only channel a call came from, a channel named with an explicit
// <#id>, or one a route hook names. The turn still speaks only here: a
// reaction on a shown line of another channel lands in that channel, and a
// post (a message, the GIF, the picture) answering such a line goes here
// plain, with a jump link to it.
// createTurnRunner builds the topic modules of src/turn/ once and runs every
// attempt of a turn through the phases of src/turn/phases/ (runTurnOnce).

import { createPullViews } from './pull-fetch.ts';
import { fallbackLookupPlan } from './recall.js';
import { createImageFetcher } from '../media/fetch-image.js';
import { createOffPeriodsReader } from '../memory/index.js';
import { createParticipationPicker } from './participation-pick.js';
import { parseRewatchPickDetailed } from './planner.js';
import { createLimits } from '../llm/limits.js';
import { createThinkStore } from './previous-think.js';
import { turnRoutes } from './turn-ability-route.ts';
import { chunkPictures } from './mirror.ts';
import { publishHeldDiary } from './diary-turn.ts';
import { coreToolsOn, loopSettings, paceSettings } from '../turn/settings.ts';
import { scheduleTimer } from '../turn/timers.ts';
import { postsPlain } from '../turn/triggers.ts';
import { lookupClassifierInput } from '../turn/lookup-input.ts';
import { mentionDirectory, pickOtherProfiles, resolveMentions, untaggedNote } from '../turn/mentions.ts';
import { continuationHistory } from '../turn/history.ts';
import { createAct } from '../turn/act.ts';
import { createDiary } from '../turn/diary.ts';
import { createDrawGif } from '../turn/draw-gif.ts';
import { createDryAct } from '../turn/dry-act.ts';
import { createFacts } from '../turn/facts.ts';
import { createInTurnTools } from '../turn/in-turn-tools.ts';
import { createInputs } from '../turn/inputs.ts';
import { createJournalNotes } from '../turn/journal-notes.ts';
import { createLookup } from '../turn/lookup.ts';
import { createOutcome } from '../turn/outcome.ts';
import { createParticipation } from '../turn/participation.ts';
import { createPulls } from '../turn/pulls.ts';
import { createRewatch } from '../turn/rewatch.ts';
import { createSends } from '../turn/sends.ts';
import { createSkillCalls } from '../turn/skill-calls.ts';
import { createToolRound } from '../turn/tool-round.ts';
import { createTyping } from '../turn/typing.ts';
import { routeFor, usableDestination } from '../turn/routing.ts';
import {
  FAILED_TURN_KEEP_MS,
  SKIP_NOTHING_TO_DO,
  SKIP_SILENCE,
  journalResultOf,
  journalTurnRecord,
  sendHash,
  settleUnknownSends,
} from '../turn/journal.ts';
import { answerOf, callViewOf, requesterOf, searchHandles } from '../turn/calls.ts';
import { taskInput } from '../turn/task-input.ts';
import { preflight } from '../turn/phases/preflight.ts';
import { requestPhase } from '../turn/phases/request.ts';
import { responsePhase } from '../turn/phases/response.ts';
import { actPhase } from '../turn/phases/act.ts';
import { toolRoundPhase } from '../turn/phases/tool-round.ts';
import { attemptReport, closeAttempt, outcomeOfError, outcomePhase } from '../turn/phases/outcome.ts';

// A set's pictures are split and named as the diary's mirrors send them (src/behavior/mirror.ts).
export { chunkPictures };

/** @typedef {import('../turn/triggers.ts').TriggerKind} TriggerKind */

/**
 * How a turn ended. `spoke` and `skip` reached the model (a skip chose
 * silence); `busy` (another turn blocks this one), `paused` (`/nep pause`),
 * `not-now` (a spontaneous chooser found nothing to do) never did; `refused`
 * is a rail (request or token cap) and carries its `limit`; `error` is any
 * other failure, logged -- a turn dropped unposted at its bar
 * (pace.dropAfterMs, `turn: dropped`) included.
 * @typedef {'spoke'|'skip'|'busy'|'refused'|'paused'|'not-now'|'error'} TurnOutcome
 */

// The functions of a turn that stand on their own live in src/turn/; these are the names importers and tests read here.
export {
  FAILED_TURN_KEEP_MS,
  SKIP_NOTHING_TO_DO,
  SKIP_SILENCE,
  answerOf,
  callViewOf,
  continuationHistory,
  coreToolsOn,
  journalResultOf,
  journalTurnRecord,
  lookupClassifierInput,
  loopSettings,
  mentionDirectory,
  paceSettings,
  pickOtherProfiles,
  postsPlain,
  requesterOf,
  resolveMentions,
  routeFor,
  searchHandles,
  sendHash,
  settleUnknownSends,
  taskInput,
  untaggedNote,
  usableDestination,
};

// The server search on a question's own words lives with the recall planning (src/behavior/recall.js).
export { fallbackLookupPlan };

// The re-watch classifier's answer parser lives with the planner (src/behavior/planner.js).
export { parseRewatchPickDetailed };

/**
 * `images` (src/llm/images.js#createImageGen) is optional: absent,
 * `features.imageGeneration` false, or a channel where the bot cannot attach
 * files, her `draw.create` is refused and no drawing line reaches `<senses>`.
 *
 * `lookup` (src/web/lookup.js#createLookup) is optional too: absent, or
 * `features.webLookup` not true, no link is read and no search is made.
 *
 * `recall` (src/behavior/recall-run.js#createRecall) is optional too: the
 * search of the server's own history beside the web search. Absent, or its
 * `available()` false, or a private chat without its partner (see runTurn),
 * no server search is made. The one
 * lookup classifier serves both (maybeLookup) and the request's `lookup`
 * input carries both parts: the web search's result as it is
 * (src/web/lookup.js#search, `{ query, text, sources, cached? }`), with a
 * `server` key (`{ text, stretch, people }`, recall's result) added only when
 * the server search found something; a server part alone is `{ server }`.
 * A web-only result is exactly the web search's object, as before recall.
 *
 * `now` (default Date.now) is the turn's clock: its own time, `{{today}}` of
 * the search classifier, the daily GIF counter and every `lastPostAt` stamp.
 *
 * `emoji` (src/behavior/emoji-index.ts#createEmojiIndex) is optional: absent, or
 * `features.customEmoji` false (a missing key counts as on), no `:name:` is
 * turned into a custom emoji and a `<react>` with a custom one is dropped.
 *
 * `describer` (src/memory/describe.js#createDescriber) is optional: when
 * absent, or `features.mediaDescriptions` is off, no description request is
 * ever made — buildRequest simply renders every un-attached picture blind
 * (and every attached one with its bare marker). A neighbour channel's
 * pictures never cost a request: they get only the captions the cache
 * already holds (`describer.cachedDescriptions`), under the same switch. A
 * pulled channel's pictures (`<channel_view>`) get the cache's captions, and
 * fresh ones only once the turn is certain to run.
 * Likewise, videos are only watched when `features.mediaDescriptions` AND
 * `features.videoDescriptions` (a missing key counts as on) are on and the describer has
 * `describeVideos`; otherwise they render without a watch.
 *
 * `getSelfName` (src/index.js) is the persona's display name in a guild;
 * default: the client's cached guild member, else the bot user's name.
 *
 * A call whose text passes the splitter's pre-filter (src/behavior/split.js)
 * asks the splitter (prompts/split.md) beside the turn's preparation, under
 * its deadline. `one`, a late, failed or unparsable answer, a missing prompt
 * or a labels file without `labels.task.part`: the turn goes on as if it had
 * never been asked. Parts in time: the turn sets its preparation aside and
 * runChain answers the parts one after another (see there).
 *
 * `routeChannels` (the route classifier's hook; src/index.js passes
 * src/behavior/route-channel.js#createChannelRouter's) is optional:
 * `({ guildId, channel, guild, partner, history, trigger, triggerKind, selfName, config }) => Promise<string[]>`,
 * the ids of channels the conversation is about; `triggerKind` is the turn's
 * TriggerKind (null on a turn without a trigger), so the hook can decline
 * kinds it does not serve (src/behavior/route.js#routeAllowed); `guild` is the
 * guild the ids are judged in, `partner` a private chat's partner (null on a
 * server turn). It is asked on a server turn, or a private chat with its
 * partner (features.privateLikeServer, see runTurn),
 * with features.channelPull on and the labels able
 * to render the block (`labels.pull.header`) while a
 * `<channel_view>` slot (`context.pull.maxChannels`) is left after the turn's
 * source and the explicit `<#id>` mentions; its ids are pulled after those
 * (src/behavior/pull.js#pullTargets). On a routed turn `history` is the source
 * channel's lines, not this chat. A throw or an answer that is not an array
 * counts as no id (a throw logs `pull: route failed`).
 *
 * Participation (src/memory/participation.js; features.participation and features.memory,
 * a missing key counts as on; never in a private chat or a place of her diary): every message a
 * turn sends for real in a server channel is recorded in the guild's participation store with
 * the history lines before it and the line it replies to (recordOwnParticipation; a dry run
 * records nothing). A server turn that builds a reply request (not a diary post) hands the
 * store to buildRequest as `<participation>`; beside its preparation the pick classifier
 * (src/behavior/participation-pick.js) chooses which stored episodes
 * of other channels come first, under the same deadline -- late, the newest are shown.
 *
 * The turn planner (src/behavior/planner.js; features.turnPlanner exactly true, read per turn):
 * one request (prompts/planner.md, role `analyzer`, purpose `planner`) stands in for
 * the route hook, the participation pick, the re-watch classifier and the search classifier,
 * none of which is asked then (createTurnPlan). Each answer block reaches the code its old
 * classifier fed; a block that is invalid or missing keeps that consumer's default (no channel,
 * the newest episodes, no second look), and the lookup block, or a failed call, takes the
 * search classifier's fallback.
 *
 * Everything a turn prepares before its reply request (the file previews, the
 * captions, the videos and their re-watch, the link reads, the search
 * classifier with its searches, the neighbours, the pulled channels) starts as soon as its inputs exist and runs alongside the
 * rest, under one deadline (paceSettings: `pace.prepareMs` from the turn's
 * start, `pace.prepareSearchMs` once the search classifier asked for a
 * search -- and at most that long while its verdict is still out --,
 * `pace.prepareMediaMs` for a direct call that brought media to look
 * at; the larger of the two with both). A request on a model role other than `core` still running then
 * contributes nothing to this turn --
 * its block is absent, as when it fails -- and keeps running for its cache.
 * A turn nobody waits for (unhurried, `pace.unpromptedWaits`) has no such
 * deadline and no bar: it waits for every request on a model role other than `core`. Every turn that reaches the reply request logs `turn: timings`.
 * `schedule(fn, ms)` (default: setTimeout) runs that deadline and the typing
 * indicator's refresh; it resolves a function that cancels it.
 * `activity` (src/behavior/activity.js#createActivity, fed by src/behavior/pipeline.js; optional)
 * tells when each person last wrote in each channel: a turn answering a person waits on it
 * (pace.settleMs, settleAuthor below); absent, no turn waits.
 * `journal` (src/memory/journal.js#createJournal; optional): with features.journal exactly
 * true (read at the moment of use), every attempt that passes the pause and attention rails
 * writes a `turn.start` line, and runTurn writes each attempt's `turn` record once it returns
 * (journalTurnRecord); `turn: model answered` then logs `thinkChars` instead of `think`.
 * Every side effect of such an attempt is a journal operation (journalOp): `started` before
 * it, then `succeeded`, `failed` or `unknown` -- the persona's posts, reactions, GIFs and
 * pictures (`by: 'persona'`; a dry run writes `started` and `succeeded` with `dryRun: true`),
 * and the engine's preparation (`by: 'engine'`: link reads, video watches, captions, the
 * searches; createPrepLedger says whether each result reached the request). A post's
 * `started` line carries its `intent` (the message it replies to, the first 80 characters of
 * its text) for the reconciliation after a restart (src/memory/journal.js#reconcile).
 * `record` (src/memory/record.js#createRecord; optional): with features.record exactly true
 * (read at the moment of use), every message of the persona that reached the chat is appended
 * to it as a `said` line (recordSaid), with the turn's and the post operation's ids when the
 * journal follows the attempt.
 *
 * Trigger links: every message a turn with a trigger posts (a message, a GIF, a picture) is
 * remembered in process with the id of that trigger (`seedTriggerLinks` adds the ones the journal
 * kept from before a restart). With features.triggerMarkers on (a missing key counts as on, read
 * per turn) the persona's own lines of the turn's history and of its pulled channels carry it
 * (src/format.js#withTriggers), so the request's `<chat>` and `<channel_view>` and every
 * analyzer transcript built from that history name the message that started the turn which posted
 * each line (`transcript.triggeredBy` / `triggeredByOlder`). The neighbours' lines show no `#n`
 * and carry none. A spontaneous turn, a diary post or a dry run links nothing.
 *
 * Call marks: every skill call she makes (runCall: its skill, status, target and the messages its
 * turn posted) is remembered in process, `seedCallMarks` adding the ones the journal kept from
 * before a restart; a message a call posted in another channel than its turn's remembers that
 * channel. With features.callMarkers on (a missing key counts as on, read per turn) the lines of
 * the turn's history and of its pulled channels carry them (src/format.js#withCalls,
 * linkCalls), so she sees what she called and how it went, in the channel where she called it.
 *
 * Skills and the interface: every effect of a reply -- a message with its reply target and
 * mentions, the GIF, the picture's publication after its generation, a diary set's pictures, a
 * reaction, the typing indicator -- is checked by src/tools/gateway.ts#checkReplyEffect right
 * before it runs (`message.create`, a picture or GIF being one with its media or URL, and
 * `message.react.add`: carried over in the current conversation, refused only under the full stop
 * -- features.tools false, she goes silent; each refusal logs `skill: refused` (`skill`, `code`,
 * `reason`) and nothing is done; no picture or diary set is generated for a post the check
 * already refuses, and no typing indicator shows), then made through the interface port `port`
 * (src/interface/port.js). Nothing counts as posted (journal, record, stats, lastPostAt) unless the port
 * answered `ok`; `unknown` is journaled as unknown and never sent again. A dry run calls neither
 * the gateway nor the port.
 *
 * Skill calls: her skills are the owner's /nep commands (src/tools/registry.ts; `skills`: the
 * registry checked against, default skillRegistry()). Her tools -- the skills granted to her and the
 * carried-over ones (src/tools/discovery.ts#exposedSkillNames) -- travel with every request of a
 * turn, as native tool definitions or, with `tools.transport` `text`, as a `<tools>` block. Every
 * call of an answer is planned in her order (planToolCall: on an immutable envelope built by code,
 * callEnvelope; journaled `proposed` with its invocation id and tool call id, repaired where the
 * schema allows (coerceArgs), resolved on the server's side, checked) and made in segments (runCall:
 * checked again right before, then run by src/tools/executors.ts through `runOp(op, args,
 * context)` -- src/admin.js#runSkillOp, the command's own path, the requester's rights checked
 * again; absent, a call is `not_configured`; her own expressive operations through
 * `runOwnOp`, src/admin.js#runOwnSkillOp, her grant alone; an inner turn's calls through
 * `runInitiativeOp`, src/admin.js#runInitiativeSkillOp, her grant alone). Her speech goes out after
 * the calls, when all of them worked and none gave her something to read; else it is held and the
 * results come back to her in one more request (runSteps), bounded by `tools.loop`. A dry run only
 * logs the call (`dry-run: would call`).
 *
 * Reactors: `reactors` (src/behavior/reactor-store.ts#createReactorStore, null: none) is the store of
 * who reacted to her messages, fed by `reaction.changed`; the turn's history read names them on her lines
 * (reactorNames).
 *
 * Intentions: `intentions` (src/intentions/service.ts#createIntentionService, null: none) gives the
 * `<intentions>` block of every turn but a diary post while features.intentions is exactly true.
 *
 * The interface: `reads` (src/interface/reads.ts#createReads over the port) is how a turn asks the interface
 * about a conversation, its lines, a member and the reactors: `runTurn` takes a conversation reference and reads
 * its info (the permissions, the audience) and one snapshot of the community's conversations per attempt. A read the
 * interface does not offer leaves its block out of the request; a conversation it no longer knows ends the turn
 * `unavailable` before any model call. `selfId()` is the persona's id on the interface (from `hello`), `getSelfName`
 * her name in a community, `memberOf(communityId, memberId)` the name and kind of a member the core has been told of,
 * `membersOf(communityId)` all of them and `conversationName(id)` the name the interface gave a conversation.
 */
export function createTurnRunner({
  hot,
  store,
  llm,
  calibrator,
  rng = Math.random,
  describer = /** @type {any} */ (undefined),
  fetchImpl = fetch,
  imageFetcher = createImageFetcher(),
  lookup = /** @type {any} */ (undefined),
  recall = null,
  images = /** @type {any} */ (undefined),
  speech = /** @type {any} */ (null),
  emoji = /** @type {any} */ (undefined),
  getSelfName = () => 'bot',
  selfId: selfIdOf = () => '',
  reads: readsDep,
  memberOf = () => null,
  membersOf = null,
  conversationName = () => null,
  routeChannels = /** @type {any} */ (undefined),
  now: clock = Date.now,
  schedule = scheduleTimer,
  activity = null,
  journal = /** @type {object | null} */ (null),
  record = null,
  port,
  skills = /** @type {import('../tools/types.ts').SkillMap | null} */ (null),
  runOp = /** @type {import('../tools/executors.ts').RunOperation | null} */ (null),
  runOwnOp = /** @type {import('../tools/executors.ts').RunOperation | null} */ (null),
  runInitiativeOp = /** @type {import('../tools/executors.ts').RunOperation | null} */ (null),
  around = null,
  reactors = null,
  errands = /** @type {any} */ (null),
  mirrors = /** @type {any} */ (null),
  intentions = null,
  // The places view of the inner life (src/behavior/inner.ts#places): `<places>` on an addressed turn with `context.places` on.
  places = null,
  // The per-turn record of the memory rows a request carried (src/memory/db/service.js#recordTurnReads); null: none.
  memoryReads = null,
  // The execution context of a turn (src/memory/db/service.js#issueContext, `(spec) => ctx`); null: none.
  memoryContext = null,
  // Her attention, one turn at a time: src/behavior/attention.ts mirrors it as leases; a plain set without them.
  attention = new Set(),
  // Which model roles are down (src/llm/role-health.ts), shared with the admin: her tool roles route on it.
  roleHealth = null,
}) {
  /** @type {import('../interface/reads.ts').Reads} */
  const ifaceReads = readsDep;
  const busy = attention;
  const routes = turnRoutes(hot, roleHealth);
  // The topic modules of the closure (src/turn/<topic>.ts), each built once from the context it reads.
  const {
    participationOn,
    participationAudience,
    aroundInputFor,
    liveChannelName,
    recordOwnParticipation,
    recentInput,
  } = createParticipation({ hot, store, around, clock });

  const iface = port;
  const {
    turnContextOf,
    stableFreezeOf,
    conversationOf,
    messageOf,
    checkEffect,
    discoveryPrompt,
    discoverSkills,
    errandsInputFor,
    intentionsInputFor,
    placesInputFor,
  } = createInputs({ hot, store, iface, skills, selfIdOf, memoryContext, errands, intentions, places });

  const { facts, setFactsSource } = createFacts({ clock });
  // The channels known to be private chats (a deferred call names only its channel).
  const privateChannels = new Set();
  const lastPostAt = new Map(); // channelId -> ts of the persona's last message
  // channelId -> ids of the messages in the history of the last turn that spoke there; for a
  // channel the bot cannot write in, the lines its `<channel_view>` block showed in the last
  // turn that spoke anywhere while showing it (noteSpokeSaw). The pending-ping drain
  // (src/behavior/pipeline.js) skips a ping such a turn already had in view.
  const spokeSaw = new Map();
  // Whether the last turn that wanted prompts['follow-up'] found it missing or blank: `turn:
  // prompt missing` is warned once each time this turns true (the turn falls back to reply.md).
  const promptState = { followUpMissing: false };
  // The participation pick classifier (src/behavior/participation-pick.js): which stored
  // exchanges of other channels a turn's `<participation>` block shows first.
  const pickParticipation = createParticipationPicker({ hot, store, llm, now: clock, schedule });
  // The last view of each pulled channel shown in each channel, in process only: a channel
  // shown again says what of it is new since (createPullViews; `seenBefore` on the entry).
  const pullViews = createPullViews();
  // The channels an exchange keeps pulled, by destination (process memory, like pullViews): `{ channelIds, at, turns, authorId }`.
  const keptPulls = new Map();
  // Posted message id -> the id of the message that started the turn which posted it, in
  // process (noteTrigger at each post, seedTriggerLinks at start from the journal); the oldest
  // links go first past TRIGGER_LINKS_MAX. Her transcript lines read it (linkTriggers).
  const triggerLinks = new Map();

  // The persona's skill calls, in process (noteCall at each call, seedCallMarks at start from the
  // journal), oldest first, the oldest dropped past CALL_MARKS_MAX; and posted message id -> the
  // channel of the turn that posted it from another channel (notePostedFrom). Her transcript
  // lines read both (linkCalls).
  const callMarks = [];
  const postedFromLinks = new Map();

  // The last think per place (src/behavior/previous-think.js), in process; a restart forgets it.
  const thinks = createThinkStore();

  // The persona's recent time away from the journal's system records, reused for a minute.
  const readOffPeriods = createOffPeriodsReader({ journal, now: clock });
  const {
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
    seedTriggerLinks,
    seedCallMarks,
    linkCalls,
    journalOn,
    dumpTurnRequest,
    offPeriodsFor,
    writeTurnRecords,
    recordSaid,
    journalOp,
  } = createJournalNotes({
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
  });
  const { runTurn, recordTurnFacts, notifyIdle, waitingParts, addToPart, waitIdle, setOnIdle, setOnTurnEnd } =
    createOutcome({
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
    });
  const { prepareDiary, diaryPictureGate } = createDiary({
    hot,
    store,
    llm,
    calibrator,
    rng,
    lookup,
    images,
    journalOp,
    recentInput,
  });
  const { drawPromptFor, drawTool, resolveGif, postGif, pickedInTime, pickGifSafely } = createDrawGif({
    hot,
    store,
    llm,
    images,
    imageFetcher,
    ifaceReads,
    iface,
    routes,
    selfIdOf,
    clock,
    schedule,
    stableFreezeOf,
    conversationOf,
    messageOf,
    checkEffect,
    lastPostAt,
    diaryPictureGate,
  });
  const { emojiLookup, renderPost, settleAuthor, diaryChannelName, mirror } = createSends({
    hot,
    store,
    emoji,
    conversationName,
    clock,
    schedule,
    activity,
    iface,
  });
  const { typingWhileCalls, typingWhilePreparing } = createTyping({ hot, iface, schedule, clock, conversationOf });
  const { dryAct } = createDryAct({
    hot,
    ifaceReads,
    iface,
    clock,
    lastPostAt,
    journalOp,
    renderPost,
    emojiLookup,
    mirror,
    pickGifSafely,
    drawPromptFor,
  });
  const { holdSpeech, act } = createAct({
    hot,
    store,
    rng,
    clock,
    selfIdOf,
    ifaceReads,
    iface,
    conversationOf,
    messageOf,
    checkEffect,
    lastPostAt,
    noteTrigger,
    noteLineSources,
    recordSaid,
    journalOp,
    renderPost,
    postGif,
    pickedInTime,
    pickGifSafely,
    recordOwnParticipation,
  });
  const { pullChannels, captionAll, withSeenBefore, markPulledSeen, noteSpokeSaw, stampShownCalls } = createPulls({
    hot,
    store,
    describer,
    routeChannels,
    clock,
    ifaceReads,
    pullViews,
    keptPulls,
    spokeSaw,
  });
  const { callView, planToolCall, heartbeatOnly, heartbeatChanged, runCalls } = createSkillCalls({
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
  });
  const { readHistory, noteThink, stepTranscript, runSteps } = createToolRound({
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
  });
  const { inTurnTools } = createInTurnTools({
    hot,
    store,
    lookup,
    describer,
    recall,
    speech,
    record,
    routes,
    clock,
    ifaceReads,
    memberOf,
    conversationOf,
    turnContextOf,
    linkCalls,
    drawTool,
  });
  const { classifierContext, maybeRewatch, rewatchOffer, applyRewatch } = createRewatch({ hot, llm, describer });
  const {
    startPrefetch,
    recallAvailable,
    turnDirectory,
    privatePartner,
    createTurnPlan,
    lookupGate,
    maybeLookup,
    maybeSplit,
  } = createLookup({
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
  });
  // What the phases of an attempt (src/turn/phases/) read: the dependencies, the closure state and the topic functions.
  const phases = {
    hot,
    store,
    llm,
    calibrator,
    clock,
    schedule,
    describer,
    fetchImpl,
    lookup,
    images,
    emoji,
    journal,
    record,
    iface,
    ifaceReads,
    skills,
    memoryReads,
    busy,
    selfIdOf,
    getSelfName,
    privateChannels,
    pullViews,
    promptState,
    pickParticipation,
    notifyIdle,
    facts,
    participationOn,
    participationAudience,
    aroundInputFor,
    liveChannelName,
    recentInput,
    turnContextOf,
    stableFreezeOf,
    discoverSkills,
    errandsInputFor,
    intentionsInputFor,
    placesInputFor,
    noteSeen,
    linkTriggers,
    linkCalls,
    earlierThinkFor,
    journalOn,
    dumpTurnRequest,
    offPeriodsFor,
    journalOp,
    prepareDiary,
    diaryPictureGate,
    resolveGif,
    emojiLookup,
    settleAuthor,
    diaryChannelName,
    typingWhilePreparing,
    dryAct,
    pullChannels,
    captionAll,
    withSeenBefore,
    markPulledSeen,
    noteSpokeSaw,
    stampShownCalls,
    readHistory,
    noteThink,
    stepTranscript,
    runSteps,
    inTurnTools,
    classifierContext,
    maybeRewatch,
    rewatchOffer,
    applyRewatch,
    startPrefetch,
    recallAvailable,
    turnDirectory,
    privatePartner,
    createTurnPlan,
    lookupGate,
    maybeLookup,
    maybeSplit,
  };

  /**
   * One turn, as described on runTurn. Internal for a split message: `maySplit` (runTurn's
   * first turn may ask the splitter; parts in time end it with the internal
   * outcome `split`, `{ parts, history }`, still holding the attention for
   * runChain), `owned` (a turn of the chain: the chain holds the attention and
   * fires the idle notifications), `part` (`{ index, total, parts }`: its
   * analyzer requests judge that part's text, its request names it), `reuseHistory` (the
   * first part's history, already fetched) and `plainPosts` (a later part
   * posts plain).
   */
  async function runTurnOnce(args) {
    // `limits`: what bit during this attempt (src/llm/limits.js), for its turn record.
    const draft = { limits: createLimits() };
    let result;
    try {
      const opened = await preflight(phases, args, draft);
      if (opened.ended) {
        result = opened.ended;
      } else {
        try {
          const prepared = await requestPhase(phases, args, draft, opened);
          const answered = prepared.ended ? prepared : await responsePhase(phases, args, draft, prepared);
          const acting = answered.ended ? answered : await actPhase(phases, args, draft, answered);
          const rounded = acting.ended ? acting : await toolRoundPhase(phases, args, draft, acting);
          result = rounded.ended ?? outcomePhase(phases, args, draft, rounded);
        } catch (err) {
          result = outcomeOfError(phases, args, draft, opened, err);
        } finally {
          closeAttempt(phases, args, draft, opened);
        }
      }
    } finally {
      await publishHeldDiary({ mirrors, turnId: draft.turnKey?.turnId });
      // An attempt whose turn.start was written closes with its turn record at runTurn's exit,
      // whatever it returned (a throw counts as `error`).
      if (draft.started) args.journalAttempts?.push({ draft, result: result ?? { outcome: 'error' } });
      if (args.turnEnds) {
        if (draft.info) args.turnEnds.info = draft.info;
        args.turnEnds.replyTargets.push(...(draft.replyTargets ?? []));
        if (typeof draft.reason === 'string') args.turnEnds.reasons.push(draft.reason);
        if (draft.factsShown) args.turnEnds.factsShown = draft.factsShown;
      }
      // What an addressed turn lost, kept for her next request there (an inner turn's go to the inner life).
      if (!args.inner) recordTurnFacts(args, draft, result);
      recordTurnThink(args, draft, result);
    }
    return attemptReport(args, draft, result);
  }

  return {
    runTurn,
    seedTriggerLinks,
    seedCallMarks,
    waitingParts,
    addToPart,
    isBusy: (channelId) => busy.has(channelId),
    isAnyBusy: () => busy.size > 0,
    /** The ids of the channels a turn is running in now (for log lines: where the attention is). */
    busyChannels: () => [...busy],
    lastPostAt: (channelId) => lastPostAt.get(channelId) ?? 0,
    notePost: (channelId, ts) => lastPostAt.set(channelId, ts),
    /**
     * Whether the last turn that spoke in `channelId` (this process, dry-run included) had
     * `messageId` in its channel history -- so a direct ping queued while that turn ran was
     * already in front of the model and is not answered a second time. For a channel the bot
     * cannot write in: whether the last turn that spoke while showing that channel's lines
     * (`<channel_view>`) showed `messageId`.
     * @param {string} channelId
     * @param {string} messageId
     * @returns {boolean}
     */
    spokeAfterSeeing: (channelId, messageId) => spokeSaw.get(channelId)?.has(messageId) ?? false,
    waitIdle,
    setOnIdle,
    /**
     * The facts kept for her next request in a conversation (src/behavior/inner.ts's `facts`: `enabled`, `add`,
     * `pending`, `markTold`); used while its `enabled()` says so, else the runner keeps its own in process.
     */
    setFactsSource,
    setOnTurnEnd,
    /**
     * The id of the message that started the turn which posted `postedId` (this process, or
     * seeded from the journal at start), or null.
     * @param {string} postedId
     * @returns {string|null}
     */
    triggerOf: (postedId) => triggerLinks.get(postedId) ?? null,
  };
}
