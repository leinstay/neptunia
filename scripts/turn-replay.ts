#!/usr/bin/env node
// Replays one stored turn with the engine's own turn code over a copy of a data folder, and cuts such a copy at the
// moment a turn started. Exists so a change of the turn's steps can be measured on real moments before it ships.
//
//   node scripts/turn-replay.ts --data <copy dir> --turn <turnId> [--samples 1] [--out <dir>]
//        [--answers-dir <dir>] [--compare] [--oracle <memory.db>] [--prompts <dir>] [--embed live|off]
//        [--calibration <ratio>] [--kind <diary kind>]
//   node scripts/turn-replay.ts --data <copy dir> --cut <turnId> --into <new copy dir>
//
// `--cut` writes a new folder whose memory is the copy's as it stood when the turn started (scripts/lib/turn-cut.ts
// names the tables and columns it cuts). `--turn` (a whole id, or a prefix only one turn has) reads the turn's
// `turn.start` row and runs the turn again through `createTurnRunner` composed as the core composes it
// (scripts/lib/turn-wiring.ts), on a port over the copy's stored lines through the trigger
// (scripts/lib/turn-stage.ts), with every clock pinned to the turn's start. Her read tools run on the copy. Every other
// tool and every write to the interface is kept and answered as done (scripts/lib/turn-tools.ts, turn-port.ts). She is
// who the core holds her to be for every turn, her account on the home interface (turn-wiring.ts `homeIdentity`), and
// stderr names that interface. A diary turn (its `turn.start` row says `mode: "diary"`) names no place and no trigger:
// it runs on the home interface as the diary service runs it, every place of that interface served from the copy, and
// what the post would publish is kept with the turn's result. `--kind` pins the post's kind, not forced, and is refused
// for any other turn. Without it the kind is drawn as live.
// `--answers-dir` answers every model request from files (scripts/lib/answers-dir.ts). Without it the roles run on the
// copy's routing (scripts/lib/script-routes.ts) and spend its keys. `--embed live` lets the embedding role alone reach
// its provider while `--answers-dir` is set. With `--answers-dir` the default is `off`, without it `live`.
// `--compare` builds the first request only and compares it, part by part, with the row the live turn archived in
// `--oracle` (default `/opt/neptunia/data/memory.db`, opened read only): one line per part on stdout, sizes and
// offsets only. A diary turn's compare covers its director request too: the director is answered with the answer the
// live turn archived, and the turn's first request is compared after it. Otherwise each sample's report goes to `<out>/<turnId>/sample-<n>.json` (default `out` beside the
// copy) and a short table to stderr.
//
// THE REPORT FILE HOLDS HER WORDS AND MEMORY ABOUT REAL PEOPLE: it is private, like the copy. Nothing she says goes
// to stdout or a log. Never start this against a live data folder: it refuses a folder a live process holds only for
// `--cut`, and reads `--turn`'s folder read only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHot } from '../src/hot.ts';
import type { Hot } from '../src/hot.ts';
import { deepMerge } from '../src/config.ts';
import { createLlm } from '../src/llm/openrouter.ts';
import { createEmbedder } from '../src/llm/embed.ts';
import { estimateMessages } from '../src/llm/tokens.ts';
import { roleModel } from '../src/llm/roles.ts';
import { CliError, flagText, parseFlags, runCli } from './lib/cli.ts';
import { createAnswersDir, offlineCore } from './lib/answers-dir.ts';
import { promptLayersHot } from './lib/prompt-layers.ts';
import { cutCopy } from './lib/turn-cut.ts';
import { diaryParamsOf, stageOf, storedTurn, triggerOf, turnParamsOf } from './lib/turn-stage.ts';
import { buildTurnRunner, homeIdentity, identityIn, scratchDir } from './lib/turn-wiring.ts';
import { archivedRequest, compareRequests, foldRepeats, blockOf, partsOf, rowsText } from './lib/turn-compare.ts';
import type { RequestParts } from './lib/turn-compare.ts';
import { STOPPED, recordingLlm, reportTable, turnReport } from './lib/turn-report.ts';
import type { KeptRequest } from './lib/turn-report.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = 'turn-replay';
const ORACLE = '/opt/neptunia/data/memory.db';
const USAGE = [
  'usage: node scripts/turn-replay.ts --data <copy dir> --turn <turnId> [--samples 1] [--out <dir>]',
  '         [--answers-dir <dir>] [--compare] [--oracle <memory.db>] [--prompts <dir>] [--embed live|off]',
  '         [--calibration <ratio>] [--kind <diary kind>]',
  '       node scripts/turn-replay.ts --data <copy dir> --cut <turnId> --into <new copy dir>',
].join('\n');

