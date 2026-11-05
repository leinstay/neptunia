// Hot configuration and prompt layers combine engine defaults with data/config and data/prompts. Settings and
// labels merge recursively; nonempty personal prompts replace complete shared files. Preambles live under
// data/prompts/preambles. Reloads retain the previous good value after a partial write. Watchers follow both roots.
// Legacy personal layouts refuse startup with offline migration guidance. Hashes describe the live layers.

import fs from 'node:fs';
import { resolvePaths } from './paths.ts';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { readConfig, deepMerge, isPlainObject } from './config.ts';
import { log } from './log.ts';
import { CONFIG_DIR, CONFIG_FILE, LABELS_FILE, MOVE_TOOL, OLD_LOCAL_CONFIG, localFiles } from './config/files.ts';
import { joinLabels, labelsFileOf } from './config/labels.ts';
// A parsed JSON value or an argument no module types yet: the alias of src/tools/types.ts, restated so this leaf
// imports nothing from src/tools/ (src/memory/ reaches it).
type Untyped = ReturnType<typeof JSON.parse>;

const DEBOUNCE_MS = 250;
const LOCAL_PROMPTS_DIRNAME = 'prompts';
/** The subfolder of prompts.local/ holding the errand agents' preambles, loaded as `hot.prompts.preambles`. */
const PREAMBLES_DIRNAME = 'preambles';
/**
 * The JSON files of the prompt layers, by name, each with how it is computed from the checkout and the private
 * directory: the labels by `computeLabels`, the tool texts by `computeJsonLayer` over `config/tools.json` and
 * `data/config/tools.json`.
 */
const JSON_LAYERS: ReadonlyArray<{
  name: string;
  compute: (rootDir: string, privateDir: string) => { value: unknown; source: string };
}> = Object.freeze([
  { name: 'labels', compute: computeLabels },
  {
    name: 'tools',
    compute: (rootDir, privateDir) =>
      computeJsonLayer({ name: 'tools', dir: CONFIG_DIR, localDir: CONFIG_DIR }, rootDir, privateDir),
  },
]);

/** Where an earlier version kept the tool texts, which the start refuses to find (scripts/tools-file-move.ts moves it). */
const OLD_TOOLS_FILE = path.join('prompts.local', 'skills.json');

/**
 * Config keys a deployment may still carry that are no longer read, each with what is read
 * instead: `memory.voiceModel` (the memory wording runs on `models.base.core`, the persona's one model);
 * `features.vision` and `features.attachedDescriptions` (pictures never go into the persona's own
 * request: she sees through the describer's captions and her second look, both on the `vision` model
 * role); `wakes.loop.strayFollowUps`
 * (an inner turn's output tags act as calls now, so nothing is left to follow up). No bound in the
 * engine is in dollars: `wakes.caps.usdPerDay`, `wakes.estimatedTurnUsd`,
 * `wakes.errandReserveMaxMinutes`, `agents.<agent>.daily.usd` and `agents.<agent>.limits.usd` are
 * not read (the provider keys' own limits are the money bounds; costs are only reported).
 */
const RETIRED_CONFIG_KEYS = Object.freeze([
  { key: 'memory.voiceModel', use: 'models.base.core', read: (config: Untyped) => config?.memory?.voiceModel },
  { key: 'features.vision', use: null, read: (config: Untyped) => config?.features?.vision },
  {
    key: 'features.attachedDescriptions',
    use: null,
    read: (config: Untyped) => config?.features?.attachedDescriptions,
  },
  {
    key: 'wakes.loop.strayFollowUps',
    use: 'wakes.loop.maxSteps',
    read: (config: Untyped) => config?.wakes?.loop?.strayFollowUps,
  },
  { key: 'wakes.caps.usdPerDay', use: null, read: (config: Untyped) => config?.wakes?.caps?.usdPerDay },
  { key: 'wakes.caps.perDay', use: null, read: (config: Untyped) => config?.wakes?.caps?.perDay },
  { key: 'wakes.caps.perHour', use: null, read: (config: Untyped) => config?.wakes?.caps?.perHour },
  {
    key: 'wakes.caps.publicPostsPerDay',
    use: null,
    read: (config: Untyped) => config?.wakes?.caps?.publicPostsPerDay,
  },
  { key: 'wakes.estimatedTurnUsd', use: null, read: (config: Untyped) => config?.wakes?.estimatedTurnUsd },
  {
    key: 'wakes.errandReserveMaxMinutes',
    use: null,
    read: (config: Untyped) => config?.wakes?.errandReserveMaxMinutes,
  },
  { key: 'intentions.droppedDays', use: null, read: (config: Untyped) => config?.intentions?.droppedDays },
  {
    key: 'heartbeat.droppedDays',
    use: null,
    read: (config: Untyped) => config?.heartbeat?.droppedDays,
  },
  {
    key: 'heartbeat.droppedShown',
    use: null,
    read: (config: Untyped) => config?.heartbeat?.droppedShown,
  },
  ...['scout', 'server', 'thinker', 'dev'].flatMap((agent) => [
    { key: `agents.${agent}.daily.usd`, use: null, read: (config: Untyped) => config?.agents?.[agent]?.daily?.usd },
    { key: `agents.${agent}.limits.usd`, use: null, read: (config: Untyped) => config?.agents?.[agent]?.limits?.usd },
  ]),
]);

