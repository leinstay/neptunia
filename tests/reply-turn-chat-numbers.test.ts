// A line of `<chat>` keeps one number for as long as it stays in the window (the owner, 2026-11-11; plan 2026-11-10
// tools-and-reads, item 30; contract .agents/docs/specs/2026-11-11-chat-numbers-contract.md). The number is the line's
// place among the stored lines of its place, the oldest being 1, the number the owner's chat draws
// (src/memory/db/chat-lines.ts), so a turn adds lines at the end and renumbers none. Reply turns over the service world
// (tests/fixtures/service-turn.ts) with a window of three lines, a scripted model and synthetic names in Greek. Every
// line is written to the world's memory before its turn, as the memory writer stores what the interface observes,
// except where a test says otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatLines } from '../src/memory/db/chat-lines.ts';
import { addLine } from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { useIface } from './fixtures/turn-world.ts';
import { CLI_CHAT, C1_CHAT, TURN_NOW, blockOf, replyRun, serviceWorld } from './fixtures/service-turn.ts';
import type { ReplyChat, ReplyLine, ReplyRun, ReplyStep } from './fixtures/service-turn.ts';

useIface('fake');

const MIN = 60_000;
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
const ALPHA: ReplyLine = { id: 'a1', text: TEXT.alpha, at: TURN_NOW - 4 * MIN };
const BETA: ReplyLine = { id: 'b1', text: TEXT.beta, at: TURN_NOW - 3 * MIN };
const GAMMA: ReplyLine = { id: 'c1x', text: TEXT.gamma, at: TURN_NOW - 2 * MIN };
const DELTA: ReplyLine = { id: 'd1', text: TEXT.delta, at: TURN_NOW - MIN };

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
/** Every number that opens a row of `text`. */
const numbersOf = (text: string): Array<number> =>
  rowsOf(text).flatMap((row) => {
    const found = /^#(\d+)\b/.exec(row);
    return found ? [Number(found[1])] : [];
  });
