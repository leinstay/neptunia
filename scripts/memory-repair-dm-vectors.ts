#!/usr/bin/env node
// Operations tool: repairs the months of the meaning index that a restart loop left behind. Stop the core first: the run
// takes the writer's lock and writes through the writer's own vector op (`applyUnitWrite`). Exit 0 done, 1 refused, 2 usage.
//
//   node scripts/memory-repair-dm-vectors.ts --db <memory.db> [--apply] [--dm-only]
//
// Without `--apply` it opens the database read-only, writes nothing and prints what it would do. `--dm-only` leaves the
// months of group places alone. Run again it finds nothing, so a second run is harmless. The output is counts only.
//
// A month is rebuilt from the rows it holds, as a new generation:
//   - a DM month's row whose line names another stored DM place (`placeId`) moves to that place's month, and takes that
//     place's audience;
//   - of the rows that repeat one record at one revision in a month, the one linked to its line stays, and the others
//     are retired;
//   - a kept row of a DM month that is not in the DM's audience, such as one quarantined to internal, takes it;
//   - the manifest counts what is left, so the month reads whole again.
// A month with an evicted vector, or one kept raw or with a tail, holds bytes the rows cannot rebuild: it is counted and
// left as it is.

import { chunkKey } from '../src/memory/chunks.ts';
import { unitRows } from '../src/memory/db/export.ts';
import { MAPPERS } from '../src/memory/db/map/index.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { manifestOfFiles } from '../src/memory/db/readers/vectors.ts';
import { dmAudienceId } from '../src/memory/db/scope.ts';
import { placeCollection, storageId } from '../src/memory/db/storage-keys.ts';
import type { StorageKey } from '../src/memory/db/storage-keys.ts';
import { listUnits } from '../src/memory/db/storage-units.ts';
import { asText, dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../src/memory/db/types.ts';
import { applyUnitWrite } from '../src/memory/db/unit-write.ts';
import { monthChecksum } from '../src/memory/vectors.ts';

type Manifest = Row & { gen: number; dims: number; model?: unknown };
type Month = { key: StorageKey; id: string; place: string; partition: string; manifest: Manifest; rows: Array<Row> };
type Counts = {
  months: number;
  rewritten: number;
  staleManifests: number;
  moved: number;
  duplicatesDm: number;
  duplicatesGroup: number;
  rescoped: number;
  emptied: number;
  leftEvicted: number;
  leftRaw: number;
  leftMoves: number;
};
/** The rows that go to another month: by the id of that month, its keys, and the chunk keys of all of them. */
type Moves = { incoming: Map<string, Array<Row>>; targets: Map<string, StorageKey>; leaving: Set<unknown> };
/** One month's next generation; `leaving` when rows it owns go elsewhere, so it is written before the month they go to. */
type Write = { key: StorageKey; value: { manifest: Row; meta: string; i8: Buffer }; leaving: boolean };

const emptyCounts = (): Counts => ({
  months: 0,
  rewritten: 0,
  staleManifests: 0,
  moved: 0,
  duplicatesDm: 0,
  duplicatesGroup: 0,
  rescoped: 0,
  emptied: 0,
  leftEvicted: 0,
  leftRaw: 0,
  leftMoves: 0,
});

const contextOf = (row: Row): Row => {
  try {
    return JSON.parse(asText(row.context ?? '{}')) as Row;
  } catch {
    return {};
  }
};

const recordOf = (row: Row): string => {
  const context = contextOf(row);
  return chunkKey({ kind: String(context.kind), id: asText(row.item_id ?? ''), revision: context.revision });
};

/** The months the rows of a repair can rebuild, by unit id, and the ids of those it must leave, each counted. */
function readMonths(db: Db, counts: Counts): { months: Map<string, Month>; left: Set<string> } {
  const months = new Map<string, Month>();
  const left = new Set<string>();
  for (const unit of listUnits(db, { kind: 'vectors' })) {
    const { key } = unit;
    if (key.subject.type !== 'place' || !key.partition) continue;
    const rows = unitRows(db, key);
    const stored = JSON.parse(asText(rows.operational[0]?.value ?? '{}')) as {
      manifest?: Manifest;
      raw?: unknown;
      tailI8?: unknown;
    };
    if (!stored.manifest) continue;
    counts.months += 1;
    const evicted = rows.vectors.some((row) => row.bytes === null);
    if (stored.raw || stored.tailI8 || evicted) {
      if (evicted) counts.leftEvicted += 1;
      else counts.leftRaw += 1;
      left.add(storageId(key));
      continue;
    }
    months.set(storageId(key), {
      key,
      id: storageId(key),
      place: key.subject.id,
      partition: key.partition,
      manifest: stored.manifest,
      rows: rows.vectors,
    });
  }
  return { months, left };
}

/** The rows that leave their month for the DM place their line names, by the id of the month they go to. */
function planMoves(
  months: Map<string, Month>,
  left: ReadonlySet<string>,
  dmPlaces: ReadonlySet<string>,
  counts: Counts
): Moves {
  const incoming = new Map<string, Array<Row>>();
  const targets = new Map<string, StorageKey>();
  const leaving = new Set<unknown>();
  for (const month of months.values()) {
    if (!dmPlaces.has(month.place)) continue;
    for (const row of month.rows) {
      const named = contextOf(row).placeId;
      if (row.owner_key !== month.id || typeof named !== 'string' || named === month.place || !dmPlaces.has(named))
        continue;
      const key = { ...placeCollection('vectors', named), partition: month.partition };
      const id = storageId(key);
      const there = months.get(id);
      if (
        left.has(id) ||
        (there && (there.manifest.dims !== month.manifest.dims || there.manifest.model !== month.manifest.model))
      ) {
        counts.leftMoves += 1;
        continue;
      }
      targets.set(id, key);
      incoming.set(id, [...(incoming.get(id) ?? []), row]);
      leaving.add(row.chunk_key);
      counts.moved += 1;
    }
  }
  return { incoming, targets, leaving };
}

/** One row per record of `rows`: the one in the audience and linked to its line, the earliest among equals. */
function withoutRepeats(rows: ReadonlyArray<Row>): Array<Row> {
  const rank = (row: Row): number => (row.audience_id === 'aud:internal' ? 2 : 0) + (row.source_rowid === null ? 1 : 0);
  const best = new Map<string, Row>();
  for (const row of rows) {
    const record = recordOf(row);
    const held = best.get(record);
    if (!held || rank(row) < rank(held)) best.set(record, row);
  }
  const kept = new Set(best.values());
  return rows.filter((row) => kept.has(row));
}

/** The files of a month that holds `rows`: its lines renumbered in order, its bytes and a manifest of the next generation. */
function filesOf(manifest: Manifest, rows: Array<Row>): Write['value'] {
  const operational = [{ value: JSON.stringify({ manifest }) }];
  const files = MAPPERS.vectors.fromRows({ vectors: rows, operational }) as { meta: string; i8: Buffer };
  const lines = files.meta
    .split('\n')
    .filter(Boolean)
    .map((text, row) => `${JSON.stringify({ ...(JSON.parse(text) as Row), row })}\n`)
    .join('');
  const meta = Buffer.from(lines, 'utf8');
  const next = manifestOfFiles({ ...manifest, v: 1 }, rows.length, files.i8, meta, monthChecksum);
  return { manifest: next, meta: lines, i8: files.i8 };
}

/** The rows the month `id` ends with and what changes on the way, its repeats counted by the kind of its place. */
function settledRows(id: string, month: Month | undefined, isDm: boolean, moves: Moves, counts: Counts) {
  const arriving = moves.incoming.get(id) ?? [];
  const staying = (month?.rows ?? []).filter((row) => !moves.leaving.has(row.chunk_key));
  const held = [...staying, ...arriving];
  const kept = withoutRepeats(held);
  const repeats = held.length - kept.length;
  if (isDm) counts.duplicatesDm += repeats;
  else counts.duplicatesGroup += repeats;
  const changed =
    repeats > 0 ||
    arriving.length > 0 ||
    staying.length < (month?.rows.length ?? 0) ||
    staying.some((row) => row.owner_key !== id);
  return { arriving, kept, changed };
}

/** The next generation of the month `id`, or null when it is whole already. */
function planMonth(
  id: string,
  month: Month | undefined,
  place: string,
  isDm: boolean,
  moves: Moves,
  counts: Counts
): Write | null {
  const { arriving, kept, changed } = settledRows(id, month, isDm, moves, counts);
  const audience = isDm ? dmAudienceId(place) : null;
  const rescoped = audience === null ? 0 : kept.filter((row) => row.audience_id !== audience).length;
  counts.rescoped += rescoped;
  const stale = month !== undefined && !sameCounts(month.manifest, filesOf(month.manifest, month.rows).manifest);
  if (stale) counts.staleManifests += 1;
  if (!changed && rescoped === 0 && !stale) return null;
  if (kept.length === 0) counts.emptied += 1;
  counts.rewritten += 1;
  const manifest = month ? { ...month.manifest, gen: month.manifest.gen + 1 } : firstManifest(arriving[0]);
  return {
    key: month?.key ?? (moves.targets.get(id) as StorageKey),
    value: filesOf(manifest, kept),
    leaving: (month?.rows ?? []).some((row) => row.owner_key === id && moves.leaving.has(row.chunk_key)),
  };
}

/** The writes that repair the database, the months that lose rows first, and their counts. */
function planRepair(db: Db, { dmOnly }: { dmOnly: boolean }): { counts: Counts; writes: Array<Write> } {
  const counts = emptyCounts();
  const { months, left } = readMonths(db, counts);
  const dmPlaces = new Set(
    db
      .prepare("SELECT id FROM places WHERE kind = 'dm' OR conversation = 'dm'")
      .all()
      .map((row) => String(row.id))
  );
  const moves = planMoves(months, left, dmPlaces, counts);
  const writes: Array<Write> = [];
  for (const id of new Set([...months.keys(), ...moves.targets.keys()])) {
    const month = months.get(id);
    const place = month?.place ?? (moves.targets.get(id) as StorageKey).subject.id;
    const isDm = dmPlaces.has(place);
    if (!isDm && dmOnly) continue;
    const write = planMonth(id, month, place, isDm, moves, counts);
    if (write) writes.push(write);
  }
  writes.sort((a, b) => Number(b.leaving) - Number(a.leaving));
  return { counts, writes };
}

/** The manifest of a month that does not exist yet, from a row that goes to it. */
function firstManifest(row: Row): Manifest {
  return { v: 1, gen: 1, rows: 0, bytes: 0, metaBytes: 0, model: row.model, dims: Number(row.dims) };
}

const COUNTED = ['rows', 'bytes', 'metaBytes', 'checksum'];
const sameCounts = (a: Row, b: Row): boolean => COUNTED.every((name) => a[name] === b[name]);

function argument(name: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? '' : (process.argv[at + 1] ?? '');
}

function apply(handle: MemoryHandle, writes: ReadonlyArray<Write>, now: number): void {
  for (const { key, value } of writes) applyUnitWrite(handle, { op: 'vectors', key, value, now });
}

function main(): number {
  const file = argument('db');
  if (!file) {
    process.stderr.write('usage: memory-repair-dm-vectors --db <memory.db> [--apply] [--dm-only]\n');
    return 2;
  }
  const write = process.argv.includes('--apply');
  const dmOnly = process.argv.includes('--dm-only');
  let handle: MemoryHandle;
  try {
    handle = openMemoryDb(file, { readOnly: !write });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    process.stderr.write(`memory-repair-dm-vectors: refused, ${typeof code === 'string' ? code : 'not opened'}\n`);
    return 1;
  }
  try {
    const db = dbOf(handle);
    const { counts, writes } = planRepair(db, { dmOnly });
    if (!write) {
      process.stdout.write(`${JSON.stringify({ mode: 'dry-run', ...counts })}\n`);
      return 0;
    }
    apply(handle, writes, Date.now());
    const remaining = planRepair(db, { dmOnly }).counts;
    process.stdout.write(`${JSON.stringify({ mode: 'apply', done: counts, remaining })}\n`);
    return 0;
  } finally {
    handle.close();
  }
}

process.exit(main());
