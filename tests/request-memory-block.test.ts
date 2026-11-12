// src/turn/request/memory-block.ts: the `<memory>` of a turn, what the graph reader brought to her mind rendered as
// entries (plan 2026-11-06-turn-frame, slice 4 (a), "The ordinary turn" and "How memory fills"). Contract:
//   memoryBlockOf(mind: Mind, frame: Frame, labels: Labels, nameOf: (id: string) => string | null): { text: string;
//     reads: Array<MemoryRead> }
// `<people>` opens with the person she answers, marked so and always present, then everyone else once; `<places>`,
// `<lore>`, `<recent>` and `<found>` follow, one entry per thing in one subtag only. `nameOf` names an id an entry
// refers to without carrying its name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fill } from '../src/format.ts';
import type { Mind, PersonEntry } from '../src/memory/db/mind-read.ts';
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

// One logic in everything the request holds (the owner's decision of 2026-11-11): an entry of `<places>` labels the
// purpose, the tone and the topics with the words `<place>` of `<surroundings>` uses (`surroundings.field` and
// `surroundings.fields.*`), and says since which day she is in a root as one more field of that form,
// `surroundings.fields.joined`, the day as `YYYY-MM-DD` in the turn's timezone (the year matters: she may have joined
// years ago). A place with no known moment has no such line. Signature: `PlaceEntry` gains `joinedAt: number | null`.
// The words come off the tracked labels (`surroundings.field`, `surroundings.fields.*`), so a test reads values and never
// their wording. `surroundings.fields.joined` is the key the root's entry gets.
function shipped(...keys: Array<string>): string {
  let node: unknown = shippedLabels.surroundings;
  for (const key of keys) node = typeof node === 'object' && node !== null ? Reflect.get(node, key) : undefined;
  if (typeof node !== 'string') throw new Error(`labels.surroundings.${keys.join('.')} is missing`);
  return node;
}
const FIELD = shipped('field');
const WORDS = {
  purpose: shipped('fields', 'purpose'),
  tone: shipped('fields', 'tone'),
  topics: shipped('fields', 'topics'),
  joined: shipped('fields', 'joined'),
};
const fieldLine = (word: string, value: string): string => fill(FIELD, { field: word, value });
const placesOf = (entries: Array<ReturnType<typeof placeEntry>>, timezone = 'UTC'): string =>
  section(
    memoryBlockOf(
      mindOfEntries({ places: entries }),
      frameOf(frameInput({ author: null, timezone })),
      shippedLabels,
      nameOf
    ).text,
    'places'
  );

test('an entry of <places> opens its purpose, tone and topics with the words <place> uses, as lines of their own', () => {
  // Bug: the three fields print as bare paragraphs, so one place reads two ways in one request.
  const entry = placeEntry('place:club', 'λέσχη', { purpose: 'ΣΚΟΠΟΣ', tone: 'ΥΦΟΣ', topics: 'ΘΕΜΑΤΑ' });
  const lines = placesOf([entry]).split('\n');
  for (const [word, value] of [
    [WORDS.purpose, 'ΣΚΟΠΟΣ'],
    [WORDS.tone, 'ΥΦΟΣ'],
    [WORDS.topics, 'ΘΕΜΑΤΑ'],
  ] as const)
    assert.ok(lines.includes(fieldLine(word, value)), `${word}: ${lines.join(' | ')}`);
  for (const value of ['ΣΚΟΠΟΣ', 'ΥΦΟΣ', 'ΘΕΜΑΤΑ']) assert.equal(lines.includes(value), false, value);
});

test('the root entry holds the day she joined in the turn timezone, a root with no moment holds none', () => {
  // Bug: the day is cut in UTC, not in her zone, or a root with no moment prints an empty or invalid day.
  const joinedAt = Date.parse('2026-10-03T23:30:00Z');
  const tokyo = '2026-10-04';
  const known = placesOf([placeEntry('place:srv', 'Αγορά', { kind: 'server', joinedAt })], 'Asia/Tokyo');
  assert.ok(known.split('\n').includes(fieldLine(WORDS.joined, tokyo)), known);
  const unknown = placesOf([placeEntry('place:srv', 'Αγορά', { kind: 'server' })], 'Asia/Tokyo');
  assert.equal(unknown.includes(`${WORDS.joined}:`), false, unknown);
});

