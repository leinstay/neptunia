// Reading the names, equivalences and descriptions of semantic entities, and what a changed premise puts up for review. A
// context sees a label or a merge only through a version it may read, at the recording cutoff it asks for. `semantic_labels`
// and `semantic_entity_merges` are rebuildable: a read checks a row against its version's own arguments, so an edited
// cache never becomes a fact. Nothing here decides a truth: the persona's memory writer answers what comes up for review.

import { audienceWhere } from './scope.ts';
import type { Context } from './scope.ts';
import { EQUIVALENCE_PREDICATE, LABEL_PREDICATE } from './semantic-registry.ts';
import {
  entityWitnesses,
  insertLabelRow,
  insertMergeRow,
  labelRowsOf,
  mergeRowOf,
  normalizeLabel,
  selectedVersionsOf,
  visibleMerges,
} from './semantic-rows.ts';
import type { SemanticRef } from './semantic-types.ts';
import { dbOf } from './types.ts';
import type { Db, MemoryHandle, Row } from './types.ts';

export type LabelQuery = { text: string; language: string | null; recordedBefore: string | null };
export type LabelCandidate = { ref: SemanticRef; label: string; versionId: string };
export type LabelResolution = { status: 'none' | 'unique' | 'ambiguous'; candidates: Array<LabelCandidate> };
export type EntityLabel = { text: string; role: string; language: string; versionId: string };
type Cutoff = { recordedBefore: string | null };

/** Whether a label row still says what its version's arguments say. */
const labelMatches = (db: Db, row: Row): boolean =>
  labelRowsOf(db, String(row.version_id)).some(
    (one) =>
      one.entity_id === row.entity_id && one.role === row.role && one.text === row.text && one.language === row.language
  );

/** The visible label rows in force at the cutoff: selected, current, affirmed and true to their versions. */
function labelsInForce(db: Db, ctx: Context, rows: ReadonlyArray<Row>, recordedBefore: string | null): Array<Row> {
  const selected = new Set(
    selectedVersionsOf(db, ctx, LABEL_PREDICATE, recordedBefore)
      .filter((one) => one.truthState === 'current' && one.polarity === 'positive')
      .map((one) => one.versionId)
  );
  return rows.filter((row) => selected.has(String(row.version_id)) && labelMatches(db, row));
}

/** Where a chain of visible equivalences from `entityId` ends. */
export function followMerges(merges: ReadonlyMap<string, string>, entityId: string): string {
  const seen = new Set<string>();
  let at = entityId;
  while (!seen.has(at)) {
    seen.add(at);
    const next = merges.get(at);
    if (next === undefined) break;
    at = next;
  }
  return at;
}

/**
 * The entities a name may mean in this context, each once and in id order: popularity never prefers one, a shared name is
 * `ambiguous`, and a read creates nothing. Throws without a valid context.
 */
export function resolveLabel(db: Db, ctx: Context, query: LabelQuery): LabelResolution {
  audienceWhere(ctx);
  const rows = db
    .prepare(
      `SELECT l.version_id, l.entity_id, l.role, l.language, l.text FROM semantic_labels l
        JOIN claim_versions v ON v.id = l.version_id
        WHERE l.normalized = ? AND (? IS NULL OR l.language = ?) ORDER BY v.recorded_at, v.rowid`
    )
    .all(normalizeLabel(query.text), query.language, query.language);
  const merges = visibleMerges(db, ctx, query.recordedBefore);
  const byEntity = new Map<string, LabelCandidate>();
  for (const row of labelsInForce(db, ctx, rows, query.recordedBefore)) {
    const id = followMerges(merges, String(row.entity_id));
    if (!byEntity.has(id))
      byEntity.set(id, {
        ref: { kind: 'entity', id },
        label: String(row.text),
        versionId: String(row.version_id),
      });
  }
  const candidates = [...byEntity.values()].sort((a, b) => (a.ref.id < b.ref.id ? -1 : 1));
  const status = candidates.length === 0 ? 'none' : candidates.length === 1 ? 'unique' : 'ambiguous';
  return { status, candidates };
}

/** The names and aliases of one entity this context may read at the cutoff. */
export function entityLabels(db: Db, ctx: Context, entityId: string, { recordedBefore }: Cutoff): Array<EntityLabel> {
  audienceWhere(ctx);
  const rows = db
    .prepare(
      `SELECT l.version_id, l.entity_id, l.role, l.language, l.text FROM semantic_labels l
        JOIN claim_versions v ON v.id = l.version_id WHERE l.entity_id = ? ORDER BY v.recorded_at, v.rowid`
    )
    .all(entityId);
  return labelsInForce(db, ctx, rows, recordedBefore).map((row) => ({
    text: String(row.text),
    role: String(row.role),
    language: String(row.language),
    versionId: String(row.version_id),
  }));
}

/**
 * The entity this context takes `entityId` to be at the cutoff: the end of its visible equivalences, itself when there are
 * none, null when the context has no witness of it. The stored references keep their original ids.
 */
export function canonicalEntity(db: Db, ctx: Context, entityId: string, { recordedBefore }: Cutoff): string | null {
  if (entityWitnesses(db, ctx, entityId, recordedBefore).length === 0) return null;
  return followMerges(visibleMerges(db, ctx, recordedBefore), entityId);
}

