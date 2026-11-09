// The memory database's schema steps above the baseline, and the names its checks and readers share. A new database
// starts from the baseline (src/memory/db/schema-baseline.ts); src/memory/db/open.ts then applies each entry of
// `MIGRATIONS` in order, one version per entry, and never edits a shipped one. The selfreflection's destination and
// mirror are finished here at an open that knows the channel, because a database once left them pending.

import { assignSelfreflectionDestination } from './publish.ts';
import { pastEntries } from './selfreflection-past.ts';
import type { Db } from './types.ts';

/** What a migration step needs from the opener: the selfreflection channel's place and the data directory. */
export type MigrationContext = { selfreflectionPlaceId?: string | null; dataDir?: string };

/** One migration: SQL text, or a function of the connection and the opener's context. */
export type Migration = string | ((db: Db, context: MigrationContext) => void);

/** The steps above the baseline, version 44 first. */
export const MIGRATIONS: Array<Migration> = [];

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

// The time stamped on what the fixes below write: the last sync of the old layout, or the epoch.
const NOW_SQL = "COALESCE((SELECT value FROM meta WHERE key = 'last_sync_at'), '1970-01-01T00:00:00.000Z')";

/** The meta key of a selfreflection destination that waits for an open that knows the channel. */
const SELFREFLECTION_DESTINATION_PENDING = 'selfreflection_destination_pending';
/** The meta key of a selfreflection mirror that waits for an open that knows the channel. */
const SELFREFLECTION_MIRROR_PENDING = 'selfreflection_mirror_pending';

const hasMeta = (db: Db, key: string): boolean =>
  db.prepare('SELECT 1 AS ok FROM meta WHERE key = ?').get(key) !== undefined;

/** The channel the opener named, or null. */
const namedPlace = (context: MigrationContext = {}): string | null => {
  const place = context?.selfreflectionPlaceId;
  return typeof place === 'string' && place ? place : null;
};

/** Gives the selfreflection's publications the channel's place as destination, once, when the opener knows it. */
export function finishSelfreflectionDestination(db: Db, context: MigrationContext = {}): number {
  const place = namedPlace(context);
  if (!hasMeta(db, SELFREFLECTION_DESTINATION_PENDING) || !place) return 0;
  const at = String(db.prepare(`SELECT ${NOW_SQL} AS at`).get()?.at);
  const pending = hasMeta(db, 'graph_pending');
  const set = assignSelfreflectionDestination(db, place, { at, project: !pending });
  db.prepare('DELETE FROM meta WHERE key = ?').run(SELFREFLECTION_DESTINATION_PENDING);
  return set;
}

/**
 * Seeds the selfreflection's mirror on the channel's place, once, when the opener knows it and the place is stored,
 * and makes her past messages there entries (selfreflection-past.ts#pastEntries). Returns the mirror rows written.
 */
export function finishSelfreflectionMirror(db: Db, context: MigrationContext = {}): number {
  const place = namedPlace(context);
  if (
    !hasMeta(db, SELFREFLECTION_MIRROR_PENDING) ||
    !place ||
    db.prepare('SELECT 1 AS ok FROM places WHERE id = ?').get(place) === undefined
  )
    return 0;
  const at = db.prepare(`SELECT ${NOW_SQL} AS at`).get()?.at;
  const written = db
    .prepare(
      "INSERT OR IGNORE INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by, extra) VALUES (?, 'selfreflection', ?, 1, ?, 'owner', NULL)"
    )
    .run(`mirror:selfreflection:${place}`, place, at).changes;
  pastEntries(db, place, { at: String(at) });
  db.prepare('DELETE FROM meta WHERE key = ?').run(SELFREFLECTION_MIRROR_PENDING);
  return Number(written);
}
