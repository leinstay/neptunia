// Exact stored source handles and verified native locators use synthetic SQLite evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search, window, quotesOf, dbSettings } from '../src/memory/db/recall.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import { groupContext, internalContext } from '../src/memory/db/scope.ts';
import { fixture } from './fixtures/memory-db-recall.ts';
import { labels } from './fixtures/labels.ts';
import { observe, OBSERVE_CODES, type Envelope } from '../src/memory/db/observe.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { toRows as recordRows } from '../src/memory/db/map/record.ts';
import { lineEvent } from './fixtures/core-over-fake.ts';

const DAY = 86400000;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const group = groupContext('discord');
const run = (
  env: ReturnType<typeof fixture>,
  forms: Array<string>,
  { plan: given = {}, ...rest }: { plan?: Record<string, unknown>; [key: string]: unknown } = {},
  ctx = group
) => search(env.db, { ctx, plan: { forms, who: [], from: null, to: null, ...given }, now: NOW, ...rest });

function storedObservation(
  env: ReturnType<typeof fixture>,
  {
    key,
    room,
    iface = 'other',
    authority = `${iface}/${room}`,
    text = 'το κουνέλι',
    at = NOW - DAY,
    privatePlace = false,
    revision = 1,
  }: {
    key: string;
    room: string;
    iface?: string;
    authority?: string;
    text?: string;
    at?: number;
    privatePlace?: boolean;
    revision?: number;
  }
) {
  const envelope: Envelope = {
    v: 1,
    iface,
    authority,
    native: { kind: 'message', key, revision },
    place: {
      authority,
      key: room,
      kind: privatePlace ? 'dm' : 'room',
      chat: privatePlace ? 'dm' : 'group',
      ...(privatePlace ? { partner: { key: 'private-partner' } } : {}),
    },
    author: { kind: 'account', key: 'author-42' },
    occurredAt: new Date(at).toISOString(),
    observedAt: new Date(NOW).toISOString(),
    text,
  };
  const result = observe(env.handle, envelope, { now: () => NOW });
  assert.equal(result.ok, true);
  if (typeof result.sourceId !== 'string') throw new Error('source identity missing');
  const placeId = env.db.prepare('SELECT place_id FROM sources WHERE id = ?').get(result.sourceId)?.place_id;
  if (typeof placeId !== 'string') throw new Error('stored place missing');
  return { sourceId: result.sourceId, placeId, iface };
}

for (const secondIface of ['other', 'foreign']) {
  test(`stored source handles preserve both same-native quotes across ${secondIface} place collisions`, () => {
    const env = fixture();
    try {
      const first = storedObservation(env, { key: 'collision-42', room: 'room-one', text: 'το κουνέλι first-anchor' });
      storedObservation(env, { key: 'before-one', room: 'room-one', at: NOW - DAY - 60_000, text: 'first-neighbor' });
      const second = storedObservation(env, {
        key: 'collision-42',
        room: 'room-two',
        iface: secondIface,
        text: 'το κουνέλι second-anchor',
      });
      storedObservation(env, {
        key: 'before-two',
        room: 'room-two',
        iface: secondIface,
        at: NOW - DAY - 60_000,
        text: 'second-neighbor',
      });
      env.stem();
      const found = run(env, ['κουνέλι']);
      const messages = found.windows
        .flatMap((one) => one.messages)
        .filter((message) => message.content.includes('anchor'));
      assert.deepEqual(
        messages.map((message) => message.stored?.sourceId).sort(),
        [first.sourceId, second.sourceId].sort()
      );
      const quotes = quotesOf(found.windows, { render: { labels, timezone: 'UTC' }, stretchChars: 1500 });
      assert.deepEqual(
        quotes
          .flatMap((quote) => quote.entries)
          .filter((entry) => entry.id === 'collision-42')
          .map((entry) => entry.stored)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        [first, second].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      );
      for (const [source, neighbor] of [
        [first, 'first-neighbor'],
        [second, 'second-neighbor'],
      ] as const) {
        const expanded = window(env.db, {
          ctx: group,
          resolvedAnchor: { kind: 'source', sourceId: source.sourceId },
          move: 'up',
          messages: 1,
        });
        assert.equal(expanded.unknown, false);
        assert.deepEqual(
          expanded.windows.flatMap((one) => one.messages.map((message) => message.content)),
          [neighbor]
        );
      }
    } finally {
      env.done();
    }
  });
}

