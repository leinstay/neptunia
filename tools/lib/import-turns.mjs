// Pure helpers of tools/import-turns.mjs: the owner's CSV of generation ids, what one stored
// generation holds (its system prompt's start, its task line, its output), which generations are
// the persona's reply turns, and which of her posted messages each one produced (a text
// similarity inside a time window after the request). No I/O here.

import { oneLine } from '../../src/memory/clamp.js';

/** How many characters of a generation's system prompt the cache keeps (enough to classify it). */
export const SYSTEM_SAMPLE_CHARS = 200;
/** How many characters of the task line the cache keeps. */
export const TASK_CHARS = 200;
/** How many characters of a system prompt name its kind in the report. */
export const KIND_KEY_CHARS = 48;
/** How much of the reply prefix is compared, so it stays inside the cached sample. */
const PREFIX_CHARS = 120;
/** How long a request is taken to run when the CSV does not say (ms). */
export const DEFAULT_GEN_MS = 120_000;
/** How much earlier than the request a posted message may be dated and still be its answer (clock skew). */
const SKEW_MS = 5_000;
/** The shortest normalised text a split part may be matched by containment. */
const PART_MIN_CHARS = 12;
/** The score a split part (contained whole in a message) gets. */
const PART_SCORE = 0.9;
/** The tags that make an output a reply turn's (prompts/format.md). */
const ACTION_TAG_RE = /<(?:msg|react|skip|draw|gif)\b/i;
/** The columns that may carry a generation's duration in ms, in order of preference. */
const DURATION_COLUMNS = ['generation_time_ms', 'generation_time', 'latency_ms', 'latency'];

/**
 * A CSV text (RFC 4180: quoted fields, doubled quotes, commas and line breaks inside quotes,
 * CRLF or LF, an optional BOM) as one object per row keyed by the header's names. Empty rows
 * are left out.
 * @param {string} text
 * @returns {Array<Record<string, string>>}
 */
export function parseCsv(text) {
  const source = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
  if (!header) return [];
  const names = header.map((name) => name.trim());
  return body.map((cells) => Object.fromEntries(names.map((name, i) => [name, cells[i] ?? ''])));
}

/**
 * A CSV time (`YYYY-MM-DD HH:MM:SS.mmm`, UTC, or an ISO time) as epoch ms, else null.
 * @param {unknown} value
 * @returns {number|null}
 */
export function csvTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d/.test(text) ? `${text.replace(' ', 'T')}${/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? '' : 'Z'}` : text;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** The duration in ms one CSV row names (DURATION_COLUMNS), else null. */
function durationOf(row) {
  for (const column of DURATION_COLUMNS) {
    const n = Number(row[column]);
    if (row[column] !== undefined && String(row[column]).trim() !== '' && Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

/**
 * The generations of the CSV rows: `{ id, createdAt, genMs, keyName }`, oldest first, each id
 * once (its first row), only those with a readable time in `[fromMs, toMs)` and, with
 * `keyName`, of that `api_key_name`.
 * @param {Array<Record<string, string>>} rows
 * @param {{ fromMs?: number|null, toMs?: number|null, keyName?: string|null }} [bounds]
 * @returns {Array<{ id: string, createdAt: number, genMs: number|null, keyName: string|null }>}
 */
export function generationsOf(rows, { fromMs = null, toMs = null, keyName = null } = {}) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.generation_id ?? '').trim();
    const createdAt = csvTime(row?.created_at);
    if (!id || seen.has(id) || createdAt === null) continue;
    if (Number.isFinite(fromMs) && createdAt < fromMs) continue;
    if (Number.isFinite(toMs) && createdAt >= toMs) continue;
    const key = typeof row.api_key_name === 'string' && row.api_key_name ? row.api_key_name : null;
    if (keyName && key !== keyName) continue;
    seen.add(id);
    out.push({ id, createdAt, genMs: durationOf(row), keyName: key });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** The text of a message content: a string, or the text parts joined. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).join('');
  return '';
}

/** The output text of a stored generation's `output`, from the shapes it may take; null when none is found. */
function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const last = [...output].reverse().find((item) => item && (item.role === 'assistant' || item.content !== undefined || typeof item.text === 'string'));
    return last ? outputText(last) : null;
  }
  if (!output || typeof output !== 'object') return null;
  if (Array.isArray(output.choices)) return outputText(output.choices[0]?.message ?? output.choices[0]?.text ?? null);
  for (const key of ['completion', 'text', 'content']) {
    const value = output[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const text = textOf(value);
      if (text) return text;
    }
  }
  if (output.message) return outputText(output.message);
  return null;
}

/**
 * What a stored generation (`GET /api/v1/generation/content` body) holds for the import: the
 * system prompt's text, the first line of the last `<task>` block of the last user message
 * (cut at TASK_CHARS), and the output text. Each is null when not found.
 * @param {unknown} body
 * @returns {{ system: string|null, task: string|null, output: string|null }}
 */
