#!/usr/bin/env node
// The deploy proof of the config cut (src/config/cut.ts): the effective settings of a private layer and the objects the
// readers derive from them, written before a deploy and compared after it.
//
//   node scripts/config-effective.ts --snapshot <file> --private <dir>
//   node scripts/config-effective.ts --compare <file> --private <dir>
//
// `--snapshot` writes `{ config, settings }` to `<file>`: `config` is this checkout's `config/config.json` with the
// private layer of `<dir>` over it, read the way the engine reads it (src/config.ts#readConfig), and `settings` holds
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
import { ROOT_DIR, readConfig } from '../src/config.ts';
import { CUT_KEYS } from '../src/config/cut.ts';
import { audioMapSettings } from '../src/media/audio-map.ts';
import { recentSettings } from '../src/memory/recent.ts';
import { participationSettings } from '../src/memory/participation.ts';
import { indexSettings } from '../src/memory/db/index-policy.ts';
import { dbSettings } from '../src/memory/db/recall.ts';
import { graphSettings } from '../src/memory/db/graph.ts';
import { focusSettings } from '../src/memory/db/focus.ts';
import { backupSettings } from '../src/memory/db/backup.ts';
import { captureSettings } from '../src/memory/db/observe.ts';
import { sessionSettings } from '../src/memory/db/session.ts';
import { boardSettings } from '../src/board/board.ts';
import { participationPickSettings } from '../src/behavior/participation-pick.ts';
import { routeSettings } from '../src/behavior/route.ts';
import { pullSettings } from '../src/behavior/pull.ts';
import { setSettings } from '../src/behavior/diary.ts';
import { elsewhereSettings } from '../src/behavior/elsewhere.ts';
import { splitSettings } from '../src/behavior/split.ts';
import { mediaPickSettings } from '../src/behavior/media-pick.ts';
import { innerSettings } from '../src/behavior/inner/settings.ts';
import { missedSettings } from '../src/behavior/missed.ts';
import { recallSettings } from '../src/behavior/recall.ts';
import { loopSettings, paceSettings } from '../src/turn/settings.ts';
import { hedgeSettings } from '../src/llm/openrouter.ts';
import { attentionSettings, heartbeatLimits, intentionSettings } from '../src/intentions/model.ts';
import { agentSettings } from '../src/agent-runner/profiles.ts';
import { CliError, parseFlags } from './lib/cli.ts';
import type { Untyped } from '../src/tools/types.ts';

const USAGE = 'usage: node scripts/config-effective.ts --snapshot <file> | --compare <file>, with --private <dir>';

type Tree = Record<string, unknown>;

const isTree = (value: unknown): value is Tree => typeof value === 'object' && value !== null && !Array.isArray(value);

const treeOf = (value: unknown): Tree => (isTree(value) ? value : {});

/** The settings objects the readers derive from `config`, by name. */
const READERS: Array<[string, (config: Record<string, Untyped>) => unknown]> = [
  ['pullSettings', (config) => pullSettings(config)],
  ['recallSettings', (config) => recallSettings(config)],
  ['dbSettings', (config) => dbSettings(config)],
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
  ['setSettings', (config) => setSettings(treeOf(config).selfreflection)],
  ['mediaPickSettings', (config) => mediaPickSettings(config)],
  ['loopSettings diary', (config) => loopSettings(config, { diary: true })],
  ['hedgeSettings', (config) => hedgeSettings(config)],
  ['boardSettings', (config) => boardSettings(config)],
  ['routeSettings', (config) => routeSettings(config)],
  ['splitSettings', (config) => splitSettings(config)],
  ['elsewhereSettings', (config) => elsewhereSettings(config)],
  ['missedSettings', (config) => missedSettings(config)],
  ['paceSettings', (config) => paceSettings(config)],
  ['loopSettings', (config) => loopSettings(config)],
  ...['scout', 'server', 'thinker', 'dev'].map((agent): [string, (config: Tree) => unknown] => [
    `agentSettings ${agent}`,
    (config) => agentSettings(agent, config, { rootDir: ROOT_DIR }),
  ]),
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

/** Whether the difference at `leaf` is one the cut declares. */
function declared(leaf: string): boolean {
  const under = (prefix: string, key: Untyped) => leaf === `${prefix}${key}` || leaf.startsWith(`${prefix}${key}.`);
  return CUT_PATHS.some((key) => under('config.', key)) || CAP_FIELDS.some((field) => under('settings.', field));
}

/** The effective config of the private layer `privateDir` and what the readers derive from it, as plain JSON. */
function effective(privateDir: string): { config: Tree; settings: Tree } {
  const config = treeOf(readConfig(ROOT_DIR, { privateDir }));
  const settings = Object.fromEntries(READERS.map(([name, read]) => [name, read(config)]));
  const plain: unknown = JSON.parse(JSON.stringify({ config, settings }));
  return plain as { config: Tree; settings: Tree };
}

/** Every leaf of `before` and `after` under `prefix`, as `[path, before, after]`; an array is one leaf. */
function leaves(prefix: string, before: unknown, after: unknown): Array<[string, unknown, unknown]> {
  if (isTree(before) || isTree(after)) {
    const was = treeOf(before);
    const now = treeOf(after);
    const keys = [...new Set([...Object.keys(was), ...Object.keys(now)])];
    const inner = keys.flatMap((key) => leaves(`${prefix}.${key}`, was[key], now[key]));
    if (isTree(before) && isTree(after)) return inner;
    const own: Array<[string, unknown, unknown]> = [
      [prefix, isTree(before) ? undefined : before, isTree(after) ? undefined : after],
      ...inner,
    ];
    return own.filter(([, one, two]) => one !== undefined || two !== undefined || false);
  }
  return [[prefix, before, after]];
}

const shown = (value: unknown) => (value === undefined ? 'absent' : JSON.stringify(value));

/** The report of `--compare`: one line per differing leaf, then the counts; `differ` counts the undeclared ones. */
function compare(before: Tree, after: Tree): { text: string; differ: number } {
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

export function run(argv: Array<string>): { text: string; code: number } {
  const flags: Record<string, unknown> = parseFlags(argv, {
    values: ['--snapshot', '--compare', '--private'],
    usage: USAGE,
  });
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
  const before: unknown = JSON.parse(fs.readFileSync(path.resolve(String(against)), 'utf8'));
  const report = compare(treeOf(before), now);
  return { text: report.text, code: report.differ > 0 ? 1 : 0 };
}

// The entry point: the report on stdout, the engine's log lines on stderr, a usage error on stderr with exit 2.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  // The redirect takes the three-argument form of `write`, which every caller of stdout here uses; the cast stands for
  // the overload list `process.stdout.write` has and a single arrow cannot spell.
  process.stdout.write = ((
    chunk: Uint8Array | string,
    encoding?: BufferEncoding,
    callback?: (err?: Error | null) => void
  ) => process.stderr.write(chunk, encoding, callback)) as typeof process.stdout.write;
  try {
    const { text, code } = run(process.argv.slice(2));
    stdoutWrite(text, () => process.exit(code));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`, () => process.exit(err instanceof CliError ? 2 : 1));
  }
}
