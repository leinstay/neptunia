// The pure part of tools/search-policy-eval.mjs: the labelled sheet read and checked, one row
// turned into the chat a live turn would show the search classifier, the classifier's parsed
// answer mapped to a decision, and the run summed up into the confusion matrix, the agreement
// and the disagreements. No I/O, no clock, no model.

import { percentile } from './recall-eval.mjs';

/** The tiers a row may be labelled with, in the matrix's order. */
export const TIERS = Object.freeze(['none', 'fast', 'memory', 'agent']);
/** The decisions a row may get: a tier, or `failed` (the call threw, or answered nothing). */
export const DECISIONS = Object.freeze([...TIERS, 'failed']);

const MINUTE_MS = 60_000;
/** The author name of a line or a question the sheet does not name (as tools/recall-eval.mjs names an unknown asker). */
const NO_AUTHOR = '-';

/** What is wrong with one parsed sheet row (`seen`: the ids before it), or null. */
function rowProblem(row, seen) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return 'not an object';
  const id = typeof row.id === 'number' || (typeof row.id === 'string' && row.id) ? String(row.id) : null;
  if (!id) return 'no id';
  if (seen.has(id)) return `duplicate id ${id}`;
  if (typeof row.question !== 'string' || !row.question.trim()) return 'no question';
  if (!TIERS.includes(row.tier)) return `tier must be one of ${TIERS.join(', ')}`;
  if (row.source !== undefined && typeof row.source !== 'string') return 'source must be a string';
  const context = row.context ?? [];
  const lineOk = (c) => c && typeof c === 'object' && typeof c.text === 'string' && (c.author === undefined || typeof c.author === 'string');
  if (!Array.isArray(context) || !context.every(lineOk)) return 'context must be [{ author, text }]';
  return null;
}

/**
 * The sheet's JSONL text as rows `{ id, source, question, context: [{ author, text }], tier,
 * note, author? }`, checked: an id (string or number, unique), a non-empty question, a tier of
 * TIERS, a source string, `context` an array of `{ author, text }` strings (absent: []). Blank
 * lines are skipped. `errors` names each bad line by its number.
 * @param {string} text
 * @returns {{ rows: object[], errors: string[] }}
 */
export function parseSheet(text) {
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
    const id = String(row.id);
    seen.add(id);
    rows.push({
      id,
      source: row.source ?? '',
      question: row.question,
      context: (row.context ?? []).map((c) => ({ author: c.author ?? '', text: c.text })),
      tier: row.tier,
      note: typeof row.note === 'string' ? row.note : '',
      ...(typeof row.author === 'string' && row.author.trim() ? { author: row.author.trim() } : {}),
    });
  }
  return { rows, errors };
}

/** A chat message in the shape the transcript renders (src/format.js), as tools/recall-eval.mjs builds its trigger. */
function chatMessage({ id, authorName, content, ts, self }) {
  return {
    id,
    channelId: 'search-policy-eval',
    authorId: self ? 'self' : `author:${authorName}`,
    authorName,
    self,
    bot: false,
    content,
    ts,
    replyToId: null,
    mentionedUserIds: [],
    attachments: [],
    links: [],
    stickers: [],
    emojis: [],
    forwarded: [],
    reactions: [],
  };
}

/**
 * One row as the chat a live turn would show the search classifier: its `context` lines one
 * minute apart before `now` (a line whose author is `selfName`, any case, is the persona's own),
 * then the question as the trigger at `now`, by the row's `author` or `-`.
 * @param {{ id: string, question: string, context: { author: string, text: string }[], author?: string }} row
 * @param {{ now: number, selfName: string }} options
 * @returns {{ history: object[], trigger: object }}
 */
export function rowChat(row, { now, selfName }) {
  const own = String(selfName ?? '').toLowerCase();
  const context = row.context ?? [];
  const history = context.map((line, i) => {
    const authorName = line.author?.trim() || NO_AUTHOR;
    return chatMessage({ id: `${row.id}:${i + 1}`, authorName, content: line.text, ts: now - (context.length - i) * MINUTE_MS, self: own !== '' && authorName.toLowerCase() === own });
  });
  const trigger = chatMessage({ id: `${row.id}:q`, authorName: row.author ?? NO_AUTHOR, content: row.question, ts: now, self: false });
  return { history: [...history, trigger], trigger };
}

/**
 * The classifier's decision from its parsed answer (src/behavior/recall.js#parseLookupAnswer):
 * an `agent:` task -> `agent`; a `web:` query -> `fast`; a
 * server part (`server:`, `who:` or a range) without `web:` -> `memory`; nothing -> `none`.
 * @param {{ web?: string|null, server?: object|null, agent?: unknown }|null} parsed
 * @returns {'none'|'fast'|'memory'|'agent'}
 */
