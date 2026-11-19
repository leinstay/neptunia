// Hot configuration and prompt layers combine engine defaults with data/config and data/prompts. Settings and
// labels merge recursively; a prompt is a `.md` file at any depth, keyed by its relative path, and a nonempty personal
// file replaces the shared file of the same path. Reloads retain the previous good value after a partial write. Watchers follow both roots.
// Legacy personal layouts refuse startup with offline migration guidance. Hashes describe the live layers.

import fs from 'node:fs';
import { resolvePaths } from './paths.ts';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { readConfig, deepMerge, isPlainObject } from './config.ts';
import { log } from './log.ts';
import { CONFIG_DIR, CONFIG_FILE, LABELS_FILE, localFiles } from './config/files.ts';
import { joinLabels, labelsFileOf } from './config/labels.ts';
// A parsed JSON value or an argument no module types yet: the alias of src/tools/types.ts, restated so this leaf
// imports nothing from src/tools/ (src/memory/ reaches it).
type Untyped = ReturnType<typeof JSON.parse>;

const DEBOUNCE_MS = 250;
const LOCAL_PROMPTS_DIRNAME = 'prompts';
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

/** The value at the steps of `path` in `config`, undefined once a step is missing. */
const valueAtPath = (config: Untyped, path: ReadonlyArray<string>): unknown =>
  path.reduce((node: Untyped, step) => node?.[step], config);

/**
 * Config keys a deployment may still carry that are no longer read, each with what is read
 * instead: `memory.voiceModel` (the memory wording runs on the core's chain, `models.routes.core`); the settings
 * that routed the model roles before their chains, `models.base`, `models.harness`, `llm.boundKeys`,
 * `llm.subscription.fallback`, `llm.reasoningByRole` and `web.quickSearch.model` (every role runs on its chain in
 * `models.routes`, its default effort in `llm.routeEffort`, and quick search on the analyzer's);
 * `features.vision` and `features.attachedDescriptions` (pictures never go into the persona's own
 * request: she sees through the describer's captions and her second look, both on the `vision` model
 * role); `wakes.loop.strayFollowUps`
 * (an inner turn's output tags act as calls now, so nothing is left to follow up). No bound in the
 * engine is in dollars: `wakes.caps.usdPerDay`, `wakes.estimatedTurnUsd`,
 * `wakes.errandReserveMaxMinutes`, `agents.<agent>.daily.usd` and `agents.<agent>.limits.usd` are
 * not read (the provider keys' own limits are the money bounds; costs are only reported). `selfimprovement.*`,
 * `development.*` and `models.development.*` name a development worker the engine does not have, `models.errands.*`
 * the errand agents' models, which their routes hold in `models.agents.model`, and `board.*` the
 * board's own operations and reaper, so nothing reads them. The diary's settings are `diary.*`, and a
 * `selfreflection` key is not read (an ignored `selfreflection.enabled` leaves the diary on by its default).
 * `context.myDay.people` named the people of the counts of what she made, which no request holds.
 * `models.routes.humanizer.linter` and `models.routes.humanizer.writer` are chains under role names the routing does
 * not know: the humanizer's linter runs on the role `linter` and its writer on the role `editor`. Their role
 * segment holds a dot, so each entry gives its path.
 * `models.routes.search` is a chain under a role the routing does not have: quick search condenses and searches on
 * the analyzer.
 */
