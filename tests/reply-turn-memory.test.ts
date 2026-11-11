// The graph assembly of a reply takes every line she sees (spec 2026-11-10 one-handle-per-person-and-place, slice 1):
// the lines of `<meanwhile>` and of `<recall>` seed the graph reader beside the chat window, what her previous turn in
// the place raised seeds the next one (`Seeds.previous`), and the request's second cut never drops an entry the reader
// keeps whatever the budget. Reply turns in `c1` of the real turn runner over the service world's memory
// (tests/fixtures/service-turn.ts#replyTurns), a scripted model, synthetic names in Greek.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addLine, addPerson, addRoom, rootId } from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { useIface } from './fixtures/turn-world.ts';
import { TURN_NOW, blockOf, replyTurns, serviceWorld } from './fixtures/service-turn.ts';

useIface('fake');

const MIN = 60_000;
const THINK = '<think>STEP 4. So: answer.</think>';
const SAY = `${THINK}<msg>γεια</msg>`;
const NIKOS = 'person:fake:4242';
const NIKOS_LINE = 'ΓΡΑΜΜΗ-ΣΤΟΝ-ΜΟΛΟ';
const iso = (at: number): string => new Date(at).toISOString();

/** The service world with Νίκος, who wrote one line in the room `μόλος` and nowhere else; her line after his when `hers`. */
function pierWorld({ hers }: { hers: boolean }): World {
  const world = serviceWorld();
  const pier = addRoom(world.db, { iface: 'fake', native: 'c9', root: rootId('fake', 'g1'), name: 'μόλος' });
  addPerson(world.db, { id: NIKOS, accounts: [{ id: 'fake:4242', iface: 'fake', native: '4242', names: ['Νίκος'] }] });
  addLine(world.db, {
    id: 'p1',
    iface: 'fake',
    place: pier,
    author: 'fake:4242',
    text: NIKOS_LINE,
    at: iso(TURN_NOW - 21 * MIN),
  });
  if (hers)
    addLine(world.db, {
      id: 'p2',
      iface: 'fake',
      place: pier,
      author: 'self',
      text: 'ΔΙΚΗ-ΤΗΣ-ΜΟΛΟΣ',
      at: iso(TURN_NOW - 20 * MIN),
    });
  return world;
}

/** The body of `<people>` in the `<memory>` of a request's user text, '' when absent. */
const peopleOf = (request: string | undefined): string =>
  /<people>([\s\S]*?)<\/people>/.exec(blockOf(request ?? '', 'memory'))?.[1] ?? '';

test('the author of a line in <meanwhile> who wrote nothing in the chat has an entry in <people>', async () => {
  // Bug: the graph reader of a reply is seeded from the chat window alone, so she reads Νίκος's line beside her own in
  // another room and memory shows nobody of that name, and she guesses who wrote it from a display name.
  const world = pierWorld({ hers: true });
  try {
    const [first = []] = await replyTurns({
      world,
      steps: [{ trigger: { id: 'r2', text: 'καλημέρα', at: TURN_NOW - MIN }, answers: [SAY] }],
    });
    assert.ok(blockOf(first[0] ?? '', 'meanwhile').includes(NIKOS_LINE), 'his line stands in <meanwhile>');
    assert.match(peopleOf(first[0]), /Νίκος/);
  } finally {
    world.close();
  }
});

test('the author of a line her earlier lookup in <recall> shows has an entry in <people>', async () => {
  // Bug: <recall> repeats what she read in the room of Νίκος, and the graph reader never takes those lines as seeds,
  // so the next turn shows his line and nothing memory holds about him.
  const world = pierWorld({ hers: false });
  try {
    const [first = [], second = []] = await replyTurns({
      world,
      steps: [
        {
          trigger: { id: 'r2', text: 'τι γράφουν εκεί;', at: TURN_NOW - 3 * MIN },
          answers: [toolAnswer(THINK, [call('conversation.read', { place: 'μόλος', last: 10 })]), SAY],
        },
        { trigger: { id: 'r3', text: 'ευχαριστώ', at: TURN_NOW - MIN }, answers: [SAY] },
      ],
    });
    assert.doesNotMatch(peopleOf(first[0]), /Νίκος/, 'nothing of the first request raised him');
    assert.ok(blockOf(second[0] ?? '', 'recall').includes(NIKOS_LINE), 'his line stands in <recall>');
    assert.match(peopleOf(second[0]), /Νίκος/);
  } finally {
    world.close();
  }
});

test('a person her previous turn in the place raised is in <people> of the next turn', async () => {
  // Bug: `previous` is always passed empty, so a person named a moment ago leaves her memory as soon as the line that
  // named him falls out of the reader's window, and the next answer in the same talk forgets who he is.
  const world = pierWorld({ hers: false });
  try {
    const [first = [], second = []] = await replyTurns({
      world,
      // One line of the window seeds the reader, so only the line she answers names anyone.
      settings: { windowMessages: 1 },
      steps: [
        { trigger: { id: 'r2', text: 'ξέρεις τον Νίκος;', at: TURN_NOW - 3 * MIN }, answers: [SAY] },
        { trigger: { id: 'r3', text: 'εντάξει', at: TURN_NOW - MIN }, answers: [SAY] },
      ],
    });
    assert.match(peopleOf(first[0]), /Νίκος/, 'the first turn raised him by his name');
    assert.match(peopleOf(second[0]), /Νίκος/);
  } finally {
    world.close();
  }
});

