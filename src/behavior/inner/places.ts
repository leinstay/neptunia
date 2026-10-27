// Her attention and the places view (docs/inner-life.md "Her attention"): an index per guild of the record's lines
// per place over `innerLife.attention.lookbackHours`, the `attend` wake an open attention gives once its place has
// settled, and the page of places that her `places.list` tool and the `<wake>` block show. The tick
// (src/behavior/inner.ts) refreshes the index; the heartbeat and the drain read it.

import { HOUR_MS, MINUTE_MS } from '../../time.js';
import { isAttend } from '../../intentions/model.ts';
import { foldText } from '../../memory/recent.js';
import { errorCode, idText, isFiniteNumber, isPositive, listOf, objOf } from '../../tools/types.ts';
import { asText } from './facts.ts';
import { stateOf } from './queue.ts';
import { innerSettings } from './settings.ts';
import type {
  AttendInfo,
  InnerContext,
  InnerSettings,
  PlaceEntry,
  PlaceIndex,
  PlaceLine,
  PlaceRow,
  PlacesPage,
  Wake,
} from './types.ts';

/** The orders the places view knows (`places.list` `sort=`). */
export const PLACE_SORTS: ReadonlyArray<string> = Object.freeze(['recent', 'name', 'lines']);
/** The wake id prefix of an attend wake (its intention and newest line follow). */
export const ATTEND_PREFIX = 'inner.wake:attend:';

/** How far behind the last scan the record is read again (a line appended late is still seen; ids de-duplicate). */
const SCAN_LAG_MS = 5 * MINUTE_MS;

/** A line an attention counts: its id, time and author. */
type CountedLine = { id: unknown; at: number; by: unknown };

/**
 * The attend wake of attention `record` over `lines` (the place's lines since her last look there,
 * `{ id, at, by, said }`: her own lines never count; with `attend.people` only theirs do) at `now`:
 * null when no line counts or the newest is younger than `attend.settle` seconds (the place is
 * still talking); else the wake named by the newest line, its own chain, due when the settle ends.
 * `record` is an intention of kind attend; `since` is her last look (for the wake's record).
 */
export function attendWake(
  record: unknown,
  lines: unknown,
  { now, since = null }: { now: number; since?: number | null }
): Wake | null {
  const attention = objOf(record);
  const attend = objOf(attention.attend);
  if (!attend.place) return null;
  const people = listOf(attend.people);
  const counted = listOf(lines).flatMap((entry): Array<CountedLine> => {
    const line = objOf(entry);
    return entry &&
      !line.said &&
      isFiniteNumber(line.at) &&
      (people.length === 0 || (line.by && people.includes(asText(line.by))))
      ? [{ id: line.id, at: line.at, by: line.by }]
      : [];
  });
  if (counted.length === 0) return null;
  const newest = counted.reduce((best, line) => (line.at > best.at ? line : best));
  const settleMs = (isFiniteNumber(attend.settle) ? attend.settle : 0) * 1000;
  if (now - newest.at < settleMs) return null;
  const id = asText(attention.id);
  const info: AttendInfo = {
    place: asText(attend.place),
    lines: counted.length,
    people: [
      ...new Set(counted.map((line) => (line.by ? asText(line.by) : null)).filter((by): by is string => Boolean(by))),
    ],
    since: isFiniteNumber(since) ? since : null,
    newestAt: newest.at,
    newestId: asText(newest.id),
  };
  return {
    id: `${ATTEND_PREFIX}${id}:${info.newestId}`,
    kind: 'attend',
    reason: 'lines',
    intentionIds: [id],
    chainId: `attend:${id}:${info.newestId}`,
    dueAt: newest.at + settleMs,
    channelId: info.place,
    privateChat: false,
    attend: info,
  };
}

/** What the places view sorts and filters an entry by. */
export type PageEntry = { id?: unknown; name?: unknown; lines?: number | null; newestAt?: number | null };

