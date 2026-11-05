-- A synthetic memory database of one Discord server at schema v28: written once by the engine of that schema with synthetic
-- text, then extended by hand with what a live run takes months to produce (merges, link history, every publication state,
-- contradictory descriptions). Frozen: the engine that wrote it no longer exists, so it is never regenerated.
PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE schema_version (version INTEGER NOT NULL);
CREATE TABLE meta (key TEXT PRIMARY KEY, value);
CREATE TABLE files (path TEXT PRIMARY KEY, kind TEXT, size INTEGER, mtime_ms INTEGER, sha1 TEXT, offset INTEGER, synced_at TEXT, lines INTEGER, gone_at TEXT, tail_sha1 TEXT, bad TEXT);
CREATE TABLE people (
  id TEXT PRIMARY KEY, kind TEXT, first_seen_at TEXT, last_seen_at TEXT, message_count INTEGER,
  affinity REAL, affinity_reason TEXT, affinity_decayed_at TEXT, real_name JSON, extra JSON, retired_at TEXT,
  owner_file TEXT
, status TEXT DEFAULT 'active', owner_key TEXT REFERENCES storage_units(id));
CREATE TABLE accounts (
  id TEXT PRIMARY KEY, iface TEXT, native_id TEXT, person_id TEXT, link TEXT, linked_by TEXT, linked_at TEXT,
  names JSON, avatar JSON, extra JSON, owner_file TEXT
, retired_at TEXT, authority_id TEXT REFERENCES authorities(id), native_key TEXT, generation INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'bot', 'shared', 'self')), gone_at TEXT, owner_key TEXT REFERENCES storage_units(id));
CREATE TABLE places (
  id TEXT PRIMARY KEY, iface TEXT, kind TEXT, native_id TEXT, parent_id TEXT, scope_kind TEXT,
  name TEXT, category TEXT, topic TEXT, extra JSON, retired_at TEXT, owner_file TEXT
, authority_id TEXT REFERENCES authorities(id), native_key TEXT, generation INTEGER NOT NULL DEFAULT 1, conversation TEXT CHECK (conversation IN ('dm', 'group')), partner_person TEXT, partner_account TEXT, gone_at TEXT, seen_from_at TEXT, seen_to_at TEXT, continues_place_id TEXT REFERENCES places(id), owner_key TEXT REFERENCES storage_units(id));
CREATE TABLE memberships (
  id TEXT PRIMARY KEY, account_id TEXT, place_id TEXT, nick TEXT, roles JSON, addressed_as JSON, pings_off INTEGER,
  extra JSON, valid_from_at TEXT, valid_to_at TEXT, owner_file TEXT
, retired_at TEXT, owner_key TEXT REFERENCES storage_units(id));
CREATE TABLE sources (
  rowid INTEGER PRIMARY KEY, id TEXT UNIQUE, kind TEXT, iface TEXT, native_id TEXT, revision INTEGER, place_id TEXT,
  author_account TEXT, reply_to TEXT, occurred_at TEXT, recorded_at TEXT, seen_at TEXT, text TEXT, stems TEXT,
  media JSON, mentions JSON, direct INTEGER, turn_id TEXT, op_id TEXT, think TEXT, extra JSON,
  scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, origin TEXT, owner_file TEXT, position INTEGER
, retired_at TEXT, authority_id TEXT, author_kind TEXT CHECK (author_kind IN ('account', 'participant', 'self')), observed_at TEXT, connection_id TEXT, audience_id TEXT REFERENCES audiences(id), author_participant TEXT REFERENCES participants(id), native_kind TEXT, generation INTEGER NOT NULL DEFAULT 1, tier TEXT CHECK (tier IS NULL OR tier IN ('a', 'b', 'c')), owner_key TEXT REFERENCES storage_units(id));
CREATE VIRTUAL TABLE sources_fts USING fts5(text, stems, content='sources', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE sources_tri USING fts5(text, content='sources', content_rowid='rowid', tokenize='trigram');
CREATE TABLE vectors (
  source_rowid INTEGER, item_id TEXT, chunk_key TEXT UNIQUE, model TEXT, dims INTEGER, scale REAL, norm REAL,
  bytes BLOB, context JSON, occurred_at TEXT, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT
, retired_at TEXT, owner_file TEXT, audience_id TEXT REFERENCES audiences(id), evicted_at TEXT, owner_key TEXT REFERENCES storage_units(id));
CREATE TABLE claims (
  id TEXT PRIMARY KEY, subject_kind TEXT, subject_id TEXT, kind TEXT, text TEXT, extra JSON, weight REAL,
  first_seen_at TEXT, last_seen_at TEXT, valid_to TEXT, superseded_by TEXT, how TEXT, author TEXT, from_person TEXT,
  truth TEXT, shown INTEGER, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, created_at TEXT, retired_at TEXT, origin_file TEXT, owner_file TEXT, position INTEGER
, audience_id TEXT REFERENCES audiences(id), owner_key TEXT REFERENCES storage_units(id));
CREATE TABLE claim_versions (
  id TEXT PRIMARY KEY, claim_id TEXT, revision_id TEXT, text TEXT, extra JSON, recorded_at TEXT, event TEXT, by TEXT,
  origin TEXT, owner_file TEXT, position INTEGER
, retired_at TEXT, owner_key TEXT REFERENCES storage_units(id));
CREATE TABLE claim_sources (claim_id TEXT, source_id TEXT, position INTEGER, retired_at TEXT, owner_file TEXT, id TEXT, owner_key TEXT REFERENCES storage_units(id));
CREATE TABLE descriptions (
  id TEXT PRIMARY KEY, subject_kind TEXT, subject_id TEXT, field TEXT, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, current_version TEXT, owner_file TEXT
, retired_at TEXT, audience_id TEXT REFERENCES audiences(id), owner_key TEXT REFERENCES storage_units(id));
CREATE TABLE description_versions (
  id TEXT PRIMARY KEY, description_id TEXT, text TEXT, author TEXT, written_at TEXT, chars INTEGER, kept INTEGER,
  removed INTEGER, added INTEGER, reason TEXT, origin TEXT, extra JSON, owner_file TEXT, position INTEGER
, retired_at TEXT, owner_key TEXT REFERENCES storage_units(id));
CREATE TABLE episodes (
  id TEXT PRIMARY KEY, kind TEXT, subject_id TEXT, place_id TEXT, date TEXT, what TEXT, quote TEXT, feeling TEXT,
  feeling_at TEXT, reread JSON, weight REAL, world TEXT, status TEXT, perspective TEXT, start_ms INTEGER,
  last_ms INTEGER, extra JSON, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, created_at TEXT, retired_at TEXT, owner_file TEXT, position INTEGER
, audience_id TEXT REFERENCES audiences(id), owner_key TEXT REFERENCES storage_units(id));
CREATE TABLE episode_sources (episode_id TEXT, source_id TEXT, position INTEGER, retired_at TEXT, owner_file TEXT, id TEXT, owner_key TEXT REFERENCES storage_units(id));
CREATE TABLE affinity_events (
  id TEXT PRIMARY KEY, person_id TEXT, at TEXT, delta REAL, applied REAL, score REAL, reason TEXT, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT,
  extra JSON, owner_file TEXT, position INTEGER
, retired_at TEXT, audience_id TEXT REFERENCES audiences(id), owner_key TEXT REFERENCES storage_units(id));
CREATE TABLE day (
  id TEXT PRIMARY KEY, at TEXT, what TEXT, outcome TEXT, reason TEXT, place_id TEXT, turn_id TEXT, source_id TEXT,
  work_id TEXT, extra JSON, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, owner_file TEXT, position INTEGER
, retired_at TEXT, audience_id TEXT REFERENCES audiences(id), owner_key TEXT REFERENCES storage_units(id));
CREATE TABLE diary (
  id TEXT PRIMARY KEY, at_ms INTEGER, kind TEXT, gist TEXT, text TEXT, picture_prompt TEXT, search TEXT, topic TEXT,
  world TEXT, status TEXT, perspective TEXT, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, extra JSON, owner_file TEXT, position INTEGER
, retired_at TEXT, audience_id TEXT REFERENCES audiences(id), owner_key TEXT REFERENCES storage_units(id));
CREATE TABLE diary_mirrors (diary_id TEXT, iface TEXT, place_id TEXT, native_ids JSON, posted_at TEXT, retired_at TEXT, owner_file TEXT, id TEXT, owner_key TEXT REFERENCES storage_units(id));
CREATE TABLE media (
  id TEXT PRIMARY KEY, kind TEXT, owner TEXT, path TEXT, native_ref TEXT, description TEXT, described_at TEXT,
  sha1 TEXT, bytes INTEGER, mime TEXT, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, extra JSON, owner_file TEXT
, retired_at TEXT, audience_id TEXT REFERENCES audiences(id), availability TEXT NOT NULL DEFAULT 'unknown' CHECK (availability IN ('present', 'missing', 'unknown')), owner_key TEXT REFERENCES storage_units(id));
CREATE TABLE intentions (
  id TEXT PRIMARY KEY, record JSON, status TEXT, due_ms INTEGER, created_ms INTEGER, updated_ms INTEGER, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT,
  archived INTEGER, owner_file TEXT, position INTEGER
, retired_at TEXT, audience_id TEXT REFERENCES audiences(id), owner_key TEXT REFERENCES storage_units(id));
CREATE TABLE work (
  id TEXT PRIMARY KEY, kind TEXT, state TEXT, record JSON, created_ms INTEGER, updated_ms INTEGER, outcome TEXT,
  seen INTEGER, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, owner_file TEXT, position INTEGER
, retired_at TEXT, audience_id TEXT REFERENCES audiences(id), owner_key TEXT REFERENCES storage_units(id));
CREATE TABLE work_events (id TEXT PRIMARY KEY, work_id TEXT, at_ms INTEGER, record JSON, owner_file TEXT, position INTEGER, retired_at TEXT, owner_key TEXT REFERENCES storage_units(id));
CREATE TABLE decisions (
  id TEXT PRIMARY KEY, at TEXT, by TEXT, target_kind TEXT, target_id TEXT, action TEXT, reason TEXT, extra JSON,
  owner_file TEXT, position INTEGER
, retired_at TEXT, owner_key TEXT REFERENCES storage_units(id));
CREATE TABLE operational (kind TEXT, owner TEXT, value JSON, owner_file TEXT, retired_at TEXT, owner_key TEXT REFERENCES storage_units(id), PRIMARY KEY (kind, owner));
CREATE TABLE session_runs (
  id TEXT PRIMARY KEY, sweep_id TEXT, scope_key TEXT, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, mode TEXT,
  started_at TEXT, finished_at TEXT, cursor_from INTEGER, cursor_to INTEGER, sources_n INTEGER,
  tokens_prompt INTEGER, tokens_completion INTEGER, model TEXT, outcome TEXT, counts JSON, errors JSON
, batch_key TEXT, applied INTEGER NOT NULL DEFAULT 0, result JSON, answer_source TEXT, audience_id TEXT REFERENCES audiences(id));
CREATE TABLE co_owners (tbl TEXT, key TEXT, owner_file TEXT, owner_key TEXT REFERENCES storage_units(id), PRIMARY KEY (tbl, key, owner_file));
CREATE TABLE interfaces (id TEXT PRIMARY KEY, name TEXT, contract INTEGER NOT NULL DEFAULT 1, extra JSON);
CREATE TABLE authorities (
    id TEXT PRIMARY KEY, iface TEXT NOT NULL REFERENCES interfaces(id), namespace TEXT NOT NULL, name TEXT, extra JSON, UNIQUE (iface, namespace)
  );
CREATE TABLE connections (
    id TEXT PRIMARY KEY, iface TEXT NOT NULL REFERENCES interfaces(id), authority_id TEXT REFERENCES authorities(id),
    self_account TEXT, capabilities JSON, status TEXT, extra JSON
  );
CREATE TABLE external_keys (
    authority_id TEXT NOT NULL REFERENCES authorities(id),
    object_kind TEXT NOT NULL CHECK (object_kind IN ('person', 'account', 'place', 'source', 'participant')),
    native_key TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1, node_id TEXT NOT NULL,
    valid_from_at TEXT, valid_to_at TEXT, recorded_at TEXT NOT NULL,
    PRIMARY KEY (authority_id, object_kind, native_key, generation)
  );
CREATE TABLE audiences (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('none', 'internal', 'group', 'dm')),
    iface TEXT REFERENCES interfaces(id), place_id TEXT REFERENCES places(id),
    CHECK ((kind IN ('none', 'internal') AND iface IS NULL AND place_id IS NULL)
        OR (kind = 'group' AND iface IS NOT NULL AND place_id IS NULL)
        OR (kind = 'dm' AND iface IS NOT NULL AND place_id IS NOT NULL)),
    CHECK (id = CASE kind WHEN 'none' THEN 'aud:none' WHEN 'internal' THEN 'aud:internal' WHEN 'group' THEN 'aud:group:' || iface ELSE 'aud:dm:' || place_id END)
  );
CREATE TABLE account_person_links (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), person_id TEXT NOT NULL REFERENCES people(id),
    state TEXT NOT NULL CHECK (state IN ('proposed', 'verified', 'revoked')),
    by TEXT, reason TEXT, evidence_id TEXT, valid_from_at TEXT, valid_to_at TEXT, recorded_at TEXT NOT NULL
  );
CREATE TABLE execution_contexts (
    id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK (mode IN ('outward', 'internal')), iface TEXT REFERENCES interfaces(id),
    destination_place_id TEXT, partner_person_id TEXT, policy_version INTEGER NOT NULL DEFAULT 1, issued_at TEXT NOT NULL
  );
CREATE TABLE "turn_reads" (
    turn_id TEXT, step TEXT, context_id TEXT NOT NULL DEFAULT '', row_kind TEXT, row_id TEXT, block TEXT, ord INTEGER, version_id TEXT, revision INTEGER,
    reader_kind TEXT NOT NULL DEFAULT 'turn' CHECK (reader_kind IN ('turn', 'session', 'wake')),
    PRIMARY KEY (turn_id, step, context_id, row_kind, row_id)
  );
CREATE TABLE participants (
    id TEXT PRIMARY KEY, authority_id TEXT NOT NULL REFERENCES authorities(id), scope_place_id TEXT REFERENCES places(id),
    token_kind TEXT NOT NULL CHECK (token_kind IN ('thread_token', 'site_token', 'post_number', 'display_name', 'none')), native_token TEXT, observation_key TEXT,
    generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
    continuity TEXT NOT NULL CHECK (continuity IN ('provider_asserted', 'verified', 'unknown')),
    display TEXT, first_seen_at TEXT, last_seen_at TEXT, extra JSON, recorded_at TEXT NOT NULL,
    CHECK (CASE
      WHEN token_kind = 'thread_token' THEN scope_place_id IS NOT NULL AND native_token IS NOT NULL AND native_token <> '' AND observation_key IS NULL
      WHEN token_kind = 'site_token' THEN scope_place_id IS NULL AND native_token IS NOT NULL AND native_token <> '' AND observation_key IS NULL
      WHEN token_kind = 'post_number' THEN native_token IS NOT NULL AND native_token <> '' AND observation_key IS NULL
      ELSE native_token IS NULL AND observation_key IS NOT NULL AND observation_key <> '' END)
  );
CREATE TABLE participant_links (
    id TEXT PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES participants(id),
    account_id TEXT REFERENCES accounts(id), person_id TEXT REFERENCES people(id),
    state TEXT NOT NULL CHECK (state IN ('proposed', 'verified', 'revoked')),
    by TEXT, reason TEXT, evidence_id TEXT, valid_from_at TEXT, valid_to_at TEXT, recorded_at TEXT NOT NULL,
    CHECK ((account_id IS NULL) <> (person_id IS NULL))
  );
CREATE TABLE people_merges (
    id TEXT PRIMARY KEY, from_person TEXT NOT NULL REFERENCES people(id), into_person TEXT NOT NULL REFERENCES people(id),
    at TEXT NOT NULL, by TEXT NOT NULL, reason TEXT, evidence JSON, CHECK (from_person <> into_person)
  );
CREATE TABLE capture_bundles (
    id TEXT PRIMARY KEY, anchor_source_id TEXT NOT NULL REFERENCES sources(id), place_id TEXT NOT NULL REFERENCES places(id),
    reason TEXT NOT NULL CHECK (reason IN ('own_line', 'mention', 'reply_to_me', 'expansion', 'watch')), policy_version INTEGER NOT NULL,
    coverage JSON NOT NULL CHECK (json_valid(coverage) AND json_type(coverage) = 'object' AND json_extract(coverage, '$.state') IN ('complete', 'pending_expansion', 'provider_unavailable', 'incomplete')), created_at TEXT NOT NULL, connection_id TEXT
  );
CREATE TABLE capture_members (
    bundle_id TEXT NOT NULL REFERENCES capture_bundles(id), source_id TEXT NOT NULL REFERENCES sources(id),
    role TEXT NOT NULL CHECK (role IN ('anchor', 'ancestor', 'before', 'after', 'reply', 'mention', 'same_author', 'watch')), added_at TEXT NOT NULL,
    PRIMARY KEY (bundle_id, source_id, role)
  );
CREATE TABLE capture_events (
    id INTEGER PRIMARY KEY, bundle_id TEXT NOT NULL REFERENCES capture_bundles(id), at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('initial', 'expansion', 'watch')), coverage JSON NOT NULL CHECK (json_valid(coverage) AND json_type(coverage) = 'object' AND json_extract(coverage, '$.state') IN ('complete', 'pending_expansion', 'provider_unavailable', 'incomplete')),
    added INTEGER NOT NULL DEFAULT 0
  );
CREATE TABLE capture_watches (
    id TEXT PRIMARY KEY, bundle_id TEXT NOT NULL REFERENCES capture_bundles(id), due_at TEXT NOT NULL, done_at TEXT,
    outcome TEXT CHECK (outcome IS NULL OR outcome IN ('fetched', 'nothing_new', 'unavailable')), extra JSON,
    CHECK ((done_at IS NULL) = (outcome IS NULL))
  );
CREATE TABLE source_relations (
    id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
    predicate TEXT NOT NULL CHECK (predicate IN ('replies_to', 'quotes', 'reposts', 'mentions', 'edits', 'references')), target_key TEXT NOT NULL,
    target_source_id TEXT REFERENCES sources(id), recorded_at TEXT NOT NULL, resolved_at TEXT,
    CHECK ((target_source_id IS NULL) = (resolved_at IS NULL))
  );
CREATE TABLE graph_nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, row_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE graph_edges (
    id TEXT PRIMARY KEY, src TEXT NOT NULL REFERENCES graph_nodes(id), predicate TEXT NOT NULL, dst TEXT NOT NULL REFERENCES graph_nodes(id),
    audience_id TEXT NOT NULL REFERENCES audiences(id), evidence_id TEXT, valid_from_at TEXT, valid_to_at TEXT, recorded_at TEXT NOT NULL,
    retired_at TEXT, projection_key TEXT NOT NULL UNIQUE, owner_key TEXT NOT NULL
  );
CREATE TABLE node_access (
    node_id TEXT NOT NULL REFERENCES graph_nodes(id), audience_id TEXT NOT NULL REFERENCES audiences(id), evidence_id TEXT NOT NULL,
    PRIMARY KEY (node_id, audience_id, evidence_id)
  );
