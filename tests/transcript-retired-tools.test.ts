// A call the journal stored under the name of a tool that no registry knows any more still reads in the transcript:
// the mark comes from the stored record alone (src/memory/journal.ts#callMarksOf, src/format.ts#callMarksFor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callMarksFor, formatTranscript, withPostedFrom } from '../src/format.ts';
import { orderedHistory } from '../src/turn/history.ts';
import { callMarksOf } from '../src/memory/journal.ts';
import { labels } from './fixtures/labels.ts';
import { msg } from './fixtures/format-rig.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 20, 10, 0, 0);

test('a past result of a retired plugin tool still reads as it was stored', () => {
  // The plugin mechanism retired, so `echo.say` is in no registry. A reader that looked the tool up there would drop
  // the mark or fail on it; the journal row is the only source.
  const at = (seconds: number) => new Date(T0 + MIN + seconds * 1000).toISOString();
  const row = (phase: string, seconds: number, extra: Record<string, unknown> = {}) => ({
    kind: 'action',
    name: 'skill',
    opId: 'op-echo',
    turnId: 't1',
    phase,
    scope: { channel: 'c1' },
    occurredAt: at(seconds),
    ...extra,
  });
  const marks = callMarksOf([
    { kind: 'turn', turnId: 't1', posted: ['p1'] },
    row('proposed', 1, { input: { skill: 'echo.say' } }),
    row('succeeded', 2, { result: { status: 'ok' } }),
  ]);
  const lines = [
    msg('q1', T0, { authorName: 'Eloise', content: 'can you say it?' }),
    msg('p1', T0 + MIN, { self: true, authorName: 'Nept', content: 'one moment' }),
  ];
  // Slice 2 (a): `withCalls` is gone; the posted-from marks and the call marks are applied apart, a mark as its own line.
  const out = orderedHistory(
    withPostedFrom(lines, new Map(marks.postedFrom)),
    callMarksFor(marks.calls as Array<Record<string, unknown>>),
    T0 + 60 * MIN
  );
  const items = formatTranscript(out, {
    timezone: 'UTC',
    gapMinutes: 20,
    maxChars: 200,
    selfName: 'Nept',
    labels,
  });
  // Slice 2 (a): the mark is a line of its own after her line, never appended to it.
  assert.match(items[1].text, /one moment\n\[10:01\] Nept \(you\): \[called echo\.say: done\]$/);
});