const RETIRED_CONFIG_KEYS = Object.freeze(
  [
    { key: 'memory.voiceModel', use: 'models.routes.core' },
    { key: 'models.base', use: 'models.routes' },
    { key: 'models.harness', use: 'models.routes' },
    { key: 'llm.boundKeys', use: 'models.routes' },
    { key: 'llm.subscription.fallback', use: 'models.routes.core' },
    { key: 'llm.reasoningByRole', use: 'llm.routeEffort' },
    { key: 'web.quickSearch.model', use: 'models.routes.analyzer' },
    { key: 'models.routes.search', use: 'models.routes.analyzer' },
    { key: 'features.vision', use: null },
    { key: 'features.attachedDescriptions', use: null },
    { key: 'wakes.loop.strayFollowUps', use: 'wakes.loop.maxSteps' },
    { key: 'wakes.caps.usdPerDay', use: null },
    { key: 'wakes.caps.perDay', use: null },
    { key: 'wakes.caps.perHour', use: null },
    { key: 'wakes.caps.publicPostsPerDay', use: null },
    { key: 'wakes.estimatedTurnUsd', use: null },
    { key: 'wakes.errandReserveMaxMinutes', use: null },
    { key: 'intentions.droppedDays', use: null },
    { key: 'heartbeat.droppedDays', use: null },
    { key: 'heartbeat.droppedShown', use: null },
    { key: 'selfimprovement', use: null },
    { key: 'development', use: null },
    { key: 'models.development', use: null },
    { key: 'models.errands', use: 'models.agents.model' },
    { key: 'board', use: null },
    { key: 'selfreflection', use: 'diary' },
    { key: 'diary.openingsShown', use: null },
    { key: 'diary.openingWords', use: null },
    { key: 'context.myDay.people', use: null },
    {
      key: 'models.routes.humanizer.linter',
      use: 'models.routes.linter',
      path: ['models', 'routes', 'humanizer.linter'],
    },
    {
      key: 'models.routes.humanizer.writer',
      use: 'models.routes.editor',
      path: ['models', 'routes', 'humanizer.writer'],
    },
  ].map(({ key, use, path }: { key: string; use: string | null; path?: Array<string> }) => ({
    key,
    use,
    read: (config: Untyped) => valueAtPath(config, path ?? key.split('.')),
  }))
);

/**
 * The retired keys of each entry of `agents` in the config, whatever agent it names: the dollar caps, and the socket,
 * out folder that the unit of a profile gives (src/agent-runner/profiles.ts), and the search provider of the runner.
 */
const RETIRED_AGENT_KEYS = Object.freeze(['daily.usd', 'limits.usd', 'socket', 'out', 'searchProvider']);

/** The retired keys of RETIRED_CONFIG_KEYS and of every agent `config.agents` names, each with its reader. */
function retiredKeysOf(
  config: unknown
): Array<{ key: string; use: string | null; read: (config: Untyped) => unknown }> {
  const section: unknown = typeof config === 'object' && config !== null ? Reflect.get(config, 'agents') : null;
  const agents = typeof section === 'object' && section !== null ? Object.keys(section) : [];
  const perAgent = agents.flatMap((agent) =>
    RETIRED_AGENT_KEYS.map((name) => {
      const key = `agents.${agent}.${name}`;
      return { key, use: null, read: (given: Untyped) => valueAtPath(given, key.split('.')) };
    })
  );
  return [...RETIRED_CONFIG_KEYS, ...perAgent];
}

/**
 * Prompt keys a deployment's own file may still sit under, each with the key read in its place, or with a folder (a
 * key ending in `/`) for a file split into one file per family there. A file under one of them is not read: the load
 * warns of it and `neptunia doctor` reports it.
 */
const RETIRED_PROMPT_KEYS: Readonly<Record<string, string>> = Object.freeze({
  'system-prompt': 'main',
  'character-card': 'persona',
  'speech-prepare': 'speech',
  reply: 'turn/reply',
  'follow-up': 'turn/follow',
  overheard: 'turn/overheard',
  inner: 'turn/inner',
  'errand-result': 'turn/errand',
  private: 'turn/private',
  'private-open': 'turn/private',
  describe: 'describe/picture',
  'describe-gif': 'describe/gif',
  'describe-video': 'describe/video',
  'describe-audio': 'describe/audio',
  avatar: 'describe/avatar',
  'rewatch-answer': 'describe/rewatch',
  'memory-session': 'memory/session',
  'description-draft': 'memory/draft',
  'description-check': 'memory/check',
  'description-merge': 'memory/merge',
  'summarize-media': 'summarize/media',
  'summarize-text': 'summarize/text',
  'recall-summary': 'summarize/recall',
  'search-summary': 'summarize/search',
  address: 'classify/address',
  merge: 'classify/merge',
  missed: 'classify/missed',
  split: 'classify/split',
  'query-builder': 'classify/query',
  'media-pick': 'classify/pick',
  'humanizer-linter': 'humanizer/linter',
  'humanizer-writer': 'humanizer/editor',
  diary: 'diary/task',
  heartbeat: 'heartbeat/task',
  'diary-scene': 'diary/scene',
  'diary-seeds': 'diary/seeds/',
  'heartbeat-seeds': 'heartbeat/seeds/',
});

