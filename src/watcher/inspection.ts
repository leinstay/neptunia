// One inspection under one durable run (src/watcher/lifecycle.ts), started by `neptunia worker watcher`: the claim, the
// brief (src/watcher/brief.ts), one agent run that gets the abort signal and the timeout, the checks on its answer
// (src/watcher/report.ts, tasks.ts), the risk rules over the earlier reports (src/watcher/risk.ts), the rows the engine
// stamps, the receipts and the board (src/watcher/filing.ts) and the commit of the report. A
// cancel reaches the agent and a waiting board call through the signal and is looked at between the phases, up to the commit: from the commit on the
// run has its report and ends as succeeded. The board is opened only when something is to be filed, and a board that cannot
// be reached or stops answering leaves a report with the filing deferred. An answer that fails its template, coverage, tasks
// or secret check earns one more attempt on the same run, inside the run's timeout, with the refusal and the answer in its
// brief. A refused answer stays only in `refused/<run id>-<attempt>.md`, mode 600, with what looks like a key masked there and
// in that brief. Nothing the agent wrote reaches a run record. No second refusal, exit code, timeout or failure of the
// engine's own check after stamping earns an attempt.

import fs from 'node:fs';
import path from 'node:path';
import { readPromptFile } from '../agent-runner/opencode.ts';
import { log } from '../log.ts';
import type { BoardCaller } from '../tools/impl/board.ts';
import { buildBrief } from './brief.ts';
import {
  cancelFilings,
  deferFilings,
  filingLines,
  hasLinkedFilings,
  hasUnsettledFilings,
  readFilings,
  resolvedFindings,
  retryFilings,
  saveDrafts,
} from './filing.ts';
import type { InstallFacts } from './install.ts';
import { claimRun, finishRun, lastRuns, noteAttempt, readRun } from './lifecycle.ts';
import type { ProcessIdentity, RunRecord, RunSource, RunState, RunStore } from './lifecycle.ts';
import { readReportRun, reportVersions } from './read.ts';
import {
  checkCoverage,
  checkTemplate,
  commitReport,
  findSecret,
  insertFilingLines,
  insertUnavailable,
  maskCredentials,
  stampCoverage,
  stampMetadata,
} from './report.ts';
import { observationInterval } from './requests.ts';
import { applyRiskRules, findingsOf, markFindings, openCounts } from './risk.ts';
import type { RiskHistoryEntry, RiskResult } from './risk.ts';
import { splitAnswer } from './tasks.ts';
import type { SplitAnswer } from './tasks.ts';

export type InspectionPhase = 'generating' | 'validating' | 'filing' | 'committing' | 'committed';
export type FilingOutcome = 'none' | 'filed' | 'deferred' | 'failed';

/** What an agent run gives back; a backend's result is one. */
export type InspectionAgentResult = {
  ok: boolean;
  text: string;
  exitCode: number | null;
  error?: string;
  /** What the run knows it could not record: the report names each under `Service runs`. */
  gaps?: ReadonlyArray<string>;
};

export type InspectionDeps = {
  store: RunStore;
  reportsDir: string;
  self: ProcessIdentity;
  source: RunSource;
  timeoutMs: number;
  promptFiles: ReadonlyArray<string>;
  /** The prompt of the second attempt; with none, a refused answer ends the run. */
  retryPromptFiles?: ReadonlyArray<string>;
  selected: { backend: string | null; model: string | null; effort: string | null };
  runAgent(
    brief: string,
    options: { signal: AbortSignal; timeoutMs: number; runId: string }
  ): Promise<InspectionAgentResult>;
  openBoard(): Promise<BoardCaller>;
  /** The facts of the running install for the brief; absent, the brief holds none. */
  install?: () => InstallFacts;
  onPhase?: (phase: InspectionPhase, runId: string) => void;
  /** How often the run's record is read for a cancel (ms). */
  cancelPollMs?: number;
  /** How long opening the board or one call to it may take before the filing is deferred (ms). */
  boardTimeoutMs?: number;
};

