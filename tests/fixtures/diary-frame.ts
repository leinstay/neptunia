// One diary turn on the turn frame (plan 2026-11-06-turn-frame, slice 6): the real turn runner with
// `chat: null`, a real store over a real memory service, the graph reader and `<meanwhile>` reading that one
// database, and a fake model that answers the planner with a fixed plan and the writer with the test's answer. The
// world of the memory database, with made-up names in Greek and accented Latin:
//   interface `fake`, root `g1` "Αγορά", room `c2` "κήπος"; interface `tele`, root `t1` "Νησί", room `k1` "λιμάνι"
//   Ελένη (`fake:111`), who wrote in `c2` right before her line there
//   Ζωή (`fake:5678`), with a direct chat `fake:dm:5678` holding a line of hers
// Her own lines: one in `c2`, one in `k1` and one in the direct chat with Ζωή. The mirrors and the stored entries are
// the test's. No network, no provider.
import { after } from 'node:test';
import { userText } from '../../src/behavior/prompt.ts';
import { createStore } from '../../src/memory/store.ts';
import { insertRows } from '../../src/memory/db/rows.ts';
import '../../src/tools/operations/index.ts';
import { addDm, addLine, addPerson, addRoom, noteInterface, rootId } from './memory-db/mind-world.ts';
import { openTestMemory } from './memory-db/service.ts';
import { planAnswerText } from './plan-answer.ts';
import { dbOf, seedMirror } from './diary-mirror.ts';
import type { MemoryService } from './diary-mirror.ts';
import { shippedLabels } from './shipped-labels.ts';
import { completionOf } from './tool-answers.ts';
import { withCapturedLogs } from './capture-logs.ts';
import { freshWorld, useIface, useSelf, world } from './turn-world.ts';
import type { Fake } from './turn-world.ts';
import { worldTurnRunner } from './world-runner.ts';

useIface('fake');
useSelf('self-id');

