// src/turn/request/memory-block.ts: the `<memory>` of a turn, what the graph reader brought to her mind rendered as
// entries (plan 2026-11-06-turn-frame, slice 4 (a), "The ordinary turn" and "How memory fills"). Contract:
//   memoryBlockOf(mind: Mind, frame: Frame, labels: Labels, nameOf: (id: string) => string | null): { text: string;
//     reads: Array<MemoryRead> }
// `<people>` opens with the person she answers, marked so and always present, then everyone else once; `<places>`,
// `<lore>`, `<recent>` and `<found>` follow, one entry per thing in one subtag only. `nameOf` names an id an entry
// refers to without carrying its name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Mind } from '../src/memory/db/mind-read.ts';
import { frameOf } from '../src/turn/request/frame.ts';
import type { FrameParty } from '../src/turn/request/frame.ts';
import { memoryBlockOf } from '../src/turn/request/memory-block.ts';
import { frameInput } from './fixtures/frame-input.ts';
import {
  claimEntry,
  episodeEntry,
  excerptEntry,
  mindOfEntries,
  personEntry,
  placeEntry,
} from './fixtures/mind-entries.ts';
import { shippedLabels } from './fixtures/shipped-labels.ts';

const ELENI = personEntry('111', 'Ελένη', { evidence: 'counterpart', relation: 'ΣΧΕΣΗ-ΕΛΕΝΗΣ' });
const NIKOS = personEntry('222', 'Νίκος', { evidence: 'author', relation: 'ΣΧΕΣΗ-ΝΙΚΟΥ' });
// A party carries the id the interface names them by (plan 2026-11-08 ids-by-links, slice 7b): the request no longer
// parses it out of the account id.
const AS_ELENI: FrameParty = { personId: ELENI.personId, accountId: 'fake:111', nativeId: '111', name: 'Ελένη' };

const nameOf = (id: string): string | null => (id === 'place:room' ? 'γενικά' : null);

function render(mind: Mind, author: FrameParty | null): string {
  return memoryBlockOf(mind, frameOf(frameInput({ author })), shippedLabels, nameOf).text;
}

/** The body of `<tag>` in `text`, '' when the tag is absent. */
function section(text: string, tag: string): string {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1] ?? '';
}

test('the person she answers opens <people> even when the reader ranked them later', () => {
  // Bug: the entries keep the reader's order, and the counterpart sits below an author of the window.
  const people = section(render(mindOfEntries({ people: [NIKOS, ELENI] }), AS_ELENI), 'people');
  assert.ok(people.includes('Ελένη') && people.includes('Νίκος'));
  assert.ok(people.indexOf('Ελένη') < people.indexOf('Νίκος'));
});

test("the counterpart's entry is marked: it differs from the same entry on a turn that answers someone else", () => {
  // Bug: the counterpart comes first but nothing tells her it is the one she answers.
  const mind = mindOfEntries({ people: [ELENI, NIKOS] });
  const asEleni = section(render(mind, AS_ELENI), 'people');
  const asNobody = section(render(mind, null), 'people');
  const eleniPart = (people: string): string => people.slice(0, people.indexOf('Νίκος'));
  assert.ok(asEleni.indexOf('Νίκος') > 0 && asNobody.indexOf('Νίκος') > 0);
  assert.notEqual(eleniPart(asEleni), eleniPart(asNobody));
});

test('the counterpart has one entry in <memory> when the reader also raised them', () => {
  // Bug: the counterpart is prepended from the frame and rendered again from the reader's list.
  const text = render(mindOfEntries({ people: [NIKOS, ELENI] }), AS_ELENI);
  assert.equal(text.split('ΣΧΕΣΗ-ΕΛΕΝΗΣ').length - 1, 1);
});

test('a counterpart the reader did not raise still opens <people>, a stranger with an empty memory', () => {
  // Bug: the person she answers is missing whenever the database knows nothing of them.
  const people = section(render(mindOfEntries({ people: [NIKOS] }), { ...AS_ELENI, name: 'Ζωή' }), 'people');
  assert.ok(people.includes('Ζωή'));
  assert.ok(people.indexOf('Ζωή') < people.indexOf('Νίκος'));
});

