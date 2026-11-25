// The stored-turn mode of scripts/replay.ts: one stored turn run again with the engine's own turn code over a copy of a
// data folder, and the cut of such a copy at the moment a turn started. It measures a change of the turn's steps on
// real moments before it ships.
//
// `--cut <turnId> --into <dir>` writes a new folder whose memory is the copy's as it stood when the turn started
// (scripts/lib/turn-cut.ts names the tables and columns it cuts). `--turn <turnId>` (a whole id, or a prefix only one
// turn has) runs the turn again through scripts/lib/turn-run.ts, which scripts/harness.ts shares: the runner composed
// as the core composes it, on a port over the copy's stored lines, every clock pinned to the turn's start. The persona's read
// tools run on the copy. Every other tool and every write to the interface is kept and answered as done. A diary turn
// runs on the home interface as the diary service runs it, and `--kind` pins its post's kind without forcing it. An
// inner turn runs with the parameters the drain passed it, rebuilt from its wake run.
//
// `--data <dir>` names the copy, and everything the mode reads comes from it: the settings and prompts (with
// `--prompts <dir>` laid over its prompts as the other modes lay theirs), the keys and routes, the memory and the
// stored lines. The other modes read the settings of the data folder of the checkout and the chat over the platform,
// so `--snapshot` (a memory alone) has no meaning here and is refused by the parser.
//
// `--answers-dir` answers every model request from files (scripts/lib/answers-dir.ts). `--answers archive` answers the
// k-th request of each purpose with the k-th answer of that purpose the live turn received, and each call of
// `web.search`, `web.read` and `media.look` with the result the live turn read (scripts/lib/turn-archive.ts); a request
// past the archive is answered `<skip/>` and listed under `pastArchive`. Without either the roles run on the copy's
// routing (scripts/lib/script-routes.ts, `--<role> <route>` replacing one). `--embed live` lets the embedding role
// reach its provider, while answers come from files too; its default is `off` then, and `live` otherwise. A run with
// paid calls, model requests or live embeddings, passes the spend gate first. `--seed <text>` makes a run repeat itself byte for byte: a seeded random source, counter
// ids and the turn's start for every time the report keeps.
//
// `--compare` builds the first request only and compares it, part by part, with the row the live turn archived in
// `--oracle <memory.db>`, required with it and opened read only. A diary turn's director request is compared first and
// answered with the live answer. Otherwise each sample's report goes to `<out>/<turnId>/sample-<n>.json`
// (default `out` beside the copy) and a short table to stderr. A stop signal ends the run after the sample in flight.
//
// THE REPORT FILES HOLD THE PERSONA'S WORDS AND MEMORY ABOUT REAL PEOPLE: they are private, like the copy. Nothing they say goes
// to stdout or a log.

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Hot } from '../../src/hot.ts';
import { createLlm } from '../../src/llm/openrouter.ts';
import { createEmbedder } from '../../src/llm/embed.ts';
import { estimateMessages } from '../../src/llm/tokens.ts';
import { roleModel } from '../../src/llm/roles.ts';
import { CliError, REFUSED_EXIT, flagText, parseFlags, spendGate, writePrivate } from './cli.ts';
import { createAnswersDir, offlineCore } from './answers-dir.ts';
import { TURN_REQUESTS, USD_PER_ANSWER, USD_PER_EMBEDDING, replayRouting } from './replay-llm.ts';
import type { PastRequest } from './turn-archive.ts';
import { cutCopy } from './turn-cut.ts';
import { storedTurn } from './turn-stage.ts';
import { archiveOfCopy, hotOf, runStoredTurn } from './turn-run.ts';
import { archivedRequest, compareRequests, foldRepeats, blockOf, partsOf, rowsText } from './turn-compare.ts';
import type { RequestParts } from './turn-compare.ts';
import { STOPPED, reportTable, turnReport } from './turn-report.ts';
import type { KeptRequest } from './turn-report.ts';
import { routedHot } from './script-routes.ts';
import type { Variant } from './script-routes.ts';

