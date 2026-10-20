// Hot reload of everything the owner tunes while the bot is running:
// config.json, config.local.json and the two prompt layers (prompts/ and
// prompts.local/). Callers never cache values — they read `hot.config` /
// `hot.prompts` at the moment of use, so an edit takes effect on the very
// next LLM request without a restart and without touching memory, history or
// scheduler state under data/.
//
// prompts/ is the tracked, generic layer; prompts.local/ is a deployment's
// own, gitignored overrides — it may be entirely absent. A local file
// replaces the base file of the same name once it is non-empty; the JSON
// layers (labels.json, and skills.json: the persona's skill texts,
// src/skills/registry.js) are deep-merged instead of replaced, each under its
// own name in `hot.prompts`. A file that fails to parse (half
// -written JSON, editor temp state) is ignored on reload: the previous good
// value stays live and the error is logged. On the very first load, invalid
// JSON still throws so a broken deployment fails fast at startup.
//
// config.json and prompts/ live in the checkout (`rootDir`); config.local.json and prompts.local/
// in the deployment's private directory (`privateDir`, src/paths.js: NEPTUNIA_PRIVATE_DIR), which
// is the checkout unless set. When the two differ a second directory watcher covers the private
// one, so an edit there reloads exactly as an edit in the checkout does.
//
// prompts.local/preambles/ (a subfolder of the private layer only; no tracked default) holds the
// errand agents' preambles, picked by agent and model (src/errands/preambles.js): every `*.md`
// directly in it is loaded under its base name into `hot.prompts.preambles` (`{}` without the
// folder). Unlike the top-level files, a preamble file that reads empty (or whitespace only) loads
// as '' at once, with no keep-the-previous-text guard: emptying a file is how the owner switches
// a preamble off, and a deleted file is simply gone. The folder gets a watcher of its own while it
// exists.
//
// `hot.hashes` names what is live: a short sha256 of the loaded prompts and of the loaded
// config, computed at every load that took, so a journal record can say which wording and
// which settings produced it.

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { loadConfig, deepMerge, isPlainObject } from './config.js';
import { log } from './log.js';

const DEBOUNCE_MS = 250;
const BASE_CONFIG_FILE = 'config.json';
const LOCAL_CONFIG_FILE = 'config.local.json';
const LOCAL_PROMPTS_DIRNAME = 'prompts.local';
/** The subfolder of prompts.local/ holding the errand agents' preambles, loaded as `hot.prompts.preambles`. */
const PREAMBLES_DIRNAME = 'preambles';
/** The JSON files of the prompt layers, by name: `<name>.json`, deep-merged local over base. */
const JSON_LAYERS = Object.freeze(['labels', 'skills']);

/**
 * Config keys a deployment may still carry that are no longer read, each with what is read
 * instead: `memory.voiceModel` (the memory wording runs on `models.core`, the persona's one model);
 * `features.vision` and `features.attachedDescriptions` (pictures never go into the persona's own
 * request any more: she sees through the describer's captions, `features.mediaDescriptions`, and
 * her second look, `features.imageRelook`, both on the `vision` helper model); `innerLife.loop.strayFollowUps`
 * (an inner turn's output tags act as calls now, so nothing is left to follow up). No bound in the
 * engine is in dollars: `innerLife.caps.usdPerDay`, `innerLife.estimatedTurnUsd`,
 * `innerLife.errandReserveMaxMinutes`, `agents.<agent>.daily.usd` and `agents.<agent>.limits.usd` are
 * not read (the provider keys' own limits are the money bounds; costs are only reported).
 */
