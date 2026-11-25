// The comparison of two scripts/harness.ts runs. Every file under `<run>/<edge>/`, at any depth, is a record, and two
// runs are compared record by record, byte for byte, over every edge either run holds or the one edge asked for. The
// text names counts per edge, each record that differs with the offset of its first different byte, and each record
// only one run holds. It never holds a byte of a record, because the records are private.

import fs from 'node:fs';
import path from 'node:path';

/** The records under `dir`, as paths relative to it with `/` between parts, sorted. */
function recordsUnder(dir: string): Array<string> {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();
}

/** The edges of a run: its top folders. */
function edgesOf(run: string): Array<string> {
  if (!fs.existsSync(run)) return [];
  return fs
    .readdirSync(run, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** The offset of the first byte where `a` and `b` differ, null when they are equal. */
function firstDifference(a: Buffer, b: Buffer): number | null {
  const length = Math.min(a.length, b.length);
  for (let at = 0; at < length; at += 1) if (a[at] !== b[at]) return at;
  return a.length === b.length ? null : length;
}

/** Runs `a` and `b` compared over `edge`, or over every edge either holds when `edge` is null. */
export function compareRuns(a: string, b: string, edge: string | null): { text: string; identical: boolean } {
  const edges = edge === null ? [...new Set([...edgesOf(a), ...edgesOf(b)])].sort() : [edge];
  const counts: Array<string> = [];
  const named: Array<string> = [];
  let identical = true;
  for (const one of edges) {
    const inA = recordsUnder(path.join(a, one));
    const inB = new Set(recordsUnder(path.join(b, one)));
    let same = 0;
    let differ = 0;
    let onlyA = 0;
    for (const record of inA) {
      if (!inB.has(record)) {
        onlyA += 1;
        named.push(`only in A ${one}/${record}`);
        continue;
      }
      inB.delete(record);
      const at = firstDifference(
        fs.readFileSync(path.join(a, one, record)),
        fs.readFileSync(path.join(b, one, record))
      );
      if (at === null) same += 1;
      else {
        differ += 1;
        named.push(`differs ${one}/${record} at byte ${at}`);
      }
    }
    for (const record of inB) named.push(`only in B ${one}/${record}`);
    if (differ > 0 || onlyA > 0 || inB.size > 0) identical = false;
    counts.push(
      `${one}: ${inA.length + inB.size} records, ${same} identical, ${differ} differ, ${onlyA} only in A, ${inB.size} only in B`
    );
  }
  return { text: `${[...counts, ...named, identical ? 'identical' : 'different'].join('\n')}\n`, identical };
}
