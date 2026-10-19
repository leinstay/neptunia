// The web lookup (features.webLookup, OFF unless set -- it costs money and the
// Brave search needs a key): the persona reads a link posted in the chat, and, when
// asked something that needs facts from outside, runs one web search. Two
// halves, both modelled on the video describer (src/memory/describe.js), and the
// persona's own raw tools beside them:
//
// - readLinks: a normal page link (never a video-site link -- the video
//   describer owns those -- never an embed classified as anything but a link
//   (a gif), never a GIF site's page (src/media/classify.js#isGifHostUrl),
//   never a `web.links.skipSites` host, never a URL whose path ends
//   with a picture/video/audio/archive/pdf extension) is fetched through the
//   SSRF-guarded page fetcher (src/web/fetch-page.js; `web.acceptLanguage`
//   sent as its Accept-Language) and condensed by the helper model (`analyzer`, purpose
//   `read-link`) through prompts/read-link.md into one excerpt of at most
//   `web.links.summaryChars`. With features.coreTools (read now) no helper condenses it:
//   the excerpt is the opening of the page's own extracted text, cut at
//   `web.links.previewChars` -- what a link preview shows -- cached apart
//   (`preview:<link id>`), no model request.
// - search: one web search whose numbered results are condensed through
//   prompts/search-summary.md, sources kept. `web.search.engine` picks the
//   engine: `brave` (src/web/brave.js, needs BRAVE_SEARCH_API_KEY; the
//   default), `exa` (src/web/exa.js, keyless; EXA_API_KEY optional) or
//   `openrouter` (OpenRouter's web plugin on Exa: the summary request itself
//   searches, one request billed to credits, its sources the answer's
//   `url_citation` annotations). `web.search.fallback` lists the engines tried
//   in order when one fails with `rate-limited` (a Brave 429 counts), `timeout`
//   or `network`; never after `empty` (nothing found is an answer, and its
//   summary is never run again) nor any other failure. The daily web slot is
//   taken once per lookup, whatever the attempts; each attempt logs its own
//   `lookup: search` line with `engine` and `fallback` (false for the first).
// - searchResults: the persona's own web.search (src/skills/tools.js): the same engines,
//   fallbacks and daily slot, but the results come back raw -- title, url, site, the
//   engine's snippet and date -- with no summary request. Brave and Exa return them as
//   they are; `openrouter` sends one request with the web plugin and only the query
//   (purpose `web-search` on the analyzer, its answer cut at `web.search.rawOutputTokens`
//   and never read), the results being its `url_citation` annotations with their content.
//   Cached apart (`results:<sha1 prefix>`), served while younger than `web.search.cacheHours`.
// - readPage: the persona's own web.read: one page by url through the same fetcher, its
//   extracted main text (src/web/readable.js) cut at `web.links.readChars`, with its title
//   and final url; no model request. Cached (`page:<sha1 prefix of the url>`) for
//   `web.links.readCacheHours`; a failure is not cached.
//
// Both share the media cache (data/guilds/<id>/media.json, LRU-trimmed to
// `media.cacheEntries`): `read:<link id>` holds an excerpt `{ text, ts }` or a
// miss `{ miss, ts, reason }` skipped for 6 hours (never for a refusal by
// `llm.maxRequestsPerDay`); `search:<sha1 prefix of the
// normalized query>` holds `{ query, text, sources, ts }`, served while younger
// than `web.search.cacheHours`. All share one daily counter
// (`state.data.webDay` / `webCount`, `web.maxPerDay`; a cap that is not a
// finite number counts as 0), reserved before the fetch or the search
// request and kept when either fails. Every model call
// goes through llm.complete (its token cap and daily request cap apply); once
// that daily request cap is spent (llm.capLeft) no page is fetched for a
// condensed read, no search that needs a request is sent and no web slot is taken.
// Logs carry reason codes, counts and `host/path` -- never page text, an
// excerpt, a query or the key.

import { isGifHostUrl, siteOf } from '../media/classify.js';
import { videoSiteFor, safeLocation } from '../media/video-sites.js';
import { roleModel } from '../llm/roles.js';
import { fillPromptTemplate } from '../behavior/prompt.js';
import { dailyCapOf, helperRequestOptions, railReason } from '../llm/openrouter.js';
import { clampText, oneLine } from '../memory/clamp.js';
import { log } from '../log.js';
import { bumpDaily, countToday, dailyCounter, MINUTE_MS, utcDay } from '../time.js';
import { hashedKey, touchKey, trimCache } from './cache.js';
import { truncateText } from './readable.js';