const RETIRED_CONFIG_KEYS = Object.freeze([
  { key: 'memory.voiceModel', use: 'models.core', read: (config) => config?.memory?.voiceModel },
  { key: 'features.vision', use: 'features.mediaDescriptions', read: (config) => config?.features?.vision },
  { key: 'features.attachedDescriptions', use: 'features.mediaDescriptions', read: (config) => config?.features?.attachedDescriptions },
  { key: 'innerLife.loop.strayFollowUps', use: 'innerLife.loop.maxSteps', read: (config) => config?.innerLife?.loop?.strayFollowUps },
  { key: 'innerLife.caps.usdPerDay', use: null, read: (config) => config?.innerLife?.caps?.usdPerDay },
  { key: 'innerLife.caps.perDay', use: null, read: (config) => config?.innerLife?.caps?.perDay },
  { key: 'innerLife.caps.perHour', use: null, read: (config) => config?.innerLife?.caps?.perHour },
  { key: 'innerLife.caps.publicPostsPerDay', use: null, read: (config) => config?.innerLife?.caps?.publicPostsPerDay },
  { key: 'innerLife.estimatedTurnUsd', use: null, read: (config) => config?.innerLife?.estimatedTurnUsd },
  { key: 'innerLife.errandReserveMaxMinutes', use: null, read: (config) => config?.innerLife?.errandReserveMaxMinutes },
  { key: 'intentions.droppedDays', use: null, read: (config) => config?.intentions?.droppedDays },
  { key: 'innerLife.heartbeat.droppedDays', use: null, read: (config) => config?.innerLife?.heartbeat?.droppedDays },
  { key: 'innerLife.heartbeat.droppedShown', use: 'innerLife.heartbeat.closedShown', read: (config) => config?.innerLife?.heartbeat?.droppedShown },
  ...['web', 'server', 'drawing', 'thinker', 'dev', 'writer'].flatMap((agent) => [
    { key: `agents.${agent}.daily.usd`, use: null, read: (config) => config?.agents?.[agent]?.daily?.usd },
    { key: `agents.${agent}.limits.usd`, use: null, read: (config) => config?.agents?.[agent]?.limits?.usd },
  ]),
]);

/** How many hex characters of the sha256 `hot.hashes` keeps. */
const HASH_CHARS = 16;

/** `value` as JSON with every object's keys sorted, so equal content gives equal text. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The first HASH_CHARS hex characters of the sha256 of `value`'s canonical JSON. */
function shortHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, HASH_CHARS);
}

function stripText(raw) {
  return raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
}

/** Basenames (with extension) of every `*.md` file directly under `dir`, or `[]` when `dir` is absent. */
function listMdFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((file) => file.endsWith('.md'));
}

/** Text of `<dir>/<file>`, stripped of BOM/CRLF and trimmed, or `null` when the file does not exist. */
function readMdFile(dir, file) {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return null;
  return stripText(fs.readFileSync(full, 'utf8'));
}

/**
 * Merge the base and local `*.md` layers into `{ prompts, sources, keptPrevious }`.
 * A local file replaces the base file of the same name once it is non-empty
 * after trimming; otherwise the base text is used. When the resulting text is
 * still empty but a previous, non-empty value is known for that name (an
 * editor may truncate a file before writing it), the previous value and its
 * source are kept so a half-written file never blanks out a live prompt. A
 * name whose files are gone from both layers is simply absent from the
 * result — the caller drops it.
 */
function computePromptFiles(promptsDir, localPromptsDir, prevPrompts, prevSources) {
  const files = new Set([...listMdFiles(promptsDir), ...listMdFiles(localPromptsDir)]);
  const prompts = {};
  const sources = {};
  const keptPrevious = [];

  for (const file of files) {
    const name = path.basename(file, '.md');
    const baseText = readMdFile(promptsDir, file);
    const localText = readMdFile(localPromptsDir, file);
    const useLocal = Boolean(localText);
    const effective = useLocal ? localText : (baseText ?? '');

    if (!effective && prevPrompts[name]) {
      prompts[name] = prevPrompts[name];
      sources[name] = prevSources[name] ?? (useLocal ? 'local' : 'base');
      keptPrevious.push(name);
    } else {
      prompts[name] = effective;
      sources[name] = useLocal ? 'local' : 'base';
    }
  }

  return { prompts, sources, keptPrevious };
}

/** Parsed `<dir>/<name>.json`, or `undefined` when the file is absent or blank. Throws on invalid JSON. */
function readJsonFile(dir, name) {
  const file = path.join(dir, `${name}.json`);
  if (!fs.existsSync(file)) return undefined;
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return undefined;
  return JSON.parse(raw);
}

