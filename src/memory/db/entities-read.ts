// The owner's typed reader of semantic entities, behind `/memory entities list`, `show`, `names` and `relations`
// (src/interface/commands/memory.ts). It reads the records the semantic writer stored and keeps no store of its own. A
// context knows of an entity through a sealed assertion version it may read that names it, recorded before the cutoff. A
// name or an equivalence counts only through a label or same-as version the context selects then, read from that version's
// own arguments. A relation is one assertion version that names the entity in a reference argument; label versions are
// its names. Reading writes nothing. people-read.ts and places-read.ts list the versions that name a person or a place
// through `versionsNaming`.

import { checkLimit, coded, contextBinding, keysetPage, positionOf } from './read-page.ts';
import type { Page } from './read-page.ts';
import { audienceWhere } from './scope.ts';
import type { Context } from './scope.ts';
import { entityDescriptions, followMerges } from './semantic-read.ts';
import { EQUIVALENCE_PREDICATE, LABEL_PREDICATE } from './semantic-registry.ts';
import { labelRowsOf, mergeRowOf, normalizeLabel, selectedVersionsWhere } from './semantic-rows.ts';
import type { SelectedVersion } from './semantic-rows.ts';
import type { SemanticArgument, SemanticLiteral, SemanticRefKind } from './semantic-types.ts';
import type { Db, Row } from './types.ts';

export type EntityName = { text: string; role: string; language: string; versionId: string };
export type EntitySummary = { id: string; kind: string; kindVersion: number; names: Array<EntityName> };
export type EntityFilters = { kind: string | null; name: string | null };
export type EntityDetail =
  | {
      found: true;
      entity: { id: string; kind: string; kindVersion: number; createdAt: string; retiredAt: string | null };
      /** The entity this context takes it to be, through the equivalences it may read; its own id when there are none. */
      canonicalId: string;
      names: Array<EntityName>;
      descriptions: Array<{ versionId: string; field: string; text: string; audienceId: string }>;
    }
  | { found: false; code: 'ENTITY_NOT_FOUND' };
export type RelationMode = 'active' | 'historical';
export type EntityRelation = {
  claimId: string;
  versionId: string;
  predicate: { id: string; version: number };
  assertionKind: string;
  polarity: string;
  truthState: string;
  how: string | null;
  validFrom: string | null;
  validTo: string | null;
  recordedAt: string;
  audienceId: string;
  /** The roles the entity plays in this version. */
  roles: Array<{ role: string; position: number }>;
  arguments: Array<SemanticArgument>;
  evidence: Array<{ sourceId: string; role: string }>;
  dependencies: Array<{ versionId: string; role: string }>;
};

type Cutoff = string | null;

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The SQL of a recording cutoff on the claim version `v`: strictly before, as every owner read pages history. */
const before = (cutoff: Cutoff): { sql: string; params: Array<unknown> } => ({
  sql: '(? IS NULL OR v.recorded_at < ?)',
  params: [cutoff, cutoff],
});

/** The versions of `predicateId` this context selects at the cutoff, in force: current and affirmed, oldest first. */
function inForce(db: Db, context: Context, predicateId: string, cutoff: Cutoff): Array<SelectedVersion> {
  const cut = before(cutoff);
  return selectedVersionsWhere(
    db,
    context,
    { sql: `a.predicate_id = ? AND ${cut.sql}`, params: [predicateId, ...cut.params] },
    null
  )
    .filter((one) => one.truthState === 'current' && one.polarity === 'positive')
    .sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0));
}

/** The names of `entityIds` from the label versions in force, each version's own arguments read. */
function namesOf(
  db: Db,
  labels: ReadonlyArray<SelectedVersion>,
  entityIds: ReadonlySet<string>
): Map<string, Array<EntityName>> {
  const out = new Map<string, Array<EntityName>>();
  for (const label of labels)
    for (const row of labelRowsOf(db, label.versionId)) {
      if (!entityIds.has(row.entity_id)) continue;
      const names = out.get(row.entity_id) ?? [];
      names.push({ text: row.text, role: row.role, language: row.language, versionId: row.version_id });
      out.set(row.entity_id, names);
    }
  return out;
}

