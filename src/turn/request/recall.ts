// What a turn looked up and recalled, as its request shows it: the `<lookup>` block of the web search and the search
// of the server's own history, with its smaller fallbacks, and the `<retrieved>` block of the automatic memory
// prefetch. buildRequest (src/behavior/prompt.js) calls them.

import { isPlainObject } from '../../config.js';
import { fill } from '../../format.js';
import { zonedDay } from '../../time.js';
import { block } from './text.ts';
import type { Labels } from './types.ts';

/** The web search's result (src/web/lookup.js#search). */
type WebLookup = {
  readonly query?: string;
  readonly text?: string | null;
  readonly sources?: Array<{ readonly site?: string; readonly url?: unknown } | null>;
  readonly cached?: boolean;
};

/** What the search of the server's own history found (src/behavior/recall-run.js). */
type ServerLookup = {
  readonly text?: string | null;
  readonly stretch?: {
    readonly channelId?: string;
    readonly channelName?: string | null;
    readonly startTs: number;
    readonly lines: unknown;
  } | null;
  readonly people?: Array<unknown>;
};

/** A turn's `lookup` input: the web part, and the server part under `server`. */
export type Lookup = WebLookup & { readonly server?: ServerLookup | null };

/** One excerpt the prefetch offered: a stretch of history or a stored item. */
export type Excerpt = {
  readonly lines?: unknown;
  readonly source?: string;
  readonly date?: string;
  readonly who?: string;
  readonly id?: string;
  readonly startTs?: number;
  readonly channelName?: string | null;
  readonly hitIds?: unknown;
};

/** The automatic memory prefetch of a turn (src/behavior/recall-run.js `prefetch`). */
export type Prefetch = {
  readonly status: string;
  readonly basis?: Array<string>;
  readonly excerpts?: Array<Excerpt | null>;
};

