// Entry point: wires config, hot reload, the persistent store, the
// OpenRouter client, discord.js and the turn/spontaneous/memory subsystems
// together, and owns the process lifecycle (startup checks, timers, graceful
// shutdown). No decision logic lives here — everything is imported from
// src/behavior, src/memory, src/llm and src/discord.

import path from 'node:path';
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';

import { ROOT_DIR, env, loadDotEnv, need } from './config.js';
import { createHot } from './hot.js';
import { log, onLog } from './log.js';
import { createMetrics, metricsTap } from './ops/metrics.js';
import { createUsage, usageTap } from './ops/usage.js';
import { createStore } from './memory/store.js';
import { createAppendStore } from './memory/append-store.js';
import { createJournal } from './memory/journal.js';
import { createRecord } from './memory/record.js';
import { createArchive } from './memory/archive.js';
import { createVectors } from './memory/vectors.js';
import { createEmbedder as createEmbedQueue } from './memory/embedder.js';
import { mirrorDryRun } from './behavior/limits.js';
import { DAY_MS, utcDay } from './time.js';
import { createCalibrator } from './llm/tokens.js';
import { createLlm } from './llm/openrouter.js';
import { createEmbedder } from './llm/embed.js';
import { createImageGen } from './llm/images.js';
import { createTurnRunner } from './behavior/turn.js';
import { createActivity } from './behavior/activity.js';
import { createMissed } from './behavior/missed.js';
import { hasRequiredLabels } from './behavior/prompt.js';
import { createChannelRouter } from './behavior/route-channel.js';
import { createRecall } from './behavior/recall-run.js';
import { createEmojiIndex } from './discord/emoji.js';
import { createAroundStore } from './discord/around.js';
import { applyReactionEvent, createReactorStore, reactionEventOf } from './discord/reactors.js';
import { createSpontaneous } from './behavior/spontaneous.js';
import { backfillDiary, createDiary } from './behavior/diary.js';
import { createMemoryUpdater } from './memory/update.js';
import { createWarmup } from './memory/warmup.js';
import { createPortraitScheduler } from './memory/portrait.js';
import { createNotesScheduler } from './memory/notes-refresh.js';
import { createEmojiBackfill } from './memory/emoji-backfill.js';
import { createGifBackfill } from './memory/gif-backfill.js';
import { createGifRecache } from './memory/gif-recache.js';
import { createDescriber } from './memory/describe.js';
import { createAvatarQueue } from './memory/avatar-queue.js';
import { memberView } from './memory/avatars.js';
import { startYoutubeCheck } from './memory/youtube-check.js';
import { createImageFetcher } from './discord/fetch-image.js';
import { createVideoFetcher } from './discord/fetch-video.js';
import { createPageFetcher } from './web/fetch-page.js';
import { createBraveSearch } from './web/brave.js';
import { createLookup } from './web/lookup.js';
import { createAdmin } from './admin.js';
import { createErrandClient } from './errands/client.js';
import { createTaskStores } from './errands/store.js';
import { createErrandService } from './errands/service.js';
import { skillRegistry } from './skills/registry.js';
import { createDiscordAdapter } from './interface/discord.js';
import { createTagHistory, deprecatedModelKeys } from './behavior/mention.js';
import { createMessageHandler } from './discord/events.js';
import { resolveGuild } from './discord/guild.js';
import { createAudienceWarmer } from './discord/audience-warm.js';
import { isValidCommandName, registerCommands, createInteractionHandler } from './discord/commands.js';

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

loadDotEnv();
const discordToken = needOrFail('DISCORD_TOKEN');
const openrouterKey = needOrFail('OPENROUTER_API_KEY');
// Optional: without it a YouTube duration comes from the watch page only.
const youtubeApiKey = env.YOUTUBE_API_KEY || null;
// Optional: without it the web lookup reads links but never searches. Never logged.
const braveApiKey = env.BRAVE_SEARCH_API_KEY || null;
// Optional: the simulator key, used only for one read-only GET of its limit on the owner's status
// card, never for a model request. Never logged.
const simApiKey = env.OPENROUTER_SIM_KEY || null;
// Optional: the management key, used only for the read-only activity GETs of the owner's status
// card (each key's spend over the last 30 days), never for a model request. Never logged.
const managementApiKey = env.OPENROUTER_MANAGEMENT_KEY || null;

const hot = createHot({ rootDir: ROOT_DIR }).watch();

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

const dataDir = path.join(ROOT_DIR, 'data');
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
const images = createImageGen({ apiKey: openrouterKey, getConfig: () => hot.config, state: store.state });

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
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildExpressions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
    ...(presencesIntent ? [GatewayIntentBits.GuildPresences] : []),
    ...(membersIntent ? [GatewayIntentBits.GuildMembers] : []),
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
});

// This instance serves exactly one Discord server. `instance.guildId` is set
// once, right after ClientReady resolves it (see below), and every component
// that needs it reads it through `getGuildId` instead of caching it, so a
// switch to a different guild always requires a restart, never a silent swap.
const instance = { guildId: null };
const getGuildId = () => instance.guildId;

