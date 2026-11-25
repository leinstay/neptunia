// What the semantic writer (semantic-write.ts) and reader (semantic-read.ts) share: the two projections an assertion
// version derives (`semantic_labels`, `semantic_entity_merges`) and which versions a context selects at a recording cutoff.
// A context never reads a global parent status: of each claim it sees, it selects the newest version it may read at the
// cutoff, and a private claim forked from a public one takes that one's place only for the context that reads the fork.

import { EQUIVALENCE_PREDICATE, LABEL_PREDICATE } from './semantic-registry.ts';
import { audienceWhere } from './scope.ts';
import type { Context } from './scope.ts';
import type { Db, Row } from './types.ts';

export type LabelRow = {
  version_id: string;
  entity_id: string;
  role: 'name' | 'alias';
  language: string;
  text: string;
  normalized: string;
};
export type MergeRow = { version_id: string; from_entity_id: string; into_entity_id: string };

/** How a label is compared: a name in any case and spacing is the same name, the stored text keeps its own form. */
export const normalizeLabel = (text: string): string =>
  text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

const argumentsOf = (db: Db, versionId: string): Array<Row> =>
  db
    .prepare('SELECT role, ref_kind, ref_id, literal_json FROM semantic_arguments WHERE version_id = ? ORDER BY role')
    .all(versionId);
const literalOf = (row: Row | undefined): unknown =>
  typeof row?.literal_json === 'string' ? (JSON.parse(row.literal_json) as unknown) : undefined;

/** The label rows a label version's own arguments give. */
export function labelRowsOf(db: Db, versionId: string): Array<LabelRow> {
  const rows = argumentsOf(db, versionId);
  const entity = rows.find((row) => row.role === 'entity')?.ref_id;
  const language = literalOf(rows.find((row) => row.role === 'language'));
  if (typeof entity !== 'string' || typeof language !== 'string') return [];
  const out: Array<LabelRow> = [];
  for (const role of ['name', 'alias'] as const) {
    const text = literalOf(rows.find((row) => row.role === role));
    if (typeof text === 'string')
      out.push({
        version_id: versionId,
        entity_id: entity,
        role,
        language,
        text,
        normalized: normalizeLabel(text),
      });
  }
  return out;
}

/** The merge row an equivalence version's own arguments give, or null for a version of one entity. */
export function mergeRowOf(db: Db, versionId: string): MergeRow | null {
  const rows = argumentsOf(db, versionId);
  const from = rows.find((row) => row.role === 'from')?.ref_id;
  const into = rows.find((row) => row.role === 'into')?.ref_id;
  if (typeof from !== 'string' || typeof into !== 'string' || from === into) return null;
  return { version_id: versionId, from_entity_id: from, into_entity_id: into };
}

