// The pure part of tools/search-compare.mjs: the queries file read and checked, one run's
// outcome classified, the runs summed up per engine (counts, reasons, latency percentiles,
// cost, the queries one engine answered and another did not), the blind sheet for the owner with
// its letters shuffled per query by a seeded random, and the scorer of a filled blind sheet
// (tools/replay-score.mjs --search). No I/O, no clock, no model.

import { createHash } from 'node:crypto';
import { percentile } from './recall-eval.mjs';

/** The engine every other one is scored against on the blind sheet. */
export const BASELINE_ENGINE = 'brave';
/** The grades a letter may get on the blind sheet's score line, as numbers (a number is read as is). */
const GRADES = Object.freeze({ good: 2, ok: 1, bad: 0 });
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SECTION_HEAD = /^## query (.+)$/;
const SCORE_LINE = /^score:\s*(.*)$/i;
const BEST_LINE = /^best:\s*([A-Z])\s*$/i;

/** One line: whitespace collapsed, trimmed. */
function flat(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** What is wrong with one parsed queries row (`seen`: the ids before it), or null. */
function rowProblem(row, seen) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return 'not an object';
  const id = typeof row.id === 'number' || (typeof row.id === 'string' && row.id.trim()) ? flat(row.id) : null;
  if (!id) return 'no id';
  if (seen.has(id)) return `duplicate id ${id}`;
  if (typeof row.query !== 'string' || !row.query.trim()) return 'no query';
  if (row.asked !== undefined && typeof row.asked !== 'string') return 'asked must be a string';
  if (row.note !== undefined && typeof row.note !== 'string') return 'note must be a string';
  return null;
}

/**
 * The queries file's JSONL text as rows `{ id, query, asked, note }`, checked: an id (string or
 * number, unique, one line), a non-empty query, `asked` and `note` strings when given (absent:
 * ''). Blank lines are skipped. `errors` names each bad line by its number.
 * @param {string} text
 * @returns {{ rows: { id: string, query: string, asked: string, note: string }[], errors: string[] }}
 */
export function parseQueries(text) {
  const rows = [];
  const errors = [];
  const seen = new Set();
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    const where = `line ${i + 1}`;
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      errors.push(`${where}: not JSON`);
      continue;
    }
    const problem = rowProblem(row, seen);
    if (problem) {
      errors.push(`${where}: ${problem}`);
      continue;
    }
    const id = flat(row.id);
    seen.add(id);
    rows.push({
      id,
      query: row.query,
      asked: typeof row.asked === 'string' ? row.asked : '',
      note: typeof row.note === 'string' ? row.note : '',
    });
  }
  return { rows, errors };
}

/**
 * The class of one run: `skipped` (the engine could not run), `answered` (ok with a text),
 * `empty` (ok, nothing found) or `failed`.
 * @param {{ ok: boolean, reason: string|null, text?: string }} result
 * @returns {'skipped'|'answered'|'empty'|'failed'}
 */
export function outcomeOf(result) {
  if (result.reason === 'skipped') return 'skipped';
  if (!result.ok) return 'failed';
  return result.text ? 'answered' : 'empty';
}

/** A function returning floats in [0, 1) from a 32-bit seed (mulberry32); tools/lib/diary-day.mjs uses it too. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `items` in a random order that depends only on `seed` and `id` (Fisher-Yates over a mulberry32
 * seeded by the sha1 of `seed` and `id`): the same run shuffles every query the same way, whatever
 * the order the queries come in.
 * @template T
 * @param {T[]} items
 * @param {string} seed
 * @param {string} id
 * @returns {T[]}
 */
