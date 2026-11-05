// Schema version 30: the tables of semantic memory, created on the running database by an ordinary forward migration. It
// creates tables and seeds the registry's first versions; no existing row changes. An assertion version is sealed by
// inserting its immutable `semantic_assertion_versions` row after its arguments and premises in one transaction: deferred
// foreign keys refuse an unsealed payload at commit, and the triggers refuse every later change to a sealed version, also
// with `recursive_triggers` off. Label, merge and search rows are rebuildable projections and carry no guard.

import { INITIAL_ENTITY_KINDS, INITIAL_PREDICATES, entityKindJson, predicateJson } from './semantic-registry.ts';
import type { Db } from './types.ts';

/** The time on the seeded registry rows: fixed, so two conversions of one database hash alike. */
const SEEDED_AT = '2026-11-05T00:00:00.000Z';

const SEMANTIC_TABLES = `
CREATE TABLE semantic_entity_kinds (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE TABLE semantic_predicate_versions (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE TABLE semantic_entities (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  kind_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  retired_at TEXT,
  FOREIGN KEY (kind, kind_version) REFERENCES semantic_entity_kinds(id, version)
);
CREATE INDEX semantic_entities_kind ON semantic_entities(kind, kind_version, id);
CREATE TABLE semantic_assertion_versions (
  version_id TEXT PRIMARY KEY NOT NULL REFERENCES claim_versions(id),
  format_version INTEGER NOT NULL CHECK (format_version >= 1),
  assertion_kind TEXT NOT NULL CHECK (assertion_kind IN ('text','label','property','relation','nary')),
  predicate_id TEXT,
  predicate_version INTEGER,
  truth_state TEXT NOT NULL CHECK (truth_state IN ('current','historical','disputed','retired','unknown')),
  how TEXT,
  polarity TEXT NOT NULL CHECK (polarity IN ('positive','negative','unknown')),
  valid_from_at TEXT,
  valid_to_at TEXT,
  recorded_at TEXT NOT NULL,
  audience_id TEXT NOT NULL REFERENCES audiences(id),
  historical_metadata_complete INTEGER NOT NULL CHECK (historical_metadata_complete IN (0,1)),
  FOREIGN KEY (predicate_id, predicate_version) REFERENCES semantic_predicate_versions(id, version),
  CHECK ((assertion_kind = 'text' AND predicate_id IS NULL AND predicate_version IS NULL)
      OR (assertion_kind <> 'text' AND predicate_id IS NOT NULL AND predicate_version IS NOT NULL)),
  CHECK (assertion_kind = 'text' OR polarity <> 'unknown'),
  CHECK (valid_from_at IS NULL OR valid_to_at IS NULL OR valid_from_at <= valid_to_at)
);
CREATE INDEX semantic_assertions_audience ON semantic_assertion_versions(audience_id, recorded_at, version_id);
CREATE INDEX semantic_assertions_predicate ON semantic_assertion_versions(predicate_id, predicate_version, recorded_at);
CREATE TABLE semantic_arguments (
  version_id TEXT NOT NULL REFERENCES semantic_assertion_versions(version_id) DEFERRABLE INITIALLY DEFERRED,
  role TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  ref_kind TEXT,
  ref_id TEXT,
  literal_json TEXT,
  PRIMARY KEY (version_id, role, position),
  CHECK ((ref_kind IS NOT NULL AND ref_id IS NOT NULL AND literal_json IS NULL)
      OR (ref_kind IS NULL AND ref_id IS NULL AND literal_json IS NOT NULL AND json_valid(literal_json)))
);
CREATE INDEX semantic_arguments_ref ON semantic_arguments(ref_kind, ref_id, role, version_id);
CREATE TABLE semantic_dependencies (
  version_id TEXT NOT NULL REFERENCES semantic_assertion_versions(version_id) DEFERRABLE INITIALLY DEFERRED,
  premise_version_id TEXT NOT NULL REFERENCES claim_versions(id),
  role TEXT NOT NULL CHECK (role IN ('supports','conflicts','identity')),
  PRIMARY KEY (version_id, premise_version_id, role),
  CHECK (version_id <> premise_version_id)
);
CREATE INDEX semantic_dependencies_premise ON semantic_dependencies(premise_version_id, version_id);
CREATE TABLE semantic_labels (
  version_id TEXT NOT NULL REFERENCES semantic_assertion_versions(version_id),
  entity_id TEXT NOT NULL REFERENCES semantic_entities(id),
  role TEXT NOT NULL CHECK (role IN ('name','alias')),
  language TEXT NOT NULL,
  text TEXT NOT NULL,
  normalized TEXT NOT NULL,
  PRIMARY KEY (version_id, entity_id, role, language, text)
);
CREATE INDEX semantic_labels_match ON semantic_labels(normalized, language, entity_id, version_id);
CREATE TABLE semantic_entity_merges (
  version_id TEXT PRIMARY KEY NOT NULL REFERENCES semantic_assertion_versions(version_id),
  from_entity_id TEXT NOT NULL REFERENCES semantic_entities(id),
  into_entity_id TEXT NOT NULL REFERENCES semantic_entities(id),
  CHECK (from_entity_id <> into_entity_id)
);
CREATE INDEX semantic_merges_from ON semantic_entity_merges(from_entity_id, version_id);
CREATE INDEX semantic_merges_into ON semantic_entity_merges(into_entity_id, version_id);
CREATE TABLE semantic_search_documents (
  rowid INTEGER PRIMARY KEY,
  document_key TEXT UNIQUE NOT NULL,
  version_id TEXT NOT NULL REFERENCES claim_versions(id),
  ref_kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  audience_id TEXT NOT NULL REFERENCES audiences(id),
  text TEXT NOT NULL,
  projection_version INTEGER NOT NULL CHECK (projection_version >= 1)
);
CREATE INDEX semantic_documents_audience ON semantic_search_documents(audience_id, version_id, rowid);
CREATE INDEX semantic_documents_ref ON semantic_search_documents(ref_kind, ref_id, version_id);
CREATE VIRTUAL TABLE semantic_search_fts USING fts5(
  text, content='semantic_search_documents', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER semantic_documents_insert AFTER INSERT ON semantic_search_documents BEGIN
  INSERT INTO semantic_search_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER semantic_documents_delete AFTER DELETE ON semantic_search_documents BEGIN
  INSERT INTO semantic_search_fts(semantic_search_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER semantic_documents_update AFTER UPDATE OF text ON semantic_search_documents BEGIN
  INSERT INTO semantic_search_fts(semantic_search_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO semantic_search_fts(rowid, text) VALUES (new.rowid, new.text);
END;`;