test('each kind of entry renders in its own subtag and nowhere else', () => {
  // Bug: an excerpt of the prefetch lands in <recent>, or a lore claim under the people.
  const mind = mindOfEntries({
    people: [NIKOS],
    places: [placeEntry('place:club', 'λέσχη', { purpose: 'ΣΚΟΠΟΣ-ΛΕΣΧΗΣ' })],
    lore: [claimEntry('claim:1', 'place:club', 'ΘΡΥΛΟΣ-ΛΕΣΧΗΣ')],
    recent: [episodeEntry('episode:1', 'place:club', 'ΕΠΕΙΣΟΔΙΟ-ΧΘΕΣ')],
    found: [excerptEntry('src:fake:m9:1:seen', 'place:club', 'ΑΠΟΣΠΑΣΜΑ-ΠΑΛΙΟ')],
  });
  const text = render(mind, null);
  const expected: Record<string, string> = {
    people: 'ΣΧΕΣΗ-ΝΙΚΟΥ',
    places: 'ΣΚΟΠΟΣ-ΛΕΣΧΗΣ',
    lore: 'ΘΡΥΛΟΣ-ΛΕΣΧΗΣ',
    recent: 'ΕΠΕΙΣΟΔΙΟ-ΧΘΕΣ',
    found: 'ΑΠΟΣΠΑΣΜΑ-ΠΑΛΙΟ',
  };
  for (const [tag, value] of Object.entries(expected)) {
    assert.ok(section(text, tag).includes(value), `${value} in <${tag}>`);
    assert.equal(text.split(value).length - 1, 1, `${value} once`);
  }
});

test('an empty mind on a turn with nobody to answer renders no text', () => {
  // Bug: empty subtags reach the request and cost tokens for nothing.
  assert.equal(render(mindOfEntries(), null).trim(), '');
});

test("a person with two accounts lists each account's interface, platform id and name in their entry", () => {
  // Bug: she reads one person writing from two accounts but cannot tell which accounts are theirs.
  const accounts = [
    {
      id: 'fake:111',
      iface: 'fake',
      platformId: '111',
      handle: null,
      displayName: 'Ελένη',
      avatar: null,
      profileText: null,
    },
    {
      id: 'other:555',
      iface: 'other',
      platformId: '555',
      handle: null,
      displayName: 'Λένα',
      avatar: null,
      profileText: null,
    },
  ];
  const eleni = { ...ELENI, accounts: ['fake:111', 'other:555'], profileAccounts: accounts };
  const people = section(render(mindOfEntries({ people: [eleni] }), AS_ELENI), 'people');
  for (const value of ['other', '555', 'Λένα', '111']) assert.ok(people.includes(value), `${value} in <people>`);
});

test('a person with one account lists no accounts', () => {
  // Bug: every entry grows an accounts line that tells her nothing the heading does not.
  const accounts = [
    {
      id: 'fake:222',
      iface: 'fake',
      platformId: '222',
      handle: null,
      displayName: 'Νίκος',
      avatar: null,
      profileText: null,
    },
  ];
  const people = section(render(mindOfEntries({ people: [{ ...NIKOS, profileAccounts: accounts }] }), null), 'people');
  assert.ok(people.includes('Νίκος'));
  assert.ok(!people.includes('222'));
});

test('a mention stored as a token in an episode of <recent> renders as the name of the account it names', () => {
  // Bug (2026-11-10): a stored text kept `<@id>` as written, so <recent> showed a person as a number while a line of the
  // chat showed the same mention by name, and she told the owner she saw him only as a number.
  const id = '123456789012345678';
  const names = (one: string): string | null => (one === id ? 'Ελένη' : nameOf(one));
  const episode = episodeEntry('episode:1', 'place:club', `ΧΘΕΣ μίλησε η <@${id}> για τη λέσχη`);
  const recent = section(
    memoryBlockOf(mindOfEntries({ recent: [episode] }), frameOf(frameInput({ author: null })), shippedLabels, names)
      .text,
    'recent'
  );
  assert.ok(recent.includes('ΧΘΕΣ'), recent);
  assert.ok(recent.includes('Ελένη'), recent);
  assert.ok(!recent.includes(id), recent);
});
