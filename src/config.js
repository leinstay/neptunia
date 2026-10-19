// Loads .env (simple KEY=VALUE parser — not the `dotenv` package) into
// process.env without overriding already-set variables, and reads
// config.json (+ optional config.local.json, deep-merged) for non-secret
// settings. Secrets are read once at startup; the JSON config is re-read by
// src/hot.js whenever the files change, so nothing here caches it. The model keys a
// config.local.json may still carry from before the model roles are read under their new
// names (`adaptLegacyModelKeys`: the old model keys, and the `models.base` section before
// `models.core` / `models.helpers`, 2026-10); a layer that still holds the flat `roles` map is
// refused instead (`assertModelsShape`), so a missed migration is loud. Every string value of the merged config may reference an
// environment variable as `${env:NAME}` (`resolveEnvRefs`), so a value that holds credentials
// (e.g. `media.video.proxy`) can stay in .env.
// config.json is read from the checkout root; config.local.json and .env from the deployment's
// private directory (src/paths.js: NEPTUNIA_PRIVATE_DIR), which is the root unless set.
// Pure helpers (parseEnv, applyEnv, deepMerge, resolveEnvRefs) are exported separately so they
// can be unit-tested without touching the filesystem.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';
import { ROLE_DEFAULTS } from './llm/roles.js';

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
      value = value
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\"/g, '"');
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

// ---- the model keys before the roles (read for one release) -------------------
// The models used to sit under `llm.model`, `memory.model`, `classifier.*` and `image.model`,
// and the request roles carried the names of those keys. A deployment's config.local.json
// written that way keeps working: `adaptLegacyModelKeys` moves each old key to its
// `models.core` / `models.helpers.*` / `models.agents.*` key (unless that new key is set too: the
// new one wins) and renames the old role names inside `llm.hedge.roles`, `llm.cache.roles` and
// the `"<prefix>@<role>"` keys of `llm.providerByModel`.
// The old role `analyzer` was the memory analyzer, which is now `extractor`, while `analyzer`
// now names the quick-decision helpers (the old `classifier.text`): an `analyzer` entry is read
// as `extractor` only when the same file still uses the old model keys (`memory.model` or any
// `classifier.*` key is present), i.e. when it was written under the old names.

/** Each old model key with the key that replaced it. */
const LEGACY_MODEL_KEYS = Object.freeze([
  ['llm.model', 'models.core'],
  ['classifier.text', 'models.helpers.analyzer'],
  ['classifier.reason', 'models.helpers.analyzer'],
  ['memory.model', 'models.helpers.extractor'],
  ['classifier.media', 'models.helpers.vision'],
  ['classifier.video', 'models.helpers.video'],
  ['classifier.embed', 'models.helpers.embedding'],
  ['image.model', 'models.agents.drawing'],
  ['classifier.byPurpose', 'models.byPurpose'],
]);

/** Each old role name with its new one (the old `analyzer` is handled apart, see above). */
const LEGACY_ROLE_NAMES = new Map([
  ['classifier.text', 'analyzer'],
  ['classifier.reason', 'analyzer'],
  ['classifier.media', 'vision'],
  ['classifier.video', 'video'],
  ['classifier.embed', 'embedding'],
  ['image', 'drawing'],
  ['voice', 'core'],
]);

/** The role lists a config may name roles in. */
const LEGACY_ROLE_LISTS = Object.freeze(['hedge', 'cache']);

// ---- `models.base` (before models.core / models.helpers, 2026-10) ---------------
// The core's roles used to sit together in `models.base`: `models.base.voice` (the model that
// speaks as the persona), the helper roles beside it and `models.byPurpose`. The core is now
// `models.core` (role `core`), the helpers `models.helpers.<role>` and the purpose pins
// `models.byPurpose`. The old keys are aliases, not refused: a layer still holding them is read
// under the new keys (`adaptLegacyModelKeys`; the new key wins when both are set), the role
// `voice` is read as `core` in `llm.keyByRole`, `llm.hedge.roles`, `llm.cache.roles` and the
// role suffix of an `llm.providerByModel` key, and src/hot.js logs the list once. The
// migration tool makes the same moves on disk (`migrateModelsKeys`).

