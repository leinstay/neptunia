// The memory database's schema, version 1 (spec: the memory store, section 3). One entry per version in
// MIGRATIONS, appended and never edited (src/memory/db/open.js applies them in order).
//
// Beyond the spec's list, every table a round trip needs carries: `position` (the index an old array had, so the
// array comes back in order), `owner_file` (the JSON file a row was made from, so a re-map of that file finds its
// previous rows) and, where an old object had fields no column names, `extra JSON`. `sources` also carries `stems`
// because an external-content FTS5 table reads its columns from the table it indexes.
//
// There is no `now` table and no `states` table: the owner dropped both.

const SCOPE = 'scope_kind TEXT, scope_iface TEXT, scope_dm TEXT';

const V1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value);
CREATE TABLE files (path TEXT PRIMARY KEY, kind TEXT, size INTEGER, mtime_ms INTEGER, sha1 TEXT, offset INTEGER, synced_at TEXT);

CREATE TABLE people (
  id TEXT PRIMARY KEY, kind TEXT, first_seen_at TEXT, last_seen_at TEXT, message_count INTEGER,
  affinity REAL, affinity_reason TEXT, affinity_decayed_at TEXT, real_name JSON, extra JSON, retired_at TEXT,
  owner_file TEXT
);
CREATE TABLE accounts (
  id TEXT PRIMARY KEY, iface TEXT, native_id TEXT, person_id TEXT, link TEXT, linked_by TEXT, linked_at TEXT,
  names JSON, avatar JSON, extra JSON, owner_file TEXT
);
CREATE TABLE places (
  id TEXT PRIMARY KEY, iface TEXT, kind TEXT, native_id TEXT, parent_id TEXT, scope_kind TEXT,
  name TEXT, category TEXT, topic TEXT, extra JSON, retired_at TEXT, owner_file TEXT
);
CREATE TABLE memberships (
  id TEXT PRIMARY KEY, account_id TEXT, place_id TEXT, nick TEXT, roles JSON, addressed_as JSON, pings_off INTEGER,
  extra JSON, valid_from_at TEXT, valid_to_at TEXT, owner_file TEXT
);

