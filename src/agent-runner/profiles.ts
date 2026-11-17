// The agents on disk: one folder per agent, `agents/<id>/` at the engine root (tracked) or `<data>/agents/<id>/` (local),
// each holding a `profile.json` and its prompt. The agents are the tracked folders, one per name of UNITS, and each runs
// in the unit of its name. A local folder that shares a tracked agent's name overlays the tracked profile key by key; a
// local folder with any other name is no agent.
//
// A profile holds exactly `id`, `description`, `prompt`, `limits`, `daily` and `cost`. A profile that misses a key, names
// an unknown one or holds a value of the wrong form fails `listAgents` and `loadProfiles` with one error naming the agent
// and the key, and a symbolic link anywhere in the local layer is refused. A profile authorizes nothing: the agent's
// prompt is its only limit, and its unit sets the sandbox of the process (deploy/). The socket and the out folder of a
// unit derive from its name (`unitPaths`). Keep in sync with docs/errands.md and agents/README.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from '../paths.ts';
import { errorFields } from '../error-fields.ts';
import { scalarText } from '../tools/types.ts';

/** The backends an agent can run on: `codex exec`, `claude -p` or OpenCode (src/agent-runner/backend.ts). */
export const BACKEND_NAMES = ['codex', 'claude', 'opencode'] as const;

/** One of BACKEND_NAMES. */
export type BackendName = (typeof BACKEND_NAMES)[number];

/**
 * The agents, each carried by the unit of its name (deploy/): `server` reads this machine, `scout` searches the web,
 * `code` writes code.
 */
export const UNITS = ['server', 'scout', 'code'] as const;

/** One of UNITS. */
export type UnitName = (typeof UNITS)[number];

/** The validated profile.json of an agent. */
export type AgentDefinition = Readonly<{
  id: UnitName;
  description: string;
  prompt: string;
  limits: Readonly<Record<string, number>>;
  daily: Readonly<Record<string, number>>;
  cost: Readonly<{ input: number; output: number }>;
}>;

/** Where an agent's profile comes from: the checkout alone (`tracked`) or overlaid by a local twin (`local`). */
export type AgentOrigin = 'tracked' | 'local';

/** The engine and persona agent trees, resolved independently of private credentials. */
export type AgentPaths = {
  rootDir?: string;
  dataDir?: string;
  env?: Record<string, string | undefined>;
};

type ResolvedAgentPaths = Required<AgentPaths>;

/** One agent's profile, the object the runner and the core use. */
export type Profile = {
  name: string;
  description: string;
  unit: UnitName;
  origin: AgentOrigin;
  promptFiles: Array<string>;
  defaultLimits: Readonly<Record<string, number>>;
  defaultDaily: Readonly<Record<string, number>>;
};

/** The engine root (two levels up from this file). */
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The folder of the agents under an engine root or a data folder: one `<id>/profile.json` per agent. */
const AGENTS_DIRNAME = 'agents';

/** The description file inside an agent's folder. */
const PROFILE_FILE = 'profile.json';

/** The keys of a profile, all required. */
const PROFILE_KEYS: ReadonlyArray<string> = Object.freeze(['id', 'description', 'prompt', 'limits', 'daily', 'cost']);

/** Resolves explicit and environment data paths against the engine root. */
function agentPaths(options: AgentPaths): ResolvedAgentPaths {
  const env = options.env ?? process.env;
  const resolved = resolvePaths({ rootDir: options.rootDir ?? ROOT_DIR, env });
  return {
    rootDir: resolved.rootDir,
    dataDir: options.dataDir === undefined ? resolved.dataDir : path.resolve(resolved.rootDir, options.dataDir),
    env,
  };
}

/** The prompt files of an agent, the local one first. */
function promptCandidates(name: string, paths: ResolvedAgentPaths, prompt: string): Array<string> {
  return [
    path.join(paths.dataDir, AGENTS_DIRNAME, name, prompt),
    path.join(paths.rootDir, AGENTS_DIRNAME, name, prompt),
  ];
}

/** An agent id, the name of its folder: lowercase letters, digits and dashes. */
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** A file name inside a folder: no directory part, a `.md` file. */
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

/** The error a profile that cannot be used fails `listAgents` / `loadProfiles` with: one line naming the agent and the key. */
export class AgentProfileError extends Error {
  agent: string;
  key: string;

  /**
   * @param agent the agent's folder name
   * @param key the offending key (`limits.steps` for a nested one)
   */
  constructor(agent: string, key: string, reason: string) {
    super(`agent profile "${agent}": key "${key}": ${reason}`);
    this.name = 'AgentProfileError';
    this.agent = agent;
    this.key = key;
  }
}

