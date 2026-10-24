// The memory database's schema, version 1 (spec: the memory store, section 3). One entry per version in
// MIGRATIONS, appended and never edited (src/memory/db/open.js applies them in order).
//
// Beyond the spec's list, every table a round trip needs carries: `position` (the index an old array had, so the
// array comes back in order), `owner_file` (the JSON file a row was made from, so a re-map of that file finds its
// previous rows) and, where an old object had fields no column names, `extra JSON`. `sources` also carries `stems`
// because an external-content FTS5 table reads its columns from the table it indexes.
//
// There is no `now` table and no `states` table: the owner dropped both.

import { assignDiaryDestination, deriveAllMirrorPublications } from './publish.js';

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

// Version 7 (spec 2026-10-24-memory-schema-v7, stage 1; section 11 overrides the rest): identity namespaces, audiences,
// DM places, account links, execution contexts and the turn_reads rebuild. Additive: no JSON field moves, the triple
// stays the compatibility projection, every new column is filled from today's columns by statements SQLite runs in one
// pass each.
//  - `interfaces` (`discord`, `cli`, `core`, and any interface a row names), `authorities` (the native namespace of each
//    interface: `discord/global`, `cli/local`, `core/local`; `legacy/local` for the full legacy id spellings; one
//    `discord/guild:<id>` per guild place), `connections` (empty until an adapter logs in), `external_keys` (every
//    person, account and place under its native authority and, for the legacy spelling, under `legacy/local`; her own
//    `person:self` under `core/local` as `self`);
//  - `people.status`, her `people` row (`person:self`, kind `self`); accounts and places get their authority, native
//    key and generation (a reused native key is a new generation, never the same node), accounts a `kind`, places a
//    `conversation` (`dm` | `group` | NULL for a container) and their DM partner; sources their authority, author kind
//    (`self` for her own kinds), `observed_at` (= `recorded_at`, a legacy approximation) and connection;
//  - `audiences` and `audience_id` on every table with the scope triple: `aud:none`, `aud:internal`, `aud:group:<iface>`,
//    `aud:dm:<DM place id>`; the DM place of every DM partner a row names is created (`<iface>:dm:<native>`); a
//    malformed triple gets `aud:internal` and one `decisions` row `migration:scope_quarantined` per table and triple;
//  - `account_person_links`: one row per account with a person, `verified` where `accounts.link` is `verified`, else
//    `proposed`; `execution_contexts`: the contexts the core issues;
//  - `turn_reads` is rebuilt with `context_id` (a read without one stores '') in its primary key and `reader_kind`;
//  - the `sources` update trigger now fires on `text` and `stems` only (the only columns the FTS tables hold), so a
//    one-pass update of another column does not re-index the whole table.
// The SQL here and src/memory/db/scope.js#audienceOf are the same rule; tests/memory-db-v7.test.js checks they agree.

/** Every table that carries the scope triple (and from v7 its `audience_id`). */
export const SCOPED_TABLES = [
  'sources', 'vectors', 'claims', 'descriptions', 'episodes', 'affinity_events', 'day', 'diary', 'media', 'intentions', 'work', 'session_runs',
];
/** Her own source kinds (`author_kind = 'self'`). */
export const SELF_SOURCE_KINDS = ['said', 'answer', 'felt', 'memory_session', 'description_review'];

// The rows the migration writes are stamped with the time the legacy data is as of: the last sync before the
// migration (an empty database has none: the epoch). Deterministic, so two databases migrated from the same rows agree.
const NOW_SQL = "COALESCE((SELECT value FROM meta WHERE key = 'last_sync_at'), '1970-01-01T00:00:00.000Z')";
/** The native authority of an interface column (src/memory/db/ids.js#nativeAuthorityOf). */
const AUTHORITY_SQL = (col) => `(CASE WHEN ${col} IS NULL OR ${col} = '' THEN 'core/local' WHEN ${col} IN ('cli', 'core') THEN ${col} || '/local' ELSE ${col} || '/global' END)`;
const DM_PREFIX = "('person:' || scope_iface || ':')";
const DM_OK = `(scope_iface IS NOT NULL AND scope_iface <> '' AND scope_dm IS NOT NULL AND substr(scope_dm, 1, length(${DM_PREFIX})) = ${DM_PREFIX} AND length(scope_dm) > length(${DM_PREFIX}))`;
/** The audience of a triple (src/memory/db/scope.js#audienceOf). */
const AUDIENCE_SQL = `(CASE
  WHEN scope_kind = 'none' THEN 'aud:none'
  WHEN scope_kind = 'group' AND scope_iface IS NOT NULL AND scope_iface <> '' THEN 'aud:group:' || scope_iface
  WHEN scope_kind = 'dm' AND ${DM_OK} THEN 'aud:dm:' || scope_iface || ':dm:' || substr(scope_dm, length(${DM_PREFIX}) + 1)
  ELSE 'aud:internal' END)`;
const MALFORMED_SQL = `(${AUDIENCE_SQL} = 'aud:internal' AND scope_kind IS NOT 'internal')`;
const SELF_KINDS_SQL = SELF_SOURCE_KINDS.map((kind) => `'${kind}'`).join(', ');
const PLACE_KEY_SQL = `(CASE
  WHEN kind = 'dm' THEN (CASE WHEN native_id IS NOT NULL THEN 'dm:' || native_id
    WHEN iface IS NOT NULL AND substr(id, 1, length(iface || ':dm:')) = iface || ':dm:' AND length(id) > length(iface || ':dm:') THEN 'dm:' || substr(id, length(iface || ':dm:') + 1)
    ELSE NULL END)
  WHEN native_id IS NULL THEN NULL
  ELSE COALESCE(NULLIF(kind, ''), 'place') || ':' || native_id END)`;
const CONVERSATION_SQL = "(CASE WHEN kind = 'dm' OR scope_kind = 'dm' THEN 'dm' WHEN kind IN ('guild', 'server', 'workspace', 'category') THEN NULL ELSE 'group' END)";
const ACCOUNT_KEY_SQL = "COALESCE(native_id, CASE WHEN iface IS NOT NULL AND substr(id, 1, length(iface) + 1) = iface || ':' AND length(id) > length(iface) + 1 THEN substr(id, length(iface) + 2) END)";

