// Fills a memory database from a data directory written the way the memory units are laid out (a fixture written
// by datadir.ts, readers.ts or a test): every memory unit under `guilds/` goes in through the database's own writers
// (unit-writes.ts), as the engine writes it, JSON units whole (op `value`), JSONL units line by line (op
// `lines`), a month of vectors from its three files (op `vectors`). The operational files (legacy-paths.ts)
// and the request dumps stay files: nothing reads them from the database; participation.json and media.json are both,
// as the store writes them (the file, and its memory rows sent). The stems and the graph projection are
// finished at the end, as the writers' projection job does. Synthetic fixtures only.
import fs from 'node:fs';
import path from 'node:path';
import type { FileFormat } from './legacy-classify.ts';
import type { Db, MemoryHandle } from '../../../src/memory/db/types.ts';
import { classify } from './legacy-classify.ts';
import type { MappedPath } from './legacy-classify.ts';
import { applyUnitUpdate, unitAsWrite } from './unit-writes.ts';
import { currentUnitPath, isOperational } from './legacy-paths.ts';
import { fillStems } from '../../../src/memory/db/stems.ts';
import { projectPending } from '../../../src/memory/db/graph.ts';

/** The JSONL kinds the writers take line by line. */
const LINE_KINDS = new Set(['record', 'journal', 'archive', 'intentions']);
/** Units no unit write takes: the errands live on the task board, the GIF library is rows of its own write kind. */
const NOT_UNITS = new Set(['errands', 'gifs']);
/** The operational files whose memory rows the store sends too (store.js#dbPlace). */
const SENT = /^guilds\/[^/]+\/(?:participation|media)\.json$/;
/** Written after the rest: an archived item that is no hot claim needs the hot claims in first, as do the links. */
const LATE_KINDS = new Set(['archive', 'participation', 'vectors']);

/** Every file under `dir`, relative with forward slashes, in name order. */
function walk(dir: string, rel = '', out: Array<string> = []): Array<string> {
  let entries: Array<fs.Dirent> = [];
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(dir, child, out);
    else out.push(child);
  }
  return out;
}

/** A memory unit of a data directory: the owner path, the kind and format of its files, and the files. */
export type Unit = { owner: string; kind: MappedPath['kind']; format: FileFormat; files: Array<string> };

/** The memory units of a data directory (a month of vectors is one unit). */
export function unitsOf(dataDir: string): Array<Unit> {
  const units = new Map<string, Unit>();
  for (const rel of walk(dataDir)) {
    if (!rel.startsWith('guilds/') || (isOperational(rel) && !SENT.test(rel))) continue;
    // A data directory of an older release names the errand units `tasks.json` and `tasks.jsonl`: they are the current units.
    const info = classify(currentUnitPath(rel));
    if (!info || 'skipped' in info || info.guildId === undefined) continue;
    if (info.kind === 'requests' || info.format === 'text' || NOT_UNITS.has(info.kind)) continue;
    if (info.format === 'jsonl' && !LINE_KINDS.has(info.kind)) continue;
    const owner = `guilds/${info.guildId}/${info.unit}`;
    if (!units.has(owner)) units.set(owner, { owner, kind: info.kind, format: info.format, files: [] });
    units.get(owner)?.files.push(rel);
  }
  return [...units.values()].sort((a, b) => Number(LATE_KINDS.has(a.kind)) - Number(LATE_KINDS.has(b.kind)) || (a.owner < b.owner ? -1 : 1));
}

/** One month of vectors from its files: `{ manifest, meta, i8 }` of its manifest's generation. */
function vectorMonth(dataDir: string, owner: string) {
  const dir = path.join(dataDir, owner);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const meta = fs.readFileSync(path.join(dir, `${manifest.gen}.jsonl`), 'utf8').slice(0, manifest.metaBytes);
  const i8 = fs.readFileSync(path.join(dir, `${manifest.gen}.i8`)).subarray(0, manifest.bytes);
  return { manifest, meta, i8 };
}

/** One unit as the writers take it: a month of vectors whole, a JSONL unit's lines, a JSON unit's value. */
function updateOf(dataDir: string, unit: Unit) {
  if (unit.format === 'vectors') return { op: 'vectors', owner: unit.owner, value: vectorMonth(dataDir, unit.owner) };
  if (unit.format === 'jsonl') {
    const lines = fs.readFileSync(path.join(dataDir, unit.files[0]), 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown);
    return { op: 'lines', owner: unit.owner, lines };
  }
  return { op: 'value', owner: unit.owner, value: JSON.parse(fs.readFileSync(path.join(dataDir, unit.files[0]), 'utf8')) };
}

/** Every memory unit of `dataDir` as the update a service's `writeUnit` takes (`{ op, owner, value | lines }`), in order. */
export function unitUpdates(dataDir: string): Array<Record<string, unknown>> {
  return unitsOf(dataDir)
    .map((unit) => updateOf(dataDir, unit))
    .filter((update) => {
      try {
        unitAsWrite(update);
        return true;
      } catch {
        // A file of an older layout that no writer takes is left out.
        return false;
      }
    });
}

/**
 * Writes every memory unit of `dataDir` into the opened database `handle` (the writer, openMemoryDb). Returns
 * `{ units, errors }`: the units written and the ones a writer refused (each one's code in `codes`). `now` stamps the
 * writes (epoch ms, or a clock).
 */
export function seedUnits(
  handle: MemoryHandle,
  dataDir: string,
  { now: clock = Date.parse('2026-10-24T00:00:00.000Z') }: { now?: number | (() => number) } = {},
): { units: number; errors: number; codes: Array<string> } {
  const now = typeof clock === 'function' ? clock() : clock;
  let written = 0;
  const codes: Array<string> = [];
  const seed = (): void => {
    for (const unit of unitsOf(dataDir)) {
      try {
        applyUnitUpdate(handle, { ...updateOf(dataDir, unit), now });
        written += 1;
      } catch (error) {
        const failure = error as { code?: string; name?: string } | null;
        // A file of an older layout that no writer takes (a voice or buffer file) is left out.
        if (failure?.code === 'UNIT_UNMAPPED') continue;
        codes.push(failure?.code ?? failure?.name ?? 'ERROR');
      }
    }
    fillStems(handle.db as Db);
    projectPending(handle, { at: new Date(now).toISOString() });
  };
  seed();
  return { units: written, errors: codes.length, codes };
}
