// The config keys that moved: the settings under `skills.*`, the switches `features.skills` and
// `features.skillsDiscovery`, the owner's grants on the tools that were renamed (`skills.describe`, the six `task.*` and
// the four `intent.*`), the nine settings of `agents` that every errand reads (they live under `errands`),
// `agents.<name>.search.provider` (now `searchProvider`) and the analyzer timeout `llm.helperTimeoutMs` (now
// `llm.analyzerTimeoutMs`). A local config written with the old keys keeps its meaning
// because `moveConfigKeys` writes each old key under its new name, and the loader (src/config.js#readConfig) applies it to
// the local file before that file is laid over config.json, so an old key overrides the shipped default of its new name.
// `tools/config-migrate.mjs` writes the same moves into the file.
//
// The moves are one ordered list. A move whose old key is absent does nothing, so applying the list twice gives the
// same config. Where the old and the new key are both set, the new one wins and the old one is dropped and reported as
// shadowed. Keys nothing reads any more (three grants of `bot.access`, `agents.maxDownloadBytes`, the two context
// keys of `agents.thinker` and `agents.ledger.socket`) are removed, with a section they leave empty, and reported as
// dropped. `diary.channelId` is the seed of the diary's mirror
// (schema v15): once the memory database has that mirror (`diaryMirror`, told by the caller) the key is removed and
// reported as moved to the database (`toDatabase`). Nothing here reads a file.

type Config = Record<string, unknown>;

/** One key that moved: dotted paths, the old spelling and the new. */
export type Move = { from: string; to: string };

export type MovedConfig = {
  config: Config;
  /** The keys that were written under their new name. */
  moved: Array<Move>;
  /** The old keys left unused because the new name was already set. */
  shadowed: Array<Move>;
  /** The dotted paths of the keys removed because nothing reads them. */
  dropped: Array<string>;
  /** The dotted paths of the keys removed because the memory database holds them (`diary.channelId`). */
  toDatabase: Array<string>;
};

const isObject = (value: unknown): value is Config =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `from[key]` placed at `to[key]`. A plain object meeting a plain object is merged key by key, the new keys winning.
 * Every key that arrived is in `moved`, every old key that lost to a new one is in `shadowed`.
 */
function place(from: Config, to: Config, names: { from: string; to: string }, paths: Move, report: MovedConfig): void {
  const value = from[names.from];
  delete from[names.from];
  const target = to[names.to];
  if (!Object.hasOwn(to, names.to)) {
    to[names.to] = value;
    report.moved.push(paths);
    return;
  }
  if (isObject(value) && isObject(target)) {
    for (const inner of Object.keys(value)) {
      const name = { from: inner, to: inner };
      place(value, target, name, { from: `${paths.from}.${inner}`, to: `${paths.to}.${inner}` }, report);
    }
    return;
  }
  report.shadowed.push(paths);
}

/** The section `name` of `config`, made when `make` is true and nothing is there; null when something else is. */
function sectionOf(config: Config, name: string, make: boolean): Config | null {
  const found = config[name];
  if (isObject(found)) return found;
  if (found !== undefined || !make) return null;
  const made: Config = {};
  config[name] = made;
  return made;
}

/** The keys of the `skills` section move to `tools`, one by one; the emptied section is dropped. */
function moveSection(config: Config, report: MovedConfig): void {
  const old = sectionOf(config, 'skills', false);
  if (old === null || Object.keys(old).length === 0) return;
  const target = sectionOf(config, 'tools', true);
  if (target === null) return;
  for (const key of Object.keys(old))
    place(old, target, { from: key, to: key }, { from: `skills.${key}`, to: `tools.${key}` }, report);
  if (Object.keys(old).length === 0) delete config.skills;
}

/** One key of the section `at` of `config` renamed. */
function renameKey(config: Config, at: string, from: string, to: string, report: MovedConfig): void {
  const section = sectionOf(config, at, false);
  if (section === null || !Object.hasOwn(section, from)) return;
  place(section, section, { from, to }, { from: `${at}.${from}`, to: `${at}.${to}` }, report);
}

/** The grants of `bot.access` that moved with their tool: the old key, a dotted tool name, and the new one. */
export const GRANT_MOVES: ReadonlyArray<[string, string]> = [
  ['skills.describe', 'tools.describe'],
  ['task.run', 'errand.run'],
  ['task.status', 'errand.status'],
  ['task.read', 'errand.read'],
  ['task.resolve', 'errand.resolve'],
  ['task.cancel', 'errand.cancel'],
  ['task.list', 'errand.list'],
  ['intent.set', 'intention.set'],
  ['intent.update', 'intention.update'],
  ['intent.cancel', 'intention.cancel'],
  ['intent.list', 'intention.list'],
];

/** Grants of tools that no longer exist, keys of `bot.access`. */
export const DROPPED_GRANTS: ReadonlyArray<string> = [
  'memory.refresh.channel',
  'memory.refresh.server',
  'memory.refresh.user',
];

/** The settings of `agents` that every errand reads, which live under `errands`. */
export const ERRAND_KEYS: ReadonlyArray<string> = [
  'opencodePath',
  'toolResultChars',
  'keepFilesHours',
  'recentLines',
  'maxOpen',
  'resultMaxChars',
  'unreadShown',
  'resultRetrySeconds',
  'resultCooldownSeconds',
];

