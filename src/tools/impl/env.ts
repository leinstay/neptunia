// The environment every operation runs against: the dependencies src/admin.js#createAdmin is
// given (see its JSDoc for each one) and the helpers several operations share -- the slash
// wording of a pointer to another command, the paused / no-guild refusals, the token
// resolver of analyzer text, the journal's system records and the config.local.json
// writers (under `hot.privateDir`, the deployment's private directory). Built once per admin; an operation reads it as `ctx.env`. Hot
// values are read at the moment of use, through `hot`, never copied.

import path from 'node:path';
import { fromTokens } from '../../memory/mentions.ts';
import { familyOf as imageFamilyOf } from '../../llm/images.js';
import { roleModel } from '../../llm/roles.js';
import { log } from '../../log.js';
import { invalid } from './registry.ts';
import { NO_GUILD, splitPath, setPath, ownValueAt, readLocalConfig, writeLocalConfig } from './shared.ts';
import { CODE } from '../codes.ts';

/**
 * The operations' environment over `deps` (src/admin.js#createAdmin's dependencies, the same
 * defaults): the dependencies themselves plus the shared helpers.
 * @param {object} deps
 * @param {import('../../interface/reads.ts').Reads|null} [deps.reads]  The core's reads of the interface.
 * @returns {object}
 */
export function createOpsEnv({
  hot,
  store,
  client,
  discord = null,
  reads = null,
  spontaneous,
  calibrator,
  getGuildId,
  turns,
  pending,
  images,
  speech = null,
  imageFetcher,
  emojiBackfill,
  gifBackfill,
  gifRecache,
  archive = null,
  journal,
  llm,
  embedder,
  embedQueue = null,
  memoryDb = null,
  record = null,
  metrics = null,
  lookup = null,
  recall = null,
  describer = null,
  usage = null,
  simKey = null,
  managementKey = null,
  port = null,
  errands = null,
  fetchImpl = null,
  intentions = null,
  inner = null,
  now = Date.now,
  // The data directory src/index.js resolved (src/paths.js); `<hot.rootDir>/data` when not given.
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

  /** A background job's skip reason as the owner reads it: the job's own `skips` first, then the
   * reasons every job shares (paused, no guild), else `fallback`. */
  function skipText(skips, reason, fallback) {
    if (Object.hasOwn(skips, String(reason))) return skips[reason];
    if (reason === 'paused') return pausedText();
    if (reason === 'no-guild') return NO_GUILD;
    return fallback;
  }

  /**
   * `/nep pause`: refuse a command that would write under `data/` while
   * paused, with a hint to resume first. Guards interject, initiate,
   * alias.add, alias.remove, lore.add, lore.remove, learned.add,
   * learned.remove, emoji.rescan, gifs.rescan, gifs.recache and draw (it counts against the image rail
   * in state.json).
   */
  function assertNotPaused() {
    if (store.state.data.paused) {
      throw Object.assign(new Error(pausedText()), { code: CODE.PAUSED });
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
    if (!guildId) throw Object.assign(new Error(NO_GUILD), { code: CODE.NO_GUILD });
    return guildId;
  }

  /** `nameOf` (a member's current stored name, or null) and `resolve` (`<@id>` -> `name (id:…)`,
   * an id with no stored name keeping its token) for this guild: the resolution every view of
   * analyzer-written text uses (src/memory/mentions.ts#fromTokens, mode `'analyzer'`). */
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

  /** config.local.json in the private directory the live config reads it from (`hot.privateDir`,
   * the checkout root unless set apart; a hot without one falls back to `hot.rootDir`). */
  function localConfigFile() {
    return path.join(hot.privateDir ?? hot.rootDir, 'config.local.json');
  }

  /** config.local.json passed through `edit` (object in, object out), written back, and the
   * config reloaded; the reload's outcome. Every config writer goes through here. */
  function editLocalConfig(edit) {
    const file = localConfigFile();
    writeLocalConfig(file, edit(readLocalConfig(file)));
    return hot.reloadConfig();
  }

  /** `value` written at `dottedPath` (or an array of keys, src/tools/impl/shared.ts#splitPath) of
   * config.local.json, then reloaded; the reload's outcome. */
  function writeLocalPath(dottedPath, value) {
    return editLocalConfig((local) => setPath(local, dottedPath, value));
  }

  /** The value at `dottedPath` as of the last write: config.local.json's when it holds the path,
   * else the live config's -- so a read right after a write sees it even a moment before the
   * reload lands. */
  function localOrLive(dottedPath) {
    const parts = splitPath(dottedPath, hot.config);
    const local = ownValueAt(readLocalConfig(localConfigFile()), parts);
    return local.found ? local.value : ownValueAt(hot.config, parts).value;
  }

  /** The stored profile of `userId`, or an Error `no profile for <id>`: a write command never
   * creates a profile for a member the persona has not met. */
  function requireProfile(guildId, userId) {
    const profile = store.getUser(guildId, userId);
    if (!profile) throw invalid(`no profile for ${userId}`, CODE.NOT_FOUND);
    return profile;
  }

  /** The drawing model (`models.base.drawing`) for status and model show, `-` when unset, flagged when src/llm/images.js
   * has no request mapping for its family (every generation would be refused). */
  function imageModelLabel(cfg) {
    const model = roleModel(cfg, 'drawing');
    if (!model) return '-';
    const family = (images?.familyOf ?? imageFamilyOf)(model);
    return family ? model : `${model} (unsupported family)`;
  }

  return {
    hot,
    store,
    client,
    // The Discord interface's capabilities object (src/index.js injects it): never imported here.
    discord,
    // The core's reads of the interface (src/interface/reads.ts): the conversation an operation posts in, a message's event.
    reads,
    spontaneous,
    calibrator,
    getGuildId,
    turns,
    pending,
    images,
    speech,
    imageFetcher,
    emojiBackfill,
    gifBackfill,
    gifRecache,
    archive,
    journal,
    llm,
    embedder,
    embedQueue,
    // /nep status: the memory database's state line (src/memory/db/service.js#status).
    memoryDb,
    record,
    metrics,
    // The web lookup: the status card's search line and `/nep task search` (src/tools/impl/search.ts).
    lookup,
    // The server search of the recall runner (src/behavior/recall-run.js): `/nep memory search`.
    recall,
    // The media describer (src/memory/describe.js): `/nep task look`, its second look.
    describer,
    usage,
    // The simulator key, read only by the status card's one GET of its limit; never logged.
    simKey,
    // The management key, read only by the status card's activity GETs; never logged.
    managementKey,
    port,
    // The persona's errands (src/errands/service.js): `/nep task`.
    errands,
    // The HTTP fetch a post's `media` download uses (default: the global fetch).
    fetchImpl,
    // The persona's intentions (src/intentions/service.js): `/nep task intent`.
    intentions,
    // The persona's inner life (src/behavior/inner.js): `/nep task inner`.
    inner,
    now,
    dataDir,
    connection,
    slash,
    pausedText,
    skipText,
    assertNotPaused,
    freshenIfPaused,
    resolvedGuildId,
    requireGuildId,
    tokenResolver,
    journalSystem,
    localConfigFile,
    editLocalConfig,
    writeLocalPath,
    localOrLive,
    requireProfile,
    imageModelLabel,
  };
}