const TOOL = 'replay-cli';
const USAGE = [
  'usage: node scripts/replay.ts --data <copy dir> --turn <turnId> [--samples 1] [--out <dir>]',
  '         [--answers-dir <dir> | --answers archive | --spend <usd>] [--compare --oracle <memory.db>]',
  '         [--prompts <dir>] [--embed live|off] [--calibration <ratio>] [--kind <diary kind>] [--seed <text>]',
  '       node scripts/replay.ts --data <copy dir> --cut <turnId> --into <new copy dir>',
].join('\n');

type Embed = (texts: Array<string>, options?: unknown) => Promise<Array<ArrayLike<number> | null>>;
type Flags = ReturnType<typeof parseFlags>;
type RunInput = Parameters<typeof runStoredTurn>[0];
type Result = { code: number; result: Record<string, unknown> };

/** Whether `argv` asks for the stored-turn mode: a `--turn` run or a `--cut`. */
export const isStoredTurnRun = (argv: ReadonlyArray<string>): boolean =>
  argv.includes('--turn') || argv.includes('--cut');

/**
 * The model client and the embedder of the run. With an answers folder or the archive every request is answered
 * without a provider, else the roles run on the copy's routing. The embedder reaches its provider on the copy's
 * embedding key when `live`, and embeds nothing otherwise.
 */
async function clientsOf(
  hot: Hot,
  { root, dataDir }: { root: string; dataDir: string },
  answers: { dir: string | null; archive: boolean; turnId: string },
  live: boolean,
  routes: Variant
) {
  const none: Embed = (texts) => Promise.resolve(texts.map(() => null));
  const spends = (answers.dir === null && !answers.archive) || live;
  const state = { data: {}, markDirty() {} };
  const calibrator = { ratio: 1, apply: (n: number) => n };
  const routing = spends
    ? await replayRouting(createLlm, hot, calibrator, state, { root, privateDir: dataDir, answers: null, routes })
    : null;
  const embedOf = (): Embed => {
    if (!live || routing === null) return none;
    const embedder = createEmbedder({ apiKey: '', keyOf: routing.keyOf, state: { data: {}, markDirty() {} } });
    return (texts, options) => embedder.embed(texts, options);
  };
  const close = (): Promise<void> => (routing === null ? Promise.resolve() : routing.close());
  if (answers.archive) {
    const archive = archiveOfCopy(dataDir, answers.turnId);
    return { llm: archive.llm, past: archive.past, embed: embedOf(), finish: () => {}, close };
  }
  if (answers.dir !== null) {
    const files = createAnswersDir({ dir: answers.dir });
    const offline = offlineCore(files, (purpose) => roleModel(hot.config, 'core', String(purpose ?? '')));
    return { llm: offline, past: null, embed: embedOf(), finish: (code: number) => files.finish(code), close };
  }
  if (routing === null) throw new Error(`${TOOL}: no routing for a run that spends`);
  return { llm: routing.llm, past: null, embed: embedOf(), finish: () => {}, close };
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
  return rowsText(rows);
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
    '--answers',
    '--seed',
    '--spend',
  ],
  switches: ['--compare'],
  usage: USAGE,
};

/** Where a `--turn` run's answers come from and whether the embedder reaches its provider, or the usage error. */
function answerOptions(flags: Flags) {
  const answersDir = flagText(flags, '--answers-dir') ?? null;
  const answers = flagText(flags, '--answers') ?? null;
  if (answers !== null && (answers !== 'archive' || answersDir !== null)) throw new CliError(USAGE);
  const archive = answers === 'archive';
  const embed = flagText(flags, '--embed') ?? (answersDir === null && !archive ? 'live' : 'off');
  if (embed !== 'live' && embed !== 'off') throw new CliError(USAGE);
  return { answersDir, archive, live: embed === 'live' };
}

/** The archived memory database `--compare` reads, required with it: the tool names no installation's path. */
function oracleOf(flags: Flags): string | null {
  const given = flagText(flags, '--oracle');
  if (flags['--compare'] === true && given === undefined)
    throw new CliError(`${TOOL}: --compare needs --oracle <memory.db>`);
  return given === undefined ? null : path.resolve(given);
}

