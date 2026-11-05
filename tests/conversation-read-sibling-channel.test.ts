// A group turn reads a sibling channel of the same server through the real core: the real store over a temporary
// database, the fake interface and a scripted model. The line was stored from a received event in channel c2; the turn
// in channel c1 calls `conversation.read` of c2 and the tool result must hold that line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from '../src/core.ts';
import { start } from '../src/interface/fake-interface.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { COMMUNITY, SELF, channelInfo, lineEvent, settle, until } from './fixtures/core-over-fake.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const STORED = 'the red book is on the shelf';

const CONFIG = {
  bot: {
    timezone: 'UTC',
    owners: ['u1'],
    access: { 'conversation.read': { everyone: false, roles: [], users: [SELF.id] } },
  },
  models: { base: { video: false } },
  pace: { settleMs: 0, settleMaxMs: 0 },
  typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], minMs: 0, maxMs: 0 },
  gifs: { backfillMessages: 0 },
};

const FIXED: Record<string, string> = {
  address: 'yes',
  split: 'one',
  merge: 'new',
  lookup: 'none',
  'query-builder': 'none',
  'route-channel': 'none',
  'participation-pick': 'none',
  'elsewhere-pick': 'place: none\nepisodes: none',
  'gif-pick': 'none',
  'media-pick': 'none',
  missed: '1: uncertain',
};

const toolResults = (messages: unknown): string =>
  (Array.isArray(messages) ? messages : [])
    .filter((message): message is { role: string; content: unknown } => message?.role === 'tool')
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
    .join('\n');

test('a group turn reads a line stored in another channel of the same server', async () => {
  // Bug: the read looked the stored record up under the channel's native root id instead of the turn's place,
  // so it answered "No messages in that span" while the line was stored.
  const root = mkdtempSync(join(tmpdir(), 'sr-'));
  const dataDir = join(root, 'd');
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  writeFileSync(join(dataDir, 'config', 'config.json'), JSON.stringify(CONFIG));
  let step = 0;
  let read = '';
  const llm = {
    complete: (messages: unknown, options: Record<string, unknown> = {}) => {
      const fixed = FIXED[String(options.purpose)];
      if (fixed !== undefined) return Promise.resolve(toolAnswer(fixed));
      step += 1;
      if (step === 1)
        return Promise.resolve(toolAnswer('', [call('conversation.read', { channel: '#room-c2', last: 5 })]));
      if (step === 2) read = toolResults(messages);
      return Promise.resolve(toolAnswer('<skip/>'));
    },
  };
  let live: Awaited<ReturnType<typeof start>> | null = null;
  try {
    await withCapturedLogs(async () => {
      const core = await startCore({
        paths: { rootDir: REPO, privateDir: dataDir, dataDir },
        env: { OPENROUTER_CORE_KEY: 'test-key' },
        interfaces: [
          {
            name: 'fake',
            start: async (host) => (live = await start(host, { self: SELF, community: COMMUNITY })),
          },
        ],
        llm,
        embedder: { embed: () => Promise.resolve([]) },
      });
      try {
        if (live === null) throw new Error('the core never started the fake interface');
        const fake = live;
        fake.adapter.seedConversation(channelInfo('c1'));
        fake.adapter.seedConversation(channelInfo('c2'));
        await fake.emit(lineEvent({ id: 'b0', conversationId: 'c2', text: STORED, at: Date.now() }));
        await settle(200);
        await fake.emit(
          lineEvent({
            id: 'a1',
            conversationId: 'c1',
            text: 'Nova, where is the red book?',
            at: Date.now(),
            mention: true,
          })
        );
        await until(() => step >= 2);
      } finally {
        await core.stop();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.ok(read.includes(STORED), read);
});
