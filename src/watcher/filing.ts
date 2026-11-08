// What the watcher files on the board, kept by run identity in `<watcher dir>/filings/<run id>.json`. An inspection writes
// its validated drafts here as `pending` before it asks the board, and every answer of the board becomes that draft's
// receipt, so a crash or an outage loses nothing and a later inspection finishes the job. A draft may have been accepted
// with its answer lost, so before any `task.add` the rows on the board are searched for this run's finding, and the add
// itself carries an idempotency key. Duplicates are found by the model's `finding` key, and a draft or a task that has
// none by its evidence. Her open task on the same evidence covers a draft too, so one issue runs once and each task keeps
// its origin. A `failed` receipt is a refusal of the board and is not retried; a `deferred` one is an outage and is.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { TaskRecord } from '../board/board.ts';
import { BoardError, BoardRefusal } from '../board/machine.ts';
import { DAY_MS } from '../time.ts';
import type { BoardCaller } from '../tools/operations/board.ts';
import { HER, WATCHER, herOpenTask, normalized } from './tasks.ts';
import type { TaskDraft } from './tasks.ts';

export type FilingState =
  'pending' | 'filed' | 'duplicate' | 'deferred' | 'failed' | 'cancelled' | 'unmatched-draft' | 'draft';

export type FilingReceipt = {
  /** The model's key, or the normalized evidence of a draft with none. */
  finding: string;
  kind: TaskDraft['kind'];
  title: string;
  evidence: string;
  done: string;
  state: FilingState;
  taskId: string | null;
};

type FilingFile = { runId: string; at: number; receipts: Array<FilingReceipt> };

const CLOSED: ReadonlyArray<string> = ['done', 'failed', 'cancelled'];
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

const filingsDir = (dir: string): string => path.join(dir, 'filings');
const fileOf = (dir: string, runId: string): string => path.join(filingsDir(dir), `${runId}.json`);
const isUnsettled = (receipt: FilingReceipt): boolean => receipt.state === 'pending' || receipt.state === 'deferred';
const hasOwnKey = (receipt: FilingReceipt): boolean => receipt.finding !== normalized(receipt.evidence);

function readFile(dir: string, runId: string): FilingFile | null {
  if (!SAFE_ID.test(runId)) return null;
  try {
    return JSON.parse(fs.readFileSync(fileOf(dir, runId), 'utf8')) as FilingFile;
  } catch {
    return null;
  }
}

function writeFile(dir: string, file: FilingFile): void {
  const target = fileOf(dir, file.runId);
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(file, null, 2));
  fs.renameSync(`${target}.tmp`, target);
}

/** The receipts of one run, in the order of its drafts; none for a run that has no drafts. */
export function readFilings(dir: string, runId: string): Array<FilingReceipt> {
  return readFile(dir, runId)?.receipts ?? [];
}

/** Whether two receipts of one answer name the same finding. */
function sameFinding(a: FilingReceipt, b: FilingReceipt): boolean {
  if (hasOwnKey(a) && hasOwnKey(b)) return a.finding === b.finding;
  return normalized(a.evidence) === normalized(b.evidence);
}

/**
 * Saves a run's validated drafts as `pending`. A repeat inside the answer is a `duplicate` from the start, and so is a draft
 * for a finding in `limits.repeated`, a key the risk rules found to repeat an earlier report with no new evidence. With
 * `limits.fileable`, the keys of the finding lines at `medium` or above, any other draft is `unmatched-draft`: settled, never
 * sent to the board and never retried. With `limits.draftsOnly` (`watcher.draftsOnly`, while the watcher is calibrated) every draft left to file is a `draft`: settled,
 * never sent to the board, listed in the report.
 */
export function saveDrafts(
  dir: string,
  runId: string,
  at: number,
  drafts: ReadonlyArray<TaskDraft>,
  limits: {
    repeated?: ReadonlySet<string>;
    fileable?: ReadonlySet<string>;
    draftsOnly?: boolean;
  } = {}
): void {
  if (drafts.length === 0) return;
  fs.mkdirSync(filingsDir(dir), { recursive: true });
  const receipts: Array<FilingReceipt> = [];
  for (const draft of drafts) {
    const receipt: FilingReceipt = {
      finding: draft.finding ?? normalized(draft.evidence),
      kind: draft.kind,
      title: draft.title,
      evidence: draft.evidence,
      done: draft.done,
      state: 'pending',
      taskId: null,
    };
    if (limits.repeated?.has(receipt.finding) === true) {
      receipt.state = 'duplicate';
      receipt.taskId = linkedReceipts(dir).findLast((one) => one.finding === receipt.finding)?.taskId ?? null;
    } else if (limits.fileable?.has(receipt.finding) === false) receipt.state = 'unmatched-draft';
    else if (receipts.some((one) => sameFinding(one, receipt))) receipt.state = 'duplicate';
    else if (limits.draftsOnly === true) receipt.state = 'draft';
    receipts.push(receipt);
  }
  writeFile(dir, { runId, at, receipts });
}