/**
 * One page of the places view: `entries` (`{ id, name, writable, lines, people, newestAt, attended }`,
 * one per place) filtered by name (`filter`, case and accents folded), sorted (`recent`: the newest
 * line first, places without one last; `name`; `lines`: most first), cut to page `page` of
 * `pageSize`. The total and how many more follow the page are always said. Pure.
 */
export function placesPage<TEntry extends PageEntry>(
  entries: ReadonlyArray<TEntry>,
  {
    filter = null,
    sort = 'recent',
    page = 1,
    pageSize = 12,
  }: { filter?: string | null; sort?: string; page?: number; pageSize?: number } = {}
): PlacesPage<TEntry> {
  const needle = typeof filter === 'string' && filter.trim() ? foldText(filter) : null;
  const kept = entries.filter(
    (entry) => entry && (needle === null || foldText(asText(entry.name ?? entry.id ?? '')).includes(needle))
  );
  const byName = (a: TEntry, b: TEntry) =>
    asText(a.name ?? a.id).localeCompare(asText(b.name ?? b.id)) || asText(a.id).localeCompare(asText(b.id));
  const sorted = [...kept].sort((a, b) => {
    if (sort === 'name') return byName(a, b);
    if (sort === 'lines') return (b.lines ?? 0) - (a.lines ?? 0) || byName(a, b);
    return (b.newestAt ?? -Infinity) - (a.newestAt ?? -Infinity) || byName(a, b);
  });
  const size = Math.max(1, Math.floor(pageSize));
  const number = Math.max(1, Math.floor(page));
  const start = (number - 1) * size;
  const items = sorted.slice(start, start + size);
  return {
    total: sorted.length,
    page: number,
    pageSize: size,
    more: Math.max(0, sorted.length - start - items.length),
    items,
  };
}

/** The place index of `guildId`, empty until the first refresh. */
export function placeIndexOf(life: InnerContext, guildId: unknown): PlaceIndex {
  const { placeIndexes } = life;
  const key = String(guildId);
  const known = placeIndexes.get(key);
  if (known) return known;
  const index: PlaceIndex = { scannedTo: null, places: new Map() };
  placeIndexes.set(key, index);
  return index;
}

/**
 * The place index brought up to `at`: the record's `seen` and `said` lines since the last scan
 * (a little behind it; a line already indexed is skipped by its message id), each as
 * `{ id, at, by, said }` under its place; lines older than the lookback window dropped. Never throws.
 */
export async function refreshPlaces(
  life: InnerContext,
  guildId: string,
  at: number,
  settings: InnerSettings
): Promise<PlaceIndex> {
  const { record, log } = life;
  const index = placeIndexOf(life, guildId);
  const floor = at - settings.attention.lookbackHours * HOUR_MS;
  const from = index.scannedTo === null ? floor : Math.max(floor, index.scannedTo - SCAN_LAG_MS);
  if (typeof record?.iterate === 'function') {
    try {
      for await (const raw of record.iterate(guildId, { from: new Date(from).toISOString() })) {
        const line = objOf(raw);
        if (line.kind !== 'seen' && line.kind !== 'said') continue;
        const place = objOf(line.scope).channel;
        if (typeof place !== 'string' || !place) continue;
        const lineAt = Date.parse(String(line.occurredAt));
        if (!Number.isFinite(lineAt) || lineAt < floor || lineAt > at) continue;
        const id = asText(line.messageId ?? line.id ?? '');
        if (!id) continue;
        let bucket = index.places.get(place);
        if (!bucket) {
          bucket = { lines: [], ids: new Set() };
          index.places.set(place, bucket);
        }
        if (bucket.ids.has(id)) continue;
        bucket.ids.add(id);
        bucket.lines.push({
          id,
          at: lineAt,
          by: line.kind === 'said' ? null : typeof line.by === 'string' ? line.by : null,
          said: line.kind === 'said',
        });
      }
    } catch (err) {
      log.warn('inner: record read failed', { guildId, code: errorCode(err) });
    }
  }
  index.scannedTo = at;
  for (const [place, bucket] of index.places) {
    if (bucket.lines.some((line) => line.at < floor)) {
      bucket.lines = bucket.lines.filter((line) => line.at >= floor);
      bucket.ids = new Set(bucket.lines.map((line) => line.id));
    }
    if (bucket.lines.length === 0) index.places.delete(place);
  }
  return index;
}

