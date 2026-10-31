// The environment every operation runs against: the dependencies src/admin.js#createAdmin is
// given (see its JSDoc for each one) and the functions several operations share -- the slash
// wording of a pointer to another command, the paused / no-guild refusals, the token
// resolver of analyzer text, the journal's system records and the writers of the private settings
// file (under `hot.privateDir`, the deployment's private directory). Built once per admin; an operation reads it as `ctx.env`. Hot
// values are read at the moment of use, through `hot`, never copied.

import path from 'node:path';
import { moveConfigKeys } from '../../config-moves.ts';
import { localConfigPath } from '../../config/files.ts';
import { fromTokens } from '../../memory/mentions.ts';
import { familyOf as imageFamilyOf } from '../../llm/images.js';
import { roleModel } from '../../llm/roles.js';
import { log } from '../../log.js';
import { invalid } from './registry.ts';
import { NO_GUILD, splitPath, setPath, ownValueAt, readLocalConfig, writeLocalConfig } from './shared.ts';
import { CODE } from '../codes.ts';
import { idText, objOf } from '../types.ts';
import type { Untyped } from '../types.ts';
import type { Reads } from '../../interface/reads.ts';
import type { RoleHealth } from '../../llm/role-health.ts';
import type { BoardCaller } from './board.ts';

/** What `createOpsEnv` is given: the persona's subsystems, the reads of the interface and the clock. */
export type OpsDeps = {
  hot: Untyped;
  store: Untyped;
  /** The core's reads of the interface. */
  reads?: Reads | null;
  /** The persona's own member id, null before the interface has said it. */
  selfId?: () => string | null;
  /** The name the persona goes by in a community. */
  getSelfName?: (communityId: string | null) => string;
  /** A member's name in the member directory. */
  memberNameOf?: (communityId: string, memberId: string) => string | null;
  /** The conversations the interface reported. */
  directory?: { isPrivate: (conversationId: string) => boolean };
  /** When the interface's link to its platform last came back (the core fills it from `connection.changed`). */
  connection?: { lastReconnectAt: number | null };
  now?: () => number;
  dataDir?: string | null;
  /** Which model roles are down (src/llm/role-health.ts), shared with the turn runner. */
  roleHealth?: RoleHealth | null;
  /** The task board her board tools file on and read (src/board/writer.ts#createBoardPort); null when there is none. */
  board?: BoardCaller | null;
  [subsystem: string]: Untyped;
};

/**
 * The operations' environment over `deps` (src/admin.js#createAdmin's dependencies, the same
 * defaults): the dependencies themselves plus the shared functions.
 */
