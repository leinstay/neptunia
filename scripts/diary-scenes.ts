#!/usr/bin/env node
// Calibration tool of the diary's scene helper (src/behavior/diary-scene.ts): runs the helper on fresh seed sets and
// prints the scenes, so the wording of `prompts/diary/scene.md` is judged on real answers before any turn uses it.
//
//   NEPTUNIA_DATA_DIR=<data folder> node scripts/diary-scenes.ts [--kinds story,picture] [--count 3]
//        [--seed <text>] [--prompts <dir>] [--out <report.md>] [--director <route>]
//
// For each kind of `--kinds` (default the five of SCENE_KINDS) and each of `--count` runs (default 3) it draws eight
// seed sets from the files of `prompts/diary/seeds/`, leaving out the lines the newest stored entries built on, and calls the
// helper once. `--seed` fixes the random source, so two runs with one seed offer the same sets; without it a fresh
// seed is drawn and named on stderr. `--prompts <dir>` lays the directory over the data folder's prompts as
// `scripts/replay.ts --prompts` does, so a variant of `diary/scene.md` is tried without touching the live one.
//
// The data folder gives the configuration, the keys and the stored entries, read only: nothing is written there.
// Requests go out on the role `director` as production sends it, on the analyzer's chain while the role has no route.
// `--director <key>/<model>[:<effort>]` or `--director harness:<claude|codex>/<model>[:<effort>]` replaces it for
// this run, to compare two models on the sets of one seed. They carry the origin `replay` and never count against
// `llm.maxRequestsPerDay`. stdout holds
// the JSON of every result by kind; `--out` writes a Markdown report beside it.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, parseFlags, privateDirOf, runCli } from './lib/cli.ts';
import { seededRng } from './lib/diary-day.ts';
import { readOnlyMemory } from './lib/memory-read.ts';
import { overlayPromptsHot } from './lib/prompt-layers.ts';
import { routedHot, routesText, scriptRouting, takeRoutes } from './lib/script-routes.ts';
import { DEFAULT_HISTORY_POSTS } from '../src/behavior/diary.ts';
import { SCENE_KINDS, buildScene, drawSceneSets, isSceneKind } from '../src/behavior/diary-scene.ts';
import type { SceneLlm, SceneResult } from '../src/behavior/diary-scene.ts';
import { readDiary } from '../src/memory/db/diary-past.ts';
import type { Hot } from '../src/hot.ts';
import { objOf } from '../src/tools/types.ts';
import type { Untyped } from '../src/tools/types.ts';

const TOOL = 'diary-scenes';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = `usage: node scripts/${TOOL}.ts [--kinds a,b] [--count n] [--seed text] [--prompts dir] [--out file] [--director route]`;
const DEFAULT_COUNT = 3;

type Env = Record<string, string | undefined>;

/** One result as the JSON prints it. */
type Printed = {
  sets: Array<Array<string>>;
  set?: number;
  used?: Array<string>;
  scene?: string;
  failure?: string;
  tokens: { in: number; out: number };
};

function parseArgs(argv: Array<string>) {
  const flags = parseFlags(argv, {
    values: ['--kinds', '--count', '--seed', '--prompts', '--out'],
    usage: USAGE,
  });
  if (flags._.length > 0) throw new CliError(USAGE);
  const kinds = typeof flags['--kinds'] === 'string' ? flags['--kinds'].split(',').map((kind) => kind.trim()) : [];
  const refused = kinds.filter((kind) => !isSceneKind(kind));
  if (refused.length > 0)
    throw new CliError(`${TOOL}: ${refused.join(', ')} gets no scene; use one of ${SCENE_KINDS.join(', ')}`);
  const count = flags['--count'] === undefined ? DEFAULT_COUNT : Number(flags['--count']);
  if (!Number.isInteger(count) || count < 1) throw new CliError(`${TOOL}: --count takes a whole number from 1`);
  const text = (name: string) => (typeof flags[name] === 'string' ? flags[name] : null);
  return {
    kinds: kinds.length > 0 ? kinds : [...SCENE_KINDS],
    count,
    seed: text('--seed'),
    prompts: text('--prompts'),
    out: text('--out'),
  };
}

function printedOf(result: SceneResult): Printed {
  const { sets, tokens } = result;
  return result.ok
    ? { sets, set: result.set, used: result.used, scene: result.scene, tokens }
    : { sets, failure: result.reason, tokens };
}

