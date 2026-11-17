// Which record lines may hold a cached picture (src/memory/record-finder.ts), and the creation time of a snowflake id
// that dates a media cache key. scripts/vision-compare.ts finds its pictures again with them.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recordFinder, snowflakeMs } from '../src/memory/record-finder.ts';

const NOW = Date.UTC(2026, 9, 15, 12);
const DAY = 24 * 60 * 60 * 1000;

/** A Discord snowflake id created at `ms` (sequence `seq`). */
function snowflake(ms: number, seq = 0) {
  return String((BigInt(ms - 1_420_070_400_000) << 22n) + BigInt(seq));
}

test('snowflakeMs: the creation time of a snowflake; null for anything else', () => {
  assert.equal(snowflakeMs(snowflake(NOW, 5)), NOW);
  assert.equal(snowflakeMs('m1'), null);
  assert.equal(snowflakeMs('123'), null);
  assert.equal(snowflakeMs(undefined), null);
});

test('recordFinder: a gif embed by its message, an attachment by its upload time, an undated key within the window', () => {
  const upload = NOW - 3 * DAY;
  const attachment = snowflake(upload);
  const embedMessage = snowflake(NOW - 40 * DAY);
  const line = (messageId: string, occurredAt: number, extra = {}) => ({
    kind: 'seen',
    messageId,
    occurredAt: new Date(occurredAt).toISOString(),
    scope: { channel: 'c1' },
    media: ['image'],
    ...extra,
  });

  const dated = recordFinder([attachment, `${embedMessage}#e0`], NOW - 7 * DAY);
  assert.ok(dated.fromMs <= NOW - 40 * DAY, 'reads back to the oldest dated key');
  assert.equal(dated.matches(line(embedMessage, NOW - 40 * DAY)), true);
  assert.equal(
    dated.matches(line(snowflake(upload + 60_000), upload + 60_000)),
    true,
    'sent a minute after the upload'
  );
  assert.equal(dated.matches(line(snowflake(upload + 3_600_000), upload + 3_600_000)), false, 'an hour later');
  assert.equal(
    dated.matches(line(snowflake(NOW - DAY), NOW - DAY)),
    false,
    'no undated key: the window alone is not enough'
  );
  assert.equal(dated.matches(line(embedMessage, NOW - 40 * DAY, { media: [] })), false, 'no media');
  assert.equal(dated.matches(line(embedMessage, NOW - 40 * DAY, { kind: 'deleted' })), false);

  const undated = recordFinder(['link:aa'], NOW - 7 * DAY);
  assert.equal(undated.fromMs, NOW - 7 * DAY);
  assert.equal(undated.matches(line(snowflake(NOW - DAY), NOW - DAY)), true);
  assert.equal(undated.matches(line(snowflake(NOW - 8 * DAY), NOW - 8 * DAY)), false);
});
