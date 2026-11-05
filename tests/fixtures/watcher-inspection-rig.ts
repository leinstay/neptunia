// Fakes for the watcher's lifecycle tests: a watcher folder under a temp persona root, a run store with an injected
// clock and an injected table of live processes, an agent that answers a canned text, and a board that keeps rows,
// honours an idempotency key the way src/board/board.ts does, and can lose its answer after accepting a task. The answers
// follow the report's exact template with its `coverage` block at the end, which the check of an inspection requires.
// Synthetic data only: no provider, no database, no socket.
import fs from 'node:fs';
import path from 'node:path';
import type { BoardOp, BoardResults, TaskRecord } from '../../src/board/board.ts';
import { BoardError } from '../../src/board/machine.ts';
import type { BoardCaller } from '../../src/tools/impl/board.ts';
import type { InspectionAgentResult, InspectionDeps } from '../../src/watcher/inspection.ts';
import type { ProcessIdentity, RunStore } from '../../src/watcher/lifecycle.ts';
import { tempDir } from './tmp.ts';
import { HEADINGS, taskRow, tasksBlock } from './watcher-rig.ts';

export const NOW = Date.parse('2026-11-04T06:00:00Z');
export const DAY = '2026-11-04';
export const MINUTE = 60_000;

/** The inspecting process as the tests' table of live processes knows it. */
export const SELF: ProcessIdentity = { pid: 4242, startId: 'boot-a' };

/** What `checkCoverage` of src/watcher/report.ts reads: one valid block, each field replaceable. */
export function coverageOf(fields: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    observation: { from: '2026-11-03T06:00:00.000Z', to: '2026-11-04T06:00:00.000Z' },
    backend: 'claude',
    account: 'the persona account',
    sources: ['model_requests', 'service journal'],
    defects: [],
    suspicious: [],
    inspected: ['memory cursors'],
    unavailable: ['provider quota'],
    ...fields,
  };
}

export const coverageBlock = (fields: Readonly<Record<string, unknown>> = {}): string =>
  '```coverage\n' + JSON.stringify(coverageOf(fields), null, 2) + '\n```\n';

export const SUBHEADINGS: ReadonlyArray<string> = [
  'Observed defects',
  'Suspicious evidence',
  'Inspected without a finding',
  'Unavailable checks',
];

/** What the fixed metadata block says, in its fixed order. */
export const METADATA: ReadonlyArray<readonly [string, string]> = [
  ['Observation interval', '2026-11-03T06:00:00.000Z to 2026-11-04T06:00:00.000Z'],
  ['Run id', 'run-template'],
  ['Selected backend', 'claude'],
  ['Model', 'model-m'],
  ['Effort', 'medium'],
  ['Effective account', 'the persona account'],
  ['Available sources', 'model_requests, service journal'],
];

/** One section's body: a string goes under its first subheading, an object names the subheadings it fills. */
type SectionBody = string | Readonly<Record<string, string>>;

/**
 * A report in the exact template of `checkTemplate`. The options reorder or replace a part so a test can break one thing:
 * the title line, the metadata rows, the sections, the subheadings of each section, and the block at the end.
 */
export function templateOf(
  options: {
    day?: string;
    title?: string;
    metadata?: ReadonlyArray<readonly [string, string]>;
    bodies?: Readonly<Record<string, SectionBody>>;
    sections?: ReadonlyArray<string>;
    subheadings?: ReadonlyArray<string>;
    end?: string;
  } = {}
): string {
  const title = options.title ?? `# Watcher report ${options.day ?? DAY}`;
  const metadata = (options.metadata ?? METADATA).map(([label, value]) => `- ${label}: ${value}`).join('\n');
  const subheadings = options.subheadings ?? SUBHEADINGS;
  const sections = (options.sections ?? HEADINGS).map((heading) => {
    const body = options.bodies?.[heading] ?? {};
    const of = (name: string): string => {
      if (typeof body !== 'string') return body[name] ?? 'none';
      return name === subheadings[0] ? body : 'none';
    };
    return [`## ${heading}`, ...subheadings.map((name) => `### ${name}\n\n${of(name)}`)].join('\n\n');
  });
  return [title, metadata, ...sections, options.end ?? coverageBlock()].join('\n\n').trimEnd() + '\n';
}

/** A whole answer: the report in its template with `bodies` and, with drafts, the tasks block after it. */
export function answerOf(
  bodies: Readonly<Record<string, string>> = {},
  drafts: ReadonlyArray<Record<string, unknown>> = []
): string {
  return templateOf({ bodies }) + (drafts.length === 0 ? '' : tasksBlock(drafts));
}

export const said = (text: string): InspectionAgentResult => ({ ok: true, text, exitCode: 0 });

export type FakeWatcherBoard = {
  board: BoardCaller;
  rows: Array<TaskRecord>;
  /** Every `task.add`, a repeat answered from the idempotency table included. */
  adds: Array<Record<string, unknown>>;
};