/** Whether `value` is a plain JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Whether `value` is a positive finite number, and a whole one when `whole`. */
function isPositive(value: unknown, whole = false): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && (!whole || Number.isInteger(value));
}

/**
 * Checks an object of positive numbers with exactly the keys of `spec` (`{ key: whole }`), for
 * `limits` and `daily`.
 */
function checkNumbers(agent: string, key: string, value: unknown, spec: Record<string, boolean>): void {
  if (!isObject(value)) throw new AgentProfileError(agent, key, 'must be an object');
  for (const name of Object.keys(value)) {
    if (!Object.hasOwn(spec, name)) throw new AgentProfileError(agent, `${key}.${name}`, 'unknown key');
  }
  for (const [name, whole] of Object.entries(spec)) {
    if (!Object.hasOwn(value, name)) throw new AgentProfileError(agent, `${key}.${name}`, 'missing');
    if (!isPositive(value[name], whole))
      throw new AgentProfileError(
        agent,
        `${key}.${name}`,
        whole ? 'must be a positive whole number' : 'must be a positive number'
      );
  }
}

/** Checks `cost`: exactly `input` and `output`, the USD per million tokens, each finite and not negative (zero is a price). */
function checkCost(agent: string, value: unknown) {
  if (!isObject(value)) throw new AgentProfileError(agent, 'cost', 'must be an object');
  for (const name of Object.keys(value)) {
    if (name !== 'input' && name !== 'output') throw new AgentProfileError(agent, `cost.${name}`, 'unknown key');
  }
  for (const name of ['input', 'output']) {
    if (!Object.hasOwn(value, name)) throw new AgentProfileError(agent, `cost.${name}`, 'missing');
    const price = value[name];
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0)
      throw new AgentProfileError(agent, `cost.${name}`, 'must be a number that is not negative');
  }
}

/** Checks a word key: one of `allowed`. */
function checkWord(agent: string, key: string, value: unknown, allowed: ReadonlyArray<string>): void {
  if (typeof value !== 'string' || !allowed.includes(value))
    throw new AgentProfileError(agent, key, `must be one of ${allowed.join(', ')}`);
}

/** A path-safe agent directory name. */
function checkId(agent: string): void {
  if (typeof agent !== 'string' || !ID_PATTERN.test(agent))
    throw new AgentProfileError(agent, 'id', 'must be lowercase letters, digits and dashes');
}

/**
 * Validates the parsed `profile.json` of the agent in folder `agent`: every key of PROFILE_KEYS present, no other key,
 * each value of the right form. Throws AgentProfileError at the first problem.
 * @param agent the folder name
 */
function validateProfile(agent: string, raw: unknown) {
  if (!isObject(raw)) throw new AgentProfileError(agent, PROFILE_FILE, 'must be a JSON object');
  for (const key of Object.keys(raw)) {
    if (!PROFILE_KEYS.includes(key)) throw new AgentProfileError(agent, key, 'unknown key');
  }
  for (const key of PROFILE_KEYS) {
    if (!Object.hasOwn(raw, key)) throw new AgentProfileError(agent, key, 'missing');
  }
  if (raw.id !== agent) throw new AgentProfileError(agent, 'id', 'must be the folder name');
  checkId(agent);
  checkWord(agent, 'id', raw.id, UNITS);
  if (typeof raw.description !== 'string' || !raw.description.trim())
    throw new AgentProfileError(agent, 'description', 'must be a non-empty string');
  if (typeof raw.prompt !== 'string' || !FILE_NAME_PATTERN.test(raw.prompt))
    throw new AgentProfileError(agent, 'prompt', 'must be a .md file name with no directory part');
  checkNumbers(agent, 'limits', raw.limits, { steps: true, seconds: false });
  checkNumbers(agent, 'daily', raw.daily, { tasks: true });
  checkCost(agent, raw.cost);
}

/** A deep-frozen copy of a parsed JSON value. */
function frozenCopy(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy));
  if (isObject(value))
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, frozenCopy(entry)])));
  return value;
}

/** Absence is the only ignored filesystem error in the persona layer. */
function personalStat(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (errorFields(error).code === 'ENOENT') return null;
    throw error;
  }
}

function refuseLink(file: string, agent: string, key: string): fs.Stats | null {
  const stat = personalStat(file);
  if (stat?.isSymbolicLink()) throw new AgentProfileError(agent, key, 'symbolic links are not allowed');
  return stat;
}

