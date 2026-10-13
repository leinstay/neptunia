// The environment every operation runs against: the dependencies src/admin.js#createAdmin is
// given (see its JSDoc for each one) and the helpers several operations share -- the slash
// wording of a pointer to another command, the paused / no-guild / warmup refusals, the token
// resolver of analyzer text, the journal's system records, the pause announcement and the
// config.local.json writers. Built once per admin; an operation reads it as `ctx.env`. Hot
// values are read at the moment of use, through `hot`, never copied.

import path from 'node:path';
import { fromTokens } from '../memory/mentions.js';
import { familyOf as imageFamilyOf } from '../llm/images.js';
import { log } from '../log.js';
import { invalid } from './registry.js';
import { NOT_TOLD, NO_GUILD, splitPath, setPath, ownValueAt, readLocalConfig, writeLocalConfig } from './shared.js';

/**
 * The operations' environment over `deps` (src/admin.js#createAdmin's dependencies, the same
 * defaults): the dependencies themselves plus the shared helpers.
 * @param {object} deps
 * @returns {object}
 */
export function createOpsEnv({
  hot,
  store,
  client,
  spontaneous,
  calibrator,
  getGuildId,
  isWarmingUp = () => false,
  turns,
  memory,
  pending,
  warmup,
  images,
  imageFetcher,
  emojiBackfill,
  gifBackfill,
  gifRecache,
  diary,
  archive = null,
  journal,
  llm,
  dataDir = hot?.rootDir ? path.join(hot.rootDir, 'data') : null,
} = {}) {
  // The gateway's last reconnect, for the status card: a resumed session, or a shard ready again
  // after its first ready. Null until one happens; nothing is tracked without a client to listen to.
  const connection = { lastReconnectAt: null };
  if (typeof client?.on === 'function') {
    let readies = 0;
    client.on('shardReady', () => {
      readies += 1;
      if (readies > 1) connection.lastReconnectAt = Date.now();
    });
    client.on('shardResume', () => {
      connection.lastReconnectAt = Date.now();
    });
  }

  /** `/<command name> <rest>`, the command name read now (`bot.commandName`, default `nep`):
   * every reply that points the owner at another command says it this way. */
  function slash(rest) {
    return `/${hot.config?.bot?.commandName || 'nep'} ${rest}`;
  }

  /** The refusal of a data/ write while paused. */
  function pausedText() {
    return `paused -- run ${slash('resume')} first`;
  }

  /** The one wording of "a warmup is running", for a refused command and a skipped job alike. */
  function warmupBusyText() {
    return `a warmup is running: follow it with ${slash('warmup status')}, end it with ${slash('warmup stop')}`;
  }

  /** A background job's skip reason as the owner reads it: the job's own `skips` first, then the
   * reasons every job shares (paused, a warmup running, no guild), else `fallback`. */
  function skipText(skips, reason, fallback) {
    if (Object.hasOwn(skips, String(reason))) return skips[reason];
    if (reason === 'paused') return pausedText();
    if (reason === 'warmup') return warmupBusyText();
    if (reason === 'no-guild') return NO_GUILD;
    return fallback;
  }

  /**
   * `/nep pause`: refuse a command that would write under `data/` while
   * paused, with a hint to resume first. Guards interject, initiate,
   * alias.add, alias.remove, memory.forget, private.forget, private.purge, memory.wipe, memory.affinity (when
   * setting a score), memory.refresh, lore.add, lore.remove, learned.add,
   * learned.remove, warmup.run, warmup.users, warmup.channels, warmup.server,
   * warmup.reset, emoji.rescan, gifs.rescan, gifs.recache and draw (it counts against the image rail
   * in state.json).
   */
  function assertNotPaused() {
    if (store.state.data.paused) {
      throw Object.assign(new Error(pausedText()), { code: 'paused' });
    }
  }

  /**
   * A read-only command must see a hand-edit made while paused, even a
   * second one made between two calls of the same command -- `dropCaches`
   * only drops what a WRITE would otherwise dirty (users/guild/channels/lore
   * /media/buffer), so this is safe to call before every read while paused.
   * A no-op when not paused, so callers can call it unconditionally.
   */
  function freshenIfPaused() {
    if (store.state.data.paused && typeof store.dropCaches === 'function') store.dropCaches();
  }

  /** The served guild: the interaction's, else the one this instance resolved; null before then. */
  function resolvedGuildId(context) {
    return context?.guildId ?? getGuildId?.() ?? null;
  }

  /** The served guild, or an Error before it resolves. */
  function requireGuildId(context) {
    const guildId = resolvedGuildId(context);
    if (!guildId) throw Object.assign(new Error(NO_GUILD), { code: 'no-guild' });
    return guildId;
  }

  /** `nameOf` (a member's current stored name, or null) and `resolve` (`<@id>` -> `name (id:…)`,
   * an id with no stored name keeping its token) for this guild: the resolution every view of
   * analyzer-written text uses (src/memory/mentions.js#fromTokens, mode `'analyzer'`). */
  function tokenResolver(guildId) {
    const nameOf = (id) => store.getUser(guildId, id)?.names?.[0] ?? null;
    const resolve = (text) => fromTokens(typeof text === 'string' ? text : '', nameOf, 'analyzer');
    return { nameOf, resolve };
  }

  /** A `system` journal record of `guildId` (features.journal exactly true, read now); never throws. */
  async function journalSystem(guildId, record) {
    if (!journal || !guildId || hot.config?.features?.journal !== true) return;
    try {
      await journal.system(guildId, record);
    } catch (err) {
      log.warn('admin: journal record failed', { code: err?.code ?? null, guildId });
    }
  }

  /**
   * `/nep pause|resume`'s one line to the chat: `labels.journal.<key>` (read now) posted in
   * `journal.announceChannelId`, no mention allowed. `{ announced, note }`: `note` is what the
   * owner's reply adds when it did not go out (no channel, no wording, the post failed).
   */
  async function announce(key) {
    const channelId = hot.config?.journal?.announceChannelId;
    if (typeof channelId !== 'string' || !channelId) return { announced: false, note: NOT_TOLD['no-channel'] };
    const text = hot.prompts?.labels?.journal?.[key];
    if (typeof text !== 'string' || !text.trim()) return { announced: false, note: NOT_TOLD['no-label'] };
    try {
      const channel = await client.channels.fetch(channelId);
      await channel.send({ content: text, allowedMentions: { parse: [] } });
      return { announced: true, note: null };
    } catch (err) {
      log.warn('admin: announce failed', { channelId, code: err?.code ?? null });
      return { announced: false, note: NOT_TOLD['send-failed'] };
    }
  }

  /** Waits out a live-analyzer run already in flight -- its answer lands after its model call and
   * would re-create what a delete just removed -- then refuses if a pause landed meanwhile. */
  async function waitForAnalyzer() {
    await memory?.waitIdle?.();
    assertNotPaused();
  }

  function localConfigFile() {
    return path.join(hot.rootDir, 'config.local.json');
  }

  /** config.local.json passed through `edit` (object in, object out), written back, and the
   * config reloaded; the reload's outcome. Every config writer goes through here. */
  function editLocalConfig(edit) {
    const file = localConfigFile();
    writeLocalConfig(file, edit(readLocalConfig(file)));
    return hot.reloadConfig();
  }

  /** `value` written at `dottedPath` of config.local.json, then reloaded; the reload's outcome. */
  function writeLocalPath(dottedPath, value) {
    return editLocalConfig((local) => setPath(local, dottedPath, value));
  }

  /** The value at `dottedPath` as of the last write: config.local.json's when it holds the path,
   * else the live config's -- so a read right after a write sees it even a moment before the
   * reload lands. */
  function localOrLive(dottedPath) {
    const parts = splitPath(dottedPath);
    const local = ownValueAt(readLocalConfig(localConfigFile()), parts);
    return local.found ? local.value : ownValueAt(hot.config, parts).value;
  }

  /** The stored profile of `userId`, or an Error `no profile for <id>`: a write command never
   * creates a profile for a member the persona has not met. */
  function requireProfile(guildId, userId) {
    const profile = store.getUser(guildId, userId);
    if (!profile) throw invalid(`no profile for ${userId}`, 'not-found');
    return profile;
  }

  /** `image.model` for status and model show, `-` when unset, flagged when src/llm/images.js
   * has no request mapping for its family (every generation would be refused). */
  function imageModelLabel(cfg) {
    const model = cfg?.image?.model;
    if (!model) return '-';
    const family = (images?.familyOf ?? imageFamilyOf)(model);
    return family ? model : `${model} (unsupported family)`;
  }

  return {
    hot,
    store,
    client,
    spontaneous,
    calibrator,
    getGuildId,
    isWarmingUp,
    turns,
    memory,
    pending,
    warmup,
    images,
    imageFetcher,
    emojiBackfill,
    gifBackfill,
    gifRecache,
    diary,
    archive,
    journal,
    llm,
    dataDir,
    connection,
    slash,
    pausedText,
    warmupBusyText,
    skipText,
    assertNotPaused,
    freshenIfPaused,
    resolvedGuildId,
    requireGuildId,
    tokenResolver,
    journalSystem,
    announce,
    waitForAnalyzer,
    localConfigFile,
    editLocalConfig,
    writeLocalPath,
    localOrLive,
    requireProfile,
    imageModelLabel,
  };
}
