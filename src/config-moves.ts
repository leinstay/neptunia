// The config keys that moved when the persona's skills became tools: the settings under `skills.*`, the switches
// `features.skills` and `features.skillsDiscovery`, and the owner's grant on the tool `skills.describe`. A local config
// written with the old keys keeps its meaning because `moveConfigKeys` writes each old key under its new name, and the
// loader (src/config.js#readConfig) applies it to the local file before that file is laid over config.json, so an old
// key overrides the shipped default of its new name. `tools/config-migrate.mjs` writes the same moves into the file.
//
// The moves are one ordered list. A move whose old key is absent does nothing, so applying the list twice gives the
// same config. Where the old and the new key are both set, the new one wins and the old one is dropped and reported as
// shadowed. Nothing here reads a file.

type Config = Record<string, unknown>;

/** One key that moved: dotted paths, the old spelling and the new. */
export type Move = { from: string; to: string };

export type MovedConfig = {
  config: Config;
  /** The keys that were written under their new name. */
  moved: Array<Move>;
  /** The old keys left unused because the new name was already set. */
  shadowed: Array<Move>;
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

/** The persona's grant on the tool `skills.describe`, a key of `bot.access` whose name holds a dot. */
function moveGrant(config: Config, report: MovedConfig): void {
  const bot = sectionOf(config, 'bot', false);
  const access = bot === null ? null : sectionOf(bot, 'access', false);
  if (access === null || !Object.hasOwn(access, 'skills.describe')) return;
  const paths = { from: 'bot.access.skills.describe', to: 'bot.access.tools.describe' };
  if (Object.hasOwn(access, 'tools.describe')) {
    delete access['skills.describe'];
    report.shadowed.push(paths);
    return;
  }
  access['tools.describe'] = access['skills.describe'];
  delete access['skills.describe'];
  report.moved.push(paths);
}

/** `config` with the old keys of the tools written under their new names. The argument is not changed. */
export function moveConfigKeys(config: Config): MovedConfig {
  const report: MovedConfig = { config: structuredClone(config), moved: [], shadowed: [] };
  moveSection(report.config, report);
  renameKey(report.config, 'features', 'skills', 'tools', report);
  renameKey(report.config, 'features', 'skillsDiscovery', 'toolsDiscovery', report);
  moveGrant(report.config, report);
  return report;
}