/** The current descriptions of an entity this context may read, one per audience, through the existing description rows. */
export function entityDescriptions(
  db: Db,
  ctx: Context,
  entityId: string
): Array<{ versionId: string; field: string; text: string; audienceId: string }> {
  const visible = audienceWhere(ctx, 'd');
  return db
    .prepare(
      `SELECT d.current_version, d.field, d.audience_id, v.text FROM descriptions d
         JOIN description_versions v ON v.id = d.current_version
        WHERE d.subject_kind = 'entity' AND d.subject_id = ? AND d.retired_at IS NULL AND ${visible.sql} ORDER BY d.id`
    )
    .all(entityId, ...visible.params)
    .map((row) => ({
      versionId: String(row.current_version),
      field: String(row.field),
      text: String(row.text),
      audienceId: String(row.audience_id),
    }));
}

// ---------- the projections ----------

/** Every label and merge row the sealed versions give, in the order they were recorded. */
function expectedRows(db: Db): { labels: Array<ReturnType<typeof labelRowsOf>[number]>; merges: Array<Row> } {
  const versionsOf = (predicate: string): Array<string> =>
    db
      .prepare(
        `SELECT a.version_id FROM semantic_assertion_versions a JOIN claim_versions v ON v.id = a.version_id
          WHERE a.predicate_id = ? ORDER BY v.recorded_at, v.rowid`
      )
      .all(predicate)
      .map((row) => String(row.version_id));
  return {
    labels: versionsOf(LABEL_PREDICATE).flatMap((id) => labelRowsOf(db, id)),
    merges: versionsOf(EQUIVALENCE_PREDICATE).flatMap((id) => mergeRowOf(db, id) ?? []),
  };
}

/** Empties both projections and derives them again from the sealed versions, in one transaction. */
export function rebuildSemanticProjections(handle: MemoryHandle): void {
  const db = dbOf(handle);
  handle.transaction(() => {
    db.exec('DELETE FROM semantic_labels; DELETE FROM semantic_entity_merges;');
    const { labels, merges } = expectedRows(db);
    for (const row of labels) insertLabelRow(db, row);
    for (const row of merges)
      insertMergeRow(db, row as { version_id: string; from_entity_id: string; into_entity_id: string });
  });
}

/** The versions whose stored projection differs from what their arguments give, in either direction. */
export function semanticProjectionMismatches(db: Db): Array<{ table: string; versionId: string }> {
  const { labels, merges } = expectedRows(db);
  const compare = (table: string, expected: ReadonlyArray<Row>, columns: ReadonlyArray<string>) => {
    const key = (row: Row): string => JSON.stringify(columns.map((column) => row[column]));
    const stored = db.prepare(`SELECT * FROM ${table}`).all();
    const held = new Set(stored.map(key));
    const wanted = new Set(expected.map(key));
    const versions = [
      ...expected.filter((row) => !held.has(key(row))),
      ...stored.filter((row) => !wanted.has(key(row))),
    ].map((row) => String(row.version_id));
    return [...new Set(versions)].map((versionId) => ({ table, versionId }));
  };
  return [
    ...compare('semantic_labels', labels, ['version_id', 'entity_id', 'role', 'language', 'text', 'normalized']),
    ...compare('semantic_entity_merges', merges, ['version_id', 'from_entity_id', 'into_entity_id']),
  ];
}

// ---------- review ----------

export type ReviewItem = {
  claimId: string;
  versionId: string;
  premiseVersionId: string;
  changedByVersionId: string;
  path: Array<string>;
};

const NEWEST_OF_CLAIM = `(SELECT n.id FROM claim_versions n WHERE n.claim_id = p.claim_id AND n.retired_at IS NULL
  ORDER BY COALESCE(n.recorded_at, '') DESC, n.rowid DESC LIMIT 1)`;

/**
 * The newest versions that rest, at any depth, on a premise that has a newer version, each with its exact path from itself
 * to that premise. Code only flags: the truth of a dependent stays as it is until the persona's memory writer answers. A
 * dependent the context may not read is not listed and carries no chain further. Bounded by `limit`.
 */
export function assertionsAwaitingReview(db: Db, ctx: Context, { limit }: { limit: number }): Array<ReviewItem> {
  const visible = audienceWhere(ctx, 'a');
  const changed = db
    .prepare(
      `SELECT DISTINCT d.premise_version_id AS premise, ${NEWEST_OF_CLAIM} AS newest
         FROM semantic_dependencies d JOIN claim_versions p ON p.id = d.premise_version_id
        WHERE p.id <> ${NEWEST_OF_CLAIM} ORDER BY premise`
    )
    .all();
  const dependents = db.prepare(
    `SELECT d.version_id, v.claim_id, ${NEWEST_OF_CLAIM.replaceAll('p.claim_id', 'v.claim_id')} AS newest
       FROM semantic_dependencies d JOIN claim_versions v ON v.id = d.version_id
       JOIN semantic_assertion_versions a ON a.version_id = d.version_id
      WHERE d.premise_version_id = ? AND ${visible.sql} ORDER BY v.recorded_at, v.rowid`
  );
  const out: Array<ReviewItem> = [];
  for (const { premise, newest } of changed) {
    const seen = new Set<string>([String(premise)]);
    const frontier: Array<Array<string>> = [[String(premise)]];
    while (frontier.length > 0 && out.length < limit) {
      const path = frontier.shift() as Array<string>;
      for (const row of dependents.all(path[0], ...visible.params)) {
        const id = String(row.version_id);
        if (seen.has(id) || out.length >= limit) continue;
        seen.add(id);
        const longer = [id, ...path];
        frontier.push(longer);
        if (row.newest === id)
          out.push({
            claimId: String(row.claim_id),
            versionId: id,
            premiseVersionId: String(premise),
            changedByVersionId: String(newest),
            path: longer,
          });
      }
    }
  }
  return out;
}
