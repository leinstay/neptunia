// The size of one memory session request (src/memory/db/session.ts). A request takes at most the page budget: the
// estimated tokens of `memoryDb.session.maxPageTokens`, and never more than CAP_SHARE of `llm.maxRequestTokens`. The
// request cap is the provider's limit; the page budget is the size the memory model answers within the session's
// timeout. A batch is cut by lines until its pages fit (`cutByArrival`); a page of a batch whose lines are fixed goes out
// in parts of fewer people (`fewestParts`), each part under its page's batch key with `|<part>/<parts>` appended, and a
// page split before keeps its split (`splitBefore`), so an applied part is never sent again.

import { requestCapOf } from './session-retrieved.ts';
import type { Db } from './types.ts';

/** The share of `llm.maxRequestTokens` a session request may take (the estimate is not the provider's count). */
export const CAP_SHARE = 0.85;

/** The estimated tokens one session request may take: `maxPageTokens`, never more than CAP_SHARE of the request cap. */
export function pageBudgetOf(config: unknown, maxPageTokens: number): number {
  const cap = requestCapOf(config as Parameters<typeof requestCapOf>[0], CAP_SHARE);
  return cap === null ? maxPageTokens : Math.min(cap, maxPageTokens);
}

/** The `part`-th of `parts` near-equal shares of `people`, in their order (the whole list when `parts` is 1). */
export function shareOf<T>(people: ReadonlyArray<T>, part: number, parts: number): Array<T> {
  if (parts <= 1) return [...people];
  return people.slice(Math.floor((part * people.length) / parts), Math.floor(((part + 1) * people.length) / parts));
}

/**
 * The fewest near-equal parts of a page of `people` whose every part `fits` (1 when the page fits whole, and 1 when even
 * one person to a part does not fit: the page goes out as it is).
 */
export function fewestParts(people: number, fits: (part: number, parts: number) => boolean): number {
  for (let parts = 1; parts <= people; parts += 1) {
    let all = true;
    for (let part = 0; part < parts && all; part += 1) all = fits(part, parts);
    if (all) return parts;
  }
  return 1;
}

/**
 * `batch` cut to its first lines by arrival (rowid) until it `fits`, halving each time, never below `min` lines (a batch
 * that still does not fit is returned as it is). The lines keep their order.
 */
export function cutByArrival<T extends { rowid: number }>(
  batch: Array<T>,
  min: number,
  fits: (lines: Array<T>) => boolean
): Array<T> {
  const floor = Math.max(1, min);
  let lines = batch;
  while (lines.length > floor && !fits(lines)) {
    const byArrival = [...lines].sort((a, b) => a.rowid - b.rowid);
    const keep = new Set(
      byArrival.slice(0, Math.max(floor, Math.ceil(byArrival.length / 2))).map((line) => line.rowid)
    );
    const next = lines.filter((line) => keep.has(line.rowid));
    if (next.length === lines.length) break;
    lines = next;
  }
  return lines;
}

/** One request of a batch, or one that was applied before: its page, its part of the page and its batch key. */
export type BatchUnit = {
  page: number;
  part: number;
  parts: number;
  batchKey: string;
  last: boolean;
  applied: boolean;
};

/**
 * The requests of a batch in order. `keyHead` is the batch key without its page; `applied` says whether a batch key was
 * applied before (always false outside `apply`); `partsOfPage` sizes a page that was neither applied nor split before.
 */
export function unitsOf(
  db: Db,
  {
    keyHead,
    pages,
    applied,
    partsOfPage,
  }: {
    keyHead: string;
    pages: number;
    applied: (batchKey: string) => boolean;
    partsOfPage: (page: number) => number;
  }
): Array<BatchUnit> {
  const units: Array<BatchUnit> = [];
  for (let page = 0; page < pages; page += 1) {
    const pageKey = `${keyHead}|${page}`;
    const lastPage = page === pages - 1;
    if (applied(pageKey)) {
      units.push({ page, part: 0, parts: 1, batchKey: pageKey, last: lastPage, applied: true });
      continue;
    }
    const parts = splitBefore(db, pageKey) ?? partsOfPage(page);
    for (let part = 0; part < parts; part += 1) {
      const batchKey = parts === 1 ? pageKey : `${pageKey}|${part}/${parts}`;
      const done = parts > 1 && applied(batchKey);
      units.push({ page, part, parts, batchKey, last: lastPage && part === parts - 1, applied: done });
    }
  }
  return units;
}

/** The number of parts a page was sent in before (from the key of an applied part), or null. */
function splitBefore(db: Db, pageKey: string): number | null {
  const prefix = `${pageKey}|`;
  const row = db
    .prepare('SELECT batch_key FROM session_runs WHERE substr(batch_key, 1, ?) = ? AND applied = 1 LIMIT 1')
    .get(prefix.length, prefix);
  const parts = Number(/\/(\d+)$/.exec(typeof row?.batch_key === 'string' ? row.batch_key : '')?.[1]);
  return Number.isInteger(parts) && parts > 1 ? parts : null;
}
