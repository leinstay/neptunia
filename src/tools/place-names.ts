// How a place named in a tool's `place` argument resolves. She writes a handle, a name she read in `<memory>` or
// `<meanwhile>`, or a name she guessed. `matchPlace` compares it with the places of the turn's snapshot she may read
// (the list is decided elsewhere, src/behavior/readable-places.ts): by native id or mention, by request handle, by name
// once case, accents, emoji, punctuation and spaces are dropped, and with a loaded stemmer by the stem of every word.
// `indexedPlace` reads a name nothing of the snapshot holds through the name index of the memory
// (src/memory/db/names.ts#placesNamed), so a place of any interface resolves to its place id. An answer that cannot be
// one place carries the places she may read, and `placeChoicesText` renders them through `labels.tools.tools.place` so
// she can call again. `foundPlaces` turns the places the memory graph ranks for words that name no place
// (src/memory/db/graph-find.ts#placesFound) into such an answer, each with what it is for. No I/O, no model-facing
// wording of its own.

import { fill } from '../format.ts';
import { objOf } from './types.ts';

/** A place she may read: its id, its name, the handle of this request when it has one, and what it is for when known. */
export type PlaceCandidate = { id: string; name: string; handle: string | null; about?: string | null };

/** How many choices an answer lists at most; the rest is counted. */
export const PLACE_CHOICES_MAX = 20;

/** The places an answer lists, and how many fit in all. */
export type PlaceChoices = { choices: ReadonlyArray<PlaceCandidate>; total: number };

/** One place, several that share the name, none, or the places the memory graph found for words that name none. */
export type PlaceMatch = { kind: 'one'; id: string } | ({ kind: 'several' | 'none' | 'found' } & PlaceChoices);

/** The words of a name with case, accents and everything that is not a letter or a digit dropped. */
function wordsOf(text: string): Array<string> {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The key two spellings of one name share: its words run together. */
const keyOf = (text: string, stem?: (word: string) => string): string =>
  wordsOf(text)
    .map((word) => (stem ? stem(word) : word))
    .join('');

/** `places` whose key under `stem` is `key`. */
function keyed(places: ReadonlyArray<PlaceCandidate>, key: string, stem?: (word: string) => string) {
  return key === '' ? [] : places.filter((place) => keyOf(place.name, stem) === key);
}

/**
 * The place `reference` names among `places`: `{ kind: 'one', id }`, `several` when the name fits more than one (the
 * matches are the choices), or `none` (the choices are every place, up to `max`, default PLACE_CHOICES_MAX). `total`
 * counts what the choices could list. Order: id or mention, handle with or without `#`, the exact name, then the
 * stemmed name when `stem` is given. A name that fits exactly never falls through to a stem.
 */
export function matchPlace(
  reference: string,
  places: ReadonlyArray<PlaceCandidate>,
  { stem, max = PLACE_CHOICES_MAX }: { stem?: (word: string) => string; max?: number } = {}
): PlaceMatch {
  const given = reference.trim();
  const listed = (found: ReadonlyArray<PlaceCandidate>): PlaceChoices => ({
    choices: found.slice(0, max),
    total: found.length,
  });
  const one = (found: ReadonlyArray<PlaceCandidate>): PlaceMatch | null => {
    const [first] = found;
    if (first === undefined) return null;
    return found.length === 1 ? { kind: 'one', id: first.id } : { kind: 'several', ...listed(found) };
  };
  const id = /^<#(\d+)>$/.exec(given)?.[1] ?? /^(\d+)$/.exec(given)?.[1];
  const byId = id === undefined ? null : one(places.filter((place) => place.id === id));
  if (byId) return byId;
  const handle = given.replace(/^#/, '');
  const byHandle = handle === '' ? null : one(places.filter((place) => place.handle === handle));
  if (byHandle) return byHandle;
  const exact = one(keyed(places, keyOf(given)));
  if (exact) return exact;
  const stemmed = stem ? one(keyed(places, keyOf(given, stem), stem)) : null;
  return stemmed ?? { kind: 'none', ...listed(places) };
}

/**
 * The place `reference` names by the name index: `named` reads the live places the name names under the turn's context
 * (src/memory/db/names.ts#placesNamed). One place is `one` with its place id, several are `several` with them as the
 * choices, none is `none` with no choices.
 */
export function indexedPlace(
  reference: string,
  named: (name: string) => ReadonlyArray<{ id: string; name: string }>,
  max: number = PLACE_CHOICES_MAX
): PlaceMatch {
  const found: Array<PlaceCandidate> = named(reference.trim()).map((place) => ({ ...place, handle: null }));
  const [first] = found;
  if (first === undefined) return { kind: 'none', choices: [], total: 0 };
  return found.length === 1
    ? { kind: 'one', id: first.id }
    : { kind: 'several', choices: found.slice(0, max), total: found.length };
}

/**
 * The places the memory graph ranked for `found`, best first, as an answer that names no place: `found` with them as
 * the choices, each with the handle `handleOf` gives it and what it is for; null when the graph found none.
 */
export function foundPlaces(
  found: ReadonlyArray<{ id: string; name: string; about: string | null }>,
  handleOf: (id: string) => string | null,
  max: number = PLACE_CHOICES_MAX
): PlaceMatch | null {
  if (found.length === 0) return null;
  const choices = found.slice(0, max).map((place) => ({ ...place, handle: handleOf(place.id) }));
  return { kind: 'found', choices, total: found.length };
}

/** What she writes to name a choice: its handle with the hash, else nothing, since its name is the token; never its id. */
const refOf = (place: PlaceCandidate): string => (place.handle ? `#${place.handle}` : '');

/** A choice line: the label for a choice with a handle, `<key>Unhandled` for one without, else the label with `{ref}` empty. */
function choiceLine(word: (key: string) => string, key: string, place: PlaceCandidate): string {
  const values = { ref: refOf(place), name: place.name, about: place.about ?? '' };
  const unhandled = place.handle ? '' : word(`${key}Unhandled`);
  if (unhandled) return fill(unhandled, values);
  return fill(word(key), values).replace(/ {2,}/g, ' ').trim();
}

/**
 * The choices of an answer as the text of a tool result: the lead of `labels.tools.tools.place.several`, `.none` or
 * `.found` (`{given}`, `{count}` the number of places that fit), one `.line` per choice (`{ref}`, the `#handle` to write,
 * and `{name}`), `.lineAbout` instead for a choice that says what it is for (`{about}` too), `.lineUnhandled` and
 * `.lineAboutUnhandled` for a choice with no handle, whose name is what she writes, and `.more` (`{count}`) when some
 * were left out. `given` is what she wrote. Reads the labels now.
 */
export function placeChoicesText(match: PlaceMatch, labels: unknown, given: string): string {
  if (match.kind === 'one') return '';
  const words = objOf(objOf(objOf(objOf(labels).tools).tools).place);
  const word = (key: string): string => (typeof words[key] === 'string' ? words[key] : '');
  const lead = fill(word(match.kind), { given, count: match.total });
  const lines = match.choices.map((place) =>
    choiceLine(word, place.about && word('lineAbout') ? 'lineAbout' : 'line', place)
  );
  const left = match.total - match.choices.length;
  const more = left > 0 ? fill(word('more'), { count: left }) : '';
  return [lead, ...lines, more].filter(Boolean).join('\n');
}
