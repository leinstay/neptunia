// The graph assembly of a reply takes every line she sees (spec 2026-11-10 one-handle-per-person-and-place, slice 1):
// the lines of `<meanwhile>` and of `<recall>` seed the graph reader beside the chat window, what her previous turn in
// the place raised seeds the next one (`Seeds.previous`), and the request's second cut never drops an entry the reader
// keeps whatever the budget. Reply turns in `c1` of the real turn runner over the service world's memory
// (tests/fixtures/service-turn.ts#replyTurns), a scripted model, synthetic names in Greek.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AT, addClaim, addLine, addPerson, addRoom, rootId } from './fixtures/memory-db/mind-world.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { useIface } from './fixtures/turn-world.ts';
import { TURN_NOW, blockOf, replyTurns, rootTags, serviceWorld } from './fixtures/service-turn.ts';
import type { ReplyStep } from './fixtures/service-turn.ts';
import { shippedLabels } from './fixtures/shipped-labels.ts';

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

// The request laid out for the prompt cache (the owner's decision of 2026-11-11, item 29 of plan 2026-11-10
// tools-and-reads; contract .agents/docs/specs/2026-11-11-cache-layout-contract.md). The rank of the graph reader
// decides what `<memory>` keeps and at which detail, and the print stands in a stable order: the same entries give the
// same bytes. Her own blocks stand after `<chat>`, so two turns of one place share everything up to `<chat>`.

/** The root tags of a reply in the order of the contract. */
const REPLY_ORDER = [
  'self',
  'surroundings',
  'memory',
  'meanwhile',
  'chat',
  'recall',
  'found',
  'inner',
  'spatial_awareness',
  'task',
];

const CLAIM = { alpha: 'ΑΛΦΑ λουλούδια', beta: 'ΒΗΤΑ θάλασσα' } as const;
const LORE = { alpha: 'ΛΟΡ-ΑΛΦΑ λουλούδια', beta: 'ΛΟΡ-ΒΗΤΑ θάλασσα' } as const;

/** The body of the subtag `<tag>` of `<memory>` in a request's user text, '' when absent. */
const subtagOf = (request: string | undefined, tag: string): string =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(blockOf(request ?? '', 'memory'))?.[1] ?? '';

/** The lines of a text as a sorted list, to compare what two texts hold whatever their order. */
const sortedLines = (text: string): Array<string> => text.split('\n').filter(Boolean).sort();

/**
 * The service world with Νίκος, two claims about Ελένη and two lore claims about `c1`, each pair one claim about
 * flowers and one about the sea, so a trigger that names one puts its claim first in the reader's rank.
 */
function rankWorld(): World {
  const world = serviceWorld();
  addPerson(world.db, { id: NIKOS, accounts: [{ id: 'fake:4242', iface: 'fake', native: '4242', names: ['Νίκος'] }] });
  const group = { group: 'fake' };
  addClaim(world.db, {
    id: 'claim:eleni:a',
    person: 'person:fake:111',
    kind: 'fact',
    text: CLAIM.alpha,
    audience: group,
  });
  addClaim(world.db, {
    id: 'claim:eleni:b',
    person: 'person:fake:111',
    kind: 'fact',
    text: CLAIM.beta,
    audience: group,
  });
  insertRows(world.db, {
    claims: (['a', 'b'] as const).map((key) => ({
      id: `lore:c1:${key}`,
      subject_kind: 'place',
      subject_id: 'fake:channel:c1',
      kind: 'lore',
      text: key === 'a' ? LORE.alpha : LORE.beta,
      truth: 'current',
      shown: 1,
      created_at: AT,
      extra: JSON.stringify({ title: key, keys: [], always: false }),
      scope_kind: 'group',
      scope_iface: 'fake',
    })),
  });
  return world;
}

/**
 * Two turns of Ελένη in `c1` with Νίκος and Ζωή writing around them. The first trigger names the sea and Ζωή wrote
 * last; the second names the flowers and the garden and Νίκος wrote last, so the reader ranks the claims, the authors
 * and the places of the second turn in another order than the first.
 */
