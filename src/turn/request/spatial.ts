// The `<spatial_awareness>` body: where the persona is, with the whole nesting of the place, whether it is a group or a
// private place, the present moment, and the owner's note on the place from `config.spatial.notes`, inherited down the
// tree. The owner's command line is a private place with a note of its own, as a direct chat on another interface is. A wake with no chat place is at the command line of her own server, a selfreflection post in her own
// world (the owner's word of 2026-11-06). `whereaboutsOfFrame` states a turn's whereabouts from its frame, with the
// interface's own nouns for its kinds of place; the head of the request (src/turn/request/head.ts) renders the body.
// Pure.

import { fill, formatNow } from '../../format.ts';
import type { PlaceChainLink } from '../../memory/db/place-tree.ts';
import type { Frame } from './frame.ts';
import type { Labels, SpatialLabels } from './types.ts';

/** The labels the block reads: the locale of the clock and `labels.spatial`. */
type SpatialTextLabels = Pick<Labels, 'locale' | 'spatial'>;

/** One place of a chain: its stored id, its kind and its name (null when the store holds none). */
export type PlaceLink = PlaceChainLink;

/**
 * Where a turn is: the owner's command line with the chain of its place, her own server (a wake with no chat place), her
 * own world (a selfreflection post), or a place with its chain up to the top.
 */
export type Whereabouts =
  | { kind: 'cli'; chain?: ReadonlyArray<PlaceLink> }
  | { kind: 'server' }
  | { kind: 'world' }
  | {
      kind: 'place';
      iface: string;
      private: boolean;
      chain: ReadonlyArray<PlaceLink>;
      /** The interface's word for each native kind of place it has (`hello.names.nouns`). */
      nouns?: Readonly<Record<string, string>>;
    };

/** The interface the owner's command line speaks as (src/interface/link.ts#CLI_IFACE). */
const CLI_IFACE = 'cli';

/** The label of a place kind the labels do not name. */
const FALLBACK_KIND = 'place';

/**
 * The whereabouts a frame states: her own server with no place or no interface, the command line on that interface,
 * else the place with its chain and the interface's nouns for its kinds of place.
 */
export function whereaboutsOfFrame(frame: Frame, nouns: Readonly<Record<string, string>> = {}): Whereabouts {
  if (frame.place === null || !frame.interface) return { kind: 'server' };
  if (frame.interface === CLI_IFACE) return { kind: 'cli', chain: frame.chain };
  return { kind: 'place', iface: frame.interface, private: frame.scope === 'dm', chain: frame.chain, nouns };
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

/**
 * One place of the path: the label of its kind when the labels name it (a one-to-one chat), else `labels.spatial.kind`
 * with the interface's noun for the kind (the native kind itself when the interface named none), else the fallback
 * kind's label for a place with no kind.
 */
function linkText(link: PlaceLink, l: SpatialLabels, nouns: Readonly<Record<string, string>>): string {
  const kinds = l.kinds ?? {};
  const name = link.name ?? l.unnamed ?? '';
  const own = link.kind !== null ? kinds[link.kind] : undefined;
  if (own !== undefined) return fill(own, { name });
  const noun = link.kind === null ? '' : (nouns[link.kind] ?? link.kind);
  if (noun !== '' && typeof l.kind === 'string') return fill(l.kind, { noun, name });
  return fill(kinds[FALLBACK_KIND] ?? '{name}', { name });
}

/** The `private` line, then `note` with the owner's note when the place or one above it has one, each when present. */
function privateLines(chain: ReadonlyArray<PlaceLink>, l: SpatialLabels, notes: unknown): Array<string> {
  const note = noteOf(chain, notes);
  return [l.private ?? '', note === null ? '' : fill(l.note ?? '', { note })];
}

/**
 * The body of `<spatial_awareness>` (docs/prompt-contract.md): on the command line `labels.spatial.cli` with `{when}`,
 * then `private` and the note of its place; on her own server `server`, in her own world `world`, each with `{when}`;
 * in a place `place` with `{path}` (the chain from the place up, each link through
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
      return [fill(l.cli ?? '', { when }), ...privateLines(whereabouts.chain ?? [], l, notes)]
        .filter(Boolean)
        .join('\n');
    case 'server':
      return fill(l.server ?? '', { when });
    case 'world':
      return fill(l.world ?? '', { when });
    case 'place': {
      const path = whereabouts.chain.map((link) => linkText(link, l, whereabouts.nouns ?? {})).join(l.within ?? ' ');
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
