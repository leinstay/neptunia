// What each table of the engine's schema stores, for the owner's storage catalog (src/memory/db/inspection.ts): `domain` is
// what she knows, its evidence and who it is about, `operational` is state the engine runs on, `derived` can be rebuilt from
// other tables, `metadata` describes the database itself. A table missing here reads like any other and is reported as
// `unclassified`; tests/commands-memory-inspect.test.ts fails until its migration's author classifies it here. A virtual
// table, an FTS shadow and a `sqlite_` table are classed by their kind.

export type StorageClass = 'domain' | 'operational' | 'derived' | 'metadata' | 'unclassified';

const TABLES_BY_CLASS: Readonly<Record<Exclude<StorageClass, 'unclassified'>, ReadonlyArray<string>>> = {
  domain: [
    'account_person_links',
    'accounts',
    'affinity_events',
    'audiences',
    'authorities',
    'claim_sources',
    'claim_version_sources',
    'claim_versions',
    'claims',
    'connections',
    'day',
    'decisions',
    'description_versions',
    'descriptions',
    'selfreflection',
    'selfreflection_mirrors',
    'episode_sources',
    'episodes',
    'execution_contexts',
    'external_keys',
    'intentions',
    'interfaces',
    'media',
    'media_links',
    'memberships',
    'message_families',
    'model_requests',
    'participant_links',
    'participants',
    'people',
    'people_merges',
    'places',
    'semantic_arguments',
    'semantic_assertion_versions',
    'semantic_dependencies',
    'semantic_entities',
    'semantic_entity_kinds',
    'semantic_predicate_versions',
    'source_relations',
    'sources',
    'work',
    'work_events',
  ],
  operational: [
    'board_agent_runs',
    'board_attempts',
    'board_comments',
    'board_dependencies',
    'board_events',
    'board_idempotency',
    'board_outbox',
    'board_questions',
    'board_results',
    'board_reviews',
    'board_tasks',
    'capture_bundles',
    'capture_events',
    'capture_members',
    'capture_watches',
    'co_owners',
    'deliveries',
    'files',
    'focus_events',
    'focus_members',
    'focus_overrides',
    'ingest',
    'ingest_cursor',
    'leases',
    'legacy_unit_aliases',
    'mirrors',
    'operational',
    'publication_grants',
    'publications',
    'relationship_daily',
    'session_runs',
    'skill_evaluations',
    'skill_uses',
    'skill_versions',
    'skills',
    'storage_units',
    'turn_reads',
    'wake_actions',
    'wake_runs',
    'wakes',
  ],
  derived: [
    'graph_edges',
    'graph_nodes',
    'index_policy',
    'node_access',
    'semantic_entity_merges',
    'semantic_labels',
    'semantic_search_documents',
    'vectors',
  ],
  metadata: ['board_schema_version', 'meta', 'schema_version'],
};

const CLASS_OF: ReadonlyMap<string, StorageClass> = new Map(
  Object.entries(TABLES_BY_CLASS).flatMap(([storageClass, tables]) =>
    tables.map((table): [string, StorageClass] => [table, storageClass as StorageClass])
  )
);

/** The class of a table of the given SQLite kind. */
export function storageClassOf(name: string, kind: 'table' | 'virtual' | 'shadow' | 'sqlite'): StorageClass {
  if (kind === 'sqlite') return 'metadata';
  if (kind === 'virtual' || kind === 'shadow') return 'derived';
  return CLASS_OF.get(name) ?? 'unclassified';
}