export const FRAME_NOW = Date.parse('2026-11-02T12:00:00.000Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const iso = (at: number): string => new Date(at).toISOString();

/** Marker texts of the two prompt files, so a test reads which file framed a request without reading any wording. */
export const MARK = { writer: 'MARK-DIARY-TASK', planner: 'MARK-DIARY-PLANNER' } as const;

/** The texts the world's lines and files carry, each unique so a test finds it in one block. */
export const TEXT = {
  ownGarden: 'ΔΙΚΗ-ΤΗΣ-ΚΗΠΟΣ',
  ownHarbour: 'ΔΙΚΗ-ΤΗΣ-ΛΙΜΑΝΙ',
  ownPrivate: 'ΔΙΚΗ-ΤΗΣ-ΙΔΙΩΤΙΚΗ',
  eleniGarden: 'ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ',
  /** A line of hers stored in the first mirror's place that no entry names. */
  mirrorOnly: 'ΜΟΝΟ-ΣΤΟΝ-ΚΑΘΡΕΦΤΗ',
  entry: 'ήσυχο βράδυ στο λιμάνι',
  /** Ελένη's line that holds the custom emoji `e1`. */
  emojiLine: 'ΚΑΡΑΒΑΚΙ :e1:',
} as const;

/** The custom emoji `e1` of `FrameTurnSpec.emoji`: its platform name. */
export const EMOJI_NAME = 'καραβάκι';

/** The plan the planner answers. */
export const PLAN = { kind: 'status', brief: 'ΗΣΥΧΟ-ΒΡΑΔΥ-ΣΤΟ-ΛΙΜΑΝΙ', search: '', picture: false } as const;

/** A mirror of her diary: a group chat of an interface. */
export type MirrorSpec = { iface: string; chatId: string; name: string };

export const JOURNAL: MirrorSpec = { iface: 'fake', chatId: 'd1', name: 'ημερολόγιο' };
export const PAGES: MirrorSpec = { iface: 'tele', chatId: 'k9', name: 'σελίδες' };

/** The gist of stored entry `index`: `ΣΕΛΙΔΑ-007` for 7, so no gist is a part of another. */
export const gistOf = (index: number): string => `ΣΕΛΙΔΑ-${String(index).padStart(3, '0')}`;

export type FrameTurnSpec = {
  /** The memory service to run over, a mirror scene's for instance; a fresh one at FRAME_NOW when absent. */
  memory?: { memoryDb: MemoryService; dataDir: string };
  /** The enabled mirrors seeded before the turn. */
  mirrors?: ReadonlyArray<MirrorSpec>;
  /** How many entries are stored before the turn, the oldest first, one a day up to the day before FRAME_NOW. */
  entries?: number;
  /** The gist and text of entry `i`, `gistOf(i)` when absent. */
  entryGist?: (index: number) => string;
  /** How many turns run one after the other over the same memory, 1 when absent. */
  turns?: number;
  /** Laid over the `diary` settings, which set `entries` and the planner's limits. */
  diary?: Record<string, unknown>;
  /** Laid over the `context` settings, such as `myDay`. */
  context?: Record<string, unknown>;
  /** The moments of more lines of hers in the garden `c2`, written before the turn. */
  gardenLines?: ReadonlyArray<number>;
  /** Laid over the `context.memory` settings, `openPrivate` for instance. */
  memorySettings?: Record<string, unknown>;
  /** The writer's answer. */
  answer?: string;
  /** Prompt files laid over the turn's own, `appearance` for instance. */
  prompts?: Record<string, unknown>;
  /**
   * A custom emoji the store names `e1` before the turn: `named` names it alone, `line` adds Ελένη's line in `c2` that
   * holds it (`TEXT.emojiLine`).
   */
  emoji?: 'named' | 'line';
};

export type FrameTurnRun = {
  result: unknown;
  /** The text of every message of each writer request, joined. */
  writer: Array<string>;
  /** The same of each planner request. */
  planner: Array<string>;
  port: Fake;
};

/** The memory services the turns opened, closed when the test file is done. */
const OPEN: Array<{ close(): unknown }> = [];
after(async () => {
  for (const item of OPEN.splice(0)) await item.close();
});

/** The world of the head of this file in `memoryDb`. */
function seedWorld(memoryDb: MemoryService): void {
  const db = dbOf(memoryDb);
  const handle = memoryDb.readHandle();
  if (handle === null) throw new Error('the memory database is not open');
  const mind = { handle, db, close: () => {} };
  noteInterface(mind, 'fake', [{ id: 'g1', name: 'Αγορά' }]);
  noteInterface(mind, 'tele', [{ id: 't1', name: 'Νησί' }]);
  const garden = addRoom(db, { iface: 'fake', native: 'c2', root: rootId('fake', 'g1'), name: 'κήπος' });
  const harbour = addRoom(db, { iface: 'tele', native: 'k1', root: rootId('tele', 't1'), name: 'λιμάνι' });
  addPerson(db, { id: 'person:fake:111', accounts: [{ id: 'fake:111', iface: 'fake', native: '111', names: ['Ελένη'] }] });
  addPerson(db, { id: 'person:fake:5678', accounts: [{ id: 'fake:5678', iface: 'fake', native: '5678', names: ['Ζωή'] }] });
  const zoeDm = addDm(db, { iface: 'fake', native: '5678', person: 'person:fake:5678', account: 'fake:5678' });
  addLine(db, { id: 'g0', iface: 'fake', place: garden, author: 'fake:111', text: TEXT.eleniGarden, at: iso(FRAME_NOW - 51 * MIN) });
  addLine(db, { id: 'g1', iface: 'fake', place: garden, author: 'self', text: TEXT.ownGarden, at: iso(FRAME_NOW - 50 * MIN) });
  addLine(db, { id: 'h1', iface: 'tele', place: harbour, author: 'self', text: TEXT.ownHarbour, at: iso(FRAME_NOW - 40 * MIN) });
  addLine(db, {
    id: 'd1',
    iface: 'fake',
    place: zoeDm,
    author: 'self',
    text: TEXT.ownPrivate,
    at: iso(FRAME_NOW - 30 * MIN),
    audience: { dm: zoeDm, iface: 'fake', person: 'person:fake:5678' },
  });
}

/** `count` group entries of hers, the oldest first, entry `i` with the gist `gist(i)`, `gistOf(i)` by default. */
function seedEntries(memoryDb: MemoryService, count: number, gist: (index: number) => string = gistOf): void {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `diary:test:${String(i).padStart(3, '0')}`,
    at_ms: FRAME_NOW - (count - i) * DAY,
    kind: 'status',
    gist: gist(i),
    text: gist(i),
    scope_kind: 'group',
    scope_iface: 'fake',
    scope_dm: null,
    extra: JSON.stringify({ publicationAudience: { kind: 'unrestricted' } }),
    position: i,
  }));
  if (rows.length > 0) insertRows(dbOf(memoryDb), { diary: rows }, { at: iso(FRAME_NOW - DAY) });
}

/** The settings and prompts of the turn. `diary.world` and `diary.historyPosts` are gone. */
function frameHot(spec: FrameTurnSpec): { config: Record<string, unknown>; prompts: Record<string, unknown> } {
  return {
    config: {
      bot: { timezone: 'UTC' },
      context: {
        channelMessages: 100,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { fetchTimeoutMs: 10_000 },
        pull: { sameAudience: true },
        meanwhile: { messages: 8, around: 2 },
        recall: { extractChars: 1200, maxItems: 6 },
        memory: { serviceMessages: 100, windowMessages: 100, maxHops: 2, budgetTokens: 10_000, ...spec.memorySettings },
        ...spec.context,
      },
      llm: { maxRequestTokens: 100_000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [0, 0], minMs: 0, maxMs: 0, betweenMessagesMs: [0, 0] },
      // Slice 6: the setting is `diary.entries`.
      diary: { entries: 150, planMaxOutputTokens: 250, planTimeoutMs: 15000, ...spec.diary },
    },
    prompts: {
      'system-prompt': 'SYSTEM for {{name}}',
      'character-card': 'CARD_TEXT',
      format: 'FORMAT_TEXT',
      diary: MARK.writer,
      'diary-planner': MARK.planner,
      'diary-seeds': '# place\na pier\n# light\nfog',
      draw: 'DRAW for {{name}}\n{{when}}\n{{request}}',
      labels: shippedLabels,
      ...spec.prompts,
    },
  };
}

