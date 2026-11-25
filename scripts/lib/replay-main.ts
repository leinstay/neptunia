// The modes of scripts/replay.ts but the stored turn: the dispatch, the spend gate and the objects every mode shares.
//
// `--answers-dir <dir> [--answers-timeout-min 20]` (any mode that sends requests): the offline model. No request of any
// role reaches a provider or a harness: each goes to
// `<dir>/req-<n>.json` (exact strings: model, purpose, system, messages) and `<dir>/req-<n>.md` (n from 1 per run, 3 digits: the model id and the purpose, then every message
// under `## system` / `## user` / `## assistant`, verbatim) and the run waits (polling, up to the
// timeout) for `<dir>/ans-<n>.txt`, whose content is the model's text (and, optionally, `<dir>/ans-<n>.tool-calls.json`:
// a JSON array of `{ id?, name, arguments }` -- `arguments` an object or a string -- for the answer's native tool calls; a
// request that had tools also lists them, with its tool choice, in `req-<n>.json`) (no cost; the result carries
// `answersDir: { dir, requests }`). `<dir>/done` (`exit <code>`) is written when the run ends. No embedding is made, so
// a recall runs without its meaning search. The directory must hold no files of an earlier run. Such a run needs no
// `--spend`.
// The spend gate (scripts/lib/cli.ts#spendGate): every mode that sends model requests prints its estimate first,
// ~USD_PER_ANSWER per request and up to TURN_REQUESTS per turn (a sample, a trigger, a scenario's turn), and refuses with
// exit code 2 without `--spend <usd>` covering it. `--skills` and `--loop-triggers` also stop once what the provider
// reports spent (`usage.cost`, else the estimate per request) reaches `--spend`.
//
// Prompt layers (scripts/lib/prompt-layers.ts#promptLayersHot, the one helper
// for every mode that takes a prompt directory): a scratch copy of the config
// files and the tracked prompts/, with directories copied into prompts.local/
// in order and read by src/hot.js as the bot reads its own. `--skills --prompts`
// lays the directory over the live prompts.local/ and merges
// labels.json and tools.json (overlayPromptsHot). The live config.local.json and prompts.local/ are the
// data folder's (NEPTUNIA_DATA_DIR, else data/ of the checkout; privateDirOf).
// Nothing in the checkout changes. A prompts.local/ (or a
// directory given) that is a link -- a separate checkout linking to the live
// layer -- is read through it and copied as files, never linked to or written.
//
// `--snapshot <dir>`: the memory is read from a snapshot folder (a copy of the memory database taken from a backup,
// or an unpacked stop-backup) instead of the live
// data/, read only as ever. The memory is the memory database of that
// directory (its `memory.db`, opened read only by scripts/lib/memory-read.ts);
// the operational files beside it (state.json, inner.json) are read as files.
//
// The engine's modules are imported from the checkout this file belongs to, the one its static imports name.
//
// What keeps the running bot undisturbed: no gateway session (a discord.js Client that never logs in, its token on REST
// only, every request but a GET refused); the turn runner reads the memory database read only and writes into an
// unflushed copy of the store; its writes to Discord are kept and answered as delivered (scripts/lib/turn-port.ts);
// the llm client counts on an in-memory copy of the daily counters and every request goes out with
// `countAgainstDailyCap: false`, `skipCalibration: true`, `origin: 'replay'`; with one sample no prompt-cache marker is
// sent at all. Nothing is written anywhere and nothing is posted.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Untyped } from '../../src/tools/types.ts';
import { createAnswersDir } from './answers-dir.ts';
import {
  CliError,
  privateDirOf,
  spendGate,
  REFUSED_EXIT,
  defaultDataDir,
  resolveGuildId,
  platformToken,
} from './cli.ts';
import { discordReads } from './platform-objects.ts';
import { overlayPromptsHot } from './prompt-layers.ts';
import { parseArgs, SNOWFLAKE } from './replay-args.ts';
import type { ReplayArgs } from './replay-args.ts';
import { runDiaryDay } from './replay-diary.ts';
import { connectDiscord, refuseDiscordWrites } from './replay-discord.ts';
import { runInner } from './replay-inner.ts';
import { TURN_REQUESTS, USD_PER_ANSWER, replayRouting, replayWithoutCache } from './replay-llm.ts';
import { storeMemoryFor } from './replay-memory.ts';
import { journalRecords, rebuiltRequest, runMessage, storedDumps } from './replay-message.ts';
import { parseScenarios, scenarioTurns } from './replay-scenarios.ts';
import { runSkills } from './replay-skills.ts';
import { isStoredTurnRun, storedTurnMain } from './replay-stored.ts';
import { runTriggerLoops } from './replay-triggers.ts';
import type { Rec, RunEnv } from './replay-types.ts';
import { takeRouteFlags, sideBySide, routedHot } from './script-routes.ts';
import type { Variant } from './script-routes.ts';
import { parseTriggers } from './triggers.ts';
import { unflushedStore } from './turn-wiring.ts';

