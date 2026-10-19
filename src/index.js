// Entry point: wires config, hot reload, the persistent store, the
// OpenRouter client, discord.js and the turn/spontaneous/memory subsystems
// together, and owns the process lifecycle (startup checks, timers, graceful
// shutdown). No decision logic lives here — everything is imported from
// src/behavior, src/memory, src/llm and the Discord interface (interfaces/discord/, through
// src/interface/discord.js).

import fs from 'node:fs';

import { ROOT_DIR, env, loadDotEnv, need } from './config.js';
import { resolvePaths } from './paths.js';
import { createHot } from './hot.js';
import { log, onLog } from './log.js';
import { createMetrics, metricsTap } from './ops/metrics.js';
import { createUsage, usageTap } from './ops/usage.js';
import {
  createStore,
  createAppendStore,
  createJournal,
  createRecord,
  createArchive,
  createVectors,
  createEmbedder as createEmbedQueue,
  createMemoryUpdater,
  createWarmup,
  createPortraitScheduler,
  createNotesScheduler,
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
import { createTurnRunner } from './behavior/turn.js';
import { createActivity } from './behavior/activity.js';
import { createMissed } from './behavior/missed.js';
import { createOfflineCatchUp } from './behavior/catch-up.js';
import { hasRequiredLabels } from './behavior/prompt.js';
import { createChannelRouter } from './behavior/route-channel.js';
import { createRecall } from './behavior/recall-run.js';
import {
  applyReactionEvent,
  createAroundStore,
  createAudienceWarmer,
  createDiscordClient,
  createDiscordInterface,
  createEmojiIndex,
  Events,
  createInteractionHandler,
  createReactorStore,
  normalizeOptions,
  reactionEvent,
  reactionClearAllEvent,
  reactionClearEmojiEvent,
  reactionStoreEventOf,
  registerCommands,
  resolveGuild,
  toEvent,
} from './interface/discord.js';
import { createSpontaneous } from './behavior/spontaneous.js';
import { createInnerLife } from './behavior/inner.js';
import { backfillDiary, createDiary } from './behavior/diary.js';
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
import { createTaskTurns, taskCompletedEvent } from './errands/turns.js';
import { createEventDoor } from './interface/door.js';
import { createIntentionStores } from './intentions/store.js';
import { createIntentionService } from './intentions/service.js';
import { skillRegistry } from './skills/registry.js';
import { createTagHistory, deprecatedModelKeys } from './behavior/mention.js';
import { createMessageHandler } from './behavior/pipeline.js';
import { isValidCommandName } from './ops/catalog.js';

const REQUIRED_PROMPTS = ['system-prompt', 'character-card', 'format', 'reply', 'interject', 'initiate', 'memory'];

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
    return fail(`index: missing required environment variable ${key} — copy .env.example to .env and fill in the real values.`);
  }
}

// The three directories, resolved once (src/paths.js): the checkout, the private layer
// (NEPTUNIA_PRIVATE_DIR: config.local.json, prompts.local/, .env) and the data directory
// (NEPTUNIA_DATA_DIR). The two variables come from the process environment (the unit file), never
// from .env, whose own place depends on them. Logged once, paths only.
const paths = resolvePaths({ rootDir: ROOT_DIR });
log.info('index: paths', { rootDir: paths.rootDir, privateDir: paths.privateDir, dataDir: paths.dataDir });
if (!fs.existsSync(paths.privateDir)) fail(`index: the private directory ${paths.privateDir} does not exist (NEPTUNIA_PRIVATE_DIR).`);

loadDotEnv(paths.privateDir);
const discordToken = needOrFail('DISCORD_TOKEN');
const openrouterKey = needOrFail('OPENROUTER_API_KEY');
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
      '(prompts.local/ may override any of these, file by file).',
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

if (!isValidCommandName(hot.config.bot.commandName)) {
  fail(
    `index: invalid bot.commandName "${hot.config.bot.commandName}" — must match ^[a-z0-9_-]{1,32}$ ` +
      '(config.local.json).',
  );
}

