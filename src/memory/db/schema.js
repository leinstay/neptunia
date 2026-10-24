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

/** Each entry moves the schema one version up. Never edit a shipped entry: append a new one. */
export const MIGRATIONS = [V1, V2];

/** Every table schema v1 creates (virtual tables included), for tests and tools. */
export const V1_TABLES = [
  'meta', 'files', 'people', 'accounts', 'places', 'memberships', 'sources', 'sources_fts', 'sources_tri', 'vectors',
  'claims', 'claim_versions', 'claim_sources', 'descriptions', 'description_versions', 'episodes', 'episode_sources',
  'affinity_events', 'day', 'diary', 'diary_mirrors', 'media', 'intentions', 'work', 'work_events', 'decisions',
  'turn_reads', 'ledger_tasks', 'ledger_attempts', 'ledger_questions', 'ledger_approvals', 'ledger_results',
  'ledger_comments', 'ledger_events', 'ledger_outbox', 'operational',
];