export type InspectionResult = {
  runId: string;
  state: RunState;
  /** Whether this call did the work, or found another run in progress. */
  started: boolean;
  day: string;
  reportPath: string | null;
  filing: FilingOutcome;
  code?: string;
};

const DEFAULT_CANCEL_POLL_MS = 1000;
const DEFAULT_BOARD_TIMEOUT_MS = 30_000;
/** A task files only from a finding line at one of these levels, as the rules left it. */
const FILED_LEVELS: ReadonlyArray<string> = ['critical', 'high', 'medium'];

/** The folder of the refused answers, inside the reports folder. */
const REFUSED_DIR = 'refused';

/** A run that ends before its report, carrying how. */
class RunEnd extends Error {
  readonly state: 'failed' | 'cancelled';
  readonly code: string | undefined;
  readonly detail: string | undefined;
  constructor(state: 'failed' | 'cancelled', code?: string, detail?: string) {
    super(code ?? state);
    this.state = state;
    this.code = code;
    this.detail = detail;
  }
}

/** Watches the run's record: the signal aborts when it says `stopping`, however the cancel came. */
function watchRun(deps: InspectionDeps, runId: string) {
  const controller = new AbortController();
  const look = (): string | undefined => {
    const state = readRun(deps.store, runId)?.state;
    if (state === 'stopping') controller.abort();
    return state;
  };
  const timer = setInterval(look, deps.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS);
  timer.unref();
  return {
    signal: controller.signal,
    close: () => clearInterval(timer),
    /** Throws at a point where the run may end: a cancel, or a run a later reader has already recovered. */
    check(): void {
      const state = look();
      if (state === 'stopping') throw new RunEnd('cancelled');
      if (state !== 'running') throw new RunEnd('failed', 'holder-gone', 'the run was recovered while it worked');
    },
    asked: (): boolean => look() === 'stopping',
  };
}

type Watch = ReturnType<typeof watchRun>;
type Observation = { from: number; to: number; dayFrom: number };
type BoardOpener = () => Promise<BoardCaller>;

/** The first brief, or the end of the run. */
function firstBrief(deps: InspectionDeps, run: RunRecord, observation: Observation): string {
  let prompt = '';
  try {
    prompt = readPromptFile([...deps.promptFiles]);
  } catch {
    // The refusal below names the missing file.
  }
  if (prompt.trim() === '') throw new RunEnd('failed', 'no-prompt', 'prompt.md is missing or empty');
  return buildBrief({
    prompt,
    day: run.day,
    reportsDir: deps.reportsDir,
    observation,
    ...(deps.install === undefined ? {} : { install: deps.install() }),
  });
}

/** The agent's answer, or the end of the run. A cancel wins over whatever the agent came back with. */
async function generate(
  deps: InspectionDeps,
  run: RunRecord,
  watch: Watch,
  ask: { brief: string; timeoutMs: number; attempt: number }
): Promise<InspectionAgentResult> {
  noteAttempt(deps.store, run.runId, ask.attempt);
  let answer: InspectionAgentResult;
  try {
    answer = await deps.runAgent(ask.brief, { signal: watch.signal, timeoutMs: ask.timeoutMs, runId: run.runId });
  } catch {
    watch.check();
    throw new RunEnd('failed', 'agent-failed', 'the agent run threw');
  }
  watch.check();
  if (answer.error === 'cancelled') throw new RunEnd('cancelled');
  if (answer.error === 'timeout') throw new RunEnd('failed', 'timeout', `the agent ran past ${ask.timeoutMs} ms`);
  if (!answer.ok || answer.exitCode !== 0) {
    const how = answer.error ?? `exit code ${String(answer.exitCode)}`;
    throw new RunEnd('failed', 'agent-failed', `the agent ended with ${how}`);
  }
  return answer;
}