/**
 * The live view `createHot` returns. `config` is the parsed settings and `prompts` the loaded prompt files, each
 * a JSON tree whose shape `config/` and src/config/schema.ts define and every reader checks as it reads, so
 * both are untyped here.
 */
export type Hot = EventEmitter & {
  config: Untyped;
  prompts: Record<string, Untyped> & { labels: Untyped; 'search-summary'?: string };
  promptSources: Record<string, string>;
  promptsDir: string;
  localPromptsDir: string;
  rootDir: string;
  privateDir: string;
  hashes: { promptsHash: string; configHash: string };
  onReload: (listener: (what: 'config' | 'prompts') => void) => () => void;
  reloadConfig: () => boolean;
  reloadPrompts: () => boolean;
  watch: () => Hot;
  close: () => void;
};

/** How many hex characters of the sha256 `hot.hashes` keeps. */
const HASH_CHARS = 16;

/** `value` as JSON with every object's keys sorted, so equal content gives equal text. */
function canonicalJson(value: Untyped): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The first HASH_CHARS hex characters of the sha256 of `value`'s canonical JSON. */
function shortHash(value: Untyped) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, HASH_CHARS);
}

function stripText(raw: Untyped) {
  return raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
}

/**
 * The local prompt files read under a newer name: `data/prompts/selfdev.md` (the brief of src/selfimprovement/ under
 * its older name) loads as `executor-brief` while `data/prompts/executor-brief.md` is absent.
 */
const LOCAL_PROMPT_MOVES: Readonly<Record<string, string>> = Object.freeze({ selfdev: 'executor-brief' });

/** The local file name `file` is read under: its newer name for a file of LOCAL_PROMPT_MOVES, else itself. */
const localNameOf = (file: string): string => {
  const moved = LOCAL_PROMPT_MOVES[path.basename(file, '.md')];
  return moved === undefined ? file : `${moved}.md`;
};

/** Text of `prompts.local/<file>`, else of the older local name that moves to it, else null. */
function readLocalMdFile(localDir: string, file: string): string | null {
  const own = readMdFile(localDir, file) as string | null;
  if (own !== null) return own;
  const older = Object.keys(LOCAL_PROMPT_MOVES).find((name) => `${LOCAL_PROMPT_MOVES[name]}.md` === file);
  return older === undefined ? null : (readMdFile(localDir, `${older}.md`) as string | null);
}

/** Basenames (with extension) of every `*.md` file directly under `dir`, or `[]` when `dir` is absent. */
function listMdFiles(dir: Untyped) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((file) => file.endsWith('.md'));
}

