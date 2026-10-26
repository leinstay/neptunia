// The errand task stores' reads from the database (stage W1): the list and the spend records load from the database,
// and a failed load is an error with a code that the next `get` tries again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTaskStores } from '../src/errands/store.js';
import { GUILD, GUILD_2, readerEnv } from './fixtures/memory-db/readers.js';

const NOW = 1792000600000;

function config(root) {
  const out = path.join(root, 'no-out');
  return () => ({ agents: new Proxy({}, { get: () => ({ out }) }) });
}

const ids = (tasks) => tasks.map((task) => task.id);

test('tasks db reader: the list and the spend records come from the database', async () => {
  const env = await readerEnv();
  try {
    const stores = createTaskStores({ log: env.log, memoryDb: env.memoryDb, config: config(env.root), now: () => NOW });
    for (const [guildId, id] of [
      [GUILD, 't1'],
      [GUILD_2, 't1.g2'],
    ]) {
      const store = stores.get(guildId);
      assert.deepEqual(
        {
          open: ids(store.open()),
          recent: ids(store.recent(100)),
          unseen: ids(store.unseen()),
          unread: ids(store.unread()),
          costs: store.costs(),
        },
        { open: [], recent: [id], unseen: [], unread: [], costs: {} },
        guildId
      );
      assert.equal(store.get('nope') ?? null, null);
    }
    assert.deepEqual(stores.get(GUILD).get('t1'), {
      id: 't1',
      state: 'done',
      createdAt: 1792000000000,
      requester: { userId: '100000000000000001' },
      scope: 'group',
      seen: true,
      readAt: 1792000000000,
      resolvedAt: null,
    });
    assert.deepEqual(
      env.warns.filter((warn) => warn.message === 'memory db: read failed'),
      []
    );
  } finally {
    env.done();
  }
});

test('tasks db reader: a closed database fails the load with a code, logged; the next get tries again', async () => {
  const env = await readerEnv();
  try {
    let open = false;
    const memoryDb = { readHandle: () => (open ? env.handle : null), database: () => (open ? env.handle.db : null) };
    const stores = createTaskStores({ log: env.log, memoryDb, config: config(env.root), now: () => NOW });
    assert.throws(
      () => stores.get(GUILD),
      (error) => error.code === 'DB_CLOSED'
    );
    assert.deepEqual(
      env.warns.map((warn) => [warn.message, warn.reader, warn.code]),
      [['memory db: read failed', 'tasks', 'DB_CLOSED']]
    );
    open = true;
    assert.equal(stores.get(GUILD).get('t1')?.id, 't1');
  } finally {
    env.done();
  }
});