// Her attitude toward a person in the entry (spec 2026-11-12 attitude-in-people). A person entry of the mind carries
//   attitude: { score: number; reason: string | null; moves: ReadonlyArray<{ delta: number; at: string; reason: string | null }> } | null
// (`moves` newest first, already cut to `context.memory.attitudeMoves` by the reader), and the entry opens with
// `memory.attitude` (`{score}` rounded, `{band}` from `affinity.bands`, `{reason}`) and, under it, `memory.attitudeMoves`
// (`{moves}`) holding one `memory.attitudeMove` (`{delta}` signed, `{date}` as YYYY-MM-DD, `{reason}`) per change. The tests
// read the score, the band word, the reason, each change's sign and day, and never the wording around them.
type Attitude = NonNullable<PersonEntry['attitude']>;

const bandWord = (band: string): string => {
  const bands = shippedLabels.affinity?.bands;
  const word = bands?.[band];
  if (typeof word !== 'string') throw new Error(`labels.affinity.bands.${band} is missing`);
  return word;
};

const GRACE = personEntry('333', 'Γαλήνη', {
  profileAccounts: [
    {
      id: 'fake:333',
      iface: 'fake',
      platformId: '333',
      handle: null,
      displayName: 'Γαλήνη',
      avatar: null,
      profileText: null,
    },
  ],
  relation: 'ΣΧΕΣΗ-ΓΑΛΗΝΗΣ',
});
const FOND: Attitude = {
  score: 31.6,
  reason: 'ΛΟΓΟΣ-ΤΕΛΕΥΤΑΙΑΣ',
  moves: [
    { delta: 6, at: '2026-11-09T10:00:00.000Z', reason: 'ΛΟΓΟΣ-ΤΕΛΕΥΤΑΙΑΣ' },
    { delta: -4, at: '2026-11-03T18:00:00.000Z', reason: 'ΛΟΓΟΣ-ΠΑΛΙΑΣ' },
  ],
};

/** The lines of the entry `person` has in `<people>` on a turn that answers nobody. */
const entryLines = (person: PersonEntry): Array<string> =>
  section(render(mindOfEntries({ people: [person] }), null), 'people')
    .trim()
    .split('\n');

test('a full entry opens with the attitude line and the latest changes, newest first, above the account lines', () => {
  // Bug: the entry holds no attitude, or puts it below the accounts where a cut of the tail takes it, or lists the
  // older change first.
  const lines = entryLines({ ...GRACE, attitude: FOND });
  const [heading = '', attitude = '', moves = ''] = lines;
  assert.ok(heading.includes('Γαλήνη'), heading);
  for (const part of ['32', bandWord('fond'), 'ΛΟΓΟΣ-ΤΕΛΕΥΤΑΙΑΣ'])
    assert.ok(attitude.includes(part), `${part} in line 2: ${attitude}`);
  for (const part of ['+6', '2026-11-09', 'ΛΟΓΟΣ-ΤΕΛΕΥΤΑΙΑΣ', '-4', '2026-11-03', 'ΛΟΓΟΣ-ΠΑΛΙΑΣ'])
    assert.ok(moves.includes(part), `${part} in line 3: ${moves}`);
  assert.ok(moves.indexOf('2026-11-09') < moves.indexOf('2026-11-03'), moves);
  const below = lines.slice(3).join('\n');
  assert.ok(below.includes('333') && below.includes('ΣΧΕΣΗ-ΓΑΛΗΝΗΣ'), below);
});

test('a person with no change and a score of zero has neither line while a person with a change beside them has both', () => {
  // Bug: a stranger reads "0 (neutral)" with an empty reason, a line that says nothing and costs tokens.
  const zero = { ...GRACE, attitude: { score: 0, reason: null, moves: [] } };
  const felt = { ...personEntry('222', 'Νίκος'), attitude: FOND };
  const people = section(render(mindOfEntries({ people: [zero, felt] }), null), 'people');
  const [first = '', second = ''] = people.trim().split('\n\n');
  assert.equal(first, entryLines({ ...GRACE, attitude: null }).join('\n'));
  assert.ok(second.includes('ΛΟΓΟΣ-ΤΕΛΕΥΤΑΙΑΣ') && second.includes('2026-11-03'), second);
});

test('with no change to show the attitude line stands alone', () => {
  // Bug: the line of changes prints empty (the label with nothing in it) when the setting holds no change back.
  const lines = entryLines({ ...GRACE, attitude: { ...FOND, moves: [] } });
  assert.ok((lines[1] ?? '').includes('ΛΟΓΟΣ-ΤΕΛΕΥΤΑΙΑΣ'), lines.join(' | '));
  assert.equal(lines.filter((line) => /\d{4}-\d{2}-\d{2}/.test(line)).length, 0, lines.join(' | '));
  assert.ok((lines[2] ?? '').includes('333'), lines.join(' | '));
});

