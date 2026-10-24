// The projection manifest of the memory graph (spec 2026-10-24-memory-schema-v7, section 3; section 11 item 5
// overrides it): the graph is wholly derived, the typed tables are the only authority, and this file says, as code,
// which typed table and which columns every node kind and every predicate comes from and by which rule. graph.js
// projects by these entries; tests/memory-db-graph.test.js enumerates them against the schema (every table and column
// named here exists). Pure data, no I/O.
//
// Node ids are `<kind>:<row id>` (graph.js#graphNodeId), so two tables that happen to share a row id never share a
// node; `graph_nodes.row_id` keeps the typed row's id, so nobody parses a node id.
//
// A projection unit is the set of typed rows one call projects together: a row and the child rows that hang off it
// (a claim with its versions and its evidence, a source with its relations, an account with its person links). Every
// edge records the unit that produced it (`owner_key`, `<unit table>:<id>`), so a changed unit retires exactly the
// edges it no longer produces. `UNIT_OF` maps every projected table to its unit.
//
// Audiences (the rule the manifest names per entry): an edge carries the audience of the row it came from; an identity
// link takes the audience of its evidence source when it has one, else the audience of the account's place (an
// account lives in its interface: the group of that interface; a participant lives in its scope place), else internal;
// a membership takes the audience of its place; a publication (schema v10) once sent takes the audience of its
// destination place (the diary entry's when it names none), and before that is internal. A place's own audience is its conversation's (`dm` -> its DM audience,
// `group` -> the group of its interface, a container such as a server -> the group of its interface, anything else
// internal). `node_access` holds one witness per (node, audience, evidence): a node with its own audience (a source, a
// claim, ...) witnesses itself; every live edge witnesses both of its ends with its own audience.

/** Kinds of nodes whose table is not built yet: listed so the manifest is the whole spec list, projected by nothing. */
export const DEFERRED = Object.freeze({
  skill: 'the skills registry (table `skills`, schema v11): projected once the improvement wake reads it (its own spec)',
});

/**
 * Node kinds: `table` (the typed table), `key` (its id column), `created` (the column the node's `created_at` comes
 * from, then `createdFallback`; `ms` when the column holds milliseconds; none: the epoch), `audience` (the row's own
 * audience column, or `inherits: [table, column]` for a child row read with its parent's audience; no audience: the
 * node is seen only through its edges), `retired` (the column that retires it).
 */
export const NODE_KINDS = Object.freeze({
  interface: { table: 'interfaces', key: 'id' },
  authority: { table: 'authorities', key: 'id' },
  person: { table: 'people', key: 'id', created: 'first_seen_at', retired: 'retired_at' },
  account: { table: 'accounts', key: 'id', retired: 'retired_at' },
  participant: { table: 'participants', key: 'id', created: 'first_seen_at', createdFallback: 'recorded_at' },
  place: { table: 'places', key: 'id', created: 'seen_from_at', retired: 'retired_at' },
  membership: { table: 'memberships', key: 'id', created: 'valid_from_at', retired: 'retired_at' },
  source: { table: 'sources', key: 'id', created: 'occurred_at', createdFallback: 'recorded_at', audience: 'audience_id', retired: 'retired_at' },
  claim: { table: 'claims', key: 'id', created: 'created_at', createdFallback: 'first_seen_at', audience: 'audience_id', retired: 'retired_at' },
  claim_version: { table: 'claim_versions', key: 'id', created: 'recorded_at', inherits: ['claims', 'claim_id'], retired: 'retired_at' },
  description: { table: 'descriptions', key: 'id', audience: 'audience_id', retired: 'retired_at' },
  description_version: { table: 'description_versions', key: 'id', created: 'written_at', inherits: ['descriptions', 'description_id'], retired: 'retired_at' },
  episode: { table: 'episodes', key: 'id', created: 'created_at', audience: 'audience_id', retired: 'retired_at' },
  diary: { table: 'diary', key: 'id', created: 'at_ms', ms: true, audience: 'audience_id', retired: 'retired_at' },
  media: { table: 'media', key: 'id', created: 'described_at', audience: 'audience_id', retired: 'retired_at' },
  intention: { table: 'intentions', key: 'id', created: 'created_ms', ms: true, audience: 'audience_id', retired: 'retired_at' },
  work: { table: 'work', key: 'id', created: 'created_ms', ms: true, audience: 'audience_id', retired: 'retired_at' },
  decision: { table: 'decisions', key: 'id', created: 'at', internal: true, retired: 'retired_at' },
  publication: { table: 'publications', key: 'id', created: 'created_at', retired: 'retired_at' },
  skill: { table: null, deferred: DEFERRED.skill },
});