/** Each key of the old `models.base` section with its new path. */
const BASE_MOVES = new Map([
  ['voice', 'models.core'],
  ['analyzer', 'models.helpers.analyzer'],
  ['extractor', 'models.helpers.extractor'],
  ['vision', 'models.helpers.vision'],
  ['video', 'models.helpers.video'],
  ['embedding', 'models.helpers.embedding'],
  ['byPurpose', 'models.byPurpose'],
]);

/** Each old role name still accepted as a key of `llm.keyByRole`, with the role it is read as. */
const KEY_BY_ROLE_ALIASES = new Map([
  ['voice', 'core'],
]);

// ---- the flat `roles` map (before models.base / models.agents, 2026-10) ---------
// The models used to sit in one flat `roles` map, the agents' roles under dotted names
// (`roles["agent.web"]`, earlier `roles.agentWeb`), with `agent.advice` beside them. They now sit
// in `models.core`, `models.helpers`, `models.byPurpose` and `models.agents` (`web`, `server`,
// `thinker`, `dev`, `writer`, `drawing`); `agent.advice` is gone. The `reasoner` role was merged
// into `analyzer` later (2026-10): its purposes go out on the analyzer, so `models.base.reasoner`
// / `models.helpers.reasoner` is dropped when it names the analyzer's model, and
// `llm.keyByRole.reasoner` becomes `llm.keyByRole.analyzer`. No layer is read the old way: a
// config file that still holds `roles`, a `reasoner` model, or one of those old role names as a
// key of `llm.keyByRole`, is refused at load with the exact moves (`assertModelsShape`);
// tools/migrate-models-config.mjs makes them (`migrateModelsKeys`). (`reasoner` in
// `llm.hedge.roles`, `llm.cache.roles` and the role suffix of an `llm.providerByModel` key is
// read as `analyzer`: src/llm/openrouter.js#currentRoleName.)

/** Each key of the old `roles` map with its new path (null: dropped). */
const ROLES_MOVES = new Map([
  ['voice', 'models.core'],
  ['analyzer', 'models.helpers.analyzer'],
  ['reasoner', 'models.helpers.reasoner'],
  ['extractor', 'models.helpers.extractor'],
  ['vision', 'models.helpers.vision'],
  ['video', 'models.helpers.video'],
  ['embedding', 'models.helpers.embedding'],
  ['byPurpose', 'models.byPurpose'],
  ['drawing', 'models.agents.drawing'],
  ['agent.web', 'models.agents.web'],
  ['agent.server', 'models.agents.server'],
  ['agent.dev', 'models.agents.dev'],
  ['agentWeb', 'models.agents.web'],
  ['agentServer', 'models.agents.server'],
  ['agentDev', 'models.agents.dev'],
  ['agent.advice', null],
]);

/** Each old role name a `llm.keyByRole` key may still carry that is refused, with its new name (null: dropped). */
const KEY_BY_ROLE_MOVES = new Map([
  ['reasoner', 'analyzer'],
  ['agent.web', 'web'],
  ['agent.server', 'server'],
  ['agent.dev', 'dev'],
  ['agentWeb', 'web'],
  ['agentServer', 'server'],
  ['agentDev', 'dev'],
  ['agent.advice', null],
]);

/** The role merged into `analyzer` (2026-10). */
const MERGED_ROLE = 'reasoner';

/** The sections of `models` a `reasoner` model may still sit in. */
const MERGED_ROLE_SECTIONS = Object.freeze(['base', 'helpers']);

/**
 * Rename the role names inside `llm.hedge.roles`, `llm.cache.roles` and the role suffix of the
 * `llm.providerByModel` keys of one config layer, in place: `roleName(name)` gives the name to
 * use; `report(where, old, use)` is called for each change (`'llm.<list>.roles', <old role>, <new
 * role>` or `'llm.providerByModel', <key>, <newKey>`). A
 * renamed route whose new key is already set is dropped (the new key wins); a list keeps one
 * copy of each name.
 */
