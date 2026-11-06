// The web lookup: the persona reads a link posted in the chat, and quick search answers with one search on the one engine
// the owner chose. Two halves, both modelled on the video describer (src/memory/describe.ts), and the persona's own raw
// tools beside them:
//
// - readLinks: a normal page link (never a video-site link -- the video
//   describer owns those -- never an embed classified as anything but a link
//   (a gif), never a GIF site's page (src/media/classify.ts#isGifHostUrl),
//   never a `SKIP_SITES` host, never a URL whose path ends
//   with a picture/video/audio/archive/pdf extension) is fetched through the
//   SSRF-guarded page fetcher (src/web/fetch-page.ts; `web.acceptLanguage`
//   sent as its Accept-Language). The excerpt is the opening of the page's own extracted
//   text, cut at `LINK_EXCERPT_CHARS` -- what a link preview shows -- cached as
//   `preview:<link id>`, no model request.
// - search: one web search whose numbered results are condensed through prompts/search-summary.md, sources kept.
//   `web.quickSearch.engine` picks the engine, and it has no default: `brave` (src/web/brave.ts) and `exa` (src/web/exa.ts) each
//   need their service key, and `openrouter` (OpenRouter's web plugin, its engine `auto`: the summary request itself
//   searches, one request billed to credits, its sources the answer's `url_citation` annotations) needs `web.quickSearch.model`.
//   Brave and Exa condense on that model too, so they do not summarise without it. An engine outside the three, or one
//   without what it needs, leaves quick search off, and when the chosen engine fails nothing answers in its place.
// - searchResults: the persona's own web.search (src/tools/tools.ts): the same engine, but the results come back raw --
//   title, url, site, the engine's snippet and date -- with no summary request. Brave and Exa return them as they are;
//   `openrouter` sends one request with the web plugin and only the query (purpose `quick-search` on quick search's own
//   role and model, its answer cut at `web.quickSearch.rawOutputTokens` and never read), the results being its `url_citation`
//   annotations with their content. Cached apart (`results:<sha1 prefix>`), served while younger than
//   `web.quickSearch.cacheHours`. A failure says why: `not-configured` with `no-engine`, `no-model`, `no-key` or `disabled`, and
//   `provider` with the engine and `timeout`, `rate-limited`, `credentials` or the client's own reason.
// - readPage: the persona's own web.read: one page by url through the same fetcher, its
//   extracted main text (src/web/readable.ts) cut at `PAGE_READ_CHARS`, with its title
//   and final url; no model request. Cached (`page:<sha1 prefix of the url>`) for
//   `web.links.readCacheHours`; a failure is not cached. Past those hours the entry stays until a later read replaces it,
//   because it is the link's text form: every link to that address holds this text instead of its preview, with no fetch.
//   A transcript shows it cut at `LINK_EXCERPT_CHARS` (src/format.ts), so a request grows no more than by a preview.
//
// Both share the media cache (data/places/<id>/media.json, LRU-trimmed to
// `MEDIA_CACHE_ENTRIES` of src/web/cache.ts): `preview:<link id>` holds an excerpt `{ text, ts }` or a
// miss `{ miss, ts, reason }` skipped for 6 hours (never for a refusal by
// `llm.maxRequestsPerDay`); `search:<sha1 prefix of the
// normalized query>` holds `{ query, text, sources, ts }`, served while younger
// than `web.quickSearch.cacheHours`. Every model call
// goes through llm.complete (its token cap and daily request cap apply); once
// that daily request cap is spent (llm.capLeft) no search that needs a request is
// sent and no web slot is taken.
// Logs carry reason codes, counts and `host/path` -- never page text, an
// excerpt, a query or the key.

import { isGifHostUrl, siteOf } from '../media/classify.ts';
import { videoSiteFor, safeLocation } from '../media/video-sites.ts';
import { SEARCH_ROLE, searchModel } from '../llm/roles.ts';
import { fillPromptTemplate } from '../behavior/prompt.ts';
import { createSummaryBuilder, parseSummaryNote, renderResults } from '../behavior/summary-builder.ts';
import { roleRequestOptions, railReason } from '../llm/openrouter.ts';
import { clampText, oneLine } from '../memory/clamp.ts';
import { log } from '../log.ts';
import { MINUTE_MS, utcDay } from '../time.ts';
import { LINK_EXCERPT_CHARS, MEDIA_CACHE_ENTRIES, hashedKey, touchKey, trimCache } from './cache.ts';
import { truncateText } from './readable.ts';
import { CODE } from '../tools/codes.ts';
import { errorFields } from '../error-fields.ts';
import { objOf, scalarText } from '../tools/types.ts';
import type { ChatMessage, CompleteOptions, CompleteResult } from '../llm/openrouter.ts';
import { withoutCredentials } from './fetch-page.ts';
import type { PageFetcher } from './fetch-page.ts';
import type { SearchClient } from './search-types.ts';

