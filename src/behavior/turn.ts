// One "turn": collect context → build the request under the token cap → ask
// the model → act in the chat like a person would (pause, typing indicator
// proportional to the text, several short messages in a row, reactions).
// Used for answering a call ('reply'), for a turn with no call ('interject', an errand's result with its asking
// message gone) and for her inner turns ('inner'), in a server channel or in a private chat (a
// channel without a place, served on behalf of the one pinned place). A
// server turn -- and a private chat, on its partner's behalf -- may also show
// other channels it is about (`<channel_view>`):
// the read-only channel a call came from, a channel named with an explicit
// <#id>, or one a route hook names. The turn still speaks only here: a
// reaction on a shown line of another channel lands in that channel, and a
// post (a message, the GIF, the picture) answering such a line goes here
// plain, with a jump link to it.
// createTurnRunner builds the topic modules of src/turn/ once and hands every
// attempt of a turn to runAttempt (src/turn/phases/attempt.ts), which runs its phases.

import { fallbackLookupPlan } from './recall.ts';
import { createImageFetcher } from '../media/fetch-image.ts';
import { createOffPeriodsReader } from '../memory/index.ts';
import { createThinkStore } from './previous-think.ts';
import { turnRoutes } from './turn-ability-route.ts';
import { chunkPictures } from './mirror.ts';
import { loopSettings, paceSettings } from '../turn/settings.ts';
import { scheduleTimer } from '../turn/timers.ts';
import { DAY_MS, utcDay } from '../time.ts';
import { log } from '../log.ts';
import { postsPlain } from '../turn/triggers.ts';
import { lookupClassifierInput } from '../turn/lookup-input.ts';
import { mentionDirectory, pickOtherProfiles, resolveMentions, untaggedNote } from '../turn/mentions.ts';
import { continuationHistory } from '../turn/history.ts';
import { myDayOf } from '../turn/request/my-day.ts';
import type { JournalReader, MyDayReader } from '../turn/request/my-day.ts';
import { placeChainInDb } from '../memory/db/place-tree.ts';
import { createAct } from '../turn/act.ts';
import { createSelfreflection } from '../turn/selfreflection.ts';
import { createDrawGif } from '../turn/draw-gif.ts';
import { createMediaPick, gifVectorModel } from './media-pick.ts';
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
import {
  FAILED_TURN_KEEP_MS,
  SKIP_NOTHING_TO_DO,
  SKIP_SILENCE,
  journalResultOf,
  journalTurnRecord,
  sendHash,
  settleUnknownSends,
} from '../turn/journal.ts';
import { answerOf, callViewOf, createLookupRing, lookupSettingsOf, requesterOf, searchHandles } from '../turn/calls.ts';
import type { Lookup } from '../turn/calls.ts';
import { frameReadsOver } from '../memory/db/frame-reads.ts';
import { createFindMeaning, findSettingsOf } from '../memory/db/graph-find.ts';
import type { FindMeaning, FindMeaningSource, FindMemoEntry } from '../memory/db/graph-find.ts';
import { lookupsOfRecords } from '../memory/journal.ts';
import type { FrameReads } from '../memory/db/frame-reads.ts';
import type { Db } from '../memory/db/types.ts';
import type { Context } from '../memory/db/scope.ts';
import { taskInput } from '../turn/task-input.ts';
import { runAttempt } from '../turn/phases/attempt.ts';
import type { Untyped } from '../tools/types.ts';
import type { TurnParams } from '../turn/outcome.ts';
import type { Reads } from '../interface/reads.ts';
import { untracked } from '../loop-watch.ts';
import type { CreateTurnRunnerInput, TurnRunner } from './turn-types.ts';

// A set's pictures are split and named as the selfreflection's mirrors send them (src/behavior/mirror.ts).
export { chunkPictures };

