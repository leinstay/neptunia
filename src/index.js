// Entry point: wires config, hot reload, the persistent store, the
// OpenRouter client, discord.js and the turn/spontaneous/memory subsystems
// together, and owns the process lifecycle (startup checks, timers, graceful
// shutdown). No decision logic lives here — everything is imported from
// src/behavior, src/memory, src/llm and the Discord interface (interfaces/discord/, through
// src/interface/discord.js).

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT_DIR, env, loadDotEnv, need } from './config.js';
import { resolvePaths } from './paths.js';
import { createHot } from './hot.js';
import { log, onLog } from './log.js';
import { createMetrics, metricsTap } from './ops/metrics.js';
import { createUsage, usageTap } from './ops/usage.js';
import { createMemoryDb } from './memory/db/service.js';
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
  memberView,
  startYoutubeCheck,
} from './memory/index.js';
import { mirrorDryRun } from './behavior/limits.js';
import { DAY_MS, utcDay } from './time.js';
import { createCalibrator } from './llm/tokens.js';
import { createLlm, roleApiKey } from './llm/openrouter.js';
import { createEmbedder } from './llm/embed.js';
import { createImageGen } from './llm/images.js';
import { createSpeech } from './speech/index.js';
import { ffmpegAvailable } from './speech/convert.js';
import { createTurnRunner } from './behavior/turn.js';
import { createActivity } from './behavior/activity.js';
import { createMissed } from './behavior/missed.js';
import { createOfflineCatchUp } from './behavior/catch-up.js';
import { hasRequiredLabels } from './behavior/prompt.js';
import { createChannelRouter } from './behavior/route-channel.js';
import { createRecall } from './behavior/recall-run.js';
import {
  applyReactionEvent,
  connectionEvent,
  createAudienceWarmer,
  createDiscordClient,
  createDiscordInterface,
  createEmojiIndex,
  Events,
  createInteractionHandler,
  createRawRegistry,
  createReactorStore,
  normalizeOptions,
  presenceEvent,
  presenceSnapshotEvent,
  reactionEvent,
  reactionClearAllEvent,
  reactionClearEmojiEvent,
  reactionStoreEventOf,
  registerCommands,
  resolveGuild,
  toEvent,
  voiceEvent,
} from './interface/discord.js';
import { createSpontaneous } from './behavior/spontaneous.js';
import { createInnerLife } from './behavior/inner.js';
import { createDiary } from './behavior/diary.js';
import { createImageFetcher } from './media/fetch-image.js';
import { createVideoFetcher } from './media/fetch-video.js';
import { createPageFetcher } from './web/fetch-page.js';
import { createBraveSearch } from './web/brave.js';
import { createExaSearch } from './web/exa.js';
import { createLookup } from './web/lookup.js';
import { createAdmin } from './admin.js';
import { createErrandClient } from './errands/client.js';
import { createTaskStores } from './errands/store.js';
import { createErrandService } from './errands/service.js';
import { channelPlaceId } from './memory/db/ids.js';
import { createTaskTurns, taskCompletedEvent } from './errands/turns.js';
import { createEventDoor } from './interface/door.js';
import { openAdapterLink } from './interface/link.ts';
import { listenSocket } from './interface/socket.ts';
import { connectSocket } from './protocol/wire.ts';
import { serveAdapter } from './protocol/serve.ts';
import { createAroundStore } from './behavior/around-store.ts';
import { defaultRawOf } from './behavior/raw-handles.ts';
import { createIntentionStores } from './intentions/store.js';
import { createIntentionService } from './intentions/service.js';
import { skillRegistry, missingDefinitions } from './skills/registry.js';
import { grantedSkillNames } from './skills/discovery.js';
import { PROFILES as AGENT_PROFILES } from './agent-runner/profiles.js';
import { createTagHistory, deprecatedModelKeys } from './behavior/mention.js';
import { createMessageHandler } from './behavior/pipeline.js';
import { isValidCommandName } from './ops/catalog.js';

const REQUIRED_PROMPTS = ['system-prompt', 'character-card', 'format', 'reply', 'interject', 'initiate'];

/** Print a one-line, secret-free error and terminate with a non-zero exit code. */
function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Like need(), but turns a missing variable into a friendly startup failure. */
function needOrFail(key) {
  try {
    return need(key);
  } catch {
    return fail(
      `index: missing required environment variable ${key} — copy .env.example to .env and fill in the real values.`
    );
  }
}

// The three directories, resolved once (src/paths.js): the checkout, the private layer
// (NEPTUNIA_PRIVATE_DIR: config.local.json, prompts.local/, .env) and the data directory
// (NEPTUNIA_DATA_DIR). The two variables come from the process environment (the unit file), never
// from .env, whose own place depends on them. Logged once, paths only.
const paths = resolvePaths({ rootDir: ROOT_DIR });
log.info('index: paths', { rootDir: paths.rootDir, privateDir: paths.privateDir, dataDir: paths.dataDir });
if (!fs.existsSync(paths.privateDir))
  fail(`index: the private directory ${paths.privateDir} does not exist (NEPTUNIA_PRIVATE_DIR).`);

loadDotEnv(paths.privateDir);
const discordToken = needOrFail('DISCORD_TOKEN');
const openrouterKey = needOrFail('OPENROUTER_CORE_KEY');
// Optional: without it a YouTube duration comes from the watch page only.
const youtubeApiKey = env.YOUTUBE_API_KEY || null;
// Optional: without it the `brave` search engine never runs (the web lookup still reads links). Never logged.
const braveApiKey = env.BRAVE_SEARCH_API_KEY || null;
// Optional: the `exa` engine runs keyless; with a key it is sent as a bearer header. Never logged.
const exaApiKey = env.EXA_API_KEY || null;
// Optional: the simulator key, used only for one read-only GET of its limit on the owner's status
// card, never for a model request. Never logged.
const simApiKey = env.OPENROUTER_SIM_KEY || null;
// Optional: the management key, used only for the read-only activity GETs of the owner's status
// card (each key's spend over the last 30 days), never for a model request. Never logged.
const managementApiKey = env.OPENROUTER_MANAGEMENT_KEY || null;

const hot = createHot({ rootDir: paths.rootDir, privateDir: paths.privateDir }).watch();

const missingPrompts = REQUIRED_PROMPTS.filter((name) => typeof hot.prompts[name] !== 'string' || !hot.prompts[name]);
if (!hasRequiredLabels(hot.prompts.labels)) missingPrompts.push('labels');

if (missingPrompts.length > 0) {
  const files = missingPrompts.map((name) => (name === 'labels' ? 'prompts/labels.json' : `prompts/${name}.md`));
  fail(
    `index: missing required prompt file(s): ${files.join(', ')} ` +
      '(prompts.local/ may override any of these, file by file).'
  );
}