/**
 * Predicates: `from` and `to` (node kinds), `table` (the typed table the edge comes from) and the `columns` the rule
 * reads, `rule` (in words), `audience` (in words). An entry with `table: null` is in the spec's list and has no typed
 * home yet (`deferred` says where it will come from).
 */
export const PREDICATES = Object.freeze({
  account_of: {
    from: ['account'], to: ['person'], table: 'account_person_links',
    columns: ['account_id', 'person_id', 'state', 'evidence_id', 'valid_from_at', 'valid_to_at', 'recorded_at'],
    rule: 'a verified link projects a live edge with its validity window; a revoked link projects the edge retired at its end (or its recording); a proposed link projects nothing',
    audience: 'the evidence source, else the group of the account\'s interface, else internal',
  },
  participant_of: {
    from: ['participant'], to: ['account', 'person'], table: 'participant_links',
    columns: ['participant_id', 'account_id', 'person_id', 'state', 'evidence_id', 'valid_from_at', 'valid_to_at', 'recorded_at'],
    rule: 'as account_of, to the account or the person the link names',
    audience: 'the evidence source, else the participant\'s scope place, else internal',
  },
  has_membership: {
    from: ['account'], to: ['membership'], table: 'memberships', columns: ['account_id', 'valid_from_at', 'valid_to_at', 'retired_at'],
    rule: 'every membership row, retired with it', audience: 'the membership\'s place',
  },
  membership_in: {
    from: ['membership'], to: ['place'], table: 'memberships', columns: ['place_id', 'valid_from_at', 'valid_to_at', 'retired_at'],
    rule: 'every membership row, retired with it', audience: 'the membership\'s place',
  },
  contained_in: {
    from: ['place'], to: ['place'], table: 'places', columns: ['parent_id', 'retired_at'],
    rule: 'a place with a parent (parent_id stays the one authority of containment)', audience: 'the child place',
  },
  continues: {
    from: ['place'], to: ['place'], table: 'places', columns: ['continues_place_id', 'retired_at'],
    rule: 'a place that continues another (a DM that became a group, or the reverse)', audience: 'the continuing place',
  },
  owned_by: { from: ['place'], to: ['account'], table: null, deferred: 'a wall\'s owner (no typed column yet)' },
  authored_by: {
    from: ['source'], to: ['account', 'participant', 'person'], table: 'sources', columns: ['author_kind', 'author_account', 'author_participant', 'retired_at'],
    rule: 'her own line to her person row, else the participant, else the account', audience: 'the source',
  },
  located_in: { from: ['source'], to: ['place'], table: 'sources', columns: ['place_id', 'retired_at'], rule: 'a source with a place', audience: 'the source' },
  replies_to: {
    from: ['source'], to: ['source'], table: 'source_relations', columns: ['source_id', 'predicate', 'target_source_id', 'recorded_at'],
    rule: 'a relation whose target is a stored source', audience: 'the replying source',
  },
  quotes: { from: ['source'], to: ['source'], table: 'source_relations', columns: ['source_id', 'predicate', 'target_source_id', 'recorded_at'], rule: 'as replies_to', audience: 'the quoting source' },
  reposts: { from: ['source'], to: ['source'], table: 'source_relations', columns: ['source_id', 'predicate', 'target_source_id', 'recorded_at'], rule: 'as replies_to', audience: 'the reposting source' },
  mentions: { from: ['source'], to: ['source'], table: 'source_relations', columns: ['source_id', 'predicate', 'target_source_id', 'recorded_at'], rule: 'as replies_to', audience: 'the mentioning source' },
  follows: { from: ['account'], to: ['account'], table: null, deferred: 'follows between accounts (no typed table yet)' },
  derived_from: {
    from: ['claim', 'claim_version', 'episode'], to: ['source'], table: 'claim_version_sources',
    columns: ['version_id', 'source_id', 'role'], also: { claim_sources: ['claim_id', 'source_id', 'retired_at'], episode_sources: ['episode_id', 'source_id', 'retired_at'] },
    rule: 'a claim version from its sources (either role), a claim from its claim-level sources, an episode from its sources; a retired link projects a retired edge',
    audience: 'the claim or the episode',
  },
  about: {
    from: ['claim', 'episode', 'description'], to: ['person', 'place'], table: 'claims', columns: ['subject_kind', 'subject_id', 'retired_at'],
    also: { episodes: ['subject_id', 'place_id', 'retired_at'], descriptions: ['subject_kind', 'subject_id', 'retired_at'] },
    rule: 'a claim or a description about a person (her own row for `self`) or a place; an episode about its subject and its place', audience: 'the claim, the episode or the description',
  },
  version_of: {
    from: ['claim_version', 'description_version'], to: ['claim', 'description'], table: 'claim_versions', columns: ['claim_id', 'retired_at'],
    also: { description_versions: ['description_id', 'retired_at'] }, rule: 'every version row', audience: 'the claim or the description',
  },
  supersedes: {
    from: ['claim', 'claim_version', 'description_version'], to: ['claim', 'claim_version', 'description_version'], table: 'claim_versions', columns: ['claim_id', 'recorded_at', 'retired_at'],
    also: { claims: ['superseded_by'], description_versions: ['description_id', 'written_at', 'retired_at'] },
    rule: 'each live version supersedes the live version before it (recorded time, then row order); a claim superseded_by another', audience: 'the claim or the description',
  },
  published_as: {
    from: ['diary'], to: ['publication'], table: 'publications', columns: ['row_kind', 'row_id', 'id', 'status', 'destination_place_id', 'created_at', 'retired_at'],
    rule: 'every publication of a diary entry (row kind diary; a diary mirror is one, schema v10)',
    audience: 'a sent publication: its destination place, else the diary entry; one not sent (queued, failed, unknown): internal',
  },
  publication_source: {
    from: ['publication'], to: ['source'], table: 'publications', columns: ['receipts', 'status', 'retired_at'],
    rule: 'each receipt of a sent publication that names a stored line (its native tuple, the first stored revision)', audience: 'as published_as',
  },
});

