// The owner's typed detail of each memory family. A detail keeps every stored field exactly and links to the exact records
// around it by id: a claim to all its versions, a version to the source revisions it rests on, a publication to its grant, a
// turn to the versions it read. Retired and internal records open like any other, for a context that may read them. The
// families that have no audience of their own and hold the persona's whole prompt or a delivery's state are the owner's
// alone. Reading writes nothing. src/interface/commands/memory.ts answers the domain routes of `/memory`.

import { rowsWithValue } from './inspection.ts';
import type { InspectionRow } from './inspection.ts';
import { checkLimit, coded, contextBinding, keysetPage, positionOf } from './read-page.ts';
import type { Page } from './read-page.ts';
import { audienceWhere } from './scope.ts';
import type { Context } from './scope.ts';
import type { Db, Row } from './types.ts';

export type DomainFamily =
  | 'sources'
  | 'claims'
  | 'claim_versions'
  | 'descriptions'
  | 'description_versions'
  | 'episodes'
  | 'diary'
  | 'media'
  | 'publications'
  | 'grants'
  | 'sessions'
  | 'requests'
  | 'turns';
export type DomainLink = { family: DomainFamily; id: string; role: string };
export type DomainDetail =
  | { found: true; family: DomainFamily; id: string; rows: Array<InspectionRow>; links: Array<DomainLink> }
  | { found: false; code: 'RECORD_NOT_FOUND' };

type FamilySpec = {
  table: string;
  /** The column that names one record. */
  key: string;
  /** Who reads it: its own `audience_id`, its parent's, or the owner alone. */
  audience: 'own' | 'owner' | { parent: string; through: string };
};

const FAMILIES: Readonly<Record<DomainFamily, FamilySpec>> = {
  sources: { table: 'sources', key: 'id', audience: 'own' },
  claims: { table: 'claims', key: 'id', audience: 'own' },
  claim_versions: { table: 'claim_versions', key: 'id', audience: { parent: 'claims', through: 'claim_id' } },
  descriptions: { table: 'descriptions', key: 'id', audience: 'own' },
  description_versions: {
    table: 'description_versions',
    key: 'id',
    audience: { parent: 'descriptions', through: 'description_id' },
  },
  episodes: { table: 'episodes', key: 'id', audience: 'own' },
  diary: { table: 'diary', key: 'id', audience: 'own' },
  media: { table: 'media', key: 'id', audience: 'own' },
  publications: { table: 'publications', key: 'id', audience: 'owner' },
  grants: { table: 'publication_grants', key: 'id', audience: 'owner' },
  sessions: { table: 'session_runs', key: 'id', audience: 'owner' },
  requests: { table: 'model_requests', key: 'id', audience: 'owner' },
  turns: { table: 'turn_reads', key: 'turn_id', audience: 'owner' },
};

/** The most rows of one record: a turn has one per read. */
const RECORD_ROWS = 100_000;

function specOf(family: DomainFamily): FamilySpec {
  if (!Object.hasOwn(FAMILIES, family)) throw coded('INSPECTION_UNKNOWN_FAMILY', 'no such memory family');
  return FAMILIES[family];
}

/** The FROM and WHERE of the records of a family a context may read. */
function readableFrom(
  spec: FamilySpec,
  context: Context
): { from: string; where: string; params: Array<string> } | null {
  const internal = context.internal === true;
  if (spec.audience === 'owner') return internal ? { from: `${spec.table} t`, where: '1 = 1', params: [] } : null;
  if (spec.audience === 'own') {
    const audience = audienceWhere(context, 't');
    return { from: `${spec.table} t`, where: audience.sql, params: audience.params };
  }
  const audience = audienceWhere(context, 'parent');
  return {
    from: `${spec.table} t JOIN ${spec.audience.parent} parent ON parent.id = t.${spec.audience.through}`,
    where: audience.sql,
    params: audience.params,
  };
}

