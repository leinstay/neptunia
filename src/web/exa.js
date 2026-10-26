// The Exa search client for web lookup, the second engine beside Brave
// (src/web/brave.js): the same contract, so src/web/lookup.js can try one and
// fall back to the other. Exa answers keyless through its public MCP endpoint
// (the errand agents' `websearch` uses the same provider), so this engine
// needs no subscription; EXA_API_KEY, when given, goes as a bearer header.
//
// Transport: one JSON-RPC 2.0 POST, `method: 'tools/call'`, `params: { name:
// 'web_search_exa', arguments: { query, numResults } }`, with `Accept:
// application/json, text/event-stream`. No `initialize` handshake is needed.
// Shape seen in the live probe of 2026-10-17 (keyless, field names only): HTTP
// 200, `Content-Type: text/event-stream`, no `Mcp-Session-Id` header, one
// `data:` line holding `{ result: { _meta: { 'ai.exa/rateLimited': boolean },
// content: [{ type, text }] }, jsonrpc, id }`. That probe was answered with the
// rate-limit flag set (the free tier was spent on this host), so the shape of a
// successful `content[0].text` was not seen: it is parsed in both documented
// forms -- a JSON string (`{ results: [{ title, url, publishedDate, text |
// snippet | summary | highlights }] }`, or the bare array) or a formatted text
// of `Title:` / `URL:` / `Published Date:` / `Text:` lines per result. The
// live answer's formatted text uses `Title:` / `URL:` / `Published:` /
// `Author:` / `Highlights:` followed by page text; both label sets are read.
// A plain JSON body (not a stream) is read the same way.
//
// Items are `{ title, url, snippet, age? }` exactly as Brave's: `age` is Exa's
// published date as it comes (an ISO date string), left out when absent,
// empty or `N/A` (any case);
// snippets are cut to SNIPPET_MAX_CHARS, since Exa returns page text where
// Brave returns a one-line description, and the summary prompt reads them all.
//
// Every call resolves to a result object and never rejects. One warn line per
// failure (`web: exa failed`), carrying the reason and an HTTP status only --
// never the query (it is chat content), never the key, never the URL.

import { log } from '../log.js';
import { clampText } from '../memory/clamp.js';

const ENDPOINT = 'https://mcp.exa.ai/mcp';
const TOOL = 'web_search_exa';
const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;
const DEFAULT_TIMEOUT_MS = 10_000;
const SNIPPET_MAX_CHARS = 600;
const RATE_LIMITED_META = 'ai.exa/rateLimited';

// The line keys of the formatted text form, lower-cased, mapped to the item field they fill
// (null: a known key whose value is not kept, so its line never joins the snippet).
const TEXT_KEYS = new Map([
  ['title', 'title'],
  ['url', 'url'],
  ['link', 'url'],
  ['published date', 'age'],
  ['publisheddate', 'age'],
  ['published', 'age'],
  ['date', 'age'],
  ['text', 'snippet'],
  ['snippet', 'snippet'],
  ['summary', 'snippet'],
  ['highlights', 'snippet'],
  ['content', 'snippet'],
  ['author', null],
  ['id', null],
  ['image', null],
  ['favicon', null],
  ['score', null],
]);
const KEY_LINE = /^\s*([A-Za-z][A-Za-z ]{0,20}?)\s*:\s?(.*)$/;
// A published value that says there is none (`N/A`, any case): no `age`, as when the field is absent.
const NO_DATE = /^n\/a$/i;
const SEPARATOR_LINE = /^\s*(?:-{3,}|={3,}|\*{3,})\s*$/;

/** Collapse whitespace to one line. */
function inlineText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** Whether `value` is an absolute http(s) URL. */
function isWebUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** `count` as an integer in 1..10, 5 when it is not a number. */
function clampCount(count) {
  const n = Math.floor(Number(count));
  if (!Number.isFinite(n)) return DEFAULT_COUNT;
  return Math.min(MAX_COUNT, Math.max(1, n));
}

/** One cleaned item, or null when it has no http(s) url. */
function itemOf({ title, url, snippet, age }) {
  const link = typeof url === 'string' ? url.trim() : '';
  if (!isWebUrl(link)) return null;
  const item = {
    title: inlineText(title),
    url: link,
    snippet: clampText(inlineText(snippet), SNIPPET_MAX_CHARS, { tolerance: 1 }),
  };
  const date = inlineText(age);
  if (date && !NO_DATE.test(date)) item.age = date;
  return item;
}

/** The snippet of a JSON result entry: its text, else its snippet, summary or highlights. */
function entrySnippet(entry) {
  for (const name of ['text', 'snippet', 'summary']) {
    if (typeof entry[name] === 'string' && entry[name].trim()) return entry[name];
  }
  if (Array.isArray(entry.highlights)) return entry.highlights.filter((h) => typeof h === 'string').join(' ');
  return '';
}

