// The memory database at the baseline, schema version 43: every table, index and trigger a new database starts with,
// and the seed rows a new install needs. src/memory/db/open.ts creates a new database from it, and the board's own
// migrations (src/board/schema.ts) add the board's tables after it. A database production opened at version 43 holds
// the same objects, which tests/memory-db-baseline.test.ts compares with the version chain. A later change to the
// schema is a step in `MIGRATIONS` of src/memory/db/schema.ts above this version, never an edit of the text below.

import { INITIAL_ENTITY_KINDS, INITIAL_PREDICATES, entityKindJson, predicateJson } from './semantic-registry.ts';
import type { Db } from './types.ts';

/** The schema version a new database starts at. */
export const BASELINE_VERSION = 43;

// One block per table in alphabetical order, each with its indexes and triggers in the order production created them:
// the query planner breaks a tie between two indexes of a table by that order. The texts are production's
// `sqlite_master` at version 43, folded to lines, so a column added by `ALTER TABLE` stands at the end of its table.
const SCHEMA = `
CREATE TABLE account_person_links (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  state TEXT NOT NULL CHECK (state IN ('proposed', 'verified', 'revoked')), by TEXT, reason TEXT, evidence_id TEXT,
  valid_from_at TEXT, valid_to_at TEXT, recorded_at TEXT NOT NULL
);
CREATE INDEX account_person_links_account ON account_person_links(account_id, valid_to_at);
CREATE INDEX account_person_links_person ON account_person_links(person_id);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY, iface TEXT, native_id TEXT, person_id TEXT, link TEXT, linked_by TEXT, linked_at TEXT,
  names JSON, avatar JSON, extra JSON, owner_file TEXT, retired_at TEXT, authority_id TEXT REFERENCES authorities(id),
  native_key TEXT, generation INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'bot', 'shared', 'self')), gone_at TEXT,
  owner_key TEXT REFERENCES storage_units(id)
);
CREATE INDEX accounts_owner ON accounts(owner_file);
CREATE UNIQUE INDEX accounts_native ON accounts(authority_id, native_key, generation) WHERE authority_id IS NOT NULL;
CREATE INDEX "accounts_storage_owner" ON "accounts"(owner_key);

CREATE TABLE affinity_events (
  id TEXT PRIMARY KEY, person_id TEXT, at TEXT, delta REAL, applied REAL, score REAL, reason TEXT, scope_kind TEXT,
  scope_iface TEXT, scope_dm TEXT, extra JSON, owner_file TEXT, position INTEGER, retired_at TEXT,
  audience_id TEXT REFERENCES audiences(id), owner_key TEXT REFERENCES storage_units(id)
);
CREATE INDEX affinity_events_owner ON affinity_events(owner_file);
CREATE INDEX "affinity_events_storage_owner" ON "affinity_events"(owner_key);

CREATE TABLE audiences (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('none', 'internal', 'group', 'dm')),
  iface TEXT REFERENCES interfaces(id), place_id TEXT REFERENCES places(id),
  CHECK ((kind IN ('none', 'internal') AND iface IS NULL AND place_id IS NULL) OR (kind = 'group' AND iface IS NOT NULL AND place_id IS NULL) OR (kind = 'dm' AND iface IS NOT NULL AND place_id IS NOT NULL)),
  CHECK (id = CASE kind WHEN 'none' THEN 'aud:none' WHEN 'internal' THEN 'aud:internal' WHEN 'group' THEN 'aud:group:' || iface ELSE 'aud:dm:' || place_id END)
);
CREATE UNIQUE INDEX audiences_single ON audiences(kind) WHERE kind IN ('none', 'internal');
CREATE UNIQUE INDEX audiences_group ON audiences(iface) WHERE kind = 'group';
CREATE UNIQUE INDEX audiences_dm ON audiences(place_id) WHERE kind = 'dm';

CREATE TABLE authorities (
  id TEXT PRIMARY KEY, iface TEXT NOT NULL REFERENCES interfaces(id), namespace TEXT NOT NULL, name TEXT, extra JSON,
  UNIQUE (iface, namespace)
);

CREATE TABLE capture_bundles (
  id TEXT PRIMARY KEY, anchor_source_id TEXT NOT NULL REFERENCES sources(id),
  place_id TEXT NOT NULL REFERENCES places(id),
  reason TEXT NOT NULL CHECK (reason IN ('own_line', 'mention', 'reply_to_me', 'expansion', 'watch')),
  policy_version INTEGER NOT NULL,
  coverage JSON NOT NULL CHECK (json_valid(coverage) AND json_type(coverage) = 'object' AND json_extract(coverage, '$.state') IN ('complete', 'pending_expansion', 'provider_unavailable', 'incomplete')),
  created_at TEXT NOT NULL, connection_id TEXT
);
CREATE INDEX capture_bundles_anchor ON capture_bundles(anchor_source_id);

CREATE TABLE capture_events (
  id INTEGER PRIMARY KEY, bundle_id TEXT NOT NULL REFERENCES capture_bundles(id), at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('initial', 'expansion', 'watch')),
  coverage JSON NOT NULL CHECK (json_valid(coverage) AND json_type(coverage) = 'object' AND json_extract(coverage, '$.state') IN ('complete', 'pending_expansion', 'provider_unavailable', 'incomplete')),
  added INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX capture_events_bundle ON capture_events(bundle_id, id);
CREATE TRIGGER capture_events_no_update BEFORE UPDATE ON capture_events
BEGIN
  SELECT RAISE(ABORT, 'capture events are append-only');
END;
CREATE TRIGGER capture_events_no_delete BEFORE DELETE ON capture_events
BEGIN
  SELECT RAISE(ABORT, 'capture events are append-only');
END;

CREATE TABLE capture_members (
  bundle_id TEXT NOT NULL REFERENCES capture_bundles(id), source_id TEXT NOT NULL REFERENCES sources(id),
  role TEXT NOT NULL CHECK (role IN ('anchor', 'ancestor', 'before', 'after', 'reply', 'mention', 'same_author', 'watch')),
  added_at TEXT NOT NULL, PRIMARY KEY (bundle_id, source_id, role)
);
CREATE INDEX capture_members_source ON capture_members(source_id);
CREATE TRIGGER capture_members_no_update BEFORE UPDATE ON capture_members
BEGIN
  SELECT RAISE(ABORT, 'capture members are never removed');
END;
CREATE TRIGGER capture_members_no_delete BEFORE DELETE ON capture_members
BEGIN
  SELECT RAISE(ABORT, 'capture members are never removed');
END;

CREATE TABLE capture_watches (
  id TEXT PRIMARY KEY, bundle_id TEXT NOT NULL REFERENCES capture_bundles(id), due_at TEXT NOT NULL, done_at TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('fetched', 'nothing_new', 'unavailable')), extra JSON,
  CHECK ((done_at IS NULL) = (outcome IS NULL))
);
CREATE INDEX capture_watches_due ON capture_watches(done_at, due_at);

CREATE TABLE claim_sources (
  claim_id TEXT, source_id TEXT, position INTEGER, retired_at TEXT, owner_file TEXT, id TEXT,
  owner_key TEXT REFERENCES storage_units(id)
);
CREATE INDEX claim_sources_claim ON claim_sources(claim_id);
CREATE INDEX claim_sources_owner ON claim_sources(owner_file);
CREATE UNIQUE INDEX claim_sources_id ON claim_sources(id);
CREATE INDEX "claim_sources_storage_owner" ON "claim_sources"(owner_key);
CREATE TRIGGER claim_sources_id_fill AFTER INSERT ON claim_sources WHEN new.id IS NULL
BEGIN
  UPDATE claim_sources SET id = 'cs:' || COALESCE(new.claim_id, '') || CASE WHEN new.owner_file IS NULL THEN ':s:' || COALESCE(new.source_id, '') ELSE ':p:' || COALESCE(new.position, '') END || CASE WHEN EXISTS (SELECT 1 FROM claim_sources o WHERE o.id = 'cs:' || COALESCE(new.claim_id, '') || CASE WHEN new.owner_file IS NULL THEN ':s:' || COALESCE(new.source_id, '') ELSE ':p:' || COALESCE(new.position, '') END) THEN '#dup' || new.rowid ELSE '' END WHERE rowid = new.rowid;
END;

CREATE TABLE claim_version_sources (
  version_id TEXT NOT NULL REFERENCES claim_versions(id), source_id TEXT NOT NULL REFERENCES sources(id),
  role TEXT NOT NULL CHECK (role IN ('supports', 'conflicts')),
  legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1)), PRIMARY KEY (version_id, source_id)
);
CREATE INDEX claim_version_sources_source ON claim_version_sources(source_id);
CREATE TRIGGER semantic_evidence_no_insert BEFORE INSERT ON claim_version_sources WHEN EXISTS (SELECT 1 FROM semantic_assertion_versions WHERE version_id = new.version_id)
BEGIN
  SELECT RAISE(ABORT, 'semantic evidence version is already sealed');
END;
CREATE TRIGGER semantic_evidence_no_update BEFORE UPDATE ON claim_version_sources WHEN EXISTS (SELECT 1 FROM semantic_assertion_versions WHERE version_id IN (old.version_id, new.version_id))
BEGIN
  SELECT RAISE(ABORT, 'semantic evidence versions are immutable');
END;
CREATE TRIGGER semantic_evidence_no_delete BEFORE DELETE ON claim_version_sources WHEN EXISTS (SELECT 1 FROM semantic_assertion_versions WHERE version_id = old.version_id)
BEGIN
  SELECT RAISE(ABORT, 'semantic evidence versions are retained');
END;

CREATE TABLE claim_versions (
  id TEXT PRIMARY KEY, claim_id TEXT, revision_id TEXT, text TEXT, extra JSON, recorded_at TEXT, event TEXT, by TEXT,
  origin TEXT, owner_file TEXT, position INTEGER, retired_at TEXT, owner_key TEXT REFERENCES storage_units(id)
);
CREATE INDEX claim_versions_owner ON claim_versions(owner_file);
CREATE INDEX claim_versions_claim ON claim_versions(claim_id);
CREATE INDEX "claim_versions_storage_owner" ON "claim_versions"(owner_key);
CREATE TRIGGER semantic_claim_no_replace BEFORE INSERT ON claim_versions WHEN EXISTS (SELECT 1 FROM semantic_assertion_versions WHERE version_id = new.id)
BEGIN
  SELECT RAISE(ABORT, 'sealed claim versions cannot be replaced');
END;
CREATE TRIGGER semantic_claim_no_update BEFORE UPDATE ON claim_versions WHEN EXISTS (SELECT 1 FROM semantic_assertion_versions WHERE version_id = old.id)
BEGIN
  SELECT RAISE(ABORT, 'sealed claim versions are immutable');
END;
CREATE TRIGGER semantic_claim_no_delete BEFORE DELETE ON claim_versions WHEN EXISTS (SELECT 1 FROM semantic_assertion_versions WHERE version_id = old.id)
BEGIN
  SELECT RAISE(ABORT, 'sealed claim versions are retained');
END;

CREATE TABLE claims (
  id TEXT PRIMARY KEY, subject_kind TEXT, subject_id TEXT, kind TEXT, text TEXT, extra JSON, weight REAL,
  first_seen_at TEXT, last_seen_at TEXT, valid_to TEXT, superseded_by TEXT, how TEXT, author TEXT, from_person TEXT,
  truth TEXT, shown INTEGER, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, created_at TEXT, retired_at TEXT,
  origin_file TEXT, owner_file TEXT, position INTEGER, audience_id TEXT REFERENCES audiences(id),
  owner_key TEXT REFERENCES storage_units(id)
);
CREATE INDEX claims_subject ON claims(subject_id, kind);
CREATE INDEX claims_file ON claims(owner_file, position);
CREATE INDEX "claims_storage_owner" ON "claims"(owner_key);

CREATE TABLE co_owners (
  tbl TEXT, key TEXT, owner_file TEXT, owner_key TEXT REFERENCES storage_units(id), PRIMARY KEY (tbl, key, owner_file)
);
CREATE INDEX co_owners_owner ON co_owners(owner_file);
CREATE INDEX "co_owners_storage_owner" ON "co_owners"(owner_key);
CREATE UNIQUE INDEX co_owners_storage ON co_owners(tbl,key,owner_key);

CREATE TABLE connections (
  id TEXT PRIMARY KEY, iface TEXT NOT NULL REFERENCES interfaces(id), authority_id TEXT REFERENCES authorities(id),
  self_account TEXT, capabilities JSON, status TEXT, extra JSON
);

CREATE TABLE day (
  id TEXT PRIMARY KEY, at TEXT, what TEXT, outcome TEXT, reason TEXT, place_id TEXT, turn_id TEXT, source_id TEXT,
  work_id TEXT, extra JSON, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, owner_file TEXT, position INTEGER,
  retired_at TEXT, audience_id TEXT REFERENCES audiences(id), owner_key TEXT REFERENCES storage_units(id)
);
CREATE INDEX day_at ON day(at);
CREATE INDEX day_owner ON day(owner_file);
CREATE INDEX "day_storage_owner" ON "day"(owner_key);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY, at TEXT, by TEXT, target_kind TEXT, target_id TEXT, action TEXT, reason TEXT, extra JSON,
  owner_file TEXT, position INTEGER, retired_at TEXT, owner_key TEXT REFERENCES storage_units(id)
);
CREATE INDEX decisions_owner ON decisions(owner_file);
CREATE INDEX "decisions_storage_owner" ON "decisions"(owner_key);

CREATE TABLE "deliveries" (
  key TEXT PRIMARY KEY, wake_id TEXT NOT NULL REFERENCES wakes(id), target TEXT, payload JSON NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'sent', 'unknown', 'failed')), queued_at INTEGER NOT NULL,
  sent_at INTEGER, receipt JSON
);
CREATE INDEX deliveries_state ON deliveries (state, queued_at);

CREATE TABLE description_versions (
  id TEXT PRIMARY KEY, description_id TEXT, text TEXT, author TEXT, written_at TEXT, chars INTEGER, kept INTEGER,
  removed INTEGER, added INTEGER, reason TEXT, origin TEXT, extra JSON, owner_file TEXT, position INTEGER,
  retired_at TEXT, owner_key TEXT REFERENCES storage_units(id)
);
CREATE INDEX description_versions_owner ON description_versions(owner_file);
CREATE INDEX "description_versions_storage_owner" ON "description_versions"(owner_key);

CREATE TABLE descriptions (
  id TEXT PRIMARY KEY, subject_kind TEXT, subject_id TEXT, field TEXT, scope_kind TEXT, scope_iface TEXT,
  scope_dm TEXT, current_version TEXT, owner_file TEXT, retired_at TEXT, audience_id TEXT REFERENCES audiences(id),
  owner_key TEXT REFERENCES storage_units(id)
);
CREATE INDEX descriptions_owner ON descriptions(owner_file);
CREATE INDEX "descriptions_storage_owner" ON "descriptions"(owner_key);

CREATE TABLE episode_sources (
  episode_id TEXT, source_id TEXT, position INTEGER, retired_at TEXT, owner_file TEXT, id TEXT,
  owner_key TEXT REFERENCES storage_units(id)
);
CREATE INDEX episode_sources_episode ON episode_sources(episode_id);
CREATE INDEX episode_sources_owner ON episode_sources(owner_file);
CREATE UNIQUE INDEX episode_sources_id ON episode_sources(id);
CREATE INDEX "episode_sources_storage_owner" ON "episode_sources"(owner_key);
CREATE TRIGGER episode_sources_id_fill AFTER INSERT ON episode_sources WHEN new.id IS NULL
BEGIN
  UPDATE episode_sources SET id = 'es:' || COALESCE(new.episode_id, '') || CASE WHEN new.owner_file IS NULL THEN ':s:' || COALESCE(new.source_id, '') ELSE ':p:' || COALESCE(new.position, '') END || CASE WHEN EXISTS (SELECT 1 FROM episode_sources o WHERE o.id = 'es:' || COALESCE(new.episode_id, '') || CASE WHEN new.owner_file IS NULL THEN ':s:' || COALESCE(new.source_id, '') ELSE ':p:' || COALESCE(new.position, '') END) THEN '#dup' || new.rowid ELSE '' END WHERE rowid = new.rowid;
END;

CREATE TABLE episodes (
  id TEXT PRIMARY KEY, kind TEXT, subject_id TEXT, place_id TEXT, date TEXT, what TEXT, quote TEXT, feeling TEXT,
  feeling_at TEXT, reread JSON, weight REAL, world TEXT, status TEXT, perspective TEXT, start_ms INTEGER,
  last_ms INTEGER, extra JSON, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, created_at TEXT, retired_at TEXT,
  owner_file TEXT, position INTEGER, audience_id TEXT REFERENCES audiences(id),
  owner_key TEXT REFERENCES storage_units(id)
);
CREATE INDEX episodes_owner ON episodes(owner_file);
CREATE INDEX "episodes_storage_owner" ON "episodes"(owner_key);

CREATE TABLE execution_contexts (
  id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK (mode IN ('outward', 'internal')),
  iface TEXT REFERENCES interfaces(id), destination_place_id TEXT, partner_person_id TEXT,
  policy_version INTEGER NOT NULL DEFAULT 1, issued_at TEXT NOT NULL
);

CREATE TABLE external_keys (
  authority_id TEXT NOT NULL REFERENCES authorities(id),
  object_kind TEXT NOT NULL CHECK (object_kind IN ('person', 'account', 'place', 'source', 'participant')),
  native_key TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1, node_id TEXT NOT NULL, valid_from_at TEXT,
  valid_to_at TEXT, recorded_at TEXT NOT NULL, PRIMARY KEY (authority_id, object_kind, native_key, generation)
);
CREATE INDEX external_keys_node ON external_keys(node_id);

CREATE TABLE files (
  path TEXT PRIMARY KEY, kind TEXT, size INTEGER, mtime_ms INTEGER, sha1 TEXT, offset INTEGER, synced_at TEXT,
  lines INTEGER, gone_at TEXT, tail_sha1 TEXT, bad TEXT
);

CREATE TABLE focus_events (
  id TEXT PRIMARY KEY, person_id TEXT NOT NULL, at TEXT NOT NULL, old_bucket TEXT, new_bucket TEXT,
  reason TEXT NOT NULL, policy_version INTEGER NOT NULL, extra JSON
);
CREATE INDEX focus_events_person ON focus_events(person_id, at);
CREATE INDEX focus_events_at ON focus_events(at);
CREATE TRIGGER focus_events_no_update BEFORE UPDATE ON focus_events
BEGIN
  SELECT RAISE(ABORT, 'focus events are append-only');
END;
CREATE TRIGGER focus_events_no_delete BEFORE DELETE ON focus_events
BEGIN
  SELECT RAISE(ABORT, 'focus events are append-only');
END;

CREATE TABLE focus_members (
  person_id TEXT PRIMARY KEY REFERENCES people(id), bucket TEXT NOT NULL CHECK (bucket IN ('close', 'exploring')),
  since TEXT NOT NULL, score REAL, policy_version INTEGER NOT NULL, reason JSON
);

CREATE TABLE focus_overrides (
  person_id TEXT PRIMARY KEY REFERENCES people(id), kind TEXT NOT NULL CHECK (kind IN ('pin', 'exclude')),
  expires_at TEXT, approved_by TEXT NOT NULL CHECK (approved_by <> ''), reason TEXT
);

CREATE TABLE graph_edges (
  id TEXT PRIMARY KEY, src TEXT NOT NULL REFERENCES graph_nodes(id), predicate TEXT NOT NULL,
  dst TEXT NOT NULL REFERENCES graph_nodes(id), audience_id TEXT NOT NULL REFERENCES audiences(id), evidence_id TEXT,
  valid_from_at TEXT, valid_to_at TEXT, recorded_at TEXT NOT NULL, retired_at TEXT,
  projection_key TEXT NOT NULL UNIQUE, owner_key TEXT NOT NULL
);
CREATE INDEX graph_edges_out ON graph_edges(src, predicate, dst);
CREATE INDEX graph_edges_in ON graph_edges(dst, predicate, src);
CREATE INDEX graph_edges_owner ON graph_edges(owner_key);

CREATE TABLE graph_nodes (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, row_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX graph_nodes_row ON graph_nodes(kind, row_id);

CREATE TABLE index_policy (
  node_id TEXT PRIMARY KEY, tier TEXT NOT NULL CHECK (tier IN ('a', 'b', 'c')), reason TEXT,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)), evaluated_at TEXT NOT NULL, expires_at TEXT
);
CREATE INDEX index_policy_touch ON index_policy(expires_at) WHERE reason = 'touch';

CREATE TABLE ingest (
  principal TEXT NOT NULL, seq INTEGER, event_id TEXT NOT NULL, kind TEXT NOT NULL, conversation TEXT,
  committed_at TEXT NOT NULL, held JSON, source_id TEXT REFERENCES sources(id), UNIQUE (principal, event_id),
  UNIQUE (principal, seq)
);
CREATE INDEX ingest_committed_at ON ingest (committed_at);
CREATE INDEX ingest_source ON ingest(source_id) WHERE source_id IS NOT NULL;

CREATE TABLE ingest_cursor (
  principal TEXT PRIMARY KEY, acked_seq INTEGER NOT NULL
);

CREATE TABLE intentions (
  id TEXT PRIMARY KEY, record JSON, status TEXT, due_ms INTEGER, created_ms INTEGER, updated_ms INTEGER,
  scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, archived INTEGER, owner_file TEXT, position INTEGER,
  retired_at TEXT, audience_id TEXT REFERENCES audiences(id), owner_key TEXT REFERENCES storage_units(id)
);
CREATE INDEX intentions_owner ON intentions(owner_file);
CREATE INDEX "intentions_storage_owner" ON "intentions"(owner_key);

CREATE TABLE interfaces (
  id TEXT PRIMARY KEY, name TEXT, contract INTEGER NOT NULL DEFAULT 1, extra JSON
);

CREATE TABLE leases (
  name TEXT PRIMARY KEY, holder TEXT NOT NULL, token INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  renewed_at INTEGER NOT NULL
);

CREATE TABLE legacy_unit_aliases (
  path TEXT PRIMARY KEY, unit_id TEXT NOT NULL REFERENCES storage_units(id)
);

CREATE TABLE media (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'gif', 'video', 'sticker', 'emoji', 'voice', 'audio', 'link', 'text', 'file')),
  path TEXT CHECK (path IS NULL OR path LIKE 'media/%'),
  availability TEXT NOT NULL DEFAULT 'unknown' CHECK (availability IN ('present', 'missing', 'unknown', 'unreadable')),
  stems TEXT, owner TEXT, native_ref TEXT, description TEXT, described_at TEXT, sha1 TEXT, bytes INTEGER, mime TEXT,
  scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, extra TEXT, owner_file TEXT, retired_at TEXT, audience_id TEXT,
  owner_key TEXT, tier TEXT
);
CREATE INDEX media_owner ON media(owner_file);
CREATE INDEX "media_storage_owner" ON "media"(owner_key);
CREATE INDEX media_native_ref ON media(native_ref) WHERE native_ref IS NOT NULL;
CREATE INDEX media_sha1 ON media(sha1) WHERE sha1 IS NOT NULL;
CREATE TRIGGER media_ai AFTER INSERT ON media
BEGIN
  INSERT INTO media_fts(rowid, description, stems) VALUES (new.rowid, new.description, new.stems);
  INSERT INTO media_tri(rowid, description) VALUES (new.rowid, new.description);
END;
CREATE TRIGGER media_ad AFTER DELETE ON media
BEGIN
  INSERT INTO media_fts(media_fts, rowid, description, stems) VALUES ('delete', old.rowid, old.description, old.stems);
  INSERT INTO media_tri(media_tri, rowid, description) VALUES ('delete', old.rowid, old.description);
END;
CREATE TRIGGER media_au AFTER UPDATE OF description, stems ON media
BEGIN
  INSERT INTO media_fts(media_fts, rowid, description, stems) VALUES ('delete', old.rowid, old.description, old.stems);
  INSERT INTO media_tri(media_tri, rowid, description) VALUES ('delete', old.rowid, old.description);
  INSERT INTO media_fts(rowid, description, stems) VALUES (new.rowid, new.description, new.stems);
  INSERT INTO media_tri(rowid, description) VALUES (new.rowid, new.description);
END;

CREATE VIRTUAL TABLE media_fts USING fts5(description, stems, content='media', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');

CREATE TABLE "media_links" (
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('source', 'selfreflection')), owner_id TEXT NOT NULL,
  position INTEGER NOT NULL, media_id TEXT NOT NULL, PRIMARY KEY (owner_kind, owner_id, position)
);
CREATE INDEX media_links_media ON media_links(media_id, owner_kind);

CREATE VIRTUAL TABLE media_tri USING fts5(description, content='media', content_rowid='rowid', tokenize='trigram');

CREATE TABLE memberships (
  id TEXT PRIMARY KEY, account_id TEXT, place_id TEXT, nick TEXT, roles JSON, addressed_as JSON, pings_off INTEGER,
  extra JSON, valid_from_at TEXT, valid_to_at TEXT, owner_file TEXT, retired_at TEXT,
  owner_key TEXT REFERENCES storage_units(id)
);
CREATE INDEX memberships_owner ON memberships(owner_file);
CREATE INDEX "memberships_storage_owner" ON "memberships"(owner_key);

CREATE TABLE message_families (
  iface TEXT NOT NULL CHECK(length(iface) > 0 AND instr(iface, char(0)) = 0) REFERENCES interfaces(id),
  conversation_id TEXT NOT NULL CHECK(length(conversation_id) > 0 AND instr(conversation_id, char(0)) = 0),
  message_id TEXT NOT NULL CHECK(length(message_id) > 0 AND instr(message_id, char(0)) = 0),
  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
  authority_id TEXT NOT NULL CHECK(length(authority_id) > 0 AND instr(authority_id, char(0)) = 0) REFERENCES authorities(id),
  native_kind TEXT NOT NULL CHECK(length(native_kind) > 0 AND instr(native_kind, char(0)) = 0),
  native_key TEXT NOT NULL CHECK(length(native_key) > 0 AND instr(native_key, char(0)) = 0),
  PRIMARY KEY(iface, conversation_id, message_id, generation),
  UNIQUE(authority_id, native_kind, native_key, generation)
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY, value
);

CREATE TABLE mirrors (
  id TEXT PRIMARY KEY, row_kind TEXT NOT NULL, place_id TEXT NOT NULL REFERENCES places(id), enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL, extra JSON, registered_at INTEGER, removed_at TEXT,
  removed_by TEXT, backfill_enabled INTEGER NOT NULL DEFAULT 0, backfill_interval_ms INTEGER,
  backfill_high_water TEXT, backfill_next_due_at INTEGER, backfill_completed_at INTEGER, UNIQUE (row_kind, place_id)
);

CREATE TABLE model_requests (
  id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, turn_id TEXT, attempt_id TEXT, step INTEGER, role TEXT,
  model TEXT, purpose TEXT, status TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'failed', 'unknown')),
  started_at TEXT NOT NULL, finished_at TEXT, system_text TEXT, messages JSON NOT NULL, tools JSON, tool_choice TEXT,
  response_text TEXT, think TEXT, tool_calls JSON, usage JSON, error_code TEXT, source TEXT, service TEXT,
  backend TEXT, run_id TEXT, outcome JSON, blocks JSON
);
CREATE INDEX model_requests_started ON model_requests(started_at);
CREATE INDEX model_requests_turn ON model_requests(turn_id, attempt_id, step);
CREATE INDEX model_requests_finished ON model_requests(finished_at);

CREATE TABLE names (
  rowid INTEGER PRIMARY KEY, label TEXT NOT NULL, normalized TEXT NOT NULL, stem TEXT NOT NULL, kind TEXT NOT NULL,
  node_id TEXT NOT NULL, audience_id TEXT NOT NULL, source_table TEXT NOT NULL, source_id TEXT NOT NULL,
  UNIQUE (normalized, kind, node_id, source_table, source_id)
);
CREATE INDEX names_stem ON names(stem);
CREATE INDEX names_source ON names(source_table, source_id);
CREATE TRIGGER names_tri_insert AFTER INSERT ON names
BEGIN
  INSERT INTO names_tri(rowid, normalized) VALUES (new.rowid, new.normalized);
END;
CREATE TRIGGER names_tri_delete AFTER DELETE ON names
BEGIN
  INSERT INTO names_tri(names_tri, rowid, normalized) VALUES ('delete', old.rowid, old.normalized);
END;

CREATE VIRTUAL TABLE names_tri USING fts5(normalized, content='names', content_rowid='rowid', tokenize='trigram');

CREATE TABLE node_access (
  node_id TEXT NOT NULL REFERENCES graph_nodes(id), audience_id TEXT NOT NULL REFERENCES audiences(id),
  evidence_id TEXT NOT NULL, PRIMARY KEY (node_id, audience_id, evidence_id)
);
CREATE INDEX node_access_evidence ON node_access(evidence_id);

CREATE TABLE operational (
  kind TEXT, owner TEXT, value JSON, owner_file TEXT, retired_at TEXT, owner_key TEXT REFERENCES storage_units(id),
  PRIMARY KEY (kind, owner)
);
CREATE INDEX operational_owner ON operational(owner_file);
CREATE INDEX "operational_storage_owner" ON "operational"(owner_key);

CREATE TABLE participant_links (
  id TEXT PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES participants(id),
  account_id TEXT REFERENCES accounts(id), person_id TEXT REFERENCES people(id),
  state TEXT NOT NULL CHECK (state IN ('proposed', 'verified', 'revoked')), by TEXT, reason TEXT, evidence_id TEXT,
  valid_from_at TEXT, valid_to_at TEXT, recorded_at TEXT NOT NULL, CHECK ((account_id IS NULL) <> (person_id IS NULL))
);
CREATE INDEX participant_links_participant ON participant_links(participant_id, valid_to_at);
CREATE INDEX participant_links_account ON participant_links(account_id);
CREATE INDEX participant_links_person ON participant_links(person_id);

CREATE TABLE participants (
  id TEXT PRIMARY KEY, authority_id TEXT NOT NULL REFERENCES authorities(id),
  scope_place_id TEXT REFERENCES places(id),
  token_kind TEXT NOT NULL CHECK (token_kind IN ('thread_token', 'site_token', 'post_number', 'display_name', 'none')),
  native_token TEXT, observation_key TEXT, generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  continuity TEXT NOT NULL CHECK (continuity IN ('provider_asserted', 'verified', 'unknown')), display TEXT,
  first_seen_at TEXT, last_seen_at TEXT, extra JSON, recorded_at TEXT NOT NULL,
  CHECK (CASE WHEN token_kind = 'thread_token' THEN scope_place_id IS NOT NULL AND native_token IS NOT NULL AND native_token <> '' AND observation_key IS NULL WHEN token_kind = 'site_token' THEN scope_place_id IS NULL AND native_token IS NOT NULL AND native_token <> '' AND observation_key IS NULL WHEN token_kind = 'post_number' THEN native_token IS NOT NULL AND native_token <> '' AND observation_key IS NULL ELSE native_token IS NULL AND observation_key IS NOT NULL AND observation_key <> '' END)
);
CREATE UNIQUE INDEX participants_tuple ON participants(authority_id, COALESCE(scope_place_id, ''), token_kind, COALESCE(native_token, observation_key), generation);

CREATE TABLE people (
  id TEXT PRIMARY KEY, kind TEXT, first_seen_at TEXT, last_seen_at TEXT, message_count INTEGER, affinity REAL,
  affinity_reason TEXT, affinity_decayed_at TEXT, real_name JSON, extra JSON, retired_at TEXT, owner_file TEXT,
  status TEXT DEFAULT 'active', owner_key TEXT REFERENCES storage_units(id),
  meta INTEGER DEFAULT 0 CHECK (meta IN (0, 1))
);
CREATE INDEX people_owner ON people(owner_file);
CREATE INDEX "people_storage_owner" ON "people"(owner_key);

CREATE TABLE people_merges (
  id TEXT PRIMARY KEY, from_person TEXT NOT NULL REFERENCES people(id),
  into_person TEXT NOT NULL REFERENCES people(id), at TEXT NOT NULL, by TEXT NOT NULL, reason TEXT, evidence JSON,
  CHECK (from_person <> into_person)
);
CREATE UNIQUE INDEX people_merges_from ON people_merges(from_person);
CREATE INDEX people_merges_into ON people_merges(into_person);

CREATE TABLE person_accounts (
  id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), iface TEXT NOT NULL, platform_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1, handle TEXT, display_name TEXT, avatar JSON, profile_text TEXT,
  recorded_at TEXT NOT NULL, UNIQUE (iface, platform_id, generation)
);
CREATE INDEX person_accounts_person ON person_accounts(person_id);
CREATE TRIGGER person_accounts_meta_insert BEFORE INSERT ON person_accounts WHEN EXISTS (SELECT 1 FROM people WHERE id = NEW.person_id AND meta IS NOT 1)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_PARENT_NOT_META');
END;
CREATE TRIGGER person_accounts_meta_update BEFORE UPDATE OF person_id ON person_accounts WHEN EXISTS (SELECT 1 FROM people WHERE id = NEW.person_id AND meta IS NOT 1)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_PARENT_NOT_META');
END;

CREATE TABLE places (
  id TEXT PRIMARY KEY, iface TEXT, kind TEXT, native_id TEXT, parent_id TEXT, scope_kind TEXT, name TEXT, topic TEXT,
  extra JSON, retired_at TEXT, owner_file TEXT, authority_id TEXT REFERENCES authorities(id), native_key TEXT,
  generation INTEGER NOT NULL DEFAULT 1, chat TEXT CHECK (chat IN ('dm', 'group')), partner_person TEXT,
  partner_account TEXT, gone_at TEXT, seen_from_at TEXT, seen_to_at TEXT,
  continues_place_id TEXT REFERENCES places(id), owner_key TEXT REFERENCES storage_units(id)
);
CREATE INDEX places_owner ON places(owner_file);
CREATE UNIQUE INDEX places_native ON places(authority_id, native_key, generation) WHERE authority_id IS NOT NULL;
CREATE INDEX "places_storage_owner" ON "places"(owner_key);
CREATE INDEX places_partner_account ON places(partner_account) WHERE partner_account IS NOT NULL;
CREATE INDEX places_partner_person ON places(partner_person) WHERE partner_person IS NOT NULL;

CREATE TABLE publication_grants (
  id TEXT PRIMARY KEY, row_kind TEXT NOT NULL, row_id TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash <> ''),
  destinations JSON NOT NULL CHECK (json_valid(destinations) AND json_type(destinations) = 'array' AND json_array_length(destinations) > 0),
  approved_by TEXT NOT NULL CHECK (approved_by <> ''), approved_at TEXT NOT NULL, reason TEXT, revoked_at TEXT
);
CREATE INDEX publication_grants_row ON publication_grants(row_kind, row_id, content_hash);
CREATE TRIGGER publication_grants_fixed BEFORE UPDATE OF id, row_kind, row_id, content_hash, destinations, approved_by, approved_at, reason ON publication_grants
BEGIN
  SELECT RAISE(ABORT, 'a grant is immutable; revoke it and grant again');
END;
CREATE TRIGGER publication_grants_revoked_once BEFORE UPDATE OF revoked_at ON publication_grants WHEN old.revoked_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a revoked grant stays revoked');
END;
CREATE TRIGGER publication_grants_no_delete BEFORE DELETE ON publication_grants
BEGIN
  SELECT RAISE(ABORT, 'grants are never deleted');
END;

CREATE TABLE "publications" (
  id TEXT PRIMARY KEY, row_kind TEXT NOT NULL, row_id TEXT NOT NULL, content_hash TEXT, rendered TEXT,
  destination_place_id TEXT REFERENCES places(id), context_id TEXT REFERENCES execution_contexts(id),
  grant_id TEXT REFERENCES publication_grants(id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'incomplete', 'unknown')),
  idempotency_key TEXT NOT NULL UNIQUE,
  receipts JSON CHECK (receipts IS NULL OR (json_valid(receipts) AND json_type(receipts) = 'array')),
  created_at TEXT NOT NULL, sent_at TEXT, owner_file TEXT, retired_at TEXT,
  owner_key TEXT REFERENCES storage_units(id), code TEXT, retryable INTEGER, claimed_by TEXT, claimed_at INTEGER,
  paced INTEGER NOT NULL DEFAULT 0, reconciled_by TEXT, reconciled_at TEXT,
  delivery JSON CHECK (delivery IS NULL OR json_valid(delivery)), CHECK ((content_hash IS NULL) = (rendered IS NULL))
);
CREATE INDEX publications_row ON publications(row_kind, row_id);
CREATE INDEX publications_owner ON publications(owner_file);
CREATE INDEX publications_storage_owner ON publications(owner_key);
CREATE INDEX publications_unsettled ON publications(status) WHERE status IN ('queued', 'unknown');
CREATE INDEX publications_place ON publications(row_kind, destination_place_id, status);
CREATE TRIGGER publications_content_fixed BEFORE UPDATE OF rendered, content_hash ON publications WHEN old.content_hash IS NOT NULL AND (new.content_hash IS NOT old.content_hash OR new.rendered IS NOT old.rendered)
BEGIN
  SELECT RAISE(ABORT, 'a publication keeps its content; an edit is a new publication');
END;
CREATE TRIGGER publications_key_fixed BEFORE UPDATE OF id, row_kind, row_id, idempotency_key ON publications
BEGIN
  SELECT RAISE(ABORT, 'a publication keeps its row and its key');
END;
CREATE TRIGGER publications_no_delete BEFORE DELETE ON publications
BEGIN
  SELECT RAISE(ABORT, 'publications are never deleted');
END;

CREATE TABLE relationship_daily (
  person_id TEXT NOT NULL REFERENCES people(id), day TEXT NOT NULL,
  audience_id TEXT NOT NULL REFERENCES audiences(id), addressed_by_them INTEGER NOT NULL DEFAULT 0,
  addressed_by_her INTEGER NOT NULL DEFAULT 0, meaningful INTEGER NOT NULL DEFAULT 0 CHECK (meaningful IN (0, 1)),
  last_contact_at TEXT, PRIMARY KEY (person_id, day, audience_id)
);
CREATE INDEX relationship_daily_day ON relationship_daily(day);

CREATE TABLE "selfreflection" (
  id TEXT PRIMARY KEY, at_ms INTEGER, kind TEXT, gist TEXT, text TEXT, picture_prompt TEXT, search TEXT, topic TEXT,
  world TEXT, status TEXT, perspective TEXT, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, extra JSON,
  owner_file TEXT, position INTEGER, retired_at TEXT, audience_id TEXT REFERENCES audiences(id),
  owner_key TEXT REFERENCES storage_units(id)
);
CREATE INDEX selfreflection_owner ON "selfreflection"(owner_file);
CREATE INDEX "selfreflection_storage_owner" ON "selfreflection"(owner_key);

CREATE TABLE "selfreflection_mirrors" (
  "selfreflection_id" TEXT, iface TEXT, place_id TEXT, native_ids JSON, posted_at TEXT, retired_at TEXT,
  owner_file TEXT, id TEXT, owner_key TEXT REFERENCES storage_units(id)
);
CREATE INDEX selfreflection_mirrors_selfreflection ON "selfreflection_mirrors"("selfreflection_id");
CREATE INDEX selfreflection_mirrors_owner ON "selfreflection_mirrors"(owner_file);
CREATE UNIQUE INDEX selfreflection_mirrors_id ON "selfreflection_mirrors"(id);
CREATE INDEX "selfreflection_mirrors_storage_owner" ON "selfreflection_mirrors"(owner_key);
CREATE TRIGGER selfreflection_mirrors_id_fill AFTER INSERT ON "selfreflection_mirrors" WHEN new.id IS NULL
BEGIN
  UPDATE "selfreflection_mirrors" SET id = 'mirror:' || COALESCE(new."selfreflection_id", '') || ':' || COALESCE(new.iface, '') || ':' || COALESCE(new.place_id, '') || CASE WHEN EXISTS (SELECT 1 FROM "selfreflection_mirrors" o WHERE o.id = 'mirror:' || COALESCE(new."selfreflection_id", '') || ':' || COALESCE(new.iface, '') || ':' || COALESCE(new.place_id, '')) THEN '#dup' || new.rowid ELSE '' END WHERE rowid = new.rowid;
END;

CREATE TABLE semantic_arguments (
  version_id TEXT NOT NULL REFERENCES semantic_assertion_versions(version_id) DEFERRABLE INITIALLY DEFERRED,
  role TEXT NOT NULL, position INTEGER NOT NULL CHECK (position >= 0), ref_kind TEXT, ref_id TEXT, literal_json TEXT,
  PRIMARY KEY (version_id, role, position),
  CHECK ((ref_kind IS NOT NULL AND ref_id IS NOT NULL AND literal_json IS NULL) OR (ref_kind IS NULL AND ref_id IS NULL AND literal_json IS NOT NULL AND json_valid(literal_json)))
);
CREATE INDEX semantic_arguments_ref ON semantic_arguments(ref_kind, ref_id, role, version_id);
CREATE TRIGGER semantic_argument_no_late_insert BEFORE INSERT ON semantic_arguments WHEN EXISTS (SELECT 1 FROM semantic_assertion_versions WHERE version_id = new.version_id)
BEGIN
  SELECT RAISE(ABORT, 'semantic argument version is already sealed');
END;
CREATE TRIGGER semantic_argument_no_update BEFORE UPDATE ON semantic_arguments
BEGIN
  SELECT RAISE(ABORT, 'semantic argument versions are immutable');
END;
CREATE TRIGGER semantic_argument_no_delete BEFORE DELETE ON semantic_arguments
BEGIN
  SELECT RAISE(ABORT, 'semantic argument versions are retained');
END;

CREATE TABLE semantic_assertion_versions (
  version_id TEXT PRIMARY KEY NOT NULL REFERENCES claim_versions(id),
  format_version INTEGER NOT NULL CHECK (format_version >= 1),
  assertion_kind TEXT NOT NULL CHECK (assertion_kind IN ('text','label','property','relation','nary')),
  predicate_id TEXT, predicate_version INTEGER,
  truth_state TEXT NOT NULL CHECK (truth_state IN ('current','historical','disputed','retired','unknown')), how TEXT,
  polarity TEXT NOT NULL CHECK (polarity IN ('positive','negative','unknown')), valid_from_at TEXT, valid_to_at TEXT,
  recorded_at TEXT NOT NULL, audience_id TEXT NOT NULL REFERENCES audiences(id),
  historical_metadata_complete INTEGER NOT NULL CHECK (historical_metadata_complete IN (0,1)),
  FOREIGN KEY (predicate_id, predicate_version) REFERENCES semantic_predicate_versions(id, version),
  CHECK ((assertion_kind = 'text' AND predicate_id IS NULL AND predicate_version IS NULL) OR (assertion_kind <> 'text' AND predicate_id IS NOT NULL AND predicate_version IS NOT NULL)),
  CHECK (assertion_kind = 'text' OR polarity <> 'unknown'),
  CHECK (valid_from_at IS NULL OR valid_to_at IS NULL OR valid_from_at <= valid_to_at)
);
CREATE INDEX semantic_assertions_audience ON semantic_assertion_versions(audience_id, recorded_at, version_id);
CREATE INDEX semantic_assertions_predicate ON semantic_assertion_versions(predicate_id, predicate_version, recorded_at);
CREATE TRIGGER semantic_assertion_no_replace BEFORE INSERT ON semantic_assertion_versions WHEN EXISTS (SELECT 1 FROM semantic_assertion_versions WHERE version_id = new.version_id)
BEGIN
  SELECT RAISE(ABORT, 'semantic assertion versions cannot be replaced');
END;
CREATE TRIGGER semantic_assertion_no_update BEFORE UPDATE ON semantic_assertion_versions
BEGIN
  SELECT RAISE(ABORT, 'semantic assertion versions are immutable');
END;
CREATE TRIGGER semantic_assertion_no_delete BEFORE DELETE ON semantic_assertion_versions
BEGIN
  SELECT RAISE(ABORT, 'semantic assertion versions are retained');
END;

CREATE TABLE semantic_dependencies (
  version_id TEXT NOT NULL REFERENCES semantic_assertion_versions(version_id) DEFERRABLE INITIALLY DEFERRED,
  premise_version_id TEXT NOT NULL REFERENCES claim_versions(id),
  role TEXT NOT NULL CHECK (role IN ('supports','conflicts','identity')),
  PRIMARY KEY (version_id, premise_version_id, role), CHECK (version_id <> premise_version_id)
);
CREATE INDEX semantic_dependencies_premise ON semantic_dependencies(premise_version_id, version_id);
CREATE TRIGGER semantic_dependency_no_late_insert BEFORE INSERT ON semantic_dependencies WHEN EXISTS (SELECT 1 FROM semantic_assertion_versions WHERE version_id = new.version_id)
BEGIN
  SELECT RAISE(ABORT, 'semantic premise version is already sealed');
END;
CREATE TRIGGER semantic_dependency_no_update BEFORE UPDATE ON semantic_dependencies
BEGIN
  SELECT RAISE(ABORT, 'semantic premise versions are immutable');
END;
CREATE TRIGGER semantic_dependency_no_delete BEFORE DELETE ON semantic_dependencies
BEGIN
  SELECT RAISE(ABORT, 'semantic premise versions are retained');
END;

CREATE TABLE semantic_entities (
  id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, kind_version INTEGER NOT NULL, created_at TEXT NOT NULL,
  retired_at TEXT, FOREIGN KEY (kind, kind_version) REFERENCES semantic_entity_kinds(id, version)
);
CREATE INDEX semantic_entities_kind ON semantic_entities(kind, kind_version, id);

CREATE TABLE semantic_entity_kinds (
  id TEXT NOT NULL, version INTEGER NOT NULL CHECK (version >= 1),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)), created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE TRIGGER semantic_kind_no_replace BEFORE INSERT ON semantic_entity_kinds WHEN EXISTS (SELECT 1 FROM semantic_entity_kinds WHERE id = new.id AND version = new.version)
BEGIN
  SELECT RAISE(ABORT, 'semantic kind versions cannot be replaced');
END;
CREATE TRIGGER semantic_kind_no_update BEFORE UPDATE ON semantic_entity_kinds
BEGIN
  SELECT RAISE(ABORT, 'semantic kind versions are immutable');
END;
CREATE TRIGGER semantic_kind_no_delete BEFORE DELETE ON semantic_entity_kinds
BEGIN
  SELECT RAISE(ABORT, 'semantic kind versions are retained');
END;

CREATE TABLE semantic_entity_merges (
  version_id TEXT PRIMARY KEY NOT NULL REFERENCES semantic_assertion_versions(version_id),
  from_entity_id TEXT NOT NULL REFERENCES semantic_entities(id),
  into_entity_id TEXT NOT NULL REFERENCES semantic_entities(id), CHECK (from_entity_id <> into_entity_id)
);
CREATE INDEX semantic_merges_from ON semantic_entity_merges(from_entity_id, version_id);
CREATE INDEX semantic_merges_into ON semantic_entity_merges(into_entity_id, version_id);

CREATE TABLE semantic_labels (
  version_id TEXT NOT NULL REFERENCES semantic_assertion_versions(version_id),
  entity_id TEXT NOT NULL REFERENCES semantic_entities(id), role TEXT NOT NULL CHECK (role IN ('name','alias')),
  language TEXT NOT NULL, text TEXT NOT NULL, normalized TEXT NOT NULL,
  PRIMARY KEY (version_id, entity_id, role, language, text)
);
CREATE INDEX semantic_labels_match ON semantic_labels(normalized, language, entity_id, version_id);

CREATE TABLE semantic_predicate_versions (
  id TEXT NOT NULL, version INTEGER NOT NULL CHECK (version >= 1),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)), created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE TRIGGER semantic_predicate_no_replace BEFORE INSERT ON semantic_predicate_versions WHEN EXISTS (SELECT 1 FROM semantic_predicate_versions WHERE id = new.id AND version = new.version)
BEGIN
  SELECT RAISE(ABORT, 'semantic predicate versions cannot be replaced');
END;
CREATE TRIGGER semantic_predicate_no_update BEFORE UPDATE ON semantic_predicate_versions
BEGIN
  SELECT RAISE(ABORT, 'semantic predicate versions are immutable');
END;
CREATE TRIGGER semantic_predicate_no_delete BEFORE DELETE ON semantic_predicate_versions
BEGIN
  SELECT RAISE(ABORT, 'semantic predicate versions are retained');
END;

CREATE TABLE semantic_search_documents (
  rowid INTEGER PRIMARY KEY, document_key TEXT UNIQUE NOT NULL,
  version_id TEXT NOT NULL REFERENCES claim_versions(id), ref_kind TEXT NOT NULL, ref_id TEXT NOT NULL,
  audience_id TEXT NOT NULL REFERENCES audiences(id), text TEXT NOT NULL,
  projection_version INTEGER NOT NULL CHECK (projection_version >= 1)
);
CREATE INDEX semantic_documents_audience ON semantic_search_documents(audience_id, version_id, rowid);
CREATE INDEX semantic_documents_ref ON semantic_search_documents(ref_kind, ref_id, version_id);
CREATE TRIGGER semantic_documents_insert AFTER INSERT ON semantic_search_documents
BEGIN
  INSERT INTO semantic_search_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER semantic_documents_delete AFTER DELETE ON semantic_search_documents
BEGIN
  INSERT INTO semantic_search_fts(semantic_search_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER semantic_documents_update AFTER UPDATE OF text ON semantic_search_documents
BEGIN
  INSERT INTO semantic_search_fts(semantic_search_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO semantic_search_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE VIRTUAL TABLE semantic_search_fts USING fts5(text, content='semantic_search_documents', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');

CREATE TABLE session_runs (
  id TEXT PRIMARY KEY, sweep_id TEXT, scope_key TEXT, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, mode TEXT,
  started_at TEXT, finished_at TEXT, cursor_from INTEGER, cursor_to INTEGER, sources_n INTEGER, tokens_prompt INTEGER,
  tokens_completion INTEGER, model TEXT, outcome TEXT, counts JSON, errors JSON, batch_key TEXT,
  applied INTEGER NOT NULL DEFAULT 0, result JSON, answer_source TEXT, audience_id TEXT REFERENCES audiences(id)
);
CREATE INDEX session_runs_sweep ON session_runs(sweep_id);
CREATE UNIQUE INDEX session_runs_applied ON session_runs(batch_key) WHERE applied = 1;

CREATE TABLE skill_evaluations (
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES skill_versions(id),
  kind TEXT NOT NULL CHECK (kind IN ('tests', 'trial', 'outcome', 'audience_check')),
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)), result JSON CHECK (result IS NULL OR json_valid(result)),
  evidence_id TEXT, at TEXT NOT NULL, content_hash TEXT NOT NULL, manifest_hash TEXT NOT NULL,
  commit_sha TEXT NOT NULL
);
CREATE INDEX skill_evaluations_version ON skill_evaluations(version_id, kind);
CREATE TRIGGER skill_evaluations_no_update BEFORE UPDATE ON skill_evaluations
BEGIN
  SELECT RAISE(ABORT, 'evaluations are append-only');
END;
CREATE TRIGGER skill_evaluations_no_delete BEFORE DELETE ON skill_evaluations
BEGIN
  SELECT RAISE(ABORT, 'evaluations are append-only');
END;

CREATE TABLE skill_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, skill TEXT NOT NULL, version_id TEXT NOT NULL REFERENCES skill_versions(id),
  turn_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('discovered', 'read', 'tried', 'succeeded', 'corrected', 'declined')),
  at TEXT NOT NULL
);
CREATE INDEX skill_uses_skill ON skill_uses(skill, at);
CREATE TRIGGER skill_uses_no_update BEFORE UPDATE ON skill_uses
BEGIN
  SELECT RAISE(ABORT, 'skill uses are append-only');
END;
CREATE TRIGGER skill_uses_no_delete BEFORE DELETE ON skill_uses
BEGIN
  SELECT RAISE(ABORT, 'skill uses are append-only');
END;

CREATE TABLE skill_versions (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES skills(id), version TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash <> ''), manifest_hash TEXT NOT NULL CHECK (manifest_hash <> ''),
  commit_sha TEXT NOT NULL CHECK (commit_sha <> ''), origin_work_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'retired')), created_at TEXT NOT NULL,
  manifest JSON NOT NULL CHECK (json_valid(manifest) AND json_type(manifest) = 'object'), source TEXT,
  UNIQUE (skill_id, content_hash, manifest_hash, commit_sha)
);
CREATE INDEX skill_versions_skill ON skill_versions(skill_id, created_at);
CREATE TRIGGER skill_versions_fixed BEFORE UPDATE OF id, skill_id, version, content_hash, manifest_hash, commit_sha, manifest, created_at ON skill_versions
BEGIN
  SELECT RAISE(ABORT, 'a skill version keeps its hashes; a change is a new version');
END;

CREATE TABLE skills (
  id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, active_version TEXT REFERENCES skill_versions(id),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'stale', 'archived')), origin_work_id TEXT,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)), extra JSON CHECK (extra IS NULL OR json_valid(extra))
);

CREATE TABLE source_relations (
  id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
  predicate TEXT NOT NULL CHECK (predicate IN ('replies_to', 'quotes', 'reposts', 'mentions', 'edits', 'references')),
  target_key TEXT NOT NULL, target_source_id TEXT REFERENCES sources(id), recorded_at TEXT NOT NULL, resolved_at TEXT,
  CHECK ((target_source_id IS NULL) = (resolved_at IS NULL))
);
CREATE UNIQUE INDEX source_relations_key ON source_relations(source_id, predicate, target_key);
CREATE INDEX source_relations_pending ON source_relations(target_key) WHERE target_source_id IS NULL;
CREATE INDEX source_relations_target ON source_relations(target_source_id) WHERE target_source_id IS NOT NULL;
CREATE TRIGGER source_relations_key_fixed BEFORE UPDATE OF source_id, predicate, target_key ON source_relations
BEGIN
  SELECT RAISE(ABORT, 'a relation keeps its source, predicate and target key');
END;
CREATE TRIGGER source_relations_no_delete BEFORE DELETE ON source_relations
BEGIN
  SELECT RAISE(ABORT, 'relations are never deleted');
END;

CREATE TABLE sources (
  rowid INTEGER PRIMARY KEY, id TEXT UNIQUE, kind TEXT, iface TEXT, native_id TEXT, revision INTEGER, place_id TEXT,
  author_account TEXT, reply_to TEXT, occurred_at TEXT, recorded_at TEXT, seen_at TEXT, text TEXT, stems TEXT,
  mentions JSON, direct INTEGER, turn_id TEXT, op_id TEXT, think TEXT, extra JSON, scope_kind TEXT, scope_iface TEXT,
  scope_dm TEXT, origin TEXT, owner_file TEXT, position INTEGER, retired_at TEXT, authority_id TEXT,
  author_kind TEXT CHECK (author_kind IN ('account', 'participant', 'self')), observed_at TEXT, connection_id TEXT,
  audience_id TEXT REFERENCES audiences(id), author_participant TEXT REFERENCES participants(id), native_kind TEXT,
  generation INTEGER NOT NULL DEFAULT 1, tier TEXT CHECK (tier IS NULL OR tier IN ('a', 'b', 'c')),
  owner_key TEXT REFERENCES storage_units(id), author_person TEXT REFERENCES people(id)
);
CREATE INDEX sources_place_time ON sources(place_id, occurred_at);
CREATE INDEX sources_native ON sources(native_id);
CREATE INDEX sources_turn ON sources(turn_id);
CREATE INDEX sources_file ON sources(owner_file, position);
CREATE INDEX sources_native_tuple ON sources(authority_id, native_kind, native_id, generation, revision);
CREATE INDEX sources_author_participant ON sources(author_participant) WHERE author_participant IS NOT NULL;
CREATE INDEX sources_message_locator ON sources(iface, CASE WHEN json_valid(extra) THEN json_extract(extra, '$."$messageLocator".conversationId') END, CASE WHEN json_valid(extra) THEN json_extract(extra, '$."$messageLocator".messageId') END, generation);
CREATE INDEX sources_iface_native ON sources(iface, native_id, generation);
CREATE INDEX "sources_storage_owner" ON "sources"(owner_key);
CREATE INDEX sources_author_person ON sources(author_person) WHERE author_person IS NOT NULL;
CREATE TRIGGER sources_ai AFTER INSERT ON sources
BEGIN
  INSERT INTO sources_fts(rowid, text, stems) VALUES (new.rowid, new.text, new.stems);
  INSERT INTO sources_tri(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER sources_ad AFTER DELETE ON sources
BEGIN
  INSERT INTO sources_fts(sources_fts, rowid, text, stems) VALUES ('delete', old.rowid, old.text, old.stems);
  INSERT INTO sources_tri(sources_tri, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER sources_au AFTER UPDATE OF text, stems ON sources
BEGIN
  INSERT INTO sources_fts(sources_fts, rowid, text, stems) VALUES ('delete', old.rowid, old.text, old.stems);
  INSERT INTO sources_tri(sources_tri, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO sources_fts(rowid, text, stems) VALUES (new.rowid, new.text, new.stems);
  INSERT INTO sources_tri(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE VIRTUAL TABLE sources_fts USING fts5(text, stems, content='sources', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');

CREATE VIRTUAL TABLE sources_tri USING fts5(text, content='sources', content_rowid='rowid', tokenize='trigram');

CREATE TABLE storage_units (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, scope_place_id TEXT,
  partition TEXT, selector JSON, key_json TEXT NOT NULL UNIQUE, lines INTEGER, offset INTEGER, synced_at TEXT,
  retired_at TEXT
);
CREATE INDEX storage_units_subject ON storage_units(kind,subject_type,subject_id,scope_place_id,partition);

CREATE TABLE "turn_reads" (
  turn_id TEXT, step TEXT, context_id TEXT NOT NULL DEFAULT '', row_kind TEXT, row_id TEXT, block TEXT, ord INTEGER,
  version_id TEXT, revision INTEGER,
  reader_kind TEXT NOT NULL DEFAULT 'turn' CHECK (reader_kind IN ('turn', 'session', 'wake')),
  PRIMARY KEY (turn_id, step, context_id, row_kind, row_id)
);

CREATE TABLE vectors (
  source_rowid INTEGER, item_id TEXT, chunk_key TEXT UNIQUE, model TEXT, dims INTEGER, scale REAL, norm REAL,
  bytes BLOB, context JSON, occurred_at TEXT, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, retired_at TEXT,
  owner_file TEXT, audience_id TEXT REFERENCES audiences(id), evicted_at TEXT,
  owner_key TEXT REFERENCES storage_units(id)
);
CREATE INDEX vectors_file ON vectors(owner_file);
CREATE INDEX vectors_model ON vectors(model, dims);
CREATE INDEX "vectors_storage_owner" ON "vectors"(owner_key);
CREATE INDEX vectors_item ON vectors(item_id);

CREATE TABLE wake_actions (
  run_id TEXT NOT NULL REFERENCES wake_runs(id), n INTEGER NOT NULL CHECK (n >= 1),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key = 'wake:' || run_id || ':' || n), kind TEXT NOT NULL,
  target TEXT, status TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (run_id, n)
);

CREATE TABLE wake_runs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, trigger TEXT, scheduled_at TEXT, started_at TEXT, finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'interrupted')),
  context_id TEXT REFERENCES execution_contexts(id), inputs JSON CHECK (inputs IS NULL OR json_valid(inputs)),
  policy_version INTEGER, outcome TEXT, extra JSON CHECK (extra IS NULL OR json_valid(extra))
);
CREATE INDEX wake_runs_status ON wake_runs(status, started_at);

CREATE TABLE wakes (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, community TEXT, due_at INTEGER, queued_at INTEGER NOT NULL,
  payload JSON NOT NULL, state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'handled', 'slept', 'dropped')),
  lease_holder TEXT, lease_token INTEGER, lease_expires_at INTEGER, handled_at INTEGER, outcome TEXT, turn_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 0, claimed_at INTEGER, turn JSON
);
CREATE INDEX wakes_state ON wakes (state, queued_at);

CREATE TABLE work (
  id TEXT PRIMARY KEY, kind TEXT, state TEXT, record JSON, created_ms INTEGER, updated_ms INTEGER, outcome TEXT,
  seen INTEGER, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, owner_file TEXT, position INTEGER, retired_at TEXT,
  audience_id TEXT REFERENCES audiences(id), owner_key TEXT REFERENCES storage_units(id)
);
CREATE INDEX work_owner ON work(owner_file);
CREATE INDEX "work_storage_owner" ON "work"(owner_key);

CREATE TABLE work_events (
  id TEXT PRIMARY KEY, work_id TEXT, at_ms INTEGER, record JSON, owner_file TEXT, position INTEGER, retired_at TEXT,
  owner_key TEXT REFERENCES storage_units(id)
);
CREATE INDEX work_events_owner ON work_events(owner_file);
CREATE INDEX "work_events_storage_owner" ON "work_events"(owner_key);
`;