function renameRoleNames(llm, roleName, report) {
  if (!isPlainObject(llm)) return;
  for (const list of LEGACY_ROLE_LISTS) {
    const roles = isPlainObject(llm[list]) ? llm[list].roles : undefined;
    if (!Array.isArray(roles)) continue;
    const next = [];
    for (const name of roles) {
      const use = roleName(name);
      if (use !== name) report(`llm.${list}.roles`, name, use);
      if (!next.includes(use)) next.push(use);
    }
    llm[list].roles = next;
  }
  if (isPlainObject(llm.providerByModel)) {
    const routes = llm.providerByModel;
    const next = {};
    const moved = [];
    for (const [key, value] of Object.entries(routes)) {
      const at = key.lastIndexOf('@');
      const role = at === -1 ? null : key.slice(at + 1);
      const use = role === null ? role : roleName(role);
      if (use === role) next[key] = value;
      else moved.push({ key, newKey: `${key.slice(0, at)}@${use}`, value });
    }
    for (const { key, newKey, value } of moved) {
      if (!Object.hasOwn(next, newKey)) next[newKey] = value;
      report('llm.providerByModel', key, newKey);
    }
    llm.providerByModel = next;
  }
}

/**
 * Move each key of `models.base` of one config layer to its new path (BASE_MOVES), in place:
 * `onMove(from, to, blocked)` is called per key found, with `blocked` true when the new key is
 * already set (then `keep` decides: `true` leaves the old key in place, else it is dropped and
 * the new key wins). An empty `models.base` is removed; a key of `models.base` with no new home
 * (a `reasoner` model, an unknown name) stays where it is.
 */
function moveBaseKeys(config, onMove, keep) {
  const models = isPlainObject(config.models) ? config.models : undefined;
  const base = isPlainObject(models?.base) ? models.base : undefined;
  if (!base) return;
  for (const [key, to] of BASE_MOVES) {
    if (!Object.hasOwn(base, key)) continue;
    const value = base[key];
    const target = parentOf(config, to);
    const blocked = Boolean(target && Object.hasOwn(target.node, target.key));
    onMove(`models.base.${key}`, to, blocked);
    if (blocked && keep) continue;
    delete base[key];
    if (!blocked) setAt(config, to, value);
  }
  if (Object.keys(base).length === 0) delete models.base;
}

/**
 * One config layer (config.json or config.local.json, parsed) moved to today's keys: each key of
 * the flat `roles` map to its new path (ROLES_MOVES; `agent.advice` dropped); the `reasoner`
 * model (`models.base.reasoner` / `models.helpers.reasoner`) dropped when it names the analyzer's
 * model (the layer's, else its default; a different model is a conflict: keep one); each key of
 * `models.base` to `models.core` / `models.helpers.<role>` / `models.byPurpose` (BASE_MOVES);
 * each old role key of `llm.keyByRole` renamed (`agent.web` -> `web`, ..., `reasoner` ->
 * `analyzer`, `voice` -> `core`; `agent.advice` dropped); and the role `voice` renamed `core`
 * in `llm.hedge.roles`, `llm.cache.roles` and the role suffix of the `llm.providerByModel` keys.
 * `moves` lists every change as `{ from, to }` (`to` null for a dropped key), key names only,
 * never a value. A key of `roles` with no new home lands in `unknown`, a move onto a key the
 * layer already sets in `conflicts`; both are left in place (with them the result may keep
 * `roles` and not be loadable). Pure: `layer` is never mutated.
 * @param {unknown} layer
 * @returns {{ config: unknown, moves: Array<{ from: string, to: string|null }>, unknown: string[], conflicts: string[] }}
 */