test('stored source handles fail closed for an ambiguous raw anchor even when only one collision is visible', () => {
  const env = fixture();
  try {
    const hidden = storedObservation(env, {
      key: 'hidden-first-42',
      room: 'private-room',
      privatePlace: true,
      text: 'hidden-source-marker',
    });
    const visible = storedObservation(env, {
      key: 'hidden-first-42',
      room: 'visible-room',
      text: 'visible-source-marker',
    });
    storedObservation(env, {
      key: 'visible-before',
      room: 'visible-room',
      at: NOW - DAY - 60_000,
      text: 'visible-neighbor',
    });
    const raw = window(env.db, { ctx: group, anchor: 'hidden-first-42' });
    assert.equal(raw.unknown, true);
    assert.deepEqual(raw.windows, []);
    const exact = window(env.db, {
      ctx: group,
      resolvedAnchor: { kind: 'source', sourceId: visible.sourceId },
      move: 'up',
      messages: 1,
    });
    assert.equal(exact.unknown, false);
    assert.equal(exact.windows[0].messages[0].content, 'visible-neighbor');
    const denied = window(env.db, {
      ctx: group,
      anchor: visible.sourceId,
      resolvedAnchor: { kind: 'source', sourceId: hidden.sourceId },
    });
    assert.equal(denied.unknown, true);
    assert.deepEqual(denied.windows, []);
  } finally {
    env.done();
  }
});

test('stored source handles resolve opaque exact IDs without falling back to a colliding native namespace', () => {
  const env = fixture();
  try {
    const exact = env.say({ native: 'opaque-native', at: NOW - DAY, text: 'exact-source-marker' });
    env.db.prepare('UPDATE sources SET id = ? WHERE id = ?').run('opaque-source-731', exact);
    env.say({ native: 'opaque-before', at: NOW - DAY - 60_000, text: 'exact-neighbor' });
    storedObservation(env, { key: 'opaque-source-731', room: 'collision-room', text: 'wrong-source-marker' });
    const raw = window(env.db, { ctx: group, anchor: 'opaque-source-731' });
    assert.equal(raw.unknown, true);
    const expanded = window(env.db, {
      ctx: group,
      resolvedAnchor: { kind: 'source', sourceId: 'opaque-source-731' },
      move: 'up',
      messages: 1,
    });
    assert.equal(expanded.unknown, false);
    assert.equal(expanded.windows[0].messages[0].content, 'exact-neighbor');
    const missing = window(env.db, {
      ctx: group,
      anchor: 'opaque-native',
      resolvedAnchor: { kind: 'source', sourceId: 'missing-source' },
    });
    assert.equal(missing.unknown, true);
    assert.deepEqual(missing.windows, []);
  } finally {
    env.done();
  }
});

test('stored source handles follow a reply parent only in the originating place', () => {
  const env = fixture();
  try {
    storedObservation(env, {
      key: 'parent-42',
      room: 'wrong-room',
      at: NOW - DAY - 10 * 60_000,
      text: 'foreign-parent-marker',
    });
    storedObservation(env, {
      key: 'parent-42',
      room: 'reply-room',
      at: NOW - DAY - 10 * 60_000,
      text: 'own-parent-marker',
    });
    const reply = storedObservation(env, { key: 'reply-42', room: 'reply-room', text: 'το κουνέλι reply-marker' });
    env.db.prepare('UPDATE sources SET reply_to = ? WHERE id = ?').run('parent-42', reply.sourceId);
    env.stem();
    const found = run(env, ['κουνέλι'], { settings: { ...dbSettings({})!, recordContext: 0, followMessages: 0 } });
    const text = found.windows.flatMap((one) => one.messages.map((message) => message.content));
    assert.ok(text.includes('own-parent-marker'));
    assert.equal(text.includes('foreign-parent-marker'), false);
  } finally {
    env.done();
  }
});

