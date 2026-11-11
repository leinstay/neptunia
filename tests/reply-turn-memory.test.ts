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
