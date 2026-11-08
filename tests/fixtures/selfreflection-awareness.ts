// The scene of tests/selfreflection-mirror-awareness.test.ts: one ordinary reply turn of the real turn runner over a real store
// and memory database, on a root of the fake interface with `general` (c1), `journal` (d1) and `notes` (d2), and a
// scripted model. Synthetic text only.
import { placeOfRoot, placeOfChat } from '../../src/memory/addresses.ts';
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../src/memory/store.ts';
import { addLine } from './memory-db/mind-world.ts';
import { dbOf, seedMirror } from './selfreflection-mirror.ts';
import type { MemoryService } from './selfreflection-mirror.ts';
import { openTestMemory } from './memory-db/service.ts';
import { hotWith, rawMessage, sequenceLlm } from './turn-harness.ts';
import { freshWorld, world } from './turn-world.ts';
import { worldTurnRunner } from './world-runner.ts';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const MINUTE = 60_000;
export const ROOT = 'g1';

/** The memory databases the scenes opened, closed when the file is done. */
const OPEN: Array<{ close(): unknown }> = [];
after(async () => {
  for (const item of OPEN.splice(0)) await item.close();
});

/** Her own message in `placeId`, ten minutes ago, as discord.js hands it over. */
function ownLine(id: string, placeId: string): Record<string, unknown> {
  return {
    ...rawMessage({ id, ts: NOW - 10 * MINUTE, content: 'σημείωμα' }),
    placeId,
    author: { id: 'self-id', bot: true, globalName: 'Bot', username: 'Bot' },
    member: { displayName: 'Bot' },
  };
}

/**
 * One ordinary reply turn to Alice in `here`, on a root with `general` (c1), `journal` (d1) and `notes` (d2),
 * each with notes in memory and her line ten minutes ago in d1 and d2, stored too. Memory holds the `selfreflection`
 * mirrors on `mirrors`; the config sets `diary.placeId` only when `selfreflectionChannelId` is given.
 */
export async function replyTurn({
  here,
  mirrors,
  selfreflectionChannelId = null,
}: {
  here: 'c1' | 'd1';
  mirrors: Array<'d1' | 'd2'>;
  selfreflectionChannelId?: string | null;
}): Promise<{ memory: { memoryDb: MemoryService }; store: ReturnType<typeof createStore>; request: unknown }> {
  const memory = await openTestMemory({ now: () => NOW });
  OPEN.push(memory);
  const store = createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb });
  const names = { c1: 'general', d1: 'journal', d2: 'notes' } as const;
  for (const [id, name] of Object.entries(names)) {
    store.touchChannel(placeOfChat(store, { id, iface: 'fake' }), { name }, NOW - 5 * MINUTE);
    store.updateChannel(placeOfChat(store, { id, iface: 'fake' }), { purpose: `${name} purpose` });
  }
  store.flush();
  await store.flushSettled({});
  // Before schema v15 there is no `mirrors` table: the turn then runs without them, so a test fails on what the turn
  // shows, not here.
  const db = dbOf(memory.memoryDb);
  const hasMirrors = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mirrors'").all();
  if (hasMirrors.length > 0)
    for (const id of mirrors) seedMirror(memory.memoryDb, { iface: 'fake', chatId: id, name: names[id], at: NOW });
  // Her channels sit under the server, as the observation of their first lines leaves them.
  const server = placeOfRoot(store, ROOT, 'fake');
  db.prepare("INSERT OR IGNORE INTO places (id, iface, kind) VALUES (?, 'fake', 'server')").run(server);
  for (const id of Object.keys(names))
    db.prepare('UPDATE places SET parent_id = ? WHERE id = ?').run(server, placeOfChat(store, { id, iface: 'fake' }));
  // Her lines in d1 and d2 are stored too, so a reply's `<memory>` brings both places to mind as hers (slice 4).
  for (const id of ['d1', 'd2'] as const)
    addLine(db, {
      id: `src:fake:p-${id}:1:said`,
      iface: 'fake',
      place: placeOfChat(store, { id, iface: 'fake' }),
      author: 'self',
      text: 'σημείωμα',
      at: new Date(NOW - 10 * MINUTE).toISOString(),
    });
  freshWorld();
  const trigger = rawMessage({ id: 'm1', ts: NOW - 1000, content: 'γεια σου' });
  for (const id of ['d1', 'd2'] as const) {
    const lines = id === here ? [ownLine(`p-${id}`, id), { ...trigger, placeId: id }] : [ownLine(`p-${id}`, id)];
    world().channel({ id, name: names[id], placeId: ROOT, historyMessages: lines, lastMessageAt: NOW - 10 * MINUTE });
  }
  if (here === 'c1') world().channel({ id: 'c1', name: names.c1, placeId: ROOT, historyMessages: [trigger] });
  const llm = sequenceLlm(['<msg>γεια</msg>']);
  const turns = worldTurnRunner({
    hot: hotWith({
      config: selfreflectionChannelId === null ? {} : { selfreflection: { placeId: selfreflectionChannelId } },
    }),
    store,
    // The memory the runner may read the mirrors from (the store reads the same database).
    memoryDb: memory.memoryDb,
    // The database a reply's request reads `<memory>` from (src/memory/db/frame-reads.ts).
    journalDb: () => db,
    memoryContext: () => ({ kind: 'group', iface: 'fake' }),
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
      placeId: here,
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

