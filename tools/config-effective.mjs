#!/usr/bin/env node
// The deploy proof of the config cut (src/config/cut.ts): the effective settings of a private layer and the objects the
// readers derive from them, written before a deploy and compared after it.
//
//   node tools/config-effective.mjs --snapshot <file> --private <dir>
//   node tools/config-effective.mjs --compare <file> --private <dir>
//
// `--snapshot` writes `{ config, settings }` to `<file>`: `config` is this checkout's `config/config.json` with the
// private layer of `<dir>` over it, read the way the engine reads it (src/config.js#readConfig), and `settings` holds
// what each reader derives from it, keyed by the reader's name (`recallSettings`, `loopSettings inner`,
// `agentSettings scout`, ...). `--compare` derives the same from the layer as it is now and prints one line per leaf
// that differs, `<config|settings>.<path>: before <json>, after <json>`, an absent value printed as `absent`. A line
// ends in ` (declared)` when the cut declares the difference: a key it took out of the settings under `config.`, or a
// daily cap's field under `settings.`. The last line is `equal: <n>, differ: <n>, declared: <n>`, `differ` counting
// the undeclared ones, and the run exits 1 when `differ` is above 0. Nothing here calls a model or writes outside
// `<file>`.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT_DIR, readConfig } from '../src/config.js';
import { CUT_KEYS } from '../src/config/cut.ts';
import { audioMapSettings } from '../src/media/audio-map.js';
import { recentSettings } from '../src/memory/recent.js';
import { participationSettings } from '../src/memory/participation.js';
import { indexSettings } from '../src/memory/db/index-policy.js';
import { dbSettings } from '../src/memory/db/recall.js';
import { graphSettings } from '../src/memory/db/graph.js';
import { focusSettings } from '../src/memory/db/focus.js';
import { backupSettings } from '../src/memory/db/backup.js';
import { captureSettings } from '../src/memory/db/observe.js';
import { sessionSettings } from '../src/memory/db/session.js';
import { boardSettings } from '../src/board/board.ts';
import { participationPickSettings } from '../src/behavior/participation-pick.js';
import { routeSettings } from '../src/behavior/route.js';
import { pullSettings } from '../src/behavior/pull.js';
import { setSettings } from '../src/behavior/diary.ts';
import { catchUpSettings } from '../src/behavior/catch-up.js';
import { elsewhereSettings } from '../src/behavior/elsewhere.ts';
import { splitSettings } from '../src/behavior/split.js';
import { gifPickSettings } from '../src/behavior/gif-pick.js';
import { innerSettings } from '../src/behavior/inner/settings.ts';
import { missedSettings } from '../src/behavior/missed.js';
import { recallSettings } from '../src/behavior/recall.js';
import { loopSettings, paceSettings } from '../src/turn/settings.ts';
import { hedgeSettings } from '../src/llm/openrouter.js';
import { attentionSettings, heartbeatLimits, intentionSettings } from '../src/intentions/model.ts';
import { agentSettings } from '../src/agent-runner/profiles.js';
import { CliError, parseFlags } from './lib/cli.mjs';

const USAGE = 'usage: node tools/config-effective.mjs --snapshot <file> | --compare <file>, with --private <dir>';

/** @typedef {Record<string, unknown>} Tree */

/** @param {unknown} value @returns {value is Tree} */
const isTree = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} value @returns {Tree} */
const treeOf = (value) => (isTree(value) ? value : {});

/**
 * The settings objects the readers derive from `config`, by name.
 * @type {Array<[string, (config: Tree) => unknown]>}
 */
const READERS = [
  ['pullSettings', (config) => pullSettings(config)],
  ['recallSettings', (config) => recallSettings(config)],
  ['dbSettings', (config) => /** @type {unknown} */ (dbSettings(config))],
  ['indexSettings', (config) => indexSettings(config)],
  ['recentSettings', (config) => recentSettings(config)],
  ['participationSettings', (config) => participationSettings(config)],
  ['participationPickSettings', (config) => participationPickSettings(config)],
  ['graphSettings', (config) => graphSettings(config)],
  ['focusSettings', (config) => focusSettings(config)],
  ['captureSettings', (config) => captureSettings(config)],
  ['sessionSettings', (config) => sessionSettings(config)],
  ['backupSettings', (config) => backupSettings(config, '/data')],
  ['innerSettings', (config) => innerSettings(config)],
  ['heartbeatLimits', (config) => heartbeatLimits(config)],
  ['intentionSettings', (config) => intentionSettings(config)],
  ['attentionSettings', (config) => attentionSettings(config)],
  ['loopSettings inner', (config) => loopSettings(config, { inner: true })],
  ['audioMapSettings', (config) => audioMapSettings(treeOf(treeOf(treeOf(config).media).video).audioMap)],
  ['setSettings', (config) => setSettings(treeOf(config).diary)],
  ['gifPickSettings', (config) => gifPickSettings(config)],
  ['loopSettings diary', (config) => loopSettings(config, { diary: true })],
  ['hedgeSettings', (config) => hedgeSettings(config)],
  ['boardSettings', (config) => boardSettings(config)],
  ['routeSettings', (config) => routeSettings(config)],
  ['splitSettings', (config) => splitSettings(config)],
  ['catchUpSettings', (config) => catchUpSettings(config)],
  ['elsewhereSettings', (config) => elsewhereSettings(config)],
  ['missedSettings', (config) => missedSettings(config)],
  ['paceSettings', (config) => paceSettings(config)],
  ['loopSettings', (config) => loopSettings(config)],
  ...['scout', 'server', 'thinker', 'dev'].map(
    /** @returns {[string, (config: Tree) => unknown]} */
    (agent) => [`agentSettings ${agent}`, (config) => agentSettings(agent, config)]
  ),
];