test('the person she answers reads with the attitude line in an entry cut to its name', () => {
  // Bug: the line is built for the entries that hold details only, so the one person she must answer well is the one
  // who loses how she feels about them when the reader cuts the entry down.
  const cut = { ...personEntry('111', 'Ελένη', { evidence: 'counterpart', detail: 'name' }), attitude: FOND };
  const people = section(render(mindOfEntries({ people: [cut] }), AS_ELENI), 'people');
  for (const part of ['32', bandWord('fond'), 'ΛΟΓΟΣ-ΤΕΛΕΥΤΑΙΑΣ', '2026-11-03'])
    assert.ok(people.includes(part), `${part} in ${people}`);
});

test('a person the reader kept whatever the budget reads with the attitude line in an entry cut to its name', () => {
  // Bug: an author of the lines she sees keeps a name and loses her attitude, so she reads a stranger where she knows someone.
  const cut = { ...personEntry('222', 'Νίκος', { detail: 'name', keep: true }), attitude: FOND };
  const people = section(render(mindOfEntries({ people: [cut] }), null), 'people');
  for (const part of ['32', bandWord('fond'), 'ΛΟΓΟΣ-ΤΕΛΕΥΤΑΙΑΣ'])
    assert.ok(people.includes(part), `${part} in ${people}`);
});

test('the band word follows the score at each edge the bands name', () => {
  // Bug: a score on an edge lands in the neighbouring band, or the band comes from the rounded score of another edge.
  const edges: Array<[number, string]> = [
    [-61, 'hostile'],
    [-60, 'hostile'],
    [-59, 'dislike'],
    [-25, 'dislike'],
    [-24, 'cool'],
    [-8, 'cool'],
    [-7, 'neutral'],
    [7, 'neutral'],
    [8, 'warm'],
    [24, 'warm'],
    [25, 'fond'],
    [59, 'fond'],
    [60, 'devoted'],
  ];
  const bands = ['hostile', 'dislike', 'cool', 'neutral', 'warm', 'fond', 'devoted'];
  for (const [score, band] of edges) {
    const line = entryLines({ ...GRACE, attitude: { score, reason: 'ΛΟΓΟΣ', moves: [] } })[1] ?? '';
    assert.ok(line.includes(String(score)) && line.includes(bandWord(band)), `${score} is ${band}: ${line}`);
    for (const other of bands.filter((one) => one !== band))
      assert.equal(line.includes(bandWord(other)), false, `${score} is not ${other}: ${line}`);
  }
});

// A person's interests, avatar, usual name and messages seen (spec 2026-11-12 what-the-frame-dropped, slice 2). A person
// entry of the mind carries
//   interests: Array<string>; usualName: string | null; messagesSeen: number | null
// and an entry at the detail `whole` prints, after the manner of speech and before the claims, in this order:
//   `memory.interests` (`{value}`, the interests joined by `; `), then `memory.avatar` (`{value}`, the description) or
//   `memory.avatarDefault` for the platform's default avatar, of the account on the frame's interface, else of the first
//   account with one, then `memory.usualName` (`{value}`) when the name differs from the heading's after folding, then
//   `memory.messagesSeen` (`{count}`, rounded down by the step `memory.ownLines` uses).
// The labels below are the test's own, each opening with a marker the test finds a line by.
const SEEN_LABELS = {
  ...shippedLabels,
  memory: {
    ...shippedLabels.memory,
    interests: 'INT {value}',
    avatar: 'AVA {value}',
    avatarDefault: 'AVD',
    usualName: 'USU {value}',
    messagesSeen: 'SEEN {count}',
  },
};
const MARKERS = ['INT ', 'AVA ', 'AVD', 'USU ', 'SEEN '];

const renderSeen = (person: PersonEntry, author: FrameParty | null = null): string =>
  section(
    memoryBlockOf(mindOfEntries({ people: [person] }), frameOf(frameInput({ author })), SEEN_LABELS, nameOf).text,
    'people'
  );
const seenLines = (person: PersonEntry, author: FrameParty | null = null): Array<string> =>
  renderSeen(person, author).trim().split('\n');
const lineOf = (lines: Array<string>, marker: string): string => lines.find((line) => line.startsWith(marker)) ?? '';
lines.findIndex((line) => line.startsWith(marker));
const markersIn = (lines: Array<string>): Array<string> =>
  MARKERS.filter((marker) => lines.some((line) => line.startsWith(marker)));

