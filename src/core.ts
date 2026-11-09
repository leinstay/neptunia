// The composition root: builds the core over the paths, the environment and the interfaces it is given, starts it and
// hands back its door and a way to stop it. It wires config, hot reload, the persistent store, the OpenRouter
// client and the turn and memory subsystems together, starts each interface over the link, and owns the
// core's lifecycle (startup checks, timers, graceful shutdown). No decision logic lives here: everything is imported
// from src/behavior, src/memory and src/llm. Nothing here builds, logs in or listens to a platform client: the
// interface does, and hands back the running interface (src/protocol/host.ts). The entry (src/index.ts) reads the
// paths and the environment, loads the interface packages and handles the process signals; a test calls `startCore`
// with a scripted model and the fake interface.

import { createMessageProducers } from './behavior/core-message-producers.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serviceCredential } from './keys/file.ts';
import { startEngineProxy } from './net/engine-proxy.ts';

import { assertPersonaLayout, localConfigPath, readInterfaceConfig } from './config/files.ts';
import { createHot } from './hot.ts';
import { log, onLog } from './log.ts';
import { createLoopWatch, loopStallMs } from './loop-watch.ts';
import { createMetrics, metricsTap } from './tools/operations/metrics.ts';
import { createUsage, usageTap } from './tools/operations/usage.ts';
import { createMemoryDb } from './memory/db/service.ts';
import { quarantineNotices } from './memory/db/pending-quarantine.ts';
import {
  createStore,
  createAppendStore,
  createJournal,
  createRecord,
  createArchive,
  createVectors,
  createEmbedder as createEmbedQueue,
  createMemoryUpdater,
  createEmojiBackfill,
  createGifBackfill,
  createGifKeeper,
  createGifRecache,
  createDescriber,
  createAvatarQueue,
  startYoutubeCheck,
} from './memory/index.ts';
import { DAY_MS, utcDay } from './time.ts';
import { createCalibrator } from './llm/tokens.ts';
import { archivedLlm } from './llm/archive.ts';
import type { ArchiveWriteGap } from './llm/archive.ts';
import { noteArchiveGap } from './watcher/requests.ts';
import { createLlm, roleApiKey } from './llm/openrouter.ts';
import { createKeyFailover } from './llm/key-failover.ts';
import { MEMORY_ROLE_DEFAULT, ROLE_DEFAULTS, SEARCH_ROLE, roleModel, searchModel } from './llm/roles.ts';
import { statusCardKeys } from './keys/card-keys.ts';
import { createKeysCommands, reasonedPause } from './keys/commands.ts';
import { importKeys } from './keys/import.ts';
import { createKeyRing } from './keys/ring.ts';
import type { KeyOf } from './keys/ring.ts';
import { createKeyStore, keysFileExists } from './keys/store.ts';
import { createRoleHealth, reportingCoreKeys, reportingLlm, roleKeyCheck } from './llm/role-health.ts';
import { createEmbedder } from './llm/embed.ts';
import { createGifFetcher } from './media/gif-files.ts';
import { createImageGen } from './llm/images.ts';
import { createSpeech } from './speech/index.ts';
import { ffmpegAvailable } from './speech/convert.ts';
import { gifVectorModel } from './behavior/media-pick.ts';
import { createTurnRunner } from './behavior/turn.ts';
import { createActivity } from './behavior/activity.ts';
import { ownerNamesOf } from './memory/db/people-read.ts';
import { loadStemmer } from './memory/db/stems.ts';
import { createMissed } from './behavior/missed.ts';
import { createEmojiIndex } from './behavior/emoji-index.ts';
import { ownMessagesOf } from './behavior/own-messages.ts';
import { hasRequiredLabels } from './behavior/prompt.ts';
import { createRecall } from './behavior/recall-run.ts';
import { createInnerLife, innerSettings } from './behavior/inner.ts';
import { createSelfreflection } from './behavior/selfreflection.ts';
import { createMirrors, guardMirrorPort } from './behavior/mirror.ts';
import { createImageFetcher } from './media/fetch-image.ts';
import { openImageStaging } from './media/staging.ts';
import { createVideoFetcher } from './media/fetch-video.ts';
import { createPageFetcher } from './web/fetch-page.ts';
import { createBraveSearch } from './web/brave.ts';
import { createExaSearch } from './web/exa.ts';
import { createLookup } from './web/lookup.ts';
import { createAdmin } from './admin.ts';
import { createErrandClient } from './errands/client.ts';
import { createErrandStores } from './errands/store.ts';
import { groupsContext } from './memory/db/scope.ts';
import type { RetrievalInput } from './memory/retrieval-input.ts';
import { createErrandService } from './errands/service.ts';
import { SELF_PERSON } from './memory/db/ids.ts';
import { createMemberDirectory } from './interface/members.ts';
import { createErrandTurns, errandDoneEvent } from './errands/turns.ts';
import { createEventDoor } from './interface/door.ts';
import { createChatDirectory } from './interface/directory.ts';
import { createOwnerPairing } from './interface/owner-pairing.ts';
import { createPersonLinks, joinScreens } from './interface/person-link.ts';
import { isReadable, takeSnapshot } from './behavior/snapshot.ts';
import {
  CLI_IFACE,
  createIfaceRouter,
  createInterfaceLinks,
  createLinkSwitch,
  openAdapterLink,
} from './interface/link.ts';
import { createCommandDesk, createCommandIntake, coreStatusFacts, lineLinksOf } from './interface/neptunia-cli.ts';
import { createCliChat } from './interface/cli-chat.ts';
import { createChatState } from './interface/commands/chat-state.ts';
import type { ChatState } from './interface/commands/chat-state.ts';
import { createChatSessions } from './chat/sessions.ts';
import { createChatStore } from './chat/store.ts';
import { withStoredHistory } from './chat/stored-history.ts';
import { echoThrough, keepLineFiles, withKeptSends } from './chat/kept-media.ts';
import { createKeptFetch } from './media/kept-files.ts';
import type { ApprovalGate, ApprovalResult } from './board/approval-view.ts';
import { createCheckpointDesk } from './development/checkpoint-desk.ts';
import { WORKTREE_FOLDER } from './development/edges.ts';
import { selfimprovementSettings } from './selfimprovement/settings.ts';
import { chatLines, recentGroupLines } from './memory/db/chat-lines.ts';
import { ownerConsoleName } from './memory/db/identity-links.ts';
import { ownerMemoryRuns } from './memory/db/media-english.ts';
import { mediaText } from './memory/db/media-store.ts';
import { OWNER_CLIENT } from './setup/clients.ts';
import { createConsole } from './interface/commands/console.ts';
import { rolePath, statusBrief } from './interface/commands/status-brief.ts';
import { wakeClockOf } from './service/commands.ts';
import { isPausedIn, resumeHeld } from './behavior/core-pause.ts';
import { configuredInterfaces, drainMs, interfaceEnabled } from './interface/mode.ts';
import { loadPrincipals, principalOfToken } from './interface/principals.ts';
import { claimCore } from './memory/db/open.ts';
import { ownerPersonOf, useOwnerAccounts } from './tools/operations/grants.ts';
import { readLocalConfig, setPath, writeLocalConfig } from './tools/operations/shared.ts';
import { moveConfigKeys } from './config-moves.ts';
import { createIngestRecord } from './memory/db/ingest.ts';
import { coreSocketPath, listenSocket } from './interface/socket.ts';
import { MAX_FRAME_BYTES, connectSocket } from './protocol/wire.ts';
import { createAroundStore } from './behavior/around-store.ts';
import { createScheduler } from './behavior/scheduler.ts';
import { boardSettings, boardTimings } from './board/board.ts';
import { createBoardPort } from './board/writer.ts';
import { createReactorStore, applyReactionChanged } from './behavior/reactor-store.ts';
import { currentIface, withIface } from './memory/db/current-iface.ts';
import { createRootRoutes } from './core-routing.ts';
import { accountOf, chatOfPlace, dmPartnerOf, placeOfChat } from './memory/addresses.ts';
import { personaJournal, personaRecord } from './behavior/inner/persona-sources.ts';
import { PERSONA_ID } from './memory/db/storage-keys.ts';
import { createOwnerAccounts } from './memory/db/person-links.ts';
import { createReads } from './interface/reads.ts';
import { createIntentionStores } from './intentions/store.ts';
import { createIntentionService } from './intentions/service.ts';
import { skillRegistry, missingDefinitions } from './tools/registry.ts';
import { wireSkills } from './skills/wiring.ts';
import { createReportReader, reportsDirOf, watcherDir } from './watcher/read.ts';
import { watcherNews } from './watcher/news.ts';
import { createTagHistory, deprecatedModelKeys } from './behavior/mention.ts';
import { createMessageHandler } from './behavior/pipeline.ts';
import { createLeasedAttention } from './behavior/attention.ts';
import { RELATIONSHIP_LIMITS } from './memory/text-limits.ts';
import { createInstalledBackend, runChildProcess } from './agent-runner/backend.ts';
import { helpOfInstalled } from './subharness/place.ts';
import { DEFAULT_BASE_URL } from './subharness/models.ts';
import { backendUsageReader, execUsage, spawnUsageChild } from './subharness/usage.ts';
import { deferModeToUnit } from './setup/install.ts';
import { REPLY_CHECK_MS } from './subharness/control.ts';
import { clearMemoryPath, memoryCheckPath, memoryPath } from './subharness/memory-path.ts';
import { clearSubscriptionPath, harnessBackend } from './subharness/subscription-path.ts';
import { coreSubscription } from './subharness/subscription-client.ts';
import { createLoginState } from './subharness/login-state.ts';
import { memoryWriterClient } from './subharness/memory-writer.ts';
import { memoryProbe } from './subharness/memory-probe.ts';
import { createRouteWatches, probeWord } from './subharness/route-watch.ts';
import type { RouteWatches } from './subharness/route-watch.ts';
import { recordCoreCheck } from './setup/model-check.ts';
import type { EffortLevel } from './llm/roles.ts';
import type { SessionContext } from './memory/db/session.ts';
import { objOf, type Untyped } from './tools/types.ts';
import type {
  ConnectionChanged,
  ChatChanged,
  InnerWake,
  MembershipChanged,
  PresenceChanged,
  PresenceSnapshot,
  ReactionChanged,
  SchedulerTick,
  VoiceChanged,
} from './protocol/events.ts';
import type { resolvePaths } from './paths.ts';
import type { InterfaceHost, RunningInterface } from './protocol/host.ts';
import type { Drained, From, InterfaceState } from './interface/link.ts';
import type { Principal } from './interface/principals.ts';
import type { Envelope, Transport } from './protocol/wire.ts';
import type { Hello } from './protocol/serve.ts';
import type { ErrandRecord } from './errands/types.ts';
import type { ErrandDoneEvent } from './errands/turns.ts';

const REQUIRED_PROMPTS = ['system-prompt', 'character-card', 'format', 'reply'];

/** The first name a stored profile holds (the store hands a profile out as a plain object). */
const firstName = (profile: object | null): string | undefined =>
  (profile as { names?: Array<string> } | null)?.names?.[0];

/**
 * Throw a one-line, secret-free error: the entry prints it and exits with a non-zero code, a test sees the throw.
 */
function fail(message: string): never {
  throw new Error(message);
}

/** The chat client as the core hands it on. */
type ChatClient = Omit<ReturnType<typeof createLlm>, 'complete'> & {
  complete: (messages: Untyped, options?: Untyped) => Promise<Untyped>;
};

/**
 * Build the core and start it. `paths` are the checkout, the private layer and the data directory (src/paths.ts),
 * `env` the environment the core reads its own keys from (never logged), `interfaces` the interfaces to start in
 * this process: one (`interfaces.mode: inprocess`), or none, when the interfaces run as units and connect to the
 * socket themselves; the core then serves `bot.placeId`. `llm`, `embedder` and `now` replace the provider client,
 * the embedding client and the clock (the scheduler, the inner life and the one-core check): only a test passes them.
 * One core runs over a data directory: a live holder of the database lock refuses the start (`locked`), and so does
 * another holder's `core:alive` lease within its ttl (`core-running`), unless the lock it left names a process that is
 * gone. Resolves once the startup steps ran; rejects with a one-line error when a startup check fails. `stop()` ends
 * everything `startCore` began and never exits the process. `interfaces` lists the interfaces with the owner's switch
 * and whether one is connected, and `disable(name)` writes `interfaces.<name>.enabled: false` to config.local/config.json,
 * stops sending to that interface, gives its actions in flight `interfaces.drainMs` and ends the rest `unknown`.
 */