/** Every projected table and the unit it belongs to: [unit table, the column naming the unit] (null: the row is its own unit). */
export const UNIT_OF = Object.freeze({
  interfaces: null, authorities: null, people: null, accounts: null, participants: null, places: null, memberships: null, sources: null,
  claims: null, descriptions: null, episodes: null, diary: null, publications: null, media: null, intentions: null, work: null, decisions: null,
  account_person_links: ['accounts', 'account_id'],
  participant_links: ['participants', 'participant_id'],
  source_relations: ['sources', 'source_id'],
  claim_versions: ['claims', 'claim_id'],
  claim_sources: ['claims', 'claim_id'],
  claim_version_sources: ['claims', 'version_id'],
  description_versions: ['descriptions', 'description_id'],
  episode_sources: ['episodes', 'episode_id'],
});

/**
 * The unit tables in the order a whole re-projection walks them (nodes of the structural tables first, so an edge to
 * them finds its node; any order gives the same result, this one writes fewer placeholders), and for each the queries
 * of its unit ids: every id its table holds and every id a child table names (a version of a claim that has no row).
 */
export const UNIT_ORDER = Object.freeze([
  'interfaces', 'authorities', 'people', 'accounts', 'participants', 'places', 'memberships', 'sources', 'claims', 'descriptions',
  'episodes', 'diary', 'publications', 'media', 'intentions', 'work', 'decisions',
]);

/** The predicates graph.js projects (the spec list less the deferred ones). */
export const PROJECTED_PREDICATES = Object.freeze(Object.keys(PREDICATES).filter((name) => PREDICATES[name].table !== null));

/** The relation predicates of `source_relations` that are graph predicates (`edits` and `references` are not in the list). */
export const RELATION_EDGES = Object.freeze(['replies_to', 'quotes', 'reposts', 'mentions']);