/** One diary turn with `chat: null` over the world above, the given mirrors and entries. */
export async function frameTurn(spec: FrameTurnSpec = {}): Promise<FrameTurnRun> {
  freshWorld();
  let memory = spec.memory;
  if (memory === undefined) {
    const opened = await openTestMemory({ now: () => FRAME_NOW, iface: () => 'fake' });
    OPEN.push(opened);
    memory = opened;
  }
  const { memoryDb, dataDir } = memory;
  seedWorld(memoryDb);
  for (const mirror of spec.mirrors ?? [JOURNAL]) seedMirror(memoryDb, { ...mirror, at: FRAME_NOW - 2 * DAY });
  const first = spec.mirrors?.[0] ?? JOURNAL;
  addLine(dbOf(memoryDb), {
    id: 'mirror-only',
    iface: first.iface,
    place: `${first.iface}:channel:${first.chatId}`,
    author: 'self',
    text: TEXT.mirrorOnly,
    at: iso(FRAME_NOW - 3 * DAY),
  });
  seedEntries(memoryDb, spec.entries ?? 3, spec.entryGist);
  for (const [index, at] of (spec.gardenLines ?? []).entries())
    addLine(dbOf(memoryDb), {
      id: `g-more-${index}`,
      iface: 'fake',
      place: 'fake:channel:c2',
      author: 'self',
      text: TEXT.ownGarden,
      at: iso(at),
    });
  const store = createStore({ dataDir, memoryDb });
  if (spec.emoji) store.nameMedia('fake', 'emoji', [{ nativeId: '7301', platformName: EMOJI_NAME, animated: false }]);
  if (spec.emoji === 'line')
    addLine(dbOf(memoryDb), {
      id: 'g2',
      iface: 'fake',
      place: 'fake:channel:c2',
      author: 'fake:111',
      text: TEXT.emojiLine,
      at: iso(FRAME_NOW - 45 * MIN),
    });
  const writer: Array<string> = [];
  const planner: Array<string> = [];
  const llm = {
    complete: (messages: Array<{ content: unknown }>, options?: { purpose?: string }) => {
      const text = messages.map((message) => userText(message.content)).join('\n');
      if (options?.purpose === 'diary-planner') {
        planner.push(text);
        // The planner answers in strict JSON (owner, 2026-11-06): her output here, never the request's.
        return Promise.resolve({ text: planAnswerText(PLAN, options), usage: {}, estimated: 5 });
      }
      writer.push(text);
      return Promise.resolve(completionOf(spec.answer ?? `<msg>${TEXT.entry}</msg>`));
    },
  };
  let contexts = 0;
  const turns = worldTurnRunner({
    hot: frameHot(spec),
    store,
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    images: null,
    lookup: null,
    rng: () => 0.5,
    now: () => FRAME_NOW,
    journalDb: () => memoryDb.readHandle()?.db ?? null,
    memoryContext: (given: Record<string, unknown>) =>
      memoryDb.issueContext({ iface: 'fake', ...given, newId: () => `ctx:diary:${(contexts += 1)}` }),
  });
  const { result } = await withCapturedLogs(async () => {
    let last: unknown = null;
    for (let turn = 0; turn < (spec.turns ?? 1); turn += 1)
      last = await turns.runTurn({ chat: null, mode: 'diary', diary: { kind: 'status', forced: true } });
    return last;
  });
  await store.flushSettled({});
  return { result, writer, planner, port: world().port };
}

/** The body of the subtag `<tag>` of a block's body, '' when absent. */
export function partOf(block: string, tag: string): string {
  return new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(block)?.[1] ?? '';
}

/** The body of the root block `<tag>` of a request's text, '' when absent. */
export function blockOf(text: string, tag: string): string {
  return new RegExp(`^<${tag}>\\n([\\s\\S]*?)\\n</${tag}>$`, 'm').exec(text)?.[1] ?? '';
}

/** The root tags of a request's text, in order: a line `<tag>` that a line `</tag>` closes. */
export function rootTags(text: string): Array<string> {
  return [...text.matchAll(/^<([a-z_]+)>\n[\s\S]*?\n<\/\1>$/gm)].map((match) => match[1] ?? '');
}

/** Whether `tags` keep the order of `list` and hold nothing else. */
export function inOrderOf(tags: ReadonlyArray<string>, list: ReadonlyArray<string>): boolean {
  let at = -1;
  for (const tag of tags) {
    const next = list.indexOf(tag, at + 1);
    if (next < 0) return false;
    at = next;
  }
  return true;
}