test('stored source handles qualify mapped DM anchors by the actual chat rather than the partner', () => {
  const env = fixture();
  try {
    for (const [id, offset] of [
      ['mapped-before', 60_000],
      ['mapped-anchor', 0],
    ] as const) {
      const event = lineEvent({
        id,
        chatId: 'actual-dm-73',
        authorId: 'partner-42',
        text: `το κουνέλι ${id}`,
        at: NOW - DAY - offset,
      });
      event.chat = { id: 'actual-dm-73', kind: 'dm', rootId: null, partnerId: 'partner-42' };
      const envelope = observationOf(event);
      assert.ok(envelope);
      assert.equal(observe(env.handle, envelope, { now: () => NOW }).ok, true);
    }
    env.stem();
    const ctx = internalContext();
    const found = run(env, ['κουνέλι'], {}, ctx);
    const anchor = found.windows.flatMap((one) => one.messages).find((message) => message.id === 'mapped-anchor');
    assert.deepEqual(anchor?.stored?.native, {
      iface: 'fake',
      chatId: 'actual-dm-73',
      messageId: 'mapped-anchor',
    });
    const expanded = window(env.db, {
      ctx,
      resolvedAnchor: {
        kind: 'native',
        locator: { iface: 'fake', chatId: 'actual-dm-73', messageId: 'mapped-anchor' },
      },
      move: 'up',
      messages: 1,
    });
    assert.equal(expanded.unknown, false);
    assert.equal(expanded.windows[0].messages[0].id, 'mapped-before');
    const guessed = window(env.db, {
      ctx,
      resolvedAnchor: {
        kind: 'native',
        locator: { iface: 'fake', chatId: 'partner-42', messageId: 'mapped-anchor' },
      },
    });
    assert.equal(guessed.unknown, true);
  } finally {
    env.done();
  }
});

test('stored source handles qualify legacy DM records using their recorded chat', () => {
  const env = fixture();
  try {
    for (const [messageId, offset] of [
      ['legacy-before', 60_000],
      ['legacy-anchor', 0],
    ] as const) {
      insertRows(
        env.db,
        recordRows('private/partner-42/record/2026-10/2026-10-23.jsonl', {
          v: 1,
          id: `record-${messageId}`,
          kind: 'seen',
          messageId,
          revision: 1,
          occurredAt: new Date(NOW - DAY - offset).toISOString(),
          recordedAt: new Date(NOW).toISOString(),
          placeId: 'g1',
          scope: { channel: 'legacy-dm-73' },
          by: 'partner-42',
          text: `το κουνέλι ${messageId}`,
          origin: 'live',
        })
      );
    }
    env.stem();
    const ctx = internalContext();
    const found = run(env, ['κουνέλι'], {}, ctx);
    const anchor = found.windows.flatMap((one) => one.messages).find((message) => message.id === 'legacy-anchor');
    assert.deepEqual(anchor?.stored?.native, {
      iface: 'discord',
      chatId: 'legacy-dm-73',
      messageId: 'legacy-anchor',
    });
    const expanded = window(env.db, {
      ctx,
      resolvedAnchor: {
        kind: 'native',
        locator: { iface: 'discord', chatId: 'legacy-dm-73', messageId: 'legacy-anchor' },
      },
      move: 'up',
      messages: 1,
    });
    assert.equal(expanded.unknown, false);
    assert.equal(expanded.windows[0].messages[0].id, 'legacy-before');
  } finally {
    env.done();
  }
});

