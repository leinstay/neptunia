// The records scripts/harness.ts `turns` writes for one replayed turn, one JSON line per item and one file per edge
// under `<out>/<edge>/<turnId>.jsonl`. `requests` holds every request as the model client got it: purpose, model,
// messages, tools and every other option it goes out with. `tools` holds every call the tool gate answered, in order, with its name, arguments, whether it
// ran on the copy or was kept, its status and its result, then every journal `action` line the turn kept.
// `actions` holds every interface action the recording port kept (send, edit, delete, react, unreact, typing and
// `command.result`) and, last, how the turn ended. `lines` holds every journal line and record append the turn kept,
// in order, as scripts/harness.ts `db` writes them through the memory writers. No record holds a time the run measured or a path of the machine:
// each path the caller names is replaced by `<path-N>`. THE RECORDS HOLD THE PERSONA'S WORDS AND MEMORY: they are private, like
// the copy.

import fs from 'node:fs';
import path from 'node:path';
import type { KeptRequest } from './turn-report.ts';
import type { GatewayCall } from './turn-tools.ts';
import type { KeptJournal } from './turn-wiring.ts';
import type { RecordedWrite } from './turn-port.ts';

/** What one replayed turn kept, and how it ended: its outcome, `deadline` or the error it stopped on. */
export type TurnRun = {
  requests: ReadonlyArray<KeptRequest>;
  gateway: ReadonlyArray<GatewayCall>;
  journal: KeptJournal['lines'];
  writes: ReadonlyArray<RecordedWrite>;
  end: string;
};

/** The edges one turn's execution records. */
export const TURN_EDGES = ['requests', 'tools', 'actions', 'lines'] as const;
type TurnEdge = (typeof TURN_EDGES)[number];

/** `items` as JSON lines, every path of `paths` in them replaced by its placeholder. */
function jsonLines(items: ReadonlyArray<unknown>, paths: ReadonlyArray<string>): string {
  let text = items.map((item) => `${JSON.stringify(item)}\n`).join('');
  paths.forEach((one, index) => {
    // A path appears in JSON as its string's escaped body.
    const escaped = JSON.stringify(one).slice(1, -1);
    if (escaped !== '') text = text.replaceAll(escaped, `<path-${index + 1}>`);
  });
  return text;
}

const statusOf = (result: unknown): unknown => (result as { status?: unknown } | null)?.status ?? null;

/**
 * The `requests` record of `requests`: each request's purpose, model, messages, tools and options, one JSON line each.
 * scripts/lib/harness-db.ts writes the requests of each replayed memory-session run with it.
 */
export function requestsRecord(requests: ReadonlyArray<KeptRequest>, paths: ReadonlyArray<string>): string {
  return jsonLines(
    requests.map((request) => ({
      purpose: request.purpose,
      model: request.model,
      messages: request.messages,
      tools: request.tools,
      options: request.options,
    })),
    paths
  );
}

/** The four records of `run`, by edge (see the head of this file). */
export function turnRecords(run: TurnRun, paths: ReadonlyArray<string>): Record<TurnEdge, string> {
  const calls = run.gateway.map((call) => ({
    source: 'gateway',
    name: call.op,
    args: call.args,
    ran: call.ran ? 'ran' : 'kept',
    status: statusOf(call.result),
    result: call.result,
  }));
  const actionLines = run.journal
    .filter((line) => line.kind === 'action')
    .map((line) => ({ source: 'journal', kind: line.kind, placeId: line.placeId, record: line.record }));
  const actions = [...run.writes.map((write) => ({ op: write.op, args: write.args })), { end: run.end }];
  return {
    requests: requestsRecord(run.requests, paths),
    tools: jsonLines([...calls, ...actionLines], paths),
    actions: jsonLines(actions, paths),
    lines: jsonLines(
      run.journal.map((line) => ({ kind: line.kind, placeId: line.placeId, record: line.record })),
      paths
    ),
  };
}

/**
 * `records` written to `<out>/<edge>/<turnId>.jsonl`, `lines` last. Each record is written under a temporary name in
 * its folder and renamed into place, so a record under its name is whole, and a `lines` record under its name means
 * the turn's four records are written: scripts/harness.ts `db`, running beside `turns`, waits for exactly that.
 */
export function writeTurnRecords(out: string, turnId: string, records: Record<TurnEdge, string>): void {
  for (const edge of TURN_EDGES) {
    const dir = path.join(out, edge);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${turnId}.jsonl`);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, records[edge], { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
}
