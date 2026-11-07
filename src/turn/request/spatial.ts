// The `<spatial_awareness>` body: where the persona is, with the whole nesting of the place, whether it is a group or a
// private place, the present moment, and the owner's note on the place from `config.spatial.notes`, inherited down the
// tree. A wake with no conversation place is at the command line of her own server, a selfreflection post in her own
// world (the owner's word of 2026-11-06). `whereaboutsOf` resolves a turn's whereabouts from its interface, its place and the store's chain of places;
// the turn's request step (src/turn/phases/request/build.ts) calls it and buildRequest (src/behavior/prompt.ts) renders
// the body in the tail, after `<chat>` and before `<now>`. Pure.

import { fill, formatNow } from '../../format.ts';
import type { PlaceChainLink } from '../../memory/db/place-tree.ts';
import type { Frame } from './frame.ts';
import type { Labels, SpatialLabels } from './types.ts';

/** The labels the block reads: the locale of the clock and `labels.spatial`. */
type SpatialTextLabels = Pick<Labels, 'locale' | 'spatial'>;

/** One place of a chain: its stored id, its kind and its name (null when the store holds none). */
export type PlaceLink = PlaceChainLink;

/**
 * Where a turn is: the owner's command line, her own server (a wake with no conversation place), her own world (a
 * selfreflection post), or a place with its chain up to the top.
 */
export type Whereabouts =
  | { kind: 'cli' }
  | { kind: 'server' }
  | { kind: 'world' }
  | { kind: 'place'; iface: string; private: boolean; chain: ReadonlyArray<PlaceLink> };

/** The interface the owner's command line speaks as (src/interface/link.ts#CLI_IFACE). */
const CLI_IFACE = 'cli';

/** The label of a place kind the labels do not name. */
const FALLBACK_KIND = 'place';

/**
 * The whereabouts of a turn on `iface` in `placeId`: the command line whatever place it names, her own server without an
 * interface or a place, else the place with the chain `chainOf` reads (the place first). A place the tree does not
 * hold yet, or a turn with no reader, is a chain of the place alone with no kind and no name.
 */
export function whereaboutsOf(input: {
  iface: string | null;
  placeId: string | null;
  isPrivate: boolean;
  chainOf: ((placeId: string) => ReadonlyArray<PlaceLink>) | null;
}): Whereabouts {
  const { iface, placeId, isPrivate, chainOf } = input;
  if (iface === CLI_IFACE) return { kind: 'cli' };
  if (!iface || !placeId) return { kind: 'server' };
  const stored = chainOf ? chainOf(placeId) : [];
  const chain = stored.length > 0 ? stored : [{ id: placeId, kind: null, name: null }];
  return { kind: 'place', iface, private: isPrivate, chain };
}

/**
 * The whereabouts a frame states: her own server with no place or no interface, the command line on that interface,
 * else the place with its chain.
 */
export function whereaboutsOfFrame(frame: Frame): Whereabouts {
  if (frame.place === null || !frame.interface) return { kind: 'server' };
  if (frame.interface === CLI_IFACE) return { kind: 'cli' };
  return { kind: 'place', iface: frame.interface, private: frame.scope === 'dm', chain: frame.chain };
}

/** The owner's note on the nearest place of the chain that has a non-blank one; null when none has. */
function noteOf(chain: ReadonlyArray<PlaceLink>, notes: unknown): string | null {
  if (typeof notes !== 'object' || notes === null || Array.isArray(notes)) return null;
  for (const link of chain) {
    const note: unknown = Object.hasOwn(notes, link.id) ? Reflect.get(notes, link.id) : null;
    if (typeof note === 'string' && note.trim() !== '') return note.trim();
  }
  return null;
}

/** One place of the path: the label of its kind (the fallback kind's for an unknown one) with its name. */
function linkText(link: PlaceLink, l: SpatialLabels): string {
  const kinds = l.kinds ?? {};
  const template = (link.kind !== null ? kinds[link.kind] : undefined) ?? kinds[FALLBACK_KIND] ?? '{name}';
  return fill(template, { name: link.name ?? l.unnamed ?? '' });
}

/**
 * The body of `<spatial_awareness>` (docs/prompt-contract.md): on the command line `labels.spatial.cli`, on her own
 * server `server`, in her own world `world`, each with `{when}`; in a place `place` with `{path}` (the chain from the place up, each link through
 * `kinds`, joined with `within`), `{iface}` and `{when}`, then `private` or `group`, then `note` with the owner's note
 * when the place or one above it has one. `{when}` is formatNow in `timezone`. '' without the labels.
 */
export function spatialAwarenessText(input: {
  whereabouts: Whereabouts;
  now: number;
  timezone: string;
  labels: SpatialTextLabels;
  notes: unknown;
}): string {
  const { whereabouts, now, timezone, labels, notes } = input;
  const l = labels.spatial;
  if (!l) return '';
  const when = formatNow(now, timezone, labels.locale);
  switch (whereabouts.kind) {
    case 'cli':
      return fill(l.cli ?? '', { when });
    case 'server':
      return fill(l.server ?? '', { when });
    case 'world':
      return fill(l.world ?? '', { when });
    case 'place': {
      const path = whereabouts.chain.map((link) => linkText(link, l)).join(l.within ?? ' ');
      const note = noteOf(whereabouts.chain, notes);
      return [
        fill(l.place ?? '', { path, iface: whereabouts.iface, when }),
        whereabouts.private ? l.private : l.group,
        note === null ? '' : fill(l.note ?? '', { note }),
      ]
        .filter(Boolean)
        .join('\n');
    }
  }
}