// The audience rail tells a bot's member overwrite by the member cache, which
// the client fills only with members seen since startup (no member intent):
// the warmer fetches every member named by an overwrite (src/discord/audience-warm.js).
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
  braveSearch: createBraveSearch(),
  braveApiKey,
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
// The route classifier (features.channelRoute): picks a channel the conversation is about for <channel_view>.
const routeChannels = createChannelRouter({ hot, store, llm });
// The search of the server's own history beside the web search (features.recall): the lookup's server part.
// It reads the archive and the record too (read only), and with features.meaningSearch the meaning
// index (one embedding of the question per run).
const recall = createRecall({ hot, store, llm, describer, archive, record, vectors, embed: embedder.embed });
// When each person last wrote in each channel (fed by the message handler): a turn answering
// someone waits until they stop writing (pace.settleMs).
const activity = createActivity();
// A warmup run ends a chain of parts (a message answered part by part) before its next part;
// read through a closure, as the warmup is created just below.
// The persona's interface (src/interface/port.js): every effect of her replies goes through it,
// after the skill gateway (src/skills/gateway.js) let the call pass.
const iface = createDiscordAdapter({ client });
// The persona's errands (agents.*): a task she or a member asks for goes to its agent runner over
// its socket in the background (src/errands/); the tasks live in data/guilds/<id>/tasks.json.
const errandClient = createErrandClient({ hot, log });
const taskStores = createTaskStores({ dataDir, config: () => hot.config, journal, log });
const errands = createErrandService({ client: errandClient, stores: taskStores, hot, getGuildId, log });
const turns = createTurnRunner({
  hot,
  store,
  llm,
  calibrator,
  client,
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
  // `<tasks>`: her open and newly finished errands; an errand's caps are its skill's budget.
  errands,
});
// THE way memory starts (docs/prompt-contract.md, "The warmup"): sample-based,
// resumable, mutes the persona while a run is in flight (see isWarmingUp below).
const warmup = createWarmup({ hot, store, client, llm, calibrator, getSelfName, getGuildId });
const isWarmingUp = warmup.isWarmingUp;
const spontaneous = createSpontaneous({ hot, store, client, turns, getGuildId, isWarmingUp });
// The persona's diary (diary.channelId): its own posts on a day plan, ticked below.
const diary = createDiary({ hot, store, client, turns, getGuildId, isWarmingUp, backfill: backfillDiary });
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
});
const tagHistory = createTagHistory();
// Messages that may have been left without an answer (src/behavior/missed.js): facts from the
// address gate, the pending queue and every turn's end, a delayed sweep per channel, and a
// recovery turn only with features.missedRecovery on (shadow mode by default).
const missed = createMissed({ hot, store, journal, llm, turns, client, getGuildId, getSelfName, isWarmingUp, dataDir });
turns.setOnTurnEnd((end) => missed.onTurnEnd(end));
// The custom emoji ranking read from history (Discord API only, no LLM): once at startup, again on /nep emoji rescan.
const emojiBackfill = createEmojiBackfill({ hot, store, client, log });
// The GIF library read from history (Discord API; the describer captions the top ones): once at
// startup, again on /nep gifs rescan.
const gifBackfill = createGifBackfill({ hot, store, client, describer, log });
// The GIF library re-described by watching (src/memory/gif-recache.js): only on /nep gifs recache;
// and the pictures an older model described, found through the record: only on /nep media
// kind:pictures action:recache.
const gifRecache = createGifRecache({ hot, store, client, describer, record, isWarmingUp, log });

const onMessage = createMessageHandler({
  hot,
  store,
  client,
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

// One attention (mention.oneAtATime): once a turn frees its channel, answer
// the oldest pending direct ping it may have collected while busy elsewhere.
turns.setOnIdle(() => onMessage.drainPending());

const admin = createAdmin({
  hot,
  store,
  client,
  // /nep message and /nep draw channel: post through the persona's interface, as her.
  port: iface,
  // /nep task: the persona's errands.
  errands,
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
  // /nep status: the costs field's per-role lines.
  usage,
  // /nep status: the simulator key's limit line (one GET, nothing else).
  simKey: simApiKey,
  // /nep status: each key's activity for its last 7 and 30 days (GETs only, nothing else).
  managementKey: managementApiKey,
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
  const deps = { journal, vaultDir: hot.config.memory?.vaultDir, redaction: hot.prompts.labels?.memory?.redaction };
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
  every(30_000, () => spontaneous.tick(), 'spontaneous.tick');
  every(30_000, () => diary.tick(), 'diary.tick');
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

client.on('messageCreate', onMessage);
// Discord attaches some embeds (a Tenor GIF's) after the message arrived: fold them into memory.
client.on('messageUpdate', onMessage.onMessageUpdate);
// A deleted message is a `deleted` line of the record (features.record).
client.on('messageDelete', onMessage.onMessageDelete);
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
const feedReactors = (kind, parts) => {
  try {
    applyReactionEvent(reactors, reactionEventOf(kind, parts), { guildId: instance.guildId, selfId: client.user?.id ?? null });
  } catch (err) {
    log.warn('reactors: event failed', { kind, code: err?.code ?? null });
  }
};
client.on(Events.MessageReactionAdd, (reaction, user) => feedReactors('add', { reaction, user }));
client.on(Events.MessageReactionRemove, (reaction, user) => feedReactors('remove', { reaction, user }));
client.on(Events.MessageReactionRemoveAll, (message) => feedReactors('removeAll', { message }));
client.on(Events.MessageReactionRemoveEmoji, (reaction) => feedReactors('removeEmoji', { reaction }));
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