/** A trigger that refuses one statement, always or when `when` holds. */
const refuse = (name: string, on: string, when: string | null, why: string): string =>
  `CREATE TRIGGER ${name} BEFORE ${on}${when === null ? '' : ` WHEN ${when}`} BEGIN SELECT RAISE(ABORT, '${why}'); END;`;
const sealed = (column: string): string =>
  `EXISTS (SELECT 1 FROM semantic_assertion_versions WHERE version_id = ${column})`;

/** A replacement fires the insert trigger, because a `REPLACE` runs delete triggers only with `recursive_triggers` on. */
const SEMANTIC_GUARDS = [
  refuse(
    'semantic_assertion_no_replace',
    'INSERT ON semantic_assertion_versions',
    sealed('new.version_id'),
    'semantic assertion versions cannot be replaced'
  ),
  refuse(
    'semantic_kind_no_replace',
    'INSERT ON semantic_entity_kinds',
    'EXISTS (SELECT 1 FROM semantic_entity_kinds WHERE id = new.id AND version = new.version)',
    'semantic kind versions cannot be replaced'
  ),
  refuse('semantic_kind_no_update', 'UPDATE ON semantic_entity_kinds', null, 'semantic kind versions are immutable'),
  refuse('semantic_kind_no_delete', 'DELETE ON semantic_entity_kinds', null, 'semantic kind versions are retained'),
  refuse(
    'semantic_predicate_no_replace',
    'INSERT ON semantic_predicate_versions',
    'EXISTS (SELECT 1 FROM semantic_predicate_versions WHERE id = new.id AND version = new.version)',
    'semantic predicate versions cannot be replaced'
  ),
  refuse(
    'semantic_predicate_no_update',
    'UPDATE ON semantic_predicate_versions',
    null,
    'semantic predicate versions are immutable'
  ),
  refuse(
    'semantic_predicate_no_delete',
    'DELETE ON semantic_predicate_versions',
    null,
    'semantic predicate versions are retained'
  ),
  refuse(
    'semantic_claim_no_replace',
    'INSERT ON claim_versions',
    sealed('new.id'),
    'sealed claim versions cannot be replaced'
  ),
  refuse(
    'semantic_claim_no_update',
    'UPDATE ON claim_versions',
    sealed('old.id'),
    'sealed claim versions are immutable'
  ),
  refuse(
    'semantic_claim_no_delete',
    'DELETE ON claim_versions',
    sealed('old.id'),
    'sealed claim versions are retained'
  ),
  refuse(
    'semantic_evidence_no_insert',
    'INSERT ON claim_version_sources',
    sealed('new.version_id'),
    'semantic evidence version is already sealed'
  ),
  refuse(
    'semantic_evidence_no_update',
    'UPDATE ON claim_version_sources',
    'EXISTS (SELECT 1 FROM semantic_assertion_versions WHERE version_id IN (old.version_id, new.version_id))',
    'semantic evidence versions are immutable'
  ),
  refuse(
    'semantic_evidence_no_delete',
    'DELETE ON claim_version_sources',
    sealed('old.version_id'),
    'semantic evidence versions are retained'
  ),
  refuse(
    'semantic_argument_no_late_insert',
    'INSERT ON semantic_arguments',
    sealed('new.version_id'),
    'semantic argument version is already sealed'
  ),
  refuse(
    'semantic_dependency_no_late_insert',
    'INSERT ON semantic_dependencies',
    sealed('new.version_id'),
    'semantic premise version is already sealed'
  ),
  refuse(
    'semantic_assertion_no_update',
    'UPDATE ON semantic_assertion_versions',
    null,
    'semantic assertion versions are immutable'
  ),
  refuse(
    'semantic_assertion_no_delete',
    'DELETE ON semantic_assertion_versions',
    null,
    'semantic assertion versions are retained'
  ),
  refuse(
    'semantic_argument_no_update',
    'UPDATE ON semantic_arguments',
    null,
    'semantic argument versions are immutable'
  ),
  refuse(
    'semantic_argument_no_delete',
    'DELETE ON semantic_arguments',
    null,
    'semantic argument versions are retained'
  ),
  refuse(
    'semantic_dependency_no_update',
    'UPDATE ON semantic_dependencies',
    null,
    'semantic premise versions are immutable'
  ),
  refuse(
    'semantic_dependency_no_delete',
    'DELETE ON semantic_dependencies',
    null,
    'semantic premise versions are retained'
  ),
].join('\n');

/** Version 30: the tables, their guards and the registry's first versions. No row of an older table changes. */
export function migrateSemanticMemory(db: Db): void {
  db.exec(`${SEMANTIC_TABLES}\n${SEMANTIC_GUARDS}`);
  const kind = db.prepare(
    'INSERT INTO semantic_entity_kinds (id, version, definition_json, created_at) VALUES (?, ?, ?, ?)'
  );
  for (const one of INITIAL_ENTITY_KINDS) kind.run(one.id, one.version, entityKindJson(one), SEEDED_AT);
  const predicate = db.prepare(
    'INSERT INTO semantic_predicate_versions (id, version, definition_json, created_at) VALUES (?, ?, ?, ?)'
  );
  for (const one of INITIAL_PREDICATES) predicate.run(one.id, one.version, predicateJson(one), SEEDED_AT);
}
