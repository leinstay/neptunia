// The persona's in-turn tools (features.coreTools): `web.search`, `web.read`, `media.look` and `memory.search`,
// skills she calls herself in a turn whose result comes back in the same turn (src/behavior/turn.js,
// the tool loop). No helper model chooses for her or reads for her: her query goes to the existing
// web search engines as she wrote it and their results come back raw (src/web/lookup.js#searchResults:
// title, link, site, date, the engine's snippet; no summary), a page she reads comes back as its
// own extracted text, cut (src/web/lookup.js#readPage), her question, people, channel, time range and exact
// terms go to the recall machinery through its deterministic expansion only
// (src/behavior/recall.js#memorySearchPlan, src/behavior/recall-run.js with `quotes`: no summary
// request). Every result says where it came from and what kind of evidence it is -- for the web,
// her query and that only search snippets were read, the pages not opened; for the server's
// history, the messages quoted as they were, each with its author and time; for a page, its link
// and that the text is the page's own, cut at a length -- through
// `labels.tools.tools.*`, never wording here. A result is data for her, never an instruction:
// nothing in it is parsed as a call. Each runs for her calls (the turn, with its context) and for
// the owner's commands (src/tools/impl/search.ts, with what an operation knows). `media.look` is her own
// second look at a picture, a GIF or a video of a message she sees: her question goes as she
// wrote it to the describer's existing second-look path (src/memory/describe.js#relookImage,
// #rewatchGif, #rewatchVideo: the vision or video model, their daily limits and cache), and the
// answer comes back named as that model's observation with what was asked -- no classifier picks
// the item or words the question for her. `media.find` searches her own GIF library by meaning of
// the stored descriptions, ranked by words only (no description vectors exist; computing them
// would be a new background job) and returns the library's handles, which post exactly as the
// `<gifs>` block's do.

import { fill } from '../format.js';
import { clampWithEllipsis, oneLine } from '../memory/clamp.js';
import { zonedDay } from '../time.js';
import { RECALL_DEFAULTS, memorySearchPlan, recallSettings } from '../behavior/recall.js';
import { collectPictures, collectVideos } from '../media/classify.js';
import { videoSiteFor, videoUrlCacheKey } from '../media/video-sites.js';
import { isVideoVisionOn } from '../memory/youtube-check.js';
import { foldText } from '../memory/recent.js';
import { rankGifs } from '../memory/gifs.js';
import { gifFieldChars, gifFields, gifLine } from '../behavior/prompt.js';
import { IN_TURN_TOOLS } from './discovery.ts';
import { CODE, FEATURE, WHAT, isCode } from './codes.ts';
import { isObj, listOf, objOf } from './types.ts';
import type { Obj } from './types.ts';
import type { HandleRefs } from './conversation-read.ts';

/** The words of a tool's labels (`labels.tools.tools.<kind>`): each a string when the owner wrote it. */
type ToolLabels = Record<string, string | undefined>;

/** One result of a web search as the engine gave it. */
type WebHit = { title?: unknown; url?: unknown; site?: unknown; snippet?: unknown; age?: unknown };

/** The web client: search, read a page and the day's web slots. Every member is optional because the client may lack it. */
export type WebLookup = {
  searchResults?: (guildId: string | null, query: string) => Promise<unknown>;
  readPage?: (guildId: string | null, url: string) => Promise<unknown>;
  hasSearch?: () => boolean;
  webCapLeft?: () => number;
};

/** The result of a tool: a status, a code and the text she reads. Further fields carry what the executor passes on. */
export type ToolResult = {
  status: string;
  code?: string;
  reason?: string;
  values?: Obj;
  data?: { text: string };
};

/** One stretch of the server's history that recall found. */
export type Quote = {
  channelId?: string | null;
  channelName?: string | null;
  startTs: number;
  lines: string;
  entries?: ReadonlyArray<QuoteEntry>;
};

/** One line of a stretch with what the handle registry needs. */
export type QuoteEntry = { id: unknown; text: string; authorId?: unknown; self?: unknown; message?: unknown };

/** The recall runner as the tools use it. */
export type RecallClient = {
  run?: (input: Obj) => Promise<unknown>;
  window?: (input: Obj) => Promise<unknown>;
  available?: () => boolean;
};

/** The describer's second look: one method per kind of media, and the day's slots. */
export type LookDescriber = {
  relookImage?: (guildId: string | null, item: Obj, question: string) => Promise<unknown>;
  rewatchVideo?: (guildId: string | null, item: Obj, question: string) => Promise<unknown>;
  rewatchGif?: (guildId: string | null, item: Obj, question: string) => Promise<unknown>;
  videoCapsLeft?: () => { rewatch?: number; video?: number; gif?: number } | null;
};

/** One thing media.look can look at: a picture, a GIF or a video, by the id the transcript keys it with. */
export type LookItem = Obj & { itemId: string };

/** A GIF of the library: its handle and the cache key of its description. */
type GifEntry = { id: string; itemId: string; [key: string]: unknown };
/** The skills that run inside the persona's turn and come back in it (defined with discovery). */
export { IN_TURN_TOOLS };

/** A string argument trimmed, '' when absent. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A value as plain text: a string as it is, a number or a boolean written out, else empty. */
function plain(value: unknown): string {
  return typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';
}

/** `labels.tools.tools[kind]` as an object, {} when missing. */
function toolLabels(labels: unknown, kind: string): ToolLabels {
  return objOf(objOf(objOf(objOf(labels).tools).tools)[kind]) as ToolLabels;
}

/** How long a title or a link in a web.search result may be. */
const RESULT_TITLE_MAX = 120;
const RESULT_URL_MAX = 300;
/** `web.search.snippetChars` and `web.search.resultsChars` when missing (config.json's values). */
const SNIPPET_CHARS_FALLBACK = 400;
const RESULTS_CHARS_FALLBACK = 3000;
/** `web.links.readChars` when missing (config.json's value). */
const READ_CHARS_FALLBACK = 4000;
/** Query parameters that only track the click and never pick the page. */
const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|yclid|mc_cid|mc_eid|ref_src)$/i;

