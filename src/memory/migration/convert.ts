// The one offline rebuild of a shipped database into the neutral places (plan 2026-11-04-cli-and-memory, S0 and S10). It reads
// a closed database through a private copy, builds an empty database of the current schema and carries every row over: a
// community partition becomes the account, DM place, place or persona its collection belongs to, and everything that names
// one follows it. Nothing is ever written to the input, and an output appears only when every check passed.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { unitRows } from '../db/export.ts';
import { MAPPERS } from '../db/map/index.ts';
import { migrateMediaStore } from '../db/media-store.ts';
import { renameToSelfreflection } from './selfreflection-names.ts';
import { MIGRATIONS, lockPathOf, openMemoryDb, schemaVersion } from '../db/open.ts';
import { manifestOfFiles } from '../db/readers/vectors.ts';
import { keyText, storageId } from '../db/storage-keys.ts';
import { ensureUnit } from '../db/storage-units.ts';
import type { StorageKey } from '../db/storage-keys.ts';
import { asText, dbOf } from '../db/types.ts';
import { monthChecksum } from '../vectors.ts';
import { convertConfig } from './convert-config.ts';
import type { ConfigReport } from './convert-config.ts';
import { neutralJson, neutralKey, neutralScope, personaDayPlan } from './convert-map.ts';
import { planDmRepair } from './dm-repair.ts';
import type { DmRepair } from './dm-repair.ts';

type Row = Record<string, unknown>;
type Db = InstanceType<typeof DatabaseSync>;

/** The one shipped schema this conversion reads. */
const SOURCE_VERSION = 28;
/** Rows carried byte for byte: what a request or a delivery said is history. */
const WHOLE_TABLES = new Set([
  'model_requests',
  'execution_contexts',
  'publications',
  'publication_grants',
  'mirrors',
  'selfreflection_mirrors',
]);
/** The columns that hold a JSON value of the engine's own. */
const JSON_COLUMNS = new Set(['extra', 'value', 'record', 'payload', 'metadata', 'context', 'turn', 'data', 'held']);
/** Line tables whose `position` counts inside one unit, so two partitions of one unit must not collide. */
const POSITIONED = [
  'sources',
  'day',
  'decisions',
  'claims',
  'claim_versions',
  'description_versions',
  'vectors',
  'intentions',
];

export type Counts = {
  input: number;
  preserved: number;
  transformed: number;
  merged: number;
  removed: number;
  added: number;
  output: number;
};
export type Failure = { code: string; table?: string; id?: string };
export type ConversionManifest = {
  convertedAt: string;
  input: { sha256: string | null; schemaVersion: number | null };
  output: { schemaVersion: number | null };
  changed: boolean;
  contentHash: string | null;
  tables: Record<string, Counts>;
  contradictions: Array<{ table: string; ids: Array<string> }>;
  failures: Array<Failure>;
  config: ConfigReport;
  /** The rows a shipped engine filed under a group that the conversion moved to their DM's scope, per table. */
  movedToDm: Record<string, number>;
};
export type ConversionOptions = {
  input: string;
  output: string;
  configIn: string;
  configOut: string;
  report: string;
  now: string;
};

/** Everything the conversion writes holds her memory or names her people. */
const OWNER_FILE = 0o600;
const OWNER_FOLDER = 0o700;

const emptyCounts = (): Counts => ({
  input: 0,
  preserved: 0,
  transformed: 0,
  merged: 0,
  removed: 0,
  added: 0,
  output: 0,
});
const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const sha256 = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** The ordinary tables of a database: no FTS shadow, no sqlite table. */
function tablesOf(db: Db): Array<string> {
  return (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all() as Array<Row>)
    .filter(
      (row) =>
        !/^(sqlite_|sources_(fts|tri)_|media_(fts|tri)_|semantic_search_fts_)/.test(String(row.name)) &&
        !/VIRTUAL/i.test(String(row.sql))
    )
    .map((row) => String(row.name))
    .sort();
}

