// Configuration combines engine defaults with the canonical persona data/config layer. Targeted writes and hot
// reload use the same paths. Environment parsing remains available to explicit migration and tooling callers;
// runtime service credentials stay in keys.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.ts';
import { resolvePaths } from './paths.ts';
import { localFiles, trackedConfigPath } from './config/files.ts';
// A parsed JSON value or an argument no module types yet: the alias of src/tools/types.ts, restated so this leaf
// imports nothing from src/tools/ (src/memory/ reaches it).
type Untyped = ReturnType<typeof JSON.parse>;

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parse the contents of a .env file into a plain object of string values.
 * Supports blank lines, full-line `#` comments, unquoted values (with an
 * optional trailing ` # comment`), and single/double quoted values.
 * Double-quoted values support \n, \r and \" escapes; single-quoted values
 * are taken literally. Only the first `=` on a line separates key from value,
 * so values may themselves contain `=`.
 */
export function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
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
export function applyEnv(parsed: Record<string, string>, target = process.env): NodeJS.ProcessEnv {
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in target)) target[key] = value;
  }
  return target;
}

/**
 * Whether `value` is a plain object (not null, not an array). The one copy
 * of this predicate: config merging, stored-state normalisers and the
 * OpenRouter routing blocks all import it from here.
 */
export function isPlainObject(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep-merge `override` onto `base`. Arrays and scalars in `override` fully
 * replace the corresponding value in `base`; plain objects are merged key by
 * key, recursively.
 */
export function deepMerge(base: Untyped, override: Untyped): Untyped {
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
 */
export function resolveEnvRefs(
  value: unknown,
  env: Record<string, string | undefined> = process.env,
  onUnset: (name: string) => void = () => {}
): unknown {
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
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      result[key] = resolveEnvRefs(item, env, onUnset);
    return result;
  }
  return value;
}

/** The unset names `${env:NAME}` references were already warned about in this process. */
const warnedUnsetEnvRefs = new Set();

/** One warning per unset name per process: the name only, never a value. */
function warnUnsetEnvRef(name: string) {
  if (warnedUnsetEnvRefs.has(name)) return;
  warnedUnsetEnvRefs.add(name);
  log.warn('config: env ref unset', { name });
}

/**
 * Read config/config.json merged with the private settings file, then every `${env:NAME}` in a string value
 * replaced from process.env (`resolveEnvRefs`; an unset name becomes '' and is warned about once
 * per process). Throws on invalid JSON and on a private settings file at both its places. config/config.json comes
 * from `rootDir`, the private file from `privateDir` (the deployment's private directory, src/paths.ts), which
 * defaults to `rootDir`: `data/config/config.json` (src/config/files.ts).
 */
export function readConfig(
  rootDir: string = ROOT_DIR,
  { privateDir = resolvePaths({ rootDir }).dataDir }: { privateDir?: string } = {}
): Record<string, unknown> {
  // The merged files are a plain object; resolveEnvRefs hands back the shape it was given.
  return resolveEnvRefs(mergeConfigFiles(rootDir, privateDir), process.env, warnUnsetEnvRef) as Record<string, unknown>;
}

/** `<rootDir>/config/config.json` deep-merged with the private settings file, env references unresolved. */
function mergeConfigFiles(rootDir: Untyped, privateDir: Untyped) {
  const base = JSON.parse(fs.readFileSync(trackedConfigPath(rootDir), 'utf8'));
  const localPath = localFiles(privateDir).config;
  if (localPath === null) return base;
  const raw = fs.readFileSync(localPath, 'utf8').trim();
  if (!raw) return base;
  const local: unknown = JSON.parse(raw);
  return deepMerge(base, local);
}

export const env = process.env;

/** Return env[key], throwing an Error whose message is exactly `key` if unset/empty. */
export function need(key: Untyped): string {
  const value = env[key];
  if (value === undefined || value === '') throw new Error(key);
  return value;
}
