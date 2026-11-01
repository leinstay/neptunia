#!/usr/bin/env node
// Writes the config keys that moved into a local config file (src/config-moves.ts: the settings under `skills.*`,
// `features.skills`, `features.skillsDiscovery`, the grants on the renamed tools, the shared settings of `agents`, which
// live under `errands`, and `agents.<name>.search.provider`). The engine applies the same moves when it loads the file, so
// an unmigrated file still works and logs one warning line per load; this tool settles the file itself.
//
//   node tools/config-migrate.mjs --dry-run [--file <private settings file>] [--db <memory.db>] [--compare-with <config.json> [--self <id>]]
//   node tools/config-migrate.mjs --apply [--file <private settings file>] [--db <memory.db>]
//
// `diary.channelId` is the seed of the diary's mirror (schema v15): it moves to the database only when the memory
// database given with `--db` (opened read-only) has an enabled `diary` mirror, printed as `diary.channelId -> memory
// database`. Without that mirror, or without `--db`, the key stays and one line says so.
//
// The file is `--file`, else the private settings file of `NEPTUNIA_PRIVATE_DIR`, else of the checkout (src/paths.js):
// `config.local/config.json`, or `config.local.json` of the old layout (src/config/files.ts#localConfigPath).
// `--dry-run` prints each move as `from -> to`, each key nothing reads any more as `<path> dropped (no reader)`, and
// writes nothing. A second run finds nothing to move.
//
// The config cut (src/config/cut.ts) runs after the moves. It prints `<key> dropped (<becomes>)` for each key that
// left the settings, `<key> differs: live <json>, constant <json>` for each live value apart from the constant that
// replaced it, `<from> -> <to>` for the two privacy switches, and `<key> -> config.local/interfaces/discord.json` for
// each key of the Discord package. `--apply` writes those keys into `config.local/interfaces/discord.json` beside the
// settings file (the private directory's `config.local/` for a file of the old layout), under the values that file
// already holds.
//
// `--compare-with <config.json>` proves the move changed no setting. It merges the given `config.json` (the tracked one
// from before the moves) under the raw local file and reads every moved setting the old way, merges this checkout's
// `config.json` under the moved local file and reads the same settings through today's readers (`errands.*`,
// `agentSettings`, the grants of the persona, whose id is `--self`, else `bot.self`), and prints `equal: <n>, differ:
// <n>` with one line for each difference. It exits 1 on any difference.

import fs from 'node:fs';
import path from 'node:path';
import { DROPPED_GRANTS, ERRAND_KEYS, GRANT_MOVES, moveConfigKeys } from '../src/config-moves.ts';
import { ROOT_DIR, deepMerge } from '../src/config.js';
import { LOCAL_CONFIG_DIR, localConfigPath, trackedConfigPath } from '../src/config/files.ts';
import { CUT_KEYS, cutConfigKeys } from '../src/config/cut.ts';
import { agentSettings } from '../src/agent-runner/profiles.js';
import { grantedToPersona } from '../src/tools/access.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { CliError, parseFlags, privateDirOf, runCli } from './lib/cli.mjs';

const USAGE =
  'usage: node tools/config-migrate.mjs --dry-run|--apply [--file <private settings file>] [--db <memory.db>] [--compare-with <config.json> [--self <id>]]';

/**
 * Whether the memory database `file` (opened read-only) has an enabled `diary` mirror; false without a file.
 * @param {unknown} file
 * @returns {boolean}
 */
function hasDiaryMirror(file) {
  if (typeof file !== 'string') return false;
  const handle = openMemoryDb(path.resolve(file), { readOnly: true });
  try {
    const db = /** @type {{ prepare(sql: string): { get(): unknown } }} */ (handle.db);
    if (db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'mirrors'").get() === undefined)
      return false;
    return (
      db.prepare("SELECT 1 AS ok FROM mirrors WHERE row_kind = 'diary' AND enabled = 1 LIMIT 1").get() !== undefined
    );
  } finally {
    handle.close();
  }
}

/** The agents of the profiles and the keys of their settings that are compared, per kind. */
const WORKER_SETTINGS = ['enabled', 'cost', 'socket', 'out', 'limits', 'daily', 'searchProvider'];
const DEVELOPMENT_SETTINGS = ['cost', 'limits'];
/** @type {Array<[string, string[]]>} */
const COMPARED_AGENTS = [
  ['scout', WORKER_SETTINGS],
  ['server', WORKER_SETTINGS],
  ['thinker', DEVELOPMENT_SETTINGS],
  ['dev', DEVELOPMENT_SETTINGS],
];

/** @param {unknown} value @returns {Record<string, unknown>} */
const objectOf = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};

