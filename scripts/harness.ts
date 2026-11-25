#!/usr/bin/env node
// The reference harness: records what the engine does on stored turns of a data copy, and compares two such records.
//
//   node scripts/harness.ts edges --data <work copy dir> --corpus <file>
//   node scripts/harness.ts turns --data <copy dir> --corpus <file> --answers archive --seed <text> --out <dir>
//        [--deadline-ms 170000]
//   node scripts/harness.ts db --data <copy dir> --from <turnId> --corpus <file> --answers archive --turns-run <dir>
//        --out <dir>
//   node scripts/harness.ts cli --data <writable copy dir> --out <dir>
//   node scripts/harness.ts faults --out <dir>
//   node scripts/harness.ts compare <runA> <runB> [--edge <name>]
//
// `edges` writes into a work copy, before `turns`, `db` and `cli` run on it, the synthetic rows of
// scripts/lib/harness-edges.ts: inputs the stored corpus never gives, picked by the corpus turns' structure. stdout gets
// how many rows each edge wrote.
//
// `turns` replays every turn of the corpus (scripts/lib/harness-corpus.ts, one `<group> <turnId>` a line) through the
// engine's turn code exactly as scripts/replay.ts `--answers archive --seed` replays one (scripts/lib/turn-run.ts):
// every model request answered from the copy's archive, offline, every clock on the turn's start, every random draw
// and id seeded. Each turn runs alone with its own deadline, and a turn past it is recorded as ended at the deadline.
// It writes four records per turn under `<out>/<edge>/<turnId>.jsonl` (scripts/lib/harness-record.ts): `requests`,
// `tools`, `actions` and `lines`. A command line turn's `actions` end with the `command.result` the command line
// answers it with. stderr gets one line per turn with its group, how it ended and the counts of each record, and
// stdout the count of turns.
//
// `db` records the memory database edge (scripts/lib/harness-db.ts): over a copy cut at the corpus turn `--from` it
// writes again, through the memory writers and in time order, every line the copy recorded after the cut and the
// `lines` record of every turn of `--corpus` that the `turns` run `--turns-run` writes, and replays the stored
// memory-session runs after the cut with their archived answers. It may start beside `turns`: on reaching a turn it
// waits for that turn's `lines` record, and fails naming the turn when the turns run writes no record for
// LINES_WAIT_MS. It then writes `<out>/db/tables.json`, one
// `<out>/db/<table>.sha` per table and `<out>/db/graph.json`. Every request a session run sent goes into that run's
// `<out>/db-requests/<nnnnn>.jsonl`, in the shape of the `requests` record of `turns`. stderr gets its counts, stdout
// the count of tables.
//
// `cli` records the command line edge (scripts/lib/harness-cli.ts): a fixed list of the owner's commands answered by
// the core's own command desk over the copy, which its writes change, one `<out>/cli/<nn>-<name>.txt` per command and
// `<out>/cli/unrecorded.txt`. stdout gets the counts.
//
// `faults` runs the long plan of scripts/lib/fault-run.ts over temporary folders and writes its effect table as records
// under `<out>/faults/` (scripts/lib/harness-faults.ts), with `gaps.txt`. stdout gets the count of scenarios and
// whether the run passed.
//
// `compare` compares two runs byte for byte under every `<run>/<edge>/` either holds, or under `--edge` alone
// (scripts/lib/harness-compare.ts), prints counts, record names and offsets, never content, and exits 0 only when
// the runs are identical.
//
// THE RECORDS HOLD THE PERSONA'S WORDS AND MEMORY ABOUT REAL PEOPLE: they are private, like the copy. Never start this against a
// live data folder.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, flagText, parseFlags, runCli } from './lib/cli.ts';
import { readCorpus } from './lib/harness-corpus.ts';
import { compareRuns } from './lib/harness-compare.ts';
import { runCliEdge } from './lib/harness-cli.ts';
import { runDbEdge } from './lib/harness-db.ts';
import { applyEdges } from './lib/harness-edges.ts';
import { FAULT_GAPS, writeFaultRecords } from './lib/harness-faults.ts';
import { LONG_PLAN, faultRun } from './lib/fault-run.ts';
import { turnRecords, writeTurnRecords } from './lib/harness-record.ts';
import type { TurnRun } from './lib/harness-record.ts';
import { keepCommandResult } from './lib/turn-port.ts';
import { archiveOfCopy, hotOf, runStoredTurn } from './lib/turn-run.ts';
import type { Hot } from '../src/hot.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = 'harness';
const USAGE = [
  'usage: node scripts/harness.ts edges --data <work copy dir> --corpus <file>',
  '       node scripts/harness.ts turns --data <copy dir> --corpus <file> --answers archive --seed <text> --out <dir>',
  '         [--deadline-ms 170000]',
  '       node scripts/harness.ts db --data <copy dir> --from <turnId> --corpus <file> --answers archive',
  '         --turns-run <dir> --out <dir>',
  '       node scripts/harness.ts cli --data <writable copy dir> --out <dir>',
  '       node scripts/harness.ts faults --out <dir>',
  '       node scripts/harness.ts compare <runA> <runB> [--edge <name>]',
].join('\n');

