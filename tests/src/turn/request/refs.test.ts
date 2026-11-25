// Tests for src/turn/request/refs.ts: a line's identity in a stored text (`src:<iface>:<message id>:<revision>`,
// written by src/turn/handles.ts) rendered when the text comes back into a request, and turned into the interface's
// form when the persona's posted words go out, so a reference survives the turn. Contract:
//   RefLine = { placeId; messageId; path: Array<string>; at: number; text; revision: number; deleted: boolean }
//   refResolverOf({ window: Map<string, number>, lineOf: (key: string) => RefLine | null, labels: Labels,
//     timezone: string }): (text: string) => string
//   outgoingRefs(text, { placeId, lineOf, linkOf: (line: RefLine) => string | null, labels, timezone }):
//     { text: string; replyTo: string | null }
// `key` is the identity without its revision, `src:<iface>:<message id>`. `window` maps the key of each line of
// `<chat>` to its `#n`. `lineOf` reads the stored line under the frame's scope, null when unknown or not readable.
// A line in the window renders as its handle, one elsewhere as a quote under its path and time, a deleted one as
// unavailable, an edited one as its current text with a note. On the way out a line of another place becomes the
// interface's link, one of this place the reply target, and with no link form the quote with path and time.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { outgoingRefs, refResolverOf } from '../../../../src/turn/request/refs.ts';
import type { RefLine } from '../../../../src/turn/request/refs.ts';
import { shippedLabels } from '../../../fixtures/shipped-labels.ts';
import { userText as contentText } from '../../../../src/behavior/prompt.ts';
import type { Lookup } from '../../../../src/turn/calls.ts';
import { frameOf, type FrameParty } from '../../../../src/turn/request/frame.ts';
import { buildRequest, type Built } from '../../../fixtures/built-request.ts';
import { frameInput, ROOM_CHAIN } from '../../../fixtures/frame-input.ts';
import { type FakePlace, line, meanwhileReads } from '../../../fixtures/meanwhile-reads.ts';
import { addLine, type World } from '../../../fixtures/memory-db/mind-world.ts';
import { mindOfEntries, personEntry, placeEntry } from '../../../fixtures/mind-entries.ts';
import { baseInput, fakeConfig, fakePrompts, makeMessage, MIN, NOW } from '../../../fixtures/prompt-rig.ts';
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
} from '../../../fixtures/service-turn.ts';
import { call, toolAnswer } from '../../../fixtures/tool-answers.ts';
import { useIface } from '../../../fixtures/turn-world.ts';

const AT = Date.parse('2026-11-05T09:41:00.000Z');

const CLUB_LINE: RefLine = {
  placeId: 'place:club',
  messageId: 'm77',
  path: ['fake', 'Αγορά', 'λέσχη'],
  at: AT,
  text: 'ΚΕΙΜΕΝΟ-ΓΡΑΜΜΗΣ',
  revision: 1,
  deleted: false,
};

const resolverOver = (lines: Record<string, RefLine>, window = new Map<string, number>()) =>
  refResolverOf({ window, lineOf: (key) => lines[key] ?? null, labels: shippedLabels, timezone: 'UTC' });