/**
 * The same object with its keys in order, any other value as it is (a JSON replacer).
 * @param {string} _key
 * @param {unknown} item
 * @returns {unknown}
 */
function sortedKeys(_key, item) {
  return typeof item === 'object' && item !== null && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    : item;
}

/**
 * JSON with the keys of every object in order, so two equal values print equal.
 * @param {unknown} value
 * @returns {string}
 */
const stable = (value) => JSON.stringify(value ?? null, sortedKeys);

/**
 * The names of `bot.access` that grant `selfId` the tool, in a merged config.
 * @param {Record<string, unknown>} config
 * @param {string} selfId
 * @returns {string[]}
 */
function grantedNames(config, selfId) {
  return Object.keys(objectOf(objectOf(config.bot).access)).filter((name) => grantedToPersona(config, selfId, name));
}

/**
 * Every moved setting read the old way (`before`, the old `config.json` under the raw local file) and the new way
 * (`after`, this checkout's `config.json` under the moved local file): `{ equal, differ: string[] }`.
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} after
 * @param {string} selfId
 */
function compareSettings(before, after, selfId) {
  let equal = 0;
  /** @type {string[]} */
  const differ = [];
  /** @param {string} name @param {unknown} old @param {unknown} now */
  const check = (name, old, now) => {
    if (stable(old) === stable(now)) equal += 1;
    else differ.push(`${name}: before ${stable(old)}, after ${stable(now)}`);
  };
  // A key the cut turned into a constant is no longer a setting: the live value is reported as cut, not as a move.
  const cut = new Set(CUT_KEYS.map((entry) => entry.key));
  for (const key of ERRAND_KEYS.filter((name) => !cut.has(`errands.${name}`)))
    check(`agents.${key} -> errands.${key}`, objectOf(before.agents)[key], objectOf(after.errands)[key]);
  for (const [name, keys] of COMPARED_AGENTS) {
    const old = objectOf(objectOf(before.agents)[name]);
    const now = objectOf(agentSettings(name, after));
    for (const key of keys) {
      const was = key === 'searchProvider' ? objectOf(old.search).provider : old[key];
      check(`agents.${name}.${key}`, was ?? null, now[key] ?? null);
    }
  }
  const moves = new Map(GRANT_MOVES);
  const was = new Set(
    grantedNames(before, selfId)
      .filter((name) => !DROPPED_GRANTS.includes(name))
      .map((name) => moves.get(name) ?? name)
  );
  const now = new Set(grantedNames(after, selfId));
  for (const name of [...new Set([...was, ...now])].sort())
    check(`bot.access.${name} granted to her`, was.has(name), now.has(name));
  return { equal, differ };
}

/**
 * The comparison of `--compare-with`: the old config.json under the raw local file against this checkout's under the
 * moved one.
 * @param {Record<string, unknown>} local
 * @param {Record<string, unknown>} moved
 * @param {string} oldFile
 * @param {string | undefined} self
 * @returns {{ text: string, differ: number }}
 */
