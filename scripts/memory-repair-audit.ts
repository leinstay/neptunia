#!/usr/bin/env node
// Operations tool: clears what the memory audit (src/memory/db/audit.ts) found on a database written before the writers
// kept these rules. Stop the core before `--apply`: the run takes the writer's lock. Exit 0 done, 1 refused, 2 usage.
//
//   node scripts/memory-repair-audit.ts --db <memory.db> [--apply]
//
// Without `--apply` it opens the database read-only and prints what it would do. A run with nothing to do writes nothing, so
// a second run is harmless. The output is counts only. In one transaction:
//   - every row whose audience is a DM place with a partner person takes that person in `scope_dm`; no audience changes;
//   - the memory session's cursor of that DM, under any key the DM was swept by, moves to the one key of its scope
//     (session-scopes.ts#dmScopeKey): the furthest cursor, because each of them read the whole audience up to its value;
//   - a version whose owner the store deleted (a claim version of event `expired` by `store`, a description version of
//     origin `legacy`) is retired with its bytes kept; a version with no such explanation stays a finding;
//   - a name the owner gave a person, stored with no audience, takes the one the writer gives it (unit-write.ts);
//   - a media row of the groups, stored with no audience by the describer's cache, takes the audience of its groups.

import { rescopeDmPlace } from '../src/memory/db/dm-rescope.ts';
import { projectRow } from '../src/memory/db/graph.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { ensureAudience } from '../src/memory/db/rows.ts';
import { audienceOf, dmAudienceId, groupScope } from '../src/memory/db/scope.ts';
import { SCOPED_TABLES } from '../src/memory/db/schema.ts';
import { dmScopeKey } from '../src/memory/db/session-scopes.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../src/memory/db/types.ts';
import { ownerNameScope } from '../src/memory/db/unit-write.ts';

type Counts = {
  scopeRows: number;
  versionsRetired: number;
  cursorsMoved: number;
  aliases: number;
  mediaAudiences: number;
};
type MetaMove = { from: string; to: string; value: string };

const ORPHAN_CLAIM_VERSIONS = `FROM claim_versions v WHERE v.retired_at IS NULL AND v.event = 'expired' AND v.by = 'store'
  AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.id = v.claim_id)`;
const ORPHAN_DESCRIPTION_VERSIONS = `FROM description_versions v WHERE v.retired_at IS NULL AND v.origin = 'legacy'
  AND NOT EXISTS (SELECT 1 FROM descriptions d WHERE d.id = v.description_id)`;
const UNSCOPED_NAMES = "FROM claims WHERE kind = 'alias' AND author = 'owner' AND audience_id IS NULL";
const UNSCOPED_MEDIA = "FROM media WHERE scope_kind = 'group' AND audience_id IS NULL";
const META_KEY = /^memory_session\.(cursor|pending)\.([^.]+)\.(.+)$/;

const countOf = (db: Db, from: string): number => Number(db.prepare(`SELECT COUNT(*) AS n ${from}`).get()?.n);

const dmPlaces = (db: Db): Array<Row> =>
  db.prepare("SELECT id, iface, partner_person FROM places WHERE chat = 'dm' OR kind = 'dm' ORDER BY id").all();