// The old per-feature model keys are never read (classifier.* replaced them);
// say so once, key names only, never a value.
for (const { key, use } of deprecatedModelKeys(hot.config)) log.warn('index: deprecated model key ignored', { key, use });

const dataDir = paths.dataDir;
// The speed figures of /nep status (src/ops/metrics.js): the durations the log lines carry,
// kept for 24 h in data/metrics.json (loaded now, written every minute and on shutdown).
const metrics = createMetrics({ dataDir, log });
onLog(metricsTap(metrics));
// The costs field of /nep status (src/ops/usage.js): today's requests per role from the `llm: usage`
// lines, kept for today and yesterday in data/usage.json (loaded now, written every minute and on shutdown).
const usage = createUsage({ dataDir, log });
onLog(usageTap(usage));
// The append-only files under data/ (the journal): one serialized writer per file. Its settings
// are read once here; the journal reads its own section (journal.*) at each write.
const appendStore = createAppendStore({
  fsyncMs: hot.config.appendStore?.fsyncMs ?? 500,
  retryMax: hot.config.appendStore?.retryMax ?? 1000,
  log,
});
// The record (src/memory/record.js): every observed message, the persona's own lines and her
// feelings, written while features.record is exactly true (read at each write). Its own append
// store, flushed every record.fsyncMs (read once here).
const recordAppendStore = createAppendStore({
  fsyncMs: hot.config.record?.fsyncMs ?? 500,
  retryMax: hot.config.appendStore?.retryMax ?? 1000,
  log,
});
// A forget holds the record's appends with the journal's writer lock (journal.withWriterLock).
const recordWriter = createRecord({ appendStore: recordAppendStore, dataDir, log, writerGate: () => journal.waitUnlocked() });
// The meaning index (src/memory/vectors.js): its writers wait on the same writer lock.
const vectors = createVectors({ dataDir, log, writerGate: () => journal.waitUnlocked() });
// The live embedding queue (src/memory/embedder.js), set once the embedding client exists below.
let embedQueue = null;
// The one place the meaning index hears of new record lines: every writer (the analyzer's
// batches, edits and deletions, the persona's own lines, feelings) appends through this record,
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
// hot file loses it, while features.archive is exactly true (read at each write). Its own append
// store, so its counts tell whether an archive line is on disk.
const archiveAppendStore = createAppendStore({
  fsyncMs: hot.config.appendStore?.fsyncMs ?? 500,
  retryMax: hot.config.appendStore?.retryMax ?? 1000,
  log,
});
const archive = createArchive({ appendStore: archiveAppendStore, dataDir, log, writerGate: () => journal.waitUnlocked() });
// The journal's writer lock (a snapshot, a forget, a wipe, the ledger at start) flushes the record's
// and the archive's append stores too, and holds their writers through their writerGate.
const journal = createJournal({ appendStore, dataDir, config: () => hot.config.journal ?? {}, lockStores: [recordAppendStore, archiveAppendStore] });
const store = createStore({
  dataDir,
  record,
  recordOn: () => hot.config.features?.record === true,
  archive,
  archiveOn: () => hot.config.features?.archive === true,
  // A forget and the ledger take members' rows out of the meaning index too.
  vectors,
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
  dataDir,
  log,
  nameOf: (guildId, userId) =>
    store.getUser(guildId, userId)?.names?.[0] ?? client.guilds.cache.get(guildId)?.members?.cache?.get(userId)?.displayName ?? null,
  selfName: (guildId) => getSelfName(guildId),
  // No catch-up pass while paused (the owner may be editing data/); /nep resume runs one.
  paused: () => store.state.data.paused === true,
});
// The persona's drawings (features.imageGeneration): its own daily rails, counted on the same state.
// Pictures are paid with the drawing role's key (`llm.keyByRole.drawing`, the agents' key), read at
// each request; the main key when the role names none.
const images = createImageGen({ apiKey: () => roleApiKey(hot.config, env, 'drawing', openrouterKey), getConfig: () => hot.config, state: store.state });

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
const audienceWarmer = createAudienceWarmer({ getGuild: () => (instance.guildId ? client.guilds.cache.get(instance.guildId) ?? null : null) });

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
// in process memory, fed by the gateway events below, never written anywhere.
const around = createAroundStore({ presences: presencesIntent });
// Who reacted to the persona's own messages (features.reactionNames): in process memory only,
// at most context.reactions.maxMessages of her messages (read at each insertion), fed by the
// reaction events below and by the turn's history fetch.
const reactors = createReactorStore({ maxMessages: () => hot.config.context?.reactions?.maxMessages ?? 500 });
// The served guild's custom emoji (features.customEmoji): a live view over discord.js's own cache.
const emoji = createEmojiIndex(client, getGuildId);
// The persona's display name in a guild: the one name every request, the warmup and the analyzer use.
const getSelfName = (guildId) => client.guilds.cache.get(guildId)?.members.me?.displayName ?? client.user?.username ?? 'bot';
// The persona's interface (src/interface/port.js): every effect of her replies goes through it,
// after the skill gateway (src/skills/gateway.js) let the call pass. The Discord interface
// (interfaces/discord/) builds it, and its capabilities object: what the core asks Discord for
// (permissions, history, pulled channels, searches), passed below as `discord` to every module
// that needs it -- nothing in the core but this file imports the interface.
const discordInterface = createDiscordInterface({ client });
const iface = discordInterface.port;
const discord = discordInterface.capabilities;
// The route classifier (features.channelRoute): picks a channel the conversation is about for <channel_view>.
const routeChannels = createChannelRouter({ hot, store, llm, discord });
// The search of the server's own history beside the web search (features.recall): the lookup's server part.
// It reads the archive and the record too (read only), and with features.meaningSearch the meaning
// index (one embedding of the question per run).
const recall = createRecall({ hot, store, llm, discord, describer, archive, record, vectors, embed: embedder.embed });
// When each person last wrote in each channel (fed by the message handler): a turn answering
// someone waits until they stop writing (pace.settleMs).
const activity = createActivity();
// A warmup run ends a chain of parts (a message answered part by part) before its next part;
// read through a closure, as the warmup is created just below.
// The persona's errands (agents.*): a task she or a member asks for goes to its agent runner over
// its socket in the background (src/errands/); the tasks live in data/guilds/<id>/tasks.json.
const errandClient = createErrandClient({ hot, log });
const taskStores = createTaskStores({ dataDir, config: () => hot.config, journal, log });
// An errand's end opens her own turn where it was asked (the task turns, created below the runner).
// An errand's end is a `task.completed` event through the event door (`door`, created below with
// the gateway's handlers); the door's handler (src/errands/turns.js#onEvent) first moves the
// intentions waiting on it back to pending, then opens her turn, which shows them with the outcome.
const errands = createErrandService({ client: errandClient, stores: taskStores, hot, env, memory: store, getGuildId, log, onFinished: (task, guildId) => door.submit(taskCompletedEvent(task, guildId)) });
// The persona's intentions (features.intentions): data/guilds/<id>/intentions.json, her own
// `intent.*` calls, the analyzer's candidates from her lines, and the waits on her errands.
const intentions = createIntentionService({ stores: createIntentionStores({ dataDir, log }), hot, tasks: errands, journal, getGuildId, log });
const turns = createTurnRunner({
  hot,
  store,
  llm,
  calibrator,
  client,
  discord,
  describer,
  imageFetcher,
  lookup,
  recall,
  images,
  emoji,
  around,
  reactors,
  getSelfName,
  routeChannels,
  isWarmingUp: () => warmup.isWarmingUp(),
  activity,
  journal,
  record,
  port: iface,
  skills: skillRegistry(),
  // Her skills are the owner commands: each runs through the command's own path, the
  // requester's rights checked again (src/admin.js#runCommand); read at call time, the admin
  // being created below.
  runCommand: (key, args, context) => admin.runCommand(key, args, context),
  // Her own messages, drawings and diary run on her grant alone (src/ops/effects.js#SELF_OWNED_OPS).
  runOwnCommand: (key, args, context) => admin.runOwnCommand(key, args, context),
  // An inner turn's calls (her own initiative, nobody asked) run on her grant alone too.
  runInitiativeCommand: (key, args, context) => admin.runInitiativeCommand(key, args, context),
  // `<tasks>`: her open and newly finished errands; an errand's caps are its skill's budget.
  errands,
  // `<intentions>`: her open intentions and the candidates from her lines (features.intentions).
  intentions,
  // `<places>` on an addressed turn (context.places): the inner life's places view, read at call time.
  places: (guildId, options) => inner.places(guildId, options),
});
// THE way memory starts (docs/prompt-contract.md, "The warmup"): sample-based,
// resumable, mutes the persona while a run is in flight (see isWarmingUp below).
const warmup = createWarmup({ hot, store, client, discord, llm, calibrator, getSelfName, getGuildId });
const isWarmingUp = warmup.isWarmingUp;
const spontaneous = createSpontaneous({ hot, store, client, discord, turns, getGuildId, isWarmingUp });
// The persona's diary (diary.channelId): its own posts on a day plan, ticked below.
const diary = createDiary({ hot, store, client, discord, turns, getGuildId, isWarmingUp, backfill: backfillDiary });
// The stream analyzer's "the stored portrait misses something" cue -- src/memory/warmup.js's
// own rails (hours/day/mute) decide whether a refresh actually runs; never awaited here.
const memory = createMemoryUpdater({
  hot,
  store,
  llm,
  calibrator,
  getSelfName,
  journal,
  onPortraitRequest: (guildId, userId, reason) => {
    warmup.refreshPortrait(guildId, userId, reason).catch((err) => log.error('index: portrait refresh failed', { error: err }));
  },
  // features.record: each batch reaches the record before it is analyzed.
  record,
  // features.archive: a pending queue over archive.pendingMax pauses memory application.
  archive,
  // A status line for the development channel (bot.dryRunChannelId, read now).
  notify: (text) => mirrorDryRun({ client, dryRunChannelId: hot.config.bot?.dryRunChannelId || '', header: 'memory', body: text }),
  // features.intentions: the intention candidates a batch found in her own lines.
  onIntentionCandidates: (guildId, raw, messages) => intentions.addCandidates(guildId, raw, messages),
  // Where her lines came from (src/intentions/sources.js), kept with them in the buffer.
  lineSourcesOf: (messageId) => intentions.lineSources(messageId),
});
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
const inner = createInnerLife({
  hot,
  dataDir,
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
  isWarmingUp,
  // People's turns first: an inner turn waits while a direct ping is queued.
  peopleWaiting: () => onMessage.pendingCount() > 0,
  submit: (event) => door.submit(event),
  // What an inner turn did and found becomes lines of hers for the memory analyzer.
  onEpisode: (guildId, episode) => memory.observeInner(guildId, episode),
  log,
});
// A diary post she asked for in an inner turn that was refused after the turn ended: told to her as feedback.
turns.setOnDeferredFailure((note) => inner.noteLateFailure(note));
const tagHistory = createTagHistory();
// Messages that may have been left without an answer (src/behavior/missed.js): facts from the
// address gate, the pending queue and every turn's end, a delayed sweep per channel, and a
// recovery turn only with features.missedRecovery on (shadow mode by default).
const missed = createMissed({ hot, store, journal, llm, turns, client, getGuildId, getSelfName, isWarmingUp, dataDir, fetchHistory: discord.fetchHistory, canSend: discord.canSend });
turns.setOnTurnEnd((end) => missed.onTurnEnd(end));
// The custom emoji ranking read from history (Discord API only, no LLM): once at startup, again on /nep emoji rescan.
const emojiBackfill = createEmojiBackfill({ hot, store, client, discord, log });
// The GIF library read from history (Discord API; the describer captions the top ones): once at
// startup, again on /nep gifs rescan.
const gifBackfill = createGifBackfill({ hot, store, client, discord, describer, log });
// The GIF library re-described by watching (src/memory/gif-recache.js): only on /nep gifs recache;
// and the pictures an older model described, found through the record: only on /nep media
// kind:pictures action:recache.
const gifRecache = createGifRecache({ hot, store, client, discord, describer, record, isWarmingUp, log });

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
  isWarmingUp,
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
    if (!channel || channel.guild?.id !== instance.guildId || typeof channel.messages?.fetch !== 'function') return { available: false, latestAt: null };
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
  // /nep diary: the day plan, a forced post.
  diary,
  calibrator,
  getGuildId,
  isWarmingUp,
  turns,
  memory,
  // /nep pause: clears the pending-ping queue on pause.
  pending: { clear: () => onMessage.clearPending() },
  // The sample-based memory warmup: run, user/users, channel/channels, server, status, reset, portrait refresh.
  warmup,
  // The image client's quota and model family, for the owner commands; /nep draw generates through it.
  images,
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
  // /nep pause|resume, memory forget|wipe: system records; /nep memory journal reads it.
  journal,
  // /nep status: the owner card probes every role's model and the drawing model's listing.
  llm,
  // /nep status: the embedding role's probe.
  embedder,
  // /nep resume: a catch-up pass of the meaning index; /nep status: its index line.
  embedQueue,
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
 * full days. Skipped while paused (the owner may be editing data/) and while the warmup runs.
 */
