// How a request of a model role finds its key in `.env`: `llm.keyByRole` maps a role to the name of an `OPENROUTER_*_KEY`
// variable (or a list of names, the first the primary), the parsed `.env` holds the values, and the core's main key and
// its backup are the default. Used while a deployment has no `keys.json`; with one the key ring (src/keys/ring.ts) picks
// the key instead. Re-exported by src/llm/openrouter.ts, which the callers import. Names are logged, a value never is.

import { createHash } from 'node:crypto';
import { isPlainObject } from '../config.ts';
import { log } from '../log.ts';
import { objOf, scalarText } from '../tools/types.ts';
import type { KeyFailover } from './key-failover.ts';

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => isPlainObject(value);
const llmOf = (config: unknown): Rec => objOf(objOf(config).llm);

/** The only environment variable names `llm.keyByRole` may point at: a config typo never sends another secret to OpenRouter. */
export const ROLE_KEY_NAME = /^OPENROUTER_[A-Z0-9_]+$/;

/**
 * The model roles that never go out on the main key: an unset or blank variable gives an empty key (`roleApiKey`), and a
 * request of such a model role is refused before it is sent (`complete` throws `ROLE_KEY_MISSING`). Her memory session
 * (`memory`) spends its own key or nothing.
 */
export const STRICT_KEY_ROLES = Object.freeze(['memory']);

// The `llm.keyByRole` entries already reported as unusable in this process (by name).
const warnedRoleKeys = new Set<string>();

/** The core's variable names when `llm.keyByRole` does not map it: the main key, then the backup when it is set. */
/** The variable of the main key: the one every request without a key of its own goes out on. */
export const MAIN_KEY_NAME = 'OPENROUTER_CORE_KEY';
const DEFAULT_CORE_KEYS = Object.freeze([MAIN_KEY_NAME, 'OPENROUTER_CORE_BACKUP_KEY']);

type Env = Record<string, string | undefined> | null | undefined;

/** Whether `name` is an allowed variable name that `env` sets to something other than blank. */
function isSetName(env: Env, name: unknown): name is string {
  if (typeof name !== 'string' || !ROLE_KEY_NAME.test(name) || !env) return false;
  const value = env[name];
  return typeof value === 'string' && value.trim() !== '';
}

/** The `llm.keyByRole` entry of `role` as it stands in the map: undefined when the role is not mapped. */
function mappedEntry(config: unknown, role: unknown): unknown {
  const map = llmOf(config).keyByRole;
  return typeof role === 'string' && role && isRec(map) && Object.hasOwn(map, role) ? map[role] : undefined;
}

/**
 * The variable names a request of `role` may go out on, in order: `llm.keyByRole[role]` is one name or a list, and the
 * first is the primary. A name that fails `ROLE_KEY_NAME` or is unset or blank in `env` is left out. A `core` the map
 * does not name takes `OPENROUTER_CORE_KEY` then `OPENROUTER_CORE_BACKUP_KEY`, the ones that are set; any other
 * unmapped role has no list (`[]`: it is on the main key). Names only.
 */
export function roleKeyNames(config: unknown, env: Env, role: unknown): Array<string> {
  const entry = mappedEntry(config, role);
  if (entry === undefined) return role === 'core' ? DEFAULT_CORE_KEYS.filter((name) => isSetName(env, name)) : [];
  const names = Array.isArray(entry) ? entry : [entry];
  return [...new Set(names)].filter((name): name is string => isSetName(env, name));
}

/**
 * The OpenRouter key a request of `role` goes out on: the variable `llm.keyByRole[role]` names
 * (read from `env`, the parsed `.env`) when the name matches `ROLE_KEY_NAME` and the variable is
 * set and not blank, else `mainKey`. The map is read from `config` at the moment of use. A mapped
 * role that falls back logs `llm: role key missing` (role, name) once per name per process; a
 * name that is not a variable name is logged as null (it may be a pasted key). Never logs a value.
 * An entry that is a list, or a `core` with a backup variable set (`roleKeyNames`), resolves to the key
 * `failover` holds as the role's current one, else to the first set name. The one place a
 * request's key is chosen (chat completions, embeddings, the status card's reads).
 * @param role The request's `options.role`.
 * @param mainKey `OPENROUTER_CORE_KEY`.
 * @param failover The client's key choice; without it a list gives its first set key.
 */
export function roleApiKey(
  config: unknown,
  env: Env,
  role: unknown,
  mainKey: string,
  failover?: Pick<KeyFailover, 'current'>
): string {
  const fallback = typeof role === 'string' && STRICT_KEY_ROLES.includes(role) ? '' : mainKey;
  const entry = mappedEntry(config, role);
  if (typeof role !== 'string' || !role || (entry === undefined && role !== 'core')) return fallback;
  if (Array.isArray(entry) || entry === undefined) return listedKey({ config, env, role, entry, failover, fallback });
  const name = typeof entry === 'string' && ROLE_KEY_NAME.test(entry) ? entry : null;
  const value = name !== null && env ? env[name] : undefined;
  if (typeof value === 'string' && value.trim()) return value;
  warnMissing(role, name ?? scalarText(entry), name !== null);
  return fallback;
}

/**
 * The key of a role with a list (`entry` an array) or of an unmapped `core`: the list's current name, else the first set
 * name. An unmapped core with fewer than two set names, and a list with none set, fall back (the latter with a warning).
 */
function listedKey({
  config,
  env,
  role,
  entry,
  failover,
  fallback,
}: {
  config: unknown;
  env: Env;
  role: string;
  entry: unknown;
  failover?: Pick<KeyFailover, 'current'>;
  fallback: string;
}): string {
  const names = roleKeyNames(config, env, role);
  if (names.length >= (Array.isArray(entry) ? 1 : 2))
    return env?.[failover?.current(role, names) ?? names[0] ?? ''] ?? '';
  if (Array.isArray(entry)) warnMissing(role, entry.join(','), false);
  return fallback;
}

/** The one `llm: role key missing` line per name per process; `name` is logged only when it is a variable name. */
function warnMissing(role: string, name: string, valid: boolean): void {
  const seen = valid ? name : `bad:${name}`;
  if (warnedRoleKeys.has(seen)) return;
  warnedRoleKeys.add(seen);
  log.warn('llm: role key missing', { role, name: valid ? name : null });
}

/**
 * The SHA-256 hex digest of an API key: how OpenRouter's activity endpoint names a key
 * (`api_key_hash`), so the status card can ask for one key's spend without holding it.
 */
export function keyHashOf(key: string): string {
  return createHash('sha256').update(String(key)).digest('hex');
}

/**
 * The extra keys `llm.keyByRole` puts in use, one entry per distinct key other than `mainKey`
 * (a model role whose key falls back, or names the main key's value, stays on the main key), with the
 * roles on it sorted by name, in the order the map first names each key. For the status card.
 */
export function roleKeyGroups(
  config: unknown,
  env: Record<string, string | undefined> | null | undefined,
  mainKey: string
): Array<{ roles: Array<string>; apiKey: string }> {
  const map = llmOf(config).keyByRole;
  if (!isRec(map)) return [];
  const groups = new Map<string, Array<string>>();
  for (const role of Object.keys(map)) {
    const apiKey = roleApiKey(config, env, role, mainKey);
    if (apiKey === mainKey || !apiKey) continue;
    if (!groups.has(apiKey)) groups.set(apiKey, []);
    groups.get(apiKey)?.push(role);
  }
  return [...groups].map(([apiKey, roles]) => ({ roles: roles.sort(), apiKey }));
}