export async function startCore(options: {
  paths: ReturnType<typeof resolvePaths>;
  env: Readonly<Record<string, string | undefined>>;
  interfaces: ReadonlyArray<{ name: string; start(host: InterfaceHost): Promise<RunningInterface> }>;
  llm?: Pick<ReturnType<typeof createLlm>, 'complete'> & Partial<ReturnType<typeof createLlm>>;
  embedder?: Pick<ReturnType<typeof createEmbedder>, 'embed'> & Partial<ReturnType<typeof createEmbedder>>;
  now?: () => number;
}): Promise<{
  door: ReturnType<typeof createEventDoor>;
  stop(signal?: string): Promise<void>;
  interfaces: { list(): Array<InterfaceState>; disable(name: string): Promise<Drained>; enable(name: string): void };
}> {
  // What the start opened, closed in reverse order when it fails: a failed start leaves no socket, link, watcher, timer or
  // database lock behind, so a process that tried to start a core can end.
  const cleanups: Array<() => unknown> = [];
  try {
    return await buildCore(options, cleanups);
  } catch (err) {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        // The start failed already: closing what is left is best effort.
      }
    }
    throw err;
  }
}

/**
 * `startCore`'s steps. Every resource it opens registers its closing in `cleanups`; once `shutdown` exists it stands for them all.
 */