const READ_MISS_TTL_MS = 6 * 60 * MINUTE_MS;
// An answer this short is the read-link prompt's "no real content" signal.
const UNREADABLE_MAX_WORDS = 4;
// Only when a web.* number is missing (config.json always has them).
const LINK_SUMMARY_CHARS_FALLBACK = 700;
const SEARCH_SUMMARY_CHARS_FALLBACK = 900;
const SEARCH_CACHE_HOURS_FALLBACK = 24;
const LINK_PREVIEW_CHARS_FALLBACK = 700;
const PAGE_READ_CHARS_FALLBACK = 4000;
const PAGE_CACHE_HOURS_FALLBACK = 6;
const RAW_OUTPUT_TOKENS_FALLBACK = 256;
const QUERY_MAX_CHARS = 200;
/** The state.json fields of the daily web counter (link reads and searches share it). */
export const WEB_DAILY = { dayKey: 'webDay', countKey: 'webCount' };
// Tab, line feed, vertical tab, form feed, carriage return, NEL, line and paragraph separators.
const QUERY_LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]+/g;
const QUERY_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
// A link to a file, not a page: the reader would only spend an attempt on it.
const BINARY_PATH = /\.(?:png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|mkv|mp3|ogg|wav|zip|rar|7z|pdf)$/i;

/** The search engines `web.search.engine` and `web.search.fallback` may name. */
export const SEARCH_ENGINES = Object.freeze(['brave', 'exa', 'openrouter']);
const DEFAULT_ENGINE = 'brave';
// The failures another engine may answer: the engine itself was busy or unreachable.
const FALLBACK_REASONS = new Set(['rate-limited', 'timeout', 'network']);

/** The engine of the live config: `web.search.engine` when it names one, else `brave`. */
function engineOf(config) {
  const engine = config?.web?.search?.engine;
  return SEARCH_ENGINES.includes(engine) ? engine : DEFAULT_ENGINE;
}

/** Whether a failed attempt may hand over to the next engine (a Brave 429 comes as `http` with the status). */
function fallsBack(failure) {
  return FALLBACK_REASONS.has(failure.reason) || (failure.reason === 'http' && failure.status === 429);
}

/** An `openrouter` engine failure as a search reason: a 429 is `rate-limited`, a timeout `timeout`, a failed fetch `network`, else the rail reason. */
function openrouterFailure(err) {
  if (err?.statusCode === 429) return 'rate-limited';
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timeout';
  if (err?.name === 'TypeError' && err?.statusCode === undefined) return 'network';
  return llmFailure(err);
}

/**
 * The `url_citation` annotations of an answer (OpenRouter's web plugin) as `{ title, url, snippet }`,
 * http(s) urls only, each url once, in order; `title` and `snippet` (the annotation's `content`)
 * collapsed to one line, '' when absent. Shared with the web agent's search command
 * (src/web/web-search.js).
 * @param {unknown} annotations
 * @returns {{ title: string, url: string, snippet: string }[]}
 */
export function urlCitations(annotations) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(annotations) ? annotations : []) {
    if (entry?.type !== 'url_citation') continue;
    const url = typeof entry.url_citation?.url === 'string' ? entry.url_citation.url.trim() : '';
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const content = entry.url_citation.content;
    out.push({ title: oneLine(String(entry.url_citation.title ?? '')), url, snippet: typeof content === 'string' ? oneLine(content) : '' });
  }
  return out;
}

/** The `url_citation` annotations of an answer as `{ title, url }` (urlCitations without the snippet). */
function citationsOf(annotations) {
  return urlCitations(annotations).map(({ title, url }) => ({ title, url }));
}

/**
 * Whether the web lookup is on. Unlike the other `features.*` switches a
 * missing key counts as OFF: it costs money and needs a key.
 */
function webOn(config) {
  return config?.features?.webLookup === true;
}

/**
 * Whether a link posted in the chat is read as a preview (features.coreTools exactly true):
 * the opening of the page's own text, no helper condensing it.
 */
function previewOn(config) {
  return config?.features?.coreTools === true;
}

/** The media cache key of a link's read: `preview:<id>` under previewOn, else `read:<id>`. */
function linkKey(config, link) {
  return `${previewOn(config) ? 'preview' : 'read'}:${link.id}`;
}

/** A positive number from the config, else `fallback`. */
function positiveOr(value, fallback) {
  return typeof value === 'number' && value > 0 ? value : fallback;
}

/** Collapse whitespace, then cap at `maxChars` on a clean boundary. */
function cleanText(raw, maxChars) {
  return clampText(oneLine(raw), maxChars, { tolerance: 1 });
}

/** Whether `url`'s path (query and fragment aside) ends with a file extension the reader skips. */
function isBinaryPath(url) {
  try {
    return BINARY_PATH.test(new URL(String(url)).pathname);
  } catch {
    return false;
  }
}

/** The safety-rail refusals of llm.complete as reason codes; any other failure is `llm`. */
function llmFailure(err) {
  return railReason(err, 'llm');
}

/** A stand-in for the persistent state when none is wired (tests, tools). */
function memoryState() {
  return { data: {}, markDirty() {} };
}

/**
 * A query as the search cache sees it: lower-cased, whitespace-collapsed, trimmed.
 * @param {string} query
 * @returns {string}
 */