/** Text of `<dir>/<file>`, stripped of BOM/CRLF and trimmed, or `null` when the file does not exist. */
function readMdFile(dir: Untyped, file: Untyped) {
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
function computePromptFiles(
  promptsDir: string,
  localPromptsDir: string,
  prevPrompts: Record<string, unknown>,
  prevSources: Record<string, string>
) {
  const files = new Set([...listMdFiles(promptsDir), ...listMdFiles(localPromptsDir).map(localNameOf)]);
  const prompts: Record<string, unknown> = {};
  const sources: Record<string, string> = {};
  const keptPrevious: Array<string> = [];

  for (const file of files) {
    const name = path.basename(file, '.md');
    const baseText = readMdFile(promptsDir, file);
    const localText = readLocalMdFile(localPromptsDir, file);
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

/**
 * Parsed `<dir>/<name>.json`, or `undefined` when the file is absent or blank. Throws on invalid JSON.
 */
function readJsonFile(dir: string, name: string): Record<string, unknown> | undefined {
  const file = path.join(dir, `${name}.json`);
  if (!fs.existsSync(file)) return undefined;
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return undefined;
  return JSON.parse(raw);
}

/**
 * `{ value, source }` for one deep-merged JSON layer (an entry of JSON_LAYERS). A
 * missing base file defaults to `{}`. Throws when either file exists and is
 * not valid JSON — callers on a reload path must catch this and keep the
 * previous value.
 */
function computeJsonLayer(
  { name, dir, localDir }: { name: string; dir: string; localDir: string },
  rootDir: string,
  privateDir: string
) {
  const base = readJsonFile(path.join(rootDir, dir), name);
  const local = readJsonFile(path.join(privateDir, localDir), name);
  if (local !== undefined) return { value: deepMerge(base ?? {}, local), source: 'merged' };
  return { value: base ?? {}, source: 'base' };
}

/** `{ model, owner }` of a parsed labels file, a missing section as `{}`. */
/**
 * `{ value, source }` of the labels: `config/labels.json` joined (src/config/labels.ts), with the private labels
 * deep-merged over it, `data/config/labels.json` joined or a flat `data/prompts/labels.json` of the old layout.
 * Throws on invalid JSON, on a key in both sections and on a private labels file at both its places.
 */
function computeLabels(rootDir: string, privateDir: string) {
  const tracked = readJsonFile(path.join(rootDir, CONFIG_DIR), path.basename(LABELS_FILE, '.json'));
  const base = tracked === undefined ? {} : joinLabels(labelsFileOf(tracked));
  const found = localFiles(privateDir).labels;
  const local = found === null ? undefined : readJsonFile(path.dirname(found.file), path.basename(found.file, '.json'));
  if (local === undefined) return { value: base, source: 'base' };
  const flat = found?.shape === 'split' ? joinLabels(labelsFileOf(local)) : local;
  return { value: deepMerge(base, flat), source: 'merged' };
}

/** The labels of the two layers as `hot.prompts.labels` holds them, read once, for a command that runs without a core. */
export function readLabels(rootDir: string, privateDir: string): Record<string, unknown> {
  return computeLabels(rootDir, privateDir).value as Record<string, unknown>;
}

/**
 * The `*.md` files directly under `dir` (data/prompts/preambles/) as `{ <base name>: text }`,
 * `{}` when the folder is absent. An empty or whitespace-only file loads as '' right away (no
 * keep-the-previous-text guard, unlike computePromptFiles): an emptied preamble means none.
 */
function computePreambles(dir: string) {
  const out: Record<string, string> = {};
  for (const file of listMdFiles(dir)) {
    out[path.basename(file, '.md')] = readMdFile(dir, file) ?? '';
  }
  return out;
}

function loadPromptLayers(
  rootDir: string,
  privateDir: string,
  prevPrompts: Record<string, unknown>,
  prevSources: Record<string, string>
) {
  const promptsDir = path.join(rootDir, 'prompts');
  const localPromptsDir = path.join(privateDir, LOCAL_PROMPTS_DIRNAME);
  const { prompts, sources, keptPrevious } = computePromptFiles(promptsDir, localPromptsDir, prevPrompts, prevSources);
  prompts.preambles = computePreambles(path.join(localPromptsDir, PREAMBLES_DIRNAME));
  sources.preambles = 'local';
  for (const layer of JSON_LAYERS) {
    const { value, source } = layer.compute(rootDir, privateDir);
    prompts[layer.name] = value;
    sources[layer.name] = source;
  }
  // JSON_LAYERS always sets `labels` and `tools`, so the merged prompts hold `labels`.
  return { prompts: prompts as Hot['prompts'], sources, keptPrevious };
}

/**
 * Log a watcher's error, then run `onError`.
 */
function attachErrorHandler(watcher: EventEmitter, onError?: () => void) {
  watcher.on('error', (err) => {
    log.warn('hot: watcher error', { error: err });
    onError?.();
  });
}

/**
 * Close `watcher` and drop it from `watchers`.
 */
function dropWatcher(watchers: Array<unknown>, watcher: { close: () => void }) {
  const index = watchers.indexOf(watcher);
  if (index !== -1) watchers.splice(index, 1);
  try {
    watcher.close();
  } catch {
    // already closed by the error that brought us here
  }
}

/**
 * A watcher of `dir` that starts once, drops itself on an error (its directory went away) and starts again when asked:
 * `start()`, `stop()`, `running()`, and `forget()` after every watcher of `watchers` was closed.
 */
function restartableWatch({
  watchImpl,
  dir,
  watchers,
  onEvent,
}: {
  watchImpl: typeof fs.watch;
  dir: string;
  watchers: Array<unknown>;
  onEvent: (file: unknown) => void;
}) {
  let current: fs.FSWatcher | null = null;
  const stop = () => {
    const watcher = current;
    if (!watcher) return;
    current = null;
    dropWatcher(watchers, watcher);
  };
  const start = () => {
    if (current) return;
    try {
      const watcher = watchImpl(dir, (event, file) => onEvent(file));
      current = watcher;
      watchers.push(watcher);
      attachErrorHandler(watcher, () => {
        if (current === watcher) stop();
      });
    } catch (err) {
      log.warn('hot: failed to watch a folder', { dir: path.basename(dir), error: err });
    }
  };
  return {
    start,
    stop,
    running: () => current !== null,
    forget: () => {
      current = null;
    },
  };
}

/**
 * Create a live view over the config and the two prompt layers: config.json and prompts/ under
 * `rootDir`, config.local.json and data/prompts/ under `privateDir` (default `rootDir`).
 * Emits 'change' with `{ what: 'config' | 'prompts' }` after every successful reload;
 * `hot.onReload(listener)` subscribes to the same with the layer name alone.
 * `hot.hashes` is `{ promptsHash, configHash }`: the first 16 hex characters of the sha256 of
 * the live prompts (every layer merged, labels included) and of the live config (both files
 * merged), each recomputed when its reload takes; a reload that fails keeps the previous one.
 * `hot.rootDir` and `hot.privateDir` name the two directories (the same one unless set apart).
 *   `watchImpl` is a test hook; production uses `fs.watch`.
 */
export function createHot({
  rootDir,
  privateDir = resolvePaths({ rootDir }).dataDir,
  watchImpl = fs.watch,
}: {
  rootDir: string;
  privateDir?: string;
  watchImpl?: typeof fs.watch;
}): Hot {
  const promptsDir = path.join(rootDir, 'prompts');
  const localPromptsDir = path.join(privateDir, LOCAL_PROMPTS_DIRNAME);
  const preamblesDir = path.join(localPromptsDir, PREAMBLES_DIRNAME);
  const toolsDir = path.join(rootDir, CONFIG_DIR);
  const localToolsDir = path.join(privateDir, CONFIG_DIR);
  // The properties of `Hot` are all assigned below, before `hot` leaves this function.
  const hot = new EventEmitter() as Hot;
  const watchers: Array<Untyped> = [];
  const timers = new Map();
  let localWatcher: fs.FSWatcher | null = null;
  let preamblesWatcher: fs.FSWatcher | null = null;
  // Whether the private layer sits in a directory of its own, which then needs its own watcher.
  const privateApart = path.resolve(privateDir) !== path.resolve(rootDir);

  // The tool texts still in their old place refuse the start before anything is read: left there they would stop
  // counting without a word.
  if (fs.existsSync(path.join(privateDir, OLD_TOOLS_FILE)))
    throw new Error(`${OLD_TOOLS_FILE} is where the tool texts were: run node scripts/tools-file-move.ts --apply`);
  hot.config = readConfig(rootDir, { privateDir });
  // A layer laid out the old way loads, and says once per start that scripts/config-files-move.ts moves it.
  if (localFiles(privateDir).old)
    log.warn('hot: the private layer keeps config.local.json or a flat prompts.local/labels.json', {
      move: MOVE_TOOL,
    });
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
  // Initial load: an invalid JSON layer (labels, tools) throws so a broken deployment fails at startup.
  const initial = loadPromptLayers(rootDir, privateDir, {}, {});
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
   * journal's `reload` records hang on (src/index.ts), as this module knows no guild.
   */
  hot.onReload = (listener: (what: 'config' | 'prompts') => void): (() => void) => {
    const handler = ({ what }: { what: Untyped }) => listener(what);
    hot.on('change', handler);
    return () => hot.off('change', handler);
  };

  hot.reloadConfig = () => {
    try {
      hot.config = readConfig(rootDir, { privateDir });
      hot.hashes = { ...hot.hashes, configHash: shortHash(hot.config) };
      log.info('hot: config reloaded');
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
      const {
        prompts: mdPrompts,
        sources: mdSources,
        keptPrevious,
      } = computePromptFiles(promptsDir, localPromptsDir, hot.prompts, hot.promptSources);

      // Each JSON layer on its own: a broken one keeps its previous value, the rest still reload.
      const json: Record<string, unknown> = {};
      const jsonSources: Record<string, string> = {};
      for (const layer of JSON_LAYERS) {
        const { name } = layer;
        json[name] = hot.prompts[name];
        jsonSources[name] = hot.promptSources[name];
        try {
          const computed = layer.compute(rootDir, privateDir);
          json[name] = computed.value;
          jsonSources[name] = computed.source;
        } catch (err) {
          log.warn('hot: json layer not reloaded, keeping the previous value', { name, error: err });
        }
      }

      const preambles = computePreambles(preamblesDir);

      // `json` holds every layer of JSON_LAYERS, `labels` among them.
      const next: Record<string, Untyped> = { ...mdPrompts, preambles, ...json };
      hot.prompts = next as Hot['prompts'];
      hot.promptSources = { ...mdSources, preambles: 'local', ...jsonSources };
      hot.hashes = { ...hot.hashes, promptsHash: shortHash(hot.prompts) };
      log.info('hot: prompts reloaded', {
        prompts: Object.keys(mdPrompts),
        preambles: Object.keys(preambles),
        keptPrevious,
      });
      hot.emit('change', { what: 'prompts' });
      return true;
    } catch (err) {
      log.warn('hot: prompts not reloaded, keeping the previous ones', { error: err });
      return false;
    }
  };

  function schedule(key: Untyped, fn: Untyped) {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(fn, DEBOUNCE_MS));
  }

  function isPromptFile(file: Untyped) {
    if (!file) return true;
    const name = String(file);
    return name.endsWith('.md') || name.endsWith('.json');
  }

  /** Close and forget the prompts.local/preambles/ watcher, so a folder created again gets a new one. */
  function stopPreamblesWatch() {
    const watcher = preamblesWatcher;
    if (!watcher) return;
    preamblesWatcher = null;
    dropWatcher(watchers, watcher);
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
    dropWatcher(watchers, watcher);
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

  /** A file of config/ or config.local/ changed: its config.json reloads the config, any other JSON the prompts. */
  function onConfigDirEntry(file: Untyped) {
    if (!file || String(file) === CONFIG_FILE) schedule('config', hot.reloadConfig);
    if (!file || (String(file) !== CONFIG_FILE && isPromptFile(file))) schedule('prompts', hot.reloadPrompts);
  }
  const toolsWatch = restartableWatch({ watchImpl, dir: toolsDir, watchers, onEvent: onConfigDirEntry });
  const localToolsWatch = restartableWatch({ watchImpl, dir: localToolsDir, watchers, onEvent: onConfigDirEntry });

  /** An entry of the private directory changed: config.local.json (the old layout) reloads the config;
   * data/prompts/ and data/config/ appearing or going away start or drop their watchers. */
  function onPrivateEntry(name: string) {
    if (name === OLD_LOCAL_CONFIG) {
      schedule('config', hot.reloadConfig);
    } else if (name === CONFIG_DIR) {
      if (!fs.existsSync(localToolsDir)) {
        localToolsWatch.stop();
        schedule('config', hot.reloadConfig);
      } else if (!localToolsWatch.running()) {
        localToolsWatch.start();
        schedule('config', hot.reloadConfig);
        schedule('prompts', hot.reloadPrompts);
      }
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

  /** An entry of the checkout changed: config/ appearing or going away (a deploy that replaces it) starts or drops
   * its watcher and reloads both layers. */
  function onRootEntry(name: string) {
    if (name !== CONFIG_DIR) return;
    if (!fs.existsSync(toolsDir)) toolsWatch.stop();
    else toolsWatch.start();
    schedule('config', hot.reloadConfig);
    schedule('prompts', hot.reloadPrompts);
  }

  hot.watch = () => {
    const rootWatcher = watchImpl(rootDir, (event, file) => {
      const name = file ? String(file) : '';
      onRootEntry(name);
      if (!privateApart) onPrivateEntry(name);
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

    // The settings, the labels and the tool texts: config/ under the checkout, data/config/ under the private
    // directory (either may be absent).
    if (fs.existsSync(toolsDir)) toolsWatch.start();
    if (fs.existsSync(localToolsDir)) localToolsWatch.start();
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
    toolsWatch.forget();
    localToolsWatch.forget();
  };

  return hot;
}
