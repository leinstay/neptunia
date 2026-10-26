// The journal's reconciliation after a restart (src/memory/journal.js#reconcile) finds the persona's own messages through
// the interface's `history` read. `ownMessagesOf(reads, iface)` (src/behavior/own-messages.ts) is the `fetchOwnMessages`
// it is handed: the last `count` messages of a conversation, only the persona's, each as `{ id, content, replyToId,
// createdAt }`. `content` is the text as written in the core's grammar (`sourceText`), the form a post's intent was
// recorded in, never the text as the chat shows it.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Reads } from '../src/interface/reads.ts';
import { createJournal } from '../src/memory/journal.js';
import { openTestMemorySync } from './fixtures/memory-db/service.js';
import { IFACE, SELF_ID, channel, rig, message } from './fixtures/reads-rig.ts';

type Own = { id: string; content: string; replyToId: string | null; createdAt: number };
type Module = {
  ownMessagesOf: (reads: Reads, iface: string) => (conversationId: string, count: number) => Promise<Array<Own>>;
};

const { ownMessagesOf } = (await import('../src/behavior/own-messages.ts')) as Module;

const DAY = Date.UTC(2026, 9, 13, 23, 59, 50);
const GUILD = 'g1';
const room = channel('c1');

const opened: Array<ReturnType<typeof openTestMemorySync>> = [];
after(async () => {
  for (const memory of opened) await memory.close();
});

function journalAt(clock: { ms: number }) {
  const memory = openTestMemorySync();
  opened.push(memory);
  let n = 0;
  return createJournal({
    appendStore: {
      append: () => Promise.resolve(),
      iterate: async function* () {},
    },
    memoryDb: memory.memoryDb,
    dataDir: memory.dataDir,
    config: () => ({ thinkChars: 4000 }),
    now: () => clock.ms,
    uuid: () => `u-${(n += 1)}`,
  });
}

test("gives the persona's own messages of a conversation and none of anyone else's", async () => {
  const { reads, fake } = rig();
  fake.seedConversation(room);
  fake.seedEvent(message(room, 'm1', DAY - 3000, 'hello', { authorId: 'u1' }));
  fake.seedEvent(message(room, 'm2', DAY - 2000, 'hi back', { authorId: SELF_ID }));
  fake.seedEvent(message(room, 'm3', DAY - 1000, 'thanks', { authorId: 'u1' }));
  const own = await ownMessagesOf(reads, IFACE)('c1', 20);
  assert.deepEqual(
    own.map((item) => item.id),
    ['m2']
  );
});

test("gives the text as written, with the mention in the core's grammar, and the reply target and the time", async () => {
  const { reads, fake } = rig();
  fake.seedConversation(room);
  fake.seedEvent(
    message(room, 'm9', DAY - 500, 'hi @Eleni', {
      authorId: SELF_ID,
      sourceText: 'hi <@u1>',
      replyToId: 'm1',
    })
  );
  const [own] = await ownMessagesOf(reads, IFACE)('c1', 20);
  assert.deepEqual(own, { id: 'm9', content: 'hi <@u1>', replyToId: 'm1', createdAt: DAY - 500 });
});

test("reads the last `count` messages of the conversation, mixed authors included, before it keeps the persona's", async () => {
  const { reads, fake, asked } = rig();
  fake.seedConversation(room);
  fake.seedEvent(message(room, 'm1', DAY - 4000, 'one', { authorId: SELF_ID }));
  fake.seedEvent(message(room, 'm2', DAY - 3000, 'two', { authorId: 'u1' }));
  fake.seedEvent(message(room, 'm3', DAY - 2000, 'three', { authorId: SELF_ID }));
  const own = await ownMessagesOf(reads, IFACE)('c1', 2);
  assert.deepEqual(
    own.map((item) => item.id),
    ['m3']
  );
  assert.deepEqual(asked('history'), [{ iface: IFACE, conversationId: 'c1' }]);
});

test('fails when the interface cannot give the history, so the operation is left unknown', async () => {
  const { reads } = rig({ reads: ['messages.fetch'] });
  await assert.rejects(ownMessagesOf(reads, IFACE)('c1', 20));
});

test('closes a post as succeeded when its own message is found by the text as written', async () => {
  const { reads, fake } = rig();
  fake.seedConversation(room);
  fake.seedEvent(
    message(room, 'm9', DAY - 500, 'hi @Eleni, welcome', {
      authorId: SELF_ID,
      sourceText: 'hi <@u1>, welcome',
      replyToId: 'm1',
    })
  );
  const clock = { ms: DAY - 60_000 };
  const journal = journalAt(clock);
  const op = journal.op(GUILD, {
    turnId: 't-1',
    name: 'post',
    by: 'persona',
    channelId: 'c1',
    intent: { replyTo: 'm1', text: 'hi <@u1>, welcome' },
  });
  await op.started();
  clock.ms = DAY;
  const counts = await journal.reconcile(GUILD, {
    days: ['2026-10-13'],
    fetchOwnMessages: ownMessagesOf(reads, IFACE),
  });
  assert.deepEqual(counts, { succeeded: 1, unknown: 0 });
});

test("closes a post as unknown when the only message with its words is another person's", async () => {
  const { reads, fake } = rig();
  fake.seedConversation(room);
  fake.seedEvent(message(room, 'm9', DAY - 500, 'good morning', { authorId: 'u1', replyToId: 'm1' }));
  const clock = { ms: DAY - 60_000 };
  const journal = journalAt(clock);
  const op = journal.op(GUILD, {
    turnId: 't-1',
    name: 'post',
    by: 'persona',
    channelId: 'c1',
    intent: { replyTo: 'm1', text: 'good morning' },
  });
  await op.started();
  clock.ms = DAY;
  const counts = await journal.reconcile(GUILD, {
    days: ['2026-10-13'],
    fetchOwnMessages: ownMessagesOf(reads, IFACE),
  });
  assert.deepEqual(counts, { succeeded: 0, unknown: 1 });
});