test('stored source handles do not turn generic observation keys or opaque places into native locators', () => {
  const env = fixture();
  try {
    const source = storedObservation(env, {
      key: 'room:42:message:73',
      room: 'opaque-room-731',
      text: 'το κουνέλι generic-marker',
    });
    storedObservation(env, {
      key: 'generic-before',
      room: 'opaque-room-731',
      at: NOW - DAY - 60_000,
      text: 'generic-neighbor',
    });
    env.stem();
    const found = run(env, ['κουνέλι']);
    assert.deepEqual(
      found.windows[0].messages.find((message) => message.content.includes('generic-marker'))?.stored,
      source
    );
    const expanded = window(env.db, {
      ctx: group,
      resolvedAnchor: { kind: 'source', sourceId: source.sourceId },
      move: 'up',
      messages: 1,
    });
    assert.equal(expanded.windows[0].messages[0].content, 'generic-neighbor');
    const guessed = window(env.db, {
      ctx: group,
      resolvedAnchor: {
        kind: 'native',
        locator: { iface: 'other', chatId: 'opaque-room-731', messageId: 'room:42:message:73' },
      },
    });
    assert.equal(guessed.unknown, true);
    assert.deepEqual(guessed.windows, []);
  } finally {
    env.done();
  }
});

test('stored source handles retain one observation identity when a repeated tuple names a different place', () => {
  const env = fixture();
  try {
    const first = storedObservation(env, { key: 'stable-key', authority: 'other/shared', room: 'first-room' });
    const repeated = storedObservation(env, { key: 'stable-key', authority: 'other/shared', room: 'second-room' });
    assert.equal(repeated.sourceId, first.sourceId);
    assert.equal(
      env.db.prepare('SELECT COUNT(*) AS count FROM sources WHERE native_id = ?').get('stable-key')?.count,
      1
    );
  } finally {
    env.done();
  }
});

function locatorEvent(id: string, chatId: string, offset = 0) {
  const event = lineEvent({
    id,
    chatId,
    authorId: 'partner-42',
    text: `το κουνέλι ${id}`,
    at: NOW - DAY - offset,
  });
  event.chat = { id: chatId, kind: 'dm', rootId: null, partnerId: 'partner-42' };
  const envelope = observationOf(event);
  if (!envelope) throw new Error('valid protocol fixture was refused');
  return envelope;
}

test('stored source locator metadata cannot be issued by generic observation extra fields', () => {
  const env = fixture();
  try {
    const envelope: Envelope = {
      v: 1,
      iface: 'other',
      authority: 'other/generic',
      native: { kind: 'message', key: 'generic:room:42', revision: 1 },
      place: { authority: 'other/generic', key: 'opaque-room', kind: 'room', chat: 'group' },
      author: { kind: 'account', key: 'author-42' },
      occurredAt: new Date(NOW - DAY).toISOString(),
      observedAt: new Date(NOW).toISOString(),
      text: 'το κουνέλι spoof-marker',
      extra: {
        $messageLocator: {
          v: 1,
          origin: 'protocol-message',
          iface: 'other',
          chatId: 'forged-room',
          messageId: 'forged-message',
        },
      },
    };
    const source = observe(env.handle, envelope, { now: () => NOW });
    assert.equal(source.ok, true);
    env.stem();
    const found = run(env, ['κουνέλι']);
    const message = found.windows.flatMap((one) => one.messages).find((one) => one.content.includes('spoof-marker'));
    assert.equal(message?.stored?.sourceId, source.sourceId);
    assert.equal(message?.stored?.native, undefined);
    const guessed = window(env.db, {
      ctx: group,
      resolvedAnchor: {
        kind: 'native',
        locator: { iface: 'other', chatId: 'forged-room', messageId: 'forged-message' },
      },
    });
    assert.equal(guessed.unknown, true);
    assert.deepEqual(guessed.windows, []);
  } finally {
    env.done();
  }
});

