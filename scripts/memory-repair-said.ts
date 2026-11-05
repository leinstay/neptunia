#!/usr/bin/env node
// One-off repair of her doubled lines. A `said` line written before the record line resolved its message family stands
// twice: the echo's row under the family's key and a `live` row under the protocol id. `message_families` pairs them
// (`native_key` is the observation row's `native_id`, `message_id` the live row's), and a pair needs equal `text` and
// `occurred_at`. The observation row stays and takes the live row's turn, operation, media and the plain fields of its
// extra. `claim_sources`, `claim_version_sources`, `episode_sources`, `source_relations`, `day` and `vectors` move to it
// with duplicates dropped, and the live row is retired. Capture bundles keep the row they captured, which stays stored.
// Then `recountDaily` runs from RECOUNT_FROM and the unlinked vectors are linked, with no model call.
//
//   node scripts/memory-repair-said.ts --db <memory.db> [--apply]
//
// Without `--apply` the run works on a temporary copy under TMPDIR, removed at the end, so the given file is only read
// and the engine may be running. `--apply` takes the writer's lock and one transaction, so the engine must be stopped.
// A second run changes nothing. The output is counts, never a line of chat.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError, flagText, parseFlags, runCli } from './lib/cli.ts';
import { recountDaily } from '../src/memory/db/focus.ts';
import { projectRow } from '../src/memory/db/graph.ts';
import { parseExtra } from '../src/memory/db/map/common.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { projectPublicationsNaming } from '../src/memory/db/publish.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { linkVectors } from '../src/memory/db/upsert.ts';
import type { Db, MemoryHandle, Row } from '../src/memory/db/types.ts';

const USAGE = 'usage: node scripts/memory-repair-said.ts --db <memory.db> [--apply]';
/** The first day her lines stood twice, the reinstall of the day counts' data. */
const RECOUNT_FROM = '2026-11-04';

export type RepairCounts = {
  pairs: number;
  different: number;
  claimSources: number;
  claimVersionSources: number;
  episodeSources: number;
  relationsRepointed: number;
  relationsCopied: number;
  days: number;
  vectorsMoved: number;
  vectorsRetired: number;
  vectorsLinked: number;
  dailyRows: number;
};

/** One live row and the row of its family. `same` holds when text and time agree. */
type Pair = {
  kept_id: string;
  kept_rowid: number;
  kept_native: string;
  kept_extra: unknown;
  live_id: string;
  live_rowid: number;
  live_extra: unknown;
  turn_id: unknown;
  op_id: unknown;
  live_media: unknown;
  owner_key: unknown;
  position: unknown;
  same: number;
};

function pairsOf(db: Db): Array<Pair> {
  return db
    .prepare(
      `SELECT o.id AS kept_id, o.rowid AS kept_rowid, o.native_id AS kept_native, o.extra AS kept_extra,
         l.id AS live_id, l.rowid AS live_rowid, l.extra AS live_extra, l.turn_id, l.op_id, l.media AS live_media,
         l.owner_key, l.position, (o.text IS l.text AND o.occurred_at IS l.occurred_at) AS same
       FROM message_families f
       JOIN sources l ON l.iface = f.iface AND l.native_id = f.message_id AND l.generation = f.generation
         AND l.kind = 'said' AND l.retired_at IS NULL
       JOIN sources o ON o.authority_id = f.authority_id AND o.native_kind = f.native_kind AND o.native_id = f.native_key
         AND o.generation = f.generation AND o.kind = 'said' AND o.retired_at IS NULL AND o.revision IS l.revision
         AND o.place_id IS l.place_id AND o.id <> l.id
       ORDER BY l.rowid`
    )
    .all() as unknown as Array<Pair>;
}

const holdsMedia = (media: unknown): boolean => typeof media === 'string' && media !== '[]';

/** The kept row's extra: its own engine keys (`$...`) and the live line's plain fields. */
function mergedExtra(pair: Pair): string {
  const live = parseExtra(pair.live_extra);
  const plain = Object.fromEntries(Object.entries(live).filter(([key]) => !key.startsWith('$')));
  return JSON.stringify({ ...live, ...parseExtra(pair.kept_extra), ...plain });
}

