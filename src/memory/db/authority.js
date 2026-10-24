// Who writes the memory (spec 2026-10-24-memory-authority, section 6 item 1): `memoryDb.authority`, `json` (the JSON
// files, the default) or `db` (the memory database). One home for the rule, so the service, the offline tools and the
// tests read it the same way. Pure: no I/O.
//
//   configAuthority(config)       'db' when `memoryDb.authority` is exactly 'db', else 'json'
//   authorityRefusal(config)      the code that keeps the service from opening the memory under the config's
//                                 authority, or null. Under `db` the database is the only memory, so every reader and
//                                 the live observation path must use it: `memoryDb.read` exactly true
//                                 (`READ_OFF`), `recall.backend` 'db' (`RECALL_NOT_DB`), `memoryDb.observeLive` exactly
//                                 true (`OBSERVE_OFF`), and her memory session's `memoryDb.session.mode` `apply` or
//                                 `off` (missing: `off`), never `shadow` (`SESSION_SHADOW`, stage W2b: shadow
//                                 decisions would read a store nobody else writes; any other value is refused the same
//                                 way). The sync is off under `db` by construction (the service never runs a pass, the
//                                 worker refuses one). Under `json` nothing is refused here: her
//                                 session's `apply` stays refused by its writer (session-write.js, APPLY_JSON_WRITER).
//   toolRefusal(config, tool)     the message an offline tool that mutates `data/` prints and exits with under `db`
//                                 (it would write files nobody reads), or null under `json`. `export`, `backup` and
//                                 `restore` of tools/memory-db.mjs never ask.

/** The authorities. */
export const AUTHORITIES = Object.freeze(['json', 'db']);

/** The refusal codes of `authorityRefusal`. */
export const AUTHORITY_CODES = Object.freeze({ READ_OFF: 'READ_OFF', RECALL_NOT_DB: 'RECALL_NOT_DB', OBSERVE_OFF: 'OBSERVE_OFF', SESSION_SHADOW: 'SESSION_SHADOW' });

/**
 * The authority a config names.
 * @param {object|null|undefined} config
 * @returns {'json'|'db'}
 */
export function configAuthority(config) {
  return config?.memoryDb?.authority === 'db' ? 'db' : 'json';
}

/**
 * Why the memory may not start under the config's authority (see the head of this file), or null.
 * @param {object|null|undefined} config
 * @returns {string|null}
 */
export function authorityRefusal(config) {
  if (configAuthority(config) !== 'db') return null;
  if (config?.memoryDb?.read !== true) return AUTHORITY_CODES.READ_OFF;
  if (config?.recall?.backend !== 'db') return AUTHORITY_CODES.RECALL_NOT_DB;
  if (config?.memoryDb?.observeLive !== true) return AUTHORITY_CODES.OBSERVE_OFF;
  const mode = config?.memoryDb?.session?.mode ?? 'off';
  if (mode !== 'apply' && mode !== 'off') return AUTHORITY_CODES.SESSION_SHADOW;
  return null;
}

/**
 * The refusal of an offline tool that would write memory files, or null when it may run.
 * @param {object|null|undefined} config
 * @param {string} tool  the tool's name, for the message
 * @returns {string|null}
 */
export function toolRefusal(config, tool) {
  if (configAuthority(config) !== 'db') return null;
  return `${tool}: memoryDb.authority is db, the memory files are no longer read; this command would write them, so it does not run`;
}
