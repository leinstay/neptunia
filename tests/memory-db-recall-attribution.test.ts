// Recall attribution preserves exact account and place identities across interfaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search, window, quotesOf } from '../src/memory/db/recall.ts';
import type { RecallMessage } from '../src/memory/db/recall.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import { channelPlaceId, dmPlaceId } from '../src/memory/db/ids.ts';
import { personId } from './fixtures/memory-db/spelled-ids.ts';
import { dmContext, dmScope, groupContext, groupScope, internalContext } from '../src/memory/db/scope.ts';
import { fixture } from './fixtures/memory-db-recall.ts';
import { labels } from './fixtures/labels.ts';

const DAY = 86400000;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const BOB = 'u-bob';
const run = (env: ReturnType<typeof fixture>, forms: Array<string>, options: Record<string, unknown> = {}) =>
  search(env.db, {
    ctx: groupContext('discord'),
    plan: { forms, who: [], from: null, to: null },
    now: NOW,
    ...options,
  });

function attributionAccount(env: ReturnType<typeof fixture>, id: string, iface: string, native: string, name: string) {
  env.db
    .prepare('INSERT INTO accounts (id, iface, native_id, names) VALUES (?, ?, ?, ?)')
    .run(id, iface, native, JSON.stringify([name]));
}

test('search names a foreign author from its exact account despite a primary native-ID collision', () => {
  const env = fixture();
  try {
    attributionAccount(env, 'discord:42', 'discord', '42', 'Primary stored author');
    attributionAccount(env, 'other:42', 'other', '42', 'Foreign stored author');
    env.say({
      native: 'foreign-author',
      iface: 'other',
      author: '42',
      place: channelPlaceId('other', 'room'),
      scope: groupScope('other'),
      at: NOW - DAY,
      text: 'το κουνέλι',
    });
    env.stem();
    const found = run(env, ['κουνέλι'], { nameOf: () => 'Primary profile author' });
    assert.equal(found.windows.length, 1);
    assert.equal(found.windows[0].messages[0].authorName, 'Foreign stored author');
    assert.equal(found.windows[0].messages[0].authorId, '42');
    const quotes = quotesOf(found.windows, { render: { labels, timezone: 'UTC' }, stretchChars: 1500 });
    assert.ok(quotes[0].lines.includes('Foreign stored author'));
    assert.equal(quotes[0].lines.includes('Primary profile author'), false);
  } finally {
    env.done();
  }
});

test('search keeps the primary stored author when a foreign account with the same native ID is inserted last', () => {
  const env = fixture();
  try {
    attributionAccount(env, 'discord:42', 'discord', '42', 'Primary stored author');
    attributionAccount(env, 'other:42', 'other', '42', 'Foreign stored author');
    env.say({ native: 'primary-author', author: '42', at: NOW - DAY, text: 'το κουνέλι' });
    env.stem();
    const found = run(env, ['κουνέλι']);
    assert.equal(found.windows.length, 1);
    assert.equal(found.windows[0].messages[0].authorName, 'Primary stored author');
  } finally {
    env.done();
  }
});

test('search resolves an opaque account through its stored native ID and interface', () => {
  const env = fixture();
  try {
    attributionAccount(env, 'account:opaque-731', 'other', '42', 'Opaque stored author');
    const source = env.say({
      native: 'opaque-author',
      iface: 'other',
      author: '42',
      place: channelPlaceId('other', 'room'),
      scope: groupScope('other'),
      at: NOW - DAY,
      text: 'το κουνέλι',
    });
    env.db.prepare('UPDATE sources SET author_account = ? WHERE id = ?').run('account:opaque-731', source);
    env.stem();
    const found = run(env, ['κουνέλι'], { nameOf: () => 'Primary profile author' });
    assert.equal(found.windows.length, 1);
    assert.equal(found.windows[0].messages[0].authorName, 'Opaque stored author');
    assert.equal(found.windows[0].messages[0].authorId, '42');
  } finally {
    env.done();
  }
});

test('search keeps same-interface profile author precedence over the stored account name', () => {
  const env = fixture();
  try {
    attributionAccount(env, 'discord:42', 'discord', '42', 'Primary stored author');
    env.say({ native: 'profile-author', author: '42', at: NOW - DAY, text: 'το κουνέλι' });
    env.stem();
    const found = run(env, ['κουνέλι'], { nameOf: () => 'Primary profile author' });
    assert.equal(found.windows[0].messages[0].authorName, 'Primary profile author');
  } finally {
    env.done();
  }
});