export function seededShuffle(items, seed, id) {
  const digest = createHash('sha1').update(`${seed}\u0000${id}`).digest();
  const rng = mulberry32(digest.readUInt32BE(0));
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The run summed up per engine from its results (`{ id, engine, ok, reason, ms_search,
 * ms_summary, ms_total, results, cost, text, sources, run? }`): counts per outcome, the failure
 * reasons, p50/p95 of the search step, the summary and the whole step (skipped runs left out),
 * the summed cost and the cost per run, and, over each query's first run, the queries one engine
 * answered and another (not skipped) did not.
 * @param {object[]} results
 * @param {string[]} engines  In report order.
 * @returns {{ engines: object[], gaps: { answered: string, missed: string, ids: string[] }[], costUsd: number }}
 */
export function summarize(results, engines) {
  const per = engines.map((engine) => {
    const runs = results.filter((r) => r.engine === engine);
    const counts = { answered: 0, empty: 0, failed: 0, skipped: 0 };
    const reasons = new Map();
    for (const r of runs) {
      const outcome = outcomeOf(r);
      counts[outcome] += 1;
      if (outcome === 'failed') reasons.set(r.reason ?? 'unknown', (reasons.get(r.reason ?? 'unknown') ?? 0) + 1);
    }
    const timed = runs.filter((r) => outcomeOf(r) !== 'skipped');
    const ms = (field) => timed.map((r) => r[field]).filter(Number.isFinite);
    const p = (field) => ({ p50: percentile(ms(field), 50), p95: percentile(ms(field), 95) });
    const costUsd = timed.reduce((sum, r) => sum + (Number(r.cost) || 0), 0);
    return {
      engine,
      runs: runs.length,
      ...counts,
      reasons: [...reasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
      search: p('ms_search'),
      summary: p('ms_summary'),
      total: p('ms_total'),
      costUsd,
      costPerRun: timed.length > 0 ? costUsd / timed.length : null,
    };
  });

  const first = new Map();
  for (const r of results) {
    const key = `${r.engine}\u0000${r.id}`;
    if (!first.has(key)) first.set(key, outcomeOf(r));
  }
  const ids = [...new Set(results.map((r) => r.id))];
  const gaps = [];
  for (const a of engines) {
    for (const b of engines) {
      if (a === b) continue;
      const missedIds = ids.filter((id) => {
        const oa = first.get(`${a}\u0000${id}`);
        const ob = first.get(`${b}\u0000${id}`);
        return oa === 'answered' && (ob === 'empty' || ob === 'failed');
      });
      if (missedIds.length > 0) gaps.push({ answered: a, missed: b, ids: missedIds });
    }
  }
  return { engines: per, gaps, costUsd: per.reduce((sum, e) => sum + e.costUsd, 0) };
}

/** A table cell: one line, `|` escaped. */
function cell(value) {
  return flat(value).replace(/\|/g, '\\|');
}

/** A duration in ms, or `-`. */
function msOf(value) {
  return Number.isFinite(value) ? String(Math.round(value)) : '-';
}

/**
 * The markdown summary of a run (summarize's result); `meta`: `{ at, queries, engines, repeat,
 * seed, rows, notRun, stopped }` for the head.
 * @param {ReturnType<typeof summarize>} summary
 * @param {{ at?: string, queries?: string, repeat?: number, seed?: string, rows?: number, notRun?: number, stopped?: string|null }} [meta]
 * @returns {string}
 */
export function renderSummary(
  summary,
  { at = '', queries = '', repeat = 1, seed = '', rows = 0, notRun = 0, stopped = null } = {}
) {
  const out = ['# Search comparison', ''];
  if (at) out.push(`- at: ${at}`);
  if (queries) out.push(`- queries: ${queries}`);
  out.push(`- engines: ${summary.engines.map((e) => e.engine).join(', ')}`);
  out.push(
    `- rows: ${rows}${notRun > 0 ? `, ${notRun} not run (${stopped ?? 'stopped'})` : ''}; runs per query and engine: ${repeat}`
  );
  if (seed) out.push(`- blind seed: ${seed}`);
  out.push(`- cost: ${summary.costUsd.toFixed(4)} USD`);
  out.push('', '## Per engine', '');
  out.push(
    '| engine | runs | answered | empty | failed | skipped | search p50 | search p95 | summary p50 | summary p95 | total p50 | total p95 | cost USD | per run USD |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
  );
  for (const e of summary.engines) {
    out.push(
      `| ${e.engine} | ${e.runs} | ${e.answered} | ${e.empty} | ${e.failed} | ${e.skipped} | ${msOf(e.search.p50)} | ${msOf(e.search.p95)} | ${msOf(e.summary.p50)} | ${msOf(e.summary.p95)} | ${msOf(e.total.p50)} | ${msOf(e.total.p95)} | ${e.costUsd.toFixed(4)} | ${e.costPerRun === null ? '-' : e.costPerRun.toFixed(4)} |`
    );
  }
  out.push(
    '',
    "Times in ms. search: the engine's own request (for `openrouter`, the one request that searches and summarizes); summary: the summary request; total: the whole search step."
  );
  out.push('', '## Failures', '');
  const failures = summary.engines.flatMap((e) => e.reasons.map((r) => ({ engine: e.engine, ...r })));
  if (failures.length === 0) out.push('None.');
  else {
    out.push('| engine | reason | runs |', '|---|---|---:|');
    for (const f of failures) out.push(`| ${f.engine} | ${cell(f.reason)} | ${f.count} |`);
  }
  out.push('', '## Answered by one engine, not by another (first run)', '');
  if (summary.gaps.length === 0) out.push('None.');
  else {
    out.push('| answered | not answered | queries | ids |', '|---|---|---:|---|');
    for (const g of summary.gaps)
      out.push(`| ${g.answered} | ${g.missed} | ${g.ids.length} | ${g.ids.map(cell).join(', ')} |`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * The blind sheet and its key from the first run of each query and engine: per query that at
 * least one engine answered, the question (`asked`, else the query) and the answers with their
 * source sites, under letters shuffled by seededShuffle(seed, id), then one score line
 * `score: A = ?, B = ?` for the owner to fill. The key maps each id to `{ A: engine, ... }`.
 * @param {{ id: string, query: string, asked: string }[]} rows  In sheet order.
 * @param {object[]} results
 * @param {string[]} engines
 * @param {string} seed
 * @returns {{ markdown: string, key: Record<string, Record<string, string>> }}
 */
export function renderBlind(rows, results, engines, seed) {
  const firstAnswer = new Map();
  for (const r of results) {
    const key = `${r.engine}\u0000${r.id}`;
    if (!firstAnswer.has(key)) firstAnswer.set(key, outcomeOf(r) === 'answered' ? r : null);
  }
  const out = [
    '# Blind search comparison',
    '',
    'For each query, read the answers, then replace each `?` on its `score:` line with `good`, `ok` or `bad` (or a',
    'number: higher is better). A line `best: <letter>` instead says that answer beats the others, which tie. Leave a',
    '`?` to skip one. Then: `node tools/replay-score.mjs --search blind.md blind-key.json`.',
  ];
  const key = {};
  for (const row of rows) {
    const answers = engines.map((engine) => firstAnswer.get(`${engine}\u0000${row.id}`)).filter(Boolean);
    if (answers.length === 0) continue;
    const shuffled = seededShuffle(answers, seed, row.id);
    const letters = shuffled.map((_, i) => LETTERS[i]);
    key[row.id] = Object.fromEntries(shuffled.map((r, i) => [letters[i], r.engine]));
    out.push('', `## query ${flat(row.id)}`, '', `Question: ${flat(row.asked || row.query)}`);
    shuffled.forEach((r, i) => {
      const sites = [...new Set((r.sources ?? []).map((s) => flat(s.site || s.url)).filter(Boolean))];
      out.push('', `### ${letters[i]}`, '', `> ${flat(r.text)}`);
      if (sites.length > 0) out.push('', `Sources: ${sites.join(', ')}`);
    });
    out.push('', `score: ${letters.map((l) => `${l} = ?`).join(', ')}`);
  }
  return { markdown: `${out.join('\n')}\n`, key };
}

/** A grade as a number, or null (`?`, blank, unknown word). */
function gradeOf(value) {
  const v = flat(value).toLowerCase();
  if (v in GRADES) return GRADES[v];
  if (v !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * The grades of a filled blind sheet: per query id, `{ letter: number }` for the letters graded
 * (a `score:` line wins over a `best:` line in the same section; `best: X` grades X 1 and the
 * section's other letters 0).
 * @param {string} markdown
 * @returns {Record<string, Record<string, number>>}
 */
export function parseBlindScores(markdown) {
  const scores = {};
  let id = null;
  let letters = [];
  let score = null;
  let best = null;
  const close = () => {
    if (id === null) return;
    if (score && Object.keys(score).length > 0) scores[id] = score;
    else if (best && letters.includes(best))
      scores[id] = Object.fromEntries(letters.map((l) => [l, l === best ? 1 : 0]));
  };
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const head = SECTION_HEAD.exec(line);
    if (head) {
      close();
      id = head[1].trim();
      letters = [];
      score = null;
      best = null;
      continue;
    }
    if (id === null) continue;
    const letter = /^### ([A-Z])\s*$/.exec(line);
    if (letter) letters.push(letter[1]);
    const scoreLine = SCORE_LINE.exec(line);
    if (scoreLine) {
      score = {};
      for (const part of scoreLine[1].split(',')) {
        const m = /^\s*([A-Z])\s*=\s*(.*?)\s*$/i.exec(part);
        if (!m) continue;
        const grade = gradeOf(m[2]);
        if (grade !== null) score[m[1].toUpperCase()] = grade;
      }
    }
    const bestLine = BEST_LINE.exec(line);
    if (bestLine) best = bestLine[1].toUpperCase();
  }
  close();
  return scores;
}

/**
 * The blind grades tallied per engine against `baseline`: for each query whose key shows both,
 * a win when the engine's grade is higher, a tie when equal, a loss when lower, unscored when
 * either is not graded; `noBaseline` counts the queries the engine answered and the baseline
 * did not (not on the sheet). A query of the scores missing from the key is an Error.
 * @param {{ key: Record<string, Record<string, string>>, scores: Record<string, Record<string, number>>, baseline?: string }} input
 * @returns {{ baseline: string, queries: number, scored: number, engines: { engine: string, win: number, tie: number, lose: number, unscored: number, noBaseline: number }[] }}
 */
export function tallySearchScores({ key, scores, baseline = BASELINE_ENGINE }) {
  for (const id of Object.keys(scores ?? {})) {
    if (!key?.[id]) throw new Error(`query ${id} is not in the key`);
  }
  const rows = new Map();
  const rowOf = (engine) => {
    if (!rows.has(engine)) rows.set(engine, { engine, win: 0, tie: 0, lose: 0, unscored: 0, noBaseline: 0 });
    return rows.get(engine);
  };
  let scored = 0;
  const ids = Object.keys(key ?? {});
  for (const id of ids) {
    const letters = key[id] ?? {};
    const byEngine = Object.fromEntries(Object.entries(letters).map(([letter, engine]) => [engine, letter]));
    const grades = scores?.[id] ?? {};
    if (Object.keys(grades).length > 0) scored += 1;
    for (const [engine, letter] of Object.entries(byEngine)) {
      if (engine === baseline) continue;
      const row = rowOf(engine);
      const base = byEngine[baseline];
      if (base === undefined) {
        row.noBaseline += 1;
        continue;
      }
      const mine = grades[letter];
      const theirs = grades[base];
      if (!Number.isFinite(mine) || !Number.isFinite(theirs)) row.unscored += 1;
      else if (mine > theirs) row.win += 1;
      else if (mine < theirs) row.lose += 1;
      else row.tie += 1;
    }
  }
  return {
    baseline,
    queries: ids.length,
    scored,
    engines: [...rows.values()].sort((a, b) => a.engine.localeCompare(b.engine)),
  };
}

/** `n` of `of` as `p%`, `-` when `of` is 0. */
function pct(n, of) {
  return of > 0 ? `${Math.round((n / of) * 100)}%` : '-';
}

/**
 * The markdown of tallySearchScores' result.
 * @param {ReturnType<typeof tallySearchScores>} tally
 * @returns {string}
 */
export function renderSearchTally(tally) {
  const out = [
    '# Search blind scores',
    '',
    `Against: ${tally.baseline}`,
    `Queries on the sheet: ${tally.queries}, scored: ${tally.scored}`,
    '',
  ];
  out.push(
    '| engine | win | tie | lose | win or tie | lose | unscored | no baseline answer |',
    '|---|---:|---:|---:|---:|---:|---:|---:|'
  );
  for (const e of tally.engines) {
    const pairs = e.win + e.tie + e.lose;
    out.push(
      `| ${e.engine} | ${e.win} | ${e.tie} | ${e.lose} | ${pct(e.win + e.tie, pairs)} | ${pct(e.lose, pairs)} | ${e.unscored} | ${e.noBaseline} |`
    );
  }
  return `${out.join('\n')}\n`;
}