// One turn of the corpus replays in seconds; the longest stored turns ran about two minutes live.
const DEFAULT_DEADLINE_MS = 170_000;

// A turns run writes each turn's records at most one deadline after the previous turn's, plus the seconds its start
// and its recording take. A db run that sees no new record for a deadline and 30 seconds more waits on a turns run
// that has stopped.
const LINES_WAIT_MS = DEFAULT_DEADLINE_MS + 30_000;

const FLAGS = {
  values: ['--data', '--corpus', '--answers', '--seed', '--out', '--deadline-ms', '--edge', '--from', '--turns-run'],
  usage: USAGE,
};

/** The embedder of an offline run: it embeds nothing, as the stored-turn mode's `--embed off` of scripts/replay.ts. */
const noEmbed = (texts: Array<string>): Promise<Array<null>> => Promise.resolve(texts.map(() => null));

/** `work` raced against `ms`: its value, or `deadline` once the time is up. */
async function withDeadline<TResult>(work: Promise<TResult>, ms: number): Promise<TResult | 'deadline'> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** One corpus turn replayed: what it kept and how it ended. */
async function replayTurn(options: {
  dataDir: string;
  turnId: string;
  hot: Hot;
  seed: string;
  deadlineMs: number;
}): Promise<{ run: TurnRun; paths: Array<string> }> {
  const archive = archiveOfCopy(options.dataDir, options.turnId);
  const ran = runStoredTurn({
    root: ROOT,
    tool: TOOL,
    dataDir: options.dataDir,
    turnId: options.turnId,
    hot: options.hot,
    llm: archive.llm,
    embed: noEmbed,
    stopAt: null,
    calibration: null,
    kind: null,
    seed: options.seed,
    archive: true,
  });
  const paths = [options.dataDir, ROOT];
  try {
    const done = await withDeadline(ran, options.deadlineMs);
    if (done === 'deadline') {
      // The turn goes on in the background with what it kept so far out of reach: its record says only that it ended.
      return { run: { requests: [], gateway: [], journal: [], writes: [], end: 'deadline' }, paths };
    }
    const outcome = typeof done.result.outcome === 'string' ? done.result.outcome : 'none';
    const writes = [...done.writes];
    if (done.turn.iface === 'cli' && done.triggerId !== null)
      keepCommandResult(
        writes,
        {
          replyRef: done.triggerId,
          outcome,
          reason: typeof done.result.reason === 'string' ? done.result.reason : null,
        },
        () => done.turn.at
      );
    return {
      run: { requests: done.requests, gateway: done.gateway, journal: done.journal, writes, end: outcome },
      paths: [done.tmpDir, ...paths],
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error';
    return { run: { requests: [], gateway: [], journal: [], writes: [], end: `error:${name}` }, paths };
  }
}

/** `edges`: the synthetic rows written into a work copy. */
async function edgesCommand(flags: ReturnType<typeof parseFlags>): Promise<string> {
  const dataText = flagText(flags, '--data');
  const corpusFile = flagText(flags, '--corpus');
  if (dataText === undefined || corpusFile === undefined) throw new CliError(USAGE);
  const corpus = readCorpus(fs.readFileSync(corpusFile, 'utf8'));
  const counts = await applyEdges({ root: ROOT, dataDir: path.resolve(dataText), corpus });
  const rows = Object.entries(counts).map(([edge, count]) => `${edge} ${count}`);
  return `edges: ${rows.join(', ')}\n`;
}

/** `turns`: every corpus turn replayed and recorded. */
async function turnsCommand(flags: ReturnType<typeof parseFlags>): Promise<string> {
  const dataText = flagText(flags, '--data');
  const corpusFile = flagText(flags, '--corpus');
  const seed = flagText(flags, '--seed');
  const outText = flagText(flags, '--out');
  if (dataText === undefined || corpusFile === undefined || seed === undefined || outText === undefined)
    throw new CliError(USAGE);
  if (flagText(flags, '--answers') !== 'archive') throw new CliError(`${TOOL}: turns answers from the archive only`);
  const deadlineMs = Number(flagText(flags, '--deadline-ms') ?? DEFAULT_DEADLINE_MS);
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1) throw new CliError(USAGE);
  const dataDir = path.resolve(dataText);
  const out = path.resolve(outText);
  if (out === dataDir || out.startsWith(`${dataDir}${path.sep}`))
    throw new CliError(`${TOOL}: --out may not be inside the data copy`);
  const turns = readCorpus(fs.readFileSync(corpusFile, 'utf8'));
  const { hot, close } = hotOf(ROOT, dataDir, null);
  try {
    for (const { group, turnId } of turns) {
      const { run, paths } = await replayTurn({ dataDir, turnId, hot, seed, deadlineMs });
      writeTurnRecords(out, turnId, turnRecords(run, paths));
      process.stderr.write(
        `${TOOL}: ${group} ${turnId} ${run.end}: ${run.requests.length} requests, ${run.gateway.length} calls, ` +
          `${run.writes.length} actions\n`
      );
    }
  } finally {
    close();
  }
  return `${turns.length} turns recorded\n`;
}

