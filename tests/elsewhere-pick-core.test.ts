// A started turn asks one `elsewhere-pick`, and both fields of its answer reach her request: the core over the fake
// interface, the tracked prompts, a model scripted by purpose. Plan 2026-11-04-cli-and-memory B3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from '../src/core.ts';
import { start } from '../src/interface/fake-interface.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { channelInfo, deliver, until } from './fixtures/core-over-fake.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SELF = { id: 'self-id', name: 'Nova' };
const COMMUNITY = { id: 'g1', name: 'Alpha' };
const CONFIG = {
  bot: { timezone: 'UTC', owners: [] },
  models: { base: { video: false } },
  pace: { settleMs: 0, settleMaxMs: 0 },
  typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], minMs: 0, maxMs: 0 },
  gifs: { backfillMessages: 0 },
  address: { attentionMinutes: 30, maxTurnsPerAuthor: 100 },
  elsewhere: { maxPlaces: 10, maxEpisodes: 10 },
};

type Asked = { purpose: unknown; text: string };
type Running = Awaited<ReturnType<typeof start>>;

/** Two channels of one community, her exchange in the second, then a call in the first. Returns the second turn's requests. */
async function secondTurn(pick: string): Promise<{ asked: Array<Asked>; reply: string }> {
  const root = mkdtempSync(join(tmpdir(), 'ep-'));
  const dataDir = join(root, 'd');
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  writeFileSync(join(dataDir, 'config', 'config.json'), JSON.stringify(CONFIG));
  const asked: Array<Asked> = [];
  let running: Running | null = null;
  const core = await startCore({
    paths: { rootDir: REPO, privateDir: dataDir, dataDir },
    env: { OPENROUTER_CORE_KEY: 'test-key' },
    interfaces: [
      {
        name: 'fake',
        start: async (host) => {
          running = await start(host, { self: SELF, community: COMMUNITY });
          return running;
        },
      },
    ],
    llm: {
      // Type fix (plan B3, approved): the core types a request's options `unknown`, so the purpose is read through a cast.
      complete: (messages: unknown, given: unknown) => {
        const options = given as { purpose?: unknown } | undefined;
        asked.push({ purpose: options?.purpose, text: JSON.stringify(messages) });
        const text =
          options?.purpose === 'address' ? 'yes' : options?.purpose === 'elsewhere-pick' ? pick : '<msg>καλημέρα</msg>';
        return Promise.resolve({ text, usage: {}, estimated: 10 });
      },
    },
    embedder: { embed: () => Promise.resolve([]) },
  });
  try {
    const live = running as unknown as Running;
    const posted = (conversation: string) =>
      live.adapter.messagesIn(conversation).filter((message) => message.authorId === SELF.id).length;
    live.adapter.seedConversation(channelInfo('c1'));
    live.adapter.seedConversation(channelInfo('c2'));
    const elsewhere = deliver(live.adapter, {
      conversationId: 'c2',
      id: 'm1',
      text: 'Nova, πού είναι το κόκκινο βιβλίο',
      at: Date.now(),
      mention: true,
    });
    await live.emit(elsewhere);
    await until(() => posted('c2') > 0);
    const before = asked.length;
    const here = deliver(live.adapter, {
      conversationId: 'c1',
      id: 'm2',
      text: 'Nova, τι είπες πριν για το βιβλίο',
      at: Date.now(),
      mention: true,
    });
    await live.emit(here);
    await until(() => posted('c1') > 0);
    const second = asked.slice(before);
    return { asked: second, reply: second.at(-1)?.text ?? '' };
  } finally {
    await core.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

test('a started turn asks one elsewhere pick and neither of the classifiers it replaces', async () => {
  // Bug: the merge leaves a hook wired, so a turn still pays for two calls and their latency.
  const { result } = await withCapturedLogs(() => secondTurn('place: none\nepisodes: none'));
  const purposes = result.asked.map((entry) => entry.purpose);
  assert.equal(purposes.filter((purpose) => purpose === 'elsewhere-pick').length, 1);
  assert.equal(purposes.includes('route-channel'), false);
  assert.equal(purposes.includes('participation-pick'), false);
});

test('a picked place reaches her request as the view of that place', async () => {
  // Bug: the answer's first field is parsed and dropped, so she is asked about a place she cannot see.
  const { result } = await withCapturedLogs(() => secondTurn('place: 1\nepisodes: none'));
  assert.ok(result.reply.includes('<channel_view'));
  assert.ok(result.reply.includes('κόκκινο βιβλίο'));
});

test('a picked place of none leaves no view in her request', async () => {
  // Bug: a none is read as the first place and a read is spent on it.
  const { result } = await withCapturedLogs(() => secondTurn('place: none\nepisodes: none'));
  assert.equal(result.reply.includes('<channel_view'), false);
});
