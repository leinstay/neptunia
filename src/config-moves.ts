// The config keys that moved: the settings under `skills.*`, the switches `features.skills` and
// `features.skillsDiscovery`, the owner's grants on the tools that were renamed (`skills.describe`, the six `task.*` and
// the four `intent.*`), the nine settings of `agents` that every errand reads (they live under `errands`),
// `agents.<name>.search.provider` (now `searchProvider`), the analyzer timeout `llm.helperTimeoutMs` (now
// `llm.analyzerTimeoutMs`), the switch `features.innerLife` (now `features.wakes`), and the sections of the wakes and
// the three ticking mechanics (MECHANIC_MOVES): `innerLife.heartbeat.*` and `innerLife.wakes.heartbeat.*` under
// `heartbeat`, `diary.*` under `selfreflection`, `selfdev.*` and `innerLife.wakes.selfimprovement.*` under
// `selfimprovement`, the other `innerLife.wakes.<kind>.*` under `wakes.kinds`, and the rest of `innerLife.*` under
// `wakes`, then the old forms of a schedule (`watcher.at`, `selfimprovement.at`, `heartbeat.everyMinutes`) under
// `<name>.schedule`, a value that is no schedule dropped and reported. A local config written with the old keys keeps its meaning
// because `moveConfigKeys` writes each old key under its new name, and the loader (src/config.ts#readConfig) applies it to
// the local file before that file is laid over config.json, so an old key overrides the shipped default of its new name.
// `scripts/config-migrate.ts` writes the same moves into the file.
//
// The moves are one ordered list. A move whose old key is absent does nothing, so applying the list twice gives the
// same config. Where the old and the new key are both set, the new one wins and the old one is dropped and reported as
// shadowed. Keys nothing reads any more (three grants of `bot.access`, `agents.maxDownloadBytes`, the two context
// keys of `agents.thinker`, `agents.ledger.socket`, and `bot.commandName` and `features.adminCommands` of the slash
// command that is gone) are removed, with a section they leave empty, and reported as dropped. `selfreflection.placeId` is the seed of the diary's mirror
// (schema v15): once the memory database has that mirror (`diaryMirror`, told by the caller) the key is removed and
// reported as moved to the database (`toDatabase`). Nothing here reads a file.
//
// The grants of `bot.access` stored under the keys of the old slash command (`memory.show`, `emoji.rescan`, ...) are
// read by `legacyGrantOps`, which src/tools/impl/access.ts#migrateStoredGrants calls once per place at start.

import { formatSchedule, parseSchedule } from './service/schedule.ts';

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
  /** The dotted paths of the keys removed because the memory database holds them (`selfreflection.placeId`). */
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

/** The keys the `skills` section holds for the SKILL.md skills; they stay where they are. */
const SKILL_FILE_KEYS: ReadonlyArray<string> = ['reviewDays'];

/** The keys of the `skills` section move to `tools`, one by one, except the SKILL.md settings; the emptied section is dropped. */
function moveSection(config: Config, report: MovedConfig): void {
  const old = sectionOf(config, 'skills', false);
  if (old === null || Object.keys(old).length === 0) return;
  const moving = Object.keys(old).filter((key) => !SKILL_FILE_KEYS.includes(key));
  if (moving.length === 0) return;
  const target = sectionOf(config, 'tools', true);
  if (target === null) return;
  for (const key of moving)
    place(old, target, { from: key, to: key }, { from: `skills.${key}`, to: `tools.${key}` }, report);
  if (Object.keys(old).length === 0) delete config.skills;
}

/** One key of the section `at` of `config` renamed. */
function renameKey(config: Config, at: string, from: string, to: string, report: MovedConfig): void {
  const section = sectionOf(config, at, false);
  if (section === null || !Object.hasOwn(section, from)) return;
  place(section, section, { from, to }, { from: `${at}.${from}`, to: `${at}.${to}` }, report);
}

/**
 * The grants of `bot.access` that moved with their tool: the old key, a dotted tool name, and the new one. The errand
 * tools once held `task.status` and `task.cancel`; those names belong to the board tools, so a file still holding them
 * is not moved (production moved them to `errand.*` before the rename).
 */
