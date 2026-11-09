// The turn's one handle registry (`draft.handles`): every `#n` a request issues, the chat lines, the reply parents, the
// pulled lines and the search handles above the floor, each to the line it names. A reference in her words means
// nothing outside the request that numbered it, so when her words leave the turn into a durable row (her think in the
// journal, her posted line in the record, an intention, a skill action's arguments) `canonical` replaces each
// reference by the line's identity, `src:<iface>:<message id>:<revision>`, and cuts a number that names nothing. The
// identity is written from the target's interface, message id and revision, the columns of the line's source row,
// never from the text of its source id. Pure apart from the registry's own map.

/** What issued a number: a line of `<chat>`, a reply parent, a line of a pulled channel, a search handle. */
export type HandleKind = 'chat' | 'parent' | 'pulled' | 'search';

/**
 * The line a number names: its memory source id, its interface (null when no row holds one), its place, the platform's
 * message id and the revision she saw.
 */
export type HandleTarget = {
  sourceId: string;
  iface: string | null;
  placeId: string;
  messageId: string;
  revision: number;
};

/** The turn's registry. */
export type Handles = {
  /** Gives `target` the next free number (one past the highest issued) and returns it. */
  issue(kind: HandleKind, target: HandleTarget): number;
  /** Registers `n`, a number a renderer already printed for `target`; a number already held keeps its first line. */
  take(n: number, kind: HandleKind, target: HandleTarget): void;
  /** The line `n` names, with the kind that issued it; null for a number nobody issued. */
  resolve(n: number): (HandleTarget & { kind: HandleKind }) | null;
  /** `text` with every reference replaced by its line's identity and every unknown number cut. */
  canonical(text: string): string;
  /** How many numbers `canonical` cut since the registry was made, for the turn's log line. */
  cut(): number;
};

/**
 * A reference: `#` and digits with no letter, digit or underscore glued to either side, so `#12`, `(#12)` and both ends
 * of `#12-#15` are references while `#12a`, `x#12` and `issue#12` are not.
 */
const REFERENCE = /( ?)(?<![\p{L}\p{N}_])#(\d{1,9})(?![\p{L}\p{N}_])/gu;

/**
 * The identity a stored text carries for a line: its interface, its message id and the revision she saw. A line whose
 * interface nobody stored keeps its source id.
 */
export function lineIdentity(target: HandleTarget): string {
  if (target.iface === null) return target.sourceId;
  return `src:${target.iface}:${target.messageId}:${target.revision}`;
}

/**
 * The target of a line a memory.search quoted, from its stored source: the source's interface, else the interface of
 * its native locator. The revision is read from the source id, 1 when it holds none.
 * TODO(plan 2026-11-08-ids-by-links, slice 8): take the revision from the source row once the stored source ref of
 * src/memory/db/recall.ts carries it.
 */
export function targetOfSource(
  stored: { sourceId: string; placeId: string; iface: string | null; native?: { iface: string } },
  messageId: string
): HandleTarget {
  const revision = Number(stored.sourceId.split(':').at(-2));
  return {
    sourceId: stored.sourceId,
    iface: stored.iface ?? stored.native?.iface ?? null,
    placeId: stored.placeId,
    messageId,
    revision: Number.isInteger(revision) && revision > 0 ? revision : 1,
  };
}

/** A new, empty registry for one turn. */
export function createHandles(): Handles {
  const byNumber = new Map<number, HandleTarget & { kind: HandleKind }>();
  let highest = 0;
  let cutCount = 0;

  function take(n: number, kind: HandleKind, target: HandleTarget): void {
    if (!Number.isInteger(n) || n < 1 || byNumber.has(n)) return;
    byNumber.set(n, { ...target, kind });
    highest = Math.max(highest, n);
  }

  return {
    issue(kind, target) {
      const n = highest + 1;
      take(n, kind, target);
      return n;
    },
    take,
    resolve: (n) => byNumber.get(n) ?? null,
    canonical(text) {
      if (typeof text !== 'string' || !text.includes('#')) return text;
      return text.replace(REFERENCE, (_match, space: string, digits: string) => {
        const target = byNumber.get(Number(digits));
        if (target) return `${space}${lineIdentity(target)}`;
        // A cut number takes the space before it along, so no double space is left behind.
        cutCount += 1;
        return '';
      });
    },
    cut: () => cutCount,
  };
}