/** Keeps a refused answer where only this account reads it, masked, for the owner to see why a day failed. */
function keepRefused(deps: InspectionDeps, runId: string, attempt: number, masked: string): void {
  const dir = path.join(deps.reportsDir, REFUSED_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${runId}-${attempt}.md`), masked, { mode: 0o600 });
}

/** The brief of the second attempt, or null with no retry prompt to read. */
function retryBrief(deps: InspectionDeps, first: string, refusal: RunEnd, masked: string): string | null {
  if (deps.retryPromptFiles === undefined) return null;
  let prompt: string;
  try {
    prompt = readPromptFile([...deps.retryPromptFiles]).trim();
  } catch {
    return null;
  }
  if (prompt === '') return null;
  const refused = `<refusal code="${refusal.code ?? ''}">${refusal.detail ?? ''}</refusal>`;
  return `${first.trim()}\n\n${prompt}\n\n${refused}\n\n<previous-answer>\n${masked}\n</previous-answer>\n`;
}

/** The report and drafts of an answer, or the end of the run. Refusals never quote the agent. */
function validate(text: string): Extract<SplitAnswer, { ok: true }> {
  const secretLine = findSecret(text);
  if (secretLine !== null) throw new RunEnd('failed', 'secret', `a key-looking string on line ${secretLine}`);
  const split = splitAnswer(text);
  if (!split.ok) throw new RunEnd('failed', split.code, split.detail);
  const checked = checkTemplate(split.report);
  if (!checked.ok) throw new RunEnd('failed', checked.code, checked.detail);
  const covered = checkCoverage(split.report);
  if (!covered.ok) throw new RunEnd('failed', covered.code, covered.detail);
  return split;
}

/** The earlier successful reports as the risk rules read them, oldest first, with each resolution at its moment. */
function riskHistory(
  reportsDir: string,
  resolved: ReadonlyArray<{ key: string; at: number }>
): Array<RiskHistoryEntry> {
  const reports = reportVersions(reportsDir).flatMap(({ runId, day, at }) => {
    const read = readReportRun(reportsDir, runId);
    const entry: RiskHistoryEntry = { day, findings: read.ok ? findingsOf(read.report.text) : [] };
    return [{ at, entry }];
  });
  const closed = resolved.map(({ key, at }) => {
    const entry: RiskHistoryEntry = { day: new Date(at).toISOString().slice(0, 10), findings: [], resolved: [key] };
    return { at, entry };
  });
  return [...reports, ...closed].sort((a, b) => a.at - b.at).map((one) => one.entry);
}

/**
 * The rules over `report`. Only a repeat can change with a resolution, so the board is asked only when something repeats and
 * a receipt names a task. A board that does not answer leaves no resolutions, and a repeat stays a repeat.
 */
async function rateFindings(
  deps: InspectionDeps,
  report: string,
  open: BoardOpener,
  watch: Watch
): Promise<RiskResult> {
  const findings = findingsOf(report);
  const rated = applyRiskRules(findings, riskHistory(deps.reportsDir, []));
  const dir = deps.store.dir;
  if (rated.repeats === 0 || !hasLinkedFilings(dir)) return rated;
  const ms = deps.boardTimeoutMs ?? DEFAULT_BOARD_TIMEOUT_MS;
  try {
    const board = await bounded(open, ms, watch.signal);
    const resolved = await bounded(() => resolvedFindings(dir, board), ms, watch.signal);
    return applyRiskRules(findings, riskHistory(deps.reportsDir, resolved));
  } catch {
    return rated;
  }
}

/** The report as the rules and the engine's facts leave it: the finding lines, then the stamped rows. */
function stamped(
  deps: InspectionDeps,
  runId: string,
  report: string,
  rated: RiskResult,
  observation: Observation
): string {
  const { model, effort } = deps.selected;
  const open = openCounts(rated.findings);
  const backend = deps.selected.backend ?? 'unknown';
  const from = new Date(observation.from).toISOString();
  const to = new Date(observation.to).toISOString();
  const marked = stampCoverage(markFindings(report, rated.findings), { from, to }, backend);
  return stampMetadata(marked, {
    'Observation interval': `${from} to ${to}`,
    'Run id': runId,
    'Selected backend': backend,
    Model: model ?? 'default',
    Effort: effort ?? 'default',
    Risk: rated.risk,
    'New findings': `${rated.newFindings}, repeats: ${rated.repeats}`,
    'Open findings': `critical ${open.critical}, high ${open.high}, medium ${open.medium}, low ${open.low}`,
  });
}

/** `work`, rejected when `ms` pass or the signal aborts. What it does later is dropped, and the receipts reconcile it. */
function bounded<T>(work: () => T | PromiseLike<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const end = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', give);
    };
    const give = (): void => {
      end();
      reject(new Error('the board gave no answer'));
    };
    const timer = setTimeout(give, ms);
    signal.addEventListener('abort', give);
    if (signal.aborted) give();
    Promise.resolve().then(work).then(resolve, reject).finally(end);
  });
}

/** Files what this run and earlier ones left to file. A board that cannot be reached or does not answer defers it. */
async function file(deps: InspectionDeps, runId: string, open: BoardOpener, watch: Watch): Promise<void> {
  const dir = deps.store.dir;
  if (!hasUnsettledFilings(dir)) return;
  const ms = deps.boardTimeoutMs ?? DEFAULT_BOARD_TIMEOUT_MS;
  let opened: BoardCaller;
  try {
    opened = await bounded(open, ms, watch.signal);
  } catch {
    deferFilings(dir, runId);
    return;
  }
  const board: BoardCaller = {
    call: (principal, op, args, idempotency) =>
      bounded(() => opened.call(principal, op, args, idempotency), ms, watch.signal),
  };
  await retryFilings({ dir, board, now: () => deps.store.now(), stop: watch.asked });
  deferFilings(dir, runId);
}

function filingOutcome(dir: string, runId: string): FilingOutcome {
  const states = readFilings(dir, runId)
    .map((one) => one.state)
    .filter((state) => state !== 'unmatched-draft');
  if (states.includes('failed')) return 'failed';
  if (states.includes('deferred')) return 'deferred';
  return states.length === 0 ? 'none' : 'filed';
}

type PassedAnswer = { answer: InspectionAgentResult; split: Extract<SplitAnswer, { ok: true }> };

/**
 * An answer that passed its checks: the first, or after one refusal the second. A second attempt reads the first brief whole
 * and gets what is left of the run's timeout. With no time or no prompt left, the first refusal ends the run.
 */
async function passedAnswer(
  deps: InspectionDeps,
  run: RunRecord,
  watch: Watch,
  observation: Observation,
  phase: (name: InspectionPhase) => void
): Promise<PassedAnswer> {
  const first = firstBrief(deps, run, observation);
  const startedAt = deps.store.now();
  const attempt = async (
    brief: string,
    timeoutMs: number,
    number: number
  ): Promise<PassedAnswer | { refusal: RunEnd; masked: string }> => {
    phase('generating');
    const answer = await generate(deps, run, watch, { brief, timeoutMs, attempt: number });
    phase('validating');
    try {
      return { answer, split: validate(answer.text) };
    } catch (error) {
      if (!(error instanceof RunEnd)) throw error;
      const { text: masked } = maskCredentials(answer.text);
      keepRefused(deps, run.runId, number, masked);
      return { refusal: error, masked };
    }
  };
  const one = await attempt(first, deps.timeoutMs, 1);
  if ('split' in one) return one;
  const left = deps.timeoutMs - (deps.store.now() - startedAt);
  if (left <= 0) throw new RunEnd('failed', 'timeout', `the run has used its ${deps.timeoutMs} ms`);
  const brief = retryBrief(deps, first, one.refusal, one.masked);
  if (brief === null) throw one.refusal;
  const two = await attempt(brief, left, 2);
  if ('split' in two) return two;
  throw two.refusal;
}

/** The work of a claimed run up to its committed report; anything short of that throws `RunEnd`. */
async function inspect(deps: InspectionDeps, run: RunRecord, watch: Watch): Promise<string> {
  const { runId, day } = run;
  const dir = deps.store.dir;
  const phase = (name: InspectionPhase): void => {
    deps.onPhase?.(name, runId);
    if (name !== 'committed') watch.check();
  };
  const observation = observationInterval({
    now: deps.store.now(),
    previousSuccessAt: lastRuns(deps.store).lastSuccess?.finishedAt ?? null,
  });
  // One link per run, however many phases ask for it; a link that failed stays failed for the run.
  let opening: Promise<BoardCaller> | null = null;
  const open: BoardOpener = () => (opening ??= deps.openBoard());
  const { answer, split } = await passedAnswer(deps, run, watch, observation, phase);
  const { report, tasks } = split;
  const rated = await rateFindings(deps, report, open, watch);
  watch.check();
  const repeated = new Set(rated.findings.flatMap((one) => (one.repeat === null ? [] : [one.key])));
  const fileable = new Set(rated.findings.flatMap((one) => (FILED_LEVELS.includes(one.level) ? [one.key] : [])));
  saveDrafts(dir, runId, deps.store.now(), tasks, { repeated, fileable });
  phase('filing');
  await file(deps, runId, open, watch);
  phase('committing');
  const text = insertUnavailable(
    insertFilingLines(stamped(deps, runId, report, rated, observation), filingLines(readFilings(dir, runId))),
    'Service runs',
    (answer.gaps ?? []).map((gap) => `- ${gap}`)
  );
  const final = checkTemplate(text);
  if (!final.ok) throw new RunEnd('failed', final.code, final.detail);
  const committed = commitReport({ reportsDir: deps.reportsDir, day, runId, at: deps.store.now(), text });
  if (!committed.ok) throw new RunEnd('failed', committed.code, committed.detail);
  phase('committed');
  return committed.path ?? path.join(deps.reportsDir, `${day}.md`);
}

/** How a thrown end, or anything unexpected such as a full disk, finishes the run. Never carries the agent's text. */
function endOf(error: unknown): RunEnd {
  if (error instanceof RunEnd) return error;
  const code = (error as NodeJS.ErrnoException).code;
  return new RunEnd('failed', 'internal', typeof code === 'string' ? code : 'an unexpected error');
}

/**
 * Runs one inspection, or answers the run already in progress with `started: false`. It resolves whatever happens; the
 * state says how it ended.
 */
export async function runInspection(deps: InspectionDeps): Promise<InspectionResult> {
  const { claimed, run } = claimRun(deps.store, { source: deps.source, owner: deps.self, timeoutMs: deps.timeoutMs });
  const { runId, day } = run;
  if (!claimed) return { runId, state: run.state, started: false, day, reportPath: null, filing: 'none' };
  log.info('watcher: inspection', { runId, source: run.source, ...deps.selected });
  const watch = watchRun(deps, runId);
  const dir = deps.store.dir;
  try {
    const reportPath = await inspect(deps, run, watch);
    const done = finishRun(deps.store, runId, { state: 'succeeded' });
    const filing = filingOutcome(dir, runId);
    log.info('watcher: inspection committed', { runId, filing });
    return { runId, state: done?.state ?? 'succeeded', started: true, day, reportPath, filing };
  } catch (error) {
    const end = endOf(error);
    if (end.state === 'cancelled') cancelFilings(dir, runId);
    const done = finishRun(deps.store, runId, {
      state: end.state,
      ...(end.code === undefined ? {} : { code: end.code }),
      ...(end.detail === undefined ? {} : { detail: end.detail }),
    });
    log.info('watcher: inspection ended', { runId, state: done?.state ?? end.state, code: end.code ?? null });
    return {
      runId,
      state: done?.state ?? end.state,
      started: true,
      day,
      reportPath: null,
      filing: 'none',
      ...(end.code === undefined ? {} : { code: end.code }),
    };
  } finally {
    watch.close();
  }
}
