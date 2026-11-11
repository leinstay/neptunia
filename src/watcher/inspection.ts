// One inspection under one durable run (src/watcher/lifecycle.ts), started by `neptunia worker watcher`: the claim, the
// brief (src/watcher/brief.ts), one agent run that gets the abort signal and the timeout, the checks on its answer
// (src/watcher/report.ts), the risk rules over the earlier reports (src/watcher/risk.ts), the rows the engine stamps and
// the commit of the report. The run files nothing: the report is for the owner. A cancel reaches the agent through the
// signal and is looked at between the phases, up to the commit: from the commit on the run has its report and ends as
// succeeded. An answer that fails its template, coverage or secret check earns one more attempt on the same run, inside the run's timeout, with the refusal and the answer in its
// brief. A refused answer stays only in `refused/<run id>-<attempt>.md`, mode 600, with what looks like a key masked there and
// in that brief. Nothing the agent wrote reaches a run record. No second refusal, exit code, timeout or failure of the
// engine's own check after stamping earns an attempt.

import fs from 'node:fs';
import path from 'node:path';
import { readPromptFile } from '../agent-runner/opencode.ts';
import { log } from '../log.ts';
import { buildBrief } from './brief.ts';
import type { InstallFacts } from './install.ts';
import type { MoneyFacts } from './money.ts';
import { claimRun, finishRun, lastRuns, noteAttempt, readRun } from './lifecycle.ts';
import type { ProcessIdentity, RunRecord, RunSource, RunState, RunStore } from './lifecycle.ts';
import { readReportRun, reportVersions } from './read.ts';
import {
  checkCoverage,
  checkTemplate,
  commitReport,
  findSecret,
  insertUnavailable,
  maskCredentials,
  stampCoverage,
  stampMetadata,
} from './report.ts';
import { observationInterval } from './requests.ts';
import { applyRiskRules, findingsOf, markFindings, openCounts } from './risk.ts';
import type { RiskHistoryEntry, RiskResult } from './risk.ts';

export type InspectionPhase = 'generating' | 'validating' | 'committing' | 'committed';

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
  /** The facts of the running install for the brief; absent, the brief holds none. */
  install?: () => InstallFacts;
  /** Stored facts that bear on failing work for the brief; absent, the brief holds none. */
  memory?: () => Promise<ReadonlyArray<string>>;
  /** The spend, balances and limits for the brief, read before the agent starts; absent or failed, the brief holds none. */
  money?: () => Promise<MoneyFacts>;
  /** The owner's accepted findings (src/watcher/accepted.ts), read once at the start of the run; absent, none. */
  accepted?: () => ReadonlyArray<string>;
  onPhase?: (phase: InspectionPhase, runId: string) => void;
  /** How often the run's record is read for a cancel (ms). */
  cancelPollMs?: number;
};

export type InspectionResult = {
  runId: string;
  state: RunState;
  /** Whether this call did the work, or found another run in progress. */
  started: boolean;
  day: string;
  reportPath: string | null;
  code?: string;
};

const DEFAULT_CANCEL_POLL_MS = 1000;

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
  };
}

type Watch = ReturnType<typeof watchRun>;
type Observation = { from: number; to: number; dayFrom: number };

/** The money fact for the brief, or none when it is not wired or its read failed; the prompt then calls it unavailable. */
async function moneyOf(deps: InspectionDeps): Promise<MoneyFacts | undefined> {
  if (deps.money === undefined) return undefined;
  try {
    return await deps.money();
  } catch {
    log.info('watcher: money facts unavailable');
    return undefined;
  }
}

