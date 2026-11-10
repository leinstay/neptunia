// Reading the names, equivalences and descriptions of semantic entities, and what a changed premise puts up for review. A
// context sees a label or a merge only through a version it may read, at the recording cutoff it asks for. `semantic_labels`
// and `semantic_entity_merges` are rebuildable: a read checks a row against its version's own arguments, so an edited
// cache never becomes a fact. Nothing here decides a truth: the persona's memory writer answers what comes up for review.

import { audienceWhere } from './scope.ts';
import type { Context } from './scope.ts';
import { LABEL_PREDICATE } from './semantic-registry.ts';
import { labelRowsOf, normalizeLabel, selectedVersionsOf, visibleMerges } from './semantic-rows.ts';
import type { SemanticRef } from './semantic-types.ts';
import type { Db, Row } from './types.ts';

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

// ---------- review ----------