const described = (text: string): string => JSON.stringify({ hash: 'h1', text, describedAt: null });
const DEFAULT_AVATAR = JSON.stringify({ hash: null, default: true });
const accountOf = (iface: string, native: string, avatar: string | null): PersonEntry['profileAccounts'][number] => ({
  id: `${iface}:${native}`,
  iface,
  platformId: native,
  handle: null,
  displayName: null,
  avatar,
  profileText: null,
});
const KNOWN = personEntry('222', 'Νίκος', {
  relation: 'ΣΧΕΣΗ',
  character: 'ΧΑΡΑΚΤΗΡΑΣ',
  style: 'ΤΡΟΠΟΣ',
  claims: [{ id: 'claim:1', kind: 'fact', text: 'ΙΣΧΥΡΙΣΜΟΣ' }],
  interests: ['ΜΟΥΣΙΚΗ', 'ΣΚΑΚΙ'],
  usualName: 'Νικολάκης',
  messagesSeen: 120,
  profileAccounts: [accountOf('fake', '222', described('ΓΑΤΑ'))],
});

test('a full entry holds the interests, avatar, usual name and count after the manner of speech and before the claims', () => {
  // Bug: the lines are pushed after the claims or before the character, so the order of the entry differs from the spec.
  const lines = seenLines(KNOWN);
  const order = ['ΤΡΟΠΟΣ', 'INT ', 'AVA ', 'USU ', 'SEEN ', 'ΙΣΧΥΡΙΣΜΟΣ'].map((part) =>
    lines.findIndex((line) => line.includes(part))
  );
  assert.ok(
    order.every((at) => at >= 0),
    `every part stands in the entry: ${order.join(',')}`
  );
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    lines.join(' | ')
  );
  const [interests, avatar, usual, seen] = ['INT ', 'AVA ', 'USU ', 'SEEN '].map((marker) => lineOf(lines, marker));
  assert.equal(interests, 'INT ΜΟΥΣΙΚΗ; ΣΚΑΚΙ');
  assert.ok(avatar.includes('ΓΑΤΑ') && usual.includes('Νικολάκης') && seen.includes('100'), lines.join(' | '));
});

test('an entry cut to compact holds none of the four lines', () => {
  // Bug: the lines are printed for every detail, so the entry the budget cut down is as long as a whole one.
  assert.deepEqual(markersIn(seenLines({ ...KNOWN, detail: 'compact' })), []);
});

test('an entry cut to its name holds none of the four lines', () => {
  // Bug: the lines are printed for every detail, so the entry the budget cut down to a name is as long as a whole one.
  assert.deepEqual(markersIn(seenLines({ ...KNOWN, detail: 'name' })), []);
});

const FOND_NOW = { score: 31.6, reason: 'ΛΟΓΟΣ-ΤΕΛΕΥΤΑΙΑΣ', moves: [] };

test('the person she answers cut to a name holds her attitude and none of the four lines', () => {
  // Bug: the new lines are bound to the attitude condition, so a short entry of the counterpart grows with them.
  const { interests, usualName, messagesSeen } = KNOWN;
  const cut = { ...ELENI, detail: 'name' as const, attitude: FOND_NOW, interests, usualName, messagesSeen };
  const text = renderSeen(cut, AS_ELENI);
  assert.ok(text.includes('ΛΟΓΟΣ-ΤΕΛΕΥΤΑΙΑΣ'), text);
  assert.deepEqual(markersIn(text.trim().split('\n')), []);
});

test('a person the reader kept, cut to compact, holds her attitude and none of the four lines', () => {
  // Bug: the entries that keep the attitude at a low detail also keep the lines of slice 2.
  const kept = { ...KNOWN, detail: 'compact' as const, keep: true, attitude: FOND_NOW };
  const lines = seenLines(kept);
  assert.ok(lines.join('\n').includes('ΛΟΓΟΣ-ΤΕΛΕΥΤΑΙΑΣ'), lines.join(' | '));
  assert.deepEqual(markersIn(lines), []);
});

test('a person with no interest, no avatar, no usual name and no count has none of the lines', () => {
  // Bug: an empty value prints its label alone, a line that says nothing and costs tokens.
  const bare = personEntry('222', 'Νίκος', { profileAccounts: [accountOf('fake', '222', null)] });
  assert.deepEqual(markersIn(seenLines(bare)), []);
});

test('the usual name that equals the heading after folding gives no line, another name gives one', () => {
  // Bug: the entry repeats its own name as the one she is called most, or compares without folding case and accents.
  const same = markersIn(seenLines({ ...KNOWN, usualName: 'ΝΙΚΟΣ' }));
  assert.equal(same.includes('USU '), false);
  const accented = markersIn(seenLines({ ...personEntry('333', 'Ελένη'), usualName: 'ΕΛΕΝΗ' }));
  assert.equal(accented.includes('USU '), false);
  assert.ok(markersIn(seenLines({ ...KNOWN, usualName: 'Νικολάκης' })).includes('USU '));
});