/**
 * When she last looked at `place`: her last own line there (the index), or the last attend wake
 * handled for that place, whichever is later; -Infinity when neither is known.
 */
export function lastLookAt(life: InnerContext, guildId: string, place: string): number {
  let last = -Infinity;
  for (const line of placeIndexOf(life, guildId).places.get(String(place))?.lines ?? [])
    if (line.said && line.at > last) last = line.at;
  for (const [id, entry] of Object.entries(stateOf(life, guildId).handled)) {
    if (id.startsWith(ATTEND_PREFIX) && entry?.place === String(place) && isFiniteNumber(entry.at) && entry.at > last)
      last = entry.at;
  }
  return last;
}

/** The indexed lines of `place` strictly after `since`. */
export function linesSince(life: InnerContext, guildId: string, place: string, since: number): Array<PlaceLine> {
  return (placeIndexOf(life, guildId).places.get(String(place))?.lines ?? []).filter((line) => line.at > since);
}

/** The guild's open attentions (the service's `attending`, else its list filtered). Never throws. */
export function openAttentions(life: InnerContext, guildId: string): ReadonlyArray<unknown> {
  const { intentions, log } = life;
  try {
    if (typeof intentions?.attending === 'function') return intentions.attending(guildId) ?? [];
    return (intentions?.list?.(guildId, { all: true }) ?? []).filter(
      (record) => objOf(record).status === 'pending' && isAttend(record)
    );
  } catch (err) {
    log.warn('inner: attentions unreadable', { guildId, code: errorCode(err) });
    return [];
  }
}

/** The place an attention names, as text. */
const attendedPlace = (record: unknown): string => asText(objOf(objOf(record).attend).place);

/** The attend wakes due now: one per open attention whose place has settled lines since her last look. */
export function attendWakes(life: InnerContext, guildId: string, at: number): Array<Wake> {
  const out: Array<Wake> = [];
  for (const record of openAttentions(life, guildId)) {
    const place = attendedPlace(record);
    const createdAt = objOf(record).createdAt;
    const since = Math.max(lastLookAt(life, guildId, place), isFiniteNumber(createdAt) ? createdAt : -Infinity);
    const wake = attendWake(record, linesSince(life, guildId, place, since), {
      now: at,
      since: Number.isFinite(since) ? since : null,
    });
    if (wake) out.push(wake);
  }
  return out;
}

/** The name of place `id`: the directory's, else the interface's cache, else the id. */
export function placeNameOf(life: InnerContext, guildId: string, id: unknown): string {
  const { conversationName } = life;
  const named = directoryOf(life, guildId).find((entry) => entry.id === asText(id));
  return named?.name ?? conversationName(asText(id)) ?? asText(id);
}

/** The places the interface publishes for the guild (`places`), else the places the record shows. */
export function directoryOf(life: InnerContext, guildId: string): Array<PlaceEntry> {
  const { placesOf, conversationName, log } = life;
  if (typeof placesOf === 'function') {
    let listed: Array<{ id: string | number; name?: unknown; writable?: unknown }> = [];
    try {
      listed = listOf(placesOf(String(guildId))).flatMap((entry) => {
        const place = objOf(entry);
        return entry && (typeof place.id === 'string' || typeof place.id === 'number')
          ? [{ ...place, id: place.id }]
          : [];
      });
    } catch (err) {
      log.warn('inner: places unreadable', { guildId, code: errorCode(err) });
      listed = [];
    }
    return listed.map((entry) => ({
      id: idText(entry.id),
      name: typeof entry.name === 'string' && entry.name ? entry.name : idText(entry.id),
      writable: typeof entry.writable === 'boolean' ? entry.writable : null,
    }));
  }
  return [...placeIndexOf(life, guildId).places.keys()].map((id) => ({
    id,
    name: conversationName(id) ?? id,
    writable: null,
  }));
}

