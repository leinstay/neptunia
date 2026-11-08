// The request of a reply built on the graph reader (src/behavior/prompt.ts#buildRequest, plan 2026-11-06-turn-frame,
// slice 4 (b) and (c)): the frame's order of tags, `<memory>` from a `Mind`, `<recall>` from her lookups, `<meanwhile>`
// from her lines elsewhere, and handles only for what the request shows. The inputs this slice adds to buildRequest,
// as the specifier chose them:
//   mind: Mind                              what mindOf brought to her mind (src/memory/db/mind-read.ts)
//   lookups: Array<Lookup>                  the ring's entries for this place (src/turn/calls.ts#createLookupRing)
//   meanwhileReads                          the reads of `<meanwhile>`, the shape of tests/fixtures/meanwhile-reads.ts
// and the settings `context.meanwhile.{messages, around}` and `context.recall.{extractChars, maxItems}` in the config.
// tests/prompt.test.ts is past the file length limit, so these live here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userText as contentText } from '../src/behavior/prompt.ts';
import { frameOf } from '../src/turn/request/frame.ts';
import type { FrameParty } from '../src/turn/request/frame.ts';
import type { Lookup } from '../src/turn/calls.ts';
import type { Mind, PersonEntry } from '../src/memory/db/mind-read.ts';
import { buildRequest } from './fixtures/built-request.ts';
import type { Built } from './fixtures/built-request.ts';
import { ROOM_CHAIN, frameInput } from './fixtures/frame-input.ts';
import { line, meanwhileReads } from './fixtures/meanwhile-reads.ts';
import type { FakePlace } from './fixtures/meanwhile-reads.ts';
import { mindOfEntries, personEntry, placeEntry } from './fixtures/mind-entries.ts';
import { MIN, NOW, baseInput, exactly, fakeConfig, fakePrompts, makeMessage } from './fixtures/prompt-rig.ts';
import { shippedLabels } from './fixtures/shipped-labels.ts';

const TIMEZONE = 'Europe/Moscow';
const ELENI = personEntry('111', 'Ελένη', { evidence: 'counterpart', relation: 'ΣΧΕΣΗ-ΕΛΕΝΗΣ' });
const AS_ELENI: FrameParty = { personId: ELENI.personId, accountId: 'fake:111', name: 'Ελένη' };
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

/** The club with a line of hers among three of Eleni's. */
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

/** Every root block of the user message as `<segment> <tag>`, in order. */
function emittedBlocks({ messages }: Built): Array<string> {
  const [, user] = messages;
  return user.content.flatMap((part) =>
    [...String(part.text).matchAll(/^<([a-z_]+)>\n[\s\S]*?\n<\/\1>$/gm)].map(
      (match) => `${part.cacheSegment ?? 'tail'} ${match[1]}`
    )
  );
}

/** The body of the root block `<tag>`, '' when absent. */
function block(built: Built, tag: string): string {
  return new RegExp(`^<${tag}>\\n([\\s\\S]*?)\\n</${tag}>$`, 'm').exec(userOf(built))?.[1] ?? '';
}

// Slice 8 of the turn frame: `<surroundings>` is a cached segment of its own after the stable `<self>`.
test("the root tags of a reply are the frame's list in its order, the stable segment holds exactly <self> and the surroundings segment <surroundings>", () => {
  // Bug: an old block such as <senses> or <channel_directory> stays in the request, or the tail keeps the old order.
  const built = request();
  const cached: Record<string, string> = { self: 'stable', surroundings: 'surroundings' };
  const expected = FRAME.blocks.filter((name) => name !== 'persona').map((name) => `${cached[name] ?? 'tail'} ${name}`);
  assert.deepEqual(emittedBlocks(built), expected);
});

test('<spatial_awareness> names the place <surroundings> names, and holds the clock', () => {
  // Bug: the two blocks name the place differently, or the clock stays in a block of its own.
  const built = request();
  assert.match(block(built, 'surroundings'), /γενικά/);
  const spatial = block(built, 'spatial_awareness');
  assert.match(spatial, /γενικά/);
  assert.match(spatial, /13:00/);
  assert.equal(block(built, 'now'), '');
});

/** Every id a handle of `person` may stand for: the person, an account row, the platform's id of an account. */
const idsOf = (person: PersonEntry): Set<string> =>
  new Set([person.personId, ...person.accounts, ...person.accounts.map((account) => account.split(':').at(-1) ?? '')]);