function sweepAffinityDecay() {
  const guildId = instance.guildId;
  const config = hot.config;
  if (!guildId || config.features?.relationships === false) return;
  if (store.state.data.paused || isWarmingUp()) return;
  const counts = store.decayAffinities(guildId, Date.now(), config.relationships ?? {});
  if (counts.decayed > 0) log.info('index: affinity decay applied', counts);
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
  archiveDrainTimer = setTimeout(() => {
    Promise.resolve()
      .then(() => (instance.guildId && !store.state.data.paused ? store.drainArchive(instance.guildId) : null))
      .catch((err) => log.error('index: archive drain failed', { error: err }))
      .finally(() => {
        if (!shuttingDown) scheduleArchiveDrain();
      });
  }, Number.isFinite(ms) && ms > 0 ? ms : 30_000);
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
    .map((message) => ({ id: message.id, content: message.content, replyToId: message.reference?.messageId ?? null, createdAt: message.createdTimestamp }));
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
 * The journal at start: forgets a crash left half done are finished first (store.resumeForgets,
 * every step of `/nep memory forget`, whatever the switch: what was journalled about a forgotten
 * member goes), then the deletion ledger is re-applied (store.applyLedger: a restored copy brings
 * no forgotten member back) -- both before the updater's first tick; then, with the journal on, a
 * `.running` marker left by a run that never stopped cleanly becomes an `unclean-stop` record,
 * this run's marker is written and the `start` record follows.
 */
async function startJournal(guildId) {
  // memory.vaultDir and labels.memory.redaction, read now (store.js carries the same fallbacks).
  // `errands`: a forget's errands step (the tasks the member asked for, src/errands/service.js#forgetUser);
  // `intentions`: its intentions step (hers that concern the member, src/intentions/service.js#forgetUser).
  const deps = { journal, errands, intentions, vaultDir: hot.config.memory?.vaultDir, redaction: hot.prompts.labels?.memory?.redaction };
  await store.resumeForgets(guildId, deps);
  await store.applyLedger(guildId, deps);
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
  // flush, the spontaneous, diary, memory and portrait ticks, the hourly affinity decay.
  every(30_000, () => store.flush(), 'store.flush');
  // TODO(.agents spec 2026-10-17-protocol-package, "Code"): the scheduler's clock becomes a
  // `scheduler.tick` event through the same dispatcher as an errand's end (see the errands above).
  every(30_000, () => spontaneous.tick(), 'spontaneous.tick');
  every(30_000, () => diary.tick(), 'diary.tick');
  // The inner life's tick, every innerLife.tickSeconds (read before each wait).
  inner.startTimer();
  // The tick still runs on schedule even with the switch off, so flipping it
  // back on later needs no restart; it is the wrapper here that no-ops.
  every(60_000, () => (hot.config.features?.memory !== false ? memory.tick() : undefined), 'memory.tick');
  // Portraits refreshed by counters (features.portraitRefresh): the scheduler looks every
  // memory.portraitCheckMinutes itself; the minute tick only gives it the chance.
  const portraits = createPortraitScheduler({ hot, store, refreshPortrait: warmup.refreshPortrait, isWarmingUp, getGuildId, now: Date.now });
  every(60_000, () => portraits.tick(), 'portraits.tick');
  // Channel and server notes re-described from a spread sample (features.notesRefresh): the
  // scheduler looks every memory.notesCheckMinutes itself; the minute tick only gives it the chance.
  const notes = createNotesScheduler({ hot, store, refreshChannelNotes: warmup.refreshChannelNotes, refreshServerNotes: warmup.refreshServerNotes, isWarmingUp, getGuildId, now: Date.now });
  every(60_000, () => notes.tick(), 'notes.tick');
  every(3_600_000, sweepAffinityDecay, 'affinity decay');
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
  // paused -- every spontaneous/analyzer tick keeps no-op'ing until /nep resume.
  if (store.state.data.paused) {
    log.info('index: starting up paused, run /nep resume when data/ is ready', {
      pausedAt: store.state.data.pausedAt ?? null,
    });
  }

  // The journal's start: unfinished forgets, an unclean stop, the start record. Awaited, so the
  // reconciliation below reads a journal that hides every member being forgotten.
  await startupStep('journal.start', () => startJournal(instance.guildId), { wait: true });

  // The links of the persona's recent lines to the messages that started their turns, rebuilt
  // from the journal once the forgets are settled. Fire-and-forget: a turn before it is done
  // only lacks the older links.
  await startupStep('journal.triggerLinks', () => seedTriggerLinks(instance.guildId));
  // The persona's recent skill calls, the same way.
  await startupStep('journal.callMarks', () => seedCallMarks(instance.guildId));

  // The missed-answer registry: data/guilds/<id>/missed.json, reconciled with the journal of the
  // last hour once the forgets are settled; a sweep armed where a candidate waits.
  await startupStep('missed.start', () => missed.start(instance.guildId));

  // The errands a restart left open: their runner can no longer answer this process, so they fail
  // (`restarted`) and show in her `<tasks>` block as failed.
  await startupStep('errands.start', () => errands.start(instance.guildId), { wait: true });

  // Her intentions reconciled with the errands as they stand now (those just failed included):
  // a wait whose errand ended, is gone or ran out moves back to pending; the expired ones expire.
  await startupStep('intentions.reconcile', () => intentions.reconcile(instance.guildId), { wait: true });

  // The meaning index caught up with what the record took while the queue was down (the last
  // embed.catchUpHours), once the forgets are settled. Fire-and-forget; nothing while paused or
  // with the switches off.
  await startupStep('embed.catchUp', () => embedQueue.catchUp(instance.guildId));

  // Once per guild after the deploy that keyed access by operation: the stored grants re-expanded
  // under the operation names, a journal record of what each covers now (src/ops/access.js).
  await startupStep('access.migrate', () => admin.migrateAccess(instance.guildId), { wait: true });

  // The side effects a crash or a restart left without an outcome. Fire-and-forget: a turn
  // starting meanwhile is never touched (only earlier operations are), and it never sends.
  await startupStep('journal.reconcile', () => reconcileJournal(instance.guildId));

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
      registerCommands(guild, hot.config).catch((err) => log.error('index: failed to re-register commands', { error: err }));
    }
  }
});

