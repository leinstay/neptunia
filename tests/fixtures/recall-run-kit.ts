// The pinned config, the clock and the rabbit question of the recall run tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIPPED_CONFIG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.json'), 'utf8')) as Record<
  string,
  Record<string, unknown>
>;

export const MINUTE = 60_000;
export const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
export const ROOT = 'g1';

// The recall settings the runner tests rely on, pinned here instead of read from the shipped defaults.
const RECALL_PIN = {
  maxForms: 8,
  maxClusters: 8,
  windowMessages: 16,
  stretchChars: 1500,
  maxPerDay: 100,
  timeoutMs: 30000,
  memoryItems: 6,
  traceMaxLines: 500,
  followMessages: 24,
  followGapMinutes: 5,
};

/** The shipped config.json with the recall settings pinned and the given groups merged over a fresh copy (one level deep). */
export function config(
  overrides: Record<string, Record<string, unknown>> = {}
): Record<string, Record<string, unknown>> {
  const base = structuredClone(SHIPPED_CONFIG);
  base.bot = { ...base.bot, timezone: 'UTC' };
  base.recall = { ...RECALL_PIN };
  for (const [key, value] of Object.entries(overrides)) base[key] = { ...base[key], ...value };
  return base;
}

export const RABBIT_SERVER = { forms: ['κουνέλι', 'κουνελιού'], who: [], from: null, to: null };