/** What a `--turn` run was asked for, or the usage error. */
function turnOptions(flags: Flags, dataDir: string) {
  const turnId = flagText(flags, '--turn');
  if (turnId === undefined) throw new CliError(USAGE);
  const { answersDir, archive, live } = answerOptions(flags);
  const samples = Number(flagText(flags, '--samples') ?? '1');
  if (!Number.isInteger(samples) || samples < 1) throw new CliError(USAGE);
  // The archive answers one live turn once: a second sample would find every answer taken.
  if (archive && samples > 1) throw new CliError(`${TOOL}: --answers archive answers one sample`);
  const outDir = path.resolve(flagText(flags, '--out') ?? path.join(path.dirname(dataDir), 'out'));
  if (outDir === dataDir || outDir.startsWith(`${dataDir}${path.sep}`))
    throw new CliError(`${TOOL}: --out may not be inside the data copy`);
  const ratioText = flagText(flags, '--calibration');
  const calibration = ratioText === undefined ? null : Number(ratioText);
  if (calibration !== null && !(calibration >= 0.6 && calibration <= 1.6)) throw new CliError(USAGE);
  return {
    turnId,
    answersDir,
    archive,
    seed: flagText(flags, '--seed') ?? null,
    live,
    samples,
    outDir,
    calibration,
    compare: flags['--compare'] === true,
    oracle: oracleOf(flags),
    prompts: flagText(flags, '--prompts') ?? null,
    kind: flagText(flags, '--kind') ?? null,
    spend: flagText(flags, '--spend'),
  };
}

/**
 * The spend gate of the run's paid calls: up to an answer and four tool-loop steps per sample, one request for
 * `--compare`, each a model request unless the answers come from files or the archive, and each an embedding request
 * too with `--embed live`. A run with no paid call passes, whatever `--spend` says.
 */
function gateOf(asked: ReturnType<typeof turnOptions>): void {
  const steps = asked.compare ? 1 : TURN_REQUESTS * asked.samples;
  const answers = asked.answersDir !== null || asked.archive ? 0 : steps;
  const embeddings = asked.live ? steps : 0;
  const gate = spendGate({
    estimateUsd: answers * USD_PER_ANSWER + embeddings * USD_PER_EMBEDDING,
    requests: answers + embeddings,
    spend: asked.spend,
    detail: `${answers} model request(s) at ~${USD_PER_ANSWER} USD and ${embeddings} embedding request(s) at ~${USD_PER_EMBEDDING} USD, up to five steps per sample`,
  });
  if (!gate.ok) throw new CliError(`${TOOL}: ${gate.text}`, { exitCode: REFUSED_EXIT });
  process.stderr.write(`${TOOL}: ${gate.text}\n`);
}

/**
 * The first request of the turn built again and compared with the archived one. A diary turn's director request is
 * compared first and answered with the live answer, so the turn's first request is built on the live scene.
 */