/** Moves one receipt on, unless another process settled it meanwhile. */
function settle(dir: string, runId: string, index: number, state: FilingState, taskId: string | null = null): void {
  const file = readFile(dir, runId);
  const receipt = file?.receipts[index];
  if (file === null || receipt === undefined || !isUnsettled(receipt)) return;
  receipt.state = state;
  receipt.taskId = taskId;
  writeFile(dir, file);
}

/** Every run's file that still has something to file, oldest first. */
function unsettledFiles(dir: string): Array<FilingFile> {
  let names: Array<string> = [];
  try {
    names = fs.readdirSync(filingsDir(dir)).filter((name) => name.endsWith('.json'));
  } catch {
    // No filing yet.
  }
  return names
    .flatMap((name) => {
      const file = readFile(dir, name.slice(0, -'.json'.length));
      return file !== null && file.receipts.some(isUnsettled) ? [file] : [];
    })
    .sort((a, b) => a.at - b.at);
}

export const hasUnsettledFilings = (dir: string): boolean => unsettledFiles(dir).length > 0;

/** Whatever a run has not yet filed will never be: it was cancelled. */
export function cancelFilings(dir: string, runId: string): void {
  const file = readFile(dir, runId);
  if (file === null || !file.receipts.some(isUnsettled)) return;
  for (const receipt of file.receipts) if (isUnsettled(receipt)) receipt.state = 'cancelled';
  writeFile(dir, file);
}

/** With no board to ask, what a run still has to file waits for a later inspection. */
export function deferFilings(dir: string, runId: string): void {
  const file = readFile(dir, runId);
  if (file === null || !file.receipts.some((one) => one.state === 'pending')) return;
  for (const receipt of file.receipts) if (receipt.state === 'pending') receipt.state = 'deferred';
  writeFile(dir, file);
}

/** Every run's receipts that name a task and a key of the model's: what a resolution can be read from. */
function linkedReceipts(dir: string): Array<FilingReceipt> {
  let names: Array<string> = [];
  try {
    names = fs.readdirSync(filingsDir(dir)).filter((name) => name.endsWith('.json'));
  } catch {
    // No filing yet.
  }
  return names.flatMap((name) =>
    (readFile(dir, name.slice(0, -'.json'.length))?.receipts ?? []).filter(
      (one) => one.taskId !== null && hasOwnKey(one)
    )
  );
}

export const hasLinkedFilings = (dir: string): boolean => linkedReceipts(dir).length > 0;

/**
 * The findings whose filed task is `done` with its pull request merged (`metadata.merged`, src/development/worker.ts), each
 * with the moment the task last moved. A key seen after that moment is new. Throws when the board does not answer.
 */
export async function resolvedFindings(dir: string, board: BoardCaller): Promise<Array<{ key: string; at: number }>> {
  const rows = await board.call(WATCHER, 'task.list', { requester: WATCHER });
  return linkedReceipts(dir).flatMap((receipt) => {
    const row = rows.find((one) => one.id === receipt.taskId);
    const merged = row?.metadata?.merged;
    if (row?.status !== 'done' || typeof merged !== 'object' || merged === null) return [];
    return [{ key: receipt.finding, at: Date.parse(row.updated_at) }];
  });
}

const metaText = (row: TaskRecord, key: string): string | null => {
  const value = row.metadata?.[key];
  return typeof value === 'string' ? value : null;
};

/** The task this very draft became, found by its run and finding. */
function acceptedRow(rows: ReadonlyArray<TaskRecord>, runId: string, receipt: FilingReceipt): TaskRecord | undefined {
  return rows.find(
    (row) =>
      row.requester === WATCHER &&
      metaText(row, 'runId') === runId &&
      (metaText(row, 'finding') ?? normalized(metaText(row, 'evidence') ?? '')) === receipt.finding
  );
}