function takeLiveFields(db: Db, pair: Pair): void {
  db.prepare(
    `UPDATE sources SET turn_id = COALESCE(?, turn_id), op_id = COALESCE(?, op_id), media = CASE WHEN ? THEN ? ELSE media END,
       origin = 'live', extra = ?, owner_key = COALESCE(owner_key, ?), position = COALESCE(position, ?) WHERE id = ?`
  ).run(
    pair.turn_id,
    pair.op_id,
    holdsMedia(pair.live_media) ? 1 : 0,
    pair.live_media,
    mergedExtra(pair),
    pair.owner_key,
    pair.position,
    pair.kept_id
  );
}

/** Moves the live links of a child table to the kept row; a parent that already cites the kept row drops its live link. */
function moveLinks(db: Db, table: 'claim_sources' | 'episode_sources', parent: string, pair: Pair, at: string): number {
  const links = db
    .prepare(`SELECT rowid AS link, ${parent} AS owner FROM ${table} WHERE source_id = ? AND retired_at IS NULL`)
    .all(pair.live_id);
  for (const { link, owner } of links) {
    const cited = db
      .prepare(`SELECT 1 AS ok FROM ${table} WHERE ${parent} = ? AND source_id = ? AND retired_at IS NULL`)
      .get(owner, pair.kept_id);
    if (cited) db.prepare(`UPDATE ${table} SET retired_at = ? WHERE rowid = ?`).run(at, link);
    else db.prepare(`UPDATE ${table} SET source_id = ? WHERE rowid = ?`).run(pair.kept_id, link);
    projectRow(db, table === 'claim_sources' ? 'claims' : 'episodes', { id: owner }, { at });
  }
  return links.length;
}

function moveVersionLinks(db: Db, pair: Pair, at: string): number {
  const versions = db.prepare('SELECT version_id FROM claim_version_sources WHERE source_id = ?').all(pair.live_id);
  db.prepare('UPDATE OR IGNORE claim_version_sources SET source_id = ? WHERE source_id = ?').run(
    pair.kept_id,
    pair.live_id
  );
  db.prepare('DELETE FROM claim_version_sources WHERE source_id = ?').run(pair.live_id);
  for (const { version_id } of versions) projectRow(db, 'claim_version_sources', { version_id }, { at });
  return versions.length;
}

/** Relations that resolved to the live row move their target to the kept row. */
function repointRelations(db: Db, pair: Pair, at: string): number {
  const relations = db
    .prepare('SELECT id, source_id FROM source_relations WHERE target_source_id = ?')
    .all(pair.live_id);
  db.prepare('UPDATE source_relations SET target_source_id = ? WHERE target_source_id = ?').run(
    pair.kept_id,
    pair.live_id
  );
  for (const { source_id } of relations) projectRow(db, 'sources', { id: source_id }, { at });
  return relations.length;
}

/**
 * Relations are append-only, so the live row's own stay on it and the kept row gets a copy, unless it already holds the
 * same relation under either key, or any reply: the echo's reply names the parent by its family, the line by its id.
 */
