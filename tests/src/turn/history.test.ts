// Tests for src/turn/history.ts#orderedHistory: every line of a turn's chat and every call mark of the persona's,
// sorted by time once, after the reply parents, the deleted placeholders and the continuation lines are in. A mark is a
// line of its own (`self: true`, `kind: 'call'`, the call's time). Pure.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Line } from '../../../src/behavior/lines.ts';
import { orderedHistory } from '../../../src/turn/history.ts';
import { addLine, type World } from '../../fixtures/memory-db/mind-world.ts';
import {
  blockOf,
  C1_CHAT,
  type ReplyChat,
  type ReplyLine,
  replyRun,
  type ReplyRun,
  type ReplyStep,
  serviceWorld,
  TURN_NOW,
} from '../../fixtures/service-turn.ts';
import { useIface } from '../../fixtures/turn-world.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 5, 10, 0, 0);
const NOW = T0 + 60 * MIN;
const PLACE = 'discord:channel:room-1';

/** A line of the chat by Zoé, or the persona's with `self`. */
function line(id: string, ts: number, self = false): Line {
  return {
    id,
    placeId: PLACE,
    authorId: self ? 'me' : 'u1',
    authorName: self ? 'Nept' : 'Zoé',
    content: id,
    self,
    ts,
    reactions: [],
  };
}

/** One call of the persona's made in this place, as the journal's call marks hold it. */
const mark = (at: number) => ({ placeId: PLACE, at, skill: 'memory.search', status: 'ok' });

/** The order of the result: a line by its id, a call mark as `mark`. */
const orderOf = (lines: ReadonlyArray<Line>) => lines.map((one) => (one.kind === 'call' ? 'mark' : one.id));

test("a call mark made between two messages stands between them, as a line of the persona's at the call time", () => {
  // Bug: a mark rides on the line before it, or after the persona's last line, and the call reads as later than what
  // answered it.
  const result = orderedHistory([line('m1', T0), line('m2', T0 + 10 * MIN)], [mark(T0 + 5 * MIN)], NOW);
  assert.deepEqual(orderOf(result), ['m1', 'mark', 'm2']);
  const own = result.find((one) => one.kind === 'call');
  assert.equal(own?.self, true);
  assert.equal(own?.ts, T0 + 5 * MIN);
});

test('a call mark at the same instant as a message comes after the message', () => {
  // Bug: the tie falls to input order, so the call reads as made before the message that led to it.
  const result = orderedHistory([line('m1', T0), line('m2', T0 + 5 * MIN)], [mark(T0 + 5 * MIN)], NOW);
  assert.deepEqual(orderOf(result), ['m1', 'm2', 'mark']);
});

test('a continuation line older than a line of the base history sorts before it', () => {
  // Bug: the continuation's lines are appended after the base, so a line written earlier is numbered later.
  const result = orderedHistory([line('b1', T0), line('b2', T0 + 10 * MIN), line('c1', T0 + 5 * MIN, true)], [], NOW);
  assert.deepEqual(orderOf(result), ['b1', 'c1', 'b2']);
});

const REPLY_TURN_CHAT_NUMBERS_MIN = 60_000;

const THINK = '<think>STEP 4. So: answer.</think>';

const SKIP = `${THINK}<skip/>`;

// The head moves with every line in these tests: the step of the head has its own tests below.
const WINDOW = { channelMessages: 3, chatHeadStep: 0 };

const iso = (at: number): string => new Date(at).toISOString();

/** The texts of the lines, each unique so a test finds its line in one block. */
const TEXT = {
  room: 'ΓΡΑΜΜΗ-ΤΟΥ-ΓΕΝΙΚΑ',
  alpha: 'ΑΛΦΑ-ΓΡΑΜΜΗ',
  beta: 'ΒΗΤΑ-ΓΡΑΜΜΗ',
  gamma: 'ΓΑΜΜΑ-ΓΡΑΜΜΗ',
  delta: 'ΔΕΛΤΑ-ΓΡΑΜΜΗ',
  garden: 'ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ',
} as const;

/** The lines that join `c1` after the world's `r1` (five minutes before the turns' clock), one minute apart. */
const ALPHA: ReplyLine = { id: 'a1', text: TEXT.alpha, at: TURN_NOW - 4 * REPLY_TURN_CHAT_NUMBERS_MIN };