/** The entities a name in force fits, the projection only narrowing the versions read. */
function entitiesNamed(db: Db, labels: ReadonlyArray<SelectedVersion>, name: string): Set<string> {
  const normalized = normalizeLabel(name);
  const indexed = new Set(
    db
      .prepare('SELECT DISTINCT version_id FROM semantic_labels WHERE normalized = ?')
      .all(normalized)
      .map((row) => String(row.version_id))
  );
  const out = new Set<string>();
  for (const label of labels) {
    if (!indexed.has(label.versionId)) continue;
    for (const row of labelRowsOf(db, label.versionId)) if (row.normalized === normalized) out.add(row.entity_id);
  }
  return out;
}

/** Whether this context has a witness of the entity before the cutoff. */
function hasWitness(db: Db, context: Context, entityId: string, cutoff: Cutoff): boolean {
  const visible = audienceWhere(context, 'a');
  const cut = before(cutoff);
  const found = db
    .prepare(
      `SELECT 1 AS ok FROM semantic_arguments g JOIN semantic_assertion_versions a ON a.version_id = g.version_id
         JOIN claim_versions v ON v.id = g.version_id
        WHERE g.ref_kind = 'entity' AND g.ref_id = ? AND ${visible.sql} AND ${cut.sql} LIMIT 1`
    )
    .get(entityId, ...visible.params, ...cut.params);
  return found !== undefined;
}

/** Each entity the context knows of at the cutoff, of the kind and name asked for, once and in id order. */
export function listEntities(
  db: Db,
  request: { context: Context; filters: EntityFilters; recordedBefore: Cutoff; limit: number; cursor: string | null }
): Page<EntitySummary> {
  const { context, filters, recordedBefore } = request;
  const binding = { reader: 'entities.list', context: contextBinding(context), filters, recordedBefore };
  const position = positionOf(request.cursor, binding);
  const limit = checkLimit(request.limit);
  const visible = audienceWhere(context, 'a');
  const cut = before(recordedBefore);
  const rows = db
    .prepare(
      `SELECT e.id, e.kind, e.kind_version FROM semantic_entities e
        WHERE (? IS NULL OR e.kind = ?) AND EXISTS (SELECT 1 FROM semantic_arguments g
          JOIN semantic_assertion_versions a ON a.version_id = g.version_id JOIN claim_versions v ON v.id = g.version_id
          WHERE g.ref_kind = 'entity' AND g.ref_id = e.id AND ${visible.sql} AND ${cut.sql})
        ORDER BY e.id`
    )
    .all(filters.kind, filters.kind, ...visible.params, ...cut.params);
  const labels = inForce(db, context, LABEL_PREDICATE, recordedBefore);
  const named = filters.name === null ? null : entitiesNamed(db, labels, filters.name);
  const listed = named === null ? rows : rows.filter((row) => named.has(String(row.id)));
  const rest = typeof position === 'string' ? listed.filter((row) => String(row.id) > position) : listed;
  const page = keysetPage(rest.slice(0, limit + 1), limit, listed.length, binding, (row) => String(row.id));
  const names = namesOf(db, labels, new Set(page.items.map((row) => String(row.id))));
  return {
    ...page,
    items: page.items.map((row) => ({
      id: String(row.id),
      kind: String(row.kind),
      kindVersion: Number(row.kind_version),
      names: names.get(String(row.id)) ?? [],
    })),
  };
}

/** Which entity each entity is taken to be through the equivalences this context selects at the cutoff. */
function mergesInForce(db: Db, context: Context, cutoff: Cutoff): Map<string, string> {
  const out = new Map<string, string>();
  for (const one of inForce(db, context, EQUIVALENCE_PREDICATE, cutoff)) {
    const merge = mergeRowOf(db, one.versionId);
    if (merge !== null) out.set(merge.from_entity_id, merge.into_entity_id);
  }
  return out;
}