// The persona's skills against the operations and the command tree registered by the imports
// above: a skill on an unknown operation, or an operation no command runs, is a programming error
// and stops the start here.
try {
  skillRegistry();
} catch (err) {
  fail(`index: invalid skill registry: ${err.message}`);
}
// A definition whose operation is not registered is left out of the registry: say so, loudly, at
// the start (never silently); the bot goes on.
{
  const missing = missingDefinitions();
  if (missing.length > 0) log.error('skills: definitions without a registered operation', { missing });
}

if (!isValidCommandName(hot.config.bot.commandName)) {
  fail(
    `index: invalid bot.commandName "${hot.config.bot.commandName}" — must match ^[a-z0-9_-]{1,32}$ ` +
      '(config.local.json).'
  );
}

// The old per-feature model keys are never read (classifier.* replaced them);
// say so once, key names only, never a value.
for (const { key, use } of deprecatedModelKeys(hot.config))
  log.warn('index: deprecated model key ignored', { key, use });

const dataDir = paths.dataDir;
// The speed figures of /nep status (src/ops/metrics.js): the durations the log lines carry,
// kept for 24 h in data/metrics.json (loaded now, written every minute and on shutdown).
const metrics = createMetrics({ dataDir, log });
onLog(metricsTap(metrics));
// The costs field of /nep status (src/ops/usage.js): today's requests per role from the `llm: usage`
// lines, kept for today and yesterday in data/usage.json (loaded now, written every minute and on shutdown).
const usage = createUsage({ dataDir, log });
onLog(usageTap(usage));
// The memory database (src/memory/db/service.js): the memory. Created before the memory modules, which read and write
// it (src/memory/db/readers/, src/memory/db/unit-write.js); opened at the start (the first tick, awaited below).
// diaryMediaDeps is read at each tick: the interface port and the image fetcher exist by then (defined below).
// `embed` and `selfName` (the re-embed job, recall.db.reembed) are the embedding client and her name, defined below.
// Her memory session is the memory writer: it runs on the chat client (role `memory`, its own key from `env`), and a
// run that fails is told to her as a `memoryFailed` fact (inner, defined below).
const memoryDb = createMemoryDb({
  hot,
  dataDir,
  log,
  diaryMediaDeps: () => ({ port: iface, imageFetcher }),
  embed: (texts, options) => embedder.embed(texts, options),
  selfName: () => getSelfName(getGuildId()),
  sessionLlm: () => llm,
  sessionEnv: () => env,
  onSessionFailure: (failure) => tellSessionFailure(failure),
});
// The record (src/memory/record.js): every observed message, the persona's own lines and her
// feelings, written while features.record is exactly true (read at each write).
// A snapshot holds the record's appends with the journal's writer lock (journal.withWriterLock).
const recordWriter = createRecord({ dataDir, log, writerGate: () => journal.waitUnlocked(), memoryDb });
// The meaning index (src/memory/vectors.js): its writers wait on the same writer lock.
const vectors = createVectors({ dataDir, log, writerGate: () => journal.waitUnlocked(), memoryDb });
// The live embedding queue (src/memory/embedder.js), set once the embedding client exists below.
let embedQueue = null;
// The one place the meaning index hears of new record lines: every writer (edits and deletions,
// the persona's own lines, feelings) appends through this record,
// and once an append took lines they are queued for embedding (the queue keeps what it wants
// and is off unless features.meaningSearch and features.embedIndex are both exactly true).
const record = {
  ...recordWriter,
  async append(guildId, lines, opts) {
    const result = await recordWriter.append(guildId, lines, opts);
    if (embedQueue && result?.written > 0) {
      try {
        embedQueue.enqueue(guildId, lines, opts ?? {});
      } catch (err) {
        log.warn('index: embed enqueue failed', { guildId: String(guildId), code: err?.code ?? null });
      }
    }
    return result;
  },
};
// The archive (src/memory/archive.js): every memory item a write drops is copied here before any
// hot list loses it, while features.archive is exactly true (read at each write). Its own append
// store for the pending queue (an operational file), so its counts speak for the archive alone.
const archiveAppendStore = createAppendStore({
  fsyncMs: hot.config.appendStore?.fsyncMs ?? 500,
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
  recordOn: () => hot.config.features?.record === true,
  archive,
  archiveOn: () => hot.config.features?.archive === true,
  memoryDb,
});

const calibrator = createCalibrator(store.state.data.calibration);
// `env` (the .env loaded once above): the keys `llm.keyByRole` names per role, looked up per request.
const llm = createLlm({ apiKey: openrouterKey, env, getConfig: () => hot.config, calibrator, state: store.state });
// Embeddings (role embedding) on the same daily request count as the chat client.
const embedder = createEmbedder({ apiKey: openrouterKey, env, state: store.state });
// The meaning index kept current: record lines queued above, flushed on the tick below.
embedQueue = createEmbedQueue({
  hot,
  vectors,
  embed: embedder.embed,
  record: recordWriter,
  log,
  nameOf: (guildId, userId) =>
    store.getUser(guildId, userId)?.names?.[0] ??
    client.guilds.cache.get(guildId)?.members?.cache?.get(userId)?.displayName ??
    null,
  selfName: (guildId) => getSelfName(guildId),
  // No catch-up pass while paused (the owner may be editing data/); /nep resume runs one.
  paused: () => store.state.data.paused === true,
  memoryDb,
});
// The persona's drawings (features.imageGeneration): its own daily rails, counted on the same state.
// Pictures are paid with the drawing role's key (`llm.keyByRole.drawing`, the agents' key), read at
// each request; the main key when the role names none.
const images = createImageGen({
  apiKey: () => roleApiKey(hot.config, env, 'drawing', openrouterKey),
  getConfig: () => hot.config,
  state: store.state,
});
// The persona's voice messages (features.speech): the preparation pass on the analyzer, the synthesis on the
// voice role's key and model, the conversion with the system ffmpeg. Without ffmpeg there is no `speech` at
// all (the skill answers `speech-not-configured`), reported once.
const speechReady = ffmpegAvailable();
if (!speechReady) log.warn('speech: ffmpeg not found, voice messages are off', {});
const speech = speechReady
  ? createSpeech({
      getConfig: () => hot.config,
      getPrompts: () => hot.prompts,
      env,
      apiKey: openrouterKey,
      llm,
      state: store.state,
    })
  : null;