const V7 = [
  `CREATE TABLE interfaces (id TEXT PRIMARY KEY, name TEXT, contract INTEGER NOT NULL DEFAULT 1, extra JSON);`,
  `CREATE TABLE authorities (
    id TEXT PRIMARY KEY, iface TEXT NOT NULL REFERENCES interfaces(id), namespace TEXT NOT NULL, name TEXT, extra JSON, UNIQUE (iface, namespace)
  );`,
  `CREATE TABLE connections (
    id TEXT PRIMARY KEY, iface TEXT NOT NULL REFERENCES interfaces(id), authority_id TEXT REFERENCES authorities(id),
    self_account TEXT, capabilities JSON, status TEXT, extra JSON
  );`,
  `CREATE TABLE external_keys (
    authority_id TEXT NOT NULL REFERENCES authorities(id),
    object_kind TEXT NOT NULL CHECK (object_kind IN ('person', 'account', 'place', 'source', 'participant')),
    native_key TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1, node_id TEXT NOT NULL,
    valid_from_at TEXT, valid_to_at TEXT, recorded_at TEXT NOT NULL,
    PRIMARY KEY (authority_id, object_kind, native_key, generation)
  );`,
  'CREATE INDEX external_keys_node ON external_keys(node_id);',
  `CREATE TABLE audiences (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('none', 'internal', 'group', 'dm')),
    iface TEXT REFERENCES interfaces(id), place_id TEXT REFERENCES places(id),
    CHECK ((kind IN ('none', 'internal') AND iface IS NULL AND place_id IS NULL)
        OR (kind = 'group' AND iface IS NOT NULL AND place_id IS NULL)
        OR (kind = 'dm' AND iface IS NOT NULL AND place_id IS NOT NULL)),
    CHECK (id = CASE kind WHEN 'none' THEN 'aud:none' WHEN 'internal' THEN 'aud:internal' WHEN 'group' THEN 'aud:group:' || iface ELSE 'aud:dm:' || place_id END)
  );`,
  "CREATE UNIQUE INDEX audiences_single ON audiences(kind) WHERE kind IN ('none', 'internal');",
  "CREATE UNIQUE INDEX audiences_group ON audiences(iface) WHERE kind = 'group';",
  "CREATE UNIQUE INDEX audiences_dm ON audiences(place_id) WHERE kind = 'dm';",
  `CREATE TABLE account_person_links (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), person_id TEXT NOT NULL REFERENCES people(id),
    state TEXT NOT NULL CHECK (state IN ('proposed', 'verified', 'revoked')),
    by TEXT, reason TEXT, evidence_id TEXT, valid_from_at TEXT, valid_to_at TEXT, recorded_at TEXT NOT NULL
  );`,
  'CREATE INDEX account_person_links_account ON account_person_links(account_id, valid_to_at);',
  'CREATE INDEX account_person_links_person ON account_person_links(person_id);',
  `CREATE TABLE execution_contexts (
    id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK (mode IN ('outward', 'internal')), iface TEXT REFERENCES interfaces(id),
    destination_place_id TEXT, partner_person_id TEXT, policy_version INTEGER NOT NULL DEFAULT 1, issued_at TEXT NOT NULL
  );`,

  // Columns.
  "ALTER TABLE people ADD COLUMN status TEXT DEFAULT 'active';",
  'ALTER TABLE accounts ADD COLUMN authority_id TEXT REFERENCES authorities(id);',
  'ALTER TABLE accounts ADD COLUMN native_key TEXT;',
  'ALTER TABLE accounts ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;',
  "ALTER TABLE accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'bot', 'shared', 'self'));",
  'ALTER TABLE accounts ADD COLUMN gone_at TEXT;',
  'ALTER TABLE places ADD COLUMN authority_id TEXT REFERENCES authorities(id);',
  'ALTER TABLE places ADD COLUMN native_key TEXT;',
  'ALTER TABLE places ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;',
  "ALTER TABLE places ADD COLUMN conversation TEXT CHECK (conversation IN ('dm', 'group'));",
  'ALTER TABLE places ADD COLUMN partner_person TEXT;',
  'ALTER TABLE places ADD COLUMN partner_account TEXT;',
  'ALTER TABLE places ADD COLUMN gone_at TEXT;',
  'ALTER TABLE places ADD COLUMN seen_from_at TEXT;',
  'ALTER TABLE places ADD COLUMN seen_to_at TEXT;',
  'ALTER TABLE sources ADD COLUMN authority_id TEXT;',
  "ALTER TABLE sources ADD COLUMN author_kind TEXT CHECK (author_kind IN ('account', 'participant', 'self'));",
  'ALTER TABLE sources ADD COLUMN observed_at TEXT;',
  'ALTER TABLE sources ADD COLUMN connection_id TEXT;',
  ...SCOPED_TABLES.map((table) => `ALTER TABLE ${table} ADD COLUMN audience_id TEXT REFERENCES audiences(id);`),
  'CREATE UNIQUE INDEX accounts_native ON accounts(authority_id, native_key, generation) WHERE authority_id IS NOT NULL;',
  'CREATE UNIQUE INDEX places_native ON places(authority_id, native_key, generation) WHERE authority_id IS NOT NULL;',

  // Interfaces and authorities.
  "INSERT INTO interfaces (id) VALUES ('discord'), ('cli'), ('core');",
  `INSERT OR IGNORE INTO interfaces (id) SELECT DISTINCT v FROM (
    ${[...SCOPED_TABLES.map((table) => `SELECT scope_iface AS v FROM ${table}`), 'SELECT iface FROM places', 'SELECT iface FROM accounts', 'SELECT iface FROM sources'].join(' UNION ')}
  ) WHERE v IS NOT NULL AND v <> '';`,
  "INSERT INTO authorities (id, iface, namespace) SELECT id || CASE WHEN id IN ('cli', 'core') THEN '/local' ELSE '/global' END, id, CASE WHEN id IN ('cli', 'core') THEN 'local' ELSE 'global' END FROM interfaces;",
  "INSERT INTO authorities (id, iface, namespace, name) VALUES ('legacy/local', 'core', 'legacy', 'legacy ids');",
  "INSERT OR IGNORE INTO authorities (id, iface, namespace) SELECT DISTINCT iface || '/guild:' || native_id, iface, 'guild:' || native_id FROM places WHERE kind = 'guild' AND native_id IS NOT NULL AND iface IS NOT NULL AND iface <> '';",

  // Her own person row.
  "INSERT OR IGNORE INTO people (id, kind, status) VALUES ('person:self', 'self', 'active');",

  // Accounts and places: authority, native key, conversation.
  `UPDATE accounts SET authority_id = ${AUTHORITY_SQL('iface')}, native_key = ${ACCOUNT_KEY_SQL};`,
  `UPDATE places SET authority_id = ${AUTHORITY_SQL('iface')}, native_key = ${PLACE_KEY_SQL}, conversation = ${CONVERSATION_SQL};`,

  // The scope triples in use, the DM places they name, the audiences.
  `CREATE TEMP TABLE _v7_scopes AS ${SCOPED_TABLES.map((table) => `SELECT '${table}' AS tbl, scope_kind, scope_iface, scope_dm, COUNT(*) AS n FROM ${table} GROUP BY scope_kind, scope_iface, scope_dm`).join(' UNION ALL ')};`,
  `INSERT OR IGNORE INTO places (id, iface, kind, native_id, parent_id, scope_kind, authority_id, native_key, generation, conversation, partner_person, partner_account)
    SELECT DISTINCT scope_iface || ':dm:' || substr(scope_dm, length(${DM_PREFIX}) + 1), scope_iface, 'dm', NULL, NULL, 'dm', ${AUTHORITY_SQL('scope_iface')},
      'dm:' || substr(scope_dm, length(${DM_PREFIX}) + 1), 1, 'dm', scope_dm, scope_iface || ':' || substr(scope_dm, length(${DM_PREFIX}) + 1)
    FROM _v7_scopes WHERE scope_kind = 'dm' AND ${DM_OK};`,
  "INSERT INTO audiences (id, kind) VALUES ('aud:none', 'none'), ('aud:internal', 'internal');",
  "INSERT OR IGNORE INTO audiences (id, kind, iface) SELECT DISTINCT 'aud:group:' || scope_iface, 'group', scope_iface FROM _v7_scopes WHERE scope_kind = 'group' AND scope_iface IS NOT NULL AND scope_iface <> '';",
  `INSERT OR IGNORE INTO audiences (id, kind, iface, place_id) SELECT DISTINCT ${AUDIENCE_SQL}, 'dm', scope_iface, scope_iface || ':dm:' || substr(scope_dm, length(${DM_PREFIX}) + 1)
    FROM _v7_scopes WHERE scope_kind = 'dm' AND ${DM_OK};`,
  `INSERT OR IGNORE INTO decisions (id, at, by, target_kind, target_id, action, reason, extra, owner_file, position, retired_at)
    SELECT 'migration:v7:scope_quarantined:' || tbl || ':' || COALESCE(scope_kind, '') || ':' || COALESCE(scope_iface, '') || ':' || COALESCE(scope_dm, ''),
      ${NOW_SQL}, 'migration', 'table', tbl, 'migration:scope_quarantined', 'malformed scope triple',
      json_object('scope_kind', scope_kind, 'scope_iface', scope_iface, 'scope_dm', scope_dm, 'rows', n), NULL, NULL, NULL
    FROM _v7_scopes WHERE ${MALFORMED_SQL};`,

  // audience_id everywhere; sources in one pass with the trigger narrowed first.
  'DROP TRIGGER sources_au;',
  `CREATE TRIGGER sources_au AFTER UPDATE OF text, stems ON sources BEGIN
  INSERT INTO sources_fts(sources_fts, rowid, text, stems) VALUES ('delete', old.rowid, old.text, old.stems);
  INSERT INTO sources_tri(sources_tri, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO sources_fts(rowid, text, stems) VALUES (new.rowid, new.text, new.stems);
  INSERT INTO sources_tri(rowid, text) VALUES (new.rowid, new.text);
END;`,
  `UPDATE sources SET audience_id = ${AUDIENCE_SQL}, authority_id = ${AUTHORITY_SQL('iface')},
    author_kind = CASE WHEN kind IN (${SELF_KINDS_SQL}) THEN 'self' WHEN author_account IS NOT NULL THEN 'account' ELSE NULL END,
    observed_at = recorded_at;`,
  ...SCOPED_TABLES.filter((table) => table !== 'sources').map((table) => `UPDATE ${table} SET audience_id = ${AUDIENCE_SQL};`),

  // External keys and links.
  `INSERT OR IGNORE INTO external_keys (authority_id, object_kind, native_key, generation, node_id, recorded_at)
    SELECT ${AUTHORITY_SQL('i.id')}, 'person', substr(p.id, length('person:' || i.id || ':') + 1), 1, p.id, ${NOW_SQL}
    FROM people p JOIN interfaces i ON substr(p.id, 1, length('person:' || i.id || ':')) = 'person:' || i.id || ':' AND length(p.id) > length('person:' || i.id || ':');`,
  `INSERT OR IGNORE INTO external_keys (authority_id, object_kind, native_key, generation, node_id, recorded_at) VALUES ('core/local', 'person', 'self', 1, 'person:self', ${NOW_SQL});`,
  `INSERT OR IGNORE INTO external_keys (authority_id, object_kind, native_key, generation, node_id, recorded_at)
    SELECT authority_id, 'account', native_key, generation, id, ${NOW_SQL} FROM accounts WHERE authority_id IS NOT NULL AND native_key IS NOT NULL;`,
  `INSERT OR IGNORE INTO external_keys (authority_id, object_kind, native_key, generation, node_id, recorded_at)
    SELECT authority_id, 'place', native_key, generation, id, ${NOW_SQL} FROM places WHERE authority_id IS NOT NULL AND native_key IS NOT NULL;`,
  `INSERT OR IGNORE INTO external_keys (authority_id, object_kind, native_key, generation, node_id, recorded_at)
    SELECT 'legacy/local', 'person', id, 1, id, ${NOW_SQL} FROM people WHERE id <> 'person:self'
    UNION ALL SELECT 'legacy/local', 'account', id, 1, id, ${NOW_SQL} FROM accounts
    UNION ALL SELECT 'legacy/local', 'place', id, 1, id, ${NOW_SQL} FROM places;`,
  `INSERT OR IGNORE INTO account_person_links (id, account_id, person_id, state, by, reason, evidence_id, valid_from_at, valid_to_at, recorded_at)
    SELECT 'link:' || a.id || ':' || a.person_id, a.id, a.person_id, CASE WHEN a.link = 'verified' THEN 'verified' ELSE 'proposed' END, 'migration', NULL, NULL,
      a.linked_at, a.retired_at, ${NOW_SQL}
    FROM accounts a WHERE a.person_id IS NOT NULL AND EXISTS (SELECT 1 FROM people p WHERE p.id = a.person_id);`,

  // turn_reads with the context in its key.
  `CREATE TABLE turn_reads_v7 (
    turn_id TEXT, step TEXT, context_id TEXT NOT NULL DEFAULT '', row_kind TEXT, row_id TEXT, block TEXT, ord INTEGER, version_id TEXT, revision INTEGER,
    reader_kind TEXT NOT NULL DEFAULT 'turn' CHECK (reader_kind IN ('turn', 'session', 'wake')),
    PRIMARY KEY (turn_id, step, context_id, row_kind, row_id)
  );`,
  `INSERT INTO turn_reads_v7 (turn_id, step, context_id, row_kind, row_id, block, ord, version_id, revision, reader_kind)
    SELECT turn_id, step, '', row_kind, row_id, block, ord, version_id, revision, 'turn' FROM turn_reads;`,
  'DROP TABLE turn_reads;',
  'ALTER TABLE turn_reads_v7 RENAME TO turn_reads;',
  'DROP TABLE temp._v7_scopes;',
].join('\n');