function checkPersonalPaths(dataDir: string, agent: string, prompt?: string | null): void {
  const root = path.join(dataDir, AGENTS_DIRNAME);
  refuseLink(root, agent, 'id');
  const folder = path.join(root, agent);
  const directory = refuseLink(folder, agent, 'id');
  if (directory && !directory.isDirectory()) return;
  refuseLink(path.join(folder, PROFILE_FILE), agent, PROFILE_FILE);
  if (prompt) refuseLink(path.join(folder, prompt), agent, 'prompt');
}

/**
 * The text of `file`, opened without following a link: the check and the open are one call, so a link placed after any
 * earlier check fails with `ELOOP`, and every other read error reaches the caller as it came.
 */
export function readWithoutLinks(file: string): string {
  return fs.readFileSync(file, { encoding: 'utf8', flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
}

/** Reads JSON without exposing its contents in an error. A missing optional profile reads as undefined. */
function readDefinition(folder: string, agent: string, optional = false): unknown {
  try {
    const raw: unknown = JSON.parse(readWithoutLinks(path.join(folder, agent, PROFILE_FILE)));
    if (!isObject(raw)) throw new AgentProfileError(agent, PROFILE_FILE, 'must be a JSON object');
    return raw;
  } catch (error) {
    const { code, name } = errorFields(error);
    if (optional && code === 'ENOENT') return undefined;
    throw new AgentProfileError(
      agent,
      PROFILE_FILE,
      code === 'ENOENT' ? 'missing' : `unreadable (${scalarText(code ?? name ?? 'parse')})`
    );
  }
}

/** The tracked definitions, validated before a local overlay can change them. */
function sharedAgents(rootDir: string): ReadonlyArray<AgentDefinition> {
  const folder = path.join(rootDir, AGENTS_DIRNAME);
  return fs
    .readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((agent) => {
      const raw = readDefinition(folder, agent);
      validateProfile(agent, raw);
      // The validator checks every required field and excludes unknown keys.
      return frozenCopy(raw) as AgentDefinition;
    });
}

/** The names of the folders under `<data>/agents/`. A symbolic link among them is refused; ordinary files are skipped. */
function personalFolders(dataDir: string): Array<string> {
  const folder = path.join(dataDir, AGENTS_DIRNAME);
  refuseLink(folder, 'agents', 'id');
  let entries: Array<fs.Dirent>;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch (error) {
    // A deployment with no local agents has no folder.
    if (errorFields(error).code === 'ENOENT') return [];
    throw error;
  }
  const names: Array<string> = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new AgentProfileError(entry.name, 'id', 'symbolic links are not allowed');
    if (entry.isDirectory()) names.push(entry.name);
  }
  return names;
}

/** `override` laid over `base`: a plain object merged key by key, anything else replaced. */
function overlaid(base: unknown, override: unknown): unknown {
  if (!isObject(base) || !isObject(override)) return override === undefined ? base : override;
  return Object.fromEntries(
    [...new Set([...Object.keys(base), ...Object.keys(override)])].map((key) => [
      key,
      Object.hasOwn(override, key)
        ? overlaid(Object.hasOwn(base, key) ? base[key] : undefined, override[key])
        : base[key],
    ])
  );
}

/** A tracked definition with its local twin laid over it. */
function personalDefinition(definition: AgentDefinition, dataDir: string): AgentDefinition {
  const agent = definition.id;
  checkPersonalPaths(dataDir, agent);
  const override = readDefinition(path.join(dataDir, AGENTS_DIRNAME), agent, true);
  if (isObject(override) && Object.hasOwn(override, 'id') && override.id !== agent)
    throw new AgentProfileError(agent, 'id', 'cannot change shared identity');
  const merged = overlaid(definition, override);
  validateProfile(agent, merged);
  const result = frozenCopy(merged) as AgentDefinition;
  checkPersonalPaths(dataDir, agent, result.prompt);
  return result;
}

/** Every agent on disk with its origin, sorted by id: a tracked agent, overlaid by its local twin when it has one. */
function definitionsOf(paths: ResolvedAgentPaths): Array<{ definition: AgentDefinition; origin: AgentOrigin }> {
  const personal = personalFolders(paths.dataDir);
  return sharedAgents(paths.rootDir).map((definition) =>
    personal.includes(definition.id)
      ? { definition: personalDefinition(definition, paths.dataDir), origin: 'local' as const }
      : { definition, origin: 'tracked' as const }
  );
}

/** Reads and validates every agent on disk, tracked and local, sorted by id. */
export function listAgents(options: AgentPaths = {}): ReadonlyArray<AgentDefinition> {
  return Object.freeze(definitionsOf(agentPaths(options)).map(({ definition }) => definition));
}

/** The folder of the engine's checkout the agents are read from. */
export function engineRoot(options: AgentPaths = {}): string {
  return agentPaths(options).rootDir;
}

/** The names of every agent on disk, sorted. */
export function agentNames(options: AgentPaths = {}): Array<string> {
  return listAgents(options).map((definition) => definition.id);
}

/** Whether `name` is an agent on disk. */
export function isAgentName(name: unknown, options: AgentPaths = {}): name is string {
  return typeof name === 'string' && agentNames(options).includes(name);
}

/** The profile object of one validated definition. */
function makeProfile(definition: AgentDefinition, origin: AgentOrigin, paths: ResolvedAgentPaths): Profile {
  return {
    name: definition.id,
    description: definition.description,
    unit: definition.id,
    origin,
    promptFiles: promptCandidates(definition.id, paths, definition.prompt),
    defaultLimits: definition.limits,
    defaultDaily: definition.daily,
  };
}

/**
 * Every agent's profile by id. Throws AgentProfileError on the first profile that cannot be used, so a bad file stops
 * the process at start.
 */
export function loadProfiles(options: AgentPaths = {}): Readonly<Record<string, Profile>> {
  const paths = agentPaths(options);
  return Object.freeze(
    Object.fromEntries(
      definitionsOf(paths).map(({ definition, origin }) => [definition.id, makeProfile(definition, origin, paths)])
    )
  );
}

/** The profile of `name`, or null. */
export function profileOf(name: unknown, options: AgentPaths = {}): Profile | null {
  if (typeof name !== 'string') return null;
  const profiles = loadProfiles(options);
  return Object.hasOwn(profiles, name) ? profiles[name] : null;
}

/** The settings of one agent, from its profile with the deployment's `agents.<name>` over it. */
export type AgentSettings = {
  /** whether the agent is on: `agents.<name>.enabled` alone, false when absent */
  enabled: boolean;
  /** USD per million tokens */
  cost: { input: number; output: number };
  /** `{ steps, seconds }` */
  limits: Record<string, number>;
  /** the daily caps, `{ tasks }` */
  daily: Record<string, number>;
};

/** The keys of `agents.<name>` that lay over the profile. */
const SETTING_KEYS = Object.freeze(['cost', 'limits', 'daily']);

/**
 * The settings of agent `name`: its profile with `config.agents.<name>` laid over it, nested objects merged key by key,
 * and `enabled` true only when the config says so. The one reader of these settings for the core and the runner, read
 * from the config it is given at each call. Null for a name that is no agent.
 * @param name The agent's id; anything else is no agent.
 * @param config The live config, or any object with an `agents` section.
 */
export function agentSettings(name: unknown, config: unknown, options: AgentPaths = {}): AgentSettings | null {
  if (typeof name !== 'string') return null;
  const profile = listAgents(options).find((definition) => definition.id === name);
  if (profile === undefined) return null;
  const section = isObject(config) && isObject(config.agents) ? config.agents : {};
  const given = section[name];
  const override = isObject(given) ? given : {};
  const values: Record<string, unknown> = { ...profile };
  const out: Record<string, unknown> = { enabled: override.enabled === true };
  for (const key of SETTING_KEYS)
    out[key] = Object.hasOwn(override, key) ? overlaid(values[key], override[key]) : values[key];
  return out as AgentSettings;
}

/** The unit scope `neptunia setup` sets in every user unit it renders (src/setup/units.ts). */
export const UNIT_SCOPE_ENV = 'NEPTUNIA_UNIT_SCOPE';

/**
 * The socket and the out folder of unit `unit`: the unit's `RuntimeDirectory` and `StateDirectory`
 * (`neptunia-agent-<unit>`), under `/run` and `/var/lib` for a system unit and under the user's runtime and state
 * folders when this process runs from a user unit (`NEPTUNIA_UNIT_SCOPE=user`), which the core, running from a user unit
 * of the same user, resolves to the same place.
 */
export function unitPaths(
  unit: UnitName,
  env: Record<string, string | undefined> = process.env
): { socket: string; out: string } {
  const folder = `neptunia-agent-${unit}`;
  if (env[UNIT_SCOPE_ENV] !== 'user')
    return { socket: path.join('/run', folder, 'sock'), out: path.join('/var/lib', folder, 'out') };
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`;
  const state = env.XDG_STATE_HOME || path.join(env.HOME ?? '', '.local', 'state');
  return { socket: path.join(runtime, folder, 'sock'), out: path.join(state, folder, 'out') };
}
