// The memory's paths under `data/` in one place: the operational files and the names of the memory database's units
// (a unit is named by the path it had under data/). The stores (store.js, record.js, journal.js, archive.js,
// vectors.js) take a `dataDir` and ask `memoryRootOf(dataDir)`. The full layout is the header comment of store.js.
//
// Only the memory's own paths live here: the other owners under `data/` (errands' tasks,
// usage.json, metrics.json, the media caches, recall-eval) are not memory and keep theirs.
//
// Pure: no I/O, every value is a path computed from `dataDir`.

import path from 'node:path';

/** `memory.vaultDir` when it is missing (config.json carries the same). */
export const DEFAULT_VAULT_DIR = 'vault';
/** The directory under `data/` `/nep memory snapshot` writes to (src/tools/impl/memory.ts). */
export const SNAPSHOTS_DIR = 'snapshots';

/**
 * The memory's paths under one `data/` directory (or a snapshot of one).
 * @param {string} dataDir
 */
export function memoryRootOf(dataDir) {
  const guildsDir = path.join(dataDir, 'guilds');
  /** `<dataDir>/guilds/<guildId>`. */
  const guildDir = (guildId) => path.join(guildsDir, String(guildId));
  /** `<guildDir>/private`, or `<guildDir>/private/<userId>` when a member is given. */
  const privateDir = (guildId, userId = null) =>
    userId === null || userId === undefined || userId === ''
      ? path.join(guildDir(guildId), 'private')
      : path.join(guildDir(guildId), 'private', String(userId));
  return {
    dataDir,
    /** `<dataDir>/guilds`: every guild's directory is below it. */
    guildsDir,
    guildDir,
    /** `<dataDir>/state.json`. */
    stateFile: path.join(dataDir, 'state.json'),
    /** `<guildDir>/record`, or `<guildDir>/private/<userId>/record` for a private chat's record. */
    recordDir: (guildId, privateUserId = null) =>
      typeof privateUserId === 'string' && privateUserId
        ? path.join(privateDir(guildId, privateUserId), 'record')
        : path.join(guildDir(guildId), 'record'),
    privateDir,
    /** `<dataDir>/snapshots`. */
    snapshotsRoot: path.join(dataDir, SNAPSHOTS_DIR),
    /** The vault directory: `configured` (`memory.vaultDir`) under `data/`, or as given when absolute. */
    vaultDir: (configured) =>
      path.resolve(dataDir, typeof configured === 'string' && configured.trim() ? configured : DEFAULT_VAULT_DIR),
    /** `rel` resolved against `dataDir` (a path stored relative to it, such as a forget marker's vault). */
    resolve: (rel) => path.resolve(dataDir, rel),
    /** `abs` relative to `dataDir`, forward-slash separated (stable across platforms). */
    relative: (abs) => path.relative(dataDir, abs).split(path.sep).join('/'),
  };
}