// Version 8 (spec 2026-10-24-memory-schema-v7, stage 2; section 11 items 1, 3, 8 and the smaller resolutions):
// participants, foreign capture and source relations. Additive, as v7: no JSON field moves.
//  - `participants`: a poster known only inside a place or a site (`token_kind`: a per-thread token, a site-scoped
//    token, a bare post number, a display name, nothing). The canonical tuple is (authority, scope place, token kind,
//    token or observation key, generation), stored whole under one unique index; a thread token needs its thread, a
//    display name or no token is keyed by the observation it came with (one participant per post). Never a person;
//    `participant_links` names exactly one target (an account or a person), `people_merges` records merges (the writer
//    refuses a cycle; a chain resolves to its final survivor, ids.js#survivorOf);
//  - `sources.author_participant` (the author combination is checked by the one writer path, rows.js#checkAuthor:
//    SQLite cannot add a CHECK to an existing table), `sources.native_kind` and `sources.generation` (with
//    `authority_id`, `native_id` and `revision`: the native tuple a relation's target is matched on). Discord lines get
//    `native_kind = 'message'`;
//  - capture: `capture_bundles` (the current coverage on the row), `capture_members` (a source may hold several roles),
//    `capture_events` (append-only: the coverage after each step) and `capture_watches`. Members and events are never
//    updated or deleted (triggers refuse it);
//  - `source_relations`: one row per (source, predicate, target_key); `target_key` is `source:<id>` or the external
//    tuple JSON (ids.js#externalTargetKey) and never changes; `target_source_id` and `resolved_at` are filled when the
//    target is or becomes a stored source. Backfilled from every Discord line's `reply_to`, resolved where the replied
//    message is stored (its first revision).

