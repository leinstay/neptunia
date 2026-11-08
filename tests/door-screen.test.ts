// The door's screen (src/pipeline/handle-message.ts#DoorScreen): before any turn or memory reads a new line, the screen
// may drop it (the right link code from the account that asked) so that no turn starts and nothing is observed, or pass
// it on. A fake adapter, a fake turn runner and a recording memory; the screen itself is a stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageHandler } from '../src/behavior/pipeline.ts';
import { createTagHistory } from '../src/behavior/mention.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { createReads } from '../src/interface/reads.ts';
import type { MessageEvent } from '../src/protocol/adapter.ts';
import type { MessageReceived } from '../src/protocol/events.ts';
import { baseConfig } from './fixtures/events-rig.ts';
import { labels } from './fixtures/labels.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { channel as channelOf } from './fixtures/reads-rig.ts';

const NOW = Date.parse('2026-11-08T12:00:00Z');
const SELF = 'self-id';

type Rig = { say: (id: string, text: string) => Promise<void>; started: Array<string>; observed: Array<string> };

function rig(verdict: (event: MessageEvent) => 'pass' | 'observe' | 'drop'): Rig {
  const fake = createFakeAdapter({ iface: 'chatnet', selfId: SELF });
  fake.seedChat(channelOf('c1', { iface: 'chatnet', name: 'c1', kind: 'channel', rootId: 'g1' }));
  const reads = createReads(fake, { info() {}, warn() {}, error() {} });
  const started: Array<string> = [];
  const observed: Array<string> = [];
  const handler = createMessageHandler(
    wrongly<Parameters<typeof createMessageHandler>[0]>({
      hot: {
        config: baseConfig({ bot: { timezone: 'UTC' }, address: { attentionMinutes: 30, maxTurnsPerAuthor: 100 } }),
        prompts: { address: 'Is it said to {{name}}?', labels },
      },
      store: { state: { data: {}, markDirty() {} }, getUser: () => ({ names: ['Member'], affinity: { score: 0 } }) },
      reads,
      selfId: () => SELF,
      getSelfName: () => 'Nova',
      turns: {
        notePost() {},
        isBusy: () => false,
        isAnyBusy: () => false,
        spokeAfterSeeing: () => false,
        lastPostAt: () => 0,
        runTurn: (asked: { trigger: { id: string } }) => {
          started.push(asked.trigger.id);
          return Promise.resolve({ outcome: 'spoke' });
        },
      },
      memory: { observe: (_place: string, line: { id: string }) => observed.push(line.id) },
      tagHistory: createTagHistory(),
      isServedRoot: () => true,
      rootsOf: () => [],
      llm: { complete: () => Promise.resolve({ text: '{"answer":"yes"}', usage: {}, estimated: 1 }) },
      now: () => NOW,
      missed: { noteFact() {}, noteActivity() {}, noteNotAddressed() {} },
      selfNames: () => [],
      screen: { screen: (event: MessageEvent) => Promise.resolve(verdict(event)), isCodeLine: () => false },
      port: fake,
    })
  );
  async function say(id: string, text: string): Promise<void> {
    const event: MessageReceived = wrongly<MessageReceived>({
      kind: 'message.received',
      iface: 'chatnet',
      at: NOW,
      id: `chatnet:message:${id}`,
      chat: { id: 'c1', kind: 'channel', rootId: 'g1', name: 'c1' },
      message: {
        id,
        author: { id: 'a1', name: 'Eleni', self: false, bot: false },
        content: text,
        sourceText: text,
        system: false,
        at: NOW,
        replyToId: null,
        replyPingAccountId: null,
        forwardedFrom: null,
        attachments: [],
        links: [],
        forwarded: [],
        stickers: [],
        emojis: [],
        reactions: [],
      },
      addressing: { mentioned: true, replyToSelf: false, mentionedAccountIds: [SELF], mentionedChatIds: [] },
    });
    fake.seedEvent(wrongly<MessageEvent>(event));
    await handler(wrongly<MessageReceived>(event));
  }
  return { say, started, observed };
}

test('a line the screen drops starts no turn and is not observed', async () => {
  const { say, started, observed } = rig((event) => (event.message.content === 'ABCD2345' ? 'drop' : 'pass'));
  await say('m1', 'ABCD2345');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(started, []);
  assert.deepEqual(observed, []);
});

test('a line the screen passes reaches memory and its turn', async () => {
  const { say, started, observed } = rig(() => 'pass');
  await say('m2', 'Nova, hello');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(observed, ['m2']);
  assert.deepEqual(started, ['m2']);
});