/** The settings of `web.links` the reader uses. */
type LinksSettings = { fetchTimeoutMs?: number; readCacheHours?: unknown };
/** The settings of `web.search` the lookup uses. */
type SearchSettings = {
  enabled?: boolean;
  engine?: unknown;
  model?: unknown;
  cacheHours?: unknown;
  maxOutputTokens?: number;
  rawOutputTokens?: unknown;
  timeoutMs?: number;
};
/** The live config as the lookup reads it. */
type LookupConfig = {
  media?: { video?: { sites?: ReadonlyArray<string> } };
  web?: { acceptLanguage?: string; links?: LinksSettings; quickSearch?: SearchSettings };
};
/** One source of a condensed search. */
type Source = { title: string; url: string; site: string };
/** One raw result of the persona's own search. */
type RawResult = { title: string; url: string; site: string; snippet: string; age?: string };
/** One entry of the media cache that a read or a search wrote. */
type CacheEntry = {
  ts: number;
  miss?: boolean;
  reason?: string;
  text?: string;
  query?: string;
  sources?: Array<Source>;
  results?: Array<RawResult>;
  url?: string;
  title?: string;
  cut?: boolean;
};
/** A link as the reader takes it: its id and address. */
type LinkItem = { id: string; url: string; site?: string; title?: string; kind?: string };
/** What `createLookup` takes. */
export type LookupDeps = {
  hot: { config: LookupConfig; prompts?: { 'search-summary'?: string } };
  store: {
    getMediaCache: (placeId: string) => Record<string, CacheEntry>;
    markMediaCacheDirty: (placeId: string) => void;
    linkedMediaKeys?: () => ReadonlySet<string>;
  };
  llm: {
    complete: (messages: Array<ChatMessage>, options?: CompleteOptions) => Promise<CompleteResult>;
    capLeft?: () => number;
  };
  pageFetcher: PageFetcher;
  searches?: { brave?: SearchClient; exa?: SearchClient };
  keys?: { brave?: string | null; exa?: string | null };
  now?: () => number;
};

/** A condensed search's answer: null when the lookup did not search. */
type SearchAnswer = { query: string; text: string; sources: Array<Source>; cached?: true } | null;

/** The persona's own search's answer, or why it did not search. */
type RawAnswer =
  | { query: string; results: Array<RawResult>; cached?: true }
  | { failed: { code: string; reason?: string; engine?: Engine; status?: number } };

/** A page read's answer. */
type PageAnswer =
  | { ok: true; url: string; title: string; text: string; cut: boolean; cached?: true }
  | { ok: false; reason: string; status?: number; url?: string };

/** What `readLinkCharged` takes beside the link. */
type Only = { cacheOnly?: boolean };

/** What `readLinks` takes beside the links. */
type MaxNew = { maxNew?: number };

/** The excerpts `readLinks` read, by link id, and how many fetches it tried. */
type Reads = { reads: Map<string, string>; newCount: number };

/** One link read through the cache: a fresh read or a cached one. */
type Got = { result: { text: string; cached?: true } | null; attempted: boolean };

/** One link read: its excerpt, and whether a fetch was tried. */
type Fetched = { result: { text: string } | null; attempted: boolean };

/** The lookup: link reads, searches and page reads over the shared media cache. */
export type Lookup = {
  readLinks: (placeId: string, links: Array<LinkItem>, options?: MaxNew) => Promise<Reads>;
  cachedReads: (placeId: string, links: Array<LinkItem>) => Map<string, string>;
  search: (placeId: string, query: string) => Promise<SearchAnswer>;
  searchResults: (placeId: string, query: string) => Promise<RawAnswer>;
  readPage: (placeId: string, url: string) => Promise<PageAnswer>;
  hasSearch: () => boolean;
  searchEngine: () => Engine | null;
};

/** A search engine of the lookup. */
type Engine = (typeof SEARCH_ENGINES)[number];
/** Why one attempt of an engine failed. */
type Failure = { reason: string; status?: number };
/** One engine's attempt at a condensed search. */
type Attempt =
  | { result: { query: string; text: string; sources: Array<Source> }; failure?: undefined }
  | { result?: undefined; failure: Failure };
/** One engine's attempt at a raw search. */
type RawAttempt = { results: Array<RawResult>; failure?: undefined } | { results?: undefined; failure: Failure };

