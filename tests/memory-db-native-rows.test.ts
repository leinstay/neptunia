// Tests for src/memory/db/native-rows.ts: a member's account and a channel's place found by their native key under the
// interface's own authority, and the native id read back from the row. Nothing is cut out of an id. Synthetic ids only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, split } from '../src/memory/db/row-columns.ts';
import {
  accountOfMember,
  channelColumn,
  channelOfPlace,
  memberOfAccount,
  mintedAccount,
  mintedChannel,
  placeOfChannel,
} from '../src/memory/db/native-rows.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { addAccount, addAuthority, addChannelPlace, addDmPlace } from './fixtures/memory-db/opaque-people.ts';

function withDb(body: (db: Db) => void): void {
  const handle = openMemoryDb(':memory:');
  try {
    body(dbOf(handle));
  } finally {
    handle.close();
  }
}

test('a channel is the newest place of its native key under its interface, and reads back from that row', () => {
  withDb((db) => {
    addChannelPlace(db, { id: 'place:old', iface: 'chat', authority: 'chat/global', native: 'c1' });
    db.prepare("UPDATE places SET generation = 1 WHERE id = 'place:old'").run();
    db.prepare(
      `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, chat, scope_kind)
       VALUES ('place:new', 'chat', 'channel', 'c1', 'channel:c1', 'chat/global', 2, 'group', 'group')`
    ).run();
    assert.equal(placeOfChannel(db, 'chat', 'c1'), 'place:new');
    assert.equal(channelOfPlace(db, 'place:new'), 'c1');
  });
});

test('a channel of another authority, an unknown channel and a direct chat give nothing', () => {
  withDb((db) => {
    addChannelPlace(db, { id: 'place:other', iface: 'chat', authority: 'chat/shared', native: 'c1' });
    addAccount(db, { id: 'account:p1', iface: 'chat', authority: 'chat/global', native: 'p1', person: 'person:p1' });
    addDmPlace(db, { id: 'place:dm-p1', iface: 'chat', authority: 'chat/global', account: 'account:p1', person: null });
    assert.equal(placeOfChannel(db, 'chat', 'c1'), null);
    assert.equal(placeOfChannel(db, 'chat', 'c9'), null);
    assert.equal(channelOfPlace(db, 'place:dm-p1'), null, 'a direct chat is no channel');
    assert.equal(channelOfPlace(db, 'place:none'), null);
  });
});

test("a member's account is found by its native key and reads its native id back", () => {
  withDb((db) => {
    addAccount(db, { id: 'account:7f', iface: 'chat', authority: 'chat/global', native: 'm1', person: 'person:7f' });
    assert.equal(accountOfMember(db, 'chat', 'm1'), 'account:7f');
    assert.equal(memberOfAccount(db, 'account:7f'), 'm1');
    assert.equal(accountOfMember(db, 'chat', 'm2'), null);
    assert.equal(memberOfAccount(db, 'account:none'), null);
  });
});

test('a member or a channel no row holds takes the id the observation mints for it', () => {
  assert.equal(mintedAccount('chat', 'm1'), 'chat:m1');
  assert.equal(mintedChannel('chat', 'c1'), 'chat:channel:c1');
});

test("a value's channel no row holds is kept beside its column, and a stored one is not", () => {
  withDb((db) => {
    addAuthority(db, 'chat', 'chat/global');
    addChannelPlace(db, { id: 'place:9b', iface: 'chat', authority: 'chat/global', native: 'c1' });
    const spec = [channelColumn(db, 'place_id')];
    const stored = split({ placeId: 'c1' }, spec, 'chat');
    assert.deepEqual([stored.cols.place_id, stored.rest], ['place:9b', {}]);
    assert.deepEqual(join(stored.cols, stored.rest, spec), { placeId: 'c1' });
    const unstored = split({ placeId: 'c2' }, spec, 'chat');
    assert.equal(unstored.cols.place_id, 'chat:channel:c2');
    assert.deepEqual(join(unstored.cols, unstored.rest, spec), { placeId: 'c2' });
  });
});