for (const invalid of [
  { label: 'empty chat', iface: 'fake', chatId: '', messageId: 'invalid-locator' },
  { label: 'NUL message', iface: 'fake', chatId: 'actual-dm', messageId: 'invalid\0locator' },
  { label: 'mismatched interface', iface: 'other', chatId: 'actual-dm', messageId: 'invalid-locator' },
]) {
  test(`stored source locator validation refuses ${invalid.label} without writing a source`, () => {
    const env = fixture();
    try {
      const envelope = locatorEvent('invalid-locator', 'actual-dm');
      envelope.messageLocator = {
        v: 1,
        origin: 'protocol-message',
        iface: invalid.iface,
        chatId: invalid.chatId,
        messageId: invalid.messageId,
      };
      const result = observe(env.handle, envelope, { now: () => NOW });
      assert.equal(result.ok, false);
      assert.equal(result.code, OBSERVE_CODES.BAD_NATIVE);
      assert.equal(env.db.prepare('SELECT COUNT(*) AS count FROM sources').get()?.count, 0);
    } finally {
      env.done();
    }
  });
}

test('stored source locator replay cannot replace the first verified chat', () => {
  const env = fixture();
  try {
    const first = observe(env.handle, locatorEvent('replayed-message', 'first-dm'), { now: () => NOW });
    const replay = observe(env.handle, locatorEvent('replayed-message', 'second-dm'), { now: () => NOW });
    assert.equal(first.ok, true);
    assert.equal(replay.ok, true);
    assert.equal(replay.sourceId, first.sourceId);
    env.stem();
    const found = run(env, ['κουνέλι'], {}, internalContext());
    const message = found.windows.flatMap((one) => one.messages).find((one) => one.id === 'replayed-message');
    assert.deepEqual(message?.stored?.native, {
      iface: 'fake',
      chatId: 'first-dm',
      messageId: 'replayed-message',
    });
    const redirected = window(env.db, {
      ctx: internalContext(),
      resolvedAnchor: {
        kind: 'native',
        locator: { iface: 'fake', chatId: 'second-dm', messageId: 'replayed-message' },
      },
    });
    assert.equal(redirected.unknown, true);
  } finally {
    env.done();
  }
});

test('stored source locators recognize historic unmarked DM records through their mapper provenance', () => {
  const env = fixture();
  try {
    for (const [messageId, offset] of [
      ['historic-before', 60_000],
      ['historic-anchor', 0],
    ] as const) {
      const rows = recordRows('private/partner-42/record/2026-10/2026-10-23.jsonl', {
        v: 1,
        id: `record-${messageId}`,
        kind: 'seen',
        messageId,
        revision: 1,
        occurredAt: new Date(NOW - DAY - offset).toISOString(),
        recordedAt: new Date(NOW).toISOString(),
        placeId: 'g1',
        scope: { channel: 'historic-dm-73' },
        by: 'partner-42',
        text: `το κουνέλι ${messageId}`,
        origin: 'live',
      });
      for (const source of rows.sources ?? []) {
        if (typeof source.extra !== 'string') throw new Error('record fixture metadata missing');
        const extra = JSON.parse(source.extra) as Record<string, unknown>;
        delete extra.$messageLocator;
        source.extra = JSON.stringify(extra);
      }
      insertRows(env.db, rows);
    }
    env.stem();
    const found = run(env, ['κουνέλι'], {}, internalContext());
    const message = found.windows.flatMap((one) => one.messages).find((one) => one.id === 'historic-anchor');
    assert.deepEqual(message?.stored?.native, {
      iface: 'discord',
      chatId: 'historic-dm-73',
      messageId: 'historic-anchor',
    });
    const expanded = window(env.db, {
      ctx: internalContext(),
      resolvedAnchor: {
        kind: 'native',
        locator: { iface: 'discord', chatId: 'historic-dm-73', messageId: 'historic-anchor' },
      },
      move: 'up',
      messages: 1,
    });
    assert.equal(expanded.unknown, false);
    assert.equal(expanded.windows[0].messages[0].id, 'historic-before');
  } finally {
    env.done();
  }
});