CREATE TABLE sources (
  rowid INTEGER PRIMARY KEY, id TEXT UNIQUE, kind TEXT, iface TEXT, native_id TEXT, revision INTEGER, place_id TEXT,
  author_account TEXT, reply_to TEXT, occurred_at TEXT, recorded_at TEXT, seen_at TEXT, text TEXT, stems TEXT,
  media JSON, mentions JSON, direct INTEGER, turn_id TEXT, op_id TEXT, think TEXT, extra JSON,
  ${SCOPE}, origin TEXT, owner_file TEXT, position INTEGER
);
CREATE INDEX sources_place_time ON sources(place_id, occurred_at);
CREATE INDEX sources_native ON sources(native_id);
CREATE INDEX sources_turn ON sources(turn_id);
CREATE INDEX sources_file ON sources(owner_file, position);
CREATE VIRTUAL TABLE sources_fts USING fts5(text, stems, content='sources', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE sources_tri USING fts5(text, content='sources', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER sources_ai AFTER INSERT ON sources BEGIN
  INSERT INTO sources_fts(rowid, text, stems) VALUES (new.rowid, new.text, new.stems);
  INSERT INTO sources_tri(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER sources_ad AFTER DELETE ON sources BEGIN
  INSERT INTO sources_fts(sources_fts, rowid, text, stems) VALUES ('delete', old.rowid, old.text, old.stems);
  INSERT INTO sources_tri(sources_tri, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER sources_au AFTER UPDATE ON sources BEGIN
  INSERT INTO sources_fts(sources_fts, rowid, text, stems) VALUES ('delete', old.rowid, old.text, old.stems);
  INSERT INTO sources_tri(sources_tri, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO sources_fts(rowid, text, stems) VALUES (new.rowid, new.text, new.stems);
  INSERT INTO sources_tri(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE vectors (
  source_rowid INTEGER, item_id TEXT, chunk_key TEXT UNIQUE, model TEXT, dims INTEGER, scale REAL, norm REAL,
  bytes BLOB, context JSON, occurred_at TEXT, ${SCOPE}
);

CREATE TABLE claims (
  id TEXT PRIMARY KEY, subject_kind TEXT, subject_id TEXT, kind TEXT, text TEXT, extra JSON, weight REAL,
  first_seen_at TEXT, last_seen_at TEXT, valid_to TEXT, superseded_by TEXT, how TEXT, author TEXT, from_person TEXT,
  truth TEXT, shown INTEGER, ${SCOPE}, created_at TEXT, retired_at TEXT, origin_file TEXT, owner_file TEXT, position INTEGER
);
CREATE INDEX claims_subject ON claims(subject_id, kind);
CREATE INDEX claims_file ON claims(owner_file, position);
CREATE TABLE claim_versions (
  id TEXT PRIMARY KEY, claim_id TEXT, revision_id TEXT, text TEXT, extra JSON, recorded_at TEXT, event TEXT, by TEXT,
  origin TEXT, owner_file TEXT, position INTEGER
);
CREATE TABLE claim_sources (claim_id TEXT, source_id TEXT, position INTEGER);

CREATE TABLE descriptions (
  id TEXT PRIMARY KEY, subject_kind TEXT, subject_id TEXT, field TEXT, ${SCOPE}, current_version TEXT, owner_file TEXT
);
CREATE TABLE description_versions (
  id TEXT PRIMARY KEY, description_id TEXT, text TEXT, author TEXT, written_at TEXT, chars INTEGER, kept INTEGER,
  removed INTEGER, added INTEGER, reason TEXT, origin TEXT, extra JSON, owner_file TEXT, position INTEGER
);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY, kind TEXT, subject_id TEXT, place_id TEXT, date TEXT, what TEXT, quote TEXT, feeling TEXT,
  feeling_at TEXT, reread JSON, weight REAL, world TEXT, status TEXT, perspective TEXT, start_ms INTEGER,
  last_ms INTEGER, extra JSON, ${SCOPE}, created_at TEXT, retired_at TEXT, owner_file TEXT, position INTEGER
);
CREATE TABLE episode_sources (episode_id TEXT, source_id TEXT, position INTEGER);

CREATE TABLE affinity_events (
  id TEXT PRIMARY KEY, person_id TEXT, at TEXT, delta REAL, applied REAL, score REAL, reason TEXT, ${SCOPE},
  extra JSON, owner_file TEXT, position INTEGER
);

CREATE TABLE day (
  id TEXT PRIMARY KEY, at TEXT, what TEXT, outcome TEXT, reason TEXT, place_id TEXT, turn_id TEXT, source_id TEXT,
  work_id TEXT, extra JSON, ${SCOPE}, owner_file TEXT, position INTEGER
);
CREATE INDEX day_at ON day(at);

CREATE TABLE diary (
  id TEXT PRIMARY KEY, at_ms INTEGER, kind TEXT, gist TEXT, text TEXT, picture_prompt TEXT, search TEXT, topic TEXT,
  world TEXT, status TEXT, perspective TEXT, ${SCOPE}, lost INTEGER, extra JSON, owner_file TEXT, position INTEGER
);
CREATE TABLE diary_mirrors (diary_id TEXT, iface TEXT, place_id TEXT, native_ids JSON, posted_at TEXT);
CREATE TABLE media (
  id TEXT PRIMARY KEY, kind TEXT, owner TEXT, path TEXT, native_ref TEXT, description TEXT, described_at TEXT,
  sha1 TEXT, bytes INTEGER, mime TEXT, ${SCOPE}, extra JSON, owner_file TEXT
);

CREATE TABLE intentions (
  id TEXT PRIMARY KEY, record JSON, status TEXT, due_ms INTEGER, created_ms INTEGER, updated_ms INTEGER, ${SCOPE},
  archived INTEGER, owner_file TEXT, position INTEGER
);
CREATE TABLE work (
  id TEXT PRIMARY KEY, kind TEXT, state TEXT, record JSON, created_ms INTEGER, updated_ms INTEGER, outcome TEXT,
  seen INTEGER, ${SCOPE}, owner_file TEXT, position INTEGER
);
CREATE TABLE work_events (id TEXT PRIMARY KEY, work_id TEXT, at_ms INTEGER, record JSON, owner_file TEXT, position INTEGER);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY, at TEXT, by TEXT, target_kind TEXT, target_id TEXT, action TEXT, reason TEXT, extra JSON,
  owner_file TEXT, position INTEGER
);
CREATE TABLE turn_reads (
  turn_id TEXT, step TEXT, row_kind TEXT, row_id TEXT, PRIMARY KEY (turn_id, step, row_kind, row_id)
);

CREATE TABLE ledger_tasks (id TEXT PRIMARY KEY, record JSON);
CREATE TABLE ledger_attempts (id TEXT PRIMARY KEY, record JSON);
CREATE TABLE ledger_questions (id TEXT PRIMARY KEY, record JSON);
CREATE TABLE ledger_approvals (id TEXT PRIMARY KEY, record JSON);
CREATE TABLE ledger_results (id TEXT PRIMARY KEY, record JSON);
CREATE TABLE ledger_comments (id TEXT PRIMARY KEY, record JSON);
CREATE TABLE ledger_events (id TEXT PRIMARY KEY, record JSON);
CREATE TABLE ledger_outbox (id TEXT PRIMARY KEY, record JSON);

CREATE TABLE operational (kind TEXT, owner TEXT, value JSON, owner_file TEXT, PRIMARY KEY (kind, owner));
`;

// Version 2 (sync): every table a sync writes can retire a row that left its file, and a vectors row knows the
// month directory it came from; `files.lines` counts the lines of a JSONL file already read.
const RETIRABLE = [
  'accounts', 'memberships', 'sources', 'vectors', 'claim_versions', 'descriptions', 'description_versions',
  'affinity_events', 'day', 'diary', 'media', 'intentions', 'work', 'work_events', 'decisions', 'operational',
];
const V2 = [
  ...RETIRABLE.map((table) => `ALTER TABLE ${table} ADD COLUMN retired_at TEXT;`),
  'ALTER TABLE vectors ADD COLUMN owner_file TEXT;',
  'ALTER TABLE files ADD COLUMN lines INTEGER;',
  'CREATE INDEX vectors_file ON vectors(owner_file);',
  ...['people', 'accounts', 'places', 'memberships', 'claim_versions', 'descriptions', 'description_versions', 'episodes',
    'affinity_events', 'day', 'diary', 'media', 'intentions', 'work', 'work_events', 'decisions', 'operational']
    .map((table) => `CREATE INDEX ${table}_owner ON ${table}(owner_file);`),
  'CREATE INDEX episode_sources_episode ON episode_sources(episode_id);',
  'CREATE INDEX claim_sources_claim ON claim_sources(claim_id);',
  'CREATE INDEX diary_mirrors_diary ON diary_mirrors(diary_id);',
].join('\n');

// Version 3 (her memory session): one row per session request, shadow or apply, whatever its outcome.
const V3 = `
CREATE TABLE session_runs (
  id TEXT PRIMARY KEY, sweep_id TEXT, scope_key TEXT, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, mode TEXT,
  started_at TEXT, finished_at TEXT, cursor_from INTEGER, cursor_to INTEGER, sources_n INTEGER,
  tokens_prompt INTEGER, tokens_completion INTEGER, model TEXT, outcome TEXT, counts JSON, errors JSON
);
CREATE INDEX session_runs_sweep ON session_runs(sweep_id);
`;

// Version 4: the diary has no `lost` mark (owner 2026-10-24: the diary in the database is the one truth; what it
// does not hold never existed). A post that was marked lost keeps its row with an empty text (fetched, nothing left).
const V4 = `
UPDATE diary SET text = '' WHERE lost = 1 AND text IS NULL;
ALTER TABLE diary DROP COLUMN lost;
`;

// Version 5 (sync and import integrity):
//  - `owner_file` is the full, guild-namespaced path of the unit (`guilds/<g>/users/<u>.json`); existing values are
//    rewritten from the `files` rows (an operational row's `owner` follows when it was built from the path);
//  - the child links (`claim_sources`, `episode_sources`, `diary_mirrors`) get `retired_at` and `owner_file` (the unit
//    that wrote the link; a link with no `owner_file` was written by the database itself and no file remap touches it);
//  - `files` gets `gone_at` (a unit that left the disk is a tombstone, never a deleted row), `tail_sha1` (the hash of the
//    last bytes before the stored offset, so a rewritten JSONL file is told from a grown one) and `bad` (the line
//    positions and byte starts of malformed lines still to retry);
//  - `co_owners`: a row two guilds both map (one person in two servers) stays one row owned by the first guild; the
//    others are listed here so their export finds it and retiring the owner hands it over instead of retiring it;
//  - `vectors(model, dims)` is indexed, and `sources.seen_at` of an old record line is its `recordedAt`.
const OWNER_TABLES = [
  'people', 'accounts', 'places', 'memberships', 'sources', 'claims', 'claim_versions', 'descriptions',
  'description_versions', 'episodes', 'affinity_events', 'day', 'diary', 'media', 'intentions', 'work', 'work_events',
  'decisions', 'vectors',
];
const CHILD_TABLES = [['claim_sources', 'claims', 'claim_id'], ['episode_sources', 'episodes', 'episode_id'], ['diary_mirrors', 'diary', 'diary_id']];
// The full path of a guild-relative owner (from the `files` rows), looked up in a temporary index so the rewrite of a
// large table is one pass.
const FULL_PATH = (table) => `(SELECT o.full FROM _owner_paths o WHERE o.rel = ${table}.owner_file)`;
const V5 = [
  'CREATE TEMP TABLE _owner_paths AS SELECT substr(path, instr(substr(path, 8), \'/\') + 8) AS rel, MIN(path) AS full FROM files WHERE path LIKE \'guilds/%\' GROUP BY 1;',
  'CREATE INDEX temp._owner_paths_rel ON _owner_paths(rel);',
  ...CHILD_TABLES.flatMap(([table]) => [
    `ALTER TABLE ${table} ADD COLUMN retired_at TEXT;`,
    `ALTER TABLE ${table} ADD COLUMN owner_file TEXT;`,
    `CREATE INDEX ${table}_owner ON ${table}(owner_file);`,
  ]),
  'ALTER TABLE files ADD COLUMN gone_at TEXT;',
  'ALTER TABLE files ADD COLUMN tail_sha1 TEXT;',
  'ALTER TABLE files ADD COLUMN bad TEXT;',
  'CREATE TABLE co_owners (tbl TEXT, key TEXT, owner_file TEXT, PRIMARY KEY (tbl, key, owner_file));',
  'CREATE INDEX co_owners_owner ON co_owners(owner_file);',
  'CREATE INDEX vectors_model ON vectors(model, dims);',
  ...OWNER_TABLES.map((table) => `UPDATE ${table} SET owner_file = ${FULL_PATH(table)} WHERE owner_file IS NOT NULL AND owner_file NOT LIKE 'guilds/%' AND ${FULL_PATH(table)} IS NOT NULL;`),
  `UPDATE operational SET owner = CASE WHEN substr(owner, 1, length(owner_file)) = owner_file THEN ${FULL_PATH('operational')} || substr(owner, length(owner_file) + 1) ELSE owner END,
     owner_file = ${FULL_PATH('operational')}
   WHERE owner_file IS NOT NULL AND owner_file NOT LIKE 'guilds/%' AND ${FULL_PATH('operational')} IS NOT NULL;`,
  ...CHILD_TABLES.map(([table, parent, link]) => `UPDATE ${table} SET owner_file = (SELECT p.owner_file FROM ${parent} p WHERE p.id = ${table}.${link});`),
  "UPDATE sources SET seen_at = recorded_at WHERE kind = 'seen' AND seen_at IS NULL AND recorded_at IS NOT NULL;",
  'DROP TABLE temp._owner_paths;',
].join('\n');

// Version 6 (her memory session before any `apply`):
//  - `session_runs` gets `batch_key` (mode, scope, cursor range and request page: the identity of what a run read),
//    `applied` (1 once an `apply` run committed; a unique index on `batch_key` among applied runs is what makes a retried
//    run apply nothing twice), `result` (the counts the first application returned, handed back to a retry) and
//    `answer_source` (the `sources` row that holds her whole answer);
//  - `turn_reads` records what the prompt rendered, resolved at assembly time: the block it was in, its order in the
//    request, the exact claim / description version and the source revision.
const V6 = [
  'ALTER TABLE session_runs ADD COLUMN batch_key TEXT;',
  'ALTER TABLE session_runs ADD COLUMN applied INTEGER NOT NULL DEFAULT 0;',
  'ALTER TABLE session_runs ADD COLUMN result JSON;',
  'ALTER TABLE session_runs ADD COLUMN answer_source TEXT;',
  'CREATE UNIQUE INDEX session_runs_applied ON session_runs(batch_key) WHERE applied = 1;',
  'ALTER TABLE turn_reads ADD COLUMN block TEXT;',
  'ALTER TABLE turn_reads ADD COLUMN ord INTEGER;',
  'ALTER TABLE turn_reads ADD COLUMN version_id TEXT;',
  'ALTER TABLE turn_reads ADD COLUMN revision INTEGER;',
].join('\n');

/** Each entry moves the schema one version up. Never edit a shipped entry: append a new one. */
export const MIGRATIONS = [V1, V2, V3, V4, V5, V6];

/** Every table schema v1 creates (virtual tables included), for tests and tools. */
export const V1_TABLES = [
  'meta', 'files', 'people', 'accounts', 'places', 'memberships', 'sources', 'sources_fts', 'sources_tri', 'vectors',
  'claims', 'claim_versions', 'claim_sources', 'descriptions', 'description_versions', 'episodes', 'episode_sources',
  'affinity_events', 'day', 'diary', 'diary_mirrors', 'media', 'intentions', 'work', 'work_events', 'decisions',
  'turn_reads', 'ledger_tasks', 'ledger_attempts', 'ledger_questions', 'ledger_approvals', 'ledger_results',
  'ledger_comments', 'ledger_events', 'ledger_outbox', 'operational',
];