type Rec = Record<string, unknown>;

type Embed = (texts: Array<string>, options?: unknown) => Promise<Array<ArrayLike<number> | null>>;

/** The copy's routing as production builds it: each role on its chain, spending the copy's keys. */
async function routingOf(hot: Hot, dataDir: string) {
  const state = { data: {}, markDirty() {} };
  // Loaded only for a run that spends: an offline run needs none of the clients it builds.
  const { scriptRouting, routesText } = await import('./lib/script-routes.ts');
  const routing = await scriptRouting(TOOL, {
    privateDir: dataDir,
    roles: ['core', 'analyzer', 'vision', 'video', 'embedding', 'search'],
    variant: {},
    getConfig: (): unknown => hot.config,
    createDirect: (keys, getConfig) =>
      createLlm({ apiKey: '', keys, getConfig, calibrator: { ratio: 1, apply: (n: number) => n }, state } as never),
    state: state,
  });
  return { routing, said: routesText(TOOL, routing.said) };
}

/**
 * The model client and the embedder of the run. With an answers folder every request is answered from files, else
 * the roles run on the copy's routing. The embedder reaches its provider on the copy's embedding key when `live`,
 * and embeds nothing otherwise.
 */
async function clientsOf(hot: Hot, dataDir: string, answersDir: string | null, live: boolean) {
  const none: Embed = (texts) => Promise.resolve(texts.map(() => null));
  const spends = answersDir === null || live;
  const built = spends ? await routingOf(hot, dataDir) : null;
  const embedOf = (): Embed => {
    if (!live || built === null) return none;
    const embedder = createEmbedder({
      apiKey: '',
      keyOf: built.routing.keyOf,
      state: { data: {}, markDirty() {} },
    });
    return (texts, options) => embedder.embed(texts, options);
  };
  const closeRouting = (): Promise<void> => (built === null ? Promise.resolve() : built.routing.close());
  if (answersDir !== null) {
    const answers = createAnswersDir({ dir: answersDir });
    const offline = offlineCore(answers, (purpose) => roleModel(hot.config, 'core', String(purpose ?? '')));
    return { llm: offline, embed: embedOf(), finish: (code: number) => answers.finish(code), close: closeRouting };
  }
  if (built === null) throw new Error(`${TOOL}: no routing for a run that spends`);
  process.stderr.write(built.said);
  return { llm: built.routing.llm, embed: embedOf(), finish: () => {}, close: closeRouting };
}

/** The settings and prompts of the copy, with `--prompts` laid over its prompts as scripts/replay.ts lays them. */
function hotOf(dataDir: string, promptsDir: string | null): { hot: Hot; close: () => void } {
  if (promptsDir === null) {
    const hot = createHot({ rootDir: ROOT, privateDir: dataDir });
    return { hot, close: () => hot.close() };
  }
  const local = path.join(dataDir, 'prompts');
  const layers = fs.existsSync(local) ? [local, path.resolve(promptsDir)] : [path.resolve(promptsDir)];
  const layered = promptLayersHot(createHot, ROOT, layers, {
    mergeJson: deepMerge,
    env: { NEPTUNIA_DATA_DIR: dataDir },
  });
  return {
    hot: layered.hot,
    close: () => {
      layered.hot.close();
      fs.rmSync(layered.dir, { recursive: true, force: true });
    },
  };
}