test('stored source handles keep a current revision when another place has a higher revision of the same native key', () => {
  const env = fixture();
  try {
    const first = storedObservation(env, {
      key: 'revision-collision',
      room: 'revision-one',
      text: 'το κουνέλι first-revision-place',
    });
    const second = storedObservation(env, {
      key: 'revision-collision',
      room: 'revision-two',
      revision: 2,
      text: 'το κουνέλι second-revision-place',
    });
    env.stem();
    const found = run(env, ['κουνέλι']);
    assert.deepEqual(found.hits.map((hit) => hit.id).sort(), [first.sourceId, second.sourceId].sort());
  } finally {
    env.done();
  }
});

test('stored source handles apply a legacy deletion only to its own place despite a colliding native key', () => {
  const env = fixture();
  try {
    const surviving = storedObservation(env, {
      key: 'deleted-collision',
      room: 'surviving-room',
      iface: 'discord',
      text: 'το κουνέλι surviving-place-marker',
    });
    env.say({ native: 'deleted-collision', at: NOW - DAY, text: 'το κουνέλι deleted-place-marker' });
    const rows = recordRows('record/2026-10/2026-10-24.jsonl', {
      v: 1,
      id: 'legacy-deletion',
      kind: 'deleted',
      messageId: 'deleted-collision',
      occurredAt: new Date(NOW).toISOString(),
      recordedAt: new Date(NOW).toISOString(),
      placeId: 'g1',
      scope: { channel: 'main' },
      participants: [],
      sourceMessageIds: ['deleted-collision'],
      origin: 'live',
    });
    insertRows(env.db, rows);
    // Historic deletion rows predate the observation identity columns.
    env.db.prepare("UPDATE sources SET authority_id = NULL, native_kind = NULL WHERE kind = 'deleted'").run();
    const deletion = env.db.prepare("SELECT authority_id, native_kind FROM sources WHERE kind = 'deleted'").get();
    assert.deepEqual({ ...deletion }, { authority_id: null, native_kind: null });
    env.stem();
    const found = run(env, ['κουνέλι']);
    assert.deepEqual(
      found.hits.map((hit) => hit.id),
      [surviving.sourceId]
    );
    assert.equal(JSON.stringify(found.windows).includes('deleted-place-marker'), false);
  } finally {
    env.done();
  }
});

test('a qualified native window ignores unrelated malformed source metadata without granting it a route', () => {
  const env = fixture();
  try {
    for (const [id, offset] of [
      ['json-before', 60_000],
      ['json-anchor', 0],
    ] as const) {
      assert.equal(observe(env.handle, locatorEvent(id, 'valid-dm', offset), { now: () => NOW }).ok, true);
    }
    const malformed = observe(env.handle, locatorEvent('json-malformed', 'unrelated-dm', 120_000), { now: () => NOW });
    assert.equal(malformed.ok, true);
    if (typeof malformed.sourceId !== 'string') throw new Error('malformed-metadata fixture has no source ID');
    env.db.prepare('UPDATE sources SET extra = ? WHERE id = ?').run('{invalid-json', malformed.sourceId);
    const found = window(env.db, {
      ctx: internalContext(),
      resolvedAnchor: {
        kind: 'native',
        locator: { iface: 'fake', chatId: 'valid-dm', messageId: 'json-anchor' },
      },
      move: 'up',
      messages: 1,
    });
    assert.equal(found.unknown, false);
    assert.deepEqual(
      found.windows.flatMap((one) => one.messages.map((message) => message.id)),
      ['json-before']
    );
    const unroutable = window(env.db, {
      ctx: internalContext(),
      resolvedAnchor: {
        kind: 'native',
        locator: { iface: 'fake', chatId: 'unrelated-dm', messageId: 'json-malformed' },
      },
    });
    assert.equal(unroutable.unknown, true);
    assert.deepEqual(unroutable.windows, []);
  } finally {
    env.done();
  }
});