for (const iface of ['other', 'discord']) {
  test(`search resolves the ${iface} group name without borrowing another interface's native-ID alias`, () => {
    const env = fixture();
    try {
      const place = channelPlaceId(iface, 'room');
      insertRows(env.db, {
        places: [
          { id: place, iface, kind: 'channel', native_id: 'room', scope_kind: 'group', name: 'Stored group name' },
        ],
      });
      env.say({ native: `place-${iface}`, iface, place, scope: groupScope(iface), at: NOW - DAY, text: 'το κουνέλι' });
      env.stem();
      const found = run(env, ['κουνέλι'], { channelNameOf: () => 'Primary snapshot group' });
      assert.equal(found.windows.length, 1);
      assert.equal(found.windows[0].channelName, iface === 'discord' ? 'Primary snapshot group' : 'Stored group name');
      const quotes = quotesOf(found.windows, { render: { labels, timezone: 'UTC' }, stretchChars: 1500 });
      assert.equal(quotes[0].channelName, iface === 'discord' ? 'Primary snapshot group' : 'Stored group name');
    } finally {
      env.done();
    }
  });
}

test('an ordinary DM read hides private place names before callbacks while internal reads retain the stored name', () => {
  const env = fixture();
  try {
    const place = dmPlaceId('discord', BOB);
    const scope = dmScope(personId('discord', BOB), 'discord');
    insertRows(env.db, {
      places: [
        {
          id: place,
          iface: 'discord',
          kind: 'dm',
          native_id: BOB,
          scope_kind: 'dm',
          partner_person: personId('discord', BOB),
          name: 'Private stored place',
        },
      ],
    });
    env.say({ native: 'private-before', place, scope, at: NOW - DAY, text: 'το κουνέλι private-before' });
    const anchor = env.say({ native: 'private-anchor', place, scope, at: NOW - DAY + 60_000, text: 'private-anchor' });
    const ordinary = window(env.db, {
      ctx: dmContext(personId('discord', BOB), 'discord', dmPlaceId('discord', BOB)),
      anchor,
      move: 'up',
      messages: 1,
      channelNameOf: () => 'Private callback place',
    });
    assert.equal(ordinary.unknown, false);
    assert.equal(ordinary.windows[0].messages[0].content, 'το κουνέλι private-before');
    assert.equal(ordinary.windows[0].channelName, null);
    const internal = window(env.db, { ctx: internalContext(), anchor, move: 'up', messages: 1 });
    assert.equal(internal.windows[0].channelName, 'Private stored place');
  } finally {
    env.done();
  }
});

test('a said source retains the supplied persona name instead of an account alias', () => {
  const env = fixture();
  try {
    attributionAccount(env, 'other:42', 'other', '42', 'Foreign stored author');
    env.say({
      native: 'self-author',
      kind: 'said',
      iface: 'other',
      author: '42',
      place: channelPlaceId('other', 'room'),
      scope: groupScope('other'),
      at: NOW - DAY,
      text: 'το κουνέλι',
    });
    env.stem();
    const found = run(env, ['κουνέλι'], { nameOf: () => 'Primary profile author', selfName: 'Synthetic persona' });
    assert.equal(found.windows[0].messages[0].authorName, 'Synthetic persona');
    assert.equal(found.windows[0].messages[0].self, true);
  } finally {
    env.done();
  }
});

test('a source retains its native author ID after its exact account retires without borrowing a foreign alias', () => {
  const env = fixture();
  try {
    attributionAccount(env, 'discord:42', 'discord', '42', 'Primary stored author');
    attributionAccount(env, 'other:42', 'other', '42', 'Foreign stored author');
    env.say({ native: 'retired-author', author: '42', at: NOW - DAY, text: 'το κουνέλι' });
    env.db.prepare('UPDATE accounts SET retired_at = ? WHERE id = ?').run(new Date(NOW).toISOString(), 'discord:42');
    env.stem();
    const found = run(env, ['κουνέλι']);
    assert.equal(found.windows.length, 1);
    assert.equal(found.windows[0].messages[0].authorId, '42');
    assert.notEqual(found.windows[0].messages[0].authorName, 'Foreign stored author');
  } finally {
    env.done();
  }
});