CREATE TABLE claim_version_sources (
    version_id TEXT NOT NULL REFERENCES claim_versions(id), source_id TEXT NOT NULL REFERENCES sources(id),
    role TEXT NOT NULL CHECK (role IN ('supports', 'conflicts')), legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1)),
    PRIMARY KEY (version_id, source_id)
  );
CREATE TABLE publication_grants (
    id TEXT PRIMARY KEY, row_kind TEXT NOT NULL, row_id TEXT NOT NULL, content_hash TEXT NOT NULL CHECK (content_hash <> ''),
    destinations JSON NOT NULL CHECK (json_valid(destinations) AND json_type(destinations) = 'array' AND json_array_length(destinations) > 0),
    approved_by TEXT NOT NULL CHECK (approved_by <> ''), approved_at TEXT NOT NULL, reason TEXT, revoked_at TEXT
  );
CREATE TABLE relationship_daily (
    person_id TEXT NOT NULL REFERENCES people(id), day TEXT NOT NULL, audience_id TEXT NOT NULL REFERENCES audiences(id),
    addressed_by_them INTEGER NOT NULL DEFAULT 0, addressed_by_her INTEGER NOT NULL DEFAULT 0,
    meaningful INTEGER NOT NULL DEFAULT 0 CHECK (meaningful IN (0, 1)), last_contact_at TEXT,
    PRIMARY KEY (person_id, day, audience_id)
  );
CREATE TABLE focus_members (
    person_id TEXT PRIMARY KEY REFERENCES people(id), bucket TEXT NOT NULL CHECK (bucket IN ('close', 'exploring')),
    since TEXT NOT NULL, score REAL, policy_version INTEGER NOT NULL, reason JSON
  );
CREATE TABLE focus_events (
    id TEXT PRIMARY KEY, person_id TEXT NOT NULL, at TEXT NOT NULL, old_bucket TEXT, new_bucket TEXT, reason TEXT NOT NULL,
    policy_version INTEGER NOT NULL, extra JSON
  );
CREATE TABLE focus_overrides (
    person_id TEXT PRIMARY KEY REFERENCES people(id), kind TEXT NOT NULL CHECK (kind IN ('pin', 'exclude')), expires_at TEXT,
    approved_by TEXT NOT NULL CHECK (approved_by <> ''), reason TEXT
  );
CREATE TABLE wake_runs (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, trigger TEXT, scheduled_at TEXT, started_at TEXT, finished_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'interrupted')), context_id TEXT REFERENCES execution_contexts(id),
    inputs JSON CHECK (inputs IS NULL OR json_valid(inputs)), policy_version INTEGER, outcome TEXT, extra JSON CHECK (extra IS NULL OR json_valid(extra))
  );
CREATE TABLE wake_actions (
    run_id TEXT NOT NULL REFERENCES wake_runs(id), n INTEGER NOT NULL CHECK (n >= 1),
    idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key = 'wake:' || run_id || ':' || n),
    kind TEXT NOT NULL, target TEXT, status TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (run_id, n)
  );
CREATE TABLE skills (
    id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, active_version TEXT REFERENCES skill_versions(id),
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'stale', 'archived')), origin_work_id TEXT,
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)), extra JSON CHECK (extra IS NULL OR json_valid(extra))
  );
CREATE TABLE skill_versions (
    id TEXT PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES skills(id), version TEXT NOT NULL,
    content_hash TEXT NOT NULL CHECK (content_hash <> ''), manifest_hash TEXT NOT NULL CHECK (manifest_hash <> ''),
    commit_sha TEXT NOT NULL CHECK (commit_sha <> ''), origin_work_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'retired')), created_at TEXT NOT NULL,
    manifest JSON NOT NULL CHECK (json_valid(manifest) AND json_type(manifest) = 'object'), source TEXT,
    UNIQUE (skill_id, content_hash, manifest_hash, commit_sha)
  );
CREATE TABLE skill_evaluations (
    id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES skill_versions(id),
    kind TEXT NOT NULL CHECK (kind IN ('tests', 'trial', 'outcome', 'audience_check')), passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
    result JSON CHECK (result IS NULL OR json_valid(result)), evidence_id TEXT, at TEXT NOT NULL,
    content_hash TEXT NOT NULL, manifest_hash TEXT NOT NULL, commit_sha TEXT NOT NULL
  );
CREATE TABLE index_policy (
    node_id TEXT PRIMARY KEY, tier TEXT NOT NULL CHECK (tier IN ('a', 'b', 'c')), reason TEXT,
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)), evaluated_at TEXT NOT NULL, expires_at TEXT
  );
CREATE TABLE mirrors (
  id TEXT PRIMARY KEY, row_kind TEXT NOT NULL, place_id TEXT NOT NULL REFERENCES places(id),
  enabled INTEGER NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, extra JSON, registered_at INTEGER, removed_at TEXT, removed_by TEXT, backfill_enabled INTEGER NOT NULL DEFAULT 0, backfill_interval_ms INTEGER, backfill_high_water TEXT, backfill_next_due_at INTEGER, backfill_completed_at INTEGER,
  UNIQUE (row_kind, place_id)
);
CREATE TABLE ingest (
  principal TEXT NOT NULL, seq INTEGER, event_id TEXT NOT NULL, kind TEXT NOT NULL, conversation TEXT,
  committed_at TEXT NOT NULL, held JSON, source_id TEXT REFERENCES sources(id),
  UNIQUE (principal, event_id), UNIQUE (principal, seq)
);
CREATE TABLE ingest_cursor (principal TEXT PRIMARY KEY, acked_seq INTEGER NOT NULL);
CREATE TABLE wakes (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, community TEXT, due_at INTEGER, queued_at INTEGER NOT NULL,
  payload JSON NOT NULL, state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'handled', 'slept', 'dropped')),
  lease_holder TEXT, lease_token INTEGER, lease_expires_at INTEGER, handled_at INTEGER, outcome TEXT,
  turn_id TEXT, attempt INTEGER NOT NULL DEFAULT 0, claimed_at INTEGER, turn JSON
);
CREATE TABLE leases (
  name TEXT PRIMARY KEY, holder TEXT NOT NULL, token INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  renewed_at INTEGER NOT NULL
);
CREATE TABLE "deliveries" (
  key TEXT PRIMARY KEY, wake_id TEXT NOT NULL REFERENCES wakes(id), target TEXT, payload JSON NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'sent', 'unknown', 'failed')), queued_at INTEGER NOT NULL,
  sent_at INTEGER, receipt JSON
);
CREATE TABLE skill_uses (
    id INTEGER PRIMARY KEY AUTOINCREMENT, skill TEXT NOT NULL, version_id TEXT NOT NULL REFERENCES skill_versions(id),
    turn_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('discovered', 'read', 'tried', 'succeeded', 'corrected', 'declined')), at TEXT NOT NULL
  );
CREATE TABLE message_families (
    iface TEXT NOT NULL CHECK(length(iface) > 0 AND instr(iface, char(0)) = 0) REFERENCES interfaces(id),
    conversation_id TEXT NOT NULL CHECK(length(conversation_id) > 0 AND instr(conversation_id, char(0)) = 0), message_id TEXT NOT NULL CHECK(length(message_id) > 0 AND instr(message_id, char(0)) = 0),
    generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
    authority_id TEXT NOT NULL CHECK(length(authority_id) > 0 AND instr(authority_id, char(0)) = 0) REFERENCES authorities(id),
    native_kind TEXT NOT NULL CHECK(length(native_kind) > 0 AND instr(native_kind, char(0)) = 0), native_key TEXT NOT NULL CHECK(length(native_key) > 0 AND instr(native_key, char(0)) = 0),
    PRIMARY KEY(iface, conversation_id, message_id, generation),
    UNIQUE(authority_id, native_kind, native_key, generation)
  );
CREATE TABLE storage_units (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
    scope_place_id TEXT, partition TEXT, selector JSON, key_json TEXT NOT NULL UNIQUE,
    lines INTEGER, offset INTEGER, synced_at TEXT, retired_at TEXT);
CREATE TABLE legacy_unit_aliases(path TEXT PRIMARY KEY, unit_id TEXT NOT NULL REFERENCES storage_units(id));
CREATE TABLE model_requests (
  id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, turn_id TEXT, attempt_id TEXT, step INTEGER, role TEXT, model TEXT,
  purpose TEXT, status TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'failed', 'unknown')), started_at TEXT NOT NULL,
  finished_at TEXT, system_text TEXT, messages JSON NOT NULL, tools JSON, tool_choice TEXT, response_text TEXT, think TEXT,
  tool_calls JSON, usage JSON, error_code TEXT, source TEXT
, service TEXT, backend TEXT, run_id TEXT, outcome JSON);
CREATE TABLE "publications" (
      id TEXT PRIMARY KEY, row_kind TEXT NOT NULL, row_id TEXT NOT NULL, content_hash TEXT, rendered TEXT,
      destination_place_id TEXT REFERENCES places(id), context_id TEXT REFERENCES execution_contexts(id),
      grant_id TEXT REFERENCES publication_grants(id),
      status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'incomplete', 'unknown')),
      idempotency_key TEXT NOT NULL UNIQUE, receipts JSON CHECK (receipts IS NULL OR (json_valid(receipts) AND json_type(receipts) = 'array')),
      created_at TEXT NOT NULL, sent_at TEXT, owner_file TEXT, retired_at TEXT, owner_key TEXT REFERENCES storage_units(id),
      code TEXT, retryable INTEGER, claimed_by TEXT, claimed_at INTEGER, paced INTEGER NOT NULL DEFAULT 0,
      reconciled_by TEXT, reconciled_at TEXT, delivery JSON CHECK (delivery IS NULL OR json_valid(delivery)),
      CHECK ((content_hash IS NULL) = (rendered IS NULL))
    );