// Direct messages are received regardless of features.privateMessages (the
// switch is hot, intents are not); a DM channel arrives uncached, hence the
// Channel partial. GuildExpressions keeps the guild's custom emoji cache
// current (emoji created, renamed, deleted) for the emoji index below.
// GuildVoiceStates feeds the voice channels of `<people_now>`. The two PRIVILEGED
// intents (discord.intents.presences, discord.intents.members) are requested only when the
// config says so, read ONCE here because intents are fixed at login: asking for one that the
// Developer Portal has not enabled makes the login fail, so both default to false.
// GuildMessageReactions (not privileged) feeds the reactor store below; a reaction on a message,
// by a user or of a message the client has not cached arrives only with the Message, Reaction and
// User partials. The message handlers take partials already: an edit or a deletion of an
// uncached message comes partial (no author, no content) and is recorded or skipped as such.
const intentSettings = hot.config.discord?.intents ?? {};
const presencesIntent = intentSettings.presences === true;
const membersIntent = intentSettings.members === true;
const client = createDiscordClient({ presences: presencesIntent, members: membersIntent });

// This instance serves exactly one Discord server. `instance.guildId` is set
// once, right after ClientReady resolves it (see below), and every component
// that needs it reads it through `getGuildId` instead of caching it, so a
// switch to a different guild always requires a restart, never a silent swap.
const instance = { guildId: null };
const getGuildId = () => instance.guildId;

// The audience rail tells a bot's member overwrite by the member cache, which
// the client fills only with members seen since startup (no member intent):
// the warmer fetches every member named by an overwrite (interfaces/discord/audience-warm.js).
const audienceWarmer = createAudienceWarmer({
  getGuild: () => (instance.guildId ? (client.guilds.cache.get(instance.guildId) ?? null) : null),
});

// Shared so a picture attached on consecutive turns, or described more than
// once, is only ever downloaded once within the fetcher's LRU window.
const imageFetcher = createImageFetcher();
const videoFetcher = createVideoFetcher();
// state: the daily video counter lives next to the LLM client's daily counter.
const describer = createDescriber({ hot, store, llm, imageFetcher, videoFetcher, state: store.state, youtubeApiKey });
// What each profiled member's avatar looks like (features.avatars, off by default): a throttled
// background queue on the vision role, its daily counter next to the LLM client's. Members are
// read from the cache first, else one REST fetch each; a member who left reads as gone.
const avatars = createAvatarQueue({
  hot,
  store,
  llm,
  imageFetcher,
  state: store.state,
  getGuildId,
  selfId: () => client.user?.id ?? null,
  paused: () => store.state.data.paused === true,
  resolveMember: async (guildId, userId) => {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return null;
    return memberView(await guild.members.fetch(userId).catch(() => null));
  },
});
// The web lookup (features.webLookup, off by default): link reader + search on a question.
// state: the daily web counter lives next to the LLM client's daily counter.
const lookup = createLookup({
  hot,
  store,
  llm,
  state: store.state,
  pageFetcher: createPageFetcher(),
  // web.search.engine picks one of these; web.search.fallback orders the others.
  searches: { brave: createBraveSearch(), exa: createExaSearch() },
  keys: { brave: braveApiKey, exa: exaApiKey },
});
// The live glance at the voice channels and the scene's statuses (features.around): a snapshot
// in process memory, fed by the interface's voice, presence and connection events through the door
// below, never written anywhere.
const around = createAroundStore({ presences: presencesIntent });
// Who reacted to the persona's own messages (features.reactionNames): in process memory only,
// at most context.reactions.maxMessages of her messages (read at each insertion), fed by the
// reaction events below and by the turn's history fetch.
const reactors = createReactorStore({ maxMessages: () => hot.config.context?.reactions?.maxMessages ?? 500 });
// The served guild's custom emoji (features.customEmoji): a live view over discord.js's own cache.
const emoji = createEmojiIndex(client, getGuildId);
// The persona's display name in a guild: the one name every request uses.
const getSelfName = (guildId) =>
  client.guilds.cache.get(guildId)?.members.me?.displayName ?? client.user?.username ?? 'bot';
// The Discord interface (interfaces/discord/) builds the adapter of the interface port and the capabilities
// object: what the core asks Discord for (permissions, history, pulled channels, searches), passed below
// as `discord` to every module that needs it -- nothing in the core but this file imports the interface.
const discordInterface = createDiscordInterface({ client });
const discord = discordInterface.capabilities;

