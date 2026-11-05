// The helpers of the recall tests: the pinned config and clock, hits and windows, stored members and the record stand-ins.
import { toRecordLine } from '../../src/memory/record.ts';
import type { RecordLine } from '../../src/memory/record.ts';
import { readFileSync } from 'node:fs';

export const SHIPPED_CONFIG = JSON.parse(
  readFileSync(new URL('../../config/config.json', import.meta.url), 'utf8')
) as Record<string, Record<string, unknown>>;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
export const BERLIN = 'Europe/Berlin';

/** Seven one-hit clusters, two hours apart, alternating two channels; ids `k0` (oldest) .. `k6` (newest). */
export function sevenClusters(): Array<{ id: string; placeId: string; ts: number; }> {
  const t = Date.UTC(2026, 9, 1, 8);
  return Array.from({ length: 7 }, (_, i) => ({
    id: `k${i}`,
    placeId: i % 2 === 0 ? 'c1' : 'c2',
    ts: t + i * 2 * HOUR,
  }));
}

/** A hit of channel `placeId` at `ts` found by the queries `keys`. */
export function found(id: string, ts: number, keys: unknown, placeId = 'c1'): { id: string; placeId: string; ts: number; queries: unknown; } {
  return { id, placeId, ts, queries: keys };
}

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

/** A record line of `placeId` (src/memory/record.ts#toRecordLine), `kind` seen unless said. */
export function rec(
  id: string,
  ts: number,
  {
    placeId = 'c2',
    by = ANA,
    text = `line ${id}`,
    replyTo = null,
    kind = 'seen',
    revision = 1,
  }: {
    placeId?: string;
    by?: string;
    text?: string;
    replyTo?: string | null;
    kind?: 'seen' | 'said' | 'deleted';
    revision?: number;
  } = {}
): RecordLine {
  return toRecordLine(
    { id, placeId, authorId: by, content: text, ts, replyToId: replyTo },
    { kind, revision, now: () => NOW, uuid: () => `x-${id}-${revision}` }
  ) as RecordLine;
}

/** A fake record over `lines`: iterate keeps the query's [from, to] on occurredAt and notes each query. */
export function fakeRecord(lines: Array<object>): {
  queries: Array<{ placeId: string }>;
  iterate(placeId: string, query?: { from?: string; to?: string }): AsyncGenerator<object, void, unknown>;
} {
  const queries: Array<{ placeId: string }> = [];
  return {
    queries,
    iterate(placeId, query = {}) {
      queries.push({ placeId, ...query });
      const from = query.from ? Date.parse(query.from) : -Infinity;
      const to = query.to ? Date.parse(query.to) : Infinity;
      return (function* () {
        for (const line of lines) {
          const at = Date.parse((line as { occurredAt: string }).occurredAt);
          if (at >= from && at <= to) yield line;
        }
      })() as unknown as AsyncGenerator<object, void, unknown>;
    },
  };
}

/** A vector row of the record as the run hands it to matchRecord. */
export function meantRow(id: string, ts: number, { placeId = 'c2', sourceIds = [id] } = {}): { id: string; placeId: string; occurredAt: string; sourceIds: Array<string>; } {
  return { id, placeId, occurredAt: new Date(ts).toISOString(), sourceIds };
}

export const OCT_7 = { from: Date.UTC(2026, 9, 7), to: Date.UTC(2026, 9, 8) - 1 };
/** The forms of the asker's question: accented Latin, matched by their stems. */
export const CUE_FORMS = ['censure', 'retirer', 'résisté'];
/** The locator settings the tests set themselves (never the shipped defaults). */
export const LOCATE = { bonus: 2, decayDays: 7, broadShare: 0.5 };

/** The 10-04 event (three lines, every form among them) and two weaker lines on the 10-07 the asker named. */
export function cueRecord({ eventAt = Date.UTC(2026, 9, 4, 18, 0) } = {}): Array<RecordLine> {
  return [
    rec('o1', eventAt, { text: 'tu veux retirer la censure ?' }),
    rec('o2', eventAt + MINUTE, { kind: 'said', text: 'non, j’ai résisté, la censure reste' }),
    rec('o3', eventAt + 2 * MINUTE, { by: ELO, text: 'elle a résisté à retirer la censure' }),
    rec('w1', Date.UTC(2026, 9, 7, 15, 0), { placeId: 'c1', text: 'une nouvelle règle de censure' }),
    rec('w2', Date.UTC(2026, 9, 7, 20, 0), { placeId: 'c3', text: 'censure encore' }),
  ];
}
