// The environment every operation runs against: the dependencies src/admin.ts#createAdmin is
// given (see its JSDoc for each one) and the functions several operations share -- the slash
// wording of a pointer to another command, the paused / no-place refusals, the token
// resolver of analyzer text, the journal's system records and the writers of the private settings
// file (under `hot.privateDir`, the deployment's private directory). Built once per admin; an operation reads it as `ctx.env`. Hot
// values are read at the moment of use, through `hot`, never copied.

import { accountOf, chatOfPlace, topPlaceOf } from '../../memory/addresses.ts';
import path from 'node:path';
import { moveConfigKeys } from '../../config-moves.ts';
import { localConfigPath } from '../../config/files.ts';
import { fromTokens } from '../../memory/mentions.ts';
import { familyOf as imageFamilyOf } from '../../llm/images.ts';
import { roleModel } from '../../llm/roles.ts';
import { log } from '../../log.ts';
import { invalid } from './registry.ts';
import { PLACE_REQUIRED, splitPath, setPath, ownValueAt, readLocalConfig, writeLocalConfig } from './shared.ts';
import { CODE } from '../codes.ts';
import { idText, objOf } from '../types.ts';
import type { Untyped } from '../types.ts';
import type { Reads } from '../../interface/reads.ts';
import type { RoleHealth } from '../../llm/role-health.ts';
import type { BoardCaller } from './board.ts';
import type { SkillsAccess } from '../../skills/port.ts';
import type { ReportReader } from '../../watcher/read.ts';
import type { CardKeys } from '../../keys/card-keys.ts';

/** What `createOpsEnv` is given: the persona's subsystems, the reads of the interface and the clock. */
export type OpsDeps = {
  hot: Untyped;
  store: Untyped;
  /** The core's reads of the interface. */
  reads?: Reads | null;
  /** The persona's own member id, null before the interface has said it. */
  selfId?: () => string | null;
  /** The name the persona goes by in a root. */
  getSelfName?: (placeId: string | null) => string;
  /** A member's name in the member directory. */
  memberNameOf?: (placeId: string, accountId: string) => string | null;
  /** The chats the interface reported, and the direct chat it saw with a member. */
  directory?: {
    isDm: (chatId: string) => boolean;
    dmChatOf?: (partnerId: string) => string | null;
  };
  /** When the interface's link to its platform last came back (the core fills it from `connection.changed`). */
  connection?: { lastReconnectAt: number | null };
  now?: () => number;
  dataDir?: string | null;
  /** Which model roles are down (src/llm/role-health.ts), shared with the turn runner. */
  roleHealth?: RoleHealth | null;
  /** The task board her board tools file on and read (src/board/writer.ts#createBoardPort); null when there is none. */
  board?: BoardCaller | null;
  /** Her skills (src/skills/port.ts) that `skill.read` and `skill.disable` use; null when the core has none. */
  skills?: SkillsAccess | null;
  /** The watcher's reports (src/watcher/read.ts) that `watcher.read` answers; null when the core has none. */
  watcher?: ReportReader | null;
  /**
   * The status card's two keys read at the moment of the card (src/keys/card-keys.ts); when given, it stands in for
   * `simKey` and `managementKey`.
   */
  cardKeys?: (() => CardKeys) | null;
  [subsystem: string]: Untyped;
};

/**
 * The operations' environment over `deps` (src/admin.ts#createAdmin's dependencies, the same
 * defaults): the dependencies themselves plus the shared functions.
 */