/**
 * How a turn ended. `spoke` and `skip` reached the model (a skip chose
 * silence); `busy` (another turn blocks this one), `paused` (`/nep pause`),
 * `not-now` (a source gone, or a call answered meanwhile) never did; `refused`
 * is a rail (request or token cap) and carries its `limit`; `error` is any
 * other failure, logged -- a turn dropped unposted at its bar
 * (pace.dropAfterMs, `turn: dropped`) included.
 */
export type TurnOutcome = 'spoke' | 'skip' | 'busy' | 'refused' | 'paused' | 'not-now' | 'cancelled' | 'error';

/** A turn's result with its outcome named. */
export type ReportedTurn = Omit<Awaited<ReturnType<ReturnType<typeof createOutcome>['runTurn']>>, 'outcome'> & {
  outcome: TurnOutcome;
};

// The functions of a turn that stand on their own live in src/turn/; these are the names importers and tests read here.
export {
  FAILED_TURN_KEEP_MS,
  SKIP_NOTHING_TO_DO,
  SKIP_SILENCE,
  answerOf,
  callViewOf,
  continuationHistory,
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
  searchHandles,
  sendHash,
  settleUnknownSends,
  taskInput,
  untaggedNote,
};

// The server search on a question's own words lives with the recall planning (src/behavior/recall.ts).
export { fallbackLookupPlan };

// The re-watch classifier's answer parser lives with the re-watch (src/turn/rewatch.ts).

