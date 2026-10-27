// The scene of tests/diary-mirror-awareness.test.ts: one ordinary reply turn of the real turn runner over a real store
// and memory database, on a community of the fake interface with `general` (c1), `journal` (d1) and `notes` (d2), and a
// scripted model. `diary-mirror-awareness.json` beside this file holds the `<server>` block the turn in c1 built with
// `diaryChannelId: 'd1'` and no mirror, on the code before `diary.channelId` became a seed. Synthetic text only.
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner } from '../../src/behavior/turn.js';
import { userText } from '../../src/behavior/prompt.js';
import { createStore } from '../../src/memory/store.js';
import { dbOf, seedMirror } from './diary-mirror.ts';
import type { MemoryService } from './diary-mirror.ts';
import { openTestMemory } from './memory-db/service.js';
import { hotWith, rawMessage, sequenceLlm } from './turn-harness.js';
import { freshWorld, onWorld, world } from './turn-world.ts';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const MINUTE = 60_000;
export const GUILD = 'g1';

/** The memory databases the scenes opened, closed when the file is done. */
const OPEN: Array<{ close(): unknown }> = [];
after(async () => {
  for (const item of OPEN.splice(0)) await item.close();
});

/** Her own message in `channelId`, ten minutes ago, as discord.js hands it over. */
function ownLine(id: string, channelId: string): Record<string, unknown> {
  return {
    ...rawMessage({ id, ts: NOW - 10 * MINUTE, content: 'σημείωμα' }),
    channelId,
    author: { id: 'self-id', bot: true, globalName: 'Bot', username: 'Bot' },
    member: { displayName: 'Bot' },
  };
}

/** The `<server>` block of the request's user text. */
export function serverBlock(messages: unknown): string {
  // The scripted model keeps each request as the runner built it: system, then user.
  const user = (messages as Array<{ content: unknown }>)[1]?.content;
  const block = /<server>[\s\S]*?<\/server>/.exec(userText(user))?.[0];
  assert.ok(block, 'the request has a <server> block');
  return block;
}

/**
 * One ordinary reply turn to Alice in `here`, on a community with `general` (c1), `journal` (d1) and `notes` (d2),
 * each with notes in memory and her line ten minutes ago in d1 and d2. Memory holds the `diary` mirrors on
 * `mirrors`; the config sets `diary.channelId` only when `diaryChannelId` is given (the recording).
 */
export async function replyTurn({
  here,
  mirrors,
  diaryChannelId = null,
}: {
  here: 'c1' | 'd1';
  mirrors: Array<'d1' | 'd2'>;
  diaryChannelId?: string | null;
}): Promise<{ memory: { memoryDb: MemoryService }; store: ReturnType<typeof createStore>; request: unknown }> {
  const memory = await openTestMemory({ now: () => NOW });
  OPEN.push(memory);
  const store = createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb });
  const names = { c1: 'general', d1: 'journal', d2: 'notes' } as const;
  for (const [id, name] of Object.entries(names)) {
    store.touchChannel(GUILD, id, { name }, NOW - 5 * MINUTE);
    store.updateChannel(GUILD, id, { purpose: `${name} purpose` });
  }
  store.flush();
  await store.flushSettled({});
  // Before schema v15 there is no `mirrors` table: the turn then runs without them, so a test fails on what the turn
  // shows, not here.
  const db = dbOf(memory.memoryDb);
  const hasMirrors = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mirrors'").all();
  if (hasMirrors.length > 0)
    for (const id of mirrors) seedMirror(memory.memoryDb, { iface: 'fake', conversationId: id, name: names[id], at: NOW });
  freshWorld();
  const trigger = rawMessage({ id: 'm1', ts: NOW - 1000, content: 'γεια σου' });
  for (const id of ['d1', 'd2'] as const) {
    const lines = id === here ? [ownLine(`p-${id}`, id), { ...trigger, channelId: id }] : [ownLine(`p-${id}`, id)];
    world().channel({ id, name: names[id], guildId: GUILD, historyMessages: lines, lastMessageAt: NOW - 10 * MINUTE });
  }
  if (here === 'c1') world().channel({ id: 'c1', name: names.c1, guildId: GUILD, historyMessages: [trigger] });
  const llm = sequenceLlm(['<msg>γεια</msg>']);
  const turns = onWorld(createTurnRunner)({
    hot: hotWith({
      features: { participation: true },
      config: diaryChannelId === null ? {} : { diary: { channelId: diaryChannelId } },
    }),
    store,
    // The memory the runner may read the mirrors from (the store reads the same database).
    memoryDb: memory.memoryDb,
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    rng: () => 0.5,
    now: () => NOW,
  });
  const result = await turns.runTurn({
    channel: { id: here },
    mode: 'reply',
    trigger: {
      ...trigger,
      channelId: here,
      authorId: 'u1',
      authorName: 'Alice',
      self: false,
      bot: false,
      ts: NOW - 1000,
    },
    triggerKind: 'mention',
  });
  assert.equal((result as { outcome?: unknown }).outcome, 'spoke', 'she answers Alice');
  await store.flushSettled({});
  const request: unknown = llm.calls[0];
  return { memory, store, request };
}