export function migrateModelsKeys(layer) {
  if (!isPlainObject(layer)) return { config: layer, moves: [], unknown: [], conflicts: [] };
  // A layer without `models` gets it where `roles` stood, so the moved file reads in the same order.
  const config = Object.hasOwn(layer, 'roles') && !Object.hasOwn(layer, 'models')
    ? Object.fromEntries(Object.entries(structuredClone(layer)).flatMap(([key, value]) => (key === 'roles' ? [['models', {}], [key, value]] : [[key, value]])))
    : structuredClone(layer);
  const moves = [];
  const unknown = [];
  const conflicts = [];
  if (Object.hasOwn(config, 'roles')) {
    const roles = config.roles;
    const left = {};
    if (isPlainObject(roles)) {
      for (const [key, value] of Object.entries(roles)) {
        const from = `roles.${key}`;
        if (!ROLES_MOVES.has(key)) {
          unknown.push(from);
          left[key] = value;
          continue;
        }
        const to = ROLES_MOVES.get(key);
        if (to === null) {
          moves.push({ from, to });
          continue;
        }
        const target = parentOf(config, to);
        if (target && Object.hasOwn(target.node, target.key)) {
          conflicts.push(`${from} -> ${to}`);
          left[key] = value;
          continue;
        }
        setAt(config, to, value);
        moves.push({ from, to });
      }
    } else {
      unknown.push('roles');
    }
    if (Object.keys(left).length > 0) config.roles = left;
    else if (isPlainObject(roles)) delete config.roles;
    if (isPlainObject(config.models) && Object.keys(config.models).length === 0 && !Object.hasOwn(layer, 'models')) delete config.models;
  }
  // The merged `reasoner` role: its model goes only when it is the analyzer's (this layer's, else
  // the default), so no purpose changes model unseen.
  const models = isPlainObject(config.models) ? config.models : undefined;
  for (const section of MERGED_ROLE_SECTIONS) {
    const map = isPlainObject(models?.[section]) ? models[section] : undefined;
    if (!map || !Object.hasOwn(map, MERGED_ROLE)) continue;
    const analyzer = Object.hasOwn(map, 'analyzer') ? map.analyzer : (isPlainObject(models.helpers) && Object.hasOwn(models.helpers, 'analyzer') ? models.helpers.analyzer : ROLE_DEFAULTS.analyzer);
    if (map[MERGED_ROLE] === analyzer || map[MERGED_ROLE] === null || map[MERGED_ROLE] === '') {
      delete map[MERGED_ROLE];
      moves.push({ from: `models.${section}.${MERGED_ROLE}`, to: null });
      if (Object.keys(map).length === 0) delete models[section];
    } else {
      conflicts.push(`models.${section}.${MERGED_ROLE} -> models.helpers.analyzer`);
    }
  }
  // `models.base.*` to `models.core` / `models.helpers.*` / `models.byPurpose`.
  moveBaseKeys(config, (from, to, blocked) => {
    if (blocked) conflicts.push(`${from} -> ${to}`);
    else moves.push({ from, to });
  }, true);
  const keyByRole = isPlainObject(config.llm) ? config.llm.keyByRole : undefined;
  if (isPlainObject(keyByRole)) {
    const next = {};
    for (const [key, value] of Object.entries(keyByRole)) {
      const renamed = KEY_BY_ROLE_MOVES.has(key) ? KEY_BY_ROLE_MOVES : (KEY_BY_ROLE_ALIASES.has(key) ? KEY_BY_ROLE_ALIASES : null);
      if (!renamed) {
        if (!Object.hasOwn(next, key)) next[key] = value;
        continue;
      }
      const use = renamed.get(key);
      const from = `llm.keyByRole.${key}`;
      if (use === null) {
        moves.push({ from, to: null });
      } else if (Object.hasOwn(keyByRole, use) || Object.hasOwn(next, use)) {
        conflicts.push(`${from} -> llm.keyByRole.${use}`);
        next[key] = value;
      } else {
        next[use] = value;
        moves.push({ from, to: `llm.keyByRole.${use}` });
      }
    }
    config.llm.keyByRole = next;
  }
  renameRoleNames(config.llm, (name) => (name === 'voice' ? 'core' : name), (where, old, use) => moves.push({ from: `${where}: ${old}`, to: `${where}: ${use}` }));
  return { config, moves, unknown, conflicts };
}

/** A config file refused at load: it still holds the flat `roles` map, the merged reasoner role or an old role key. */
export class ConfigShapeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigShapeError';
  }
}