export function contentOf(body) {
  const data = body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data : body;
  const messages = Array.isArray(data?.input?.messages) ? data.input.messages : [];
  const systemMessage = messages.find((message) => message?.role === 'system');
  const system = systemMessage ? textOf(systemMessage.content) : null;
  const user = [...messages].reverse().find((message) => message?.role === 'user');
  const userText = user ? textOf(user.content) : '';
  const at = userText.lastIndexOf('<task>');
  const taskLine = at >= 0 ? userText.slice(at + '<task>'.length).replace(/^\s+/, '').split('\n')[0].replace(/<\/task>.*$/, '').trim() : '';
  const output = data && typeof data === 'object' ? outputText(data.output ?? data.completion ?? null) : null;
  return {
    system: system || null,
    task: taskLine ? Array.from(taskLine).slice(0, TASK_CHARS).join('') : null,
    output: typeof output === 'string' ? output : null,
  };
}

/**
 * The shape of a value for a log line: object keys and value types, arrays as their length and
 * first item's shape, never a value (no text leaves through it).
 * @param {unknown} value
 * @param {number} [depth=4]
 * @returns {unknown}
 */
export function shapeOf(value, depth = 4) {
  if (Array.isArray(value)) return depth > 0 && value.length > 0 ? [`array(${value.length})`, shapeOf(value[0], depth - 1)] : `array(${value.length})`;
  if (value && typeof value === 'object') {
    if (depth <= 0) return 'object';
    return Object.fromEntries(Object.keys(value).slice(0, 30).map((key) => [key, shapeOf(value[key], depth - 1)]));
  }
  return value === null ? 'null' : typeof value;
}

/**
 * The cache entry of one fetched generation: its time, duration, the start of its system prompt
 * (SYSTEM_SAMPLE_CHARS), its task line and its output text; never the rest of the input.
 * @param {{ id: string, createdAt: number, genMs: number|null }} gen
 * @param {{ system: string|null, task: string|null, output: string|null }} content
 * @returns {object}
 */