/** The rows of a DM place whose `scope_dm` is not the partner it names. */
function strayRows(db: Db, place: Row): number {
  if (typeof place.partner_person !== 'string') return 0;
  let found = 0;
  for (const table of SCOPED_TABLES)
    found += Number(
      db
        .prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE audience_id = ? AND scope_dm IS NOT ?`)
        .get(dmAudienceId(place.id), place.partner_person)?.n
    );
  return found;
}

/** Every key a sweep may have kept a DM under: the place, and the person on each spelling of `scope_dm` its lines carry. */
function oldScopeKeys(db: Db, place: Row): Map<string, string> {
  const iface = String(place.iface);
  const to = dmScopeKey(iface, String(place.id));
  const spellings = db
    .prepare('SELECT DISTINCT scope_dm FROM sources WHERE audience_id = ? AND scope_dm IS NOT NULL')
    .all(dmAudienceId(place.id))
    .map((row) => String(row.scope_dm));
  const keys = new Map<string, string>();
  for (const name of [String(place.id), ...spellings]) keys.set(`dm:${iface}:${name}`, to);
  keys.delete(to);
  return keys;
}

/**
 * What moves in `meta`: the cursors and held batches under an old key of a DM. A cursor at the one key takes the furthest
 * value of those it replaces. A held batch keeps its place only when the one key holds none.
 */
function metaMoves(db: Db, places: ReadonlyArray<Row>): Array<MetaMove> {
  const oldKeys = new Map(places.flatMap((place) => [...oldScopeKeys(db, place)]));
  const stored = new Map(
    db
      .prepare(
        "SELECT key, value FROM meta WHERE key LIKE 'memory_session.cursor.%' OR key LIKE 'memory_session.pending.%'"
      )
      .all()
      .map((row): [string, string] => [String(row.key), String(row.value)])
  );
  const moves: Array<MetaMove> = [];
  const furthest = new Map(stored);
  for (const [from, value] of stored) {
    const [, kind, mode, scope] = META_KEY.exec(from) ?? [];
    const toScope = scope === undefined ? undefined : oldKeys.get(scope);
    if (toScope === undefined) continue;
    const to = `memory_session.${String(kind)}.${String(mode)}.${toScope}`;
    const held = furthest.get(to);
    const keeps = held === undefined || (kind === 'cursor' && Number(value) > Number(held));
    if (keeps) furthest.set(to, value);
    moves.push({ from, to, value });
  }
  return moves.map((move) => ({ ...move, value: furthest.get(move.to) ?? move.value }));
}

function plan(db: Db): Counts {
  const places = dmPlaces(db);
  return {
    scopeRows: places.reduce((sum, place) => sum + strayRows(db, place), 0),
    versionsRetired: countOf(db, ORPHAN_CLAIM_VERSIONS) + countOf(db, ORPHAN_DESCRIPTION_VERSIONS),
    cursorsMoved: metaMoves(db, places).length,
    aliases: countOf(db, UNSCOPED_NAMES),
    mediaAudiences: countOf(db, UNSCOPED_MEDIA),
  };
}

function repairNames(db: Db, at: string): void {
  const names = db.prepare(`SELECT id, subject_id ${UNSCOPED_NAMES}`).all();
  const update = db.prepare(
    'UPDATE claims SET scope_kind = ?, scope_iface = ?, scope_dm = ?, audience_id = ? WHERE id = ?'
  );
  for (const name of names) {
    const scope = ownerNameScope(db, String(name.subject_id), null);
    ensureAudience(db, scope, { at });
    update.run(scope.scope_kind, scope.scope_iface, scope.scope_dm, scope.audience_id, name.id);
    projectRow(db, 'claims', { id: name.id }, { at });
  }
}

function repairMedia(db: Db, at: string): void {
  const rows = db.prepare(`SELECT id, scope_iface ${UNSCOPED_MEDIA}`).all();
  const update = db.prepare('UPDATE media SET audience_id = ? WHERE id = ?');
  for (const row of rows) {
    const scope = audienceOf(groupScope(row.scope_iface as string | null));
    ensureAudience(db, scope, { at });
    update.run(scope.audience_id, row.id);
    projectRow(db, 'media', { id: row.id }, { at });
  }
}

function apply(handle: MemoryHandle, at: string): void {
  const db = dbOf(handle);
  handle.transaction(() => {
    const places = dmPlaces(db);
    // The moves read the spellings the lines carry, so they are planned before `scope_dm` changes.
    const moves = metaMoves(db, places);
    for (const place of places)
      if (typeof place.partner_person === 'string') rescopeDmPlace(db, String(place.id), place.partner_person);
    const remove = db.prepare('DELETE FROM meta WHERE key = ?');
    const put = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    for (const move of moves) {
      remove.run(move.from);
      put.run(move.to, move.value);
    }
    for (const orphans of [ORPHAN_CLAIM_VERSIONS, ORPHAN_DESCRIPTION_VERSIONS]) {
      const table = orphans.includes('claim_versions') ? 'claim_versions' : 'description_versions';
      db.prepare(`UPDATE ${table} SET retired_at = ? WHERE id IN (SELECT v.id ${orphans})`).run(at);
    }
    repairNames(db, at);
    repairMedia(db, at);
  });
}

function main(): number {
  const at = process.argv.indexOf('--db');
  const file = at === -1 ? '' : (process.argv[at + 1] ?? '');
  if (file === '') {
    process.stderr.write('usage: memory-repair-audit --db <memory.db> [--apply]\n');
    return 2;
  }
  const write = process.argv.includes('--apply');
  let counts: Counts;
  try {
    const reader = openMemoryDb(file, { readOnly: true });
    try {
      counts = plan(dbOf(reader));
    } finally {
      reader.close();
    }
    if (write && Object.values(counts).some((count) => count > 0)) {
      const writer = openMemoryDb(file);
      try {
        apply(writer, new Date().toISOString());
      } finally {
        writer.close();
      }
    }
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    process.stderr.write(`memory-repair-audit: refused, ${typeof code === 'string' ? code : 'not opened'}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify({ mode: write ? 'apply' : 'dry-run', ...counts })}\n`);
  return 0;
}

process.exit(main());
