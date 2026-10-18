// The pure part of the reports (tools/journal-report.mjs, tools/request-report.mjs): one day's
// journal records, or one day's operational log lines, folded into the same tally, then
// rendered as one markdown section. A number the source does not carry stays null and prints
// `N/A`; nothing is guessed. No I/O here: the scripts read the files and print.

import { LIMIT_KINDS } from '../../src/llm/limits.js';

/** What a missing number prints as. */
export const NA = 'N/A';

/** The outcome a `turn: model answered` log line stands for (the log does not say how the turn ended). */
export const LOG_OUTCOME = 'model-answered';

/**
 * The `p`-th percentile (0..100) of the finite numbers of `values`, linearly interpolated
 * between the closest ranks; null when there is none.
 * @param {unknown[]} values
 * @param {number} p
 * @returns {number|null}
 */
export function percentile(values, p) {
  const sorted = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0 || !Number.isFinite(p)) return null;
  const pos = ((sorted.length - 1) * Math.min(100, Math.max(0, p))) / 100;
  const low = Math.floor(pos);
  const high = Math.ceil(pos);
  return sorted[low] + (sorted[high] - sorted[low]) * (pos - low);
}

/** Add `n` to `map[a][b]`, creating the inner map. */
function bump2(map, a, b, n = 1) {
  map[a] ??= {};
  map[a][b] = (map[a][b] ?? 0) + n;
}

/** A fresh, empty tally: every part present and zero; the log reader sets its missing parts to null. */
function emptyTally() {
  return {
    records: 0,
    turns: {},
    reasons: {},
    actions: {},
    prompt: [],
    cached: { cached: 0, prompt: 0, counted: 0, cacheWrite: 0, writeCounted: 0 },
    dropped: {},
    limits: [],
    ownMessages: 0,
    memoryBatches: 0,
    system: {},
    fileBytes: null,
  };
}

/** A limit entry's kind and amount when it has a kind, else null. */
function limitEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.kind !== 'string' || !entry.kind) return null;
  return { kind: entry.kind, lost: Number.isFinite(entry.lost) ? entry.lost : null };
}

/**
 * One day's journal records folded into the report's numbers:
 * - `turns[outcome][triggerKind]`: `turn` records by outcome and the trigger kind of their
 *   `turn.start` line (same `turnId` and `attemptId`; `-` when that line is absent or names none);
 * - `reasons[outcome][reason]`: the reason of every turn that has one (skips, refusals, errors);
 * - `actions[name][phase]`: every `action` line;
 * - `prompt`: the prompt tokens of every turn with a usage; `cached`: the cached and prompt
 *   sums over the turns that report both (`counted` of them), and the cache-write tokens
 *   (`usage.cacheWrite`) summed over the turns that report them (`writeCounted` of them);
 * - `dropped[section]`: the sum of `budget.dropped` per section;
 * - `limits`: every `limits` entry of the turn and memory records (`{ kind, lost }`);
 * - `ownMessages`: the persona's posts (`posted` entries); `memoryBatches`; `system[event]`.
 * Anything that is not an object is skipped. `fileBytes` stays null (the reader sets it).
 * @param {object[]} records
 * @returns {object}
 */
export function tally(records) {
  const out = emptyTally();
  const list = (Array.isArray(records) ? records : []).filter((r) => r && typeof r === 'object');
  const triggers = new Map();
  for (const record of list) {
    if (record.kind === 'turn.start' && typeof record.turnId === 'string') {
      triggers.set(`${record.turnId}#${record.attemptId ?? 1}`, typeof record.trigger?.kind === 'string' ? record.trigger.kind : '-');
    }
  }
  for (const record of list) {
    out.records += 1;
    if (record.kind === 'turn') {
      const outcome = typeof record.outcome === 'string' ? record.outcome : '-';
      bump2(out.turns, outcome, triggers.get(`${record.turnId}#${record.attemptId ?? 1}`) ?? '-');
      if (typeof record.reason === 'string' && record.reason) bump2(out.reasons, outcome, record.reason);
      const usage = record.usage;
      if (Number.isFinite(usage?.prompt)) {
        out.prompt.push(usage.prompt);
        if (Number.isFinite(usage.cached)) {
          out.cached.cached += usage.cached;
          out.cached.prompt += usage.prompt;
          out.cached.counted += 1;
        }
        if (Number.isFinite(usage.cacheWrite)) {
          out.cached.cacheWrite += usage.cacheWrite;
          out.cached.writeCounted += 1;
        }
      }
      for (const [section, n] of Object.entries(record.budget?.dropped ?? {})) {
        if (Number.isFinite(n)) out.dropped[section] = (out.dropped[section] ?? 0) + n;
      }
      if (Array.isArray(record.posted)) out.ownMessages += record.posted.length;
    } else if (record.kind === 'action') {
      bump2(out.actions, typeof record.name === 'string' ? record.name : '-', typeof record.phase === 'string' ? record.phase : '-');
    } else if (record.kind === 'memory') {
      out.memoryBatches += 1;
    } else if (record.kind === 'system') {
      const event = typeof record.event === 'string' ? record.event : '-';
      out.system[event] = (out.system[event] ?? 0) + 1;
    }
    if ((record.kind === 'turn' || record.kind === 'memory') && Array.isArray(record.limits)) {
      for (const entry of record.limits) {
        const limit = limitEntry(entry);
        if (limit) out.limits.push(limit);
      }
    }
  }
  return out;
}

