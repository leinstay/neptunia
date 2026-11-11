// Tests for the destination of an intention at the call (src/tools/operations/intention.ts): a place that is a mirror of
// her selfreflection is no place a due turn can post in, so `intention.set` and `intention.update` refuse it with the code
// `selfreflection-mirror` and store nothing, while any other place she may write in is stored as the destination. The
// operations run through `runOp` over a real memory database holding a mirror (tests/fixtures/selfreflection-mirror.ts),
// a real intention store and service, and the fake interface of the test's world for the chats. Synthetic data only.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { runOp } from '../src/tools/operations/index.ts';
import { createOpsEnv } from '../src/tools/operations/env.ts';
import { createIntentionStores } from '../src/intentions/store.ts';
import { createIntentionService } from '../src/intentions/service.ts';
import { createDiscordInterface } from '../interfaces/discord/index.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { useIface, world } from './fixtures/turn-world.ts';
import { tempDir } from './fixtures/tmp.ts';
import { openTestMemorySync } from './fixtures/memory-db/service.ts';
import { seedMirror } from './fixtures/selfreflection-mirror.ts';
import { OWNER_PERSON } from './fixtures/owner-accounts.ts';
import { wrongly } from './fixtures/loose-types.ts';

useIface('fake');
const OWNER = '42';
const T0 = Date.parse('2026-11-11T10:00:00Z');
/** The chat of her diary's mirror, the chat she is in, and another chat she may write in. */
const MIRROR_CHAT = 'diary';
const HERE = 'c1';
const ELSEWHERE = 'c2';

const opened: Array<ReturnType<typeof openTestMemorySync>> = [];
after(async () => {
  for (const { close } of opened) await close();
});

/** The operations' environment over a memory database whose one enabled mirror is the chat `diary` of the fake interface. */
function makeEnv() {
  const rootDir = tempDir('nep-intention-mirror-');
  const memory = openTestMemorySync({ dataDir: path.join(rootDir, 'data') });
  opened.push(memory);
  const { memoryDb } = memory;
  seedMirror(memoryDb, { iface: 'fake', chatId: MIRROR_CHAT, at: T0 });
  for (const id of [HERE, ELSEWHERE, MIRROR_CHAT]) world().channel({ id });
  const hot = {
    config: {
      bot: { ownerPerson: OWNER_PERSON, access: {}, timezone: 'UTC' },
      features: { intentions: true },
      intentions: { expiresDays: 14, maxOpen: 20 },
    },
    prompts: { labels: {} },
    rootDir,
    reloadConfig: () => true,
  };
  const now = () => T0;
  const intentions = createIntentionService({
    stores: createIntentionStores({ memoryDb, now }),
    hot,
    errands: wrongly(null),
    now,
  });
  const env = createOpsEnv({
    discord: createDiscordInterface().capabilities,
    hot,
    store: { state: { data: {}, markDirty() {} } },
    client: { channels: { cache: new Map() } },
    spontaneous: {},
    calibrator: { ratio: 1 },
    isServedRoot: (id: unknown) => id === 'g1',
    reads: world().reads,
    port: world().port,
    memoryDb,
    intentions,
    now,
  });
  return { env, intentions };
}

/** Her own call in a reply turn in the chat `c1`. */
const hers = (env: unknown) => ({
  env,
  placeId: HERE,
  accountId: OWNER,
  roleIds: [],
  actor: 'persona',
  turnId: 'T1',
  sourceMessageId: 'm1',
});

/** The destinations of every intention the service holds, closed ones included. */
const destinations = (intentions: ReturnType<typeof makeEnv>['intentions']) =>
  intentions.list({ closed: true, all: true }).map((record) => record.destination ?? null);

test('intention.set refuses the place of her diary mirror with selfreflection-mirror and stores nothing', async () => {
  const { env, intentions } = makeEnv();
  await withCapturedLogs(async () => {
    const result = await runOp(
      'intention.set',
      { text: 'post the sketch there', due: '1h', placeId: MIRROR_CHAT },
      wrongly(hers(env))
    );
    assert.equal(result.code, 'selfreflection-mirror', result.summary);
    assert.notEqual(result.status, 'ok');
    assert.deepEqual(destinations(intentions), [], 'no intention was stored');
  });
});

test('intention.set stores an intention aimed at another place she may write in', async () => {
  const { env, intentions } = makeEnv();
  await withCapturedLogs(async () => {
    const result = await runOp(
      'intention.set',
      { text: 'post the sketch there', due: '1h', placeId: ELSEWHERE },
      wrongly(hers(env))
    );
    assert.equal(result.status, 'ok', result.summary);
    assert.deepEqual(destinations(intentions), [ELSEWHERE]);
  });
});

test('intention.update refuses moving an intention to the place of her diary mirror and keeps its destination', async () => {
  const { env, intentions } = makeEnv();
  await withCapturedLogs(async () => {
    const set = await runOp(
      'intention.set',
      { text: 'post the sketch there', due: '1h', placeId: ELSEWHERE },
      wrongly(hers(env))
    );
    assert.equal(set.status, 'ok', set.summary);
    const id = (set.data as { intention: { id: string } }).intention.id;
    const result = await runOp('intention.update', { id, placeId: MIRROR_CHAT }, wrongly(hers(env)));
    assert.equal(result.code, 'selfreflection-mirror', result.summary);
    assert.notEqual(result.status, 'ok');
    assert.deepEqual(destinations(intentions), [ELSEWHERE], 'the destination is the one set before');
  });
});

test('intention.update moves an intention to another place she may write in', async () => {
  const { env, intentions } = makeEnv();
  await withCapturedLogs(async () => {
    const set = await runOp('intention.set', { text: 'post the sketch', due: '1h' }, wrongly(hers(env)));
    assert.equal(set.status, 'ok', set.summary);
    const id = (set.data as { intention: { id: string } }).intention.id;
    const result = await runOp('intention.update', { id, placeId: ELSEWHERE }, wrongly(hers(env)));
    assert.equal(result.status, 'ok', result.summary);
    assert.deepEqual(destinations(intentions), [ELSEWHERE]);
  });
});
