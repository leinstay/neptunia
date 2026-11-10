// The extracted source locator preserves routes already covered by the database source-handle regressions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeLocatorOf } from '../src/memory/db/source-locator.ts';
import { recordSourceRow } from '../src/memory/db/record-lines.ts';
import type { Row, Rows } from '../src/memory/db/types.ts';

/**
 * A record row as an older release stored it, a private layer's partner spelled in its day file's path, and its writer
 * as version step 46 stamped it.
 */
const recordRows = (rel: string, line: Row): Rows => ({
  sources: [
    {
      // The older release's record was Discord's.
      ...recordSourceRow(line, { iface: 'discord', privateAccountId: /private\/([^/]+)\//.exec(rel)?.[1] ?? null }),
      writer: 'record',
      position: null,
    },
  ],
});

function historical(): { row: Row; extra: Row } {
  const mapping = recordRows('private/partner-42/record/2026-10/2026-10-23.jsonl', {
    v: 1,
    id: 'record-historic-anchor',
    kind: 'seen',
    messageId: 'historic-anchor',
    revision: 1,
    occurredAt: '2026-10-23T12:00:00.000Z',
    recordedAt: '2026-10-24T12:00:00.000Z',
    placeId: 'g1',
    scope: { channel: 'historic-dm-73' },
    by: 'partner-42',
    text: 'Synthetic historical evidence',
    origin: 'live',
  });
  const row = mapping.sources?.[0];
  if (!row || typeof row.extra !== 'string') {
    throw new Error('the record row omitted its source metadata');
  }
  const parsed: unknown = JSON.parse(row.extra);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the record row metadata must be a JSON object');
  }
  // A parsed JSON object has string keys after the object and array checks above.
  const extra = parsed as Row;
  delete extra.$messageLocator;
  return { row, extra };
}

test('a verified marker returns its native route instead of the opaque storage key', () => {
  const result = nativeLocatorOf(
    { iface: 'fake', native_id: 'opaque-family-key', kind: 'seen', place_id: 'opaque-place' },
    {
      $messageLocator: {
        v: 1,
        origin: 'protocol-message',
        iface: 'fake',
        chatId: 'actual-dm',
        messageId: 'same-native',
      },
    }
  );
  assert.deepEqual(result, { iface: 'fake', chatId: 'actual-dm', messageId: 'same-native' });
});

test('a marker stored before the chat rename, with its conversationId key, still returns its native route', () => {
  // Catches: rows of the append-only sources table that name the chat `conversationId` losing their message route.
  const result = nativeLocatorOf(
    { iface: 'fake', native_id: 'opaque-family-key', kind: 'seen', place_id: 'opaque-place' },
    {
      $messageLocator: {
        v: 1,
        origin: 'protocol-message',
        iface: 'fake',
        conversationId: 'old-dm',
        messageId: 'old-native',
      },
    }
  );
  assert.deepEqual(result, { iface: 'fake', chatId: 'old-dm', messageId: 'old-native' });
});

test('an unmarked historical record routes through its actual DM chat rather than its partner', () => {
  const { row, extra } = historical();
  assert.deepEqual(nativeLocatorOf(row, extra), {
    iface: 'discord',
    chatId: 'historic-dm-73',
    messageId: 'historic-anchor',
  });
});

test('a malformed present marker refuses the otherwise valid historical fallback', () => {
  const { row, extra } = historical();
  assert.equal(nativeLocatorOf(row, { ...extra, $messageLocator: null }), undefined);
});

test('a nonrecord source never gains a route from record-shaped native metadata', () => {
  const { row, extra } = historical();
  assert.equal(nativeLocatorOf({ ...row, writer: 'profile' }, extra), undefined);
});

test('a historical record line reads its chat from the stored place when the place id spells nothing', () => {
  const channelOfPlace = (placeId: string): string | null => (placeId === 'place:9b24' ? 'room-n' : null);
  const result = nativeLocatorOf(
    { iface: 'fake', native_id: 'm-1', kind: 'seen', place_id: 'place:9b24', storage_kind: 'record' },
    { v: 1, id: 'record-1' },
    channelOfPlace
  );
  assert.deepEqual(result, { iface: 'fake', chatId: 'room-n', messageId: 'm-1' });
});