test("an identity of a line in the window renders as that line's current handle", () => {
  // Bug: the stored identity reaches the model raw, or as a quote of a line the persona can see a few rows below.
  const resolve = resolverOver({ 'src:fake:m77': CLUB_LINE }, new Map([['src:fake:m77', 12]]));
  const text = resolve('όπως στο src:fake:m77:1 είπαν');
  assert.match(text, /#12(?!\d)/);
  assert.doesNotMatch(text, /src:fake/);
});

test('an identity of a line elsewhere renders as a quote under its path and time', () => {
  // Bug: a line of another place is lost, or quoted with no place and no time to read it by.
  const text = resolverOver({ 'src:fake:m77': CLUB_LINE })('όπως στο src:fake:m77:1 είπαν');
  assert.ok(text.includes('ΚΕΙΜΕΝΟ-ΓΡΑΜΜΗΣ'));
  assert.ok(text.includes('λέσχη'));
  assert.ok(text.includes('09:41'));
  assert.doesNotMatch(text, /src:fake/);
});

test('an identity of a deleted line renders as unavailable, without its old text', () => {
  // Bug: a message its author deleted keeps being quoted.
  const text = resolverOver({ 'src:fake:m77': { ...CLUB_LINE, deleted: true } })('όπως στο src:fake:m77:1 είπαν');
  assert.ok(!text.includes('ΚΕΙΜΕΝΟ-ΓΡΑΜΜΗΣ'));
  assert.doesNotMatch(text, /src:fake/);
  assert.ok(text.includes('όπως στο'));
});

test('an identity of an edited line renders the current text with a note that it changed', () => {
  // Bug: an edit goes unnoticed and the persona reads the new words as the ones they referred to.
  const edited = resolverOver({ 'src:fake:m77': { ...CLUB_LINE, revision: 2 } })('δες src:fake:m77:1');
  const same = resolverOver({ 'src:fake:m77': CLUB_LINE })('δες src:fake:m77:1');
  assert.ok(edited.includes('ΚΕΙΜΕΝΟ-ΓΡΑΜΜΗΣ'));
  assert.notEqual(edited, same);
});

test('an identity of a line the scope cannot read renders without its text', () => {
  // Bug: a reference stored in a private chat opens the line in a group.
  const text = resolverOver({})('δες src:fake:m77:1');
  assert.doesNotMatch(text, /src:fake/);
  assert.ok(text.includes('δες'));
});

const OUT = {
  lineOf: (key: string) => (key === 'src:fake:m77' ? CLUB_LINE : null),
  labels: shippedLabels,
  timezone: 'UTC',
};

test('a posted identity of another place goes out as the interface link for it', () => {
  // Bug: the platform shows the raw identity, or the link of the wrong line.
  const out = outgoingRefs('δες src:fake:m77:1', {
    ...OUT,
    placeId: 'place:room',
    linkOf: (one) => `https://fake.example/${one.placeId}/${one.messageId}`,
  });
  assert.ok(out.text.includes('https://fake.example/place:club/m77'));
  assert.doesNotMatch(out.text, /src:fake/);
  assert.equal(out.replyTo, null);
});

test('a posted identity of this place goes out as a reply to that line', () => {
  // Bug: a line a few messages up gets a link to itself instead of the platform's reply.
  const out = outgoingRefs('δες src:fake:m77:1', {
    ...OUT,
    placeId: 'place:club',
    linkOf: (one) => `https://fake.example/${one.placeId}/${one.messageId}`,
  });
  assert.equal(out.replyTo, 'm77');
  assert.doesNotMatch(out.text, /src:fake/);
});

test('with no link form, as at the command line, a posted identity goes out as the quote with path and time', () => {
  // Bug: the command line shows an identity nobody can open.
  const out = outgoingRefs('δες src:fake:m77:1', { ...OUT, placeId: 'cli:dm:owner', linkOf: () => null });
  assert.ok(out.text.includes('ΚΕΙΜΕΝΟ-ΓΡΑΜΜΗΣ'));
  assert.ok(out.text.includes('λέσχη'));
  assert.ok(out.text.includes('09:41'));
  assert.doesNotMatch(out.text, /src:fake/);
});

test('an identity at the end of a sentence, before a colon or before a dash renders as its handle', () => {
  // Bug: the guard after the revision refused a trailing `.`, `:` or `-`, so a third of the stored thinks kept raw ids.
  const resolve = resolverOver({ 'src:fake:m77': CLUB_LINE }, new Map([['src:fake:m77', 12]]));
  for (const tail of ['.', ': και', ' - και', '-'])
    assert.doesNotMatch(resolve(`όπως στο src:fake:m77:1${tail}`), /src:fake/, `tail ${JSON.stringify(tail)}`);
});

test('both ends of a range of identities render as handles', () => {
  // Bug: in `src:a:1-src:b:1` the first end was glued to the dash and stayed raw.
  const other: RefLine = { ...CLUB_LINE, messageId: 'm78' };
  const resolve = resolverOver(
    { 'src:fake:m77': CLUB_LINE, 'src:fake:m78': other },
    new Map([
      ['src:fake:m77', 12],
      ['src:fake:m78', 15],
    ])
  );
  const text = resolve('src:fake:m77:1-src:fake:m78:1');
  assert.match(text, /#12(?!\d)/);
  assert.match(text, /#15(?!\d)/);
});

test('a source id with its kind after the revision is no reference', () => {
  // Bug: a widened guard reads `src:x:m:1:seen` as the line m at revision 1.
  const resolve = resolverOver({ 'src:fake:m77': CLUB_LINE }, new Map([['src:fake:m77', 12]]));
  assert.equal(resolve('src:fake:m77:1:seen'), 'src:fake:m77:1:seen');
});

const TIMEZONE = 'Europe/Moscow';

const ELENI = personEntry('111', 'Ελένη', { evidence: 'counterpart', relation: 'ΣΧΕΣΗ-ΕΛΕΝΗΣ' });

// A party carries the id the interface names them by (plan 2026-11-08 ids-by-links, slice 7b): the request no longer
// parses it out of the account id.
const AS_ELENI: FrameParty = { personId: ELENI.personId, accountId: 'fake:111', nativeId: '111', name: 'Ελένη' };

const CLUB = placeEntry('place:club', 'λέσχη', { purpose: 'ΣΚΟΠΟΣ-ΛΕΣΧΗΣ' });

const FRAME = frameOf(
  frameInput({ now: NOW, timezone: TIMEZONE, author: AS_ELENI, trigger: { messageId: 'm1', authorId: '111' } })
);

const WHEREABOUTS = { kind: 'place', iface: 'fake', private: false, chain: ROOM_CHAIN };

const CONTEXT = {
  meanwhile: { messages: 8, around: 2 },
  recall: { extractChars: 1200, maxItems: 6 },
};

const HISTORY = [makeMessage('m1', NOW - MIN, { authorId: '111', authorName: 'Ελένη', content: 'γεια σου' })];

const LOOKUP: Lookup = {
  turnId: 'turn:7',
  at: NOW - 2 * MIN,
  tool: 'memory.search',
  args: { query: 'ΕΡΩΤΗΜΑ-ΚΗΠΟΣ' },
  place: { id: 'place:room', path: ['fake', 'Αγορά', 'γενικά'] },
  status: 'ok',
  extract: 'ΑΠΟΣΠΑΣΜΑ-ΚΗΠΟΥ',
  sourceIds: ['src:fake:m50:1:seen'],
  anchorMessageIds: ['m1'],
};

/** The club with a line of the persona among three of Eleni's. */
const CLUB_LINES: FakePlace = {
  id: 'place:club',
  path: ['fake', 'Αγορά', 'λέσχη'],
  dm: false,
  lines: [
    line('place:club', 'c1', NOW - 40 * MIN, '111', 'πρώτη'),
    line('place:club', 'c2', NOW - 39 * MIN, '111', 'δεύτερη'),
    line('place:club', 'c3', NOW - 38 * MIN, null, 'δική της'),
    line('place:club', 'c4', NOW - 37 * MIN, '111', 'τρίτη'),
  ],
};

const nameOf = (id: string): string | null => (id === '111' ? 'Ελένη' : null);

function request(over: Record<string, unknown> = {}): Built {
  return buildRequest(
    baseInput({
      config: fakeConfig({ context: CONTEXT }),
      prompts: fakePrompts({ labels: shippedLabels }),
      frame: FRAME,
      whereabouts: WHEREABOUTS,
      history: HISTORY,
      trigger: HISTORY[0],
      triggerKind: 'mention',
      nameOf,
      mind: mindOfEntries({ people: [ELENI], places: [CLUB] }),
      lookups: [LOOKUP],
      myDay: ['09:00 έγραψα στη λέσχη'],
      meanwhileReads: meanwhileReads([CLUB_LINES]),
      ...over,
    })
  );
}

const userOf = ({ messages }: Built): string => contentText(messages[1].content);

/** The body of the root block `<tag>`, '' when absent. */
function block(built: Built, tag: string): string {
  return new RegExp(`^<${tag}>\\n([\\s\\S]*?)\\n</${tag}>$`, 'm').exec(userOf(built))?.[1] ?? '';
}

test("a posted line of the persona with an identity of a line in the window renders that line's handle in <chat>", () => {
  // Bug: the persona's stored words show a raw identity, and they cannot tell which line they meant.
  const history = [
    ...HISTORY,
    makeMessage('m2', NOW - MIN / 2, {
      self: true,
      authorId: 'self',
      authorName: 'Nept',
      content: 'όπως είπε src:fake:m1:1',
    }),
  ];
  const built = request({ history, trigger: history[0] });
  const n = [...built.idByIndex].find(([, id]) => id === 'm1')?.[0];
  const mine = block(built, 'chat')
    .split('\n')
    .find((row) => row.includes('όπως είπε'));
  assert.ok(mine?.includes(`#${n}`), mine ?? 'no line of the persona');
  assert.doesNotMatch(block(built, 'chat'), /src:fake/);
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

/** What follows the `<task>` of a request: the persona's answers and the results of their calls in a tool round. */
const afterTask = (request: string): string => request.split('</task>').slice(1).join('</task>');

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
      at: iso(TURN_NOW - (60 + count - i) * REPLY_TURN_CHAT_NUMBERS_MIN),
    });
  return world;
};

const READ_GARDEN = toolAnswer(THINK, [call('conversation.read', { place: 'κήπος', last: 10 })]);

describe('chat numbers in a reply turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('a reaction to a number of the turn before lands on the line that number named', async () => {
    // Bug: the persona's stored think or memory carries `#N` of the last turn, and in this turn the window has moved, so the
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
});