function mayOpen(db: Db, family: DomainFamily, id: string, context: Context): boolean {
  const spec = FAMILIES[family];
  const readable = readableFrom(spec, context);
  if (readable === null) return false;
  const found = db
    .prepare(`SELECT 1 AS ok FROM ${readable.from} WHERE t.${spec.key} = ? AND ${readable.where} LIMIT 1`)
    .get(id, ...readable.params);
  return found !== undefined;
}

const idsOf = (rows: ReadonlyArray<Row>): Array<string> =>
  rows.filter((row) => typeof row.id === 'string').map((row) => String(row.id));
const linksOf = (rows: ReadonlyArray<Row>, family: DomainFamily, role: string): Array<DomainLink> =>
  idsOf(rows).map((id) => ({ family, id, role }));

function sourceLinks(db: Db, id: string): Array<DomainLink> {
  const self = db.prepare('SELECT kind, iface, native_id FROM sources WHERE id = ?').get(id);
  const revisions =
    typeof self?.native_id === 'string'
      ? db
          .prepare(
            'SELECT id FROM sources WHERE kind = ? AND iface = ? AND native_id = ? AND id <> ? ORDER BY revision'
          )
          .all(self.kind, self.iface, self.native_id, id)
      : [];
  const evidence = db.prepare('SELECT version_id AS id FROM claim_version_sources WHERE source_id = ?').all(id);
  return [...linksOf(revisions, 'sources', 'revision'), ...linksOf(evidence, 'claim_versions', 'evidence')];
}

/** The row kinds `turn_reads` names, as the family that opens each. A claim or description read opens the version it saw. */
const READ_FAMILIES: Readonly<Record<string, { row: DomainFamily; version?: DomainFamily }>> = {
  claim: { row: 'claims', version: 'claim_versions' },
  claims: { row: 'claims', version: 'claim_versions' },
  description: { row: 'descriptions', version: 'description_versions' },
  descriptions: { row: 'descriptions', version: 'description_versions' },
  source: { row: 'sources' },
  sources: { row: 'sources' },
  episode: { row: 'episodes' },
  episodes: { row: 'episodes' },
  diary: { row: 'diary' },
  media: { row: 'media' },
};

function turnLinks(db: Db, id: string): Array<DomainLink> {
  const reads = db
    .prepare('SELECT row_kind, row_id, version_id FROM turn_reads WHERE turn_id = ? ORDER BY ord')
    .all(id);
  const links = reads.flatMap((row): Array<DomainLink> => {
    const family = READ_FAMILIES[String(row.row_kind)];
    if (family === undefined) return [];
    if (family.version !== undefined && typeof row.version_id === 'string')
      return [{ family: family.version, id: row.version_id, role: 'read' }];
    return [{ family: family.row, id: String(row.row_id), role: 'read' }];
  });
  const requests = db.prepare('SELECT id FROM model_requests WHERE turn_id = ? ORDER BY id').all(id);
  return [...links, ...linksOf(requests, 'requests', 'request')];
}

function linksOfRecord(db: Db, family: DomainFamily, id: string): Array<DomainLink> {
  const rows = (sql: string): Array<Row> => db.prepare(sql).all(id);
  switch (family) {
    case 'claims':
      return [
        ...linksOf(
          rows('SELECT id FROM claim_versions WHERE claim_id = ? ORDER BY recorded_at, id'),
          'claim_versions',
          'version'
        ),
        ...linksOf(rows('SELECT source_id AS id FROM claim_sources WHERE claim_id = ?'), 'sources', 'source'),
      ];
    case 'claim_versions':
      return [
        ...linksOf(rows('SELECT claim_id AS id FROM claim_versions WHERE id = ?'), 'claims', 'claim'),
        ...rows('SELECT source_id, role FROM claim_version_sources WHERE version_id = ?').map((row): DomainLink => ({
          family: 'sources',
          id: String(row.source_id),
          role: String(row.role),
        })),
      ];
    case 'sources':
      return sourceLinks(db, id);
    case 'descriptions':
      return linksOf(
        rows('SELECT id FROM description_versions WHERE description_id = ? ORDER BY written_at, id'),
        'description_versions',
        'version'
      );
    case 'description_versions':
      return linksOf(
        rows('SELECT description_id AS id FROM description_versions WHERE id = ?'),
        'descriptions',
        'description'
      );
    case 'episodes':
      return linksOf(rows('SELECT source_id AS id FROM episode_sources WHERE episode_id = ?'), 'sources', 'source');
    case 'diary':
      return linksOf(
        rows("SELECT id FROM publications WHERE row_kind = 'diary' AND row_id = ?"),
        'publications',
        'publication'
      );
    case 'publications':
      return linksOf(rows('SELECT grant_id AS id FROM publications WHERE id = ?'), 'grants', 'grant');
    case 'grants':
      return linksOf(rows('SELECT id FROM publications WHERE grant_id = ?'), 'publications', 'publication');
    case 'turns':
      return turnLinks(db, id);
    case 'media':
    case 'sessions':
    case 'requests':
      return [];
  }
}