/** What the places view is asked for: a filter, an order, a page and its size. */
export type PlacesQuery = { filter?: string | null; sort?: string; page?: number; pageSize?: number | null };

/**
 * The places view (her `places.list`, the page in `<wake>`): every place of the directory (and
 * every attended place), with the lines and distinct people since her last look there (the
 * index: at most the lookback window), its newest line, whether she can write there (null when
 * the interface did not say) and whether she attends it; filtered, sorted and paged (placesPage;
 * `pageSize` defaults to `innerLife.attention.pageSize`). Never throws.
 */
export function places(
  life: InnerContext,
  guildId: string | null = life.getGuildId(),
  { filter = null, sort = 'recent', page = 1, pageSize = null }: PlacesQuery = {}
): PlacesPage {
  const { hot } = life;
  const settings = innerSettings(hot.config);
  const size = isPositive(pageSize) ? pageSize : settings.attention.pageSize;
  if (!guildId) return placesPage<PlaceRow>([], { filter, sort, page, pageSize: size });
  const attended = new Set(openAttentions(life, guildId).map(attendedPlace));
  const directory = directoryOf(life, guildId);
  const known = new Set(directory.map((entry) => entry.id));
  const entries = [
    ...directory,
    ...[...attended]
      .filter((id) => !known.has(id))
      .map((id) => ({ id, name: placeNameOf(life, guildId, id), writable: null })),
  ];
  const rows = entries.map((entry): PlaceRow => {
    const lines = linesSince(life, guildId, entry.id, lastLookAt(life, guildId, entry.id)).filter((line) => !line.said);
    return {
      id: entry.id,
      name: entry.name,
      writable: entry.writable,
      lines: lines.length,
      people: new Set(lines.map((line) => line.by).filter(Boolean)).size,
      newestAt: lines.length > 0 ? Math.max(...lines.map((line) => line.at)) : null,
      attended: attended.has(entry.id),
    };
  });
  return placesPage(rows, { filter, sort: PLACE_SORTS.includes(sort) ? sort : 'recent', page, pageSize: size });
}

/** The places page of `<wake>` (null when `innerLife.attention.placesInWake` is 0). */
export function placesInWakeOf(life: InnerContext, guildId: string, settings: InnerSettings): PlacesPage | null {
  const size = settings.attention.placesInWake;
  return size > 0 ? places(life, guildId, { sort: 'recent', page: 1, pageSize: size }) : null;
}

/** The names of the places where `memberId` wrote within the lookback window, the busiest first. */
export function activePlacesOf(life: InnerContext, guildId: string, memberId: unknown): Array<string> {
  const counts: Array<{ id: string; n: number }> = [];
  for (const [id, bucket] of placeIndexOf(life, guildId).places) {
    const n = bucket.lines.filter((line) => line.by === String(memberId)).length;
    if (n > 0) counts.push({ id, n });
  }
  return counts
    .sort((a, b) => b.n - a.n || (a.id < b.id ? -1 : 1))
    .map((entry) => placeNameOf(life, guildId, entry.id));
}

/** An attend wake's facts for `<wake>`: the place's name and the people's names (ids when unknown). */
export function attendFactsOf(
  life: InnerContext,
  guildId: string,
  wake: Wake
): { attend?: AttendInfo & { placeName: string; peopleNames: Array<unknown> } } {
  const { nameOf } = life;
  if (!wake.attend) return {};
  const name = (id: string): unknown => {
    try {
      return (typeof nameOf === 'function' ? nameOf(String(guildId), id) : null) ?? id;
    } catch {
      return id;
    }
  };
  return {
    attend: {
      ...wake.attend,
      placeName: placeNameOf(life, guildId, wake.attend.place),
      peopleNames: wake.attend.people.map(name),
    },
  };
}