const READ_MISS_TTL_MS = 6 * 60 * MINUTE_MS;
// Only when a web.* number is missing (config.json always has them).
const SEARCH_CACHE_HOURS_FALLBACK = 24;
const PAGE_CACHE_HOURS_FALLBACK = 6;
// The reader's and the search's measures. Production values, config cut of 2026-10-31.
/** The largest page fetched, in bytes. */
const LINK_MAX_BYTES = 1500000;
/** The characters of a page's text kept from the fetch. */
const LINK_TEXT_CHARS = 6000;
/** The length of a page read whole (`web.read`). */
const PAGE_READ_CHARS = 4000;
/** The length of a search's condensed answer. */
const SEARCH_SUMMARY_CHARS = 900;
/** The results one search asks for. */
const SEARCH_RESULTS = 5;
/** The hosts whose links are media, never read as pages. */
const SKIP_SITES = Object.freeze([
  'cdn.discordapp.com',
  'media.discordapp.net',
  'tenor.com',
  'giphy.com',
  'klipy.com',
  'imgur.com',
  'i.redd.it',
  'v.redd.it',
  'pbs.twimg.com',
]);
const RAW_OUTPUT_TOKENS_FALLBACK = 256;
const QUERY_MAX_CHARS = 200;
// Tab, line feed, vertical tab, form feed, carriage return, NEL, line and paragraph separators.
const QUERY_LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]+/g;
const QUERY_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
// A link to a file, not a page: the reader would only spend an attempt on it.
const BINARY_PATH = /\.(?:png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|mkv|mp3|ogg|wav|zip|rar|7z|pdf)$/i;

/** The search engines `web.quickSearch.engine` may name. */
export const SEARCH_ENGINES = ['brave', 'exa', 'openrouter'] as const;
/** The reason of an engine's request that had no key to go out on. */
const NO_KEY = 'no-key';

/** The video sites of the live config (`media.video.sites`), none when it names none. */
function videoSitesOf(config: LookupConfig): ReadonlyArray<string> {
  const video = config.media?.video;
  return video?.sites ?? [];
}

/** The engine of the live config: `web.quickSearch.engine` when it names one, else none. */
function engineOf(config: LookupConfig): Engine | null {
  const quickSearch = config?.web?.quickSearch;
  const engine = quickSearch?.engine;
  return SEARCH_ENGINES.find((name) => name === engine) ?? null;
}

/** A failed attempt as the persona's search tells it: refused credentials and a rate limit by name, else the attempt's reason. */
function toldReason({ reason, status }: Failure): string {
  if (status === 401 || status === 403) return 'credentials';
  return status === 429 ? 'rate-limited' : reason;
}

/** An `openrouter` engine failure as a search reason: no key for its role, a 429 `rate-limited`, a timeout `timeout`, a failed fetch `network`, else the rail reason. */
function openrouterFailure(err: unknown): string {
  const { statusCode, name, code } = errorFields(err);
  if (code === 'ROLE_KEY_MISSING') return NO_KEY;
  if (statusCode === 429) return 'rate-limited';
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (name === 'TypeError' && statusCode === undefined) return 'network';
  return llmFailure(err);
}

/**
 * The `url_citation` annotations of an answer (OpenRouter's web plugin) as `{ title, url, snippet }`,
 * http(s) urls only, each url once, in order; `title` and `snippet` (the annotation's `content`)
 * collapsed to one line, '' when absent.
 */
export function urlCitations(annotations: unknown): Array<{ title: string; url: string; snippet: string }> {
  const seen = new Set<string>();
  const out: Array<{ title: string; url: string; snippet: string }> = [];
  for (const given of Array.isArray(annotations) ? (annotations as Array<unknown>) : []) {
    const entry = objOf(given);
    if (entry.type !== 'url_citation') continue;
    const citation = objOf(entry.url_citation);
    const url = typeof citation.url === 'string' ? citation.url.trim() : '';
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const content = citation.content;
    out.push({
      title: oneLine(scalarText(citation.title ?? '')),
      url,
      snippet: typeof content === 'string' ? oneLine(content) : '',
    });
  }
  return out;
}

/** The `url_citation` annotations of an answer as `{ title, url }` (urlCitations without the snippet). */
function citationsOf(annotations: unknown): Array<{ title: string; url: string }> {
  return urlCitations(annotations).map(({ title, url }) => ({ title, url }));
}

/** The media cache key of a link's read: `preview:<id>`. */
function linkKey(config: unknown, link: { id: string }): string {
  return `preview:${link.id}`;
}

/** The media cache key of a page read, by the address it was asked for: `page:<sha1 prefix>`. */
function pageKey(url: string): string {
  return hashedKey('page', url.trim());
}