/** The token kinds of a participant. */
export const PARTICIPANT_TOKEN_KINDS = ['thread_token', 'site_token', 'post_number', 'display_name', 'none'];
/** How far a participant's token is known to stay one poster. */
export const CONTINUITIES = ['provider_asserted', 'verified', 'unknown'];
/** The predicates of `source_relations`. */
export const RELATION_PREDICATES = ['replies_to', 'quotes', 'reposts', 'mentions', 'edits', 'references'];
/** Why a capture bundle was opened. */
export const CAPTURE_REASONS = ['own_line', 'mention', 'reply_to_me', 'expansion', 'watch'];
/** The roles a source holds in a bundle. */
export const CAPTURE_ROLES = ['anchor', 'ancestor', 'before', 'after', 'reply', 'mention', 'same_author', 'watch'];
/** The states of a bundle's coverage. */
export const COVERAGE_STATES = ['complete', 'pending_expansion', 'provider_unavailable', 'incomplete'];
/** The kinds of a capture event. */
export const CAPTURE_EVENT_KINDS = ['initial', 'expansion', 'watch'];
/** How a watch ended. */
export const WATCH_OUTCOMES = ['fetched', 'nothing_new', 'unavailable'];

const IN = (values) => values.map((value) => `'${value}'`).join(', ');
const COVERAGE_CHECK = (col) => `CHECK (json_valid(${col}) AND json_type(${col}) = 'object' AND json_extract(${col}, '$.state') IN (${IN(COVERAGE_STATES)}))`;
const APPEND_ONLY = (table, what) => [
  `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${what}'); END;`,
  `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${what}'); END;`,
];
/** The first stored revision of the message a Discord line replies to (`s` the replying line). */
const REPLY_TARGET_SQL = `(SELECT t.id FROM sources t WHERE t.authority_id = s.authority_id AND t.native_kind = 'message' AND t.native_id = s.reply_to
  AND t.generation = 1 AND t.kind IN ('seen', 'said') AND t.retired_at IS NULL ORDER BY t.revision, t.rowid LIMIT 1)`;

const V8 = [
  `CREATE TABLE participants (
    id TEXT PRIMARY KEY, authority_id TEXT NOT NULL REFERENCES authorities(id), scope_place_id TEXT REFERENCES places(id),
    token_kind TEXT NOT NULL CHECK (token_kind IN (${IN(PARTICIPANT_TOKEN_KINDS)})), native_token TEXT, observation_key TEXT,
    generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
    continuity TEXT NOT NULL CHECK (continuity IN (${IN(CONTINUITIES)})),
    display TEXT, first_seen_at TEXT, last_seen_at TEXT, extra JSON, recorded_at TEXT NOT NULL,
    CHECK (CASE
      WHEN token_kind = 'thread_token' THEN scope_place_id IS NOT NULL AND native_token IS NOT NULL AND native_token <> '' AND observation_key IS NULL
      WHEN token_kind = 'site_token' THEN scope_place_id IS NULL AND native_token IS NOT NULL AND native_token <> '' AND observation_key IS NULL
      WHEN token_kind = 'post_number' THEN native_token IS NOT NULL AND native_token <> '' AND observation_key IS NULL
      ELSE native_token IS NULL AND observation_key IS NOT NULL AND observation_key <> '' END)
  );`,
  "CREATE UNIQUE INDEX participants_tuple ON participants(authority_id, COALESCE(scope_place_id, ''), token_kind, COALESCE(native_token, observation_key), generation);",
  `CREATE TABLE participant_links (
    id TEXT PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES participants(id),
    account_id TEXT REFERENCES accounts(id), person_id TEXT REFERENCES people(id),
    state TEXT NOT NULL CHECK (state IN ('proposed', 'verified', 'revoked')),
    by TEXT, reason TEXT, evidence_id TEXT, valid_from_at TEXT, valid_to_at TEXT, recorded_at TEXT NOT NULL,
    CHECK ((account_id IS NULL) <> (person_id IS NULL))
  );`,
  'CREATE INDEX participant_links_participant ON participant_links(participant_id, valid_to_at);',
  'CREATE INDEX participant_links_account ON participant_links(account_id);',
  'CREATE INDEX participant_links_person ON participant_links(person_id);',
  `CREATE TABLE people_merges (
    id TEXT PRIMARY KEY, from_person TEXT NOT NULL REFERENCES people(id), into_person TEXT NOT NULL REFERENCES people(id),
    at TEXT NOT NULL, by TEXT NOT NULL, reason TEXT, evidence JSON, CHECK (from_person <> into_person)
  );`,
  'CREATE UNIQUE INDEX people_merges_from ON people_merges(from_person);',
  'CREATE INDEX people_merges_into ON people_merges(into_person);',

  'ALTER TABLE sources ADD COLUMN author_participant TEXT REFERENCES participants(id);',
  'ALTER TABLE sources ADD COLUMN native_kind TEXT;',
  'ALTER TABLE sources ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;',
  "UPDATE sources SET native_kind = 'message' WHERE iface = 'discord' AND native_id IS NOT NULL;",
  'CREATE INDEX sources_native_tuple ON sources(authority_id, native_kind, native_id, generation, revision);',
  'CREATE INDEX sources_author_participant ON sources(author_participant) WHERE author_participant IS NOT NULL;',

  `CREATE TABLE capture_bundles (
    id TEXT PRIMARY KEY, anchor_source_id TEXT NOT NULL REFERENCES sources(id), place_id TEXT NOT NULL REFERENCES places(id),
    reason TEXT NOT NULL CHECK (reason IN (${IN(CAPTURE_REASONS)})), policy_version INTEGER NOT NULL,
    coverage JSON NOT NULL ${COVERAGE_CHECK('coverage')}, created_at TEXT NOT NULL, connection_id TEXT
  );`,
  'CREATE INDEX capture_bundles_anchor ON capture_bundles(anchor_source_id);',
  `CREATE TABLE capture_members (
    bundle_id TEXT NOT NULL REFERENCES capture_bundles(id), source_id TEXT NOT NULL REFERENCES sources(id),
    role TEXT NOT NULL CHECK (role IN (${IN(CAPTURE_ROLES)})), added_at TEXT NOT NULL,
    PRIMARY KEY (bundle_id, source_id, role)
  );`,
  'CREATE INDEX capture_members_source ON capture_members(source_id);',
  `CREATE TABLE capture_events (
    id INTEGER PRIMARY KEY, bundle_id TEXT NOT NULL REFERENCES capture_bundles(id), at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN (${IN(CAPTURE_EVENT_KINDS)})), coverage JSON NOT NULL ${COVERAGE_CHECK('coverage')},
    added INTEGER NOT NULL DEFAULT 0
  );`,
  'CREATE INDEX capture_events_bundle ON capture_events(bundle_id, id);',
  ...APPEND_ONLY('capture_events', 'capture events are append-only'),
  ...APPEND_ONLY('capture_members', 'capture members are never removed'),
  `CREATE TABLE capture_watches (
    id TEXT PRIMARY KEY, bundle_id TEXT NOT NULL REFERENCES capture_bundles(id), due_at TEXT NOT NULL, done_at TEXT,
    outcome TEXT CHECK (outcome IS NULL OR outcome IN (${IN(WATCH_OUTCOMES)})), extra JSON,
    CHECK ((done_at IS NULL) = (outcome IS NULL))
  );`,
  'CREATE INDEX capture_watches_due ON capture_watches(done_at, due_at);',

  `CREATE TABLE source_relations (
    id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
    predicate TEXT NOT NULL CHECK (predicate IN (${IN(RELATION_PREDICATES)})), target_key TEXT NOT NULL,
    target_source_id TEXT REFERENCES sources(id), recorded_at TEXT NOT NULL, resolved_at TEXT,
    CHECK ((target_source_id IS NULL) = (resolved_at IS NULL))
  );`,
  'CREATE UNIQUE INDEX source_relations_key ON source_relations(source_id, predicate, target_key);',
  'CREATE INDEX source_relations_pending ON source_relations(target_key) WHERE target_source_id IS NULL;',
  'CREATE INDEX source_relations_target ON source_relations(target_source_id) WHERE target_source_id IS NOT NULL;',
  `CREATE TRIGGER source_relations_key_fixed BEFORE UPDATE OF source_id, predicate, target_key ON source_relations
    BEGIN SELECT RAISE(ABORT, 'a relation keeps its source, predicate and target key'); END;`,
  ...APPEND_ONLY('source_relations', 'relations are never deleted').slice(1),
  `INSERT OR IGNORE INTO source_relations (source_id, predicate, target_key, target_source_id, recorded_at, resolved_at)
    SELECT id, 'replies_to', json_array(authority_id, 'message', reply_to, 1, NULL), target, ${NOW_SQL}, CASE WHEN target IS NULL THEN NULL ELSE ${NOW_SQL} END
    FROM (SELECT s.id AS id, s.authority_id AS authority_id, s.reply_to AS reply_to, ${REPLY_TARGET_SQL} AS target FROM sources s
      WHERE s.iface = 'discord' AND s.id IS NOT NULL AND s.authority_id IS NOT NULL AND s.reply_to IS NOT NULL AND s.reply_to <> '')
    ORDER BY id;`,
].join('\n');