/** The seed that picks the graph phases' retired rows. */
const GRAPH_SEED = 'a';

/** `db`: the memory database edge over a copy cut at `--from`. */
async function dbCommand(flags: ReturnType<typeof parseFlags>): Promise<string> {
  const dataText = flagText(flags, '--data');
  const fromTurn = flagText(flags, '--from');
  const corpusFile = flagText(flags, '--corpus');
  const turnsText = flagText(flags, '--turns-run');
  const outText = flagText(flags, '--out');
  if (
    dataText === undefined ||
    fromTurn === undefined ||
    corpusFile === undefined ||
    turnsText === undefined ||
    outText === undefined
  )
    throw new CliError(USAGE);
  if (flagText(flags, '--answers') !== 'archive') throw new CliError(`${TOOL}: db answers from the archive only`);
  const dataDir = path.resolve(dataText);
  const out = path.resolve(outText);
  if (out === dataDir || out.startsWith(`${dataDir}${path.sep}`))
    throw new CliError(`${TOOL}: --out may not be inside the data copy`);
  const turnsRun = path.resolve(turnsText);
  // Sorted and unique, so turns that start at one moment replay in an order the corpus's line order does not change.
  const turnIds = [...new Set(readCorpus(fs.readFileSync(corpusFile, 'utf8')).map(({ turnId }) => turnId))].sort();
  const counts = await runDbEdge({
    root: ROOT,
    dataDir,
    fromTurn,
    turnIds,
    turnsRun,
    out,
    seed: GRAPH_SEED,
    linesWaitMs: LINES_WAIT_MS,
  });
  process.stderr.write(
    `${TOOL}: db: ${counts.heard} heard lines (${counts.inexact} without a native reference, ` +
      `${counts.unrebuilt} refused ${JSON.stringify(counts.refusals)}, ` +
      `${counts.skippedOwn} of corpus turns), ` +
      `${counts.turns} turns, ${counts.lines} lines (${counts.failedLines} failed), ` +
      `${counts.sessions} session runs, ${counts.sessionRows} with a batch, ${counts.requests} requests ` +
      `(${counts.pastArchive} past the archive)\n`
  );
  return `${counts.tables} tables recorded\n`;
}

/** `cli`: the command line edge over a writable copy. */
async function cliCommand(flags: ReturnType<typeof parseFlags>): Promise<string> {
  const dataText = flagText(flags, '--data');
  const outText = flagText(flags, '--out');
  if (dataText === undefined || outText === undefined) throw new CliError(USAGE);
  const dataDir = path.resolve(dataText);
  const out = path.resolve(outText);
  if (out === dataDir || out.startsWith(`${dataDir}${path.sep}`))
    throw new CliError(`${TOOL}: --out may not be inside the data copy`);
  const counts = await runCliEdge({ root: ROOT, dataDir, out });
  return `${counts.recorded} commands recorded, ${counts.unrecorded} unrecorded\n`;
}

/** `faults`: the long fault plan, its effect table as records. */
async function faultsCommand(flags: ReturnType<typeof parseFlags>): Promise<string> {
  const outText = flagText(flags, '--out');
  if (outText === undefined) throw new CliError(USAGE);
  const report = await faultRun(LONG_PLAN);
  writeFaultRecords(path.resolve(outText), report, FAULT_GAPS);
  return `${report.rows.length} scenarios recorded, ${report.ok ? 'passed' : 'FAILED'}\n`;
}

/** `compare`: two runs, byte for byte. */
function compareCommand(flags: ReturnType<typeof parseFlags>): string {
  const [a, b, ...rest] = flags._.slice(1);
  if (a === undefined || b === undefined || rest.length > 0) throw new CliError(USAGE);
  const result = compareRuns(path.resolve(a), path.resolve(b), flagText(flags, '--edge') ?? null);
  if (!result.identical) throw new CliError(result.text.trimEnd());
  return result.text;
}

function main(argv: Array<string>): Promise<string> {
  const flags = parseFlags(argv, FLAGS);
  switch (flags._[0]) {
    case 'edges':
      return edgesCommand(flags);
    case 'turns':
      return turnsCommand(flags);
    case 'db':
      return dbCommand(flags);
    case 'cli':
      return cliCommand(flags);
    case 'faults':
      return faultsCommand(flags);
    case 'compare':
      return Promise.resolve().then(() => compareCommand(flags));
    default:
      throw new CliError(USAGE);
  }
}

runCli(import.meta.url, main);