CREATE TABLE board_schema_version (version INTEGER NOT NULL);
CREATE TABLE board_dependencies (
  task_id TEXT NOT NULL, depends_on_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('blocks','parent-child','discovered-from','related')),
  created_by TEXT, created_at TEXT,
  PRIMARY KEY (task_id, depends_on_id)
);
CREATE TABLE board_attempts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, n INTEGER, principal TEXT, role TEXT, model TEXT, provider_pin TEXT,
  worktree TEXT, branch TEXT, db_path TEXT, started_at TEXT, ended_at TEXT, exit_code INTEGER, finish_reason TEXT,
  steps INTEGER, tokens_in INTEGER, tokens_out INTEGER, tokens_reasoning INTEGER, cache_read INTEGER, cache_write INTEGER,
  cost_est_usd REAL, cost_billed_usd REAL, rejected_asks INTEGER, failed_tools INTEGER,
  loop_signals TEXT, stall_signals TEXT,
  outcome TEXT CHECK (outcome IN ('done','failed','stopped','stalled','over-budget','needs_answer'))
);
CREATE TABLE board_questions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_id TEXT, asked_by TEXT, text TEXT, to_whom TEXT NOT NULL,
  answer TEXT, answered_by TEXT, answered_at TEXT, created_at TEXT
);
CREATE TABLE board_comments (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT, text TEXT, created_at TEXT);
CREATE TABLE board_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, actor TEXT, type TEXT, old TEXT, new TEXT, created_at TEXT
);
CREATE TABLE board_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, to_whom TEXT, kind TEXT, payload TEXT,
  created_at TEXT, delivered_at TEXT
);
CREATE TABLE board_idempotency (key TEXT PRIMARY KEY, principal TEXT, response TEXT, created_at TEXT);
CREATE TABLE board_agent_runs (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT, wave INTEGER, started_at TEXT NOT NULL, ended_at TEXT,
  trigger_seqs TEXT, steps INTEGER, tokens_in INTEGER, tokens_out INTEGER, cache_read INTEGER, cache_write INTEGER,
  cost_est_usd REAL, context_mean INTEGER, context_peak INTEGER, compactions INTEGER, outcome TEXT
);
CREATE TABLE "board_tasks" (
  id TEXT PRIMARY KEY,
  lane TEXT CHECK (lane IN ('dev','errand')),
  project TEXT,
  title TEXT NOT NULL, description TEXT, acceptance TEXT,
  requester TEXT NOT NULL,
  priority INTEGER CHECK (priority BETWEEN 0 AND 4) DEFAULT 2,
  risk TEXT CHECK (risk IN ('low','normal','high')) DEFAULT 'normal',
  role TEXT,
  budget_usd REAL, step_cap INTEGER, estimate_minutes INTEGER,
  status TEXT NOT NULL CHECK (status IN ('proposed','triaged','approved','rejected','in_progress','needs_answer','needs_validation','blocked','done','failed','cancelled')),
  close_reason TEXT, defer_until TEXT,
  is_blocked INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  lease_owner TEXT, lease_expires_at TEXT, heartbeat_at TEXT,
  subscriber TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  metadata TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  unblocks TEXT
);
CREATE TABLE "board_reviews" (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, principal TEXT,
  decision TEXT CHECK (decision IN ('approve','reject','accept','changes')),
  scope TEXT CHECK (scope IN ('plan','merge','deploy')),
  note TEXT, created_at TEXT
);
CREATE TABLE "board_results" (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_id TEXT,
  kind TEXT CHECK (kind IN ('summary','diff','pr','answer','file','prompt','spec','handoff')),
  body TEXT, uri TEXT, created_at TEXT
);
INSERT INTO "schema_version" ("version") VALUES (1);
INSERT INTO "schema_version" ("version") VALUES (2);
INSERT INTO "schema_version" ("version") VALUES (3);
INSERT INTO "schema_version" ("version") VALUES (4);
INSERT INTO "schema_version" ("version") VALUES (5);
INSERT INTO "schema_version" ("version") VALUES (6);
INSERT INTO "schema_version" ("version") VALUES (7);
INSERT INTO "schema_version" ("version") VALUES (8);
INSERT INTO "schema_version" ("version") VALUES (9);
INSERT INTO "schema_version" ("version") VALUES (10);
INSERT INTO "schema_version" ("version") VALUES (11);
INSERT INTO "schema_version" ("version") VALUES (12);
INSERT INTO "schema_version" ("version") VALUES (13);
INSERT INTO "schema_version" ("version") VALUES (14);
INSERT INTO "schema_version" ("version") VALUES (15);
INSERT INTO "schema_version" ("version") VALUES (16);
INSERT INTO "schema_version" ("version") VALUES (17);
INSERT INTO "schema_version" ("version") VALUES (18);
INSERT INTO "schema_version" ("version") VALUES (19);
INSERT INTO "schema_version" ("version") VALUES (20);
INSERT INTO "schema_version" ("version") VALUES (21);
INSERT INTO "schema_version" ("version") VALUES (22);
INSERT INTO "schema_version" ("version") VALUES (23);
INSERT INTO "schema_version" ("version") VALUES (24);
INSERT INTO "schema_version" ("version") VALUES (25);
INSERT INTO "schema_version" ("version") VALUES (26);
INSERT INTO "schema_version" ("version") VALUES (27);
INSERT INTO "schema_version" ("version") VALUES (28);
INSERT INTO "meta" ("key","value") VALUES ('stemmer','{"count":0,"endings":[],"productivity":[]}');
INSERT INTO "meta" ("key","value") VALUES ('stems_pending','1');
INSERT INTO "meta" ("key","value") VALUES ('focus_last_day','2026-10-01');
INSERT INTO "people" ("id","kind","first_seen_at","last_seen_at","message_count","affinity","affinity_reason","affinity_decayed_at","real_name","extra","retired_at","owner_file","status","owner_key") VALUES ('person:self','self',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'active',NULL);
INSERT INTO "people" ("id","kind","first_seen_at","last_seen_at","message_count","affinity","affinity_reason","affinity_decayed_at","real_name","extra","retired_at","owner_file","status","owner_key") VALUES ('person:discord:u1','member','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',1,0,'',NULL,NULL,'{"detailsSeq":1,"updatedAt":null,"$has":["details","interests","aliases","episodes","affinity","affinity.history"]}',NULL,NULL,'active','unit:dae2fbd39e6cdc060f4c20cdd4515a4e');
INSERT INTO "people" ("id","kind","first_seen_at","last_seen_at","message_count","affinity","affinity_reason","affinity_decayed_at","real_name","extra","retired_at","owner_file","status","owner_key") VALUES ('person:discord:u2','member','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',1,0,'',NULL,NULL,'{"detailsSeq":1,"updatedAt":null,"$has":["details","interests","aliases","episodes","affinity","affinity.history"]}',NULL,NULL,'active','unit:8adc9170509132aa288fce2d6f7c8073');
INSERT INTO "people" ("id","kind","first_seen_at","last_seen_at","message_count","affinity","affinity_reason","affinity_decayed_at","real_name","extra","retired_at","owner_file","status","owner_key") VALUES ('person:0b7a4c1e',NULL,'2026-10-01T12:00:00.000Z',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "people" ("id","kind","first_seen_at","last_seen_at","message_count","affinity","affinity_reason","affinity_decayed_at","real_name","extra","retired_at","owner_file","status","owner_key") VALUES ('person:merged-a',NULL,'2026-10-01T12:00:00.000Z',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'merged_into:person:merged-b',NULL);
INSERT INTO "people" ("id","kind","first_seen_at","last_seen_at","message_count","affinity","affinity_reason","affinity_decayed_at","real_name","extra","retired_at","owner_file","status","owner_key") VALUES ('person:merged-b',NULL,'2026-10-01T12:00:00.000Z',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'merged_into:person:0b7a4c1e',NULL);
INSERT INTO "accounts" ("id","iface","native_id","person_id","link","linked_by","linked_at","names","avatar","extra","owner_file","retired_at","authority_id","native_key","generation","kind","gone_at","owner_key") VALUES ('discord:u1','discord','u1','person:discord:u1','verified',NULL,NULL,'["Anna"]',NULL,NULL,NULL,NULL,'discord/global','u1',1,'user',NULL,'unit:dae2fbd39e6cdc060f4c20cdd4515a4e');
INSERT INTO "accounts" ("id","iface","native_id","person_id","link","linked_by","linked_at","names","avatar","extra","owner_file","retired_at","authority_id","native_key","generation","kind","gone_at","owner_key") VALUES ('discord:u2','discord','u2','person:0b7a4c1e','verified','owner',NULL,'["Boris"]',NULL,NULL,NULL,NULL,'discord/global','u2',1,'user',NULL,'unit:8adc9170509132aa288fce2d6f7c8073');
INSERT INTO "places" ("id","iface","kind","native_id","parent_id","scope_kind","name","category","topic","extra","retired_at","owner_file","authority_id","native_key","generation","conversation","partner_person","partner_account","gone_at","seen_from_at","seen_to_at","continues_place_id","owner_key") VALUES ('discord:guild:g1','discord','guild','g1',NULL,'group',NULL,NULL,NULL,NULL,NULL,NULL,'discord/global','guild:g1',1,NULL,NULL,NULL,NULL,'2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL,'unit:3678eaeac42aa03fc4e317af1d8db316');
INSERT INTO "places" ("id","iface","kind","native_id","parent_id","scope_kind","name","category","topic","extra","retired_at","owner_file","authority_id","native_key","generation","conversation","partner_person","partner_account","gone_at","seen_from_at","seen_to_at","continues_place_id","owner_key") VALUES ('discord:channel:c1','discord','channel','c1','discord:guild:g1','group','',NULL,NULL,NULL,NULL,NULL,'discord/global','channel:c1',1,'group',NULL,NULL,NULL,'2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL,'unit:7d1333f1393fe317691fce8428459583');
INSERT INTO "places" ("id","iface","kind","native_id","parent_id","scope_kind","name","category","topic","extra","retired_at","owner_file","authority_id","native_key","generation","conversation","partner_person","partner_account","gone_at","seen_from_at","seen_to_at","continues_place_id","owner_key") VALUES ('discord:channel:c2','discord','channel','c2','discord:guild:g1','group','c2',NULL,NULL,NULL,NULL,NULL,'discord/global','channel:c2',1,'group',NULL,NULL,NULL,'2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL,NULL);
INSERT INTO "places" ("id","iface","kind","native_id","parent_id","scope_kind","name","category","topic","extra","retired_at","owner_file","authority_id","native_key","generation","conversation","partner_person","partner_account","gone_at","seen_from_at","seen_to_at","continues_place_id","owner_key") VALUES ('discord:dm:u1','discord','dm',NULL,NULL,'dm',NULL,NULL,NULL,NULL,NULL,NULL,'discord/global','dm:u1',1,'dm',NULL,'discord:u1',NULL,'2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL,NULL);
INSERT INTO "places" ("id","iface","kind","native_id","parent_id","scope_kind","name","category","topic","extra","retired_at","owner_file","authority_id","native_key","generation","conversation","partner_person","partner_account","gone_at","seen_from_at","seen_to_at","continues_place_id","owner_key") VALUES ('discord:dm:u2','discord','dm',NULL,NULL,'dm',NULL,NULL,NULL,NULL,NULL,NULL,'discord/global','dm:u2',1,'dm',NULL,'discord:u2',NULL,'2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL,NULL);
INSERT INTO "sources" ("rowid","id","kind","iface","native_id","revision","place_id","author_account","reply_to","occurred_at","recorded_at","seen_at","text","stems","media","mentions","direct","turn_id","op_id","think","extra","scope_kind","scope_iface","scope_dm","origin","owner_file","position","retired_at","authority_id","author_kind","observed_at","connection_id","audience_id","author_participant","native_kind","generation","tier","owner_key") VALUES (1,'source:afa39593f8d20af4a695f01fb6456d94','seen','discord','o1',0,'discord:channel:c1','discord:u1',NULL,'2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z','observed line o1',NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,'group','discord',NULL,'observation',NULL,NULL,NULL,'discord/global','account','2026-10-01T12:00:00.000Z',NULL,'aud:group:discord',NULL,'message',1,NULL,NULL);
INSERT INTO "sources" ("rowid","id","kind","iface","native_id","revision","place_id","author_account","reply_to","occurred_at","recorded_at","seen_at","text","stems","media","mentions","direct","turn_id","op_id","think","extra","scope_kind","scope_iface","scope_dm","origin","owner_file","position","retired_at","authority_id","author_kind","observed_at","connection_id","audience_id","author_participant","native_kind","generation","tier","owner_key") VALUES (2,'source:a29860a56df16360c3737cc0ac83d1dd','seen','discord','o2',0,'discord:channel:c2','discord:u2',NULL,'2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z','observed line o2',NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,'group','discord',NULL,'observation',NULL,NULL,NULL,'discord/global','account','2026-10-01T12:00:00.000Z',NULL,'aud:group:discord',NULL,'message',1,NULL,NULL);
INSERT INTO "sources" ("rowid","id","kind","iface","native_id","revision","place_id","author_account","reply_to","occurred_at","recorded_at","seen_at","text","stems","media","mentions","direct","turn_id","op_id","think","extra","scope_kind","scope_iface","scope_dm","origin","owner_file","position","retired_at","authority_id","author_kind","observed_at","connection_id","audience_id","author_participant","native_kind","generation","tier","owner_key") VALUES (3,'source:d33c7104a1d4700597d6d862c9f07272','seen','discord','o3',0,'discord:dm:u1','discord:u1',NULL,'2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z','observed line o3',NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,'dm','discord',NULL,'observation',NULL,NULL,NULL,'discord/global','account','2026-10-01T12:00:00.000Z',NULL,'aud:dm:discord:dm:u1',NULL,'message',1,NULL,NULL);
INSERT INTO "sources" ("rowid","id","kind","iface","native_id","revision","place_id","author_account","reply_to","occurred_at","recorded_at","seen_at","text","stems","media","mentions","direct","turn_id","op_id","think","extra","scope_kind","scope_iface","scope_dm","origin","owner_file","position","retired_at","authority_id","author_kind","observed_at","connection_id","audience_id","author_participant","native_kind","generation","tier","owner_key") VALUES (4,'source:7a50bbe9b550a9449415e572fb780bd6','seen','discord','o4',0,'discord:dm:u2','discord:u2',NULL,'2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z','observed line o4',NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,'dm','discord',NULL,'observation',NULL,NULL,NULL,'discord/global','account','2026-10-01T12:00:00.000Z',NULL,'aud:dm:discord:dm:u2',NULL,'message',1,NULL,NULL);
INSERT INTO "sources" ("rowid","id","kind","iface","native_id","revision","place_id","author_account","reply_to","occurred_at","recorded_at","seen_at","text","stems","media","mentions","direct","turn_id","op_id","think","extra","scope_kind","scope_iface","scope_dm","origin","owner_file","position","retired_at","authority_id","author_kind","observed_at","connection_id","audience_id","author_participant","native_kind","generation","tier","owner_key") VALUES (5,'src:discord:m1:1:seen','seen','discord','m1',1,'discord:channel:c1','discord:u1',NULL,'2026-10-01T12:00:00.000Z','2026-11-05T04:07:05.527Z','2026-11-05T04:07:05.527Z','a recorded line',NULL,'[]','[]',0,NULL,NULL,NULL,'{"v":1,"id":"6a0fa59a-198a-4120-a5ca-479a12b44c2c","guildId":"g1","participants":["u1"],"sourceMessageIds":["m1"],"$null":["replyTo"],"$messageLocator":{"v":1,"origin":"record-v1","iface":"discord","conversationId":"c1","messageId":"m1"}}','group','discord',NULL,'live',NULL,0,NULL,'discord/global','account','2026-11-05T04:07:05.527Z',NULL,'aud:group:discord',NULL,'message',1,NULL,'unit:c676dd55b9f169af18945bcc0bf315e1');
INSERT INTO "sources" ("rowid","id","kind","iface","native_id","revision","place_id","author_account","reply_to","occurred_at","recorded_at","seen_at","text","stems","media","mentions","direct","turn_id","op_id","think","extra","scope_kind","scope_iface","scope_dm","origin","owner_file","position","retired_at","authority_id","author_kind","observed_at","connection_id","audience_id","author_participant","native_kind","generation","tier","owner_key") VALUES (6,'src:discord:m2:1:seen','seen','discord','m2',1,'discord:dm:u1','discord:u1',NULL,'2026-10-01T12:00:00.000Z','2026-11-05T04:07:05.530Z','2026-11-05T04:07:05.530Z','a private recorded line',NULL,'[]','[]',0,NULL,NULL,NULL,'{"v":1,"id":"14205010-faac-40c3-9b38-2585c4e0e7f4","guildId":"g1","participants":["u1"],"sourceMessageIds":["m2"],"$null":["replyTo"],"$messageLocator":{"v":1,"origin":"record-v1","iface":"discord","conversationId":"dm-native","messageId":"m2"},"scope":{"user":"u1","private":true,"channel":"dm-native"}}','dm','discord','person:discord:u1','live',NULL,0,NULL,'discord/global','account','2026-11-05T04:07:05.530Z',NULL,'aud:dm:discord:dm:u1',NULL,'message',1,NULL,'unit:ea00c78f0c9a769ae5ecce63725a3298');
INSERT INTO "sources" ("rowid","id","kind","iface","native_id","revision","place_id","author_account","reply_to","occurred_at","recorded_at","seen_at","text","stems","media","mentions","direct","turn_id","op_id","think","extra","scope_kind","scope_iface","scope_dm","origin","owner_file","position","retired_at","authority_id","author_kind","observed_at","connection_id","audience_id","author_participant","native_kind","generation","tier","owner_key") VALUES (7,'src:discord:m3:1:seen','seen','discord','m3',1,'discord:dm:u2','discord:u1',NULL,'2026-10-01T12:00:00.000Z','2026-11-05T04:07:05.532Z','2026-11-05T04:07:05.532Z','a line with no community',NULL,'[]','[]',0,NULL,NULL,NULL,'{"v":1,"id":"f0952302-10ae-4505-8ff1-8da17f9db62a","guildId":"no-community","participants":["u1"],"sourceMessageIds":["m3"],"$null":["replyTo"],"$messageLocator":{"v":1,"origin":"record-v1","iface":"discord","conversationId":"dm-native","messageId":"m3"},"scope":{"user":"u2","private":true,"channel":"dm-native"}}','dm','discord','person:discord:u2','live',NULL,0,NULL,'discord/global','account','2026-11-05T04:07:05.532Z',NULL,'aud:dm:discord:dm:u2',NULL,'message',1,NULL,'unit:ba8ef3b527ef96619bb15961e6684b2f');
INSERT INTO "claims" ("id","subject_kind","subject_id","kind","text","extra","weight","first_seen_at","last_seen_at","valid_to","superseded_by","how","author","from_person","truth","shown","scope_kind","scope_iface","scope_dm","created_at","retired_at","origin_file","owner_file","position","audience_id","owner_key") VALUES ('dt-d6e482b2-c443-487e-af64-6a6b56dc5d72','person','person:discord:u1','detail','told in the server partition','{"id":1,"recordedAt":"2026-11-05T04:07:05.499Z"}',1,'2026-11-05T04:07:05.499Z','2026-11-05T04:07:05.499Z',NULL,NULL,'legacy','import',NULL,'current',1,'dm','discord','person:discord:u1',NULL,NULL,'unit:43ac0f11ced04660c949ccdd8f405a09',NULL,0,'aud:dm:discord:dm:u1','unit:43ac0f11ced04660c949ccdd8f405a09');
INSERT INTO "claims" ("id","subject_kind","subject_id","kind","text","extra","weight","first_seen_at","last_seen_at","valid_to","superseded_by","how","author","from_person","truth","shown","scope_kind","scope_iface","scope_dm","created_at","retired_at","origin_file","owner_file","position","audience_id","owner_key") VALUES ('lore:5xp3y3','place','discord:guild:g1','lore','the roof holds bees','{"title":"a synthetic fact","keys":["fact"],"always":false}',3,'2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL,NULL,'legacy','owner',NULL,'current',1,'group','discord',NULL,NULL,NULL,'unit:17642bf6db3bf541370b68c369c88d0d',NULL,0,'aud:group:discord','unit:17642bf6db3bf541370b68c369c88d0d');
INSERT INTO "claims" ("id","subject_kind","subject_id","kind","text","extra","weight","first_seen_at","last_seen_at","valid_to","superseded_by","how","author","from_person","truth","shown","scope_kind","scope_iface","scope_dm","created_at","retired_at","origin_file","owner_file","position","audience_id","owner_key") VALUES ('ar1',NULL,NULL,'episode',NULL,NULL,1,'2026-09-01','2026-10-01T12:00:00.000Z',NULL,NULL,'archive','import',NULL,'historical',0,'group','discord',NULL,NULL,'2026-10-01T12:00:00.000Z','unit:636ce7c41c7455c8539a6ec591011b18',NULL,NULL,'aud:group:discord','unit:636ce7c41c7455c8539a6ec591011b18');
INSERT INTO "claims" ("id","subject_kind","subject_id","kind","text","extra","weight","first_seen_at","last_seen_at","valid_to","superseded_by","how","author","from_person","truth","shown","scope_kind","scope_iface","scope_dm","created_at","retired_at","origin_file","owner_file","position","audience_id","owner_key") VALUES ('ar2','person','person:discord:u1','episode',NULL,NULL,1,'2026-09-01','2026-10-01T12:00:00.000Z',NULL,NULL,'archive','import',NULL,'historical',0,'dm','discord','person:discord:u1',NULL,'2026-10-01T12:00:00.000Z','unit:835ad76e2422d0a068250d2a1ee3b6dc',NULL,NULL,'aud:dm:discord:dm:u1','unit:835ad76e2422d0a068250d2a1ee3b6dc');
INSERT INTO "claims" ("id","subject_kind","subject_id","kind","text","extra","weight","first_seen_at","last_seen_at","valid_to","superseded_by","how","author","from_person","truth","shown","scope_kind","scope_iface","scope_dm","created_at","retired_at","origin_file","owner_file","position","audience_id","owner_key") VALUES ('dt-ab86a51c-fd47-468c-b6ea-4274f881e8db','person','person:discord:u2','detail','told with no community','{"id":1,"recordedAt":"2026-11-05T04:07:05.538Z"}',1,'2026-11-05T04:07:05.538Z','2026-11-05T04:07:05.538Z',NULL,NULL,'legacy','import',NULL,'current',1,'dm','discord','person:discord:u2',NULL,NULL,'unit:73f8b674c1125b3b1a382ff1ca4d60ad',NULL,0,'aud:dm:discord:dm:u2','unit:73f8b674c1125b3b1a382ff1ca4d60ad');
INSERT INTO "claims" ("id","subject_kind","subject_id","kind","text","extra","weight","first_seen_at","last_seen_at","valid_to","superseded_by","how","author","from_person","truth","shown","scope_kind","scope_iface","scope_dm","created_at","retired_at","origin_file","owner_file","position","audience_id","owner_key") VALUES ('recent_line::d4b2a096b3f5a4ed','place',NULL,'recent_line','a synthetic recent line','{"id":1,"$derived":true}',NULL,NULL,NULL,NULL,NULL,'legacy','import',NULL,'current',1,'group','discord',NULL,NULL,NULL,'unit:8b3a74741c7a5cf66ddcd7fcb17d9d89',NULL,0,'aud:group:discord','unit:8b3a74741c7a5cf66ddcd7fcb17d9d89');
INSERT INTO "claims" ("id","subject_kind","subject_id","kind","text","extra","weight","first_seen_at","last_seen_at","valid_to","superseded_by","how","author","from_person","truth","shown","scope_kind","scope_iface","scope_dm","created_at","retired_at","origin_file","owner_file","position","audience_id","owner_key") VALUES ('claim:retired','person','person:0b7a4c1e','detail','an old retired detail',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'current',1,'dm',NULL,NULL,'2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL,NULL,NULL,'aud:dm:discord:dm:u2','unit:43ac0f11ced04660c949ccdd8f405a09');
INSERT INTO "claim_versions" ("id","claim_id","revision_id","text","extra","recorded_at","event","by","origin","owner_file","position","retired_at","owner_key") VALUES ('b6169014-6f3d-4750-80b7-0257450d5d49','ar1','rv-26253ef022cc',NULL,'{"v":1,"kind":"archive","itemKind":"episode","scope":{"guild":true},"participants":[],"observedAt":{"date":"2026-09-01","precision":"day"},"lastSeen":"2026-10-01T12:00:00.000Z","sourceRefs":[],"neutral":null,"text":{"what":"evicted ar1"},"weight":1,"stored":{"date":"2026-09-01","addedAt":"2026-10-01T12:00:00.000Z"},"occurredAt":"2026-10-01T12:00:00.000Z","guildId":"g1"}','2026-10-01T12:00:00.000Z','evicted','store','live',NULL,0,NULL,'unit:636ce7c41c7455c8539a6ec591011b18');
INSERT INTO "claim_versions" ("id","claim_id","revision_id","text","extra","recorded_at","event","by","origin","owner_file","position","retired_at","owner_key") VALUES ('38092f94-10bc-4b94-ba57-77f279ff4e69','ar2','rv-fc14b7503c7e',NULL,'{"v":1,"kind":"archive","itemKind":"episode","scope":{"user":"u1","private":true},"participants":["u1"],"observedAt":{"date":"2026-09-01","precision":"day"},"lastSeen":"2026-10-01T12:00:00.000Z","sourceRefs":[],"neutral":null,"text":{"what":"evicted ar2"},"weight":1,"stored":{"date":"2026-09-01","addedAt":"2026-10-01T12:00:00.000Z"},"occurredAt":"2026-10-01T12:00:00.000Z","guildId":"g1"}','2026-10-01T12:00:00.000Z','evicted','store','live',NULL,0,NULL,'unit:835ad76e2422d0a068250d2a1ee3b6dc');
INSERT INTO "descriptions" ("id","subject_kind","subject_id","field","scope_kind","scope_iface","scope_dm","current_version","owner_file","retired_at","audience_id","owner_key") VALUES ('desc:person:discord:u1:character','person','person:discord:u1','character','group','discord',NULL,'desc:person:discord:u1:character:legacy',NULL,NULL,'aud:group:discord','unit:dae2fbd39e6cdc060f4c20cdd4515a4e');
INSERT INTO "descriptions" ("id","subject_kind","subject_id","field","scope_kind","scope_iface","scope_dm","current_version","owner_file","retired_at","audience_id","owner_key") VALUES ('desc:person:discord:u1:style','person','person:discord:u1','style','group','discord',NULL,'desc:person:discord:u1:style:legacy',NULL,NULL,'aud:group:discord','unit:dae2fbd39e6cdc060f4c20cdd4515a4e');
INSERT INTO "descriptions" ("id","subject_kind","subject_id","field","scope_kind","scope_iface","scope_dm","current_version","owner_file","retired_at","audience_id","owner_key") VALUES ('desc:person:discord:u1:relationship','person','person:discord:u1','relationship','group','discord',NULL,'desc:person:discord:u1:relationship:legacy',NULL,NULL,'aud:group:discord','unit:dae2fbd39e6cdc060f4c20cdd4515a4e');
INSERT INTO "descriptions" ("id","subject_kind","subject_id","field","scope_kind","scope_iface","scope_dm","current_version","owner_file","retired_at","audience_id","owner_key") VALUES ('desc:person:discord:u2:character','person','person:discord:u2','character','group','discord',NULL,'desc:person:discord:u2:character:legacy',NULL,NULL,'aud:group:discord','unit:8adc9170509132aa288fce2d6f7c8073');
INSERT INTO "descriptions" ("id","subject_kind","subject_id","field","scope_kind","scope_iface","scope_dm","current_version","owner_file","retired_at","audience_id","owner_key") VALUES ('desc:person:discord:u2:style','person','person:discord:u2','style','group','discord',NULL,'desc:person:discord:u2:style:legacy',NULL,NULL,'aud:group:discord','unit:8adc9170509132aa288fce2d6f7c8073');
INSERT INTO "descriptions" ("id","subject_kind","subject_id","field","scope_kind","scope_iface","scope_dm","current_version","owner_file","retired_at","audience_id","owner_key") VALUES ('desc:person:discord:u2:relationship','person','person:discord:u2','relationship','group','discord',NULL,'desc:person:discord:u2:relationship:legacy',NULL,NULL,'aud:group:discord','unit:8adc9170509132aa288fce2d6f7c8073');
INSERT INTO "descriptions" ("id","subject_kind","subject_id","field","scope_kind","scope_iface","scope_dm","current_version","owner_file","retired_at","audience_id","owner_key") VALUES ('desc:person:discord:u1:dm:relationship','person','person:discord:u1','relationship','dm','discord','person:discord:u1','desc:person:discord:u1:dm:relationship:legacy',NULL,NULL,'aud:dm:discord:dm:u1','unit:43ac0f11ced04660c949ccdd8f405a09');
INSERT INTO "descriptions" ("id","subject_kind","subject_id","field","scope_kind","scope_iface","scope_dm","current_version","owner_file","retired_at","audience_id","owner_key") VALUES ('desc:discord:guild:g1:patterns','place','discord:guild:g1','patterns','group','discord',NULL,'desc:discord:guild:g1:patterns:legacy',NULL,NULL,'aud:group:discord','unit:3678eaeac42aa03fc4e317af1d8db316');
INSERT INTO "descriptions" ("id","subject_kind","subject_id","field","scope_kind","scope_iface","scope_dm","current_version","owner_file","retired_at","audience_id","owner_key") VALUES ('desc:discord:guild:g1:starters','place','discord:guild:g1','starters','group','discord',NULL,'desc:discord:guild:g1:starters:legacy',NULL,NULL,'aud:group:discord','unit:3678eaeac42aa03fc4e317af1d8db316');
INSERT INTO "descriptions" ("id","subject_kind","subject_id","field","scope_kind","scope_iface","scope_dm","current_version","owner_file","retired_at","audience_id","owner_key") VALUES ('desc:discord:channel:c1:purpose','place','discord:channel:c1','purpose','group','discord',NULL,'desc:discord:channel:c1:purpose:legacy',NULL,NULL,'aud:group:discord','unit:7d1333f1393fe317691fce8428459583');
INSERT INTO "descriptions" ("id","subject_kind","subject_id","field","scope_kind","scope_iface","scope_dm","current_version","owner_file","retired_at","audience_id","owner_key") VALUES ('desc:discord:channel:c1:topics','place','discord:channel:c1','topics','group','discord',NULL,'desc:discord:channel:c1:topics:legacy',NULL,NULL,'aud:group:discord','unit:7d1333f1393fe317691fce8428459583');
INSERT INTO "descriptions" ("id","subject_kind","subject_id","field","scope_kind","scope_iface","scope_dm","current_version","owner_file","retired_at","audience_id","owner_key") VALUES ('desc:discord:channel:c1:tone','place','discord:channel:c1','tone','group','discord',NULL,'desc:discord:channel:c1:tone:legacy',NULL,NULL,'aud:group:discord','unit:7d1333f1393fe317691fce8428459583');
INSERT INTO "descriptions" ("id","subject_kind","subject_id","field","scope_kind","scope_iface","scope_dm","current_version","owner_file","retired_at","audience_id","owner_key") VALUES ('desc:person:discord:u2:dm:relationship','person','person:discord:u2','relationship','dm','discord','person:discord:u2','desc:person:discord:u2:dm:relationship:legacy',NULL,NULL,'aud:dm:discord:dm:u2','unit:73f8b674c1125b3b1a382ff1ca4d60ad');
INSERT INTO "descriptions" ("id","subject_kind","subject_id","field","scope_kind","scope_iface","scope_dm","current_version","owner_file","retired_at","audience_id","owner_key") VALUES ('description:said-under-server','person','person:0b7a4c1e','occupation','dm','discord','person:0b7a4c1e','description:said-under-server:v1',NULL,NULL,'aud:dm:discord:dm:u2','unit:5153707a022e92536da2f0a7060c50cf');
INSERT INTO "descriptions" ("id","subject_kind","subject_id","field","scope_kind","scope_iface","scope_dm","current_version","owner_file","retired_at","audience_id","owner_key") VALUES ('description:said-with-no-community','person','person:0b7a4c1e','occupation','dm','discord','person:0b7a4c1e','description:said-with-no-community:v1',NULL,NULL,'aud:dm:discord:dm:u2','unit:73f8b674c1125b3b1a382ff1ca4d60ad');
INSERT INTO "description_versions" ("id","description_id","text","author","written_at","chars","kept","removed","added","reason","origin","extra","owner_file","position","retired_at","owner_key") VALUES ('desc:person:discord:u1:character:legacy','desc:person:discord:u1:character','','import',NULL,0,NULL,NULL,NULL,NULL,'legacy',NULL,NULL,0,NULL,'unit:dae2fbd39e6cdc060f4c20cdd4515a4e');
INSERT INTO "description_versions" ("id","description_id","text","author","written_at","chars","kept","removed","added","reason","origin","extra","owner_file","position","retired_at","owner_key") VALUES ('desc:person:discord:u1:style:legacy','desc:person:discord:u1:style','','import',NULL,0,NULL,NULL,NULL,NULL,'legacy',NULL,NULL,0,NULL,'unit:dae2fbd39e6cdc060f4c20cdd4515a4e');
INSERT INTO "description_versions" ("id","description_id","text","author","written_at","chars","kept","removed","added","reason","origin","extra","owner_file","position","retired_at","owner_key") VALUES ('desc:person:discord:u1:relationship:legacy','desc:person:discord:u1:relationship','','import',NULL,0,NULL,NULL,NULL,NULL,'legacy',NULL,NULL,0,NULL,'unit:dae2fbd39e6cdc060f4c20cdd4515a4e');
INSERT INTO "description_versions" ("id","description_id","text","author","written_at","chars","kept","removed","added","reason","origin","extra","owner_file","position","retired_at","owner_key") VALUES ('desc:person:discord:u2:character:legacy','desc:person:discord:u2:character','','import',NULL,0,NULL,NULL,NULL,NULL,'legacy',NULL,NULL,0,NULL,'unit:8adc9170509132aa288fce2d6f7c8073');
INSERT INTO "description_versions" ("id","description_id","text","author","written_at","chars","kept","removed","added","reason","origin","extra","owner_file","position","retired_at","owner_key") VALUES ('desc:person:discord:u2:style:legacy','desc:person:discord:u2:style','','import',NULL,0,NULL,NULL,NULL,NULL,'legacy',NULL,NULL,0,NULL,'unit:8adc9170509132aa288fce2d6f7c8073');
INSERT INTO "description_versions" ("id","description_id","text","author","written_at","chars","kept","removed","added","reason","origin","extra","owner_file","position","retired_at","owner_key") VALUES ('desc:person:discord:u2:relationship:legacy','desc:person:discord:u2:relationship','','import',NULL,0,NULL,NULL,NULL,NULL,'legacy',NULL,NULL,0,NULL,'unit:8adc9170509132aa288fce2d6f7c8073');
INSERT INTO "description_versions" ("id","description_id","text","author","written_at","chars","kept","removed","added","reason","origin","extra","owner_file","position","retired_at","owner_key") VALUES ('desc:person:discord:u1:dm:relationship:legacy','desc:person:discord:u1:dm:relationship','','import',NULL,0,NULL,NULL,NULL,NULL,'legacy',NULL,NULL,0,NULL,'unit:43ac0f11ced04660c949ccdd8f405a09');
INSERT INTO "description_versions" ("id","description_id","text","author","written_at","chars","kept","removed","added","reason","origin","extra","owner_file","position","retired_at","owner_key") VALUES ('desc:discord:guild:g1:patterns:legacy','desc:discord:guild:g1:patterns','short synthetic lines','import',NULL,21,NULL,NULL,NULL,NULL,'legacy',NULL,NULL,0,NULL,'unit:3678eaeac42aa03fc4e317af1d8db316');
INSERT INTO "description_versions" ("id","description_id","text","author","written_at","chars","kept","removed","added","reason","origin","extra","owner_file","position","retired_at","owner_key") VALUES ('desc:discord:guild:g1:starters:legacy','desc:discord:guild:g1:starters','','import',NULL,0,NULL,NULL,NULL,NULL,'legacy',NULL,NULL,0,NULL,'unit:3678eaeac42aa03fc4e317af1d8db316');
INSERT INTO "description_versions" ("id","description_id","text","author","written_at","chars","kept","removed","added","reason","origin","extra","owner_file","position","retired_at","owner_key") VALUES ('desc:discord:channel:c1:purpose:legacy','desc:discord:channel:c1:purpose','talk about synthetic things','import',NULL,27,NULL,NULL,NULL,NULL,'legacy',NULL,NULL,0,NULL,'unit:7d1333f1393fe317691fce8428459583');
INSERT INTO "description_versions" ("id","description_id","text","author","written_at","chars","kept","removed","added","reason","origin","extra","owner_file","position","retired_at","owner_key") VALUES ('desc:discord:channel:c1:topics:legacy','desc:discord:channel:c1:topics','','import',NULL,0,NULL,NULL,NULL,NULL,'legacy',NULL,NULL,0,NULL,'unit:7d1333f1393fe317691fce8428459583');
INSERT INTO "description_versions" ("id","description_id","text","author","written_at","chars","kept","removed","added","reason","origin","extra","owner_file","position","retired_at","owner_key") VALUES ('desc:discord:channel:c1:tone:legacy','desc:discord:channel:c1:tone','','import',NULL,0,NULL,NULL,NULL,NULL,'legacy',NULL,NULL,0,NULL,'unit:7d1333f1393fe317691fce8428459583');
INSERT INTO "description_versions" ("id","description_id","text","author","written_at","chars","kept","removed","added","reason","origin","extra","owner_file","position","retired_at","owner_key") VALUES ('desc:person:discord:u2:dm:relationship:legacy','desc:person:discord:u2:dm:relationship','','import',NULL,0,NULL,NULL,NULL,NULL,'legacy',NULL,NULL,0,NULL,'unit:73f8b674c1125b3b1a382ff1ca4d60ad');
INSERT INTO "description_versions" ("id","description_id","text","author","written_at","chars","kept","removed","added","reason","origin","extra","owner_file","position","retired_at","owner_key") VALUES ('description:said-under-server:v1','description:said-under-server','a teacher, said under the server',NULL,'2026-10-01T12:00:00.000Z',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'unit:5153707a022e92536da2f0a7060c50cf');
INSERT INTO "description_versions" ("id","description_id","text","author","written_at","chars","kept","removed","added","reason","origin","extra","owner_file","position","retired_at","owner_key") VALUES ('description:said-with-no-community:v1','description:said-with-no-community','a sailor, said with no community',NULL,'2026-10-01T12:00:00.000Z',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'unit:73f8b674c1125b3b1a382ff1ca4d60ad');
INSERT INTO "episodes" ("id","kind","subject_id","place_id","date","what","quote","feeling","feeling_at","reread","weight","world","status","perspective","start_ms","last_ms","extra","scope_kind","scope_iface","scope_dm","created_at","retired_at","owner_file","position","audience_id","owner_key") VALUES ('participation::d4b2a096b3f5a4ed','participation',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'{"id":1,"what":"a synthetic talk","$derived":true}','group','discord',NULL,NULL,NULL,NULL,0,'aud:group:discord','unit:f753b9f696fe9e26e4587438d704d69c');
INSERT INTO "day" ("id","at","what","outcome","reason","place_id","turn_id","source_id","work_id","extra","scope_kind","scope_iface","scope_dm","owner_file","position","retired_at","audience_id","owner_key") VALUES ('055bb2fc-32b4-4515-bc1b-8d649c006617','2026-10-01T12:00:00.000Z','turn.start',NULL,NULL,'discord:channel:c1','t-9f357d57-a1aa-4852-8b63-767559754c07',NULL,NULL,'{"v":1,"recordedAt":"2026-10-01T12:00:00.000Z","guildId":"g1","participants":[],"sourceMessageIds":[],"origin":"live","attemptId":1,"mode":"reply","trigger":null}','group','discord',NULL,NULL,0,NULL,'aud:group:discord','unit:e1b7d6fbdaa52629a94025070f7f9d43');
INSERT INTO "day" ("id","at","what","outcome","reason","place_id","turn_id","source_id","work_id","extra","scope_kind","scope_iface","scope_dm","owner_file","position","retired_at","audience_id","owner_key") VALUES ('d306d91f-8cf1-4faa-bca9-555a89357530','2026-10-01T12:00:00.000Z','turn.start',NULL,NULL,'discord:dm:u1','t-692ffad9-0044-4c31-b155-025bbecf792b',NULL,NULL,'{"v":1,"recordedAt":"2026-10-01T12:00:00.000Z","guildId":"g1","participants":[],"sourceMessageIds":[],"origin":"live","attemptId":1,"mode":"reply","trigger":null,"scope":{"user":"u1","private":true}}','dm','discord','person:discord:u1',NULL,0,NULL,'aud:dm:discord:dm:u1','unit:a3d6a7d87d47f024325f56b8ee4be1f8');
INSERT INTO "day" ("id","at","what","outcome","reason","place_id","turn_id","source_id","work_id","extra","scope_kind","scope_iface","scope_dm","owner_file","position","retired_at","audience_id","owner_key") VALUES ('13fe58a2-2858-4cd8-9492-6c7c4ee0c2c9','2026-10-01T12:00:00.000Z','turn.start',NULL,NULL,'discord:dm:u2','t-1204262a-9644-4bd2-af30-77d78b14eb0f',NULL,NULL,'{"v":1,"recordedAt":"2026-10-01T12:00:00.000Z","guildId":"no-community","participants":[],"sourceMessageIds":[],"origin":"live","attemptId":1,"mode":"reply","trigger":null,"scope":{"user":"u2","private":true}}','dm','discord','person:discord:u2',NULL,0,NULL,'aud:dm:discord:dm:u2','unit:35b48ba835de96bc230edec35f1bf598');
INSERT INTO "day" ("id","at","what","outcome","reason","place_id","turn_id","source_id","work_id","extra","scope_kind","scope_iface","scope_dm","owner_file","position","retired_at","audience_id","owner_key") VALUES ('5ce47c62-31b0-479c-b67b-78292befd5e9','2026-10-01T12:00:00.000Z','system',NULL,NULL,NULL,NULL,NULL,NULL,'{"v":1,"recordedAt":"2026-10-01T12:00:00.000Z","guildId":"","participants":[],"sourceMessageIds":[],"origin":"live","event":"start","by":"service"}','group','discord',NULL,NULL,0,NULL,'aud:group:discord','unit:f935a904a0c9e719645d73df5781c4ba');
INSERT INTO "day" ("id","at","what","outcome","reason","place_id","turn_id","source_id","work_id","extra","scope_kind","scope_iface","scope_dm","owner_file","position","retired_at","audience_id","owner_key") VALUES ('129dc942-228c-4400-91c4-473c2388e019','2026-10-01T12:00:00.000Z','system',NULL,NULL,NULL,NULL,NULL,NULL,'{"v":1,"recordedAt":"2026-10-01T12:00:00.000Z","guildId":"g1","participants":[],"sourceMessageIds":[],"origin":"live","event":"reload","note":"synthetic"}','group','discord',NULL,NULL,1,NULL,'aud:group:discord','unit:e1b7d6fbdaa52629a94025070f7f9d43');
INSERT INTO "diary" ("id","at_ms","kind","gist","text","picture_prompt","search","topic","world","status","perspective","scope_kind","scope_iface","scope_dm","extra","owner_file","position","retired_at","audience_id","owner_key") VALUES ('diary::3165d2edf08a7e80',1790856000000,NULL,NULL,'a synthetic entry',NULL,NULL,NULL,NULL,NULL,NULL,'group','discord',NULL,'{"$derived":true}',NULL,0,NULL,'aud:group:discord','unit:31ce3c9eb7acf8402a4d2dd9f47b2205');
INSERT INTO "diary" ("id","at_ms","kind","gist","text","picture_prompt","search","topic","world","status","perspective","scope_kind","scope_iface","scope_dm","extra","owner_file","position","retired_at","audience_id","owner_key") VALUES ('diary:1',1790856000000,'status',NULL,'a synthetic entry',NULL,NULL,NULL,NULL,NULL,NULL,'none',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "media" ("id","kind","owner","path","native_ref","description","described_at","sha1","bytes","mime","scope_kind","scope_iface","scope_dm","extra","owner_file","retired_at","audience_id","availability","owner_key") VALUES ('media:gif:a1','gif',NULL,'https://example.org/a.gif',NULL,NULL,NULL,NULL,NULL,NULL,'group','discord',NULL,NULL,NULL,NULL,'aud:group:discord','unknown','unit:2e07a9639c26a52e3e46541abc28dc1d');
INSERT INTO "media" ("id","kind","owner","path","native_ref","description","described_at","sha1","bytes","mime","scope_kind","scope_iface","scope_dm","extra","owner_file","retired_at","audience_id","availability","owner_key") VALUES ('media:attachment:entries','attachment',NULL,NULL,'entries',NULL,NULL,NULL,NULL,NULL,'group','discord',NULL,'{"k1":{"description":"a synthetic picture"}}',NULL,NULL,'aud:group:discord','unknown','unit:759e23c9c093c356747c4482ca0c1319');
INSERT INTO "intentions" ("id","record","status","due_ms","created_ms","updated_ms","scope_kind","scope_iface","scope_dm","archived","owner_file","position","retired_at","audience_id","owner_key") VALUES ('int-1','{"id":"int-1","purpose":"answer about the synthetic plan","provenance":{"kind":"self","turnId":null,"channelId":"dm-native","scope":"dm"},"status":"pending","createdAt":1790856000000,"updatedAt":1790856000000,"dueAt":1790856001000,"every":null,"expiresAt":1790942400000,"awaitingErrandId":null,"waitDeadline":null,"destination":"dm-native","completionCondition":null,"chainId":null,"attend":null,"history":[{"at":1790856000000,"to":"pending","by":"persona"}]}','pending',1790856001000,1790856000000,1790856000000,'internal',NULL,NULL,0,NULL,0,NULL,'aud:internal','unit:6ee258339aaed444ed6ce3913df249dc');
INSERT INTO "operational" ("kind","owner","value","owner_file","retired_at","owner_key") VALUES ('inner','unit:63888e60b0e436ad389263cc73c6f4d7','{"v":1,"stopped":false,"review":null,"reviewViews":{},"heartbeat":null,"selfimprovement":null,"facts":[],"turns":[],"spend":[],"turnIds":[]}',NULL,NULL,'unit:63888e60b0e436ad389263cc73c6f4d7');
INSERT INTO "operational" ("kind","owner","value","owner_file","retired_at","owner_key") VALUES ('private','person:discord:u1','{"detailsSeq":2,"firstSeen":"","lastSeen":"","buffer":[],"$has":["details","interests","episodes","affinity","affinity.history"],"affinity":{"score":0,"reason":""}}',NULL,NULL,'unit:43ac0f11ced04660c949ccdd8f405a09');
INSERT INTO "operational" ("kind","owner","value","owner_file","retired_at","owner_key") VALUES ('guild','discord:guild:g1','{"learnedNextId":1,"emojiUsage":{},"emojiBackfill":null,"pingsOff":[],"updatedAt":"2026-11-05T04:07:05.501Z","notesUpdatedAt":"2026-11-05T04:07:05.501Z","notesCheckedAt":null,"notesFlaggedAt":null,"notesSampleReviewedAt":null,"notesAttemptAt":null,"$has":["injokes","self","learned"]}',NULL,NULL,'unit:3678eaeac42aa03fc4e317af1d8db316');
INSERT INTO "operational" ("kind","owner","value","owner_file","retired_at","owner_key") VALUES ('channel','discord:channel:c1','{"days":{},"messageCount":0,"firstMessageAt":null,"lastMessageAt":null,"topWriters":[],"writers":{},"updatedAt":"2026-11-05T04:07:05.502Z","notesCheckedAt":null,"notesFlaggedAt":null,"notesSampleReviewedAt":null,"notesAttemptAt":null,"$null":["category","topic"]}',NULL,NULL,'unit:7d1333f1393fe317691fce8428459583');
INSERT INTO "operational" ("kind","owner","value","owner_file","retired_at","owner_key") VALUES ('private','person:discord:u2','{"detailsSeq":2,"firstSeen":"","lastSeen":"","buffer":[],"$has":["details","interests","episodes","affinity","affinity.history"],"affinity":{"score":0,"reason":""}}',NULL,NULL,'unit:73f8b674c1125b3b1a382ff1ca4d60ad');
INSERT INTO "operational" ("kind","owner","value","owner_file","retired_at","owner_key") VALUES ('intentions','unit:6ee258339aaed444ed6ce3913df249dc','{"$has":["intentions"]}',NULL,NULL,'unit:6ee258339aaed444ed6ce3913df249dc');
INSERT INTO "operational" ("kind","owner","value","owner_file","retired_at","owner_key") VALUES ('gifs','unit:2e07a9639c26a52e3e46541abc28dc1d','{"nextId":2,"backfill":null,"$has":["entries"]}',NULL,NULL,'unit:2e07a9639c26a52e3e46541abc28dc1d');
INSERT INTO "operational" ("kind","owner","value","owner_file","retired_at","owner_key") VALUES ('recent','unit:8b3a74741c7a5cf66ddcd7fcb17d9d89','{"nextId":2,"$has":["lines"]}',NULL,NULL,'unit:8b3a74741c7a5cf66ddcd7fcb17d9d89');
INSERT INTO "operational" ("kind","owner","value","owner_file","retired_at","owner_key") VALUES ('participation','unit:f753b9f696fe9e26e4587438d704d69c','{"nextId":2,"$has":["episodes"]}',NULL,NULL,'unit:f753b9f696fe9e26e4587438d704d69c');
INSERT INTO "operational" ("kind","owner","value","owner_file","retired_at","owner_key") VALUES ('missed','unit:ba72e6653dea71354d067cdf34cc20e5','{"calls":[]}',NULL,NULL,'unit:ba72e6653dea71354d067cdf34cc20e5');
INSERT INTO "operational" ("kind","owner","value","owner_file","retired_at","owner_key") VALUES ('diary','unit:31ce3c9eb7acf8402a4d2dd9f47b2205','{"updatedAt":1790856000000,"$has":["posts"]}',NULL,NULL,'unit:31ce3c9eb7acf8402a4d2dd9f47b2205');
INSERT INTO "interfaces" ("id","name","contract","extra") VALUES ('discord',NULL,1,NULL);
INSERT INTO "interfaces" ("id","name","contract","extra") VALUES ('cli',NULL,1,NULL);
INSERT INTO "interfaces" ("id","name","contract","extra") VALUES ('core',NULL,1,NULL);
INSERT INTO "authorities" ("id","iface","namespace","name","extra") VALUES ('cli/local','cli','local',NULL,NULL);
INSERT INTO "authorities" ("id","iface","namespace","name","extra") VALUES ('core/local','core','local',NULL,NULL);
INSERT INTO "authorities" ("id","iface","namespace","name","extra") VALUES ('discord/global','discord','global',NULL,NULL);
INSERT INTO "authorities" ("id","iface","namespace","name","extra") VALUES ('legacy/local','core','legacy','legacy ids',NULL);
INSERT INTO "authorities" ("id","iface","namespace","name","extra") VALUES ('discord/guild:g1','discord','guild:g1',NULL,NULL);
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('core/local','person','self',1,'person:self',NULL,NULL,'1970-01-01T00:00:00.000Z');
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('discord/global','place','guild:g1',1,'discord:guild:g1',NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('legacy/local','place','discord:guild:g1',1,'discord:guild:g1',NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('discord/global','place','channel:c1',1,'discord:channel:c1',NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('legacy/local','place','discord:channel:c1',1,'discord:channel:c1',NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('discord/global','account','u1',1,'discord:u1',NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('legacy/local','account','discord:u1',1,'discord:u1',NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('discord/global','source','["message","o1",0,null]',1,'source:afa39593f8d20af4a695f01fb6456d94',NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('discord/global','place','channel:c2',1,'discord:channel:c2',NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('legacy/local','place','discord:channel:c2',1,'discord:channel:c2',NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('discord/global','account','u2',1,'discord:u2',NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('legacy/local','account','discord:u2',1,'discord:u2',NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('discord/global','source','["message","o2",0,null]',1,'source:a29860a56df16360c3737cc0ac83d1dd',NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('discord/global','place','dm:u1',1,'discord:dm:u1',NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('legacy/local','place','discord:dm:u1',1,'discord:dm:u1',NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('discord/global','source','["message","o3",0,null]',1,'source:d33c7104a1d4700597d6d862c9f07272',NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('discord/global','place','dm:u2',1,'discord:dm:u2',NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('legacy/local','place','discord:dm:u2',1,'discord:dm:u2',NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('discord/global','source','["message","o4",0,null]',1,'source:7a50bbe9b550a9449415e572fb780bd6',NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('discord/global','person','u1',1,'person:discord:u1',NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('legacy/local','person','person:discord:u1',1,'person:discord:u1',NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('discord/global','person','u2',1,'person:discord:u2',NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "external_keys" ("authority_id","object_kind","native_key","generation","node_id","valid_from_at","valid_to_at","recorded_at") VALUES ('legacy/local','person','person:discord:u2',1,'person:discord:u2',NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "audiences" ("id","kind","iface","place_id") VALUES ('aud:none','none',NULL,NULL);
INSERT INTO "audiences" ("id","kind","iface","place_id") VALUES ('aud:internal','internal',NULL,NULL);
INSERT INTO "audiences" ("id","kind","iface","place_id") VALUES ('aud:group:discord','group','discord',NULL);
INSERT INTO "audiences" ("id","kind","iface","place_id") VALUES ('aud:dm:discord:dm:u1','dm','discord','discord:dm:u1');
INSERT INTO "audiences" ("id","kind","iface","place_id") VALUES ('aud:dm:discord:dm:u2','dm','discord','discord:dm:u2');
INSERT INTO "account_person_links" ("id","account_id","person_id","state","by","reason","evidence_id","valid_from_at","valid_to_at","recorded_at") VALUES ('link:discord:u1:person:discord:u1','discord:u1','person:discord:u1','verified','import',NULL,NULL,NULL,NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "account_person_links" ("id","account_id","person_id","state","by","reason","evidence_id","valid_from_at","valid_to_at","recorded_at") VALUES ('link:discord:u2:person:discord:u2','discord:u2','person:discord:u2','verified','import',NULL,NULL,NULL,'2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z');
INSERT INTO "account_person_links" ("id","account_id","person_id","state","by","reason","evidence_id","valid_from_at","valid_to_at","recorded_at") VALUES ('link:u2:opaque','discord:u2','person:0b7a4c1e','verified','owner','synthetic',NULL,'2026-10-01T12:00:00.000Z',NULL,'2026-10-01T12:00:00.000Z');
INSERT INTO "people_merges" ("id","from_person","into_person","at","by","reason","evidence") VALUES ('merge:person:merged-a','person:merged-a','person:merged-b','2026-10-01T12:00:00.000Z','owner','synthetic',NULL);
INSERT INTO "people_merges" ("id","from_person","into_person","at","by","reason","evidence") VALUES ('merge:person:merged-b','person:merged-b','person:0b7a4c1e','2026-10-01T12:00:00.000Z','owner','synthetic',NULL);
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('interface:cli','interface','cli','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('interface:core','interface','core','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('interface:discord','interface','discord','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('authority:cli/local','authority','cli/local','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('authority:core/local','authority','core/local','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('authority:discord/global','authority','discord/global','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('authority:legacy/local','authority','legacy/local','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('person:person:self','person','person:self','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('place:discord:guild:g1','place','discord:guild:g1','2026-10-01T12:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('place:discord:channel:c1','place','discord:channel:c1','2026-10-01T12:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('account:discord:u1','account','discord:u1','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('source:source:afa39593f8d20af4a695f01fb6456d94','source','source:afa39593f8d20af4a695f01fb6456d94','2026-10-01T12:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('place:discord:channel:c2','place','discord:channel:c2','2026-10-01T12:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('account:discord:u2','account','discord:u2','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('source:source:a29860a56df16360c3737cc0ac83d1dd','source','source:a29860a56df16360c3737cc0ac83d1dd','2026-10-01T12:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('place:discord:dm:u1','place','discord:dm:u1','2026-10-01T12:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('source:source:d33c7104a1d4700597d6d862c9f07272','source','source:d33c7104a1d4700597d6d862c9f07272','2026-10-01T12:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('place:discord:dm:u2','place','discord:dm:u2','2026-10-01T12:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('source:source:7a50bbe9b550a9449415e572fb780bd6','source','source:7a50bbe9b550a9449415e572fb780bd6','2026-10-01T12:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description:desc:person:discord:u1:character','description','desc:person:discord:u1:character','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('person:person:discord:u1','person','person:discord:u1','2026-10-01T12:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description:desc:person:discord:u1:style','description','desc:person:discord:u1:style','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description:desc:person:discord:u1:relationship','description','desc:person:discord:u1:relationship','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description_version:desc:person:discord:u1:character:legacy','description_version','desc:person:discord:u1:character:legacy','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description_version:desc:person:discord:u1:style:legacy','description_version','desc:person:discord:u1:style:legacy','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description_version:desc:person:discord:u1:relationship:legacy','description_version','desc:person:discord:u1:relationship:legacy','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description:desc:person:discord:u2:character','description','desc:person:discord:u2:character','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('person:person:discord:u2','person','person:discord:u2','2026-10-01T12:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description:desc:person:discord:u2:style','description','desc:person:discord:u2:style','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description:desc:person:discord:u2:relationship','description','desc:person:discord:u2:relationship','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description_version:desc:person:discord:u2:character:legacy','description_version','desc:person:discord:u2:character:legacy','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description_version:desc:person:discord:u2:style:legacy','description_version','desc:person:discord:u2:style:legacy','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description_version:desc:person:discord:u2:relationship:legacy','description_version','desc:person:discord:u2:relationship:legacy','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('claim:dt-d6e482b2-c443-487e-af64-6a6b56dc5d72','claim','dt-d6e482b2-c443-487e-af64-6a6b56dc5d72','2026-11-05T04:07:05.499Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description:desc:person:discord:u1:dm:relationship','description','desc:person:discord:u1:dm:relationship','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description_version:desc:person:discord:u1:dm:relationship:legacy','description_version','desc:person:discord:u1:dm:relationship:legacy','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('authority:discord/guild:g1','authority','discord/guild:g1','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description:desc:discord:guild:g1:patterns','description','desc:discord:guild:g1:patterns','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description:desc:discord:guild:g1:starters','description','desc:discord:guild:g1:starters','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description_version:desc:discord:guild:g1:patterns:legacy','description_version','desc:discord:guild:g1:patterns:legacy','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description_version:desc:discord:guild:g1:starters:legacy','description_version','desc:discord:guild:g1:starters:legacy','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('claim:lore:5xp3y3','claim','lore:5xp3y3','2026-10-01T12:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description:desc:discord:channel:c1:purpose','description','desc:discord:channel:c1:purpose','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description:desc:discord:channel:c1:topics','description','desc:discord:channel:c1:topics','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description:desc:discord:channel:c1:tone','description','desc:discord:channel:c1:tone','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description_version:desc:discord:channel:c1:purpose:legacy','description_version','desc:discord:channel:c1:purpose:legacy','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description_version:desc:discord:channel:c1:topics:legacy','description_version','desc:discord:channel:c1:topics:legacy','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description_version:desc:discord:channel:c1:tone:legacy','description_version','desc:discord:channel:c1:tone:legacy','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('claim_version:b6169014-6f3d-4750-80b7-0257450d5d49','claim_version','b6169014-6f3d-4750-80b7-0257450d5d49','2026-10-01T12:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('claim:ar1','claim','ar1','2026-09-01');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('claim_version:38092f94-10bc-4b94-ba57-77f279ff4e69','claim_version','38092f94-10bc-4b94-ba57-77f279ff4e69','2026-10-01T12:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('claim:ar2','claim','ar2','2026-09-01');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('source:src:discord:m1:1:seen','source','src:discord:m1:1:seen','2026-10-01T12:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('source:src:discord:m2:1:seen','source','src:discord:m2:1:seen','2026-10-01T12:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('source:src:discord:m3:1:seen','source','src:discord:m3:1:seen','2026-10-01T12:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('claim:dt-ab86a51c-fd47-468c-b6ea-4274f881e8db','claim','dt-ab86a51c-fd47-468c-b6ea-4274f881e8db','2026-11-05T04:07:05.538Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description:desc:person:discord:u2:dm:relationship','description','desc:person:discord:u2:dm:relationship','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('description_version:desc:person:discord:u2:dm:relationship:legacy','description_version','desc:person:discord:u2:dm:relationship:legacy','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('intention:int-1','intention','int-1','2026-10-01T12:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('media:media:gif:a1','media','media:gif:a1','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('claim:recent_line::d4b2a096b3f5a4ed','claim','recent_line::d4b2a096b3f5a4ed','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('episode:participation::d4b2a096b3f5a4ed','episode','participation::d4b2a096b3f5a4ed','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('media:media:attachment:entries','media','media:attachment:entries','1970-01-01T00:00:00.000Z');
INSERT INTO "graph_nodes" ("id","kind","row_id","created_at") VALUES ('diary:diary::3165d2edf08a7e80','diary','diary::3165d2edf08a7e80','2026-10-01T12:00:00.000Z');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:12d8105244b9b48423b98165ed692a4a','place:discord:channel:c1','contained_in','place:discord:guild:g1','aud:group:discord',NULL,NULL,NULL,'2026-10-01T12:00:00.000Z',NULL,'contained_in:place:discord:channel:c1:place:discord:guild:g1','places:discord:channel:c1');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:92b477e70ce565221683b827669b42bb','source:source:afa39593f8d20af4a695f01fb6456d94','authored_by','account:discord:u1','aud:group:discord','source:afa39593f8d20af4a695f01fb6456d94',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL,'authored_by:source:source:afa39593f8d20af4a695f01fb6456d94:account:discord:u1','sources:source:afa39593f8d20af4a695f01fb6456d94');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:bd9ddc2c98794b50e04fee1243e3626e','source:source:afa39593f8d20af4a695f01fb6456d94','located_in','place:discord:channel:c1','aud:group:discord','source:afa39593f8d20af4a695f01fb6456d94',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL,'located_in:source:source:afa39593f8d20af4a695f01fb6456d94:place:discord:channel:c1','sources:source:afa39593f8d20af4a695f01fb6456d94');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:a3620e952975b882721c2784c4ebb3c3','place:discord:channel:c2','contained_in','place:discord:guild:g1','aud:group:discord',NULL,NULL,NULL,'2026-10-01T12:00:00.000Z',NULL,'contained_in:place:discord:channel:c2:place:discord:guild:g1','places:discord:channel:c2');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:58a5520e21aaf02f6d875d8bc48af16e','source:source:a29860a56df16360c3737cc0ac83d1dd','authored_by','account:discord:u2','aud:group:discord','source:a29860a56df16360c3737cc0ac83d1dd',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL,'authored_by:source:source:a29860a56df16360c3737cc0ac83d1dd:account:discord:u2','sources:source:a29860a56df16360c3737cc0ac83d1dd');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:8f7e0285e1ffccaf97429a5fe64c467f','source:source:a29860a56df16360c3737cc0ac83d1dd','located_in','place:discord:channel:c2','aud:group:discord','source:a29860a56df16360c3737cc0ac83d1dd',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL,'located_in:source:source:a29860a56df16360c3737cc0ac83d1dd:place:discord:channel:c2','sources:source:a29860a56df16360c3737cc0ac83d1dd');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:4e06d3e613e73dd2b91dad16f80dbc7f','source:source:d33c7104a1d4700597d6d862c9f07272','authored_by','account:discord:u1','aud:dm:discord:dm:u1','source:d33c7104a1d4700597d6d862c9f07272',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL,'authored_by:source:source:d33c7104a1d4700597d6d862c9f07272:account:discord:u1','sources:source:d33c7104a1d4700597d6d862c9f07272');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:db6b9fa3dd3c079b2a404e288fa2124b','source:source:d33c7104a1d4700597d6d862c9f07272','located_in','place:discord:dm:u1','aud:dm:discord:dm:u1','source:d33c7104a1d4700597d6d862c9f07272',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL,'located_in:source:source:d33c7104a1d4700597d6d862c9f07272:place:discord:dm:u1','sources:source:d33c7104a1d4700597d6d862c9f07272');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:5f854c04a9ce52b130a30cf7466f983c','source:source:7a50bbe9b550a9449415e572fb780bd6','authored_by','account:discord:u2','aud:dm:discord:dm:u2','source:7a50bbe9b550a9449415e572fb780bd6',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL,'authored_by:source:source:7a50bbe9b550a9449415e572fb780bd6:account:discord:u2','sources:source:7a50bbe9b550a9449415e572fb780bd6');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:7a8c52d4556caf522dde9bea57856134','source:source:7a50bbe9b550a9449415e572fb780bd6','located_in','place:discord:dm:u2','aud:dm:discord:dm:u2','source:7a50bbe9b550a9449415e572fb780bd6',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL,'located_in:source:source:7a50bbe9b550a9449415e572fb780bd6:place:discord:dm:u2','sources:source:7a50bbe9b550a9449415e572fb780bd6');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:6bdd436b44dc91c020215ed7f6e243cd','description:desc:person:discord:u1:character','about','person:person:discord:u1','aud:group:discord',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'about:description:desc:person:discord:u1:character:person:person:discord:u1','descriptions:desc:person:discord:u1:character');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:b600a95c15b2b98bbf58635f3ae54821','description:desc:person:discord:u1:style','about','person:person:discord:u1','aud:group:discord',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'about:description:desc:person:discord:u1:style:person:person:discord:u1','descriptions:desc:person:discord:u1:style');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:3ed889f12df3aab8d1b17ff2ed35a98d','description:desc:person:discord:u1:relationship','about','person:person:discord:u1','aud:group:discord',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'about:description:desc:person:discord:u1:relationship:person:person:discord:u1','descriptions:desc:person:discord:u1:relationship');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:db11f0d4ca2ac805a8e7b270ce702476','description_version:desc:person:discord:u1:character:legacy','version_of','description:desc:person:discord:u1:character','aud:group:discord',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'version_of:description_version:desc:person:discord:u1:character:legacy:description:desc:person:discord:u1:character','descriptions:desc:person:discord:u1:character');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:9fcadecc6c16842b00f65dc230293a78','description_version:desc:person:discord:u1:style:legacy','version_of','description:desc:person:discord:u1:style','aud:group:discord',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'version_of:description_version:desc:person:discord:u1:style:legacy:description:desc:person:discord:u1:style','descriptions:desc:person:discord:u1:style');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:a93c84f6c0b0ad7476dc4e85375b1be2','description_version:desc:person:discord:u1:relationship:legacy','version_of','description:desc:person:discord:u1:relationship','aud:group:discord',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'version_of:description_version:desc:person:discord:u1:relationship:legacy:description:desc:person:discord:u1:relationship','descriptions:desc:person:discord:u1:relationship');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:d42b94f2fed18fe992cb0901bdd6b3eb','account:discord:u1','account_of','person:person:discord:u1','aud:group:discord',NULL,NULL,NULL,'2026-10-01T12:00:00.000Z',NULL,'account_of:account:discord:u1:person:person:discord:u1','accounts:discord:u1');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:ce1a05779b860c0746fdba4331d51c6e','description:desc:person:discord:u2:character','about','person:person:discord:u2','aud:group:discord',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'about:description:desc:person:discord:u2:character:person:person:discord:u2','descriptions:desc:person:discord:u2:character');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:aa92bdc44717a37b4c957590993f596d','description:desc:person:discord:u2:style','about','person:person:discord:u2','aud:group:discord',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'about:description:desc:person:discord:u2:style:person:person:discord:u2','descriptions:desc:person:discord:u2:style');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:ee7f726b2c20e300acd2eb5e0059a649','description:desc:person:discord:u2:relationship','about','person:person:discord:u2','aud:group:discord',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'about:description:desc:person:discord:u2:relationship:person:person:discord:u2','descriptions:desc:person:discord:u2:relationship');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:24099d022d43be0afeb42b4becf8fa6e','description_version:desc:person:discord:u2:character:legacy','version_of','description:desc:person:discord:u2:character','aud:group:discord',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'version_of:description_version:desc:person:discord:u2:character:legacy:description:desc:person:discord:u2:character','descriptions:desc:person:discord:u2:character');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:46832c1dacef8ca189d8e28a40e9c77f','description_version:desc:person:discord:u2:style:legacy','version_of','description:desc:person:discord:u2:style','aud:group:discord',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'version_of:description_version:desc:person:discord:u2:style:legacy:description:desc:person:discord:u2:style','descriptions:desc:person:discord:u2:style');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:4b0292af03df87bd74aaf4a650ff0ebb','description_version:desc:person:discord:u2:relationship:legacy','version_of','description:desc:person:discord:u2:relationship','aud:group:discord',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'version_of:description_version:desc:person:discord:u2:relationship:legacy:description:desc:person:discord:u2:relationship','descriptions:desc:person:discord:u2:relationship');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:7862e3a605a21a9b2e73421375927330','account:discord:u2','account_of','person:person:discord:u2','aud:group:discord',NULL,NULL,NULL,'2026-10-01T12:00:00.000Z',NULL,'account_of:account:discord:u2:person:person:discord:u2','accounts:discord:u2');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:5f687344e330774d727e47f0c87b8249','claim:dt-d6e482b2-c443-487e-af64-6a6b56dc5d72','about','person:person:discord:u1','aud:dm:discord:dm:u1',NULL,NULL,NULL,'2026-11-05T04:07:05.499Z',NULL,'about:claim:dt-d6e482b2-c443-487e-af64-6a6b56dc5d72:person:person:discord:u1','claims:dt-d6e482b2-c443-487e-af64-6a6b56dc5d72');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:2159b1eda9932ef7bf17ec8bbf369b56','description:desc:person:discord:u1:dm:relationship','about','person:person:discord:u1','aud:dm:discord:dm:u1',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'about:description:desc:person:discord:u1:dm:relationship:person:person:discord:u1','descriptions:desc:person:discord:u1:dm:relationship');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:850d0aa4e532831f661b02765cbbd27b','description_version:desc:person:discord:u1:dm:relationship:legacy','version_of','description:desc:person:discord:u1:dm:relationship','aud:dm:discord:dm:u1',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'version_of:description_version:desc:person:discord:u1:dm:relationship:legacy:description:desc:person:discord:u1:dm:relationship','descriptions:desc:person:discord:u1:dm:relationship');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:95b3318cde403d1540643ea8a4ac026c','description:desc:discord:guild:g1:patterns','about','place:discord:guild:g1','aud:group:discord',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'about:description:desc:discord:guild:g1:patterns:place:discord:guild:g1','descriptions:desc:discord:guild:g1:patterns');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:2e609131a1088a0e482c5ac2acc38a04','description:desc:discord:guild:g1:starters','about','place:discord:guild:g1','aud:group:discord',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'about:description:desc:discord:guild:g1:starters:place:discord:guild:g1','descriptions:desc:discord:guild:g1:starters');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:615b408510559ae289105d209ecd8525','description_version:desc:discord:guild:g1:patterns:legacy','version_of','description:desc:discord:guild:g1:patterns','aud:group:discord',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'version_of:description_version:desc:discord:guild:g1:patterns:legacy:description:desc:discord:guild:g1:patterns','descriptions:desc:discord:guild:g1:patterns');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:e05f13a01986f505eec2e42a098cfd25','description_version:desc:discord:guild:g1:starters:legacy','version_of','description:desc:discord:guild:g1:starters','aud:group:discord',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'version_of:description_version:desc:discord:guild:g1:starters:legacy:description:desc:discord:guild:g1:starters','descriptions:desc:discord:guild:g1:starters');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:626574e0e4f0dfa515f6d3d7fb9e05d9','claim:lore:5xp3y3','about','place:discord:guild:g1','aud:group:discord',NULL,NULL,NULL,'2026-10-01T12:00:00.000Z',NULL,'about:claim:lore:5xp3y3:place:discord:guild:g1','claims:lore:5xp3y3');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:3baf48aafb4e27d110618f18130cafd8','description:desc:discord:channel:c1:purpose','about','place:discord:channel:c1','aud:group:discord',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'about:description:desc:discord:channel:c1:purpose:place:discord:channel:c1','descriptions:desc:discord:channel:c1:purpose');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:62b3396bddc2ca8c843b6945e2405efe','description:desc:discord:channel:c1:topics','about','place:discord:channel:c1','aud:group:discord',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'about:description:desc:discord:channel:c1:topics:place:discord:channel:c1','descriptions:desc:discord:channel:c1:topics');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:8b0448c94575a74ac1221d536fa6f6b1','description:desc:discord:channel:c1:tone','about','place:discord:channel:c1','aud:group:discord',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'about:description:desc:discord:channel:c1:tone:place:discord:channel:c1','descriptions:desc:discord:channel:c1:tone');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:607711092927f61bc67724581dd24f87','description_version:desc:discord:channel:c1:purpose:legacy','version_of','description:desc:discord:channel:c1:purpose','aud:group:discord',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'version_of:description_version:desc:discord:channel:c1:purpose:legacy:description:desc:discord:channel:c1:purpose','descriptions:desc:discord:channel:c1:purpose');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:3369253deee536d072f0c87bf3379e6c','description_version:desc:discord:channel:c1:topics:legacy','version_of','description:desc:discord:channel:c1:topics','aud:group:discord',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'version_of:description_version:desc:discord:channel:c1:topics:legacy:description:desc:discord:channel:c1:topics','descriptions:desc:discord:channel:c1:topics');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:3d03ff25a75f1310937689dba33965ca','description_version:desc:discord:channel:c1:tone:legacy','version_of','description:desc:discord:channel:c1:tone','aud:group:discord',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'version_of:description_version:desc:discord:channel:c1:tone:legacy:description:desc:discord:channel:c1:tone','descriptions:desc:discord:channel:c1:tone');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:2b59c7d80f1e672f980fe8baa3299482','claim_version:b6169014-6f3d-4750-80b7-0257450d5d49','version_of','claim:ar1','aud:group:discord',NULL,NULL,NULL,'2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z','version_of:claim_version:b6169014-6f3d-4750-80b7-0257450d5d49:claim:ar1','claims:ar1');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:78f520d04aa89544b6cab3b72ccee790','claim_version:38092f94-10bc-4b94-ba57-77f279ff4e69','version_of','claim:ar2','aud:dm:discord:dm:u1',NULL,NULL,NULL,'2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z','version_of:claim_version:38092f94-10bc-4b94-ba57-77f279ff4e69:claim:ar2','claims:ar2');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:69328a872bf92d539cf658d643d91c19','claim:ar2','about','person:person:discord:u1','aud:dm:discord:dm:u1',NULL,NULL,NULL,'2026-09-01','2026-10-01T12:00:00.000Z','about:claim:ar2:person:person:discord:u1','claims:ar2');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:ddaa84b79a51caff82f6cf970ac9127a','source:src:discord:m1:1:seen','authored_by','account:discord:u1','aud:group:discord','src:discord:m1:1:seen',NULL,NULL,'2026-11-05T04:07:05.527Z',NULL,'authored_by:source:src:discord:m1:1:seen:account:discord:u1','sources:src:discord:m1:1:seen');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:e2c392b69ae71e074509efd31f8fdf7f','source:src:discord:m1:1:seen','located_in','place:discord:channel:c1','aud:group:discord','src:discord:m1:1:seen',NULL,NULL,'2026-11-05T04:07:05.527Z',NULL,'located_in:source:src:discord:m1:1:seen:place:discord:channel:c1','sources:src:discord:m1:1:seen');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:0fde66f77f95117655f020b2553515e8','source:src:discord:m2:1:seen','authored_by','account:discord:u1','aud:dm:discord:dm:u1','src:discord:m2:1:seen',NULL,NULL,'2026-11-05T04:07:05.530Z',NULL,'authored_by:source:src:discord:m2:1:seen:account:discord:u1','sources:src:discord:m2:1:seen');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:d38b6e61160450fd0c7c26aac559c8f1','source:src:discord:m2:1:seen','located_in','place:discord:dm:u1','aud:dm:discord:dm:u1','src:discord:m2:1:seen',NULL,NULL,'2026-11-05T04:07:05.530Z',NULL,'located_in:source:src:discord:m2:1:seen:place:discord:dm:u1','sources:src:discord:m2:1:seen');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:f6d8b236dd4e469f1b665f07650c7c1a','source:src:discord:m3:1:seen','authored_by','account:discord:u1','aud:dm:discord:dm:u2','src:discord:m3:1:seen',NULL,NULL,'2026-11-05T04:07:05.532Z',NULL,'authored_by:source:src:discord:m3:1:seen:account:discord:u1','sources:src:discord:m3:1:seen');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:75412b57439dea1a89aa8b63c0503866','source:src:discord:m3:1:seen','located_in','place:discord:dm:u2','aud:dm:discord:dm:u2','src:discord:m3:1:seen',NULL,NULL,'2026-11-05T04:07:05.532Z',NULL,'located_in:source:src:discord:m3:1:seen:place:discord:dm:u2','sources:src:discord:m3:1:seen');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:1cefa3a5249602012d6a0733a378c175','claim:dt-ab86a51c-fd47-468c-b6ea-4274f881e8db','about','person:person:discord:u2','aud:dm:discord:dm:u2',NULL,NULL,NULL,'2026-11-05T04:07:05.538Z',NULL,'about:claim:dt-ab86a51c-fd47-468c-b6ea-4274f881e8db:person:person:discord:u2','claims:dt-ab86a51c-fd47-468c-b6ea-4274f881e8db');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:57f227d871748188e0d1619d637a310a','description:desc:person:discord:u2:dm:relationship','about','person:person:discord:u2','aud:dm:discord:dm:u2',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'about:description:desc:person:discord:u2:dm:relationship:person:person:discord:u2','descriptions:desc:person:discord:u2:dm:relationship');
INSERT INTO "graph_edges" ("id","src","predicate","dst","audience_id","evidence_id","valid_from_at","valid_to_at","recorded_at","retired_at","projection_key","owner_key") VALUES ('edge:3da17cbeddbda022462702252e1641a3','description_version:desc:person:discord:u2:dm:relationship:legacy','version_of','description:desc:person:discord:u2:dm:relationship','aud:dm:discord:dm:u2',NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,'version_of:description_version:desc:person:discord:u2:dm:relationship:legacy:description:desc:person:discord:u2:dm:relationship','descriptions:desc:person:discord:u2:dm:relationship');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('source:source:afa39593f8d20af4a695f01fb6456d94','aud:group:discord','source:source:afa39593f8d20af4a695f01fb6456d94');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('source:source:afa39593f8d20af4a695f01fb6456d94','aud:group:discord','edge:92b477e70ce565221683b827669b42bb');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('account:discord:u1','aud:group:discord','edge:92b477e70ce565221683b827669b42bb');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('source:source:afa39593f8d20af4a695f01fb6456d94','aud:group:discord','edge:bd9ddc2c98794b50e04fee1243e3626e');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('place:discord:channel:c1','aud:group:discord','edge:bd9ddc2c98794b50e04fee1243e3626e');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('place:discord:channel:c2','aud:group:discord','edge:a3620e952975b882721c2784c4ebb3c3');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('place:discord:guild:g1','aud:group:discord','edge:a3620e952975b882721c2784c4ebb3c3');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('source:source:a29860a56df16360c3737cc0ac83d1dd','aud:group:discord','source:source:a29860a56df16360c3737cc0ac83d1dd');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('source:source:a29860a56df16360c3737cc0ac83d1dd','aud:group:discord','edge:58a5520e21aaf02f6d875d8bc48af16e');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('account:discord:u2','aud:group:discord','edge:58a5520e21aaf02f6d875d8bc48af16e');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('source:source:a29860a56df16360c3737cc0ac83d1dd','aud:group:discord','edge:8f7e0285e1ffccaf97429a5fe64c467f');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('place:discord:channel:c2','aud:group:discord','edge:8f7e0285e1ffccaf97429a5fe64c467f');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('source:source:d33c7104a1d4700597d6d862c9f07272','aud:dm:discord:dm:u1','source:source:d33c7104a1d4700597d6d862c9f07272');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('source:source:d33c7104a1d4700597d6d862c9f07272','aud:dm:discord:dm:u1','edge:4e06d3e613e73dd2b91dad16f80dbc7f');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('account:discord:u1','aud:dm:discord:dm:u1','edge:4e06d3e613e73dd2b91dad16f80dbc7f');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('source:source:d33c7104a1d4700597d6d862c9f07272','aud:dm:discord:dm:u1','edge:db6b9fa3dd3c079b2a404e288fa2124b');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('place:discord:dm:u1','aud:dm:discord:dm:u1','edge:db6b9fa3dd3c079b2a404e288fa2124b');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('source:source:7a50bbe9b550a9449415e572fb780bd6','aud:dm:discord:dm:u2','source:source:7a50bbe9b550a9449415e572fb780bd6');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('source:source:7a50bbe9b550a9449415e572fb780bd6','aud:dm:discord:dm:u2','edge:5f854c04a9ce52b130a30cf7466f983c');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('account:discord:u2','aud:dm:discord:dm:u2','edge:5f854c04a9ce52b130a30cf7466f983c');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('source:source:7a50bbe9b550a9449415e572fb780bd6','aud:dm:discord:dm:u2','edge:7a8c52d4556caf522dde9bea57856134');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('place:discord:dm:u2','aud:dm:discord:dm:u2','edge:7a8c52d4556caf522dde9bea57856134');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u1:character','aud:group:discord','description:desc:person:discord:u1:character');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:person:discord:u1:character:legacy','aud:group:discord','description_version:desc:person:discord:u1:character:legacy');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u1:character','aud:group:discord','edge:6bdd436b44dc91c020215ed7f6e243cd');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('person:person:discord:u1','aud:group:discord','edge:6bdd436b44dc91c020215ed7f6e243cd');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:person:discord:u1:character:legacy','aud:group:discord','edge:db11f0d4ca2ac805a8e7b270ce702476');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u1:character','aud:group:discord','edge:db11f0d4ca2ac805a8e7b270ce702476');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u1:style','aud:group:discord','description:desc:person:discord:u1:style');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:person:discord:u1:style:legacy','aud:group:discord','description_version:desc:person:discord:u1:style:legacy');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u1:style','aud:group:discord','edge:b600a95c15b2b98bbf58635f3ae54821');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('person:person:discord:u1','aud:group:discord','edge:b600a95c15b2b98bbf58635f3ae54821');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:person:discord:u1:style:legacy','aud:group:discord','edge:9fcadecc6c16842b00f65dc230293a78');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u1:style','aud:group:discord','edge:9fcadecc6c16842b00f65dc230293a78');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u1:relationship','aud:group:discord','description:desc:person:discord:u1:relationship');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:person:discord:u1:relationship:legacy','aud:group:discord','description_version:desc:person:discord:u1:relationship:legacy');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u1:relationship','aud:group:discord','edge:3ed889f12df3aab8d1b17ff2ed35a98d');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('person:person:discord:u1','aud:group:discord','edge:3ed889f12df3aab8d1b17ff2ed35a98d');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:person:discord:u1:relationship:legacy','aud:group:discord','edge:a93c84f6c0b0ad7476dc4e85375b1be2');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u1:relationship','aud:group:discord','edge:a93c84f6c0b0ad7476dc4e85375b1be2');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('account:discord:u1','aud:group:discord','edge:d42b94f2fed18fe992cb0901bdd6b3eb');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('person:person:discord:u1','aud:group:discord','edge:d42b94f2fed18fe992cb0901bdd6b3eb');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u2:character','aud:group:discord','description:desc:person:discord:u2:character');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:person:discord:u2:character:legacy','aud:group:discord','description_version:desc:person:discord:u2:character:legacy');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u2:character','aud:group:discord','edge:ce1a05779b860c0746fdba4331d51c6e');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('person:person:discord:u2','aud:group:discord','edge:ce1a05779b860c0746fdba4331d51c6e');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:person:discord:u2:character:legacy','aud:group:discord','edge:24099d022d43be0afeb42b4becf8fa6e');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u2:character','aud:group:discord','edge:24099d022d43be0afeb42b4becf8fa6e');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u2:style','aud:group:discord','description:desc:person:discord:u2:style');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:person:discord:u2:style:legacy','aud:group:discord','description_version:desc:person:discord:u2:style:legacy');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u2:style','aud:group:discord','edge:aa92bdc44717a37b4c957590993f596d');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('person:person:discord:u2','aud:group:discord','edge:aa92bdc44717a37b4c957590993f596d');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:person:discord:u2:style:legacy','aud:group:discord','edge:46832c1dacef8ca189d8e28a40e9c77f');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u2:style','aud:group:discord','edge:46832c1dacef8ca189d8e28a40e9c77f');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u2:relationship','aud:group:discord','description:desc:person:discord:u2:relationship');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:person:discord:u2:relationship:legacy','aud:group:discord','description_version:desc:person:discord:u2:relationship:legacy');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u2:relationship','aud:group:discord','edge:ee7f726b2c20e300acd2eb5e0059a649');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('person:person:discord:u2','aud:group:discord','edge:ee7f726b2c20e300acd2eb5e0059a649');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:person:discord:u2:relationship:legacy','aud:group:discord','edge:4b0292af03df87bd74aaf4a650ff0ebb');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u2:relationship','aud:group:discord','edge:4b0292af03df87bd74aaf4a650ff0ebb');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('account:discord:u2','aud:group:discord','edge:7862e3a605a21a9b2e73421375927330');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('person:person:discord:u2','aud:group:discord','edge:7862e3a605a21a9b2e73421375927330');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('claim:dt-d6e482b2-c443-487e-af64-6a6b56dc5d72','aud:dm:discord:dm:u1','claim:dt-d6e482b2-c443-487e-af64-6a6b56dc5d72');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('claim:dt-d6e482b2-c443-487e-af64-6a6b56dc5d72','aud:dm:discord:dm:u1','edge:5f687344e330774d727e47f0c87b8249');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('person:person:discord:u1','aud:dm:discord:dm:u1','edge:5f687344e330774d727e47f0c87b8249');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u1:dm:relationship','aud:dm:discord:dm:u1','description:desc:person:discord:u1:dm:relationship');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:person:discord:u1:dm:relationship:legacy','aud:dm:discord:dm:u1','description_version:desc:person:discord:u1:dm:relationship:legacy');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u1:dm:relationship','aud:dm:discord:dm:u1','edge:2159b1eda9932ef7bf17ec8bbf369b56');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('person:person:discord:u1','aud:dm:discord:dm:u1','edge:2159b1eda9932ef7bf17ec8bbf369b56');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:person:discord:u1:dm:relationship:legacy','aud:dm:discord:dm:u1','edge:850d0aa4e532831f661b02765cbbd27b');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u1:dm:relationship','aud:dm:discord:dm:u1','edge:850d0aa4e532831f661b02765cbbd27b');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:discord:guild:g1:patterns','aud:group:discord','description:desc:discord:guild:g1:patterns');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:discord:guild:g1:patterns:legacy','aud:group:discord','description_version:desc:discord:guild:g1:patterns:legacy');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:discord:guild:g1:patterns','aud:group:discord','edge:95b3318cde403d1540643ea8a4ac026c');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('place:discord:guild:g1','aud:group:discord','edge:95b3318cde403d1540643ea8a4ac026c');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:discord:guild:g1:patterns:legacy','aud:group:discord','edge:615b408510559ae289105d209ecd8525');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:discord:guild:g1:patterns','aud:group:discord','edge:615b408510559ae289105d209ecd8525');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:discord:guild:g1:starters','aud:group:discord','description:desc:discord:guild:g1:starters');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:discord:guild:g1:starters:legacy','aud:group:discord','description_version:desc:discord:guild:g1:starters:legacy');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:discord:guild:g1:starters','aud:group:discord','edge:2e609131a1088a0e482c5ac2acc38a04');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('place:discord:guild:g1','aud:group:discord','edge:2e609131a1088a0e482c5ac2acc38a04');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:discord:guild:g1:starters:legacy','aud:group:discord','edge:e05f13a01986f505eec2e42a098cfd25');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:discord:guild:g1:starters','aud:group:discord','edge:e05f13a01986f505eec2e42a098cfd25');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('claim:lore:5xp3y3','aud:group:discord','claim:lore:5xp3y3');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('claim:lore:5xp3y3','aud:group:discord','edge:626574e0e4f0dfa515f6d3d7fb9e05d9');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('place:discord:guild:g1','aud:group:discord','edge:626574e0e4f0dfa515f6d3d7fb9e05d9');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('place:discord:channel:c1','aud:group:discord','edge:12d8105244b9b48423b98165ed692a4a');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('place:discord:guild:g1','aud:group:discord','edge:12d8105244b9b48423b98165ed692a4a');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:discord:channel:c1:purpose','aud:group:discord','description:desc:discord:channel:c1:purpose');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:discord:channel:c1:purpose:legacy','aud:group:discord','description_version:desc:discord:channel:c1:purpose:legacy');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:discord:channel:c1:purpose','aud:group:discord','edge:3baf48aafb4e27d110618f18130cafd8');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('place:discord:channel:c1','aud:group:discord','edge:3baf48aafb4e27d110618f18130cafd8');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:discord:channel:c1:purpose:legacy','aud:group:discord','edge:607711092927f61bc67724581dd24f87');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:discord:channel:c1:purpose','aud:group:discord','edge:607711092927f61bc67724581dd24f87');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:discord:channel:c1:topics','aud:group:discord','description:desc:discord:channel:c1:topics');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:discord:channel:c1:topics:legacy','aud:group:discord','description_version:desc:discord:channel:c1:topics:legacy');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:discord:channel:c1:topics','aud:group:discord','edge:62b3396bddc2ca8c843b6945e2405efe');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('place:discord:channel:c1','aud:group:discord','edge:62b3396bddc2ca8c843b6945e2405efe');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:discord:channel:c1:topics:legacy','aud:group:discord','edge:3369253deee536d072f0c87bf3379e6c');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:discord:channel:c1:topics','aud:group:discord','edge:3369253deee536d072f0c87bf3379e6c');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:discord:channel:c1:tone','aud:group:discord','description:desc:discord:channel:c1:tone');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:discord:channel:c1:tone:legacy','aud:group:discord','description_version:desc:discord:channel:c1:tone:legacy');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:discord:channel:c1:tone','aud:group:discord','edge:8b0448c94575a74ac1221d536fa6f6b1');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('place:discord:channel:c1','aud:group:discord','edge:8b0448c94575a74ac1221d536fa6f6b1');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:discord:channel:c1:tone:legacy','aud:group:discord','edge:3d03ff25a75f1310937689dba33965ca');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:discord:channel:c1:tone','aud:group:discord','edge:3d03ff25a75f1310937689dba33965ca');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('source:src:discord:m1:1:seen','aud:group:discord','source:src:discord:m1:1:seen');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('source:src:discord:m1:1:seen','aud:group:discord','edge:ddaa84b79a51caff82f6cf970ac9127a');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('account:discord:u1','aud:group:discord','edge:ddaa84b79a51caff82f6cf970ac9127a');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('source:src:discord:m1:1:seen','aud:group:discord','edge:e2c392b69ae71e074509efd31f8fdf7f');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('place:discord:channel:c1','aud:group:discord','edge:e2c392b69ae71e074509efd31f8fdf7f');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('source:src:discord:m2:1:seen','aud:dm:discord:dm:u1','source:src:discord:m2:1:seen');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('source:src:discord:m2:1:seen','aud:dm:discord:dm:u1','edge:0fde66f77f95117655f020b2553515e8');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('account:discord:u1','aud:dm:discord:dm:u1','edge:0fde66f77f95117655f020b2553515e8');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('source:src:discord:m2:1:seen','aud:dm:discord:dm:u1','edge:d38b6e61160450fd0c7c26aac559c8f1');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('place:discord:dm:u1','aud:dm:discord:dm:u1','edge:d38b6e61160450fd0c7c26aac559c8f1');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('source:src:discord:m3:1:seen','aud:dm:discord:dm:u2','source:src:discord:m3:1:seen');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('source:src:discord:m3:1:seen','aud:dm:discord:dm:u2','edge:f6d8b236dd4e469f1b665f07650c7c1a');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('account:discord:u1','aud:dm:discord:dm:u2','edge:f6d8b236dd4e469f1b665f07650c7c1a');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('source:src:discord:m3:1:seen','aud:dm:discord:dm:u2','edge:75412b57439dea1a89aa8b63c0503866');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('place:discord:dm:u2','aud:dm:discord:dm:u2','edge:75412b57439dea1a89aa8b63c0503866');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('claim:dt-ab86a51c-fd47-468c-b6ea-4274f881e8db','aud:dm:discord:dm:u2','claim:dt-ab86a51c-fd47-468c-b6ea-4274f881e8db');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('claim:dt-ab86a51c-fd47-468c-b6ea-4274f881e8db','aud:dm:discord:dm:u2','edge:1cefa3a5249602012d6a0733a378c175');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('person:person:discord:u2','aud:dm:discord:dm:u2','edge:1cefa3a5249602012d6a0733a378c175');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u2:dm:relationship','aud:dm:discord:dm:u2','description:desc:person:discord:u2:dm:relationship');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:person:discord:u2:dm:relationship:legacy','aud:dm:discord:dm:u2','description_version:desc:person:discord:u2:dm:relationship:legacy');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u2:dm:relationship','aud:dm:discord:dm:u2','edge:57f227d871748188e0d1619d637a310a');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('person:person:discord:u2','aud:dm:discord:dm:u2','edge:57f227d871748188e0d1619d637a310a');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description_version:desc:person:discord:u2:dm:relationship:legacy','aud:dm:discord:dm:u2','edge:3da17cbeddbda022462702252e1641a3');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('description:desc:person:discord:u2:dm:relationship','aud:dm:discord:dm:u2','edge:3da17cbeddbda022462702252e1641a3');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('intention:int-1','aud:internal','intention:int-1');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('media:media:gif:a1','aud:group:discord','media:media:gif:a1');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('claim:recent_line::d4b2a096b3f5a4ed','aud:group:discord','claim:recent_line::d4b2a096b3f5a4ed');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('episode:participation::d4b2a096b3f5a4ed','aud:group:discord','episode:participation::d4b2a096b3f5a4ed');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('media:media:attachment:entries','aud:group:discord','media:media:attachment:entries');
INSERT INTO "node_access" ("node_id","audience_id","evidence_id") VALUES ('diary:diary::3165d2edf08a7e80','aud:group:discord','diary:diary::3165d2edf08a7e80');
INSERT INTO "publication_grants" ("id","row_kind","row_id","content_hash","destinations","approved_by","approved_at","reason","revoked_at") VALUES ('grant:1','diary','diary:1','hash-1','["discord:channel:c1"]','owner','2026-10-01T12:00:00.000Z',NULL,NULL);
INSERT INTO "mirrors" ("id","row_kind","place_id","enabled","created_at","created_by","extra","registered_at","removed_at","removed_by","backfill_enabled","backfill_interval_ms","backfill_high_water","backfill_next_due_at","backfill_completed_at") VALUES ('mirror:1','diary','discord:channel:c1',1,'2026-10-01T12:00:00.000Z','owner','{"backfill":{"cursor":"diary:0","paced":2}}',NULL,NULL,NULL,0,NULL,NULL,NULL,NULL);
INSERT INTO "wakes" ("id","kind","community","due_at","queued_at","payload","state","lease_holder","lease_token","lease_expires_at","handled_at","outcome","turn_id","attempt","claimed_at","turn") VALUES ('inner.wake:heartbeat:1','heartbeat','g1',NULL,1790856000000,'{"kind":"heartbeat"}','queued',NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:63888e60b0e436ad389263cc73c6f4d7','inner','persona','persona:local',NULL,NULL,NULL,'{"kind":"inner","subject":{"type":"persona","id":"persona:local"}}',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:dae2fbd39e6cdc060f4c20cdd4515a4e','user','account','discord:u1','discord:guild:g1',NULL,NULL,'{"kind":"user","subject":{"type":"account","id":"discord:u1"},"scopePlaceId":"discord:guild:g1"}',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:8adc9170509132aa288fce2d6f7c8073','user','account','discord:u2','discord:guild:g1',NULL,NULL,'{"kind":"user","subject":{"type":"account","id":"discord:u2"},"scopePlaceId":"discord:guild:g1"}',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:43ac0f11ced04660c949ccdd8f405a09','private','account','discord:u1','discord:guild:g1',NULL,NULL,'{"kind":"private","subject":{"type":"account","id":"discord:u1"},"scopePlaceId":"discord:guild:g1"}',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:3678eaeac42aa03fc4e317af1d8db316','guild','place','discord:guild:g1','discord:guild:g1',NULL,NULL,'{"kind":"guild","subject":{"type":"place","id":"discord:guild:g1"},"scopePlaceId":"discord:guild:g1"}',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:17642bf6db3bf541370b68c369c88d0d','lore','place','discord:guild:g1','discord:guild:g1',NULL,NULL,'{"kind":"lore","subject":{"type":"place","id":"discord:guild:g1"},"scopePlaceId":"discord:guild:g1"}',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:7d1333f1393fe317691fce8428459583','channel','place','discord:channel:c1','discord:guild:g1',NULL,NULL,'{"kind":"channel","subject":{"type":"place","id":"discord:channel:c1"},"scopePlaceId":"discord:guild:g1"}',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:636ce7c41c7455c8539a6ec591011b18','archive','place','discord:guild:g1','discord:guild:g1','2026-10',NULL,'{"kind":"archive","subject":{"type":"place","id":"discord:guild:g1"},"scopePlaceId":"discord:guild:g1","partition":"2026-10"}',1,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:835ad76e2422d0a068250d2a1ee3b6dc','archive','account','discord:u1','discord:guild:g1','2026-10',NULL,'{"kind":"archive","subject":{"type":"account","id":"discord:u1"},"scopePlaceId":"discord:guild:g1","partition":"2026-10"}',1,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:c676dd55b9f169af18945bcc0bf315e1','record','place','discord:guild:g1','discord:guild:g1','2026-10-01',NULL,'{"kind":"record","subject":{"type":"place","id":"discord:guild:g1"},"scopePlaceId":"discord:guild:g1","partition":"2026-10-01"}',1,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:ea00c78f0c9a769ae5ecce63725a3298','record','account','discord:u1','discord:guild:g1','2026-10-01',NULL,'{"kind":"record","subject":{"type":"account","id":"discord:u1"},"scopePlaceId":"discord:guild:g1","partition":"2026-10-01"}',1,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:ba8ef3b527ef96619bb15961e6684b2f','record','account','discord:u2','discord:guild:no-community','2026-10-01',NULL,'{"kind":"record","subject":{"type":"account","id":"discord:u2"},"scopePlaceId":"discord:guild:no-community","partition":"2026-10-01"}',1,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:e1b7d6fbdaa52629a94025070f7f9d43','journal','place','discord:guild:g1','discord:guild:g1','2026-10-01',NULL,'{"kind":"journal","subject":{"type":"place","id":"discord:guild:g1"},"scopePlaceId":"discord:guild:g1","partition":"2026-10-01"}',2,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:a3d6a7d87d47f024325f56b8ee4be1f8','journal','account','discord:u1','discord:guild:g1','2026-10-01',NULL,'{"kind":"journal","subject":{"type":"account","id":"discord:u1"},"scopePlaceId":"discord:guild:g1","partition":"2026-10-01"}',1,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:35b48ba835de96bc230edec35f1bf598','journal','account','discord:u2','discord:guild:no-community','2026-10-01',NULL,'{"kind":"journal","subject":{"type":"account","id":"discord:u2"},"scopePlaceId":"discord:guild:no-community","partition":"2026-10-01"}',1,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:f935a904a0c9e719645d73df5781c4ba','journal','place','discord:guild:','discord:guild:','2026-10-01',NULL,'{"kind":"journal","subject":{"type":"place","id":"discord:guild:"},"scopePlaceId":"discord:guild:","partition":"2026-10-01"}',1,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:73f8b674c1125b3b1a382ff1ca4d60ad','private','account','discord:u2','discord:guild:no-community',NULL,NULL,'{"kind":"private","subject":{"type":"account","id":"discord:u2"},"scopePlaceId":"discord:guild:no-community"}',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:6ee258339aaed444ed6ce3913df249dc','intentions','place','discord:guild:g1','discord:guild:g1',NULL,'{"collection":"active"}','{"kind":"intentions","subject":{"type":"place","id":"discord:guild:g1"},"scopePlaceId":"discord:guild:g1","selector":{"collection":"active"}}',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:2e07a9639c26a52e3e46541abc28dc1d','gifs','place','discord:guild:g1','discord:guild:g1',NULL,NULL,'{"kind":"gifs","subject":{"type":"place","id":"discord:guild:g1"},"scopePlaceId":"discord:guild:g1"}',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:8b3a74741c7a5cf66ddcd7fcb17d9d89','recent','place','discord:guild:g1','discord:guild:g1',NULL,NULL,'{"kind":"recent","subject":{"type":"place","id":"discord:guild:g1"},"scopePlaceId":"discord:guild:g1"}',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:f753b9f696fe9e26e4587438d704d69c','participation','place','discord:guild:g1','discord:guild:g1',NULL,NULL,'{"kind":"participation","subject":{"type":"place","id":"discord:guild:g1"},"scopePlaceId":"discord:guild:g1"}',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:759e23c9c093c356747c4482ca0c1319','media','place','discord:guild:g1','discord:guild:g1',NULL,NULL,'{"kind":"media","subject":{"type":"place","id":"discord:guild:g1"},"scopePlaceId":"discord:guild:g1"}',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:ba72e6653dea71354d067cdf34cc20e5','missed','place','discord:guild:g1','discord:guild:g1',NULL,NULL,'{"kind":"missed","subject":{"type":"place","id":"discord:guild:g1"},"scopePlaceId":"discord:guild:g1"}',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:31ce3c9eb7acf8402a4d2dd9f47b2205','diary','place','discord:guild:g1','discord:guild:g1',NULL,NULL,'{"kind":"diary","subject":{"type":"place","id":"discord:guild:g1"},"scopePlaceId":"discord:guild:g1"}',NULL,NULL,'2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "storage_units" ("id","kind","subject_type","subject_id","scope_place_id","partition","selector","key_json","lines","offset","synced_at","retired_at") VALUES ('unit:5153707a022e92536da2f0a7060c50cf','private','account','discord:u2','discord:guild:g1',NULL,NULL,'{"kind":"private","subject":{"type":"account","id":"discord:u2"},"scopePlaceId":"discord:guild:g1"}',NULL,NULL,NULL,NULL);
INSERT INTO "legacy_unit_aliases" ("path","unit_id") VALUES ('guilds/g1/lore.json','unit:17642bf6db3bf541370b68c369c88d0d');
INSERT INTO "legacy_unit_aliases" ("path","unit_id") VALUES ('guilds/g1/private/u1.json','unit:43ac0f11ced04660c949ccdd8f405a09');
INSERT INTO "model_requests" ("id","schema_version","turn_id","attempt_id","step","role","model","purpose","status","started_at","finished_at","system_text","messages","tools","tool_choice","response_text","think","tool_calls","usage","error_code","source","service","backend","run_id","outcome") VALUES ('req:1',1,'t1',NULL,NULL,'core','x/y',NULL,'ok','2026-10-01T12:00:00.000Z',NULL,NULL,'[{"role":"user","content":"a synthetic request"}]',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'watcher','claude','run-1','done');
INSERT INTO "publications" ("id","row_kind","row_id","content_hash","rendered","destination_place_id","context_id","grant_id","status","idempotency_key","receipts","created_at","sent_at","owner_file","retired_at","owner_key","code","retryable","claimed_by","claimed_at","paced","reconciled_by","reconciled_at","delivery") VALUES ('pub:queued','diary','diary:1','hash-1','a synthetic entry','discord:channel:c1',NULL,'grant:1','queued','idem:queued',NULL,'2026-10-01T12:00:00.000Z',NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,1,NULL,NULL,'{"parts":2}');
INSERT INTO "publications" ("id","row_kind","row_id","content_hash","rendered","destination_place_id","context_id","grant_id","status","idempotency_key","receipts","created_at","sent_at","owner_file","retired_at","owner_key","code","retryable","claimed_by","claimed_at","paced","reconciled_by","reconciled_at","delivery") VALUES ('pub:sending','diary','diary:1','hash-1','a synthetic entry','discord:channel:c1',NULL,'grant:1','sending','idem:sending','[{"part":1,"id":"native-1"}]','2026-10-01T12:00:00.000Z',NULL,NULL,NULL,NULL,NULL,0,'worker-1',1790856000000,1,NULL,NULL,'{"parts":2}');
INSERT INTO "publications" ("id","row_kind","row_id","content_hash","rendered","destination_place_id","context_id","grant_id","status","idempotency_key","receipts","created_at","sent_at","owner_file","retired_at","owner_key","code","retryable","claimed_by","claimed_at","paced","reconciled_by","reconciled_at","delivery") VALUES ('pub:sent','diary','diary:1','hash-1','a synthetic entry','discord:channel:c1',NULL,'grant:1','sent','idem:sent','[{"part":1,"id":"native-1"}]','2026-10-01T12:00:00.000Z',NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,1,NULL,NULL,'{"parts":2}');
INSERT INTO "publications" ("id","row_kind","row_id","content_hash","rendered","destination_place_id","context_id","grant_id","status","idempotency_key","receipts","created_at","sent_at","owner_file","retired_at","owner_key","code","retryable","claimed_by","claimed_at","paced","reconciled_by","reconciled_at","delivery") VALUES ('pub:failed','diary','diary:1','hash-1','a synthetic entry','discord:channel:c1',NULL,'grant:1','failed','idem:failed','[{"part":1,"id":"native-1"}]','2026-10-01T12:00:00.000Z',NULL,NULL,NULL,NULL,'SYNTHETIC',0,NULL,NULL,1,NULL,NULL,'{"parts":2}');
INSERT INTO "publications" ("id","row_kind","row_id","content_hash","rendered","destination_place_id","context_id","grant_id","status","idempotency_key","receipts","created_at","sent_at","owner_file","retired_at","owner_key","code","retryable","claimed_by","claimed_at","paced","reconciled_by","reconciled_at","delivery") VALUES ('pub:incomplete','diary','diary:1','hash-1','a synthetic entry','discord:channel:c1',NULL,'grant:1','incomplete','idem:incomplete','[{"part":1,"id":"native-1"}]','2026-10-01T12:00:00.000Z',NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,1,NULL,NULL,'{"parts":2}');
INSERT INTO "publications" ("id","row_kind","row_id","content_hash","rendered","destination_place_id","context_id","grant_id","status","idempotency_key","receipts","created_at","sent_at","owner_file","retired_at","owner_key","code","retryable","claimed_by","claimed_at","paced","reconciled_by","reconciled_at","delivery") VALUES ('pub:unknown','diary','diary:1','hash-1','a synthetic entry','discord:channel:c1',NULL,'grant:1','unknown','idem:unknown','[{"part":1,"id":"native-1"}]','2026-10-01T12:00:00.000Z',NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,1,'owner','2026-10-01T12:00:00.000Z','{"parts":2}');
INSERT INTO "board_schema_version" ("version") VALUES (1);
INSERT INTO "board_schema_version" ("version") VALUES (2);
INSERT INTO "board_schema_version" ("version") VALUES (3);
CREATE INDEX sources_place_time ON sources(place_id, occurred_at);
CREATE INDEX sources_native ON sources(native_id);
CREATE INDEX sources_turn ON sources(turn_id);
CREATE INDEX sources_file ON sources(owner_file, position);
CREATE TRIGGER sources_ai AFTER INSERT ON sources BEGIN
  INSERT INTO sources_fts(rowid, text, stems) VALUES (new.rowid, new.text, new.stems);
  INSERT INTO sources_tri(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER sources_ad AFTER DELETE ON sources BEGIN
  INSERT INTO sources_fts(sources_fts, rowid, text, stems) VALUES ('delete', old.rowid, old.text, old.stems);
  INSERT INTO sources_tri(sources_tri, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE INDEX claims_subject ON claims(subject_id, kind);
CREATE INDEX claims_file ON claims(owner_file, position);
CREATE INDEX day_at ON day(at);
CREATE INDEX vectors_file ON vectors(owner_file);
CREATE INDEX people_owner ON people(owner_file);
CREATE INDEX accounts_owner ON accounts(owner_file);
CREATE INDEX places_owner ON places(owner_file);
CREATE INDEX memberships_owner ON memberships(owner_file);
CREATE INDEX claim_versions_owner ON claim_versions(owner_file);
CREATE INDEX descriptions_owner ON descriptions(owner_file);
CREATE INDEX description_versions_owner ON description_versions(owner_file);
CREATE INDEX episodes_owner ON episodes(owner_file);
CREATE INDEX affinity_events_owner ON affinity_events(owner_file);
CREATE INDEX day_owner ON day(owner_file);
CREATE INDEX diary_owner ON diary(owner_file);
CREATE INDEX media_owner ON media(owner_file);
CREATE INDEX intentions_owner ON intentions(owner_file);
CREATE INDEX work_owner ON work(owner_file);
CREATE INDEX work_events_owner ON work_events(owner_file);
CREATE INDEX decisions_owner ON decisions(owner_file);
CREATE INDEX operational_owner ON operational(owner_file);
CREATE INDEX episode_sources_episode ON episode_sources(episode_id);
CREATE INDEX claim_sources_claim ON claim_sources(claim_id);
CREATE INDEX diary_mirrors_diary ON diary_mirrors(diary_id);
CREATE INDEX session_runs_sweep ON session_runs(sweep_id);
CREATE INDEX claim_sources_owner ON claim_sources(owner_file);
CREATE INDEX episode_sources_owner ON episode_sources(owner_file);
CREATE INDEX diary_mirrors_owner ON diary_mirrors(owner_file);
CREATE INDEX co_owners_owner ON co_owners(owner_file);
CREATE INDEX vectors_model ON vectors(model, dims);
CREATE UNIQUE INDEX session_runs_applied ON session_runs(batch_key) WHERE applied = 1;
CREATE INDEX external_keys_node ON external_keys(node_id);
CREATE UNIQUE INDEX audiences_single ON audiences(kind) WHERE kind IN ('none', 'internal');
CREATE UNIQUE INDEX audiences_group ON audiences(iface) WHERE kind = 'group';
CREATE UNIQUE INDEX audiences_dm ON audiences(place_id) WHERE kind = 'dm';
CREATE INDEX account_person_links_account ON account_person_links(account_id, valid_to_at);
CREATE INDEX account_person_links_person ON account_person_links(person_id);
CREATE UNIQUE INDEX accounts_native ON accounts(authority_id, native_key, generation) WHERE authority_id IS NOT NULL;
CREATE UNIQUE INDEX places_native ON places(authority_id, native_key, generation) WHERE authority_id IS NOT NULL;
CREATE TRIGGER sources_au AFTER UPDATE OF text, stems ON sources BEGIN
  INSERT INTO sources_fts(sources_fts, rowid, text, stems) VALUES ('delete', old.rowid, old.text, old.stems);
  INSERT INTO sources_tri(sources_tri, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO sources_fts(rowid, text, stems) VALUES (new.rowid, new.text, new.stems);
  INSERT INTO sources_tri(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE UNIQUE INDEX participants_tuple ON participants(authority_id, COALESCE(scope_place_id, ''), token_kind, COALESCE(native_token, observation_key), generation);
CREATE INDEX participant_links_participant ON participant_links(participant_id, valid_to_at);
CREATE INDEX participant_links_account ON participant_links(account_id);
CREATE INDEX participant_links_person ON participant_links(person_id);
CREATE UNIQUE INDEX people_merges_from ON people_merges(from_person);
CREATE INDEX people_merges_into ON people_merges(into_person);
CREATE INDEX sources_native_tuple ON sources(authority_id, native_kind, native_id, generation, revision);
CREATE INDEX sources_author_participant ON sources(author_participant) WHERE author_participant IS NOT NULL;
CREATE INDEX capture_bundles_anchor ON capture_bundles(anchor_source_id);
CREATE INDEX capture_members_source ON capture_members(source_id);
CREATE INDEX capture_events_bundle ON capture_events(bundle_id, id);
CREATE TRIGGER capture_events_no_update BEFORE UPDATE ON capture_events BEGIN SELECT RAISE(ABORT, 'capture events are append-only'); END;
CREATE TRIGGER capture_events_no_delete BEFORE DELETE ON capture_events BEGIN SELECT RAISE(ABORT, 'capture events are append-only'); END;
CREATE TRIGGER capture_members_no_update BEFORE UPDATE ON capture_members BEGIN SELECT RAISE(ABORT, 'capture members are never removed'); END;
CREATE TRIGGER capture_members_no_delete BEFORE DELETE ON capture_members BEGIN SELECT RAISE(ABORT, 'capture members are never removed'); END;
CREATE INDEX capture_watches_due ON capture_watches(done_at, due_at);
CREATE UNIQUE INDEX source_relations_key ON source_relations(source_id, predicate, target_key);
CREATE INDEX source_relations_pending ON source_relations(target_key) WHERE target_source_id IS NULL;
CREATE INDEX source_relations_target ON source_relations(target_source_id) WHERE target_source_id IS NOT NULL;
CREATE TRIGGER source_relations_key_fixed BEFORE UPDATE OF source_id, predicate, target_key ON source_relations
    BEGIN SELECT RAISE(ABORT, 'a relation keeps its source, predicate and target key'); END;
CREATE TRIGGER source_relations_no_delete BEFORE DELETE ON source_relations BEGIN SELECT RAISE(ABORT, 'relations are never deleted'); END;
CREATE INDEX graph_nodes_row ON graph_nodes(kind, row_id);
CREATE INDEX graph_edges_out ON graph_edges(src, predicate, dst);
CREATE INDEX graph_edges_in ON graph_edges(dst, predicate, src);
CREATE INDEX graph_edges_owner ON graph_edges(owner_key);
CREATE INDEX node_access_evidence ON node_access(evidence_id);
CREATE INDEX claim_version_sources_source ON claim_version_sources(source_id);
CREATE INDEX claim_versions_claim ON claim_versions(claim_id);
CREATE UNIQUE INDEX claim_sources_id ON claim_sources(id);
CREATE TRIGGER claim_sources_id_fill AFTER INSERT ON claim_sources WHEN new.id IS NULL BEGIN
    UPDATE claim_sources SET id = 'cs:' || COALESCE(new.claim_id, '') || CASE WHEN new.owner_file IS NULL THEN ':s:' || COALESCE(new.source_id, '') ELSE ':p:' || COALESCE(new.position, '') END || CASE WHEN EXISTS (SELECT 1 FROM claim_sources o WHERE o.id = 'cs:' || COALESCE(new.claim_id, '') || CASE WHEN new.owner_file IS NULL THEN ':s:' || COALESCE(new.source_id, '') ELSE ':p:' || COALESCE(new.position, '') END) THEN '#dup' || new.rowid ELSE '' END
    WHERE rowid = new.rowid;
  END;
CREATE UNIQUE INDEX episode_sources_id ON episode_sources(id);
CREATE TRIGGER episode_sources_id_fill AFTER INSERT ON episode_sources WHEN new.id IS NULL BEGIN
    UPDATE episode_sources SET id = 'es:' || COALESCE(new.episode_id, '') || CASE WHEN new.owner_file IS NULL THEN ':s:' || COALESCE(new.source_id, '') ELSE ':p:' || COALESCE(new.position, '') END || CASE WHEN EXISTS (SELECT 1 FROM episode_sources o WHERE o.id = 'es:' || COALESCE(new.episode_id, '') || CASE WHEN new.owner_file IS NULL THEN ':s:' || COALESCE(new.source_id, '') ELSE ':p:' || COALESCE(new.position, '') END) THEN '#dup' || new.rowid ELSE '' END
    WHERE rowid = new.rowid;
  END;
CREATE UNIQUE INDEX diary_mirrors_id ON diary_mirrors(id);
CREATE TRIGGER diary_mirrors_id_fill AFTER INSERT ON diary_mirrors WHEN new.id IS NULL BEGIN
    UPDATE diary_mirrors SET id = 'mirror:' || COALESCE(new.diary_id, '') || ':' || COALESCE(new.iface, '') || ':' || COALESCE(new.place_id, '') || CASE WHEN EXISTS (SELECT 1 FROM diary_mirrors o WHERE o.id = 'mirror:' || COALESCE(new.diary_id, '') || ':' || COALESCE(new.iface, '') || ':' || COALESCE(new.place_id, '')) THEN '#dup' || new.rowid ELSE '' END
    WHERE rowid = new.rowid;
  END;
CREATE INDEX publication_grants_row ON publication_grants(row_kind, row_id, content_hash);
CREATE TRIGGER publication_grants_fixed BEFORE UPDATE OF id, row_kind, row_id, content_hash, destinations, approved_by, approved_at, reason ON publication_grants
    BEGIN SELECT RAISE(ABORT, 'a grant is immutable; revoke it and grant again'); END;
CREATE TRIGGER publication_grants_revoked_once BEFORE UPDATE OF revoked_at ON publication_grants WHEN old.revoked_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'a revoked grant stays revoked'); END;
CREATE TRIGGER publication_grants_no_delete BEFORE DELETE ON publication_grants BEGIN SELECT RAISE(ABORT, 'grants are never deleted'); END;
CREATE INDEX relationship_daily_day ON relationship_daily(day);
CREATE INDEX focus_events_person ON focus_events(person_id, at);
CREATE INDEX focus_events_at ON focus_events(at);
CREATE TRIGGER focus_events_no_update BEFORE UPDATE ON focus_events BEGIN SELECT RAISE(ABORT, 'focus events are append-only'); END;
CREATE TRIGGER focus_events_no_delete BEFORE DELETE ON focus_events BEGIN SELECT RAISE(ABORT, 'focus events are append-only'); END;
CREATE INDEX wake_runs_status ON wake_runs(status, started_at);
CREATE INDEX skill_versions_skill ON skill_versions(skill_id, created_at);
CREATE TRIGGER skill_versions_fixed BEFORE UPDATE OF id, skill_id, version, content_hash, manifest_hash, commit_sha, manifest, created_at ON skill_versions
    BEGIN SELECT RAISE(ABORT, 'a skill version keeps its hashes; a change is a new version'); END;
CREATE INDEX skill_evaluations_version ON skill_evaluations(version_id, kind);
CREATE INDEX index_policy_touch ON index_policy(expires_at) WHERE reason = 'touch';
CREATE INDEX ingest_committed_at ON ingest (committed_at);
CREATE INDEX wakes_state ON wakes (community, state, queued_at);
CREATE INDEX deliveries_state ON deliveries (state, queued_at);
CREATE TRIGGER skill_evaluations_no_update BEFORE UPDATE ON skill_evaluations BEGIN SELECT RAISE(ABORT, 'evaluations are append-only'); END;
CREATE TRIGGER skill_evaluations_no_delete BEFORE DELETE ON skill_evaluations BEGIN SELECT RAISE(ABORT, 'evaluations are append-only'); END;
CREATE INDEX skill_uses_skill ON skill_uses(skill, at);
CREATE TRIGGER skill_uses_no_update BEFORE UPDATE ON skill_uses BEGIN SELECT RAISE(ABORT, 'skill uses are append-only'); END;
CREATE TRIGGER skill_uses_no_delete BEFORE DELETE ON skill_uses BEGIN SELECT RAISE(ABORT, 'skill uses are append-only'); END;
CREATE INDEX sources_message_locator ON sources(iface, CASE WHEN json_valid(extra) THEN json_extract(extra, '$."$messageLocator".conversationId') END, CASE WHEN json_valid(extra) THEN json_extract(extra, '$."$messageLocator".messageId') END, generation);
CREATE INDEX sources_iface_native ON sources(iface, native_id, generation);
CREATE INDEX ingest_source ON ingest(source_id) WHERE source_id IS NOT NULL;
CREATE INDEX storage_units_subject ON storage_units(kind,subject_type,subject_id,scope_place_id,partition);
CREATE INDEX "people_storage_owner" ON "people"(owner_key);
CREATE INDEX "accounts_storage_owner" ON "accounts"(owner_key);
CREATE INDEX "places_storage_owner" ON "places"(owner_key);
CREATE INDEX "memberships_storage_owner" ON "memberships"(owner_key);
CREATE INDEX "sources_storage_owner" ON "sources"(owner_key);
CREATE INDEX "vectors_storage_owner" ON "vectors"(owner_key);
CREATE INDEX "claims_storage_owner" ON "claims"(owner_key);
CREATE INDEX "claim_versions_storage_owner" ON "claim_versions"(owner_key);
CREATE INDEX "claim_sources_storage_owner" ON "claim_sources"(owner_key);
CREATE INDEX "descriptions_storage_owner" ON "descriptions"(owner_key);
CREATE INDEX "description_versions_storage_owner" ON "description_versions"(owner_key);
CREATE INDEX "episodes_storage_owner" ON "episodes"(owner_key);
CREATE INDEX "episode_sources_storage_owner" ON "episode_sources"(owner_key);
CREATE INDEX "affinity_events_storage_owner" ON "affinity_events"(owner_key);
CREATE INDEX "day_storage_owner" ON "day"(owner_key);
CREATE INDEX "diary_storage_owner" ON "diary"(owner_key);
CREATE INDEX "diary_mirrors_storage_owner" ON "diary_mirrors"(owner_key);
CREATE INDEX "media_storage_owner" ON "media"(owner_key);
CREATE INDEX "intentions_storage_owner" ON "intentions"(owner_key);
CREATE INDEX "work_storage_owner" ON "work"(owner_key);
CREATE INDEX "work_events_storage_owner" ON "work_events"(owner_key);
CREATE INDEX "decisions_storage_owner" ON "decisions"(owner_key);
CREATE INDEX "operational_storage_owner" ON "operational"(owner_key);
CREATE INDEX "co_owners_storage_owner" ON "co_owners"(owner_key);
CREATE UNIQUE INDEX co_owners_storage ON co_owners(tbl,key,owner_key);
CREATE INDEX model_requests_started ON model_requests(started_at);
CREATE INDEX model_requests_turn ON model_requests(turn_id, attempt_id, step);
CREATE INDEX publications_row ON publications(row_kind, row_id);
CREATE INDEX publications_owner ON publications(owner_file);
CREATE INDEX publications_storage_owner ON publications(owner_key);
CREATE INDEX publications_unsettled ON publications(status) WHERE status IN ('queued', 'unknown');
CREATE INDEX publications_place ON publications(row_kind, destination_place_id, status);
CREATE TRIGGER publications_content_fixed BEFORE UPDATE OF rendered, content_hash ON publications
      WHEN old.content_hash IS NOT NULL AND (new.content_hash IS NOT old.content_hash OR new.rendered IS NOT old.rendered)
      BEGIN SELECT RAISE(ABORT, 'a publication keeps its content; an edit is a new publication'); END;
CREATE TRIGGER publications_key_fixed BEFORE UPDATE OF id, row_kind, row_id, idempotency_key ON publications
      BEGIN SELECT RAISE(ABORT, 'a publication keeps its row and its key'); END;
CREATE TRIGGER publications_no_delete BEFORE DELETE ON publications BEGIN SELECT RAISE(ABORT, 'publications are never deleted'); END;
CREATE INDEX model_requests_finished ON model_requests(finished_at);
CREATE INDEX board_dependencies_on ON board_dependencies(depends_on_id);
CREATE INDEX board_attempts_task ON board_attempts(task_id);
CREATE INDEX board_questions_task ON board_questions(task_id);
CREATE INDEX board_events_task ON board_events(task_id, seq);
CREATE INDEX board_outbox_pending ON board_outbox(to_whom) WHERE delivered_at IS NULL;
CREATE INDEX board_agent_runs_agent ON board_agent_runs(agent, started_at);
CREATE INDEX board_tasks_status ON board_tasks(status);
CREATE INDEX board_tasks_lease ON board_tasks(lease_expires_at) WHERE lease_owner IS NOT NULL;
INSERT INTO sources_fts(sources_fts) VALUES('rebuild');
INSERT INTO sources_tri(sources_tri) VALUES('rebuild');
COMMIT;
PRAGMA foreign_keys = ON;