/**
 * The limits table of a day: one row per kind that bit, `{ kind, count, lost }`, `lost` the sum
 * of the finite amounts (null when no entry of the kind had one). Takes journal records (the
 * `limits` arrays of the turn and memory records; other records add nothing) or bare limit
 * entries (`{ kind, lost }`, as `tally` collects them). Rows in the order of LIMIT_KINDS, unknown
 * kinds after them by name.
 * @param {object[]} records
 * @returns {{ kind: string, count: number, lost: number|null }[]}
 */
export function limitsTable(records) {
  const rows = new Map();
  const add = (entry) => {
    const limit = limitEntry(entry);
    if (!limit) return;
    const row = rows.get(limit.kind) ?? { kind: limit.kind, count: 0, lost: null };
    row.count += 1;
    if (limit.lost !== null) row.lost = (row.lost ?? 0) + limit.lost;
    rows.set(limit.kind, row);
  };
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== 'object') continue;
    const isRecord = 'v' in record || 'occurredAt' in record || Array.isArray(record.limits);
    if (!isRecord) add(record);
    else if ((record.kind === 'turn' || record.kind === 'memory') && Array.isArray(record.limits)) record.limits.forEach(add);
  }
  const rank = (kind) => {
    const at = LIMIT_KINDS.indexOf(kind);
    return at === -1 ? LIMIT_KINDS.length : at;
  };
  return [...rows.values()].sort((a, b) => rank(a.kind) - rank(b.kind) || a.kind.localeCompare(b.kind));
}

/**
 * The operational log folded into the shape of `tally`, one tally per UTC day of the line's
 * `time`: each `turn: model answered` line (src/log.js JSON; anything before the first `{` of a
 * line is ignored, so prefixed journalctl lines work too) counts under outcome LOG_OUTCOME by its
 * `trigger`; its `usage.prompt_tokens` (and `usage.prompt_tokens_details.cached_tokens` and
 * `.cache_write_tokens` when present) and the `dropped` of each section of `budget` are added. What the log does not carry
 * is null and prints N/A: reasons, actions, limits, own messages, memory batches, system events,
 * file bytes.
 * @param {string[]} lines
 * @returns {Map<string, object>}
 */
export function tallyLog(lines) {
  const days = new Map();
  for (const raw of Array.isArray(lines) ? lines : []) {
    const text = String(raw ?? '');
    const at = text.indexOf('{');
    if (at === -1) continue;
    let entry;
    try {
      entry = JSON.parse(text.slice(at));
    } catch {
      continue;
    }
    if (entry?.msg !== 'turn: model answered' || typeof entry.time !== 'string') continue;
    const day = entry.time.slice(0, 10);
    if (!days.has(day)) {
      days.set(day, { ...emptyTally(), reasons: null, actions: null, limits: null, ownMessages: null, memoryBatches: null, system: null });
    }
    const out = days.get(day);
    out.records += 1;
    bump2(out.turns, LOG_OUTCOME, typeof entry.trigger === 'string' && entry.trigger ? entry.trigger : '-');
    const prompt = entry.usage?.prompt_tokens;
    if (Number.isFinite(prompt)) {
      out.prompt.push(prompt);
      const cached = entry.usage?.prompt_tokens_details?.cached_tokens;
      if (Number.isFinite(cached)) {
        out.cached.cached += cached;
        out.cached.prompt += prompt;
        out.cached.counted += 1;
      }
      const written = entry.usage?.prompt_tokens_details?.cache_write_tokens;
      if (Number.isFinite(written)) {
        out.cached.cacheWrite += written;
        out.cached.writeCounted += 1;
      }
    }
    for (const [section, stats] of Object.entries(entry.budget ?? {})) {
      if (stats && typeof stats === 'object' && Number.isFinite(stats.dropped)) {
        out.dropped[section] = (out.dropped[section] ?? 0) + stats.dropped;
      }
    }
  }
  return days;
}

