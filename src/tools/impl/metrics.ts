// The speed figures of the owner's `/nep status` card: how long a reply, a recall step, the
// planner, an analyzer batch or an embedding flush took over the last day. The durations come
// from the log lines that already carry them (src/log.js#onLog, subscribed in src/index.js via
// `metricsTap`); each metric keeps its samples of the last 24 h, at most MAX_SAMPLES (the oldest
// go first), in memory, and `data/metrics.json` keeps them across a restart (written at most once
// a minute, and once more on shutdown; write-temp + rename). Only numbers are kept: a name, a time
// and a duration, never a message or an id.

import * as nodeFs from 'node:fs';
import path from 'node:path';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../../time.js';
import { log as defaultLog } from '../../log.js';

/** The file under `data/` the samples persist in. */
export const METRICS_FILE = 'metrics.json';

/** How long a sample is kept. */
export const KEEP_MS = DAY_MS;

/** The most samples one metric keeps. */
export const MAX_SAMPLES = 2000;

/** The least time between two writes of the file (a forced write on shutdown aside). */
export const SAVE_EVERY_MS = MINUTE_MS;

/** The file's schema version. */
const VERSION = 1;

/**
 * The metrics the tap records, in the order the status card's speed field lists them.
 * `reply`: from the trigger to the turn's first message posted, every turn; split by whether a
 * recall ran during the turn. The recall steps, the planner, the analyzer batch and the
 * embedding flush come from their own log lines.
 */
export const SPEED_METRICS = Object.freeze([
  'reply',
  'reply with recall',
  'reply without recall',
  'recall total',
  'discord search',
  'record match',
  'memory match',
  'meaning search',
  'recall summary',
  'planner',
  'analyzer batch',
  'embedding flush',
]);

const isDuration = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** `values` (numbers) -> `{ n, median, mean }`, the two rounded to whole ms; nulls when empty. */
function summarize(values) {
  if (values.length === 0) return { n: 0, median: null, mean: null };
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return { n: sorted.length, median: Math.round(median), mean: Math.round(mean) };
}

/**
 * Create the metrics store, loading `data/metrics.json` when it is there (a missing or broken
 * file starts empty; samples past 24 h or over the cap are dropped on load).
 *
 * @param {object} options
 * @param {string} options.dataDir  The `data/` directory.
 * @param {() => number} [options.now=Date.now]
 * @param {object} [options.fs]  A `node:fs`-shaped API (`readFileSync`, `promises.mkdir|writeFile|rename`).
 * @param {{ warn: Function }} [options.log]
 * @returns {{
 *   record(name: string, ms: number): boolean,
 *   summary(name: string, hours?: number): { n: number, median: number|null, mean: number|null },
 *   names(): string[],
 *   save(opts?: { force?: boolean }): Promise<boolean>,
 * }}
 *   `record` keeps one sample (refused, false, for an empty name or anything but a finite
 *   duration >= 0). `summary` covers the samples of the last `hours` (default 24, never more
 *   than 24). `save` writes the file when a sample came since the last write and, unless
 *   `force`, a minute has passed since it; resolves whether it wrote. A failed write is logged
 *   (`metrics: save failed`, its code) and tried again on the next call. Writes run one at a time.
 */
export function createMetrics({ dataDir, now = Date.now, fs = nodeFs, log = defaultLog }) {
  const file = path.join(dataDir, METRICS_FILE);
  const series = new Map(); // name -> [[atMs, ms], ...], oldest first
  let dirty = false;
  let lastSaveAt = -Infinity;
  let chain = Promise.resolve();

  /** `name`'s samples without those past KEEP_MS and over MAX_SAMPLES. */
  function prune(name) {
    const samples = series.get(name);
    if (!samples) return [];
    const from = now() - KEEP_MS;
    let start = 0;
    while (start < samples.length && samples[start][0] < from) start += 1;
    start = Math.max(start, samples.length - MAX_SAMPLES);
    if (start > 0) samples.splice(0, start);
    if (samples.length === 0) series.delete(name);
    return samples;
  }

  function load() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') log.warn('metrics: load failed', { code: error?.code ?? null });
      return;
    }
    const samples = parsed && typeof parsed === 'object' ? parsed.samples : null;
    if (!samples || typeof samples !== 'object') return;
    for (const [name, list] of Object.entries(samples)) {
      if (!name || !Array.isArray(list)) continue;
      const valid = list
        .filter((pair) => Array.isArray(pair) && Number.isFinite(pair[0]) && isDuration(pair[1]))
        .map(([at, ms]) => [at, ms])
        .sort((a, b) => a[0] - b[0]);
      if (valid.length === 0) continue;
      series.set(name, valid);
      prune(name);
    }
  }

  function record(name, ms) {
    if (typeof name !== 'string' || !name || !isDuration(ms)) return false;
    if (!series.has(name)) series.set(name, []);
    series.get(name).push([now(), Math.round(ms)]);
    prune(name);
    dirty = true;
    return true;
  }

  function summary(name, hours = 24) {
    const span = Math.min(isDuration(hours) ? hours * HOUR_MS : KEEP_MS, KEEP_MS);
    const from = now() - span;
    return summarize(
      prune(name)
        .filter(([at]) => at >= from)
        .map(([, ms]) => ms)
    );
  }

  function names() {
    return [...series.keys()].filter((name) => prune(name).length > 0);
  }

  async function write() {
    for (const name of [...series.keys()]) prune(name);
    const text = JSON.stringify({ v: VERSION, samples: Object.fromEntries(series) });
    const tmp = `${file}.tmp`;
    await fs.promises.mkdir(dataDir, { recursive: true });
    await fs.promises.writeFile(tmp, text);
    await fs.promises.rename(tmp, file);
  }

  function save({ force = false } = {}) {
    const run = chain.then(async () => {
      if (!dirty || (!force && now() - lastSaveAt < SAVE_EVERY_MS)) return false;
      dirty = false;
      try {
        await write();
        lastSaveAt = now();
        return true;
      } catch (error) {
        dirty = true;
        log.warn('metrics: save failed', { code: error?.code ?? null });
        return false;
      }
    });
    chain = run.catch(() => {});
    return run;
  }

  load();
  return { record, summary, names, save };
}

