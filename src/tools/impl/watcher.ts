// Operation `watcher.read`: her side of the watcher's reports (src/watcher/). `watcher.read { day? }` answers the
// latest report, or the report of one day `YYYY-MM-DD`, as text, with its day in the data. It reads a file the watcher
// wrote through the reader the core gives the operations' environment (`env.watcher`); a core with none answers
// `failed`. It is not granted to her in the tracked config: the owner opens it with `/tools grant watcher.read`. Her
// grant alone does not let anyone else read it: it is an owner-only read for a person who asks.

import { defineOp, invalid } from './registry.ts';
import { CODE } from '../codes.ts';
import { textOf } from '../types.ts';
import type { Obj, OpContext } from '../types.ts';

function cmdRead(args: Obj, ctx: OpContext) {
  const reader = ctx.env.watcher;
  if (reader == null) {
    return { status: 'failed', code: CODE.NOT_CONFIGURED, summary: 'watcher: no reports here', data: null };
  }
  const asked = textOf(args.day).trim();
  const read = reader.read(asked === '' ? undefined : asked);
  if (!read.ok) {
    if (read.code === 'invalid-day') throw invalid('day: a date written YYYY-MM-DD');
    const which = asked === '' ? 'no report yet' : `no report for ${asked}`;
    return { status: 'failed', code: CODE.NOT_FOUND, summary: which, data: null };
  }
  const { day, text } = read.report;
  return { status: 'ok', code: CODE.OK, summary: text, data: { day, text } };
}

defineOp({
  name: 'watcher.read',
  rights: { kind: 'read', member: false },
  run: (args, ctx) => cmdRead(args, ctx),
});