/** Whether `name`, a prompt key, is one of RETIRED_PROMPT_KEYS. */
const isRetiredPrompt = (name: string): boolean => Object.hasOwn(RETIRED_PROMPT_KEYS, name);

/**
 * The prompt files under `localPromptsDir` at a key of RETIRED_PROMPT_KEYS, each as `{ file, use }`: its path and the
 * path read in its place, both relative to that folder. The load's warning and the doctor's `local-layer` read it.
 */
export function retiredPromptFiles(localPromptsDir: string): Array<{ file: string; use: string }> {
  return listPromptFiles(localPromptsDir)
    .map((file) => file.slice(0, -'.md'.length))
    .filter(isRetiredPrompt)
    .map((name) => {
      const target = RETIRED_PROMPT_KEYS[name];
      // A folder target takes the file's families, one file each.
      return { file: `${name}.md`, use: target.endsWith('/') ? `${target}<family>.md` : `${target}.md` };
    });
}

/**
 * The live view `createHot` returns. `config` is the parsed settings and `prompts` the loaded prompt files, each
 * a JSON tree whose shape `config/` and src/config/schema.ts define and every reader checks as it reads, so
 * both are untyped here.
 */
export type Hot = EventEmitter & {
  config: Untyped;
  prompts: Record<string, Untyped> & { labels: Untyped; 'summarize/search'?: string };
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
 * Paths relative to `dir`, with `/` between the parts, of every `*.md` file at any depth under `dir`, or `[]` when
 * `dir` is absent.
 */
function listPromptFiles(dir: string) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  const out: Array<string> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const relative = path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep);
    out.push(relative.join('/'));
  }
  return out;
}

/**
 * The prompts directly under the folder key `folder` of `prompts` as `{ <base name>: text }`: for `heartbeat/seeds`
 * the entries `heartbeat/seeds/<name>`, none deeper.
 */
export function promptsInFolder(prompts: Record<string, unknown>, folder: string): Record<string, unknown> {
  const prefix = `${folder}/`;
  const out: Record<string, unknown> = {};
  for (const [key, text] of Object.entries(prompts)) {
    const name = key.slice(prefix.length);
    if (key.startsWith(prefix) && !name.includes('/')) out[name] = text;
  }
  return out;
}

/** Text of `<dir>/<file>`, stripped of BOM/CRLF and trimmed, or `null` when the file does not exist. */
function readMdFile(dir: Untyped, file: Untyped) {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return null;
  return stripText(fs.readFileSync(full, 'utf8'));
}

/**
 * Merge the base and local `*.md` layers into `{ prompts, sources, keptPrevious }`, each file keyed by its path
 * relative to its layer without the extension (`diary/kinds/story`).
 * A local file replaces the base file of the same path once it is non-empty
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
  const files = new Set([...listPromptFiles(promptsDir), ...listPromptFiles(localPromptsDir)]);
  const prompts: Record<string, unknown> = {};
  const sources: Record<string, string> = {};
  const keptPrevious: Array<string> = [];

  for (const file of files) {
    const name = file.slice(0, -'.md'.length);
    const baseText = readMdFile(promptsDir, file);
    // A deployment file at a retired key is not read, and the key stays absent without a tracked file of that path.
    const retired = isRetiredPrompt(name);
    if (retired && baseText === null) continue;
    const localText = retired ? null : readMdFile(localPromptsDir, file);
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
 * `{ value, source }` of the labels: `config/labels.json` joined (src/config/labels.ts), with the private
 * `data/config/labels.json` joined and deep-merged over it. Throws on invalid JSON and on a key in both sections.
 */