/** One record of a family, every column exact, with its links to the exact records around it that the context may open. */
export function domainDetail(db: Db, request: { family: DomainFamily; id: string; context: Context }): DomainDetail {
  const { family, id, context } = request;
  contextBinding(context);
  const spec = specOf(family);
  if (!mayOpen(db, family, id, context)) return { found: false, code: 'RECORD_NOT_FOUND' };
  const seen = new Set<string>();
  const links = linksOfRecord(db, family, id).filter((link) => {
    const key = `${link.role} ${link.family} ${link.id}`;
    if (seen.has(key) || !mayOpen(db, link.family, link.id, context)) return false;
    seen.add(key);
    return true;
  });
  return { found: true, family, id, rows: rowsWithValue(db, spec.table, spec.key, id, RECORD_ROWS), links };
}

/** Each record of a family once across pages, retired and internal ones included, as far as the context may read. */
export function domainList(
  db: Db,
  request: { family: DomainFamily; context: Context; limit: number; cursor: string | null }
): Page<{ family: DomainFamily; id: string }> {
  const { family, context } = request;
  const spec = specOf(family);
  const binding = { reader: 'domain.list', family, context: contextBinding(context) };
  const position = positionOf(request.cursor, binding);
  const limit = checkLimit(request.limit);
  const readable = readableFrom(spec, context);
  if (readable === null) return { items: [], snapshot: '', next: null, total: 0, truncated: false, reason: null };
  const key = `t.${spec.key}`;
  const counted = db
    .prepare(`SELECT COUNT(DISTINCT ${key}) AS n FROM ${readable.from} WHERE ${readable.where}`)
    .get(...readable.params);
  const after = typeof position === 'string' ? `AND ${key} > ?` : '';
  const rows = db
    .prepare(
      `SELECT DISTINCT ${key} AS id FROM ${readable.from} WHERE ${readable.where} ${after} ORDER BY ${key} LIMIT ?`
    )
    .all(...readable.params, ...(after === '' ? [] : [position]), limit + 1);
  const items = rows.map((row) => ({ family, id: String(row.id) }));
  return keysetPage(items, limit, Number(counted?.n), binding, (item) => item.id);
}

/** Every version of a claim or a description in order of recording, each opened whole. */
export function versionsOf(
  db: Db,
  request: { family: 'claims' | 'descriptions'; id: string; context: Context }
):
  | { found: true; id: string; versions: Array<Extract<DomainDetail, { found: true }>> }
  | { found: false; code: 'RECORD_NOT_FOUND' } {
  const { family, id, context } = request;
  contextBinding(context);
  if (!mayOpen(db, family, id, context)) return { found: false, code: 'RECORD_NOT_FOUND' };
  const versions =
    family === 'claims'
      ? db.prepare('SELECT id FROM claim_versions WHERE claim_id = ? ORDER BY recorded_at, id').all(id)
      : db.prepare('SELECT id FROM description_versions WHERE description_id = ? ORDER BY written_at, id').all(id);
  const versionFamily: DomainFamily = family === 'claims' ? 'claim_versions' : 'description_versions';
  const opened = idsOf(versions).flatMap((version) => {
    const detail = domainDetail(db, { family: versionFamily, id: version, context });
    return detail.found ? [detail] : [];
  });
  return { found: true, id, versions: opened };
}
