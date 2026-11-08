// The scene of tests/diary-requests.test.ts: one diary turn of the real turn runner over the fake interface and a real
// store over a memory database, with a scripted model, on fixed inputs that reach every block a diary request can carry.
// Memory holds two earlier diary entries with their text (posted to the diary channel `d1` as `m1` and `m2`), the channel
// notes of `d1` and of `c1` (the root's other chat), recent lines of both and the guild's notes; the fake
// interface holds `d1` with the same two posts as her messages. `diary-requests.json` beside this file holds the plan
// request and the writer request this scene produced with the diary turn running in `d1`, before the diary became the
// selfreflection wake (recorded with `{ mirror: false }`). With `mirror: true` memory also holds `d1` as a place of the
// fake interface named `journal` and the diary's one enabled mirror on it, which is what the wake rebuilds the channel's
// inputs from. Synthetic text only.
import { placeOfRoot, placeOfChat } from '../../src/memory/addresses.ts';
import { createStore } from '../../src/memory/store.ts';
import { dbOf, seedMirror, seedPlace } from './selfreflection-mirror.ts';
import { labels } from './labels.ts';
import { openTestMemory } from './memory-db/service.ts';
import { useIface, useSelf, world } from './turn-world.ts';
import { worldTurnRunner } from './world-runner.ts';
import '../../src/tools/operations/index.ts';
import { planAnswerText } from './plan-answer.ts';

useIface('fake');
useSelf('self-id');

