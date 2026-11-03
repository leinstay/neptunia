import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/tools/impl/index.ts';
import { createInTurnTools, type InTurnDraft } from '../src/turn/in-turn-tools.ts';
import { callViewOf, searchHandles } from '../src/turn/calls.ts';
import { memorySearchText } from '../src/tools/tools.ts';
import { resolveCall, executeCall, type InTurnCall } from '../src/tools/executors.ts';
import { skillRegistry } from '../src/tools/registry.ts';
import { turnRoutes } from '../src/behavior/turn-ability-route.ts';
import type { NativeMessageLocator } from '../src/memory/db/recall.ts';
import { groupContext } from '../src/memory/db/scope.ts';
import { rig, channel } from './fixtures/reads-rig.ts';
import { labels } from './fixtures/labels.ts';

const NOW = Date.parse('2026-10-24T12:00:00Z');

function cacheScene() {
  const io = rig();
  const pages: Array<string> = [];
  const images: Array<unknown> = [];
  const hot = {
    config: {
      features: { vision: true, mediaDescriptions: true, videoDescriptions: true, coreTools: true },
      models: { base: { vision: 'test/vision' } },
    },
    prompts: { labels },
  };
  const draft: InTurnDraft = { handleFloor: 2 };
  const tools = createInTurnTools({
    hot,
    store: {},
    recall: null,
    speech: null,
    record: null,
    routes: turnRoutes(hot, null),
    clock: () => NOW,
    ifaceReads: io.reads,
    lookup: {
      readPage: (_guildId, url) => {
        pages.push(url);
        return Promise.resolve({ ok: true, url, title: 'stored page', text: `page:${url}` });
      },
    },
    describer: {
      relookImage: (_guildId, item, question) => {
        images.push(item.itemId);
        return Promise.resolve({ question, text: `image:${String(item.itemId)}` });
      },
    },
    memberOf: () => null,
    conversationOf: (current) => ({ iface: 'fake', conversationId: current.id }),
    turnContextOf: () => groupContext('fake'),
    linkCalls: (lines) => lines,
    drawTool: () => Promise.reject(new Error('drawing is outside this fixture')),
  });
  const history = [
    {
      id: 'same-native',
      content: 'https://local.example/wrong',
      attachments: [{ id: 'local-wrong', kind: 'image', url: 'https://local.example/wrong.png' }],
      links: [],
    },
  ];
  const handlers = tools.inTurnTools({
    channel: channel('room'),
    guildId: 'g1',
    selfId: 'self',
    selfName: 'Synthetic persona',
    history,
    draft,
  });
  return { io, pages, images, draft, handlers };
}

function registerCached(scene: ReturnType<typeof cacheScene>, name: string, native?: NativeMessageLocator) {
  const stored = {
    sourceId: `opaque-${name}`,
    placeId: `place-${name}`,
    iface: native?.iface ?? `foreign-${name}`,
    ...(native ? { native } : {}),
  };
  const refs = searchHandles(scene.draft);
  const n = refs.next();
  memorySearchText(
    [
      {
        channelId: 'room',
        channelName: 'stored room',
        startTs: NOW,
        lines: name,
        entries: [
          {
            id: 'same-native',
            text: name,
            stored,
            message: {
              id: 'same-native',
              content: `https://${name}.example/page`,
              attachments: [
                { id: `image-${name}`, kind: 'image', url: `https://${name}.example/image.png`, name: `${name}.png` },
              ],
              links: [],
            },
          },
        ],
      },
    ],
    { labels, refs }
  );
  return { n, stored };
}

async function cachedCall(scene: ReturnType<typeof cacheScene>, skill: 'web.read' | 'media.look', n: number) {
  const view = callViewOf({
    channel: { id: 'room', communityId: 'g1' },
    currentIface: 'fake',
    skills: skillRegistry(),
    searchRefs: scene.draft.searchRefs,
  });
  const resolved = resolveCall(
    { skill, args: skill === 'web.read' ? { message: `#${n}` } : { message: `#${n}`, question: 'describe the item' } },
    view
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) assert.fail('authorized cached handle was refused');
  assert.equal(resolved.args.message, 'same-native');
  assert.equal(resolved.memoryAnchor, undefined);
  return executeCall(resolved, {
    inTurn: scene.handlers,
    port: { send: () => Promise.reject(new Error('cached reads never send')) },
    refOf: () => ({ iface: 'fake', conversationId: 'room' }),
    opContext: { guildId: 'g1', channelId: 'room' },
  });
}