/** The first request of `purpose` the live turn archived in `oracle`, with the answer it got. */
function archivedOf(oracle: string, turnId: string, purpose: string): { parts: RequestParts; text: string | null } {
  const db = new DatabaseSync(oracle, { readOnly: true });
  try {
    const found = archivedRequest(db, turnId, purpose);
    if (found === null) throw new CliError(`${TOOL}: ${oracle} archived no ${purpose} request of ${turnId}`);
    return found;
  } finally {
    db.close();
  }
}

/** The lines of a chat block that open a message (`#N ...`), after the repeats are folded. */
const numberedLines = (block: string): string =>
  foldRepeats(block)
    .split('\n')
    .filter((line) => /^#\d+\b/.test(line))
    .join('\n');

/**
 * The compare's lines. A chat block that differs is compared again with its repeated lines folded, whole and as its
 * numbered message lines alone.
 */
function compareText(rebuilt: RequestParts, archived: RequestParts): string {
  const rows = compareRequests(rebuilt, archived);
  const mine = blockOf(rebuilt.user, 'chat');
  const theirs = blockOf(archived.user, 'chat');
  if (mine !== null && theirs !== null && mine !== theirs) {
    const again = (part: string, a: string, b: string) => {
      const found = compareRequests({ system: a, user: '', tools: [] }, { system: b, user: '', tools: [] })[0];
      rows.push({ ...found, part });
    };
    again('<chat> with repeated lines folded', foldRepeats(mine), foldRepeats(theirs));
    again('<chat> message lines with repeated lines folded', numberedLines(mine), numberedLines(theirs));
  }
  return `${rowsText(rows)}\n`;
}

/** The parameters of a reply turn: its trigger line read off the port, as the pipeline passes them. */
async function replyParams(
  stage: ReturnType<typeof stageOf>,
  turn: ReturnType<typeof storedTurn>,
  db: DatabaseSync,
  wired: ReturnType<typeof buildTurnRunner>
): Promise<Record<string, unknown>> {
  const trigger = await triggerOf(stage, turn, db);
  const internal = turn.iface === 'cli' ? wired.memoryContext({ kind: 'internal' }) : null;
  return turnParamsOf(turn, stage, trigger, internal);
}

/** One run of the stored turn: its requests, its writes, its kept calls and the turn's result. */
async function runOnce(options: {
  dataDir: string;
  turnId: string;
  hot: Hot;
  llm: { complete: (messages: unknown, options?: unknown) => Promise<unknown> };
  embed: (texts: Array<string>, options?: unknown) => Promise<Array<ArrayLike<number> | null>>;
  stopAt: string | null;
  calibration: number | null;
  kind: string | null;
}) {
  const db = new DatabaseSync(path.join(options.dataDir, 'memory.db'), { readOnly: true });
  const tmpDir = scratchDir('nep-turn-replay-');
  try {
    const stored = storedTurn(db, options.turnId);
    const now = () => stored.at;
    // The adapter of the turn's interface knows her by her account there, and the core by her account on the home one.
    const home = homeIdentity(db, options.dataDir);
    // A turn in no place, a diary turn, runs on the home interface as the core's diary service runs it.
    const turn = stored.placeId === null ? { ...stored, iface: home.iface } : stored;
    const diary = stored.mode === 'diary' || options.kind !== null ? diaryParamsOf(stored, options.kind) : null;
    const self = { selfId: home.selfId, selfName: home.selfName };
    const said =
      home.from === 'clients.json'
        ? 'the first interface of clients.json'
        : 'no clients.json, her first account off the command line';
    process.stderr.write(`${TOOL}: identity: ${home.iface} (${said})\n`);
    const stage = stageOf({
      db,
      dataDir: options.dataDir,
      turn,
      selfId: identityIn(db, turn.iface).selfId,
      now,
      tmpDir,
    });
    const recorded = recordingLlm(options.llm, { stopAt: options.stopAt });
    const wired = buildTurnRunner({
      root: ROOT,
      dataDir: options.dataDir,
      hot: options.hot,
      turnId: turn.turnId,
      now,
      identity: { iface: turn.iface, ...self, rootNative: stage.rootNative },
      rootPlace: stage.rootPlace,
      port: stage.port,
      llm: recorded.llm,
      embed: options.embed,
      ...(options.calibration === null ? {} : { calibration: options.calibration }),
    });
    try {
      await wired.seed();
      const params = diary ?? (await replyParams(stage, turn, db, wired));
      const result = (await wired.under(() => wired.runner.runTurn(params))) as Rec;
      return {
        turn,
        result,
        requests: recorded.requests,
        writes: stage.writes,
        calls: wired.calls,
        carried: wired.carried,
        journal: wired.journal.lines,
      };
    } finally {
      wired.close();
      stage.close();
    }
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const FLAGS = {
  values: [
    '--data',
    '--turn',
    '--cut',
    '--into',
    '--samples',
    '--out',
    '--answers-dir',
    '--oracle',
    '--prompts',
    '--embed',
    '--calibration',
    '--kind',
  ],
  switches: ['--compare'],
  usage: USAGE,
};

type Flags = ReturnType<typeof parseFlags>;
type RunInput = Parameters<typeof runOnce>[0];

/** What a `--turn` run was asked for, or the usage error. */
function turnOptions(flags: Flags, dataDir: string) {
  const turnId = flagText(flags, '--turn');
  if (turnId === undefined) throw new CliError(USAGE);
  const answersDir = flagText(flags, '--answers-dir') ?? null;
  const embed = flagText(flags, '--embed') ?? (answersDir === null ? 'live' : 'off');
  if (embed !== 'live' && embed !== 'off') throw new CliError(USAGE);
  const samples = Number(flagText(flags, '--samples') ?? '1');
  if (!Number.isInteger(samples) || samples < 1) throw new CliError(USAGE);
  const outDir = path.resolve(flagText(flags, '--out') ?? path.join(path.dirname(dataDir), 'out'));
  if (outDir === dataDir || outDir.startsWith(`${dataDir}${path.sep}`))
    throw new CliError(`${TOOL}: --out may not be inside the data copy`);
  const ratioText = flagText(flags, '--calibration');
  const calibration = ratioText === undefined ? null : Number(ratioText);
  if (calibration !== null && !(calibration >= 0.6 && calibration <= 1.6)) throw new CliError(USAGE);
  return {
    turnId,
    answersDir,
    live: embed === 'live',
    samples,
    outDir,
    calibration,
    compare: flags['--compare'] === true,
    oracle: path.resolve(flagText(flags, '--oracle') ?? ORACLE),
    prompts: flagText(flags, '--prompts') ?? null,
    kind: flagText(flags, '--kind') ?? null,
  };
}

/** Writes a private file of a run under the out folder. */
function writePrivate(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The first request of the turn built again and compared with the archived one. A diary turn's director request is
 * compared first and answered with the live answer, so the turn's first request is built on the live scene.
 */
async function compareRun(input: RunInput, outDir: string, oracle: string): Promise<string> {
  const director = archivedDirector(input, oracle);
  const llm =
    director === null
      ? input.llm
      : {
          ...input.llm,
          complete: (messages: unknown, options?: unknown) =>
            (options as { purpose?: unknown } | undefined)?.purpose === 'diary-scene'
              ? Promise.resolve({ text: director.text ?? '', toolCalls: [] })
              : input.llm.complete(messages, options),
        };
  const run = await runOnce({ ...input, llm, stopAt: 'reply' });
  const { turnId } = run.turn;
  const first: KeptRequest | undefined = run.requests.find((request) => request.purpose === 'reply');
  const directed = run.requests.find((request) => request.purpose === 'diary-scene');
  // The rebuilt requests beside the reports, private as they are, for a reader who must see the difference.
  writePrivate(path.join(outDir, turnId, 'first-request.json'), {
    ...(directed === undefined ? {} : { director: { messages: directed.messages } }),
    messages: first?.messages ?? null,
    tools: first?.tools ?? null,
    memoryReads: run.carried,
  });
  const lines: Array<string> = [];
  if (director !== null) {
    if (directed === undefined) throw new CliError(`${TOOL}: the turn ended before its director request`);
    lines.push('diary-scene:', compareText(partsOf(directed.messages, directed.tools), director.parts));
  }
  if (first === undefined)
    throw new CliError(`${TOOL}: the turn ended ${String(run.result.outcome)} before its first request`);
  const writer = compareText(partsOf(first.messages, first.tools), archivedOf(oracle, turnId, 'reply').parts);
  lines.push(...(director === null ? [writer] : ['reply:', writer]));
  return lines.join('\n');
}

/**
 * The director request the live diary turn archived in `oracle`, null for a turn of the copy that is no diary turn.
 * A diary turn of a kind with no scene archived none, and reading it fails as any missing archived request does.
 */
function archivedDirector(input: RunInput, oracle: string): { parts: RequestParts; text: string | null } | null {
  const copy = new DatabaseSync(path.join(input.dataDir, 'memory.db'), { readOnly: true });
  const turn = (() => {
    try {
      return storedTurn(copy, input.turnId);
    } finally {
      copy.close();
    }
  })();
  return turn.mode === 'diary' ? archivedOf(oracle, turn.turnId, 'diary-scene') : null;
}

/** The turn run whole `samples` times, one private report file each. */
async function sampleRuns(input: RunInput, outDir: string, samples: number): Promise<string> {
  const written: Array<string> = [];
  for (let sample = 1; sample <= samples; sample += 1) {
    const run = await runOnce(input);
    const { turnId } = run.turn;
    const report = turnReport({
      turnId,
      sample,
      requests: run.requests,
      writes: run.writes,
      keptCalls: run.calls,
      result: run.result,
      journal: run.journal,
      estimate: (messages) => estimateMessages(messages),
    });
    const file = path.join(outDir, turnId, `sample-${sample}.json`);
    writePrivate(file, { ...report, requests: run.requests });
    process.stderr.write(`${reportTable(report)}\n`);
    written.push(file);
  }
  return `${written.join('\n')}\n`;
}

async function main(argv: Array<string>): Promise<string> {
  const flags = parseFlags(argv, FLAGS);
  const dataText = flagText(flags, '--data');
  if (dataText === undefined) throw new CliError(USAGE);
  const dataDir = path.resolve(dataText);
  const cut = flagText(flags, '--cut');
  if (cut !== undefined) {
    const into = flagText(flags, '--into');
    if (into === undefined) throw new CliError(USAGE);
    const done = cutCopy({ from: dataDir, into: path.resolve(into), turnId: cut });
    const lines = done.counts.map((count) => `${count.table}: ${count.removed} removed, ${count.restored} set back`);
    return `cut at ${new Date(done.at).toISOString()}\n${lines.join('\n')}\n`;
  }
  const asked = turnOptions(flags, dataDir);
  const { hot, close } = hotOf(dataDir, asked.prompts);
  const client = await clientsOf(hot, dataDir, asked.answersDir, asked.live);
  const input: RunInput = {
    dataDir,
    turnId: asked.turnId,
    hot,
    llm: client.llm,
    embed: client.embed,
    stopAt: null,
    calibration: asked.calibration,
    kind: asked.kind,
  };
  try {
    const text = asked.compare
      ? await compareRun(input, asked.outDir, asked.oracle)
      : await sampleRuns(input, asked.outDir, asked.samples);
    client.finish(0);
    return text;
  } catch (error) {
    if (error instanceof Error && error.message === STOPPED) throw new CliError(`${TOOL}: ${STOPPED}`);
    client.finish(1);
    throw error;
  } finally {
    await client.close();
    close();
  }
}

runCli(import.meta.url, main);