// The link between the core and the Discord side (docs/interfaces.md). Both still run in this process:
// the core listens on a Unix socket under the data directory, the Discord side connects with a token made
// at boot, says hello and serves the Discord adapter. Every inbound event travels as an envelope to the
// core's door and every effect of the persona travels back as an action. The socket folder is created
// at mode 0700 and the file at 0600 (src/interface/socket.ts).
const LINK_SOCKET = path.join(dataDir, 'run', 'core.sock');
// Ten files of 10 MiB in base64 (a third larger) and the rest of an envelope fit in one frame.
const LINK_MAX_FRAME_BYTES = 150 * 1024 * 1024;
const linkToken = randomBytes(32).toString('hex');
// The door is created below, once its handlers exist; an envelope that arrives sooner waits for it.
/** @type {PromiseWithResolvers<{ receive(value: unknown): Promise<import('./protocol/wire.ts').Envelope> }>} */
const doorReady = Promise.withResolvers();
const linkDoor = { receive: async (/** @type {unknown} */ value) => (await doorReady.promise).receive(value) };
/** @type {PromiseWithResolvers<ReturnType<typeof openAdapterLink>>} */
const linkOpened = Promise.withResolvers();
const linkServer = await listenSocket({
  path: LINK_SOCKET,
  maxFrameBytes: LINK_MAX_FRAME_BYTES,
  log,
  onConnection: (transport) => {
    // Only the one connection of this process is served; the file is 0600 and the token is needed anyway.
    const link = openAdapterLink({ transport, door: linkDoor, token: linkToken, log });
    linkOpened.resolve(link);
  },
});
const discordPort = discordInterface.port;
const linkServed = serveAdapter({
  transport: await connectSocket({ path: LINK_SOCKET, maxFrameBytes: LINK_MAX_FRAME_BYTES }),
  hello: { iface: discordPort.iface, capabilities: discordPort.capabilities(), resume: null },
  token: linkToken,
  adapter: discordPort,
  log,
});
const coreLink = await linkOpened.promise;
// Awaited before anything below is built: every module that takes the port gets the link's adapter, whose
// `iface` and capabilities exist once hello has arrived. Nothing sends before this line.
await coreLink.hello.catch((err) => fail(`index: the link to the interface failed: ${String(err)}`));
// The persona's interface (src/interface/port.js): every effect of her replies goes through it,
// after the skill gateway (src/skills/gateway.js) let the call pass.
const iface = coreLink.adapter;
// The discord.js messages behind the message events stay on the Discord side, under the event id.
const rawHandles = createRawRegistry({ capacity: 2000 });
// The route classifier (features.channelRoute): picks a channel the conversation is about for <channel_view>.
const routeChannels = createChannelRouter({ hot, store, llm, discord });
// The search of the server's own history beside the web search (features.recall): the lookup's server part.
// It reads the archive and the record too (read only), and with features.meaningSearch the meaning
// index (one embedding of the question per run).
const recall = createRecall({
  hot,
  store,
  llm,
  discord,
  describer,
  archive,
  record,
  vectors,
  embed: embedder.embed,
  memoryDb,
});
// When each person last wrote in each channel (fed by the message handler): a turn answering
// someone waits until they stop writing (pace.settleMs).
const activity = createActivity();
// The persona's errands (agents.*): a task she or a member asks for goes to its agent runner over
// its socket in the background (src/errands/); the tasks live in data/guilds/<id>/tasks.json.
const errandClient = createErrandClient({ hot, log });
const taskStores = createTaskStores({ config: () => hot.config, journal, log, memoryDb });
// An errand's end opens her own turn where it was asked (the task turns, created below the runner).
// An errand's end is a `task.completed` event through the event door (`door`, created below with
// the gateway's handlers); the door's handler (src/errands/turns.js#onEvent) first moves the
// intentions waiting on it back to pending, then opens her turn, which shows them with the outcome.
// A task's `context.recent`: the channel's newest lines from the memory database (her own under her name), oldest first.
function recentChannelLines(guildId, channelId, count) {
  const db = memoryDb.database();
  if (!db || !channelId || !(count > 0)) return [];
  const rows = db
    .prepare(
      `SELECT s.kind, s.text, a.names FROM sources s LEFT JOIN accounts a ON a.id = s.author_account
      WHERE s.place_id = ? AND s.kind IN ('seen', 'said') AND s.retired_at IS NULL AND length(COALESCE(s.text, '')) > 0 ORDER BY s.occurred_at DESC, s.rowid DESC LIMIT ?`
    )
    .all(channelPlaceId(String(channelId)), count);
  const lines = [];
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
  onFinished: (task, guildId) => door.submit(taskCompletedEvent(task, guildId)),
});
// The persona's intentions (features.intentions): data/guilds/<id>/intentions.json, her own
// `intent.*` calls, the analyzer's candidates from her lines, and the waits on her errands.
// Both stores send their writes to the database; `flush` is their retry and shutdown step.
const intentionStores = createIntentionStores({ log, memoryDb });
const intentions = createIntentionService({ stores: intentionStores, hot, tasks: errands, journal, getGuildId, log });
const turns = createTurnRunner({
  hot,
  store,
  // The memory rows a turn's request carried go to the database (memoryDb.turnReads).
  memoryReads: (args) => memoryDb.recordTurnReads(args),
  // One execution context per turn for its memory reads (recorded while the database is open).
  memoryContext: (spec) => memoryDb.issueContext(spec),
  llm,
  calibrator,
  client,
  discord,
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
  routeChannels,
  activity,
  journal,
  record,
  port: iface,
  skills: skillRegistry(),
  // Her skills run by operation name, the requester's rights checked again
  // (src/admin.js#runSkillOp); read at call time, the admin being created below.
  runOp: (op, args, context) => admin.runSkillOp(op, args, context),
  // Her own messages, drawings and diary run on her grant alone (src/ops/effects.js#SELF_OWNED_OPS).
  runOwnOp: (op, args, context) => admin.runOwnSkillOp(op, args, context),
  // An inner turn's calls (her own initiative, nobody asked) run on her grant alone too.
  runInitiativeOp: (op, args, context) => admin.runInitiativeSkillOp(op, args, context),
  // `<tasks>`: her open and newly finished errands; an errand's caps are its skill's budget.
  errands,
  // `<intentions>`: her open intentions and the candidates from her lines (features.intentions).
  intentions,
  // `<places>` on an addressed turn (context.places): the inner life's places view, read at call time.
  places: (guildId, options) => inner.places(guildId, options),
});
const spontaneous = createSpontaneous({ hot, store, client, discord, turns, getGuildId });
// The persona's diary (diary.channelId): its own posts on a day plan, ticked below.
// The diary's posts are rows of the memory database already: no backfill from the channel.
const diary = createDiary({ hot, store, client, discord, turns, getGuildId });
// The code-only memory of the live message path (src/memory/update.js): counters, GIF library, emoji, names.
const memory = createMemoryUpdater({ hot, store });
// The turn an errand's end opens, through the one attention and a cooldown per conversation.
const taskTurns = createTaskTurns({ hot, client, discord, turns, errands, intentions, getGuildId, log });
/**
 * The places the Discord interface publishes for the guild, as the core takes them: opaque
 * addresses with a name and whether the persona can write there (the channel directory a turn
 * shows her, interfaces/discord/collect.js#channelDirectoryOf, and its send check). Nothing of
 * discord.js reaches the core: it reads this list alone.
 */
function placesOf(guildId) {
  const guild = client.guilds.cache.get(String(guildId));
  if (!guild) return [];
  return discord.channelDirectoryOf(guild, hot.config.bot).map((entry) => {
    const channel = guild.channels.cache.get(entry.id);
    let writable = null;
    try {
      writable = channel ? discord.canSend(channel) : null;
    } catch {
      writable = null;
    }
    return { id: entry.id, name: entry.name, writable };
  });
}
// The persona's inner life (features.innerLife, off by default; docs/inner-life.md): a scheduler
// that lists what is due for her (her intentions, waits past their deadline, one daily review, the lines of the places she attends),
// hands each as an `inner.wake` event through the door, and runs an inner turn when the one
// attention is free and no cap refuses. Its own timer; a no-op with the switch off.
// Resolved once the journal's start-up reconciliation is done (or failed): an inner turn that the last run left in flight is
// resolved from the journal only after it (src/behavior/inner.js, `ready`).
let journalReconciled = () => {};
const journalReconciledPromise = new Promise((resolve) => {
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
  nameOf: (guildId, memberId) => store.getUser(guildId, memberId)?.names?.[0] ?? null,
  journal,
  client,
  discord,
  store,
  getGuildId,
  // People's turns first: an inner turn waits while a direct ping is queued.
  peopleWaiting: () => onMessage.pendingCount() > 0,
  submit: (event) => door.submit(event),
  // Each inner turn as a wake run in the memory database (memoryDb.wakeRuns).
  memoryDb,
  // The heartbeat's facts (src/behavior/heartbeat-view.js): her errands, what she can do. No presence or
  // do-not-disturb state (owner, 2026-10-20: she must not read those markers).
  heartbeat: {
    tasks: (guildId) => taskStores.get(guildId).recent(100),
    skills: () => grantedSkillNames({ config: hot.config, selfId: client.user?.id ?? null, registry: skillRegistry() }),
    agents: () => Object.keys(AGENT_PROFILES),
    selfId: () => client.user?.id ?? null,
    focusPeople: () => (hot.config.innerLife?.heartbeat?.focusSource === 'db' ? memoryDb.focusPeople() : null),
  },
  log,
});
// The drops, holds and failures kept for her next request in a conversation live in the inner life's state.
turns.setFactsSource(inner.facts);
/**
 * A memory session run that failed (src/memory/db/service.js, once per failing scope),
 * told the same way: a `memoryFailed` fact with the code and the lines waiting; a private conversation's only in that
 * private chat (its DM channel, when the client knows it). Never throws.
 */