/** The first brief, or the end of the run. */
async function firstBrief(
  deps: InspectionDeps,
  run: RunRecord,
  observation: Observation,
  accepted: ReadonlyArray<string>
): Promise<string> {
  let prompt = '';
  try {
    prompt = readPromptFile([...deps.promptFiles]);
  } catch {
    // The refusal below names the missing file.
  }
  if (prompt.trim() === '') throw new RunEnd('failed', 'no-prompt', 'prompt.md is missing or empty');
  const money = await moneyOf(deps);
  return buildBrief({
    prompt,
    day: run.day,
    reportsDir: deps.reportsDir,
    observation,
    ...(deps.install === undefined ? {} : { install: deps.install() }),
    ...(money === undefined ? {} : { money }),
    ...(deps.memory === undefined ? {} : { memory: await deps.memory() }),
    accepted,
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

/** The report of an answer, or the end of the run. Refusals never quote the agent. */
function validate(text: string, acceptedCount: number): string {
  const secretLine = findSecret(text);
  if (secretLine !== null) throw new RunEnd('failed', 'secret', `a key-looking string on line ${secretLine}`);
  const checked = checkTemplate(text);
  if (!checked.ok) throw new RunEnd('failed', checked.code, checked.detail);
  const covered = checkCoverage(text, acceptedCount);
  if (!covered.ok) throw new RunEnd('failed', covered.code, covered.detail);
  return text;
}

/** The earlier successful reports as the risk rules read them, oldest first. */
function riskHistory(reportsDir: string): Array<RiskHistoryEntry> {
  return reportVersions(reportsDir).map(({ runId, day }) => {
    const read = readReportRun(reportsDir, runId);
    return { day, findings: read.ok ? findingsOf(read.report.text) : [] };
  });
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

type PassedAnswer = { answer: InspectionAgentResult; report: string };

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
  const accepted = deps.accepted?.() ?? [];
  const first = await firstBrief(deps, run, observation, accepted);
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
      return { answer, report: validate(answer.text, accepted.length) };
    } catch (error) {
      if (!(error instanceof RunEnd)) throw error;
      const { text: masked } = maskCredentials(answer.text);
      keepRefused(deps, run.runId, number, masked);
      return { refusal: error, masked };
    }
  };
  const one = await attempt(first, deps.timeoutMs, 1);
  if ('report' in one) return one;
  const left = deps.timeoutMs - (deps.store.now() - startedAt);
  if (left <= 0) throw new RunEnd('failed', 'timeout', `the run has used its ${deps.timeoutMs} ms`);
  const brief = retryBrief(deps, first, one.refusal, one.masked);
  if (brief === null) throw one.refusal;
  const two = await attempt(brief, left, 2);
  if ('report' in two) return two;
  throw two.refusal;
}

/** The work of a claimed run up to its committed report; anything short of that throws `RunEnd`. */
async function inspect(deps: InspectionDeps, run: RunRecord, watch: Watch): Promise<string> {
  const { runId, day } = run;
  const phase = (name: InspectionPhase): void => {
    deps.onPhase?.(name, runId);
    if (name !== 'committed') watch.check();
  };
  const observation = observationInterval({
    now: deps.store.now(),
    previousSuccessAt: lastRuns(deps.store).lastSuccess?.finishedAt ?? null,
  });
  const { answer, report } = await passedAnswer(deps, run, watch, observation, phase);
  const rated = applyRiskRules(findingsOf(report), riskHistory(deps.reportsDir));
  phase('committing');
  const text = insertUnavailable(
    stamped(deps, runId, report, rated, observation),
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
  if (!claimed) return { runId, state: run.state, started: false, day, reportPath: null };
  log.info('watcher: inspection', { runId, source: run.source, ...deps.selected });
  const watch = watchRun(deps, runId);
  try {
    const reportPath = await inspect(deps, run, watch);
    const done = finishRun(deps.store, runId, { state: 'succeeded' });
    log.info('watcher: inspection committed', { runId });
    return { runId, state: done?.state ?? 'succeeded', started: true, day, reportPath };
  } catch (error) {
    const end = endOf(error);
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
      ...(end.code === undefined ? {} : { code: end.code }),
    };
  } finally {
    watch.close();
  }
}