/**
 * Throws ConfigShapeError when one parsed config layer still holds the flat `roles` map, a
 * `reasoner` model (`models.base.reasoner`, `models.helpers.reasoner`), or an old role name
 * (`agent.web`, `agentWeb`, `agent.advice`, `reasoner`, ...) as a key of `llm.keyByRole`: the
 * message names the file, every move to make (`roles.voice -> models.core`, `roles.agent.web ->
 * models.agents.web`, `drop roles.agent.advice`, `drop models.base.reasoner`, ...) and the
 * migration tool. Nothing is read the old way, so a missed migration stops the load. The
 * `models.base.*` keys and the role name `voice` are aliases, read by `adaptLegacyModelKeys`:
 * they never stop the load.
 * @param {unknown} layer
 * @param {string} file  The file's name, for the message.
 */
export function assertModelsShape(layer, file) {
  if (!isPlainObject(layer)) return;
  const keyByRole = isPlainObject(layer.llm) ? layer.llm.keyByRole : undefined;
  const oldKeys = isPlainObject(keyByRole) && Object.keys(keyByRole).some((key) => KEY_BY_ROLE_MOVES.has(key));
  const merged = isPlainObject(layer.models) && MERGED_ROLE_SECTIONS.some((section) => isPlainObject(layer.models[section]) && Object.hasOwn(layer.models[section], MERGED_ROLE));
  if (!Object.hasOwn(layer, 'roles') && !oldKeys && !merged) return;
  const { moves, unknown, conflicts } = migrateModelsKeys(layer);
  const steps = [
    ...moves.map(({ from, to }) => (to === null ? `drop "${from}"` : `"${from}" -> "${to}"`)),
    ...unknown.map((key) => `"${key}" has no new key (remove it)`),
    ...conflicts.map((move) => `${move} (the new key is already set: keep one)`),
  ];
  throw new ConfigShapeError(
    `${file}: the flat "roles" map, the "agent." role names and the "reasoner" role (merged into "analyzer") are no longer read; `
    + 'the models now sit in "models.core" (the persona\'s model), "models.helpers" (analyzer, extractor, vision, video, embedding), "models.byPurpose" '
    + 'and "models.agents" (web, server, thinker, dev, writer, drawing), and "llm.keyByRole" names those roles. '
    + `Move: ${steps.join('; ')}. `
    + `Or run: node tools/migrate-models-config.mjs ${file} --write`,
  );
}

/** The parent object of a dotted path inside `root` and the last key, or null when a parent is missing. */
function parentOf(root, dotted) {
  const keys = dotted.split('.');
  let node = root;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(node) || !Object.hasOwn(node, key)) return null;
    node = node[key];
  }
  return isPlainObject(node) ? { node, key: keys[keys.length - 1] } : null;
}