export function normalizeQuery(query) {
  return String(query ?? '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * A search query made safe to fill into the search-summary prompt (and to
 * render in the `<lookup>` header): one line (line breaks and tabs become a
 * space), no `<` or `>`, no control characters, trimmed, at most 200
 * UTF-16 units without splitting a surrogate pair. Inner spaces are kept.
 * @param {string} query
 * @returns {string}
 */
export function cleanQuery(query) {
  const flat = String(query ?? '')
    .replace(QUERY_LINE_BREAKS, ' ')
    .replace(QUERY_CONTROLS, '')
    .replace(/[<>]/g, '')
    .trim();
  let out = '';
  for (const point of flat) {
    if (out.length + point.length > QUERY_MAX_CHARS) break;
    out += point;
  }
  return out.trim();
}

/** `web.search.results` as the web plugin's `max_results`: an integer in 1..10, `fallback` (5) when not a number (as the search clients clamp it). */
function clampResults(value, fallback = 5) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : fallback;
}

/**
 * The `plugins` of a request that searches through OpenRouter's web plugin on Exa: the lookup's
 * `openrouter` engine and the web agent's search command (src/web/web-search.js). `results`
 * becomes `max_results`, an integer in 1..10, `fallback` when not a number.
 * @param {unknown} results
 * @param {number} [fallback]
 * @returns {{ id: 'web', engine: 'exa', max_results: number }[]}
 */
export function webSearchPlugins(results, fallback = 5) {
  return [{ id: 'web', engine: 'exa', max_results: clampResults(results, fallback) }];
}

/** The cache key of one search. */
function searchKey(query) {
  return hashedKey('search', normalizeQuery(query));
}

/**
 * Numbered search results as plain lines (data, not wording): the search-summary prompt reads
 * them, and the web agent's search command prints them. Per result `<n>. <title>`, the url, the
 * snippet and the age, each on its own line when present; a blank line between results.
 * @param {{ title?: string, url?: string, snippet?: string, age?: string }[]} results
 * @returns {string}
 */