function computeLabels(rootDir: string, privateDir: string) {
  const tracked = readJsonFile(path.join(rootDir, CONFIG_DIR), path.basename(LABELS_FILE, '.json'));
  const base = tracked === undefined ? {} : joinLabels(labelsFileOf(tracked));
  const found = localFiles(privateDir).labels;
  const local = found === null ? undefined : readJsonFile(path.dirname(found), path.basename(found, '.json'));
  if (local === undefined) return { value: base, source: 'base' };
  return { value: deepMerge(base, joinLabels(labelsFileOf(local))), source: 'merged' };
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
 * `rootDir`, data/config/ and data/prompts/ under `privateDir` (default `rootDir`).
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
  const toolsDir = path.join(rootDir, CONFIG_DIR);
  const localToolsDir = path.join(privateDir, CONFIG_DIR);
  // The properties of `Hot` are all assigned below, before `hot` leaves this function.
  const hot = new EventEmitter() as Hot;
  const watchers: Array<Untyped> = [];
  const timers = new Map();
  let localWatcher: fs.FSWatcher | null = null;
  // Whether the private layer sits in a directory of its own, which then needs its own watcher.
  const privateApart = path.resolve(privateDir) !== path.resolve(rootDir);

  hot.config = readConfig(rootDir, { privateDir });
  // The retired keys reported for the config now live: one warning when a key appears (at
  // startup or on a reload), none while it stays, another once it was removed and set again.
  const reportedRetired = new Set();
  const reportRetiredKeys = () => {
    const retired = retiredKeysOf(hot.config);
    for (const key of reportedRetired) if (!retired.some((one) => one.key === key)) reportedRetired.delete(key);
    for (const { key, use, read } of retired) {
      if (read(hot.config) == null) {
        reportedRetired.delete(key);
      } else if (!reportedRetired.has(key)) {
        reportedRetired.add(key);
        log.warn(`config: ${key} is no longer read`, { key, use });
      }
    }
  };
  reportRetiredKeys();
  // The deployment's prompt files at a retired key reported like the retired settings: one warning when a file
  // appears, none while it stays.
  const reportedPrompts = new Set<string>();
  const reportRetiredPrompts = () => {
    const found = retiredPromptFiles(localPromptsDir);
    for (const file of reportedPrompts) if (!found.some((one) => one.file === file)) reportedPrompts.delete(file);
    for (const { file, use } of found) {
      if (reportedPrompts.has(file)) continue;
      reportedPrompts.add(file);
      log.warn('prompts: a file is no longer read', { file, use });
    }
  };
  reportRetiredPrompts();
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
   * journal's `reload` records hang on (src/index.ts), as this module knows no place.
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

      // `json` holds every layer of JSON_LAYERS, `labels` among them.
      const next: Record<string, Untyped> = { ...mdPrompts, ...json };
      hot.prompts = next as Hot['prompts'];
      hot.promptSources = { ...mdSources, ...jsonSources };
      hot.hashes = { ...hot.hashes, promptsHash: shortHash(hot.prompts) };
      log.info('hot: prompts reloaded', {
        prompts: Object.keys(mdPrompts),
        keptPrevious,
      });
      reportRetiredPrompts();
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

  /** An entry of a recursively watched prompts folder: a prompt file, or a folder that may hold some (moved in whole). */
  function isPromptEntry(dir: string, file: Untyped) {
    return isPromptFile(file) || fs.statSync(path.join(dir, String(file)), { throwIfNoEntry: false })?.isDirectory();
  }

  /** Close and forget the data/prompts/ watcher, so a directory created again gets a new one. */
  function stopLocalWatch() {
    const watcher = localWatcher;
    if (!watcher) return;
    localWatcher = null;
    dropWatcher(watchers, watcher);
  }

  function startLocalWatch() {
    if (localWatcher) return;
    try {
      // Recursive: on Linux Node adds a watch for every folder below, a folder created later included.
      const watcher = watchImpl(localPromptsDir, { recursive: true }, (event, file) => {
        if (isPromptEntry(localPromptsDir, file)) schedule('prompts', hot.reloadPrompts);
      });
      localWatcher = watcher;
      watchers.push(watcher);
      // A watcher whose directory went away errors out: drop it, the root watcher starts the next one.
      attachErrorHandler(watcher, () => {
        if (localWatcher === watcher) stopLocalWatch();
      });
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

  /** An entry of the private directory changed: data/prompts/ and data/config/ appearing or going away start or drop
   * their watchers. */
  function onPrivateEntry(name: string) {
    if (name === CONFIG_DIR) {
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

    const baseWatcher = watchImpl(promptsDir, { recursive: true }, (event, file) => {
      if (isPromptEntry(promptsDir, file)) schedule('prompts', hot.reloadPrompts);
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
    toolsWatch.forget();
    localToolsWatch.forget();
  };

  return hot;
}