export const NOW = Date.UTC(2026, 9, 6, 19, 30, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const ROOT = 'g1';

/** One message of hers in the diary channel, as discord.js hands it over. */
function ownPost(id: string, ts: number, content: string): Record<string, unknown> {
  return {
    id,
    placeId: 'd1',
    author: { id: 'self-id', bot: true, globalName: 'Bot', username: 'Bot' },
    member: { displayName: 'Bot' },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

/** The settings of the scene: recent lines shown, no pictures, the diary channel set. */
export function sceneHot(): { config: Record<string, unknown>; prompts: Record<string, unknown> } {
  return {
    // PR 7d: the switches are code and the diary's, memory's and context's measures constants, so the config holds
    // only the keys that are still settings.
    config: {
      bot: { timezone: 'Europe/Athens' },
      context: {
        channelMessages: 50,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { fetchTimeoutMs: 10_000 },
        pull: { sameAudience: true },
      },
      llm: { maxRequestTokens: 50000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [0, 0], minMs: 0, maxMs: 0, betweenMessagesMs: [0, 0] },
      selfreflection: { placeId: 'd1', world: true, planMaxOutputTokens: 250, planTimeoutMs: 15000 },
    },
    prompts: {
      'system-prompt': 'SYSTEM for {{name}}',
      'character-card': 'CARD_TEXT',
      format: 'FORMAT_TEXT',
      selfreflection: 'DIARY_TASK for {{name}}',
      'selfreflection-planner': 'PLAN_SYSTEM for {{name}}',
      'selfreflection-seeds': '# place\na pier\n# light\nfog',
      world: 'WORLD of {{name}}',
      labels,
    },
  };
}

/** A model that answers the plan request with a status plan and the writer request with one message; it keeps both. */
export function sceneLlm(): {
  calls: Array<unknown>;
  complete: (messages: unknown, options?: { purpose?: string }) => Promise<{ text: string; usage: object; estimated: number }>;
} {
  const calls: Array<unknown> = [];
  return {
    calls,
    complete: (messages, options) => {
      calls.push(structuredClone(messages));
      const text =
        options?.purpose === 'selfreflection-planner'
          // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
          ? planAnswerText({ kind: 'status', brief: 'a calm evening', search: '', picture: false }, options)
          : '<msg>ήσυχο βράδυ στο λιμάνι</msg>';
      return Promise.resolve({ text, usage: {}, estimated: 5 });
    },
  };
}

/**
 * The world of the scene: the root's other chat and the diary channel, which holds her two earlier posts
 * when `history` is on. The wake's run leaves it empty, so the history it shows can only come from memory.
 */
export function sceneWorld({ history }: { history: boolean }): void {
  world().channel({ id: 'c1', name: 'general', placeId: ROOT });
  world().channel({
    id: 'd1',
    name: 'journal',
    placeId: ROOT,
    historyMessages: history
      ? [ownPost('m1', NOW - 2 * DAY, 'χθες βράδυ στο λιμάνι'), ownPost('m2', NOW - DAY, 'une journée grise au port')]
      : [],
  });
}

/** The two earlier entries: her posts `m1` and `m2` of the diary channel, by their time, gist and text. */
const EARLIER = [
  { id: 'm1', at: NOW - 2 * DAY, text: 'χθες βράδυ στο λιμάνι' },
  { id: 'm2', at: NOW - DAY, text: 'une journée grise au port' },
] as const;

/** The memory of the scene: the service, the real store over it and the clock both read. */
export type SceneMemory = {
  memory: Awaited<ReturnType<typeof openTestMemory>>;
  store: ReturnType<typeof createStore>;
};

/** Her two earlier posts as lines of the record of `d1`, one record day each, as the live path writes them. */
async function seedRecord(memoryDb: SceneMemory['memory']['memoryDb']): Promise<void> {
  for (const post of EARLIER) {
    const occurredAt = new Date(post.at).toISOString();
    const day = occurredAt.slice(0, 10);
    await memoryDb.writeUnit({
      kind: 'unit',
      op: 'lines',
      owner: `guilds/${ROOT}/record/${day.slice(0, 7)}/${day}.jsonl`,
      iface: 'fake',
      lines: [
        {
          v: 1,
          id: `rec-${post.id}`,
          kind: 'said',
          messageId: post.id,
          revision: 1,
          occurredAt,
          recordedAt: occurredAt,
          placeId: ROOT,
          scope: { channel: 'd1' },
          text: post.text,
          origin: 'live',
        },
      ],
    });
  }
}

/**
 * Memory as the scene needs it: the guild's notes, the channel notes, two recent lines and the two earlier entries
 * with their text (the text the diary media job fills in from the interface). With `mirror`, also the place `d1` of
 * the fake interface, named `journal`, and the diary's one enabled mirror on it. With `published` and no mirror, the
 * place `d1` is where both earlier entries were published (their publications name it), and its record holds them as
 * her lines.
 */
export async function sceneMemory({
  mirror,
  published = false,
}: {
  mirror: boolean;
  published?: boolean;
}): Promise<SceneMemory> {
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'fake' });
  const store = createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb });
  store.updatePlace(placeOfRoot(store, ROOT), { patterns: 'people greet each other in Greek' });
  for (const [id, name, purpose] of [
    ['d1', 'journal', 'her own diary'],
    ['c1', 'general', 'everyday talk'],
  ] as const) {
    store.touchChannel(placeOfChat(store, { id: id }), { name }, NOW - 2 * HOUR);
    store.updateChannel(placeOfChat(store, { id: id }), { purpose });
  }
  store.applyRecentOps(
    placeOfRoot(store, ROOT),
    [
      { text: 'Alice is planning a trip to Thessaloniki', at: NOW - 2 * HOUR, placeId: 'c1', weight: 1 },
      { text: 'a quiet harbour', at: NOW - 2 * HOUR, placeId: 'd1', weight: 1 },
    ],
    { now: NOW, hours: 24 }
  );
  for (const post of EARLIER) {
    // The store's JSDoc types `search` as a string; a post with no search stores null, as the diary turn records it.
    const stored: Record<string, unknown> = {
      at: post.at,
      kind: 'status',
      gist: post.text,
      picture: null,
      messageIds: [post.id],
      search: null,
    };
    store.appendSelfreflectionPost(stored as Parameters<typeof store.appendSelfreflectionPost>[0], { max: 40 });
  }
  store.flush();
  await store.flushSettled({});
  const db = dbOf(memory.memoryDb);
  for (const post of EARLIER) db.prepare('UPDATE selfreflection SET text = ? WHERE at_ms = ?').run(post.text, post.at);
  // Before schema v15 there is no `mirrors` table to seed: the scene then fails where the turn needs its chat,
  // which is what the test is about, and not here.
  const hasMirrors = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mirrors'").all().length > 0;
  if (mirror && hasMirrors) seedMirror(memory.memoryDb, { iface: 'fake', chatId: 'd1', name: 'journal', at: NOW });
  if (published) {
    const place = seedPlace(memory.memoryDb, { iface: 'fake', chatId: 'd1', name: 'journal', at: NOW });
    db.prepare("UPDATE publications SET destination_place_id = ? WHERE row_kind = 'selfreflection'").run(place);
    await seedRecord(memory.memoryDb);
  }
  // Her channels sit under the server, as the observation of their first lines leaves them.
  for (const id of ['d1', 'c1'])
    db.prepare('UPDATE places SET parent_id = ? WHERE id = ?').run(
      placeOfRoot(store, ROOT),
      placeOfChat(store, { id })
    );
  return { memory, store };
}

/** What the scene's runner offers a test: one turn at a time. */
export type SceneRunner = { runTurn(params: Record<string, unknown>): Promise<unknown> };

/** The real turn runner over the scene's world, store, settings and model. */
export function sceneRunner(llm: ReturnType<typeof sceneLlm>, store: SceneMemory['store']): SceneRunner {
  return worldTurnRunner({
    hot: sceneHot(),
    store,
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    images: null,
    lookup: null,
    rng: () => 0.5,
    now: () => NOW,
  });
}