const columnsOf = (db: Db, table: string): Array<string> =>
  (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<Row>).map((row) => String(row.name));

/** What is wrong with the command's arguments, naming the argument; null when the run may start. */
export function usageProblem(options: ConversionOptions): string | null {
  if (!fs.existsSync(options.input) || !fs.statSync(options.input).isFile()) return '--input names no file';
  if (fs.existsSync(options.configIn) && !fs.statSync(options.configIn).isDirectory())
    return '--config-in names no folder';
  if (Number.isNaN(Date.parse(options.now))) return '--now is no date';
  return null;
}

function refusal(input: string, output: string): Failure | null {
  if (fs.existsSync(output)) return { code: 'TARGET_EXISTS' };
  // An empty log is what a read-only connection leaves behind; frames in it are writes the file does not hold yet.
  if (fs.existsSync(`${input}-wal`) && fs.statSync(`${input}-wal`).size > 0) return { code: 'DATABASE_OPEN' };
  const lock = lockPathOf(input);
  if (!fs.existsSync(lock)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid?: unknown };
    if (typeof parsed.pid !== 'number') return { code: 'DATABASE_OPEN' };
    process.kill(parsed.pid, 0);
    return { code: 'DATABASE_OPEN' };
  } catch (error) {
    return (error as { code?: unknown }).code === 'ESRCH' ? null : { code: 'DATABASE_OPEN' };
  }
}

type UnitPlan = {
  /** Old unit id to new unit id. */
  newId: Map<string, string>;
  /** Old unit id to its new key. */
  newKey: Map<string, StorageKey>;
  /** New unit id to the rows of the old units it holds, ordered by old id. */
  groups: Map<string, Array<Row>>;
  failures: Array<Failure>;
};

function planUnits(source: Db): UnitPlan {
  const plan: UnitPlan = { newId: new Map(), newKey: new Map(), groups: new Map(), failures: [] };
  const dmRows = source
    .prepare("SELECT id, partner_account FROM places WHERE kind = 'dm' OR conversation = 'dm' ORDER BY id")
    .all() as Array<Row>;
  const dmOf = new Map<string, string>();
  for (const row of dmRows)
    if (typeof row.partner_account === 'string' && !dmOf.has(row.partner_account))
      dmOf.set(row.partner_account, String(row.id));
  const dmPlaceOf = (account: string): string | null => dmOf.get(account) ?? null;
  const units = source.prepare('SELECT * FROM storage_units ORDER BY id').all() as Array<Row>;
  for (const unit of units) {
    let old: StorageKey;
    try {
      old = JSON.parse(String(unit.key_json)) as StorageKey;
      if (typeof old?.kind !== 'string' || typeof old.subject?.id !== 'string') throw new Error('shape');
    } catch {
      plan.failures.push({ code: 'BAD_UNIT_KEY', table: 'storage_units', id: String(unit.id) });
      continue;
    }
    const mapped = neutralKey(old, dmPlaceOf, String(unit.id));
    if ('code' in mapped) {
      plan.failures.push({ code: mapped.code, table: 'storage_units', id: mapped.id });
      continue;
    }
    const id = storageId(mapped);
    plan.newId.set(String(unit.id), id);
    plan.newKey.set(String(unit.id), mapped);
    plan.groups.set(id, [...(plan.groups.get(id) ?? []), unit]);
  }
  return plan;
}

/** Every row's owner must be a registered unit: an orphan is refused, never carried. */
function orphanOwners(source: Db): Array<Failure> {
  const known = new Set(
    (source.prepare('SELECT id FROM storage_units').all() as Array<Row>).map((row) => String(row.id))
  );
  const failures: Array<Failure> = [];
  for (const table of tablesOf(source)) {
    if (!columnsOf(source, table).includes('owner_key')) continue;
    const rows = source
      .prepare(`SELECT DISTINCT owner_key FROM ${quote(table)} WHERE owner_key LIKE 'unit:%'`)
      .all() as Array<Row>;
    for (const row of rows) {
      if (!known.has(String(row.owner_key))) failures.push({ code: 'ORPHAN_OWNER', table, id: String(row.owner_key) });
    }
  }
  return failures;
}

