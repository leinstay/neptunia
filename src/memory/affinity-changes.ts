// The attitude changes the memory database holds, across people: one row of `affinity_events` per change, newest first.
// `affinityChangesOf` reads them under any context: memory.read's section `changes` reads them under the turn's
// (src/turn/memory-read.ts). `readAffinityChanges`, the reader of the owner's `memory.profile.read section:changes`
// (src/tools/operations/memory.ts), reads the group audiences and the rows no audience owns through a group context, so
// a change made in a private chat never appears there. A retired change is left out. Reading writes nothing.

import { audienceWhere } from './db/scope.ts';
import { namesIn } from './db/names.ts';
import { createReadSeam } from './db/readers/seam.ts';
import type { Context } from './db/scope.ts';
import type { Db, Log } from './db/types.ts';

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The most changes one read returns. */
export const AFFINITY_CHANGES_MAX = 100;
/** How many changes a read returns when it names no limit. */
export const AFFINITY_CHANGES_DEFAULT = 25;

/** One attitude change: when, whose, how far it moved the score, the score after it and the stated reason. */
export type AffinityChange = {
  at: string;
  personId: string;
  name: string | null;
  applied: number;
  score: number;
  reason: string;
};

/** What a read narrows by: one person, a window of time (ISO instants, ends included) and a count. */
export type AffinityChangeFilter = {
  personId?: string | null;
  since?: string | null;
  until?: string | null;
  limit?: number;
};

/**
 * The changes matching `filter` that the context `ctx` may read, newest first, at most `limit` (default
 * `AFFINITY_CHANGES_DEFAULT`, never more than `AFFINITY_CHANGES_MAX`). A change made in a direct chat reads only under
 * that chat's context (scope.ts#audienceWhere). Read only.
 */
export function affinityChangesOf(db: Db, ctx: Context, filter: AffinityChangeFilter = {}): Array<AffinityChange> {
  const audience = audienceWhere(ctx, 'e');
  const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? AFFINITY_CHANGES_DEFAULT)), AFFINITY_CHANGES_MAX);
  const where = [`e.retired_at IS NULL`, audience.sql];
  const params: Array<string | number> = [...audience.params];
  if (filter.personId) {
    where.push('e.person_id = ?');
    params.push(filter.personId);
  }
  if (filter.since) {
    where.push('e.at >= ?');
    params.push(filter.since);
  }
  if (filter.until) {
    where.push('e.at <= ?');
    params.push(filter.until);
  }
  return db
    .prepare(
      `SELECT e.at, e.person_id, e.applied, e.delta, e.score, e.reason, p.real_name
       FROM affinity_events e LEFT JOIN people p ON p.id = e.person_id
       WHERE ${where.join(' AND ')} ORDER BY e.at DESC, e.rowid DESC LIMIT ?`
    )
    .all(...params, limit)
    .map((row) => ({
      at: textOf(row.at),
      personId: textOf(row.person_id),
      name: namesIn(row.real_name)[0] ?? null,
      applied: Number(row.applied ?? row.delta ?? 0),
      score: Number(row.score ?? 0),
      reason: typeof row.reason === 'string' ? row.reason : '',
    }));
}

/**
 * The changes matching `filter` under a group context, as affinityChangesOf reads them. `memoryDb` is the service that
 * hands out the read connection and the group context.
 */
export function readAffinityChanges({
  memoryDb,
  log,
  filter = {},
}: {
  memoryDb: {
    readHandle?: () => { db: object } | null;
    issueContext: (spec: { kind: 'group' }) => Context;
  };
  log: Pick<Log, 'warn'>;
  filter?: AffinityChangeFilter;
}): Array<AffinityChange> {
  const seam = createReadSeam({ memoryDb, log, reader: 'affinity-changes' });
  const ctx = memoryDb.issueContext({ kind: 'group' });
  return seam.run(() => affinityChangesOf(seam.db(), ctx, filter));
}
