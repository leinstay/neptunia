#!/usr/bin/env node
// Operations tool: brings the self facts stored under `aud:none` to the audience their writer gives them now (the notes of a
// place, src/memory/db/map/place.ts): the groups on a server or channel, the partner's DM on a DM. A row whose place cannot be
// found becomes internal, never shown. A row with a live `decisions` row of `AUDIENCE_NONE_KEPT` stays, and is counted as
// `kept`. Stop the core before `--apply`: the run takes the writer's lock and projects the rows again through the graph's own
// `projectRow`. Exit 0 done, 1 refused, 2 usage.
//
//   node scripts/memory-repair-self-audience.ts --db <memory.db> [--apply]
//
// Without `--apply` it opens the database read-only and prints what it would do. A run with nothing to do writes nothing, so a
// second run is harmless. The output is counts only.

import { AUDIENCE_NONE_KEPT } from '../src/memory/db/audit.ts';
import { projectRow } from '../src/memory/db/graph.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { ensureAudience } from '../src/memory/db/rows.ts';
import { SCOPE_INTERNAL, audienceOf, dmAudienceId, groupScope } from '../src/memory/db/scope.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../src/memory/db/types.ts';

type Counts = { group: number; dm: number; internal: number; kept: number };
type Move = { id: string; to: 'group' | 'dm' | 'internal'; scope: Row };

/** The scope a self fact takes from the notes of `place`: internal with no place to read it from. */
function scopeOfPlace(place: Row | undefined): Pick<Move, 'to' | 'scope'> {
  if (place === undefined) return { to: 'internal', scope: audienceOf(SCOPE_INTERNAL) };
  if (place.conversation === 'dm' || place.kind === 'dm')
    return {
      to: 'dm',
      scope: {
        scope_kind: 'dm',
        scope_iface: place.iface,
        scope_dm: place.partner_person ?? null,
        audience_id: dmAudienceId(String(place.id)),
      },
    };
  return { to: 'group', scope: audienceOf(groupScope(String(place.iface))) };
}

/** What a run would do: the rows to move, and those a recorded reason keeps. */
function plan(db: Db): { moves: Array<Move>; kept: number } {
  const rows = db
    .prepare(
      `SELECT c.id, u.subject_id AS place,
         EXISTS (SELECT 1 FROM decisions r WHERE r.target_kind = 'claims' AND r.target_id = c.id AND r.action = ? AND r.retired_at IS NULL) AS kept
       FROM claims c LEFT JOIN storage_units u ON u.id = c.owner_key
       WHERE c.kind = 'self_fact' AND c.retired_at IS NULL AND c.audience_id = 'aud:none' ORDER BY c.id`
    )
    .all(AUDIENCE_NONE_KEPT);
  const placeOf = db.prepare('SELECT id, iface, kind, conversation, partner_person FROM places WHERE id = ?');
  const moves: Array<Move> = [];
  let kept = 0;
  for (const row of rows) {
    if (row.kept === 1) {
      kept += 1;
      continue;
    }
    const place = typeof row.place === 'string' ? placeOf.get(row.place) : undefined;
    moves.push({ id: String(row.id), ...scopeOfPlace(place) });
  }
  return { moves, kept };
}

function apply(handle: MemoryHandle, moves: ReadonlyArray<Move>): void {
  const db = dbOf(handle);
  const at = new Date().toISOString();
  const update = db.prepare(
    'UPDATE claims SET scope_kind = ?, scope_iface = ?, scope_dm = ?, audience_id = ? WHERE id = ?'
  );
  const witnesses = db.prepare(
    `DELETE FROM node_access WHERE audience_id = 'aud:none' AND node_id IN (SELECT id FROM graph_nodes WHERE row_id = ?)`
  );
  handle.transaction(() => {
    for (const { id, scope } of moves) {
      ensureAudience(db, scope, { at });
      update.run(scope.scope_kind, scope.scope_iface ?? null, scope.scope_dm ?? null, scope.audience_id, id);
      witnesses.run(id);
      projectRow(handle, 'claims', { id }, { at });
    }
  });
}

function main(): number {
  const at = process.argv.indexOf('--db');
  const file = at === -1 ? '' : (process.argv[at + 1] ?? '');
  if (file === '') {
    process.stderr.write('usage: memory-repair-self-audience --db <memory.db> [--apply]\n');
    return 2;
  }
  const write = process.argv.includes('--apply');
  let moves: Array<Move>;
  let kept: number;
  try {
    const reader = openMemoryDb(file, { readOnly: true });
    try {
      ({ moves, kept } = plan(dbOf(reader)));
    } finally {
      reader.close();
    }
    if (write && moves.length > 0) {
      const writer = openMemoryDb(file);
      try {
        apply(writer, moves);
      } finally {
        writer.close();
      }
    }
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    process.stderr.write(`memory-repair-self-audience: refused, ${typeof code === 'string' ? code : 'not opened'}\n`);
    return 1;
  }
  const counts: Counts = { group: 0, dm: 0, internal: 0, kept };
  for (const move of moves) counts[move.to] += 1;
  process.stdout.write(`${JSON.stringify({ ...counts, applied: write })}\n`);
  return 0;
}

process.exit(main());
