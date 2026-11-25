// The fault edge of scripts/harness.ts `faults`: the report of a fault run (scripts/lib/fault-run.ts) as records under
// `<out>/faults/`, one `<nn>-<scenario>.json` per scenario in run order with its effect keys and counts, what repeated
// and what never came, the keys in the order they happened for a scenario whose effects have an order, and
// `gaps.txt`, one line per fault the fake interface cannot express. No record holds the time the run took, so two runs
// of one tree compare byte for byte. The records hold no private data.

import fs from 'node:fs';
import path from 'node:path';
import type { Report } from './fault-run.ts';

/** The faults the fault run leaves out, each with why the fake interface cannot express it. */
export const FAULT_GAPS: ReadonlyArray<string> = [
  'a send split into parts by the platform limit with a later part refused: the fake answers a queued failure for ' +
    'the whole send, never for one of its parts',
  'an interjection the inner life starts on its own (mode auto): the live rig runs no inner wake, and the simulated ' +
    'weeks answer their turns with a stub, so only the interjection of an errand result whose asking message is gone ' +
    'runs through the real turn',
];

/** The record name of a scenario: its place in the run and its words in kebab-case. */
const nameOf = (index: number, scenario: string): string =>
  `${String(index + 1).padStart(2, '0')}-${scenario
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}.json`;

/** `report` and `gaps` written to `<out>/faults/`. */
export function writeFaultRecords(out: string, report: Report, gaps: ReadonlyArray<string>): void {
  const dir = path.join(out, 'faults');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  report.rows.forEach((row, index) => {
    const record = {
      scenario: row.scenario,
      keys: row.keys,
      repeats: row.repeats,
      missing: row.missing,
      ...(row.order === null ? {} : { order: row.order }),
    };
    fs.writeFileSync(path.join(dir, nameOf(index, row.scenario)), `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
  });
  fs.writeFileSync(path.join(dir, 'gaps.txt'), gaps.map((gap) => `${gap}\n`).join(''), { mode: 0o600 });
}