/** The Markdown report: per result the kind, the chosen set with its kept lines marked, the scene, the rest. */
function reportOf(results: Record<string, Array<Printed>>, seed: string): string {
  const lines = [`# Diary scenes`, '', `Seed \`${seed}\`.`];
  for (const [kind, runs] of Object.entries(results)) {
    runs.forEach((run, index) => {
      lines.push('', `## ${kind} ${index + 1}`, '');
      const chosen = run.set ? run.sets[run.set - 1] : null;
      if (chosen) {
        lines.push(`Set ${run.set}:`, '');
        for (const line of chosen) lines.push(`- ${run.used?.includes(line) ? '[x]' : '[ ]'} ${line}`);
        lines.push('', run.scene ?? '');
      } else lines.push(run.failure ? `Failed: \`${run.failure}\`.` : 'No set works.');
      lines.push('', 'Passed over:', '');
      run.sets.forEach((set, at) => {
        if (at + 1 !== run.set) lines.push(`${at + 1}. ${set.join('; ')}`);
      });
      lines.push('', `Tokens ${run.tokens.in} in, ${run.tokens.out} out.`);
    });
  }
  return `${lines.join('\n')}\n`;
}

/** The real client: the `director` route production gives the run, or the one `--director` names. */
async function routedLlm(hot: Hot, env: Env, routes: ReturnType<typeof takeRoutes>['routes']): Promise<SceneLlm> {
  const { createLlm } = await import('../src/llm/openrouter.ts');
  const { createCalibrator } = await import('../src/llm/tokens.ts');
  // Throwaway counters and calibration: the data folder's state is never written.
  const state = { data: {}, markDirty() {} };
  const calibrator = createCalibrator(undefined);
  const routing = await scriptRouting(TOOL, {
    privateDir: privateDirOf(ROOT, env),
    roles: ['director'],
    variant: routes,
    // The live config of the run, untyped as the client reads it.
    getConfig: (): Untyped => hot.config,
    createDirect: (keys, getConfig) => createLlm({ apiKey: '', keys, getConfig, calibrator, state }),
    state,
  });
  process.stderr.write(routesText(TOOL, routing.said));
  return routing.llm;
}

/** The stored entries of the data folder, oldest first, read only; none when it has no memory database. */
function storedEntries(dataDir: string): Array<unknown> {
  const memory = readOnlyMemory(dataDir);
  try {
    const db: unknown = memory.memoryDb?.database();
    return db ? readDiary(db, { internal: true }, DEFAULT_HISTORY_POSTS) : [];
  } finally {
    memory.close();
  }
}

/** The whole tool: the JSON of every result on stdout, the report in `--out`. */
export async function main(
  argv: Array<string>,
  {
    env = process.env,
    now = Date.now,
    llmOf = null,
  }: { env?: Env; now?: () => number; llmOf?: ((hot: Hot) => SceneLlm) | null } = {}
): Promise<string> {
  const taken = takeRoutes(TOOL, argv);
  const args = parseArgs(taken.argv);
  const seed = args.seed ?? randomBytes(6).toString('hex');
  if (args.seed === null) process.stderr.write(`${TOOL}: seed ${seed}\n`);
  const dataDir = privateDirOf(ROOT, env);
  const { createHot } = await import('../src/hot.ts');
  const layered = args.prompts === null ? null : overlayPromptsHot(createHot, ROOT, args.prompts, { env });
  const hot = layered?.hot ?? createHot({ rootDir: ROOT, privateDir: dataDir });
  try {
    // The helper reads its model from the config, so the config it sees carries the route a flag names.
    const asked = routedHot(hot, taken.routes);
    const real = llmOf ? llmOf(hot) : await routedLlm(hot, env, taken.routes);
    // The tool's own requests, as a replay's: never counted against the day's cap.
    const llm: SceneLlm = {
      complete: (messages, options) =>
        real.complete(messages, { ...options, origin: 'replay', countAgainstDailyCap: false }),
    };
    const posts = storedEntries(dataDir);
    const rng = seededRng(seed, 'scenes');
    const zone = objOf(objOf(hot.config).bot).timezone;
    const timezone = typeof zone === 'string' && zone ? zone : 'UTC';
    const results: Record<string, Array<Printed>> = {};
    for (const kind of args.kinds) {
      results[kind] = [];
      for (let run = 0; run < args.count; run += 1) {
        const sets = drawSceneSets({ prompts: hot.prompts, posts, rng });
        const result = await buildScene({ hot: asked, llm, kind, sets, now: now(), timezone });
        process.stderr.write(`${TOOL}: ${kind} ${run + 1}/${args.count} ${result.ok ? 'ok' : result.reason}\n`);
        results[kind].push(printedOf(result));
      }
    }
    if (args.out !== null) fs.writeFileSync(path.resolve(args.out), reportOf(results, seed));
    return `${JSON.stringify(results, null, 2)}\n`;
  } finally {
    hot.close?.();
    if (layered) fs.rmSync(layered.dir, { recursive: true, force: true });
  }
}

runCli(import.meta.url, main);
