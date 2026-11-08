// The pinned config and the rabbit lines of the recall run tests, and the timers and deferred promises their budget scenes use.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { line, rawHit } from './recall-lines.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIPPED_CONFIG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.json'), 'utf8')) as Record<
  string,
  Record<string, unknown>
>;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
export const RABBIT = Date.UTC(2026, 9, 1, 18, 44);
export const ROOT = 'g1';
export const PROMPT = 'You are {{name}}; {{answerChars}}.';

// The recall settings the runner tests rely on, pinned here instead of read from the shipped defaults.
export const RECALL_PIN = {
  maxForms: 8,
  maxPeople: 2,
  dateSamples: 4,
  clusterGapMinutes: 30,
  maxClusters: 8,
  rareHits: 0,
  windowMessages: 16,
  answerChars: 1200,
  stretchChars: 1500,
  maxPerDay: 100,
  timeoutMs: 30000,
  minSummaryMs: 2500,
  maxOutputTokens: 500,
  memoryItems: 6,
  selfBonus: 1,
  selfExtra: 0,
  contextMessages: 0,
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

/** The message searches among the REST calls. */
export const searches = <TCall extends { route: string }>(calls: Array<TCall>): Array<TCall> =>
  calls.filter((c) => c.route.endsWith('/messages/search'));

export const RABBIT_LINES = [
  line('r0', RABBIT - 6 * MINUTE, { name: 'Βασίλης', author: 'u2', content: 'πάμε κυνήγι' }),
  line('r1', RABBIT - 4 * MINUTE, { name: 'Ana', content: 'bang', attachment: { id: 'p1' } }),
  line('r2', RABBIT, { name: 'Βασίλης', author: 'u2', content: 'το κουνέλι πέθανε' }),
  line('r3', RABBIT + 2 * MINUTE, { name: 'Ana', content: 'κηδεία για το κουνέλι' }),
  line('r4', RABBIT + 3 * MINUTE, { name: 'Birthdays', author: 'bot1', content: 'κουνέλι birthday!', bot: true }),
];
export const GARDEN_LINES = [
  line('g1', RABBIT - 30 * HOUR, { name: 'Éloïse', author: 'u3', content: 'ένα κουνέλι στον κήπο' }),
  line('g2', RABBIT - 30 * HOUR + MINUTE, { name: 'Ana', content: 'ωραίο' }),
];
export const PRIVATE_LINES = [line('s1', RABBIT - HOUR, { name: 'Ana', content: 'μυστικό κουνέλι' })];

/** Search answers: `κουνέλι` hits the rabbit lines (the bot's too), the garden and the private channel; `κουνελιού` nothing. */
export function rabbitAnswers(route: string, query: { content?: string }): unknown {
  if (route.endsWith('/members/search')) return [];
  if (query.content === 'κουνέλι') {
    return {
      total_results: 5,
      messages: [
        [rawHit('c1', RABBIT_LINES[4])],
        [rawHit('c1', RABBIT_LINES[3])],
        [rawHit('c1', RABBIT_LINES[2])],
        [rawHit('c4', PRIVATE_LINES[0])],
        [rawHit('c2', GARDEN_LINES[0])],
      ],
    };
  }
  return { total_results: 0, messages: [] };
}

export const RABBIT_SERVER = { forms: ['κουνέλι', 'κουνελιού'], who: [], from: null, to: null };

/** Timers fired by hand: `fire(ms)` runs the pending one that was set for `ms`. */
type ManualTimer = { fn: () => void; ms: number; done: boolean };

export function manualTimers(): {
  set: (fn: () => void, ms: number) => ManualTimer;
  clear: (timer: ManualTimer) => void;
  fire: (ms: number) => void;
  pending: () => Array<number>;
} {
  const all: Array<ManualTimer> = [];
  return {
    set: (fn: () => void, ms: number) => {
      const timer = { fn, ms, done: false };
      all.push(timer);
      return timer;
    },
    clear: (timer: ManualTimer) => {
      timer.done = true;
    },
    fire(ms: number) {
      const timer = all.find((t) => t.ms === ms && !t.done);
      assert.ok(timer, `a pending timer of ${ms} ms`);
      timer.done = true;
      timer.fn();
    },
    pending: () => all.filter((t) => !t.done).map((t) => t.ms),
  };
}

/** A promise with its resolve at hand. */
export function deferred(): { promise: Promise<unknown>; resolve: (value?: unknown) => void } {
  let resolve: (value?: unknown) => void = () => {};
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A pending request that rejects with an AbortError once `signal` aborts. */
export function hangUntilAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
}

export const BUDGET = { timeoutMs: 10000, minSummaryMs: 2500 };
