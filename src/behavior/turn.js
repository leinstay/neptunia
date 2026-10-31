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

import { randomUUID } from 'node:crypto';
import { block, buildRequest, usesFollowUpTask } from './prompt.js';
import { isSetKind, setSettings, stripUrls } from './diary.ts';
import { createDeadline, createPrepLedger, lateMediaTeller } from './turn-parts.ts';
import { createLinker, messageLinkOf } from './elsewhere.ts';
import { createPullViews } from './pull-fetch.ts';
import { audienceAllows, takeSnapshot } from './snapshot.ts';
import { fetchNeighbors } from './neighbors.ts';
import { withTextPreviews } from '../media/text-preview.ts';
import { isTaggedCall } from './mention.js';
import { fallbackLookupPlan } from './recall.js';
import { splitCandidate } from './split.js';
import { turnRequestInput } from './turn-input.js';
import { parseOutput } from '../llm/parse.js';
import { DailyCapError, TokenLimitError, errorCodeOf, railReason } from '../llm/openrouter.js';
import { limitOf } from './limits.js';
import { portIface } from '../interface/capabilities.ts';
import { collectVideos, lateVideoStates } from '../media/classify.js';
import { createImageFetcher } from '../media/fetch-image.js';
import { resolveReactionEmoji } from './emoji.js';
import { refreshEmojiIfOn } from './emoji-index.ts';
import { log } from '../log.js';
import { countDashes, stripDashes } from '../memory/clamp.js';
import { isVideoVisionOn, createOffPeriodsReader } from '../memory/index.js';
import { createParticipationPicker, participationEpisodeOffer } from './participation-pick.js';
import { parseRewatchPickDetailed, plannerOn } from './planner.js';
import { routeAllowed, routeCandidate, routeSettings } from './route.js';
import { routeChannelOffer } from './route-channel.js';
import { deletedLinesMax, deletedLinesOf, withDeletedLines } from './deleted-lines.js';
import { budgetDrops } from '../llm/budget.js';
import { createLimits } from '../llm/limits.js';
import { createThinkStore } from './previous-think.js';
import { exposedSkillNames } from '../tools/discovery.ts';
import { outcomeDetail } from '../tools/executors.ts';
import { FACTS_SHOWN_MAX, factPayload } from './inner.ts';
import { innerOutputCalls } from './inner-output.js';
import { feedbackInTurnText, wakeBlockText } from './wake.ts';
import { turnRoutes } from './turn-ability-route.ts';
import { transportOf } from '../tools/tool-calls.ts';
import { buildTools } from '../tools/tools-json.ts';
import { thinkMissing } from './tool-step.js';
import { toolsBlockText } from '../llm/tool-text.js';
import { estimateTools } from '../llm/tokens.js';
import { chunkPictures, diaryConversationIds } from './mirror.ts';
import { forcedPictureRefusal, publishHeldDiary, recordEntry, wakeInputs } from './diary-turn.ts';
import { NO_LOOP, coreToolsOn, loopSettings, paceSettings } from '../turn/settings.ts';
import { PREPARE_STAGES, TOO_SLOW, scheduleTimer, trackStage } from '../turn/timers.ts';
import { DIRECT_CALLS, askedFor, postsPlain, takeAttention, unhurried } from '../turn/triggers.ts';
import { lookupClassifierInput } from '../turn/lookup-input.ts';
import { mentionDirectory, pickOtherProfiles, resolveMentions, storedNames, untaggedNote } from '../turn/mentions.ts';
import { sourceLinkTarget } from '../turn/targets.ts';
import {
  describableCandidates,
  gifRewatchItems,
  readableLinkCandidates,
  relookCandidates,
  triggerBringsMedia,
} from '../turn/media.ts';
import { NO_RECENT, continuationHistory, withReplyParents } from '../turn/history.ts';
import { createAct } from '../turn/act.ts';
import { createDiary } from '../turn/diary.ts';
import { createDrawGif } from '../turn/draw-gif.ts';
import { createDryAct } from '../turn/dry-act.ts';
import { createFacts } from '../turn/facts.ts';
import { createInTurnTools } from '../turn/in-turn-tools.ts';
import { createInputs } from '../turn/inputs.ts';
import { createJournalNotes } from '../turn/journal-notes.ts';
import { createLookup } from '../turn/lookup.ts';
import { createParticipation } from '../turn/participation.ts';
import { createPulls } from '../turn/pulls.ts';
import { createRewatch } from '../turn/rewatch.ts';
import { createSends } from '../turn/sends.ts';
import { createSkillCalls } from '../turn/skill-calls.ts';
import { createToolRound } from '../turn/tool-round.ts';
import { createTyping } from '../turn/typing.ts';
import { channelDirectoryOf, inCommunity, routeFor, usableDestination } from '../turn/routing.ts';
import {
  FAILED_TURN_KEEP_MS,
  SKIP_NOTHING_TO_DO,
  SKIP_SILENCE,
  cutOffOf,
  droppedSections,
  journalResultOf,
  journalStartOf,
  journalTurnRecord,
  journalUsage,
  journalled,
  linkHosts,
  noteDiagnostics,
  sendHash,
  settleUnknownSends,
  untoldDiagnostics,
} from '../turn/journal.ts';
import {
  CALL_MARKS_MAX,
  SEARCH_HANDLE_GAP,
  answerOf,
  callEnvelope,
  callViewOf,
  defaultSkills,
  replyOptionsOf,
  requesterOf,
  searchHandles,
} from '../turn/calls.ts';
import { taskInput } from '../turn/task-input.ts';

// A set's pictures are split and named as the diary's mirrors send them (src/behavior/mirror.ts).
export { chunkPictures };

/** @typedef {import('../protocol/adapter.ts').ConversationInfo} Conv */
/** @typedef {import('./snapshot.ts').Snapshot} Snap */
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
 * A value of the untyped parts of the turn (the live config, a draft) as the object a typed function takes.
 * @param {*} value
 * @returns {object}
 */
function asObject(value) {
  return value;
}

/**
 * A list of the untyped parts of the turn as the list a typed function takes.
 * @param {*} value
 * @returns {object[]}
 */