/** The checkout this file belongs to: the engine every mode runs, its modules imported from here. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The whole tool. Returns `{ code, result }`; never prints to stdout itself. With several `--variant` flags the same
 * inputs run once per variant and `result` lays their answers side by side (scripts/lib/script-routes.ts#sideBySide).
 * `--turn` and `--cut` select the stored-turn mode (scripts/lib/replay-stored.ts), which runs one setup.
 */
export async function main(
  argv: Array<string>,
  { root = ROOT, signal }: { root?: string; signal?: AbortSignal } = {}
): Promise<{ result: Untyped; code: Untyped }> {
  const taken = takeRouteFlags('replay-cli', argv, { variants: true });
  if (isStoredTurnRun(taken.argv)) return storedTurnMain(taken.argv, taken.variants, { root, signal });
  const args: ReplayArgs = parseArgs(taken.argv);
  const runs: Array<{ result: Untyped; code: Untyped }> = [];
  for (const variant of taken.variants) runs.push(await runVariant(args, variant.routes, { root, signal }));
  if (runs.length === 1) return runs[0];
  return {
    code: Math.max(...runs.map((run) => Number(run.code) || 0)),
    result: {
      variants: taken.variants.map((variant) => variant.label),
      ...(sideBySide(
        taken.variants.map((variant) => variant.label),
        runs.map((run) => run.result)
      ) as Rec),
    },
  };
}

/** One run of the tool on the roles `routes` replaces. */
async function runVariant(
  args: ReplayArgs,
  routes: Variant,
  { root, signal }: { root: string; signal?: AbortSignal }
): Promise<{ result: Untyped; code: Untyped }> {
  if (args.answersDir === null) return runMain(args, { root, signal, answers: null, routes });
  // `--answers-dir`: every request answers through files (scripts/lib/answers-dir.ts); `done` ends the run.
  const { estimateMessages } = await import(pathToFileURL(path.join(root, 'src', 'llm', 'tokens.ts')).href);
  const answers = createAnswersDir({
    dir: path.resolve(root, args.answersDir),
    timeoutMin: args.answersTimeoutMin,
    estimate: (messages) => estimateMessages(messages),
  });
  let code = 1;
  try {
    const out = await runMain(args, { root, signal, answers, routes });
    code = out.code;
    return { ...out, result: { ...out.result, answersDir: { dir: answers.dir, requests: answers.count() } } };
  } catch (err) {
    code = err instanceof CliError ? err.exitCode : 1;
    throw err;
  } finally {
    answers.finish(code);
  }
}