test('an author of the chat window keeps an entry in <people> when the people share is spent', async () => {
  // Bug: the graph reader keeps every author of the window whatever the budget, as a name at least, and the request's
  // second cut drops him again at the people share, so she sees his line and memory has nobody behind it.
  const world = pierWorld({ hers: false });
  try {
    const [first = []] = await replyTurns({
      world,
      settings: { budgetTokens: 10 },
      steps: [
        {
          lines: [{ id: 'r2', text: 'γεια σε όλους', at: TURN_NOW - 2 * MIN, authorId: '4242', authorName: 'Νίκος' }],
          trigger: { id: 'r3', text: 'καλημέρα', at: TURN_NOW - MIN },
          answers: [SAY],
        },
      ],
    });
    assert.ok(blockOf(first[0] ?? '', 'chat').includes('γεια σε όλους'), 'his line stands in <chat>');
    assert.match(peopleOf(first[0]), /Νίκος/);
  } finally {
    world.close();
  }
});

// The `#N` numbers of `<recall>` (plan 2026-11-10 tools-and-reads, item 22). An extract repeats a read of an earlier
// turn, and a number is valid only in the request that issued it, so every number the extract shows must name, in this
// turn's calls, the line it named when it was read, and a line memory no longer holds is shown with no number. The
// turn reads the garden `c2` of the service world, Ελένη's line and hers after it; a call `around` a number with no line
// before or after it reads back exactly the line the number names.

const GARDEN = { eleni: 'ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ', hers: 'ΔΙΚΗ-ΤΗΣ-ΚΗΠΟΣ' } as const;

/** Her answer that reads the garden by its name. */
const READ_GARDEN = toolAnswer(THINK, [call('conversation.read', { place: 'κήπος', last: 10 })]);

/** The line of `text` that holds `marker`, '' when none does. */
const lineWith = (text: string, marker: string): string => text.split('\n').find((line) => line.includes(marker)) ?? '';

/** The `#N` that opens the line of `text` holding `marker`, null when the line opens with none. */
const numberOf = (text: string, marker: string): string | null => /^#\d+\b/.exec(lineWith(text, marker))?.[0] ?? null;

/** What follows the `<task>` of a request: her answers and the results of her calls in a tool round. */
const afterTask = (request: string): string => request.split('</task>').slice(1).join('</task>');

/** How many times `marker` stands in `text`. */
const countOf = (text: string, marker: string): number => text.split(marker).length - 1;

/** Her answer that reads the garden around the number that opens the line of `marker` in `<recall>`, that line alone. */
const aroundRecalled =
  (marker: string) =>
  (request: string): unknown =>
    toolAnswer(THINK, [
      call('conversation.read', {
        place: 'κήπος',
        around: numberOf(blockOf(request, 'recall'), marker) ?? '#0',
        before: '0',
        after: '0',
      }),
    ]);

