// The helpers of the recall tests: the clock, messages, stored members and archive entries.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
export const BERLIN = 'Europe/Berlin';

/** A normalized message. */
export function msg(id: string, ts: number, extra = {}): { id: string; placeId: string; authorId: string; authorName: string; self: boolean; bot: boolean; content: string; ts: number; attachments: Array<never>; links: Array<never>; stickers: Array<never>; emojis: Array<never>; forwarded: Array<never>; reactions: Array<never>; replyToId: null; } {
  return {
    id,
    placeId: 'c1',
    authorId: 'u1',
    authorName: 'Ana',
    self: false,
    bot: false,
    content: `line ${id}`,
    ts,
    attachments: [],
    links: [],
    stickers: [],
    emojis: [],
    forwarded: [],
    reactions: [],
    replyToId: null,
    ...extra,
  };
}

export const ANA = '411111111111111111';
export const KITE = '477777777777777777';
export const ELO = '433333333333333333';

/** A stored episode. */
export function ep(
  date: string,
  what: string,
  { quote = '', feeling = '', weight = 3, addedAt = `${date}T20:00:00.000Z` } = {}
): { date: string; what: string; quote: string; feeling: string; weight: number; addedAt: string; } {
  return { date, what, quote, feeling, weight, addedAt };
}

/** An archive entry as src/memory/archive.ts#archiveEntry writes it (the fields recall reads). */
export function archived(
  itemKind: string,
  itemId: string,
  text: string,
  {
    observedAt = { date: '2026-08-01', precision: 'day' },
    scope = { user: ANA },
    recordedAt = '2026-10-01T00:00:00.000Z',
    neutral = null,
    weight,
  }: {
    observedAt?: { date: string; precision: string };
    scope?: { user?: string; channel?: string };
    recordedAt?: string;
    neutral?: unknown;
    weight?: number;
  } = {}
): Record<string, unknown> {
  return {
    v: 1,
    id: `a-${itemId}-${recordedAt}`,
    kind: 'archive',
    event: 'evicted',
    itemKind,
    itemId,
    revisionId: `rv-${recordedAt}`,
    scope,
    participants: scope.user ? [scope.user] : [],
    observedAt,
    neutral,
    text,
    ...(weight === undefined ? {} : { weight }),
    stored: {},
    recordedAt,
    placeId: 'g1',
  };
}