/** Per merged unit and line table, how far its positions move so two partitions stay in their order. */
function positionOffsets(source: Db, plan: UnitPlan): Map<string, number> {
  const offsets = new Map<string, number>();
  for (const units of plan.groups.values()) {
    if (units.length < 2) continue;
    for (const table of POSITIONED) {
      if (!columnsOf(source, table).includes('position')) continue;
      let next = 0;
      for (const unit of units) {
        offsets.set(`${table}\u0000${String(unit.id)}`, next);
        const top = source
          .prepare(`SELECT MAX(position) AS top FROM ${quote(table)} WHERE owner_key = ?`)
          .get(String(unit.id)) as Row;
        next += typeof top.top === 'number' ? top.top + 1 : 0;
      }
    }
  }
  return offsets;
}

function parsed(text: unknown): unknown {
  if (typeof text !== 'string' || (text[0] !== '{' && text[0] !== '[')) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

type Context = {
  plan: UnitPlan;
  offsets: Map<string, number>;
  iface: string;
  dmPlaceOf: (account: string) => string | null;
  repair: DmRepair;
  /** The next free position of a unit in a line table, for a row moved into it. */
  nextPosition: (unit: string, table: string) => number;
};

/** The JSON columns of a row with the old identifiers gone. */
function neutralColumns(table: string, row: Row, out: Row, owner: string | null, ctx: Context): void {
  for (const column of Object.keys(row)) {
    if (!JSON_COLUMNS.has(column)) continue;
    const value = parsed(row[column]);
    if (value === undefined) continue;
    const next = neutralValue(table, value, owner === null ? undefined : ctx.plan.newKey.get(owner), ctx);
    const text = JSON.stringify(next);
    if (text !== JSON.stringify(value)) out[column] = text;
  }
}

/** One row of `table` as the target holds it. */
function carried(table: string, row: Row, ctx: Context): Row {
  if (WHOLE_TABLES.has(table)) {
    const owner = row.owner_key;
    return typeof owner === 'string' && ctx.plan.newId.has(owner)
      ? { ...row, owner_key: ctx.plan.newId.get(owner) }
      : row;
  }
  const out: Row = { ...row };
  const owner = typeof row.owner_key === 'string' ? row.owner_key : null;
  if (owner !== null && ctx.plan.newId.has(owner)) out.owner_key = ctx.plan.newId.get(owner);
  if (owner !== null && typeof row.position === 'number') {
    const offset = ctx.offsets.get(`${table}\u0000${owner}`);
    if (offset !== undefined) out.position = row.position + offset;
  }
  neutralColumns(table, row, out, owner, ctx);
  const neutral = { ...out, ...renamedFields(table, row, ctx) };
  return { ...neutral, ...ctx.repair.moved(table, neutral, ctx.nextPosition) };
}

/** The stored words of one row that the neutral schema spells otherwise. */
function renamedFields(table: string, row: Row, ctx: Context): Row {
  const unit = (id: unknown): unknown =>
    typeof id === 'string' && ctx.plan.newId.has(id) ? ctx.plan.newId.get(id) : id;
  if (table === 'places') return row.kind === 'guild' ? { kind: 'server' } : {};
  if (table === 'operational')
    return {
      kind: row.kind === 'guild' ? 'place' : row.kind,
      owner: unit(row.owner),
      ...(row.kind === 'state' ? { value: JSON.stringify(personaDayPlan(neutralJson(parsed(row.value)))) } : {}),
    };
  if (table === 'legacy_unit_aliases') return { unit_id: unit(row.unit_id) };
  if (table === 'wakes') return { community: null };
  return {};
}

function neutralValue(table: string, value: unknown, key: StorageKey | undefined, ctx: Context): unknown {
  const scoped = value as { scope?: unknown };
  if (
    table === 'claim_versions' &&
    key !== undefined &&
    scoped !== null &&
    typeof scoped === 'object' &&
    scoped.scope !== null &&
    typeof scoped.scope === 'object'
  ) {
    const scope = neutralScope(scoped.scope as Record<string, unknown>, key, ctx.iface, ctx.dmPlaceOf);
    return neutralJson({ ...(scoped as object), scope });
  }
  return neutralJson(value);
}

const rowsKey = (table: string, row: Row, keyColumns: Array<string>): string =>
  JSON.stringify(keyColumns.map((column) => row[column]));

function primaryKey(db: Db, table: string): Array<string> {
  const info = db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<Row>;
  const key = info
    .filter((row) => Number(row.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((row) => String(row.name));
  return key.length > 0 ? key : info.map((row) => String(row.name));
}

/** The merged rows of one unit group: its first key, the sums of its counts. */
function unitRow(id: string, units: Array<Row>, key: StorageKey): Row {
  const first = units[0];
  const lines = units.map((unit) => unit.lines).filter((value): value is number => typeof value === 'number');
  const synced = units.map((unit) => unit.synced_at).filter((value): value is string => typeof value === 'string');
  const live = units.some((unit) => unit.retired_at === null);
  return {
    ...first,
    id,
    kind: key.kind,
    subject_type: key.subject.type,
    subject_id: key.subject.id,
    scope_place_id: null,
    partition: key.partition ?? null,
    selector: key.selector ? JSON.stringify(key.selector) : null,
    key_json: keyText(key),
    lines: lines.length > 0 ? lines.reduce((sum, value) => sum + value, 0) : null,
    synced_at: synced.sort().at(-1) ?? null,
    retired_at: live ? null : first.retired_at,
  };
}

/** Two descriptions of one subject and field that now share a unit, each saying its own thing. */
function contradictionsOf(source: Db, plan: UnitPlan): Array<{ table: string; ids: Array<string> }> {
  const out: Array<{ table: string; ids: Array<string> }> = [];
  for (const units of plan.groups.values()) {
    if (units.length < 2) continue;
    const owners = units.map((unit) => String(unit.id));
    const marks = owners.map(() => '?').join(',');
    const rows = source
      .prepare(
        `SELECT d.id, d.subject_id, d.field, d.audience_id, v.text FROM descriptions d
         LEFT JOIN description_versions v ON v.id = d.current_version WHERE d.owner_key IN (${marks}) ORDER BY d.id`
      )
      .all(...owners) as Array<Row>;
    const bySlot = new Map<string, Array<Row>>();
    for (const row of rows) {
      const slot = JSON.stringify([row.subject_id, row.field, row.audience_id]);
      bySlot.set(slot, [...(bySlot.get(slot) ?? []), row]);
    }
    for (const group of bySlot.values()) {
      if (group.length > 1 && new Set(group.map((row) => row.text)).size > 1)
        out.push({ table: 'descriptions', ids: group.map((row) => String(row.id)) });
    }
  }
  return out;
}

function hashOf(db: Db): string {
  const hash = createHash('sha256');
  for (const table of tablesOf(db)) {
    const rows = (db.prepare(`SELECT * FROM ${quote(table)}`).all() as Array<Row>)
      .map((row) => JSON.stringify(row))
      .sort();
    hash.update(table);
    for (const row of rows) hash.update(row);
  }
  return hash.digest('hex');
}

/** Hands out, per unit and line table, the positions after every row the input's units hold there. */
function positionsAfter(
  source: Db,
  plan: UnitPlan,
  offsets: Map<string, number>
): (unit: string, table: string) => number {
  const next = new Map<string, number>();
  return (unit, table) => {
    const key = `${table}\u0000${unit}`;
    let free = next.get(key);
    if (free === undefined) {
      free = 0;
      for (const old of plan.groups.get(unit) ?? []) {
        const id = String(old.id);
        const top = source
          .prepare(`SELECT MAX(position) AS top FROM ${quote(table)} WHERE owner_key = ?`)
          .get(id) as Row;
        if (typeof top.top === 'number') free = Math.max(free, top.top + (offsets.get(`${table}\u0000${id}`) ?? 0) + 1);
      }
    }
    next.set(key, free + 1);
    return free;
  };
}

/**
 * What the moved rows need beside them: the units and audiences the input did not hold, and each unit's line count past
 * its last position, so the next append lands after them.
 */
function settleRepair(target: Db, repair: DmRepair, tables: Record<string, Counts>): void {
  for (const [id, key] of repair.units) {
    if (ensuredUnit(target, id, key)) {
      tables.storage_units.added += 1;
      tables.storage_units.output += 1;
    }
    for (const table of ['sources', 'day']) {
      target
        .prepare(
          `UPDATE storage_units SET lines = MAX(COALESCE(lines, 0),
             COALESCE((SELECT MAX(position) + 1 FROM ${quote(table)} WHERE owner_key = ?), 0)) WHERE id = ?`
        )
        .run(id, id);
    }
  }
  const insert = target.prepare("INSERT OR IGNORE INTO audiences (id, kind, iface, place_id) VALUES (?, 'dm', ?, ?)");
  for (const [id, home] of repair.audiences) {
    if (insert.run(id, home.iface, home.place).changes === 0) continue;
    tables.audiences.added += 1;
    tables.audiences.output += 1;
  }
}

/**
 * The manifest of every month of vectors counted again. The conversion renames keys inside the stored lines, which changes
 * a month's bytes, and a reader trusts its manifest for them. A month with an evicted row is counted by its reader, and one
 * kept raw or with a tail holds bytes the rows do not.
 */
function settleVectorManifests(target: Db, tables: Record<string, Counts>): void {
  const months = target
    .prepare("SELECT id, key_json FROM storage_units WHERE kind = 'vectors' AND retired_at IS NULL")
    .all() as Array<Row>;
  const update = target.prepare("UPDATE operational SET value = ? WHERE kind = 'vectors' AND owner_key = ?");
  for (const month of months) {
    const rows = unitRows(target, JSON.parse(String(month.key_json)) as StorageKey);
    const stored = JSON.parse(asText(rows.operational[0]?.value ?? '{}')) as {
      manifest?: Row;
      raw?: unknown;
      tailI8?: unknown;
    };
    if (!stored.manifest || stored.raw || stored.tailI8) continue;
    if (rows.vectors.some((row) => row.bytes === null)) continue;
    const files = MAPPERS.vectors.fromRows(rows) as { meta: string; i8: Buffer };
    const manifest = manifestOfFiles(
      stored.manifest,
      rows.vectors.length,
      files.i8,
      Buffer.from(files.meta, 'utf8'),
      monthChecksum
    );
    if (JSON.stringify(manifest) === JSON.stringify(stored.manifest)) continue;
    update.run(JSON.stringify({ ...stored, manifest }), String(month.id));
    tables.operational.preserved -= 1;
    tables.operational.transformed += 1;
  }
}

/** A unit row of `key` in the target; whether it was missing. */
function ensuredUnit(target: Db, id: string, key: StorageKey): boolean {
  if (target.prepare('SELECT 1 FROM storage_units WHERE id = ?').get(id)) return false;
  ensureUnit(target, key);
  return true;
}

/** The rows of the semantic search index's own tables: derived from its documents, so they are only counted. */
function countSemanticShadows(source: Db, target: Db, tables: Record<string, Counts>): void {
  const names = target
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'semantic_search_fts_*'")
    .all() as Array<Row>;
  const count = (db: Db, name: string): number =>
    Number((db.prepare(`SELECT COUNT(*) AS n FROM ${quote(name)}`).get() as Row).n);
  const inSource = source.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
  for (const row of names) {
    const name = String(row.name);
    const held = count(target, name);
    tables[name] = inSource.get(name)
      ? { ...emptyCounts(), input: count(source, name), preserved: held, output: held }
      : { ...emptyCounts(), added: held, output: held };
  }
}

/** The guards of sealed semantic versions: lifted while rows are carried, because each sealed row arrives whole. */
function liftSemanticGuards(target: Db): () => void {
  const guards = target
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'semantic_*_no_*'")
    .all() as Array<Row>;
  for (const guard of guards) target.exec(`DROP TRIGGER ${quote(String(guard.name))}`);
  return () => {
    for (const guard of guards) target.exec(String(guard.sql));
  };
}

/**
 * Carries every row of `source` into the empty `target`, and answers what happened to each table. A table of the current
 * schema that the input does not hold (the semantic tables of a shipped v28) keeps what the migrations gave it: the
 * registry's first versions, counted as added, and no semantic row, because the conversion infers nothing from prose.
 */
function copyRows(
  source: Db,
  target: Db,
  plan: UnitPlan,
  repair: DmRepair,
  failures: Array<Failure>
): Record<string, Counts> {
  const dmRows = source
    .prepare("SELECT id, partner_account FROM places WHERE kind = 'dm' OR conversation = 'dm'")
    .all() as Array<Row>;
  const dmOf = new Map(dmRows.map((row) => [String(row.partner_account), String(row.id)]));
  const ifaceRow = source
    .prepare("SELECT iface FROM places WHERE iface IS NOT NULL AND iface <> 'core' LIMIT 1")
    .get() as Row | undefined;
  const offsets = positionOffsets(source, plan);
  const ctx: Context = {
    plan,
    offsets,
    iface: typeof ifaceRow?.iface === 'string' ? ifaceRow.iface : 'discord',
    dmPlaceOf: (account) => dmOf.get(account) ?? null,
    repair,
    nextPosition: positionsAfter(source, plan, offsets),
  };
  const tables: Record<string, Counts> = {};
  const sourceTables = tablesOf(source);
  const targetTables = new Set(tablesOf(target));
  const restoreGuards = liftSemanticGuards(target);
  for (const table of targetTables) {
    if (sourceTables.includes(table)) {
      target.exec(`DELETE FROM ${quote(table)}`);
      continue;
    }
    const held = Number((target.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get() as Row).n);
    tables[table] = { ...emptyCounts(), added: held, output: held };
  }
  for (const table of sourceTables) {
    const counts = emptyCounts();
    tables[table] = counts;
    if (!targetTables.has(table)) {
      failures.push({ code: 'TABLE_NOT_IN_TARGET', table });
      continue;
    }
    const columns = columnsOf(target, table);
    const keyColumns = primaryKey(source, table);
    const rows = source.prepare(`SELECT rowid AS _rowid_, * FROM ${quote(table)} ORDER BY rowid`).all() as Array<Row>;
    counts.input = rows.length;
    const stored = new Map<string, string>();
    const named = columns.map(quote).join(',');
    const insert = target.prepare(
      `INSERT INTO ${quote(table)} (rowid,${named}) VALUES (?,${columns.map(() => '?').join(',')})`
    );
    if (table === 'storage_units') {
      for (const [id, units] of plan.groups) {
        const key = plan.newKey.get(String(units[0].id)) as StorageKey;
        const next = unitRow(id, units, key);
        insert.run(
          (rows.find((row) => row.id === units[0].id) as Row)._rowid_ as number,
          ...(columns.map((c) => next[c]) as Array<string>)
        );
        const same =
          units.length === 1 &&
          units[0].id === id &&
          units[0].key_json === next.key_json &&
          units[0].scope_place_id === null;
        counts[same ? 'preserved' : 'transformed'] += 1;
        counts.merged += units.length - 1;
      }
      counts.output = plan.groups.size;
      continue;
    }
    for (const raw of rows) {
      const { _rowid_: rowid, ...row } = raw;
      const next = carried(table, row, ctx);
      const key = rowsKey(table, next, keyColumns);
      const text = JSON.stringify(columns.map((column) => next[column]));
      const held = stored.get(key);
      if (held !== undefined) {
        if (held === text) counts.merged += 1;
        else failures.push({ code: 'MERGE_CONFLICT', table, id: key });
        continue;
      }
      stored.set(key, text);
      insert.run(rowid as number, ...(columns.map((column) => next[column]) as Array<string>));
      counts[JSON.stringify(row) === JSON.stringify(next) ? 'preserved' : 'transformed'] += 1;
      counts.output += 1;
    }
  }
  const sequences = source.prepare('SELECT name, seq FROM sqlite_sequence').all() as Array<Row>;
  target.exec('DELETE FROM sqlite_sequence');
  const sequence = target.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)');
  for (const row of sequences) sequence.run(String(row.name), Number(row.seq));
  restoreGuards();
  countSemanticShadows(source, target, tables);
  return tables;
}

/** The rows the current schema itself adds: its later versions in `schema_version`. */
function addCurrentVersions(source: Db, target: Db, tables: Record<string, Counts>): void {
  const row = source.prepare('SELECT MAX(version) AS top FROM schema_version').get() as Row;
  const top = Number(row.top);
  const columns = columnsOf(target, 'schema_version');
  const insert = target.prepare(
    `INSERT INTO schema_version (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')})`
  );
  const counts = tables.schema_version;
  const last = source.prepare('SELECT * FROM schema_version WHERE version = ?').get(top) as Row;
  for (let version = top + 1; version <= MIGRATIONS.length; version += 1) {
    insert.run(...(columns.map((column) => (column === 'version' ? version : last[column])) as Array<string>));
    counts.added += 1;
    counts.output += 1;
  }
}

function validate(target: Db, failures: Array<Failure>): void {
  const integrity = target.prepare('PRAGMA integrity_check').get() as Row;
  if (integrity.integrity_check !== 'ok') failures.push({ code: 'INTEGRITY' });
  for (const row of target.prepare('PRAGMA foreign_key_check').all() as Array<Row>)
    failures.push({ code: 'FOREIGN_KEY', table: String(row.table) });
  const known = new Set((target.prepare('SELECT id FROM places').all() as Array<Row>).map((row) => row.id));
  for (const unit of target
    .prepare("SELECT id, subject_id FROM storage_units WHERE subject_type = 'place'")
    .all() as Array<Row>) {
    if (!known.has(unit.subject_id))
      failures.push({ code: 'NO_PLACE_ROW', table: 'storage_units', id: String(unit.id) });
  }
}

/** The report, readable by its owner alone from its first byte, whatever file stood there. */
function writeReport(file: string, manifest: ConversionManifest): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w', OWNER_FILE);
  try {
    fs.fchmodSync(fd, OWNER_FILE);
    fs.writeSync(fd, `${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

/** Every file and folder under `root` readable by its owner alone. */
function ownerOnly(root: string): void {
  if (!fs.statSync(root).isDirectory()) {
    fs.chmodSync(root, OWNER_FILE);
    return;
  }
  fs.chmodSync(root, OWNER_FOLDER);
  for (const name of fs.readdirSync(root)) ownerOnly(path.join(root, name));
}

/** The built database moves into place, the logs SQLite left beside it first. This is the run's last step. */
function publishDatabase(built: string, output: string): void {
  for (const suffix of ['-wal', '-shm']) {
    if (!fs.existsSync(`${built}${suffix}`)) continue;
    ownerOnly(`${built}${suffix}`);
    fs.renameSync(`${built}${suffix}`, `${output}${suffix}`);
  }
  ownerOnly(built);
  fs.renameSync(built, output);
}

/** The rows carried, the checks passed, the config built, the report written and the database moved, in that order. */
function run(options: ConversionOptions, manifest: ConversionManifest, work: string): 0 | 1 {
  const refused = (failures: Array<Failure>): 1 => {
    manifest.failures.push(...failures);
    writeReport(options.report, manifest);
    return 1;
  };
  const copy = path.join(work, 'source.db');
  fs.copyFileSync(options.input, copy);
  const source = new DatabaseSync(copy);
  let target: ReturnType<typeof openMemoryDb> | null = null;
  try {
    const version = schemaVersion(source);
    manifest.input.schemaVersion = version;
    if (version !== SOURCE_VERSION && version !== MIGRATIONS.length) return refused([{ code: 'UNSUPPORTED_SCHEMA' }]);
    // The output is at the current schema, so the working copy takes the names of today and goes to the one media store
    // first: its rows then fit.
    source.exec('BEGIN');
    renameToSelfreflection(source);
    migrateMediaStore(source);
    source.exec('COMMIT');
    const plan = planUnits(source);
    const failures = [...plan.failures, ...orphanOwners(source)];
    if (failures.length > 0) return refused(failures);
    const built = path.join(work, 'memory.db');
    target = openMemoryDb(built);
    const db = dbOf(target) as unknown as Db;
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    const repair = planDmRepair(source);
    manifest.tables = copyRows(source, db, plan, repair, failures);
    settleRepair(db, repair, manifest.tables);
    settleVectorManifests(db, manifest.tables);
    manifest.movedToDm = repair.counts;
    addCurrentVersions(source, db, manifest.tables);
    db.exec('COMMIT');
    validate(db, failures);
    if (failures.length > 0) return refused(failures);
    manifest.contradictions = contradictionsOf(source, plan);
    manifest.contentHash = hashOf(db);
    manifest.output.schemaVersion = schemaVersion(db);
    target.close();
    target = null;
    const builtConfig = path.join(work, 'config');
    manifest.config = convertConfig(options.configIn, builtConfig);
    ownerOnly(builtConfig);
    manifest.changed =
      manifest.config.removed.length + manifest.config.moved.length > 0 ||
      Object.values(manifest.tables).some((counts) => counts.transformed + counts.merged + counts.added > 0);
    writeReport(options.report, manifest);
    fs.mkdirSync(path.dirname(options.configOut), { recursive: true });
    fs.cpSync(builtConfig, options.configOut, { recursive: true });
    ownerOnly(options.configOut);
    publishDatabase(built, options.output);
    return 0;
  } finally {
    target?.close();
    source.close();
  }
}

/** A failed run's report, when it can still be written: its code only, never what the failure quoted. */
function reportFailure(options: ConversionOptions, manifest: ConversionManifest, error: unknown): void {
  const given = (error as { code?: unknown } | null)?.code;
  manifest.failures.push({ code: typeof given === 'string' && given ? given : 'CONVERSION_FAILED' });
  try {
    writeReport(options.report, manifest);
  } catch {
    process.stderr.write(`memory-convert-places: failed with ${manifest.failures.at(-1)?.code}, no report written\n`);
  }
}

/** The whole run. Answers the process exit code: 0 converted, 1 refused or failed with `failures` in the report and no output. */
export function convertFile(options: ConversionOptions): 0 | 1 {
  const manifest: ConversionManifest = {
    convertedAt: options.now,
    input: { sha256: null, schemaVersion: null },
    output: { schemaVersion: null },
    changed: false,
    contentHash: null,
    tables: {},
    contradictions: [],
    failures: [],
    config: { removed: [], moved: [] },
    movedToDm: {},
  };
  let work: string | null = null;
  try {
    const stopped = refusal(options.input, options.output);
    if (fs.existsSync(options.input)) manifest.input.sha256 = sha256(options.input);
    if (stopped) {
      manifest.failures.push(stopped);
      writeReport(options.report, manifest);
      return 1;
    }
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    work = fs.mkdtempSync(path.join(path.dirname(options.output), '.convert-'));
    return run(options, manifest, work);
  } catch (error) {
    reportFailure(options, manifest, error);
    return 1;
  } finally {
    if (work !== null) fs.rmSync(work, { recursive: true, force: true });
  }
}