/** A positive number from the config, else `fallback`. */
function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && value > 0 ? value : fallback;
}

/** Collapse whitespace, then cap at `maxChars` on a clean boundary. */
function cleanText(raw: unknown, maxChars: number): string {
  return clampText(oneLine(raw), maxChars, { tolerance: 1 });
}

/** Whether `url`'s path (query and fragment aside) ends with a file extension the reader skips. */
function isBinaryPath(url: string): boolean {
  try {
    return BINARY_PATH.test(new URL(String(url)).pathname);
  } catch {
    return false;
  }
}

/** The safety-rail refusals of llm.complete as reason codes; any other failure is `llm`. */
function llmFailure(err: unknown): string {
  return railReason(err, 'llm');
}

/** The `{ status }` field of a failure that came with an HTTP status, else nothing. */
function statusOf(err: unknown): { status?: number } {
  const { statusCode } = errorFields(err);
  return typeof statusCode === 'number' ? { status: statusCode } : {};
}

/** A query as the search cache sees it: lower-cased, whitespace-collapsed, trimmed. */
export function normalizeQuery(query: string): string {
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
 */
export function cleanQuery(query: string): string {
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

/** `web.quickSearch.results` as the web plugin's `max_results`: an integer in 1..10, `fallback` (5) when not a number (as the search clients clamp it). */
function clampResults(value: unknown, fallback = 5): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : fallback;
}

/**
 * The `plugins` of a request that searches through OpenRouter's web plugin, with no `engine` set so the plugin chooses:
 * the lookup's `openrouter` engine. `results` becomes
 * `max_results`, an integer in 1..10, `fallback` when not a number.
 */
export function webSearchPlugins(results: unknown, fallback: number = 5): Array<{ id: 'web'; max_results: number }> {
  return [{ id: 'web', max_results: clampResults(results, fallback) }];
}

/** The cache key of one search. */
function searchKey(query: string): string {
  return hashedKey('search', normalizeQuery(query));
}

export { renderResults };

/**
 * @param deps.hot Live config + prompts; read at the moment of use.
 * @param deps.store getMediaCache / markMediaCacheDirty (src/memory/store.ts).
 * @param deps.llm From createLlm().
 * @param deps.pageFetcher From createPageFetcher() (src/web/fetch-page.ts).
 * @param deps.searches The search clients: createBraveSearch()
 *   (src/web/brave.ts) and createExaSearch() (src/web/exa.ts); an engine without its client is
 *   never ready.
 * @param deps.keys The service keys of the `brave` and `exa` engines; never logged.
 */
export function createLookup(deps: LookupDeps): Lookup {
  const { hot, store, llm, pageFetcher, searches = {}, keys = {}, now = Date.now } = deps;
  const buildSummary = createSummaryBuilder({ hot, llm, now });
  // One in-flight read per place + link: a message prefill and a turn that
  // reach the same new link at once share one request.
  const inFlight = new Map<string, Promise<Fetched>>();

  function putEntry(placeId: string, key: string, value: CacheEntry): void {
    const cache = store.getMediaCache(placeId);
    touchKey(cache, key, value);
    trimCache(cache, MEDIA_CACHE_ENTRIES, () => store.linkedMediaKeys?.() ?? new Set<string>());
    store.markMediaCacheDirty(placeId);
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

  /** Whether `link` may be read under the live config at all (switches, prompt, kind, sites, file path). */
  function readable(link: LinkItem | null | undefined): boolean {
    const config = hot.config;
    if (!link?.id || !link.url) return false;
    if (link.kind !== undefined && link.kind !== 'link') return false;
    if (videoSiteFor(link.url, SKIP_SITES)) return false;
    if (isGifHostUrl(link.url)) return false;
    if (videoSiteFor(link.url, videoSitesOf(config))) return false;
    if (isBinaryPath(link.url)) return false;
    return true;
  }

  /** The cached state of a link: `{ text }` (LRU-touched), `'miss'` (still fresh) or null. */
  function cachedRead(placeId: string, key: string): { text: string } | 'miss' | null {
    const cache = store.getMediaCache(placeId);
    const entry = cache[key];
    if (!entry) return null;
    if (entry.miss) return now() - entry.ts < READ_MISS_TTL_MS ? 'miss' : null;
    if (typeof entry.text !== 'string') return null;
    touchKey(cache, key, entry);
    store.markMediaCacheDirty(placeId);
    return { text: entry.text };
  }

  /** The uncached part of a read: resolves `{ result, attempted }`. */
  async function fetchAndRead(placeId: string, link: LinkItem, key: string): Promise<Fetched> {
    const config = hot.config;
    const linksCfg: LinksSettings = config.web?.links ?? {};
    const location = safeLocation(link.url);
    const report = (outcome: string, reason: string | null = null, extra: object = {}): void =>
      log.info('lookup: link', { state: outcome, reason, cached: false, location, ...extra });
    const miss = (reason: string, extra?: object): { result: null; attempted: true } => {
      putEntry(placeId, key, { miss: true, ts: now(), reason });
      report('miss', reason, extra);
      return { result: null, attempted: true };
    };

    const page = await pageFetcher.fetchText(link.url, {
      maxBytes: LINK_MAX_BYTES,
      timeoutMs: linksCfg.fetchTimeoutMs,
      maxChars: LINK_TEXT_CHARS,
      acceptLanguage: config.web?.acceptLanguage,
    });
    if (!page?.ok) return miss(page?.reason ?? 'network', page?.status !== undefined ? { status: page.status } : {});

    const body = String(page.text ?? '').trim();
    if (!body) return miss('empty');

    // The opening of the page's own text, no model request.
    const opening = cleanText(body, LINK_EXCERPT_CHARS);
    if (!opening) return miss('empty');
    putEntry(placeId, key, { text: opening, ts: now() });
    report('read', null, { chars: opening.length, preview: true });
    return { result: { text: opening }, attempted: true };
  }

  /** One link read through the cache, with readLinks' accounting: `attempted` = a fetch was tried (or awaited in flight). */
  async function readLinkCharged(placeId: string, link: LinkItem, { cacheOnly = false }: Only = {}): Promise<Got> {
    if (!readable(link)) return { result: null, attempted: false };
    const key = linkKey(hot.config, link);
    // The text form of a link she read with web.read comes first: the page entry of its address, whatever its age.
    const cached = cachedRead(placeId, pageKey(link.url)) ?? cachedRead(placeId, key);
    if (cached === 'miss') return { result: null, attempted: false };
    if (cached) return { result: { ...cached, cached: true }, attempted: false };
    if (cacheOnly) return { result: null, attempted: false };

    const flightKey = `${placeId}:${key}`;
    const running = inFlight.get(flightKey);
    if (running) {
      const { result } = await running;
      return { result, attempted: true };
    }
    const promise = fetchAndRead(placeId, link, key).finally(() => inFlight.delete(flightKey));
    inFlight.set(flightKey, promise);
    return promise;
  }

  /**
   * Read up to `maxNew` NEW links of `links`, in the order given, each
   * turned into an excerpt (the opening of the page's text) through the shared cache. Every fetch ATTEMPT
   * counts toward `maxNew` (a failure included); cache hits are free; past `maxNew` the rest are only looked up in the cache. A link
   * listed twice is read once. A link is left out of `reads` when the feature
   * is off, it is not readable, a fresh miss is cached
   * or the read failed.
   * @param links Normalized link items (src/media/classify.ts#collectReadableLinks).
   * @returns link id -> excerpt.
   */
  async function readLinks(
    placeId: string,
    links: Array<LinkItem>,
    { maxNew = Infinity }: MaxNew = {}
  ): Promise<Reads> {
    const reads = new Map<string, string>();
    const seen = new Set<string>();
    let newCount = 0;
    for (const link of links ?? []) {
      if (!link?.id || seen.has(link.id)) continue;
      seen.add(link.id);
      const { result, attempted } = await readLinkCharged(placeId, link, { cacheOnly: newCount >= maxNew });
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
   * @returns link id -> excerpt.
   */
  function cachedReads(placeId: string, links: Array<LinkItem>): Map<string, string> {
    const reads = new Map<string, string>();
    const seen = new Set<string>();
    for (const link of links ?? []) {
      if (!link?.id || seen.has(link.id)) continue;
      seen.add(link.id);
      if (!readable(link)) continue;
      const cached = cachedRead(placeId, pageKey(link.url)) ?? cachedRead(placeId, linkKey(hot.config, link));
      if (cached && cached !== 'miss') reads.set(link.id, cached.text);
    }
    return reads;
  }

  /**
   * One web search on `query`, condensed with its sources, through the shared
   * cache. Needs the feature, `web.quickSearch.enabled`, the search-summary prompt,
   * a chosen engine that can run (hasSearch), the model the summary goes out on and a non-blank
   * query. No results -> an empty `text` (the caller renders labels.lookup.none). A failure is
   * never cached.
   */
  async function search(placeId: string, query: string): Promise<SearchAnswer> {
    const config = hot.config;
    const searchCfg: SearchSettings = config.web?.quickSearch ?? {};
    if (searchCfg.enabled === false) return null;
    const promptText = hot.prompts?.['search-summary'];
    const asked = cleanQuery(query);
    if (!promptText || !asked) return null;
    const engine = engineOf(config);
    if (engine === null || !hasSearch() || searchModel(config) === undefined) return null;

    const report = (outcome: string, reason: string | null = null, extra: object = {}): void =>
      log.info('lookup: search', { state: outcome, reason, ...extra });
    const cache = store.getMediaCache(placeId);
    const key = searchKey(asked);
    const hit = cache[key];
    if (hit && typeof hit.text === 'string') {
      const maxAgeMs = positiveOr(searchCfg.cacheHours, SEARCH_CACHE_HOURS_FALLBACK) * 60 * MINUTE_MS;
      if (now() - hit.ts < maxAgeMs) {
        touchKey(cache, key, hit);
        store.markMediaCacheDirty(placeId);
        report(hit.text ? 'found' : 'nothing', null, { cached: true, results: hit.sources?.length ?? 0 });
        return { query: hit.query ?? asked, text: hit.text, sources: hit.sources ?? [], cached: true };
      }
      delete cache[key];
      store.markMediaCacheDirty(placeId);
    }

    // The summary request would be refused: no search, no slot.
    if (capSpent()) {
      report('limit', 'daily-cap');
      return null;
    }

    const outcome = await attempt(engine, asked, promptText, config);
    if (outcome.result) {
      const found = outcome.result;
      putEntry(placeId, key, { ...found, ts: now() });
      report(found.text ? 'found' : 'nothing', null, { cached: false, results: found.sources.length, engine });
      return found;
    }
    const { reason, status } = outcome.failure;
    report('error', reason, { ...(status !== undefined ? { status } : {}), engine });
    return null;
  }

  /** Why quick search is off under `config`, or null when the chosen engine has what it needs. */
  function whyOff(config: LookupConfig): { reason: string; engine?: Engine } | null {
    const engine = engineOf(config);
    if (engine === null) return { reason: 'no-engine' };
    if (engine === 'openrouter')
      return typeof llm?.complete === 'function' && searchModel(config) !== undefined
        ? null
        : { reason: 'no-model', engine };
    const key = keys[engine];
    return typeof searches[engine]?.search === 'function' && typeof key === 'string' && key.trim() !== ''
      ? null
      : { reason: NO_KEY, engine };
  }

  /** The summary prompt filled for `asked`, and the summary request's options for this config. */
  function summaryRequest(config: LookupConfig, promptText: string, asked: string, chars: number, cfg: SearchSettings) {
    return {
      system: {
        role: 'system',
        content: fillPromptTemplate(promptText, { query: asked, maxChars: chars, today: todayDate() }),
      },
      options: {
        model: searchModel(config),
        ...roleRequestOptions(config, {
          role: SEARCH_ROLE,
          maxOutputTokens: cfg.maxOutputTokens,
          purpose: 'search-summary',
          long: true,
        }),
      },
    };
  }

  /**
   * One engine's attempt: `{ result }` (found, or nothing found with an empty text and no
   * sources) or `{ failure: { reason, status? } }`. Brave and Exa search, then the summary
   * condenses their results; `openrouter` searches and condenses in one request.
   */
  async function attempt(engine: Engine, asked: string, promptText: string, config: LookupConfig): Promise<Attempt> {
    const searchCfg: SearchSettings = config.web?.quickSearch ?? {};
    const summaryChars = SEARCH_SUMMARY_CHARS;
    const { system, options } = summaryRequest(config, promptText, asked, summaryChars, searchCfg);

    if (engine === 'openrouter') {
      let completion;
      try {
        completion = await llm.complete([system, { role: 'user', content: asked }], {
          ...options,
          // No hedge: a second attempt would run (and bill) the web search twice.
          isRoleRequest: false,
          plugins: webSearchPlugins(SEARCH_RESULTS),
        });
      } catch (err) {
        return {
          failure: {
            reason: openrouterFailure(err),
            ...statusOf(err),
          },
        };
      }
      if (!String(completion.text ?? '').trim()) return { failure: { reason: 'empty' } };
      const note = parseSummaryNote(completion.text, { maxChars: summaryChars });
      if (!note.text) return { result: { query: asked, text: '', sources: [] } };
      const text = cleanText(note.text, summaryChars);
      const sources = citationsOf(completion.annotations).map((c) => ({ ...c, site: siteOf(c.url) }));
      return { result: { query: asked, text, sources } };
    }

    const found = await searches[engine]?.search(asked, {
      apiKey: keys[engine] ?? null,
      count: SEARCH_RESULTS,
      timeoutMs: searchCfg.timeoutMs,
    });
    if (!found?.ok) {
      if (found?.reason === 'empty') return { result: { query: asked, text: '', sources: [] } };
      return {
        failure: {
          reason: found?.reason ?? 'network',
          ...(found?.status !== undefined ? { status: found.status } : {}),
        },
      };
    }
    const limits = { maxChars: summaryChars, maxOutputTokens: Number(searchCfg.maxOutputTokens) };
    const note = await buildSummary({ kind: 'web', query: asked, results: found.results }, limits);
    if (note.status === 'failed') return { failure: { reason: llmFailure(note.error), ...statusOf(note.error) } };
    if (note.reason === 'empty') return { failure: { reason: 'empty' } };
    if (!note.text) return { result: { query: asked, text: '', sources: [] } };
    const sources = found.results.map((r) => ({ title: r.title ?? '', url: r.url, site: siteOf(r.url) }));
    return { result: { query: asked, text: note.text, sources } };
  }

  /**
   * The persona's own web.search: one search on `query` whose results come back raw (see the
   * header): `{ query, results: [{ title, url, site, snippet, age? }], cached? }`, `results`
   * empty when nothing was found; `{ failed: { code, reason?, engine?, status? } }` when it did
   * not search: `not-configured` (`disabled` by `web.quickSearch.enabled`, else `no-engine`, `no-model`
   * or `no-key`), `empty-query` (the cleaned query is blank), `cap` (the day's web slots are spent,
   * or an `openrouter` request would pass `llm.maxRequestsPerDay`), `provider` (the chosen engine
   * failed: `timeout`, `rate-limited`, `credentials` or its own reason). Never reads the
   * search-summary prompt, never sends a summary request. A failure is never cached.
   */
  async function searchResults(placeId: string, query: string): Promise<RawAnswer> {
    const config = hot.config;
    const searchCfg = config.web?.quickSearch ?? {};
    if (searchCfg.enabled === false) return { failed: { code: CODE.NOT_CONFIGURED, reason: 'disabled' } };
    const asked = cleanQuery(query);
    if (!asked) return { failed: { code: CODE.EMPTY_QUERY } };
    const off = whyOff(config);
    const engine = engineOf(config);
    if (off !== null || engine === null)
      return { failed: { code: CODE.NOT_CONFIGURED, ...(off ?? { reason: 'no-engine' }) } };

    const report = (outcome: string, reason: string | null = null, extra: object = {}): void =>
      log.info('lookup: search', { state: outcome, reason, raw: true, ...extra });
    const cache = store.getMediaCache(placeId);
    const key = hashedKey('results', normalizeQuery(asked));
    const hit = cache[key];
    if (hit && Array.isArray(hit.results)) {
      const maxAgeMs = positiveOr(searchCfg.cacheHours, SEARCH_CACHE_HOURS_FALLBACK) * 60 * MINUTE_MS;
      if (now() - hit.ts < maxAgeMs) {
        touchKey(cache, key, hit);
        store.markMediaCacheDirty(placeId);
        report(hit.results.length ? 'found' : 'nothing', null, { cached: true, results: hit.results.length });
        return { query: hit.query ?? asked, results: hit.results, cached: true };
      }
      delete cache[key];
      store.markMediaCacheDirty(placeId);
    }

    // Only the `openrouter` engine sends a model request.
    if (engine === 'openrouter' && capSpent()) {
      report('limit', 'daily-cap');
      return { failed: { code: CODE.CAP } };
    }
    const outcome = await rawAttempt(engine, asked, config);
    if (outcome.results) {
      const result = { query: asked, results: outcome.results };
      putEntry(placeId, key, { ...result, ts: now() });
      report(outcome.results.length ? 'found' : 'nothing', null, {
        cached: false,
        results: outcome.results.length,
        engine,
      });
      return result;
    }
    const { reason, status } = outcome.failure;
    report('error', reason, { ...(status !== undefined ? { status } : {}), engine });
    if (reason === NO_KEY) return { failed: { code: CODE.NOT_CONFIGURED, reason, engine } };
    return {
      failed: {
        code: CODE.PROVIDER,
        reason: toldReason(outcome.failure),
        engine,
        ...(status !== undefined ? { status } : {}),
      },
    };
  }

  /**
   * One engine's raw attempt: `{ results }` (possibly empty: nothing found) or `{ failure }`.
   * `openrouter`: one request with the web plugin, the query as its only message, the answer
   * capped at `web.quickSearch.rawOutputTokens` and never read; the results its `url_citation`
   * annotations. Brave and Exa: their results as they come.
   */
  async function rawAttempt(engine: Engine, asked: string, config: LookupConfig): Promise<RawAttempt> {
    const searchCfg: SearchSettings = config.web?.quickSearch ?? {};
    if (engine === 'openrouter') {
      let completion;
      try {
        completion = await llm.complete([{ role: 'user', content: asked }], {
          model: searchModel(config),
          ...roleRequestOptions(config, {
            role: SEARCH_ROLE,
            maxOutputTokens: positiveOr(searchCfg.rawOutputTokens, RAW_OUTPUT_TOKENS_FALLBACK),
            purpose: 'quick-search',
          }),
          // No hedge: a second attempt would run (and bill) the web search twice.
          isRoleRequest: false,
          plugins: webSearchPlugins(SEARCH_RESULTS),
        });
      } catch (err) {
        return {
          failure: {
            reason: openrouterFailure(err),
            ...statusOf(err),
          },
        };
      }
      return {
        results: urlCitations(completion.annotations).map((c) => ({
          title: c.title,
          url: c.url,
          site: siteOf(c.url),
          snippet: c.snippet,
        })),
      };
    }
    const found = await searches[engine]?.search(asked, {
      apiKey: keys[engine] ?? null,
      count: SEARCH_RESULTS,
      timeoutMs: searchCfg.timeoutMs,
    });
    if (!found?.ok) {
      if (found?.reason === 'empty') return { results: [] };
      return {
        failure: {
          reason: found?.reason ?? 'network',
          ...(found?.status !== undefined ? { status: found.status } : {}),
        },
      };
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
   * extracted main text cut at `PAGE_READ_CHARS` (`cut: true` when it was longer), its
   * title and the url it ended at after redirects; no model request. Needs the feature;
   * takes one daily web slot per fetch (a cache hit is free). `{ ok: false, reason }`:
   * `not-configured` (the feature off), `daily-cap` (the day's slots spent), `empty` (no
   * text on the page; `url` says where it ended up), or the fetcher's reason (`scheme`, `private`, `redirects`, `type`,
   * `size`, `timeout`, `http`, `network`). A page read is cached for
   * `web.links.readCacheHours`; a failure is not.
   */
  async function readPage(placeId: string, url: string): Promise<PageAnswer> {
    const config = hot.config;
    const linksCfg: LinksSettings = config.web?.links ?? {};
    const maxChars = PAGE_READ_CHARS;
    const asked = String(url ?? '').trim();
    const location = safeLocation(asked);
    const report = (outcome: string, reason: string | null = null, extra: object = {}): void =>
      log.info('lookup: page', { state: outcome, reason, location, ...extra });
    const cache = store.getMediaCache(placeId);
    const key = pageKey(asked);
    const hit = cache[key];
    if (hit && typeof hit.text === 'string') {
      if (now() - hit.ts < positiveOr(linksCfg.readCacheHours, PAGE_CACHE_HOURS_FALLBACK) * 60 * MINUTE_MS) {
        touchKey(cache, key, hit);
        store.markMediaCacheDirty(placeId);
        report('read', null, { cached: true, chars: hit.text.length });
        return {
          ok: true,
          url: hit.url ?? '',
          title: hit.title ?? '',
          text: hit.text,
          cut: hit.cut === true,
          cached: true,
        };
      }
    }
    const page = await pageFetcher.fetchText(asked, {
      maxBytes: LINK_MAX_BYTES,
      timeoutMs: linksCfg.fetchTimeoutMs,
      acceptLanguage: config.web?.acceptLanguage,
    });
    if (!page?.ok) {
      const reason = page?.reason ?? 'network';
      report('miss', reason, page?.status !== undefined ? { status: page.status } : {});
      return { ok: false, reason, ...(page?.status !== undefined ? { status: page.status } : {}) };
    }
    const whole = String(page.text ?? '').trim();
    const finalUrl = withoutCredentials(String(page.finalUrl || asked));
    if (!whole) {
      report('miss', 'empty');
      return { ok: false, reason: 'empty', url: finalUrl };
    }
    const text = truncateText(whole, maxChars);
    const read = {
      url: finalUrl,
      title: oneLine(String(page.title ?? '')),
      text,
      cut: text !== whole,
    };
    putEntry(placeId, key, { ...read, ts: now() });
    report('read', null, { cached: false, chars: text.length, cut: read.cut });
    return { ok: true, ...read };
  }

  /** Whether the chosen engine (`web.quickSearch.engine`, read now) has what it needs. `/status` reports it. */
  function hasSearch() {
    return whyOff(hot.config) === null;
  }

  /** The chosen engine's name (`web.quickSearch.engine`, read now), null while none of the three is set. */
  function searchEngine() {
    return engineOf(hot.config);
  }

  return { readLinks, cachedReads, search, searchResults, readPage, hasSearch, searchEngine };
}