/** A positive whole number from the config, else `fallback`. */
function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * A result's link as she may hand it on: http(s) only, the fragment and tracking parameters
 * dropped; longer than RESULT_URL_MAX it loses its query string, then is cut with an ellipsis.
 * `{ href, key }` (`key`: host without `www.`, path without a trailing slash, query -- one page
 * once), or null for anything that is not an http(s) URL. Pure.
 */
function cleanLink(raw: unknown): { href: string; key: string } | null {
  let url: URL;
  try {
    url = new URL(plain(raw));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.hash = '';
  for (const name of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(name)) url.searchParams.delete(name);
  if (url.href.length > RESULT_URL_MAX) url.search = '';
  const key = `${url.hostname.replace(/^www\./i, '').toLowerCase()}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  const href = url.href.length > RESULT_URL_MAX ? `${url.href.slice(0, RESULT_URL_MAX - 1)}…` : url.href;
  return { href, key };
}

/**
 * The text of a web.search result (`found`: src/web/lookup.js#searchResults' `{ query, results }`,
 * raw, no helper between): `labels.tools.tools.web.source` (`{query}`), `.goal` (`{goal}`) when
 * she named what she needs to establish, then each result as the engine gave it -- `<n>. <title>`,
 * its link (cleanLink; a result without an http(s) link and a page listed twice are left out),
 * `<site> · <date>` (the date only when the engine gave one), its snippet cut at `snippetChars`
 * -- while the whole stays within `maxChars` (the first result always shows, its snippet cut to
 * fit), then `.more` (`{count}`) for the results left out for room; `.none` when nothing came back. Numbers, links, sites, dates and snippets are data; a
 * missing label adds nothing. Pure.
 * `found` is `{ query, results }` of the search.
 */
export function webSearchText(
  found: unknown,
  {
    goal = '',
    labels,
    snippetChars = SNIPPET_CHARS_FALLBACK,
    maxChars = RESULTS_CHARS_FALLBACK,
  }: { goal?: unknown; labels: unknown; snippetChars?: number; maxChars?: number }
): string {
  const l = toolLabels(labels, 'web');
  const lines: Array<string> = [];
  const given = objOf(found);
  if (l.source) lines.push(fill(l.source, { query: text(given.query) }));
  if (l.goal && text(goal)) lines.push(fill(l.goal, { goal: text(goal) }));
  const seen = new Set<string>();
  const blocks: Array<string> = [];
  let used = lines.join('\n').length;
  const all: Array<WebHit> = listOf(given.results).map(objOf);
  let left = 0;
  for (const [at, result] of all.entries()) {
    const link = cleanLink(result.url);
    if (!link || seen.has(link.key)) continue;
    seen.add(link.key);
    const head: Array<string> = [
      `${blocks.length + 1}. ${clampWithEllipsis(oneLine(result.title), RESULT_TITLE_MAX)}`.trimEnd(),
      link.href,
    ];
    const where = [oneLine(result.site), oneLine(result.age)].filter(Boolean).join(' · ');
    if (where) head.push(where);
    const headText = head.join('\n');
    const room = maxChars - used - headText.length - 2;
    if (blocks.length > 0 && room < 0) {
      // This result and every one listed after it, left out for room.
      left =
        1 +
        all.slice(at + 1).filter((rest) => {
          const next = cleanLink(rest.url);
          if (!next || seen.has(next.key)) return false;
          seen.add(next.key);
          return true;
        }).length;
      break;
    }
    const limit = Math.min(snippetChars, room);
    const snippet = limit > 0 ? clampWithEllipsis(oneLine(result.snippet), limit) : '';
    const block: string = snippet ? `${headText}\n${snippet}` : headText;
    blocks.push(block);
    used += block.length + 1;
  }
  if (blocks.length === 0) {
    if (l.none) lines.push(l.none);
    return lines.join('\n');
  }
  if (left > 0 && l.more) {
    // The closing line takes room too: results give way to it until the whole fits (the first stays).
    const more = l.more;
    const closing = (): string => fill(more, { count: String(left) });
    while (blocks.length > 1 && used + closing().length + 1 > maxChars) {
      used -= (blocks.pop() ?? '').length + 1;
      left += 1;
    }
    return [...lines, ...blocks, closing()].join('\n');
  }
  return [...lines, ...blocks].join('\n');
}

/**
 * The text of a web.read result (`page`: src/web/lookup.js#readPage's `{ url, title, text, cut }`):
 * `labels.tools.tools.read.source` (`{url}`: where the page ended up, `{maxChars}`), `.title`
 * (`{title}`) when the page has one, the page's own text as extracted, then `.cut` (`{maxChars}`)
 * when it was cut. A missing label adds nothing. Pure.
 * `page` is `{ url, title, text, cut }` of the page read.
 */
export function webReadText(
  page: unknown,
  { labels, maxChars = READ_CHARS_FALLBACK }: { labels: unknown; maxChars?: number }
): string {
  const l = toolLabels(labels, 'read');
  const lines: Array<string> = [];
  const read = objOf(page);
  if (l.source) lines.push(fill(l.source, { url: text(read.url), maxChars: String(maxChars) }));
  const title = oneLine(read.title);
  if (l.title && title) lines.push(fill(l.title, { title }));
  lines.push(plain(read.text).trim());
  if (read.cut === true && l.cut) lines.push(fill(l.cut, { maxChars: String(maxChars) }));
  return lines.join('\n');
}

/**
 * The text of a memory.search result (`quotes`: recall's stretches, `{ channelName, startTs,
 * lines }`): `labels.tools.tools.memory.source`, then per stretch `.window` (`{date}`: its first
 * line's day as `YYYY-MM-DD` in `timezone`, `{channel}`: its channel's name) and its lines as they
 * were (time and author on each); `.none` when there is none. Each stretch is cut on its own at
 * `windowChars` (its last lines dropped, then `.windowCut` with `{dropped}`, the number of lines
 * dropped); the whole result is counted stretch by stretch against `maxChars`: a stretch that does
 * not fit whole is left out with every one after it, and a closing `.windowsLeft` (`{count}`,
 * `{where}`: each left-out stretch's channel and day, comma-joined) says what she did not get. The
 * first stretch always stays. A missing label adds nothing.
 *
 * With `hidden` (the search found that a better match exists only in a private conversation this one may not open) a
 * last line, `.hidden`, says so: no text, no count. Shown with or without stretches.
 *
 * With `refs` (`{ next(): number, take(shown): void }`, the turn's handle registry) and a stretch's
 * `entries` (`{ id, text, authorId, self, message }` per line), each quoted line starts with a `#N`
 * handle numbered on from `refs.next()`, `.handles` follows the source line, and the lines that
 * stayed in the text after the cuts are handed to `refs.take` (`{ n, id, channelId, authorId, self,
 * message }`); a line cut away is never registered. Otherwise pure.
 */
export function memorySearchText(
  quotes: ReadonlyArray<Quote> | null | undefined,
  {
    labels,
    timezone = 'UTC',
    windowChars = RECALL_DEFAULTS.quoteWindowChars,
    maxChars = RECALL_DEFAULTS.quoteMaxChars,
    refs = null,
    hidden = false,
  }: {
    labels: unknown;
    timezone?: string;
    windowChars?: number;
    maxChars?: number;
    refs?: HandleRefs | null;
    hidden?: boolean;
  }
): string {
  const l = toolLabels(labels, 'memory');
  const lines: Array<string> = l.source ? [l.source] : [];
  let counter = refs ? refs.next() : 0;
  const numbered = (quote: Quote): Array<QuoteEntry & { n: number; shown: string }> | null => {
    if (!refs || !Array.isArray(quote.entries) || quote.entries.length === 0) return null;
    const list = quote.entries.map((entry) => ({ ...entry, n: counter++, shown: `#${counter - 1} ${entry.text}` }));
    return list;
  };
  let handled = false;
  const shown = (Array.isArray(quotes) ? quotes : []).filter(
    (quote) => typeof quote.lines === 'string' && quote.lines.trim() && Number.isFinite(quote.startTs)
  );
  if (shown.length === 0) {
    if (l.none) lines.push(l.none);
    if (hidden && l.hidden) lines.push(l.hidden);
    return lines.join('\n');
  }
  const kept: Array<{ block: Array<string>; where: string; size: number; stayed: Array<Obj> }> = [];
  const left: Array<string> = [];
  let used = lines.join('\n').length;
  const bounded = Number.isFinite(maxChars) && maxChars > 0;
  for (const quote of shown) {
    const day = zonedDay(quote.startTs, timezone);
    const channelName = plain(quote.channelName);
    const block: Array<string> = [];
    if (l.window) block.push(fill(l.window, { date: day, channel: channelName }));
    const entries = numbered(quote);
    const quoted = cutWindowLines(entries ? entries.map((entry) => entry.shown).join('\n') : quote.lines, windowChars);
    block.push(quoted.text);
    // The entries still in the text: whole entries from the top, up to the lines that stayed.
    const stayed: Array<Obj> = [];
    if (entries) {
      let remaining = quoted.text.split('\n').length;
      for (const entry of entries) {
        if (remaining <= 0) break;
        stayed.push({
          n: entry.n,
          id: entry.id,
          channelId: quote.channelId ?? null,
          authorId: entry.authorId,
          self: entry.self,
          message: entry.message,
        });
        remaining -= entry.shown.split('\n').length;
      }
    }
    if (quoted.dropped > 0 && l.windowCut) block.push(fill(l.windowCut, { dropped: String(quoted.dropped) }));
    const where = [channelName, day].filter(Boolean).join(' ');
    const size = block.join('\n').length + 1;
    if (left.length > 0 || (kept.length > 0 && bounded && used + size > maxChars)) {
      left.push(where);
      continue;
    }
    kept.push({ block, where, size, stayed });
    used += size;
  }
  // The closing line takes room too: windows give way to it until the whole fits.
  const closing = (): string =>
    left.length > 0 && l.windowsLeft ? fill(l.windowsLeft, { count: String(left.length), where: left.join(', ') }) : '';
  while (bounded && kept.length > 1 && used + closing().length + 1 > maxChars) {
    const dropped = kept.pop();
    if (!dropped) break;
    used -= dropped.size;
    left.unshift(dropped.where);
  }
  for (const { block, stayed } of kept) {
    lines.push(...block);
    if (refs && stayed.length > 0) {
      refs.take(stayed);
      handled = true;
    }
  }
  if (handled && l.handles) lines.splice(l.source ? 1 : 0, 0, l.handles);
  if (closing()) lines.push(closing());
  if (hidden && l.hidden) lines.push(l.hidden);
  return lines.join('\n');
}

/** One stretch's lines cut at `limit` characters: whole lines from the top (the first always stays, clamped when alone too long), how many were dropped. */
function cutWindowLines(value: string, limit: number): { text: string; dropped: number } {
  const all = value.split('\n');
  if (!Number.isFinite(limit) || limit <= 0 || value.length <= limit) return { text: value, dropped: 0 };
  const kept: Array<string> = [];
  let used = 0;
  for (const line of all) {
    const add = line.length + (kept.length > 0 ? 1 : 0);
    if (kept.length > 0 && used + add > limit) break;
    kept.push(line);
    used += add;
  }
  const only = kept[0];
  if (kept.length === 1 && only !== undefined && only.length > limit) kept[0] = clampWithEllipsis(only, limit);
  return { text: kept.join('\n'), dropped: all.length - kept.length };
}

/**
 * One web.search: `args.query` (her words, as she wrote them) through `lookup.searchResults` (the
 * existing engines, their cache, the daily web slot `web.maxPerDay`; the results raw, no
 * summary), `args.goal` only echoed back with the result. `not_configured` (`not-configured`)
 * without the client, the feature (features.webLookup, read now) or a search engine; `invalid`
 * (`invalid-args`) without a query; `failed` with `daily-cap` once the day's web slots are spent,
 * `error` when the search gave nothing back; the lookup's own failures by their code: `not-configured`,
 * `invalid` (`empty-query`), `cap`, `failed` (`provider`, with the last engine status in `values.status`); else `ok` with webSearchText (cut by
 * `web.search.snippetChars` and `web.search.resultsChars`, read now) as its `data.text`. Never
 * throws.
 */
export async function runWebSearch({
  lookup,
  config,
  labels,
  guildId,
  args,
}: {
  lookup: WebLookup | null;
  config: unknown;
  labels: unknown;
  guildId: string | null;
  args: unknown;
}): Promise<ToolResult> {
  try {
    const given = objOf(args);
    const query = text(given.query);
    if (!query) return { status: 'invalid', code: CODE.INVALID_ARGS, reason: 'args.query:required' };
    const searchCfg = objOf(objOf(objOf(config).web).search);
    if (
      !lookup ||
      typeof lookup.searchResults !== 'function' ||
      objOf(objOf(config).features).webLookup !== true ||
      searchCfg.enabled === false
    )
      return { status: 'not_configured', code: CODE.NOT_CONFIGURED, values: { feature: FEATURE.web } };
    if (typeof lookup.hasSearch === 'function' && !lookup.hasSearch())
      return { status: 'not_configured', code: CODE.NOT_CONFIGURED, values: { feature: FEATURE.web } };
    if (typeof lookup.webCapLeft === 'function' && !(lookup.webCapLeft() > 0))
      return { status: 'failed', code: CODE.DAILY_CAP };
    const answer = await lookup.searchResults(guildId, query);
    if (!isObj(answer)) return { status: 'failed', code: CODE.ERROR };
    const found = answer;
    // The lookup's own coded failure (src/web/lookup.js#searchResults): said as it was.
    if (found.failed) {
      const failure = objOf(found.failed);
      const code = plain(failure.code);
      if (code === CODE.NOT_CONFIGURED) return { status: 'not_configured', code, values: { feature: FEATURE.web } };
      if (code === CODE.EMPTY_QUERY) return { status: 'invalid', code };
      if (code === CODE.PROVIDER) return { status: 'failed', code, values: { status: plain(failure.status) } };
      return code === CODE.CAP
        ? { status: 'failed', code: CODE.CAP, values: { what: WHAT.search } }
        : { status: 'failed', code: CODE.ERROR };
    }
    const shown = webSearchText(
      { ...found, query: found.query ?? query },
      {
        goal: given.goal,
        labels,
        snippetChars: positiveOr(searchCfg.snippetChars, SNIPPET_CHARS_FALLBACK),
        maxChars: positiveOr(searchCfg.resultsChars, RESULTS_CHARS_FALLBACK),
      }
    );
    return { status: 'ok', data: { text: shown } };
  } catch {
    return { status: 'failed', code: CODE.ERROR };
  }
}

/** An http(s) link inside a message's text: up to the first space or angle bracket. */
const LINK_IN_TEXT = /https?:\/\/[^\s<>]+/i;

/**
 * The first http(s) link written in `text` (a message's own words), or null: what web.read
 * reads of a message whose link the platform did not embed. Pure.
 */
export function firstLinkIn(value: unknown): string | null {
  const match = typeof value === 'string' ? LINK_IN_TEXT.exec(value) : null;
  return match?.[0] ?? null;
}

/** The page codes of src/web/lookup.js#readPage that mean the call itself was not right. */
const READ_INVALID = new Set(['scheme']);

/**
 * One web.read: the page at `args.url`, or the first link of the message `args.message` names
 * (an id her `#N` resolved to: `linkOf(id)`, the caller's, resolves to a url or null), through
 * `lookup.readPage` (the SSRF-guarded fetcher, the daily web slot, no model request).
 * `invalid` (`invalid-args`) without either, (`no-link`) when that message holds no link, and
 * (`scheme`) for a url that is not http(s); `not_configured` (`not-configured`) without the
 * client or the feature (features.webLookup, read now); `failed` with `daily-cap` once the day's
 * web slots are spent, else with the page's code (`private`, `type`, `size`, `http`,
 * `timeout`, ...); `ok` with webReadText (`web.links.readChars`, read now) as its `data.text`, or
 * `.none` when the page had no text. Never throws.
 */
export async function runWebRead({
  lookup,
  config,
  labels,
  guildId,
  args,
  linkOf = null,
}: {
  lookup: WebLookup | null;
  config: unknown;
  labels: unknown;
  guildId: string | null;
  args: unknown;
  linkOf?: ((messageId: string) => string | null | Promise<string | null>) | null;
}): Promise<ToolResult> {
  try {
    const given = objOf(args);
    let url = text(given.url);
    const messageId = text(given.message);
    if (!url && !messageId) return { status: 'invalid', code: CODE.INVALID_ARGS, reason: 'args.url:required' };
    if (!lookup || typeof lookup.readPage !== 'function' || objOf(objOf(config).features).webLookup !== true)
      return { status: 'not_configured', code: CODE.NOT_CONFIGURED, values: { feature: FEATURE.web } };
    if (!url) {
      url = text(typeof linkOf === 'function' ? await linkOf(messageId) : null);
      if (!url) return { status: 'invalid', code: CODE.NO_LINK };
    }
    if (typeof lookup.webCapLeft === 'function' && !(lookup.webCapLeft() > 0))
      return { status: 'failed', code: CODE.DAILY_CAP };
    const page = objOf(await lookup.readPage(guildId, url));
    const maxChars = positiveOr(objOf(objOf(objOf(config).web).links).readChars, READ_CHARS_FALLBACK);
    if (page.ok === true) return { status: 'ok', data: { text: webReadText(page, { labels, maxChars }) } };
    const reason = plain(page.reason ?? CODE.ERROR);
    if (reason === 'empty') {
      const l = toolLabels(labels, 'read');
      return {
        status: 'ok',
        data: {
          text: [l.source ? fill(l.source, { url, maxChars: String(maxChars) }) : '', l.none ?? '']
            .filter(Boolean)
            .join('\n'),
        },
      };
    }
    if (reason === CODE.NOT_CONFIGURED)
      return { status: 'not_configured', code: reason, values: { feature: FEATURE.web } };
    // A page code the catalogue knows is told as it is (an HTTP status rides along); any other is `error`.
    const code = isCode(reason) ? reason : CODE.ERROR;
    return {
      status: READ_INVALID.has(code) ? 'invalid' : 'failed',
      code,
      ...(code === CODE.HTTP && page.status !== undefined ? { values: { status: plain(page.status) } } : {}),
      ...(code === CODE.TIMEOUT ? { values: { what: WHAT.page } } : {}),
    };
  } catch {
    return { status: 'failed', code: CODE.ERROR };
  }
}

/**
 * One memory.search: her `question`, `people`, `when` and `terms` as memorySearchPlan reads them
 * (the stored profiles for the names, `recall.maxForms`, `bot.timezone`, read now), her
 * `channel` (already an id) bounding the stretches, then `recall.run` with `quotes` -- the server
 * search of the recall runner, its daily cap and its rails, without the summary request --
 * over the turn's `history` (its lines are left out: she sees them already) and `decorate`.
 * `not_configured` without the runner or while it is not available; `not_configured`
 * (`unsupported`) in a private chat without its partner; `invalid` (`no-query`) when nothing is
 * left to search; else `ok` with memorySearchText as its `data.text`. With `args.anchor` (a message id: the
 * executor resolves a `#N`) the call is a window read instead (`recall.window`: `move` `up` | `down`, `messages`
 * or `minutes`): the same text, `invalid` (`unknown-message`) for an anchor that cannot be opened,
 * `not_configured` while the runner has no database to read. `asker` is the user id of whoever asked (the trigger's
 * author): the hidden-DM marker is set only for that person's own private chat; the window read gets it too.
 * `memoryContext` (optional): the turn's execution context, handed to the recall runner. Never throws.
 */
export async function runMemorySearch({
  recall,
  store,
  config,
  labels,
  guildId,
  snapshot = null,
  channel,
  partnerId = null,
  selfId = null,
  selfName = '',
  history = [],
  decorate = null,
  args,
  now = Date.now(),
  refs = null,
  asker = null,
  memoryContext = null,
}: {
  recall: RecallClient | null;
  store?: { listUserProfiles?: (guildId: string) => unknown } | null;
  config: unknown;
  labels: unknown;
  guildId: string | null;
  snapshot?: unknown;
  channel?: { communityId?: unknown } | null;
  partnerId?: string | null;
  selfId?: string | null;
  selfName?: string;
  history?: ReadonlyArray<unknown>;
  decorate?: unknown;
  args: unknown;
  now?: number;
  refs?: HandleRefs | null;
  asker?: string | null;
  memoryContext?: unknown;
}): Promise<ToolResult> {
  try {
    if (!recall || typeof recall.run !== 'function' || (typeof recall.available === 'function' && !recall.available()))
      return { status: 'not_configured', code: CODE.NOT_CONFIGURED };
    if (!guildId || (channel?.communityId == null && !partnerId))
      return { status: 'not_configured', code: CODE.UNSUPPORTED };
    const settings = recallSettings(objOf(config));
    const zone = objOf(objOf(config).bot).timezone;
    const timezone = typeof zone === 'string' ? zone : 'UTC';
    const given = objOf(args);
    // An `anchor` makes the call a window read: the lines up or down from that message, no search.
    if (text(given.anchor)) {
      if (typeof recall.window !== 'function') return { status: 'not_configured', code: CODE.NOT_CONFIGURED };
      const count = (value: unknown): number | null =>
        Number.isInteger(value) && (value as number) > 0 ? (value as number) : null;
      const read = objOf(
        await recall.window({
          guildId,
          snapshot,
          channel,
          partnerId,
          selfName,
          history,
          anchor: text(given.anchor),
          move: text(given.move) === 'down' ? 'down' : 'up',
          messages: count(given.messages),
          minutes: count(given.minutes),
          decorate,
          asker,
          ...(memoryContext ? { memoryContext } : {}),
        })
      );
      const kind = objOf(read.outcome).kind ?? null;
      if (kind === 'not-configured') return { status: 'not_configured', code: CODE.NOT_CONFIGURED };
      if (kind === 'unknown-anchor') return { status: 'invalid', code: CODE.UNKNOWN_MESSAGE, reason: 'args.anchor' };
      if (kind === 'error' || !Array.isArray(read.quotes)) return { status: 'failed', code: CODE.ERROR };
      return {
        status: 'ok',
        data: {
          text: memorySearchText(read.quotes as Array<Quote>, {
            labels,
            timezone,
            windowChars: settings?.quoteWindowChars,
            maxChars: settings?.quoteMaxChars,
            refs,
          }),
        },
      };
    }
    const plan = memorySearchPlan({
      question: text(given.question),
      people: text(given.people),
      terms: text(given.terms),
      when: text(given.when),
      channelId: text(given.channelId) || null,
      profiles:
        typeof store?.listUserProfiles === 'function' ? listOf(store.listUserProfiles(guildId)).filter(isObj) : [],
      selfId,
      selfName,
      maxForms: settings?.maxForms,
      timezone,
      now,
    });
    if (!plan) return { status: 'invalid', code: CODE.NO_QUERY };
    const candidate = { id: null, content: text(given.question), authorId: asker };
    const found = objOf(
      await recall.run({
        guildId,
        snapshot,
        channel,
        partnerId,
        selfId,
        selfName,
        history,
        candidate,
        server: plan,
        decorate,
        quotes: true,
        ...(memoryContext ? { memoryContext } : {}),
      })
    );
    const outcome = objOf(found.outcome);
    const quotes: Array<Quote> = Array.isArray(found.quotes) ? (found.quotes as Array<Quote>) : [];
    const shown = (): string =>
      memorySearchText(quotes, {
        labels,
        timezone,
        windowChars: settings?.quoteWindowChars,
        maxChars: settings?.quoteMaxChars,
        refs,
        hidden: found.hidden === true,
      });
    // A run that did not search says so; an empty search that ran stays an ok with `memory.none`.
    if (outcome.kind === 'daily-cap') return { status: 'denied', code: CODE.DAILY_CAP };
    if (outcome.kind === 'not-configured') return { status: 'not_configured', code: CODE.NOT_CONFIGURED };
    if (outcome.kind === 'not-visible') return { status: 'denied', code: CODE.CHANNEL_NOT_VISIBLE };
    if (outcome.kind === 'error') return { status: 'failed', code: CODE.ERROR };
    if (outcome.kind === 'timeout')
      return quotes.length > 0
        ? { status: 'partial', code: CODE.TIMEOUT, values: { what: WHAT.search }, data: { text: shown() } }
        : { status: 'failed', code: CODE.TIMEOUT, values: { what: WHAT.search } };
    const l = toolLabels(labels, 'memory');
    const lines: Array<string> = [];
    if (outcome.degraded === true && l.degraded) lines.push(l.degraded);
    lines.push(shown());
    if (typeof outcome.failed === 'number' && outcome.failed > 0 && l.partial)
      lines.push(fill(l.partial, { failed: String(outcome.failed), total: plain(outcome.total) }));
    return { status: 'ok', data: { text: lines.join('\n') } };
  } catch {
    return { status: 'failed', code: CODE.ERROR };
  }
}

/** `media.look.maxPerTurn` when missing (config.json's value). */
export const LOOK_PER_TURN_FALLBACK = 2;

/**
 * The most second looks one turn of hers may take (`media.look.maxPerTurn`, read by the caller
 * now; a whole number of at least 1, else LOOK_PER_TURN_FALLBACK). Pure.
 */
export function lookPerTurn(config: unknown): number {
  return positiveOr(objOf(objOf(objOf(config).media).look).maxPerTurn, LOOK_PER_TURN_FALLBACK);
}

/**
 * What media.look can look at in one normalized message, in the order the message shows them
 * (src/media/classify.js#collectPictures: attachments, then embeds, the forwarded parts after),
 * numbered 1.. by that order: an attached or embedded picture (`image`), a GIF (`gif`: watched
 * as a clip), a video (`video`: an attachment, or a link of a `videoSites` site --
 * collectVideos -- listed once, where it first shows; one without a preview picture after the
 * rest). Stickers are not looked at again. [] for no message. Pure.
 */
export function lookableMedia(
  message: unknown,
  { videoSites = [] }: { videoSites?: unknown } = {}
): Array<{ kind: 'image' | 'gif' | 'video'; item: LookItem }> {
  if (!isObj(message)) return [];
  const videos = collectVideos(message, { videoSites: Array.isArray(videoSites) ? (videoSites as Array<string>) : [] });
  const videoById = new Map<string, LookItem>(videos.map((video) => [video.itemId, video as LookItem]));
  const seen = new Set<string>();
  const out: Array<{ kind: 'image' | 'gif' | 'video'; item: LookItem }> = [];
  for (const item of collectPictures(message)) {
    if (!item.itemId || seen.has(item.itemId)) continue;
    const video = videoById.get(item.itemId);
    if (video) out.push({ kind: 'video', item: video });
    else if (item.kind === 'image' || item.kind === 'gif') out.push({ kind: item.kind, item });
    else continue;
    seen.add(item.itemId);
  }
  for (const video of videos) {
    if (seen.has(video.itemId)) continue;
    seen.add(video.itemId);
    out.push({ kind: 'video', item: video });
  }
  return out;
}

/**
 * The text of a media.look result: `labels.tools.tools.look.image` for a picture, `.video` for
 * a video or a GIF (watched as a clip), each with `{name}` (the item's name) and `{question}`
 * (what was asked), then the model's answer as it gave it. A missing label adds nothing. Pure.
 */
export function mediaLookText(
  {
    kind,
    name = '',
    question = '',
    text: answer = '',
  }: { kind: string; name?: string; question?: string; text?: string },
  { labels }: { labels: unknown }
): string {
  const l = toolLabels(labels, 'look');
  const label = kind === 'image' ? l.image : l.video;
  const lines: Array<string> = [];
  if (label) lines.push(fill(label, { name: oneLine(name), question: oneLine(question) }));
  lines.push(answer.trim());
  return lines.join('\n');
}

/**
 * The describer's second look for each kind and whether its switches let it run now: a picture
 * under features.imageRelook (the look runs through the vision model like a caption), a video and a GIF under video vision
 * (src/memory/youtube-check.js#isVideoVisionOn) and features.videoRewatch (a missing key counts
 * as on, each, as the describer reads them).
 */
const LOOKS: Readonly<
  Record<
    'image' | 'video' | 'gif',
    { method: 'relookImage' | 'rewatchVideo' | 'rewatchGif'; on: (features: Obj, config: unknown) => boolean }
  >
> = Object.freeze({
  image: { method: 'relookImage', on: (features) => features.imageRelook !== false },
  video: {
    method: 'rewatchVideo',
    on: (features, config) => isVideoVisionOn(objOf(config)) && features.videoRewatch !== false,
  },
  gif: {
    method: 'rewatchGif',
    on: (features, config) => isVideoVisionOn(objOf(config)) && features.videoRewatch !== false,
  },
});

/** The switch that keeps the second look of `kind` off, by its name (`features.<name>`, or the video vision's own); '' when none is, the describer lacking the method. */
function switchOf(kind: string, features: Obj, config: unknown): string {
  if (kind === 'image') return features.imageRelook === false ? 'features.imageRelook' : '';
  if (!isVideoVisionOn(objOf(config))) return 'video vision';
  return features.videoRewatch === false ? 'features.videoRewatch' : '';
}

/**
 * One media.look: the picture, GIF or video number `args.item` (1.., default 1; lookableMedia's
 * order) of the message `args.message` names, or (`args.url`, exactly one of the two) a video link of a
 * `media.video.sites` site (`not-video-site` otherwise, `data.text` from `labels.tools.tools.look.notVideoSite`, `{sites}`; the
 * engine fetches no other host) looked at as a chat's video link is, with `name` the link itself. A message is an id her `#N` resolved to (`mediaOf(id)`, the
 * caller's, gives the normalized message or null). The item is looked at again with her `args.question` as
 * she wrote it through the describer's second look (relookImage, rewatchGif, rewatchVideo: their
 * daily counters, their cache, `llm.maxRequestsPerDay`). `invalid` (`invalid-args`) without a
 * message-or-url (both or neither) or a question, an unparseable url, or with an item the message does not hold; `invalid`
 * (`unknown-message`, reason `message-deleted` for a deleted one) when the message is not one she sees, (`no-media`) when it holds nothing to
 * look at; `not_configured` (`not-configured`) without the describer or its second look for that
 * kind, or while the kind's switches are off (read now; the switch named in `data.text` from `labels.tools.tools.look.off`, `{feature}`); `failed` with `daily-cap` when the
 * describer's `videoCapsLeft()` says the day's second looks are spent (a video also needs a video
 * slot, a GIF a GIF watch slot), with `turn-cap` when `takeTurnSlot()` (the caller's per-turn
 * count, asked only once every other check passed) refuses, with `error` when the second look
 * gave nothing back; else `ok` with mediaLookText as its `data.text`. Never throws.
 */
export async function runMediaLook({
  describer,
  config,
  labels,
  guildId,
  args,
  mediaOf,
  takeTurnSlot = null,
}: {
  describer: LookDescriber | null;
  config: unknown;
  labels: unknown;
  guildId: string | null;
  args: unknown;
  mediaOf: (messageId: string) => unknown;
  takeTurnSlot?: (() => boolean) | null;
}): Promise<ToolResult> {
  try {
    const given = objOf(args);
    const messageId = text(given.message);
    const link = text(given.url);
    const question = text(given.question);
    const mediaCfg = objOf(objOf(config).media);
    const features = objOf(objOf(config).features);
    if (messageId && link) return { status: 'invalid', code: CODE.INVALID_ARGS, reason: 'args.url|message:one' };
    if (!messageId && !link) return { status: 'invalid', code: CODE.INVALID_ARGS, reason: 'args.url|message:one' };
    if (!question) return { status: 'invalid', code: CODE.INVALID_ARGS, reason: 'args.question:required' };
    let kind: 'image' | 'gif' | 'video';
    let item: LookItem;
    if (link) {
      let parsed = null;
      try {
        parsed = new URL(link);
      } catch {
        parsed = null;
      }
      if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:'))
        return { status: 'invalid', code: CODE.INVALID_ARGS, reason: 'args.url:bad' };
      const sites = objOf(mediaCfg.video).sites;
      const site = Array.isArray(sites) ? videoSiteFor(link, sites) : null;
      if (!site) {
        const notVideo = toolLabels(labels, 'look').notVideoSite;
        const list = Array.isArray(sites) ? sites.join(', ') : '';
        return {
          status: 'invalid',
          code: CODE.NOT_VIDEO_SITE,
          ...(notVideo ? { data: { text: fill(notVideo, { sites: list }) } } : {}),
        };
      }
      if (!describer) return { status: 'not_configured', code: CODE.NOT_CONFIGURED };
      kind = 'video';
      item = {
        source: 'link',
        messageId: null,
        itemId: videoUrlCacheKey(link),
        kind: 'link',
        url: link,
        site,
        name: link,
        durationSec: null,
      };
    } else {
      if (!describer) return { status: 'not_configured', code: CODE.NOT_CONFIGURED };
      const message = objOf(typeof mediaOf === 'function' ? await mediaOf(messageId) : null);
      if (Object.keys(message).length === 0) return { status: 'invalid', code: CODE.UNKNOWN_MESSAGE };
      // A placeholder line of a deleted message: gone, whatever it held.
      if (message.deleted === true)
        return { status: 'invalid', code: CODE.UNKNOWN_MESSAGE, reason: CODE.MESSAGE_DELETED };
      const media = lookableMedia(message, { videoSites: objOf(mediaCfg.video).sites });
      if (media.length === 0) return { status: 'invalid', code: CODE.NO_MEDIA };
      const wanted = given.item;
      const n = wanted === undefined || wanted === null || wanted === '' ? 1 : Number(wanted);
      const chosen = media[n - 1];
      if (!Number.isInteger(n) || n < 1 || chosen === undefined)
        return { status: 'invalid', code: CODE.INVALID_ARGS, reason: 'args.item:range' };
      ({ kind, item } = chosen);
    }
    const look = LOOKS[kind];
    if (!look.on(features, config) || typeof describer?.[look.method] !== 'function') {
      // The switch that is off, by name (`labels.tools.tools.look.off`, as the call mark's op text).
      const feature = switchOf(kind, features, config);
      const off = toolLabels(labels, 'look').off;
      return {
        status: 'not_configured',
        code: CODE.NOT_CONFIGURED,
        ...(feature && off ? { data: { text: fill(off, { feature }) } } : {}),
      };
    }
    const slots = typeof describer?.videoCapsLeft === 'function' ? describer.videoCapsLeft() : null;
    if (
      slots &&
      (!((slots.rewatch ?? 0) > 0) ||
        (kind === 'video' && !((slots.video ?? 0) > 0)) ||
        (kind === 'gif' && !((slots.gif ?? Infinity) > 0)))
    )
      return { status: 'failed', code: CODE.DAILY_CAP };
    if (typeof takeTurnSlot === 'function' && !takeTurnSlot()) return { status: 'failed', code: CODE.TURN_CAP };
    const answer = objOf(await describer?.[look.method]?.(guildId, item, question));
    const said = typeof answer.text === 'string' ? answer.text.trim() : '';
    if (!said) return { status: 'failed', code: CODE.ERROR };
    return {
      status: 'ok',
      data: {
        text: mediaLookText(
          { kind, name: plain(item.name), question: text(answer.question) || question, text: said },
          { labels }
        ),
      },
    };
  } catch {
    return { status: 'failed', code: CODE.ERROR };
  }
}

/** `media.find` result count: the default and the most one call returns. */
export const FIND_DEFAULT = 5;
export const FIND_MAX = 10;
/** A word shorter than this is matched whole only; from it on a shared stem of this many letters counts as a near match. */
const STEM_MIN = 4;

/** The words of `value` folded for comparison (lower case, no accents), letters and digits only, one letter words dropped. */
function wordsOf(value: unknown): Array<string> {
  return foldText(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);
}

/** How well query word `q` matches document word `d`: 1 equal, 0.6 one starts with the other (both at least STEM_MIN long), else 0. */
function wordScore(q: string, d: string): number {
  if (q === d) return 1;
  if (q.length >= STEM_MIN && d.length >= STEM_MIN && (d.startsWith(q) || q.startsWith(d))) return 0.6;
  return 0;
}

/**
 * The library's GIFs that match `query`, best first: each entry's stored description (its reaction,
 * its action and its on-screen text, from the describer cache) scored word by word against the
 * query's words (folded: case and accents ignored, so descriptions in either language match; the
 * best match of each query word counts, the reaction field double); entries scoring nothing are left
 * out, ties keep the library's own rank (most used and most recent first). At most `n` (1..FIND_MAX,
 * FIND_DEFAULT when not a number). Pure.
 * `gifs` is the stored library (store.getGifs) and `mediaCache` the describer cache (store.getMediaCache), read only.
 * The entries come back best first, `id` the handle.
 */
export function findGifs(
  gifs: unknown,
  mediaCache: Obj | null,
  query: string,
  { n = FIND_DEFAULT, halfLifeDays = 30 }: { n?: unknown; halfLifeDays?: number } = {}
): Array<GifEntry> {
  const wanted = [...new Set(wordsOf(query))];
  if (wanted.length === 0) return [];
  const count = Number.isFinite(Number(n)) && Number(n) >= 1 ? Math.min(FIND_MAX, Math.floor(Number(n))) : FIND_DEFAULT;
  const scored: Array<{ entry: GifEntry; score: number; at: number }> = [];
  for (const [at, ranked] of (rankGifs(gifs, halfLifeDays) as Array<GifEntry>).entries()) {
    const entry = ranked;
    const cached = objOf(mediaCache?.[entry.itemId]);
    if (Object.keys(cached).length === 0 || cached.miss) continue;
    const fields = gifFields(entry, mediaCache, { reactionChars: 0, actionChars: 0 });
    const parts: Array<[unknown, number]> = fields
      ? [
          [fields.reaction, 2],
          [fields.action, 1],
          [fields.text, 1],
        ]
      : [[typeof cached.text === 'string' ? cached.text : '', 1]];
    const docs = parts.map(([value, weight]) => ({ words: wordsOf(value), weight }));
    if (docs.every((doc) => doc.words.length === 0)) continue;
    let score = 0;
    for (const q of wanted) {
      let best = 0;
      for (const doc of docs) for (const d of doc.words) best = Math.max(best, wordScore(q, d) * doc.weight);
      score += best;
    }
    if (score > 0) scored.push({ entry, score, at });
  }
  scored.sort((a, b) => b.score - a.score || a.at - b.at);
  return scored.slice(0, count).map((item) => item.entry);
}

/**
 * The text of a media.find result: `labels.tools.tools.find.source` (`{query}`, `{count}`), then one
 * line per GIF as the `<gifs>` block writes an entry (its handle and stored description, gifLine:
 * `labels.gifs.entryFields` / `.entry`); `labels.tools.tools.find.none` when there is none. A missing
 * label adds nothing. Pure.
 * `found` is findGifs' entries.
 */
export function mediaFindText(
  found: ReadonlyArray<GifEntry>,
  {
    query = '',
    labels,
    mediaCache = null,
    config = {},
  }: { query?: string; labels: unknown; mediaCache?: Obj | null; config?: unknown }
): string {
  const l = toolLabels(labels, 'find');
  const lines: Array<string> = [];
  if (found.length === 0) {
    if (l.source) lines.push(fill(l.source, { query: oneLine(query), count: '0' }));
    if (l.none) lines.push(l.none);
    return lines.join('\n');
  }
  if (l.source) lines.push(fill(l.source, { query: oneLine(query), count: String(found.length) }));
  const chars = gifFieldChars(objOf(objOf(config).gifs));
  for (const entry of found)
    lines.push(gifLine(entry, mediaCache, objOf(labels), { ...chars, ownMarkHours: 0, now: 0 }));
  return lines.join('\n');
}

/**
 * One media.find: her `args.query` (her words) against the descriptions of the guild's GIF library
 * (src/memory/gifs.js, the describer cache), `args.n` results (default 5, at most 10). Reads only; no
 * model request, no cap. `invalid` (`invalid-args`) without a query or one with no word in it;
 * `not_configured` without the store or while `features.gifs` is false (read now); else `ok` with
 * mediaFindText as its `data.text` -- an empty result is an ok with `find.none`. Never throws.
 */
export function runMediaFind({
  store,
  config,
  labels,
  guildId,
  args,
}: {
  store: { getGifs?: (guildId: string) => unknown; getMediaCache?: (guildId: string) => unknown } | null;
  config: unknown;
  labels: unknown;
  guildId: string | null;
  args: unknown;
}): ToolResult {
  try {
    const asked = objOf(args);
    const query = text(asked.query);
    if (!query || wordsOf(query).length === 0)
      return { status: 'invalid', code: CODE.INVALID_ARGS, reason: 'args.query:required' };
    if (!store || typeof store.getGifs !== 'function' || !guildId || objOf(objOf(config).features).gifs === false)
      return { status: 'not_configured', code: CODE.NOT_CONFIGURED };
    const given = asked.n;
    if (
      given !== undefined &&
      given !== null &&
      given !== '' &&
      (!Number.isInteger(Number(given)) || Number(given) < 1 || Number(given) > FIND_MAX)
    )
      return { status: 'invalid', code: CODE.INVALID_ARGS, reason: 'args.n:range' };
    const cache = typeof store.getMediaCache === 'function' ? store.getMediaCache(guildId) : null;
    const mediaCache = isObj(cache) ? cache : null;
    const halfLife = objOf(objOf(config).gifs).halfLifeDays;
    const found = findGifs(store.getGifs(guildId), mediaCache, query, {
      n: given,
      halfLifeDays: typeof halfLife === 'number' ? halfLife : 30,
    });
    return { status: 'ok', data: { text: mediaFindText(found, { query, labels, mediaCache, config }) } };
  } catch {
    return { status: 'failed', code: CODE.ERROR };
  }
}