function copyRelations(db: Db, pair: Pair): number {
  const held = db.prepare(
    `SELECT 1 AS ok FROM source_relations WHERE source_id = ? AND predicate = ?
     AND (target_key = ? OR target_source_id = ? OR predicate = 'replies_to')`
  );
  const add = db.prepare(
    `INSERT INTO source_relations (source_id, predicate, target_key, target_source_id, recorded_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  let copied = 0;
  for (const row of db.prepare('SELECT * FROM source_relations WHERE source_id = ?').all(pair.live_id)) {
    if (held.get(pair.kept_id, row.predicate, row.target_key, row.target_source_id)) continue;
    add.run(pair.kept_id, row.predicate, row.target_key, row.target_source_id, row.recorded_at, row.resolved_at);
    copied += 1;
  }
  return copied;
}

function moveVectors(db: Db, pair: Pair, at: string): { moved: number; retired: number } {
  const out = { moved: 0, retired: 0 };
  const rows = db
    .prepare('SELECT chunk_key, model FROM vectors WHERE source_rowid = ? AND retired_at IS NULL')
    .all(pair.live_rowid);
  for (const { chunk_key, model } of rows) {
    const held = db
      .prepare('SELECT 1 AS ok FROM vectors WHERE source_rowid = ? AND model IS ? AND retired_at IS NULL')
      .get(pair.kept_rowid, model);
    if (held) {
      db.prepare('UPDATE vectors SET retired_at = ? WHERE chunk_key = ?').run(at, chunk_key);
      out.retired += 1;
    } else {
      db.prepare('UPDATE vectors SET source_rowid = ? WHERE chunk_key = ?').run(pair.kept_rowid, chunk_key);
      out.moved += 1;
    }
  }
  return out;
}

function repairPair(db: Db, pair: Pair, at: string, counts: RepairCounts): void {
  takeLiveFields(db, pair);
  counts.claimSources += moveLinks(db, 'claim_sources', 'claim_id', pair, at);
  counts.episodeSources += moveLinks(db, 'episode_sources', 'episode_id', pair, at);
  counts.claimVersionSources += moveVersionLinks(db, pair, at);
  counts.relationsRepointed += repointRelations(db, pair, at);
  counts.relationsCopied += copyRelations(db, pair);
  counts.days += Number(
    db.prepare('UPDATE day SET source_id = ? WHERE source_id = ?').run(pair.kept_id, pair.live_id).changes
  );
  const vectors = moveVectors(db, pair, at);
  counts.vectorsMoved += vectors.moved;
  counts.vectorsRetired += vectors.retired;
  db.prepare('UPDATE sources SET retired_at = ? WHERE id = ?').run(at, pair.live_id);
  projectRow(db, 'sources', { id: pair.live_id }, { at });
  projectRow(db, 'sources', { id: pair.kept_id }, { at });
  const extra = db.prepare('SELECT extra FROM sources WHERE id = ?').get(pair.kept_id)?.extra;
  projectPublicationsNaming(db, { kind: 'said', native_id: pair.kept_native, extra }, { at });
}

/** Links every vector with no line yet, as a vector write does (upsert.ts#linkVectors). */
function linkUnlinked(db: Db): number {
  const rows: Array<Row> = db
    .prepare('SELECT chunk_key, context, scope_iface FROM vectors WHERE source_rowid IS NULL AND retired_at IS NULL')
    .all();
  linkVectors(db, rows);
  let linked = 0;
  for (const row of rows) {
    if (row.source_rowid === undefined) continue;
    db.prepare('UPDATE vectors SET source_rowid = ? WHERE chunk_key = ?').run(row.source_rowid, row.chunk_key);
    linked += 1;
  }
  return linked;
}

/** The repair, in one transaction on `handle`. `now` is the retirement's time and the recount's last day. */
export function repairSaid(handle: MemoryHandle, { now = Date.now }: { now?: () => number } = {}): RepairCounts {
  return handle.transaction(() => {
    const db = dbOf(handle);
    const at = new Date(now()).toISOString();
    const counts: RepairCounts = {
      pairs: 0,
      different: 0,
      claimSources: 0,
      claimVersionSources: 0,
      episodeSources: 0,
      relationsRepointed: 0,
      relationsCopied: 0,
      days: 0,
      vectorsMoved: 0,
      vectorsRetired: 0,
      vectorsLinked: 0,
      dailyRows: 0,
    };
    for (const pair of pairsOf(db)) {
      if (pair.same !== 1) {
        counts.different += 1;
        continue;
      }
      repairPair(db, pair, at, counts);
      counts.pairs += 1;
    }
    counts.vectorsLinked = linkUnlinked(db);
    counts.dailyRows = recountDaily(db, { from: RECOUNT_FROM, to: now() }).rows;
    return counts;
  });
}

/** The counts of a run on a consistent copy of the file: the given file is opened read-only. */
function repairCopy(file: string): RepairCounts {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-repair-said-'));
  try {
    const copy = path.join(dir, 'memory.db');
    const source = openMemoryDb(file, { readOnly: true });
    try {
      dbOf(source).prepare('VACUUM INTO ?').run(copy);
    } finally {
      source.close();
    }
    const handle = openMemoryDb(copy);
    try {
      return repairSaid(handle);
    } finally {
      handle.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function repairFile(file: string): RepairCounts {
  const handle = openMemoryDb(file);
  try {
    return repairSaid(handle);
  } finally {
    handle.close();
  }
}

/** The whole tool: the counts of the run as lines of text. */
// eslint-disable-next-line @typescript-eslint/require-await -- an async entry rejects on a bad flag, as runCli reads it
export async function main(argv: Array<string>): Promise<string> {
  const flags = parseFlags(argv, { values: ['--db'], switches: ['--apply'], usage: USAGE });
  const file = flagText(flags, '--db');
  if (!file || !fs.existsSync(file)) throw new CliError(USAGE);
  const apply = flags['--apply'] === true;
  const counts = apply ? repairFile(file) : repairCopy(file);
  const lines = Object.entries(counts).map(([name, count]) => `${name} ${String(count)}`);
  return `${[apply ? 'applied' : 'dry run, nothing written', ...lines].join('\n')}\n`;
}

runCli(import.meta.url, main);