const BETA: ReplyLine = { id: 'b1', text: TEXT.beta, at: TURN_NOW - 3 * REPLY_TURN_CHAT_NUMBERS_MIN };

const GAMMA: ReplyLine = { id: 'c1x', text: TEXT.gamma, at: TURN_NOW - 2 * REPLY_TURN_CHAT_NUMBERS_MIN };

const DELTA: ReplyLine = { id: 'd1', text: TEXT.delta, at: TURN_NOW - REPLY_TURN_CHAT_NUMBERS_MIN };

/** Writes `lines` to the world's memory as lines of `chat`'s place, by Ελένη, as the memory writer stores them. */
const store = (world: World, chat: ReplyChat, lines: ReadonlyArray<ReplyLine>): void => {
  for (const line of lines)
    addLine(world.db, {
      id: `src:${chat.iface}:${line.id}:1`,
      iface: chat.iface,
      place: chat.place,
      author: `${chat.iface}:${line.authorId ?? '111'}`,
      text: line.text,
      at: iso(line.at),
    });
};

/** A step whose lines and trigger are stored before its turn. */
const storedStep = (world: World, chat: ReplyChat, step: ReplyStep): ReplyStep => ({
  ...step,
  before: () => {
    step.before?.();
    store(world, chat, [...(step.lines ?? []), step.trigger]);
  },
});

/** Reply turns in `c1` with a window of three lines, over a world made for the run. */
async function inRoom(
  steps: (world: World) => ReadonlyArray<ReplyStep>,
  options: { restartBefore?: number; world?: () => World } = {}
): Promise<ReplyRun> {
  const world = (options.world ?? serviceWorld)();
  try {
    return await replyRun({
      world,
      context: WINDOW,
      steps: steps(world).map((step) => storedStep(world, C1_CHAT, step)),
      ...(options.restartBefore === undefined ? {} : { restartBefore: options.restartBefore }),
    });
  } finally {
    world.close();
  }
}

/** The user text of request `step` of turn `turn` of a run, '' when there is none. */
const requestOf = (run: ReplyRun, turn: number, step = 0): string => {
  const requests = run.requests[turn] ?? [];
  return requests[step] ?? '';
};

/** The rows of a text. */
const rowsOf = (text: string): Array<string> => text.split('\n');

/** The row of `text` that holds `marker`, '' when none does. */
const rowWith = (text: string, marker: string): string => rowsOf(text).find((row) => row.includes(marker)) ?? '';

/** The `#N` that opens the row of `text` holding `marker`, null when that row opens with none. */
const numberOf = (text: string, marker: string): string | null => /^#\d+\b/.exec(rowWith(text, marker))?.[0] ?? null;