/** A markdown table; `rows` are arrays of cells. */
function table(head, rows) {
  const line = (cells) => `| ${cells.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n');
}

/** A number as printed: whole numbers as they are, others with one decimal; null -> N/A. */
function num(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return NA;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Two-level counts as a table: a row per outer key, a column per inner key, then the row total. */
function crossTable(label, map) {
  const inner = [...new Set(Object.values(map).flatMap((row) => Object.keys(row)))].sort();
  const rows = Object.keys(map)
    .sort()
    .map((key) => {
      const row = map[key];
      const total = inner.reduce((sum, k) => sum + (row[k] ?? 0), 0);
      return [key, ...inner.map((k) => row[k] ?? 0), total];
    });
  return table([label, ...inner, 'total'], rows);
}

/**
 * One day as a markdown section (`## <day>`): file bytes and record count, turns by outcome x
 * trigger kind, skip and refusal reasons, actions by name x phase, prompt tokens median and p90
 * with the cached share and the cache-write tokens, `budget.dropped` per section, the limits table (kind, count, total lost),
 * own messages, memory batches and system events. A part that is null prints `N/A`; an empty
 * one prints `none`.
 * @param {string} day
 * @param {object} t  From `tally` or `tallyLog` (`fileBytes` set by the caller when known).
 * @returns {string}
 */
export function renderDay(day, t) {
  const out = [`## ${day}`, ''];
  const isEmpty = (value) => (Array.isArray(value) ? value.length === 0 : Boolean(value) && typeof value === 'object' && Object.keys(value).length === 0);
  const section = (title, value, render) => {
    out.push(`### ${title}`, '');
    if (value === null || value === undefined) out.push(NA);
    else if (isEmpty(value)) out.push('none');
    else out.push(render(value));
    out.push('');
  };
  out.push(`File bytes: ${num(t.fileBytes)}`, `Records: ${num(t.records)}`, '');
  section('Turns by outcome and trigger', t.turns, (v) => crossTable('outcome', v));
  section('Skip and refusal reasons', t.reasons, (v) =>
    table(
      ['outcome', 'reason', 'count'],
      Object.keys(v)
        .sort()
        .flatMap((outcome) =>
          Object.entries(v[outcome])
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([reason, n]) => [outcome, reason, n]),
        ),
    ),
  );
  section('Actions by name and phase', t.actions, (v) => crossTable('action', v));
  const share = t.cached && t.cached.prompt > 0 ? `${((100 * t.cached.cached) / t.cached.prompt).toFixed(1)}%` : NA;
  out.push('### Usage', '');
  out.push(
    table(
      ['measure', 'value'],
      [
        ['requests with usage', Array.isArray(t.prompt) ? t.prompt.length : NA],
        ['prompt tokens median', num(percentile(t.prompt, 50))],
        ['prompt tokens p90', num(percentile(t.prompt, 90))],
        ['cached share', share],
        ['requests reporting cached', t.cached ? t.cached.counted : NA],
        ['cache-write tokens', t.cached?.writeCounted > 0 ? num(t.cached.cacheWrite) : NA],
      ],
    ),
    '',
  );
  section('Budget dropped (items per section)', t.dropped, (v) =>
    table(['section', 'dropped'], Object.entries(v).sort(([a], [b]) => a.localeCompare(b))),
  );
  section('Limits', t.limits === null || t.limits === undefined ? null : limitsTable(t.limits), (rows) =>
    table(['limit', 'count', 'lost'], rows.map((r) => [r.kind, r.count, num(r.lost)])),
  );
  out.push(`Own messages: ${num(t.ownMessages)}`, `Memory batches: ${num(t.memoryBatches)}`, '');
  section('System events', t.system, (v) => table(['event', 'count'], Object.entries(v).sort(([a], [b]) => a.localeCompare(b))));
  return `${out.join('\n').trimEnd()}\n`;
}