// Version 9 (spec 2026-10-24-memory-schema-v7, stage 3; section 11 items 5 and 6 and the smaller resolutions): the
// graph projection, version-level evidence, durable ids of the child links, the continuation of a place.
//  - `graph_nodes` (one per typed row of a node kind, `<kind>:<row id>`, the row id kept in `row_id`), `graph_edges`
//    (semantic `projection_key` `<predicate>:<src>:<dst>[:<evidence>]`, the unit that produced it in `owner_key`, the
//    audience it is read with) and `node_access` (one witness per node, audience and evidence). All three are derived:
//    the manifest (graph-manifest.js) maps the typed rows to them, graph.js writes them in the writers' transactions,
//    and `tools/memory-db.mjs rebuild` drops and rebuilds them. The migration writes the nodes of the rows every database
//    has from the earlier migrations (interfaces, authorities, people: nodes with no edge, the manifest's rule spelt in
//    SQL) and, when the database holds anything else, marks the whole projection pending (`meta.graph_pending`): the next
//    full sync pass (in the worker) or the last slice of the first import projects every unit, in slices
//    (graph.js#projectPending), so the migration itself stays one quick transaction;
//  - `claim_version_sources`: the sources of each claim version, `supports` or `conflicts`. Existing claim-level
//    links (`claim_sources`) are copied to their claim's newest live version with `legacy = 1` (claim-level provenance,
//    not invented history); a link whose source is not stored is left to `claim_sources` alone;
//  - `claim_sources`, `episode_sources` and `diary_mirrors` get a durable `id`, deterministic from their natural key
//    (a file's link: its parent and position; a link the database wrote: its parent and source; a mirror: its entry,
//    interface and place), a repeat of a key suffixed `#dup<rowid>`; a trigger gives every new row its id the same way;
//  - `places.continues_place_id`: the place a place continues (the typed home of the `continues` predicate; no writer
//    fills it yet);
//  - `claim_versions(claim_id)` is indexed (the newest version of a claim is read by every claim read and write).

/** Every table schema v9 adds. */
export const V9_TABLES = ['graph_nodes', 'graph_edges', 'node_access', 'claim_version_sources'];
/** The roles of a version's source. */
export const EVIDENCE_ROLES = ['supports', 'conflicts'];

const LINK_KEY = {
  claim_sources: (x) => `'cs:' || COALESCE(${x}.claim_id, '') || CASE WHEN ${x}.owner_file IS NULL THEN ':s:' || COALESCE(${x}.source_id, '') ELSE ':p:' || COALESCE(${x}.position, '') END`,
  episode_sources: (x) => `'es:' || COALESCE(${x}.episode_id, '') || CASE WHEN ${x}.owner_file IS NULL THEN ':s:' || COALESCE(${x}.source_id, '') ELSE ':p:' || COALESCE(${x}.position, '') END`,
  diary_mirrors: (x) => `'mirror:' || COALESCE(${x}.diary_id, '') || ':' || COALESCE(${x}.iface, '') || ':' || COALESCE(${x}.place_id, '')`,
};
const LINK_PARENT = { claim_sources: 'claim_id', episode_sources: 'episode_id', diary_mirrors: 'diary_id' };
const DURABLE_IDS = Object.keys(LINK_KEY).flatMap((table) => [
  `ALTER TABLE ${table} ADD COLUMN id TEXT;`,
  `UPDATE ${table} SET id = ${LINK_KEY[table](table)} || CASE WHEN EXISTS (SELECT 1 FROM ${table} o WHERE o.${LINK_PARENT[table]} IS ${table}.${LINK_PARENT[table]}
     AND o.rowid < ${table}.rowid AND ${LINK_KEY[table]('o')} = ${LINK_KEY[table](table)}) THEN '#dup' || ${table}.rowid ELSE '' END;`,
  `CREATE UNIQUE INDEX ${table}_id ON ${table}(id);`,
  `CREATE TRIGGER ${table}_id_fill AFTER INSERT ON ${table} WHEN new.id IS NULL BEGIN
    UPDATE ${table} SET id = ${LINK_KEY[table]('new')} || CASE WHEN EXISTS (SELECT 1 FROM ${table} o WHERE o.id = ${LINK_KEY[table]('new')}) THEN '#dup' || new.rowid ELSE '' END
    WHERE rowid = new.rowid;
  END;`,
]);
/** Tables whose rows the v9 migration leaves to the pending projection (anything beyond the node-only kinds). */
const PENDING_TABLES = ['accounts', 'participants', 'places', 'memberships', 'sources', 'claims', 'claim_versions', 'claim_sources', 'descriptions',
  'description_versions', 'episodes', 'episode_sources', 'diary', 'diary_mirrors', 'media', 'intentions', 'work', 'decisions'];