function tellSessionFailure({ scopeKind, partner, code, lines, at }) {
  try {
    if (inner.facts?.enabled?.() !== true) return;
    const guildId = getGuildId();
    if (!guildId) return;
    const privateChat = scopeKind === 'dm';
    const userId = privateChat ? String(partner ?? '').replace(/^person:[^:]+:/, '') : null;
    const channelId = privateChat ? (client.users?.cache?.get(userId)?.dmChannel?.id ?? null) : null;
    inner.facts.add(guildId, { kind: 'memoryFailed', code, waiting: lines, channelId, privateChat, at });
  } catch (err) {
    log.warn('index: memory session failure not told', { code: err?.code ?? null });
  }
}
const tagHistory = createTagHistory();
// Messages that may have been left without an answer (src/behavior/missed.js): facts from the
// address gate, the pending queue and every turn's end, a delayed sweep per channel, and a
// recovery turn only with features.missedRecovery on (shadow mode by default).
const missed = createMissed({
  hot,
  store,
  journal,
  llm,
  turns,
  client,
  getGuildId,
  getSelfName,
  dataDir,
  fetchHistory: discord.fetchHistory,
  canSend: discord.canSend,
});
turns.setOnTurnEnd((end) => missed.onTurnEnd(end));
// The custom emoji ranking read from history (Discord API only, no LLM): once at startup, again on /nep emoji rescan.
const emojiBackfill = createEmojiBackfill({ hot, store, client, discord, log });
// The GIF library read from history (Discord API; the describer captions the top ones): once at
// startup, again on /nep gifs rescan.
const gifBackfill = createGifBackfill({ hot, store, client, discord, describer, log });
// The GIF library re-described by watching (src/memory/gif-recache.js): only on /nep gifs recache;
// and the pictures an older model described, found through the record: only on /nep media
// kind:pictures action:recache.
const gifRecache = createGifRecache({ hot, store, client, discord, describer, record, log });

const onMessage = createMessageHandler({
  hot,
  store,
  client,
  // The Discord functions the pipeline calls (src/behavior/pipeline.js imports none of them).
  discord,
  turns,
  spontaneous,
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
  memoryDb,
  // The discord.js messages of an event come from the Discord side's registry; an event built in
  // process still carries its own.
  rawOf: (event) => rawHandles.rawOf(event) ?? defaultRawOf(event),
  // The limit and pause notices go out through the interface like any other effect.
  port: iface,
});

// The messages posted while the bot was down (src/behavior/catch-up.js): once at start, fetched
// over REST after the last message seen per channel and handed to the handler's catch-up path.
const offlineCatchUp = createOfflineCatchUp({
  hot,
  store,
  journal,
  selfId: () => client.user?.id ?? null,
  channelInfo: (channelId) => {
    const channel = client.channels.cache.get(channelId);
    if (!channel || channel.guild?.id !== instance.guildId || typeof channel.messages?.fetch !== 'function')
      return { available: false, latestAt: null };
    return { available: true, latestAt: channel.lastMessageId ? discord.snowflakeTime(channel.lastMessageId) : null };
  },
  fetchRecent: async (channelId, limit) => {
    const channel = client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId));
    return [...(await channel.messages.fetch({ limit })).values()];
  },
  deliver: async (message, options) => {
    const event = inbound('message.received', () => toEvent(message, selfIdNow(), normalizeOptions(hot.config)));
    return event ? onMessage.catchUp(event, options) : 'ignored';
  },
});

// One attention (mention.oneAtATime): once a turn frees its channel, answer
// the oldest pending direct ping it may have collected while busy elsewhere.
turns.setOnIdle(() => onMessage.drainPending());

const admin = createAdmin({
  hot,
  store,
  client,
  // The operations' `env.discord`: permission checks, the diary backfill, the private purge.
  discord,
  // /nep message and /nep draw channel: post through the persona's interface, as her.
  port: iface,
  // /nep task: the persona's errands.
  errands,
  // /nep task intent: her intentions.
  intentions,
  // /nep task inner: the inner life's kill switch and status.
  inner,
  spontaneous,
  calibrator,
  getGuildId,
  turns,
  // /nep pause: clears the pending-ping queue on pause.
  pending: { clear: () => onMessage.clearPending() },
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
  // /nep status: the simulator key's limit line (one GET, nothing else).
  simKey: simApiKey,
  // /nep status: each key's activity for its last 7 and 30 days (GETs only, nothing else).
  managementKey: managementApiKey,
  // /nep memory snapshot: the data directory it copies.
  dataDir,
});
const onInteraction = createInteractionHandler({ hot, admin, getGuildId });

// Once at startup, fire-and-forget: tell the operator whether YouTube links can
// be watched here (only when video vision is on). Logs the status, never the URL or key.
startYoutubeCheck({ hot, checkYoutube: describer.checkYoutube });

const timers = [];

/** Run `fn` on an interval; a rejected promise is logged, never left unhandled. */
function every(ms, fn, label) {
  const id = setInterval(() => {
    Promise.resolve()
      .then(fn)
      .catch((err) => log.error(`index: ${label} failed`, { error: err }));
  }, ms);
  id.unref?.();
  timers.push(id);
}

/**
 * relationships.decayPerDay: every stored affinity (public and private) drifts toward zero, one
 * step per whole day (src/memory/store.js#decayAffinities). Cheap to run hourly: it only applies
 * full days. Skipped while paused (the owner may be editing data/).
 */
/** How often the affinity decay sweeps. */
const AFFINITY_SWEEP_MS = 3_600_000;