/** Hostname of `url` without a leading `www.`, or '' for an unparsable URL. */
function siteOf(url: unknown): string {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/**
 * The web part of `<lookup>`: what the persona looked up online this turn
 * (src/web/lookup.js#search) -- `labels.lookup.header` with the query, then
 * the condensed text and `labels.lookup.sources` with the distinct sites, or
 * `labels.lookup.none` when nothing useful came back. '' when an older
 * labels.json has no `labels.lookup.header`.
 */
function renderWebLookup(lookup: WebLookup, labels: Labels): string {
  const l = labels.lookup;
  if (!l?.header) return '';
  const lines = [fill(l.header, { query: lookup.query ?? '' })];
  const text = String(lookup.text ?? '').trim();
  if (!text) {
    if (l.none) lines.push(l.none);
    return lines.join('\n');
  }
  lines.push(text);
  const sources = Array.isArray(lookup.sources) ? lookup.sources : [];
  const sites = [
    ...new Set(
      sources.map((source) => source?.site || siteOf(source?.url)).filter((site): site is string => Boolean(site))
    ),
  ];
  if (sites.length > 0 && l.sources) lines.push(fill(l.sources, { list: sites.join(', ') }));
  return lines.join('\n');
}

/**
 * The server part of `<lookup>`: what the search of the server's own history
 * found this turn (src/behavior/recall-run.js) -- `labels.lookup.serverHeader`,
 * then the summary text, then, when a stretch came back and the labels have
 * `labels.lookup.stretch`, that label with `{date}` (the day of the stretch's
 * first line as `YYYY-MM-DD` in `timezone`: with its year, a stretch may be
 * years old) and `{channel}` (its channel's
 * name), followed by the stretch's lines as they are. '' when there is no
 * server part, nothing to show, or an older labels.json has no
 * `labels.lookup.serverHeader`.
 */
function renderServerLookup(server: ServerLookup | null | undefined, labels: Labels, timezone: string): string {
  const l = labels.lookup;
  if (!server || !l?.serverHeader) return '';
  const lines: Array<string> = [];
  const text = String(server.text ?? '').trim();
  if (text) lines.push(text);
  const stretch = server.stretch;
  if (
    l.stretch &&
    stretch &&
    typeof stretch.lines === 'string' &&
    stretch.lines.trim() &&
    Number.isFinite(stretch.startTs)
  ) {
    lines.push(
      fill(l.stretch, { date: zonedDay(stretch.startTs, timezone), channel: String(stretch.channelName ?? '') }),
      stretch.lines
    );
  }
  return lines.length > 0 ? [l.serverHeader, ...lines].join('\n') : '';
}

/**
 * The `<retrieved>` block body (the automatic memory prefetch, features.coreTools): `labels.prefetch.header`,
 * `labels.prefetch.basis` with `{basis}` (the lanes searched, `labels.prefetch.lanes.<kind>`
 * joined), then with excerpts `labels.prefetch.caution` and each excerpt as an `<excerpt>`: a
 * history stretch under `labels.prefetch.excerpt` (`{n}`, `{source}` =
 * `labels.prefetch.sources.history`, `{date}` its first line's day in `timezone`, `{channel}`,
 * `{id}` its best hit's message id) and its lines (time and speaker on each, relevant ones marked),
 * a stored item under `labels.prefetch.memoryExcerpt` (`{n}`, `{source}` =
 * `labels.prefetch.sources.memory`, `{date}`, `{who}`, `{id}`) and its text; without excerpts the
 * status line `labels.prefetch.status.<status>` (`none`, `timeout`, `unavailable`). '' without
 * `labels.prefetch.header`. Pure.
 */
export function prefetchText(prefetch: Prefetch | null | undefined, labels: Labels, timezone: string): string {
  const l = labels.prefetch;
  if (!prefetch || !l || !isPlainObject(l) || typeof l.header !== 'string' || !l.header.trim()) return '';
  const lanes = (Array.isArray(prefetch.basis) ? prefetch.basis : [])
    .map((kind) => l.lanes?.[kind])
    .filter((text): text is string => typeof text === 'string' && Boolean(text));
  const lines: Array<string> = [l.header];
  if (lanes.length > 0 && typeof l.basis === 'string' && l.basis)
    lines.push(fill(l.basis, { basis: lanes.join(', ') }));
  const excerpts = Array.isArray(prefetch.excerpts)
    ? prefetch.excerpts.filter(
        (e): e is Excerpt & { lines: string } => typeof e?.lines === 'string' && Boolean(e.lines.trim())
      )
    : [];
  if (excerpts.length === 0) {
    const status = l.status?.[prefetch.status === 'ok' ? 'none' : prefetch.status];
    if (typeof status === 'string' && status) lines.push(status);
    return lines.join('\n');
  }
  if (typeof l.caution === 'string' && l.caution) lines.push(l.caution);
  excerpts.forEach((excerpt, i) => {
    const memory = excerpt.source === 'memory';
    const head = memory ? (l.memoryExcerpt ?? l.excerpt) : l.excerpt;
    const fields = memory
      ? {
          n: i + 1,
          source: l.sources?.memory ?? '',
          date: excerpt.date ?? '',
          who: excerpt.who ?? '',
          id: excerpt.id ?? '',
        }
      : {
          n: i + 1,
          source: l.sources?.history ?? '',
          date:
            excerpt.startTs !== undefined && Number.isFinite(excerpt.startTs)
              ? zonedDay(excerpt.startTs, timezone)
              : '',
          channel: String(excerpt.channelName ?? ''),
          id: excerpt.id ?? '',
        };
    lines.push(
      block(
        'excerpt',
        [typeof head === 'string' && head ? fill(head, fields) : '', excerpt.lines].filter(Boolean).join('\n')
      )
    );
  });
  return lines.join('\n');
}

/**
 * The `<lookup>` block body as candidates in order of preference, for the
 * budget to take the first that fits (all of them one piece, never split).
 * `lookup` is the turn's `lookup` input: the web search's result
 * (src/web/lookup.js#search) and, under `server`, the server search's
 * (renderServerLookup); either may be missing. The web part alone renders
 * exactly as it did before the server part existed (no part header); the
 * server part alone renders under its header. With both, the block is
 * `labels.lookup.bothNote` (when present), `labels.lookup.webHeader` (when
 * present) over the web part, then the server part -- followed by the web
 * part alone and the server part alone as smaller fallbacks. [] when there is
 * no lookup or the labels can render neither part.
 */
export function lookupCandidates(lookup: Lookup | null | undefined, labels: Labels, timezone: string): Array<string> {
  if (!lookup || typeof lookup !== 'object') return [];
  const { server, ...webPart } = lookup;
  const web = Object.keys(webPart).length > 0 ? renderWebLookup(webPart, labels) : '';
  const serverText = renderServerLookup(server, labels, timezone);
  if (!web || !serverText) return [web || serverText].filter(Boolean);
  // Both parts rendered, so `labels.lookup` is there.
  const l = labels.lookup!;
  const whole = [l.bothNote, l.webHeader, web, serverText].filter(Boolean).join('\n');
  return [whole, web, serverText];
}
