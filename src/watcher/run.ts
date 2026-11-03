// One run of the watcher, `runWatcher`, called by `neptunia watcher run` (bin/neptunia.ts) once a day: the brief
// (src/watcher/brief.ts), one agent run, the checks on its answer (src/watcher/report.ts), the tasks it asked for
// (src/watcher/tasks.ts) and the report file. The agent backend is injected as `runAgent`. A run whose day already has a
// report does nothing. An answer that fails a check files nothing and writes no report; the run leaves `<day>.failed`
// beside the reports with the code and a detail that never quotes the agent. The day is the UTC date of `now()`.

import fs from 'node:fs';
import path from 'node:path';
import { readPromptFile } from '../agent-runner/opencode.ts';
import type { BoardCaller } from '../tools/impl/board.ts';
import { buildBrief } from './brief.ts';
import { checkReport, findSecret, insertFiled, writeReport } from './report.ts';
import type { ReportCode } from './report.ts';
import { FilingError, fileTasks, splitAnswer } from './tasks.ts';
import type { Filed } from './tasks.ts';

export type AgentResult = { ok: boolean; text: string; exitCode: number };
export type RunAgent = (profile: string, brief: string, options: Record<string, unknown>) => Promise<AgentResult>;

export type WatcherRun =
  | { ok: true; day: string; ran: boolean; reportPath: string; filed: Array<Filed> }
  | {
      ok: false;
      day: string;
      code: ReportCode | 'no-prompt' | 'agent-failed' | 'bad-tasks' | 'board-failed';
      detail: string;
      filed: Array<Filed>;
    };

/** The agent profile the watcher runs under (agents/watcher). */
const PROFILE = 'watcher';

type Failure = Exclude<WatcherRun, { ok: true }>;

/** A failed run: the marker file beside the reports, then the result. */
function failed(reportsDir: string, day: string, code: Failure['code'], detail: string): Failure {
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, `${day}.failed`), `${code}\n${detail}\n`);
  return { ok: false, day, code, detail, filed: [] };
}

export async function runWatcher(deps: {
  now: () => number;
  runAgent: RunAgent;
  board: BoardCaller;
  reportsDir: string;
  promptFiles: Array<string>;
}): Promise<WatcherRun> {
  const { reportsDir } = deps;
  const day = new Date(deps.now()).toISOString().slice(0, 10);
  const reportPath = path.join(reportsDir, `${day}.md`);
  if (fs.existsSync(reportPath)) return { ok: true, day, ran: false, reportPath, filed: [] };

  let prompt = '';
  try {
    prompt = readPromptFile(deps.promptFiles);
  } catch {
    // The refusal below names the missing file.
  }
  if (prompt.trim() === '') return failed(reportsDir, day, 'no-prompt', 'prompt.md is missing or empty');

  let answer: Awaited<ReturnType<RunAgent>>;
  try {
    answer = await deps.runAgent(PROFILE, buildBrief({ prompt, day, reportsDir }), { day });
  } catch {
    return failed(reportsDir, day, 'agent-failed', 'the agent run threw');
  }
  if (!answer.ok || answer.exitCode !== 0) {
    return failed(reportsDir, day, 'agent-failed', `the agent ended with exit code ${answer.exitCode}`);
  }

  const secretLine = findSecret(answer.text);
  if (secretLine !== null) return failed(reportsDir, day, 'secret', `a key-looking string on line ${secretLine}`);
  const split = splitAnswer(answer.text);
  if (!split.ok) return failed(reportsDir, day, split.code, split.detail);
  const checked = checkReport(split.report);
  if (!checked.ok) return failed(reportsDir, day, checked.code, checked.detail);

  let filed: Array<Filed> = [];
  let refusal: string | null = null;
  try {
    filed = (await fileTasks({ board: deps.board, drafts: split.tasks, now: deps.now })).filed;
  } catch (error) {
    refusal = error instanceof Error ? error.message : 'the board refused';
    if (error instanceof FilingError) filed = error.filed;
  }

  const written = writeReport(reportsDir, day, insertFiled(split.report, filed));
  if (!written.ok) return { ok: false, day, code: written.code, detail: written.detail, filed };
  fs.rmSync(path.join(reportsDir, `${day}.failed`), { force: true });
  if (refusal !== null) return { ok: false, day, code: 'board-failed', detail: refusal, filed };
  return { ok: true, day, ran: true, reportPath, filed };
}