/** A task of the watcher's that already covers this finding: open, or created today or yesterday. */
function coveringRow(rows: ReadonlyArray<TaskRecord>, receipt: FilingReceipt, since: number): TaskRecord | undefined {
  return rows.find((row) => {
    if (row.requester !== WATCHER) return false;
    if (CLOSED.includes(row.status) && Date.parse(row.created_at) < since) return false;
    const key = metaText(row, 'finding');
    if (key !== null && hasOwnKey(receipt)) return key === receipt.finding;
    return normalized(metaText(row, 'evidence') ?? '') === normalized(receipt.evidence);
  });
}

/** What the outcome of a call to the board makes of a receipt: a refusal is final, anything else is an outage. */
const stateOfError = (error: unknown): FilingState =>
  error instanceof BoardError || error instanceof BoardRefusal ? 'failed' : 'deferred';

/** One draft's turn: reconcile, compare, then add. Whether the board stopped answering. */
async function fileOne(
  args: { dir: string; board: BoardCaller; rows: Array<TaskRecord>; since: number },
  runId: string,
  index: number,
  receipt: FilingReceipt
): Promise<boolean> {
  const { dir, board, rows, since } = args;
  const accepted = acceptedRow(rows, runId, receipt);
  const covering = accepted ?? coveringRow(rows, receipt, since) ?? herOpenTask(rows, receipt.evidence);
  if (covering !== undefined) {
    settle(dir, runId, index, accepted === undefined ? 'duplicate' : 'filed', covering.id);
    return false;
  }
  const key = createHash('sha256').update(`${runId}\n${receipt.finding}`).digest('hex').slice(0, 32);
  try {
    const added = await board.call(
      WATCHER,
      'task.add',
      {
        lane: 'dev',
        title: receipt.title,
        description: receipt.evidence,
        acceptance: receipt.done,
        metadata: {
          kind: receipt.kind,
          evidence: receipt.evidence,
          origin: WATCHER,
          runId,
          ...(hasOwnKey(receipt) ? { finding: receipt.finding } : {}),
        },
      },
      `watcher-${key}`
    );
    rows.push(added);
    settle(dir, runId, index, 'filed', added.id);
    return false;
  } catch (error) {
    const state = stateOfError(error);
    settle(dir, runId, index, state);
    return state === 'deferred';
  }
}

/** Gives every unsettled draft of `files` the state a board that stopped answering leaves it in. */
function settleAll(dir: string, files: ReadonlyArray<FilingFile>, state: FilingState): void {
  for (const file of files)
    file.receipts.forEach((one, index) => {
      if (isUnsettled(one)) settle(dir, file.runId, index, state);
    });
}

/**
 * Files everything unsettled, oldest run first, each draft once. `stop` is asked before each draft, and what it holds back
 * stays unsettled for the caller to decide. The first call that gets no answer leaves every draft still unsettled deferred
 * without a call each, so a dead link costs one timeout. Nothing here throws for the board's sake.
 */
export async function retryFilings(args: {
  dir: string;
  board: BoardCaller;
  now: () => number;
  stop?: () => boolean;
}): Promise<void> {
  const { dir, board } = args;
  const files = unsettledFiles(dir);
  if (files.length === 0) return;
  const since = Math.floor(args.now() / DAY_MS) * DAY_MS - DAY_MS;
  let rows: Array<TaskRecord>;
  try {
    rows = [
      ...(await board.call(WATCHER, 'task.list', { requester: WATCHER })),
      ...(await board.call(WATCHER, 'task.list', { requester: HER })),
    ];
  } catch (error) {
    settleAll(dir, files, stateOfError(error));
    return;
  }
  for (const file of files) {
    for (const [index, receipt] of file.receipts.entries()) {
      if (!isUnsettled(receipt)) continue;
      if (args.stop?.() === true) return;
      if (await fileOne({ dir, board, rows, since }, file.runId, index, receipt)) {
        settleAll(dir, files, 'deferred');
        return;
      }
    }
  }
}

/** The lines of a run's receipts for "Tasks filed", each with the key a later report repeats for the same problem. */
export function filingLines(receipts: ReadonlyArray<FilingReceipt>): Array<string> {
  return receipts.flatMap((one) => {
    const title = one.title.replace(/\s+/g, ' ').trim();
    const tag = hasOwnKey(one) ? `${one.kind}, ${one.finding}` : one.kind;
    if (one.state === 'filed') return [`- ${one.taskId ?? ''} (${tag}): ${title}`];
    if (['deferred', 'failed', 'unmatched-draft', 'draft'].includes(one.state)) {
      return [`- ${one.state} (${tag}): ${title}`];
    }
    if (one.state === 'duplicate' && one.taskId !== null) return [`- already ${one.taskId} (${tag}): ${title}`];
    return [];
  });
}
