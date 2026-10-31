// Loads .env (simple KEY=VALUE parser — not the `dotenv` package) into
// process.env without overriding already-set variables, and reads
// config/config.json (+ the optional private settings file, deep-merged) for non-secret
// settings. Secrets are read once at startup; the JSON config is re-read by
// src/hot.js whenever the files change, so nothing here caches it. Every string value of the merged config may reference an
// environment variable as `${env:NAME}` (`resolveEnvRefs`), so a value that holds credentials
// (e.g. `media.video.proxy`) can stay in .env.
// config/config.json is read from the checkout; config.local/config.json (or config.local.json of the old layout,
// src/config/files.ts) and .env from the deployment's private directory (src/paths.js: NEPTUNIA_PRIVATE_DIR), which
// is the root unless set.
// Pure functions (parseEnv, applyEnv, deepMerge, resolveEnvRefs) are exported separately so they
// can be unit-tested without touching the filesystem.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';
import { moveConfigKeys } from './config-moves.ts';
import { localFiles, trackedConfigPath } from './config/files.ts';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parse the contents of a .env file into a plain object of string values.
 * Supports blank lines, full-line `#` comments, unquoted values (with an
 * optional trailing ` # comment`), and single/double quoted values.
 * Double-quoted values support \n, \r and \" escapes; single-quoted values
 * are taken literally. Only the first `=` on a line separates key from value,
 * so values may themselves contain `=`.
 */
export function parseEnv(content) {
  const result = {};
  const lines = String(content).split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();

    if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"');
    } else if (value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'") {
      value = value.slice(1, -1);
    } else {
      const hashIdx = value.indexOf(' #');
      if (hashIdx !== -1) value = value.slice(0, hashIdx);
      value = value.trim();
    }

    result[key] = value;
  }

  return result;
}

/**
 * Copy parsed .env values onto `target` (defaults to process.env), skipping
 * any key that is already present so real environment variables always win.
 */
export function applyEnv(parsed, target = process.env) {
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in target)) target[key] = value;
  }
  return target;
}

/**
 * Whether `value` is a plain object (not null, not an array). The one copy
 * of this predicate: config merging, stored-state normalisers and the
 * OpenRouter routing blocks all import it from here.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep-merge `override` onto `base`. Arrays and scalars in `override` fully
 * replace the corresponding value in `base`; plain objects are merged key by
 * key, recursively.
 */
export function deepMerge(base, override) {
  if (override === undefined) return base;
  if (isPlainObject(base) && isPlainObject(override)) {
    const result = { ...base };
    for (const key of Object.keys(override)) {
      result[key] = deepMerge(base[key], override[key]);
    }
    return result;
  }
  return override;
}

/** `${env:NAME}` inside a config string: NAME as a .env key may spell it. */
const ENV_REF_RE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * `value` with every `${env:NAME}` inside each string replaced by `env[NAME]`, walking plain
 * objects and arrays (keys stay as they are). An unset name (undefined in `env`) becomes an
 * empty string and is passed to `onUnset` at each occurrence; a name set to an empty string is
 * not reported. Strings without a reference and non-string values come back as they are. Pure:
 * `value` is never mutated.
 * @param {unknown} value
 * @param {Record<string, string | undefined>} [env]
 * @param {(name: string) => void} [onUnset]
 * @returns {unknown}
 */
export function resolveEnvRefs(value, env = process.env, onUnset = () => {}) {
  if (typeof value === 'string') {
    if (!value.includes('${env:')) return value;
    return value.replace(ENV_REF_RE, (_, name) => {
      const found = env[name];
      if (found === undefined) {
        onUnset(name);
        return '';
      }
      return String(found);
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveEnvRefs(item, env, onUnset));
  if (isPlainObject(value)) {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = resolveEnvRefs(item, env, onUnset);
    return result;
  }
  return value;
}

/** The unset names `${env:NAME}` references were already warned about in this process. */
const warnedUnsetEnvRefs = new Set();

/** One warning per unset name per process: the name only, never a value. */
function warnUnsetEnvRef(name) {
  if (warnedUnsetEnvRefs.has(name)) return;
  warnedUnsetEnvRefs.add(name);
  log.warn('config: env ref unset', { name });
}

/**
 * Load `<privateDir>/.env` into process.env (no-op when the file is absent). `privateDir` is the
 * deployment's private directory (src/paths.js), the checkout root by default.
 * @param {string} [privateDir]
 */
export function loadDotEnv(privateDir = ROOT_DIR) {
  const file = path.join(privateDir, '.env');
  if (!fs.existsSync(file)) return;
  applyEnv(parseEnv(fs.readFileSync(file, 'utf8')));
}

/**
 * Read config/config.json merged with the private settings file, then every `${env:NAME}` in a string value
 * replaced from process.env (`resolveEnvRefs`; an unset name becomes '' and is warned about once
 * per process). Throws on invalid JSON and on a private settings file at both its places. config/config.json comes
 * from `rootDir`, the private file from `privateDir` (the deployment's private directory, src/paths.js), which
 * defaults to `rootDir`: `config.local/config.json`, or `config.local.json` of the old layout (src/config/files.ts).
 * @param {string} [rootDir]
 * @param {{ privateDir?: string }} [options]
 * @returns {object}
 */
export function readConfig(rootDir = ROOT_DIR, { privateDir = rootDir } = {}) {
  return resolveEnvRefs(mergeConfigFiles(rootDir, privateDir), process.env, warnUnsetEnvRef);
}

/** `<rootDir>/config/config.json` deep-merged with the private settings file, env references unresolved. */
function mergeConfigFiles(rootDir, privateDir) {
  const base = JSON.parse(fs.readFileSync(trackedConfigPath(rootDir), 'utf8'));
  const localPath = localFiles(privateDir).config;
  if (localPath === null) return base;
  const raw = fs.readFileSync(localPath, 'utf8').trim();
  if (!raw) return base;
  /** @type {unknown} */
  const local = JSON.parse(raw);
  return deepMerge(base, movedLocal(local));
}

/**
 * The local file with its keys of an earlier name written under their new one (src/config-moves.ts), one warning line
 * per load when any moved, lost to a key of the new name or was dropped. The file itself is untouched: `tools/config-migrate.mjs`
 * writes the same moves into it.
 * @param {unknown} local
 * @returns {unknown}
 */
function movedLocal(local) {
  if (typeof local !== 'object' || local === null || Array.isArray(local)) return local;
  const { config, moved, shadowed, dropped } = moveConfigKeys(/** @type {Record<string, unknown>} */ (local));
  if (moved.length > 0 || shadowed.length > 0 || dropped.length > 0)
    log.warn('config: keys of an old name read under the new one', {
      moved: moved.length,
      shadowed: shadowed.length,
      dropped: dropped.length,
      migrate: 'tools/config-migrate.mjs',
    });
  return config;
}

export const env = process.env;

/** Return env[key], throwing an Error whose message is exactly `key` if unset/empty. */
export function need(key) {
  const value = env[key];
  if (value === undefined || value === '') throw new Error(key);
  return value;
}