/** The newest live version of the claim `cs.claim_id` (the same order service.js#turnReadRows reads a claim's version in). */
const NEWEST_VERSION_SQL = `(SELECT v.id FROM claim_versions v WHERE v.claim_id = cs.claim_id AND v.retired_at IS NULL ORDER BY COALESCE(v.recorded_at, '') DESC, v.rowid DESC LIMIT 1)`;

const V9 = [
  'CREATE TABLE graph_nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, row_id TEXT NOT NULL, created_at TEXT NOT NULL);',
  'CREATE INDEX graph_nodes_row ON graph_nodes(kind, row_id);',
  `CREATE TABLE graph_edges (
    id TEXT PRIMARY KEY, src TEXT NOT NULL REFERENCES graph_nodes(id), predicate TEXT NOT NULL, dst TEXT NOT NULL REFERENCES graph_nodes(id),
    audience_id TEXT NOT NULL REFERENCES audiences(id), evidence_id TEXT, valid_from_at TEXT, valid_to_at TEXT, recorded_at TEXT NOT NULL,
    retired_at TEXT, projection_key TEXT NOT NULL UNIQUE, owner_key TEXT NOT NULL
  );`,
  'CREATE INDEX graph_edges_out ON graph_edges(src, predicate, dst);',
  'CREATE INDEX graph_edges_in ON graph_edges(dst, predicate, src);',
  'CREATE INDEX graph_edges_owner ON graph_edges(owner_key);',
  `CREATE TABLE node_access (
    node_id TEXT NOT NULL REFERENCES graph_nodes(id), audience_id TEXT NOT NULL REFERENCES audiences(id), evidence_id TEXT NOT NULL,
    PRIMARY KEY (node_id, audience_id, evidence_id)
  );`,
  'CREATE INDEX node_access_evidence ON node_access(evidence_id);',
  `CREATE TABLE claim_version_sources (
    version_id TEXT NOT NULL REFERENCES claim_versions(id), source_id TEXT NOT NULL REFERENCES sources(id),
    role TEXT NOT NULL CHECK (role IN (${IN(EVIDENCE_ROLES)})), legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1)),
    PRIMARY KEY (version_id, source_id)
  );`,
  'CREATE INDEX claim_version_sources_source ON claim_version_sources(source_id);',
  'CREATE INDEX claim_versions_claim ON claim_versions(claim_id);',
  'ALTER TABLE places ADD COLUMN continues_place_id TEXT REFERENCES places(id);',
  ...DURABLE_IDS,
  `INSERT OR IGNORE INTO claim_version_sources (version_id, source_id, role, legacy)
    SELECT version_id, source_id, 'supports', 1 FROM (
      SELECT ${NEWEST_VERSION_SQL} AS version_id, cs.source_id AS source_id FROM claim_sources cs
       WHERE cs.retired_at IS NULL AND cs.source_id IS NOT NULL AND EXISTS (SELECT 1 FROM sources s WHERE s.id = cs.source_id)
    ) WHERE version_id IS NOT NULL ORDER BY version_id, source_id;`,
  "INSERT OR IGNORE INTO graph_nodes (id, kind, row_id, created_at) SELECT 'interface:' || id, 'interface', id, '1970-01-01T00:00:00.000Z' FROM interfaces;",
  "INSERT OR IGNORE INTO graph_nodes (id, kind, row_id, created_at) SELECT 'authority:' || id, 'authority', id, '1970-01-01T00:00:00.000Z' FROM authorities;",
  "INSERT OR IGNORE INTO graph_nodes (id, kind, row_id, created_at) SELECT 'person:' || id, 'person', id, COALESCE(NULLIF(first_seen_at, ''), '1970-01-01T00:00:00.000Z') FROM people;",
  `INSERT OR REPLACE INTO meta (key, value) SELECT 'graph_pending', '{"unit":0,"after":null}' WHERE ${PENDING_TABLES.map((table) => `EXISTS (SELECT 1 FROM ${table})`).join(' OR ')};`,
].join('\n');

// Version 10 (spec 2026-10-24-memory-schema-v7, stages 4 and 5; section 11 item 4 and the smaller resolutions on focus):
// publications with grants, and the focus set.
//  - `publications`: one row per outward send of something of hers (a diary entry first): the exact rendered text and
//    its content hash (immutable once known: a trigger refuses a change), the destination place, the execution context,
//    the grant it went out under, its state (`queued` | `sent` | `failed` | `unknown`), a unique idempotency key and
//    the interface's receipts (`[{ authority, kind, key }]`). Never deleted. publish.js is its writer;
//  - `publication_grants`: the owner's exceptions, bound to one content hash of one row and a set of destination places;
//    immutable but for `revoked_at` (set once). Never deleted;
//  - every `diary_mirrors` row becomes a `sent` publication (the mirror's id, its entry's text and hash, the mirror's
//    place as the destination when that place exists, its message ids as receipts, the key `diary:<entry>:<place>`),
//    by the same function the sync uses for every later mirror write (publish.js#deriveMirrorPublication), and is
//    projected into the graph (`published_as`, `publication_source`; left to the pending projection when v9's is still
//    pending). That one step is JavaScript (SQLite has no
//    SHA-256), which is why this entry is a function of the connection;
//  - focus: `relationship_daily` (counts per person, UTC day and audience, recounted from `sources` by focus.js),
//    `focus_members` (the current close and exploring sets only, no snapshot), `focus_events` (append-only history:
//    every change of bucket, every challenge and its end, pins over capacity) and `focus_overrides` (the owner's pins
//    and exclusions). Filled by focus.js, never by a file: the sync never touches them.

/** Every table schema v10 adds. */
export const V10_TABLES = ['publications', 'publication_grants', 'relationship_daily', 'focus_members', 'focus_events', 'focus_overrides'];
/** The buckets of the focus set. */
export const FOCUS_BUCKETS = ['close', 'exploring'];