/**
 * A board holding `rows`. `down` throws on every call, as a socket nobody listens on does. `refuse` throws a `BoardError`
 * on `task.add`, the row not taken. `onAdd` runs after a row is accepted, before the answer goes back: a throw in it is an answer
 * lost, and a promise it returns holds the answer back. `forgetKeys` models an idempotency key past its 24 hours.
 */
export function watcherBoard(
  options: {
    rows?: ReadonlyArray<TaskRecord>;
    down?: () => boolean;
    refuse?: () => boolean;
    onAdd?: (row: TaskRecord) => void | Promise<void>;
    forgetKeys?: boolean;
  } = {}
): FakeWatcherBoard {
  const rows = [...(options.rows ?? [])];
  const adds: Array<Record<string, unknown>> = [];
  const keys = new Map<string, TaskRecord>();
  const add = async (principal: string, args: Readonly<Record<string, unknown>>, key: string | null) => {
    adds.push({ ...args });
    const known = key === null || options.forgetKeys === true ? undefined : keys.get(key);
    if (known !== undefined) return known;
    if (options.refuse?.() === true) throw new BoardError('forbidden', 'the board refused the task');
    const row = taskRow({
      id: `T-${rows.length + 1}`,
      title: String(args.title),
      description: typeof args.description === 'string' ? args.description : null,
      acceptance: typeof args.acceptance === 'string' ? args.acceptance : null,
      requester: principal,
      metadata: (args.metadata ?? null) as TaskRecord['metadata'],
      status: 'proposed',
    });
    rows.push(row);
    if (key !== null) keys.set(key, row);
    await options.onAdd?.(row);
    return row;
  };
  const board: BoardCaller = {
    async call<TOp extends BoardOp>(
      principal: string,
      op: TOp,
      args: Readonly<Record<string, unknown>> = {},
      idempotency: string | null = null
    ): Promise<BoardResults[TOp]> {
      if (options.down?.() === true) throw new Error('connect ECONNREFUSED');
      // The fake answers each op with the row shape the real board gives it; the cast is the generic return.
      if (op === 'task.add') return (await add(principal, args, idempotency)) as BoardResults[TOp];
      if (op === 'task.list') {
        const { requester } = args;
        return rows.filter((row) => requester === undefined || row.requester === requester) as BoardResults[TOp];
      }
      throw new Error(`the watcher called ${String(op)}, which it has no right to`);
    },
  };
  return { board, rows, adds };
}

export type InspectionRig = {
  root: string;
  dir: string;
  reportsDir: string;
  promptFile: string;
  clock: { t: number };
  /** pid to start id of the processes alive at this moment. */
  alive: Map<number, string>;
  store: RunStore;
  fake: FakeWatcherBoard;
};

/** A persona root with `agents/watcher/prompt.md` and an empty `reports/`, the clock at `start`, `SELF` alive. */
export function inspectionRig(start: number = NOW, board: FakeWatcherBoard = watcherBoard()): InspectionRig {
  const root = tempDir('nep-inspection-');
  const dir = path.join(root, 'agents', 'watcher');
  const reportsDir = path.join(dir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const promptFile = path.join(dir, 'prompt.md');
  fs.writeFileSync(promptFile, 'PROMPT-SENTINEL');
  const clock = { t: start };
  const alive = new Map([[SELF.pid, SELF.startId]]);
  let made = 0;
  const store: RunStore = {
    dir,
    now: () => clock.t,
    newRunId: () => {
      made += 1;
      return `run-${made}`;
    },
    processStart: (pid) => alive.get(pid) ?? null,
  };
  return { root, dir, reportsDir, promptFile, clock, alive, store, fake: board };
}

/** The deps of one inspection over `rig`, answering `answerOf()` unless the overrides say otherwise. */
export function inspectionDeps(rig: InspectionRig, overrides: Partial<InspectionDeps> = {}): InspectionDeps {
  return {
    store: rig.store,
    reportsDir: rig.reportsDir,
    self: SELF,
    source: 'timer',
    timeoutMs: 60 * MINUTE,
    promptFiles: [rig.promptFile],
    selected: { backend: 'claude', model: 'model-m', effort: 'medium' },
    runAgent: () => Promise.resolve(said(answerOf())),
    openBoard: () => Promise.resolve(rig.fake.board),
    cancelPollMs: 5,
    ...overrides,
  };
}

/** Every file under `dir`, with its text: what a planted value must appear in nowhere. */
export function allTextUnder(dir: string): string {
  const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8'))
    .join('\n');
}

/** Resolves when `signal` aborts; a run that never hears the cancel fails the test in three seconds. */
export function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error('the run was never aborted')), 3_000);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** The body of the `## <heading>` section of a report. */
export function sectionOf(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}
