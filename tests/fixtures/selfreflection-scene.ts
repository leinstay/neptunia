// A selfreflection scene: one selfreflection wake of the real turn runner over the fake interface and a real store over
// a memory database, with a scripted model, on fixed inputs that reach every block a selfreflection request can carry.
// Memory holds two earlier entries with their text, the place `d1` named `journal` with the one enabled mirror on it, the
// place `c1` named `general`, recent lines of both and the server's notes. Synthetic text only.
import { placeOfRoot, placeOfChat } from '../../src/memory/addresses.ts';
import { createStore } from '../../src/memory/store.ts';
import { insertRows } from '../../src/memory/db/rows.ts';
import { dbOf } from '../../src/memory/db/types.ts';
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
export const SERVER = 'g1';

/** The planner's purpose, the model call whose request is the plan. */
export const PLANNER_PURPOSE = 'selfreflection-planner';

/** The settings of the scene: recent lines shown, no pictures, the mirror place set. */
export function sceneHot(): { config: Record<string, unknown>; prompts: Record<string, unknown> } {
  return {
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
  complete: (
    messages: unknown,
    options?: { purpose?: string }
  ) => Promise<{ text: string; usage: object; estimated: number }>;
} {
  const calls: Array<unknown> = [];
  return {
    calls,
    complete: (messages, options) => {
      calls.push(structuredClone(messages));
      const text =
        options?.purpose === PLANNER_PURPOSE
          // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
          ? planAnswerText({ kind: 'status', brief: 'a calm evening', search: '', picture: false }, options)
          : '<msg>ήσυχο βράδυ στο λιμάνι</msg>';
      return Promise.resolve({ text, usage: {}, estimated: 5 });
    },
  };
}

/** The interface's world: the server's other chat and the mirror place, empty, so history can only come from memory. */
export function sceneWorld({ restricted = false }: { restricted?: boolean } = {}): void {
  world().channel({ id: 'c1', name: 'general', placeId: SERVER });
  world().channel({ id: 'd1', name: 'journal', placeId: SERVER, historyMessages: [] });
  if (restricted) world().channel({ id: 's1', name: 'staff-room', placeId: SERVER, audience: STAFF_ONLY });
}

/** The audience of a channel only one role reads: narrower than the mirror place's, which everyone reads. */
const STAFF_ONLY = {
  everyone: false,
  groups: ['staff'],
  groupAllow: ['staff'],
  groupDeny: [] as Array<string>,
  memberAllow: [] as Array<string>,
  memberDeny: [] as Array<string>,
  memberGroups: {} as Record<string, Array<string>>,
};

const EARLIER = [
  { id: 'm1', at: NOW - 2 * DAY, text: 'χθες βράδυ στο λιμάνι' },
  { id: 'm2', at: NOW - DAY, text: 'une journée grise au port' },
] as const;

/** The memory of the scene: the service and the real store over it. */
export type SceneMemory = {
  memory: Awaited<ReturnType<typeof openTestMemory>>;
  store: ReturnType<typeof createStore>;
};

/**
 * Memory as the scene needs it: the server's notes, the notes of both channels, two recent lines, the two earlier
 * entries with their text (written through `store.appendSelfreflectionPost`, then given their text as the media job
 * does), and the place `d1` with the one enabled mirror on it.
 */
export async function sceneMemory({ restricted = false }: { restricted?: boolean } = {}): Promise<SceneMemory> {
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'fake' });
  const db = dbOf(memory.memoryDb.readHandle() as { db: unknown });
  const store = createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb });
  store.updatePlace(placeOfRoot(store, SERVER), { patterns: 'people greet each other in Greek' });
  const channels: Array<readonly [string, string, string]> = [
    ['d1', 'journal', 'her own diary'],
    ['c1', 'general', 'everyday talk'],
  ];
  if (restricted) channels.push(['s1', 'staff-room', 'private planning']);
  for (const [id, name, purpose] of channels) {
    store.touchChannel(placeOfChat(store, { id }), { name }, NOW - 2 * HOUR);
    store.updateChannel(placeOfChat(store, { id }), { purpose });
  }
  store.applyRecentOps(
    placeOfRoot(store, SERVER),
    [
      { text: 'Alice is planning a trip to Thessaloniki', at: NOW - 2 * HOUR, placeId: 'c1', weight: 1 },
      { text: 'a quiet harbour', at: NOW - 2 * HOUR, placeId: 'd1', weight: 1 },
    ],
    { now: NOW, hours: 24 }
  );
  for (const post of EARLIER) {
    // The store's JSDoc types `search` as a string; an entry with no search stores null, as the turn records it.
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
  for (const post of EARLIER) db.prepare('UPDATE selfreflection SET text = ? WHERE at_ms = ?').run(post.text, post.at);
  insertRows(
    db,
    {
      places: [
        { id: 'fake:channel:d1', iface: 'fake', kind: 'channel', native_id: 'd1', parent_id: null, scope_kind: 'group', name: 'journal' },
      ],
    },
    { at: new Date(NOW).toISOString() }
  );
  for (const [id] of channels)
    db.prepare('UPDATE places SET parent_id = ? WHERE id = ?').run(
      placeOfRoot(store, SERVER),
      placeOfChat(store, { id })
    );
  db.prepare(
    "INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by, extra) VALUES (?, 'selfreflection', ?, 1, ?, 'owner', NULL)"
  ).run('mirror:test:fake:channel:d1', 'fake:channel:d1', new Date(NOW).toISOString());
  return { memory, store };
}

/** The real turn runner over the scene's world, store, settings and model. */
export function sceneRunner(
  llm: ReturnType<typeof sceneLlm>,
  store: SceneMemory['store']
): { runTurn(params: Record<string, unknown>): Promise<unknown> } {
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