/** The rows of a `<chat>` up to its last numbered line, the tempo rows after it left out. */
const linesPart = (chat: string): Array<string> => {
  const rows = rowsOf(chat);
  const last = rows.findLastIndex((row) => /^#\d+ /.test(row));
  return rows.slice(0, last + 1);
};

// The head of the window moves in steps so that a cached request stays stable: the window holds
// `context.channelMessages` lines at its smallest and grows by the new lines, and its first line is the place's line
// numbered h = max(1, s * floor((L - n + 1) / s)), L the newest line's number, n `channelMessages` and s
// `context.chatHeadStep`. With s = 0 the head moves with every line, h = L - n + 1. Here n is 3 and s is 4: the room
// line `r1` is #1, and the window starts at #1 until the place's sixth line, then at #4 until its tenth.

const HEAD = { channelMessages: 3, chatHeadStep: 4 };

/** Lines of `c1` after `r1`, one per turn after the first two. A gap of half an hour stands before ΓΑΜΜΑ, line #4. */
const RUN: ReadonlyArray<ReplyLine> = [
  { id: 'h2', text: 'ΑΛΦΑ-ΚΕΦΑΛΗ', at: TURN_NOW - 4 * REPLY_TURN_CHAT_NUMBERS_MIN },
  { id: 'h3', text: 'ΒΗΤΑ-ΚΕΦΑΛΗ', at: TURN_NOW - 3 * REPLY_TURN_CHAT_NUMBERS_MIN },
  { id: 'h4', text: 'ΓΑΜΜΑ-ΚΕΦΑΛΗ', at: TURN_NOW + 30 * REPLY_TURN_CHAT_NUMBERS_MIN },
  { id: 'h5', text: 'ΔΕΛΤΑ-ΚΕΦΑΛΗ', at: TURN_NOW + 31 * REPLY_TURN_CHAT_NUMBERS_MIN },
  { id: 'h6', text: 'ΕΨΙΛΟΝ-ΚΕΦΑΛΗ', at: TURN_NOW + 32 * REPLY_TURN_CHAT_NUMBERS_MIN },
  { id: 'h7', text: 'ΖΗΤΑ-ΚΕΦΑΛΗ', at: TURN_NOW + 33 * REPLY_TURN_CHAT_NUMBERS_MIN },
];

const replyTurnChatNumbersLine = (n: number): ReplyLine => RUN[n - 2] ?? { id: 'none', text: 'none', at: TURN_NOW };

/** Turns over `c1`: the first answers #3 with #2 joining before it, each later one answers the next line of RUN. */
const headSteps = (turns: number): ReadonlyArray<ReplyStep> => [
  { lines: [replyTurnChatNumbersLine(2)], trigger: replyTurnChatNumbersLine(3), answers: [SKIP] },
  ...Array.from({ length: turns - 1 }, (_, i) => ({ trigger: replyTurnChatNumbersLine(4 + i), answers: [SKIP] })),
];

/** The `<chat>` of every turn of a run of `turns` turns in `c1` under `context`. */
async function headRun(
  turns: number,
  context: Record<string, unknown>,
  options: { restartBefore?: number } = {}
): Promise<Array<string>> {
  const world = serviceWorld();
  try {
    const run = await replyRun({
      world,
      context,
      steps: headSteps(turns).map((step) => storedStep(world, C1_CHAT, step)),
      ...(options.restartBefore === undefined ? {} : { restartBefore: options.restartBefore }),
    });
    return run.requests.map((requests) => blockOf(requests[0] ?? '', 'chat'));
  } finally {
    world.close();
  }
}

/** The rows of a `<chat>` that hold a numbered line. */
const lineRows = (chat: string): Array<string> => rowsOf(chat).filter((row) => /^#\d+ /.test(row));

describe('chat numbers in a reply turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('a line keeps its number in the next turn when the oldest line leaves the window', async () => {
    // Bug: the window numbers its lines #1 to #n, so when a new line pushes the oldest out, every line shown moves down
    // by one and the same line reads #2 in one turn and #1 in the next.
    const run = await inRoom(() => [
      { lines: [ALPHA], trigger: BETA, answers: [SKIP] },
      { trigger: GAMMA, answers: [SKIP] },
    ]);
    const first = blockOf(requestOf(run, 0), 'chat');
    const second = blockOf(requestOf(run, 1), 'chat');
    assert.match(first, new RegExp(TEXT.room), 'the first window holds the room line');
    assert.doesNotMatch(second, new RegExp(TEXT.room), 'the room line left the second window');
    assert.match(numberOf(first, TEXT.alpha) ?? '', /^#\d+$/, 'the line has a number');
    assert.equal(numberOf(second, TEXT.alpha), numberOf(first, TEXT.alpha));
    assert.equal(numberOf(second, TEXT.beta), numberOf(first, TEXT.beta));
  });

  test("the next turn's <chat> starts with the turn before's, less the line that left, byte for byte", async () => {
    // Bug: anything that changes the rows of lines both windows hold (a number, a marker, the head) breaks the repeat the
    // prompt cache reads, though nothing but one new line and one gone line happened.
    const run = await inRoom(() => [
      { lines: [ALPHA], trigger: BETA, answers: [SKIP] },
      { trigger: GAMMA, answers: [SKIP] },
    ]);
    const first = blockOf(requestOf(run, 0), 'chat');
    const second = blockOf(requestOf(run, 1), 'chat');
    const kept = linesPart(first).filter((row) => !row.includes(TEXT.room));
    assert.ok(
      kept.some((row) => row.includes(TEXT.beta)),
      'the kept rows hold the newest line of the first turn'
    );
    assert.ok(second.startsWith(`${kept.join('\n')}\n`), `${kept.join('\n')}\n---\n${second}`);
    assert.match(rowWith(second, TEXT.gamma), /^#\d+ /, 'the new line follows them with a number');
  });

  test('a line not yet stored when its turn runs keeps that number once memory stores it', async () => {
    // Bug: the line the persona answers reaches the turn before the memory writer stores it, so it is numbered one way in its own
    // turn and another once it is stored, and a number the persona used for it names nothing or another line.
    const world = serviceWorld();
    try {
      const run = await replyRun({
        world,
        context: WINDOW,
        steps: [
          // ΒΗΤΑ joins the chat unstored and is stored only before the next turn, the way observation lags.
          { before: () => store(world, C1_CHAT, [ALPHA]), lines: [ALPHA], trigger: BETA, answers: [SKIP] },
          { before: () => store(world, C1_CHAT, [BETA, GAMMA]), trigger: GAMMA, answers: [SKIP] },
          { before: () => store(world, C1_CHAT, [DELTA]), trigger: DELTA, answers: [SKIP] },
        ],
      });
      const first = blockOf(requestOf(run, 0), 'chat');
      const third = blockOf(requestOf(run, 2), 'chat');
      assert.match(numberOf(first, TEXT.beta) ?? '', /^#\d+$/, 'the unstored line has a number');
      assert.equal(numberOf(third, TEXT.beta), numberOf(first, TEXT.beta));
    } finally {
      world.close();
    }
  });

  test('between two drops of the head every <chat> starts with the whole <chat> of the turn before', async () => {
    // Bug: the window keeps a fixed count, so each new line pushes the oldest out and the block differs from its first
    // line on, which a prefix cache cannot reuse.
    const chats = await headRun(3, HEAD);
    for (const [turn, chat] of chats.entries()) {
      if (turn === 0) continue;
      const before = linesPart(chats[turn - 1] ?? '').join('\n');
      assert.ok(chat.startsWith(`${before}\n`), `turn ${turn + 1}:\n${before}\n---\n${chat}`);
    }
    assert.equal(lineRows(chats[2] ?? '').length, 5, 'the window grew to five lines');
  });

  test('the line that crosses the step drops the window to channelMessages lines, starting at the step', async () => {
    // Bug: the head drops by one line, or to another line than the place's #4, or the first line keeps the gap mark
    // measured to a line the window no longer shows, so the next drop's head is not a function of its first line.
    const chats = await headRun(5, HEAD);
    const dropped = chats[3] ?? '';
    const rows = lineRows(dropped);
    assert.equal(rows.length, 3, dropped);
    assert.match(rows[0] ?? '', /^#4 .*ΓΑΜΜΑ-ΚΕΦΑΛΗ/);
    assert.match(rowsOf(dropped)[1] ?? '', /^#4 /, 'the first line follows the day line with no gap mark before it');
    const next = chats[4] ?? '';
    assert.ok(next.startsWith(`${linesPart(dropped).join('\n')}\n`), `${dropped}\n---\n${next}`);
  });

  test('with context.chatHeadStep 0 the head moves with every line', async () => {
    // Bug: a step of 0 is read as a missing setting and the default step applies, so the window grows past its count.
    const chats = await headRun(2, { channelMessages: 3, chatHeadStep: 0 });
    const rows = lineRows(chats[1] ?? '');
    assert.equal(rows.length, 3, chats[1]);
    assert.match(rows[0] ?? '', /ΑΛΦΑ-ΚΕΦΑΛΗ/);
  });

  test('after a restart the head of the window is where it would have been', async () => {
    // Bug: the head is kept in the process, so after a restart the window starts at the newest lines again and the
    // block no longer starts with the one before the restart.
    const kept = await headRun(3, HEAD);
    const restarted = await headRun(3, HEAD, { restartBefore: 2 });
    assert.equal(restarted[2], kept[2]);
    assert.ok((restarted[2] ?? '').startsWith(`${linesPart(restarted[1] ?? '').join('\n')}\n`), restarted[2]);
  });
});
