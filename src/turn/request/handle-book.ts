// The handles of one request (docs/prompt-contract.md, "Mention handles"): a person's handle is cut from the meta-person
// id, an account no person holds from its account key, a place's from its native chat id (src/behavior/handles.ts). A
// book is filled once per request, the chat's handles fixed first, then the people of `<memory>` and the authors in
// view under the collision rule of assignHandles; a key met later (a mention in a stored text) takes the shortest form
// no other key of the book holds. The labels that name an author or a place by a handle are read here too. The request
// builder (src/turn/request/reader.ts) and the read tools (src/turn/in-turn-tools.ts) use it. Pure.

import { HANDLE_DIGITS, assignHandles, handleOf } from '../../behavior/handles.ts';
import { fill } from '../../format.ts';
import { escapeStored, pathText } from './text.ts';
import type { Labels } from './types.ts';

// 256 bits of SHA-256 hold 49 base-36 digits (src/behavior/handles.ts).
const MAX_DIGITS = 49;

/** The handles of one request by key (a person id, an account key or a chat id), without their sigil. */
export type HandleBook = {
  /** The handle of `key`, given now when the book holds none. */
  handleOf(key: string): string;
  /** Every key and its handle, in the order given. */
  entries(): Map<string, string>;
};

/**
 * A book over `fixed` (key -> handle, kept as given), then `profiled` and `inView` placed together by assignHandles with
 * `prefix` after the keys of `fixed`, which take the forms they had alone.
 */
export function handleBook(
  fixed: ReadonlyMap<string, string>,
  { profiled = [], inView = [] }: { profiled?: Iterable<string>; inView?: Iterable<string> },
  prefix?: string
): HandleBook {
  const handles = assignHandles({ profiled: fixed.keys(), inView: [...profiled, ...inView] }, prefix ? { prefix } : {});
  for (const [key, handle] of fixed) handles.set(key, handle);
  const taken = new Set(handles.values());
  return {
    handleOf(key) {
      const known = handles.get(key);
      if (known !== undefined) return known;
      let handle = handleOf(key, HANDLE_DIGITS, prefix);
      for (let digits = HANDLE_DIGITS + 1; taken.has(handle) && digits <= MAX_DIGITS; digits += 1)
        handle = handleOf(key, digits, prefix);
      handles.set(key, handle);
      taken.add(handle);
      return handle;
    },
    entries: () => new Map(handles),
  };
}

/** An author named by their handle (`authors.line`), `authors.unknown` without one. */
export function authorText(labels: Labels, handle: string | null): string {
  const words = labels.authors ?? {};
  if (handle === null) return words.unknown ?? '';
  return fill(words.line ?? '{handle}', { handle: `@${handle}` });
}

/**
 * A place by its handle and its path (`places.ref`, `#{handle} {name}`), or by its path alone (`places.refUnhandled`)
 * for a place with no handle; the path joined with `memory.pathJoin`, each name escaped.
 */
export function placeRefText(labels: Labels, handle: string | null, path: ReadonlyArray<string>): string {
  const words = labels.places ?? {};
  const name = pathText(path, labels.memory?.pathJoin);
  return handle === null
    ? fill(words.refUnhandled ?? '{name}', { name })
    : fill(words.ref ?? '#{handle} {name}', { handle, name });
}

/** A name that may stand in a request as it is, escaped; `authors.unknown` for none. */
export function namedOrUnknown(labels: Labels, name: string | null | undefined): string {
  return typeof name === 'string' && name.trim() !== '' ? escapeStored(name) : (labels.authors?.unknown ?? '');
}

/** Where a person's handle may mention them: the name of their entry and every account by interface and platform id. */
export type HandleTarget = {
  readonly name: string | null;
  readonly accounts: ReadonlyArray<{ readonly iface: string; readonly native: string }>;
};

/**
 * What a request hands on for the rest of its turn: each person's handle (without `@`) to where it may mention them,
 * the handle of a person or account key as the request gives it, and a place id named as the request names it (null
 * for a place the memory holds no row of).
 */
export type RequestRefs = {
  readonly targets: ReadonlyMap<string, HandleTarget>;
  readonly personHandle: (key: string) => string;
  readonly placeRef: (placeId: string) => string | null;
};