/** Set `value` at a dotted path inside `root`, creating plain objects on the way. */
function setAt(root, dotted, value) {
  const keys = dotted.split('.');
  let node = root;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

/**
 * A deployment's own config layer (config.local.json, before it is merged) read under the
 * model roles: every key of `models.base` moved to `models.core` / `models.helpers.<role>` /
 * `models.byPurpose` and every old model key (`llm.model`, `classifier.*`, ...) to its new key,
 * unless the new key is set too (then the old one is dropped and the new one wins);
 * `llm.keyByRole.voice` read as `llm.keyByRole.core` (dropped when `core` is set too); and the
 * old role names inside `llm.hedge.roles`, `llm.cache.roles` and the role suffix of the
 * `llm.providerByModel` keys renamed (`voice` -> `core`, `classifier.text` -> `analyzer`,
 * `classifier.reason` -> `analyzer`, `classifier.media` -> `vision`, `classifier.video` ->
 * `video`, `classifier.embed` -> `embedding`, `image` -> `drawing`, and the old `analyzer` ->
 * `extractor` only while the layer still holds `memory.model` or a `classifier.*` key). A
 * renamed route whose new key is already set is dropped (the new key wins). The flat `roles`
 * map is not adapted: assertModelsShape refuses it. `renamed` lists what was found, key names
 * and role names only, never a value (src/hot.js logs it once). Pure: `local` is never mutated.
 * @param {unknown} local  The parsed config.local.json.
 * @returns {{ config: unknown, renamed: Array<{ key: string, use: string }> }}
 */
export function adaptLegacyModelKeys(local) {
  if (!isPlainObject(local)) return { config: local, renamed: [] };
  const config = structuredClone(local);
  const renamed = [];
  const oldNames = (isPlainObject(config.memory) && Object.hasOwn(config.memory, 'model'))
    || (isPlainObject(config.classifier) && Object.keys(config.classifier).length > 0);
  const roleName = (name) => {
    if (typeof name !== 'string') return name;
    if (oldNames && name === 'analyzer') return 'extractor';
    return LEGACY_ROLE_NAMES.get(name) ?? name;
  };

  moveBaseKeys(config, (from, to) => renamed.push({ key: from, use: to }), false);
  for (const [from, to] of LEGACY_MODEL_KEYS) {
    const at = parentOf(config, from);
    if (!at || !Object.hasOwn(at.node, at.key)) continue;
    const value = at.node[at.key];
    delete at.node[at.key];
    const target = parentOf(config, to);
    if (!target || !Object.hasOwn(target.node, target.key)) setAt(config, to, value);
    renamed.push({ key: from, use: to });
  }
  if (isPlainObject(config.classifier) && Object.keys(config.classifier).length === 0) delete config.classifier;

  const llm = config.llm;
  if (isPlainObject(llm)) {
    if (isPlainObject(llm.keyByRole)) {
      for (const [old, use] of KEY_BY_ROLE_ALIASES) {
        if (!Object.hasOwn(llm.keyByRole, old)) continue;
        const value = llm.keyByRole[old];
        delete llm.keyByRole[old];
        if (!Object.hasOwn(llm.keyByRole, use)) llm.keyByRole[use] = value;
        renamed.push({ key: `llm.keyByRole.${old}`, use: `llm.keyByRole.${use}` });
      }
    }
    renameRoleNames(llm, roleName, (where, old, use) => renamed.push({ key: `${where}: ${old}`, use }));
  }
  return { config, renamed };
}

/**
 * Read config.json merged with config.local.json, each layer checked by `assertModelsShape`
 * first (throws ConfigShapeError on the flat `roles` map), the local layer then read through
 * `adaptLegacyModelKeys`, then every `${env:NAME}` in a string value replaced from
 * process.env (`resolveEnvRefs`; an unset name becomes '' and is warned about once per
 * process). Throws on invalid JSON. config.json comes from `rootDir`, config.local.json from
 * `privateDir` (the deployment's private directory, src/paths.js), which defaults to `rootDir`.
 * @param {string} [rootDir]
 * @param {{ privateDir?: string }} [options]
 * @returns {{ config: object, renamed: Array<{ key: string, use: string }> }}  `renamed`: the old
 *   model keys and role names config.local.json still carries, with their new names.
 */
export function loadConfig(rootDir = ROOT_DIR, { privateDir = rootDir } = {}) {
  const { config, renamed } = mergeConfigFiles(rootDir, privateDir);
  return { config: resolveEnvRefs(config, process.env, warnUnsetEnvRef), renamed };
}

/** `<rootDir>/config.json` deep-merged with `<privateDir>/config.local.json` (each checked by
 * `assertModelsShape`, the local one read through `adaptLegacyModelKeys`), env references
 * unresolved. */
function mergeConfigFiles(rootDir, privateDir) {
  const base = JSON.parse(fs.readFileSync(path.join(rootDir, 'config.json'), 'utf8'));
  assertModelsShape(base, 'config.json');
  const localPath = path.join(privateDir, 'config.local.json');
  if (!fs.existsSync(localPath)) return { config: base, renamed: [] };
  const raw = fs.readFileSync(localPath, 'utf8').trim();
  if (!raw) return { config: base, renamed: [] };
  const parsed = JSON.parse(raw);
  assertModelsShape(parsed, 'config.local.json');
  const { config: local, renamed } = adaptLegacyModelKeys(parsed);
  return { config: deepMerge(base, local), renamed };
}

/** Read config.json merged with config.local.json (see `loadConfig`). Throws on invalid JSON. */
export function readConfig(rootDir = ROOT_DIR, { privateDir = rootDir } = {}) {
  return loadConfig(rootDir, { privateDir }).config;
}

export const env = process.env;

/** Return env[key], throwing an Error whose message is exactly `key` if unset/empty. */
export function need(key) {
  const value = env[key];
  if (value === undefined || value === '') throw new Error(key);
  return value;
}