// The time on the seeded rows that came from the chain's data steps, which read it from a `meta` key a new database
// never holds.
const EPOCH = '1970-01-01T00:00:00.000Z';

// The time on the seeded registry rows: fixed, so two new databases hash alike.
const SEEDED_AT = '2026-11-05T00:00:00.000Z';

// The interfaces and authorities of a new install, her own person and its key, the two audiences that name no place,
// and their graph nodes.
const SEED_ROWS = `
INSERT INTO interfaces (id) VALUES ('discord'), ('cli'), ('core');
INSERT INTO authorities (id, iface, namespace, name) VALUES
  ('cli/local', 'cli', 'local', NULL), ('core/local', 'core', 'local', NULL),
  ('discord/global', 'discord', 'global', NULL), ('legacy/local', 'core', 'legacy', 'legacy ids');
INSERT INTO people (id, kind, status) VALUES ('person:self', 'self', 'active');
INSERT INTO external_keys (authority_id, object_kind, native_key, generation, node_id, recorded_at) VALUES
  ('core/local', 'person', 'self', 1, 'person:self', '${EPOCH}');
INSERT INTO audiences (id, kind) VALUES ('aud:none', 'none'), ('aud:internal', 'internal');
INSERT INTO graph_nodes (id, kind, row_id, created_at) VALUES
  ('interface:cli', 'interface', 'cli', '${EPOCH}'), ('interface:core', 'interface', 'core', '${EPOCH}'),
  ('interface:discord', 'interface', 'discord', '${EPOCH}'),
  ('authority:cli/local', 'authority', 'cli/local', '${EPOCH}'),
  ('authority:core/local', 'authority', 'core/local', '${EPOCH}'),
  ('authority:discord/global', 'authority', 'discord/global', '${EPOCH}'),
  ('authority:legacy/local', 'authority', 'legacy/local', '${EPOCH}'),
  ('person:person:self', 'person', 'person:self', '${EPOCH}');
`;

/** Creates the baseline's objects and seed rows on an empty database and records its version. */
export function createBaseline(db: Db): void {
  db.exec(SCHEMA);
  db.exec(SEED_ROWS);
  const kind = db.prepare(
    'INSERT INTO semantic_entity_kinds (id, version, definition_json, created_at) VALUES (?, ?, ?, ?)'
  );
  for (const one of INITIAL_ENTITY_KINDS) kind.run(one.id, one.version, entityKindJson(one), SEEDED_AT);
  const predicate = db.prepare(
    'INSERT INTO semantic_predicate_versions (id, version, definition_json, created_at) VALUES (?, ?, ?, ?)'
  );
  for (const one of INITIAL_PREDICATES) predicate.run(one.id, one.version, predicateJson(one), SEEDED_AT);
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(BASELINE_VERSION);
}