async function compareRun(input: RunInput, outDir: string, oracle: string): Promise<Result> {
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
  const run = await runStoredTurn({ ...input, llm, stopAt: 'reply' });
  const { turnId } = run.turn;
  const first: KeptRequest | undefined = run.requests.find((request) => request.purpose === 'reply');
  const directed = run.requests.find((request) => request.purpose === 'diary-scene');
  // The rebuilt requests beside the reports, private as they are, for a reader who must see the difference.
  const file = path.join(outDir, turnId, 'first-request.json');
  writePrivate(file, {
    ...(directed === undefined ? {} : { director: { messages: directed.messages } }),
    messages: first?.messages ?? null,
    tools: first?.tools ?? null,
    memoryReads: run.carried,
  });
  const compare: Record<string, string> = {};
  if (director !== null) {
    if (directed === undefined) throw new CliError(`${TOOL}: the turn ended before its director request`);
    compare['diary-scene'] = compareText(partsOf(directed.messages, directed.tools), director.parts);
  }
  if (first === undefined)
    throw new CliError(`${TOOL}: the turn ended ${String(run.result.outcome)} before its first request`);
  compare.reply = compareText(partsOf(first.messages, first.tools), archivedOf(oracle, turnId, 'reply').parts);
  return { code: 0, result: { turnId, request: file, compare } };
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

/** The turn run whole `samples` times, one private report file each, until the signal stops the next one. */
async function sampleRuns(
  input: RunInput,
  run: { outDir: string; samples: number; past: ReadonlyArray<PastRequest> | null; signal?: AbortSignal }
): Promise<Result> {
  const written: Array<string> = [];
  let turnId = input.turnId;
  for (let sample = 1; sample <= run.samples; sample += 1) {
    if (run.signal?.aborted) break;
    const done = await runStoredTurn(input);
    turnId = done.turn.turnId;
    const report = turnReport({
      turnId,
      sample,
      requests: done.requests,
      writes: done.writes,
      keptCalls: done.calls,
      result: done.result,
      journal: done.journal,
      estimate: (messages) => estimateMessages(messages),
    });
    const file = path.join(run.outDir, turnId, `sample-${sample}.json`);
    const pastArchive = run.past === null ? {} : { pastArchive: [...run.past] };
    const held = done.held === null ? {} : { held: done.held };
    writePrivate(file, { ...report, ...pastArchive, ...held, requests: done.requests });
    process.stderr.write(`${reportTable(report)}\n`);
    written.push(file);
  }
  const cut = written.length < run.samples ? { cut: { asked: run.samples, finished: written.length } } : {};
  return { code: written.length < run.samples ? 1 : 0, result: { turnId, reports: written, ...cut } };
}

/** The `--cut` run: a new copy of the data folder cut at the turn's start. */
function cutRun(flags: Flags, dataDir: string, cut: string): Result {
  const into = flagText(flags, '--into');
  if (into === undefined) throw new CliError(USAGE);
  const done = cutCopy({ from: dataDir, into: path.resolve(into), turnId: cut });
  return {
    code: 0,
    result: { cut: { at: new Date(done.at).toISOString(), into: path.resolve(into), counts: done.counts } },
  };
}

/**
 * The stored-turn mode of the command: `argv` without the role flags, `variants` what they asked for. One setup only:
 * the turn's samples already repeat it.
 */
export async function storedTurnMain(
  argv: Array<string>,
  variants: ReadonlyArray<{ routes: Variant }>,
  { root, signal }: { root: string; signal?: AbortSignal }
): Promise<Result> {
  if (variants.length !== 1)
    throw new CliError(`${TOOL}: --variant: variant-unsupported: a stored turn runs one setup`);
  const flags = parseFlags(argv, FLAGS);
  const dataText = flagText(flags, '--data');
  if (dataText === undefined) throw new CliError(USAGE);
  const dataDir = path.resolve(dataText);
  const cut = flagText(flags, '--cut');
  if (cut !== undefined) return cutRun(flags, dataDir, cut);
  const asked = turnOptions(flags, dataDir);
  gateOf(asked);
  const { routes } = variants[0];
  const opened = hotOf(root, dataDir, asked.prompts);
  const hot = routedHot(opened.hot, routes);
  const client = await clientsOf(
    hot,
    { root, dataDir },
    { dir: asked.answersDir, archive: asked.archive, turnId: asked.turnId },
    asked.live,
    routes
  );
  const input: RunInput = {
    root,
    tool: TOOL,
    dataDir,
    turnId: asked.turnId,
    hot,
    llm: client.llm,
    embed: client.embed,
    stopAt: null,
    calibration: asked.calibration,
    kind: asked.kind,
    seed: asked.seed,
    archive: asked.archive,
  };
  try {
    const out = asked.compare
      ? await compareRun(input, asked.outDir, asked.oracle!)
      : await sampleRuns(input, { outDir: asked.outDir, samples: asked.samples, past: client.past, signal });
    client.finish(out.code);
    return out;
  } catch (error) {
    if (error instanceof Error && error.message === STOPPED) throw new CliError(STOPPED);
    client.finish(1);
    throw error;
  } finally {
    await client.close();
    opened.close();
  }
}