async function runMain(args: ReplayArgs, { root, signal, answers, routes }: RunEnv) {
  const src = path.join(root, 'src');
  const load = (rel: Untyped) => import(pathToFileURL(path.join(src, rel)).href);

  // The triggers of --loop-triggers, read before anything else: their number is the estimate.
  let triggers: Untyped = null;
  if (args.loopTriggers) {
    if (args.triggers !== null) {
      try {
        triggers = parseTriggers(fs.readFileSync(path.resolve(root, args.triggers), 'utf8'));
      } catch (err: Untyped) {
        throw new CliError(`replay-cli: ${args.triggers}: ${err?.code === 'ENOENT' ? 'not found' : err.message}`);
      }
      if (triggers.length === 0) throw new CliError(`replay-cli: ${args.triggers} names no trigger`);
    } else triggers = [{ placeId: args.placeId, triggerId: args.triggerId, turnId: null }];
  }
  // The scenarios of --skills, read before anything else too: their runs are the estimate.
  let scenarios = null;
  if (args.skills !== null) {
    let text;
    try {
      text = fs.readFileSync(path.resolve(root, args.skills), 'utf8');
    } catch (err: Untyped) {
      throw new CliError(`replay-cli: ${args.skills}: ${err?.code === 'ENOENT' ? 'not found' : err.message}`);
    }
    scenarios = parseScenarios(text);
  }
  const { deepMerge } = await load('config.ts');
  const { createHot } = await load('hot.ts');
  const { log } = await load('log.ts');

  // Reads config.json, config.local.json and both prompt layers; writes nothing. Not watched: one request.
  const hot = routedHot(createHot({ rootDir: root, privateDir: privateDirOf(root) }), routes);
  // The spend gate: the estimate first; nothing is sent without --spend covering it.
  let spendBudget = null;
  // A diary day's estimate needs its plan, made from the config: its gate is in runDiaryDay.
  if (args.showRequestTurn === null && !args.diaryDay) {
    const turns = args.dry
      ? 0
      : args.loopTriggers
        ? triggers.length
        : scenarios
          ? scenarioTurns(scenarios)
          : args.samples!;
    const requests = turns * TURN_REQUESTS;
    const detail = `~${USD_PER_ANSWER} USD per request, up to ${TURN_REQUESTS} per turn (the persona's answer and its tool-loop steps)`;
    let gate = spendGate({ estimateUsd: requests * USD_PER_ANSWER, requests, spend: args.spend, detail });
    // Every request answers from the files and bills nothing: without --spend the run goes on.
    if (!gate.ok && answers && args.spend === undefined)
      gate = {
        ...gate,
        ok: true,
        text: `${gate.text.split('\n')[0]}\nanswers-dir: every request answers from the files, nothing is billed`,
      };
    if (!gate.ok) {
      hot.close();
      throw new CliError(`replay-cli: ${gate.text}`, { exitCode: REFUSED_EXIT });
    }
    spendBudget = gate.budget;
    process.stderr.write(`replay-cli: ${gate.text}\n`);
  }
  if (args.diaryDay) {
    try {
      return await runDiaryDay({ args, root, load, hot, createHot, log, signal, answers, routes });
    } finally {
      hot.close();
    }
  }
  if (args.inner) {
    try {
      return await runInner({ args, root, load, hot, createHot, log, signal, budget: spendBudget, answers, routes });
    } finally {
      hot.close();
    }
  }
  const liveData = defaultDataDir(root);
  const dataDir = args.snapshot !== null ? path.resolve(root, args.snapshot) : liveData;
  if (!fs.existsSync(dataDir)) throw new CliError(`replay-cli: no data directory at ${dataDir}`);

  // --show-request <turnId>: a stored dump needs neither Discord nor a key.
  let turnStart = null;
  if (args.showRequestTurn !== null) {
    const journalGuild = resolveGuildId(liveData, hot.config.bot?.placeId || undefined);
    const journalDirs = [
      ...new Set([
        path.join(liveData, 'guilds', journalGuild, 'journal'),
        path.join(dataDir, 'guilds', journalGuild, 'journal'),
      ]),
    ];
    for (const dir of journalDirs) {
      const dumps = storedDumps(dir, args.showRequestTurn, { steps: args.steps });
      if (dumps.length > 0) {
        hot.close();
        return {
          code: 0,
          result: {
            source: 'dump',
            turnId: args.showRequestTurn,
            dumps: dumps.map(({ file, dump }) => ({ file, ...dump })),
          },
        };
      }
    }
    for (const dir of journalDirs) {
      turnStart =
        journalRecords(dir).find((record) => record?.kind === 'turn.start' && record.turnId === args.showRequestTurn) ??
        null;
      if (turnStart) break;
    }
    if (!turnStart)
      throw new CliError(
        `replay-cli: no request dump and no turn.start record of ${args.showRequestTurn} in the journal`
      );
    if (!SNOWFLAKE.test(turnStart.scope?.channel ?? '') || !SNOWFLAKE.test(turnStart.trigger?.messageId ?? '')) {
      throw new CliError(
        'replay-cli: that turn has no channel or trigger message to rebuild it from (a spontaneous or private turn)'
      );
    }
    args.placeId = turnStart.scope.channel;
    args.triggerId = turnStart.trigger.messageId;
  }
  const discordToken = platformToken('discord', { rootDir: root });
  const keyNeeded = args.showRequestTurn === null && !args.dry;
  const { createStore } = await load('memory/store.ts');
  const { createCalibrator } = await load('llm/tokens.ts');
  const { createLlm } = await load('llm/openrouter.ts');
  const { createEmbedder } = await load('llm/embed.ts');
  const discordPackage = (await load('../interfaces/discord/index.ts')) as Record<string, Untyped>;
  const { createDiscordInterface, resolveGuild } = discordPackage;

  let client: Untyped = null;
  let layered: { hot: Untyped; dir: string } | null = null;
  try {
    const discord = createRequire(path.join(root, 'package.json'))('discord.js');
    const connection = await connectDiscord({
      discord,
      token: discordToken,
      configuredGuildId: hot.config.bot?.placeId || '',
      resolveGuild,
      log,
    });
    client = connection.client;
    refuseDiscordWrites(client);
    const port = createDiscordInterface({ client, config: () => hot.config }).port;
    // The model clients on the data folder's routing: the counters an unflushed copy of the store's state, never written.
    const { state } = unflushedStore(createStore({ dataDir, memoryDb: storeMemoryFor(dataDir) }));
    const calibrator = createCalibrator(state.data.calibration);
    const routing = keyNeeded
      ? await replayRouting(createLlm, hot, calibrator, state, { root, answers, routes })
      : null;
    // Every request is marked as this tool's own. One sample: no cache marker.
    const noCache = replayWithoutCache(args, Boolean(scenarios));
    // A run that sends nothing (a rebuilt request, --dry) answers every request before the one it keeps with nothing.
    const silent = { complete: () => Promise.resolve({ text: '', toolCalls: [] }) };
    const llm =
      routing === null
        ? silent
        : {
            complete: (messages: Untyped, options: Untyped) =>
              routing.llm.complete(messages, {
                ...options,
                origin: 'replay',
                countAgainstDailyCap: false,
                skipCalibration: true,
                ...(noCache ? { cache: false } : {}),
              }),
          };
    const embedder = routing === null || answers ? null : createEmbedder({ apiKey: '', keyOf: routing.keyOf, state });
    const embed = (texts: Array<string>, options?: unknown) =>
      embedder === null ? Promise.resolve(texts.map(() => null)) : embedder.embed(texts, options);
    // The live journal's records, read once on first need: the mode and trigger kind each turn recorded at its start.
    let journalCache: Array<Untyped> | null = null;
    const journalOf = () =>
      (journalCache ??= journalRecords(path.join(liveData, 'guilds', String(connection.placeId), 'journal')));
    const kit = {
      args,
      root,
      liveData,
      dataDir,
      hot,
      port,
      reads: discordReads(client, () => hot.config).reads,
      llm,
      embed,
      journalOf,
      log,
      signal,
      budget: spendBudget,
    };
    if (args.loopTriggers) return await runTriggerLoops({ ...kit, triggers });
    if (scenarios) {
      // The prompt layers the scenarios are answered under: the live ones, or `--prompts` over a copy of
      // prompts.local/; labels.json merged as src/hot.js merges it.
      if (args.prompts !== null) layered = overlayPromptsHot(createHot, root, args.prompts, { mergeJson: deepMerge });
      return await runSkills({ ...kit, hot: layered?.hot ?? hot, scenarios, connection });
    }
    if (turnStart) return await rebuiltRequest({ ...kit, llm: silent, turnStart });
    return await runMessage({ ...kit, placeId: args.placeId!, triggerId: args.triggerId! });
  } finally {
    hot.close();
    if (layered) {
      layered.hot.close();
      fs.rmSync(layered.dir, { recursive: true, force: true });
    }
    if (client && typeof client.destroy === 'function') await Promise.resolve(client.destroy()).catch(() => {});
  }
}
