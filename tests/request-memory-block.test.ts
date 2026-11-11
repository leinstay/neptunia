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
import { factItemsOf, memoryBlockOf, memoryItemsOf } from '../src/turn/request/memory-block.ts';
import type { EntryRefs } from '../src/turn/request/memory-block.ts';
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

test('the counterpart has one entry when the frame knows them by their platform id alone', () => {
  // Bug (2026-11-11): a frame whose store links no person names the counterpart by the platform id, and the person the
  // reader raised for that same account was rendered a second time under the stranger the frame made of them.
  const byId: FrameParty = { personId: null, accountId: '111', nativeId: '111', name: 'Ελένη' };
  const people = section(render(mindOfEntries({ people: [ELENI, NIKOS] }), byId), 'people');
  assert.equal(people.split('Ελένη').length - 1, 1, people);
  assert.ok(people.includes('ΣΧΕΣΗ-ΕΛΕΝΗΣ'), people);
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

test('a person with one account lists that account with its interface and platform id', () => {
  // Bug: a person's entry hides the account she sees, so she cannot tie a line to it.
  // The owner's decision of 2026-11-10: an entry lists every account, one line each, a single account included.
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
  const account = people.split('\n').find((line) => line.includes('222')) ?? '';
  assert.ok(account.includes('fake'), people);
});

// The owner's decision of 2026-11-10: a mention in a stored text reads as the handle of the person it names, and a
// mention of an account no row holds reads `authors.unknown`; no platform id stands in a block.
const MENTIONS: EntryRefs = {
  mention: (native) => (native === '777' ? '@u7ele' : 'someone'),
  place: () => 'γενικά',
  partnerOf: () => 'someone',
};
const WITH_AUTHORS = {
  ...shippedLabels,
  authors: { line: '{handle}', lineAccount: '{handle} ({iface} {id})', unknown: 'someone' },
};

test('a mention in a stored fact of <found> reads as the handle of the person it names, or authors.unknown', () => {
  // Bug: the prefetch's facts are escaped and never read for mentions, so <found> shows a bare `<@id>` with a platform
  // id while every other block shows the handle.
  const facts = [{ state: 'current', text: 'ΓΝΩΡΙΖΕΙ <@777> ΚΑΙ <@999>' }];
  const named = factItemsOf(facts, WITH_AUTHORS, MENTIONS)
    .map((item) => item.text)
    .join('\n');
  assert.ok(named.includes('ΓΝΩΡΙΖΕΙ @u7ele ΚΑΙ someone'), named);
  const plain = factItemsOf(facts, WITH_AUTHORS)
    .map((item) => item.text)
    .join('\n');
  assert.ok(plain.includes('ΓΝΩΡΙΖΕΙ someone ΚΑΙ someone'), plain);
  assert.doesNotMatch(`${named}\n${plain}`, /<@|&lt;@|\b777\b|\b999\b/);
});

test('a mention in a claim, a lore text, an episode, an excerpt and a place topic reads as the handle', () => {
  // Guard: every stored text of <memory> passes the mention path, so none of them shows a platform id.
  const text = '<@777>';
  const mind = mindOfEntries({
    people: [{ ...NIKOS, detail: 'whole', claims: [{ id: 'claim:n', kind: 'fact', text: `ΙΣΧΥΡΙΣΜΟΣ ${text}` }] }],
    places: [placeEntry('place:club', 'λέσχη', { topics: `ΘΕΜΑΤΑ ${text}` })],
    lore: [claimEntry('claim:1', 'place:club', `ΘΡΥΛΟΣ ${text}`)],
    recent: [episodeEntry('episode:1', 'place:club', `ΕΠΕΙΣΟΔΙΟ ${text}`)],
    found: [excerptEntry('src:fake:m9:1:seen', 'place:club', `ΑΠΟΣΠΑΣΜΑ ${text}`)],
  });
  const frame = frameOf(frameInput({ author: null }));
  const items = memoryItemsOf(mind, frame, WITH_AUTHORS, nameOf, null, new Set(), () => null, MENTIONS);
  const all = items.map((item) => item.text).join('\n');
  for (const word of ['ΙΣΧΥΡΙΣΜΟΣ', 'ΘΕΜΑΤΑ', 'ΘΡΥΛΟΣ', 'ΕΠΕΙΣΟΔΙΟ', 'ΑΠΟΣΠΑΣΜΑ'])
    assert.ok(all.includes(`${word} @u7ele`), `${word}: ${all}`);
  assert.doesNotMatch(all, /<@|&lt;@|\b777\b/);
});