/** What follows the `<task>` of a request: her answers and the results of her calls in a tool round. */
const afterTask = (request: string): string => request.split('</task>').slice(1).join('</task>');
/** How many times `marker` stands in `text`. */
const countOf = (text: string, marker: string): number => text.split(marker).length - 1;
/** The rows of a `<chat>` up to its last numbered line, the tempo rows after it left out. */
const linesPart = (chat: string): Array<string> => {
  const rows = rowsOf(chat);
  const last = rows.findLastIndex((row) => /^#\d+ /.test(row));
  return rows.slice(0, last + 1);
};

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

test('a reaction to a number of the turn before lands on the line that number named', async () => {
  // Bug: her stored think or her memory carries `#N` of the last turn, and in this turn the window has moved, so the
  // reaction goes on the line that slid into that number.
  let alpha = '#0';
  const run = await inRoom(() => [
    {
      lines: [ALPHA],
      trigger: BETA,
      answers: [
        (request: string): string => {
          alpha = numberOf(blockOf(request, 'chat'), TEXT.alpha) ?? '#0';
          return SKIP;
        },
      ],
    },
    { trigger: GAMMA, answers: [(): string => `${THINK}<react to="${alpha}">👍</react>`, SKIP] },
  ]);
  assert.notEqual(alpha, '#0', 'the first turn showed the line with a number');
  assert.deepEqual(
    run.reactions.map((one) => one.messageId),
    [ALPHA.id]
  );
});

test('a conversation.read around a number of the turn before reads the line that number named', async () => {
  // Bug: a number she carries into the next turn resolves through that turn's window, which has moved, so the read
  // opens on another line.
  let alpha = '#0';
  const run = await inRoom(() => [
    {
      lines: [ALPHA],
      trigger: BETA,
      answers: [
        (request: string): string => {
          alpha = numberOf(blockOf(request, 'chat'), TEXT.alpha) ?? '#0';
          return SKIP;
        },
      ],
    },
    {
      trigger: GAMMA,
      answers: [
        (): unknown => toolAnswer(THINK, [call('conversation.read', { around: alpha, before: '0', after: '0' })]),
        SKIP,
      ],
    },
  ]);
  const result = afterTask(requestOf(run, 1, 1));
  assert.equal(countOf(result, TEXT.alpha), 1, result);
  assert.equal(countOf(result, TEXT.beta), 0, 'the read opened on the line the number named and no other');
});

/** The service world with `count` stored lines of Ελένη in `c1` before its `r1`, a minute apart. */
const busyRoom = (count: number) => (): World => {
  const world = serviceWorld();
  for (let i = 0; i < count; i += 1)
    addLine(world.db, {
      id: `src:fake:old${i}:1`,
      iface: 'fake',
      place: C1_CHAT.place,
      author: 'fake:111',
      text: `ΠΑΛΙΑ-${i}`,
      at: iso(TURN_NOW - (60 + count - i) * MIN),
    });
  return world;
};

const READ_GARDEN = toolAnswer(THINK, [call('conversation.read', { place: 'κήπος', last: 10 })]);

test('the numbers of a read and of <recall> stand clear of the numbers of <chat> in a place with a long history', async () => {
  // Bug: the numbers of a read and of `<recall>` start past the window's size rather than past the highest number
  // `<chat>` shows, so in a place whose lines go by numbers in the twenties a read line takes a number a chat line holds.
  const run = await inRoom(
    () => [
      { lines: [ALPHA], trigger: BETA, answers: [READ_GARDEN, SKIP] },
      { trigger: GAMMA, answers: [SKIP] },
    ],
    { world: busyRoom(22) }
  );
  const chatOne = numbersOf(blockOf(requestOf(run, 0), 'chat'));
  const read = numbersOf(afterTask(requestOf(run, 0, 1)));
  const chatTwo = numbersOf(blockOf(requestOf(run, 1), 'chat'));
  const recall = numbersOf(blockOf(requestOf(run, 1), 'recall'));
  assert.ok(Math.min(...chatOne) > 3, `the chat goes by its place's numbers: ${chatOne.join(', ')}`);
  assert.ok(read.length > 0 && recall.length > 0, 'the read and <recall> number their lines');
  assert.deepEqual(
    read.filter((n) => chatOne.includes(n)),
    [],
    `read ${read.join(', ')} against chat ${chatOne.join(', ')}`
  );
  assert.deepEqual(
    recall.filter((n) => chatTwo.includes(n)),
    [],
    `recall ${recall.join(', ')} against chat ${chatTwo.join(', ')}`
  );
});

test('after a restart a line has the number it had before, and <chat> is what it would have been', async () => {
  // Bug: the numbers live in the process (a counter or an offset), so a restart between two answers numbers the window
  // anew and her context after the restart differs from the one she would have had.
  const steps = (): ReadonlyArray<ReplyStep> => [
    { lines: [ALPHA], trigger: BETA, answers: [SKIP] },
    { trigger: GAMMA, answers: [SKIP] },
  ];
  const kept = await inRoom(steps);
  const restarted = await inRoom(steps, { restartBefore: 1 });
  const before = blockOf(requestOf(restarted, 0), 'chat');
  const after = blockOf(requestOf(restarted, 1), 'chat');
  assert.match(numberOf(before, TEXT.alpha) ?? '', /^#\d+$/, 'the line has a number');
  assert.equal(numberOf(after, TEXT.alpha), numberOf(before, TEXT.alpha));
  assert.equal(after, blockOf(requestOf(kept, 1), 'chat'));
});

test('a line not yet stored when its turn runs keeps that number once memory stores it', async () => {
  // Bug: the line she answers reaches the turn before the memory writer stores it, so it is numbered one way in its own
  // turn and another once it is stored, and a number she used for it names nothing or another line.
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

/** A line of the owner's command line chat, by the owner's account. */
const ownerLine = (id: string, text: string, at: number): ReplyLine => ({ id, text, at, authorId: 'owner' });

test("the command line's <chat> shows each line by the number the owner's chat draws for it", async () => {
  // Bug: the owner sees `[#31]` before a line and she sees the same line as `#2`, so a number one of them names means
  // another line to the other.
  const world = serviceWorld();
  const older = Array.from({ length: 30 }, (_, i) => ownerLine(`o${i}`, `ΠΑΛΙΑ-${i}`, TURN_NOW - (60 - i) * MIN));
  store(world, CLI_CHAT, older);
  const recent = [ownerLine('n1', TEXT.alpha, TURN_NOW - 4 * MIN), ownerLine('n2', TEXT.beta, TURN_NOW - 3 * MIN)];
  try {
    const run = await replyRun({
      world,
      chat: CLI_CHAT,
      context: WINDOW,
      steps: [
        {
          before: () => store(world, CLI_CHAT, recent),
          lines: recent.slice(0, 1),
          trigger: recent[1] ?? ownerLine('n2', TEXT.beta, TURN_NOW - 3 * MIN),
          answers: [SKIP],
        },
      ],
    });
    const chat = blockOf(requestOf(run, 0), 'chat');
    const drawn = new Map(chatLines(world.db, CLI_CHAT.place).map((line) => [line.text, line.number]));
    assert.equal(drawn.get(TEXT.beta), 32, "the owner's chat draws the newest line as the count of the chat's lines");
    assert.equal(numberOf(chat, TEXT.alpha), `#${String(drawn.get(TEXT.alpha))}`);
    assert.equal(numberOf(chat, TEXT.beta), `#${String(drawn.get(TEXT.beta))}`);
  } finally {
    world.close();
  }
});

// The head of the window moves in steps (the lead, 2026-11-11, inside the owner's aim for item 30): the window holds
// `context.channelMessages` lines at its smallest and grows by the new lines, and its first line is the place's line
// numbered h = max(1, s * floor((L - n + 1) / s)), L the newest line's number, n `channelMessages` and s
// `context.chatHeadStep`. With s = 0 the head moves with every line, h = L - n + 1. Here n is 3 and s is 4: the room
// line `r1` is #1, and the window starts at #1 until the place's sixth line, then at #4 until its tenth.

const HEAD = { channelMessages: 3, chatHeadStep: 4 };
/** Lines of `c1` after `r1`, one per turn after the first two. A gap of half an hour stands before ΓΑΜΜΑ, line #4. */
const RUN: ReadonlyArray<ReplyLine> = [
  { id: 'h2', text: 'ΑΛΦΑ-ΚΕΦΑΛΗ', at: TURN_NOW - 4 * MIN },
  { id: 'h3', text: 'ΒΗΤΑ-ΚΕΦΑΛΗ', at: TURN_NOW - 3 * MIN },
  { id: 'h4', text: 'ΓΑΜΜΑ-ΚΕΦΑΛΗ', at: TURN_NOW + 30 * MIN },
  { id: 'h5', text: 'ΔΕΛΤΑ-ΚΕΦΑΛΗ', at: TURN_NOW + 31 * MIN },
  { id: 'h6', text: 'ΕΨΙΛΟΝ-ΚΕΦΑΛΗ', at: TURN_NOW + 32 * MIN },
  { id: 'h7', text: 'ΖΗΤΑ-ΚΕΦΑΛΗ', at: TURN_NOW + 33 * MIN },
];
const line = (n: number): ReplyLine => RUN[n - 2] ?? { id: 'none', text: 'none', at: TURN_NOW };

/** Turns over `c1`: the first answers #3 with #2 joining before it, each later one answers the next line of RUN. */
const headSteps = (turns: number): ReadonlyArray<ReplyStep> => [
  { lines: [line(2)], trigger: line(3), answers: [SKIP] },
  ...Array.from({ length: turns - 1 }, (_, i) => ({ trigger: line(4 + i), answers: [SKIP] })),
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

test('a request over its budget is still cut to the next step of context.chatSteps', async () => {
  // Bug: the head step keeps the oldest lines of a grown window, so a request over its budget keeps lines the cut to a
  // lower step of `context.chatSteps` would leave out, or keeps the oldest rather than the newest.
  const world = serviceWorld();
  const long = (tag: string): string => `${tag} ${'λόγια '.repeat(250)}`;
  const lines = [2, 3, 4, 5].map((n) => ({
    id: `w${n}`,
    text: long(`ΜΑΚΡΙΑ-${n}`),
    at: TURN_NOW - 4 * MIN + n * 10_000,
  }));
  const trigger = { id: 'w6', text: long('ΜΑΚΡΙΑ-6'), at: TURN_NOW - 3 * MIN };
  try {
    const run = await replyRun({
      world,
      // 6 000 tokens hold two of these lines and not three (measured on this rig).
      llm: { maxRequestTokens: 6000 },
      context: { channelMessages: 3, chatHeadStep: 4, chatSteps: [6, 2] },
      steps: [storedStep(world, C1_CHAT, { lines, trigger, answers: [SKIP] })],
    });
    const rows = lineRows(blockOf(requestOf(run, 0), 'chat'));
    assert.equal(rows.length, 2, rows.join('\n'));
    assert.match(rows[0] ?? '', /ΜΑΚΡΙΑ-5/);
    assert.match(rows[1] ?? '', /ΜΑΚΡΙΑ-6/);
  } finally {
    world.close();
  }
});

test('after a restart the head of the window is where it would have been', async () => {
  // Bug: the head is kept in the process, so after a restart the window starts at the newest lines again and the
  // block no longer starts with the one before the restart.
  const kept = await headRun(3, HEAD);
  const restarted = await headRun(3, HEAD, { restartBefore: 2 });
  assert.equal(restarted[2], kept[2]);
  assert.ok((restarted[2] ?? '').startsWith(`${linesPart(restarted[1] ?? '').join('\n')}\n`), restarted[2]);
});