function compared(local, moved, oldFile, self) {
  /** @type {unknown} */
  let old;
  try {
    old = JSON.parse(fs.readFileSync(path.resolve(oldFile), 'utf8'));
  } catch (err) {
    throw new CliError(`${oldFile} cannot be read as JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  /** @type {unknown} */
  const current = JSON.parse(fs.readFileSync(trackedConfigPath(ROOT_DIR), 'utf8'));
  const before = objectOf(deepMerge(objectOf(old), local));
  const after = objectOf(deepMerge(objectOf(current), moved));
  const own = objectOf(after.bot).self ?? objectOf(before.bot).self;
  const selfId = self ?? (typeof own === 'string' ? own : '');
  const { equal, differ } = compareSettings(before, after, selfId);
  return {
    text: `${differ.join('\n')}${differ.length > 0 ? '\n' : ''}equal: ${equal}, differ: ${differ.length}\n`,
    differ: differ.length,
  };
}

/** The fate of each key the cut took out, for its `dropped` line. */
const FATE_OF = new Map(CUT_KEYS.map((row) => [row.key, row.becomes]));

/** The Discord package's private settings file, as the report names it. */
const DISCORD_FILE = `${LOCAL_CONFIG_DIR}/interfaces/discord.json`;

/**
 * The private file of the Discord package beside the settings file `file`: `config.local/interfaces/discord.json`
 * under the private directory, whose `config.local/` holds the file of the new layout or sits beside the old one.
 * @param {string} file
 * @returns {string}
 */
function discordFileOf(file) {
  const dir = path.dirname(file);
  const localDir = path.basename(dir) === LOCAL_CONFIG_DIR ? dir : path.join(dir, LOCAL_CONFIG_DIR);
  return path.join(localDir, 'interfaces', 'discord.json');
}

/**
 * The dotted paths of the leaves of `tree`, in order.
 * @param {Record<string, unknown>} tree
 * @param {string} [prefix]
 * @returns {string[]}
 */
function leafKeys(tree, prefix = '') {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? leafKeys(/** @type {Record<string, unknown>} */ (value), `${prefix}${key}.`)
      : [`${prefix}${key}`]
  );
}

/**
 * The config cut of a moved layer (src/config/cut.ts): the cut layer, its report lines and the Discord keys.
 * @param {Record<string, unknown>} moved
 * @returns {{ config: Record<string, unknown>, cutLines: string[], discord: Record<string, unknown> }}
 */
function cutReport(moved) {
  const { config, cut, differs, renamed, interfaces } = cutConfigKeys(moved);
  const discord = interfaces.discord ?? {};
  const cutLines = [
    ...cut.map((key) => `${key} dropped (${FATE_OF.get(key) ?? 'constant'})`),
    ...differs.map(
      (one) => `${one.key} differs: live ${JSON.stringify(one.live)}, constant ${JSON.stringify(one.constant)}`
    ),
    ...renamed.map((one) => `${one.from} -> ${one.to}`),
    ...leafKeys(discord).map((key) => `${key} -> ${DISCORD_FILE}`),
  ];
  return { config, cutLines, discord };
}

/**
 * The migrated settings file written over `file`, and the Discord keys, when there are any, into its interface file.
 * @param {string} file
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>} discord
 */
function writeMigrated(file, config, discord) {
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  if (Object.keys(discord).length > 0) writeInterfaceFile(discordFileOf(file), discord);
}

/**
 * `moved` written into the interface file `target`, the values the file already holds winning.
 * @param {string} target
 * @param {Record<string, unknown>} moved
 */
function writeInterfaceFile(target, moved) {
  const raw = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').trim() : '';
  /** @type {unknown} */
  const held = raw === '' ? {} : JSON.parse(raw);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(deepMerge(moved, objectOf(held)), null, 2)}\n`);
}

/**
 * @param {string[]} argv
 * @returns {Promise<string>}
 */
export function main(argv) {
  return Promise.resolve(migrate(argv));
}

/**
 * @param {string[]} argv
 * @returns {string}
 */
function migrate(argv) {
  /** @type {Record<string, unknown>} */
  const flags = parseFlags(argv, {
    values: ['--file', '--db', '--compare-with', '--self'],
    switches: ['--dry-run', '--apply'],
    usage: USAGE,
  });
  if (flags['--dry-run'] === flags['--apply'])
    throw new CliError(`give exactly one of --dry-run and --apply\n${USAGE}`);
  if (typeof flags['--compare-with'] === 'string' && flags['--apply'])
    throw new CliError(`--compare-with goes with --dry-run\n${USAGE}`);
  const file =
    typeof flags['--file'] === 'string' ? path.resolve(flags['--file']) : localConfigPath(privateDirOf(process.cwd()));
  if (!fs.existsSync(file)) return `${file} does not exist: nothing to move\n`;
  const text = fs.readFileSync(file, 'utf8').trim();
  if (text === '') return `${file} is empty: nothing to move\n`;
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CliError(
      `${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}); nothing was changed`
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new CliError(`${file} must hold a JSON object; nothing was changed`);
  const diaryMirror = hasDiaryMirror(flags['--db']);
  const { config: movedConfig, moved, shadowed, dropped, toDatabase } = moveConfigKeys(parsed, { diaryMirror });
  const { config, cutLines, discord } = cutReport(movedConfig);
  const lines = [
    ...moved.map((move) => `${move.from} -> ${move.to}`),
    ...shadowed.map((move) => `${move.from} -> ${move.to} (already set; the old key is dropped)`),
    ...dropped.map((key) => `${key} dropped (no reader)`),
    ...toDatabase.map((key) => `${key} -> memory database (its diary mirror)`),
    ...cutLines,
  ];
  if (flags['--apply'] && lines.length > 0) writeMigrated(file, config, discord);
  const kept = Object.hasOwn(objectOf(config.diary), 'channelId')
    ? `diary.channelId kept: the memory database ${typeof flags['--db'] === 'string' ? 'has no diary mirror yet' : 'was not given (--db)'}\n`
    : '';
  const moves = `${lines.length === 0 ? 'nothing to move\n' : `${lines.join('\n')}\n`}${kept}`;
  if (typeof flags['--compare-with'] !== 'string') return moves;
  const report = compared(
    parsed,
    config,
    flags['--compare-with'],
    typeof flags['--self'] === 'string' ? flags['--self'] : undefined
  );
  if (report.differ > 0) throw new CliError(`${moves}${report.text}`);
  return `${moves}${report.text}`;
}

runCli(import.meta.url, main);
