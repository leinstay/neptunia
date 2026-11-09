// The memory database's schema steps above the baseline, and the names its checks and readers share. A new database
// starts from the baseline (src/memory/db/schema-baseline.ts); src/memory/db/open.ts then applies each entry of
// `MIGRATIONS` in order, one version per entry, and never edits a shipped one.

import { ownLineRows } from './line-owner.ts';
import { ownProfileRows } from './profile-owner.ts';
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
/** Why a capture bundle was opened. */
export const CAPTURE_REASONS = ['own_line', 'mention', 'reply_to_me', 'expansion', 'watch'];
/** The roles a source holds in a bundle. */
export const CAPTURE_ROLES = ['anchor', 'ancestor', 'before', 'after', 'reply', 'mention', 'same_author', 'watch'];
/** The states of a bundle's coverage. */
export const COVERAGE_STATES = ['complete', 'pending_expansion', 'provider_unavailable', 'incomplete'];
/** How a watch ended. */
export const WATCH_OUTCOMES = ['fetched', 'nothing_new', 'unavailable'];
/** The states of a wake run. */
export const WAKE_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'interrupted'];