const V10_SQL = [
  `CREATE TABLE publication_grants (
    id TEXT PRIMARY KEY, row_kind TEXT NOT NULL, row_id TEXT NOT NULL, content_hash TEXT NOT NULL CHECK (content_hash <> ''),
    destinations JSON NOT NULL CHECK (json_valid(destinations) AND json_type(destinations) = 'array' AND json_array_length(destinations) > 0),
    approved_by TEXT NOT NULL CHECK (approved_by <> ''), approved_at TEXT NOT NULL, reason TEXT, revoked_at TEXT
  );`,
  'CREATE INDEX publication_grants_row ON publication_grants(row_kind, row_id, content_hash);',
  `CREATE TRIGGER publication_grants_fixed BEFORE UPDATE OF id, row_kind, row_id, content_hash, destinations, approved_by, approved_at, reason ON publication_grants
    BEGIN SELECT RAISE(ABORT, 'a grant is immutable; revoke it and grant again'); END;`,
  `CREATE TRIGGER publication_grants_revoked_once BEFORE UPDATE OF revoked_at ON publication_grants WHEN old.revoked_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'a revoked grant stays revoked'); END;`,
  ...APPEND_ONLY('publication_grants', 'grants are never deleted').slice(1),
  `CREATE TABLE publications (
    id TEXT PRIMARY KEY, row_kind TEXT NOT NULL, row_id TEXT NOT NULL, content_hash TEXT, rendered TEXT,
    destination_place_id TEXT REFERENCES places(id), context_id TEXT REFERENCES execution_contexts(id),
    grant_id TEXT REFERENCES publication_grants(id),
    status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'unknown')),
    idempotency_key TEXT NOT NULL UNIQUE, receipts JSON CHECK (receipts IS NULL OR (json_valid(receipts) AND json_type(receipts) = 'array')),
    created_at TEXT NOT NULL, sent_at TEXT, owner_file TEXT, retired_at TEXT,
    CHECK ((content_hash IS NULL) = (rendered IS NULL))
  );`,
  'CREATE INDEX publications_row ON publications(row_kind, row_id);',
  'CREATE INDEX publications_owner ON publications(owner_file);',
  "CREATE INDEX publications_unsettled ON publications(status) WHERE status IN ('queued', 'unknown');",
  `CREATE TRIGGER publications_content_fixed BEFORE UPDATE OF rendered, content_hash ON publications
    WHEN old.content_hash IS NOT NULL AND (new.content_hash IS NOT old.content_hash OR new.rendered IS NOT old.rendered)
    BEGIN SELECT RAISE(ABORT, 'a publication keeps its content; an edit is a new publication'); END;`,
  `CREATE TRIGGER publications_key_fixed BEFORE UPDATE OF id, row_kind, row_id, idempotency_key ON publications
    BEGIN SELECT RAISE(ABORT, 'a publication keeps its row and its key'); END;`,
  ...APPEND_ONLY('publications', 'publications are never deleted').slice(1),

  `CREATE TABLE relationship_daily (
    person_id TEXT NOT NULL REFERENCES people(id), day TEXT NOT NULL, audience_id TEXT NOT NULL REFERENCES audiences(id),
    addressed_by_them INTEGER NOT NULL DEFAULT 0, addressed_by_her INTEGER NOT NULL DEFAULT 0,
    meaningful INTEGER NOT NULL DEFAULT 0 CHECK (meaningful IN (0, 1)), last_contact_at TEXT,
    PRIMARY KEY (person_id, day, audience_id)
  );`,
  'CREATE INDEX relationship_daily_day ON relationship_daily(day);',
  `CREATE TABLE focus_members (
    person_id TEXT PRIMARY KEY REFERENCES people(id), bucket TEXT NOT NULL CHECK (bucket IN (${IN(['close', 'exploring'])})),
    since TEXT NOT NULL, score REAL, policy_version INTEGER NOT NULL, reason JSON
  );`,
  `CREATE TABLE focus_events (
    id TEXT PRIMARY KEY, person_id TEXT NOT NULL, at TEXT NOT NULL, old_bucket TEXT, new_bucket TEXT, reason TEXT NOT NULL,
    policy_version INTEGER NOT NULL, extra JSON
  );`,
  'CREATE INDEX focus_events_person ON focus_events(person_id, at);',
  'CREATE INDEX focus_events_at ON focus_events(at);',
  ...APPEND_ONLY('focus_events', 'focus events are append-only'),
  `CREATE TABLE focus_overrides (
    person_id TEXT PRIMARY KEY REFERENCES people(id), kind TEXT NOT NULL CHECK (kind IN ('pin', 'exclude')), expires_at TEXT,
    approved_by TEXT NOT NULL CHECK (approved_by <> ''), reason TEXT
  );`,
].join('\n');

/**
 * Schema v10: the tables, then every mirror's publication (one function for the migration and the sync), projected now
 * unless the whole projection is still pending from v9 (then the pending projection takes the publications with it).
 */
function V10(db) {
  db.exec(V10_SQL);
  const at = db.prepare(`SELECT ${NOW_SQL} AS at`).get().at;
  const pending = db.prepare("SELECT 1 AS ok FROM meta WHERE key = 'graph_pending'").get() !== undefined;
  deriveAllMirrorPublications(db, { at, project: !pending });
}

// Version 11 (spec 2026-10-24-memory-schema-v7, stages 6 and 7; section 11 on wakes, skills, vectors, media, backups):
// wake runs and their actions, the skills registry, the index policy and the storage marks. Additive and dark: every
// new table starts empty, every new column NULL (`media.availability` `unknown`); nothing a turn reads changes.
//  - `wake_runs`: one row per inner wake run (wakes.js is its writer), with its state (`queued` | `running` |
//    `succeeded` | `failed` | `interrupted`), the inputs its view showed (ids with versions), the envelope's policy
//    version and the outcome. `wake_actions`: one row per action of a run, keyed by `wake:<run>:<n>` (unique, checked
//    against the run and the number): a restarted run that records the same action finds the first row;
//  - `skills`, `skill_versions`, `skill_evaluations`: the registry of the engine's skills (skills.js). A version is
//    bound to its content hash, its manifest hash and the engine commit; an evaluation carries the same three, so a
//    passing evaluation of one version never counts for another. Evaluations are append-only;
//  - `index_policy`: one row per graph node of a source (`source:<id>`), its tier (`a` | `b` | `c`), the reason, a pin,
//    when it was evaluated and, for a touch, when the touch expires (index-policy.js). Derived: no foreign key into the
//    graph, which may be pending;
//  - `sources.tier` (the same tier on the row), `vectors.evicted_at` (an evicted vector keeps its row, `model`,
//    `dims`, `norm` and `context`; only `bytes` is dropped), `media.availability` (`present` | `missing` | `unknown`).
// Spelt out in one place so the tests and docs/memory-access.md can list them.

/** Every table schema v11 adds. */
export const V11_TABLES = ['wake_runs', 'wake_actions', 'skills', 'skill_versions', 'skill_evaluations', 'index_policy'];
/** The states of a wake run. */
export const WAKE_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'interrupted'];
/** The lifecycle of a registered skill, the status of a skill version and the kinds of an evaluation. */
export const SKILL_LIFECYCLES = ['active', 'stale', 'archived'];
export const SKILL_VERSION_STATUSES = ['candidate', 'active', 'retired'];
export const SKILL_EVALUATION_KINDS = ['tests', 'trial', 'outcome', 'audience_check'];
/** The tiers of the index policy and the availability of a media row. */
export const INDEX_TIERS = ['a', 'b', 'c'];
export const MEDIA_AVAILABILITY = ['present', 'missing', 'unknown'];

const JSON_OR_NULL = (col) => `CHECK (${col} IS NULL OR json_valid(${col}))`;

