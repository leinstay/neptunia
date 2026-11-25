// The mirror desk (src/behavior/mirror-desk.ts): an entry whose audience could not be read stays in memory, is published
// nowhere, and the failure is shown. Real turn, store and memory, a scripted model and fake transports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../../src/memory/store.ts';
import { ROOT, sceneRunner } from '../../fixtures/diary-requests-recorded.ts';
import { diaryRows, entryOf, seedMirror } from '../../fixtures/diary-mirror.ts';
import { T0, mirrorScene } from '../../fixtures/mirror-scene.ts';
import type { Scene } from '../../fixtures/mirror-scene.ts';
import { freshWorld, world } from '../../fixtures/turn-world.ts';
import { directorAnswer } from '../../fixtures/scene-answer.ts';

const TEXT = 'ήσυχο βράδυ στο λιμάνι';

const D1 = 'fake:channel:d1';

const OTHER_D1 = 'other:channel:d1';

const BAD = `<audience>place:fake:channel:nowhere</audience><msg>${TEXT}</msg>`;

/** Two interfaces with one mirror each, and one store over their memory. */
async function setting() {
  const scene = await mirrorScene({ ifaces: ['fake', 'other'] });
  seedMirror(scene.memory.memoryDb, { iface: 'fake', chatId: 'd1', at: T0 });
  seedMirror(scene.memory.memoryDb, { iface: 'other', chatId: 'd1', at: T0 });
  return { scene, store: createStore({ dataDir: scene.memory.dataDir, memoryDb: scene.memory.memoryDb }) };
}

type Setting = { scene: Scene; store: ReturnType<typeof createStore> };

/** One diary turn in which the persona's writer answers `answer`, or fails when it is null: the result and the writer's request. */
async function turn({ store }: Setting, answer: string | null, extra: Record<string, unknown> = {}) {
  freshWorld();
  world().channel({ id: 'd1', name: 'journal', placeId: ROOT });
  const calls: Array<unknown> = [];
  const model = {
    calls,
    complete: (messages: unknown, options?: { purpose?: string }) => {
      calls.push(structuredClone(messages));
      const scene = directorAnswer(messages, options);
      if (scene) return Promise.resolve(scene);
      if (answer === null) return Promise.reject(Object.assign(new Error('provider down'), { statusCode: 500 }));
      return Promise.resolve({ text: answer, usage: {}, estimated: 5 });
    },
  };
  const result = await sceneRunner(model, store).runTurn({
    mode: 'diary',
    diary: { kind: 'thought', forced: true },
    placeId: ROOT,
    ...extra,
  });
  await store.flushSettled({});
  return { result, writer: calls.at(-1) };
}

test('a refused audience stands as a blocked entry under each mirror, kept in memory and sent nowhere', async () => {
  // Catches: a refusal that leaves no row, so `/mirror status` shows nothing wrong while an entry never goes out.
  const setup = await setting();
  const { result } = await turn(setup, BAD);
  const entry = entryOf(result);
  const mirrors = setup.scene.publisher();
  await mirrors.publishEntry(entry);
  await mirrors.drainQueued();
  const blocked = { entryId: entry.id, code: 'audience-invalid', reason: 'audience-unknown-place' };
  assert.deepEqual(
    mirrors.mirrorStatus().map((mirror) => [mirror.placeId, mirror.audienceBlocked]),
    [
      [D1, [blocked]],
      [OTHER_D1, [blocked]],
    ]
  );
  assert.deepEqual(setup.scene.transport('fake').attempts, []);
  assert.deepEqual(setup.scene.transport('other').attempts, []);
  const memory = setup.scene.memory;
  assert.equal(diaryRows(memory.memoryDb)[0]?.text, TEXT);
});

const ONE = { id: 'e1', messages: ['one'] };

/** Ten mirrors: nine channels of the fake interface and one of an interface that is not connected. */
async function tenMirrors() {
  const scene = await mirrorScene({ ifaces: ['fake', 'gone'] });
  const places = new Map<string, string>();
  for (let i = 0; i < 9; i += 1)
    places.set(`d${i}`, seedMirror(scene.memory.memoryDb, { iface: 'fake', chatId: `d${i}`, at: T0 + i }).placeId);
  places.set('d9', seedMirror(scene.memory.memoryDb, { iface: 'gone', chatId: 'd9', at: T0 + 9 }).placeId);
  scene.disconnect('gone');
  scene.entry({ id: 'e1' });
  const behave = (attempt: { chatId: string }) =>
    attempt.chatId === 'd3'
      ? ({ refuse: 'channel-no-permission' } as const)
      : attempt.chatId === 'd5'
        ? ('throw' as const)
        : ('deliver' as const);
  scene.transport().behave = behave;
  return { scene, places, mirrors: scene.publisher(), transport: scene.transport(), behave };
}

test('status shows each mirror its own trouble and a certain refusal is not retried by itself', async () => {
  // Catches: a failure hidden behind one aggregate line, or a forbidden channel hammered at every tick.
  const { places, mirrors, transport } = await tenMirrors();
  await mirrors.publishEntry(ONE);
  await mirrors.drainQueued();
  const status = (chat: string) => mirrors.mirrorStatus().find((mirror) => mirror.placeId === places.get(chat));
  assert.deepEqual(status('d3')?.failed, [{ entryId: 'e1', code: 'channel-no-permission', retryable: false }]);
  assert.deepEqual(status('d3')?.uncertain, []);
  assert.deepEqual(
    status('d5')?.uncertain.map((one) => one.entryId),
    ['e1']
  );
  assert.equal(status('d9')?.queued, 1);
  assert.equal(status('d9')?.interfaceConnected, false);
  assert.deepEqual(status('d0')?.failed, []);
  assert.equal(transport.attempts.filter((attempt) => attempt.chatId === 'd3').length, 1);
});
