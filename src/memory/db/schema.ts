// The memory database's schema steps above the baseline, and the names its checks and readers share. A new database
// starts from the baseline (src/memory/db/schema-baseline.ts); src/memory/db/open.ts then applies each entry of
// `MIGRATIONS` in order, one version per entry, and never edits a shipped one.

import type { Db } from './types.ts';

/** One migration: SQL text, or a function of the connection. */
export type Migration = string | ((db: Db) => void);

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
