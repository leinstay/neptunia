// The memory database's schema steps above the baseline, and the names its checks and readers share. A new database
// starts from the baseline (src/memory/db/schema-baseline.ts); src/memory/db/open.ts then applies each entry of
// `MIGRATIONS` in order, one version per entry, and never edits a shipped one.

import { ownLineRows } from './line-owner.ts';
import { ownMediaRows } from './media-owner.ts';
import { ownGifRows } from './gif-library.ts';
import { retireOwnLinesSeenTwice } from './own-lines.ts';
import { dropUnitLayer } from './drop-units.ts';
import { ownProfileRows } from './profile-owner.ts';
import { ownPlaceListRows, ownPlaceRows, ownSelfreflectionRows } from './place-owner.ts';
import { placeLineVectors } from './line-vectors.ts';
import { rebuildLocatorIndex } from './message-family-catalog.ts';
import type { Db } from './types.ts';

/** One migration: SQL text, or a function of the connection. */
export type Migration = string | ((db: Db) => void);

/** The steps above the baseline, version 45 first. */
export const MIGRATIONS: Array<Migration> = [
  // Version 45: a line vector names the place of its index, not a month unit (src/memory/db/line-vectors.ts), and the
  // index of a line by its stored address matches the query that asks it (message-family-catalog.ts).
  (db: Db): void => {
    placeLineVectors(db);
    rebuildLocatorIndex(db);
  },
  // Version 46: the rows of the record, the journal and the archive name their owner themselves: the writer, the place
  // that holds them and their day or month (src/memory/db/line-owner.ts), taken from their units.
  (db: Db): void => {
    for (const table of ['sources', 'day', 'decisions', 'affinity_events', 'claim_versions']) {
      db.exec(`ALTER TABLE "${table}" ADD COLUMN writer TEXT`);
      db.exec(`ALTER TABLE "${table}" ADD COLUMN holder_id TEXT`);
      db.exec(`ALTER TABLE "${table}" ADD COLUMN period TEXT`);
    }
    // A journal's attitude rows are read through their decision's id, so that table needs no index of its own.
    for (const table of ['sources', 'day', 'decisions', 'claim_versions'])
      db.exec(
        `CREATE INDEX "${table}_line" ON "${table}"(writer, holder_id, period, position) WHERE writer IS NOT NULL`
      );
    // The indexes of the owner paths of an older layout serve no query and cost every line write.
    for (const index of [
      'sources_file',
      'day_owner',
      'decisions_owner',
      'affinity_events_owner',
      'claim_versions_owner',
    ])
      db.exec(`DROP INDEX IF EXISTS "${index}"`);
    db.exec('ALTER TABLE claims ADD COLUMN writer TEXT');
    ownLineRows(db);
  },
  // Version 47: the rows of an account's profile, a private layer and a history of prose name their writer and holder,
  // and the rows no unit owns in the session's tables are her session's (src/memory/db/profile-owner.ts).
  (db: Db): void => {
    const added: Record<string, ReadonlyArray<string>> = {
      people: ['writer', 'holder_id'],
      accounts: ['writer', 'holder_id'],
      memberships: ['writer', 'holder_id'],
      claims: ['holder_id'],
      descriptions: ['writer', 'holder_id'],
      description_versions: ['writer', 'holder_id'],
      episodes: ['writer', 'holder_id'],
      operational: ['writer', 'holder_id'],
    };
    for (const [table, columns] of Object.entries(added))
      for (const column of columns) db.exec(`ALTER TABLE "${table}" ADD COLUMN ${column} TEXT`);
    for (const table of [...Object.keys(added), 'affinity_events'])
      db.exec(`CREATE INDEX "${table}_holder" ON "${table}"(writer, holder_id) WHERE writer IS NOT NULL`);
    ownProfileRows(db);
  },
  // Version 48: the rows of a place's notes and a channel's entry, and the places that share one of them, name their
  // writer and holder (src/memory/db/place-owner.ts).
  (db: Db): void => {
    for (const table of ['places', 'co_owners'])
      for (const column of ['writer', 'holder_id']) db.exec(`ALTER TABLE "${table}" ADD COLUMN ${column} TEXT`);
    db.exec('CREATE INDEX "places_holder" ON "places"(writer, holder_id) WHERE writer IS NOT NULL');
    db.exec('CREATE INDEX "co_owners_holder" ON "co_owners"(tbl, writer, holder_id) WHERE writer IS NOT NULL');
    ownPlaceRows(db);
  },
  // Version 49: the rows of a lorebook, a participation and recent lines, and an episode's message links, name their
  // writer and holder (src/memory/db/place-owner.ts).
  (db: Db): void => {
    for (const column of ['writer', 'holder_id']) db.exec(`ALTER TABLE episode_sources ADD COLUMN ${column} TEXT`);
    db.exec('CREATE INDEX "episode_sources_holder" ON episode_sources(writer, holder_id) WHERE writer IS NOT NULL');
    ownPlaceListRows(db);
  },
  // Version 50: her selfreflection's entries, their mirrors and the mirrors' publications name their writer and holder
  // (src/memory/db/place-owner.ts).
  (db: Db): void => {
    for (const table of ['selfreflection', 'selfreflection_mirrors', 'publications']) {
      for (const column of ['writer', 'holder_id']) db.exec(`ALTER TABLE "${table}" ADD COLUMN ${column} TEXT`);
      db.exec(`CREATE INDEX "${table}_holder" ON "${table}"(writer, holder_id) WHERE writer IS NOT NULL`);
    }
    ownSelfreflectionRows(db);
  },
  // Version 51: a record line whose author no account row holds keeps the author's id beside its column, since the
  // record reads an author back from the account's row (src/memory/db/record-lines.ts). The id is the one the line
  // was written with, after the interface's prefix of the account id it was stored under.
  `UPDATE sources SET extra = json_set(COALESCE(extra, '{}'), '$."$kept:by"', substr(author_account, instr(author_account, ':') + 1))
    WHERE writer = 'record' AND author_account IS NOT NULL AND instr(author_account, ':') > 0
      AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = sources.author_account)
      AND (extra IS NULL OR (json_valid(extra) AND json_extract(extra, '$."$kept:by"') IS NULL))`,
  // Version 52: the rows of a place's media cache and of the GIF library name their writer and holder, a cache row the
  // moment it was last written, and the describer's saved descriptions live on their rows alone
  // (src/memory/db/media-owner.ts).
  (db: Db): void => {
    for (const column of ['writer TEXT', 'holder_id TEXT', 'used_at INTEGER'])
      db.exec(`ALTER TABLE media ADD COLUMN ${column}`);
    db.exec('CREATE INDEX "media_holder" ON media(writer, holder_id, used_at) WHERE writer IS NOT NULL');
    ownMediaRows(db);
  },
  // Version 53: the GIF library leaves its unit. Every row of a library entry, the ones a media cache's unit took
  // included, is the library's and the persona's, its operational row the persona's, and the GIF units go
  // (src/memory/db/gif-library.ts).
  (db: Db): void => {
    ownGifRows(db);
  },
  // Version 54: a line of hers the record also stored as a `seen` line of her own account is retired
  // (src/memory/db/own-lines.ts).
  (db: Db): void => {
    retireOwnLinesSeenTwice(db, new Date().toISOString());
  },
  // Version 55: the storage unit layer leaves the schema: its catalog, path aliases, file ledger, the capture tables and
  // the unit columns of every row; `co_owners` keeps the four columns the sharing reads (src/memory/db/drop-units.ts).
  (db: Db): void => {
    dropUnitLayer(db);
  },
];

/** The tables that carry a scope and its `audience_id`. */
export const SCOPED_TABLES = [
  'sources',
  'vectors',
  'claims',
  'descriptions',
  'episodes',
  'affinity_events',
  'day',
  'selfreflection',
  'media',
  'intentions',
  'work',
  'session_runs',
];

/** The token kinds of a participant. */
export const PARTICIPANT_TOKEN_KINDS = ['thread_token', 'site_token', 'post_number', 'display_name', 'none'];
/** The predicates of `source_relations`. */
export const RELATION_PREDICATES = ['replies_to', 'quotes', 'reposts', 'mentions', 'edits', 'references'];
/** The states of a wake run. */
export const WAKE_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'interrupted'];