function buildEnv({
  hot,
  store,
  reads = null,
  selfId = () => null,
  getSelfName = () => '',
  memberNameOf = () => null,
  directory = { isDm: () => false },
  connection = { lastReconnectAt: null },
  calibrator,
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
  cardKeys = null,
  port = null,
  errands = null,
  fetchImpl = null,
  intentions = null,
  inner = null,
  board = null,
  skills = null,
  watcher = null,
  now = Date.now,
  // The data directory src/index.ts resolved (src/paths.ts); `<hot.rootDir>/data` when not given.
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
   * reasons every job shares (paused, no place), else `fallback`. */
  function skipText(skips: Record<string, string>, reason: unknown, fallback: string): string {
    const known = skips[idText(reason)];
    if (Object.hasOwn(skips, idText(reason)) && known !== undefined) return known;
    if (reason === 'paused') return pausedText();
    if (reason === 'no-place') return PLACE_REQUIRED;
    return fallback;
  }

  /**
   * `/nep pause`: refuse a command that would write under `data/` while
   * paused, with a hint to resume first. Guards message.create,
   * alias.add, alias.remove, lore.add, lore.remove, learned.add,
   * learned.remove, emoji.rescan, gifs.rescan, gifs.recache and draw (it counts against the image rail
   * in state.json).
   */
  /** Whether state.json holds the pause flag (`/nep pause`), read at the call. */
  function isPausedNow(): boolean {
    const { data } = store.state;
    return Boolean(data.paused);
  }

  function assertNotPaused(): void {
    if (isPausedNow()) {
      throw Object.assign(new Error(pausedText()), { code: CODE.PAUSED });
    }
  }

  /**
   * A read-only command must see a hand-edit made while paused, even a
   * second one made between two calls of the same command -- `dropCaches`
   * only drops what a WRITE would otherwise dirty (users/place/channels/lore
   * /media/buffer), so this is safe to call before every read while paused.
   * A no-op when not paused, so callers can call it unconditionally.
   */
  function freshenIfPaused(): void {
    if (isPausedNow() && typeof store.dropCaches === 'function') store.dropCaches();
  }

  /**
   * The place whose shared collections the operation reads and writes: the top of the place it runs in
   * (`store.rootPlaceOf`), so a channel and a thread of a server share its lore, and a DM is its own top. The place as
   * given when the store holds no tree for it; null with none.
   */
  function resolvedPlaceId(context: { placeId?: string | null } | null | undefined): string | null {
    const placeId = context?.placeId ?? null;
    return placeId ? topPlaceOf(store, placeId) : null;
  }

  /**
   * The native chat of the place an operation runs in, for a call that speaks to the interface
   * (src/memory/addresses.ts#chatOfPlace, a DM's chat from the directory); null with no place.
   */
  function chatOf(context: { placeId?: string | null } | null | undefined): string | null {
    const placeId = context?.placeId ?? null;
    return placeId ? chatOfPlace(store, placeId, directory.dmChatOf ?? null) : null;
  }

  /** The place the operation addresses, or an Error with none. */
  function requirePlaceId(context: { placeId?: string | null } | null | undefined): string {
    const placeId = resolvedPlaceId(context);
    if (!placeId) throw Object.assign(new Error(PLACE_REQUIRED), { code: CODE.PLACE_REQUIRED });
    return placeId;
  }

  /** `nameOf` (a member's current stored name, or null) and `resolve` (`<@id>` -> `name (id:…)`,
   * an id with no stored name keeping its token) for this place: the resolution every view of
   * analyzer-written text uses (src/memory/mentions.ts#fromTokens, mode `'analyzer'`). */
  function tokenResolver(): {
    nameOf: (id: string) => string | null;
    resolve: (text: unknown) => string;
  } {
    const nameOf = (id: string): string | null =>
      (store.getUser(accountOf(store, id))?.names?.[0] as string | undefined) ?? null;
    const resolve = (text: unknown): string => fromTokens(typeof text === 'string' ? text : '', nameOf, 'analyzer');
    return { nameOf, resolve };
  }

  /** A `system` journal record of the persona; never throws. */
  async function journalSystem(record: unknown): Promise<void> {
    if (!journal) return;
    try {
      await journal.system(record);
    } catch (err) {
      log.warn('admin: journal record failed', { code: objOf(err).code ?? null });
    }
  }

  /** The private settings file the live config reads (src/config/files.ts#localConfigPath) in the private directory
   * (`hot.privateDir`, the checkout root unless set apart; a hot without one falls back to `hot.rootDir`). */
  function localConfigFile(): string {
    return localConfigPath((hot.privateDir ?? path.join(hot.rootDir as string, 'data')) as string);
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

  /** The stored profile of `accountId`, or an Error `no profile for <id>`: a write command never
   * creates a profile for a member the persona has not met. */
  function requireProfile(placeId: string, accountId: string): Untyped {
    const profile = store.getUser(accountOf(store, accountId));
    if (!profile) throw invalid(`no profile for ${accountId}`, CODE.NOT_FOUND);
    return profile;
  }

  /** The drawing model (`models.base.drawing`) for status and model show, `-` when unset, flagged when src/llm/images.ts
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
    // The chats the interface reported (`directory.isDm`).
    directory,
    // The core's reads of the interface (src/interface/reads.ts): the chat an operation posts in, a message's event.
    reads,
    calibrator,
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
    // /nep status: the memory database's state line (src/memory/db/service.ts#status).
    memoryDb,
    record,
    metrics,
    // The web lookup: the status card's search line and `/nep task search` (src/tools/impl/search.ts).
    lookup,
    // The server search of the recall runner (src/behavior/recall-run.ts): `/nep memory search`.
    recall,
    // The media describer (src/memory/describe.ts): `/nep task look`, its second look.
    describer,
    usage,
    // The simulator key, read only by the status card's one GET of its limit; never logged.
    get simKey(): string | null {
      return cardKeys ? cardKeys().simKey : (simKey as string | null);
    },
    // The management key, read only by the status card's activity GETs; never logged.
    get managementKey(): string | null {
      return cardKeys ? cardKeys().managementKey : (managementKey as string | null);
    },
    port,
    // The persona's errands (src/errands/service.ts): `/nep task`.
    errands,
    // The HTTP fetch a post's `media` download uses (default: the global fetch).
    fetchImpl,
    // The persona's intentions (src/intentions/service.ts): `/nep task intent`.
    intentions,
    // The persona's inner life (src/behavior/inner.ts): `/nep task inner`.
    inner,
    // The selfreflection's publisher (src/behavior/mirror.ts): what she writes to her selfreflection with message.create is held there.
    // The task board (src/tools/impl/board.ts): `task.propose` and `task.status`, and the status card's agent costs.
    board,
    // Her skills (src/tools/impl/skill.ts): `skill.read` and `skill.disable`.
    skills,
    // The watcher's reports (src/tools/impl/watcher.ts): `watcher.read`.
    watcher,
    now,
    dataDir,
    connection,
    slash,
    pausedText,
    skipText,
    assertNotPaused,
    freshenIfPaused,
    resolvedPlaceId,
    chatOf,
    requirePlaceId,
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

/** The operations' environment over `deps` (src/admin.ts#createAdmin's dependencies): the dependencies plus the shared functions. */
export function createOpsEnv(deps: OpsDeps): Env {
  return buildEnv(deps);
}