export function cacheEntryOf(gen, content) {
  return {
    v: 1,
    id: gen.id,
    status: 'ok',
    createdAt: new Date(gen.createdAt).toISOString(),
    genMs: Number.isFinite(gen.genMs) ? gen.genMs : null,
    system: typeof content.system === 'string' ? Array.from(content.system.trimStart()).slice(0, SYSTEM_SAMPLE_CHARS).join('') : null,
    task: content.task ?? null,
    output: content.output,
  };
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a system prompt sample is the reply system prompt: it starts with `prefix` (its first
 * PREFIX_CHARS characters) when given; else with the first line of `template`
 * (prompts/system-prompt.md as the live layers have it) rendered with `name`, or, without a
 * name, with `{{name}}` standing for any short run of characters.
 * @param {{ prefix?: string|null, template?: string|null, name?: string|null }} options
 * @returns {(system: string|null) => boolean}
 */
export function replyMatcher({ prefix = null, template = null, name = null } = {}) {
  if (typeof prefix === 'string' && prefix.trim()) {
    const head = prefix.trimStart().slice(0, PREFIX_CHARS);
    return (system) => typeof system === 'string' && system.trimStart().startsWith(head);
  }
  const firstLine = String(template ?? '').trimStart().split('\n')[0].trim();
  if (!firstLine) return () => false;
  if (typeof name === 'string' && name) {
    const head = firstLine.replace(/\{\{name\}\}/g, name).slice(0, PREFIX_CHARS);
    return (system) => typeof system === 'string' && system.trimStart().startsWith(head);
  }
  // The name becomes a NUL so the cut cannot fall inside the placeholder.
  const pieces = firstLine.replace(/\{\{name\}\}/g, '\u0000').slice(0, PREFIX_CHARS).split('\u0000');
  const re = new RegExp(`^${pieces.map(escapeRe).join('[^\\n]{1,64}?')}`);
  return (system) => typeof system === 'string' && re.test(system.trimStart());
}

/**
 * A cached generation's kind: `reply` when its system prompt is the reply one (`isReply`) and its
 * output holds an action tag (`<msg`, `<react`, `<skip`, `<draw`, `<gif`), else `other`.
 * @param {{ system: string|null, output: string|null }} entry
 * @param {(system: string|null) => boolean} isReply
 * @returns {'reply'|'other'}
 */
export function classify(entry, isReply) {
  return isReply(entry?.system ?? null) && typeof entry?.output === 'string' && ACTION_TAG_RE.test(entry.output) ? 'reply' : 'other';
}

/**
 * What names a non-reply generation's kind in the report: the first KIND_KEY_CHARS characters of
 * its system prompt on one line, `(no system prompt)` without one.
 * @param {{ system: string|null }} entry
 * @returns {string}
 */
export function kindKey(entry) {
  const text = typeof entry?.system === 'string' ? oneLine(entry.system) : '';
  return text ? Array.from(text).slice(0, KIND_KEY_CHARS).join('') : '(no system prompt)';
}

/**
 * A message text as the matching compares it: Unicode-normalised and lowercased; a custom emoji
 * (`<:name:id>`) and a shortcode (`:name:`) become their name; user, role and channel mention
 * tokens and `@name` words go (the model writes `@name`, the post carries `<@id>`); anything but
 * letters and digits becomes one space.
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeForMatch(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/<a?:([a-z0-9_]+):\d+>/g, ' $1 ')
    .replace(/<(?:@[!&]?|#)\d+>/g, ' ')
    .replace(/(^|\s)@[^\s]+/gu, ' ')
    .replace(/:([a-z0-9_]{2,32}):/g, ' $1 ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The character bigrams of a string with their counts. */
function bigrams(text) {
  const out = new Map();
  const chars = Array.from(text);
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const key = chars[i] + chars[i + 1];
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/**
 * How alike two message texts are, 0..1: the Dice coefficient of their normalised texts'
 * character bigrams; a text of at least PART_MIN_CHARS normalised characters contained whole in
 * the other (a long message the bot split into parts) scores at least PART_SCORE.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function similarity(a, b) {
  const x = normalizeForMatch(a);
  const y = normalizeForMatch(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const part = short.length >= PART_MIN_CHARS && long.includes(short) ? PART_SCORE : 0;
  const bx = bigrams(x);
  const by = bigrams(y);
  let shared = 0;
  let total = 0;
  for (const [key, count] of bx) {
    shared += Math.min(count, by.get(key) ?? 0);
    total += count;
  }
  for (const count of by.values()) total += count;
  const dice = total > 0 ? (2 * shared) / total : 0;
  return Math.max(dice, part);
}

/** Whether `part` is a split part of `whole`: shorter, at least PART_MIN_CHARS normalised, contained whole. */
function isPartOf(whole, part) {
  const x = normalizeForMatch(whole);
  const y = normalizeForMatch(part);
  return y.length >= PART_MIN_CHARS && y.length < x.length && x.includes(y);
}

/**
 * Which of the persona's posted messages each reply turn produced. `turns`: `{ id, createdAt,
 * genMs, messages: string[] }` (the `<msg>` texts); `lines`: her messages from the record, `{
 * messageId, at, channelId, privateUserId?, text }`. Turns are taken oldest first; a message
 * posted within `[createdAt - 5 s, createdAt + genMs (else DEFAULT_GEN_MS) + slackMs]` and not
 * yet taken by an earlier turn is a candidate; each `<msg>` takes its best candidate scoring at
 * least `minSimilarity` (the earliest on a tie), plus any further candidate that is a split part
 * of it; the turn keeps only the matches in the channel of its best one. Pure.
 * @param {Array<{ id: string, createdAt: number, genMs?: number|null, messages: string[] }>} turns
 * @param {Array<{ messageId: string, at: number, channelId: string|null, privateUserId?: string|null, text: string }>} lines
 * @param {{ slackMs: number, minSimilarity: number }} options
 * @returns {Map<string, { posted: Array<{ messageId: string, at: number }>, channelId: string|null,
 *   privateUserId: string|null, scores: number[], lines: object[] }>}
 */
export function matchTurns(turns, lines, { slackMs, minSimilarity }) {
  const sorted = [...(Array.isArray(lines) ? lines : [])].filter((line) => Number.isFinite(line?.at)).sort((a, b) => a.at - b.at);
  const used = new Set();
  const out = new Map();
  const firstAtOrAfter = (ms) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].at < ms) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (const turn of [...(Array.isArray(turns) ? turns : [])].sort((a, b) => a.createdAt - b.createdAt)) {
    const end = turn.createdAt + (Number.isFinite(turn.genMs) ? turn.genMs : DEFAULT_GEN_MS) + slackMs;
    const candidates = [];
    for (let i = firstAtOrAfter(turn.createdAt - SKEW_MS); i < sorted.length && sorted[i].at <= end; i += 1) {
      if (!used.has(sorted[i].messageId)) candidates.push(sorted[i]);
    }
    const pairs = []; // { line, score }
    const taken = new Set();
    for (const text of Array.isArray(turn.messages) ? turn.messages : []) {
      const scored = candidates
        .filter((line) => !taken.has(line.messageId))
        .map((line) => ({ line, score: similarity(text, line.text) }))
        .filter((pair) => pair.score >= minSimilarity);
      if (scored.length === 0) continue;
      const best = scored.reduce((top, pair) => (pair.score > top.score ? pair : top));
      for (const pair of scored) {
        if (pair === best || isPartOf(text, pair.line.text)) {
          pairs.push(pair);
          taken.add(pair.line.messageId);
        }
      }
    }
    let kept = [];
    if (pairs.length > 0) {
      const top = pairs.reduce((best, pair) => (pair.score > best.score ? pair : best));
      const place = (line) => `${line.privateUserId ?? ''}/${line.channelId ?? ''}`;
      kept = pairs.filter((pair) => place(pair.line) === place(top.line)).sort((a, b) => a.line.at - b.line.at);
    }
    for (const pair of kept) used.add(pair.line.messageId);
    out.set(turn.id, {
      posted: kept.map((pair) => ({ messageId: pair.line.messageId, at: pair.line.at })),
      channelId: kept[0]?.line.channelId ?? null,
      privateUserId: kept[0]?.line.privateUserId ?? null,
      scores: kept.map((pair) => Math.round(pair.score * 100) / 100),
      lines: kept.map((pair) => pair.line),
    });
  }
  return out;
}
