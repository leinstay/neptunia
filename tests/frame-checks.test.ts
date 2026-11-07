// Tests for scripts/lib/frame-checks.ts: the replay's checks over a rendered request, each returning its findings (empty
// when the request passes). `chatInTimeOrder` checks that every line of `<chat>` stands in time order with one clock,
// `placeBound` that `<spatial_awareness>` puts her in the place the request was built for. Each check takes the labels the
// request was rendered with, since a deployment rewords them. Plan 2026-11-06-turn-frame, slice 2 (h).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTranscript, renderTranscript } from '../src/format.ts';
import type { Line } from '../src/behavior/lines.ts';
import { spatialAwarenessText } from '../src/turn/request/spatial.ts';
import { block } from '../src/turn/request/text.ts';
import { chatInTimeOrder, placeBound } from '../scripts/lib/frame-checks.ts';
import { labels } from './fixtures/labels.ts';

const MIN = 60_000;
const TZ = 'UTC';
const PLACE = 'discord:channel:room-1';
const MIDNIGHT = Date.UTC(2026, 10, 5, 0, 0, 0);

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

/** `<chat>` of four lines in time order across midnight, rendered as a request renders it. */
function chatText(): string {
  const lines = [
    line('a', MIDNIGHT - 20 * MIN),
    line('b', MIDNIGHT - 5 * MIN),
    line('c', MIDNIGHT + 5 * MIN),
    line('d', MIDNIGHT + 15 * MIN),
  ];
  return renderTranscript(formatTranscript(lines, { timezone: TZ, selfName: 'Nept', labels }), TZ, labels);
}

/** `<spatial_awareness>` of a turn in the channel `café` of the server `Ágora`. */
function spatialText(): string {
  return spatialAwarenessText({
    whereabouts: {
      kind: 'place',
      iface: 'discord',
      private: false,
      chain: [
        { id: PLACE, kind: 'channel', name: 'café' },
        { id: 'discord:server:g1', kind: 'server', name: 'Ágora' },
      ],
    },
    now: MIDNIGHT + 20 * MIN,
    timezone: TZ,
    labels,
    notes: null,
  });
}

/** A request with the two blocks, `<chat>` given. */
const request = (chat: string) => [block('spatial_awareness', spatialText()), block('chat', chat)].join('\n\n');

test('chatInTimeOrder finds nothing in a chat whose lines run in order across midnight', () => {
  // Bug: the check compares clocks alone, so 00:05 after 23:55 reads as out of order.
  assert.deepEqual(chatInTimeOrder(request(chatText()), labels), []);
});

test('chatInTimeOrder reports a chat with two lines out of time order', () => {
  const rows = chatText().split('\n');
  const first = rows.findIndex((row) => row.includes('λόγια a'));
  const second = rows.findIndex((row) => row.includes('λόγια b'));
  [rows[first], rows[second]] = [rows[second], rows[first]];
  assert.notEqual(chatInTimeOrder(request(rows.join('\n')), labels).length, 0);
});

test('chatInTimeOrder reports a line that carries a clock and an age', () => {
  const aged = chatText().replace('[23:55]', '[23:55 · 25 min ago]');
  assert.ok(aged.includes('25 min ago'), 'the counter-example holds the aged line');
  assert.notEqual(chatInTimeOrder(request(aged), labels).length, 0);
});

test('placeBound finds nothing when the place of spatial_awareness is the place the request was built for', () => {
  assert.deepEqual(placeBound(request(chatText()), 'café', labels), []);
});

test('placeBound reports a request built for the server while spatial_awareness puts her in a channel of it', () => {
  // Bug: the check looks for the name anywhere in the block, and a parent on the path passes for the place.
  assert.notEqual(placeBound(request(chatText()), 'Ágora', labels).length, 0);
});