function asList(value) {
  return value;
}

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

  // channelId -> the chain of parts running there (runChain): its author, its parts, the part
  // in progress (`next`, 1-based; 0 before the first) and the messages folded into a later part.
  const chains = new Map();
  const { facts, setFactsSource } = createFacts({ clock });
  // The channels known to be private chats (a deferred call names only its channel).
  const privateChannels = new Set();
  const lastPostAt = new Map(); // channelId -> ts of the persona's last message
  let onIdle = null; // set via setOnIdle(); see the finally block of runTurn below
  let onTurnEnd = null; // set via setOnTurnEnd(); see noteTurnEnd
  let idleWaiters = []; // resolvers for waitIdle() (/nep pause), notified once busy.size hits 0
  // channelId -> ids of the messages in the history of the last turn that spoke there; for a
  // channel the bot cannot write in, the lines its `<channel_view>` block showed in the last
  // turn that spoke anywhere while showing it (noteSpokeSaw). The pending-ping drain
  // (src/behavior/pipeline.js) skips a ping such a turn already had in view.
  const spokeSaw = new Map();
  // Whether the last turn that wanted prompts['follow-up'] found it missing or blank: `turn:
  // prompt missing` is warned once each time this turns true (the turn falls back to reply.md).
  let followUpPromptMissing = false;
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
  async function runTurn(params) {
    // Every attempt that started in the journal (runTurnOnce), closed here, at the one exit.
    const attempts = [];
    // What every attempt posted in reply to and why it ended (runTurnOnce), for the end hook.
    const ends = { replyTargets: [], reasons: [], factsShown: null, info: null };
    const wake = params?.mode === 'diary' && !params.conversation ? await selfreflectionOf(params) : {};
    const tracked = { ...params, ...wake, journalAttempts: attempts, turnEnds: ends };
    let result;
    let thrown = null;
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
  async function selfreflectionOf({ guildId }) {
    const { conversation, channel, history } = await wakeInputs({
      store,
      conversationInfo: (ref) => ifaceReads.conversationInfo(ref, { audience: true, viewers: [] }),
      iface: portIface(iface),
      guildId,
      selfId: selfIdOf(),
      selfName: getSelfName(guildId),
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
  function noteFailedTurn(params, result, ends, thrown) {
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
  function recordTurnFacts(args, draft, result) {
    try {
      const channel = draft.info;
      if (!channel || result?.dryRun === true) return;
      const entries = [];
      if (draft.sendFailure) entries.push({ kind: 'sendFailed', ...draft.sendFailure });
      if (draft.loopCut?.dropped > 0)
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
  function noteTurnEnd(params, result, ends) {
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
    const end = {
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
      .then(() => onTurnEnd(end))
      .catch((err) => log.warn('turn: onTurnEnd failed', { error: err }));
  }

  /** Why a chain ends before its next part: `paused` (/nep pause), or null. */
  function chainStop() {
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
  async function runChain(params, { parts, history }) {
    const { trigger } = params;
    const channel = { id: params.conversation.conversationId };
    const total = parts.length;
    const chain = { authorId: trigger?.authorId ?? null, parts, next: 0, added: new Map() };
    chains.set(channel.id, chain);
    const results = [];
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
        let result;
        try {
          const once = await runTurnOnce({
            ...params,
            owned: true,
            part: { index, total, parts },
            reuseHistory: i === 0 ? history : null,
            // Messages folded into the whole call before it split go with its first part.
            added: [...(i === 0 && Array.isArray(params.added) ? params.added : []), ...(chain.added.get(index) ?? [])],
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
  function chainOutcome(results) {
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
  function notifyIdle() {
    if (onIdle) {
      Promise.resolve()
        .then(() => onIdle())
        .catch((err) => log.warn('turn: onIdle failed', { error: err }));
    }
    if (busy.size === 0 && idleWaiters.length > 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

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
      result = await runTurnAttempt(args, draft);
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
    // An inner turn reports what it did and proposed, and its turn id (the errands it handed off name it).
    const innerTurnId = draft.started?.turnId ?? draft.turnKey?.turnId ?? null;
    const innerPart = args.inner
      ? {
          inner: {
            actions: draft.innerActions ?? [],
            intentIds: [...(draft.innerIntentIds ?? [])],
            loop: draft.innerLoop ?? { ...NO_LOOP },
            ...(untoldDiagnostics(draft).length > 0 ? { diagnostics: untoldDiagnostics(draft) } : {}),
            ...(draft.innerOpenFollowUp === true ? { openFollowUp: true } : {}),
            turnId: innerTurnId,
          },
          ...(args.inner.shadow ? { shadow: true } : {}),
        }
      : {};
    return draft.started
      ? { ...result, ...innerPart, turnId: draft.started.turnId, attemptId: draft.started.attemptId }
      : { ...result, ...innerPart };
  }

  /**
   * runTurnOnce's body; `draft` collects what the journal's turn record needs (journalTurnRecord).
   * @param {{ conversation: import('../protocol/adapter.ts').ConversationRef, guildId?: string|null, standIn?: Conv|null, [key: string]: * }} params
   * @param {*} draft
   */
  async function runTurnAttempt(
    {
      conversation,
      guildId: guildIdParam = null,
      mode,
      trigger = null,
      triggerKind = null,
      chooseMode = null,
      forced = false,
      source = null,
      focus = null,
      queued = null,
      added = null,
      maySplit = false,
      owned = false,
      part = null,
      reuseHistory = null,
      plainPosts = false,
      diary: diaryParams = null,
      journalTurn = null,
      missed = null,
      stillDue = null,
      requester: requesterParam = null,
      taskResult = null,
      inner = null,
      standIn = null,
    },
    draft = {}
  ) {
    // The journal's preparation steps of this attempt (createPrepLedger): each an operation of
    // the engine, closed with whether its result reached the request.
    const prep = createPrepLedger();
    const prepStep = (stage, name, fields, offeredOf) => {
      const op = journalOp(draft, name, 'engine', fields);
      return op.opId ? prep.step(stage, op, offeredOf) : null;
    };
    // An inner turn (mode `inner`, src/behavior/inner.ts): her calls pass its gate (innerVerdict).
    if (inner && mode === 'inner') draft.inner = inner;
    // The turn a finished errand of her own opens (asked in an inner turn: requester kind
    // `persona`, no person behind it) is her own initiative too: her grants alone decide her calls.
    if (taskResult?.requester?.kind === 'persona' && !taskResult.requester.userId) draft.ownInitiative = true;
    // Set when this turn hands its message to a chain of parts: the chain keeps the attention.
    let chained = false;
    // /nep pause: the owner is editing data/ by hand -- no new turn may start (a reply, an interject, an initiate, an
    // eavesdrop, or a forced turn) until /nep resume. A turn already in flight when the pause is requested is left to
    // finish naturally; admin.js's pause handler waits for it via waitIdle() below instead of aborting it here.
    if (store.state.data.paused) return { outcome: 'paused' };
    // A chain's turn runs under the attention it holds; taken before anything is awaited, so two turns cannot both take it.
    const attentionId = conversation.conversationId;
    if (!owned && !takeAttention(busy, attentionId, hot.config)) return { outcome: 'busy' };
    const letGo = () => {
      if (owned) return;
      busy.delete(attentionId);
      notifyIdle();
    };
    // The conversation as the interface describes it now (a wake's own, `standIn`); one it no longer knows ends the turn.
    const found = standIn
      ? { conversation: standIn }
      : await ifaceReads.conversationInfo(conversation, { audience: true, viewers: [] });
    if (found === null) {
      letGo();
      log.warn('turn: conversation unavailable', { channel: conversation.conversationId });
      return { outcome: 'unavailable' };
    }
    const channel = found.conversation;
    draft.info = channel;
    // A conversation of a community carries it; a private chat is served on behalf of the pinned one.
    const guildId = channel.communityId ?? guildIdParam;
    if (!guildId) {
      letGo();
      throw new Error('runTurn: a private chat needs a guildId');
    }
    const isPrivate = !inCommunity(channel);
    // The journal (features.journal, read now): the turn starts here, past the pause and
    // attention rails; a later attempt of the same turn (journalTurn) keeps its id.
    if (journalOn()) {
      draft.guildId = guildId;
      draft.channelId = channel.id;
      draft.privateUserId = isPrivate ? (trigger?.authorId ?? channel.partnerId ?? null) : null;
      draft.mode = mode;
      draft.started = journal.start(
        guildId,
        journalStartOf({ draft, channel, trigger, triggerKind, mode, journalTurn })
      );
    }
    // A turn answering a person first lets them finish writing (pace.settleMs), holding the
    // attention meanwhile; the turn's clocks (its deadline, its bar) start after this wait. The
    // first part of a split message reuses the history its message already waited for. The
    // author's activity is read in the trigger's own channel (a routed call's turn posts elsewhere).
    const settledMs =
      mode === 'reply' && !reuseHistory ? await settleAuthor(trigger?.channelId ?? channel.id, trigger) : 0;
    // The typing indicator, the preparation's deadline and the turn's bar, ended in `finally`
    // whatever the outcome; the start and the mode a dropped turn logs.
    let stopTyping = () => {};
    let deadline = null;
    let bar = null;
    // The attempt's turn planner (createTurnPlan), abandoned in `finally` if it never started.
    let planner = null;
    const turnStartedAt = clock();
    let turnMode = mode;
    try {
      const config = hot.config;
      const features = config.features ?? {};
      // How her tools travel this turn (tools.transport, read once): native tool calls, or text blocks.
      const transport = transportOf(config);
      draft.transport = transport;
      const memoryOn = features.memory !== false;
      const selfId = selfIdOf();
      const selfName = getSelfName(guildId);
      const now = turnStartedAt;
      const startedAt = now;
      // A forced diary picture kind (/nep diary post <kind>) the post may not carry is refused before any request.
      const kind = mode === 'diary' ? diaryParams?.kind : null;
      const pictureRefusal = forcedPictureRefusal({ config, kind, gate: () => diaryPictureGate(config, channel, now) });
      if (pictureRefusal) return pictureRefusal;
      // The turn's pace: an unhurried turn (spontaneous or overheard, pace.unpromptedWaits on) has no bar or deadline.
      const pace = paceSettings(config);
      const waitsForAll = unhurried(triggerKind, pace);
      // The bar (pace.dropAfterMs, from the turn's start): the answer must be in hand by then, or the turn is dropped
      // unposted. At the bar every wait below gives up (beforeBar throws TOO_SLOW), the typing stops and the reply request
      // is aborted.
      bar = createDeadline({ clock, startedAt, schedule, limitMs: waitsForAll ? null : pace.dropAfterMs });
      const barAbort = new AbortController();
      bar.reached.then(() => {
        stopTyping();
        barAbort.abort();
      });
      const beforeBar = (promise) =>
        bar.leftMs() === null
          ? promise
          : Promise.race([
              promise,
              bar.reached.then(() => {
                throw TOO_SLOW;
              }),
            ]);
      const replyOptions = () => replyOptionsOf(hot.config, { draft, bar, barAbort });
      // Someone asked for this turn (askedFor): not a spontaneous or an overheard one.
      const asked = askedFor(trigger, triggerKind);
      // A turn a returned errand opened answers with its result: the engine's own search
      // (the classifier, the planner's lookup block) is not run on the original request, so no
      // <lookup> block stands beside the result. Her own recall call still runs.
      const answersTask = triggerKind === 'errand';
      // features.coreTools (read now): she calls her own tools in the turn, so no search classifier
      // (nor the planner's lookup or skills block) runs before her reply.
      const coreTools = coreToolsOn(config);
      // Skills discovery: the `skills:` line of the search classifier or the planner (parseSkillsLines).
      let skillsAnswer = null;
      // A direct call sees the persona typing while the turn prepares.
      stopTyping = typingWhilePreparing(channel, triggerKind, config);

      // A private chat's partner as a guild member (features.privateLikeServer), fetched beside
      // the history; null on a server turn, with the switch off or when the fetch fails.
      const partnerPending = isPrivate
        ? privatePartner({ guildId, userId: trigger?.authorId ?? channel.partnerId ?? null, config })
        : Promise.resolve(null);
      // The groups the requester holds in the community, read once: the rights of her calls are checked against them.
      const requesterPending =
        !isPrivate && trigger?.authorId
          ? ifaceReads.memberInfo({ communityId: guildId, memberId: String(trigger.authorId) })
          : Promise.resolve(null);
      // The community's listing, once for the attempt (neighbours, pulls, routing, places, audience rails); a private
      // chat is listed for its partner's sake.
      const partnerHint = isPrivate ? (trigger?.authorId ?? channel.partnerId ?? null) : null;
      const snapshotPending = takeSnapshot(ifaceReads, guildId, partnerHint ? [String(partnerHint)] : []);
      const emojiPending = refreshEmojiIfOn(emoji, config);
      const historyStartedAt = clock();
      const snapshot = /** @type {Snap|null} */ (await beforeBar(snapshotPending));
      draft.snapshot = snapshot;
      // The first part of a split message reuses the history its message's turn fetched.
      // Part of the history: the messages replies of the window answer from outside it
      // (context.fetchReplyParents), prepended as its oldest lines (withReplyParents). The
      // persona's own lines carry the message that started their turn (linkTriggers) and the
      // skill calls she made (linkCalls), so the request and every analyzer transcript built from
      // this history name them.
      const rawHistory = linkCalls(
        linkTriggers(
          reuseHistory ??
            (await beforeBar(
              readHistory(channel, config, { inner: Boolean(draft.inner), draft, guildId }).then((lines) =>
                withReplyParents(ifaceReads, channel, lines, { trigger, config })
              )
            ))
        ),
        { channel, snapshot, guildId }
      );
      const historyMs = clock() - historyStartedAt;
      const partner = await beforeBar(partnerPending);
      await beforeBar(emojiPending);
      draft.requesterGroups = (await beforeBar(requesterPending))?.member?.groupIds ?? [];
      // A private chat on its partner's behalf: pulls and the server search from the served community (none otherwise).
      const likeServer = isPrivate && partner !== null;
      const servedGuild = isPrivate && !likeServer ? null : { id: guildId };
      const servedSnapshot = servedGuild ? snapshot : null;
      // What the analyzer requests judge: the trigger, or on a part of a split message the trigger with
      // that part's text (same id, author and time).
      const candidate =
        part && trigger ? { ...trigger, content: part.parts[part.index - 1] ?? trigger.content } : trigger;
      // The history the request is built from: with its file previews once they are ready (below).
      let history = rawHistory;
      // The automatic memory prefetch (features.coreTools with features.memoryPrefetch): started now,
      // alongside the preparation, bounded by its own deadline (startPrefetch).
      const prefetching = startPrefetch({
        config,
        channel,
        snapshot: servedSnapshot,
        guildId,
        guild: servedGuild,
        partner: isPrivate ? partner : null,
        trigger,
        candidate,
        triggerKind,
        mode,
        history: rawHistory,
        selfId,
        selfName,
        nameOf: memoryOn ? (id) => store.getUser(guildId, id)?.names?.[0] ?? null : null,
        journalStep: prepStep,
        wake: draft.inner?.wake ?? null,
      });
      // A diary post plans itself first (prepareDiary), alongside the preparation below; settled
      // into a value or an error so a refusal waits for its turn to be thrown.
      const diaryPending =
        mode === 'diary'
          ? prepareDiary({
              config,
              guildId,
              channel,
              selfName,
              history: rawHistory,
              now,
              params: diaryParams,
              memoryOn,
              draft,
            }).then(
              (value) => ({ value }),
              (error) => ({ error })
            )
          : null;

      // The searches this turn may run (maybeLookup): the web search (features.webLookup -- unlike
      // the other switches a missing key counts as OFF: it costs money and the search needs a key)
      // and the server search (a private chat only on its partner's behalf). Asked once, so the
      // lookup stage, the planner's offer and `<senses>` agree.
      const webLookupOn = features.webLookup === true && Boolean(lookup);
      const webSearchOn = webLookupOn && config.web?.search?.enabled !== false && typeof lookup.search === 'function';
      const serverOn = (!isPrivate || likeServer) && recallAvailable();
      // The turn planner (features.turnPlanner exactly true, read now; never for an inner turn):
      // one request for the route, the participation pick, the
      // re-watch and the search classifier, none of which is asked then. It starts in the pull's
      // route step on a turn that waits for its pull (a source, or a mode still to choose), else
      // once the file previews are in (below), like the search classifier did.
      planner =
        plannerOn(config) && !draft.inner
          ? createTurnPlan({
              config,
              channelId: channel.id,
              selfName,
              triggerKind,
              limits: draft.limits ?? null,
              early: Boolean(source) || mode === 'auto',
            })
          : null;
      // The planner's `skills:` line, once it answered (skills discovery, read when the request is built).
      planner?.result.then((plan) => {
        if (!coreTools) skillsAnswer ??= plan?.blocks?.skills ?? null;
      });
      // What the planner is sent: the search classifier's transcript of `lines` (with the captions,
      // video states and page reads given) and candidate, the participation pick's episodes, the
      // re-watch's media (`media`, prepared by the caller) and whether a search could run.
      const plannerStart = ({ lines, descriptions, videos, reads, media = null }) => {
        const judged = routeCandidate(lines, candidate);
        const context = judged
          ? classifierContext({
              config,
              selfName,
              history: lines,
              trigger: judged,
              contextMessages: Math.max(0, Math.floor(config.web?.search?.contextMessages ?? 50)),
              descriptions,
              videos,
              reads,
            })
          : null;
        let episodes = null;
        if (participationOn(channel, config) && mode !== 'diary') {
          try {
            const units = hot.prompts?.labels?.units;
            episodes = participationEpisodeOffer({
              store,
              guildId,
              channel,
              snapshot,
              audience: participationAudience(channel, config, snapshot),
              config,
              units,
              selfName,
              now: clock(),
            });
          } catch (err) {
            log.warn('participation: failed', {
              channel: channel.id,
              reason: 'error',
              status: null,
              name: err?.name ?? null,
            });
          }
        }
        const lookupWanted =
          asked &&
          !answersTask &&
          !coreTools &&
          (webSearchOn || serverOn) &&
          lookupGate({ config, webOn: webSearchOn, serverOn }).skip === null;
        planner.start({
          transcriptBlock: context?.transcriptBlock ?? '',
          candidateBlock: judged ? block('candidate', `${judged.authorName}: ${context.triggerText}`) : null,
          episodes,
          media,
          lookup: lookupWanted,
        });
      };
      // The planner's route step (pullChannels' routePlan): this turn's channel list as the route
      // hook would build it (features.channelRoute, routeAllowed, its candidate), then the pick of
      // the planner's channel block, mapped back to its id.
      const routePlan = planner
        ? async ({ lines, routed }) => {
            const settings = routeSettings(config);
            const allowed = inCommunity(channel)
              ? routeAllowed({ triggerKind })
              : Boolean(servedGuild && partner) && triggerKind === 'private';
            const judged = routeCandidate(lines, candidate);
            if (settings && allowed && judged) {
              try {
                planner.offerChannels(
                  routeChannelOffer({
                    store,
                    guildId,
                    channel,
                    snapshot: servedSnapshot,
                    partnerId: partner?.id ?? null,
                    candidate: judged,
                    config,
                    settings,
                    now: clock(),
                  })
                );
              } catch (err) {
                log.warn('pull: route failed', { channel: channel.id, error: err });
              }
            }
            if (planner.early) plannerStart({ lines, descriptions: routed?.descriptions });
            const plan = await planner.result;
            const answer = plan.blocks.channel;
            const id = answer.state === 'ok' ? plan.offer.channel?.ids?.[answer.index - 1] : null;
            return typeof id === 'string' && id
              ? [{ id, direction: answer.direction === 'earlier' ? 'earlier' : null }]
              : [];
          }
        : null;

      // The other channels this turn shows (`<channel_view>`, pullChannels), found and fetched
      // before the mode is chosen so a chooser sees them. Fresh captions only for a turn certain
      // to run: with the fetch when no chooser can still say not-now, else once it chose
      // (captionAll). A turn about another channel, or one with a chooser, waits for them here;
      // any other turn fetches them alongside the preparation below. A private chat only on its
      // partner's behalf (likeServer), judged against the partner.
      // The block renders only under `labels.pull.header` (read now, as buildRequest reads it):
      // without it no channel is fetched for a mention or the route hook and no fresh caption
      // is paid for; a turn's source is still pulled (its chooser and a routed call's search
      // classifier read it).
      const certain = mode !== 'auto';
      const pullLabelled = Boolean(hot.prompts?.labels?.pull?.header);
      const pullStartedAt = clock();
      const pullsPending =
        isPrivate && !likeServer
          ? Promise.resolve({ pulled: [], sourceSkip: null })
          : pullChannels({
              channel,
              guildId,
              snapshot: servedSnapshot,
              partner,
              history,
              trigger,
              candidate,
              triggerKind,
              source,
              selfName,
              config,
              now,
              certain,
              labelled: pullLabelled,
              routePlan,
            })
              // Never fails the turn: anything unexpected is no pull (and no source).
              .catch((err) => {
                log.warn('pull: failed', { channel: channel.id, error: err });
                return { pulled: [], sourceSkip: source ? 'error' : null };
              });
      const early = source || !certain ? await beforeBar(pullsPending) : null;
      if (early?.sourceSkip) {
        // Nothing to answer, or nothing to comment on: the source is gone or refused.
        if (source.reason !== 'routed') return { outcome: 'not-now' };
        log.warn('turn: source unavailable', {
          channel: channel.id,
          source: source.channelId,
          reason: early.sourceSkip,
        });
        return { outcome: 'error' };
      }

      let finalMode = mode;
      if (mode === 'auto') {
        finalMode = chooseMode(history, now, { pulled: early.pulled });
        if (!finalMode) return { outcome: 'not-now' };
      }
      turnMode = finalMode;
      // Ready before the request is built; pulled ahead of a chooser, they get their fresh
      // captions now (only when the block can render).
      const pulledPending = !early
        ? pullsPending.then((pulls) => pulls.pulled)
        : certain || !pullLabelled
          ? Promise.resolve(early.pulled)
          : captionAll(early.pulled, { guildId, config, destination: channel });
      // A routed call lives in its source: the search classifier reads the source's lines around
      // it, with their captions, instead of this chat; the re-watch is not offered (below).
      const routedPull =
        source?.reason === 'routed'
          ? (early?.pulled.find((entry) => entry.channelId === source.channelId) ?? null)
          : null;

      // Everything below starts as soon as its inputs exist and runs alongside the rest; the turn
      // waits for all of it together, at most until the deadline (paceSettings, counted from the
      // turn's start; longer once the search classifier asked for a search -- held for its verdict
      // up to pace.prepareSearchMs while it is out -- or for a direct call that brought media to
      // look at). A stage still running then contributes nothing -- its block
      // is absent, as when it fails -- and keeps running for its cache; nothing it settles later
      // reaches this turn. A stage whose inputs were not ready by then is never started. An
      // unhurried turn has no deadline: it waits for every stage (a
      // search asked for leaves it so: extend never sets a limit on a deadline without one).
      deadline = createDeadline({ clock, startedAt, schedule, limitMs: waitsForAll ? null : pace.prepareMs });
      const stages = new Map();
      const track = (name, work, from = clock()) => {
        const stage = trackStage(work, {
          clock,
          startedAt: from,
          onError: (err) => log.warn('turn: stage failed', { channel: channel.id, stage: name, error: err }),
        });
        stages.set(name, stage);
        return stage;
      };
      // A chain that starts a stage once another settled: never rejects, never fails the turn.
      const chainFailed = (name) => (err) =>
        log.warn('turn: stage failed', { channel: channel.id, stage: name, error: err });

      const prefetchStage = prefetching ? track('prefetch', () => prefetching.pending) : null;

      // Lazy, request-time only (see fetchTextPreview's header comment):
      // never fetched during plain normalization or while just buffered. Read by the
      // transcripts alone: the request's and the two classifiers'.
      const previews = track('previews', () =>
        withTextPreviews(
          asList(rawHistory),
          Number(config.media?.filePreviewChars ?? 10000),
          /** @type {typeof fetch} */ (fetchImpl)
        )
      );
      const previewed = () => (previews.done && Array.isArray(previews.value) ? previews.value : rawHistory);

      // The pictures of the window get a `vision` caption, newest first, capped at
      // media.maxPerTurn; cached captions are free (see src/memory/describe.js). The caption is
      // the only way a picture reaches the persona: none goes into her request as an image. A
      // routed call's own pictures are captioned with its pulled channel instead.
      let captions = null;
      let captionCandidates = [];
      if (features.mediaDescriptions === true && describer) {
        captionCandidates = describableCandidates(rawHistory);
        const describeOp =
          captionCandidates.length > 0
            ? prepStep('captions', 'describe', { input: { candidates: captionCandidates.length } })
            : null;
        captions = track('captions', () =>
          journalled(
            describeOp,
            () => describer.describeMany(guildId, captionCandidates, { maxNew: config.media?.maxPerTurn ?? 6 }),
            (value) => {
              const count = value?.descriptions?.size ?? 0;
              return { result: { count }, offered: count > 0 };
            }
          )
        );
      }
      // The captions a classifier's transcript shows: this turn's once they are done, else what
      // the describer's cache holds at the classifier's start (a fresh caption lands there).
      const captionsSoFar = () => {
        if (!captions) return undefined;
        if (captions.done) return captions.value?.descriptions;
        try {
          return typeof describer.cachedDescriptions === 'function'
            ? describer.cachedDescriptions(guildId, captionCandidates)
            : undefined;
        } catch {
          return undefined;
        }
      };

      // The splitter (runTurn's first turn only): a call that may hold several requests asks it
      // now, beside everything else and under the same deadline. The turn waits for it as for any
      // stage; parts in time end the wait at once (below). Without prompts.split it is off
      // (`split: skipped`, `no-prompt`); without labels.task.part (an older labels file) it is
      // never asked. A routed call is read in its source, as the search classifier reads it.
      let splitStage = null;
      if (maySplit && splitCandidate(trigger, triggerKind, config)) {
        const splitPrompt = hot.prompts?.split;
        if (!splitPrompt) {
          log.info('split: skipped', { channel: channel.id, reason: 'no-prompt' });
        } else if (hot.prompts?.labels?.task?.part) {
          const shown = captionsSoFar();
          splitStage = track('split', () =>
            maybeSplit({
              config,
              channelId: channel.id,
              selfName,
              history: routedPull ? routedPull.messages : rawHistory,
              trigger,
              descriptions: routedPull ? new Map([...(shown ?? []), ...routedPull.descriptions]) : shown,
              prompt: splitPrompt,
              isLate: () => deadline.passed,
            })
          );
        }
      }
      const hasParts = () => Boolean(splitStage?.done) && Array.isArray(splitStage.value);

      // Videos (attached, or linked from a known video site) may be watched
      // by the video describer, newest first, at most media.video.maxPerTurn
      // NEW ones per turn; cached results and limit/error states are free.
      let videoStage = null;
      let rewatchStage = null;
      let rewatchChain = null;
      let videoCandidates = [];
      // Both switches (isVideoVisionOn), like the senses line; a missing videoDescriptions counts as on.
      if (isVideoVisionOn(config) && typeof describer?.describeVideos === 'function') {
        const videoCfg = config.media?.video ?? {};
        for (let i = rawHistory.length - 1; i >= 0; i -= 1) {
          videoCandidates.push(...collectVideos(rawHistory[i], { videoSites: videoCfg.sites }));
        }
        const candidates = videoCandidates;
        const watchOp =
          candidates.length > 0
            ? prepStep('videos', 'watch-video', { input: { candidates: candidates.length } })
            : null;
        const watchStartedAt = clock();
        videoStage = track('videos', () =>
          journalled(
            watchOp,
            () => describer.describeVideos(guildId, candidates, { maxNew: videoCfg.maxPerTurn ?? 5 }),
            (value) => {
              const states = value?.videos instanceof Map ? [...value.videos.values()] : [];
              return {
                result: {
                  seconds: Math.round((clock() - watchStartedAt) / 100) / 10,
                  watched: states.filter((state) => state?.state === 'watched').length,
                },
                offered: states.length > 0,
              };
            }
          )
        );
      }

      // A second look when the trigger asks about a watched video or a posted picture: a
      // direct address only (never a spontaneous or an overheard turn). Videos under features.videoRewatch (with the video stage), watched GIFs under
      // features.videoRewatch and video vision, pictures under features.imageRelook (a missing
      // key counts as on, each; the look runs through the vision model), the persona's own
      // posted drawings included.
      // A routed call asks about its source, whose media no turn looks at: the media
      // here belong to another conversation, so nothing is offered or retried.
      // It needs the videos' states and its transcript the file previews; it works on a
      // copy of the states, so a late re-watch never touches what the request was built from.
      const videoRewatchOn =
        Boolean(videoStage) && features.videoRewatch !== false && typeof describer.rewatchVideo === 'function';
      const imageRelookOn = features.imageRelook !== false && typeof describer?.relookImage === 'function';
      // Watched GIFs under features.videoRewatch and video vision (they are watched as clips);
      // the describer's watchedGifs offers none while GIFs are not watched (media.gif.watch).
      const gifRewatchOn =
        isVideoVisionOn(config) &&
        features.videoRewatch !== false &&
        typeof describer?.rewatchGif === 'function' &&
        typeof describer.watchedGifs === 'function';
      // The items a second look may be offered for (the re-watch, or the planner's `<media>`).
      // With features.coreTools no classifier picks a second look for her: she calls media.look.
      const mediaWanted = asked && (videoRewatchOn || imageRelookOn || gifRewatchOn) && !routedPull && !coreTools;
      const pictures = mediaWanted && imageRelookOn ? relookCandidates(rawHistory) : [];
      const gifItems = mediaWanted && gifRewatchOn ? gifRewatchItems(rawHistory) : [];
      if (asked && (videoRewatchOn || imageRelookOn || gifRewatchOn)) {
        if (coreTools) {
          log.info('rewatch: skipped', { channel: channel.id, reason: 'core-tools' });
        } else if (routedPull) {
          log.info('rewatch: skipped', { channel: channel.id, reason: 'routed' });
        } else if (planner) {
          // The planner's re-watch block picks the item and the question (its `<media>` built by
          // plannerMedia below); the second look itself waits for the video stage, as before.
          rewatchChain = planner.result
            .then(async (plan) => {
              const offer = plan.offer.media;
              const answer = plan.blocks.rewatch;
              if (!offer || answer.state !== 'ok') return undefined;
              await videoStage?.settled;
              if (deadline.passed) return undefined;
              rewatchStage = track('rewatch', async () => {
                const own = new Map(videoStage?.value?.videos ?? offer.states);
                const imageAnswers = new Map();
                try {
                  await applyRewatch({
                    guildId,
                    channelId: channel.id,
                    offer,
                    pick: answer.pick,
                    reason: answer.parse,
                    videos: own,
                    imageAnswers,
                  });
                } catch (err) {
                  log.warn('rewatch: failed', { channel: channel.id, error: err });
                }
                // The video states only when videos were offered; otherwise the video stage's stand.
                return { videos: offer.offersVideos ? own : null, imageAnswers };
              });
              return rewatchStage.settled;
            })
            .catch(chainFailed('rewatch'));
        } else {
          rewatchChain = Promise.all([videoStage?.settled, previews.settled])
            .then(() => {
              const watched = videoStage?.value?.videos;
              const offersVideos = videoRewatchOn && Boolean(watched);
              // Read from the cache now, after the stages above: a GIF watched meanwhile counts.
              const gifCaptions = gifItems.length > 0 ? describer.watchedGifs(guildId, gifItems) : new Map();
              const gifs = gifItems.filter((item) => gifCaptions.has(item.itemId));
              if (deadline.passed || (!offersVideos && !imageRelookOn && gifs.length === 0)) return undefined;
              rewatchStage = track('rewatch', async () => {
                const own = new Map(watched ?? []);
                const imageAnswers = new Map();
                try {
                  await maybeRewatch({
                    config,
                    guildId,
                    channelId: channel.id,
                    selfName,
                    history: previewed(),
                    trigger: candidate,
                    videos: own,
                    descriptions: captionsSoFar(),
                    candidates: offersVideos ? videoCandidates : [],
                    gifs,
                    gifCaptions,
                    pictures,
                    imageAnswers,
                  });
                } catch (err) {
                  log.warn('rewatch: failed', { channel: channel.id, error: err });
                }
                // The video states only when videos were offered; otherwise the video stage's stand.
                return { videos: offersVideos ? own : null, imageAnswers };
              });
              return rewatchStage.settled;
            })
            .catch(chainFailed('rewatch'));
        }
      }
      // A direct call that brought something to look at -- on its own message or the one it
      // replies to, captioned or watched by the stages above -- is about that thing: its deadline
      // grows to pace.prepareMediaMs (null: no extension). A search asked for later may grow it
      // further; extend keeps the larger limit, and never sets one on a deadline without one. The
      // hold for the search classifier's verdict (pace.prepareSearchMs) does nothing under a larger limit.
      if (
        trigger &&
        DIRECT_CALLS.has(triggerKind) &&
        pace.prepareMediaMs !== null &&
        triggerBringsMedia(trigger, captionCandidates, videoCandidates)
      ) {
        deadline.extend(pace.prepareMediaMs);
      }
      // The video states a classifier's transcript shows: this turn's once they are done (with the
      // re-watch's answer when it is done too), else what the describer's cache holds.
      const videosSoFar = async () => {
        if (!videoStage) return undefined;
        if (rewatchStage?.done && rewatchStage.value?.videos) return rewatchStage.value.videos;
        if (videoStage.done) return videoStage.value?.videos;
        try {
          return typeof describer.cachedVideos === 'function'
            ? await describer.cachedVideos(guildId, videoCandidates)
            : undefined;
        } catch {
          return undefined;
        }
      };

      // The web lookup (features.webLookup -- unlike the other switches a
      // missing key counts as OFF: it costs money and the search needs a
      // key). The links: the newest readable links of the history, at most
      // web.links.maxPerTurn NEW reads (cached excerpts are free). Beside them, on a
      // direct address only (not an overheard line), the search classifier
      // when the web search or the server search (recall; a private chat only
      // on its partner's behalf) can run, and what its answer asks for of the two, in parallel.
      let linksStage = null;
      const webCfg = config.web ?? {};
      // Cache only: no fetch, no model request, no daily slot (src/web/lookup.js#cachedReads).
      const cachedLinkReads = () => {
        if (!linksStage || typeof lookup?.cachedReads !== 'function') return undefined;
        try {
          return lookup.cachedReads(guildId, readableLinkCandidates(rawHistory, config.media?.video?.sites));
        } catch (err) {
          log.warn('lookup: links failed', { channel: channel.id, error: err });
          return undefined;
        }
      };
      if (webLookupOn && webCfg.links?.enabled !== false && typeof lookup.readLinks === 'function') {
        linksStage = track('links', async () => {
          try {
            const candidates = readableLinkCandidates(rawHistory, config.media?.video?.sites);
            // The journal: the link reads as one operation of the engine, hosts only.
            const readOp =
              candidates.length > 0
                ? prepStep('links', 'read-link', { input: { hosts: linkHosts(candidates) } })
                : null;
            const read = await journalled(
              readOp,
              () => lookup.readLinks(guildId, candidates, { maxNew: webCfg.links?.maxPerTurn ?? 2 }),
              (value) => {
                const reads = value?.reads instanceof Map ? value.reads : new Map();
                const chars = [...reads.values()].reduce(
                  (sum, text) => sum + (typeof text === 'string' ? text.length : 0),
                  0
                );
                return {
                  result: { hosts: linkHosts(candidates.filter((link) => reads.has(link.id))), chars },
                  offered: reads.size > 0,
                };
              }
            );
            return read.reads;
          } catch (err) {
            log.warn('lookup: links failed', { channel: channel.id, error: err });
            return undefined;
          }
        });
      }
      // The search classifier's transcript needs the file previews; the captions, video states and
      // page reads it shows are what this turn has at its start (captionsSoFar, videosSoFar, the
      // reads once done). A routed call is read in its source (routedPull), with its captions.
      let lookupStage = null;
      let lookupChain = null;
      // `serverOn` (above): the lookup stage runs the server search and `<senses>` says it exists.
      if (asked && !answersTask && coreTools && (webSearchOn || serverOn))
        log.info('lookup: skipped', { channel: channel.id, reason: 'core-tools' });
      if (asked && !answersTask && !coreTools) {
        const webOn = webSearchOn;
        if (webOn || serverOn) {
          lookupChain = previews.settled
            .then(() => {
              if (deadline.passed) return undefined;
              lookupStage = track('lookup', async () => {
                try {
                  const chat = previewed();
                  const shown = captionsSoFar();
                  const videosShown = await videosSoFar();
                  return await maybeLookup({
                    config,
                    guildId,
                    channel,
                    snapshot: servedSnapshot,
                    partner,
                    selfId,
                    selfName,
                    history: routedPull ? routedPull.messages : chat,
                    chatHistory: chat,
                    trigger: candidate,
                    descriptions: routedPull ? new Map([...(shown ?? []), ...routedPull.descriptions]) : shown,
                    videos: videosShown,
                    // Link reads of this turn when they are in, else what the link cache already holds.
                    reads: linksStage?.done ? linksStage.value : cachedLinkReads(),
                    webOn,
                    serverOn,
                    onSearch: () => deadline.extend(pace.prepareSearchMs),
                    onSkills: (answer) => {
                      skillsAnswer = answer;
                    },
                    journalStep: prepStep,
                    triggerKind,
                    limits: draft.limits ?? null,
                    // With the planner its lookup block stands in for the search classifier.
                    planned: planner ? await planner.result : null,
                    turnContext: () => turnContextOf(draft, channel),
                  });
                } catch (err) {
                  log.warn('lookup: failed', { channel: channel.id, error: err });
                  return null;
                }
              });
              // Until the classifier's verdict the deadline waits for it, at most until
              // pace.prepareSearchMs: a search it asks for has moved the deadline there by the time
              // the stage ends; no search lets a limit that passed meanwhile pass at once.
              deadline.hold(lookupStage.settled, pace.prepareSearchMs);
              return lookupStage.settled;
            })
            .catch(chainFailed('lookup'));
        }
      }

      // The turn planner, unless its route step started it already: once the file previews are in
      // (and, when a watched video may be offered a second look, once the video stage settled, as
      // the re-watch waited), with what this turn has then -- the search classifier's transcript
      // (a routed call read in its source) and the re-watch's `<media>` (plannerMedia). A deadline
      // already passed sends nothing: every block keeps its default.
      if (planner && !planner.started) {
        const plannerMedia = (watched) => {
          const offersVideos = videoRewatchOn && Boolean(watched);
          // Read from the cache now, after the stages above: a GIF watched meanwhile counts.
          const gifCaptions = gifItems.length > 0 ? describer.watchedGifs(guildId, gifItems) : new Map();
          const gifs = gifItems.filter((item) => gifCaptions.has(item.itemId));
          if (!offersVideos && !imageRelookOn && gifs.length === 0) return null;
          const offer = rewatchOffer({
            config,
            channelId: channel.id,
            history: previewed(),
            videos: new Map(watched ?? []),
            descriptions: captionsSoFar(),
            candidates: offersVideos ? videoCandidates : [],
            gifs,
            gifCaptions,
            pictures,
          });
          return offer ? { ...offer, offersVideos } : null;
        };
        const videosFirst = mediaWanted && videoRewatchOn && videoCandidates.length > 0 ? videoStage?.settled : null;
        Promise.all([previews.settled, videosFirst])
          .then(async () => {
            if (planner.started) return;
            if (deadline.passed) {
              planner.abandon('late');
              return;
            }
            const chat = previewed();
            const shown = captionsSoFar();
            const videosShown = await videosSoFar();
            plannerStart({
              lines: routedPull ? routedPull.messages : chat,
              descriptions: routedPull ? new Map([...(shown ?? []), ...routedPull.descriptions]) : shown,
              videos: videosShown,
              reads: linksStage?.done ? linksStage.value : cachedLinkReads(),
              media: mediaWanted ? plannerMedia(videosShown) : null,
            });
          })
          .catch((err) => {
            log.warn('turn: stage failed', { channel: channel.id, stage: 'planner', error: err });
            planner.abandon('error');
          });
      }

      // A private chat has no neighbouring channels. A neighbour passes the audience rail the
      // pulls pass (audienceAllows, context.pull.sameAudience): everyone who can read this channel
      // can read it. One refused takes no slot, costs no fetch, and never reaches `<server>`
      // either (buildRequest maps only the neighbours it is given); counted on the answer's log.
      const neighborsStage = isPrivate
        ? null
        : track('neighbors', async () => {
            let hidden = 0;
            const accept = (/** @type {Conv} */ other) => {
              const allowed = audienceAllows(channel, other, config);
              if (!allowed) hidden += 1;
              return allowed;
            };
            // Without the listing (the interface does not offer it) there are no neighbours to show.
            const found = snapshot
              ? await fetchNeighbors(ifaceReads, snapshot, channel, asObject(config), now, { accept })
              : [];
            return { neighbors: found, hidden };
          });
      // The pulled channels started earlier: timed from their own start.
      const pulledStage = isPrivate && !likeServer ? null : track('pulled', () => pulledPending, pullStartedAt);
      // `<participation>`: the persona's own exchanges on other channels this turn may show, and
      // the pick classifier's choice among them (src/behavior/participation-pick.js; it asks
      // nothing when there is no episode to offer). Late or failed, the newest are shown.
      const participationShown = participationOn(channel, config) && finalMode !== 'diary';
      const participationAudienceOf = participationShown ? participationAudience(channel, config, snapshot) : null;
      const participationStage = participationShown
        ? track('participation', () =>
            planner
              ? // The planner's episodes block, mapped back to the episode ids it was offered.
                planner.result.then((plan) => {
                  const answer = plan.blocks.episodes;
                  const ids = plan.offer.episodes?.ids ?? [];
                  return answer.state === 'ok' ? answer.indices.map((n) => ids[n - 1]).filter(Boolean) : [];
                })
              : pickParticipation({
                  guildId,
                  channel,
                  snapshot,
                  history: rawHistory,
                  trigger: candidate,
                  triggerKind,
                  mode: finalMode,
                  selfName,
                  audience: participationAudienceOf,
                  limits: draft.limits,
                })
          )
        : null;

      // Parts in time end the wait at once: the whole message's preparation is set aside.
      const partsReady = splitStage
        ? splitStage.settled.then(() => (hasParts() ? undefined : new Promise(() => {})))
        : null;
      await beforeBar(
        Promise.race([
          Promise.all([
            previews.settled,
            captions?.settled,
            videoStage?.settled,
            rewatchChain,
            linksStage?.settled,
            lookupChain,
            neighborsStage?.settled,
            pulledStage?.settled,
            participationStage?.settled,
            splitStage?.settled,
            prefetchStage?.settled,
          ]),
          deadline.reached,
          ...(partsReady ? [partsReady] : []),
        ])
      );
      if (hasParts()) {
        // The message holds several requests: runChain answers them, this turn's attention kept.
        deadline.close();
        chained = true;
        return { outcome: 'split', parts: splitStage.value, history: rawHistory };
      }
      deadline.close();
      const prepareMs = clock() - startedAt;
      // What this turn has: a stage still running is left out (named in `late`).
      const late = PREPARE_STAGES.filter((name) => stages.has(name) && !stages.get(name).done);
      for (const name of late) {
        draft.limits?.add({ kind: 'helper-timeout', where: name });
        const stage = stages.get(name);
        stage.settled.then(() => log.info('turn: stage late', { channel: channel.id, stage: name, ms: stage.ms }));
      }
      const timings = { history: historyMs };
      for (const name of PREPARE_STAGES.slice(1)) timings[name] = stages.get(name)?.done ? stages.get(name).ms : null;
      history = previewed();
      // Messages deleted inside the window: the record's `deleted` lines over its span in this one
      // channel, each the history lacks put back as a placeholder at its own place (never in a
      // private chat); its read takes `timings.record`.
      timings.record = null;
      if (!isPrivate && record && features.record === true && typeof record.iterate === 'function') {
        const found = await deletedLinesOf({
          record,
          guildId,
          channelId: channel.id,
          history,
          selfId,
          selfName,
          nameOf: memoryOn ? (id) => store.getUser(guildId, id)?.names?.[0] ?? null : null,
          max: deletedLinesMax(config.context),
          clock,
        });
        timings.record = found.ms;
        if (found.failed) log.warn('turn: deleted lines failed', { channel: channel.id });
        draft.deletedIds = found.deletedIds;
        history = withDeletedLines(history, found.placeholders);
      }
      // A text attachment cut at media.filePreviewChars (src/media/text-preview.ts#withTextPreviews).
      for (const message of history) {
        for (const attachment of message.attachments ?? []) {
          if (attachment?.previewLost > 0)
            draft.limits?.add({
              kind: 'preview-cut',
              where: message.id,
              lost: attachment.previewLost,
              detail: attachment.id,
            });
        }
      }
      const descriptions = captions?.done ? captions.value?.descriptions : undefined;
      // A video stage past the deadline: the cached states stay, and the videos it was still
      // watching render not watched (`pending`) instead of as a bare still frame.
      const videos =
        rewatchStage?.done && rewatchStage.value?.videos
          ? rewatchStage.value.videos
          : videoStage?.done
            ? videoStage.value?.videos
            : videoStage
              ? lateVideoStates(videoCandidates, await videosSoFar(), config.media?.video?.maxPerTurn ?? 5)
              : undefined;
      // What the request shows as not ready, for the steps that follow (lateMediaTeller): the videos rendered
      // `pending`, and whether the captions were late.
      const pendingMedia = {
        videoIds:
          videoStage && !videoStage.done && !(rewatchStage?.done && rewatchStage.value?.videos)
            ? [...videos].filter(([, state]) => state?.state === 'pending').map(([id]) => id)
            : [],
        captions: Boolean(captions) && !captions.done && captionCandidates.length > 0,
      };
      // A picture's second look on a question (features.imageRelook): rendered under its line.
      const imageAnswers =
        rewatchStage?.done && rewatchStage.value?.imageAnswers?.size > 0 ? rewatchStage.value.imageAnswers : null;
      const reads = linksStage?.done ? linksStage.value : undefined;
      const lookupResult = lookupStage?.done ? (lookupStage.value ?? null) : null;
      // A prefetch still out at the deadline: the request says so (`timeout`) instead of waiting.
      const prefetchResult = prefetching
        ? prefetchStage?.done
          ? (prefetchStage.value ?? null)
          : { status: 'timeout', basis: prefetching.lanes.map((lane) => lane.kind), excerpts: [] }
        : null;
      prep.take('prefetch', prefetchResult !== null);
      // What the turn has in front of it from outside, for where her lines came from (noteSeen):
      // someone's message she answers, the retrieved memory, pages read, a lookup, an errand's result.
      if (trigger && String(trigger.authorId ?? '') !== String(selfId)) noteSeen(draft, trigger.content);
      noteSeen(draft, prefetchResult?.excerpts);
      noteSeen(draft, reads, { read: true });
      noteSeen(draft, lookupResult, { read: true });
      noteSeen(draft, taskResult?.result, { read: true });
      // The journal: which preparation steps reached the request (the rest close as not delivered).
      prep.take('captions', Boolean(captions?.done), { hold: Boolean(captions) });
      prep.take('videos', Boolean(videoStage?.done), { hold: Boolean(videoStage) });
      prep.take('links', Boolean(linksStage?.done));
      prep.take('lookup', Boolean(lookupStage?.done));
      const neighborsFound = neighborsStage?.done ? neighborsStage.value : null;
      const neighbors = Array.isArray(neighborsFound?.neighbors) ? neighborsFound.neighbors : [];
      const neighborsHidden = neighborsFound?.hidden ?? 0;
      // Pulled ahead of a chooser, the channels keep their cached captions when the fresh ones are late.
      const pulled = pulledStage?.done && Array.isArray(pulledStage.value) ? pulledStage.value : (early?.pulled ?? []);

      // A neighbour's pictures get only the captions the cache already holds, under the
      // chat captions' switch: cachedDescriptions never sends a request or counts a day.
      // A diary post's plan, search and picture check (a request or token cap refuses the turn).
      let diaryPrep = null;
      if (diaryPending) {
        const settled = await beforeBar(diaryPending);
        if (settled.error) throw settled.error;
        diaryPrep = settled.value;
        // The post's kind decides how many pictures it takes (drawTool, runSteps): a set kind several, any other one.
        draft.diary = { set: isSetKind(diaryPrep.plan.kind, config.diary?.setKinds) };
      }
      const neighborDescriptions =
        features.mediaDescriptions === true &&
        typeof describer?.cachedDescriptions === 'function' &&
        neighbors.length > 0
          ? describer.cachedDescriptions(
              guildId,
              neighbors.flatMap((neighbor) => describableCandidates(neighbor.messages, []))
            )
          : undefined;
      // Drawing (features.imageGeneration, a missing key counts as on) needs the image client
      // and Attach Files here. An unasked turn reads the quota for no member, like draw.create charges none.
      // A diary post draws only while its picture check allowed it (its own daily cap and the image cap).
      const drawOn =
        Boolean(images) &&
        features.imageGeneration !== false &&
        channel.permissions.attach &&
        (!diaryPrep || diaryPrep.pictureAllowed);
      const drawQuota = drawOn ? images.quota({ userId: asked ? (trigger.authorId ?? null) : null }) : undefined;
      // Neighbours the bot can read but not write in, marked in `<server>` (a pulled channel's
      // record carries its own mark). A pulled channel whose block is shown is left out of the
      // neighbours by buildRequest itself.
      const readOnlyIds = new Set(
        neighbors.filter((neighbor) => neighbor.readOnly === true).map((neighbor) => neighbor.channelId)
      );
      // Where a call from a read-only channel is answered, for `<senses>`.
      const destination = isPrivate ? null : usableDestination(snapshot, asObject(config)).channel;
      // `<recent>`: the guild's live recent lines (none: an empty list) and the channels this turn may show them from.
      const recent = memoryOn ? recentInput({ channel, snapshot, guildId, isPrivate, config, now }) : NO_RECENT;
      // The prompts this request is built from, read once: the task labels below decide what it names.
      const prompts = hot.prompts;
      // A part of a split message, the author's other calls still queued, the messages folded into this one.
      // Addressed turns of this channel that failed earlier, told once (first part only); cleared at the turn's end unless it fails too.
      const addressedHere = mode === 'reply' && askedFor(trigger, triggerKind) && (!part || part.index === 1);
      if (isPrivate) privateChannels.add(String(channel.id));
      const factScope = { channelId: String(channel.id), privateChat: isPrivate };
      let pendingFacts = addressedHere ? facts().pending(guildId, factScope) : [];
      // A send of hers that may have gone out is looked for in the channel's lines first: found, the fact is dropped; not, it is told as unclear.
      if (pendingFacts.some((fact) => fact.kind === 'sendFailed' && fact.unknown === true)) {
        const settled = settleUnknownSends(pendingFacts, history);
        if (settled.dropped.length > 0) {
          facts().markTold(
            guildId,
            settled.dropped.map((fact) => fact.id)
          );
          log.info('turn: unknown send found in the channel', { channel: channel.id, count: settled.dropped.length });
        }
        pendingFacts = settled.kept;
      }
      const failedFacts = pendingFacts.filter(
        (fact) =>
          fact.kind === 'failedTurn' &&
          fact.channelId === factScope.channelId &&
          now - fact.at < FAILED_TURN_KEEP_MS &&
          fact.messageId !== trigger.id
      );
      const failedEarlier = failedFacts.map((fact) => ({
        author:
          history.find((m) => m.authorId === fact.authorId)?.authorName ??
          store.getUser?.(guildId, fact.authorId)?.names?.[0] ??
          '',
        messageId: fact.messageId,
        link: messageLinkOf(iface, isPrivate ? null : guildId, channel.id, fact.messageId),
        at: fact.at,
        code: fact.code,
      }));
      // What else was kept for her (a drop, a hold, a call or a message that failed): a `<wake>`-shaped block before the task.
      const otherFacts = pendingFacts.filter((fact) => fact.kind !== 'failedTurn').slice(0, FACTS_SHOWN_MAX);
      const factsText =
        otherFacts.length > 0
          ? feedbackInTurnText(otherFacts.map(factPayload), prompts?.labels, {
              timezone: config.bot?.timezone ?? 'UTC',
              locale: prompts?.labels?.locale,
            })
          : '';
      const shownIds = [...failedFacts, ...(factsText ? otherFacts : [])].map((fact) => fact.id);
      if (shownIds.length > 0) draft.factsShown = shownIds;
      const tasks = taskInput({
        part,
        queued,
        added,
        missed,
        failedEarlier,
        labels: prompts?.labels,
        channelId: channel.id,
      });
      // What this turn had in view yet does not answer (spokeAfterSeeing): the queued calls it
      // named, and on a part of a split message every line after the message -- a call that came
      // while the chain ran waits for its own turn after the chain.
      const triggerAt = part && trigger ? history.findIndex((m) => m.id === trigger.id) : -1;
      const notAnswered =
        triggerAt === -1
          ? tasks.deferred
          : new Set([...tasks.deferred, ...history.slice(triggerAt + 1).map((m) => m.id)]);
      const guildMemory = memoryOn ? store.getGuild(guildId) : null;
      // Whether the call tags the persona, read as decideMention reads it (pipeline.js decideAndLog):
      // an untagged reply takes the follow-up task (usesFollowUpTask).
      const taggedCall = trigger ? isTaggedCall(trigger, selfId) : null;
      if (
        usesFollowUpTask({
          mode: finalMode,
          triggerKind,
          taggedCall,
          routed: source?.reason === 'routed',
          privateChat: isPrivate,
        })
      ) {
        const followUpPrompt = prompts?.['follow-up'];
        const missing = !(typeof followUpPrompt === 'string' && followUpPrompt.trim());
        if (missing && !followUpPromptMissing)
          log.warn('turn: prompt missing', { name: 'follow-up', reason: 'no-prompt', channel: channel.id });
        followUpPromptMissing = missing;
      }
      // `<now>`: the persona's recent time away (the journal's pauses and stops).
      const offPeriods = await offPeriodsFor(guildId, config);
      // Skills discovery on a turn someone asked for: the catalogue when the question was what the
      // persona can do; named skills only logged and journaled (shadow).
      const skillsInventory = asked ? discoverSkills({ config, channel, trigger, answer: skillsAnswer, draft }) : null;
      // Her tools, the same for every turn kind and pinned for this one (a grant removed meanwhile is still caught at each call):
      // the skills granted to her and the carried-over ones, as native tool definitions (or `<tools>` text). A diary post
      // has the same tools; only `draw.create` runs there (runSteps).
      draft.toolNames = exposedSkillNames({ config, selfId, registry: skills ?? defaultSkills() });
      draft.tools = buildTools(draft.toolNames, {
        registry: skills ?? defaultSkills(),
        texts: prompts?.tools,
        fill: { drawChars: config.image?.maxPromptChars ?? 1600 },
      });
      const toolsBlock = transport === 'text' ? toolsBlockText(draft.tools, prompts?.labels) : null;
      const toolsTokens = transport === 'native' ? estimateTools(draft.tools) : 0;
      // Every input named (turnRequestInput throws on one left undefined); null marks an absent one.
      // A heartbeat's lines carry handles (`#N`) numbered on past the request's own lines, like a memory.search's quotes:
      // the text is worded once with a provisional base, then again when the request says where its own numbering ends.
      const heartbeatRefs = Array.isArray(draft.inner?.wake?.heartbeat?.refs) ? draft.inner.wake.heartbeat.refs : [];
      const heartbeatHandleBase = heartbeatRefs.length > 0 ? SEARCH_HANDLE_GAP + 1 : null;
      let shownHeartbeatRefs = [];
      const wakeTextOf = (handleBase) =>
        wakeBlockText(draft.inner.wake, prompts?.labels, {
          locale: prompts?.labels?.locale,
          handleBase,
          onRefs: (refs) => (shownHeartbeatRefs = refs),
        });
      const requestInput = turnRequestInput({
        config,
        prompts,
        calibrator,
        mode: finalMode,
        forced: forced || (diaryPrep !== null && diaryParams?.forced === true),
        now,
        selfName,
        // `<directory>` never lists the persona's own profile.
        selfId,
        history,
        neighbors,
        trigger,
        triggerKind,
        taggedCall,
        guildMemory: guildMemory ?? {},
        interlocutor: memoryOn && trigger ? (store.getUser(guildId, trigger.authorId) ?? null) : null,
        // A private chat: the partner's private layer joins their public profile (only there).
        privateChat: isPrivate ? { userId: trigger?.authorId ?? null } : null,
        privateProfile: isPrivate && memoryOn && trigger ? (store.getPrivate(guildId, trigger.authorId) ?? null) : null,
        otherProfiles: memoryOn
          ? pickOtherProfiles(store, guildId, history, trigger?.authorId, config.context.otherProfiles)
          : [],
        candidateProfiles: memoryOn ? store.listUserProfiles(guildId) : [],
        nameOf: memoryOn ? (id) => store.getUser(guildId, id)?.names?.[0] ?? null : null,
        channels: memoryOn ? store.listChannels(guildId) : [],
        // `<channel_directory>`: every text channel the persona can read, with its handle (none in a private chat).
        channelDirectory: channelDirectoryOf(isPrivate ? null : snapshot, asObject(config.bot)),
        loreEntries: memoryOn ? store.getLore(guildId) : [],
        currentChannelId: channel.id,
        diaryChannelIds: diaryConversationIds(store),
        descriptions: descriptions ?? null,
        neighborDescriptions: neighborDescriptions ?? null,
        videos: videos ?? null,
        imageAnswers,
        reads: reads ?? null,
        lookup: lookupResult ?? null,
        // `<retrieved>`: the automatic memory prefetch of this trigger (null: none ran).
        prefetch: prefetchResult,
        searchAvailable:
          features.webLookup === true && typeof lookup?.hasSearch === 'function' && lookup.hasSearch() === true,
        // The search of the server's own history: the value the lookup stage used.
        recallAvailable: serverOn,
        drawQuota: drawQuota ?? null,
        // The `<emoji>` block: the index's emoji (ranked by guildMemory.emojiUsage) and their cached captions.
        customEmoji: emoji ? (emoji.list() ?? []) : [],
        // The `<gifs>` block and the transcript's GIF handles: the guild's library (features.gifs).
        gifs: features.gifs !== false && typeof store.getGifs === 'function' ? (store.getGifs(guildId) ?? null) : null,
        // The cached captions of both lists.
        mediaCache:
          emoji || (features.gifs !== false && typeof store.getGifs === 'function')
            ? (store.getMediaCache(guildId) ?? null)
            : null,
        // `<channel_view>`: the channels pulled into this turn (each with the last view of it
        // shown in this channel, when one is within context.pull.seenTtlMinutes), the one it is
        // about, the chat line put to the room, where a call from a read-only channel is answered.
        // The persona's lines there name the message that started their turn (linkTriggers) and
        // the skill calls she made there (linkCalls).
        pulled: withSeenBefore(
          pulled.map((entry) =>
            Array.isArray(entry?.messages)
              ? { ...entry, messages: linkCalls(linkTriggers(entry.messages), { channel, snapshot, guildId }) }
              : entry
          ),
          channel.id,
          now
        ),
        source,
        focus,
        tasks: tasks.input,
        elsewhereDestination: destination?.name ? { name: destination.name } : null,
        readOnlyIds,
        // `<recent>`: the last hours, its live lines and the members' moments (no block without the store).
        recentLines: recent.lines ?? null,
        recentAudience: recent.audience ?? null,
        // `<participation>`: the store read now, the classifier's picks when they came in time.
        participation: participationShown
          ? {
              state: store.getParticipation(guildId),
              pickedIds:
                participationStage?.done && Array.isArray(participationStage.value) ? participationStage.value : [],
              audience: participationAudienceOf,
              channelName: liveChannelName(channel, snapshot),
            }
          : null,
        // `<senses>`: where the persona keeps its diary, when one is set.
        diaryChannel: diaryChannelName(guildId, config, snapshot, finalMode === 'diary' ? channel : null),
        // A diary post: its past posts, its plan and what its search found.
        diary: diaryPrep
          ? { posts: diaryPrep.posts, plan: diaryPrep.plan, found: diaryPrep.found, seeds: diaryPrep.seeds ?? '' }
          : null,
        offPeriods,
        skillsInventory,
        // Her tools this turn: the in-turn ones for `<senses>`, the text transport's `<tools>` body, and what the native
        // transport's `tools` field costs the request (the room the sections share).
        toolsGranted: draft.toolNames,
        toolsBlock,
        toolsTokens,
        // `<people_now>`'s live part: the voice and status snapshot (null: none).
        around: aroundInputFor({ config, mode: finalMode, isPrivate, snapshot }),
        // `<errands>` and `<errand_result>`: her errands (none on a diary post).
        errands:
          finalMode === 'diary'
            ? null
            : errandsInputFor({ guildId, channel, isPrivate, taskResult, config, labels: prompts?.labels, now }),
        // `<intentions>`: hers and the proposed ones (features.intentions; none on a diary post).
        intentions:
          finalMode === 'diary'
            ? ''
            : intentionsInputFor({ guildId, channel, snapshot, isPrivate, config, labels: prompts?.labels, now }),
        // `<wake>`: an inner turn's reason to be awake (src/behavior/wake.ts); none on any other turn.
        wake: draft.inner ? wakeTextOf(heartbeatHandleBase) : factsText || null,
        // An inner turn's wake kind: a heartbeat takes `prompts.heartbeat` as its task text.
        wakeKind: draft.inner?.wake?.kind ?? null,
        // `<places>`: the places page on an addressed server turn, only with `context.places` exactly true (an inner turn has it in `<wake>`).
        places:
          !draft.inner && !isPrivate && finalMode !== 'diary'
            ? placesInputFor({ guildId, config, labels: prompts?.labels })
            : null,
        // Her one previous think: the latest finished turn tied to this place within the window (an inner turn imports none).
        previousThink: earlierThinkFor({ channel, guildId, isPrivate, draft, mode: finalMode }),
        // `<self_facts>` and `<gifs>` held per cache bucket, so a memory batch rewrites the cache once at most.
        stableFreeze: stableFreezeOf(guildId),
      });
      let request = buildRequest(requestInput);
      if (heartbeatRefs.length > 0) {
        const floor = Math.max(0, ...request.idByIndex.keys());
        const base = floor + SEARCH_HANDLE_GAP + 1;
        if (base !== heartbeatHandleBase) {
          requestInput.wake = wakeTextOf(base);
          request = buildRequest(requestInput);
        }
        // The handles the block kept resolve in this turn and in the steps of its loop (the registry of memory.search's quotes).
        draft.handleFloor = floor;
        searchHandles(draft).take(
          shownHeartbeatRefs
            .filter((index) => heartbeatRefs[index])
            .map((index) => ({ n: base + index, ...heartbeatRefs[index] }))
        );
      }
      // What `<recent>` showed, held back or cut: counts only.
      if (request.recent) log.info('recent: shown', { channel: channel.id, ...request.recent });
      // The memory rows this request carried, for the database's per-turn record (deferred there; it never fails a turn).
      if (memoryReads && draft.started?.turnId && request.memoryReads?.length) {
        // One step: the steps of her tool loop add tool results to this request, never memory reads of their own.
        try {
          const readContext = turnContextOf(draft, channel);
          memoryReads({
            turnId: draft.started.turnId,
            step: 's0',
            guildId,
            reads: request.memoryReads,
            ...(readContext?.id ? { contextId: readContext.id } : {}),
          });
        } catch {
          /* a record, never a turn's failure */
        }
      }
      // The journal: what of the window went in, whose lines they were, what the budget dropped.
      if (draft.started && request.seen) {
        // The lines of the pulled channels whose block the request kept count as seen too, by channel.
        const pulledSeen = (request.pulledKept ?? []).map(({ channelId, ids }) => ({
          channelId,
          messageIds: [...ids],
        }));
        const pulledIdsSeen = pulledSeen.flatMap((entry) => entry.messageIds);
        draft.seen = {
          ...request.seen,
          messageIds: [...new Set([...request.seen.messageIds, ...pulledIdsSeen])],
          pulled: pulledSeen,
        };
        const keptIds = new Set(draft.seen.messageIds);
        const pulledLines = pulledSeen.flatMap(
          ({ channelId }) => pulled.find((entry) => entry.channelId === channelId)?.messages ?? []
        );
        const authors = [...history, ...pulledLines]
          .filter((message) => keptIds.has(message.id) && !message.self)
          .map((message) => message.authorId);
        draft.participants = [...new Set([...authors, trigger?.authorId].filter((id) => typeof id === 'string' && id))];
        draft.dropped = droppedSections(request.stats);
        budgetDrops(request.stats, draft.limits);
      }

      // The request is text only (buildRequest never attaches a picture: the persona sees them
      // through the describer's captions), so nothing is downloaded or resent here.
      const messages = request.messages;

      let completion;
      // What the client was given, for the journal's request dump.
      const sentMessages = messages;
      // Her tools travel as the request's `tools` on the native transport (the text transport described them in `<tools>`).
      const toolsSent =
        transport === 'native' && draft.tools.length > 0 ? { tools: draft.tools, toolChoice: 'auto' } : null;
      const replyStartedAt = clock();
      try {
        completion = await beforeBar(llm.complete(messages, { ...replyOptions(), ...(toolsSent ?? {}) }));
      } catch (err) {
        // The bar passed, or no time is left under it by the time the error lands: the turn is
        // dropped as too slow (an answer could not be asked for again), not reported as an error.
        if (err === TOO_SLOW || bar.passed || bar.leftMs() === 0) throw TOO_SLOW;
        throw err;
      } finally {
        // Where this turn's time went, answered or not: numbers and codes only.
        const end = clock();
        log.info('turn: timings', {
          channel: channel.id,
          mode: finalMode,
          triggerKind: triggerKind ?? null,
          settleMs: settledMs,
          prepareMs,
          late,
          stages: timings,
          replyMs: end - replyStartedAt,
          totalMs: end - startedAt,
        });
      }
      // The answer is in hand: the bar is met, and the typing imitation below (never shortened) takes over.
      bar.close();
      stopTyping();

      // The journal's request dump (journal.keepRequests): the request as sent and the raw answer.
      dumpTurnRequest(guildId, draft, sentMessages, completion, null, toolsSent);

      // The model's output as it is acted on: the feature switches drop parts of it first. The same
      // for the answer to every request after her calls.
      const shapeOutput = (parsed) => {
        if (features.reactions === false) {
          parsed.reactions = [];
          parsed.untargetedReactions = [];
        }
        // A custom emoji reaction resolves through the index; an unknown one (or the switch off) is dropped.
        const lookupEmoji = emojiLookup();
        parsed.reactions = parsed.reactions
          .map((reaction) => ({ ...reaction, emoji: resolveReactionEmoji(reaction.emoji, lookupEmoji) }))
          .filter((reaction) => reaction.emoji);
        if (features.multiMessage === false) parsed.messages = parsed.messages.slice(0, 1);
        // format.stripDashes (a missing key counts as on): no em/en dash in a <msg> text; a message
        // left empty is not posted. Hyphens, <react>, <gif> and reply ids are untouched.
        if (hot.config.format?.stripDashes !== false) {
          const dashes = parsed.messages.reduce((sum, message) => sum + countDashes(message.text), 0);
          if (dashes > 0) {
            parsed.messages = parsed.messages
              .map((message) => ({ ...message, text: stripDashes(message.text) }))
              .filter((message) => message.text !== '');
            log.info('turn: dashes stripped', { channel: channel.id, count: dashes });
          }
        }
        // An inner turn's tags are public actions in its current channel: lowered into the calls a
        // `message.create` / `message.react.add` of hers would be, planned after her own calls and made
        // with them once her speech may go out (src/behavior/inner-output.js).
        parsed.loweredCalls = [];
        if (draft.inner) {
          const current = draft.inner.currentChannel === undefined ? String(channel.id) : draft.inner.currentChannel;
          parsed.loweredCalls = innerOutputCalls(parsed, {
            current: current ? String(current) : null,
            turnChannel: String(channel.id),
          }).map((call) => ({ ...call, lowered: true }));
          if (parsed.loweredCalls.length > 0)
            log.info('turn: inner output lowered', { channel: channel.id, calls: parsed.loweredCalls.length });
          parsed.messages = [];
          parsed.reactions = [];
          parsed.untargetedReactions = [];
          parsed.gif = null;
        }
        if (diaryPrep) {
          // A diary post: no reaction, no GIF, nothing posted as a reply, no link, at most diary.maxMessages.
          parsed.reactions = [];
          parsed.gif = null;
          parsed.messages = parsed.messages
            .map((message) => ({ ...message, replyTo: null, text: stripUrls(message.text) }))
            .filter((message) => message.text !== '')
            .slice(0, Math.max(0, config.diary?.maxMessages ?? 3));
        }
        return parsed;
      };
      // One answer read: split into speech and calls (answerOf), the speech parsed and shaped, the think kept,
      // her answer counted when it did not begin with her thinking. `number`: 1 for the reply's answer, one more for each after.
      draft.format = { thinkMissing: 0, coerced: 0, malformed: 0, truncated: 0, capped: 0, held: 0 };
      draft.steps = 0;
      const readAnswer = (answered, number) => {
        const split = answerOf(answered, { transport, step: number, registry: skills ?? defaultSkills() });
        const shaped = shapeOutput(parseOutput(split.speechText, { limits: draft.limits }));
        noteDiagnostics(draft, shaped, answered);
        noteThink(draft, shaped);
        shaped.gif = resolveGif(guildId, shaped.gif, channel.id, draft.limits);
        // Counted, never refused: the answer is acted on all the same.
        if (thinkMissing(split.rawText)) {
          draft.format.thinkMissing += 1;
          log.info('turn: think missing', { channel: channel.id, step: number - 1 });
        }
        return { completion: answered, ...split, parsed: shaped };
      };
      const first = readAnswer(completion, 1);
      const parsed = first.parsed;
      const nothingToDo =
        parsed.messages.length === 0 &&
        parsed.reactions.length === 0 &&
        parsed.gif === null &&
        parsed.loweredCalls.length === 0;
      // Nothing to post and nothing to call: silence (her calls run all the same when she wrote any).
      const silent = (parsed.skip || nothingToDo) && first.calls.length === 0;
      // The journal keeps the think (journal.thinkChars); the log then carries its length only.
      if (draft.started) {
        draft.think = parsed.think;
        draft.usage = journalUsage(completion);
      }
      const thinkField = journalOn() ? { thinkChars: Array.from(parsed.think ?? '').length } : { think: parsed.think };

      log.info('turn: model answered', {
        mode: finalMode,
        trigger: triggerKind ?? null,
        // Only on a turn about another channel, with channels pulled, or with a line put to the room.
        ...(source ? { source: source.channelId ?? null } : {}),
        ...(pulled.length > 0 ? { pulled: pulled.length } : {}),
        ...(focus ? { focus: true } : {}),
        // Active neighbours the audience rail left out.
        ...(neighborsHidden > 0 ? { neighborsHidden } : {}),
        secondsToAnswer: Math.round((clock() - startedAt) / 100) / 10,
        channel: channel.id,
        estimated: completion.estimated,
        usage: completion.usage,
        calibration: Number(calibrator.ratio.toFixed(3)),
        budget: request.stats,
        // Per user-message part: length and a short hash, to see which part changes between turns (no content).
        segments: request.segments,
        ...thinkField,
        skip: parsed.skip || nothingToDo,
        messages: parsed.messages.length,
        reactions: parsed.reactions.length,
        gif: Boolean(parsed.gif),
        ...(first.calls.length > 0 ? { calls: first.calls.length } : {}),
      });
      // The pulled channels whose block was in the request sent (a skip and a dry run included):
      // their seen marks move to the newest line shown; a block the budget dropped moves none.
      const shownPulled = request.pulledKept ?? [];
      // What a private chat showed of the server stays there: no seen mark, no stamp, no pending ping.
      const serverShown = isPrivate ? [] : shownPulled;
      markPulledSeen(serverShown);
      // This channel's view of each pulled channel the request showed, for the next view of it here.
      if (!isPrivate) pullViews.remember(channel.id, request.pulledViews ?? [], now);
      store.state.data.calibration = calibrator.ratio;
      store.state.markDirty();
      // The calls of the ring this turn showed follow its decision (stampShownCalls), except a
      // routed turn's own call: its caller stamps that one.
      const ownCallId = source?.reason === 'routed' ? (trigger?.id ?? null) : null;

      // Cut off at the output cap before any complete action: a lost answer, not her silence.
      const cutOff = cutOffOf(completion, parsed, { channelId: channel.id, empty: silent, followUp: false });
      if (cutOff && !cutOff.kept && first.calls.length === 0) {
        draft.reason = 'cut-off';
        return { outcome: 'error', mode: finalMode, reason: 'cut-off' };
      }
      if (silent) {
        stampShownCalls({ shown: serverShown, pulled, answered: new Set(), exceptId: ownCallId });
        // An inner turn that ends with no action: nothing to do, journalled as such.
        return { outcome: 'skip', mode: finalMode, reason: draft.inner ? SKIP_NOTHING_TO_DO : SKIP_SILENCE };
      }

      const idByIndex = request.idByIndex;
      // The output side of the pulled channels: which line lives where, whose @name resolves,
      // which post carries a jump link (one rule for act and dryAct). Names resolve over the
      // pulled lines the request showed, then this chat's history: resolveMentions keeps the
      // last author of a display name, so a chat author wins a name both share. The stored names
      // of the members whose profile the request kept and of the pulled lines' authors resolve
      // too, behind every display name: a pulled line fetched without its member carries the
      // global name while `<people>` reads the server nickname. Only then the fallback directory:
      // a member the model was not shown (another channel, a block the budget dropped) is
      // mentioned by a name nobody else in the served guild carries.
      const pulledIds = request.pulledIds ?? new Map();
      // The highest line number of the request: a memory.search of the turn numbers its quotes on past it.
      draft.handleFloor = Math.max(0, ...idByIndex.keys());
      const shownLines = shownPulled.flatMap(({ channelId, ids }) => {
        const shownIds = new Set(ids);
        return (pulled.find((entry) => entry.channelId === channelId)?.messages ?? []).filter((message) =>
          shownIds.has(message.id)
        );
      });
      const lines = shownLines.length > 0 ? [...shownLines, ...history] : history;
      // With features.mentionHandles on (the request was built with it: `handles`), only her
      // `@handle` mentions anyone and no name is matched at all.
      const handles = request.handles ?? null;
      // The request's channel handles: her `#handle` links its channel exactly.
      const channelHandles = request.channelHandles ?? null;
      const knownNames =
        memoryOn && !handles
          ? storedNames(request.peopleShown, shownLines, (userId) => store.getUser(guildId, userId))
          : [];
      // Behind those, every member of the served guild the bot knows (built once, on the first `@`).
      const directory = handles ? null : turnDirectory({ guildId, memoryOn });
      const linkFor = createLinker({
        linkOf: (channelId, messageId) => messageLinkOf(iface, guildId, channelId, messageId),
        pulledIds,
        sourceTarget: isPrivate ? null : sourceLinkTarget({ source, trigger, pulledKept: shownPulled }),
      });
      // A follow-up or an overheard turn (postsPlain) never posts as a platform reply -- the
      // model's reply="#n" quotes nothing.
      // A later part of a split message posts plain too: the first part replied to the message.
      const plain = postsPlain(triggerKind) || plainPosts;
      const routing = {
        pulledIds,
        lines,
        knownNames,
        directory,
        handles,
        memberNames: request.memberNames ?? null,
        channelHandles,
        linkFor,
        plain,
      };
      // Read fresh right here, not from the `features` snapshot taken at the
      // top of this turn: unlike the other switches this one defaults to OFF,
      // and whether to actually post is the very last decision of a turn.
      // A set below diary.set.minPosted (read now) is not posted at all: not even its messages.
      const setShort = (pictures, extra = {}) => {
        log.info('turn: set short', {
          channel: channel.id,
          pictures,
          wanted: setSettings(hot.config.diary).minPosted,
          ...extra,
        });
        return { outcome: 'refused', mode: finalMode, reason: 'set-short', ...extra };
      };
      // A recovery turn (src/behavior/missed.js) asks right before anything is posted whether
      // its messages still wait for an answer (`stillDue`): the persona spoke in the channel
      // since it started, or another turn answered one of them -- nothing is posted.
      if (typeof stillDue === 'function' && !stillDue()) {
        log.info('turn: dropped', {
          channel: channel.id,
          mode: finalMode,
          triggerKind: triggerKind ?? null,
          reason: 'answered-meanwhile',
        });
        draft.reason = 'answered-meanwhile';
        return { outcome: 'not-now', mode: finalMode, reason: 'answered-meanwhile' };
      }
      if (hot.config.features?.dryRun === true) {
        // A diary post's pictures as the dry run counts them: her draw.create calls, the first few its kind takes (none while drawing is off).
        const diarySet = Boolean(draft.diary?.set);
        const diaryDraws = diaryPrep
          ? (drawOn ? first.calls.filter((one) => one.name === 'draw.create') : [])
              .slice(0, diarySet ? setSettings(config.diary).pictures[1] : 1)
              .map((one) => ({ text: String(one.args?.text ?? ''), self: one.args?.self === true }))
          : null;
        // Nothing is generated: a set with fewer drawings than it needs would be short.
        if (diarySet && diaryDraws.length < setSettings(config.diary).minPosted)
          return setShort(diaryDraws.length, { dryRun: true });
        // Her calls in a dry run: logged with the skill and the names of its arguments, never checked, run or followed by a step.
        for (const call of first.calls)
          log.info('dry-run: would call', { channel: channel.id, skill: call.name, args: Object.keys(call.args) });
        await dryAct({
          channel,
          guildId,
          parsed,
          idByIndex,
          history,
          mode: finalMode,
          triggerKind,
          trigger,
          selfName,
          part,
          ...routing,
          gifPick: !diaryPrep,
          diaryDraws,
          diarySet,
          draft,
        });
        noteSpokeSaw(channel, history, serverShown, pulled, notAnswered);
        // A rehearsed diary post is not recorded and counts for no daily cap.
        const rehearsedPictures = diaryDraws?.length ?? 0;
        const rehearsed = diaryPrep
          ? {
              diary: {
                kind: diaryPrep.plan.kind,
                picture: rehearsedPictures > 0,
                search: Boolean(diaryPrep.plan.search),
                messages: parsed.messages.length,
                pictures: rehearsedPictures,
              },
            }
          : {};
        return { outcome: 'spoke', mode: finalMode, dryRun: true, ...rehearsed };
      }
      // Every call of the attempt: its turn (the journal's turn, else one id per attempt) and its index over every step.
      // Its key is the effect's record, `<turnId>:<effectIndex>:<target>` (the conversation it names, else the turn's),
      // with no attempt in it, so a later attempt of the turn carries the key a first one would have carried.
      draft.turnKey ??= { turnId: draft.started?.turnId ?? randomUUID() };
      const envelopeOf = (/** @type {{ args?: Record<string, unknown> }} */ call) => {
        const index = draft.callCount ?? 0;
        draft.callCount = index + 1;
        const target = typeof call?.args?.channelId === 'string' ? call.args.channelId || channel.id : channel.id;
        return callEnvelope({
          trigger,
          channel,
          added,
          missed,
          requester: requesterParam,
          turnId: draft.turnKey.turnId,
          idempotencyKey: `${draft.turnKey.turnId}:${index}:${target}`,
          ownInitiative: Boolean(draft.inner) || draft.ownInitiative === true,
          chainId: draft.inner?.wake?.chainId ?? null,
          wakeKind: draft.inner?.wake?.kind ?? null,
        });
      };
      const actArgs = {
        channel,
        guildId,
        privateChat: isPrivate,
        parsed,
        idByIndex,
        history,
        startedAt,
        mode: finalMode,
        triggerKind,
        trigger,
        selfName,
        ...routing,
        sourceId: isPrivate ? null : (source?.channelId ?? null),
        gifPick: !diaryPrep,
        participation: isPrivate ? null : { descriptions: descriptions ?? null },
        draft,
      };
      // The calls of the reply and of every later step, run in the turn's context (runCall's).
      const callContext = {
        channel,
        trigger,
        guildId,
        draft,
        privateChat: isPrivate,
        idByIndex,
        pulledIds,
        lines,
        knownNames,
        directory,
        handles,
        channelHandles,
        inTurn: inTurnTools({
          channel,
          snapshot: servedSnapshot,
          guildId,
          partner: isPrivate ? partner : null,
          selfId,
          selfName,
          history,
          draft,
          trigger,
          triggerKind,
          mode: finalMode,
          plain,
        }),
      };
      const lateMedia =
        pendingMedia.videoIds.length > 0 || pendingMedia.captions
          ? lateMediaTeller({
              lines: history,
              idByIndex,
              handles,
              memberNames: request.memberNames ?? null,
              selfName,
              videoStage,
              videoItems: videoCandidates,
              captions,
              captionItems: captionCandidates,
              pending: pendingMedia,
              onTold: (stage) => prep.tell(stage),
              transcript: stepTranscript,
            })
          : null;
      // Her calls, then her speech, then (when something is left to read) another request, and so on (runSteps).
      const stepped = await runSteps({
        channel,
        guildId,
        trigger,
        draft,
        transport,
        messages: sentMessages,
        first,
        readAnswer,
        actArgs,
        callContext,
        envelopeOf,
        routing: {
          idByIndex,
          history,
          lines,
          pulledIds,
          handles,
          memberNames: request.memberNames ?? null,
          channelHandles,
        },
        memoryOn,
        selfName,
        triggerKind,
        lateMedia,
      });
      // A step was cut off with nothing complete and nothing of the turn reached the chat: a lost answer.
      if (stepped.cutOff && !stepped.delivered) {
        draft.reason = 'cut-off';
        return { outcome: 'error', mode: finalMode, reason: 'cut-off' };
      }
      // A set kind that ended below diary.set.minPosted staged pictures (runSteps): nothing was posted.
      if (draft.setShort !== undefined) return setShort(draft.setShort);
      noteSpokeSaw(channel, [...history, ...(draft.loopSeen ?? [])], serverShown, pulled, notAnswered);
      const acts = stepped.acts;
      const answeredAll = new Set(acts.flatMap((acted) => [...(acted.answered ?? [])]));
      stampShownCalls({ shown: serverShown, pulled, answered: answeredAll, exceptId: ownCallId });
      if (draft.started) {
        draft.posted = acts.flatMap((acted) => acted.posts ?? []);
        draft.reactions = acts.flatMap((acted) => acted.reacted ?? []);
      }
      // The messages its posts replied to, for the end hook (noteTurnEnd), journal or not.
      draft.replyTargets = acts
        .flatMap((acted) => acted.posts ?? [])
        .map((post) => post?.replyTo)
        .filter((id) => typeof id === 'string' && id);
      // A diary post holds what it would send (holdSpeech): the entry is recorded and counted before any publication.
      const held = acts.filter((one) => one.held === true);
      const recorded =
        diaryPrep && held.length > 0
          ? {
              diary: recordEntry({
                store,
                config: hot.config,
                guildId,
                now,
                plan: diaryPrep.plan,
                held: { texts: held.flatMap((one) => one.texts), rendered: held.flatMap((one) => one.rendered) },
                staged: held.findLast((one) => one.staged.length > 0)?.staged ?? [],
                set: Boolean(draft.diary?.set),
                voice: draft.diaryVoice ?? null,
              }),
            }
          : {};
      // An inner turn in shadow mode delivers nothing, whatever it proposed.
      const delivered = stepped.delivered && draft.inner?.shadow !== true;
      return {
        outcome: 'spoke',
        mode: finalMode,
        delivered,
        ...recorded,
        ...(draft.sendFailure || draft.gifFailure ? { partial: true } : {}),
      };
    } catch (err) {
      if (err === TOO_SLOW) {
        // Past the bar: nothing is posted; `error`, like a failed request (a routed call stays unanswered).
        log.warn('turn: dropped', {
          channel: channel.id,
          mode: turnMode,
          triggerKind: triggerKind ?? null,
          reason: 'too-slow',
          seconds: Math.round((clock() - turnStartedAt) / 100) / 10,
        });
        draft.reason = 'too-slow';
        return { outcome: 'error' };
      }
      if (err instanceof DailyCapError || err instanceof TokenLimitError) {
        log.warn('turn: refused by a safety rail', { channel: channel.id, error: err });
        draft.reason = railReason(err);
        if (err instanceof DailyCapError)
          draft.limits?.add({ kind: 'daily-cap', where: limitOf(err)?.key ?? 'llm.maxRequestsPerDay' });
        return { outcome: 'refused', limit: limitOf(err) };
      }
      const code = errorCodeOf(err);
      log.error('turn: failed', { channel: channel.id, code, error: err });
      return { outcome: 'error', reason: code };
    } finally {
      draft.mode = turnMode;
      prep.closeAll();
      planner?.abandon('ended');
      stopTyping();
      deadline?.close();
      bar?.close();
      // A turn of a chain, or one that hands its message to a chain, leaves the attention and
      // the notifications to the chain (runChain), which releases them once every part is done.
      if (!owned && !chained) busy.delete(channel.id);
      if (!owned && !chained) notifyIdle();
    }
  }

  return {
    runTurn,
    /**
     * Remember which message started the turn that posted each message of `pairs`
     * (`[postedId, triggerId]`, oldest first: src/memory/journal.js#triggerLinks at start), so
     * her lines posted before a restart name their trigger too. A malformed pair is skipped; a
     * link noted since is kept over a seeded one.
     * @param {Array<[string, string]>} pairs
     */
    seedTriggerLinks: (pairs) => {
      for (const pair of Array.isArray(pairs) ? pairs : []) {
        if (!Array.isArray(pair) || triggerLinks.has(pair[0])) continue;
        noteTrigger(pair[0], pair[1]);
      }
    },
    /**
     * Remember the persona's skill calls from before a restart (src/memory/journal.js#callMarks at
     * start: `calls` oldest first, `postedFrom` pairs), so her lines keep showing them -- a call
     * that did not work with why (its `code` and `reason` through outcomeDetail). They go
     * before the calls noted since; a post noted since keeps its channel.
     * @param {{ calls?: object[], postedFrom?: Array<[string, string]> }} marks
     */
    seedCallMarks: (marks) => {
      // A call that did not work keeps why (its journaled code and reason, outcomeDetail).
      const seeded = (Array.isArray(marks?.calls) ? marks.calls : [])
        .filter((mark) => mark && typeof mark === 'object')
        .map((mark) => (mark.detail ? mark : { ...mark, detail: outcomeDetail(mark) }));
      callMarks.unshift(...seeded.slice(-CALL_MARKS_MAX));
      if (callMarks.length > CALL_MARKS_MAX) callMarks.splice(0, callMarks.length - CALL_MARKS_MAX);
      for (const pair of Array.isArray(marks?.postedFrom) ? marks.postedFrom : []) {
        if (!Array.isArray(pair) || postedFromLinks.has(pair[0])) continue;
        notePostedFrom(pair[0], pair[1]);
      }
    },
    /**
     * The parts of the chain running in `channelId` not started yet, when its message is
     * `authorId`'s: `{ index, text }` in order (1-based indices). Empty otherwise. Read only.
     * @param {string} channelId
     * @param {string} authorId
     * @returns {{ index: number, text: string }[]}
     */
    waitingParts: (channelId, authorId) => {
      const chain = chains.get(channelId);
      if (!chain || chain.authorId !== authorId) return [];
      return chain.parts.map((text, i) => ({ index: i + 1, text })).filter(({ index }) => index > chain.next);
    },
    /**
     * Fold `message` (`{ id, text, ts }`) into part `index` of `authorId`'s chain in `channelId`,
     * so that part's request names it (`labels.task.added`). False -- nothing changed -- when no
     * such chain runs or the part has started.
     * @returns {boolean}
     */
    addToPart: (channelId, authorId, index, message) => {
      const chain = chains.get(channelId);
      if (!chain || chain.authorId !== authorId || !(index > chain.next) || index > chain.parts.length) return false;
      chain.added.set(index, [...(chain.added.get(index) ?? []), message]);
      return true;
    },
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
    /**
     * Resolves once no turn is in flight anywhere -- immediately if that is
     * already true. Used by admin.js's `/nep pause` to wait out a turn
     * that was already running when the pause was requested, instead of
     * aborting it.
     * @returns {Promise<void>}
     */
    waitIdle: () => (busy.size === 0 ? Promise.resolve() : new Promise((resolve) => idleWaiters.push(resolve))),
    /** Called (never awaited by runTurn) every time a turn finishes anywhere, once the channel is freed. */
    setOnIdle: (fn) => {
      onIdle = fn;
    },
    /**
     * The facts kept for her next request in a conversation (src/behavior/inner.ts's `facts`: `enabled`, `add`,
     * `pending`, `markTold`); used while its `enabled()` says so, else the runner keeps its own in process.
     */
    setFactsSource,
    /**
     * Called (never awaited, never thrown into the turn) once every runTurn has ended, with how
     * it ended (noteTurnEnd): src/behavior/missed.js resolves and records from it.
     * @param {(end: object) => void} fn
     */
    setOnTurnEnd: (fn) => {
      onTurnEnd = fn;
    },
    /**
     * The id of the message that started the turn which posted `postedId` (this process, or
     * seeded from the journal at start), or null.
     * @param {string} postedId
     * @returns {string|null}
     */
    triggerOf: (postedId) => triggerLinks.get(postedId) ?? null,
  };
}