/**
 * A log listener (src/log.js#onLog) feeding `metrics` from the lines that carry a duration:
 *
 *   - `recall: searched`: `discordMs`, `recordMs`, `memoryMs`, `meaningMs` (a step that took no
 *     time did not run: no sample); it also marks its channel as recalled at the line's time;
 *   - `recall: summary`: `ms` (the summary request; 0 when none was sent: no sample) and
 *     `totalMs` (the run from its start, as `recall total`);
 *   - `planner: classified`: `ms`;
 *   - `memory: update applied`, `memory: private update applied`: `ms` (`analyzer batch`);
 *   - `embedder: flushed`: `ms`, only for a flush that embedded something;
 *   - `turn: timings` opens a turn of its channel (it started `totalMs` before the line), with a
 *     recall when its channel was recalled since then; the next `turn: sent` of the channel gives
 *     the turn's `reply` (`secondsSinceTrigger`), and `reply with recall` or `reply without
 *     recall`; the turn's later messages give nothing.
 *
 * Reads numbers and channel ids only; never throws on an odd entry.
 * @param {{ record: (name: string, ms: number) => boolean }} metrics
 * @returns {(entry: object) => void}
 */
export function metricsTap(metrics) {
  const recalledAt = new Map(); // channel -> ms of its last `recall: searched`
  const openTurns = new Map(); // channel -> { withRecall }
  const timeOf = (entry) => Date.parse(entry?.time);
  const positive = (value) => isDuration(value) && value > 0;

  return (entry) => {
    if (!entry || typeof entry !== 'object') return;
    const channel = typeof entry.channel === 'string' ? entry.channel : null;
    switch (entry.msg) {
      case 'recall: searched': {
        for (const [field, name] of [
          ['discordMs', 'discord search'],
          ['recordMs', 'record match'],
          ['memoryMs', 'memory match'],
          ['meaningMs', 'meaning search'],
        ]) {
          if (positive(entry[field])) metrics.record(name, entry[field]);
        }
        if (channel && Number.isFinite(timeOf(entry))) recalledAt.set(channel, timeOf(entry));
        break;
      }
      case 'recall: summary':
        if (positive(entry.ms)) metrics.record('recall summary', entry.ms);
        if (isDuration(entry.totalMs)) metrics.record('recall total', entry.totalMs);
        break;
      case 'planner: classified':
        if (isDuration(entry.ms)) metrics.record('planner', entry.ms);
        break;
      case 'memory: update applied':
      case 'memory: private update applied':
        if (isDuration(entry.ms)) metrics.record('analyzer batch', entry.ms);
        break;
      case 'embedder: flushed':
        if (entry.embedded > 0 && isDuration(entry.ms)) metrics.record('embedding flush', entry.ms);
        break;
      case 'turn: timings': {
        if (!channel) break;
        const startedAt = timeOf(entry) - (isDuration(entry.totalMs) ? entry.totalMs : 0);
        const recalled = recalledAt.get(channel);
        recalledAt.delete(channel);
        openTurns.set(channel, { withRecall: Number.isFinite(recalled) && recalled >= startedAt });
        break;
      }
      case 'turn: sent': {
        const turn = channel ? openTurns.get(channel) : null;
        if (!turn || !isDuration(entry.secondsSinceTrigger)) break;
        openTurns.delete(channel);
        const ms = entry.secondsSinceTrigger * 1000;
        metrics.record('reply', ms);
        metrics.record(turn.withRecall ? 'reply with recall' : 'reply without recall', ms);
        break;
      }
      default:
        break;
    }
  };
}