/**
 * `images` (src/llm/images.js#createImageGen) is optional: absent,
 * `features.imageGeneration` false, or a channel where the bot cannot attach
 * files, her `draw.create` is refused and no drawing line reaches `<senses>`.
 *
 * `lookup` (src/web/lookup.js#createLookup) is optional too: absent, or
 * `features.webLookup` not true, no link is read and no search is made.
 *
 * `recall` (src/behavior/recall-run.ts#createRecall) is optional too: the
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
 * `getSelfName` (src/index.ts) is the persona's display name in a place;
 * default: the client's cached place member, else the bot user's name.
 *
 * A call whose text passes the splitter's pre-filter (src/behavior/split.ts)
 * asks the splitter (prompts/split.md) beside the turn's preparation, under
 * its deadline. `one`, a late, failed or unparsable answer, a missing prompt
 * or a labels file without `labels.task.part`: the turn goes on as if it had
 * never been asked. Parts in time: the turn sets its preparation aside and
 * runChain answers the parts one after another (see there).
 *
 * Participation (src/memory/participation.js; features.participation and features.memory,
 * a missing key counts as on; never in a private chat or a place of her selfreflection): every message a
 * turn sends for real in a server channel is recorded in the place's participation store with
 * the history lines before it and the line it replies to (recordOwnParticipation).
 *
 * Everything a turn prepares before its reply request (the file previews, the
 * captions, the videos and their re-watch, the link reads, the search
 * classifier with its searches) starts as soon as its inputs exist and runs alongside the
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
 * `activity` (src/behavior/activity.ts#createActivity, fed by src/behavior/pipeline.ts; optional)
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
 * (src/format.ts#withTriggers), so the request's `<chat>` and `<channel_view>` and every
 * analyzer transcript built from that history name the message that started the turn which posted
 * each line (`transcript.triggeredBy` / `triggeredByOlder`). The neighbours' lines show no `#n`
 * and carry none. A spontaneous turn or a selfreflection post links nothing.
 *
 * Call marks: every skill call she makes (runCall: its skill, status, target and the messages its
 * turn posted) is remembered in process, `seedCallMarks` adding the ones the journal kept from
 * before a restart; a message a call posted in another channel than its turn's remembers that
 * channel. Each call stands as a line of hers at its time among the lines of the place she called it from, in
 * `<chat>` and in a pulled channel (callMarksOf, src/turn/history.ts#orderedHistory), and her line posted from
 * another place's turn names that place (linkCalls), so she sees what she called and how it went.
 *
 * Skills and the interface: every effect of a reply -- a message with its reply target and
 * mentions, the GIF, the picture's publication after its generation, a selfreflection set's pictures, a
 * reaction, the typing indicator -- is checked by src/tools/gateway.ts#checkReplyEffect right
 * before it runs (`message.create`, a picture or GIF being one with its media or URL, and
 * `message.react.add`: carried over in the current chat, refused only under the full stop
 * -- features.tools false, she goes silent; each refusal logs `skill: refused` (`skill`, `code`,
 * `reason`) and nothing is done; no picture or selfreflection set is generated for a post the check
 * already refuses, and no typing indicator shows), then made through the interface port `port`
 * (src/interface/port.js). Nothing counts as posted (journal, record, stats, lastPostAt) unless the port
 * answered `ok`; `unknown` is journaled as unknown and never sent again.
 *
 * Skill calls: her skills are the owner's /nep commands (src/tools/registry.ts; `skills`: the
 * registry checked against, default skillRegistry()). Her tools -- the skills granted to her and the
 * carried-over ones (src/tools/discovery.ts#exposedSkillNames) -- travel with every request of a
 * turn, as native tool definitions or, with `tools.transport` `text`, as a `<tools>` block. Every
 * call of an answer is planned in her order (planToolCall: on an immutable envelope built by code,
 * callEnvelope; journaled `proposed` with its invocation id and tool call id, repaired where the
 * schema allows (coerceArgs), resolved on the server's side, checked) and made in segments (runCall:
 * checked again right before, then run by src/tools/executors.ts through `runOp(op, args,
 * context)` -- src/admin.ts#runSkillOp, the command's own path, the requester's rights checked
 * again; absent, a call is `not_configured`; her own expressive operations through
 * `runOwnOp`, src/admin.ts#runOwnSkillOp, her grant alone; an inner turn's calls through
 * `runInitiativeOp`, src/admin.ts#runInitiativeSkillOp, her grant alone). Her speech goes out after
 * the calls, when all of them worked and none gave her something to read; else it is held and the
 * results come back to her in one more request (runSteps), bounded by `tools.loop`.
 *
 * Reactors: `reactors` (src/behavior/reactor-store.ts#createReactorStore, null: none) is the store of
 * who reacted to her messages, fed by `reaction.changed`; the turn's history read names them on her lines
 * (reactorNames).
 *
 * Intentions: `intentions` (src/intentions/service.ts#createIntentionService, null: none) gives the
 * `<intentions>` block of every turn but a selfreflection post while features.intentions is exactly true.
 *
 * The interface: `reads` (src/interface/reads.ts#createReads over the port) is how a turn asks the interface
 * about a chat, its lines, a member and the reactors: `runTurn` takes a chat reference and reads
 * its info (the permissions, the audience) and one snapshot of the root's chats per attempt. A read the
 * interface does not offer leaves its block out of the request; a chat it no longer knows ends the turn
 * `unavailable` before any model call. `selfId()` is the persona's id on the interface (from `hello`), `getSelfName`
 * her name in a root, `memberOf(placeId, accountId)` the name and kind of a member the core has been told of,
 * `membersOf(placeId)` all of them and `chatName(id)` the name the interface gave a chat.
 */