const REORDERED: ReadonlyArray<ReplyStep> = [
  {
    lines: [
      { id: 'n1', text: 'πρώτη', at: TURN_NOW - 10 * MIN, authorId: '4242', authorName: 'Νίκος' },
      { id: 'z1', text: 'δεύτερη', at: TURN_NOW - 9 * MIN, authorId: '5678', authorName: 'Ζωή' },
    ],
    trigger: { id: 'e1', text: 'η θάλασσα', at: TURN_NOW - 8 * MIN },
    answers: [SAY],
  },
  {
    lines: [{ id: 'n2', text: 'τρίτη', at: TURN_NOW - 4 * MIN, authorId: '4242', authorName: 'Νίκος' }],
    trigger: { id: 'e2', text: 'τα λουλούδια στον κήπος', at: TURN_NOW - 3 * MIN },
    answers: [SAY],
  },
];

test('two turns that raise the same entries in another rank print <people>, <places> and <lore> byte for byte the same', async () => {
  // Bug: the request prints the entries and the claims inside an entry in the order the graph reader ranked them, so
  // the same people, places and lore come out in another order each turn and the prompt cache stops inside <people>.
  const world = rankWorld();
  try {
    const [first = [], second = []] = await replyTurns({ world, steps: REORDERED });
    for (const tag of ['people', 'places', 'lore']) {
      const before = subtagOf(first[0], tag);
      const after = subtagOf(second[0], tag);
      assert.ok(before !== '', `the first turn has <${tag}>`);
      assert.deepEqual(sortedLines(after), sortedLines(before), `<${tag}> holds the same lines in both turns`);
      assert.equal(after, before, `<${tag}>`);
    }
  } finally {
    world.close();
  }
});

test('the reordering loses no claim of a person and no lore claim of a place', async () => {
  // Guard: a stable order built by dropping and re-adding entries or claims loses one of them.
  const world = rankWorld();
  try {
    const [first = [], second = []] = await replyTurns({ world, steps: REORDERED });
    for (const request of [first[0], second[0]]) {
      for (const text of Object.values(CLAIM)) assert.ok(subtagOf(request, 'people').includes(text), text);
      for (const text of Object.values(LORE)) assert.ok(subtagOf(request, 'lore').includes(text), text);
      for (const name of ['Ελένη', 'Νίκος', 'Ζωή']) assert.ok(subtagOf(request, 'people').includes(name), name);
    }
  } finally {
    world.close();
  }
});

test('the person she answers stays the first entry of <people> and marked, and every author keeps an entry under a spent share', async () => {
  // Guard: the stable order sorts the person she answers among the others by id, or the people share spent by the
  // budget drops an author the reader keeps whatever the budget. Ζωή's id sorts last, so a sort by id alone moves her.
  const world = rankWorld();
  try {
    const steps = REORDERED.map((step) => ({
      ...step,
      trigger: { ...step.trigger, authorId: '5678', authorName: 'Ζωή' },
    }));
    const [, second = []] = await replyTurns({ world, settings: { budgetTokens: 10 }, steps });
    const entries = subtagOf(second[0], 'people').split('\n\n');
    const counterpart = shippedLabels.memory?.counterpart ?? '';
    assert.ok(counterpart !== '', 'the shipped labels mark the person she answers');
    assert.ok((entries[0] ?? '').includes('Ζωή') && (entries[0] ?? '').includes(counterpart), entries[0]);
    assert.equal(entries.filter((entry) => entry.includes(counterpart)).length, 1, 'one person marked');
    for (const name of ['Ελένη', 'Νίκος'])
      assert.ok(
        entries.some((entry) => entry.includes(name)),
        name
      );
    assert.equal(entries.filter((entry) => (entry.split('\n')[0] ?? '').includes('Ζωή')).length, 1, 'one entry of her');
  } finally {
    world.close();
  }
});

/** Five lines of hers in `place` before the turns, the minutes before TURN_NOW `from` down. */
function ownLines(world: World, place: string, prefix: string, from: number): void {
  for (let i = 0; i < 5; i += 1)
    addLine(world.db, {
      id: `${prefix}${i}`,
      iface: 'fake',
      place,
      author: 'self',
      text: `${prefix.toUpperCase()}-ΔΙΚΗ-${i}`,
      at: iso(TURN_NOW - (from - i) * MIN),
    });
}