/** The items of the JSON form (`{ results: [...] }` or the bare array), or null when `text` is not that form. */
function parseJsonResults(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  const raw = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : null;
  if (!raw) return null;
  return raw
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) =>
      itemOf({ title: entry.title, url: entry.url, snippet: entrySnippet(entry), age: entry.publishedDate })
    );
}

/** The items of the formatted text form: a `Title:` line, or a url line once the entry has one, starts a new entry. */
function parseTextResults(text) {
  const entries = [];
  let current = null;
  let field = null;
  for (const line of text.split(/\r?\n/)) {
    if (SEPARATOR_LINE.test(line)) {
      field = null;
      continue;
    }
    const match = KEY_LINE.exec(line);
    const key = match ? match[1].trim().toLowerCase() : null;
    if (match && TEXT_KEYS.has(key)) {
      const target = TEXT_KEYS.get(key);
      if (
        !current ||
        (target === 'title' && current.title !== undefined) ||
        (target === 'url' && current.url !== undefined)
      ) {
        current = {};
        entries.push(current);
      }
      field = target;
      if (target) current[target] = current[target] ? `${current[target]} ${match[2]}` : match[2];
      continue;
    }
    // A line under a snippet key continues it; any other loose line is dropped.
    if (current && field === 'snippet' && line.trim()) current.snippet = `${current.snippet ?? ''} ${line}`;
  }
  return entries.map(itemOf);
}

/** The cleaned items of one tool answer's text (entries without an http(s) url dropped), at most `count`. */
export function parseExaText(text, count = DEFAULT_COUNT) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const items = parseJsonResults(text.trim()) ?? parseTextResults(text);
  return items.filter(Boolean).slice(0, clampCount(count));
}

/** The first JSON-RPC message of a body that is plain JSON or an event stream of `data:` lines, or null. */
function firstMessage(body) {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try {
      const message = JSON.parse(line.slice(5).trim());
      if (message && (message.result !== undefined || message.error !== undefined)) return message;
    } catch {
      // Not a JSON event; the next one may be.
    }
  }
  return null;
}

/**
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {string} [deps.endpoint]  Exa's MCP endpoint.
 */
export function createExaSearch({ fetchImpl = fetch, endpoint = ENDPOINT } = {}) {
  let nextId = 1;

  /** One warn line (reason, status), then the failure object. */
  function fail(reason, status) {
    const meta = { reason };
    if (status !== undefined) meta.status = status;
    log.warn('web: exa failed', meta);
    return status === undefined ? { ok: false, reason } : { ok: false, reason, status };
  }

  /**
   * One Exa web search. `count` is clamped to 1..10. A blank query fails with
   * `empty` without a request, warned. A search that finds nothing usable is
   * `{ ok: false, reason: 'empty' }` too, but a normal outcome: no warn line.
   * A 429, or an answer flagged rate-limited by Exa, is `rate-limited`; any
   * other non-2xx, an unreadable body or a tool error is `http`. Keyless is
   * the default: there is no `no-key` reason. Never rejects.
   * @param {string} query
   * @param {{ apiKey?: string|null, count?: number, timeoutMs?: number }} [options]
   * @returns {Promise<{ ok: true, results: Array<{ title: string, url: string, snippet: string, age?: string }> }
   *   | { ok: false, reason: 'rate-limited'|'http'|'timeout'|'network'|'empty', status?: number }>}
   */
  async function search(query, { apiKey = null, count = DEFAULT_COUNT, timeoutMs } = {}) {
    const q = typeof query === 'string' ? query.trim() : '';
    if (!q) return fail('empty');

    const n = clampCount(count);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (typeof apiKey === 'string' && apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/call',
      params: { name: TOOL, arguments: { query: q, numResults: n } },
    });

    const waitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, waitMs);
    try {
      const response = await fetchImpl(endpoint, { method: 'POST', headers, body, signal: controller.signal });
      if (!response || typeof response !== 'object') return fail('network');
      if (response.status === 429) return fail('rate-limited', 429);
      if (!response.ok) return fail('http', response.status);
      const message = firstMessage(await response.text());
      if (!message || message.error !== undefined || !message.result) return fail('http', response.status);
      const { result } = message;
      if (result._meta?.[RATE_LIMITED_META] === true) return fail('rate-limited');
      if (result.isError === true) return fail('http', response.status);
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content.find((part) => typeof part?.text === 'string')?.text ?? '';
      const results = parseExaText(text, n);
      // Nothing found is an answer, not a failure: the caller renders it (src/web/lookup.js).
      if (!results.length) return { ok: false, reason: 'empty' };
      return { ok: true, results };
    } catch {
      return fail(timedOut ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  return { search };
}
