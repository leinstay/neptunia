// Operations: `/nep task places [filter] [sort] [page]` -- her read skill `places.list`
// (docs/inner-life.md "Her attention"): the places the interface publishes for the server (the
// channel directory, writable or read-only alike), each with its address, its name, whether she can
// write there, the lines and distinct people since her last look there (counted from the record by
// the inner life, src/behavior/inner.ts#places), and whether she attends it; filtered by name
// (`filter`), sorted (`sort`: `recent`, the default, `name`, `lines`), one page of
// `innerLife.attention.pageSize` at a time (`page`). The total and how many more are always said.
// A read; grantable to her and to people. Answers are operator lines (addresses, names, counts).

import { defineOp, perEnv, invalid } from './registry.ts';
import { CODE } from '../codes.ts';
import { textOf } from '../types.ts';
import type { Obj, OpContext, Untyped } from '../types.ts';

/** The orders `sort` may name. */
export const PLACE_SORTS = Object.freeze(['recent', 'name', 'lines']);

/** The time of `ts` for an answer line (UTC, minutes). */
function stamp(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
}

/** One place as an answer line. */
export function placeLine(place: Untyped): string {
  const parts = [`${place.name ?? place.id} (${place.id})`, `${place.lines} lines`, `${place.people} people`];
  if (Number.isFinite(place.newestAt)) parts.push(`last ${stamp(place.newestAt)}`);
  if (place.writable === false) parts.push('read-only');
  if (place.attended) parts.push('attending');
  if (Number.isFinite(place.present)) parts.push(`${place.present} here now`);
  return parts.join(' · ');
}

const handlers = perEnv((env) => {
  const { resolvedGuildId } = env;

  /** The inner life's places view, or an Error naming what is missing. */
  function places() {
    if (typeof env.inner?.places !== 'function')
      throw Object.assign(new Error('the places are not available'), { code: CODE.NOT_CONFIGURED });
    return env.inner;
  }

  function cmdList(args: Obj, context: OpContext) {
    const filter = typeof args.filter === 'string' && args.filter.trim() ? args.filter.trim() : null;
    const sort =
      args.sort === undefined || args.sort === null || args.sort === ''
        ? 'recent'
        : textOf(args.sort).trim().toLowerCase();
    if (!PLACE_SORTS.includes(sort)) throw invalid(`sort: ${PLACE_SORTS.join(', ')}`, CODE.BAD_SORT);
    const raw = args.page === undefined || args.page === null || args.page === '' ? 1 : Number(args.page);
    if (!Number.isInteger(raw) || raw < 1) throw invalid('page: a whole number from 1', CODE.BAD_PAGE);
    const result = places().places(resolvedGuildId(context), { filter, sort, page: raw });
    const lines = result.items.map(placeLine);
    lines.push(`total ${result.total}, ${result.more} more`);
    const text = lines.join('\n');
    return { status: 'ok', code: CODE.OK, summary: text, data: { text, places: result } };
  }

  return { cmdList };
});

defineOp({
  name: 'places.list',
  rights: { kind: 'read' },
  run: (args, ctx) => handlers(ctx.env).cmdList(args, ctx),
});