test('<places> reads the same before and after she writes one more line in a place it lists', async () => {
  // Bug: a place's entry carries the exact count of her messages there, which grows with every line she writes, so the
  // entry of the place she talks in changes every turn and the cache stops at it. She wrote five lines in `c1` and in
  // the garden before the turns, and a sixth in each during the first turn, on the same day.
  const world = serviceWorld();
  ownLines(world, 'fake:channel:c1', 'c', 90);
  ownLines(world, 'fake:channel:c2', 'k', 80);
  const writeMore = (): string => {
    addLine(world.db, {
      id: 'c9',
      iface: 'fake',
      place: 'fake:channel:c1',
      author: 'self',
      text: 'ΕΚΤΗ-Γ',
      at: iso(TURN_NOW - 7 * MIN),
    });
    addLine(world.db, {
      id: 'k9',
      iface: 'fake',
      place: 'fake:channel:c2',
      author: 'self',
      text: 'ΕΚΤΗ-Κ',
      at: iso(TURN_NOW - 7 * MIN),
    });
    return SAY;
  };
  try {
    const [first = [], second = []] = await replyTurns({
      world,
      steps: [
        { trigger: { id: 'e1', text: 'καλημέρα', at: TURN_NOW - 8 * MIN }, answers: [writeMore] },
        { trigger: { id: 'e2', text: 'εντάξει', at: TURN_NOW - 3 * MIN }, answers: [SAY] },
      ],
    });
    const before = subtagOf(first[0], 'places');
    // The owner's decision of 2026-11-11: a place reads as the interface's noun and its name in quotes.
    assert.ok(before.includes('"γενικά"') && before.includes('"κήπος"'), before);
    assert.equal(subtagOf(second[0], 'places'), before);
  } finally {
    world.close();
  }
});

test('the second turn of a place repeats the first request byte for byte up to <chat> when only the chat gained lines', async () => {
  // Bug: her own blocks, `<inner>` with her last think and `<spatial_awareness>` with the number of the line she
  // answers, stand before `<chat>`, so the first request of every turn differs from the turn before above <chat> and
  // the cache reaches nothing after `<surroundings>`. The common prefix ends right before `<chat>`.
  const world = serviceWorld();
  try {
    const [first = [], second = []] = await replyTurns({
      world,
      steps: [
        { trigger: { id: 'e1', text: 'καλημέρα', at: TURN_NOW - 8 * MIN }, answers: [SAY] },
        { trigger: { id: 'e2', text: 'εντάξει', at: TURN_NOW - 3 * MIN }, answers: [SAY] },
      ],
    });
    const before = first[0] ?? '';
    const after = second[0] ?? '';
    for (const tag of ['memory', 'meanwhile'])
      assert.deepEqual(sortedLines(blockOf(after, tag)), sortedLines(blockOf(before, tag)), `the same <${tag}>`);
    const prefix = before.slice(0, before.indexOf('\n<chat>\n') + 1);
    assert.ok(prefix.includes('</meanwhile>') && prefix.includes('</memory>'), 'the prefix holds the stable blocks');
    assert.ok(after.startsWith(prefix), 'the second request starts with the first up to <chat>');
  } finally {
    world.close();
  }
});

test("a reply request orders its root tags as the contract: the stable blocks, <chat>, then the turn's own and <task>", async () => {
  // Bug: the request keeps its old order, `<recall>`, `<inner>` and `<spatial_awareness>` before `<chat>`, or the
  // frame's list and the printed order drift apart.
  const world = serviceWorld();
  try {
    const [, second = []] = await replyTurns({
      world,
      steps: [
        { trigger: { id: 'e1', text: 'καλημέρα', at: TURN_NOW - 8 * MIN }, answers: [SAY] },
        { trigger: { id: 'e2', text: 'εντάξει', at: TURN_NOW - 3 * MIN }, answers: [SAY] },
      ],
    });
    const tags = rootTags(second[0] ?? '');
    for (const tag of ['memory', 'meanwhile', 'chat', 'inner', 'spatial_awareness', 'task'])
      assert.ok(tags.includes(tag), `holds <${tag}>: ${tags.join(' ')}`);
    assert.deepEqual(
      tags,
      REPLY_ORDER.filter((tag) => tags.includes(tag))
    );
  } finally {
    world.close();
  }
});