/** The keys nothing reads any more, as dotted paths below the config. */
const DROPPED_KEYS: ReadonlyArray<ReadonlyArray<string>> = [
  ['agents', 'maxDownloadBytes'],
  ['agents', 'thinker', 'contextLimit'],
  ['agents', 'thinker', 'contextHard'],
  ['agents', 'ledger', 'socket'],
];

/** `bot.access` of `config` when it is a plain object. */
function accessOf(config: Config): Config | null {
  const bot = sectionOf(config, 'bot', false);
  return bot === null ? null : sectionOf(bot, 'access', false);
}

/** The owner's grants on the renamed tools, keys of `bot.access` whose names hold a dot. */
function moveGrants(config: Config, report: MovedConfig): void {
  const access = accessOf(config);
  if (access === null) return;
  for (const [from, to] of GRANT_MOVES) {
    if (!Object.hasOwn(access, from)) continue;
    const paths = { from: `bot.access.${from}`, to: `bot.access.${to}` };
    if (Object.hasOwn(access, to)) {
      delete access[from];
      report.shadowed.push(paths);
      continue;
    }
    access[to] = access[from];
    delete access[from];
    report.moved.push(paths);
  }
}

/** The grants of tools that no longer exist are removed. */
function dropGrants(config: Config, report: MovedConfig): void {
  const access = accessOf(config);
  if (access === null) return;
  for (const key of DROPPED_GRANTS) {
    if (!Object.hasOwn(access, key)) continue;
    delete access[key];
    report.dropped.push(`bot.access.${key}`);
  }
}

/** The shared settings of `agents` move to `errands`; an `agents` section left empty is dropped. */
function moveErrandKeys(config: Config, report: MovedConfig): void {
  const agents = sectionOf(config, 'agents', false);
  if (agents === null) return;
  for (const key of ERRAND_KEYS) {
    if (!Object.hasOwn(agents, key)) continue;
    const target = sectionOf(config, 'errands', true);
    if (target === null) return;
    place(agents, target, { from: key, to: key }, { from: `agents.${key}`, to: `errands.${key}` }, report);
  }
  if (Object.keys(agents).length === 0) delete config.agents;
}

/** `agents.<name>.search.provider` becomes `agents.<name>.searchProvider`, the shape a profile has. */
function moveSearchProvider(config: Config, report: MovedConfig): void {
  const agents = sectionOf(config, 'agents', false);
  if (agents === null) return;
  for (const name of Object.keys(agents)) {
    const agent = sectionOf(agents, name, false);
    const search = agent === null ? null : sectionOf(agent, 'search', false);
    if (agent === null || search === null || !Object.hasOwn(search, 'provider')) continue;
    place(
      search,
      agent,
      { from: 'provider', to: 'searchProvider' },
      { from: `agents.${name}.search.provider`, to: `agents.${name}.searchProvider` },
      report
    );
    if (Object.keys(search).length === 0) delete agent.search;
  }
}

/** The keys nothing reads any more are removed, and a section they leave empty with them. */
function dropKeys(config: Config, report: MovedConfig): void {
  for (const path of DROPPED_KEYS) {
    const chain: Array<Config> = [config];
    for (const name of path.slice(0, -1)) {
      const next = sectionOf(chain[chain.length - 1] ?? config, name, false);
      if (next === null) break;
      chain.push(next);
    }
    const last = path[path.length - 1];
    const section = chain[chain.length - 1];
    if (chain.length !== path.length || section === undefined || last === undefined || !Object.hasOwn(section, last))
      continue;
    delete section[last];
    report.dropped.push(path.join('.'));
    for (let depth = chain.length - 1; depth > 0; depth -= 1) {
      if (Object.keys(chain[depth] ?? {}).length > 0) break;
      delete (chain[depth - 1] ?? config)[path[depth - 1] ?? ''];
    }
  }
}

/** `diary.channelId` removed once the memory database has the diary's mirror; a `diary` section it empties goes too. */
function moveDiarySeed(config: Config, diaryMirror: boolean, report: MovedConfig): void {
  const diary = sectionOf(config, 'diary', false);
  if (!diaryMirror || diary === null || !Object.hasOwn(diary, 'channelId')) return;
  delete diary.channelId;
  if (Object.keys(diary).length === 0) delete config.diary;
  report.toDatabase.push('diary.channelId');
}

/**
 * `config` with the old keys written under their new names. `diaryMirror`: the memory database has the diary's mirror,
 * so `diary.channelId` goes and `toDatabase` names it (empty otherwise). The argument is not changed.
 */
export function moveConfigKeys(config: Config, { diaryMirror = false }: { diaryMirror?: boolean } = {}): MovedConfig {
  const report: MovedConfig = { config: structuredClone(config), moved: [], shadowed: [], dropped: [], toDatabase: [] };
  moveSection(report.config, report);
  renameKey(report.config, 'features', 'skills', 'tools', report);
  renameKey(report.config, 'features', 'skillsDiscovery', 'toolsDiscovery', report);
  moveGrants(report.config, report);
  dropGrants(report.config, report);
  moveErrandKeys(report.config, report);
  moveSearchProvider(report.config, report);
  renameKey(report.config, 'llm', 'helperTimeoutMs', 'analyzerTimeoutMs', report);
  dropKeys(report.config, report);
  moveDiarySeed(report.config, diaryMirror, report);
  return report;
}