/** One entity as stored, with its names, the entity it is taken to be and its descriptions, as far as the context reads. */
export function entityDetail(
  db: Db,
  entityId: string,
  request: { context: Context; recordedBefore: Cutoff }
): EntityDetail {
  const { context, recordedBefore } = request;
  contextBinding(context);
  const row = db.prepare('SELECT * FROM semantic_entities WHERE id = ?').get(entityId);
  if (row === undefined || !hasWitness(db, context, entityId, recordedBefore))
    return { found: false, code: 'ENTITY_NOT_FOUND' };
  const labels = inForce(db, context, LABEL_PREDICATE, recordedBefore);
  return {
    found: true,
    entity: {
      id: entityId,
      kind: String(row.kind),
      kindVersion: Number(row.kind_version),
      createdAt: String(row.created_at),
      retiredAt: textOrNull(row.retired_at),
    },
    canonicalId: followMerges(mergesInForce(db, context, recordedBefore), entityId),
    names: namesOf(db, labels, new Set([entityId])).get(entityId) ?? [],
    descriptions: entityDescriptions(db, context, entityId),
  };
}

/** The sealed versions this context may read that name `ref` in a reference argument, oldest first. */
export function versionsNaming(
  db: Db,
  context: Context,
  ref: { kind: SemanticRefKind; ids: ReadonlyArray<string> }
): Array<{ versionId: string; audienceId: string }> {
  if (ref.ids.length === 0) return [];
  const visible = audienceWhere(context, 'a');
  return db
    .prepare(
      `SELECT DISTINCT a.version_id, a.audience_id, v.recorded_at, v.rowid FROM semantic_arguments g
         JOIN semantic_assertion_versions a ON a.version_id = g.version_id JOIN claim_versions v ON v.id = g.version_id
        WHERE g.ref_kind = ? AND g.ref_id IN (${ref.ids.map(() => '?').join(', ')}) AND ${visible.sql}
        ORDER BY v.recorded_at, v.rowid`
    )
    .all(ref.kind, ...ref.ids, ...visible.params)
    .map((row) => ({ versionId: String(row.version_id), audienceId: String(row.audience_id) }));
}

// The writer checked each ref kind and literal against the registry before it sealed the version, so a stored argument has
// one of those shapes.
const argumentOf = (row: Row): SemanticArgument =>
  typeof row.ref_kind === 'string'
    ? {
        role: String(row.role),
        position: Number(row.position),
        ref: { kind: row.ref_kind as SemanticRefKind, id: String(row.ref_id) },
      }
    : {
        role: String(row.role),
        position: Number(row.position),
        literal: JSON.parse(String(row.literal_json)) as SemanticLiteral,
      };

/** One relation version whole: its epistemic row, every argument, its evidence and its premises. */
function relationOf(db: Db, versionId: string, entityId: string): EntityRelation {
  const row = db
    .prepare(
      `SELECT a.*, v.claim_id FROM semantic_assertion_versions a
         JOIN claim_versions v ON v.id = a.version_id WHERE a.version_id = ?`
    )
    .get(versionId);
  if (row === undefined) throw new Error(`semantic version ${versionId} vanished during a read`);
  const args = db
    .prepare('SELECT * FROM semantic_arguments WHERE version_id = ? ORDER BY role, position')
    .all(versionId)
    .map(argumentOf);
  return {
    claimId: String(row.claim_id),
    versionId,
    predicate: { id: String(row.predicate_id), version: Number(row.predicate_version) },
    assertionKind: String(row.assertion_kind),
    polarity: String(row.polarity),
    truthState: String(row.truth_state),
    how: textOrNull(row.how),
    validFrom: textOrNull(row.valid_from_at),
    validTo: textOrNull(row.valid_to_at),
    recordedAt: String(row.recorded_at),
    audienceId: String(row.audience_id),
    roles: args.flatMap((one) =>
      'ref' in one && one.ref.kind === 'entity' && one.ref.id === entityId
        ? [{ role: one.role, position: one.position }]
        : []
    ),
    arguments: args,
    evidence: db
      .prepare('SELECT source_id, role FROM claim_version_sources WHERE version_id = ? ORDER BY source_id')
      .all(versionId)
      .map((one) => ({ sourceId: String(one.source_id), role: String(one.role) })),
    dependencies: db
      .prepare(
        'SELECT premise_version_id, role FROM semantic_dependencies WHERE version_id = ? ORDER BY premise_version_id, role'
      )
      .all(versionId)
      .map((one) => ({ versionId: String(one.premise_version_id), role: String(one.role) })),
  };
}