test('a retired account keeps its native identity without displaying its retired name', () => {
  const env = fixture();
  try {
    attributionAccount(env, 'discord:42', 'discord', '42', 'Retired stored author');
    env.say({ native: 'retired-only', author: '42', at: NOW - DAY, text: 'το κουνέλι retained evidence' });
    env.db.prepare('UPDATE accounts SET retired_at = ? WHERE id = ?').run(new Date(NOW).toISOString(), 'discord:42');
    env.stem();
    const message = run(env, ['κουνέλι']).windows[0].messages[0];
    assert.equal(message.authorId, '42');
    assert.notEqual(message.authorName, 'Retired stored author');
    assert.equal(message.content, 'το κουνέλι retained evidence');
  } finally {
    env.done();
  }
});

test('a source with no account retains its text and reports no author identity', () => {
  const env = fixture();
  try {
    env.say({ native: 'missing-account', author: 'missing', at: NOW - DAY, text: 'το κουνέλι unattributed evidence' });
    env.stem();
    const message = run(env, ['κουνέλι']).windows[0].messages[0];
    assert.equal(message.authorId, null);
    assert.equal(message.content, 'το κουνέλι unattributed evidence');
  } finally {
    env.done();
  }
});

for (const snapshot of [false, true]) {
  test(`a named group uses ${snapshot ? 'its native snapshot identity' : 'its stored name without a snapshot callback'}`, () => {
    const env = fixture();
    try {
      const place = channelPlaceId('discord', 'room');
      insertRows(env.db, {
        places: [
          {
            id: place,
            iface: 'discord',
            kind: 'channel',
            native_id: 'room',
            scope_kind: 'group',
            name: 'Stored group',
          },
        ],
      });
      env.say({ native: 'named-group', place, at: NOW - DAY, text: 'το κουνέλι named group evidence' });
      env.stem();
      const found = run(
        env,
        ['κουνέλι'],
        snapshot ? { channelNameOf: (id: unknown) => (id === 'room' ? 'Snapshot group' : null) } : {}
      );
      assert.equal(found.windows[0].channelName, snapshot ? 'Snapshot group' : 'Stored group');
      assert.equal(found.windows[0].messages[0].content, 'το κουνέλι named group evidence');
    } finally {
      env.done();
    }
  });
}

test('a normalized DM place hides its name independently of an allowed source audience', () => {
  const env = fixture();
  try {
    const place = dmPlaceId('discord', BOB);
    insertRows(env.db, {
      places: [
        {
          id: place,
          iface: 'discord',
          kind: 'dm',
          native_id: BOB,
          chat: 'dm',
          name: 'Private normalized place',
        },
      ],
    });
    env.say({ native: 'readable-private-place', place, at: NOW - DAY, text: 'το κουνέλι allowed evidence' });
    env.stem();
    const found = run(env, ['κουνέλι'], { channelNameOf: () => 'Private snapshot place' });
    assert.equal(found.windows[0].channelName, null);
    assert.equal(found.windows[0].messages[0].content, 'το κουνέλι allowed evidence');
  } finally {
    env.done();
  }
});

test("quotesOf names each line's author by the handle `handleOf` gives its stored account, never the name or the id", () => {
  // Bug: a memory.search result names its authors by the stored display name, and `(id:…)` in memory mode, so the lines
  // she found tie to no entry of <people>. The owner's decision of 2026-11-10: one handle per person, authors by handle.
  const env = fixture();
  try {
    attributionAccount(env, 'discord:42', 'discord', '42', 'Primary stored author');
    attributionAccount(env, 'other:42', 'other', '42', 'Foreign stored author');
    env.say({
      native: 'foreign-author',
      iface: 'other',
      author: '42',
      place: channelPlaceId('other', 'room'),
      scope: groupScope('other'),
      at: NOW - DAY,
      text: 'το κουνέλι',
    });
    env.stem();
    const found = run(env, ['κουνέλι']);
    const authors = { line: '{handle}', lineAccount: '{handle} ({iface} {id})', unknown: 'someone' };
    const quotes = quotesOf(found.windows, {
      render: { labels: { ...labels, authors }, timezone: 'UTC' },
      stretchChars: 1500,
      handleOf: (message: RecallMessage) =>
        message.stored?.iface === 'other' && message.authorId === '42' ? 'u0th1' : 'uprim',
    });
    const stretch = quotes[0]?.lines ?? '';
    const line = stretch.split('\n').find((one) => one.includes('κουνέλι')) ?? '';
    assert.ok(line.includes('@u0th1'), line);
    assert.equal(/Foreign stored author|Primary stored author|\b42\b/.test(line), false, line);
  } finally {
    env.done();
  }
});