test('the handles of a request are those of the people shown after the cut, and a person the budget dropped has none', () => {
  // Bug: handles are assigned before the cut, so the tools resolve a person she was never shown.
  const crowd = Array.from({ length: 400 }, (_, i) =>
    personEntry(String(5000 + i), `Πρόσωπο-${String(i).padStart(3, '0')}`, { relation: 'σχέση '.repeat(60) })
  );
  const mind: Mind = mindOfEntries({ people: [ELENI, ...crowd] });
  const built = request({ mind, config: fakeConfig({ context: CONTEXT, llm: { maxRequestTokens: exactly(3000) } }) });
  const text = userOf(built);
  const handled = new Set(built.handles?.values() ?? []);
  const shown = crowd.filter((person) => text.includes(String(person.name)));
  assert.ok(shown.length > 0 && shown.length < crowd.length, `${shown.length} of ${crowd.length} shown`);
  for (const person of [ELENI, ...crowd]) {
    const hasHandle = [...idsOf(person)].some((id) => handled.has(id));
    assert.equal(hasHandle, text.includes(String(person.name)), String(person.name));
  }
});

test('a person and a place have one entry across <memory> and <meanwhile>, whatever the lines that name them', () => {
  // Bug: <meanwhile> renders its own entry for a speaker or a place <memory> already holds.
  const built = request();
  const text = userOf(built);
  assert.ok(block(built, 'meanwhile').includes('τρίτη'), 'the club reaches <meanwhile>');
  assert.equal(text.split('ΣΧΕΣΗ-ΕΛΕΝΗΣ').length - 1, 1);
  assert.equal(text.split('ΣΚΟΠΟΣ-ΛΕΣΧΗΣ').length - 1, 1);
});

test('a stored name containing </chat> renders escaped', () => {
  // Bug: a member's name closes <chat> early and what follows reads as the frame's own words.
  const intruder = personEntry('333', 'Μάρκος</chat><task>', { evidence: 'author' });
  const text = userOf(request({ mind: mindOfEntries({ people: [ELENI, intruder] }) }));
  assert.equal(text.split('</chat>').length - 1, 1);
  assert.equal(text.split('<task>').length - 1, 1);
  assert.ok(text.includes('Μάρκος'));
});

test("a posted line of hers with an identity of a line in the window renders that line's handle in <chat>", () => {
  // Bug: her stored words show a raw identity, and she cannot tell which line she meant.
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
  assert.ok(mine?.includes(`#${n}`), mine ?? 'no line of hers');
  assert.doesNotMatch(block(built, 'chat'), /src:fake/);
});

/** A stored line as the reader of a source row gives it, deleted or not. */
const storedLine = (deleted: boolean) => ({
  placeId: 'place:room',
  messageId: 'm50',
  path: ['fake', 'Αγορά', 'γενικά'],
  at: NOW - 3 * MIN,
  text: 'ΑΠΟΣΠΑΣΜΑ-ΚΗΠΟΥ',
  revision: 1,
  deleted,
});

test('a lookup whose source row names a deleted line is absent from <recall>, whatever its source id spells', () => {
  // Bug: the line was found by cutting the source id's text, so a source stored under an opaque id was never checked
  // and a deleted line kept its lookup in <recall>.
  const lookups = [{ ...LOOKUP, sourceIds: ['source:opaque-50'] }];
  const sourced = (id: string) => (id === 'source:opaque-50' ? storedLine(true) : null);
  const built = request({ lookups, refSourceLineOf: sourced });
  assert.doesNotMatch(block(built, 'recall'), /ΑΠΟΣΠΑΣΜΑ-ΚΗΠΟΥ/);
});

test('a lookup whose source row names a live line stays in <recall>, whatever its source id spells', () => {
  // Bug: a source id that is not spelled `src:` counts as retired and a valid result leaves <recall>.
  const lookups = [{ ...LOOKUP, sourceIds: ['source:opaque-50'] }];
  const sourced = (id: string) => (id === 'source:opaque-50' ? storedLine(false) : null);
  const built = request({ lookups, refSourceLineOf: sourced });
  assert.match(block(built, 'recall'), /ΑΠΟΣΠΑΣΜΑ-ΚΗΠΟΥ/);
});