// The gateway's messages and reactions reach the core as protocol events (packages/protocol/,
// built by interfaces/discord/collect.js) through the event door (src/interface/door.js), the one
// entry of the mind: it validates each event at the boundary, drops a repeated id, and hands the
// event to the handler of its kind. An event that cannot be built or is malformed is dropped with
// one warn line (its kind and the reason, never its content), so nothing behind it ever sees a
// half-formed one. The core's own events (an errand's end) come through the same door.
const door = createEventDoor({
  handlers: {
    'message.received': (event) => {
      if (event.deleted) return onMessage.onMessageDelete(event);
      return event.edit ? onMessage.onMessageUpdate(event) : onMessage(event);
    },
    'reaction.changed': (event) => feedReactors(event),
    'task.completed': (event) => {
      // An errand an inner turn handed off counts its cost against the inner life's dollars.
      inner.onTaskFinished(event?.raw?.task ?? errands.store?.(event?.guildId ?? null)?.get?.(event?.taskId) ?? null, event?.guildId ?? instance.guildId);
      return taskTurns.onEvent(event);
    },
    'inner.wake': (event) => inner.onWake(event),
  },
  log,
});
function inbound(kind, build) {
  let event;
  try {
    event = build();
  } catch (err) {
    log.warn('interface: invalid event', { kind, reason: 'build-failed', name: err?.name ?? null });
    return;
  }
  door.submit(event);
}
const selfIdNow = () => client.user?.id ?? null;
client.on('messageCreate', (message) => {
  inbound('message.received', () => toEvent(message, selfIdNow(), normalizeOptions(hot.config)));
});
// Discord attaches some embeds (a Tenor GIF's) after the message arrived: fold them into memory.
client.on('messageUpdate', (oldMessage, newMessage) => {
  inbound('message.received', () => toEvent(newMessage, selfIdNow(), { ...normalizeOptions(hot.config), edit: true, previous: oldMessage }));
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

// The live snapshot (`<people_now>`) follows the gateway: the events are cheap map updates and run whatever
// features.around says (a switch turned on later finds a snapshot that is current); a lost
// connection marks it stale until the shard is back. Only the served guild is tracked.
function seedAround() {
  const guild = instance.guildId ? client.guilds.cache.get(instance.guildId) : null;
  if (!guild) return;
  around.seedVoice(guild.voiceStates?.cache?.values() ?? []);
  around.seedPresence(guild.presences?.cache?.values() ?? []);
  around.markFresh();
  log.info('around: seeded', { guildId: instance.guildId, ...around.counts() });
}
client.on(Events.VoiceStateUpdate, (_old, state) => {
  if (instance.guildId && state?.guild?.id === instance.guildId) around.voiceUpdate(state);
});
client.on(Events.PresenceUpdate, (_old, presence) => {
  if (instance.guildId && presence?.guild?.id === instance.guildId) around.presenceUpdate(presence);
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
  if (instance.guildId && message?.guild?.id === instance.guildId && message.member) avatars.offer(instance.guildId, memberView(message.member));
});
// The reactor store follows the reactions on the persona's messages in the served guild, whatever
// features.reactionNames says (a cheap map update; a switch turned on later finds it current).
const feedReactors = (event) => {
  try {
    applyReactionEvent(reactors, reactionStoreEventOf(event), { guildId: instance.guildId, selfId: client.user?.id ?? null });
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
client.on(Events.ShardDisconnect, () => around.markStale());
client.on(Events.ShardReconnecting, () => around.markStale());
client.on(Events.ShardResume, () => around.markFresh());
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
  await store.flushSettled({ holdMaxMs });
  await metrics.save({ force: true });
  await usage.save({ force: true });
  // The journal's `stop` record (journal on), then the run marker goes: this stop was clean.
  if (instance.guildId) {
    if (journalOn()) await journal.system(instance.guildId, { event: 'stop', by: 'service', note: signal });
    await journal.clearRunning(instance.guildId).catch((err) => log.warn('index: journal marker not removed', { error: err }));
  }
  await appendStore.close().catch((err) => log.warn('index: append store close failed', { error: err }));
  await recordAppendStore.close().catch((err) => log.warn('index: append store close failed', { error: err }));
  await archiveAppendStore.close().catch((err) => log.warn('index: append store close failed', { error: err }));
  await client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('index: unhandled rejection', { error: err }));

client.login(discordToken).catch((err) => fail(`index: Discord login failed: ${err.message}`));