/** The ids of the versions that are relations of the entity in `mode` for this context at the cutoff. */
function relationIds(db: Db, context: Context, entityId: string, mode: RelationMode, cutoff: Cutoff): Array<string> {
  const cut = before(cutoff);
  const naming = `SELECT g.version_id FROM semantic_arguments g WHERE g.ref_kind = 'entity' AND g.ref_id = ?`;
  if (mode === 'historical') {
    const visible = audienceWhere(context, 'a');
    return db
      .prepare(
        `SELECT a.version_id FROM semantic_assertion_versions a JOIN claim_versions v ON v.id = a.version_id
          WHERE a.version_id IN (${naming}) AND a.predicate_id IS NOT ? AND ${visible.sql} AND ${cut.sql}`
      )
      .all(entityId, LABEL_PREDICATE, ...visible.params, ...cut.params)
      .map((row) => String(row.version_id));
  }
  const names = new Set(
    db
      .prepare(naming)
      .all(entityId)
      .map((row) => String(row.version_id))
  );
  return selectedVersionsWhere(
    db,
    context,
    {
      sql: `v.claim_id IN (SELECT n.claim_id FROM claim_versions n WHERE n.id IN (${naming}))
        AND a.predicate_id IS NOT ? AND ${cut.sql}`,
      params: [entityId, LABEL_PREDICATE, ...cut.params],
    },
    null
  )
    .filter((one) => one.truthState !== 'retired' && names.has(one.versionId))
    .map((one) => one.versionId);
}

/** The relations of an entity the context knows of, `active` or `historical`, by page in order of recording. */
export function entityRelations(
  db: Db,
  request: {
    context: Context;
    entityId: string;
    predicates: ReadonlyArray<string> | null;
    mode: RelationMode;
    recordedBefore: Cutoff;
    limit: number;
    cursor: string | null;
  }
): Page<EntityRelation> {
  const { context, entityId, predicates, mode, recordedBefore } = request;
  const binding = {
    reader: 'entities.relations',
    context: contextBinding(context),
    entityId,
    predicates,
    mode,
    recordedBefore,
  };
  const position = positionOf(request.cursor, binding);
  const limit = checkLimit(request.limit);
  if (mode !== 'active' && mode !== 'historical')
    throw coded('INSPECTION_BAD_ARGUMENT', 'a mode is active or historical');
  if (!hasWitness(db, context, entityId, recordedBefore)) throw coded('ENTITY_NOT_FOUND', 'no such entity');
  const all = relationIds(db, context, entityId, mode, recordedBefore)
    .map((id) => relationOf(db, id, entityId))
    .filter((one) => predicates === null || predicates.includes(one.predicate.id))
    .sort((a, b) =>
      a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : a.versionId < b.versionId ? -1 : 1
    );
  // A cursor of this binding holds the key `keysetPage` was given below, so its position is that pair.
  const after = Array.isArray(position) ? (position as [string, string]) : null;
  const rest =
    after === null
      ? all
      : all.filter((one) => one.recordedAt > after[0] || (one.recordedAt === after[0] && one.versionId > after[1]));
  return keysetPage(rest.slice(0, limit + 1), limit, all.length, binding, (one) => [one.recordedAt, one.versionId]);
}