// health: allow function-length until 2027-04-01 -- the old entry's body moved whole, split into subsystem builders in stage 5
// health: allow complexity until 2027-04-01 -- the old entry's body moved whole, split into subsystem builders in stage 5
async function buildCore(
  options: Parameters<typeof startCore>[0],
  cleanups: Array<() => unknown>
): ReturnType<typeof startCore> {
  const { paths, env, interfaces } = options;
  if (path.resolve(paths.privateDir) !== path.resolve(paths.dataDir))
    fail('privateDir must match dataDir: prepare the persona with scripts/persona-files-move.ts');
  assertPersonaLayout(paths.dataDir, paths.rootDir);
  const clock = options.now ?? Date.now;
  // The checkout and canonical persona data root are logged once. privateDir aliases dataDir.
  log.info('index: paths', { rootDir: paths.rootDir, privateDir: paths.privateDir, dataDir: paths.dataDir });
  if (interfaces.length > 1) fail(`index: the core starts one interface at most, got ${interfaces.length}.`);
  // No interface in this process: they run as units, and the root comes from the settings.
  const asUnits = interfaces.length === 0;

  // The persona key ring is read for each request; an empty store remains available to the keys commands.
  const keyStore = createKeyStore({ privateDir: paths.privateDir });
  const keyRing = createKeyRing({ store: keyStore, failover: createKeyFailover({ now: clock }) });
  const ringNow = () => keyRing;
  /** The key of `role` in the key store, null while there is none (`.env` serves then), '' when the store has no key for it. */
  const keyOf: KeyOf = (role) => keyRing.route(role)?.value ?? '';
  const openrouterKey = '';
  // Optional: without it a YouTube duration comes from the watch page only.
  const youtubeApiKey = serviceCredential(paths.dataDir, 'youtube');
  // Optional: without it the `brave` engine of quick search stays off (the web lookup still reads links). Never logged.
  const braveApiKey = serviceCredential(paths.dataDir, 'brave');
  // Optional: without it the `exa` engine of quick search stays off. Sent as a bearer header, never logged.
  const exaApiKey = serviceCredential(paths.dataDir, 'exa');

  fs.mkdirSync(paths.dataDir, { recursive: true });
  const hot = createHot({ rootDir: paths.rootDir, privateDir: paths.privateDir }).watch();
  cleanups.push(() => hot.close());

  // The engine proxy (src/net/engine-proxy.ts) in force before anything connects; the interfaces never take it.
  const proxy = startEngineProxy({ dataDir: paths.dataDir, config: (): unknown => hot.config, now: clock, log });
  cleanups.push(() => proxy.stop());

  const missingPrompts = REQUIRED_PROMPTS.filter((name) => typeof hot.prompts[name] !== 'string' || !hot.prompts[name]);
  if (!hasRequiredLabels(hot.prompts.labels)) missingPrompts.push('labels');

  if (missingPrompts.length > 0) {
    const files = missingPrompts.map((name) => (name === 'labels' ? 'config/labels.json' : `prompts/${name}.md`));
    fail(
      `index: missing required prompt file(s): ${files.join(', ')} ` +
        '(prompts.local/ may override any of these prompt files, file by file, and config.local/labels.json the labels).'
    );
  }

  // The persona's skills against the operations registered by the imports above: a skill on an unknown operation is a
  // programming error and stops the start here.
  try {
    skillRegistry();
  } catch (err) {
    fail(`index: invalid skill registry: ${String(objOf(err).message)}`);
  }
  // A definition whose operation is not registered is left out of the registry, said loudly at start; the bot goes on.
  {
    const missing = missingDefinitions();
    if (missing.length > 0) log.error('skills: definitions without a registered operation', { missing });
  }

  // The old per-feature model keys (classifier.* replaced them) are named once at start, never their values.
  for (const { key, use } of deprecatedModelKeys(hot.config))
    log.warn('index: deprecated model key ignored', { key, use });

  const dataDir = paths.dataDir;
  // The parts of the hot reload the one-core claim and the interfaces' switches read and write (src/hot.ts).
  const settings = hot;
  // The event loop watch (src/loop-watch.ts): a late tick logs the operations open or just ended around it.
  const loopWatch = createLoopWatch({
    log,
    now: Date.now,
    thresholdMs: () => loopStallMs(hot.config),
    sampleMs: 250,
    setInterval,
    clearInterval,
  });
  cleanups.push(() => loopWatch.stop());
  // One core over this data directory, claimed before anything below touches it or the socket.
  fs.mkdirSync(dataDir, { recursive: true });
  let releaseCore: () => void = () => {};
  try {
    const dbFile: string | undefined = hot.config.memoryDb?.file;
    releaseCore = claimCore(path.join(dataDir, dbFile || 'memory.db'), { now: clock });
  } catch (err) {
    fail(`index: ${err instanceof Error ? err.message : String(err)}`);
  }
  cleanups.push(() => releaseCore());
  // Who the persona is on the interface and which namespace its ids belong to: set once from `hello`, read at each use.
  const identity = { iface: '', selfId: '', selfName: 'bot' };
  // The names of the members of the served root, fed by `membership.changed` (a nickname change included).
  const members = createMemberDirectory();
  // The memory database (src/memory/db/service.js): the memory. Created before the memory modules, which read and write
  // it (src/memory/db/readers/, src/memory/db/unit-write.js). Readiness is awaited before durable stores are created.
  // selfreflectionMediaDeps is read at each tick: the interface port and the image fetcher exist by then (defined below).
  // `embed` and `selfName` (the re-embed job, recall.db.reembed) are the embedding client and her name, defined below.
  // Her memory session is the memory writer: it runs on the chat client (role `memory`, its own key from `env`), and a
  // run that fails is told to her as a `memoryFailed` fact (inner, defined below). A pending write the open sets aside
  // (src/memory/db/pending-quarantine.ts) is a `pendingQuarantined` fact, held until the inner life exists.
  // The options are named first: the module declares the ones it reads, and `embed` and `selfName` are not among them yet.
  // The session's model client (src/subharness/memory-writer.ts): the chat client below on the direct path, else one run
  // through the subharness config.json names; set once the chat client exists. A refused run wakes the memory probe.
  let sessionClient: SessionContext['llm'] | null = null;
  // The probe of the writer's path (src/subharness/memory-probe.ts), created with the pause below.
  let watches: RouteWatches | null = null;
  // Whether the last run of the core or the memory writer through its harness lost its login, for the chat's header.
  const logins = createLoginState();
  const quarantine = quarantineNotices(clock, log);
  const memoryDbOptions = {
    hot,
    dataDir,
    log,
    selfreflectionMediaDeps: () => ({ port: iface, imageFetcher }),
    // The interface the unit writes name their rows with: the one of `hello`, known once the link is up.
    iface: () => currentIface() ?? (identity.iface || null),
    embed: (texts: Untyped, options: Untyped) => embedder.embed(texts, options),
    selfName: () => identity.selfName,
    sessionLlm: () => sessionClient,
    track: loopWatch.track,
    sessionEnv: () => env,
    sessionKeys: ringNow,
    sessionPath: () => memoryPath(paths.privateDir),
    onSessionFailure: (failure: Untyped) => tellSessionFailure(failure),
    onPendingQuarantined: quarantine.hold,
  };
  const memoryDb = createMemoryDb(memoryDbOptions);
  cleanups.push(() => memoryDb.close());
  cleanups.push(
    useOwnerAccounts(createOwnerAccounts({ database: () => memoryDb.database(), home: () => identity.iface }))
  );
  await memoryDb.open();
  // The speed figures of /nep status (src/tools/operations/metrics.ts): the durations the log lines carry,
  // kept for 24 h in the database metrics unit, written every minute and on shutdown.
  const metrics = createMetrics({ dataDir, log, memoryDb });
  const untapMetrics = onLog(metricsTap(metrics));
  cleanups.push(untapMetrics);
  // The costs field of /nep status (src/tools/operations/usage.ts): today's requests per role from the `llm: usage`
  // lines, kept in the database usage unit, written every minute and on shutdown.
  const usage = createUsage({ dataDir, log, memoryDb });
  const untapUsage = onLog(usageTap(usage));
  cleanups.push(untapUsage);

  // The task board (src/board/, docs/core.md "The task board"): its tables in the memory database, every write of it
  // a write of the memory writer, over the core's clock, the live `board.*` settings and the private layer's
  // clients.json, read at each call. The agents' `task.*` commands, her board tools and the reaper's beat use it.
  const board = createBoardPort({
    write: (write) => memoryDb.memoryWrite({ kind: 'board', write }),
    context: () => ({ at: clock(), settings: boardSettings(settings.config), privateDir: paths.privateDir }),
    briefWaitMs: () => boardTimings(settings.config).briefWaitMs,
  });
  // Her skills (src/skills/wiring.ts): the SKILL.md files of `skills/` and `skills.local/` read at each call, their
  // registry in the memory database written through the memory writer, the index of the active ones for a request and
  // the skill facts of the selfimprovement wake. An activation grants no tool.
  const skillsWiring = wireSkills({
    // The live settings and prompts, read at each use.
    hot: settings,
    memoryDb,
    board,
    selfId: () => identity.selfId,
    rootDir: paths.rootDir,
    privateDir: paths.privateDir,
    now: clock,
    log,
  });
  // The record (src/memory/record.js): every observed message, the persona's own lines and her
  // feelings, written while features.record is exactly true (read at each write).
  // A snapshot holds the record's appends with the journal's writer lock (journal.withWriterLock).
  const recordWriter = createRecord({ dataDir, log, writerGate: () => journal.waitUnlocked(), memoryDb });
  // The meaning index (src/memory/vectors.js): its writers wait on the same writer lock.
  const vectors = createVectors({ dataDir, log, writerGate: () => journal.waitUnlocked(), memoryDb });
  // The live embedding queue (src/memory/embedder.js), set once the embedding client exists below.
  let embedQueue: Untyped = null;
  // The one place the meaning index hears of new record lines: every writer (edits and deletions, the persona's own
  // lines, feelings) appends through this record, and once an append took lines they are queued for embedding (the
  // queue keeps what it wants and is off unless features.meaningSearch and features.embedIndex are both exactly true).
  const record = {
    ...recordWriter,
    async append(placeId: string, lines: Untyped, opts?: Untyped) {
      const result = await recordWriter.append(placeId, lines, opts);
      if (embedQueue && result?.written > 0) {
        try {
          embedQueue.enqueue(placeId, lines, opts ?? {});
        } catch (err) {
          log.warn('index: embed enqueue failed', { placeId: String(placeId), code: objOf(err).code ?? null });
        }
      }
      return result;
    },
  };
  // The archive (src/memory/archive.js): every memory item a write drops is copied here before any
  // hot list loses it, while features.archive is exactly true (read at each write). Its own append
  // store for the pending queue (an operational file), so its counts speak for the archive alone.
  const archiveAppendStore = createAppendStore({
    // Production value, config cut of 2026-10-31.
    fsyncMs: 500,
    retryMax: hot.config.appendStore?.retryMax ?? 1000,
    log,
  });
  const archive = createArchive({
    appendStore: archiveAppendStore,
    dataDir,
    log,
    writerGate: () => journal.waitUnlocked(),
    memoryDb,
  });
  // The journal's writer lock (a snapshot) flushes the archive's append store too, and holds the
  // record's and the archive's writers through their writerGate.
  const journal = createJournal({
    dataDir,
    lockStores: [archiveAppendStore],
    memoryDb,
  });
  const store = createStore({
    dataDir,
    record,
    archive,
    memoryDb,
    track: loopWatch.track,
  });
  const processState = store.state; // state.json: the pause flag, the daily counters and the process's marks
  const calibrator = createCalibrator(processState.data.calibration);
  // Which model roles are down (src/llm/role-health.ts): one tracker for the turns, the operations, the describer and
  // `/status`. A role has no key when the key it resolves to is empty (src/llm/openrouter.js#roleApiKey).
  const harnessOf = (role: string): string | null => harnessBackend(paths.privateDir, role);
  const roleHealth = createRoleHealth({
    now: () => Date.now(),
    hasKey: roleKeyCheck({ hot, env, mainKey: openrouterKey, keyOf, served: (role) => harnessOf(role) !== null }),
  });
  // `env` (the .env loaded once above): the keys `llm.keyByRole` names per role, looked up per request.
  // createLlm (src/llm/openrouter.js) declares `complete` as `Function`, which no caller's declared call accepts, so
  // the core hands the client on typed as the call the modules below make.
  // The core's own failure `keys-exhausted` (every key of its list out of credit) is told to the tracker.
  const requestArchive = {
    write: (update: Record<string, unknown>) => memoryDb.memoryWrite(update),
    log,
    backend: 'openrouter',
    noteGap: (gap: ArchiveWriteGap) => noteArchiveGap(paths.privateDir, gap),
  };
  const directLlm = (options.llm ??
    reportingCoreKeys(
      createLlm({
        apiKey: openrouterKey,
        env,
        keys: ringNow,
        getConfig: () => hot.config,
        calibrator,
        state: processState,
      }),
      roleHealth
    )) as ChatClient;
  const subscription = coreSubscription({ direct: directLlm, paths, hot, state: processState, usage, logins });
  const llm = archivedLlm(subscription.llm, requestArchive);
  // Her memory session through a subharness never reaches the chat client, so it has its own archive wrap.
  sessionClient = archivedLlm(
    memoryWriterClient({
      writer: {
        privateDir: paths.privateDir,
        runChild: runChildProcess,
        workDir: path.join(os.tmpdir(), 'neptunia-memory'),
      },
      direct: directLlm,
      record: (entry) => usage.record(entry),
      onRefused: () => void watches?.refused('memory'),
      ran: (backend, outcome) => logins.ran('memory', backend, outcome),
    }),
    requestArchive
  );
  // Embeddings (role embedding) on the same daily request count as the chat client.
  const embedder = options.embedder ?? createEmbedder({ apiKey: openrouterKey, env, keyOf, state: processState });
  // The meaning index kept current: record lines queued above, flushed on the tick below.
  embedQueue = createEmbedQueue({
    hot,
    vectors,
    embed: (texts, opts) => embedder.embed(texts, opts),
    record: recordWriter,
    log,
    nameOf: (placeId, accountId) =>
      firstName(store.getUser(accountOf(store, accountId))) ?? members.nameOf(nativeOfPlace(placeId), accountId),
    selfName: (placeId) => getSelfName(placeId),
    // No catch-up pass while paused (the owner may be editing data/); /nep resume runs one.
    paused: () => processState.data.paused === true,
    memoryDb,
  });
  // The persona's drawings: its own daily rails, counted on the same state. Pictures are paid with the drawing role's
  // key (`llm.keyByRole.drawing`, the agents' key), read at each request; the main key when the role names none. The
  // options are named first: the module does not declare `state`, the daily counter it shares with the chat client.
  const imageOptions = {
    apiKey: () => keyOf('drawing') ?? roleApiKey(hot.config, env, 'drawing', openrouterKey),
    getConfig: () => hot.config,
    state: processState,
  };
  const images = createImageGen(imageOptions);
  // The persona's voice messages: the preparation pass on the analyzer, the synthesis on the
  // voice role's key and model, the conversion with the system ffmpeg. Without ffmpeg there is no `speech` at
  // all (the skill answers `speech-not-configured`), reported once.
  const speechReady = ffmpegAvailable();
  if (!speechReady) log.warn('speech: ffmpeg not found, voice messages are off', {});
  const speechOptions = {
    getConfig: () => hot.config,
    getPrompts: () => hot.prompts,
    env,
    apiKey: openrouterKey,
    keyOf,
    llm,
    state: processState,
  };
  const speech = speechReady ? createSpeech(speechOptions) : null;

  // Shared, so a picture attached on several turns is downloaded once within the fetcher's LRU window.
  // An image from the owner's terminal waits in the staging folder, and these readers open its reference like any address.
  const imageStaging = openImageStaging(paths.dataDir);
  void imageStaging.sweep();
  // A file of the owner's chat kept under media/cli/ (src/chat/kept-media.ts) is opened by its reference too.
  const keptFetch = createKeptFetch({ dataDir, next: imageStaging.fetch });
  const imageFetcher = createImageFetcher({ fetchImpl: keptFetch });
  const videoFetcher = createVideoFetcher({ fetchImpl: keptFetch });
  // state: the daily video counter lives next to the LLM client's daily counter.
  // Its vision and video requests tell the role health how they went.
  const describerLlm = reportingLlm(llm, { health: roleHealth, hot, roles: ['vision', 'video'] });
  const describerDeps = {
    hot,
    store,
    llm: describerLlm,
    imageFetcher,
    videoFetcher,
    state: processState,
    youtubeApiKey,
    proxy: () => proxy.current(),
    track: loopWatch.track,
  };
  const describer = createDescriber(describerDeps);
  // The web lookup (features.webLookup, off by default): link reader + search on a question.
  // state: the daily web counter lives next to the LLM client's daily counter.
  // The options are named first: the module does not declare `state`, the daily web counter.
  const lookupOptions = {
    hot,
    // The store answers a media cache as a plain object; the lookup reads it as its cache entries.
    store: store as unknown as Parameters<typeof createLookup>[0]['store'],
    llm,
    state: processState,
    pageFetcher: createPageFetcher(),
    // web.quickSearch.engine picks one of these, and nothing answers in its place.
    searches: { brave: createBraveSearch(), exa: createExaSearch() },
    keys: { brave: braveApiKey, exa: exaApiKey },
  };
  const lookup = createLookup(lookupOptions);
  // The persona's display name in a root: the one name every request uses. Her nickname there when the member
  // directory holds one (a nickname change reaches it through `membership.changed`), else the name `hello` gave.
  const getSelfName = (placeId: string | null) =>
    members.nameOf(nativeOfPlace(placeId ?? ''), identity.selfId) ?? identity.selfName;

  // The link between the core and its interfaces (docs/interfaces.md): the core listens on a Unix socket under the
  // data directory, an interface connects with its token, says hello and serves its adapter. Every inbound event
  // travels as an envelope to the core's door and every effect of the persona travels back as an action. An interface
  // started here connects with a token made at boot; a unit connects with the token of its client in clients.json.
  // The socket folder is set to 0750 and the file to 0660 for the group `neptunia` (src/interface/socket.ts).
  const LINK_SOCKET = coreSocketPath(dataDir);
  const linkToken = randomBytes(32).toString('hex');
  // Every client is a principal of the private layer's clients.json (src/interface/principals.ts), read at each
  // envelope. The token made here is the boot principal of the one in-process interface whatever that file holds, named
  // after it and bound to the iface its hello names.
  const bootPrincipal = {
    name: interfaces[0]?.name ?? 'boot',
    kind: 'interface' as const,
    iface: null,
    permissions: [],
  };
  const principalOf = (token: string) =>
    principalOfToken(token, { privateDir: paths.privateDir, boot: { token: linkToken, principal: bootPrincipal } });
  // The interface clients of clients.json, read when the core needs their names.
  const interfaceClients = () => (loadPrincipals(paths.privateDir) ?? []).filter((entry) => entry.kind === 'interface');
  if (asUnits) {
    // The namespace the modules below are built with comes from clients.json before any unit connects: the first it
    // names is the home interface of what no chat addresses (wakes, the selfreflection). Every effect of a turn goes by
    // the `iface` of its own reference (`createIfaceRouter`), so the other interfaces work beside it.
    const ifaces = [...new Set(interfaceClients().map((entry) => entry.iface))];
    identity.iface = ifaces[0] ?? '';
  }
  // One setting of the private settings file, its keys of an old name settled first (src/config-moves.ts), then reloaded.
  function writeLocalSetting(parts: ReadonlyArray<string>, value: unknown): void {
    const file = localConfigPath(paths.privateDir);
    writeLocalConfig(file, setPath(moveConfigKeys(readLocalConfig(file)).config, parts, value));
    settings.reloadConfig();
  }
  // The owner's switch of each interface (interfaces.<name>.enabled), written to the private settings file and reloaded,
  // as the owner commands write it (src/tools/operations/env.ts#editLocalConfig).
  function setInterfaceEnabled(name: string, enabled: boolean) {
    const file = localConfigPath(paths.privateDir);
    // No key of an old name lies under `interfaces` (src/config-moves.ts), so the file is edited as it is.
    writeLocalConfig(file, setPath(readLocalConfig(file), ['interfaces', name, 'enabled'], enabled));
    settings.reloadConfig();
  }
  const interfaceLinks = createInterfaceLinks({
    names: () => [
      ...interfaces.map((entry) => entry.name),
      ...interfaceClients().map((entry) => entry.name),
      ...configuredInterfaces(settings.config),
    ],
    isEnabled: (name) => interfaceEnabled(settings.config, name),
    setEnabled: setInterfaceEnabled,
    drainMs: () => drainMs(settings.config),
  });
  // A disabled interface is refused at its hello, read at each one.
  const admit = (principal: Principal) =>
    principal.kind === 'interface' && !interfaceEnabled(settings.config, principal.name) ? 'interface-disabled' : null;
  // The events each principal sent and its watermark (memory.db's ingest and ingest_cursor, src/memory/db/ingest.ts):
  // the door deduplicates against them and commits each event there before its ack, the link answers hello with the
  // watermark. A write before the database opens is refused, and the event is answered `failed`.
  const ingestRecord = createIngestRecord({ memoryDb, hot, now: Date.now });
  // The ingestion row of each message event the door is handling: the observation of its line writes the row in the
  // line's transaction (observe.js#observe).
  // The door is created below, once its handlers exist; an envelope that arrives sooner waits for it.
  const doorReady: PromiseWithResolvers<{ receive(value: unknown, from?: From): Promise<Envelope> }> =
    Promise.withResolvers();
  const linkDoor = {
    receive: async (value: unknown, from: From | undefined) => {
      const door = await doorReady.promise;
      // Everything this event does to memory happens under the interface it came from.
      const envelope = (value as { body?: { iface?: unknown }; iface?: unknown } | null) ?? null;
      return withIface(envelope?.body?.iface ?? envelope?.iface, () => door.receive(value, from));
    },
  };
  const linkOpened: PromiseWithResolvers<ReturnType<typeof openAdapterLink>> = Promise.withResolvers();
  // With the interfaces as units the core's adapter starts with no link: the first interface whose hello is taken
  // becomes the one the core serves.
  let linkSwitch: ReturnType<typeof createLinkSwitch> | null = asUnits ? createLinkSwitch(null) : null;
  let servedName: string | null = null;
  // Every connected interface by name, and which of them serves each root. One persona across all of them: the
  // served interface above keeps the core's identity and capabilities, and an effect goes by the reference's `iface`.
  const linksByName = new Map<string, ReturnType<typeof createLinkSwitch>>();
  const rootRoutes = createRootRoutes({ current: currentIface });
  /** The roots a hello names: the one it serves first, then the rest. */
  const helloRoots = (greeting: Hello) =>
    [greeting.root, ...(greeting.roots ?? [])].flatMap((one) => (one ? [one] : []));
  function connectInterface(name: string, greeting: Hello, link: ReturnType<typeof openAdapterLink>) {
    const known = linksByName.get(greeting.iface);
    if (known === undefined) linksByName.set(greeting.iface, createLinkSwitch(link));
    else known.attach(link);
    const named = helloRoots(greeting);
    const roots = named.map((one) => one.id);
    rootRoutes.note(greeting.iface, roots);
    store.noteRoots(greeting.iface, named, greeting.names);
    log.info('index: interface connected', { principal: name, iface: greeting.iface, roots: roots.length });
  }
  /** True for a root some connected interface serves, and the configured one before any said hello. */
  /** The native id of a root, from the place the core holds it by. */
  const nativeOfPlace = (id: string): string => store.nativeRootOf(store.rootPlaceOf(id) ?? id) ?? id;
  const isServedRoot = (id: string | null | undefined): boolean =>
    typeof id === 'string' && rootRoutes.isServed(nativeOfPlace(id));
  /** The canonical place of every root the connected interfaces serve. */
  const servedPlaces = (): Array<string> =>
    rootRoutes.servedList().map(({ iface: name, nativeId }) => store.placeOfRoot(nativeId, name));
  /** The served interface's hello: who the persona is on it. */
  function greet(greeting: Hello) {
    identity.iface = greeting.iface;
    identity.selfId = greeting.self.id;
    identity.selfName = greeting.self.name;
  }
  // The owner's commands (src/interface/neptunia-cli.ts) are answered before the door: a command never reaches her
  // memory or a turn. The desk exists once the admin does, below; a command that arrives sooner waits for the door.
  let commandDesk: ReturnType<typeof createCommandDesk> | null = null;
  let chatState: ChatState | null = null;
  const numberOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null);
  const stringOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
  const ownerName = (): string | null => ownerConsoleName(memoryDb.database());
  // A chat line keeps its staged files and gains its links. Her `cli:dm:owner` replies go to the last line's link.
  const intake = createCommandIntake({
    door: keepLineFiles(linkDoor, { dataDir, readStaged: (id) => imageStaging.read(id) }),
    ready: () => doorReady.promise,
    desk: () => commandDesk,
    linesHeld: () => isPausedIn(store),
    runner: () => turns,
    chatCommands: (name: string, args: Record<string, unknown>) => chatState?.command(name, args) ?? null,
    lineLinks: lineLinksOf({ hot, parseLinks: (texts) => reads.parseLinks(texts) }),
    ownerName,
    log,
  });
  const linkServer = await listenSocket({
    path: LINK_SOCKET,
    maxFrameBytes: MAX_FRAME_BYTES,
    log,
    onConnection: (transport) => subscription.serve(transport, openInterfaceLink),
  });
  cleanups.push(() => linkServer.close());
  function openInterfaceLink(transport: Transport) {
    const link = openAdapterLink({
      transport,
      door: intake.doorOf(() => link),
      principalOf,
      ingest: ingestRecord,
      log,
      admit,
    });
    interfaceLinks.add(link);
    if (linkSwitch === null) {
      linkOpened.resolve(link);
      return;
    }
    // A reconnect of the interface takes over the core's adapter; another client's link only sends events.
    const switched = linkSwitch;
    link.hello.then(
      (greeting) => {
        const principal = link.principal();
        if (principal?.kind === 'interface') connectInterface(principal.name, greeting, link);
        if (asUnits && servedName === null && principal?.kind === 'interface') servedName = principal.name;
        if (principal === null || principal.name !== (asUnits ? servedName : switched.current().principal()?.name))
          return;
        switched.attach(link);
        if (asUnits) greet(greeting);
      },
      () => {}
    );
  }
  // An interface run in this process is started by the caller (src/index.ts loads the interface package by name at run
  // time, a test passes the fake one) with the core's end of the link, its settings and its logger. It builds its
  // client, logs in, waits for the place, says hello and serves its adapter; the events it sees wait until
  // `running.open()` below, when the door has its handlers. A refusal (no token, no place, no login) stops the start
  // here. A unit does all of it in its own process (bin/neptunia.ts).
  // The interface's settings are the core's with its package's own and its private file over them
  // (src/config/files.ts#readInterfaceConfig), read again when the core's settings reload.
  /**
   * @param current  The core's settings now.
   */
  const interfaceConfigOf = (name: string, current: () => Record<string, unknown>): (() => Record<string, unknown>) => {
    let seen: unknown = null;
    let settings: Record<string, unknown> = {};
    return () => {
      const core = current();
      if (core !== seen) {
        seen = core;
        settings = readInterfaceConfig({ rootDir: paths.rootDir, privateDir: paths.privateDir, name, base: core });
      }
      return settings;
    };
  };
  const running = asUnits
    ? null
    : await interfaces[0]
        .start({
          connect: () => connectSocket({ path: LINK_SOCKET, maxFrameBytes: MAX_FRAME_BYTES }),
          token: linkToken,
          dataDir: path.join(dataDir, 'interfaces', interfaces[0].name),
          env: {},
          config: interfaceConfigOf(interfaces[0].name, () => hot.config),
          onConfigChange: (listener) => hot.onReload(listener),
          log,
        })
        .catch((err) => fail(`index: ${err instanceof Error ? err.message : String(err)}`));
  if (running !== null) cleanups.push(() => running.stop());
  const coreLink = linkSwitch ?? createLinkSwitch(await linkOpened.promise);
  linkSwitch = coreLink;
  cleanups.push(() => coreLink.close());
  // Awaited before anything below is built: every module that takes the port gets the link's adapter, whose
  // `iface` and capabilities exist once hello has arrived. Nothing sends before this line. A unit says hello later,
  // and until then the adapter answers as a link that dropped.
  const hello = asUnits
    ? null
    : await coreLink.current().hello.catch((err) => fail(`index: the link to the interface failed: ${String(err)}`));
  if (hello !== null) {
    greet(hello);
    const named = helloRoots(hello);
    rootRoutes.note(
      hello.iface,
      named.map((one) => one.id)
    );
    store.noteRoots(hello.iface, named);
  }
  // The around store tells a presence event from a voice one by what the interface declares in `hello`: whether it
  // reports presences at all (intents are fixed at login, the interface reads its own at its start).
  // The live glance at the voice channels and the scene's statuses: a snapshot in process memory,
  // fed by the interface's voice, presence and connection events through the door below, never written anywhere.
  const around = createAroundStore({ presences: () => coreLink.adapter.capabilities().presence === true });
  // The owner's chat sessions (docs/cli.md): a file of their own, whose lines are a read of memory's stored sources.
  const chatSessions = createChatSessions({
    store: createChatStore({
      file: path.join(paths.privateDir, 'cli', 'sessions.json'),
      readLines: (placeId) => chatLines(memoryDb.database(), placeId),
    }),
    now: clock,
    newId: randomUUID,
  });
  // The owner's chat exists while no client is open (src/interface/cli-chat.ts): a text post is kept as her line and
  // shown when it opens; its history reads the stored lines; a file she sends is kept and echoed through the door.
  const cliChat = createCliChat({ live: () => intake.chat(), now: clock, newId: randomUUID });
  const partnerOf = (placeId: string): string | null => dmPartnerOf(store, placeId);
  const cliAdapter = () =>
    withKeptSends(
      withStoredHistory(cliChat, (id) => chatSessions.shown(id), partnerOf, ownerName),
      { dataDir, newId: randomUUID, echo: echoThrough(linkDoor) }
    );
  // The persona's interface (src/interface/port.js): every effect of her replies goes through it,
  // after the skill gateway (src/tools/gateway.ts) let the call pass. It is the guarded port: a send to a selfreflection
  // mirror's place goes nowhere (`selfreflection-mirror`); only the mirrors' publisher below holds the link's own adapter.
  // Her replies in the owner's chat (`iface: 'cli'`) go to the open chat, every other effect to the served
  // interface; with no chat open a text reply there is kept for the chat, and a history read there answers the stored
  // lines alone.
  const routed = createIfaceRouter(
    coreLink.adapter,
    (name) => (name === CLI_IFACE ? cliAdapter() : (linksByName.get(name)?.adapter ?? null)),
    () => [cliAdapter(), ...[...linksByName.values()].map((link) => link.adapter)],
    (nativeId) => {
      const name = rootRoutes.ifaceOf(nativeId, (one) => linksByName.get(one)?.current().isClosed() === false);
      return name === null ? null : (linksByName.get(name)?.adapter ?? null);
    }
  );
  const iface = guardMirrorPort(routed, { memoryDb });
  // The selfreflection's mirrors (src/behavior/mirror.ts): each recorded entry published once to every enabled mirror, through
  // the link of the mirror's own interface, or none while that link is closed.
  const mirrorPort = (name: string) => {
    const link = linksByName.get(name) ?? (coreLink.adapter.iface === name ? coreLink : null);
    return link === null || link.current().isClosed() ? null : link.adapter;
  };
  const mirrors = createMirrors({ memoryDb, port: mirrorPort, now: Date.now, dataDir, config: () => hot.config });

  // The core's reads of the interface: each answers its body or null, and a block that needs one is left out when it is null.
  const reads = createReads(iface, log, (id) =>
    id === PERSONA_ID ? null : store.nativeRootOf(store.rootPlaceOf(id) ?? id)
  );
  // The custom emoji of the turn's place, read from the interface and kept 60 seconds: the turn lists them to her
  // and turns her `:name:` into the platform's markup through it.
  const emoji = createEmojiIndex({
    reads,
    now: Date.now,
  });
  // What each profiled member's avatar looks like (features.avatars, off by default): a throttled
  // background queue on the vision role, its daily counter next to the LLM client's. Each member is one read of the
  // interface; a member who left reads as gone.
  // The options are named first: the module does not declare `state`, the daily counter it shares with the chat client.
  const avatarOptions = {
    hot,
    store,
    llm,
    imageFetcher,
    state: processState,
    selfId: () => identity.selfId,
    reads,
    paused: () => processState.data.paused === true,
  };
  const avatars = createAvatarQueue({
    ...avatarOptions,
    isServedRoot,
    servedPlaces,
  });
  // Who reacted to her messages, fed by `reaction.changed` (the door below) and by the `reactors` read.
  const reactors = createReactorStore();
  // The search of the server's own history beside the web search: the lookup's server part.
  // It reads the archive and the record too (read only), and with features.meaningSearch the meaning
  // index (one embedding of the question per run).
  const recall = createRecall({
    hot,
    store,
    llm,
    reads,
    memberName: (placeId, accountId) => members.nameOf(nativeOfPlace(placeId), accountId),
    describer,
    archive,
    record,
    vectors,
    embed: (texts: Array<string>, opts: Untyped) => embedder.embed(texts, opts),
    memoryDb,
    iface: identity.iface,
    track: loopWatch.track,
  });
  // When each person last wrote in each channel (fed by the message handler): a turn answering
  // someone waits until they stop writing (pace.settleMs).
  const activity = createActivity();
  // The persona's errands (`errands.*`, `agents.<profile>` overrides): a task she or a member asks for goes to its agent runner over
  // its socket in the background (src/errands/); the errands are tasks of the board's errand lane in memory.db.
  const agentPaths = { rootDir: paths.rootDir, dataDir: paths.dataDir, env };
  const errandClient = createErrandClient({ hot, log, agentPaths });
  const taskStores = createErrandStores({ config: () => hot.config, journal, log, memoryDb, agentPaths });
  // An errand's end opens her own turn where it was asked (the task turns, created below the runner).
  // An errand's end is an `errand.done` event through the event door (`door`, created below with
  // the gateway's handlers), its id `errand-done:<errand id>`; the door's handler (src/errands/turns.ts#onEvent) first
  // moves the intentions waiting on it back to pending, then opens her turn, which shows them with the outcome. Once
  // the door took the event its end is marked delivered on the board, so a core started after a crash finds only the
  // ends it never delivered (ErrandStore#pendingEnds).
  async function submitErrandEnd(task: ErrandRecord) {
    const answer = await door.submit({ ...errandDoneEvent(task), id: `errand-done:${task.id}` });
    if (answer.status === 'ok' || answer.status === 'duplicate') taskStores.get()?.markDelivered(task.id);
    return answer;
  }
  // A task's `context.recent`: the channel's newest lines from the memory database (her own under her name), oldest first.
  function recentChannelLines(chatId: string, count: number) {
    const db = memoryDb.database();
    if (!db || !chatId || !(count > 0)) return [];
    const rows = recentGroupLines(db, placeOfChat(store, { id: String(chatId) }, identity.iface), count);
    const lines: Array<{ author: string; text: string }> = [];
    for (const row of rows) {
      let name = '';
      if (row.kind === 'said') name = hot.config?.bot?.name ?? '';
      else {
        try {
          const names = JSON.parse(row.names ?? '[]');
          name = Array.isArray(names) && typeof names[0] === 'string' ? names[0] : '';
        } catch {
          name = '';
        }
      }
      lines.push({ author: name, text: [row.text ?? '', mediaText(row.media ?? [])].filter(Boolean).join(' ') });
      if (lines.length >= count) break;
    }
    return lines.reverse();
  }
  const errands = createErrandService({
    agentPaths,
    privateDir: paths.privateDir,
    client: errandClient,
    stores: taskStores,
    hot,
    env,
    memory: { recentLines: recentChannelLines },
    // An errand's facts: a group read, because a runner never sees a private chat.
    retrieve: (input) =>
      memoryDb.retrieve(memoryDb.issueContext({ kind: 'group', iface: currentIface() ?? identity.iface }), input, {
        sources: false,
      }),
    log,
    onFinished: (task) => submitErrandEnd(task),
    proxy: () => proxy.current(),
  });
  // The persona's intentions: data/places/<id>/intentions.json, her own `intent.*` calls and the waits on her errands.
  // Both stores send their writes to the database; `flush` is their retry and shutdown step.
  const intentionStores = createIntentionStores({ log, memoryDb });
  const intentions = createIntentionService({ stores: intentionStores, hot, errands, log });
  // Chats the interface reported and dms it showed: names for the inner life and the turn, a dm on a session failure.
  const directory = createChatDirectory();
  // When the interface's link to its platform last came back, for /nep status.
  const connection: { lastReconnectAt: number | null } = { lastReconnectAt: null };
  const embedOne =
    (purpose: string) =>
    async (text: string): Promise<ArrayLike<number> | null> =>
      (await embedder.embed([text], { config: hot.config, purpose }))[0] ?? null;
  // The GIF library's captions, vectors and cached files (src/memory/gif-keeper.ts).
  const gifKeeper = createGifKeeper({
    store,
    dataDir,
    fetchBytes: createGifFetcher({ fetchImpl: imageStaging.fetch }),
    embed: embedOne('media-pick'),
    embedModel: () => gifVectorModel(hot.config),
    describer,
    log,
  });
  // The memory's learned stemmer, read at each use: the alias gate and the places a read call names match with it.
  const learnedStemmer = () => {
    const handle = memoryDb.readHandle();
    return handle ? loadStemmer(handle.db as Parameters<typeof loadStemmer>[0]) : null;
  };
  // Her link tool (src/interface/person-link.ts): `person.link` in a turn, and the door's check of the next message.
  const personLinks = createPersonLinks({ hot, memoryDb, port: iface, now: clock });
  const turns = createTurnRunner({
    personLinks,
    track: loopWatch.track,
    dataDir,
    fetchImpl: keptFetch,
    embedQuery: embedOne('media-pick'),
    embedFind: embedOne('recall-query'),
    // A cancel and the steps of a turn over a line of the owner's chat (src/interface/chat-turns.ts).
    cancelOf: (triggerId: string | null) => intake.cancelOf(triggerId),
    noteProgress: (triggerId: string | null, step: { name: string; detail: string }) =>
      intake.noteProgress(triggerId, step),
    hot,
    store,
    roleHealth,
    // The memory rows a turn's request carried go to the database.
    memoryReads: (args: Untyped) => memoryDb.recordTurnReads(args),
    // A selfreflection post's stored facts, read through the one retrieval service under the selfreflection's context.
    selfreflectionFacts: (input: RetrievalInput) => memoryDb.retrieve(groupsContext(), input, { sources: false }),
    journalDb: () => memoryDb.readHandle()?.db ?? null, // the journal's rows for <my_day>, while the database is open
    // One execution context per turn for its memory reads (recorded while the database is open).
    memoryContext: (spec: Untyped) => memoryDb.issueContext({ iface: currentIface() ?? identity.iface, ...spec }),
    // Her attention, mirrored as leases in the memory database (attention.ts).
    attention: createLeasedAttention({ memoryDb, hot, holder: `core:${process.pid}`, log }),
    llm,
    calibrator,
    describer,
    imageFetcher,
    lookup,
    recall,
    images,
    speech,
    emoji,
    around,
    reactors,
    getSelfName,
    selfId: () => identity.selfId,
    stemmer: learnedStemmer,
    reads,
    memberOf: (placeId: string, accountId: string) => members.infoOf(nativeOfPlace(placeId), accountId),
    membersOf: (placeId: string) => members.list(nativeOfPlace(placeId)),
    chatName: (chatId: string) => directory.nameOf(chatId),
    activity,
    journal,
    record,
    port: iface,
    // Her active skills, each an entry of the tools array, and the sink of the use rows (src/skills/uses.ts).
    activeSkills: skillsWiring.active,
    recordSkillUses: skillsWiring.record,
    // Her skills run by operation name, the requester's rights checked again
    // (src/admin.ts#runSkillOp); read at call time, the admin being created below.
    runOp: (op: Untyped, args: Untyped, context: Untyped) => admin.runSkillOp(op, args, context),
    // Her own messages, drawings and selfreflection run on her grant alone (src/tools/definitions.ts, trait `self`).
    runOwnOp: (op: Untyped, args: Untyped, context: Untyped) => admin.runOwnSkillOp(op, args, context),
    // An inner turn's calls (her own initiative, nobody asked) run on her grant alone too.
    runInitiativeOp: (op: Untyped, args: Untyped, context: Untyped) => admin.runInitiativeSkillOp(op, args, context),
    // `<errands>`: her open and newly finished errands; an errand's caps are its skill's budget.
    errands,
    // `<intentions>`: her open intentions.
    intentions,
    // `<places>` on an addressed turn (context.places): the inner life's places view, read at call time.
    places: (options: Untyped) => inner.places(options),
  });
  // The persona's selfreflection: its own entries on a day plan as the selfreflection wake, ticked below, each published to the
  // selfreflection's mirrors. The selfreflection's posts are rows of the memory database already: no backfill from the channel.
  const selfreflection = createSelfreflection({ hot, store, reads, turns, mirrors });
  // The code-only memory of the live message path (src/memory/update.js): counters, GIF library, emoji, names.
  const memory = createMemoryUpdater({ hot, store, gifKeeper });
  // The turn an errand's end opens, through the lease and a cooldown per chat.
  const taskTurns = createErrandTurns({
    hot,
    reads,
    iface: () => identity.iface,
    turns,
    errands,
    intentions,
    log,
  });
  // The places the interface lists for a root, as the inner life shows them to her: the channels she may read, with
  // whether she can write there. The view is read synchronously, so the last listing of each root is kept here,
  // read again when a chat changes and before each beat of the inner life.
  const placeListings: Map<string, Array<{ id: string; name: string; writable: boolean }>> = new Map();
  async function refreshPlaces(placeId: string) {
    const snapshot = await takeSnapshot(reads, placeId);
    if (snapshot === null) return;
    placeListings.set(
      placeId,
      snapshot.chats
        .filter((entry) => isReadable(entry))
        .map((entry) => ({ id: entry.id, name: entry.name ?? entry.id, writable: entry.permissions.send }))
    );
  }
  const placesOf = () => [...placeListings.values()].flat();
  async function refreshAllPlaces() {
    for (const placeId of servedPlaces()) await refreshPlaces(placeId);
  }
  // The persona's inner life (features.wakes, off by default; docs/inner-life.md): a scheduler
  // that lists what is due for her (her intentions, waits past their deadline, one daily review, the lines of the places she attends),
  // hands each as an `inner.wake` event through the door, and runs an inner turn when the one
  // attention is free and no cap refuses. Its tick is a beat of the scheduler below; a no-op with the switch off.
  // Resolved once the journal's start-up reconciliation is done (or failed): an inner turn that the last run left in flight is
  // resolved from the journal only after it (src/behavior/inner.ts, `ready`).
  let journalReconciled: () => void = () => {};
  const journalReconciledPromise = new Promise<void>((resolve) => {
    journalReconciled = resolve;
  });
  const inner = createInnerLife({
    hot,
    dataDir,
    ready: () => journalReconciledPromise,
    turns,
    intentions,
    record: personaRecord(record, store, servedPlaces),
    // Her attention: the places the interface publishes, and the names of the people a wake names.
    places: placesOf,
    // The names of the chats the interface reported (`chat.changed`), for the places she is shown.
    chatName: (chatId) => directory.nameOf(chatId),
    nameOf: (accountId: string) => firstName(store.getUser(accountOf(store, accountId))) ?? null,
    journal: personaJournal(journal, servedPlaces, store),
    reads,
    iface: () => identity.iface,
    store,
    // People's turns first: an inner turn waits while a direct ping is queued.
    peopleWaiting: () => onMessage.pendingCount() > 0,
    submit: (event) => door.submit(event),
    // Each inner turn as a wake run in the memory database.
    memoryDb,
    // A live wake turn's posts go out through the guarded port once the wake completed (src/behavior/inner/deliveries.ts).
    port: iface,
    now: clock,
    // The selfimprovement wake's facts beyond the journal (src/behavior/selfimprovement-view.ts): her grants, her
    // skills with their use counts, her proposals and her outbox rows on the board, and the watcher's newest report.
    selfimprovement: {
      ...skillsWiring.selfimprovement,
      watcher: (now) => watcherNews({ config: hot.config, rootDir: paths.dataDir, now }),
    },
    log,
  });
  // The drops, holds and failures kept for her next request in a chat live in the inner life's state.
  turns.setFactsSource(inner.facts);
  /**
   * A memory session run that failed (src/memory/db/service.js, once per failing scope),
   * told the same way: a `memoryFailed` fact with the code and the lines waiting; a private chat's only in that
   * private chat (its DM channel, when the client knows it). Never throws.
   */
  function tellSessionFailure({
    scopeKind,
    place,
    code,
    lines,
    at,
  }: {
    scopeKind: Untyped;
    place: Untyped;
    code: Untyped;
    lines: Untyped;
    at: number;
  }) {
    try {
      if (inner.facts?.enabled?.() !== true) return;
      const dmChat = scopeKind === 'dm';
      const chatId =
        dmChat && typeof place === 'string'
          ? chatOfPlace(store, place, (partner) => directory.dmChatOf(partner))
          : null;
      inner.facts.add({ kind: 'memoryFailed', code, waiting: lines, placeId: chatId, dmChat, at });
    } catch (err) {
      log.warn('index: memory session failure not told', { code: objOf(err).code ?? null });
    }
  }
  // The engine proxy's fallback and recovery reach her like any failure: a `proxySwitched` fact.
  proxy.tellTo(inner.facts);
  quarantine.tellWith((fact) => inner.facts?.enabled?.() === true && inner.facts.add(fact));
  const tagHistory = createTagHistory();
  // Messages that may have been left without an answer (src/behavior/missed.ts): facts from the
  // address gate, the pending queue and every turn's end, a delayed sweep per channel, and a
  // recovery turn only with features.missedRecovery on (shadow mode by default).
  const missed = createMissed({
    hot,
    store,
    journal,
    llm,
    turns,
    reads,
    partnerOf: (chatId) => directory.partnerOf(chatId),
    getSelfName,
    dataDir,
    memoryDb,
  });
  turns.setOnTurnEnd((end) => {
    missed.onTurnEnd(end);
    // `neptunia -p` with text ends when the turn over its line ends.
    intake.turnEnded(end);
  });
  // The custom emoji ranking read from history (the interface's reads only, no model call): once at startup, again on /nep emoji rescan.
  const emojiBackfill = createEmojiBackfill({ store, reads, iface: () => identity.iface, log });
  // The GIF library read from history (the interface's reads; the describer captions the top ones): once at
  // startup, again on /nep gifs rescan.
  const gifBackfill = createGifBackfill({
    store,
    reads,
    iface: () => identity.iface,
    describer,
    keeper: gifKeeper,
    log,
  });
  // The GIF library re-described by watching (src/memory/gif-recache.js): only on /nep gifs recache; and the pictures
  // an older model described, found through the record: only on /nep media kind:pictures action:recache.
  const gifRecache = createGifRecache({
    hot,
    store,
    reads,
    iface: () => identity.iface,
    emoji,
    describer,
    record,
    log,
  });

  // The owner's pairing of his accounts (src/interface/owner-pairing.ts): the door's screen and `/interfaces pair`.
  const ownerPairing = createOwnerPairing({ hot, memoryDb, port: iface, selfId: () => identity.selfId, now: clock });
  const onMessage = createMessageHandler({
    screen: joinScreens(personLinks, ownerPairing),
    gifKeeper,
    isServedRoot,
    rootsOf: (name: string) => rootRoutes.rootsOf(name),
    hot,
    store,
    // The core's reads of the interface: the chat a message is in, its history, a message by id, a member.
    reads,
    selfId: () => identity.selfId,
    turns,
    memory,
    tagHistory,
    // The alias gate reads the memory's learned stemmer; while the database is closed it matches whole words.
    stemmer: learnedStemmer,
    // Her aliases: the names the owner gave her own person record, `/memory users names add person:self <name>`.
    selfNames: () => {
      const handle = memoryDb.readHandle();
      return handle ? ownerNamesOf(handle.db as Parameters<typeof ownerNamesOf>[0], SELF_PERSON) : [];
    },
    getSelfName,
    describer,
    // features.followUp: the address classifier's own, separate LLM call.
    llm,
    // web.links.prefill: a posted link is read ahead of time.
    lookup,
    // pace.settleMs: every member's message is noted for the turn runner's settle wait.
    activity,
    // features.record: deletions and edits reach the record.
    record,
    // A failed address gate and a replaced deferred follow-up are missed-answer facts.
    missed,
    // Every observed message goes to the memory database as an observation: the record of the line.
    memoryDb,
    // The owner's command line belongs to `bot.ownerPerson`, minted with its first line on a raw install.
    ownerPerson: {
      current: () => ownerPersonOf(settings.config),
      adopt: (person: string) => writeLocalSetting(['bot', 'ownerPerson'], person),
    },
    // The limit and pause notices go out through the interface like any other effect.
    port: iface,
  });

  // One turn at a time (mention.oneAtATime): once a turn frees its channel, answer
  // the oldest pending direct ping it may have collected while busy elsewhere.
  turns.setOnIdle(() => onMessage.drainPending());

  const admin = createAdmin({
    hot,
    store,
    // Her board tools (src/tools/operations/board.ts): she files and reads as the builtin principal `persona`.
    board,
    // Her skill tools (src/tools/operations/skill.ts): `skill.read` and `skill.disable`.
    skills: skillsWiring.access,
    // Her tool `watcher.read` (src/tools/operations/watcher.ts): the reports folder follows `watcher.dir` at each read.
    watcher: createReportReader(() => reportsDirOf(paths.dataDir, watcherDir(hot.config))),
    roleHealth,
    // The operations' `env.reads`: the chat they post in, a message's event.
    reads,
    // Who the persona is, and the names of members and chats the interface reported.
    selfId: () => identity.selfId,
    getSelfName,
    memberNameOf: (placeId, accountId) => members.nameOf(nativeOfPlace(placeId), accountId),
    directory,
    // /nep status: when the interface's link to its platform last came back.
    connection,
    // /nep message and /nep draw channel: post through the persona's interface, as her.
    port: iface,
    // /nep task: the persona's errands.
    errands,
    // /nep task intent: her intentions.
    intentions,
    // /nep task inner: the inner life's kill switch and status.
    inner,
    calibrator,
    turns,
    // /nep resume: what the pause kept, the held messages and the queued pings, handed back once.
    pending: {
      drain: () => resumeHeld({ ingest: ingestRecord, handler: onMessage, hot, store, now: Date.now, log }),
    },
    // The image client's quota and model family, for the owner commands; /nep draw generates through it.
    images,
    // The voice messages' quota and pipeline, for the skill `voice.say`.
    speech,
    // /nep draw self: the avatar reference, fetched the same way a turn fetches it.
    imageFetcher,
    // /nep emoji status|rescan: the emoji ranking and its history backfill.
    emojiBackfill,
    // /nep gifs status|rescan: the GIF library and its history backfill.
    gifBackfill,
    // /nep gifs recache: the library's captions re-described by watching; /nep pause waits for it.
    gifRecache,
    // /nep memory archive | restore: the archive of what left hot memory.
    archive,
    // /nep pause|resume: system records; /nep memory journal reads it.
    journal,
    // /nep status: the owner card probes every role's model and the drawing model's listing.
    llm,
    // /nep status: the embedding role's probe.
    embedder,
    // /nep resume: a catch-up pass of the meaning index; /nep status: its index line.
    embedQueue,
    // /nep status: the memory database's state line.
    memoryDb,
    // /nep status: the record's month indexes for the memory coverage.
    record: recordWriter,
    // /nep status: the speed field.
    metrics,
    // /nep status: the web search engine on the limits field.
    lookup,
    recall,
    // /nep task look: the describer's second look at a picture or a video.
    describer,
    // /nep status: the costs field's per-role lines.
    usage,
    // /nep status: the simulator key's limit line (one GET) and each key's activity for its last 7 and 30 days (GETs
    // only), with the two keys read from keys.json, else .env, at the moment of the card. Never logged.
    cardKeys: () => statusCardKeys(paths.privateDir, {}),
    // /nep memory snapshot: the data directory it copies.
    dataDir,
  });
  // The key commands: the checks go to the provider with the global `fetch` of the moment, a model is saved through the
  // `model.set` operation, and the last core key's removal pauses her with the reason `no-core-key`.
  const asOwner = { accountId: '', roleIds: [], actor: 'owner', asOwner: true };
  const ownerOp = async (op: string, args: Record<string, unknown>): Promise<string> => {
    const result = await admin.runSkillOp(op, args, asOwner);
    if (result.status !== 'ok') throw new Error(result.summary || result.code);
    return result.summary;
  };
  // Her pause with a reason, which the key commands and the probes set: `no-core-key` after the last core key's
  // removal, `core-down`, `analyzer-down` or `memory-down` after a failed probe. Each lifts only its own pause, and an owner's pause given over
  // one of them becomes his.
  const pauseControl = reasonedPause({ run: ownerOp, store });
  // One run of the installed codex or claude for a check: the subharness's `/subharness` checks and the memory probe.
  const runSubharnessBackend = (backend: 'codex' | 'claude', brief: string, model?: string, effort?: EffortLevel) =>
    createInstalledBackend(backend, paths.privateDir).run(brief, {
      cwd: os.tmpdir(),
      timeoutMs: REPLY_CHECK_MS,
      sandbox: 'read-only',
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
    });
  const keysCommands = createKeysCommands({
    store: keyStore,
    ring: keyRing,
    fetch: (input, init) => globalThis.fetch(input, init),
    baseUrl: () => String(objOf(objOf(hot.config).llm).baseUrl),
    defaults: { ...ROLE_DEFAULTS, memory: MEMORY_ROLE_DEFAULT },
    // A deployment still on `.env` has its keys moved into the store before the first add writes anything.
    importLegacy: () => {
      const keyVariables = Object.entries(env).filter(
        (entry): entry is [string, string] =>
          /^OPENROUTER_[A-Z0-9_]+_KEY$/.test(entry[0]) && typeof entry[1] === 'string' && entry[1].trim() !== ''
      );
      if (keysFileExists(paths.privateDir) || keyVariables.length === 0) return null;
      return importKeys({ env: Object.fromEntries(keyVariables), config: hot.config, store: keyStore });
    },
    currentModel: (role) =>
      role === SEARCH_ROLE ? (searchModel(hot.config) ?? '') : (roleModel(hot.config, role) ?? ''),
    speechVoice: () => {
      const voice = objOf(objOf(hot.config).speech).voice;
      return typeof voice === 'string' ? voice : '';
    },
    saveModel: async (role, model) => {
      await ownerOp('model.set', { role, id: model });
    },
    // `/model set --provider` and `--effort` write the local config directly: the route key holds dots and `@`, and
    // `llm.reasoningByRole.<role>` is absent until its first write, so neither fits `config.set`.
    routes: () => objOf(objOf(hot.config).llm).providerByModel as Readonly<Record<string, unknown>>,
    saveRoute: (key, value) => {
      writeLocalSetting(['llm', 'providerByModel', key], value);
      return Promise.resolve();
    },
    saveSetting: (dotted, value) => {
      writeLocalSetting(dotted.split('.'), value);
      return Promise.resolve();
    },
    pause: pauseControl,
    recordCheck: (role, check) => {
      if (role === 'core') recordCoreCheck(paths.dataDir, { ...check, at: clock() });
    },
    // `/model set memory|core <model>` returns the writer or her turns to the direct path once the model passed its check.
    directPath: (role) => {
      if (role === 'memory') clearMemoryPath(paths.privateDir);
      if (role === 'core') clearSubscriptionPath(paths.privateDir, 'core');
    },
    harnessOf,
    // `keys check memory` proves the path the writer runs on: the probe through the backend while config.json names one.
    memoryPath: () => memoryCheckPath(paths.privateDir),
    probeMemory: () => probeMemoryRaw(clock()),
  });
  // The memory probe as `keys check memory` asks it, and the watches of the core, the analyzer and the memory writer
  // (src/subharness/route-watch.ts), whose sleeps `core-down`, `analyzer-down` and `memory-down` go through the pause.
  const probeMemoryRaw = (now: number) =>
    memoryProbe(
      {
        privateDir: paths.privateDir,
        route: () => keyRing.route('memory'),
        fetch: (input, init) => globalThis.fetch(input, init),
        baseUrl: String(objOf(objOf(hot.config).llm).baseUrl),
        model: () => roleModel(hot.config, 'memory') ?? '',
        runBackend: runSubharnessBackend,
      },
      now
    );
  watches = createRouteWatches({
    privateDir: paths.privateDir,
    fetch: options.llm === undefined ? (input, init) => globalThis.fetch(input, init) : null,
    baseUrl: () => String(objOf(objOf(hot.config).llm).baseUrl),
    route: (role) => keyRing.route(role),
    model: (role) => roleModel(hot.config, role) ?? null,
    runBackend: runSubharnessBackend,
    pause: pauseControl,
    now: clock,
    config: (): unknown => hot.config,
  });
  // The chat's sessions and development checkpoints (docs/cli.md).
  chatState = createChatState({
    sessions: chatSessions,
    checkpoints: createCheckpointDesk({
      tasks: async () => (await board.command(OWNER_CLIENT.name, 'task.list', { lane: 'dev' })).data,
      worktreeRoot: () => {
        const { checkout } = selfimprovementSettings(hot.config);
        return checkout === null ? null : path.join(checkout, WORKTREE_FOLDER);
      },
      storeDir: path.join(paths.privateDir, 'development', 'checkpoints'),
      now: clock,
      newId: randomUUID,
    }),
    // The owner's gates, under the owner's own board name: the board's rights decide.
    approvals: {
      gates: async () =>
        ((await board.command(OWNER_CLIENT.name, 'task.approvals', {})).data ?? []) as ReadonlyArray<ApprovalGate>,
      answer: async (answer) => {
        const reply = await board.command(OWNER_CLIENT.name, 'task.approval.answer', answer);
        return (reply.data ?? { status: 'refused', code: reply.status, message: reply.text }) as ApprovalResult;
      },
    },
    // No read holds the last request's size, so that number stays unknown.
    context: () => ({
      usedTokens: null,
      limitTokens: numberOrNull(objOf(objOf(hot.config).llm).maxRequestTokens),
      route: keyRing.route('core')?.name ?? null,
      model: stringOrNull(roleModel(objOf(hot.config), 'core')),
    }),
  });
  // The owner's commands over the link: the `neptunia` chat and `-p`, and the board commands of the agents.
  commandDesk = createCommandDesk({
    // The owner's console (src/interface/commands/console.ts): the chat's table over the operations, run as the owner.
    console: createConsole({
      track: loopWatch.track,
      ...ownerMemoryRuns({ memoryDb, reads, iface: () => identity.iface, describer, describerDeps, now: clock, log }),
      statusBrief: () =>
        statusBrief({
          config: () => objOf(hot.config),
          paused: () => Boolean(processState.data.paused),
          pauseReason: () => pauseControl.reason(),
          path: (role) => rolePath(paths.privateDir, role),
          hasKey: (role) => keyRing.route(role) !== null,
          probe: () => watches?.last('memory') ?? null,
          runFailed: (role, via) =>
            via === 'api' ? roleHealth.down(hot.config, role) !== null : logins.lost(role, via),
          interfaces: () => interfaceLinks.list(),
        }),
      memoryWriter: () => probeWord(watches?.last('memory') ?? null),
      runOp: (op, args, context) => admin.runSkillOp(op, args, context),
      ownerReads: admin.ownerReads,
      places: () => [...new Set([...servedPlaces(), ...store.topPlaces()])],
      selfId: () => identity.selfId || null,
      hot,
      privateDir: paths.privateDir,
      dataDir,
      memoryDb,
      pairing: ownerPairing,
      usage,
      metrics,
      wakeClock: (name) => wakeClockOf(name, { now: clock(), inner, selfreflection }),
      proxy,
      chatLines: (chatId, count) => recentChannelLines(chatId, count),
      now: Date.now,
      // `/mirror` (src/interface/commands/mirror.ts).
      mirrors,
      // `/skills` (src/interface/commands/skills.ts).
      skills: skillsWiring.access,
      // `/keys` and the checked `/model set` (src/keys/commands.ts), over the key store.
      keys: { enabled: () => true, run: (name, args, dialog) => keysCommands.run(name, args, dialog) },
      roleKey: (role) => keyRing.route(role),
      // The backends' own accounts for `/usage` (src/subharness/usage.ts): reads of their accounts, no model run.
      backendUsage: backendUsageReader(() => {
        const base = objOf(objOf(hot.config).llm).baseUrl;
        return {
          privateDir: paths.privateDir,
          now: Date.now,
          fetch,
          baseUrl: typeof base === 'string' ? base : DEFAULT_BASE_URL,
          openRouterKey: keyRing.route('core'),
          spawn: spawnUsageChild,
          exec: execUsage,
        };
      }),
      // `/model set --via` checks with one reply of the backend (src/subharness/selection.ts); a mode change goes into
      // the agent's unit (src/setup/install.ts).
      subharness: {
        runBackend: runSubharnessBackend,
        helpOf: (backend) => helpOfInstalled(paths.privateDir, backend),
        fetch,
        get baseUrl() {
          const base = objOf(objOf(hot.config).llm).baseUrl;
          return typeof base === 'string' ? base : undefined;
        },
        applyMode: (agent) => Promise.resolve(deferModeToUnit(agent)),
      },
    }),
    interfaces: interfaceLinks,
    // The agents' board commands (src/board/commands.ts), each run in the memory writer.
    tasks: board,
    // The agents' `skill.pending` (src/skills/agent-commands.ts), which binds a package on the board.
    skills: skillsWiring.access,
    board,
    facts: () =>
      coreStatusFacts({
        hot,
        store,
        usage,
        interfaces: interfaceLinks,
        inner,
        errands: taskStores,
        roleHealth,
      }),
  });

  // Once at startup, fire-and-forget: tell the operator whether YouTube links can
  // be watched here (only when the video role is up: a role switched off watches nothing, so there is nothing to
  // probe, and the probe's request would leave the host). Logs the status, never the URL or key.
  if (roleHealth.down(settings.config, 'video') === null)
    void startYoutubeCheck({ checkYoutube: describer.checkYoutube });

  const timers: Array<Untyped> = [];

  /** Run `fn` on an interval; a rejected promise is logged, never left unhandled. */
  function every(ms: number, fn: Untyped, label: string) {
    const id = setInterval(() => {
      Promise.resolve()
        .then(() => loopWatch.track(label, fn))
        .catch((err) => log.error(`index: ${label} failed`, { error: err }));
    }, ms);
    id.unref?.();
    timers.push(id);
  }

  /** How often the affinity decay sweeps. */
  const AFFINITY_SWEEP_MS = 3_600_000;

  /** RELATIONSHIP_LIMITS.decayPerDay: every stored affinity drifts toward zero, one step per whole day; not while paused. */
  function sweepAffinityDecay() {
    if (processState.data.paused) return;
    // Decay counts only time she was running: the sweep runs hourly, so a gap of more than two sweeps since the last one
    // (kept in the state file) is downtime, and all of it but one sweep's hour is skipped.
    const now = Date.now();
    const last = Date.parse(processState.data.affinityDecaySweptAt ?? '');
    const gap = Number.isFinite(last) ? now - last : 0;
    const skipMs = gap > 2 * AFFINITY_SWEEP_MS ? gap - AFFINITY_SWEEP_MS : 0;
    const decay = { ...RELATIONSHIP_LIMITS, skipMs };
    const counts = store.decayAffinities(now, decay);
    processState.data.affinityDecaySweptAt = new Date(now).toISOString();
    processState.markDirty();
    if (counts.decayed > 0 || skipMs > 0)
      log.info('index: affinity decay applied', { ...counts, skippedHours: Math.round(skipMs / 3_600_000) });
  }

  /**
   * The archive drain: what the archive refused waits in its pending queue (and the victims stay
   * hot); this retries it every archive.drainMs (read before each wait; config.json's 30000), so
   * the queue empties without waiting for new messages. Skipped while paused (the trim would make
   * the store dirty). Runs whatever features.archive says: what waits was queued while it was on.
   */
  let archiveDrainTimer: Untyped = null;
  function scheduleArchiveDrain() {
    const ms = Number(hot.config.archive?.drainMs);
    archiveDrainTimer = setTimeout(
      () => {
        Promise.resolve()
          .then(() => (processState.data.paused ? null : store.drainArchive()))
          .catch((err) => log.error('index: archive drain failed', { error: err }))
          .finally(() => {
            if (!shuttingDown) scheduleArchiveDrain();
          });
      },
      Number.isFinite(ms) && ms > 0 ? ms : 30_000
    );
    archiveDrainTimer.unref?.();
  }

  /**
   * One startup step after the place resolved, by name: a synchronous throw or
   * a rejected promise is logged as `index: startup step failed` and never
   * stops the steps after it. With `wait` the step finishes before the next
   * one starts; otherwise it runs on in the background (fire-and-forget).
   */
  async function startupStep(step: string, fn: () => unknown, { wait = false }: { wait?: boolean } = {}) {
    const failed = (err: Untyped) => log.error('index: startup step failed', { step, error: err });
    try {
      const done = Promise.resolve(fn()).catch(failed);
      if (wait) await done;
    } catch (err) {
      failed(err);
    }
  }

  /**
   * The journal's operations left open by the last run, yesterday's
   * and today's: a post is looked for among the persona's own messages, everything else is marked
   * unknown; nothing is sent again. Only operations started before this start are touched.
   */
  async function reconcileJournal(placeId: string) {
    const startedAt = Date.now();
    const days = [utcDay(startedAt - DAY_MS), utcDay(startedAt)];
    const counts = await journal.reconcile(placeId, {
      days,
      before: startedAt,
      fetchOwnMessages: ownMessagesOf(reads, identity.iface),
    });
    log.info('journal: reconciled', { placeId, succeeded: counts.succeeded, unknown: counts.unknown });
  }

  /**
   * Which message started the turn that posted each of the persona's messages of yesterday and
   * today (the journal's turn records), handed to the turn runner so her lines posted before this
   * start keep naming their trigger in the transcripts. Read whatever the switches: the runner
   * renders the links only with features.triggerMarkers on, and a journal never written gives none.
   */
  async function seedTriggerLinks(placeId: string) {
    const at = Date.now();
    const pairs = await journal.triggerLinks(placeId, { days: [utcDay(at - DAY_MS), utcDay(at)] });
    turns.seedTriggerLinks(pairs);
    log.info('journal: trigger links read', { placeId, links: pairs.length });
  }

  /**
   * The persona's skill calls and thinks of yesterday and today (the journal's skill operations and turn records), handed
   * to the turn runner so her chat keeps her calls and a turn keeps the previous think of its place across this start.
   */
  async function seedCallMarks(placeId: string) {
    const at = Date.now();
    const marks = await journal.callMarks(placeId, { days: [utcDay(at - DAY_MS), utcDay(at)] });
    turns.seedCallMarks({ ...marks, placeId });
    log.info('journal: call marks read', { placeId, calls: marks.calls.length });
  }

  /** One start-up step over every served place, in turn. */
  async function eachServed(step: (placeId: string) => unknown): Promise<void> {
    const places = new Set([...servedPlaces(), ...store.topPlaces()]);
    for (const placeId of places) await step(placeId);
  }

  /** Whether the journal is written now (features.journal exactly true, read now). */
  const journalOn = () => true;

  /**
   * The journal at start, with the journal on: a `.running` marker left by a run that never stopped
   * cleanly becomes an `unclean-stop` record, this run's marker is written and the `start` record follows.
   */
  async function startJournal() {
    if (!journalOn()) return;
    const { unclean } = await journal.markRunning();
    if (unclean) log.warn('journal: unclean stop noted');
    await journal.system({ event: 'start', by: 'service' });
  }

  // A reload that took (config or prompts) is a system record of the served place.
  hot.onReload((what: Untyped) => {
    if (!journalOn()) return;
    void journal.system({ event: 'reload', note: what });
  });

  // The behaviours' clock (src/behavior/scheduler.ts): one timer waits for the earliest beat and each wait is a
  // `scheduler.tick` event through the door below, whose handler starts the beats that are due. The beats are the
  // behaviour ones only; the housekeeping timers further down are plain intervals.
  // Its waits are real timers, so it reads the real clock: an injected `now` is for the inner life's decisions.
  const scheduler = createScheduler({
    submit: (event) => door.submit(event),
    now: Date.now,
    setTimer: (fn, ms) => {
      const id = setTimeout(fn, ms);
      id.unref?.();
      return () => clearTimeout(id);
    },
    log,
  });
  // The selfreflection's beat also sends what its mirrors still hold queued.
  scheduler.add({
    name: 'selfreflection.tick',
    everyMs: () => 30_000,
    run: async () => {
      await selfreflection.tick();
      await mirrors.drainQueued();
    },
  });
  // The board's reaper (src/board/board.ts#reap), every board.reapSeconds (read before each wait): a lease past its
  // expiry goes back to approved with its generation raised, so the late holder's next call is refused. Nothing to
  // do while the memory database is not open.
  scheduler.add({
    name: 'board.reap',
    everyMs: () => boardTimings(settings.config).reapSeconds * 1000,
    run: async () => {
      const ids = await board.reap();
      if (ids.length > 0) log.info('board: leases expired', { count: ids.length, tasks: ids });
    },
  });
  // Her done skill tasks activate the version each one bound (src/skills/task-activation.ts), on the reaper's clock. Only the
  // core holds the skills access and the board together. A sweep looks at the board and not at a notification, so a crash
  // between a task's end and its activation recovers on the first beat after the start.
  scheduler.add({
    name: 'skills.settle',
    everyMs: () => boardTimings(settings.config).reapSeconds * 1000,
    run: async () => {
      for (const one of await skillsWiring.settle()) log.info('skills: task settled', { ...one });
    },
  });
  // The inner life's tick, every wakes.tickSeconds (read before each wait).
  scheduler.add({
    name: 'inner.tick',
    everyMs: () => innerSettings(hot.config).tickSeconds * 1000,
    run: async () => {
      await refreshAllPlaces();
      inner.releaseStoredStop();
      return inner.tick();
    },
  });

  /**
   * A changed or posting member's avatar offered to the avatar queue (features.avatars, off by default), when the
   * member is of the served place. The offer is synchronous and never throws.
   */
  function offerAvatar(
    rootId: string | null | undefined,
    member: { id: string; bot?: boolean; avatar?: { hash: string | null; url: string | null } } | undefined
  ) {
    if (!isServedRoot(rootId) || !member?.avatar) return;
    avatars.offer(store.placeOfRoot(String(rootId)), {
      id: member.id,
      bot: member.bot === true,
      hash: member.avatar.hash,
      url: member.avatar.url,
    });
  }

  // The interface's events reach the core as protocol events (src/protocol/, built by the interface) over the
  // link, through the event door (src/interface/door.js), the one entry of the mind: it validates each event at the
  // boundary, drops a repeated id, and hands the event to the handler of its kind. An event that cannot be built
  // or is malformed is dropped with one warn line (its kind and the reason, never its content), so
  // nothing behind it ever sees a half-formed one. The core's own events (an errand's end, the scheduler's tick)
  // come through the same door, in process.
  const door = createEventDoor({
    handlers: {
      // The second argument holds the event's ingestion row, which the observation of its line commits with the line.
      'message.received': createMessageProducers({
        store,
        onMessage,
        observeDirectory: (event) => directory.observe(event),
        offerAvatar: (event) => offerAvatar(event.chat?.rootId, event.message?.author),
        issueInternalContext: () => memoryDb.issueContext({ kind: 'internal' }),
      }),
      // The reactor store follows the reactions on the persona's messages in the served place, whatever
      // features.reactionNames says (a cheap map update; a switch turned on later finds it current).
      'reaction.changed': (event: ReactionChanged) => {
        try {
          applyReactionChanged(reactors, event, { isServed: isServedRoot, selfId: identity.selfId });
        } catch (err) {
          log.warn('reactors: event failed', { kind: event?.kind ?? null, code: objOf(err).code ?? null });
        }
      },
      'errand.done': (event: ErrandDoneEvent) => {
        // An errand an inner turn handed off counts its cost against the inner life's dollars.
        inner.onTaskFinished(event?.raw?.errand ?? errands.store?.()?.get?.(event?.errandId) ?? null);
        return taskTurns.onEvent(event);
      },
      'inner.wake': (event: InnerWake) => inner.onWake(event),
      'scheduler.tick': (event: SchedulerTick) => scheduler.dispatch(event.at),
      // The live glance at the voice channels and the statuses (`<people_now>`): cheap map updates that run
      // whatever features.around says; a lost connection marks it stale until the shard is back.
      'voice.changed': (event: VoiceChanged) => around.voiceChanged(event),
      'presence.changed': (event: PresenceChanged) => around.presenceChanged(event),
      'presence.snapshot': (event: PresenceSnapshot) => {
        around.snapshot(event);
        log.info('around: seeded', around.counts());
      },
      'connection.changed': (event: ConnectionChanged) => {
        if (event.state === 'resumed') connection.lastReconnectAt = event.at;
        return around.connection(event);
      },
      // The names of the chats (the inner life shows them), and a changed avatar of a member.
      'chat.changed': (event: ChatChanged) => {
        directory.apply(event);
        void refreshAllPlaces();
      },
      'membership.changed': (event: MembershipChanged) => {
        members.apply(event);
        offerAvatar(event.placeId, event.member);
      },
    },
    log,
    ingest: ingestRecord,
  });
  doorReady.resolve(door);

  let shuttingDown = false;
  let stopping: Promise<void> | null = null;

  async function shutdown(signal: Untyped) {
    shuttingDown = true;
    log.info('index: shutting down', { signal });
    for (const id of timers) clearInterval(id);
    loopWatch.stop();
    if (archiveDrainTimer) clearTimeout(archiveDrainTimer);
    selfreflection.stop();
    missed.stop();
    errandClient.close();
    taskTurns.stop();
    scheduler.stop();
    // core:alive let go, so the next start over this data goes ahead at once.
    try {
      await inner.release();
    } catch (err) {
      log.warn('index: core:alive not released', { error: err });
    }
    await missed.save().catch((err) => log.warn('index: missed registry not saved', { error: err }));
    // The embedding queue flushes what waits once (a short wait at most), before the stores close.
    await embedQueue.close().catch((err: Untyped) => log.warn('index: embed queue close failed', { error: err }));
    // archive.holdMaxMs: how long a file held for the archive may wait before it is written anyway.
    const holdMaxMs = hot.config.archive?.holdMaxMs ?? 5000;
    hot.close();
    // `final`: the unit writes that still fail are kept in data/memory-pending/.
    await store.flushSettled({ holdMaxMs, final: true });
    await metrics.save({ force: true });
    await usage.save({ force: true });
    // The journal's `stop` record (journal on), then the run marker goes: this stop was clean.
    if (journalOn()) await journal.system({ event: 'stop', by: 'service', note: signal });
    await journal.clearRunning().catch((err) => log.warn('index: journal marker not removed', { error: err }));
    await archiveAppendStore.close().catch((err) => log.warn('index: append store close failed', { error: err }));
    // The intention and task writes still waiting, then those still failing kept pending.
    await intentionStores
      .flush({ final: true })
      .catch((err) => log.warn('index: intentions flush failed', { error: err }));
    await taskStores.flush({ final: true }).catch((err) => log.warn('index: tasks flush failed', { error: err }));
    // After the last flush of every store the database closes and releases its lock.
    await memoryDb.close().catch((err) => log.warn('index: memory db close failed', { error: err }));
    // The interface closes its end of the link and its client, then the core's end and the socket close, and the
    // socket file goes with the server.
    try {
      await running?.stop();
    } catch (err) {
      log.warn('index: interface stop failed', { error: err });
    }
    coreLink.close();
    await linkServer.close().catch((err) => log.warn('index: link socket close failed', { error: err }));
    // The writer lock goes with the database; this only removes one a crashed writer thread left behind.
    releaseCore();
    untapMetrics();
    untapUsage();
  }

  /** Stops the core once, whoever asks first: the timers, the stores, the memory database, the interface and the link. */
  const stop = (signal = 'stop') => (stopping ??= shutdown(signal));
  // From here the shutdown closes everything the start opened, and the steps below run behind it.
  cleanups.length = 0;
  cleanups.push(() => stop('start-failed'));

  // The door has its handlers: the interface delivers the events it held since its start, and every later one.
  running?.open();
  // The interface is connected: what the selfreflection's mirrors held queued goes out now.
  mirrors.drainQueued().catch((err: unknown) => log.warn('mirror: drain failed', { error: err }));

  // The periodic work first, before anything below can throw or wait: the
  // flush, the behaviours' beats, the hourly affinity decay. Then the startup steps, in order.
  every(30_000, () => store.flush(), 'store.flush');
  every(10_000, () => memoryDb.tick(), 'memoryDb.tick');
  // The intention and task writes that failed go again.
  every(30_000, () => Promise.all([intentionStores.flush(), taskStores.flush()]), 'module stores flush');
  // The spontaneous, selfreflection and inner life ticks: the scheduler's beats, each wait a `scheduler.tick` through the door.
  scheduler.start();
  every(AFFINITY_SWEEP_MS, sweepAffinityDecay, 'affinity decay');
  // The embedding queue flushes on its own clock (src/memory/embedder.js; a full batch sooner);
  // the same tick runs its catch-up pass at the start and then on its own clock.
  every(30_000, () => embedQueue.tick(), 'embed.tick');
  // The avatar queue: its first tick scans the profiled members, then once a day; between
  // requests it waits its interval (src/memory/avatar-queue.js).
  every(5_000, () => avatars.tick(), 'avatars.tick');
  // The speed samples written to data/metrics.json (at most once a minute; nothing new, no write).
  every(60_000, () => metrics.save(), 'metrics.save');
  // Today's per-role usage written to data/usage.json (at most once a minute; nothing new, no write).
  every(60_000, () => usage.save(), 'usage.save');
  // The probes' interval, `memory.probeMinutes` of the live config, looked at once a minute.
  every(60_000, () => watches?.tick(), 'route probes');
  scheduleArchiveDrain();

  log.info('index: ready', { tag: identity.selfName });

  // A pause persisted before this restart comes back paused: every scheduler tick does nothing until /resume.
  if (processState.data.paused) {
    log.info('index: starting up paused, run /resume when data/ is ready', {
      pausedAt: processState.data.pausedAt ?? null,
    });
  }

  // The database is the memory: opened first (its pending writes of the last shutdown replayed) and awaited, before
  // anything below reads it.
  await startupStep('memoryDb.open', () => memoryDb.tick(), { wait: true });

  // The probes at start, with the link up: a dead core, analyzer or writer path puts her to sleep before her first turn.
  await startupStep('route.probes', () => watches?.start());

  // The journal's start: an unclean stop, the start record. Awaited, before the reconciliation below.
  await startupStep('journal.start', () => startJournal(), { wait: true });

  // The links of the persona's recent lines to the messages that started their turns, rebuilt from the journal.
  // Fire-and-forget: a turn before it is done only lacks the older links.
  await startupStep('journal.triggerLinks', () => eachServed(seedTriggerLinks));
  // The persona's recent skill calls, the same way.
  await startupStep('journal.callMarks', () => eachServed(seedCallMarks));

  // The missed-answer registry: data/places/<id>/missed.json, reconciled with the journal of the
  // last hour; a sweep armed where a candidate waits.
  await startupStep('missed.start', async () => {
    const holders = store.placesHolding('missed');
    for (const place of holders.length > 0 ? holders : [PERSONA_ID]) await missed.start(place);
  });

  // The errands a restart left open: their runner can no longer answer this process, so they fail
  // (`restarted`) and show in her `<errands>` block as failed.
  await startupStep('errands.start', () => errands.start(), { wait: true });

  // Her intentions reconciled with the errands as they stand now (those just failed included):
  // a wait whose errand ended, is gone or ran out moves back to pending; the expired ones expire.
  await startupStep('intentions.reconcile', () => intentions.reconcile(), { wait: true });

  // The meaning index caught up with what the record took while the queue was down (the last
  // CATCH_UP_HOURS of src/memory/embedder.js). Fire-and-forget; nothing while paused.
  await startupStep('embed.catchUp', () => embedQueue.catchUp());

  // Once per place after the deploy that keyed access by operation: the stored grants re-expanded
  // under the operation names, a journal record of what each covers now (src/tools/operations/access.ts).
  await startupStep('access.migrate', () => eachServed(admin.migrateAccess), { wait: true });

  // The side effects a crash or a restart left without an outcome. Fire-and-forget: a turn
  // starting meanwhile is never touched (only earlier operations are), and it never sends.
  await startupStep('journal.reconcile', () => eachServed(reconcileJournal).finally(journalReconciled));

  // The custom emoji ranking from history, once (no emojiBackfill stamp). Fire-and-forget: never blocks the persona, logs its errors.
  await startupStep('emojiBackfill.startIfNeeded', () => eachServed(emojiBackfill.startIfNeeded));

  // The GIF library from history, once (no backfill stamp in gifs.json). Fire-and-forget: never blocks the persona, logs its errors.
  await startupStep('gifBackfill.startIfNeeded', () => eachServed(gifBackfill.startIfNeeded));
  // What the library's entries lack that needs no message: their captions, vectors and files, in the background.
  await startupStep('gifKeeper.settle', () => eachServed(gifKeeper.settle));

  // Affinity decay: once now (catches up the days the process was down), then hourly (above).
  await startupStep('affinity decay', sweepAffinityDecay, { wait: true });

  // What the archive refused before this start: drained once now (it also counts the queue for
  // the stall check), then on the timer (above). Fire-and-forget.
  await startupStep('archive.drain', () => (processState.data.paused ? null : store.drainArchive()));

  return {
    door,
    stop,
    interfaces: {
      list: () => interfaceLinks.list(),
      disable: (name: string) => interfaceLinks.disable(name),
      enable: (name: string) => interfaceLinks.enable(name),
    },
  };
}