/** The fields of the derived objects that are a daily cap of plan section 4.5 or its twin. */
const CAP_FIELDS = [
  'recallSettings.maxPerDay',
  'dbSettings.maxPerDay',
  'attentionSettings.perDayDefault',
  'innerSettings.attention.perDayDefault',
  'agentSettings scout.daily',
  'agentSettings server.daily',
];

/** The dotted keys the cut took out of `config`, the renamed switches' new names among them. */
const CUT_PATHS = CUT_KEYS.flatMap((row) => (row.becomes === 'rename' && row.to ? [row.key, row.to] : [row.key]));

/**
 * Whether the difference at `leaf` is one the cut declares.
 * @param {string} leaf
 * @returns {boolean}
 */
function declared(leaf) {
  const under = (prefix, key) => leaf === `${prefix}${key}` || leaf.startsWith(`${prefix}${key}.`);
  return CUT_PATHS.some((key) => under('config.', key)) || CAP_FIELDS.some((field) => under('settings.', field));
}

/**
 * The effective config of the private layer `privateDir` and what the readers derive from it, as plain JSON.
 * @param {string} privateDir
 * @returns {{ config: Tree, settings: Tree }}
 */
function effective(privateDir) {
  const config = treeOf(readConfig(ROOT_DIR, { privateDir }));
  const settings = Object.fromEntries(READERS.map(([name, read]) => [name, read(config)]));
  /** @type {unknown} */
  const plain = JSON.parse(JSON.stringify({ config, settings }));
  return /** @type {{ config: Tree, settings: Tree }} */ (plain);
}

/**
 * Every leaf of `before` and `after` under `prefix`, as `[path, before, after]`; an array is one leaf.
 * @param {string} prefix
 * @param {unknown} before
 * @param {unknown} after
 * @returns {Array<[string, unknown, unknown]>}
 */
function leaves(prefix, before, after) {
  if (isTree(before) || isTree(after)) {
    const was = treeOf(before);
    const now = treeOf(after);
    const keys = [...new Set([...Object.keys(was), ...Object.keys(now)])];
    const inner = keys.flatMap((key) => leaves(`${prefix}.${key}`, was[key], now[key]));
    if (isTree(before) && isTree(after)) return inner;
    return [[prefix, isTree(before) ? undefined : before, isTree(after) ? undefined : after], ...inner].filter(
      ([, one, two]) => one !== undefined || two !== undefined || false
    );
  }
  return [[prefix, before, after]];
}

/** @param {unknown} value @returns {string} */
const shown = (value) => (value === undefined ? 'absent' : JSON.stringify(value));

/**
 * The report of `--compare`: one line per differing leaf, then the counts; `differ` counts the undeclared ones.
 * @param {Tree} before
 * @param {Tree} after
 * @returns {{ text: string, differ: number }}
 */
function compare(before, after) {
  const lines = [];
  let equal = 0;
  let differ = 0;
  let marked = 0;
  for (const part of ['config', 'settings']) {
    for (const [leaf, was, now] of leaves(part, before[part], after[part])) {
      if (JSON.stringify(was) === JSON.stringify(now)) {
        equal += 1;
        continue;
      }
      const isDeclared = declared(leaf);
      if (isDeclared) marked += 1;
      else differ += 1;
      lines.push(`${leaf}: before ${shown(was)}, after ${shown(now)}${isDeclared ? ' (declared)' : ''}`);
    }
  }
  lines.push(`equal: ${equal}, differ: ${differ}, declared: ${marked}`);
  return { text: `${lines.join('\n')}\n`, differ };
}

/**
 * @param {string[]} argv
 * @returns {{ text: string, code: number }}
 */
export function run(argv) {
  /** @type {Record<string, unknown>} */
  const flags = parseFlags(argv, { values: ['--snapshot', '--compare', '--private'], usage: USAGE });
  const snapshot = flags['--snapshot'];
  const against = flags['--compare'];
  const privateDir = flags['--private'];
  if ((typeof snapshot === 'string') === (typeof against === 'string') || typeof privateDir !== 'string')
    throw new CliError(USAGE);
  const now = effective(path.resolve(privateDir));
  if (typeof snapshot === 'string') {
    fs.writeFileSync(path.resolve(snapshot), `${JSON.stringify(now, null, 2)}\n`);
    return { text: `${snapshot}: ${Object.keys(now.settings).length} readers written\n`, code: 0 };
  }
  /** @type {unknown} */
  const before = JSON.parse(fs.readFileSync(path.resolve(String(against)), 'utf8'));
  const report = compare(treeOf(before), now);
  return { text: report.text, code: report.differ > 0 ? 1 : 0 };
}

// The entry point: the report on stdout, the engine's log lines on stderr, a usage error on stderr with exit 2.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, callback) => process.stderr.write(chunk, encoding, callback);
  try {
    const { text, code } = run(process.argv.slice(2));
    stdoutWrite(text, () => process.exit(code));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`, () => process.exit(err instanceof CliError ? 2 : 1));
  }
}