export function decisionOf(parsed) {
  if (parsed?.agent) return 'agent';
  if (parsed?.web) return 'fast';
  if (parsed?.server) return 'memory';
  return 'none';
}

/** The classifier's query of a result, for the disagreement list: the web query, else the forms and names. */
function queryText(result) {
  if (result.query) return result.query;
  const parts = [...(result.forms ?? []), ...(result.who ?? [])];
  return parts.length > 0 ? parts.join(', ') : '';
}

/**
 * The run summed up from its per-row results (`{ id, source, tier, decision, query, forms, who,
 * ms, ok, costUsd }`): the confusion matrix tier x decision, the agreement overall and per
 * source, the disagreements in run order, the latency p50/p95, the summed cost, the failed
 * calls, and whether any row was decided `agent`.
 * @param {object[]} results
 * @returns {object}
 */
export function summarize(results) {
  const matrix = Object.fromEntries(TIERS.map((tier) => [tier, Object.fromEntries(DECISIONS.map((d) => [d, 0]))]));
  const bySource = new Map();
  let agreed = 0;
  const disagreements = [];
  for (const r of results) {
    if (matrix[r.tier] && r.decision in matrix[r.tier]) matrix[r.tier][r.decision] += 1;
    const hit = r.decision === r.tier;
    if (hit) agreed += 1;
    else disagreements.push({ id: r.id, tier: r.tier, decision: r.decision, query: queryText(r) });
    const source = r.source || '-';
    const s = bySource.get(source) ?? { rows: 0, agreed: 0 };
    s.rows += 1;
    if (hit) s.agreed += 1;
    bySource.set(source, s);
  }
  const ms = results.map((r) => r.ms);
  return {
    rows: results.length,
    agreed,
    matrix,
    bySource: [...bySource.entries()].map(([source, s]) => ({ source, ...s })),
    disagreements,
    latency: { p50: percentile(ms, 50), p95: percentile(ms, 95) },
    costUsd: results.reduce((sum, r) => sum + (Number(r.costUsd) || 0), 0),
    failed: results.filter((r) => !r.ok).length,
    saidAgent: results.some((r) => r.decision === 'agent'),
  };
}

/** `n` of `of` as `n/of (p%)`. */
function share(n, of) {
  return `${n}/${of} (${of > 0 ? Math.round((n / of) * 100) : 0}%)`;
}

/** A table cell: one line, `|` escaped. */
function cell(value) {
  return String(value ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|');
}

/**
 * The markdown summary of a run (summarize's result); `meta`: `{ at, sheet, model, rows,
 * skipped, stopped }` for the head.
 * @param {object} summary
 * @param {{ at?: string, sheet?: string, model?: string|null, skipped?: number, stopped?: string|null }} [meta]
 * @returns {string}
 */
export function renderSummary(summary, { at = '', sheet = '', model = null, skipped = 0, stopped = null } = {}) {
  const out = ['# Search-policy evaluation', ''];
  if (at) out.push(`- at: ${at}`);
  if (sheet) out.push(`- sheet: ${sheet}`);
  out.push(`- model: ${model ?? '-'}`);
  out.push(`- rows: ${summary.rows}${skipped > 0 ? `, ${skipped} not asked (${stopped ?? 'stopped'})` : ''}; failed calls: ${summary.failed}`);
  out.push(`- agreement: ${share(summary.agreed, summary.rows)}`);
  out.push(`- latency: p50 ${summary.latency.p50 ?? '-'} ms, p95 ${summary.latency.p95 ?? '-'} ms`);
  out.push(`- cost: ${summary.costUsd.toFixed(4)} USD`);
  if (!summary.saidAgent) out.push('', 'The classifier cannot say `agent` today: those rows count as misses.');
  out.push('', '## Confusion matrix (rows: tier, columns: decision)', '');
  out.push(`| tier | ${DECISIONS.join(' | ')} | total |`, `|---|${DECISIONS.map(() => '---:').join('|')}|---:|`);
  for (const tier of TIERS) {
    const row = summary.matrix[tier];
    const total = DECISIONS.reduce((sum, d) => sum + row[d], 0);
    out.push(`| ${tier} | ${DECISIONS.map((d) => row[d]).join(' | ')} | ${total} |`);
  }
  out.push('', '## Agreement per source', '', '| source | agreed |', '|---|---:|');
  for (const s of summary.bySource) out.push(`| ${cell(s.source)} | ${share(s.agreed, s.rows)} |`);
  out.push('', `## Disagreements (${summary.disagreements.length})`, '');
  if (summary.disagreements.length === 0) out.push('None.');
  else {
    out.push('| id | tier | decision | query |', '|---|---|---|---|');
    for (const d of summary.disagreements) out.push(`| ${cell(d.id)} | ${d.tier} | ${d.decision} | ${cell(d.query)} |`);
  }
  return `${out.join('\n')}\n`;
}