export function renderResults(results) {
  return results
    .map((result, index) =>
      [`${index + 1}. ${result.title ?? ''}`, result.url ?? '', result.snippet ?? '', result.age ?? '']
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}

/**
 * @param {object} deps
 * @param {object} deps.hot     Live config + prompts; read at the moment of use.
 * @param {object} deps.store   getMediaCache / markMediaCacheDirty (src/memory/store.js).
 * @param {object} deps.llm     From createLlm().
 * @param {{ data: object, markDirty: () => void }} [deps.state]  The persistent state holding the
 *   daily web counter; without it the counter lives in memory only.
 * @param {object} deps.pageFetcher  From createPageFetcher() (src/web/fetch-page.js).
 * @param {{ brave?: object, exa?: object }} [deps.searches]  The search clients: createBraveSearch()
 *   (src/web/brave.js) and createExaSearch() (src/web/exa.js); an engine without its client is
 *   never ready.
 * @param {{ brave?: string|null, exa?: string|null }} [deps.keys]  BRAVE_SEARCH_API_KEY and the
 *   optional EXA_API_KEY; never logged.
 * @param {() => number} [deps.now]
 */
export function createLookup({ hot, store, llm, state = memoryState(), pageFetcher, searches = {}, keys = {}, now = Date.now }) {
  // One in-flight read per guild + link: a message prefill and a turn that
  // reach the same new link at once share one request.
  const inFlight = new Map();

  function putEntry(guildId, key, value) {
    const cache = store.getMediaCache(guildId);
    touchKey(cache, key, value);
    trimCache(cache, hot.config.media?.cacheEntries ?? Infinity);
    store.markMediaCacheDirty(guildId);
  }

  /** Today's UTC date `YYYY-MM-DD` on the injected clock (the daily counter and `{{today}}`). */
  function todayDate() {
    return utcDay(now());
  }

  /**
   * Whether `llm.maxRequestsPerDay` is spent today (the client's read-only
   * `capLeft`): the condensing request would be refused, so nothing is
   * fetched or reserved for it. A client without `capLeft` never is.
   */
  function capSpent() {
    return typeof llm?.capLeft === 'function' && llm.capLeft() <= 0;
  }

  /**
   * The slots of the shared daily web counter left today (`web.maxPerDay`,
   * read now; not a finite number counts as 0), read only: the counter is
   * never rolled over or written here. For a turn that skips the search
   * classifier when no search could run.
   * @returns {number}
   */
  function webCapLeft() {
    const cap = dailyCapOf(hot.config.web?.maxPerDay, 'web.maxPerDay');
    return Math.max(0, cap - countToday(state.data, WEB_DAILY, now()));
  }

  /**
   * Reserve one slot of the shared daily web counter; false when `web.maxPerDay`
   * (read now; not a finite number counts as 0) is spent.
   */
  function reserveDaily() {
    const cap = dailyCapOf(hot.config.web?.maxPerDay, 'web.maxPerDay');
    const nowMs = now();
    const { count } = dailyCounter(state.data, WEB_DAILY, nowMs);
    if (count >= cap) {
      state.markDirty();
      return false;
    }
    bumpDaily(state.data, WEB_DAILY, nowMs);
    state.markDirty();
    return true;
  }

  /** Whether `link` may be read under the live config at all (switches, prompt, kind, sites, file path). */
  function readable(link) {
    const config = hot.config;
    if (!webOn(config)) return false;
    const linksCfg = config.web?.links ?? {};
    if (linksCfg.enabled === false) return false;
    if (!previewOn(config) && !hot.prompts?.['read-link']) return false;
    if (!link?.id || !link.url) return false;
    if (link.kind !== undefined && link.kind !== 'link') return false;
    if (videoSiteFor(link.url, linksCfg.skipSites ?? [])) return false;
    if (isGifHostUrl(link.url)) return false;
    if (videoSiteFor(link.url, config.media?.video?.sites ?? [])) return false;
    if (isBinaryPath(link.url)) return false;
    return true;
  }

  /** The cached state of a link: `{ text }` (LRU-touched), `'miss'` (still fresh) or null. */
  function cachedRead(guildId, key) {
    const cache = store.getMediaCache(guildId);
    const entry = cache[key];
    if (!entry) return null;
    if (entry.miss) return now() - entry.ts < READ_MISS_TTL_MS ? 'miss' : null;
    if (typeof entry.text !== 'string') return null;
    touchKey(cache, key, entry);
    store.markMediaCacheDirty(guildId);
    return { text: entry.text };
  }

  /** The uncached part of a read: resolves `{ result, attempted }`. */
  async function fetchAndRead(guildId, link, key) {
    const config = hot.config;
    const linksCfg = config.web?.links ?? {};
    const summaryChars = positiveOr(linksCfg.summaryChars, LINK_SUMMARY_CHARS_FALLBACK);
    const location = safeLocation(link.url);
    const report = (outcome, reason = null, extra = {}) =>
      log.info('lookup: link', { state: outcome, reason, cached: false, location, ...extra });
    const miss = (reason, extra) => {
      putEntry(guildId, key, { miss: true, ts: now(), reason });
      report('miss', reason, extra);
      return { result: null, attempted: true };
    };

    const preview = previewOn(config);
    // The condensing request would be refused: no fetch, no slot, no miss (a preview sends none).
    if (!preview && capSpent()) {
      report('limit', 'daily-cap');
      return { result: null, attempted: false };
    }
    if (!reserveDaily()) {
      report('limit', 'daily');
      return { result: null, attempted: false };
    }

    const page = await pageFetcher.fetchText(link.url, {
      maxBytes: linksCfg.maxBytes,
      timeoutMs: linksCfg.fetchTimeoutMs,
      maxChars: linksCfg.textChars,
      acceptLanguage: config.web?.acceptLanguage,
    });
    if (!page?.ok) return miss(page?.reason ?? 'network', page?.status !== undefined ? { status: page.status } : {});

    const title = String(page.title || link.title || '').trim();
    const body = String(page.text ?? '').trim();
    if (!body) return miss('empty');

    // A preview: the opening of the page's own text, no model request.
    if (preview) {
      const opening = cleanText(body, positiveOr(linksCfg.previewChars, LINK_PREVIEW_CHARS_FALLBACK));
      if (!opening) return miss('empty');
      putEntry(guildId, key, { text: opening, ts: now() });
      report('read', null, { chars: opening.length, preview: true });
      return { result: { text: opening }, attempted: true };
    }

    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: fillPromptTemplate(hot.prompts['read-link'], { maxChars: summaryChars, today: todayDate() }) },
          { role: 'user', content: title ? `${title}\n\n${body}` : body },
        ],
        {
          model: roleModel(config, 'analyzer', 'read-link'),
          ...helperRequestOptions(config, { role: 'analyzer', maxOutputTokens: linksCfg.maxOutputTokens, purpose: 'read-link', long: true }),
        },
      );
    } catch (err) {
      const reason = llmFailure(err);
      const status = err?.statusCode !== undefined ? { status: err.statusCode } : {};
      // A refusal by the daily request cap is not the page's fault: nothing is
      // cached, so the link is read after the reset (the cap check above keeps
      // it from being fetched again meanwhile).
      if (reason === 'daily-cap') {
        report('limit', reason, status);
        return { result: null, attempted: true };
      }
      // Any other failure, the token-cap refusal included, is cached as a miss
      // (skipped for 6 hours), so the page is not re-fetched and re-charged on
      // every turn that sees the link.
      return miss(reason, status);
    }

    const text = cleanText(completion.text, summaryChars);
    if (!text) return miss('empty');
    if (text.split(' ').length <= UNREADABLE_MAX_WORDS) return miss('unreadable');

    putEntry(guildId, key, { text, ts: now() });
    report('read', null, { chars: text.length });
    return { result: { text }, attempted: true };
  }

  /** One link read through the cache, with readLinks' accounting: `attempted` = a fetch was tried (or awaited in flight). */
  async function readLinkCharged(guildId, link, { cacheOnly = false } = {}) {
    if (!readable(link)) return { result: null, attempted: false };
    const key = linkKey(hot.config, link);
    const cached = cachedRead(guildId, key);
    if (cached === 'miss') return { result: null, attempted: false };
    if (cached) return { result: { ...cached, cached: true }, attempted: false };
    if (cacheOnly) return { result: null, attempted: false };

    const flightKey = `${guildId}:${key}`;
    const running = inFlight.get(flightKey);
    if (running) {
      const { result } = await running;
      return { result, attempted: true };
    }
    const promise = fetchAndRead(guildId, link, key).finally(() => inFlight.delete(flightKey));
    inFlight.set(flightKey, promise);
    return promise;
  }

  /**
   * Read up to `maxNew` NEW links of `links`, in the order given, each
   * condensed into an excerpt (a preview under features.coreTools: previewOn) through the shared cache. Every fetch ATTEMPT
   * counts toward `maxNew` (a failure included); cache hits and the daily cap
   * are free; past `maxNew` the rest are only looked up in the cache. A link
   * listed twice is read once. A link is left out of `reads` when the feature
   * is off, it is not readable, a fresh miss is cached, the daily cap is spent
   * or the read failed.
   * @param {string} guildId
   * @param {{ id: string, url: string, site?: string, title?: string, kind?: string }[]} links
   *   Normalized link items (src/media/classify.js#collectReadableLinks).
   * @param {{ maxNew?: number }} [options]
   * @returns {Promise<{ reads: Map<string, string>, newCount: number }>}  link id -> excerpt.
   */
  async function readLinks(guildId, links, { maxNew = Infinity } = {}) {
    const reads = new Map();
    const seen = new Set();
    let newCount = 0;
    for (const link of links ?? []) {
      if (!link?.id || seen.has(link.id)) continue;
      seen.add(link.id);
      const { result, attempted } = await readLinkCharged(guildId, link, { cacheOnly: newCount >= maxNew });
      if (attempted) newCount += 1;
      if (result) reads.set(link.id, result.text);
    }
    return { reads, newCount };
  }

  /**
   * What the link cache already holds for `links`, read the way readLinks
   * reads its cache (the same readable() rules; an excerpt is LRU-touched),
   * synchronously and with nothing else: no fetch, no model request, no
   * daily web slot, no miss recorded, no wait for a read in flight. A link
   * that is not readable, not cached or cached as a miss is left out; a link
   * listed twice is looked up once. For a caller that cannot wait for the
   * link stage (the turn's search classifier).
   * @param {string} guildId
   * @param {{ id: string, url: string, site?: string, title?: string, kind?: string }[]} links
   * @returns {Map<string, string>}  link id -> excerpt.
   */
  function cachedReads(guildId, links) {
    const reads = new Map();
    const seen = new Set();
    for (const link of links ?? []) {
      if (!link?.id || seen.has(link.id)) continue;
      seen.add(link.id);
      if (!readable(link)) continue;
      const cached = cachedRead(guildId, linkKey(hot.config, link));
      if (cached && cached !== 'miss') reads.set(link.id, cached.text);
    }
    return reads;
  }

  /**
   * One web search on `query`, condensed with its sources, through the shared
   * cache. Needs the feature, `web.search.enabled`, the search-summary prompt,
   * a chosen engine that can run (hasSearch) and a non-blank query. No
   * results -> an empty `text` (the caller renders labels.lookup.none). A
   * failure is never cached; a fallback engine answers only the failures
   * listed in the header.
   * @param {string} guildId
   * @param {string} query
   * @returns {Promise<{ query: string, text: string, sources: { title: string, url: string, site: string }[],
   *   cached?: true }|null>}
   */
  async function search(guildId, query) {
    const config = hot.config;
    if (!webOn(config)) return null;
    const searchCfg = config.web?.search ?? {};
    if (searchCfg.enabled === false) return null;
    const promptText = hot.prompts?.['search-summary'];
    const asked = cleanQuery(query);
    if (!promptText || !asked) return null;
    if (!hasSearch()) return null;

    const report = (outcome, reason = null, extra = {}) => log.info('lookup: search', { state: outcome, reason, ...extra });
    const cache = store.getMediaCache(guildId);
    const key = searchKey(asked);
    const hit = cache[key];
    if (hit && typeof hit.text === 'string') {
      const maxAgeMs = positiveOr(searchCfg.cacheHours, SEARCH_CACHE_HOURS_FALLBACK) * 60 * MINUTE_MS;
      if (now() - hit.ts < maxAgeMs) {
        touchKey(cache, key, hit);
        store.markMediaCacheDirty(guildId);
        report(hit.text ? 'found' : 'nothing', null, { cached: true, results: hit.sources?.length ?? 0 });
        return { query: hit.query ?? asked, text: hit.text, sources: hit.sources ?? [], cached: true };
      }
      delete cache[key];
      store.markMediaCacheDirty(guildId);
    }

    // The summary request would be refused: no search, no slot.
    if (capSpent()) {
      report('limit', 'daily-cap');
      return null;
    }
    if (!reserveDaily()) {
      report('limit', 'daily');
      return null;
    }

    const engines = [engineOf(config), ...fallbackEngines(config)];
    for (let i = 0; i < engines.length; i += 1) {
      const meta = { engine: engines[i], fallback: i > 0 };
      // A fallback sends a request of its own: not once the daily request cap is spent.
      if (i > 0 && capSpent()) {
        report('limit', 'daily-cap', meta);
        return null;
      }
      const outcome = await attempt(engines[i], asked, promptText, config);
      if (outcome.result) {
        putEntry(guildId, key, { ...outcome.result, ts: now() });
        report(outcome.result.text ? 'found' : 'nothing', null, { cached: false, results: outcome.result.sources.length, ...meta });
        return outcome.result;
      }
      const { reason, status } = outcome.failure;
      report('error', reason, { ...(status !== undefined ? { status } : {}), ...meta });
      if (!fallsBack(outcome.failure)) return null;
    }
    return null;
  }

  /** Whether `engine` can run: Brave needs its client and its key, Exa its client, OpenRouter the llm client. */
  function engineReady(engine) {
    if (engine === 'brave') return typeof searches.brave?.search === 'function' && typeof keys.brave === 'string' && keys.brave.trim().length > 0;
    if (engine === 'exa') return typeof searches.exa?.search === 'function';
    return typeof llm?.complete === 'function';
  }

  /** `web.search.fallback` of the live config: the known engines that can run, in order, each once, never the chosen one. */
  function fallbackEngines(config) {
    const chosen = engineOf(config);
    const list = Array.isArray(config.web?.search?.fallback) ? config.web.search.fallback : [];
    const out = [];
    for (const engine of list) {
      if (!SEARCH_ENGINES.includes(engine) || engine === chosen || out.includes(engine) || !engineReady(engine)) continue;
      out.push(engine);
    }
    return out;
  }

  /** The summary prompt filled for `asked`, and the summary request's options for this config. */
  function summaryRequest(config, promptText, asked, summaryChars, searchCfg) {
    return {
      system: { role: 'system', content: fillPromptTemplate(promptText, { query: asked, maxChars: summaryChars, today: todayDate() }) },
      options: {
        model: roleModel(config, 'analyzer', 'search-summary'),
        ...helperRequestOptions(config, { role: 'analyzer', maxOutputTokens: searchCfg.maxOutputTokens, purpose: 'search-summary', long: true }),
      },
    };
  }

  /**
   * One engine's attempt: `{ result }` (found, or nothing found with an empty text and no
   * sources) or `{ failure: { reason, status? } }`. Brave and Exa search, then the summary
   * condenses their results; `openrouter` searches and condenses in one request.
   */
  async function attempt(engine, asked, promptText, config) {
    const searchCfg = config.web?.search ?? {};
    const summaryChars = positiveOr(searchCfg.summaryChars, SEARCH_SUMMARY_CHARS_FALLBACK);
    const { system, options } = summaryRequest(config, promptText, asked, summaryChars, searchCfg);

    if (engine === 'openrouter') {
      let completion;
      try {
        completion = await llm.complete([system, { role: 'user', content: asked }], {
          ...options,
          // No hedge: a second attempt would run (and bill) the web search twice.
          helper: false,
          plugins: webSearchPlugins(searchCfg.results),
        });
      } catch (err) {
        return { failure: { reason: openrouterFailure(err), ...(err?.statusCode !== undefined ? { status: err.statusCode } : {}) } };
      }
      const text = cleanText(completion.text, summaryChars);
      if (!text) return { failure: { reason: 'empty' } };
      const sources = citationsOf(completion.annotations).map((c) => ({ ...c, site: siteOf(c.url) }));
      return { result: { query: asked, text, sources } };
    }

    const client = searches[engine];
    const found = await client.search(asked, { apiKey: keys[engine] ?? null, count: searchCfg.results, timeoutMs: searchCfg.timeoutMs });
    if (!found?.ok) {
      if (found?.reason === 'empty') return { result: { query: asked, text: '', sources: [] } };
      return { failure: { reason: found?.reason ?? 'network', ...(found?.status !== undefined ? { status: found.status } : {}) } };
    }
    let completion;
    try {
      completion = await llm.complete([system, { role: 'user', content: renderResults(found.results) }], options);
    } catch (err) {
      return { failure: { reason: llmFailure(err), ...(err?.statusCode !== undefined ? { status: err.statusCode } : {}) } };
    }
    const text = cleanText(completion.text, summaryChars);
    if (!text) return { failure: { reason: 'empty' } };
    const sources = found.results.map((r) => ({ title: r.title ?? '', url: r.url, site: siteOf(r.url) }));
    return { result: { query: asked, text, sources } };
  }

  /**
   * The persona's own web.search: one search on `query` whose results come back raw (see the
   * header): `{ query, results: [{ title, url, site, snippet, age? }], cached? }`, `results`
   * empty when nothing was found; `{ failed: { code, status? } }` when it did not search:
   * `not-configured` (the feature, `web.search.enabled`, no engine), `empty-query` (the cleaned
   * query is blank), `cap` (the day's web slots are spent, or an `openrouter` request would pass
   * `llm.maxRequestsPerDay`), `provider` (every engine tried failed; `status` the last HTTP
   * status when it gave one). Shares the engines,
   * their fallbacks (the failures listed in the header) and the daily web slot with `search`;
   * never reads the search-summary prompt, never sends a summary request. A failure is never
   * cached.
   * @param {string} guildId
   * @param {string} query
   * @returns {Promise<{ query: string, results: { title: string, url: string, site: string, snippet: string, age?: string }[], cached?: true }|{ failed: { code: string, status?: number } }>}
   */
  async function searchResults(guildId, query) {
    const config = hot.config;
    const failedWith = (code, status) => ({ failed: { code, ...(status !== undefined ? { status } : {}) } });
    if (!webOn(config)) return failedWith('not-configured');
    const searchCfg = config.web?.search ?? {};
    if (searchCfg.enabled === false) return failedWith('not-configured');
    const asked = cleanQuery(query);
    if (!asked) return failedWith('empty-query');
    if (!hasSearch()) return failedWith('not-configured');

    const report = (outcome, reason = null, extra = {}) => log.info('lookup: search', { state: outcome, reason, raw: true, ...extra });
    const cache = store.getMediaCache(guildId);
    const key = hashedKey('results', normalizeQuery(asked));
    const hit = cache[key];
    if (hit && Array.isArray(hit.results)) {
      const maxAgeMs = positiveOr(searchCfg.cacheHours, SEARCH_CACHE_HOURS_FALLBACK) * 60 * MINUTE_MS;
      if (now() - hit.ts < maxAgeMs) {
        touchKey(cache, key, hit);
        store.markMediaCacheDirty(guildId);
        report(hit.results.length ? 'found' : 'nothing', null, { cached: true, results: hit.results.length });
        return { query: hit.query ?? asked, results: hit.results, cached: true };
      }
      delete cache[key];
      store.markMediaCacheDirty(guildId);
    }

    const engines = [engineOf(config), ...fallbackEngines(config)];
    // Only the `openrouter` engine sends a model request: the cap matters when it comes first.
    if (engines[0] === 'openrouter' && capSpent()) {
      report('limit', 'daily-cap');
      return failedWith('cap');
    }
    if (!reserveDaily()) {
      report('limit', 'daily');
      return failedWith('cap');
    }
    let last;
    for (let i = 0; i < engines.length; i += 1) {
      const meta = { engine: engines[i], fallback: i > 0 };
      if (engines[i] === 'openrouter' && i > 0 && capSpent()) {
        report('limit', 'daily-cap', meta);
        return failedWith('cap');
      }
      const outcome = await rawAttempt(engines[i], asked, config);
      if (outcome.results) {
        const result = { query: asked, results: outcome.results };
        putEntry(guildId, key, { ...result, ts: now() });
        report(outcome.results.length ? 'found' : 'nothing', null, { cached: false, results: outcome.results.length, ...meta });
        return result;
      }
      const { reason, status } = outcome.failure;
      report('error', reason, { ...(status !== undefined ? { status } : {}), ...meta });
      last = status;
      if (!fallsBack(outcome.failure)) return failedWith('provider', status);
    }
    return failedWith('provider', last);
  }

  /**
   * One engine's raw attempt: `{ results }` (possibly empty: nothing found) or `{ failure }`.
   * `openrouter`: one request with the web plugin, the query as its only message, the answer
   * capped at `web.search.rawOutputTokens` and never read; the results its `url_citation`
   * annotations. Brave and Exa: their results as they come.
   */
  async function rawAttempt(engine, asked, config) {
    const searchCfg = config.web?.search ?? {};
    if (engine === 'openrouter') {
      let completion;
      try {
        completion = await llm.complete([{ role: 'user', content: asked }], {
          model: roleModel(config, 'analyzer', 'web-search'),
          ...helperRequestOptions(config, { role: 'analyzer', maxOutputTokens: positiveOr(searchCfg.rawOutputTokens, RAW_OUTPUT_TOKENS_FALLBACK), purpose: 'web-search' }),
          // No hedge: a second attempt would run (and bill) the web search twice.
          helper: false,
          plugins: webSearchPlugins(searchCfg.results),
        });
      } catch (err) {
        return { failure: { reason: openrouterFailure(err), ...(err?.statusCode !== undefined ? { status: err.statusCode } : {}) } };
      }
      return { results: urlCitations(completion.annotations).map((c) => ({ title: c.title, url: c.url, site: siteOf(c.url), snippet: c.snippet })) };
    }
    const found = await searches[engine].search(asked, { apiKey: keys[engine] ?? null, count: searchCfg.results, timeoutMs: searchCfg.timeoutMs });
    if (!found?.ok) {
      if (found?.reason === 'empty') return { results: [] };
      return { failure: { reason: found?.reason ?? 'network', ...(found?.status !== undefined ? { status: found.status } : {}) } };
    }
    return {
      results: found.results.map((r) => ({
        title: oneLine(String(r.title ?? '')),
        url: r.url,
        site: siteOf(r.url),
        snippet: oneLine(String(r.snippet ?? '')),
        ...(typeof r.age === 'string' && r.age.trim() ? { age: r.age.trim() } : {}),
      })),
    };
  }

  /**
   * The persona's own web.read: the page at `url` through the SSRF-guarded fetcher, its
   * extracted main text cut at `web.links.readChars` (`cut: true` when it was longer), its
   * title and the url it ended at after redirects; no model request. Needs the feature;
   * takes one daily web slot per fetch (a cache hit is free). `{ ok: false, reason }`:
   * `not-configured` (the feature off), `daily-cap` (the day's slots spent), `empty` (no
   * text on the page), or the fetcher's reason (`scheme`, `private`, `redirects`, `type`,
   * `size`, `timeout`, `http`, `network`). A page read is cached for
   * `web.links.readCacheHours`; a failure is not.
   * @param {string} guildId
   * @param {string} url
   * @returns {Promise<{ ok: true, url: string, title: string, text: string, cut: boolean, cached?: true }
   *   | { ok: false, reason: string, status?: number }>}
   */
  async function readPage(guildId, url) {
    const config = hot.config;
    if (!webOn(config)) return { ok: false, reason: 'not-configured' };
    const linksCfg = config.web?.links ?? {};
    const maxChars = positiveOr(linksCfg.readChars, PAGE_READ_CHARS_FALLBACK);
    const asked = String(url ?? '').trim();
    const location = safeLocation(asked);
    const report = (outcome, reason = null, extra = {}) => log.info('lookup: page', { state: outcome, reason, location, ...extra });
    const cache = store.getMediaCache(guildId);
    const key = hashedKey('page', asked);
    const hit = cache[key];
    if (hit && typeof hit.text === 'string') {
      if (now() - hit.ts < positiveOr(linksCfg.readCacheHours, PAGE_CACHE_HOURS_FALLBACK) * 60 * MINUTE_MS) {
        touchKey(cache, key, hit);
        store.markMediaCacheDirty(guildId);
        report('read', null, { cached: true, chars: hit.text.length });
        return { ok: true, url: hit.url, title: hit.title ?? '', text: hit.text, cut: hit.cut === true, cached: true };
      }
      delete cache[key];
      store.markMediaCacheDirty(guildId);
    }
    if (!reserveDaily()) {
      report('limit', 'daily');
      return { ok: false, reason: 'daily-cap' };
    }
    const page = await pageFetcher.fetchText(asked, {
      maxBytes: linksCfg.maxBytes,
      timeoutMs: linksCfg.fetchTimeoutMs,
      acceptLanguage: config.web?.acceptLanguage,
    });
    if (!page?.ok) {
      const reason = page?.reason ?? 'network';
      report('miss', reason, page?.status !== undefined ? { status: page.status } : {});
      return { ok: false, reason, ...(page?.status !== undefined ? { status: page.status } : {}) };
    }
    const whole = String(page.text ?? '').trim();
    if (!whole) {
      report('miss', 'empty');
      return { ok: false, reason: 'empty' };
    }
    const text = truncateText(whole, maxChars);
    const read = { url: String(page.finalUrl || asked), title: oneLine(String(page.title ?? '')), text, cut: text !== whole };
    putEntry(guildId, key, { ...read, ts: now() });
    report('read', null, { cached: false, chars: text.length, cut: read.cut });
    return { ok: true, ...read };
  }

  /**
   * Whether the chosen engine (`web.search.engine`, read now) can run: `brave` needs
   * BRAVE_SEARCH_API_KEY, `exa` and `openrouter` need no key. The fallback engines do not
   * count: they only stand in for a chosen engine that runs. `/nep status` reports it.
   */
  function hasSearch() {
    return engineReady(engineOf(hot.config));
  }

  /** The chosen engine's name (`web.search.engine`, read now; `brave` when it names none). */
  function searchEngine() {
    return engineOf(hot.config);
  }

  return { readLinks, cachedReads, search, searchResults, readPage, hasSearch, searchEngine, webCapLeft };
}
