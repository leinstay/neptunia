// The composition root: builds the core over the paths, the environment and the interfaces it is given, starts it and
// hands back its door and a way to stop it. It wires config, hot reload, the persistent store, the OpenRouter
// client and the turn, spontaneous and memory subsystems together, starts each interface over the link, and owns the
// core's lifecycle (startup checks, timers, graceful shutdown). No decision logic lives here: everything is imported
// from src/behavior, src/memory and src/llm. Nothing here builds, logs in or listens to a platform client: the
// interface does, and hands back the running interface (src/protocol/host.ts). The entry (src/index.ts) reads the
// paths and the environment, loads the interface packages and handles the process signals; a test calls `startCore`
// with a scripted model and the fake interface.
//
// This file stays JavaScript: it is the body of the old entry moved into a function, and stage 8 of the core
// extraction converts it to TypeScript.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { localConfigPath, readInterfaceConfig } from './config/files.ts';
import { createHot } from './hot.ts';
import { log, onLog } from './log.ts';
import { createMetrics, metricsTap } from './tools/impl/metrics.ts';
import { createUsage, usageTap } from './tools/impl/usage.ts';
import { createMemoryDb } from './memory/db/service.ts';
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
  createGifRecache,
  createDescriber,
  createAvatarQueue,
  startYoutubeCheck,
} from './memory/index.ts';
import { DAY_MS, utcDay } from './time.ts';
import { createCalibrator } from './llm/tokens.ts';
import { createLlm, roleApiKey } from './llm/openrouter.ts';
import { createKeyFailover } from './llm/key-failover.ts';
import { MEMORY_ROLE_DEFAULT, ROLE_DEFAULTS, roleModel } from './llm/roles.ts';
import { statusCardKeys } from './keys/card-keys.ts';
import { createKeysCommands } from './keys/commands.ts';
import { importKeys } from './keys/import.ts';
import { createKeyRing } from './keys/ring.ts';
import type { KeyOf } from './keys/ring.ts';
import { createKeyStore, keysFileExists } from './keys/store.ts';
import { createRoleHealth, reportingCoreKeys, reportingLlm, roleKeyCheck } from './llm/role-health.ts';
import { createEmbedder } from './llm/embed.ts';
import { createImageGen } from './llm/images.ts';
import { createSpeech } from './speech/index.ts';
import { ffmpegAvailable } from './speech/convert.ts';
import { createTurnRunner } from './behavior/turn.ts';
import { createActivity } from './behavior/activity.ts';
import { createMissed } from './behavior/missed.ts';
import { createOfflineCatchUp } from './behavior/catch-up.ts';
import { createEmojiIndex } from './behavior/emoji-index.ts';
import { ownMessagesOf } from './behavior/own-messages.ts';
import { hasRequiredLabels } from './behavior/prompt.ts';
import { createChannelRouter } from './behavior/route-channel.ts';
import { createRecall } from './behavior/recall-run.ts';
import { createSpontaneous } from './behavior/spontaneous.ts';
import { createInnerLife, innerSettings } from './behavior/inner.ts';
import { createTurnsBudget } from './behavior/turn-budget.ts';
import { coreKeyBalances } from './llm/key-grants.ts';
import { createDiary } from './behavior/diary.ts';
import { createMirrors, guardMirrorPort } from './behavior/mirror.ts';
import { createImageFetcher } from './media/fetch-image.ts';
import { createVideoFetcher } from './media/fetch-video.ts';
import { createPageFetcher } from './web/fetch-page.ts';
import { createBraveSearch } from './web/brave.ts';
import { createExaSearch } from './web/exa.ts';
import { createLookup } from './web/lookup.ts';
import { createAdmin } from './admin.ts';
import { createErrandClient } from './errands/client.ts';
import { createErrandStores } from './errands/store.ts';
import { createErrandService } from './errands/service.ts';
import { channelPlaceId } from './memory/db/ids.ts';
import { createMemberDirectory } from './interface/members.ts';
import { createErrandTurns, errandDoneEvent } from './errands/turns.ts';
import { createEventDoor } from './interface/door.ts';
import { createConversationDirectory } from './interface/directory.ts';
import { isReadable, takeSnapshot } from './behavior/snapshot.ts';
import {
  CLI_IFACE,
  closedAdapter,
  createIfaceRouter,
  createInterfaceLinks,
  createLinkSwitch,
  openAdapterLink,
} from './interface/link.ts';
import { createCommandDesk, createCommandIntake, coreStatusFacts } from './interface/neptunia-cli.ts';
import { createConsole } from './interface/commands/console.ts';
import { holdIfPaused, resumeHeld } from './behavior/core-pause.ts';
import { configuredInterfaces, drainMs, interfaceEnabled } from './interface/mode.ts';
import { loadPrincipals, principalOfToken } from './interface/principals.ts';
import { claimCore } from './memory/db/open.ts';
import { readLocalConfig, setPath, writeLocalConfig } from './tools/impl/shared.ts';
import { createIngestRecord, createRowsByMessage, observingWith } from './memory/db/ingest.ts';
import { coreSocketPath, listenSocket } from './interface/socket.ts';
import { MAX_FRAME_BYTES, connectSocket } from './protocol/wire.ts';
import { createAroundStore } from './behavior/around-store.ts';
import { createScheduler } from './behavior/scheduler.ts';
import { boardSettings, boardTimings } from './board/board.ts';
import { createBoardPort } from './board/writer.ts';
import { createReactorStore, applyReactionChanged } from './behavior/reactor-store.ts';
import { createReads } from './interface/reads.ts';
import { createIntentionStores } from './intentions/store.ts';
import { createIntentionService } from './intentions/service.ts';
import { skillRegistry, missingDefinitions, setExtraSkills } from './tools/registry.ts';
import { grantedSkillNames } from './tools/discovery.ts';
import { ackLanded, landedFor } from './selfimprovement/landed.ts';
import { wireSkills } from './skills/wiring.ts';
import { createReportReader, reportsDirOf, watcherDir } from './watcher/read.ts';
import { ABILITY_ADDED, abilityWake, fileAnnounceStore, forgetAbilities, newAbilities } from './plugins/announce.ts';
import { createPluginControl, systemdUnits } from './plugins/control.ts';
import { loadPlugins } from './plugins/folders.ts';
import { openPluginLink, routeConnection } from './plugins/link.ts';
import { createPluginRegistry } from './plugins/registry.ts';
import { pluginCallDeadlineMs, pluginEnabled } from './plugins/settings.ts';
import { PROFILES as AGENT_PROFILES } from './agent-runner/profiles.ts';
import { createTagHistory, deprecatedModelKeys } from './behavior/mention.ts';
import { createMessageHandler } from './behavior/pipeline.ts';
import { createLeasedAttention } from './behavior/attention.ts';
import { RELATIONSHIP_LIMITS } from './memory/text-limits.ts';
import { createInstalledBackend } from './agent-runner/backend.ts';
import { isInstalled } from './subharness/place.ts';
import { deferModeToUnit } from './setup/install.ts';
import { REPLY_CHECK_MS } from './subharness/control.ts';
import { objOf } from './tools/types.ts';
import type { Untyped } from './tools/types.ts';
import type {
  ConnectionChanged,
  ConversationChanged,
  InnerWake,
  MembershipChanged,
  MessageReceived,
  PresenceChanged,
  PresenceSnapshot,
  ReactionChanged,
  SchedulerTick,
  VoiceChanged,
} from './protocol/events.ts';
import type { resolvePaths } from './paths.ts';
import type { InterfaceHost, RunningInterface } from './protocol/host.ts';
import type { PluginUnits } from './plugins/control.ts';
import type { Drained, From, InterfaceState } from './interface/link.ts';
import type { Principal } from './interface/principals.ts';
import type { Envelope, Transport } from './protocol/wire.ts';
import type { Hello } from './protocol/serve.ts';
import type { PluginLink } from './plugins/link.ts';
import type { Wake } from './behavior/inner/types.ts';
import type { ErrandRecord } from './errands/types.ts';
import type { PluginCallContext } from './plugins/registry.ts';
import type { ErrandDoneEvent } from './errands/turns.ts';

