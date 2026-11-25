// Tests for src/interface/place-chat.ts: the chat of a stored place, over a fake `dmChatOf` read and a fake writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chatOfStoredPlace } from '../../../src/interface/place-chat.ts';
import type { PlaceRef } from '../../../src/memory/db/frame-reads.ts';
import type { Reads } from '../../../src/interface/reads.ts';

/** A reads whose `dmChatOf` answers `answer`, recording the arguments of every call. */
function fakeReads(answer: unknown) {
  const calls: Array<unknown> = [];
  const reads = {
    answer: (name: string, partner: unknown) => {
      calls.push([name, partner]);
      return Promise.resolve(answer);
    },
  } as unknown as Pick<Reads, 'answer'>;
  return { reads, calls };
}

/** A writer that records every address it is asked to store. */
function fakeNote() {
  const notes: Array<[string, string]> = [];
  const note = (placeId: string, address: string) => {
    notes.push([placeId, address]);
    return Promise.resolve();
  };
  return { note, notes };
}

const dmWithoutAddress: PlaceRef = { iface: 'discord', kind: 'dm', nativeId: null, partnerNativeId: 'acct-7' };

test('chatOfStoredPlace: a place without a row is an unknown conversation', async () => {
  const { reads } = fakeReads({ status: 'ok', chatId: 'chat-1' });
  assert.deepEqual(await chatOfStoredPlace({ placeId: 'p1', ref: null, reads, note: null }), {
    ok: false,
    code: 'unknown-conversation',
  });
});

test('chatOfStoredPlace: a place that holds an address gives it back without a read', async () => {
  const { reads, calls } = fakeReads({ status: 'ok', chatId: 'other' });
  const ref: PlaceRef = { iface: 'discord', kind: 'dm', nativeId: 'chat-9', partnerNativeId: 'acct-7' };
  assert.deepEqual(await chatOfStoredPlace({ placeId: 'p1', ref, reads, note: null }), {
    ok: true,
    chat: { iface: 'discord', chatId: 'chat-9' },
  });
  assert.equal(calls.length, 0);
});

test('chatOfStoredPlace: a direct chat without an address is opened for its partner and the answer is stored', async () => {
  const { reads, calls } = fakeReads({ status: 'ok', chatId: 'chat-3' });
  const { note, notes } = fakeNote();
  assert.deepEqual(await chatOfStoredPlace({ placeId: 'p1', ref: dmWithoutAddress, reads, note }), {
    ok: true,
    chat: { iface: 'discord', chatId: 'chat-3' },
  });
  assert.deepEqual(calls, [['dmChatOf', { iface: 'discord', accountId: 'acct-7' }]]);
  assert.deepEqual(notes, [['p1', 'chat-3']]);
});

test('chatOfStoredPlace: a refused open gives the code of the interface and stores nothing', async () => {
  const { reads } = fakeReads({ status: 'forbidden', code: 'dm-closed' });
  const { note, notes } = fakeNote();
  assert.deepEqual(await chatOfStoredPlace({ placeId: 'p1', ref: dmWithoutAddress, reads, note }), {
    ok: false,
    code: 'dm-closed',
  });
  assert.equal(notes.length, 0);
});

test('chatOfStoredPlace: a writer that fails still leaves the opened chat to use', async () => {
  const { reads } = fakeReads({ status: 'ok', chatId: 'chat-3' });
  const note = () => Promise.reject(new Error('database is locked'));
  assert.deepEqual(await chatOfStoredPlace({ placeId: 'p1', ref: dmWithoutAddress, reads, note }), {
    ok: true,
    chat: { iface: 'discord', chatId: 'chat-3' },
  });
});

test('chatOfStoredPlace: a channel without an address is an unknown conversation and is not opened', async () => {
  const { reads, calls } = fakeReads({ status: 'ok', chatId: 'chat-3' });
  const ref: PlaceRef = { iface: 'discord', kind: 'channel', nativeId: null, partnerNativeId: 'acct-7' };
  assert.deepEqual(await chatOfStoredPlace({ placeId: 'p1', ref, reads, note: null }), {
    ok: false,
    code: 'unknown-conversation',
  });
  assert.equal(calls.length, 0);
});

test('chatOfStoredPlace: a direct chat whose partner is unknown is an unknown conversation', async () => {
  const { reads, calls } = fakeReads({ status: 'ok', chatId: 'chat-3' });
  const ref: PlaceRef = { iface: 'discord', kind: 'dm', nativeId: null, partnerNativeId: null };
  assert.deepEqual(await chatOfStoredPlace({ placeId: 'p1', ref, reads, note: null }), {
    ok: false,
    code: 'unknown-conversation',
  });
  assert.equal(calls.length, 0);
});
