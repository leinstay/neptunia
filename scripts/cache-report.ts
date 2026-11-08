#!/usr/bin/env node
// Operations tool: how much of her prompts the provider's cache served over a day range, from the archive of model
// requests in the memory database (`model_requests`). Opens `<data>/memory.db` read-only (no lock, no migration);
// writes nothing, sends nothing, spends nothing. Prints counts only, never a request's text.
//
//   node scripts/cache-report.ts --from 2026-11-05 --to 2026-11-06 [--data <dir>]
//
// Her requests are the rows of role `core` with status `ok` and a turn, whose `started_at` falls on a day of the range
// (UTC, both ends included). A turn is a `turn_id`, its first request the one with the lowest `step`. The place of a turn
// is the `place_id` of its journal row (`day`, `what = 'turn'`), and the gaps are taken between consecutive turn starts
// of one place: a gap longer than the cache TTL means the place's prefix was written again.

import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { CliError, daysBetween, defaultDataDir, flagText, parseFlags, runCli } from './lib/cli.ts';

const USAGE = 'usage: node scripts/cache-report.ts --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--data <dir>]';

/** The numbers of a range. */
export type CacheReport = {
  turns: number;
  promptTokens: number;
  cachedTokens: number;
  /** Turns whose first request read no cached token, over all turns; 0 with no turn. */
  zeroCacheShare: number;
  /** The median gap between consecutive turns of one place, in seconds; null with no gap. */
  medianGapSeconds: number | null;
};

type Statement = { all: (...params: Array<unknown>) => Array<Record<string, unknown>> };
type ReadDb = { prepare: (sql: string) => Statement };

/** A whole count of `value`, 0 for anything else. */
const countOf = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** The prompt and cached tokens of a stored usage. */
function tokensOf(usage: unknown): { prompt: number; cached: number } {
  let parsed: unknown = null;
  try {
    parsed = typeof usage === 'string' ? JSON.parse(usage) : null;
  } catch {
    parsed = null;
  }
  const record = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const details = record.prompt_tokens_details;
  const cached: unknown = details !== null && typeof details === 'object' ? Reflect.get(details, 'cached_tokens') : 0;
  return { prompt: countOf(record.prompt_tokens), cached: countOf(cached) };
}

/** The median of `values`, the mean of the two middle ones for an even count; null for none. */
function median(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The report of the days from `range.from` to `range.to` over an open memory database. */
export function cacheReport(handle: { db: object }, range: { from: string; to: string }): CacheReport {
  const db = handle.db as ReadDb;
  const rows = db
    .prepare(
      `SELECT turn_id, step, started_at, usage FROM model_requests
       WHERE role = 'core' AND status = 'ok' AND turn_id IS NOT NULL
         AND substr(started_at, 1, 10) BETWEEN ? AND ?
       ORDER BY turn_id, step, started_at`
    )
    .all(range.from, range.to);
  let promptTokens = 0;
  let cachedTokens = 0;
  const firsts = new Map<string, { at: number; cached: number }>();
  for (const row of rows) {
    const tokens = tokensOf(row.usage);
    promptTokens += tokens.prompt;
    cachedTokens += tokens.cached;
    const turn = String(row.turn_id);
    if (!firsts.has(turn)) firsts.set(turn, { at: Date.parse(String(row.started_at)), cached: tokens.cached });
  }
  const placeOf = new Map<string, string>();
  for (const row of db.prepare(`SELECT turn_id, place_id FROM day WHERE what = 'turn' AND turn_id IS NOT NULL`).all())
    if (typeof row.place_id === 'string') placeOf.set(String(row.turn_id), row.place_id);
  const startsByPlace = new Map<string, Array<number>>();
  for (const [turn, first] of firsts) {
    const place = placeOf.get(turn);
    if (place === undefined || !Number.isFinite(first.at)) continue;
    startsByPlace.set(place, [...(startsByPlace.get(place) ?? []), first.at]);
  }
  const gaps = [...startsByPlace.values()].flatMap((starts) =>
    starts
      .sort((a, b) => a - b)
      .slice(1)
      .map((at, i) => (at - starts[i]) / 1000)
  );
  const turns = firsts.size;
  const zero = [...firsts.values()].filter((first) => first.cached === 0).length;
  return {
    turns,
    promptTokens,
    cachedTokens,
    zeroCacheShare: turns === 0 ? 0 : zero / turns,
    medianGapSeconds: median(gaps),
  };
}

/** The whole tool: the report of the range as text. */
export async function main(argv: Array<string>, { cwd = process.cwd() }: { cwd?: string } = {}): Promise<string> {
  const flags = parseFlags(argv, { values: ['--data', '--from', '--to'], usage: USAGE });
  const from = flagText(flags, '--from');
  const to = flagText(flags, '--to');
  if (from === undefined || to === undefined) throw new CliError(USAGE);
  daysBetween(from, to, USAGE);
  const data = flagText(flags, '--data');
  const dataDir = data !== undefined ? path.resolve(cwd, data) : defaultDataDir(cwd);
  const handle = openMemoryDb(path.join(dataDir, 'memory.db'), { readOnly: true });
  try {
    const report = cacheReport(handle, { from, to });
    const gap = report.medianGapSeconds === null ? 'none' : String(Math.round(report.medianGapSeconds));
    return await Promise.resolve(
      [
        `# Prompt cache, ${from} to ${to}`,
        '',
        `Turns: ${report.turns}`,
        `Prompt tokens: ${report.promptTokens}`,
        `Cached tokens: ${report.cachedTokens}`,
        `Turns with no cached token on their first request: ${Math.round(report.zeroCacheShare * 100)}%`,
        `Median gap between turns of one place: ${gap} s`,
        '',
      ].join('\n')
    );
  } finally {
    handle.close();
  }
}

runCli(import.meta.url, main);
