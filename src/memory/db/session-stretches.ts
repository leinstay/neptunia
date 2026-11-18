// The stretches of a memory session's batch (session.ts): the block `<stretches>` that lists them, each under a handle
// `sN` the answer cites, and the check of the answer's group `stretches`, one sentence per stretch. A stretch of a chat
// is cut by stretchesOf (stretches.ts) over her lines of the batch, a stretch of her own time is one heartbeat run. A
// stretch whose first line of hers lies within SILENCE_MS of a stored sentence's last moment in the same holder
// continues that sentence: the block shows it, and the writer replaces it (session-write.ts).

import { fill } from '../../format.ts';
import { block } from '../../turn/request/text.ts';
import { OWN_TIME_KIND } from './ids.ts';
import { scopeWhere } from './scope.ts';
import type { Context } from './scope.ts';
import { SILENCE_MS, overlapping, storedStretches, stretchesOf } from './stretches.ts';
import { asText } from './types.ts';
import type { Db, Row } from './types.ts';

/** The characters of a sentence the writer keeps. */
export const STRETCH_MAX_CHARS = 400;

/**
 * A stretch the request lists: its holder (the place, or the run of her own time), its first and last line of hers,
 * the ids of those lines, the range of the batch's numbered lines in it, and the stored sentence it continues.
 */
export type StretchRef = {
  holder: string;
  placeId: string | null;
  turnId: string | null;
  at: number;
  end: number;
  sources: Array<string>;
  from: number;
  to: number;
  prior: string | null;
};

/** One line of the batch as the block reads it: a `sources` row with its moment and its number, 0 when unnumbered. */
type Numbered = Row & { at: number; n: number };

/** The candidates of a chat batch: stretches of her lines, each with the numbered lines of its place since the last. */
function chatStretches(lines: ReadonlyArray<Numbered>): Array<Omit<StretchRef, 'prior'>> {
  const hers = lines
    .filter((line) => line.kind === 'said' && typeof line.place_id === 'string' && line.place_id)
    .map((line) => ({ placeId: String(line.place_id), at: line.at, id: asText(line.id) }));
  const before = new Map<string, number>();
  return stretchesOf(hers).flatMap((stretch) => {
    const after = before.get(stretch.placeId) ?? -Infinity;
    before.set(stretch.placeId, stretch.end);
    const numbers = lines
      .filter((line) => line.n > 0 && line.place_id === stretch.placeId && line.at > after && line.at <= stretch.end)
      .map((line) => line.n);
    if (numbers.length === 0) return [];
    return [
      {
        holder: stretch.placeId,
        placeId: stretch.placeId,
        turnId: null,
        at: stretch.at,
        end: stretch.end,
        sources: stretch.lines.map((line) => line.id),
        from: Math.min(...numbers),
        to: Math.max(...numbers),
      },
    ];
  });
}

/** The candidates of a batch of her own time: one per run, its numbered lines its sources. */
function ownStretches(lines: ReadonlyArray<Numbered>): Array<Omit<StretchRef, 'prior'>> {
  const byTurn = new Map<string, Array<Numbered>>();
  for (const line of lines) {
    if (line.kind !== OWN_TIME_KIND || line.n === 0) continue;
    const turn = asText(line.turn_id);
    byTurn.set(turn, [...(byTurn.get(turn) ?? []), line]);
  }
  return [...byTurn].map(([turn, own]) => ({
    holder: turn,
    placeId: null,
    turnId: turn,
    at: Math.min(...own.map((line) => line.at)),
    end: Math.max(...own.map((line) => line.at)),
    sources: own.map((line) => asText(line.id)),
    from: Math.min(...own.map((line) => line.n)),
    to: Math.max(...own.map((line) => line.n)),
  }));
}

/**
 * The block `<stretches>`, '' when it lists none, and what each handle stands for: the stretches of `lines` that hold a line of hers, read
 * under `ctx` for the stored sentences they continue (one read for all), in the words of `labels.memory`. `placeHandle`
 * names a place as the request does, `clock` a moment, and `read` records a stored sentence the block shows.
 */
export function stretchBlockOf(
  db: Db,
  ctx: Context,
  lines: ReadonlyArray<Numbered>,
  given: {
    words: Row;
    placeHandle: (id: string) => string;
    clock: (at: number) => string;
    read: (kind: string, id: string, block: string) => void;
  }
): { block: string; stretches: Map<string, StretchRef> } {
  const candidates = [...chatStretches(lines), ...ownStretches(lines)];
  const stretches = new Map<string, StretchRef>();
  if (candidates.length === 0) return { block: '', stretches };
  const stored = storedStretches(db, scopeWhere(ctx, 'e'), {
    holders: [...new Set(candidates.map((one) => one.holder))],
    from: Math.min(...candidates.map((one) => one.at)) - SILENCE_MS,
    to: Math.max(...candidates.map((one) => one.end)),
  });
  const out: Array<string> = [];
  for (const one of candidates) {
    const prior = overlapping(stored, { holder: one.holder, at: one.at - SILENCE_MS, end: one.end });
    const handle = `s${stretches.size + 1}`;
    stretches.set(handle, { ...one, prior: prior?.id ?? null });
    const values = { handle, first: given.clock(one.at), last: given.clock(one.end), from: one.from, to: one.to };
    const line = one.placeId
      ? fill(asText(given.words.stretch), { ...values, place: `[${given.placeHandle(one.placeId)}]` })
      : fill(asText(given.words.stretchOwn), values);
    if (prior) given.read('episode', prior.id, 'stretches');
    out.push(prior ? line + fill(asText(given.words.stretchStored), { what: prior.what }) : line);
  }
  return { block: block('stretches', out.join('\n')), stretches };
}

/**
 * The entries of the answer's group `stretches` that hold: each names a handle of the request and one sentence, cut
 * at STRETCH_MAX_CHARS. An unknown handle is `unknown_stretch`, an empty sentence `no_text` and a second sentence for
 * one stretch `duplicate_stretch`.
 */
export function validStretches(
  items: ReadonlyArray<unknown>,
  stretches: ReadonlyMap<string, StretchRef> | undefined,
  drop: (reason: string) => void
): Array<Row> {
  const kept: Array<Row> = [];
  const seen = new Set<string>();
  for (const item of items) {
    const entry = item && typeof item === 'object' && !Array.isArray(item) ? (item as Row) : null;
    if (!entry) {
      drop('bad_op');
      continue;
    }
    const handle = asText(entry.stretch).trim();
    const ref = stretches?.get(handle);
    if (!ref) {
      drop('unknown_stretch');
      continue;
    }
    const what = asText(entry.what).trim();
    if (!what) {
      drop('no_text');
      continue;
    }
    if (seen.has(handle)) {
      drop('duplicate_stretch');
      continue;
    }
    seen.add(handle);
    kept.push({ ...ref, what: what.slice(0, STRETCH_MAX_CHARS) });
  }
  return kept;
}