function sweepAffinityDecay() {
  const guildId = instance.guildId;
  const config = hot.config;
  if (!guildId || config.features?.relationships === false) return;
  if (store.state.data.paused) return;
  // Decay counts only time she was running: the sweep runs hourly, so a gap of more than two sweeps since the last one
  // (kept in the state file) is downtime, and all of it but one sweep's hour is skipped.
  const now = Date.now();
  const last = Date.parse(store.state.data.affinityDecaySweptAt ?? '');
  const gap = Number.isFinite(last) ? now - last : 0;
  const skipMs = gap > 2 * AFFINITY_SWEEP_MS ? gap - AFFINITY_SWEEP_MS : 0;
  const counts = store.decayAffinities(guildId, now, { ...(config.relationships ?? {}), skipMs });
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
let archiveDrainTimer = null;
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
 * @param {string} step
 * @param {() => unknown} fn
 * @param {{ wait?: boolean }} [options]
 */
async function startupStep(step, fn, { wait = false } = {}) {
  const failed = (err) => log.error('index: startup step failed', { step, error: err });
  try {
    const done = Promise.resolve(fn()).catch(failed);
    if (wait) await done;
  } catch (err) {
    failed(err);
  }
}

/**
 * The persona's last `n` messages of `channelId` (the bot's own among the channel's last `n`),
 * as the journal's reconciliation reads them: id, raw content, the message replied to, the time.
 */
async function fetchOwnMessages(channelId, n) {
  const channel = await client.channels.fetch(channelId);
  const messages = await channel.messages.fetch({ limit: n });
  return [...messages.values()]
    .filter((message) => message.author?.id === client.user.id)
    .map((message) => ({
      id: message.id,
      content: message.content,
      replyToId: message.reference?.messageId ?? null,
      createdAt: message.createdTimestamp,
    }));
}

/**
 * The journal's operations left open by the last run (features.journal, read now), yesterday's
 * and today's: a post is looked for among the persona's own messages, everything else is marked
 * unknown; nothing is sent again. Only operations started before this start are touched.
 */
async function reconcileJournal(guildId) {
  if (hot.config.features?.journal !== true) return;
  const startedAt = Date.now();
  const days = [utcDay(startedAt - DAY_MS), utcDay(startedAt)];
  const counts = await journal.reconcile(guildId, { days, before: startedAt, fetchOwnMessages });
  log.info('journal: reconciled', { guildId, succeeded: counts.succeeded, unknown: counts.unknown });
}

/**
 * Which message started the turn that posted each of the persona's messages of yesterday and
 * today (the journal's turn records), handed to the turn runner so her lines posted before this
 * start keep naming their trigger in the transcripts. Read whatever the switches: the runner
 * renders the links only with features.triggerMarkers on, and a journal never written gives none.
 */
async function seedTriggerLinks(guildId) {
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
async function seedCallMarks(guildId) {
  const at = Date.now();
  const marks = await journal.callMarks(guildId, { days: [utcDay(at - DAY_MS), utcDay(at)] });
  turns.seedCallMarks(marks);
  log.info('journal: call marks read', { guildId, calls: marks.calls.length });
}

/** Whether the journal is written now (features.journal exactly true, read now). */
const journalOn = () => hot.config.features?.journal === true;

/** Delete the request dumps older than journal.keepRequests days (features.journal, read now). */
async function pruneJournalRequests(guildId) {
  if (!journalOn()) return;
  const { removed } = await journal.pruneRequests(guildId);
  log.info('journal: pruned', { guildId, removed });
}

/**
 * The journal at start, with the journal on: a `.running` marker left by a run that never stopped
 * cleanly becomes an `unclean-stop` record, this run's marker is written and the `start` record follows.
 */
async function startJournal(guildId) {
  if (!journalOn()) return;
  const { unclean } = await journal.markRunning(guildId);
  if (unclean) log.warn('journal: unclean stop noted', { guildId });
  await journal.system(guildId, { event: 'start', by: 'service' });
}

// A reload that took (config or prompts) is a system record of the served guild.
hot.onReload((what) => {
  if (!instance.guildId || !journalOn()) return;
  journal.system(instance.guildId, { event: 'reload', note: what });
});

let lastCommandName = hot.config.bot.commandName;
let lastAdminCommandsOn = hot.config.features?.adminCommands !== false;

client.once(Events.ClientReady, async () => {
  const guilds = [...client.guilds.cache.values()].map((guild) => ({ id: guild.id, name: guild.name }));
  const resolved = resolveGuild(hot.config.bot.guildId, guilds);
  if (resolved.error) fail(`index: ${resolved.error}`);

  instance.guildId = resolved.guildId;
  seedAround();

  // The periodic work first, before anything below can throw or wait: the
  // flush, the spontaneous and diary ticks, the hourly affinity decay.
  every(30_000, () => store.flush(), 'store.flush');
  every(10_000, () => memoryDb.tick(), 'memoryDb.tick');
  // The intention and task writes that failed go again.
  every(30_000, () => Promise.all([intentionStores.flush(), taskStores.flush()]), 'module stores flush');
  // TODO(.agents spec 2026-10-17-protocol-package, "Code"): the scheduler's clock becomes a
  // `scheduler.tick` event through the same dispatcher as an errand's end (see the errands above).
  every(30_000, () => spontaneous.tick(), 'spontaneous.tick');
  every(30_000, () => diary.tick(), 'diary.tick');
  // The inner life's tick, every innerLife.tickSeconds (read before each wait).
  inner.startTimer();
  every(AFFINITY_SWEEP_MS, sweepAffinityDecay, 'affinity decay');
  // The embedding queue flushes every embed.flushSeconds (read at each tick; a full batch sooner);
  // the same tick runs its catch-up pass when the switches turn on and every embed.catchUpEveryMinutes.
  every(30_000, () => embedQueue.tick(instance.guildId), 'embed.tick');
  // The avatar queue: its first tick scans the profiled members, then once a day; between
  // requests it waits avatars.intervalMs (read at each tick). A no-op with the switch off.
  every(5_000, () => avatars.tick(), 'avatars.tick');
  // The speed samples written to data/metrics.json (at most once a minute; nothing new, no write).
  every(60_000, () => metrics.save(), 'metrics.save');
  // Today's per-role usage written to data/usage.json (at most once a minute; nothing new, no write).
  every(60_000, () => usage.save(), 'usage.save');
  scheduleArchiveDrain();

  if (!hot.config.bot.guildId) {
    log.info('index: bot.guildId is not set, using the only guild the bot is in — pin it in config.local.json', {
      guildId: instance.guildId,
    });
  }

  log.info('index: ready', { guildId: instance.guildId, tag: client.user.tag });

  // /nep pause: a pause persisted before this restart comes back
  // paused -- every spontaneous tick keeps no-op'ing until /nep resume.
  if (store.state.data.paused) {
    log.info('index: starting up paused, run /nep resume when data/ is ready', {
      pausedAt: store.state.data.pausedAt ?? null,
    });
  }

  // The database is the memory: opened first (its pending writes of the last shutdown replayed) and awaited, before
  // anything below reads it.
  await startupStep('memoryDb.open', () => memoryDb.tick(), { wait: true });

  // The journal's start: an unclean stop, the start record. Awaited, before the reconciliation below.
  await startupStep('journal.start', () => startJournal(instance.guildId), { wait: true });

  // The links of the persona's recent lines to the messages that started their turns, rebuilt
  // from the journal. Fire-and-forget: a turn before it is done
  // only lacks the older links.
  await startupStep('journal.triggerLinks', () => seedTriggerLinks(instance.guildId));
  // The persona's recent skill calls, the same way.
  await startupStep('journal.callMarks', () => seedCallMarks(instance.guildId));

  // The missed-answer registry: data/guilds/<id>/missed.json, reconciled with the journal of the
  // last hour; a sweep armed where a candidate waits.
  await startupStep('missed.start', () => missed.start(instance.guildId));

  // The errands a restart left open: their runner can no longer answer this process, so they fail
  // (`restarted`) and show in her `<tasks>` block as failed.
  await startupStep('errands.start', () => errands.start(instance.guildId), { wait: true });

  // Her intentions reconciled with the errands as they stand now (those just failed included):
  // a wait whose errand ended, is gone or ran out moves back to pending; the expired ones expire.
  await startupStep('intentions.reconcile', () => intentions.reconcile(instance.guildId), { wait: true });

  // The meaning index caught up with what the record took while the queue was down (the last
  // embed.catchUpHours). Fire-and-forget; nothing while paused or
  // with the switches off.
  await startupStep('embed.catchUp', () => embedQueue.catchUp(instance.guildId));

  // Once per guild after the deploy that keyed access by operation: the stored grants re-expanded
  // under the operation names, a journal record of what each covers now (src/ops/access.js).
  await startupStep('access.migrate', () => admin.migrateAccess(instance.guildId), { wait: true });

  // The side effects a crash or a restart left without an outcome. Fire-and-forget: a turn
  // starting meanwhile is never touched (only earlier operations are), and it never sends.
  await startupStep('journal.reconcile', () => reconcileJournal(instance.guildId).finally(journalReconciled));

  // The messages posted while the bot was down (features.offlineCatchUp): observed, and a call
  // younger than offlineCatchUp.windowMinutes answered as live. Fire-and-forget: REST per
  // channel, never throws; the gateway's own messages are not held up meanwhile.
  await startupStep('offlineCatchUp.run', () => offlineCatchUp.run(instance.guildId));

  // The request dumps older than journal.keepRequests days: once now, then daily.
  await startupStep('journal.prune', () => pruneJournalRequests(instance.guildId));
  every(DAY_MS, () => pruneJournalRequests(instance.guildId), 'journal.prune');

  const guild = client.guilds.cache.get(instance.guildId);
  await startupStep('registerCommands', () => registerCommands(guild, hot.config), { wait: true });

  // The members named by channel overwrites, fetched so the audience rail knows which are bots.
  // Fire-and-forget: REST one by one, never throws.
  await startupStep('audienceWarmer.warm', () => audienceWarmer.warm());

  // The custom emoji ranking from history, once (features.customEmoji on, no emojiBackfill stamp,
  // context.customEmoji.backfillMessages > 0). Fire-and-forget: never blocks the persona, logs its errors.
  await startupStep('emojiBackfill.startIfNeeded', () => emojiBackfill.startIfNeeded(instance.guildId));

  // The GIF library from history, once (features.gifs on, no backfill stamp in gifs.json,
  // gifs.backfillMessages > 0). Fire-and-forget: never blocks the persona, logs its errors.
  await startupStep('gifBackfill.startIfNeeded', () => gifBackfill.startIfNeeded(instance.guildId));

  // Affinity decay: once now (catches up the days the process was down), then hourly (above).
  await startupStep('affinity decay', sweepAffinityDecay, { wait: true });

  // What the archive refused before this start: drained once now (it also counts the queue for
  // the stall check), then on the timer (above). Fire-and-forget.
  await startupStep('archive.drain', () => (store.state.data.paused ? null : store.drainArchive(instance.guildId)));
});

// A running instance never switches servers live: bot.guildId is only read at
// startup. If the owner later points it at a different, non-empty guild while
// the process is up, keep serving the original one and just say so.
hot.on('change', ({ what }) => {
  if (what !== 'config' || !instance.guildId) return;
  const configured = hot.config.bot.guildId;
  if (configured && configured !== instance.guildId) {
    log.warn('index: bot.guildId changed while running, restart required to switch servers', {
      serving: instance.guildId,
      configured,
    });
  }

  // The command tree (and whether it is registered at all) depends on
  // bot.commandName and features.adminCommands — re-push it only when one of
  // those actually changed, never on every unrelated config edit.
  const commandName = hot.config.bot.commandName;
  const adminCommandsOn = hot.config.features?.adminCommands !== false;
  if (commandName !== lastCommandName || adminCommandsOn !== lastAdminCommandsOn) {
    lastCommandName = commandName;
    lastAdminCommandsOn = adminCommandsOn;
    const guild = client.guilds.cache.get(instance.guildId);
    if (guild) {
      registerCommands(guild, hot.config).catch((err) =>
        log.error('index: failed to re-register commands', { error: err })
      );
    }
  }
});

// The gateway's events reach the core as protocol events (src/protocol/, built by
// interfaces/discord/collect.js and around.js) over the link, through the event door
// (src/interface/door.js), the one entry of the mind: it validates each event at the boundary,
// drops a repeated id, and hands the event to the handler of its kind. An event that cannot be built
// or is malformed is dropped with one warn line (its kind and the reason, never its content), so
// nothing behind it ever sees a half-formed one. The core's own events (an errand's end) come
// through the same door, in process.
const door = createEventDoor({
  handlers: {
    'message.received': (event) => {
      if (event.deleted) return onMessage.onMessageDelete(event);
      return event.edit ? onMessage.onMessageUpdate(event) : onMessage(event);
    },
    'reaction.changed': (event) => feedReactors(event),
    'task.completed': (event) => {
      // An errand an inner turn handed off counts its cost against the inner life's dollars.
      inner.onTaskFinished(
        event?.raw?.task ?? errands.store?.(event?.guildId ?? null)?.get?.(event?.taskId) ?? null,
        event?.guildId ?? instance.guildId
      );
      return taskTurns.onEvent(event);
    },
    'inner.wake': (event) => inner.onWake(event),
    // The live glance at the voice channels and the statuses (`<people_now>`).
    'voice.changed': (event) => around.voiceChanged(event),
    'presence.changed': (event) => around.presenceChanged(event),
    'presence.snapshot': (event) => {
      around.snapshot(event);
      log.info('around: seeded', { guildId: instance.guildId, ...around.counts() });
    },
    'connection.changed': (event) => around.connection(event),
  },
  log,
});
doorReady.resolve(door);
/**
 * One gateway event to the core: built, its discord.js handles kept in the registry under its id
 * (a message event only: the pipeline reads them back through `rawOf`), then emitted over the link
 * without them. The answer is the core's ack; one that is neither taken nor a repeat is logged.
 * @typedef {{ id: string, raw?: unknown, rawPrevious?: unknown }} Event
 * @param {string} kind
 * @param {() => Event} build
 */
function inbound(kind, build) {
  /** @type {Event} */
  let event;
  try {
    event = build();
  } catch (err) {
    log.warn('interface: invalid event', { kind, reason: 'build-failed', name: err?.name ?? null });
    return;
  }
  if (kind === 'message.received' && event.raw)
    rawHandles.put(event.id, { message: event.raw, previous: event.rawPrevious ?? null });
  linkServed.emit(event).then((status) => {
    if (status !== 'ok' && status !== 'duplicate') log.warn('interface: event not taken', { kind, status });
  });
}
const selfIdNow = () => client.user?.id ?? null;
client.on('messageCreate', (message) => {
  inbound('message.received', () => toEvent(message, selfIdNow(), normalizeOptions(hot.config)));
});
// Discord attaches some embeds (a Tenor GIF's) after the message arrived: fold them into memory.
client.on('messageUpdate', (oldMessage, newMessage) => {
  inbound('message.received', () =>
    toEvent(newMessage, selfIdNow(), { ...normalizeOptions(hot.config), edit: true, previous: oldMessage })
  );
});
// A deleted message is a `deleted` line of the record (features.record).
client.on('messageDelete', (message) => {
  inbound('message.received', () => toEvent(message, selfIdNow(), { deleted: true }));
});
// A new or edited channel of the served guild may name a member the cache has not seen.
const warmOnChannel = (channel) => {
  if (instance.guildId && channel?.guild?.id === instance.guildId) audienceWarmer.warm({ quiet: true });
};
client.on(Events.ChannelCreate, warmOnChannel);
client.on(Events.ChannelUpdate, (_old, channel) => warmOnChannel(channel));
client.on('interactionCreate', onInteraction);

// The live snapshot (`<people_now>`) follows the gateway: the events are cheap map updates in the core and run
// whatever features.around says (a switch turned on later finds a snapshot that is current); a lost
// connection marks it stale until the shard is back. Only the served guild is tracked.
function seedAround() {
  const guild = instance.guildId ? client.guilds.cache.get(instance.guildId) : null;
  if (!guild) return;
  inbound('presence.snapshot', () => presenceSnapshotEvent(guild, Date.now()));
  inbound('connection.changed', () => connectionEvent('resumed', Date.now()));
}
client.on(Events.VoiceStateUpdate, (old, state) => {
  if (instance.guildId && state?.guild?.id === instance.guildId)
    inbound('voice.changed', () => voiceEvent(state, Date.now(), old));
});
client.on(Events.PresenceUpdate, (_old, presence) => {
  if (instance.guildId && presence?.guild?.id === instance.guildId)
    inbound('presence.changed', () => presenceEvent(presence, Date.now()));
});
// A changed avatar of a profiled member is queued for a description (features.avatars): the member
// and user updates need discord.intents.members; a member's own message works without it. The
// offer is synchronous and never throws.
client.on(Events.GuildMemberUpdate, (_old, member) => {
  if (instance.guildId && member?.guild?.id === instance.guildId) avatars.offer(instance.guildId, memberView(member));
});
client.on(Events.UserUpdate, (_old, user) => {
  const member = instance.guildId ? client.guilds.cache.get(instance.guildId)?.members?.cache?.get(user?.id) : null;
  if (member) avatars.offer(instance.guildId, memberView(member));
});
client.on('messageCreate', (message) => {
  if (instance.guildId && message?.guild?.id === instance.guildId && message.member)
    avatars.offer(instance.guildId, memberView(message.member));
});
// The reactor store follows the reactions on the persona's messages in the served guild, whatever
// features.reactionNames says (a cheap map update; a switch turned on later finds it current).
const feedReactors = (event) => {
  try {
    applyReactionEvent(reactors, reactionStoreEventOf(event), {
      guildId: instance.guildId,
      selfId: client.user?.id ?? null,
    });
  } catch (err) {
    log.warn('reactors: event failed', { kind: event?.kind ?? null, code: err?.code ?? null });
  }
};
client.on(Events.MessageReactionAdd, (reaction, user) => {
  inbound('reaction.changed', () => reactionEvent(reaction, user, true));
});
client.on(Events.MessageReactionRemove, (reaction, user) => {
  inbound('reaction.changed', () => reactionEvent(reaction, user, false));
});
client.on(Events.MessageReactionRemoveAll, (message) => {
  inbound('reaction.changed', () => reactionClearAllEvent(message));
});
client.on(Events.MessageReactionRemoveEmoji, (reaction) => {
  inbound('reaction.changed', () => reactionClearEmojiEvent(reaction));
});
client.on(Events.ShardDisconnect, () => inbound('connection.changed', () => connectionEvent('lost', Date.now())));
client.on(Events.ShardReconnecting, () => inbound('connection.changed', () => connectionEvent('lost', Date.now())));
client.on(Events.ShardResume, () => inbound('connection.changed', () => connectionEvent('resumed', Date.now())));
// A fresh session (not a resume) delivers the guild's state again: reseed from the cache.
client.on(Events.ShardReady, () => seedAround());

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('index: shutting down', { signal });
  for (const id of timers) clearInterval(id);
  if (archiveDrainTimer) clearTimeout(archiveDrainTimer);
  spontaneous.stop();
  diary.stop();
  onMessage.stop();
  missed.stop();
  errandClient.close();
  taskTurns.stop();
  inner.stopTimer();
  await missed.save().catch((err) => log.warn('index: missed registry not saved', { error: err }));
  // The embedding queue flushes what waits once (a short wait at most), before the stores close.
  await embedQueue.close().catch((err) => log.warn('index: embed queue close failed', { error: err }));
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
  // The link and the socket close, and the socket file goes with the server.
  linkServed.close();
  coreLink.close();
  await linkServer.close().catch((err) => log.warn('index: link socket close failed', { error: err }));
  await client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('index: unhandled rejection', { error: err }));

client.login(discordToken).catch((err) => fail(`index: Discord login failed: ${err.message}`));