const V11 = [
  `CREATE TABLE wake_runs (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, trigger TEXT, scheduled_at TEXT, started_at TEXT, finished_at TEXT,
    status TEXT NOT NULL CHECK (status IN (${IN(WAKE_RUN_STATUSES)})), context_id TEXT REFERENCES execution_contexts(id),
    inputs JSON ${JSON_OR_NULL('inputs')}, policy_version INTEGER, outcome TEXT, extra JSON ${JSON_OR_NULL('extra')}
  );`,
  'CREATE INDEX wake_runs_status ON wake_runs(status, started_at);',
  `CREATE TABLE wake_actions (
    run_id TEXT NOT NULL REFERENCES wake_runs(id), n INTEGER NOT NULL CHECK (n >= 1),
    idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key = 'wake:' || run_id || ':' || n),
    kind TEXT NOT NULL, target TEXT, status TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (run_id, n)
  );`,
  `CREATE TABLE skills (
    id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, active_version TEXT REFERENCES skill_versions(id),
    lifecycle TEXT NOT NULL CHECK (lifecycle IN (${IN(SKILL_LIFECYCLES)})), origin_work_id TEXT,
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)), extra JSON ${JSON_OR_NULL('extra')}
  );`,
  `CREATE TABLE skill_versions (
    id TEXT PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES skills(id), version TEXT NOT NULL,
    content_hash TEXT NOT NULL CHECK (content_hash <> ''), manifest_hash TEXT NOT NULL CHECK (manifest_hash <> ''),
    commit_sha TEXT NOT NULL CHECK (commit_sha <> ''), origin_work_id TEXT,
    status TEXT NOT NULL CHECK (status IN (${IN(SKILL_VERSION_STATUSES)})), created_at TEXT NOT NULL,
    manifest JSON NOT NULL CHECK (json_valid(manifest) AND json_type(manifest) = 'object'),
    UNIQUE (skill_id, content_hash, manifest_hash, commit_sha)
  );`,
  'CREATE INDEX skill_versions_skill ON skill_versions(skill_id, created_at);',
  `CREATE TRIGGER skill_versions_fixed BEFORE UPDATE OF id, skill_id, version, content_hash, manifest_hash, commit_sha, manifest, created_at ON skill_versions
    BEGIN SELECT RAISE(ABORT, 'a skill version keeps its hashes; a change is a new version'); END;`,
  `CREATE TABLE skill_evaluations (
    id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES skill_versions(id),
    kind TEXT NOT NULL CHECK (kind IN (${IN(SKILL_EVALUATION_KINDS)})), passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
    result JSON ${JSON_OR_NULL('result')}, evidence_id TEXT, at TEXT NOT NULL,
    content_hash TEXT NOT NULL, manifest_hash TEXT NOT NULL, commit_sha TEXT NOT NULL
  );`,
  'CREATE INDEX skill_evaluations_version ON skill_evaluations(version_id, kind);',
  ...APPEND_ONLY('skill_evaluations', 'evaluations are append-only'),
  `CREATE TABLE index_policy (
    node_id TEXT PRIMARY KEY, tier TEXT NOT NULL CHECK (tier IN (${IN(INDEX_TIERS)})), reason TEXT,
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)), evaluated_at TEXT NOT NULL, expires_at TEXT
  );`,
  "CREATE INDEX index_policy_touch ON index_policy(expires_at) WHERE reason = 'touch';",
  `ALTER TABLE sources ADD COLUMN tier TEXT CHECK (tier IS NULL OR tier IN (${IN(INDEX_TIERS)}));`,
  'ALTER TABLE vectors ADD COLUMN evicted_at TEXT;',
  `ALTER TABLE media ADD COLUMN availability TEXT NOT NULL DEFAULT 'unknown' CHECK (availability IN (${IN(MEDIA_AVAILABILITY)}));`,
].join('\n');

// Version 12 (spec 2026-10-24-memory-authority, stage W2a): a data step, no table. The diary's legacy mirrors name no
// place, so their `publications` rows have no destination; the deployment's diary channel (`diary.channelId` of the
// live config, which only the opener knows: open.js passes it as `context.diaryPlaceId`) becomes it, where that place is
// stored (publish.js#assignDiaryDestination). Opened without the channel (a tool), the step leaves the meta key
// `diary_destination_pending` (when there is a publication to give it to), and the next open that knows the channel
// does it (open.js#migrate). A mirror the sync brings later gets it from the diary's own write under authority `db`.

/** The meta key of a diary destination the v12 step could not set yet. */
export const DIARY_DESTINATION_PENDING = 'diary_destination_pending';

/** Gives the diary's publications the channel's place as destination, once, when the opener knows it. */
export function finishDiaryDestination(db, context = {}) {
  if (db.prepare('SELECT 1 AS ok FROM meta WHERE key = ?').get(DIARY_DESTINATION_PENDING) === undefined) return 0;
  const place = typeof context?.diaryPlaceId === 'string' && context.diaryPlaceId ? context.diaryPlaceId : null;
  if (!place) return 0;
  const at = db.prepare(`SELECT ${NOW_SQL} AS at`).get().at;
  const pending = db.prepare("SELECT 1 AS ok FROM meta WHERE key = 'graph_pending'").get() !== undefined;
  const set = assignDiaryDestination(db, place, { at, project: !pending });
  db.prepare('DELETE FROM meta WHERE key = ?').run(DIARY_DESTINATION_PENDING);
  return set;
}

function V12(db, context = {}) {
  // Only a database holding diary publications without a destination has anything to wait for.
  if (db.prepare("SELECT 1 AS ok FROM publications WHERE row_kind = 'diary' AND destination_place_id IS NULL LIMIT 1").get() === undefined) return;
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(DIARY_DESTINATION_PENDING, '1');
  finishDiaryDestination(db, context);
}

/** Each entry moves the schema one version up: SQL text, or a function of the connection (and the opener's context)
 * for a step SQL cannot do. Never edit a shipped entry: append a new one. */
export const MIGRATIONS = [V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11, V12];

/** Every table schema v7 adds. */
export const V7_TABLES = ['interfaces', 'authorities', 'connections', 'external_keys', 'audiences', 'account_person_links', 'execution_contexts'];

/** Every table schema v8 adds. */
export const V8_TABLES = [
  'participants', 'participant_links', 'people_merges', 'capture_bundles', 'capture_members', 'capture_events', 'capture_watches', 'source_relations',
];

/** Every table schema v1 creates (virtual tables included), for tests and tools. */
export const V1_TABLES = [
  'meta', 'files', 'people', 'accounts', 'places', 'memberships', 'sources', 'sources_fts', 'sources_tri', 'vectors',
  'claims', 'claim_versions', 'claim_sources', 'descriptions', 'description_versions', 'episodes', 'episode_sources',
  'affinity_events', 'day', 'diary', 'diary_mirrors', 'media', 'intentions', 'work', 'work_events', 'decisions',
  'turn_reads', 'ledger_tasks', 'ledger_attempts', 'ledger_questions', 'ledger_approvals', 'ledger_results',
  'ledger_comments', 'ledger_events', 'ledger_outbox', 'operational',
];
