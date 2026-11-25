import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Untyped } from '../../../../src/tools/types.ts';
import { makeAdmin, makeHot, makeRoot } from '../../../fixtures/admin-rig.ts';

// ---------------------------------------------------------------------------
// pause / resume
// ---------------------------------------------------------------------------

test('run: pause sets paused/pausedAt first, flushes, and drops caches', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);

  const result = await admin.run('bot.pause', {}, {});

  const storeData = store.state.data;
  assert.equal(storeData.paused, true);
  assert.ok(storeData.pausedAt);
  assert.ok(store.flushCalls >= 1);
  assert.equal(store.dropCachesCalls, 1);
  assert.match(result, /paused/i);
  assert.match(result, /resume/i);
});

test('run: pause is idempotent -- a second call just reports the state without dropping caches again', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);

  await admin.run('bot.pause', {}, {});
  const storeData = store.state.data;
  const pausedAt = storeData.pausedAt;
  const dropsAfterFirst = store.dropCachesCalls;

  const result = await admin.run('bot.pause', {}, {});

  const data2 = store.state.data;
  assert.equal(data2.pausedAt, pausedAt, 'pausedAt is not bumped by a repeat pause');
  assert.equal(store.dropCachesCalls, dropsAfterFirst, 'nothing is dropped again');
  assert.match(result, /already paused/i);
});

test('run: pause waits for a turn already in flight before dropping caches', async () => {
  const rootDir = makeRoot();
  let resolveIdle: () => void = () => {};
  const idlePromise = new Promise<void>((resolve) => {
    resolveIdle = resolve;
  });
  const turns = { waitIdle: () => idlePromise };
  const { admin, store } = makeAdmin(rootDir, { turns });

  const pausePromise = admin.run('bot.pause', {}, {});
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.dropCachesCalls, 0, 'must not drop caches before the in-flight turn finished');

  resolveIdle();
  await pausePromise;
  assert.equal(store.dropCachesCalls, 1);
});

test('run: resume refuses when data/ has an invalid file, naming the path, and leaves paused untouched', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  await admin.run('bot.pause', {}, {});
  store.validateResult = ['guilds/g1/users/u1.json'];

  const result = await admin.run('bot.resume', {}, {});

  assert.match(result, /invalid json/i);
  assert.ok(result.includes('guilds/g1/users/u1.json'));
  const storeData = store.state.data;
  assert.equal(storeData.paused, true, 'stays paused');
});

test('run: resume clears the flags and reports plain confirmation', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  await admin.run('bot.pause', {}, {});

  const result = await admin.run('bot.resume', {}, {});

  const storeData = store.state.data;
  assert.equal(storeData.paused, undefined);
  assert.equal(storeData.pausedAt, undefined);
  assert.equal(store.reloadStateCalls, 1);
  assert.equal(result, 'Resumed.');
});

test('run: resume starts a catch-up pass of the meaning index for the guild; pause and a refused resume do not', async () => {
  const rootDir = makeRoot();
  const passes: Array<Untyped> = [];
  const embedQueue = {
    catchUp: async (placeId: string) => {
      passes.push(placeId);
      return null;
    },
  };
  const { admin, store } = makeAdmin(rootDir, { embedQueue });
  await admin.run('bot.pause', {}, { placeId: 'g1' });
  store.validateResult = ['guilds/g1/users/u1.json'];
  await admin.run('bot.resume', {}, { placeId: 'g1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(passes, [], 'still paused: no pass');
  store.validateResult = [];
  assert.equal(await admin.run('bot.resume', {}, { placeId: 'g1' }), 'Resumed.');
  await new Promise((resolve) => setImmediate(resolve));
  // The pass names no place: every place that holds a record.
  assert.deepEqual(passes, [undefined]);
});

// ---------------------------------------------------------------------------
// the journal: system records, /nep journal
// ---------------------------------------------------------------------------

/** A journal fake: records every write and call; `read` serves `days[day]` filtered like the real one. */
function fakeJournal(days: Record<string, Array<Untyped>> = {}) {
  const calls: Array<Untyped> = [];
  return {
    calls,
    system: async (record: Untyped) => {
      calls.push(['system', record]);
    },
    read: async (placeId: string, { day, kind = null, n = 50 }: { day: string; kind?: string | null; n?: number }) => {
      calls.push(['read', placeId, { day, kind, n }]);
      return (days[day] ?? []).filter((record: Untyped) => !kind || record.kind === kind).slice(-n);
    },
    forgetUser: async (placeId: string, accountId: string) => {
      calls.push(['forgetUser', placeId, accountId]);
      return { files: 2, dropped: 5 };
    },
    removeGuild: async (placeId: string) => {
      calls.push(['removeGuild', placeId]);
      return { files: 3 };
    },
  };
}

/** A client whose channels collect what is sent to them (nothing should be). */
function sendingClient() {
  const sent: Array<Untyped> = [];
  return {
    sent,
    channels: {
      fetch: async (id: string) => ({
        id,
        send: async (message: Untyped) => {
          sent.push([id, message]);
        },
      }),
    },
  };
}

test('admin: pause and resume write system records and post nothing to the chat', async () => {
  const rootDir = makeRoot();
  const journal = fakeJournal();
  const client = sendingClient();
  const hot = makeHot(rootDir);
  hot.config.journal = {};
  const { admin } = makeAdmin(rootDir, { hot, client, journal });

  const paused = await admin.run('bot.pause', {}, { placeId: 'g1' });
  assert.match(paused, /^Paused./);
  assert.equal(client.sent.length, 0);
  const pauseRecord = journal.calls.find(([name]) => name === 'system');
  // A system record is the persona's: no place in its call.
  assert.deepEqual(pauseRecord, ['system', { event: 'pause', by: 'owner' }]);

  const resumed = await admin.run('bot.resume', {}, { placeId: 'g1' });
  assert.equal(resumed, 'Resumed.');
  assert.equal(client.sent.length, 0);
  const records = journal.calls.filter(([name]) => name === 'system').map(([, record]) => record);
  assert.deepEqual(records, [
    { event: 'pause', by: 'owner' },
    { event: 'resume', by: 'owner' },
  ]);

  // A repeat pause or resume that changes nothing records nothing.
  await admin.run('bot.resume', {}, { placeId: 'g1' });
  assert.equal(journal.calls.filter(([name]) => name === 'system').length, 2);
});
