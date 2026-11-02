// Fakes for the watcher tests: a runAgent that answers a canned text and records what it was asked, a board that keeps
// the tasks `task.add` files and answers `task.list`, a temp watcher folder (prompt.md and reports/), and builders for
// a report that holds the seven headings. Synthetic data only; no provider, no database, no socket.
import fs from 'node:fs';
import path from 'node:path';
import type { BoardCaller } from '../../src/tools/impl/board.ts';
import type { BoardOp, BoardResults, TaskRecord } from '../../src/board/board.ts';
import type { AgentResult, RunAgent } from '../../src/watcher/run.ts';
import { tempDir } from './tmp.ts';

/** The headings of a report, in order (src/watcher/report.ts#REPORT_HEADINGS). */
export const HEADINGS: ReadonlyArray<string> = [
  'Her day',
  'Misunderstandings',
  'Memory',
  'The project',
  'The server',
  'Tasks filed',
  'For the owner',
];

/** A report with every heading, each holding `bodies[heading]` or the line "nothing found". */
export function reportText(bodies: Readonly<Record<string, string>> = {}): string {
  return (
    HEADINGS.map((heading) => `## ${heading}\n\n${bodies[heading] ?? 'nothing found'}\n`).join('\n')
  );
}

/** A `tasks` block as the agent ends its answer with. */
export function tasksBlock(drafts: ReadonlyArray<Record<string, unknown>>): string {
  return '```tasks\n' + JSON.stringify(drafts, null, 2) + '\n```\n';
}

/** A key shaped like an OpenRouter key, built in pieces so no scanner sees one in the source. */
export const PLANTED_KEY = ['sk', 'or', 'v1', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'].join('-');

export type WatcherDirs = { root: string; watcherDir: string; reportsDir: string };

/** `.agents/watcher/` in a temp folder, with `prompt.md` written and an empty `reports/`. */
export function watcherDirs(prompt = 'PROMPT-SENTINEL: the three questions.'): WatcherDirs {
  const root = tempDir('nep-watcher-');
  const watcherDir = path.join(root, '.agents', 'watcher');
  const reportsDir = path.join(watcherDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(watcherDir, 'prompt.md'), prompt);
  return { root, watcherDir, reportsDir };
}

/** Writes `<day>.md` into the reports folder. */
export function putReport(dirs: WatcherDirs, day: string, text: string): void {
  fs.writeFileSync(path.join(dirs.reportsDir, `${day}.md`), text);
}

export type AgentCall = { profile: unknown; brief: string; options: unknown };

/** A runAgent that answers `answer` (a result, or a function of the call) and records every call. */
export function fakeAgent(answer: AgentResult | ((call: AgentCall) => AgentResult)): { run: RunAgent; calls: Array<AgentCall> } {
  const calls: Array<AgentCall> = [];
  const run: RunAgent = (profile, brief, options) => {
    const call = { profile, brief, options };
    calls.push(call);
    return Promise.resolve(typeof answer === 'function' ? answer(call) : answer);
  };
  return { run, calls };
}

export const said = (text: string): AgentResult => ({ ok: true, text, exitCode: 0 });

export type BoardCall = { principal: string; op: string; args: Record<string, unknown> };

/** One task row with the fields the watcher reads. */
export function taskRow(fields: Partial<TaskRecord> & { id: string }): TaskRecord {
  return {
    lane: 'dev',
    project: null,
    title: 'a task',
    description: null,
    acceptance: null,
    requester: 'watcher',
    priority: 2,
    risk: 'normal',
    role: null,
    budget_usd: null,
    step_cap: null,
    estimate_minutes: null,
    status: 'proposed',
    close_reason: null,
    defer_until: null,
    is_blocked: 0,
    revision: 1,
    lease_owner: null,
    lease_expires_at: null,
    heartbeat_at: null,
    subscriber: null,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    metadata: null,
    lease_generation: 0,
    blocked_reason: null,
    unblocks: null,
    ...fields,
  };
}

export type FakeBoard = { board: BoardCaller; calls: Array<BoardCall>; tasks: Array<TaskRecord>; added(): Array<BoardCall> };

/**
 * A board that holds `tasks`, appends a row for every `task.add` (ids T-fake-1, T-fake-2, ...) and answers `task.list`
 * filtered by `requester`. `failAdd` makes every `task.add` throw it.
 */
export function fakeBoard(tasks: ReadonlyArray<TaskRecord> = [], options: { failAdd?: Error; now?: () => number } = {}): FakeBoard {
  const held = [...tasks];
  const calls: Array<BoardCall> = [];
  const board: BoardCaller = {
    call<TOp extends BoardOp>(principal: string, op: TOp, args: Readonly<Record<string, unknown>> = {}): BoardResults[TOp] {
      calls.push({ principal, op, args: { ...args } });
      if (op === 'task.add') {
        if (options.failAdd !== undefined) throw options.failAdd;
        const row = taskRow({
          id: `T-fake-${held.length + 1}`,
          title: String(args.title),
          description: typeof args.description === 'string' ? args.description : null,
          acceptance: typeof args.acceptance === 'string' ? args.acceptance : null,
          requester: typeof args.requester === 'string' ? args.requester : principal,
          metadata: typeof args.metadata === 'object' && args.metadata !== null ? (args.metadata as Record<string, unknown>) : null,
          created_at: new Date(options.now?.() ?? Date.now()).toISOString(),
        });
        held.push(row);
        // The fake answers each op with the row shape the real board gives it; the cast is the generic return.
        return row as BoardResults[TOp];
      }
      if (op === 'task.list') {
        const requester = args.requester;
        return held.filter((row) => requester === undefined || row.requester === requester) as BoardResults[TOp];
      }
      throw new Error(`the watcher called ${String(op)}, which the fake board does not hold`);
    },
  };
  return { board, calls, tasks: held, added: () => calls.filter((call) => call.op === 'task.add') };
}