export function insertLabelRow(db: Db, row: LabelRow): void {
  db.prepare(
    'INSERT INTO semantic_labels (version_id, entity_id, role, language, text, normalized) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(row.version_id, row.entity_id, row.role, row.language, row.text, row.normalized);
}

export function insertMergeRow(db: Db, row: MergeRow): void {
  db.prepare('INSERT INTO semantic_entity_merges (version_id, from_entity_id, into_entity_id) VALUES (?, ?, ?)').run(
    row.version_id,
    row.from_entity_id,
    row.into_entity_id
  );
}

/** The projection rows of one sealed version, inside the writer's transaction. */
export function projectSealedVersion(db: Db, versionId: string, predicateId: string): void {
  if (predicateId === LABEL_PREDICATE) for (const row of labelRowsOf(db, versionId)) insertLabelRow(db, row);
  if (predicateId === EQUIVALENCE_PREDICATE) {
    const merge = mergeRowOf(db, versionId);
    if (merge) insertMergeRow(db, merge);
  }
}

/** A version a context selects: its claim, its own epistemic snapshot and when it was recorded. */
export type SelectedVersion = {
  versionId: string;
  claimId: string;
  truthState: string;
  polarity: string;
  audienceId: string;
  recordedAt: string;
};

/** The claim a fork was derived from, read from the fork's own `extra`. */
function derivedFromOf(extra: unknown): string | null {
  if (typeof extra !== 'string' || extra === '') return null;
  const parsed = JSON.parse(extra) as { derivedFrom?: unknown };
  return typeof parsed.derivedFrom === 'string' ? parsed.derivedFrom : null;
}

/**
 * Of every claim of `claimFilter`, the newest version `ctx` may read at the cutoff. A claim whose private fork the context
 * also reads is left out, because the fork speaks for that context.
 */
export function selectedVersionsWhere(
  db: Db,
  ctx: Context,
  claimFilter: { sql: string; params: Array<unknown> },
  recordedBefore: string | null
): Array<SelectedVersion> {
  const visible = audienceWhere(ctx, 'a');
  const rows = db
    .prepare(
      `SELECT a.version_id, a.truth_state, a.polarity, a.audience_id, v.claim_id, v.recorded_at, c.extra
         FROM semantic_assertion_versions a JOIN claim_versions v ON v.id = a.version_id JOIN claims c ON c.id = v.claim_id
        WHERE ${claimFilter.sql} AND ${visible.sql} AND (? IS NULL OR v.recorded_at <= ?)
        ORDER BY v.recorded_at, v.rowid`
    )
    .all(...claimFilter.params, ...visible.params, recordedBefore, recordedBefore);
  const newest = new Map<string, Row>();
  const replaced = new Set<string>();
  for (const row of rows) {
    newest.set(String(row.claim_id), row);
    const parent = derivedFromOf(row.extra);
    if (parent !== null) replaced.add(parent);
  }
  return [...newest.values()]
    .filter((row) => !replaced.has(String(row.claim_id)))
    .map((row) => ({
      versionId: String(row.version_id),
      claimId: String(row.claim_id),
      truthState: String(row.truth_state),
      polarity: String(row.polarity),
      audienceId: String(row.audience_id),
      recordedAt: String(row.recorded_at),
    }));
}

/** The versions of a predicate that `ctx` selects at the cutoff. */
export const selectedVersionsOf = (
  db: Db,
  ctx: Context,
  predicateId: string,
  recordedBefore: string | null
): Array<SelectedVersion> =>
  selectedVersionsWhere(db, ctx, { sql: 'a.predicate_id = ?', params: [predicateId] }, recordedBefore);

/** Which entity a context takes each entity to be: `from` to `into`, from the equivalences in force for it at the cutoff. */
export function visibleMerges(db: Db, ctx: Context, recordedBefore: string | null): Map<string, string> {
  const out = new Map<string, string>();
  const merge = db.prepare('SELECT from_entity_id, into_entity_id FROM semantic_entity_merges WHERE version_id = ?');
  for (const selected of selectedVersionsOf(db, ctx, EQUIVALENCE_PREDICATE, recordedBefore)) {
    if (selected.truthState !== 'current' || selected.polarity !== 'positive') continue;
    const row = merge.get(selected.versionId);
    if (row) out.set(String(row.from_entity_id), String(row.into_entity_id));
  }
  return out;
}

/** Whether a stored entity has a witness `ctx` may read: an assertion version that names it. */
export function entityWitnesses(db: Db, ctx: Context, entityId: string, recordedBefore: string | null): Array<string> {
  const visible = audienceWhere(ctx, 'a');
  return db
    .prepare(
      `SELECT DISTINCT a.audience_id FROM semantic_arguments g
         JOIN semantic_assertion_versions a ON a.version_id = g.version_id
         JOIN claim_versions v ON v.id = g.version_id
        WHERE g.ref_kind = 'entity' AND g.ref_id = ? AND ${visible.sql} AND (? IS NULL OR v.recorded_at <= ?)`
    )
    .all(entityId, ...visible.params, recordedBefore, recordedBefore)
    .map((row) => String(row.audience_id));
}
