// Her own time as the memory session reads it (session.ts, scope `own:<iface>`): the steps of one heartbeat turn in
// order, each with its thinking and its calls, each call with its arguments and the result the next step was given, and
// how the run ended. Reads `wake_runs` and `model_requests` only. The heartbeat's own input request is left out: the
// session has its own blocks. Pure reads; the session writes what it keeps through the writer.

import { parseToolCallBlocks } from '../../llm/tool-text.ts';
import { skillNameOfApi } from '../../tools/definitions.ts';
import { OWN_TIME_KIND, otherSourceId } from './ids.ts';
import { asText } from './types.ts';
import type { Db, Row } from './types.ts';

/** The characters of a call's result the view keeps. */
export const RESULT_MAX_CHARS = 1200;

type OwnCall = { tool: string; args: string; status: string | null; result: string | null };
type OwnStep = { think: string; calls: Array<OwnCall> };
/** One heartbeat turn as the session reads it. */
export type OwnTimeView = { turnId: string; at: string; status: string; outcome: string | null; steps: Array<OwnStep> };

const parse = (text: unknown): unknown => {
  try {
    return JSON.parse(asText(text));
  } catch {
    // A column the archive left empty or never wrote (a step that failed before its answer).
    return null;
  }
};
const rows = (value: unknown): Array<Row> => (Array.isArray(value) ? (value as Array<Row>) : []);

/** The calls a step wrote: the native ones the archive kept, else the blocks of the text transport. */
function callsOf(step: Row): Array<{ id: string | null; tool: string; args: string }> {
  const native = rows(parse(step.tool_calls));
  const calls =
    native.length > 0 ? native : (parseToolCallBlocks(asText(step.response_text ?? '')).calls as unknown as Array<Row>);
  return calls.map((call) => ({
    id: typeof call.id === 'string' ? call.id : null,
    tool: skillNameOfApi(call.name) ?? asText(call.name),
    args: asText(call.arguments ?? ''),
  }));
}

const RESULT_TAG = /^<tool_result id="([^"]*)" name="[^"]*" status="([^"]*)">\n([\s\S]*?)\n?<\/tool_result>$/;

/** The results the request after a step carries: native by call id, the text transport's in call order. */
function resultsOf(next: Row | undefined): {
  byId: Map<string, string>;
  inOrder: Array<{ status: string; text: string }>;
} {
  const byId = new Map<string, string>();
  const inOrder: Array<{ status: string; text: string }> = [];
  const messages = rows(parse(next?.messages));
  for (const message of messages) {
    if (message.role === 'tool') byId.set(asText(message.tool_call_id), asText(message.content ?? ''));
  }
  const last = [...messages].reverse().find((message) => message.role === 'user' && Array.isArray(message.content));
  for (const part of rows(last?.content)) {
    const tag = RESULT_TAG.exec(asText(part.text ?? ''));
    if (tag) inOrder.push({ status: tag[2], text: tag[3] });
  }
  return { byId, inOrder };
}

const cut = (text: string): string => (text.length > RESULT_MAX_CHARS ? `${text.slice(0, RESULT_MAX_CHARS)}…` : text);

/** The view of the heartbeat run `turnId`, or null when no run has that id. */
export function ownTimeView(db: Db, turnId: string): OwnTimeView | null {
  const run = db.prepare('SELECT started_at, status, outcome FROM wake_runs WHERE id = ?').get(turnId);
  if (!run) return null;
  const list = db
    .prepare(
      `SELECT attempt_id, think, tool_calls, response_text, messages FROM model_requests
       WHERE turn_id = ? AND status = 'ok' ORDER BY attempt_id, step`
    )
    .all(turnId);
  const steps = list.map((step, at): OwnStep => {
    const next = list[at + 1]?.attempt_id === step.attempt_id ? list[at + 1] : undefined;
    const { byId, inOrder } = resultsOf(next);
    const calls = callsOf(step).map((call, n): OwnCall => {
      const own = call.id !== null && byId.has(call.id) ? { status: null, text: byId.get(call.id)! } : inOrder[n];
      return { tool: call.tool, args: call.args, status: own?.status ?? null, result: own ? cut(own.text) : null };
    });
    return { think: asText(step.think ?? '').trim(), calls };
  });
  return {
    turnId,
    at: asText(run.started_at),
    status: asText(run.status),
    outcome: typeof run.outcome === 'string' ? run.outcome : null,
    steps,
  };
}

const flat = (text: string): string => text.replace(/\s*\n\s*/g, ' ⏎ ');

/** The lines of a view, one per thinking, call and result, then how the run ended; none for a run with no step. */
export function viewLines(view: OwnTimeView): Array<string> {
  if (view.steps.length === 0) return [];
  const lines: Array<string> = [];
  for (const step of view.steps) {
    if (step.think) lines.push(`think: ${flat(step.think)}`);
    for (const call of step.calls) {
      lines.push(`call ${call.tool} ${flat(call.args)}`);
      if (call.result !== null) lines.push(`result${call.status ? ` ${call.status}` : ''}: ${flat(call.result)}`);
    }
  }
  lines.push(`ended: ${view.status}${view.outcome ? ` ${view.outcome}` : ''}`);
  return lines;
}

/**
 * The finished heartbeat runs after the `wake_runs` rowid `after`, oldest first, at most `limit`, read over the rowid.
 * The list stops at a heartbeat run still queued or running, so no run is passed before it ends. `since`: an ISO time
 * before which a run is passed over.
 */
export function finishedRuns(
  db: Db,
  { after, limit, since }: { after: number; limit: number; since: string | null }
): Array<{ rowid: number; id: string }> {
  const out: Array<{ rowid: number; id: string }> = [];
  const found = db
    .prepare(
      "SELECT rowid AS rowid, id, status, started_at FROM wake_runs WHERE rowid > ? AND kind = 'heartbeat' ORDER BY rowid LIMIT ?"
    )
    .all(after, limit);
  for (const row of found) {
    if (row.status === 'queued' || row.status === 'running') break;
    if (since !== null && asText(row.started_at) < since) continue;
    out.push({ rowid: Number(row.rowid), id: asText(row.id) });
  }
  return out;
}

/** One line of her own time as a batch line of the session: its run's rowid, the id it is stored under if cited. */
export type OwnLine = Row & { rowid: number; id: string; kind: string; text: string; at: number; opens: boolean };

/**
 * The lines of the finished heartbeat runs after `cursor`, run by run, until `maxLines` lines are reached (one run at
 * least), and the rowid of the last run read: a run with no step moves it and gives no line.
 */
export function ownBatchOf(
  db: Db,
  { cursor, maxLines, since }: { cursor: number; maxLines: number; since: string | null }
): { lines: Array<OwnLine>; cursorTo: number } {
  const lines: Array<OwnLine> = [];
  let cursorTo = cursor;
  for (const run of finishedRuns(db, { after: cursor, limit: maxLines, since })) {
    if (lines.length >= maxLines) break;
    const view = ownTimeView(db, run.id);
    const at = Date.parse(view?.at ?? '');
    (view ? viewLines(view) : []).forEach((text, n) =>
      lines.push({
        rowid: run.rowid,
        id: otherSourceId(OWN_TIME_KIND, `${run.id}:${n + 1}`),
        kind: OWN_TIME_KIND,
        text,
        at: Number.isFinite(at) ? at : 0,
        opens: n === 0,
        place_id: null,
        author_account: null,
      })
    );
    cursorTo = run.rowid;
  }
  return { lines, cursorTo };
}
