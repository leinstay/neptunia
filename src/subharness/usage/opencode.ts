// OpenCode's statistics: `opencode stats` under the persona's backend home, a local read of its own database that starts no
// model run. The printed table is checked against the installed binary (2026-11-05): boxed rows of a label and a value.
// Its dollars are API accounting. A row the table lacks stays unknown, and a table with no known row is `unreadable`.
// src/subharness/usage.ts reads through this.

import { stripVTControlCharacters } from 'node:util';
import { readRouting } from '../routing.ts';
import { isInstalled, subharnessPlace, vendorEnv } from '../place.ts';
import type { BackendUsage, Observation, UsageExec, UsageMetric } from '../usage.ts';

export type OpenCodeUsageDeps = { privateDir: string; now(): number; exec: UsageExec };

const ROWS: ReadonlyArray<{ label: string; name: string; unit: UsageMetric['unit'] }> = [
  { label: 'Sessions', name: 'sessions', unit: 'count' },
  { label: 'Messages', name: 'messages', unit: 'count' },
  { label: 'Days', name: 'days', unit: 'days' },
  { label: 'Total Cost', name: 'totalCost', unit: 'usd' },
  { label: 'Avg Cost/Day', name: 'avgCostPerDay', unit: 'usd' },
  { label: 'Avg Tokens/Session', name: 'avgTokensPerSession', unit: 'tokens' },
  { label: 'Median Tokens/Session', name: 'medianTokensPerSession', unit: 'tokens' },
  { label: 'Input', name: 'input', unit: 'tokens' },
  { label: 'Output', name: 'output', unit: 'tokens' },
  { label: 'Cache Read', name: 'cacheRead', unit: 'tokens' },
  { label: 'Cache Write', name: 'cacheWrite', unit: 'tokens' },
];

const SUFFIXES: Readonly<Record<string, number>> = { K: 1e3, M: 1e6, B: 1e9 };

/** A printed value as a number: `$1.23`, `12`, `50.0K`. Null for anything else, so a new format reads as unknown. */
function numberOf(text: string): number | null {
  const match = /^\$?(\d+(?:\.\d+)?)([KMB]?)$/.exec(text.replaceAll(',', ''));
  if (match === null) return null;
  return Number(match[1]) * (SUFFIXES[match[2] ?? ''] ?? 1);
}

/** The rows of the boxed table, by label. */
function rowsOf(stdout: string): Map<string, number | null> {
  const rows = new Map<string, number | null>();
  for (const line of stripVTControlCharacters(stdout).split('\n')) {
    const match = /^│\s*(\S.*?)\s{2,}(\S+)\s*│$/.exec(line.trim());
    if (match !== null) rows.set(match[1] ?? '', numberOf(match[2] ?? ''));
  }
  return rows;
}

/** OpenCode's statistics now, named by the extra key it runs on. */
export async function readOpenCodeUsage(deps: OpenCodeUsageDeps): Promise<BackendUsage> {
  const answer = (over: Partial<Observation>): BackendUsage => ({
    variant: 'api',
    source: 'opencode',
    account: { label: null },
    observedAt: deps.now(),
    availability: 'unavailable',
    metrics: [],
    errors: [],
    handoff: null,
    ...over,
  });
  if (!isInstalled(deps.privateDir, 'opencode')) return answer({ errors: [{ code: 'not-installed' }] });
  const account = { label: readRouting(deps.privateDir).subharness.key };
  const { binary } = subharnessPlace(deps.privateDir, 'opencode');
  const env = vendorEnv(deps.privateDir, 'opencode');
  const run = await deps.exec(binary, ['stats'], { env }).catch(() => null);
  if (run === null || run.code !== 0) return answer({ account, errors: [{ code: 'read-failed' }] });
  const rows = rowsOf(run.stdout);
  if (!ROWS.some((row) => rows.has(row.label))) return answer({ account, errors: [{ code: 'unreadable' }] });
  return answer({
    account,
    availability: 'available',
    metrics: ROWS.map(({ label, name, unit }): UsageMetric => {
      const value = rows.get(label) ?? null;
      return { name, scope: 'account', unit, value, state: value === null ? 'unknown' : 'observed' };
    }),
  });
}