function buildEnv({
  hot,
  store,
  reads = null,
  selfId = () => null,
  getSelfName = () => '',
  memberNameOf = () => null,
  directory = { isPrivate: () => false },
  connection = { lastReconnectAt: null },
  spontaneous,
  calibrator,
  getGuildId,
  turns,
  pending,
  images,
  speech = null,
  roleHealth = null,
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
  mirrors = null,
  board = null,
  now = Date.now,
  // The data directory src/index.js resolved (src/paths.js); `<hot.rootDir>/data` when not given.
  dataDir = hot?.rootDir ? path.join(hot.rootDir as string, 'data') : null,
}: OpsDeps) {
  /** `/<rest>`: every reply that points the owner at a command of the chat (src/interface/commands/table.ts). */
  function slash(rest: string): string {
    return `/${rest}`;
  }

  /** The refusal of a data/ write while paused. */
  function pausedText(): string {
    return `paused -- run ${slash('resume')} first`;
  }

  /** A background job's skip reason as the owner reads it: the job's own `skips` first, then the
   * reasons every job shares (paused, no guild), else `fallback`. */
  function skipText(skips: Record<string, string>, reason: unknown, fallback: string): string {
    const known = skips[idText(reason)];
    if (Object.hasOwn(skips, idText(reason)) && known !== undefined) return known;
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
  function assertNotPaused(): void {
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
  function freshenIfPaused(): void {
    if (store.state.data.paused && typeof store.dropCaches === 'function') store.dropCaches();
  }

  /** The served guild: the interaction's, else the one this instance resolved; null before then. */
  function resolvedGuildId(context: { guildId?: string | null } | null | undefined): string | null {
    return context?.guildId ?? (getGuildId?.() as string | null | undefined) ?? null;
  }

  /** The served guild, or an Error before it resolves. */
  function requireGuildId(context: { guildId?: string | null } | null | undefined): string {
    const guildId = resolvedGuildId(context);
    if (!guildId) throw Object.assign(new Error(NO_GUILD), { code: CODE.NO_GUILD });
    return guildId;
  }

  /** `nameOf` (a member's current stored name, or null) and `resolve` (`<@id>` -> `name (id:…)`,
   * an id with no stored name keeping its token) for this guild: the resolution every view of
   * analyzer-written text uses (src/memory/mentions.ts#fromTokens, mode `'analyzer'`). */
  function tokenResolver(guildId: string): {
    nameOf: (id: string) => string | null;
    resolve: (text: unknown) => string;
  } {
    const nameOf = (id: string): string | null =>
      (store.getUser(guildId, id)?.names?.[0] as string | undefined) ?? null;
    const resolve = (text: unknown): string => fromTokens(typeof text === 'string' ? text : '', nameOf, 'analyzer');
    return { nameOf, resolve };
  }

  /** A `system` journal record of `guildId` (features.journal exactly true, read now); never throws. */
  async function journalSystem(guildId: string | null, record: unknown): Promise<void> {
    if (!journal || !guildId || hot.config?.features?.journal !== true) return;
    try {
      await journal.system(guildId, record);
    } catch (err) {
      log.warn('admin: journal record failed', { code: objOf(err).code ?? null, guildId });
    }
  }

  /** The private settings file the live config reads (src/config/files.ts#localConfigPath) in the private directory
   * (`hot.privateDir`, the checkout root unless set apart; a hot without one falls back to `hot.rootDir`). */
  function localConfigFile(): string {
    return localConfigPath((hot.privateDir ?? hot.rootDir) as string);
  }

  /** the private settings file with its keys of an old name written under their new one (src/config-moves.ts), as the
   * loader reads it: a command that read the raw file would add a key under the new name beside the old one, and the
   * next load would let the new one win. */
  function settledLocalConfig(file: string): Untyped {
    return moveConfigKeys(readLocalConfig(file)).config as Untyped;
  }

  /** the private settings file, settled, passed through `edit` (object in, object out), written back, and the
   * config reloaded; the reload's outcome. Every config writer goes through here. */
  function editLocalConfig(edit: (local: Untyped) => unknown): boolean {
    const file = localConfigFile();
    writeLocalConfig(file, edit(settledLocalConfig(file)));
    return hot.reloadConfig() as boolean;
  }

  /** `value` written at `dottedPath` (or an array of keys, src/tools/impl/shared.ts#splitPath) of
   * the private settings file, then reloaded; the reload's outcome. */
  function writeLocalPath(dottedPath: string | ReadonlyArray<string>, value: unknown): boolean {
    return editLocalConfig((local) => setPath(local, dottedPath, value));
  }

  /** The value at `dottedPath` as of the last write: the private settings file's when it holds the path,
   * else the live config's -- so a read right after a write sees it even a moment before the
   * reload lands. */
  function localOrLive(dottedPath: string | ReadonlyArray<string>): unknown {
    const parts = splitPath(dottedPath, hot.config);
    const local = ownValueAt(settledLocalConfig(localConfigFile()), parts);
    return local.found ? local.value : ownValueAt(hot.config, parts).value;
  }

  /** The stored profile of `userId`, or an Error `no profile for <id>`: a write command never
   * creates a profile for a member the persona has not met. */
  function requireProfile(guildId: string, userId: string): Untyped {
    const profile = store.getUser(guildId, userId);
    if (!profile) throw invalid(`no profile for ${userId}`, CODE.NOT_FOUND);
    return profile;
  }

  /** The drawing model (`models.base.drawing`) for status and model show, `-` when unset, flagged when src/llm/images.js
   * has no request mapping for its family (every generation would be refused). */
  function imageModelLabel(cfg: object): string {
    const model = roleModel(cfg, 'drawing');
    if (!model) return '-';
    const family = (images?.familyOf ?? imageFamilyOf)(model);
    return family ? model : `${model} (unsupported family)`;
  }

  return {
    hot,
    store,
    // The persona's own member id and the name she goes by (the interface's `hello`, the member directory).
    selfId,
    getSelfName,
    memberNameOf,
    // The conversations the interface reported (`directory.isPrivate`).
    directory,
    // The core's reads of the interface (src/interface/reads.ts): the conversation an operation posts in, a message's event.
    reads,
    spontaneous,
    calibrator,
    getGuildId,
    turns,
    pending,
    images,
    speech,
    // Which model roles are down (src/llm/role-health.ts): `voice.say` routes on it.
    roleHealth,
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
    // The persona's errands (src/errands/service.ts): `/nep task`.
    errands,
    // The HTTP fetch a post's `media` download uses (default: the global fetch).
    fetchImpl,
    // The persona's intentions (src/intentions/service.ts): `/nep task intent`.
    intentions,
    // The persona's inner life (src/behavior/inner.ts): `/nep task inner`.
    inner,
    // The diary's publisher (src/behavior/mirror.ts): what she writes to her diary with message.create is held there.
    mirrors: mirrors as unknown,
    // The task board (src/tools/impl/board.ts): `board.propose` and `board.status`, and the status card's agent costs.
    board,
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

/** The environment an operation runs against: what `createOpsEnv` builds. */
export type Env = ReturnType<typeof buildEnv>;

/** The operations' environment over `deps` (src/admin.js#createAdmin's dependencies): the dependencies plus the shared functions. */
export function createOpsEnv(deps: OpsDeps): Env {
  return buildEnv(deps);
}
