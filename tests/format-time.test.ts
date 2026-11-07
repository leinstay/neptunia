// Tests for the time of a line in `<chat>` (src/format.ts#formatTranscript over src/turn/history.ts#orderedHistory): one
// clock per line and no age, one date header per day, and the call mark that says where she called from and where a
// lookup searched. Plan 2026-11-06-turn-frame, slice 2 (b) and (c). Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, formatTranscript, renderTranscript } from '../src/format.ts';
import type { Line } from '../src/behavior/lines.ts';
import { orderedHistory } from '../src/turn/history.ts';
import { labels } from './fixtures/labels.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const TZ = 'UTC';
const PLACE = 'discord:channel:room-1';

/** A line of the chat by Zoé. */
function line(id: string, ts: number): Line {
  return {
    id,
    placeId: PLACE,
    authorId: 'u1',
    authorName: 'Zoé',
    content: `λόγια ${id}`,
    self: false,
    ts,
    reactions: [],
  };
}

/** How often `part` stands in `text`. */
const count = (text: string, part: string) => text.split(part).length - 1;

test('a line older than an hour shows its clock alone, with no age', () => {
  // Bug: the line carries a clock and an age, and with `<tempo>` she adds durations that disagree.
  const now = Date.UTC(2026, 10, 5, 12, 0, 0);
  const items = formatTranscript([line('m1', now - 3 * HOUR)], {
    timezone: TZ,
    selfName: 'Nept',
    labels: { ...labels, transcript: { ...labels.transcript, timeAged: '[{clock} · {age} ago]' } },
    now,
  });
  assert.equal(items[0]?.text, '#1 [09:00] Zoé: λόγια m1');
});

test('each day of the chat has one date header, before its first line, a call mark included', () => {
  // Bug: the day change is measured between messages only, so a mark after midnight sits under the old day.
  const day1 = Date.UTC(2026, 10, 4, 22, 0, 0);
  const day2 = Date.UTC(2026, 10, 5, 0, 0, 0);
  const history = orderedHistory(
    [line('a', day1), line('b', day1 + 90 * MIN), line('c', day2 + 20 * MIN), line('d', day2 + 9 * HOUR)],
    [{ placeId: PLACE, at: day2 + 10 * MIN, skill: 'memory.search', status: 'ok' }],
    day2 + 10 * HOUR
  );
  const text = renderTranscript(formatTranscript(history, { timezone: TZ, selfName: 'Nept', labels }), TZ, labels);
  const date1 = formatDate(day1, TZ, labels.locale);
  const date2 = formatDate(day2, TZ, labels.locale);
  assert.equal(count(text, date1), 1, text);
  assert.equal(count(text, date2), 1, text);
  assert.ok(text.indexOf(date2) < text.indexOf('memory.search'), text);
});

test('the call mark of a search names the place she called from, then the place searched, the query and the status', () => {
  // Bug: the mark names only one place, so a search of another room reads as a search of this one.
  const t0 = Date.UTC(2026, 10, 5, 10, 0, 0);
  const history = orderedHistory(
    [line('m1', t0)],
    [
      {
        placeId: PLACE,
        at: t0 + 5 * MIN,
        skill: 'memory.search',
        status: 'ok',
        args: 'query "λαγός"',
        from: 'café',
        searched: 'salon',
      },
    ],
    t0 + HOUR
  );
  const tokens = {
    ...labels,
    transcript: {
      ...labels.transcript,
      called: '[C {skill}{args}: {status}]',
      calledFrom: ' F<{place}>',
      calledSearched: ' S<{place}>',
      calledArgs: ' A<{args}>',
      callStatus: { ...labels.transcript.callStatus, ok: 'OK' },
    },
  };
  const text = formatTranscript(history, { timezone: TZ, selfName: 'Nept', labels: tokens })
    .map((item) => item.text)
    .join('\n');
  assert.ok(text.includes('[C memory.search F<café> S<salon> A<query "λαγός">: OK]'), text);
});