test('the usual name reads as a name shown: its emoji are dropped', () => {
  // Bug: the name goes into the entry raw, so an emoji of the platform name shows where every other name loses it.
  const lines = seenLines({ ...KNOWN, usualName: 'Νικολάκης 🎉' });
  assert.equal(lineOf(lines, 'USU '), 'USU Νικολάκης');
});

test('the default avatar of the platform reads through memory.avatarDefault and no description', () => {
  // Bug: the stored JSON of the default avatar is printed as a description, or the default is dropped.
  const person = { ...KNOWN, profileAccounts: [accountOf('fake', '222', DEFAULT_AVATAR)] };
  const lines = seenLines(person);
  assert.deepEqual(markersIn(lines), ['INT ', 'AVD', 'USU ', 'SEEN ']);
  assert.equal(lineOf(lines, 'AVD'), 'AVD');
});

test('a described avatar reads through memory.avatar with its text, never the stored JSON', () => {
  // Bug: the entry prints the stored field as it is, hash and all.
  const lines = seenLines(KNOWN);
  assert.equal(lineOf(lines, 'AVA '), 'AVA ΓΑΤΑ');
  assert.equal(markersIn(lines).includes('AVD'), false);
  assert.doesNotMatch(lines.join('\n'), /h1|describedAt/);
});

test('the avatar of the account on the frame interface wins over the avatar of another account listed before it', () => {
  // Bug: the first account of the person with an avatar is taken, so a person who wears another face elsewhere is
  // described by it in the place where she sees the face of this one.
  const person = {
    ...KNOWN,
    profileAccounts: [accountOf('other', '555', described('ΑΛΛΟ')), accountOf('fake', '222', described('ΕΔΩ'))],
  };
  assert.equal(lineOf(seenLines(person), 'AVA '), 'AVA ΕΔΩ');
});

test('with no avatar on the account in this place the first account that has one is described', () => {
  // Bug: the entry has no avatar line for a person whose face is stored on another account only.
  const person = {
    ...KNOWN,
    profileAccounts: [
      accountOf('fake', '222', null),
      accountOf('other', '555', described('ΠΡΩΤΟ')),
      accountOf('third', '777', described('ΔΕΥΤΕΡΟ')),
    ],
  };
  assert.equal(lineOf(seenLines(person), 'AVA '), 'AVA ΠΡΩΤΟ');
});

test('an avatar field that is not a stored avatar gives no line and shows no raw text', () => {
  // Bug: a hand-edited or old field is printed as it is.
  const person = { ...KNOWN, profileAccounts: [accountOf('fake', '222', 'not json at all')] };
  const text = renderSeen(person);
  assert.equal(
    markersIn(text.split('\n')).some((marker) => marker.startsWith('AV')),
    false
  );
  assert.doesNotMatch(text, /not json at all/);
});

test('the count is the same across two renders while the person wrote fewer messages than a step, and changes at it', () => {
  // Bug: the exact count is printed, so the entry changes bytes with every message and breaks the cached request.
  const at = (messagesSeen: number): string => renderSeen({ ...KNOWN, messagesSeen });
  assert.equal(at(120), at(199));
  assert.notEqual(at(199), at(200));
  assert.equal(lineOf(at(120).split('\n'), 'SEEN '), 'SEEN 100');
});

test('an interest that mentions a person reads with the handle the rest of the request uses', () => {
  // Bug: the interests skip the mention path of the stored texts, so a bare `<@id>` with a platform id shows in <people>.
  const person = { ...KNOWN, detail: 'whole' as const, interests: ['ΜΟΥΣΙΚΗ ΜΕ <@777>'] };
  const items = memoryItemsOf(
    mindOfEntries({ people: [person] }),
    frameOf(frameInput({ author: null })),
    { ...SEEN_LABELS, authors: WITH_AUTHORS.authors },
    nameOf,
    null,
    new Set(),
    () => null,
    MENTIONS
  );
  const all = items.map((item) => item.text).join('\n');
  assert.ok(all.includes('ΜΟΥΣΙΚΗ ΜΕ @u7ele'), all);
  assert.doesNotMatch(all, /<@|&lt;@|\b777\b/);
});

test('two renders with nothing changed between them hold the same bytes', () => {
  // Bug: a line takes the clock, a Map order or a random value, so the held part of the request changes by itself.
  const first = renderSeen(KNOWN);
  const second = renderSeen({ ...KNOWN, interests: [...KNOWN.interests] });
  assert.equal(first, second);
});
