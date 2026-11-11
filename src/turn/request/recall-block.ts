// The body of `<recall>`: what she looked up herself in the last turns of this place (docs/prompt-contract.md), from the
// ring of her lookups (src/turn/calls.ts#createLookupRing). Each lookup says when, where she called from, the tool, the
// place it searched when its arguments name one (by its handle and path, `places.ref`, as the request names it), the
// query, the status and a bounded extract of the result. A lookup
// whose quoted sources are all retired is left out. The request builder (src/turn/request/reader.ts) calls it. Pure.

import { fill, formatClock } from '../../format.ts';
import type { Lookup } from '../calls.ts';
import { escapeStored, pathText } from './text.ts';
import type { Labels } from './types.ts';

/** The arguments that name what a lookup searched for, in the order they are read. */
const QUERY_ARGS = ['query', 'text', 'q', 'url', 'about'];
/** The arguments that name the place a lookup searched. */
const PLACE_ARGS = ['place', 'channel'];

const textArg = (args: Record<string, unknown>, names: ReadonlyArray<string>): string | null => {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
};

/** What a lookup asked: its query argument, else every plain argument but the place as `name=value`. */
function queryOf(args: Record<string, unknown>): string {
  const query = textArg(args, QUERY_ARGS);
  if (query !== null) return query;
  return Object.entries(args)
    .filter(([name, value]) => !PLACE_ARGS.includes(name) && ['string', 'number', 'boolean'].includes(typeof value))
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(', ');
}

/** Whether every source a lookup quotes is retired; a lookup that quotes none stands. */
const allRetired = (lookup: Lookup, retired: ReadonlySet<string>): boolean =>
  lookup.sourceIds.length > 0 && lookup.sourceIds.every((id) => retired.has(id));

/** How a request names a place id she searched: its handle and path (`places.ref`). */
export type PlaceRefOf = (placeId: string) => string;

/** One lookup in the labels' words. */
function lookupText(lookup: Lookup, labels: Labels, timezone: string, placeRef: PlaceRefOf | null): string {
  const l = labels.recall ?? {};
  const place = textArg(lookup.args, PLACE_ARGS);
  const searched = place === null ? '' : placeRef === null ? escapeStored(place) : placeRef(place);
  const head = fill(l.item ?? '', {
    time: formatClock(lookup.at, timezone, labels.locale),
    from: pathText(lookup.place.path, labels.memory?.pathJoin),
    tool: escapeStored(lookup.tool),
    searched: place === null ? '' : fill(l.searched ?? '', { place: searched }),
    query: escapeStored(queryOf(lookup.args)),
    status: escapeStored(lookup.status),
  });
  const extract = lookup.extract.trim() === '' ? '' : fill(l.extract ?? '', { extract: escapeStored(lookup.extract) });
  return [head, extract].filter(Boolean).join('\n');
}

/**
 * The body of `<recall>` over `lookups`, oldest first, `window.retired` naming the source ids that are retired, a searched
 * place named by `placeRef`. '' with no lookup left.
 */
export function recallBlockOf(
  lookups: ReadonlyArray<Lookup>,
  window: { retired: ReadonlySet<string> },
  labels: Labels,
  timezone: string,
  placeRef: PlaceRefOf | null = null
): string {
  const shown = lookups.filter((lookup) => !allRetired(lookup, window.retired)).sort((a, b) => a.at - b.at);
  if (shown.length === 0) return '';
  const header = labels.recall?.header ?? '';
  return [header, ...shown.map((lookup) => lookupText(lookup, labels, timezone, placeRef))]
    .filter(Boolean)
    .join('\n\n');
}
