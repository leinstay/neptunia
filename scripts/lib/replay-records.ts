// The records of a skill scenario's turns (scripts/lib/replay-skills.ts): one line of runs.jsonl per turn, the turn's
// report as the stored-turn mode writes one (scripts/lib/turn-report.ts) under the scenario, run, step and turn it
// belongs to, and the summary of a scenario's records: its turns, the turns with a call and without, every call by name
// and by status, and for a multi-step scenario each run's decisions as letters.

import type { TurnReport } from './turn-report.ts';
import type { Rec } from './replay-types.ts';

/** One turn of a scenario as runs.jsonl keeps it. */
export type TurnRecord = {
  scenario: string;
  run: number;
  step?: number;
  turn?: number;
  queue?: Rec;
  decision: 'call' | 'no-call';
  calls: Array<{ name: string; status: string | null }>;
  messages: Array<string>;
  outcome: string | null;
  report: TurnReport;
};

/** The record of a turn: `ids` names it, `report` is what it did; a turn decided to call when any step made a call. */
export function turnRecord(
  ids: { scenario: string; run: number; step?: number; turn?: number; queue?: Rec },
  report: TurnReport
): TurnRecord {
  const calls = report.steps.flatMap((step) =>
    (step.calls as Array<{ name: unknown; status: unknown }>).map((call) => ({
      name: typeof call.name === 'string' ? call.name : '',
      status: typeof call.status === 'string' ? call.status : null,
    }))
  );
  return {
    ...ids,
    decision: calls.length > 0 ? 'call' : 'no-call',
    calls,
    messages: report.reply.messages,
    outcome: report.outcome,
    report,
  };
}

/**
 * What the later turns of a multi-step scenario see otherwise than live ones: a live turn marks a line of the persona with the
 * line that triggered it, read off the memory the turn wrote, and a replay writes no memory.
 */
const STEPS_LIMIT =
  "the persona's earlier lines in this scenario carry no '(turn triggered by #N)': a live turn reads that link off memory, which a replay never writes";

/** Each count of `names`, by name. */
const countOf = (names: ReadonlyArray<string>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const name of names) out[name] = (out[name] ?? 0) + 1;
  return out;
};

/**
 * The summary of a scenario's records: its runs and turns, the turns with a call and without, every call by name and by
 * status, the turns that spoke. A multi-step scenario adds `patterns`: per run, one letter per turn, `C` for a call and
 * `N` for none, the steps apart by a space, and `limit`, what its later turns see otherwise than live turns would.
 */
export function scenarioSummary(
  records: ReadonlyArray<TurnRecord>,
  { steps = null }: { steps?: number | null } = {}
): Rec {
  const calls = records.flatMap((record) => record.calls);
  const runs = [...new Set(records.map((record) => record.run))];
  const patterns =
    steps === null
      ? null
      : runs.map((run) => {
          const mine = records.filter((record) => record.run === run);
          return Array.from({ length: steps }, (_, i) =>
            mine
              .filter((record) => record.step === i + 1)
              .map((record) => (record.decision === 'call' ? 'C' : 'N'))
              .join('')
          ).join(' ');
        });
  return {
    runs: runs.length,
    turns: records.length,
    calls: records.filter((record) => record.decision === 'call').length,
    noCall: records.filter((record) => record.decision === 'no-call').length,
    byName: countOf(calls.map((call) => call.name)),
    byStatus: countOf(calls.map((call) => call.status ?? 'none')),
    spoke: records.filter((record) => record.messages.length > 0).length,
    ...(patterns === null ? {} : { steps, patterns, limit: STEPS_LIMIT }),
  };
}
