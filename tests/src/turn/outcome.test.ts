import assert from 'node:assert/strict';
import { test } from 'node:test';
import { labels } from '../../fixtures/labels.ts';
import { createTurnRunner } from '../../fixtures/turn-runner.ts';
import { useIface, world } from '../../fixtures/turn-world.ts';

useIface('fake');

/** A discord.js-shaped raw message of chat `placeId`. */
function rawMessage(id: string, placeId: string, authorId = 'u1') {
  return {
    id,
    placeId,
    author: { id: authorId, bot: false, globalName: authorId, username: authorId },
    member: { displayName: authorId },
    cleanContent: 'hey bot',
    createdTimestamp: Date.now() - 1000,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

/** The trigger the pipeline hands runTurn for `raw`. */
function triggerOf(raw: ReturnType<typeof rawMessage>) {
  return {
    id: raw.id,
    placeId: raw.placeId,
    authorId: raw.author.id,
    authorName: raw.author.globalName,
    self: false,
    bot: false,
    content: raw.cleanContent,
    ts: raw.createdTimestamp,
    replyToId: null,
    attachments: [],
    stickers: [],
  };
}

function fakeStore() {
  return {
    getPlace: () => ({}),
    getUser: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    liveRules: () => [],
    getDiary: () => ({ posts: [], updatedAt: 0 }),
    state: { data: {}, markDirty() {} },
  };
}

function fakeHot() {
  return {
    config: {
      bot: { timezone: 'UTC', dryRunChannelId: '' },
      context: {
        channelMessages: 100,
        neighborMessages: 5,
        neighborMaxAgeMinutes: 60,
        neighborMaxChannels: 8,
        maxMessageChars: 800,
        gapMarkerMinutes: 20,
        otherProfiles: 6,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: {
          maxImages: 2,
          tokensPerImage: 400,
          imageSize: 512,
          recentImages: 0,
          recentImageMinutes: 0,
          maxBytes: 1_500_000,
          fetchTimeoutMs: 10_000,
        },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [0, 0], minMs: 0, maxMs: 0, betweenMessagesMs: [0, 0] },
      diary: { world: false },
    },
    prompts: {
      main: 'SYSTEM',
      persona: 'CARD',
      format: 'Use <msg> and <react> tags.',
      'turn/reply': 'Someone called you: {{author}}.',
      'heartbeat/task': 'HEARTBEAT',
      'diary/task': 'DIARY',
      labels,
    },
  };
}

/** A model whose every request waits until the test answers it: `answer(i, text)` answers request `i`. */
function heldModel() {
  const calls: Array<unknown> = [];
  const answers: Array<(value: unknown) => void> = [];
  return {
    calls,
    complete: (messages: unknown) => {
      calls.push(messages);
      return new Promise<unknown>((resolve) => answers.push(resolve));
    },
    answer(index: number, text: string) {
      answers[index]?.({ text, usage: {}, estimated: 10 });
    },
  };
}

/** Waits, an event-loop turn at a time, until the model has `count` requests (or gives up after a bounded wait). */
async function untilCalls(model: { calls: Array<unknown> }, count: number) {
  for (let i = 0; i < 2000 && model.calls.length < count; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const BEAT_WAKE = {
  kind: 'heartbeat',
  items: [{ kind: 'heartbeat', reason: 'heartbeat', intentionIds: [] as Array<string>, errandId: null }],
  intentions: [],
  now: Date.now(),
  timezone: 'UTC',
  channels: [],
  chainId: 'heartbeat:1',
};

/** A runner over two chats of the world, its model held, and the turns a test starts on it. */
function lanes() {
  const c1 = world().channel({ id: 'c1', name: 'general', placeId: 'g1', historyMessages: [rawMessage('m1', 'c1')] });
  const c2 = world().channel({ id: 'c2', name: 'other', placeId: 'g1', historyMessages: [rawMessage('m2', 'c2')] });
  const model = heldModel();
  const turns = createTurnRunner({
    hot: fakeHot(),
    store: fakeStore(),
    llm: model,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
  });
  const mention = (channel: typeof c1, id: string) =>
    turns.runTurn({ channel, mode: 'reply', trigger: triggerOf(rawMessage(id, channel.id)), triggerKind: 'mention' });
  const inner = (wake: typeof BEAT_WAKE, channel: typeof c1 | null = null) =>
    turns.runTurn({
      ...(channel ? { channel } : { chat: null }),
      mode: 'inner',
      triggerKind: 'inner',
      inner: { wake, shadow: false, mayAct: () => true, currentChannel: null },
    });
  const heartbeat = () => inner(BEAT_WAKE);
  const diary = () => turns.runTurn({ chat: null, mode: 'diary', diary: { kind: 'status', forced: false } });
  return { c1, c2, model, turns, mention, inner, heartbeat, diary };
}

test('the end of a service turn starts no drain of held calls; the end of a chat turn does', async () => {
  const { c1, model, turns, mention, heartbeat } = lanes();
  let idle = 0;
  turns.setOnIdle(() => {
    idle += 1;
  });
  const beat = heartbeat();
  await untilCalls(model, 1);
  model.answer(0, '<skip/>');
  await beat;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle, 0);
  const reply = mention(c1, 'm1');
  await untilCalls(model, 2);
  model.answer(1, '<msg>hi</msg>');
  await reply;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle, 1);
});

test('the pause waits for a service turn too: waitIdle resolves once both lanes are free', async () => {
  const { model, turns, heartbeat } = lanes();
  const beat = heartbeat();
  await untilCalls(model, 1);
  let idle = false;
  void turns.waitIdle().then(() => {
    idle = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle, false, 'the heartbeat still runs');
  model.answer(0, '<skip/>');
  await beat;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle, true);
});