/**
 * `{ value, source }` for one deep-merged JSON layer (a name of JSON_LAYERS). A
 * missing base file defaults to `{}`. Throws when either file exists and is
 * not valid JSON — callers on a reload path must catch this and keep the
 * previous value.
 */
function computeJsonLayer(name, promptsDir, localPromptsDir) {
  const base = readJsonFile(promptsDir, name);
  const local = readJsonFile(localPromptsDir, name);
  if (local !== undefined) return { value: deepMerge(base ?? {}, local), source: 'merged' };
  return { value: base ?? {}, source: 'base' };
}

/**
 * The `*.md` files directly under `dir` (prompts.local/preambles/) as `{ <base name>: text }`,
 * `{}` when the folder is absent. An empty or whitespace-only file loads as '' right away (no
 * keep-the-previous-text guard, unlike computePromptFiles): an emptied preamble means none.
 */
function computePreambles(dir) {
  const out = {};
  for (const file of listMdFiles(dir)) {
    out[path.basename(file, '.md')] = readMdFile(dir, file) ?? '';
  }
  return out;
}

function loadPromptLayers(promptsDir, localPromptsDir, prevPrompts, prevSources) {
  const { prompts, sources, keptPrevious } = computePromptFiles(promptsDir, localPromptsDir, prevPrompts, prevSources);
  prompts.preambles = computePreambles(path.join(localPromptsDir, PREAMBLES_DIRNAME));
  sources.preambles = 'local';
  for (const name of JSON_LAYERS) {
    const { value, source } = computeJsonLayer(name, promptsDir, localPromptsDir);
    prompts[name] = value;
    sources[name] = source;
  }
  return { prompts, sources, keptPrevious };
}

/**
 * Create a live view over the config and the two prompt layers: config.json and prompts/ under
 * `rootDir`, config.local.json and prompts.local/ under `privateDir` (default `rootDir`).
 * Emits 'change' with `{ what: 'config' | 'prompts' }` after every successful reload;
 * `hot.onReload(listener)` subscribes to the same with the layer name alone.
 * `hot.hashes` is `{ promptsHash, configHash }`: the first 16 hex characters of the sha256 of
 * the live prompts (every layer merged, labels included) and of the live config (both files
 * merged), each recomputed when its reload takes; a reload that fails keeps the previous one.
 * `hot.rootDir` and `hot.privateDir` name the two directories (the same one unless set apart).
 * @param {{ rootDir: string, privateDir?: string, watchImpl?: typeof fs.watch }} options
 *   `watchImpl` is a test hook; production uses `fs.watch`.
 */