// health: allow function-length until 2027-04-01 -- the closure holds its whole operation, grown by the one dependency that names the loop watch
export function createTurnRunner({
  hot,
  store,
  llm,
  calibrator,
  rng = Math.random,
  describer = undefined,
  fetchImpl = fetch,
  imageFetcher = createImageFetcher(),
  lookup = undefined,
  recall = null,
  images = undefined,
  speech = null,
  emoji = undefined,
  // The embedder of the media pick's candidate search (src/behavior/media-pick.ts); null: it reads the captions' words.
  embedQuery = null,
  // The embedder of the finder and media.find (graph-find.ts#createFindMeaning); null: they read words only.
  embedFind = null,
  // The data folder a library GIF's cached file is read from; null: no file to post.
  dataDir = null,
  getSelfName = () => 'bot',
  selfId: selfIdOf = () => '',
  stemmer = () => null,
  reads: readsDep,
  memberOf = () => null,
  membersOf = null,
  chatName = () => null,
  now: clock = Date.now,
  schedule = scheduleTimer,
  activity = null,
  journal = null,
  record = null,
  port,
  skills = null,
  activeSkills = null, // her active skills for the tools array and the sink of their use rows (src/skills/); null: none
  recordSkillUses = null,
  runOp = null,
  runOwnOp = null,
  runInitiativeOp = null,
  around = null,
  reactors = null,
  errands = null,
  intentions = null,
  // The places view of the inner life (src/behavior/inner.ts#places): `<places>` on an addressed turn with `context.places` on.
  places = null,
  // The memory rows a request carried (src/memory/db/service.js#recordTurnReads) and a turn's execution context (#issueContext, `(spec) => ctx`); null: none.
  memoryReads = null,
  selfreflectionFacts = null,
  // The memory's read handle while it is open, for `<my_day>` (src/turn/request/my-day.ts); null: no block.
  journalDb = null,
  ownerAccount = null,
  personLinks = null,
  memoryContext = null,
  // Her attention, one turn at a time (src/behavior/attention.ts mirrors it as leases; a plain set without them), the model roles that are down (src/llm/role-health.ts, her tool roles route on it); null: none.
  attention = new Set(),
  roleHealth = null,
  track = untracked,
  cancelOf = () => null,
  noteProgress = () => {},
}: CreateTurnRunnerInput): TurnRunner {
  const ifaceReads: Reads = readsDep;
  // What she did today under a turn's context, read from the journal's rows; `[]` while the database is closed.
  const myDay: MyDayReader | null = journalDb
    ? (context, now, timezone, options) => {
        const db = journalDb() as JournalReader | null;
        if (!db) return [];
        return myDayOf(db, context, (id) => placeChainInDb(db, id)[0]?.name ?? null, now, timezone, options);
      }
    : null;
  // The reads of a framed request beside her day: the graph reader, her lines elsewhere, a line by its identity.
  const frameReads: FrameReads | null = journalDb
    ? frameReadsOver(
        () => journalDb() as Db | null,
        () => hot.config
      )
    : null;
  // Her lookups per place for `<recall>` (src/turn/calls.ts), in process, seeded at start with the call marks.
  const lookupRing = createLookupRing([]);
  const busy = attention;
  const routes = turnRoutes(hot, roleHealth);
  // The topic modules of the closure (src/turn/<topic>.ts), each built once from the context it reads.
  const { aroundInputFor, liveChannelName, recordOwnParticipation } = createParticipation({
    hot,
    store,
    around,
    clock,
  });

  const iface = port;
  const inputs = createInputs({ store, iface, memoryContext, errands, intentions, places });
  const { turnContextOf, chatOf, messageOf, checkEffect } = inputs;

  const { facts, setFactsSource } = createFacts({ clock });
  // The channels known to be private chats (a deferred call names only its channel).
  const dmChannels = new Set<string>();
  const lastPostAt = new Map<string, number>(); // placeId -> ts of the persona's last message
  // placeId -> ids of the messages in the history of the last turn that spoke there (noteSpokeSaw).
  // The pending-ping drain (src/behavior/pipeline.ts) skips a ping such a turn already had in view.
  const spokeSaw = new Map<string, Set<string>>();
  // Whether the last turn that wanted prompts['follow-up'] found it missing: warned once each time (falls back to reply.md).
  const promptState = { followUpMissing: false };
  // Posted message id -> the id of the message that started the turn which posted it, in
  // process (noteTrigger at each post, seedTriggerLinks at start from the journal); the oldest
  // links go first past TRIGGER_LINKS_MAX. Her transcript lines read it (linkTriggers).
  const triggerLinks = new Map();

  // The persona's skill calls, in process (noteCall at each call, seedCallMarks at start from the
  // journal), oldest first, the oldest dropped past CALL_MARKS_MAX; and posted message id -> the
  // channel of the turn that posted it from another channel (notePostedFrom). Her transcript
  // lines read both (linkCalls).
  const callMarks: Array<Untyped> = [];
  const postedFromLinks = new Map();

  // The last think per place (src/behavior/previous-think.ts), in process, seeded at start from the journal (seedThinks).
  const thinks = createThinkStore();

  /** Her thinks of yesterday and today in the place journal's `turn` records, into the store; a failed read is logged. */
  async function seedThinks(placeId: string): Promise<void> {
    // The core's journal (src/memory/journal.ts#createJournal) as far as its `read` goes.
    const reader = journal as { read?: (placeId: string, query: object) => Promise<Array<unknown>> } | null;
    if (typeof reader?.read !== 'function') return;
    try {
      const at = clock();
      for (const day of [utcDay(at - DAY_MS), utcDay(at)])
        thinks.seed(await reader.read(placeId, { day, kind: 'turn', n: Number.MAX_SAFE_INTEGER }), {
          isDm: false,
        });
    } catch (error) {
      log.warn('turn: thinks not seeded', { placeId, error });
    }
  }

  /** Her lookups of yesterday and today in the place journal's skill operations, into the ring; a failed read is logged. */
  async function seedLookups(placeId: string): Promise<void> {
    const reader = journal as { read?: (placeId: string, query: object) => Promise<Array<unknown>> } | null;
    if (typeof reader?.read !== 'function') return;
    try {
      const at = clock();
      const records: Array<unknown> = [];
      for (const day of [utcDay(at - DAY_MS), utcDay(at)])
        records.push(...(await reader.read(placeId, { day, n: Number.MAX_SAFE_INTEGER })));
      const config: unknown = hot.config;
      const settings = lookupSettingsOf(config);
      for (const one of lookupsOfRecords(records) as Array<Lookup>) lookupRing.note(one, settings);
    } catch (error) {
      log.warn('turn: lookups not seeded', { placeId, error });
    }
  }

  // The persona's recent time away from the journal's system records, reused for a minute.
  const readOffPeriods = createOffPeriodsReader({ journal, now: clock });
  const {
    factsOfKind,
    keepFact,
    noteTrigger: noteTriggerLink,
    linkTriggers,
    earlierThinkFor,
    recordTurnThink,
    noteCall,
    notePostedFrom,
    seedTriggerLinks,
    seedCallMarks,
    linkCalls,
    callMarksOf,
    journalOn,
    offPeriodsFor,
    writeTurnRecords,
    recordSaid,
    journalOp,
  } = createJournalNotes({
    hot,
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
  });
  // A post answering a trigger also anchors the lookups that trigger anchors, so a reply to her post keeps them.
  const noteTrigger = (postedId: unknown, triggerId: unknown): void => {
    noteTriggerLink(postedId, triggerId);
    if (typeof postedId === 'string' && typeof triggerId === 'string') lookupRing.follow(triggerId, postedId);
  };
  const { runTurn, recordTurnFacts, notifyIdle, waitingParts, addToPart, waitIdle, setOnIdle, setOnTurnEnd } =
    createOutcome({
      store,
      clock,
      busy,
      facts,
      factsOfKind,
      keepFact,
      // Each topic module types the draft of an attempt by the fields it reads; all of them are views of one `Draft`.
      writeTurnRecords: (list: Array<unknown>) => writeTurnRecords(list as Parameters<typeof writeTurnRecords>[0]),
      runTurnOnce,
    });
  const { prepareSelfreflection, selfreflectionPictureGate } = createSelfreflection({
    hot,
    store,
    llm,
    rng,
    lookup,
    images,
    journalOp,
    selfreflectionFacts,
  });
  const mediaPick = createMediaPick({
    hot,
    // The runner's store is the memory store (src/memory/store.ts), which holds the library and the rails the pick reads.
    store: store as Parameters<typeof createMediaPick>[0]['store'],
    llm,
    clock,
    ...(embedQuery ? { embedQuery } : {}),
  });
  const { drawTool, postGif, pickedInTime } = createDrawGif({
    hot,
    store,
    dataDir,
    images,
    imageFetcher,
    ifaceReads,
    iface,
    routes,
    selfIdOf,
    clock,
    schedule,
    ...inputs,
    lastPostAt,
    selfreflectionPictureGate: (config, channel, now) =>
      selfreflectionPictureGate(config as Parameters<typeof selfreflectionPictureGate>[0], channel, now),
  });
  const { emojiLookup, renderPost, settleAuthor, settles, selfreflectionChannelName } = createSends({
    hot,
    store,
    emoji,
    chatName,
    clock,
    schedule,
    activity,
    iface,
  });
  const { typingWhileCalls } = createTyping({ iface, schedule, clock, chatOf });
  const { holdSpeech, act } = createAct({
    hot,
    store,
    rng,
    clock,
    selfIdOf,
    ifaceReads,
    iface,
    chatOf,
    messageOf,
    checkEffect,
    lastPostAt,
    noteTrigger,
    recordSaid,
    journalOp,
    renderPost,
    postGif,
    pickedInTime,
    mediaPick,
    emojiInventory: () => emoji?.list() ?? [],
    recordOwnParticipation,
  });
  const { noteSpokeSaw } = createPulls({ spokeSaw });
  // One memo of the finder's embeddings per attempt's draft, keyed by exact text, so a turn embeds a text once.
  const findMeanings = new WeakMap<object, FindMeaningSource>();
  const findMeaningFor = (draft: object | null | undefined): FindMeaningSource | null => {
    if (!embedFind || !draft) return null;
    let made = findMeanings.get(draft);
    if (!made) {
      made = createFindMeaning({
        embed: embedFind,
        model: gifVectorModel(hot.config),
        deadlineMs: findSettingsOf(hot.config).deadlineMs,
        memo: new Map<string, FindMemoEntry>(),
      });
      findMeanings.set(draft, made);
    }
    return made;
  };
  const { callView, planToolCall, runCalls } = createSkillCalls({
    hot,
    store,
    stemmer,
    // A place she names by a stored name or alias, of any interface, read under the turn's memory context.
    placesNamedFor: (draft, channel) => {
      const context = turnContextOf(draft, channel) as Context | null;
      return frameReads?.placesNamed && context
        ? (name: string) => frameReads.placesNamed?.(context, name) ?? []
        : null;
    },
    // The places the memory graph ranks for words of hers that name no place, read under the turn's memory context.
    placesFoundFor: (draft, channel) => {
      const context = turnContextOf(draft, channel) as Context | null;
      return frameReads?.placesFound && context
        ? (words: string, meaning?: FindMeaning) => frameReads.placesFound?.(context, words, meaning) ?? []
        : null;
    },
    findMeaningFor,
    // A #handle she carries names a channel of any interface the memory holds.
    knownPlaces: () => frameReads?.chatPlaces?.() ?? [],
    placeRef: (placeId) => frameReads?.placeRef?.(placeId) ?? null,
    skills,
    selfIdOf,
    clock,
    iface,
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
    lookupRing,
  });
  const { readHistory, noteThink, stepTranscript, runSteps } = createToolRound({
    isWithheld:
      personLinks === null ? null : (iface, chatId, messageId) => personLinks.isWithheld(iface, chatId, messageId),
    hot,
    llm,
    calibrator,
    clock,
    skills,
    ifaceReads,
    reactors,
    memberOf,
    selfIdOf,
    chatOf,
    callView,
    planToolCall,
    runCalls,
    typingWhileCalls,
    holdSpeech,
    act,
  });
  const { inTurnTools } = createInTurnTools({
    personLinks,
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
    chatOf,
    turnContextOf: (draft, channel) => turnContextOf(draft, channel),
    placeReads: frameReads,
    findMeaningFor,
    linkCalls,
    drawTool,
  });
  const { classifierContext } = createRewatch({ hot });
  const { startPrefetch, recallAvailable, turnDirectory, privatePartner, maybeSplit } = createLookup({
    hot,
    store,
    llm,
    clock,
    recall,
    membersOf,
    selfIdOf,
    ifaceReads,
    classifierContext,
    linkCalls,
  });
  // What an attempt and its phases (src/turn/phases/) read: the dependencies, the closure state and the topic functions.
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
    ...{ activeSkills, recordSkillUses },
    memoryReads,
    myDay,
    frameReads,
    ownerAccount: ownerAccount ?? ((placeId: string) => frameReads?.ownerAccount?.(placeId) ?? null),
    lookupRing,
    busy,
    selfIdOf,
    getSelfName,
    dmChannels,
    promptState,
    notifyIdle,
    facts,
    track,
    aroundInputFor,
    liveChannelName,
    ...inputs,
    linkTriggers,
    linkCalls,
    callMarksOf,
    earlierThinkFor,
    journalOn,
    offPeriodsFor,
    journalOp,
    prepareSelfreflection,
    selfreflectionPictureGate,
    emojiLookup,
    settleAuthor,
    settles,
    selfreflectionChannelName,
    noteSpokeSaw,
    readHistory,
    noteThink,
    stepTranscript,
    runSteps,
    cancelOf,
    noteProgress,
    inTurnTools,
    classifierContext,
    startPrefetch,
    recallAvailable,
    turnDirectory,
    privatePartner,
    maybeSplit,
    recordTurnFacts,
    recordTurnThink,
  };

  /**
   * One turn, as described on runTurn. Internal for a split message: `maySplit` (runTurn's
   * first turn may ask the splitter; parts in time end it with the internal
   * outcome `split`, `{ parts, history }`, still holding the attention for
   * runChain), `owned` (a turn of the chain: the chain holds the attention and
   * fires the idle notifications), `part` (`{ index, total, parts }`: its
   * analyzer requests judge that part's text, its request names it), `reuseHistory` (the
   * first part's history, already fetched) and `plainPosts` (a later part
   * posts plain). The attempt itself is src/turn/phases/attempt.ts.
   */
  function runTurnOnce(args: TurnParams) {
    return runAttempt(phases, args);
  }

  return {
    // src/turn/outcome.ts types `outcome` as a string; its values are the names of `TurnOutcome`.
    runTurn: runTurn as (params: Parameters<typeof runTurn>[0]) => Promise<ReportedTurn>,
    seedTriggerLinks,
    // The journal's marks at start name their place: its `turn` records of yesterday and today seed her thinks too.
    seedCallMarks: (marks: { calls?: unknown; postedFrom?: unknown; placeId?: unknown } | null | undefined) => {
      seedCallMarks(marks);
      if (typeof marks?.placeId === 'string') void seedLookups(marks.placeId);
      if (typeof marks?.placeId === 'string') void seedThinks(marks.placeId);
    },
    waitingParts,
    addToPart,
    isBusy: (placeId: string) => busy.has(placeId),
    isAnyBusy: () => busy.size > 0,
    /** The ids of the channels a turn is running in now (for log lines: where the attention is). */
    busyChannels: () => [...busy],
    lastPostAt: (placeId: string) => lastPostAt.get(placeId) ?? 0,
    notePost: (placeId: string, ts: Untyped) => lastPostAt.set(placeId, ts),
    /**
     * Whether the last turn that spoke in `placeId` (this process) had
     * `messageId` in its channel history -- so a direct ping queued while that turn ran was
     * already in front of the model and is not answered a second time. For a channel the bot
     * cannot write in: whether the last turn that spoke while showing that channel's lines
     * (`<channel_view>`) showed `messageId`.
     */
    spokeAfterSeeing: (placeId: string, messageId: string) => spokeSaw.get(placeId)?.has(messageId) ?? false,
    waitIdle,
    setOnIdle,
    /**
     * The facts kept for her next request in a chat (src/behavior/inner.ts's `facts`: `enabled`, `add`,
     * `pending`, `markTold`); used while its `enabled()` says so, else the runner keeps its own in process.
     */
    setFactsSource,
    setOnTurnEnd,
    /**
     * The id of the message that started the turn which posted `postedId` (this process, or
     * seeded from the journal at start), or null.
     */
    triggerOf: (postedId: string): string | null => triggerLinks.get(postedId) ?? null,
  };
}