test('a number of a line in <recall> reads that line in a call of the next turn', async () => {
  // Bug: the extract keeps the numbers the earlier turn's read issued and this turn never registered, so a call with
  // the number she sees in <recall> is refused as a message not in the chat, while the read said its numbers work in
  // her calls (turn t-7ff3389c, media.look).
  const world = serviceWorld();
  try {
    const [, second = []] = await replyTurns({
      world,
      steps: [
        { trigger: { id: 'r2', text: 'τι γράφουν στον κήπο;', at: TURN_NOW - 3 * MIN }, answers: [READ_GARDEN, SAY] },
        {
          trigger: { id: 'r3', text: 'τι είπε η Ελένη;', at: TURN_NOW - MIN },
          answers: [aroundRecalled(GARDEN.eleni), SAY],
        },
      ],
    });
    assert.match(numberOf(blockOf(second[0] ?? '', 'recall'), GARDEN.eleni) ?? '', /^#\d+$/, 'her line has a number');
    const result = afterTask(second[1] ?? '');
    assert.equal(countOf(result, GARDEN.eleni), 1, result);
    assert.equal(countOf(result, GARDEN.hers), 0, 'the call read the line the number names and no other');
  } finally {
    world.close();
  }
});

test('no number in <recall> is the number of a line of <chat> in the same request', async () => {
  // Bug: the earlier turn numbered its read on past its own short window, and this turn's window is long enough to
  // issue the same numbers to its own lines, so one number stands for two lines and a call takes the chat's.
  const world = serviceWorld();
  try {
    const chatter = Array.from({ length: 30 }, (_, i) => ({
      id: `n${i}`,
      text: `ΚΟΥΒΕΝΤΑ-${i}`,
      at: TURN_NOW - 2 * MIN + i * 1000,
    }));
    const [, second = []] = await replyTurns({
      world,
      steps: [
        { trigger: { id: 'r2', text: 'τι γράφουν στον κήπο;', at: TURN_NOW - 3 * MIN }, answers: [READ_GARDEN, SAY] },
        { lines: chatter, trigger: { id: 'r3', text: 'καλά', at: TURN_NOW - MIN }, answers: [SAY] },
      ],
    });
    const request = second[0] ?? '';
    const recall = blockOf(request, 'recall');
    assert.ok(recall.includes(GARDEN.eleni), 'the read stands in <recall>');
    const chatNumbers = new Set(blockOf(request, 'chat').match(/^#\d+\b/gm) ?? []);
    assert.ok(chatNumbers.size >= 30, 'the window numbers its lines');
    const shared = (recall.match(/(?<![\p{L}\p{N}_])#\d+\b/gu) ?? []).filter((n) => chatNumbers.has(n));
    assert.deepEqual(shared, []);
  } finally {
    world.close();
  }
});

test('a number of a line in <recall> still reads that line after a read of the same turn', async () => {
  // Bug: a read numbers its lines on from the turn's next free number, and a number <recall> shows but the registry
  // never counted is issued again to a line of the new read, which takes it over.
  const world = serviceWorld();
  try {
    const [, second = []] = await replyTurns({
      world,
      steps: [
        { trigger: { id: 'r2', text: 'τι γράφουν στον κήπο;', at: TURN_NOW - 3 * MIN }, answers: [READ_GARDEN, SAY] },
        {
          trigger: { id: 'r3', text: 'και εδώ;', at: TURN_NOW - MIN },
          answers: [toolAnswer(THINK, [call('conversation.read', { last: 10 })]), aroundRecalled(GARDEN.eleni), SAY],
        },
      ],
    });
    assert.match(numberOf(blockOf(second[0] ?? '', 'recall'), GARDEN.eleni) ?? '', /^#\d+$/, 'her line has a number');
    const before = afterTask(second[1] ?? '');
    const after = afterTask(second[2] ?? '');
    assert.equal(countOf(after, GARDEN.eleni) - countOf(before, GARDEN.eleni), 1, after);
    assert.equal(countOf(after, GARDEN.hers), countOf(before, GARDEN.hers), 'the call read no other line');
  } finally {
    world.close();
  }
});

test('a line of <recall> whose stored line is gone is shown with no number', async () => {
  // Bug: the extract prints the number the earlier read gave a line memory no longer holds, and no call of this turn
  // can resolve it, so the number points at nothing.
  const world = serviceWorld();
  try {
    const retireEleni = (): string => {
      world.db.prepare('UPDATE sources SET retired_at = ? WHERE id = ?').run(new Date(TURN_NOW).toISOString(), 'g0');
      return SAY;
    };
    const [, second = []] = await replyTurns({
      world,
      steps: [
        {
          trigger: { id: 'r2', text: 'τι γράφουν στον κήπο;', at: TURN_NOW - 3 * MIN },
          answers: [READ_GARDEN, retireEleni],
        },
        { trigger: { id: 'r3', text: 'καλά', at: TURN_NOW - MIN }, answers: [SAY] },
      ],
    });
    const recall = blockOf(second[0] ?? '', 'recall');
    assert.ok(recall.includes(GARDEN.hers), 'the lookup stands, her line is live');
    const line = lineWith(recall, GARDEN.eleni);
    assert.ok(line !== '', 'the gone line stands in the extract');
    assert.doesNotMatch(line, /(?<![\p{L}\p{N}_])#\d+\b/u);
  } finally {
    world.close();
  }
});

test('a number of a read reads its line in a later call of the same turn', async () => {
  // Guard: the numbers a read issues are registered in the turn's registry, and the call after it resolves them; a
  // renumbering of <recall> must leave the turn's own reads as they are.
  const world = serviceWorld();
  try {
    const aroundRead = (request: string): unknown =>
      toolAnswer(THINK, [
        call('conversation.read', {
          place: 'κήπος',
          around: numberOf(afterTask(request), GARDEN.eleni) ?? '#0',
          before: '0',
          after: '0',
        }),
      ]);
    const [first = []] = await replyTurns({
      world,
      steps: [
        {
          trigger: { id: 'r2', text: 'τι γράφουν στον κήπο;', at: TURN_NOW - 3 * MIN },
          answers: [READ_GARDEN, aroundRead, SAY],
        },
      ],
    });
    const before = afterTask(first[1] ?? '');
    const after = afterTask(first[2] ?? '');
    assert.equal(countOf(after, GARDEN.eleni) - countOf(before, GARDEN.eleni), 1, after);
    assert.equal(countOf(after, GARDEN.hers), countOf(before, GARDEN.hers), 'the call read no other line');
  } finally {
    world.close();
  }
});
