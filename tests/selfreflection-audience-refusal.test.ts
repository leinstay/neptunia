// An audience that could not be read keeps the entry in memory and publishes it nowhere, and nobody is left unaware: the
// owner sees it under each mirror for as long as it stands, and she hears of it once, in the next diary request she
// answers. Real turn, real store and memory, a scripted model and fake transports. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/memory/store.ts';
import { ROOT, sceneRunner } from './fixtures/selfreflection-requests-recorded.ts';
import { selfreflectionRows, entryOf, seedMirror } from './fixtures/selfreflection-mirror.ts';
import { labels } from './fixtures/labels.ts';
import { T0, mirrorScene } from './fixtures/mirror-scene.ts';
import type { Scene } from './fixtures/mirror-scene.ts';
import { freshWorld, world } from './fixtures/turn-world.ts';
import { planAnswerText } from './fixtures/plan-answer.ts';

const TEXT = 'ήσυχο βράδυ στο λιμάνι';
const D1 = 'fake:channel:d1';
const OTHER_D1 = 'other:channel:d1';
const BAD = `<audience>place:fake:channel:nowhere</audience><msg>${TEXT}</msg>`;
const BOUNDARY = { kind: 'internal-turn', origin: { iface: 'fake', chatId: 'd1' } } as const;

/** Two interfaces with one mirror each, and one store over their memory. */
async function setting() {
  const scene = await mirrorScene({ ifaces: ['fake', 'other'] });
  seedMirror(scene.memory.memoryDb, { iface: 'fake', chatId: 'd1', at: T0 });
  seedMirror(scene.memory.memoryDb, { iface: 'other', chatId: 'd1', at: T0 });
  return { scene, store: createStore({ dataDir: scene.memory.dataDir, memoryDb: scene.memory.memoryDb }) };
}

type Setting = { scene: Scene; store: ReturnType<typeof createStore> };

/** One diary turn in which her writer answers `answer`, or fails when it is null: the result and the writer's request. */
async function turn({ store }: Setting, answer: string | null, extra: Record<string, unknown> = {}) {
  freshWorld();
  world().channel({ id: 'd1', name: 'journal', placeId: ROOT });
  const calls: Array<unknown> = [];
  const model = {
    calls,
    complete: (messages: unknown, options?: { purpose?: string }) => {
      calls.push(structuredClone(messages));
      if (options?.purpose === 'selfreflection-planner') {
        // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
        const text = planAnswerText({ kind: 'status', brief: 'a calm evening', search: '', picture: false }, options);
        return Promise.resolve({ text, usage: {}, estimated: 5 });
      }
      if (answer === null) return Promise.reject(Object.assign(new Error('provider down'), { statusCode: 500 }));
      return Promise.resolve({ text: answer, usage: {}, estimated: 5 });
    },
  };
  const result = await sceneRunner(model, store).runTurn({
    mode: 'selfreflection',
    selfreflection: { kind: 'status', forced: true },
    placeId: ROOT,
    ...extra,
  });
  await store.flushSettled({});
  return { result, writer: calls.at(-1) };
}

/** Every string of a request, joined. */
function requestText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(requestText).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(requestText).join('\n');
  return '';
}

/**
 * The body of the request's `<feedback>` part of `<inner>`, or null when it has none. In these scenes nothing else
 * failed, so the part holds the refused audiences alone.
 */
function refusalBlock(request: unknown): string | null {
  // Slice 6: the refused audiences are told in `<feedback>` inside `<inner>`, which replaces `<audience_refused>`.
  return /<feedback>([\s\S]*?)<\/feedback>/.exec(requestText(request))?.[1] ?? null;
}

/** Whether the request tells her of a refused audience. */
const tells = (request: unknown): boolean => refusalBlock(request) !== null;

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
  assert.equal(selfreflectionRows(setup.scene.memory.memoryDb)[0]?.text, TEXT);
});

test('the status command names the blocked entry and why', async () => {
  // Catches: a field the desk fills and the owner's answer never prints.
  const setup = await setting();
  const { result } = await turn(setup, BAD);
  const { text } = await setup.scene.desk()('status');
  for (const word of [entryOf(result).id, 'audience-invalid', 'audience-unknown-place'])
    assert.ok(text.includes(word), word);
});

test('an entry with a readable audience blocks nothing and tells her nothing', async () => {
  // Catches: every entry reported, or a block that shows up on an ordinary diary request.
  const setup = await setting();
  await turn(setup, `<msg>${TEXT}</msg>`);
  const { writer } = await turn(setup, `<audience>interface:fake</audience><msg>${TEXT}</msg>`);
  assert.equal(refusalBlock(writer), null);
  assert.deepEqual(
    setup.scene
      .publisher()
      .mirrorStatus()
      .flatMap((mirror) => mirror.audienceBlocked),
    []
  );
});

for (const [value, code] of [
  ['place:fake:channel:nowhere', 'audience-unknown-place'],
  ['interface:nothing', 'audience-unknown-interface'],
  ['everywhere', 'audience-malformed'],
] as const) {
  test(`her next diary request tells her why, for ${code}`, async () => {
    // Catches: the same words for every failure, which would not tell her what to name differently.
    const setup = await setting();
    await turn(setup, `<audience>${value}</audience><msg>${TEXT}</msg>`);
    const { writer } = await turn(setup, `<msg>${TEXT}</msg>`);
    assert.ok(refusalBlock(writer)?.includes(labels.selfreflection.audienceReasons[code]));
  });
}

test('she hears of it once, and the owner keeps seeing it', async () => {
  // Catches: the same failure repeated on every later request, or telling her clearing the owner's view.
  const setup = await setting();
  await turn(setup, BAD);
  assert.equal(tells((await turn(setup, `<msg>${TEXT}</msg>`)).writer), true);
  assert.equal(refusalBlock((await turn(setup, `<msg>${TEXT}</msg>`)).writer), null);
  assert.equal(setup.scene.publisher().mirrorStatus()[0]?.audienceBlocked.length, 1);
});

test('a request she answered with silence still counts as telling her', async () => {
  // Catches: the mark tied to a recorded entry, so each skipped turn repeats the notice.
  const setup = await setting();
  await turn(setup, BAD);
  assert.equal(tells((await turn(setup, '<skip/>')).writer), true);
  assert.equal(refusalBlock((await turn(setup, `<msg>${TEXT}</msg>`)).writer), null);
});

test('a request the model never answered does not count as telling her', async () => {
  // Catches: the mark set as the request is built, so a provider failure loses the only notice she would get.
  const setup = await setting();
  await turn(setup, BAD);
  assert.equal(tells((await turn(setup, null)).writer), true);
  assert.equal(tells((await turn(setup, `<msg>${TEXT}</msg>`)).writer), true);
});

test('a refusal on an entry under a trusted restriction stays out of an ordinary diary request', async () => {
  // Catches: the notice quoting a private entry into a request whose diary history hides that entry.
  const setup = await setting();
  await turn(setup, BAD, { publicationBoundary: BOUNDARY });
  assert.equal(refusalBlock((await turn(setup, `<msg>${TEXT}</msg>`)).writer), null);
});