const REQUIRED_PROMPTS = ['system-prompt', 'character-card', 'format', 'reply', 'interject', 'initiate'];

/** The first name a stored profile holds (the store hands a profile out as a plain object). */
const firstName = (profile: object | null): string | undefined =>
  (profile as { names?: Array<string> } | null)?.names?.[0];

/**
 * Throw a one-line, secret-free error: the entry prints it and exits with a non-zero code, a test sees the throw.
 */
function fail(message: string): never {
  throw new Error(message);
}

/**
 * The variable `key` of `env`, or a friendly startup failure when it is missing or empty.
 */
function needOrFail(env: Readonly<Record<string, string | undefined>>, key: string): string {
  const value = env[key];
  if (value === undefined || value === '')
    fail(
      `index: missing required environment variable ${key} — copy .env.example to .env and fill in the real values.`
    );
  return value;
}

/** The chat client as the core hands it on. */
type ChatClient = Omit<ReturnType<typeof createLlm>, 'complete'> & {
  complete: (messages: Untyped, options?: Untyped) => Promise<Untyped>;
};

/**
 * Build the core and start it. `paths` are the checkout, the private layer and the data directory (src/paths.ts),
 * `env` the environment the core reads its own keys from (never logged), `interfaces` the interfaces to start in
 * this process: one (`interfaces.mode: inprocess`), or none, when the interfaces run as units and connect to the
 * socket themselves; the core then serves `bot.guildId`. `llm`, `embedder` and `now` replace the provider client,
 * the embedding client and the clock (the scheduler, the inner life and the one-core check): only a test passes them.
 * `units` starts and stops the unit of a plugin (`/plugins enable`): `systemctl` unless a test passes a stand-in.
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
  units?: PluginUnits;
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
  const clock = options.now ?? Date.now;
  // The three directories (src/paths.ts): the checkout, the private layer (config.local/, prompts.local/) and the
  // data directory. Logged once, paths only.
  log.info('index: paths', { rootDir: paths.rootDir, privateDir: paths.privateDir, dataDir: paths.dataDir });
  if (!fs.existsSync(paths.privateDir))
    fail(`index: the private directory ${paths.privateDir} does not exist (NEPTUNIA_PRIVATE_DIR).`);
  if (interfaces.length > 1) fail(`index: the core starts one interface at most, got ${interfaces.length}.`);
  // No interface in this process: they run as units, and the community comes from the settings.
  const asUnits = interfaces.length === 0;

  // The model keys: `keys.json` of the private layer when it exists (the key ring, read at each request), else the
  // `.env` variables `llm.keyByRole` names (scripts/keys-import.ts moves them). A deployment with a key store needs no
  // key in `.env` to start: without a core key she is paused until `/keys core add`.
  const keyStore = createKeyStore({ privateDir: paths.privateDir });
  const keyRing = createKeyRing({ store: keyStore, failover: createKeyFailover({ now: clock }) });
  const ringNow = () => (keysFileExists(paths.privateDir) ? keyRing : null);
  /** The key of `role` in the key store, null while there is none (`.env` serves then), '' when the store has no key for it. */
  const keyOf: KeyOf = (role) => ringNow()?.route(role)?.value ?? (ringNow() === null ? null : '');
  const openrouterKey = ringNow() === null ? needOrFail(env, 'OPENROUTER_CORE_KEY') : (env.OPENROUTER_CORE_KEY ?? '');
  // Optional: without it a YouTube duration comes from the watch page only.
  const youtubeApiKey = env.YOUTUBE_API_KEY || null;
  // Optional: without it the `brave` search engine never runs (the web lookup still reads links). Never logged.
  const braveApiKey = env.BRAVE_SEARCH_API_KEY || null;
  // Optional: the `exa` engine runs keyless; with a key it is sent as a bearer header. Never logged.
  const exaApiKey = env.EXA_API_KEY || null;

  const hot = createHot({ rootDir: paths.rootDir, privateDir: paths.privateDir }).watch();
  cleanups.push(() => hot.close());

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
  // programming error
  // and stops the start here.
  try {
    skillRegistry();
  } catch (err) {
    fail(`index: invalid skill registry: ${String(objOf(err).message)}`);
  }
  // A definition whose operation is not registered is left out of the registry: say so, loudly, at
  // the start (never silently); the bot goes on.
  {
    const missing = missingDefinitions();
    if (missing.length > 0) log.error('skills: definitions without a registered operation', { missing });
  }

  // The old per-feature model keys are never read (classifier.* replaced them);
  // say so once, key names only, never a value.
  for (const { key, use } of deprecatedModelKeys(hot.config))
    log.warn('index: deprecated model key ignored', { key, use });

  const dataDir = paths.dataDir;
  // The parts of the hot reload the one-core claim and the interfaces' switches read and write (src/hot.ts).
  const settings = hot;
  const configuredGuild: string | null = settings.config.bot?.guildId ?? null;
  if (asUnits && !configuredGuild)
    fail('index: bot.guildId must be set when the interfaces run as units (config.local/config.json).');
  // One core over this data directory, claimed before anything below touches it or the socket.
  fs.mkdirSync(dataDir, { recursive: true });
  let releaseCore: () => void = () => {};
  try {
    const dbFile: string | undefined = settings.config.memoryDb?.file;
    releaseCore = claimCore(path.join(dataDir, dbFile || 'memory.db'), { now: clock });
  } catch (err) {
    fail(`index: ${err instanceof Error ? err.message : String(err)}`);
  }
  cleanups.push(() => releaseCore());
  // Who the persona is on the interface and which namespace its ids belong to: set once from `hello`, read at each use.
  const identity = { iface: '', selfId: '', selfName: 'bot' };
  // The names of the members of the served community, fed by `membership.changed` (a nickname change included).
  const members = createMemberDirectory();
  // The speed figures of /nep status (src/tools/impl/metrics.ts): the durations the log lines carry,
  // kept for 24 h in data/metrics.json (loaded now, written every minute and on shutdown).
  const metrics = createMetrics({ dataDir, log });
  const untapMetrics = onLog(metricsTap(metrics));
  cleanups.push(untapMetrics);
  // The costs field of /nep status (src/tools/impl/usage.ts): today's requests per role from the `llm: usage`
  // lines, kept for today and yesterday in data/usage.json (loaded now, written every minute and on shutdown).
  const usage = createUsage({ dataDir, log });
  const untapUsage = onLog(usageTap(usage));
  cleanups.push(untapUsage);
  // The memory database (src/memory/db/service.js): the memory. Created before the memory modules, which read and write
  // it (src/memory/db/readers/, src/memory/db/unit-write.js); opened at the start (the first tick, awaited below).
  // diaryMediaDeps is read at each tick: the interface port and the image fetcher exist by then (defined below).
  // `embed` and `selfName` (the re-embed job, recall.db.reembed) are the embedding client and her name, defined below.
  // Her memory session is the memory writer: it runs on the chat client (role `memory`, its own key from `env`), and a
  // run that fails is told to her as a `memoryFailed` fact (inner, defined below).
  // The options are named first: the module declares the ones it reads, and `embed` and `selfName` are not among them yet.
  const memoryDbOptions = {
    hot,
    dataDir,
    log,
    diaryMediaDeps: () => ({ port: iface, imageFetcher }),
    // The interface the unit writes name their rows with: the one of `hello`, known once the link is up.
    iface: () => identity.iface || null,
    embed: (texts: Untyped, options: Untyped) => embedder.embed(texts, options),
    selfName: () => getSelfName(getGuildId()),
    sessionLlm: () => llm,
    sessionEnv: () => env,
    sessionKeys: ringNow,
    onSessionFailure: (failure: Untyped) => tellSessionFailure(failure),
  };
  const memoryDb = createMemoryDb(memoryDbOptions);
  cleanups.push(() => memoryDb.close());
  // The task board (src/board/, docs/core.md "The task board"): its tables in the memory database, every write of it
  // a write of the memory writer, over the core's clock, the live `board.*` settings and the private layer's
  // clients.json, read at each call. The agents' `task.*` commands, her board tools and the reaper's beat use it.
  const board = createBoardPort({
    write: (write) => memoryDb.memoryWrite({ kind: 'board', write }),
    context: () => ({ at: clock(), settings: boardSettings(settings.config), privateDir: paths.privateDir }),
    briefWaitMs: () => boardTimings(settings.config).briefWaitMs,
  });
  // The plugins (src/plugins/, docs/plugins.md): the `plugins/` folder of the checkout and `plugins.local/` of the private
  // layer, read at each call. The registry holds the tools the enabled plugins registered, beside the core's own in the
  // gateway's registry; the manifests it checks against are those of the enabled plugins.
  const pluginFolders = () => ({
    trackedDir: path.join(paths.rootDir, 'plugins'),
    localDir: path.join(paths.privateDir, 'plugins.local'),
  });
  const enabledPlugins = () =>
    loadPlugins(pluginFolders()).plugins.filter((plugin) => pluginEnabled(settings.config, plugin.manifest.name));
  const pluginRegistry = createPluginRegistry({
    manifests: () => enabledPlugins().map((plugin) => plugin.manifest),
    log,
  });
  setExtraSkills(
    () => pluginRegistry.skills(),
    () => loadPlugins(pluginFolders()).plugins.flatMap((plugin) => plugin.manifest.tools.map((tool) => tool.name))
  );
  cleanups.push(() => setExtraSkills(null));
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
    // The skills the enabled plugins ship (`skills/` of each), read with the tracked and the local ones.
    pluginDirs: () => enabledPlugins().map((plugin) => plugin.skillsDir),
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
  // The one place the meaning index hears of new record lines: every writer (edits and deletions,
  // the persona's own lines, feelings) appends through this record,
  // and once an append took lines they are queued for embedding (the queue keeps what it wants
  // and is off unless features.meaningSearch and features.embedIndex are both exactly true).
  const record = {
    ...recordWriter,
    async append(guildId: string, lines: Untyped, opts: Untyped) {
      const result = await recordWriter.append(guildId, lines, opts);
      if (embedQueue && result?.written > 0) {
        try {
          embedQueue.enqueue(guildId, lines, opts ?? {});
        } catch (err) {
          log.warn('index: embed enqueue failed', { guildId: String(guildId), code: objOf(err).code ?? null });
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
    config: () => hot.config.journal ?? {},
    lockStores: [archiveAppendStore],
    memoryDb,
  });
  const store = createStore({
    dataDir,
    record,
    archive,
    memoryDb,
  });

  const calibrator = createCalibrator(store.state.data.calibration);
  // Which model roles are down (src/llm/role-health.ts): one tracker for the turns, the operations, the describer and
  // `/status`. A role has no key when the key it resolves to is empty (src/llm/openrouter.js#roleApiKey).
  const roleHealth = createRoleHealth({
    now: () => Date.now(),
    hasKey: roleKeyCheck({ hot, env, mainKey: openrouterKey, keyOf }),
  });
  // `env` (the .env loaded once above): the keys `llm.keyByRole` names per role, looked up per request.
  // createLlm (src/llm/openrouter.js) declares `complete` as `Function`, which no caller's declared call accepts, so
  // the core hands the client on typed as the call the modules below make.
  // The core's own failure `keys-exhausted` (every key of its list out of credit) is told to the tracker.
  const llm = (options.llm ??
    reportingCoreKeys(
      createLlm({
        apiKey: openrouterKey,
        env,
        keys: ringNow,
        getConfig: () => hot.config,
        calibrator,
        state: store.state,
      }),
      roleHealth
    )) as ChatClient;
  // Embeddings (role embedding) on the same daily request count as the chat client.
  const embedder = options.embedder ?? createEmbedder({ apiKey: openrouterKey, env, keyOf, state: store.state });
  // The meaning index kept current: record lines queued above, flushed on the tick below.
  embedQueue = createEmbedQueue({
    hot,
    vectors,
    embed: (texts, opts) => embedder.embed(texts, opts),
    record: recordWriter,
    log,
    nameOf: (guildId, userId) => firstName(store.getUser(guildId, userId)) ?? members.nameOf(guildId, userId),
    selfName: (guildId) => getSelfName(guildId),
    // No catch-up pass while paused (the owner may be editing data/); /nep resume runs one.
    paused: () => store.state.data.paused === true,
    memoryDb,
  });
  // The persona's drawings: its own daily rails, counted on the same state.
  // Pictures are paid with the drawing role's key (`llm.keyByRole.drawing`, the agents' key), read at
  // each request; the main key when the role names none.
  // The options are named first: the module does not declare `state`, the daily counter it shares with the chat client.
  const imageOptions = {
    apiKey: () => keyOf('drawing') ?? roleApiKey(hot.config, env, 'drawing', openrouterKey),
    getConfig: () => hot.config,
    state: store.state,
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
    state: store.state,
  };
  const speech = speechReady ? createSpeech(speechOptions) : null;

  // This instance serves exactly one community. `instance.guildId` is set
  // once, right after ClientReady resolves it (see below), and every component
  // that needs it reads it through `getGuildId` instead of caching it, so a
  // switch to a different guild always requires a restart, never a silent swap.
  const instance: { guildId: string | null } = { guildId: null };
  const getGuildId = () => instance.guildId;
  // The community id the startup steps and the modules below take as a `string`. It is null only before the
  // community resolves (below; in units mode it is `bot.guildId`), and those modules are called after that.
  const servedGuildId = (): string => instance.guildId as string;

  // Shared so a picture attached on consecutive turns, or described more than
  // once, is only ever downloaded once within the fetcher's LRU window.
  const imageFetcher = createImageFetcher();
  const videoFetcher = createVideoFetcher();
  // state: the daily video counter lives next to the LLM client's daily counter.
  // Its vision and video requests tell the role health how they went.
  const describerLlm = reportingLlm(llm, { health: roleHealth, hot, roles: ['vision', 'video'] });
  const describer = createDescriber({
    hot,
    store,
    llm: describerLlm,
    imageFetcher,
    videoFetcher,
    state: store.state,
    youtubeApiKey,
  });
  // The web lookup (features.webLookup, off by default): link reader + search on a question.
  // state: the daily web counter lives next to the LLM client's daily counter.
  // The options are named first: the module does not declare `state`, the daily web counter.
  const lookupOptions = {
    hot,
    // The store answers a media cache as a plain object; the lookup reads it as its cache entries.
    store: store as unknown as Parameters<typeof createLookup>[0]['store'],
    llm,
    state: store.state,
    pageFetcher: createPageFetcher(),
    // web.search.engine picks one of these; web.search.fallback orders the others.
    searches: { brave: createBraveSearch(), exa: createExaSearch() },
    keys: { brave: braveApiKey, exa: exaApiKey },
  };
  const lookup = createLookup(lookupOptions);
  // The persona's display name in a community: the one name every request uses. Her nickname there when the member
  // directory holds one (a nickname change reaches it through `membership.changed`), else the name `hello` gave.
  const getSelfName = (guildId: string | null) => members.nameOf(guildId ?? '', identity.selfId) ?? identity.selfName;

  // The link between the core and its interfaces (docs/interfaces.md): the core listens on a Unix socket under the
  // data directory, an interface connects with its token, says hello and serves its adapter. Every inbound event
  // travels as an envelope to the core's door and every effect of the persona travels back as an action. An interface
  // started here connects with a token made at boot; a unit connects with the token of its client in clients.json.
  // The socket folder is set to 0750 and the file to 0660 for the group `neptunia` (src/interface/socket.ts).
  const LINK_SOCKET = coreSocketPath(dataDir);
  const linkToken = randomBytes(32).toString('hex');
  // Every client is a principal of the private layer's clients.json (src/interface/principals.ts), read at each
  // envelope. With no clients.json the token made here is the boot principal of the one in-process interface, named
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
    // The core serves one interface: its namespace is known from clients.json before any unit connects, so every module
    // below is built with it.
    const ifaces = [...new Set(interfaceClients().map((entry) => entry.iface))];
    if (ifaces.length > 1)
      fail(`index: clients.json names interfaces of ${ifaces.length} namespaces; the core serves one.`);
    identity.iface = ifaces[0] ?? '';
  }
  // The owner's switch of each interface (interfaces.<name>.enabled), written to the private settings file and reloaded,
  // as the owner commands write it (src/tools/impl/env.ts#editLocalConfig).
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
  const ingestRows = createRowsByMessage();
  const observingDb = observingWith(memoryDb, ingestRecord, ingestRows);
  // The door is created below, once its handlers exist; an envelope that arrives sooner waits for it.
  const doorReady: PromiseWithResolvers<{ receive(value: unknown, from?: From): Promise<Envelope> }> =
    Promise.withResolvers();
  const linkDoor = {
    receive: async (value: unknown, from: From | undefined) => (await doorReady.promise).receive(value, from),
  };
  const linkOpened: PromiseWithResolvers<ReturnType<typeof openAdapterLink>> = Promise.withResolvers();
  // With the interfaces as units the core's adapter starts with no link: the first interface whose hello is taken
  // becomes the one the core serves.
  let linkSwitch: ReturnType<typeof createLinkSwitch> | null = asUnits ? createLinkSwitch(null) : null;
  let servedName: string | null = null;
  /** The served interface's hello: who the persona is on it. */
  function greet(greeting: Hello) {
    identity.iface = greeting.iface;
    identity.selfId = greeting.self.id;
    identity.selfName = greeting.self.name;
  }
  // The owner's commands (src/interface/neptunia-cli.ts) are answered before the door: a command never reaches her
  // memory or a turn. The desk exists once the admin does, below; a command that arrives sooner waits for the door.
  // The link of the owner's chat that sent the last line is where her replies in `cli:dm:owner` go.
  let commandDesk: ReturnType<typeof createCommandDesk> | null = null;
  const intake = createCommandIntake({ door: linkDoor, ready: () => doorReady.promise, desk: () => commandDesk, log });
  const linkServer = await listenSocket({
    path: LINK_SOCKET,
    maxFrameBytes: MAX_FRAME_BYTES,
    log,
    // A connection is a plugin's when its first envelope is a `hello` under the namespace `plugin`.
    onConnection: (transport) =>
      routeConnection(transport, { adapter: openInterfaceLink, plugin: openPluginConnection }),
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
        if (asUnits && servedName === null && principal?.kind === 'interface') {
          servedName = principal.name;
          if (greeting.community !== null && greeting.community.id !== instance.guildId)
            log.warn('index: the interface serves another community than bot.guildId', {
              principal: principal.name,
            });
        }
        if (principal === null || principal.name !== (asUnits ? servedName : switched.current().principal()?.name))
          return;
        switched.attach(link);
        if (asUnits) greet(greeting);
      },
      () => {}
    );
  }
  /**
   * A plugin's link (src/plugins/link.ts): its hello is let in only while the owner has it on, its tools go to the
   * registry, and the first time a plugin registers a tool it was not announced for, a heartbeat wake with the cause
   * `ability.added` tells her.
   */
  function openPluginConnection(transport: Transport) {
    const link = openPluginLink({
      transport,
      principalOf,
      admit: (principal) => (pluginEnabled(settings.config, principal.name) ? null : 'plugin-disabled'),
      register: (plugin, tools) => {
        const outcome = pluginRegistry.register(plugin, tools);
        announceAbilities(plugin, outcome.accepted);
        return outcome;
      },
      deadlineMs: () => pluginCallDeadlineMs(settings.config),
      now: clock,
      log,
    });
    link.hello.then(
      ({ plugin }) => {
        pluginLinks.get(plugin)?.close();
        pluginLinks.set(plugin, link);
        pluginRegistry.attach(plugin, link);
      },
      () => {}
    );
  }
  /** The live plugin link of each plugin by name, so a disable can close it. */
  const pluginLinks: Map<string, PluginLink> = new Map();
  const announced = fileAnnounceStore(dataDir);
  /** Where the ability wake goes once the inner life exists below. */
  let raiseWake: ((wake: Wake) => unknown) | null = null;
  function announceAbilities(plugin: string, accepted: ReadonlyArray<string>) {
    if (raiseWake === null || getGuildId() === null) return;
    const tools = newAbilities({ plugin, accepted, store: announced });
    if (tools === null) return;
    log.info('plugins: ability announced', { plugin, reason: ABILITY_ADDED, tools: tools.length });
    void Promise.resolve(raiseWake(abilityWake({ at: clock(), plugin, tools }))).catch((err: unknown) =>
      log.warn('plugins: ability wake not queued', { plugin, error: err })
    );
  }
  // The owner's switch of a plugin (plugins.<name>.enabled), written to the private settings file and reloaded, as the
  // interfaces' switch is.
  function setPluginEnabled(name: string, enabled: boolean) {
    const file = localConfigPath(paths.privateDir);
    writeLocalConfig(file, setPath(readLocalConfig(file), ['plugins', name, 'enabled'], enabled));
    settings.reloadConfig();
  }
  const pluginControl = createPluginControl({
    folders: pluginFolders,
    privateDir: paths.privateDir,
    isEnabled: (name) => pluginEnabled(settings.config, name),
    setEnabled: setPluginEnabled,
    connected: (name) => pluginRegistry.connected(name),
    toolsOf: (name) => pluginRegistry.tools(name),
    units: options.units ?? systemdUnits(),
    unitsMode: () => asUnits,
    // A disabled plugin has no tool, no announcement and no link left.
    onDisabled: (name) => {
      pluginRegistry.forget(name);
      forgetAbilities({ plugin: name, store: announced });
      pluginLinks.get(name)?.close();
      pluginLinks.delete(name);
    },
  });
  // An interface run in this process is started by the caller (src/index.ts loads the interface package by name at run
  // time, a test passes the fake one) with the core's end of the link, its settings and its logger. It builds its
  // client, logs in, waits for the guild, says hello and serves its adapter; the events it sees wait until
  // `running.open()` below, when the door has its handlers. A refusal (no token, no guild, no login) stops the start
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
  if (hello !== null) greet(hello);
  // The around store tells a presence event from a voice one by what the interface declares in `hello`: whether it
  // reports presences at all (intents are fixed at login, the interface reads its own at its start).
  // The live glance at the voice channels and the scene's statuses: a snapshot in process memory,
  // fed by the interface's voice, presence and connection events through the door below, never written anywhere.
  const around = createAroundStore({ presences: () => coreLink.adapter.capabilities().presence === true });
  // The persona's interface (src/interface/port.js): every effect of her replies goes through it,
  // after the skill gateway (src/tools/gateway.ts) let the call pass. It is the guarded port: a send to a diary
  // mirror's place goes nowhere (`diary-mirror`); only the mirrors' publisher below holds the link's own adapter.
  // Her replies in the owner's chat (`iface: 'cli'`) go to the chat's link, every other effect to the served
  // interface; with no chat connected a reply there ends as a dropped link's does.
  const routed = createIfaceRouter(
    coreLink.adapter,
    (name) => (name !== CLI_IFACE ? null : (intake.chat() ?? closedAdapter())),
    () => [intake.chat()].filter((adapter) => adapter !== null)
  );
  const iface = guardMirrorPort(routed, { memoryDb });
  // The diary's mirrors (src/behavior/mirror.ts): each recorded entry published once to every enabled mirror.
  const mirrors = createMirrors({ memoryDb, port: () => coreLink.adapter, now: Date.now, dataDir });

  // The community the interface serves, or the configured one when the interfaces run as units.
  instance.guildId = asUnits ? configuredGuild : (hello?.community?.id ?? null);
  // The core's reads of the interface: each answers its body or null, and a block that needs one is left out when it is null.
  const reads = createReads(iface, log);
  // The custom emoji of the served community, read from the interface and kept 60 seconds: the turn lists them to her
  // and turns her `:name:` into the platform's markup through it.
  const emoji = createEmojiIndex({ reads, communityId: () => instance.guildId, now: Date.now });
  // What each profiled member's avatar looks like (features.avatars, off by default): a throttled
  // background queue on the vision role, its daily counter next to the LLM client's. Each member is one read of the
  // interface; a member who left reads as gone.
  // The options are named first: the module does not declare `state`, the daily counter it shares with the chat client.
  const avatarOptions = {
    hot,
    store,
    llm,
    imageFetcher,
    state: store.state,
    getGuildId,
    selfId: () => identity.selfId,
    reads,
    paused: () => store.state.data.paused === true,
  };
  const avatars = createAvatarQueue(avatarOptions);
  // Who reacted to her messages, fed by `reaction.changed` (the door below) and by the `reactors` read.
  const reactors = createReactorStore();
  // The route classifier: picks a channel the conversation is about for <channel_view>.
  const routeChannels = createChannelRouter({ hot, store, llm });
  // The search of the server's own history beside the web search: the lookup's server part.
  // It reads the archive and the record too (read only), and with features.meaningSearch the meaning
  // index (one embedding of the question per run).
  const recall = createRecall({
    hot,
    store,
    llm,
    reads,
    memberName: (communityId, memberId) => members.nameOf(communityId, memberId),
    describer,
    archive,
    record,
    vectors,
    embed: (texts: Array<string>, opts: Untyped) => embedder.embed(texts, opts),
    memoryDb,
    iface: identity.iface,
  });
  // When each person last wrote in each channel (fed by the message handler): a turn answering
  // someone waits until they stop writing (pace.settleMs).
  const activity = createActivity();
  // The persona's errands (`errands.*`, `agents.<profile>` overrides): a task she or a member asks for goes to its agent runner over
  // its socket in the background (src/errands/); the errands are tasks of the board's errand lane in memory.db.
  const errandClient = createErrandClient({ hot, log });
  const taskStores = createErrandStores({ config: () => hot.config, journal, log, memoryDb });
  // An errand's end opens her own turn where it was asked (the task turns, created below the runner).
  // An errand's end is an `errand.done` event through the event door (`door`, created below with
  // the gateway's handlers), its id `errand-done:<errand id>`; the door's handler (src/errands/turns.ts#onEvent) first
  // moves the intentions waiting on it back to pending, then opens her turn, which shows them with the outcome. Once
  // the door took the event its end is marked delivered on the board, so a core started after a crash finds only the
  // ends it never delivered (ErrandStore#pendingEnds).
  async function submitErrandEnd(task: ErrandRecord, guildId: string) {
    const answer = await door.submit({ ...errandDoneEvent(task, guildId), id: `errand-done:${task.id}` });
    if (answer.status === 'ok' || answer.status === 'duplicate') taskStores.get(guildId)?.markDelivered(task.id);
    return answer;
  }
  // A task's `context.recent`: the channel's newest lines from the memory database (her own under her name), oldest first.
  function recentChannelLines(guildId: string, channelId: string, count: number) {
    const db = memoryDb.database();
    if (!db || !channelId || !(count > 0)) return [];
    // The columns the statement selects.
    const rows = db
      .prepare(
        `SELECT s.kind, s.text, a.names FROM sources s LEFT JOIN accounts a ON a.id = s.author_account
      WHERE s.place_id = ? AND s.kind IN ('seen', 'said') AND s.retired_at IS NULL AND length(COALESCE(s.text, '')) > 0 ORDER BY s.occurred_at DESC, s.rowid DESC LIMIT ?`
      )
      .all(channelPlaceId(identity.iface, String(channelId)), count) as Array<{
      kind: string;
      text: string | null;
      names: string | null;
    }>;
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
      lines.push({ author: name, text: row.text ?? '' });
      if (lines.length >= count) break;
    }
    return lines.reverse();
  }
  const errands = createErrandService({
    client: errandClient,
    stores: taskStores,
    hot,
    env,
    memory: { recentLines: recentChannelLines },
    getGuildId,
    log,
    onFinished: (task, guildId) => submitErrandEnd(task, guildId),
  });
  // The persona's intentions: data/guilds/<id>/intentions.json, her own
  // `intent.*` calls, the analyzer's candidates from her lines, and the waits on her errands.
  // Both stores send their writes to the database; `flush` is their retry and shutdown step.
  const intentionStores = createIntentionStores({ log, memoryDb });
  const intentions = createIntentionService({ stores: intentionStores, hot, errands, journal, getGuildId, log });
  // The conversations the interface reported (`conversation.changed`) and the direct chats it showed in messages:
  // their names for the inner life and the turn, the direct chat of a member for a memory session failure.
  const directory = createConversationDirectory();
  // When the interface's link to its platform last came back, for /nep status.
  const connection: { lastReconnectAt: number | null } = { lastReconnectAt: null };
  const turns = createTurnRunner({
    hot,
    store,
    roleHealth,
    // The memory rows a turn's request carried go to the database.
    memoryReads: (args: Untyped) => memoryDb.recordTurnReads(args),
    // One execution context per turn for its memory reads (recorded while the database is open).
    memoryContext: (spec: Untyped) => memoryDb.issueContext({ iface: identity.iface, ...spec }),
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
    reads,
    memberOf: (communityId: string, memberId: string) => members.infoOf(communityId, memberId),
    membersOf: (communityId: string) => members.list(communityId),
    conversationName: (conversationId: string) => directory.nameOf(conversationId),
    routeChannels,
    activity,
    journal,
    record,
    port: iface,
    // The registered tools of the plugins and the call to one: her in-turn tools beside the core's own.
    plugins: {
      tools: () => pluginRegistry.tools(),
      call: (tool: string, args: Record<string, unknown>, context: PluginCallContext) =>
        pluginRegistry.call(tool, args, context),
    },
    // The index of her active skills (`<skills>`) and the sink of the use rows (src/skills/uses.ts).
    skillIndex: skillsWiring.index,
    recordSkillUses: skillsWiring.record,
    // Her skills run by operation name, the requester's rights checked again
    // (src/admin.ts#runSkillOp); read at call time, the admin being created below.
    runOp: (op: Untyped, args: Untyped, context: Untyped) => admin.runSkillOp(op, args, context),
    // Her own messages, drawings and diary run on her grant alone (src/tools/impl/effects.ts#SELF_OWNED_OPS).
    runOwnOp: (op: Untyped, args: Untyped, context: Untyped) => admin.runOwnSkillOp(op, args, context),
    // An inner turn's calls (her own initiative, nobody asked) run on her grant alone too.
    runInitiativeOp: (op: Untyped, args: Untyped, context: Untyped) => admin.runInitiativeSkillOp(op, args, context),
    // `<errands>`: her open and newly finished errands; an errand's caps are its skill's budget.
    errands,
    // What a turn writes to her diary with message.create, published by the diary's mirrors when it ends.
    mirrors,
    // `<intentions>`: her open intentions and the candidates from her lines.
    intentions,
    // `<places>` on an addressed turn (context.places): the inner life's places view, read at call time.
    places: (guildId: string, options: Untyped) => inner.places(guildId, options),
  });
  const spontaneous = createSpontaneous({ turns });
  // The persona's diary: its own entries on a day plan as the selfreflection wake, ticked below, each published to the
  // diary's mirrors. The diary's posts are rows of the memory database already: no backfill from the channel.
  const diary = createDiary({ hot, store, reads, turns, getGuildId, mirrors });
  // The code-only memory of the live message path (src/memory/update.js): counters, GIF library, emoji, names.
  const memory = createMemoryUpdater({ hot, store });
  // The turn an errand's end opens, through the lease and a cooldown per conversation.
  const taskTurns = createErrandTurns({
    hot,
    reads,
    iface: () => identity.iface,
    turns,
    errands,
    intentions,
    getGuildId,
    log,
  });
  // The places the interface lists for a community, as the inner life shows them to her: the channels she may read, with
  // whether she can write there. The view is read synchronously, so the last listing of each community is kept here,
  // read again when a conversation changes and before each beat of the inner life.
  const placeListings: Map<string, Array<{ id: string; name: string; writable: boolean }>> = new Map();
  async function refreshPlaces(communityId: Untyped) {
    if (!communityId) return;
    const snapshot = await takeSnapshot(reads, String(communityId));
    if (snapshot === null) return;
    placeListings.set(
      String(communityId),
      snapshot.conversations
        .filter((entry) => isReadable(entry))
        .map((entry) => ({ id: entry.id, name: entry.name ?? entry.id, writable: entry.permissions.send }))
    );
  }
  const placesOf = (guildId: string) => placeListings.get(String(guildId)) ?? [];
  // The persona's inner life (features.innerLife, off by default; docs/inner-life.md): a scheduler
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
    record,
    // Her attention: the places the interface publishes, and the names of the people a wake names.
    places: placesOf,
    // The names of the conversations the interface reported (`conversation.changed`), for the places she is shown.
    conversationName: (conversationId) => directory.nameOf(conversationId),
    nameOf: (guildId, memberId) => firstName(store.getUser(guildId, memberId)) ?? null,
    journal,
    reads,
    iface: () => identity.iface,
    store,
    getGuildId,
    // People's turns first: an inner turn waits while a direct ping is queued.
    peopleWaiting: () => onMessage.pendingCount() > 0,
    submit: (event) => door.submit(event),
    // The wake's turns line (src/behavior/turn-budget.ts): the core keys' balances against the week's core requests.
    turnsBudget: createTurnsBudget({
      usage,
      // What is left of each key of the core's list: its `llm.keys` grant minus what the usage records say went out on it.
      keyBalances: () => coreKeyBalances({ llm, usage, config: hot.config, now: clock() }),
      now: clock,
    }),
    // Each inner turn as a wake run in the memory database.
    memoryDb,
    // A live wake turn's posts go out through the guarded port once the wake completed (src/behavior/inner/deliveries.ts).
    port: iface,
    now: clock,
    // The heartbeat's facts (src/behavior/heartbeat-view.ts): her errands, what she can do. No presence or
    // do-not-disturb state (owner, 2026-10-20: she must not read those markers).
    heartbeat: {
      tasks: (guildId) => taskStores.get(guildId)?.recent(100),
      skills: () => grantedSkillNames({ config: hot.config, selfId: identity.selfId, registry: skillRegistry() }),
      agents: () => Object.keys(AGENT_PROFILES),
      selfId: () => identity.selfId,
      focusPeople: () => memoryDb.focusPeople({ iface: identity.iface }),
      // The fixes of her own code that merged (src/selfimprovement/landed.ts), told once.
      landed: async () => (await landedFor(board)).landed,
      ackLanded: (seqs) => ackLanded(board, seqs),
    },
    // The selfimprovement wake's facts beyond the journal (src/behavior/selfimprovement-view.ts): her grants, her
    // skills with their use counts, her proposals and her outbox rows on the board.
    selfimprovement: skillsWiring.selfimprovement,
    log,
  });
  // The drops, holds and failures kept for her next request in a conversation live in the inner life's state.
  turns.setFactsSource(inner.facts);
  // The wake that tells her a plugin added a tool goes into the inner life's queue (src/plugins/announce.ts).
  raiseWake = (wake) => inner.enqueue(getGuildId() ?? '', wake);
  /**
   * A memory session run that failed (src/memory/db/service.js, once per failing scope),
   * told the same way: a `memoryFailed` fact with the code and the lines waiting; a private conversation's only in that
   * private chat (its DM channel, when the client knows it). Never throws.
   */
  function tellSessionFailure({
    scopeKind,
    partner,
    code,
    lines,
    at,
  }: {
    scopeKind: Untyped;
    partner: Untyped;
    code: Untyped;
    lines: Untyped;
    at: number;
  }) {
    try {
      if (inner.facts?.enabled?.() !== true) return;
      const guildId = getGuildId();
      if (!guildId) return;
      const privateChat = scopeKind === 'dm';
      const userId = privateChat ? String(partner ?? '').replace(/^person:[^:]+:/, '') : null;
      const channelId = userId !== null ? directory.dmConversationOf(userId) : null;
      inner.facts.add(guildId, { kind: 'memoryFailed', code, waiting: lines, channelId, privateChat, at });
    } catch (err) {
      log.warn('index: memory session failure not told', { code: objOf(err).code ?? null });
    }
  }
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
    iface: () => identity.iface,
    partnerOf: (conversationId) => directory.partnerOf(conversationId),
    getGuildId,
    getSelfName,
    dataDir,
  });
  turns.setOnTurnEnd((end) => missed.onTurnEnd(end));
  // The custom emoji ranking read from history (the interface's reads only, no model call): once at startup, again on /nep emoji rescan.
  const emojiBackfill = createEmojiBackfill({ store, reads, iface: () => identity.iface, log });
  // The GIF library read from history (the interface's reads; the describer captions the top ones): once at
  // startup, again on /nep gifs rescan.
  const gifBackfill = createGifBackfill({ store, reads, iface: () => identity.iface, describer, log });
  // The GIF library re-described by watching (src/memory/gif-recache.js): only on /nep gifs recache;
  // and the pictures an older model described, found through the record: only on /nep media
  // kind:pictures action:recache.
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

  const onMessage = createMessageHandler({
    hot,
    store,
    // The core's reads of the interface: the conversation a message is in, its history, a message by id, a member.
    reads,
    selfId: () => identity.selfId,
    turns,
    memory,
    tagHistory,
    getGuildId,
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
    // Its observations carry the ingestion row of their event (ingestRows above).
    memoryDb: observingDb,
    // The limit and pause notices go out through the interface like any other effect.
    port: iface,
  });

  // The messages posted while the bot was down (src/behavior/catch-up.ts): once at start, read through the interface's
  // history after the last message seen per channel and handed to the handler's catch-up path.
  const offlineCatchUp = createOfflineCatchUp({
    hot,
    store,
    journal,
    iface: identity.iface,
    reads,
    // A caught-up message is observed once, by the handler's catch-up path, never emitted as a live event.
    // The adapter's `MessageEvent` and the protocol's `MessageReceived` name one event; the second marks every field.
    deliver: (event, options) => onMessage.catchUp(event as MessageReceived & { raw: object }, options),
  });

  // One turn at a time (mention.oneAtATime): once a turn frees its channel, answer
  // the oldest pending direct ping it may have collected while busy elsewhere.
  turns.setOnIdle(() => onMessage.drainPending());

  const admin = createAdmin({
    hot,
    store,
    // Her board tools (src/tools/impl/board.ts): she files and reads as the builtin principal `persona`.
    board,
    // Her skill tools (src/tools/impl/skill.ts): `skill.read` and `skill.disable`.
    skills: skillsWiring.access,
    // Her tool `watcher.read` (src/tools/impl/watcher.ts): the reports folder follows `watcher.dir` at each read.
    watcher: createReportReader(() => reportsDirOf(paths.rootDir, watcherDir(hot.config))),
    roleHealth,
    // The operations' `env.reads`: the conversation they post in, a message's event.
    reads,
    // Who the persona is, and the names of members and conversations the interface reported.
    selfId: () => identity.selfId,
    getSelfName,
    memberNameOf: (communityId, memberId) => members.nameOf(communityId, memberId),
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
    // Her message.create to her diary: held for the turn's entry by the diary's publisher.
    mirrors,
    spontaneous,
    calibrator,
    getGuildId,
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
    cardKeys: () => statusCardKeys(paths.privateDir, env),
    // /nep memory snapshot: the data directory it copies.
    dataDir,
  });
  // The key commands: the checks go to the provider with the global `fetch` of the moment, a model is saved through the
  // `model.set` operation, and the last core key's removal pauses her with the reason `no-core-key`.
  const asOwner = { guildId: getGuildId(), userId: '', roleIds: [], actor: 'owner', asOwner: true };
  const ownerOp = async (op: string, args: Record<string, unknown>): Promise<string> => {
    const result = await admin.runSkillOp(op, args, { ...asOwner, guildId: getGuildId() });
    if (result.status !== 'ok') throw new Error(result.summary || result.code);
    return result.summary;
  };
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
    currentModel: (role) => roleModel(hot.config, role) ?? '',
    saveModel: async (role, model) => {
      await ownerOp('model.set', { role, id: model });
    },
    pause: {
      async pause(reason) {
        const wasPaused = store.state.data.paused === true;
        await ownerOp('bot.pause', {});
        if (wasPaused) return;
        store.state.data.pausedReason = reason;
        store.state.markDirty();
        store.flush();
      },
      async resume() {
        await ownerOp('bot.resume', {});
        if (store.state.data.paused) throw new Error('she is still paused: run /resume and read its answer');
      },
      reason: () => (store.state.data.paused ? String(store.state.data.pausedReason ?? 'owner') : null),
    },
  });
  // The owner's commands over the link: the `neptunia` chat and `-p`, and the board commands of the agents.
  commandDesk = createCommandDesk({
    // The owner's console (src/interface/commands/console.ts): the chat's table over the operations, run as the owner.
    console: createConsole({
      runOp: (op, args, context) => admin.runSkillOp(op, args, context),
      ownerReads: admin.ownerReads,
      guildId: getGuildId,
      selfId: () => identity.selfId || null,
      hot,
      privateDir: paths.privateDir,
      dataDir,
      memoryDb,
      usage,
      metrics,
      conversationLines: (conversationId, count) => {
        const guildId = getGuildId();
        return guildId ? recentChannelLines(guildId, conversationId, count) : [];
      },
      now: Date.now,
      // `/skills` (src/interface/commands/skills.ts).
      skills: skillsWiring.access,
      // `/plugins` (src/interface/commands/plugins.ts).
      plugins: pluginControl,
      // `/keys` and the checked `/model set` (src/keys/commands.ts), over the key store.
      keys: { enabled: () => ringNow() !== null, run: (name, args, dialog) => keysCommands.run(name, args, dialog) },
      // `/subharness enable` checks with one run of the backend or one GET of the key (src/subharness/control.ts); a
      // mode change goes into the agent's unit (src/setup/install.ts).
      subharness: {
        asksModels: true,
        isInstalled: (backend) => isInstalled(paths.privateDir, backend),
        runBackend: (backend, brief, model) =>
          createInstalledBackend(backend, paths.privateDir).run(brief, {
            cwd: os.tmpdir(),
            timeoutMs: REPLY_CHECK_MS,
            sandbox: 'read-only',
            ...(model === undefined ? {} : { model }),
          }),
        fetch,
        get baseUrl() {
          const base = objOf(objOf(hot.config).llm).baseUrl;
          return typeof base === 'string' ? base : undefined;
        },
        applyMode: (agent) => Promise.resolve(deferModeToUnit(agent)),
      },
    }),
    interfaces: interfaceLinks,
    guildId: getGuildId,
    // The agents' board commands (src/board/commands.ts), each run in the memory writer.
    tasks: board,
    // The agents' `skill.pending` and `skill.activate` (src/skills/agent-commands.ts).
    skills: skillsWiring.access,
    facts: () =>
      coreStatusFacts({
        hot,
        store,
        usage,
        interfaces: interfaceLinks,
        inner,
        errands: taskStores,
        guildId: getGuildId,
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
        .then(fn)
        .catch((err) => log.error(`index: ${label} failed`, { error: err }));
    }, ms);
    id.unref?.();
    timers.push(id);
  }

  /**
   * RELATIONSHIP_LIMITS.decayPerDay: every stored affinity (public and private) drifts toward zero, one
   * step per whole day (src/memory/store.js#decayAffinities). Cheap to run hourly: it only applies
   * full days. Skipped while paused (the owner may be editing data/).
   */
  /** How often the affinity decay sweeps. */
  const AFFINITY_SWEEP_MS = 3_600_000;

  function sweepAffinityDecay() {
    const guildId = instance.guildId;
    const config = hot.config;
    if (!guildId) return;
    if (store.state.data.paused) return;
    // Decay counts only time she was running: the sweep runs hourly, so a gap of more than two sweeps since the last one
    // (kept in the state file) is downtime, and all of it but one sweep's hour is skipped.
    const now = Date.now();
    const last = Date.parse(store.state.data.affinityDecaySweptAt ?? '');
    const gap = Number.isFinite(last) ? now - last : 0;
    const skipMs = gap > 2 * AFFINITY_SWEEP_MS ? gap - AFFINITY_SWEEP_MS : 0;
    const decay = { ...RELATIONSHIP_LIMITS, skipMs };
    const counts = store.decayAffinities(guildId, now, decay);
    store.state.data.affinityDecaySweptAt = new Date(now).toISOString();
    store.state.markDirty();
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
          .then(() => (instance.guildId && !store.state.data.paused ? store.drainArchive(instance.guildId) : null))
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
   * One startup step after the guild resolved, by name: a synchronous throw or
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
  async function reconcileJournal(guildId: string) {
    const startedAt = Date.now();
    const days = [utcDay(startedAt - DAY_MS), utcDay(startedAt)];
    const counts = await journal.reconcile(guildId, {
      days,
      before: startedAt,
      fetchOwnMessages: ownMessagesOf(reads, identity.iface),
    });
    log.info('journal: reconciled', { guildId, succeeded: counts.succeeded, unknown: counts.unknown });
  }

  /**
   * Which message started the turn that posted each of the persona's messages of yesterday and
   * today (the journal's turn records), handed to the turn runner so her lines posted before this
   * start keep naming their trigger in the transcripts. Read whatever the switches: the runner
   * renders the links only with features.triggerMarkers on, and a journal never written gives none.
   */
  async function seedTriggerLinks(guildId: string) {
    const at = Date.now();
    const pairs = await journal.triggerLinks(guildId, { days: [utcDay(at - DAY_MS), utcDay(at)] });
    turns.seedTriggerLinks(pairs);
    log.info('journal: trigger links read', { guildId, links: pairs.length });
  }

  /**
   * The persona's skill calls of yesterday and today (the journal's skill operations), handed to the
   * turn runner so her lines keep showing what she called and how it went across this start. Read
   * whatever the switches: the runner renders them only with features.callMarkers on.
   */
  async function seedCallMarks(guildId: string) {
    const at = Date.now();
    const marks = await journal.callMarks(guildId, { days: [utcDay(at - DAY_MS), utcDay(at)] });
    turns.seedCallMarks(marks);
    log.info('journal: call marks read', { guildId, calls: marks.calls.length });
  }

  /** Whether the journal is written now (features.journal exactly true, read now). */
  const journalOn = () => true;

  /** Delete the request dumps older than journal.keepRequests days. */
  async function pruneJournalRequests(guildId: string) {
    if (!journalOn()) return;
    const { removed } = await journal.pruneRequests(guildId);
    log.info('journal: pruned', { guildId, removed });
  }

  /**
   * The journal at start, with the journal on: a `.running` marker left by a run that never stopped
   * cleanly becomes an `unclean-stop` record, this run's marker is written and the `start` record follows.
   */
  async function startJournal(guildId: string) {
    if (!journalOn()) return;
    const { unclean } = await journal.markRunning(guildId);
    if (unclean) log.warn('journal: unclean stop noted', { guildId });
    await journal.system(guildId, { event: 'start', by: 'service' });
  }

  // A reload that took (config or prompts) is a system record of the served guild.
  hot.onReload((what: Untyped) => {
    if (!instance.guildId || !journalOn()) return;
    void journal.system(instance.guildId, { event: 'reload', note: what });
  });

  // A running instance never switches servers live: bot.guildId is only read at
  // startup. If the owner later points it at a different, non-empty guild while
  // the process is up, keep serving the original one and just say so. (The command tree is the
  // interface's: it registers it again when the name or the switch changed.)
  hot.on('change', ({ what }: { what: Untyped }) => {
    if (what !== 'config') return;
    const configured = hot.config.bot.guildId;
    if (configured && configured !== instance.guildId) {
      log.warn('index: bot.guildId changed while running, restart required to switch servers', {
        serving: instance.guildId,
        configured,
      });
    }
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
  // The diary's beat also sends what its mirrors still hold queued.
  scheduler.add({
    name: 'diary.tick',
    everyMs: () => 30_000,
    run: async () => {
      await diary.tick();
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
  // The inner life's tick, every innerLife.tickSeconds (read before each wait).
  scheduler.add({
    name: 'inner.tick',
    everyMs: () => innerSettings(hot.config).tickSeconds * 1000,
    run: async () => {
      await refreshPlaces(instance.guildId);
      return inner.tick();
    },
  });

  /**
   * A changed or posting member's avatar offered to the avatar queue (features.avatars, off by default), when the
   * member is of the served guild. The offer is synchronous and never throws.
   */
  function offerAvatar(
    guildId: string | null | undefined,
    member: { id: string; bot?: boolean; avatar?: { hash: string | null; url: string | null } } | undefined
  ) {
    if (guildId !== instance.guildId || !member?.avatar) return;
    avatars.offer(servedGuildId(), {
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
      'message.received': async (event: MessageReceived, context) => {
        // A new message while paused is held for the resume, with its ingestion row (src/behavior/core-pause.ts).
        holdIfPaused(event, context, store);
        const release = ingestRows.hold(event, context.ingest);
        try {
          // The direct chats of members are learned from the messages seen in them.
          directory.observe(event);
          if (event.deleted) return await onMessage.onMessageDelete(event);
          if (event.edit) return await onMessage.onMessageUpdate(event);
          // A member's own message carries their avatar: a changed one is queued for a description.
          offerAvatar(event.conversation?.communityId, event.message?.author);
          return await onMessage(event);
        } finally {
          release();
        }
      },
      // The reactor store follows the reactions on the persona's messages in the served guild, whatever
      // features.reactionNames says (a cheap map update; a switch turned on later finds it current).
      'reaction.changed': (event: ReactionChanged) => {
        try {
          applyReactionChanged(reactors, event, { communityId: instance.guildId, selfId: identity.selfId });
        } catch (err) {
          log.warn('reactors: event failed', { kind: event?.kind ?? null, code: objOf(err).code ?? null });
        }
      },
      'errand.done': (event: ErrandDoneEvent) => {
        // An errand an inner turn handed off counts its cost against the inner life's dollars.
        inner.onTaskFinished(
          event?.raw?.errand ?? errands.store?.(event?.communityId ?? null)?.get?.(event?.errandId) ?? null,
          event?.communityId ?? instance.guildId
        );
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
        log.info('around: seeded', { guildId: instance.guildId, ...around.counts() });
      },
      'connection.changed': (event: ConnectionChanged) => {
        if (event.state === 'resumed') connection.lastReconnectAt = event.at;
        return around.connection(event);
      },
      // The names of the conversations (the inner life shows them), and a changed avatar of a member.
      'conversation.changed': (event: ConversationChanged) => {
        directory.apply(event);
        void refreshPlaces(instance.guildId);
      },
      'membership.changed': (event: MembershipChanged) => {
        members.apply(event);
        offerAvatar(event.communityId, event.member);
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
    if (archiveDrainTimer) clearTimeout(archiveDrainTimer);
    diary.stop();
    onMessage.stop();
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
    if (instance.guildId) {
      if (journalOn()) await journal.system(instance.guildId, { event: 'stop', by: 'service', note: signal });
      await journal
        .clearRunning(instance.guildId)
        .catch((err) => log.warn('index: journal marker not removed', { error: err }));
    }
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
  // The interface is connected: what the diary's mirrors held queued goes out now.
  mirrors.drainQueued().catch((err: unknown) => log.warn('mirror: drain failed', { error: err }));

  // The periodic work first, before anything below can throw or wait: the
  // flush, the behaviours' beats, the hourly affinity decay. Then the startup steps, in order.
  every(30_000, () => store.flush(), 'store.flush');
  every(10_000, () => memoryDb.tick(), 'memoryDb.tick');
  // The intention and task writes that failed go again.
  every(30_000, () => Promise.all([intentionStores.flush(), taskStores.flush()]), 'module stores flush');
  // The spontaneous, diary and inner life ticks: the scheduler's beats, each wait a `scheduler.tick` through the door.
  scheduler.start();
  every(AFFINITY_SWEEP_MS, sweepAffinityDecay, 'affinity decay');
  // The embedding queue flushes on its own clock (src/memory/embedder.js; a full batch sooner);
  // the same tick runs its catch-up pass at the start and then on its own clock.
  every(30_000, () => embedQueue.tick(instance.guildId), 'embed.tick');
  // The avatar queue: its first tick scans the profiled members, then once a day; between
  // requests it waits its interval (src/memory/avatar-queue.js).
  every(5_000, () => avatars.tick(), 'avatars.tick');
  // The speed samples written to data/metrics.json (at most once a minute; nothing new, no write).
  every(60_000, () => metrics.save(), 'metrics.save');
  // Today's per-role usage written to data/usage.json (at most once a minute; nothing new, no write).
  every(60_000, () => usage.save(), 'usage.save');
  scheduleArchiveDrain();

  if (!hot.config.bot.guildId) {
    log.info('index: bot.guildId is not set, using the only guild the bot is in — pin it in config.local/config.json', {
      guildId: instance.guildId,
    });
  }

  log.info('index: ready', { guildId: instance.guildId, tag: identity.selfName });

  // A pause persisted before this restart comes back paused: every spontaneous tick does nothing until /resume.
  if (store.state.data.paused) {
    log.info('index: starting up paused, run /resume when data/ is ready', {
      pausedAt: store.state.data.pausedAt ?? null,
    });
  }

  // The database is the memory: opened first (its pending writes of the last shutdown replayed) and awaited, before
  // anything below reads it.
  await startupStep('memoryDb.open', () => memoryDb.tick(), { wait: true });

  // The journal's start: an unclean stop, the start record. Awaited, before the reconciliation below.
  await startupStep('journal.start', () => startJournal(servedGuildId()), { wait: true });

  // The links of the persona's recent lines to the messages that started their turns, rebuilt
  // from the journal. Fire-and-forget: a turn before it is done
  // only lacks the older links.
  await startupStep('journal.triggerLinks', () => seedTriggerLinks(servedGuildId()));
  // The persona's recent skill calls, the same way.
  await startupStep('journal.callMarks', () => seedCallMarks(servedGuildId()));

  // The missed-answer registry: data/guilds/<id>/missed.json, reconciled with the journal of the
  // last hour; a sweep armed where a candidate waits.
  await startupStep('missed.start', () => missed.start(servedGuildId()));

  // The errands a restart left open: their runner can no longer answer this process, so they fail
  // (`restarted`) and show in her `<errands>` block as failed.
  await startupStep('errands.start', () => errands.start(instance.guildId), { wait: true });

  // Her intentions reconciled with the errands as they stand now (those just failed included):
  // a wait whose errand ended, is gone or ran out moves back to pending; the expired ones expire.
  await startupStep('intentions.reconcile', () => intentions.reconcile(instance.guildId), { wait: true });

  // The meaning index caught up with what the record took while the queue was down (the last
  // CATCH_UP_HOURS of src/memory/embedder.js). Fire-and-forget; nothing while paused.
  await startupStep('embed.catchUp', () => embedQueue.catchUp(instance.guildId));

  // Once per guild after the deploy that keyed access by operation: the stored grants re-expanded
  // under the operation names, a journal record of what each covers now (src/tools/impl/access.ts).
  await startupStep('access.migrate', () => admin.migrateAccess(servedGuildId()), { wait: true });

  // The side effects a crash or a restart left without an outcome. Fire-and-forget: a turn
  // starting meanwhile is never touched (only earlier operations are), and it never sends.
  await startupStep('journal.reconcile', () => reconcileJournal(servedGuildId()).finally(journalReconciled));

  // The messages posted while the bot was down: observed, and a call
  // younger than offlineCatchUp.windowMinutes answered as live. Fire-and-forget: REST per
  // channel, never throws; the gateway's own messages are not held up meanwhile.
  await startupStep('offlineCatchUp.run', () => offlineCatchUp.run(servedGuildId()));

  // The request dumps older than journal.keepRequests days: once now, then daily.
  await startupStep('journal.prune', () => pruneJournalRequests(servedGuildId()));
  every(DAY_MS, () => pruneJournalRequests(servedGuildId()), 'journal.prune');

  // The custom emoji ranking from history, once (no emojiBackfill stamp). Fire-and-forget: never blocks the persona, logs its errors.
  await startupStep('emojiBackfill.startIfNeeded', () => emojiBackfill.startIfNeeded(servedGuildId()));

  // The GIF library from history, once (no backfill stamp in gifs.json). Fire-and-forget: never blocks the persona, logs its errors.
  await startupStep('gifBackfill.startIfNeeded', () => gifBackfill.startIfNeeded(servedGuildId()));

  // Affinity decay: once now (catches up the days the process was down), then hourly (above).
  await startupStep('affinity decay', sweepAffinityDecay, { wait: true });

  // What the archive refused before this start: drained once now (it also counts the queue for
  // the stall check), then on the timer (above). Fire-and-forget.
  await startupStep('archive.drain', () => (store.state.data.paused ? null : store.drainArchive(servedGuildId())));

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