export function createHot({ rootDir, privateDir = rootDir, watchImpl = fs.watch }) {
  const promptsDir = path.join(rootDir, 'prompts');
  const localPromptsDir = path.join(privateDir, LOCAL_PROMPTS_DIRNAME);
  const preamblesDir = path.join(localPromptsDir, PREAMBLES_DIRNAME);
  // Whether the private layer sits in a directory of its own, which then needs its own watcher.
  const privateApart = path.resolve(privateDir) !== path.resolve(rootDir);
  const hot = new EventEmitter();
  const watchers = [];
  const timers = new Map();
  let localWatcher = null;
  let preamblesWatcher = null;

  let loaded = loadConfig(rootDir, { privateDir });
  hot.config = loaded.config;
  // The old model keys and role names config.local.json still carries (src/config.js#adaptLegacyModelKeys,
  // read under their new names): one warning listing them, key names only, at startup and again
  // at a reload that changes the list. A layer still holding the flat `roles` map throws instead
  // (src/config.js#assertModelsShape): at startup the bot does not start, on a reload the
  // previous config stays live.
  let reportedLegacy = '';
  const reportLegacyKeys = (renamed) => {
    const listed = JSON.stringify(renamed);
    if (listed === reportedLegacy) return;
    reportedLegacy = listed;
    if (renamed.length > 0) log.warn('config: old model keys read under their new names', { keys: renamed });
  };
  reportLegacyKeys(loaded.renamed);
  // The retired keys reported for the config now live: one warning when a key appears (at
  // startup or on a reload), none while it stays, another once it was removed and set again.
  const reportedRetired = new Set();
  const reportRetiredKeys = () => {
    for (const { key, use, read } of RETIRED_CONFIG_KEYS) {
      if (read(hot.config) == null) {
        reportedRetired.delete(key);
      } else if (!reportedRetired.has(key)) {
        reportedRetired.add(key);
        log.warn(`config: ${key} is no longer read`, { key, use });
      }
    }
  };
  reportRetiredKeys();
  // Initial load: an invalid JSON layer (labels, skills) throws so a broken deployment fails at startup.
  const initial = loadPromptLayers(promptsDir, localPromptsDir, {}, {});
  hot.prompts = initial.prompts;
  hot.promptSources = initial.sources;
  hot.promptsDir = promptsDir;
  hot.localPromptsDir = localPromptsDir;
  hot.rootDir = rootDir;
  hot.privateDir = privateDir;
  hot.hashes = { promptsHash: shortHash(hot.prompts), configHash: shortHash(hot.config) };

  /**
   * Subscribe to every reload that took: `listener` gets the layer name (`'config'` or
   * `'prompts'`); a failed reload calls nothing. Returns the unsubscribe function. The hook the
   * journal's `reload` records hang on (src/index.js), as this module knows no guild.
   * @param {(what: 'config'|'prompts') => void} listener
   * @returns {() => void}
   */
  hot.onReload = (listener) => {
    const handler = ({ what }) => listener(what);
    hot.on('change', handler);
    return () => hot.off('change', handler);
  };

  hot.reloadConfig = () => {
    try {
      loaded = loadConfig(rootDir, { privateDir });
      hot.config = loaded.config;
      hot.hashes = { ...hot.hashes, configHash: shortHash(hot.config) };
      log.info('hot: config reloaded');
      reportLegacyKeys(loaded.renamed);
      reportRetiredKeys();
      hot.emit('change', { what: 'config' });
      return true;
    } catch (err) {
      log.warn('hot: config not reloaded, keeping the previous one', { error: err });
      return false;
    }
  };

  hot.reloadPrompts = () => {
    try {
      const { prompts: mdPrompts, sources: mdSources, keptPrevious } = computePromptFiles(
        promptsDir,
        localPromptsDir,
        hot.prompts,
        hot.promptSources,
      );

      // Each JSON layer on its own: a broken one keeps its previous value, the rest still reload.
      const json = {};
      const jsonSources = {};
      for (const name of JSON_LAYERS) {
        json[name] = hot.prompts[name];
        jsonSources[name] = hot.promptSources[name];
        try {
          const computed = computeJsonLayer(name, promptsDir, localPromptsDir);
          json[name] = computed.value;
          jsonSources[name] = computed.source;
        } catch (err) {
          log.warn('hot: json layer not reloaded, keeping the previous value', { name, error: err });
        }
      }

      const preambles = computePreambles(preamblesDir);

      hot.prompts = { ...mdPrompts, preambles, ...json };
      hot.promptSources = { ...mdSources, preambles: 'local', ...jsonSources };
      hot.hashes = { ...hot.hashes, promptsHash: shortHash(hot.prompts) };
      log.info('hot: prompts reloaded', { prompts: Object.keys(mdPrompts), preambles: Object.keys(preambles), keptPrevious });
      hot.emit('change', { what: 'prompts' });
      return true;
    } catch (err) {
      log.warn('hot: prompts not reloaded, keeping the previous ones', { error: err });
      return false;
    }
  };

  function schedule(key, fn) {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(fn, DEBOUNCE_MS));
  }

  function isPromptFile(file) {
    if (!file) return true;
    const name = String(file);
    return name.endsWith('.md') || name.endsWith('.json');
  }

  function attachErrorHandler(watcher, onError) {
    watcher.on('error', (err) => {
      log.warn('hot: watcher error', { error: err });
      onError?.();
    });
  }

  /** Close `watcher` and drop it from `watchers`. */
  function dropWatcher(watcher) {
    const index = watchers.indexOf(watcher);
    if (index !== -1) watchers.splice(index, 1);
    try {
      watcher.close();
    } catch {
      // already closed by the error that brought us here
    }
  }

  /** Close and forget the prompts.local/preambles/ watcher, so a folder created again gets a new one. */
  function stopPreamblesWatch() {
    const watcher = preamblesWatcher;
    if (!watcher) return;
    preamblesWatcher = null;
    dropWatcher(watcher);
  }

  function startPreamblesWatch() {
    if (preamblesWatcher) return;
    try {
      const watcher = watchImpl(preamblesDir, (event, file) => {
        if (isPromptFile(file)) schedule('prompts', hot.reloadPrompts);
      });
      preamblesWatcher = watcher;
      watchers.push(watcher);
      attachErrorHandler(watcher, () => {
        if (preamblesWatcher === watcher) stopPreamblesWatch();
      });
    } catch (err) {
      log.warn('hot: failed to watch prompts.local/preambles', { error: err });
    }
  }

  /** prompts.local/preambles/ appeared or went away: start or drop its watcher, then reload. */
  function onPreamblesEntry() {
    if (!fs.existsSync(preamblesDir)) stopPreamblesWatch();
    else startPreamblesWatch();
    schedule('prompts', hot.reloadPrompts);
  }

  /** Close and forget the prompts.local/ watcher (and its preambles/ one), so a directory created again gets new ones. */
  function stopLocalWatch() {
    stopPreamblesWatch();
    const watcher = localWatcher;
    if (!watcher) return;
    localWatcher = null;
    dropWatcher(watcher);
  }

  function startLocalWatch() {
    if (localWatcher) return;
    try {
      const watcher = watchImpl(localPromptsDir, (event, file) => {
        // No name (some platforms) may be the folder too: sync its watcher, then reload.
        if (!file || String(file) === PREAMBLES_DIRNAME) onPreamblesEntry();
        else if (isPromptFile(file)) schedule('prompts', hot.reloadPrompts);
      });
      localWatcher = watcher;
      watchers.push(watcher);
      // A watcher whose directory went away errors out: drop it, the root watcher starts the next one.
      attachErrorHandler(watcher, () => {
        if (localWatcher === watcher) stopLocalWatch();
      });
      if (fs.existsSync(preamblesDir)) startPreamblesWatch();
    } catch (err) {
      log.warn('hot: failed to watch prompts.local', { error: err });
    }
  }

  /** An entry of the private directory changed: config.local.json reloads the config;
   * prompts.local/ appearing or going away starts or drops its watcher. */
  function onPrivateEntry(name) {
    if (name === LOCAL_CONFIG_FILE) {
      schedule('config', hot.reloadConfig);
    } else if (name === LOCAL_PROMPTS_DIRNAME) {
      if (!fs.existsSync(localPromptsDir)) {
        // Deleted (or moved away by an rsync): its watcher is dead, a recreated directory gets a new one.
        stopLocalWatch();
      } else if (!localWatcher) {
        startLocalWatch();
        schedule('prompts', hot.reloadPrompts);
      }
    }
  }

  hot.watch = () => {
    const rootWatcher = watchImpl(rootDir, (event, file) => {
      const name = file ? String(file) : '';
      if (name === BASE_CONFIG_FILE) schedule('config', hot.reloadConfig);
      else if (!privateApart) onPrivateEntry(name);
    });
    watchers.push(rootWatcher);
    attachErrorHandler(rootWatcher);

    if (privateApart) {
      // The private layer in a directory of its own: a second root watcher, for its entries only.
      const privateWatcher = watchImpl(privateDir, (event, file) => onPrivateEntry(file ? String(file) : ''));
      watchers.push(privateWatcher);
      attachErrorHandler(privateWatcher);
    }

    const baseWatcher = watchImpl(promptsDir, (event, file) => {
      if (isPromptFile(file)) schedule('prompts', hot.reloadPrompts);
    });
    watchers.push(baseWatcher);
    attachErrorHandler(baseWatcher);

    if (fs.existsSync(localPromptsDir)) startLocalWatch();

    return hot;
  };

  hot.close = () => {
    for (const watcher of watchers) watcher.close();
    for (const timer of timers.values()) clearTimeout(timer);
    watchers.length = 0;
    timers.clear();
    localWatcher = null;
    preamblesWatcher = null;
  };

  return hot;
}
