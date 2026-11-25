// The reader worker (src/memory/db/reader-worker.ts): it opens on a read-only connection while another connection holds
// the writer lock, and refuses every write message. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { channelPlaceId, dmPlaceId } from '../../../../src/memory/db/ids.ts';
import { personId } from '../../../fixtures/memory-db/spelled-ids.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { dmScope } from '../../../../src/memory/db/scope.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import { fixture } from '../../../fixtures/memory-db-recall.ts';
import { fillEnvAudiences } from '../../../fixtures/memory-db/audiences.ts';
import { insertRows } from '../../../../src/memory/db/rows.ts';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const MINUTE = 60_000;
const MAIN = channelPlaceId('discord', 'main');
const OTHER = channelPlaceId('discord', 'other');
const ALICE = 'u-alice';
const BOB = 'u-bob';
const ALICE_PERSON = personId('discord', ALICE);
const BOB_PERSON = personId('discord', BOB);
const VECTOR = [1, 0, 0, 0];
const REAL_READER = pathToFileURL(path.resolve('src/memory/db/reader-worker.ts')).href;

const tmpRoot = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-off-main-'));

/** A file database with group lines in two channels, one DM line each for two people, an account and vectors. */
function writeFixtureDb(file: string): void {
  const env = fixture();
  try {
    insertRows(env.db, {
      places: [
        { id: MAIN, iface: 'discord', kind: 'channel', native_id: 'main', scope_kind: 'group', name: 'main' },
        { id: OTHER, iface: 'discord', kind: 'channel', native_id: 'other', scope_kind: 'group', name: 'other' },
        {
          id: dmPlaceId('discord', ALICE),
          iface: 'discord',
          kind: 'dm',
          native_id: null,
          scope_kind: 'dm',
          partner_person: ALICE_PERSON,
        },
        {
          id: dmPlaceId('discord', BOB),
          iface: 'discord',
          kind: 'dm',
          native_id: null,
          scope_kind: 'dm',
          partner_person: BOB_PERSON,
        },
      ],
    });
    env.account(ALICE, ['Alice']);
    env.account(BOB, ['Bob']);
    env.say({ native: 'main-1', at: NOW - 5 * MINUTE, text: 'the rabbit left the garden' });
    env.say({ native: 'main-2', at: NOW - 4 * MINUTE, text: 'a rabbit came back at dusk', author: BOB });
    env.say({ native: 'main-3', at: NOW - 3 * MINUTE, text: 'nothing about animals in this line' });
    env.say({ native: 'other-1', at: NOW - 2 * MINUTE, text: 'the rabbit in the other channel', place: OTHER });
    env.say({
      native: 'dm-alice',
      at: NOW - MINUTE,
      text: 'the secret rabbit of alice',
      place: dmPlaceId('discord', ALICE),
      scope: dmScope(ALICE_PERSON, 'discord'),
    });
    env.say({
      native: 'dm-bob',
      at: NOW - MINUTE,
      text: 'the secret rabbit of bob',
      author: BOB,
      place: dmPlaceId('discord', BOB),
      scope: dmScope(BOB_PERSON, 'discord'),
    });
    env.vector('main-3', VECTOR);
    env.vector('main-1', [0.9, 0.1, 0, 0]);
    env.vector('dm-alice', VECTOR, { scope: dmScope(ALICE_PERSON, 'discord') });
    env.stem();
    fillEnvAudiences(env);
    env.db.prepare('VACUUM INTO ?').run(file);
  } finally {
    env.done();
  }
}

/** A reader worker driven by hand: `ask` posts one message and answers with the reply. */
function readerByHand() {
  const worker = new Worker(new URL(REAL_READER));
  let seq = 0;
  const ask = (type: string, payload: Record<string, unknown> = {}) =>
    new Promise<{ ok: boolean; code?: unknown }>((resolve, reject) => {
      seq += 1;
      const id = seq;
      const onMessage = (message: { id?: number; ok: boolean; code?: unknown }) => {
        if (message.id !== id) return;
        worker.off('message', onMessage);
        resolve(message);
      };
      worker.on('message', onMessage);
      worker.once('error', reject);
      worker.postMessage({ ...payload, id, type });
    });
  return { ask, stop: () => worker.terminate() };
}

test('the reader opens while another connection holds the writer lock and refuses every write message', async () => {
  const root = tmpRoot();
  const file = path.join(root, 'memory.db');
  writeFixtureDb(file);
  const writer = openMemoryDb(file);
  const reader = readerByHand();
  try {
    const count = () => dbOf(writer).prepare('SELECT COUNT(*) AS n FROM sources').get()?.n;
    const before = count();
    assert.equal((await reader.ask('open', { path: file })).ok, true);
    const update = { kind: 'unit', op: 'value', file: 'guilds/g1/users/x.json', value: { id: 'x', names: ['X'] } };
    for (const type of [
      'memoryWrite',
      'observe',
      'observeMessage',
      'deleteMessage',
      'diaryApply',
      'focus',
      'turnReads',
    ]) {
      assert.equal((await reader.ask(type, { update })).ok, false, type);
    }
    assert.equal(count(), before);
    assert.equal((await reader.ask('close')).ok, true);
  } finally {
    await reader.stop();
    writer.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