for (const skill of ['web.read', 'media.look'] as const) {
  test(`${skill} keeps each stored message's cached content across colliding handles and loop steps`, async () => {
    const scene = cacheScene();
    const first = registerCached(scene, 'first');
    const second = registerCached(scene, 'second');
    const one = await cachedCall(scene, skill, first.n);
    const two = await cachedCall(scene, skill, second.n);
    assert.equal(one.status, 'ok');
    assert.equal(two.status, 'ok');
    if (skill === 'web.read')
      assert.deepEqual(scene.pages, ['https://first.example/page', 'https://second.example/page']);
    else assert.deepEqual(scene.images, ['image-first', 'image-second']);
    assert.deepEqual(scene.io.fake.calls, []);
  });
}

for (const skill of ['web.read', 'media.look'] as const) {
  test(`${skill} never falls back to local history when an exact stored cache entry is missing`, async () => {
    const scene = cacheScene();
    const call: InTurnCall = {
      requester: null,
      conversationId: 'room',
      idempotencyKey: null,
      messageRef: { kind: 'stored', stored: { sourceId: 'missing-source', placeId: 'missing-place', iface: 'other' } },
    };
    const result = await scene.handlers[skill]({ message: 'same-native', question: 'describe the item' }, call);
    assert.equal(JSON.stringify(result).includes('local.example'), false);
    assert.deepEqual(scene.pages, []);
    assert.deepEqual(scene.images, []);
    assert.deepEqual(scene.io.fake.calls, []);
  });
}

test('a native cached link reference matches its current conversation without borrowing a foreign route', async () => {
  const scene = cacheScene();
  const call: InTurnCall = {
    requester: null,
    conversationId: 'room',
    idempotencyKey: null,
    messageRef: { kind: 'native', native: { iface: 'fake', conversationId: 'room', messageId: 'same-native' } },
  };
  await scene.handlers['web.read']({ message: 'same-native' }, call);
  assert.deepEqual(scene.pages, ['https://local.example/wrong']);
  assert.deepEqual(scene.io.fake.calls, []);
});

test('a foreign native cache reference cannot select the same native ID from current history', async () => {
  const scene = cacheScene();
  const call: InTurnCall = {
    requester: null,
    conversationId: 'room',
    idempotencyKey: null,
    messageRef: { kind: 'native', native: { iface: 'other', conversationId: 'room', messageId: 'same-native' } },
  };
  await scene.handlers['web.read']({ message: 'same-native' }, call);
  assert.deepEqual(scene.pages, []);
  assert.deepEqual(scene.io.fake.calls, []);
});

test('an ambiguous qualified native cache reference cannot choose between distinct stored sources', async () => {
  const scene = cacheScene();
  const native = { iface: 'fake', conversationId: 'room', messageId: 'same-native' };
  registerCached(scene, 'first', native);
  registerCached(scene, 'second', native);
  const call: InTurnCall = {
    requester: null,
    conversationId: 'room',
    idempotencyKey: null,
    messageRef: { kind: 'native', native },
  };
  await scene.handlers['web.read']({ message: 'same-native' }, call);
  assert.deepEqual(scene.pages, []);
  assert.deepEqual(scene.io.fake.calls, []);
});

test('repeating one source-free native quote keeps its original handle usable for cached web reads', async () => {
  const scene = cacheScene();
  const refs = searchHandles(scene.draft);
  const firstNumber = refs.next();
  const quote = {
    channelId: 'quoted-room',
    channelName: 'quoted room',
    startTs: NOW,
    lines: 'quoted link',
    entries: [
      {
        id: 'same-native',
        text: 'quoted link',
        message: {
          id: 'same-native',
          channelId: 'quoted-room',
          native: { iface: 'fake', conversationId: 'quoted-room', messageId: 'same-native' },
          content: 'https://repeat.example/original',
          attachments: [],
          links: [],
        },
      },
    ],
  };
  memorySearchText([quote], { labels, refs });
  const firstRead = await cachedCall(scene, 'web.read', firstNumber);
  assert.equal(firstRead.status, 'ok');
  assert.deepEqual(scene.pages, ['https://repeat.example/original']);
  memorySearchText([quote], { labels, refs });
  const repeatedRead = await cachedCall(scene, 'web.read', firstNumber);
  assert.equal(repeatedRead.status, 'ok');
  assert.deepEqual(scene.pages, ['https://repeat.example/original', 'https://repeat.example/original']);
  assert.deepEqual(scene.io.fake.calls, []);
});
