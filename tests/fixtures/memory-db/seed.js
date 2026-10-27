// Fills a memory database from a data directory written the way the memory units are laid out (a fixture written
// by datadir.js, readers.js or a test): every memory unit under `guilds/` goes in through the database's own writers
// (src/memory/db/unit-write.js), as the engine writes it, JSON units whole (op `value`), JSONL units line by line (op
// `lines`), a month of vectors from its three files (op `vectors`). The operational files (src/memory/db/paths.js)
// and the request dumps stay files: nothing reads them from the database; participation.json and media.json are both,
// as the store writes them (the file, and its memory rows sent). The stems and the graph projection are
// finished at the end, as the writers' projection job does. Synthetic fixtures only.
import fs from 'node:fs';
import path from 'node:path';
import { classify } from '../../../src/memory/db/map/index.js';
import { applyUnitWrite } from '../../../src/memory/db/unit-write.js';
import { currentUnitPath, isOperational } from '../../../src/memory/db/paths.js';
import { fillStems } from '../../../src/memory/db/stems.js';
import { projectPending } from '../../../src/memory/db/graph.js';

/** The JSONL kinds the writers take line by line. */
const LINE_KINDS = new Set(['record', 'journal', 'archive', 'intentions', 'errands']);
/** The operational files whose memory rows the store sends too (store.js#dbPlace). */
const SENT = /^guilds\/[^/]+\/(?:participation|media)\.json$/;
/** Written after the rest: an archived item that is no hot claim needs the hot claims in first, as do the links. */
const LATE_KINDS = new Set(['archive', 'participation', 'vectors']);

/** Every file under `dir`, relative with forward slashes, in name order. */
function walk(dir, rel = '', out = []) {
  let entries = [];
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

/** The memory units of a data directory: [{ owner, kind, format, files }] (a month of vectors is one unit). */
export function unitsOf(dataDir) {
  const units = new Map();
  for (const rel of walk(dataDir)) {
    if (!rel.startsWith('guilds/') || (isOperational(rel) && !SENT.test(rel))) continue;
    // A data directory of an older release names the errand units `tasks.json` and `tasks.jsonl`: they are the current units.
    const info = classify(currentUnitPath(rel));
    if (!info || info.skipped || info.guildId === undefined) continue;
    if (info.kind === 'requests' || info.format === 'text') continue;
    if (info.format === 'jsonl' && !LINE_KINDS.has(info.kind)) continue;
    const owner = `guilds/${info.guildId}/${info.unit}`;
    if (!units.has(owner)) units.set(owner, { owner, kind: info.kind, format: info.format, files: [] });
    units.get(owner).files.push(rel);
  }
  return [...units.values()].sort((a, b) => Number(LATE_KINDS.has(a.kind)) - Number(LATE_KINDS.has(b.kind)) || (a.owner < b.owner ? -1 : 1));
}

/** One month of vectors from its files: `{ manifest, meta, i8 }` of its manifest's generation. */
function vectorMonth(dataDir, owner) {
  const dir = path.join(dataDir, owner);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const meta = fs.readFileSync(path.join(dir, `${manifest.gen}.jsonl`), 'utf8').slice(0, manifest.metaBytes);
  const i8 = fs.readFileSync(path.join(dir, `${manifest.gen}.i8`)).subarray(0, manifest.bytes);
  return { manifest, meta, i8 };
}

/** One unit as the writers take it: a month of vectors whole, a JSONL unit's lines, a JSON unit's value. */
function updateOf(dataDir, unit) {
  if (unit.format === 'vectors') return { op: 'vectors', owner: unit.owner, value: vectorMonth(dataDir, unit.owner) };
  if (unit.format === 'jsonl') {
    const lines = fs.readFileSync(path.join(dataDir, unit.files[0]), 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    return { op: 'lines', owner: unit.owner, lines };
  }
  return { op: 'value', owner: unit.owner, value: JSON.parse(fs.readFileSync(path.join(dataDir, unit.files[0]), 'utf8')) };
}

/** Every memory unit of `dataDir` as the update a service's `writeUnit` takes (`{ op, owner, value | lines }`), in order. */
export function unitUpdates(dataDir) {
  return unitsOf(dataDir).map((unit) => updateOf(dataDir, unit));
}

/**
 * Writes every memory unit of `dataDir` into the opened database `handle` (the writer, openMemoryDb). Returns
 * `{ units, errors }`: the units written and the ones a writer refused (each one's code in `codes`). `now` stamps the
 * writes (epoch ms, or a clock).
 * @param {{ db: object, transaction: Function }} handle
 * @param {string} dataDir
 * @param {{ now?: number|(() => number) }} [options]
 */
export function seedUnits(handle, dataDir, { now: clock = Date.parse('2026-10-24T00:00:00.000Z') } = {}) {
  const now = typeof clock === 'function' ? clock() : clock;
  let written = 0;
  const codes = [];
  for (const unit of unitsOf(dataDir)) {
    try {
      applyUnitWrite(handle, { kind: 'unit', ...updateOf(dataDir, unit), now });
      written += 1;
    } catch (error) {
      codes.push(error?.code ?? error?.name ?? 'ERROR');
    }
  }
  fillStems(handle.db);
  projectPending(handle, { at: new Date(now).toISOString() });
  return { units: written, errors: codes.length, codes };
}