export const GRANT_MOVES: ReadonlyArray<[string, string]> = [
  ['skills.describe', 'tools.describe'],
  ['task.run', 'errand.run'],
  ['task.read', 'errand.read'],
  ['task.resolve', 'errand.resolve'],
  ['task.list', 'errand.list'],
  ['intent.set', 'intention.set'],
  ['intent.update', 'intention.update'],
  ['intent.cancel', 'intention.cancel'],
  ['intent.list', 'intention.list'],
  ['board.propose', 'task.propose'],
  ['board.status', 'task.status'],
  ['board.cancel', 'task.cancel'],
  ['board.comment', 'task.comment'],
  ['board.answer', 'task.answer'],
  ['board.unblock', 'task.unblock'],
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
export const DROPPED_KEYS: ReadonlyArray<ReadonlyArray<string>> = [
  ['agents', 'maxDownloadBytes'],
  ['agents', 'thinker', 'contextLimit'],
  ['agents', 'thinker', 'contextHard'],
  ['agents', 'ledger', 'socket'],
  ['bot', 'commandName'],
  ['memory', 'mainChannelIds'],
  ['features', 'adminCommands'],
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

/**
 * The sections that moved to a section of their own, in this order: the old section's path and the new one's. Every
 * key of the old section moves, the keys the config cut holds with them (src/config/cut.ts knows them under the new
 * names, `selfreflection.set`, `heartbeat.people`, `wakes.queueMax`). The three ticking mechanics take what only they
 * read, the selfimprovement and heartbeat wakes' limits included (`tools`, `maxActs`, `maxTasks`, `inputTokens`); the
 * other wake kinds' limits go under `wakes.kinds`, and the rest of `innerLife`, the wake engine every kind shares, is
 * `wakes`.
 */
export const MECHANIC_MOVES: ReadonlyArray<{ from: ReadonlyArray<string>; to: ReadonlyArray<string> }> = [
  { from: ['innerLife', 'heartbeat'], to: ['heartbeat'] },
  { from: ['diary'], to: ['selfreflection'] },
  { from: ['selfdev'], to: ['selfimprovement'] },
  { from: ['innerLife', 'wakes', 'selfimprovement'], to: ['selfimprovement'] },
  { from: ['innerLife', 'wakes', 'heartbeat'], to: ['heartbeat'] },
  { from: ['innerLife', 'wakes'], to: ['wakes', 'kinds'] },
  { from: ['innerLife'], to: ['wakes'] },
];

/** The section at `path` of `config`, made on the way when `make` is true; null where something else is. */
function sectionAt(config: Config, path: ReadonlyArray<string>, make: boolean): Config | null {
  let node: Config | null = config;
  for (const name of path) {
    node = node === null ? null : sectionOf(node, name, make);
  }
  return node;
}

/** The sections of MECHANIC_MOVES moved key by key to their new section; each section left empty goes. */
function moveMechanics(config: Config, report: MovedConfig): void {
  for (const move of MECHANIC_MOVES) {
    const chain: Array<Config> = [config];
    for (const name of move.from) {
      const next = sectionOf(chain[chain.length - 1] ?? config, name, false);
      if (next === null) break;
      chain.push(next);
    }
    const old = chain[chain.length - 1];
    if (chain.length !== move.from.length + 1 || old === undefined) continue;
    const keys = Object.keys(old);
    if (keys.length === 0) continue;
    const target = sectionAt(config, move.to, true);
    if (target === null) continue;
    const at = move.from.join('.');
    const to = move.to.join('.');
    for (const key of keys)
      place(old, target, { from: key, to: key }, { from: `${at}.${key}`, to: `${to}.${key}` }, report);
    for (let depth = chain.length - 1; depth > 0; depth -= 1) {
      if (Object.keys(chain[depth] ?? {}).length > 0) break;
      delete (chain[depth - 1] ?? config)[move.from[depth - 1] ?? ''];
    }
  }
}

/** The text a daily time holds as a schedule, null when it is no time. */
const scheduleOfTime = (value: unknown): string | null => {
  const schedule = typeof value === 'string' ? parseSchedule(`at ${value}`) : null;
  return schedule === null ? null : formatSchedule(schedule);
};

/** The text a number of minutes holds as a schedule, null when it is no interval. */
const scheduleOfMinutes = (value: unknown): string | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0
    ? formatSchedule({ kind: 'every', everyMinutes: value })
    : null;

/** The old keys of a schedule: each section, its key, and what its value means as a schedule. */
const SCHEDULE_MOVES: ReadonlyArray<{ section: string; key: string; read: (value: unknown) => string | null }> = [
  { section: 'watcher', key: 'at', read: scheduleOfTime },
  { section: 'selfimprovement', key: 'at', read: scheduleOfTime },
  { section: 'heartbeat', key: 'everyMinutes', read: scheduleOfMinutes },
];

/** Each old key of a schedule written as `<section>.schedule`; a junk value is dropped, a new schedule wins. */
function moveSchedules(config: Config, report: MovedConfig): void {
  for (const { section, key, read } of SCHEDULE_MOVES) {
    const held = sectionOf(config, section, false);
    if (held === null || !Object.hasOwn(held, key)) continue;
    const schedule = read(held[key]);
    const from = `${section}.${key}`;
    delete held[key];
    if (schedule === null) report.dropped.push(from);
    else if (Object.hasOwn(held, 'schedule')) report.shadowed.push({ from, to: `${section}.schedule` });
    else {
      held.schedule = schedule;
      report.moved.push({ from, to: `${section}.schedule` });
    }
    if (Object.keys(held).length === 0) delete config[section];
  }
}

/** `selfreflection.placeId` removed once the memory database has the diary's mirror; a section it empties goes too. */
function moveDiarySeed(config: Config, diaryMirror: boolean, report: MovedConfig): void {
  const section = sectionOf(config, 'selfreflection', false);
  if (!diaryMirror || section === null || !Object.hasOwn(section, 'placeId')) return;
  delete section.placeId;
  if (Object.keys(section).length === 0) delete config.selfreflection;
  report.toDatabase.push('selfreflection.placeId');
}

/**
 * `config` with the old keys written under their new names. `diaryMirror`: the memory database has the diary's mirror,
 * so `selfreflection.placeId` (or the old `diary.placeId`) goes and `toDatabase` names it (empty otherwise). The argument is not changed.
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
  renameKey(report.config, 'features', 'innerLife', 'wakes', report);
  dropKeys(report.config, report);
  moveMechanics(report.config, report);
  moveSchedules(report.config, report);
  moveDiarySeed(report.config, diaryMirror, report);
  return report;
}

/**
 * The keys of the old slash command, before the operations layer, each with the operation it ran with no optional
 * argument. Never dispatched: only `legacyGrantOps` reads it, for the grants stored under those keys.
 */
const LEGACY_COMMAND_TO_OP: Readonly<Record<string, string>> = Object.freeze({
  status: 'status.show',
  set: 'config.set',
  unset: 'config.unset',
  pause: 'bot.pause',
  resume: 'bot.resume',
  interject: 'message.create',
  initiate: 'message.create',
  draw: 'draw.create',
  pings: 'pings.get',
  'emoji.status': 'media.status',
  'emoji.rescan': 'media.rescan',
  'gifs.status': 'media.status',
  'gifs.rescan': 'media.rescan',
  'gifs.recache': 'media.recache',
  'model.show': 'model.show',
  'model.set': 'model.set',
  'route.list': 'route.list',
  'route.set': 'route.set',
  'route.remove': 'route.remove',
  'rule.add': 'rule.add',
  'rule.list': 'rule.list',
  'rule.remove': 'rule.remove',
  'access.grant': 'access.grant',
  'access.revoke': 'access.revoke',
  'access.list': 'access.list',
  'alias.add': 'alias.add',
  'alias.remove': 'alias.remove',
  'learned.add': 'learning.add',
  'learned.remove': 'learning.remove',
  'lore.add': 'lore.add',
  'lore.list': 'lore.list',
  'lore.show': 'lore.show',
  'lore.remove': 'lore.remove',
  'memory.show': 'memory.profile.read',
  'memory.channel': 'memory.channel.read',
  'memory.server': 'memory.server.read',
  'memory.recent': 'memory.recent.read',
  'memory.affinity': 'memory.affinity.read',
  'memory.journal': 'memory.journal.read',
  'memory.archive': 'memory.archive.read',
  'memory.restore': 'memory.restore',
  'memory.snapshot': 'memory.snapshot',
  'private.show': 'memory.private.read',
});

/**
 * The operations an old slash-command grant covered, for the one-time migration of the stored grants
 * (src/tools/impl/grants.ts#migrateGrants): `*` -> every operation of `everyOp` (`from: '*'`); an old command key ->
 * the operation it ran (`memory.affinity` -> `memory.affinity.read`); an old group -> its keys' operations (`from` the
 * group); a key with no operation (`ping`, `reload`, `learned.list` and the other removed commands) -> null, and such
 * a grant is dropped.
 */
export function legacyGrantOps(
  key: string,
  everyOp: ReadonlyArray<string> = []
): { from: string | null; names: Array<string> } | null {
  if (key === '*') return { from: '*', names: [...everyOp] };
  const opOf = (full: string): string => LEGACY_COMMAND_TO_OP[full] ?? '';
  if (Object.hasOwn(LEGACY_COMMAND_TO_OP, key)) return { from: null, names: [opOf(key)] };
  const under = Object.keys(LEGACY_COMMAND_TO_OP).filter((full) => full.startsWith(`${key}.`));
  if (under.length === 0) return null;
  return { from: key, names: [...new Set(under.map(opOf))] };
}
