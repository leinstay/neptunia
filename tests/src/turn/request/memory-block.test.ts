import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { handleOf } from '../../../../src/behavior/handles.ts';
import { userText as contentText, userText } from '../../../../src/behavior/prompt.ts';
import { fill, formatDay } from '../../../../src/format.ts';
import { affinityBand } from '../../../../src/memory/affinity.ts';
import type { ExcerptEntry, Mind, PersonEntry, PlaceEntry } from '../../../../src/memory/db/mind-read.ts';
import { insertRows } from '../../../../src/memory/db/rows.ts';
import type { ListedPerson } from '../../../../src/memory/db/service-lists.ts';
import type { Lookup } from '../../../../src/turn/calls.ts';
import { frameOf, type FrameParty } from '../../../../src/turn/request/frame.ts';
import {
  type EntryRefs,
  factItemsOf,
  memoryItemsOf,
  renderMemory,
  serviceItemsOf,
} from '../../../../src/turn/request/memory-block.ts';
import type { Labels, MemoryLabels } from '../../../../src/turn/request/types.ts';
import { buildRequest, type Built } from '../../../fixtures/built-request.ts';
import { replyTurn, replyTurns } from '../../../fixtures/diary-awareness.ts';
import { dbOf } from '../../../fixtures/diary-mirror.ts';
import { frameInput, ROOM_CHAIN } from '../../../fixtures/frame-input.ts';
import { labels } from '../../../fixtures/labels.ts';
import { type FakePlace, line, meanwhileReads } from '../../../fixtures/meanwhile-reads.ts';
import {
  addAttitude,
  addClaim,
  addDm,
  addLine,
  addPerson,
  addRoom,
  AT,
  noteInterface,
  openWorld,
  rootId,
  type World,
} from '../../../fixtures/memory-db/mind-world.ts';
import { claimEntry, excerptEntry, mindOfEntries, personEntry, placeEntry } from '../../../fixtures/mind-entries.ts';
import { OWNER_PERSON } from '../../../fixtures/owner-accounts.ts';
import { baseInput, fakeConfig, fakePrompts, makeMessage, MIN, NOW } from '../../../fixtures/prompt-rig.ts';
import {
  addInterest,
  blockOf,
  CLI_CHAT,
  heartbeatWorld,
  NIKOS,
  ELENI as REPLY_TURN_HANDLES_ELENI,
  ELENI as REPLY_TURN_MEMORY_ELENI,
  replyRun,
  type ReplyRun,
  type ReplyStep,
  replyTurns as replyTurnMemoryReplyTurns,
  serviceTurn,
  serviceWake,
  serviceWorld,
  TEXT,
  TURN_NOW,
} from '../../../fixtures/service-turn.ts';
import { shippedLabels } from '../../../fixtures/shipped-labels.ts';
import { call, toolAnswer } from '../../../fixtures/tool-answers.ts';
import { useIface } from '../../../fixtures/turn-world.ts';

/** The entry of the place named `name` in `<memory>`'s `<places>`: from its heading to the next blank line. */
function placeEntryOf(request: unknown, name: string): string {
  const user = (request as Array<{ content: unknown }>)[1]?.content;
  const places = /<places>\n([\s\S]*?)\n<\/places>/.exec(userText(user))?.[1] ?? '';
  // A place reads in words: the entry's heading holds the name in quotes, no `>`.
  const entry = places.split('\n\n').find((one) => (one.split('\n')[0] ?? '').includes(`"${name}"`));
  assert.ok(entry, `<memory> shows ${name}`);
  return entry;
}

const marked = (entry: string): boolean => entry.split('\n').includes(labels.memory.diary);

// Slice 4: "a turn marks the mirrored place as the diary in <server>, byte for byte as diary.placeId did" asserted the
// recorded `<server>` block, which a reply on the frame no longer has. The mark moved to the place's `<memory>` entry.
test("a reply marks the mirrored place as the persona's diary in <memory>, and no other place", async () => {
  // Bug: the mirror is read but the mark is lost with `<server>`, so the persona speaks of their own diary as a stranger's room.
  const { request } = await replyTurn({ here: 'c1', mirrors: ['d1'] });
  assert.deepEqual(
    ['journal', 'notes', 'general'].map((name) => marked(placeEntryOf(request, name))),
    [true, false, false]
  );
});

// The persona cannot write in a mirror place at all (stage 3 design, section 9): the refusal, the event that opens no turn and
// the publisher that still writes there are tested in tests/src/tools/operations/shared.test.ts,
// tests/src/pipeline/chats.test.ts and tests/src/behavior/mirror.test.ts.

// Slice 4: on the frame the places of a reply are `<memory>`'s, so the mark is asserted there instead of in `<server>`.
test('with two mirrors both places carry the diary mark in <memory>', async () => {
  const { request } = await replyTurn({ here: 'c1', mirrors: ['d1', 'd2'] });
  assert.deepEqual(
    ['journal', 'notes', 'general'].map((name) => marked(placeEntryOf(request, name))),
    [true, true, false]
  );
});

test('a place whose mirror is disabled loses the diary mark in <memory> at the next request', async () => {
  const { requests } = await replyTurns({
    here: 'c1',
    mirrors: ['d1'],
    steps: [
      { answers: ['<msg>γεια</msg>'] },
      {
        before: (memoryDb) => {
          dbOf(memoryDb).prepare('UPDATE mirrors SET enabled = 0').run();
        },
        answers: ['<msg>γεια</msg>'],
      },
    ],
  });
  assert.deepEqual(
    [marked(placeEntryOf(requests[0], 'journal')), marked(placeEntryOf(requests[1], 'journal'))],
    [true, false]
  );
});

const DAY = 86_400_000;

/** The words of the bands of the persona's attitude. */
const BANDS: Record<string, string> = shippedLabels.affinity?.bands ?? {};

/** The entries of `<people>`, each with all its lines. */
const peopleEntries = (text: string): Array<string> =>
  (new RegExp('<people>\\n([\\s\\S]*?)\\n</people>').exec(blockOf(text, 'memory'))?.[1] ?? '').split('\n\n');

/** The entry of `<people>` that opens with `marker`, '' with none. */
const entryWith = (text: string, marker: string): string =>
  peopleEntries(text).find((entry) => entry.startsWith(marker)) ?? '';

/** The words of the entry of a reply turn. */
const MEM = (shippedLabels.memory ?? {}) as Record<string, string>;

describe('an inner turn of a service', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('<memory> of a turn with no place raised from a group line holds that person private fact, under an origin', async () => {
    // Bug: the service reads memory under a group scope and loses what the persona knows from a direct chat, or seeds the
    // reader from a chat window it does not have, so the person who wrote beside the persona's line never enters.
    // Changed: the wake was a heartbeat, whose `<memory>` lists people and places instead of what the persona's lines raise.
    const run = await serviceTurn({ wake: serviceWake('intention_due'), answers: ['<skip/>'], chat: null });
    const memory = blockOf(run.requests[0] ?? '', 'memory');
    assert.ok(memory.includes(TEXT.eleniSecret), memory);
    const entry = memory.split('\n\n').find((part) => part.includes(TEXT.eleniSecret)) ?? '';
    const origins = Object.values(shippedLabels.memory?.origin ?? {}).filter((value) => typeof value === 'string');
    assert.ok(
      origins.some((origin) => entry.includes(origin)),
      entry
    );
  });

  test('a heartbeat entry carries the attitude, real name, aliases and interests in the words of a reply entry', async () => {
    // Bug: the service collector renders a person through its own words, the band alone and `into:`, so one fact reads
    // two ways and the number, the reason and the latest changes of the attitude are missing.
    const world = heartbeatWorld();
    world.db.prepare('UPDATE people SET real_name = ? WHERE id = ?').run(JSON.stringify(['Νικόλαος']), NIKOS);
    addClaim(world.db, { id: 'alias:n1', person: NIKOS, kind: 'alias', text: 'Νικ', audience: { group: 'fake' } });
    addAttitude(world.db, {
      id: 'aff:n2',
      person: NIKOS,
      at: new Date(TURN_NOW - DAY).toISOString(),
      applied: 2,
      score: 42,
      reason: 'ΛΟΓΟΣ-ΝΕΟΣ',
      audience: { group: 'fake' },
    });
    addInterest(world, 'int:n1', NIKOS, 'ΕΝΔΙΑΦΕΡΟΝ-ΕΝΑ', 2, DAY);
    addInterest(world, 'int:n2', NIKOS, 'ΕΝΔΙΑΦΕΡΟΝ-ΔΥΟ', 1, DAY);
    const run = await serviceTurn({ wake: serviceWake('heartbeat'), answers: ['<skip/>'], chat: null, world });
    const nikos = entryWith(run.requests[0] ?? '', `@${handleOf(NIKOS)}`);
    const lines = nikos.split('\n');
    const band = BANDS[affinityBand(42)] ?? '';
    assert.ok(lines.includes(fill(MEM.attitude ?? '', { score: 42, band, reason: 'ΛΟΓΟΣ-ΝΕΟΣ' })), nikos);
    assert.ok(nikos.includes('2026-11-01') && nikos.includes('2026-10-28'), `both changes: ${nikos}`);
    assert.ok(lines.includes(fill(MEM.realName ?? '', { value: 'Νικόλαος' })), nikos);
    assert.ok(lines.includes(fill(MEM.aliases ?? '', { value: 'Νικ' })), nikos);
    assert.ok(lines.includes(fill(MEM.interests ?? '', { value: 'ΕΝΔΙΑΦΕΡΟΝ-ΕΝΑ; ΕΝΔΙΑΦΕΡΟΝ-ΔΥΟ' })), nikos);
    assert.ok(
      lines.some((line) => line.includes('222') && line.includes('Νίκος')),
      `the account line: ${nikos}`
    );
  });

  test('a heartbeat entry holds no avatar even when the account stores a described one', async () => {
    // Bug: the entry goes through the renderer of a reply turn, which prints the avatar of each account, and a heartbeat
    // runs in no interface where a face is seen.
    const world = heartbeatWorld();
    const avatar = JSON.stringify({ hash: 'h1', text: 'ΕΙΚΟΝΑ-ΝΙΚΟΥ', describedAt: null });
    world.db.prepare('UPDATE accounts SET avatar = ? WHERE id = ?').run(avatar, 'fake:222');
    const run = await serviceTurn({ wake: serviceWake('heartbeat'), answers: ['<skip/>'], chat: null, world });
    const nikos = entryWith(run.requests[0] ?? '', `@${handleOf(NIKOS)}`);
    assert.ok(nikos.includes('Νίκος'), nikos);
    assert.ok(!nikos.includes('ΕΙΚΟΝΑ-ΝΙΚΟΥ'), nikos);
  });
});

const ELENI = personEntry('111', 'Ελένη', { evidence: 'counterpart', relation: 'ΣΧΕΣΗ-ΕΛΕΝΗΣ' });

const AS_ELENI: FrameParty = { personId: ELENI.personId, accountId: 'fake:111', nativeId: '111', name: 'Ελένη' };

const FRAME = frameOf(
  frameInput({ now: NOW, timezone: 'Europe/Moscow', author: AS_ELENI, trigger: { messageId: 'm1', authorId: '111' } })
);

const HISTORY = [makeMessage('m1', NOW - MIN, { authorId: '111', authorName: 'Ελένη', content: 'γεια σου' })];

const nameOf = (id: string): string | null => (id === '111' ? 'Ελένη' : null);

/** Eight rooms, each with a purpose, a tone and topics long enough that `<places>` wants more than its share. */
const ROOMS: Array<PlaceEntry> = Array.from({ length: 8 }, (_, i) =>
  placeEntry(`place:room${i}`, `αίθουσα${i}`, {
    purpose: `ΣΚΟΠΟΣ-${i} η αίθουσα όπου μιλούν για βιβλία, ταινίες, μουσική και ό,τι άλλο φέρνει η μέρα`,
    tone: `ΥΦΟΣ-${i} χαλαρό, με αστεία και μεγάλες κουβέντες αργά το βράδυ`,
    topics: `ΘΕΜΑΤΑ-${i} βιβλία, ταινίες, μουσική, ταξίδια, φαγητό`,
  })
);

/** Lore of the first rooms, more than the lore share holds. */
const LORE = ROOMS.slice(0, 4).map((room, i) =>
  claimEntry(`claim:${i}`, room.placeId, `ΘΡΥΛΟΣ-${i} εδώ κάποτε κάποιος έγραψε ένα ποίημα για τη βροχή και τη θάλασσα`)
);

/** `count` excerpts of a line found outside the window, the turn's own `<found>`. */
const excerpts = (count: number): Array<ExcerptEntry> =>
  Array.from({ length: count }, (_, i) =>
    excerptEntry(
      `src:fake:x${i}:1:seen`,
      'place:room0',
      `ΑΠΟΣΠΑΣΜΑ-${i} κάτι που ειπώθηκε παλιά για τη βροχή και τη θάλασσα`
    )
  );

/**
 * A reply in the room with Eleni, the rooms and their lore in memory, the persona's line in another room in `<meanwhile>`, and
 * `found` as the reader's excerpts. The memory budget is 1000 tokens: people 50, places 300, lore 50 and
 * found 600, so what `<found>` leaves unused is most of the budget.
 */
function request(found: Array<ExcerptEntry>): Built {
  return buildRequest(
    baseInput({
      config: fakeConfig({
        context: {
          meanwhile: { messages: 8, around: 2 },
          recall: { extractChars: 1200, maxItems: 6 },
          memory: {
            budgetTokens: 1000,
            budgetShare: null,
            shares: { people: 0.05, places: 0.3, lore: 0.05, found: 0.6 },
          },
        },
      }),
      prompts: fakePrompts({ labels: shippedLabels }),
      frame: FRAME,
      whereabouts: { kind: 'place', iface: 'fake', private: false, chain: ROOM_CHAIN },
      history: HISTORY,
      trigger: HISTORY[0],
      triggerKind: 'mention',
      nameOf,
      mind: mindOfEntries({ people: [ELENI], places: ROOMS, lore: LORE, found }),
      meanwhileReads: meanwhileReads([
        {
          id: 'place:room1',
          path: ['fake', 'Αγορά', 'αίθουσα1'],
          dm: false,
          lines: [
            line('place:room1', 'c1', NOW - 40 * MIN, '111', 'πρώτη'),
            line('place:room1', 'c2', NOW - 39 * MIN, null, 'δική της'),
          ],
        },
      ]),
    })
  );
}

/** The body of the root block `<tag>` of a request's user message, '' when absent. */
function rootOf(built: Built, tag: string): string {
  const [, message] = built.messages;
  const user = message.content.map((part) => String(part.text ?? '')).join('');
  return new RegExp(`^<${tag}>\\n([\\s\\S]*?)\\n</${tag}>$`, 'm').exec(user)?.[1] ?? '';
}

/** The body of a subtag of `<memory>` in a request's user message, '' when absent. */
function subtagOf(built: Built, tag: string): string {
  return new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(rootOf(built, 'memory'))?.[1] ?? '';
}

test('the entries of <people>, <places> and <lore> print the same whatever <found> holds, from nothing to its full share', () => {
  // Bug: the share <found> leaves unused is lent to <places> and <lore>, so a turn that finds less shows a place at a
  // higher detail and one more lore claim, and the bytes of <memory> change with what the turn itself found.
  const empty = request([]);
  assert.ok(subtagOf(empty, 'places').includes('ΣΚΟΠΟΣ-0'), 'the rooms are shown');
  for (const count of [1, 4, 12]) {
    const built = request(excerpts(count));
    assert.ok(rootOf(built, 'found').includes('ΑΠΟΣΠΑΣΜΑ-0'), `<found> holds what was found (${count})`);
    for (const tag of ['people', 'places', 'lore'])
      assert.equal(subtagOf(built, tag), subtagOf(empty, tag), `<${tag}> with ${count} excerpts in <found>`);
  }
});

const TIMEZONE = 'Europe/Moscow';

// A party carries the id the interface names them by (plan 2026-11-08 ids-by-links, slice 7b): the request no longer
// parses it out of the account id.
const PROMPT_READER_AS_ELENI: FrameParty = {
  personId: ELENI.personId,
  accountId: 'fake:111',
  nativeId: '111',
  name: 'Ελένη',
};

const CLUB = placeEntry('place:club', 'λέσχη', { purpose: 'ΣΚΟΠΟΣ-ΛΕΣΧΗΣ' });

const PROMPT_READER_FRAME = frameOf(
  frameInput({
    now: NOW,
    timezone: TIMEZONE,
    author: PROMPT_READER_AS_ELENI,
    trigger: { messageId: 'm1', authorId: '111' },
  })
);

const WHEREABOUTS = { kind: 'place', iface: 'fake', private: false, chain: ROOM_CHAIN };

const CONTEXT = {
  meanwhile: { messages: 8, around: 2 },
  recall: { extractChars: 1200, maxItems: 6 },
};

const PROMPT_READER_HISTORY = [
  makeMessage('m1', NOW - MIN, { authorId: '111', authorName: 'Ελένη', content: 'γεια σου' }),
];

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

function promptReaderRequest(over: Record<string, unknown> = {}): Built {
  return buildRequest(
    baseInput({
      config: fakeConfig({ context: CONTEXT }),
      prompts: fakePrompts({ labels: shippedLabels }),
      frame: PROMPT_READER_FRAME,
      whereabouts: WHEREABOUTS,
      history: PROMPT_READER_HISTORY,
      trigger: PROMPT_READER_HISTORY[0],
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

test('a place the answered line names keeps its entry in <places> when the section drops other places', () => {
  // Bug (2026-11-10): a user named a place by its name, the reader raised it by that word, and the budget of
  // <places> kept the higher-ranked places first and dropped it, so the persona never saw the place they were asked about.
  const crowd = Array.from({ length: 40 }, (_, i) =>
    placeEntry(`place:room-${i}`, `αίθουσα-${String(i).padStart(2, '0')}`)
  );
  const kitchen = placeEntry('place:kitchen', 'κουζίνα', { evidence: 'word' });
  const asked = makeMessage('m1', NOW - MIN, {
    authorId: '111',
    authorName: 'Ελένη',
    content: 'τι φωτογραφήθηκε στην κουζίνα στις 8 Νοεμβρίου;',
  });
  const memory = {
    budgetTokens: 400,
    // `people` holds the 0.1 of the share `recent`, which left with its block.
    shares: { people: 0.6, places: 0.15, lore: 0.15, found: 0.1 },
  };
  const built = promptReaderRequest({
    config: fakeConfig({ context: { ...CONTEXT, memory } }),
    history: [asked],
    trigger: asked,
    mind: mindOfEntries({ people: [ELENI], places: [...crowd, kitchen] }),
  });
  const places = /<places>([\s\S]*?)<\/places>/.exec(block(built, 'memory'))?.[1] ?? '';
  const shown = crowd.filter((place) => places.includes(String(place.name)));
  assert.ok(shown.length < crowd.length, `the section dropped places: ${places}`);
  assert.ok(shown.length > 0, `the section kept places: ${places}`);
  assert.ok(places.includes('κουζίνα'), places);
});

/** The body of `<places>` in `<memory>`, '' when absent. */
const placesOf = (built: Built): string => /<places>([\s\S]*?)<\/places>/.exec(block(built, 'memory'))?.[1] ?? '';

test('<places> takes the share the people leave unused, as the graph reader lends it', () => {
  // Bug (2026-11-10): the request cut each memory block a second time at its own share, so <places> lost entries the
  // graph reader had kept with a loan from an unused people share, while <memory> used two thirds of its budget.
  const crowd = Array.from({ length: 20 }, (_, i) =>
    placeEntry(`place:room-${i}`, `αίθουσα-${String(i).padStart(2, '0')}`, { purpose: 'σκοπός '.repeat(10) })
  );
  const memory = {
    budgetTokens: 4000,
    // `people` holds the 0.1 of the share `recent`, which left with its block.
    shares: { people: 0.6, places: 0.15, lore: 0.15, found: 0.1 },
  };
  const built = promptReaderRequest({
    config: fakeConfig({ context: { ...CONTEXT, memory } }),
    mind: mindOfEntries({ people: [ELENI], places: crowd }),
  });
  const places = placesOf(built);
  const shown = crowd.filter((place) => places.includes(String(place.name)));
  assert.equal(shown.length, crowd.length, places);
});

test('a place the graph reader keeps whatever the budget stays in <places> when it alone is over the share', () => {
  // Bug: the request took the kept place first but still cut it at the places share, so the place the persona is in, or the
  // one the line names, left <memory> whenever its description was longer than the share.
  const kept = placeEntry('place:kept', 'αποθήκη', { keep: true, purpose: 'ΣΚΟΠΟΣ-ΑΠΟΘΗΚΗΣ '.repeat(40) });
  const memory = {
    budgetTokens: 200,
    // `people` holds the 0.1 of the share `recent`, which left with its block.
    shares: { people: 0.6, places: 0.15, lore: 0.15, found: 0.1 },
  };
  const built = promptReaderRequest({
    config: fakeConfig({ context: { ...CONTEXT, memory } }),
    mind: mindOfEntries({ people: [ELENI], places: [kept] }),
  });
  assert.ok(placesOf(built).includes('αποθήκη'), block(built, 'memory'));
});

test('the request cuts <places> at the same total the graph reader takes from budgetShare', () => {
  // Bug: the graph reader and the request's second cut read the total separately, so a share that lowered one left
  // the other at budgetTokens and the two disagreed about what stays in <memory>.
  const crowd = Array.from({ length: 20 }, (_, i) =>
    placeEntry(`place:room-${i}`, `αίθουσα-${String(i).padStart(2, '0')}`, { purpose: 'σκοπός '.repeat(10) })
  );
  // `people` holds the 0.1 of the share `recent`, which left with its block.
  const shares = { people: 0.6, places: 0.15, lore: 0.15, found: 0.1 };
  const shown = (memory: Record<string, unknown>): string =>
    placesOf(
      promptReaderRequest({
        config: fakeConfig({ context: { ...CONTEXT, memory }, llm: { maxRequestTokens: 40000 } }),
        mind: mindOfEntries({ people: [ELENI], places: crowd }),
      })
    );
  const wide = shown({ budgetTokens: 4000, shares });
  const byShare = shown({ budgetTokens: 4000, budgetShare: 0.01, shares });
  const byTotal = shown({ budgetTokens: 400, shares });
  assert.notEqual(byShare, wide, 'the share did not lower the total');
  assert.equal(byShare, byTotal);
});

test('<memory> prints people after the one the persona answers, claims, places and lore by id whatever the rank', () => {
  // Bug: the request prints the entries in the graph reader's rank, which changes with every trigger, so one set of
  // entries gives other bytes each turn. Every list below is handed over in the reverse of its id order.
  const eleni = {
    ...ELENI,
    claims: [
      { id: 'claim:2', kind: 'fact', text: 'ΙΣΧΥΡΙΣΜΟΣ-ΔΥΟ' },
      { id: 'claim:1', kind: 'fact', text: 'ΙΣΧΥΡΙΣΜΟΣ-ΕΝΑ' },
    ],
  };
  const mind = mindOfEntries({
    people: [
      eleni,
      personEntry('333', 'Ζωή', { evidence: 'author' }),
      personEntry('222', 'Νίκος', { evidence: 'author' }),
    ],
    places: [
      placeEntry('place:b', 'βήτα', { purpose: 'ΣΚΟΠΟΣ-Β' }),
      placeEntry('place:a', 'άλφα', { purpose: 'ΣΚΟΠΟΣ-Α' }),
    ],
    lore: [claimEntry('claim:l2', 'place:a', 'ΘΡΥΛΟΣ-ΔΥΟ'), claimEntry('claim:l1', 'place:a', 'ΘΡΥΛΟΣ-ΕΝΑ')],
  });
  const memory = block(promptReaderRequest({ mind }), 'memory');
  const before = (a: string, b: string): boolean => memory.indexOf(a) >= 0 && memory.indexOf(a) < memory.indexOf(b);
  assert.ok(before('Ελένη', 'Νίκος') && before('Νίκος', 'Ζωή'), memory);
  assert.ok(before('ΙΣΧΥΡΙΣΜΟΣ-ΕΝΑ', 'ΙΣΧΥΡΙΣΜΟΣ-ΔΥΟ'), memory);
  assert.ok(before('ΣΚΟΠΟΣ-Α', 'ΣΚΟΠΟΣ-Β'), memory);
  assert.ok(before('ΘΡΥΛΟΣ-ΕΝΑ', 'ΘΡΥΛΟΣ-ΔΥΟ'), memory);
});

/** The club with `count` lines of the persona there, the last an hour before the turn. */
const clubWith = (count: number): Array<ReturnType<typeof placeEntry>> => [
  { ...CLUB, ownLines: count, ownLastAt: new Date(NOW - 60 * MIN).toISOString() },
];

test('the entry of a place reads the same after the persona writes one more line there on the same day', () => {
  // Bug: the entry prints the exact count of the persona's lines, so the place they talk in changes with every line.
  const places = (count: number): string => {
    const memory = block(
      promptReaderRequest({ mind: mindOfEntries({ people: [ELENI], places: clubWith(count) }) }),
      'memory'
    );
    return /<places>\n([\s\S]*?)\n<\/places>/.exec(memory)?.[1] ?? '';
  };
  assert.ok(places(6).includes('λέσχη'), places(6));
  assert.equal(places(7), places(6));
});

test('a place the persona wrote in keeps a line saying so, and a place they never wrote in has none', () => {
  // Guard: the count leaves the entry with the line it stood on, and the persona can no longer tell a room they talk in from one
  // they never wrote in.
  const lines = (count: number): number => {
    const memory = block(
      promptReaderRequest({ mind: mindOfEntries({ people: [ELENI], places: clubWith(count) }) }),
      'memory'
    );
    return (/<places>\n([\s\S]*?)\n<\/places>/.exec(memory)?.[1] ?? '').split('\n').length;
  };
  assert.equal(lines(6), lines(0) + 1);
});

const REPLY_TURN_HANDLES_MIN = 60_000;

const THINK = '<think>STEP 4. So: answer.</think>';

const SAY = `${THINK}<msg>εντάξει</msg>`;

const iso = (at: number): string => new Date(at).toISOString();

const REPLY_TURN_HANDLES_NIKOS = 'person:fake:4242';

const GIANNIS = 'person:tele:88';

/** The texts of the world's lines, each unique so a test finds its line in one block. */
const LINE = {
  ownerGarden: 'ΠΕΤΡΟΣ-ΣΤΟΝ-ΚΗΠΟ',
  ownerRoom: 'ΠΕΤΡΟΣ-ΣΤΟ-ΓΕΝΙΚΑ',
  ownerCli: 'ΠΟΙΟΣ-ΕΓΡΑΨΕ-ΣΤΟΝ-ΚΗΠΟ',
  giannisHarbour: 'ΓΙΑΝΝΗΣ-ΣΤΟ-ΛΙΜΑΝΙ',
  eleniGarden: 'ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ',
  nikosOne: 'ΝΙΚΟΣ-ΑΠΟ-ΤΟ-ΕΝΑ',
  nikosTwo: 'ΝΙΚΟΣ-ΑΠΟ-ΤΟ-ΔΥΟ',
} as const;

/** The name the owner's command line account carries, and the one their account on the fake interface carries. */
const OWNER_CLI_NAME = 'ΠΕΤΡΟΣ-ΚΟΝΣΟΛΑ';

const OWNER_FAKE_NAME = 'Πέτρος';

/**
 * The service world, with the owner holding an account on the command line and one on the fake interface, their line in
 * the garden `c2` right after the persona's, and Γιάννης, who has an account on `tele` alone and wrote in the harbour `k1` right
 * after the persona's line there. Ελένη's line before the persona's in the garden mentions nobody; the owner's mentions Ελένη.
 */
function handleWorld(): World {
  const world = serviceWorld();
  addPerson(world.db, {
    id: OWNER_PERSON,
    accounts: [
      { id: 'cli:owner', iface: 'cli', native: 'owner', names: [OWNER_CLI_NAME] },
      { id: 'fake:u1', iface: 'fake', native: 'u1', names: [OWNER_FAKE_NAME] },
    ],
  });
  addDm(world.db, { iface: 'cli', native: 'owner', person: OWNER_PERSON, account: 'cli:owner' });
  addLine(world.db, {
    id: 'o1',
    iface: 'fake',
    place: 'fake:channel:c2',
    author: 'fake:u1',
    text: `${LINE.ownerGarden} <@111>`,
    at: iso(TURN_NOW - 49 * REPLY_TURN_HANDLES_MIN),
  });
  addPerson(world.db, { id: GIANNIS, accounts: [{ id: 'tele:88', iface: 'tele', native: '88', names: ['Γιάννης'] }] });
  addLine(world.db, {
    id: 'y1',
    iface: 'tele',
    place: 'tele:channel:k1',
    author: 'tele:88',
    text: LINE.giannisHarbour,
    at: iso(TURN_NOW - 39 * REPLY_TURN_HANDLES_MIN),
  });
  addPerson(world.db, {
    id: REPLY_TURN_HANDLES_NIKOS,
    accounts: [
      { id: 'fake:4242', iface: 'fake', native: '4242', names: ['Νίκος'] },
      { id: 'fake:4243', iface: 'fake', native: '4243', names: ['Νικόλαος'] },
    ],
  });
  return world;
}

/** The owner's line on the command line. */
const ownerSays = (id: string, text: string, at: number) => ({ id, text, at, authorId: 'owner', authorName: 'owner' });

/** Reply turns on the owner's command line over a fresh handle world. */
async function onCli(steps: ReadonlyArray<ReplyStep>): Promise<ReplyRun> {
  const world = handleWorld();
  try {
    return await replyRun({ world, chat: CLI_CHAT, steps });
  } finally {
    world.close();
  }
}

/** Reply turns in the room `c1` of the fake interface over a fresh handle world. */
async function inRoom(steps: ReadonlyArray<ReplyStep>): Promise<ReplyRun> {
  const world = handleWorld();
  try {
    return await replyRun({ world, steps });
  } finally {
    world.close();
  }
}

/** The user text of request `step` of turn `turn` of a run, '' when there is none. */
const requestOf = (run: ReplyRun, turn: number, step: number): string => {
  const requests = run.requests[turn] ?? [];
  return requests[step] ?? '';
};

/** The bodies of every `<people>` of a text: the request's own and the one a read result carries. */
const peopleBodies = (text: string): Array<string> =>
  [...text.matchAll(/<people>\n?([\s\S]*?)\n?<\/people>/g)].map((match) => match[1] ?? '');

/** The entries of every `<people>` of a text, one text each. */
const entriesOf = (text: string): Array<string> =>
  peopleBodies(text).flatMap((body) => body.split(/\n\s*\n/).filter((entry) => entry.trim() !== ''));

/** The entry of `<people>` that holds `name`, '' when none does. */
const replyTurnHandlesEntryWith = (text: string, name: string): string =>
  entriesOf(text).find((entry) => entry.includes(name)) ?? '';

/** The line of `text` that holds `marker`, '' when none does. */
const lineWith = (text: string, marker: string): string => text.split('\n').find((line) => line.includes(marker)) ?? '';

describe('handles in a reply turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('an entry of <people> lists each account on a line of its own and marks the account of the place the persona is in', async () => {
    // Bug: the accounts stand on one line, so the persona cannot tell which of the person's accounts is the one they talk with.
    const cli = await onCli([
      { trigger: ownerSays('m1', LINE.ownerCli, TURN_NOW - REPLY_TURN_HANDLES_MIN), answers: [SAY] },
    ]);
    const room = await inRoom([
      { trigger: { id: 'r2', text: 'καλημέρα', at: TURN_NOW - REPLY_TURN_HANDLES_MIN }, answers: [SAY] },
    ]);
    const onCommandLine = replyTurnHandlesEntryWith(requestOf(cli, 0, 0), OWNER_FAKE_NAME);
    const inTheRoom = replyTurnHandlesEntryWith(requestOf(room, 0, 0), OWNER_FAKE_NAME);
    // The heading names the person and says why they are here, which differs between the turns: the accounts follow it.
    const accountLine = (entry: string, name: string): string => lineWith(entry.split('\n').slice(1).join('\n'), name);
    const cliLine = (entry: string): string => accountLine(entry, OWNER_CLI_NAME);
    const fakeLine = (entry: string): string => accountLine(entry, OWNER_FAKE_NAME);
    assert.notEqual(cliLine(onCommandLine), fakeLine(onCommandLine), 'one line per account');
    assert.notEqual(cliLine(onCommandLine), cliLine(inTheRoom), 'the command line account is marked on one turn only');
    assert.notEqual(fakeLine(onCommandLine), fakeLine(inTheRoom), 'the room account is marked on one turn only');
  });

  test('a <@id> mention in a stored claim of <memory> is shown as a handle', async () => {
    // Bug: a stored text renders a mention as the account's display name, which changes ten times a day and ties to no
    // entry, or as the bare account number when nothing names it.
    const world = handleWorld();
    try {
      addClaim(world.db, {
        id: 'claim:fact:mention',
        person: REPLY_TURN_HANDLES_ELENI,
        kind: 'fact',
        text: 'ΓΝΩΡΙΖΕΙ-ΤΗ <@5678>',
        audience: { group: 'fake' },
      });
      const run = await replyRun({
        world,
        steps: [{ trigger: { id: 'r2', text: 'καλημέρα', at: TURN_NOW - REPLY_TURN_HANDLES_MIN }, answers: [SAY] }],
      });
      const line = lineWith(blockOf(requestOf(run, 0, 0), 'memory'), 'ΓΝΩΡΙΖΕΙ-ΤΗ');
      assert.match(line, /@u[0-9a-z]+/, line);
      assert.doesNotMatch(line, /<@|&lt;@|\b5678\b|Ζωή/);
    } finally {
      world.close();
    }
  });

  test('an entry of <people> opens with its handle and a colon', async () => {
    // Bug: the entry opened `@handle Name`, so the handle read as part of the name. In the fix, a
    // handle and a colon open every entry.
    const run = await onCli([
      { trigger: ownerSays('m1', LINE.ownerCli, TURN_NOW - REPLY_TURN_HANDLES_MIN), answers: [SAY] },
    ]);
    const entries = entriesOf(requestOf(run, 0, 0));
    assert.ok(entries.length > 0, 'the request has people');
    for (const entry of entries) assert.match(entry.split('\n')[0] ?? '', /^@u[0-9a-z]+: \S/, entry);
  });
});

const REPLY_TURN_MEMORY_MIN = 60_000;

const REPLY_TURN_MEMORY_SAY = `${THINK}<msg>γεια</msg>`;

const REPLY_TURN_MEMORY_NIKOS = 'person:fake:4242';

/** The body of `<people>` in the `<memory>` of a request's user text, '' when absent. */
const peopleOf = (request: string | undefined): string =>
  /<people>([\s\S]*?)<\/people>/.exec(blockOf(request ?? '', 'memory'))?.[1] ?? '';

const CLAIM = { alpha: 'ΑΛΦΑ λουλούδια', beta: 'ΒΗΤΑ θάλασσα' } as const;

const REPLY_TURN_MEMORY_LORE = { alpha: 'ΛΟΡ-ΑΛΦΑ λουλούδια', beta: 'ΛΟΡ-ΒΗΤΑ θάλασσα' } as const;

/** The body of the subtag `<tag>` of `<memory>` in a request's user text, '' when absent. */
const replyTurnMemorySubtagOf = (request: string | undefined, tag: string): string =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(blockOf(request ?? '', 'memory'))?.[1] ?? '';

/** The lines of a text as a sorted list, to compare what two texts hold whatever their order. */
const sortedLines = (text: string): Array<string> => text.split('\n').filter(Boolean).sort();

/**
 * The service world with Νίκος, two claims about Ελένη and two lore claims about `c1`, each pair one claim about
 * flowers and one about the sea, so a trigger that names one puts its claim first in the reader's rank.
 */
function rankWorld(): World {
  const world = serviceWorld();
  addPerson(world.db, {
    id: REPLY_TURN_MEMORY_NIKOS,
    accounts: [{ id: 'fake:4242', iface: 'fake', native: '4242', names: ['Νίκος'] }],
  });
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
      text: key === 'a' ? REPLY_TURN_MEMORY_LORE.alpha : REPLY_TURN_MEMORY_LORE.beta,
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
      { id: 'n1', text: 'πρώτη', at: TURN_NOW - 10 * REPLY_TURN_MEMORY_MIN, authorId: '4242', authorName: 'Νίκος' },
      { id: 'z1', text: 'δεύτερη', at: TURN_NOW - 9 * REPLY_TURN_MEMORY_MIN, authorId: '5678', authorName: 'Ζωή' },
    ],
    trigger: { id: 'e1', text: 'η θάλασσα', at: TURN_NOW - 8 * REPLY_TURN_MEMORY_MIN },
    answers: [REPLY_TURN_MEMORY_SAY],
  },
  {
    lines: [
      { id: 'n2', text: 'τρίτη', at: TURN_NOW - 4 * REPLY_TURN_MEMORY_MIN, authorId: '4242', authorName: 'Νίκος' },
    ],
    trigger: { id: 'e2', text: 'τα λουλούδια στον κήπος', at: TURN_NOW - 3 * REPLY_TURN_MEMORY_MIN },
    answers: [REPLY_TURN_MEMORY_SAY],
  },
];

/** Five lines of the persona in `place` before the turns, the minutes before TURN_NOW `from` down. */
function ownLines(world: World, place: string, prefix: string, from: number): void {
  for (let i = 0; i < 5; i += 1)
    addLine(world.db, {
      id: `${prefix}${i}`,
      iface: 'fake',
      place,
      author: 'self',
      text: `${prefix.toUpperCase()}-ΔΙΚΗ-${i}`,
      at: iso(TURN_NOW - (from - i) * REPLY_TURN_MEMORY_MIN),
    });
}

// The persona's attitude toward the person they answer, in a real reply turn (spec 2026-11-12 attitude-in-people): the entry of
// Ελένη in `<people>` opens with the score, the band and the reason of the newest change toward Ελένη, and with the latest
// changes, newest first, `context.memory.attitudeMoves` of them (2 when the setting is missing).
const CHANGE_DAYS = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'];

/** The service world with five changes of the persona's attitude toward Ελένη, one a day, each with its own reason. */
function feltWorld(): World {
  const world = serviceWorld();
  const scores = [4, 9.5, 7, 21, 31.6];
  CHANGE_DAYS.forEach((day, at) =>
    addAttitude(world.db, {
      id: `aff:${day}`,
      person: REPLY_TURN_MEMORY_ELENI,
      at: `${day}T09:00:00.000Z`,
      applied: at === 2 ? -2.5 : 5,
      score: scores[at] ?? 0,
      reason: `ΛΟΓΟΣ-${at + 1}`,
      audience: { group: 'fake' },
    })
  );
  return world;
}

/** The entry of the person the persona answers: the first of `<people>`. */
const answeredEntry = (request: string | undefined): string => peopleOf(request).trim().split('\n\n')[0] ?? '';

describe('memory in a reply turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('two turns that raise the same entries in another rank print <people>, <places> and <lore> byte for byte the same', async () => {
    // Bug: the request prints the entries and the claims inside an entry in the order the graph reader ranked them, so
    // the same people, places and lore come out in another order each turn and the prompt cache stops inside <people>.
    const world = rankWorld();
    try {
      const [first = [], second = []] = await replyTurnMemoryReplyTurns({ world, steps: REORDERED });
      for (const tag of ['people', 'places', 'lore']) {
        const before = replyTurnMemorySubtagOf(first[0], tag);
        const after = replyTurnMemorySubtagOf(second[0], tag);
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
      const [first = [], second = []] = await replyTurnMemoryReplyTurns({ world, steps: REORDERED });
      for (const request of [first[0], second[0]]) {
        for (const text of Object.values(CLAIM))
          assert.ok(replyTurnMemorySubtagOf(request, 'people').includes(text), text);
        for (const text of Object.values(REPLY_TURN_MEMORY_LORE))
          assert.ok(replyTurnMemorySubtagOf(request, 'lore').includes(text), text);
        for (const name of ['Ελένη', 'Νίκος', 'Ζωή'])
          assert.ok(replyTurnMemorySubtagOf(request, 'people').includes(name), name);
      }
    } finally {
      world.close();
    }
  });

  test('the person the persona answers stays the first entry of <people> and marked, and every author keeps an entry under a spent share', async () => {
    // Guard: the stable order sorts the person the persona answers among the others by id, or the people share spent by the
    // budget drops an author the reader keeps whatever the budget. Ζωή's id sorts last, so a sort by id alone moves Ζωή.
    const world = rankWorld();
    try {
      const steps = REORDERED.map((step) => ({
        ...step,
        trigger: { ...step.trigger, authorId: '5678', authorName: 'Ζωή' },
      }));
      const [, second = []] = await replyTurnMemoryReplyTurns({ world, settings: { budgetTokens: 10 }, steps });
      const entries = replyTurnMemorySubtagOf(second[0], 'people').split('\n\n');
      const counterpart = shippedLabels.memory?.counterpart ?? '';
      assert.ok(counterpart !== '', 'the shipped labels mark the person the persona answers');
      assert.ok((entries[0] ?? '').includes('Ζωή') && (entries[0] ?? '').includes(counterpart), entries[0]);
      assert.equal(entries.filter((entry) => entry.includes(counterpart)).length, 1, 'one person marked');
      for (const name of ['Ελένη', 'Νίκος'])
        assert.ok(
          entries.some((entry) => entry.includes(name)),
          name
        );
      assert.equal(
        entries.filter((entry) => (entry.split('\n')[0] ?? '').includes('Ζωή')).length,
        1,
        'one entry of Ζωή'
      );
    } finally {
      world.close();
    }
  });

  test('<places> reads the same before and after the persona writes one more line in a place it lists', async () => {
    // Bug: a place's entry carries the exact count of the persona's messages there, which grows with every line they write, so the
    // entry of the place the persona talks in changes every turn and the cache stops at it. The persona wrote five lines in `c1` and in
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
        at: iso(TURN_NOW - 7 * REPLY_TURN_MEMORY_MIN),
      });
      addLine(world.db, {
        id: 'k9',
        iface: 'fake',
        place: 'fake:channel:c2',
        author: 'self',
        text: 'ΕΚΤΗ-Κ',
        at: iso(TURN_NOW - 7 * REPLY_TURN_MEMORY_MIN),
      });
      return REPLY_TURN_MEMORY_SAY;
    };
    try {
      const [first = [], second = []] = await replyTurnMemoryReplyTurns({
        world,
        steps: [
          { trigger: { id: 'e1', text: 'καλημέρα', at: TURN_NOW - 8 * REPLY_TURN_MEMORY_MIN }, answers: [writeMore] },
          {
            trigger: { id: 'e2', text: 'εντάξει', at: TURN_NOW - 3 * REPLY_TURN_MEMORY_MIN },
            answers: [REPLY_TURN_MEMORY_SAY],
          },
        ],
      });
      const before = replyTurnMemorySubtagOf(first[0], 'places');
      // A place reads as the interface's noun and its name in quotes.
      assert.ok(before.includes('"γενικά"') && before.includes('"κήπος"'), before);
      assert.equal(replyTurnMemorySubtagOf(second[0], 'places'), before);
    } finally {
      world.close();
    }
  });

  test('the entry of the person the persona answers opens with their attitude and their latest two changes by default', async () => {
    // Bug: the turn builds the request with no attitude in <people> (as since 2026-11-09), so the persona cannot tell how they
    // feel about the one they answer; or the setting that was never given reads as "no limit" and all five changes show.
    const world = feltWorld();
    try {
      const [first = []] = await replyTurnMemoryReplyTurns({
        world,
        steps: [
          {
            trigger: { id: 'r2', text: 'καλημέρα', at: TURN_NOW - REPLY_TURN_MEMORY_MIN },
            answers: [REPLY_TURN_MEMORY_SAY],
          },
        ],
      });
      const entry = answeredEntry(first[0]);
      const [heading = '', attitude = '', moves = ''] = entry.split('\n');
      assert.match(heading, /Ελένη/);
      for (const part of ['32', 'ΛΟΓΟΣ-5']) assert.ok(attitude.includes(part), `${part}: ${attitude}`);
      for (const part of ['2026-10-05', '2026-10-04', 'ΛΟΓΟΣ-4']) assert.ok(moves.includes(part), `${part}: ${moves}`);
      for (const gone of ['2026-10-01', '2026-10-02', '2026-10-03', 'ΛΟΓΟΣ-1', 'ΛΟΓΟΣ-2', 'ΛΟΓΟΣ-3'])
        assert.equal(entry.includes(gone), false, `${gone} is shown: ${entry}`);
    } finally {
      world.close();
    }
  });

  test('with context.memory.attitudeMoves at 0 the entry keeps the attitude line and shows no change', async () => {
    // Bug: the setting is read as unset and all changes show, or as "no attitude" and the line goes with them.
    const world = feltWorld();
    try {
      const [first = []] = await replyTurnMemoryReplyTurns({
        world,
        settings: { attitudeMoves: 0 },
        steps: [
          {
            trigger: { id: 'r2', text: 'καλημέρα', at: TURN_NOW - REPLY_TURN_MEMORY_MIN },
            answers: [REPLY_TURN_MEMORY_SAY],
          },
        ],
      });
      const entry = answeredEntry(first[0]);
      assert.ok((entry.split('\n')[1] ?? '').includes('ΛΟΓΟΣ-5'), entry);
      assert.doesNotMatch(entry, /\d{4}-\d{2}-\d{2}/);
    } finally {
      world.close();
    }
  });

  test('the entry of the person the persona answers holds the same bytes on two turns when nothing about their attitude changed', async () => {
    // Bug: the lines hold something that moves with the turn, or order the changes of one instant differently from turn
    // to turn, and the cached part of the request breaks at the entry on every reply.
    const world = feltWorld();
    addAttitude(world.db, {
      id: 'aff:tie',
      person: REPLY_TURN_MEMORY_ELENI,
      at: '2026-10-05T09:00:00.000Z',
      applied: 0.6,
      score: 31.6,
      reason: 'ΛΟΓΟΣ-ΙΔΙΑ-ΣΤΙΓΜΗ',
      audience: { group: 'fake' },
    });
    try {
      const [first = [], second = []] = await replyTurnMemoryReplyTurns({
        world,
        steps: [
          {
            trigger: { id: 'r2', text: 'καλημέρα', at: TURN_NOW - 3 * REPLY_TURN_MEMORY_MIN },
            answers: [REPLY_TURN_MEMORY_SAY],
          },
          {
            trigger: { id: 'r3', text: 'τι κάνεις;', at: TURN_NOW - REPLY_TURN_MEMORY_MIN },
            answers: [REPLY_TURN_MEMORY_SAY],
          },
        ],
      });
      const before = answeredEntry(first[0]);
      assert.ok(before.includes('ΛΟΓΟΣ-5'), before);
      assert.equal(answeredEntry(second[0]), before);
    } finally {
      world.close();
    }
  });
});

/** The body of `<memory>` with every entry of `mind`, as the request renders it. */
const memoryBlockOf = (
  mind: Parameters<typeof memoryItemsOf>[0],
  frame: Parameters<typeof memoryItemsOf>[1],
  labels: Parameters<typeof memoryItemsOf>[2],
  nameOf: Parameters<typeof memoryItemsOf>[3]
): { text: string } => ({ text: renderMemory(memoryItemsOf(mind, frame, labels, nameOf), mind.leftOut, labels) });

const REQUEST_MEMORY_BLOCK_NIKOS = personEntry('222', 'Νίκος', { evidence: 'author', relation: 'ΣΧΕΣΗ-ΝΙΚΟΥ' });

// A party carries the id the interface names them by (plan 2026-11-08 ids-by-links, slice 7b): the request no longer
// parses it out of the account id.
const REQUEST_MEMORY_BLOCK_AS_ELENI: FrameParty = {
  personId: ELENI.personId,
  accountId: 'fake:111',
  nativeId: '111',
  name: 'Ελένη',
};

const requestMemoryBlockNameOf = (id: string): string | null => (id === 'place:room' ? 'γενικά' : null);

function render(mind: Mind, author: FrameParty | null): string {
  return memoryBlockOf(mind, frameOf(frameInput({ author })), shippedLabels, requestMemoryBlockNameOf).text;
}

/** The body of `<tag>` in `text`, '' when the tag is absent. */
function section(text: string, tag: string): string {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1] ?? '';
}

test('the person the persona answers opens <people> even when the reader ranked them later', () => {
  // Bug: the entries keep the reader's order, and the counterpart sits below an author of the window.
  const people = section(
    render(mindOfEntries({ people: [REQUEST_MEMORY_BLOCK_NIKOS, ELENI] }), REQUEST_MEMORY_BLOCK_AS_ELENI),
    'people'
  );
  assert.ok(people.includes('Ελένη') && people.includes('Νίκος'));
  assert.ok(people.indexOf('Ελένη') < people.indexOf('Νίκος'));
});

test("the counterpart's entry is marked: it differs from the same entry on a turn that answers someone else", () => {
  // Bug: the counterpart comes first but nothing tells the persona it is the one they answer.
  const mind = mindOfEntries({ people: [ELENI, REQUEST_MEMORY_BLOCK_NIKOS] });
  const asEleni = section(render(mind, REQUEST_MEMORY_BLOCK_AS_ELENI), 'people');
  const asNobody = section(render(mind, null), 'people');
  const eleniPart = (people: string): string => people.slice(0, people.indexOf('Νίκος'));
  assert.ok(asEleni.indexOf('Νίκος') > 0 && asNobody.indexOf('Νίκος') > 0);
  assert.notEqual(eleniPart(asEleni), eleniPart(asNobody));
});

test('the counterpart has one entry in <memory> when the reader also raised them', () => {
  // Bug: the counterpart is prepended from the frame and rendered again from the reader's list.
  const text = render(mindOfEntries({ people: [REQUEST_MEMORY_BLOCK_NIKOS, ELENI] }), REQUEST_MEMORY_BLOCK_AS_ELENI);
  assert.equal(text.split('ΣΧΕΣΗ-ΕΛΕΝΗΣ').length - 1, 1);
});

test('the counterpart has one entry when the frame knows them by their platform id alone', () => {
  // Bug (2026-11-11): a frame whose store links no person names the counterpart by the platform id, and the person the
  // reader raised for that same account was rendered a second time under the stranger the frame made of them.
  const byId: FrameParty = { personId: null, accountId: '111', nativeId: '111', name: 'Ελένη' };
  const people = section(render(mindOfEntries({ people: [ELENI, REQUEST_MEMORY_BLOCK_NIKOS] }), byId), 'people');
  assert.equal(people.split('Ελένη').length - 1, 1, people);
  assert.ok(people.includes('ΣΧΕΣΗ-ΕΛΕΝΗΣ'), people);
});

test('a counterpart the reader did not raise still opens <people>, a stranger with an empty memory', () => {
  // Bug: the person the persona answers is missing whenever the database knows nothing of them.
  const people = section(
    render(mindOfEntries({ people: [REQUEST_MEMORY_BLOCK_NIKOS] }), { ...REQUEST_MEMORY_BLOCK_AS_ELENI, name: 'Ζωή' }),
    'people'
  );
  assert.ok(people.includes('Ζωή'));
  assert.ok(people.indexOf('Ζωή') < people.indexOf('Νίκος'));
});

test('each kind of entry renders in its own subtag and nowhere else', () => {
  // Bug: an excerpt of the prefetch lands in <lore>, or a lore claim under the people.
  const mind = mindOfEntries({
    people: [REQUEST_MEMORY_BLOCK_NIKOS],
    places: [placeEntry('place:club', 'λέσχη', { purpose: 'ΣΚΟΠΟΣ-ΛΕΣΧΗΣ' })],
    lore: [claimEntry('claim:1', 'place:club', 'ΘΡΥΛΟΣ-ΛΕΣΧΗΣ')],
    found: [excerptEntry('src:fake:m9:1:seen', 'place:club', 'ΑΠΟΣΠΑΣΜΑ-ΠΑΛΙΟ')],
  });
  const text = render(mind, null);
  const expected: Record<string, string> = {
    people: 'ΣΧΕΣΗ-ΝΙΚΟΥ',
    places: 'ΣΚΟΠΟΣ-ΛΕΣΧΗΣ',
    lore: 'ΘΡΥΛΟΣ-ΛΕΣΧΗΣ',
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
  // Bug: the persona reads one person writing from two accounts but cannot tell which accounts are theirs.
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
  const people = section(render(mindOfEntries({ people: [eleni] }), REQUEST_MEMORY_BLOCK_AS_ELENI), 'people');
  for (const value of ['other', '555', 'Λένα', '111']) assert.ok(people.includes(value), `${value} in <people>`);
});

test('a person with one account lists that account with its interface and platform id', () => {
  // Bug: a person's entry hides the account the persona sees, so they cannot tie a line to it.
  // An entry lists every account, one line each, a single account included.
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
  const people = section(
    render(mindOfEntries({ people: [{ ...REQUEST_MEMORY_BLOCK_NIKOS, profileAccounts: accounts }] }), null),
    'people'
  );
  assert.ok(people.includes('Νίκος'));
  const account = people.split('\n').find((line) => line.includes('222')) ?? '';
  assert.ok(account.includes('fake'), people);
});

// A mention in a stored text reads as the handle of the person it names, and a
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
    people: [
      {
        ...REQUEST_MEMORY_BLOCK_NIKOS,
        detail: 'whole',
        claims: [{ id: 'claim:n', kind: 'fact', text: `ΙΣΧΥΡΙΣΜΟΣ ${text}` }],
        episodes: [{ id: 'episode:1', date: '2026-11-06', what: `ΕΠΕΙΣΟΔΙΟ ${text}` }],
        episodesHeld: 1,
      },
    ],
    places: [placeEntry('place:club', 'λέσχη', { topics: `ΘΕΜΑΤΑ ${text}` })],
    lore: [claimEntry('claim:1', 'place:club', `ΘΡΥΛΟΣ ${text}`)],
    found: [excerptEntry('src:fake:m9:1:seen', 'place:club', `ΑΠΟΣΠΑΣΜΑ ${text}`)],
  });
  const frame = frameOf(frameInput({ author: null }));
  const items = memoryItemsOf(
    mind,
    frame,
    WITH_AUTHORS,
    requestMemoryBlockNameOf,
    null,
    new Set(),
    () => null,
    MENTIONS
  );
  const all = items.map((item) => item.text).join('\n');
  for (const word of ['ΙΣΧΥΡΙΣΜΟΣ', 'ΘΕΜΑΤΑ', 'ΘΡΥΛΟΣ', 'ΕΠΕΙΣΟΔΙΟ', 'ΑΠΟΣΠΑΣΜΑ'])
    assert.ok(all.includes(`${word} @u7ele`), `${word}: ${all}`);
  assert.doesNotMatch(all, /<@|&lt;@|\b777\b/);
});

// One logic in everything the request holds: an entry of `<places>` labels the
// purpose, the tone and the topics with the words `<place>` of `<surroundings>` uses (`surroundings.field` and
// `surroundings.fields.*`), and says since which day the persona is in a root as one more field of that form,
// `surroundings.fields.joined`, the day as `YYYY-MM-DD` in the turn's timezone (the year matters: the persona may have joined
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

const requestMemoryBlockPlacesOf = (entries: Array<ReturnType<typeof placeEntry>>, timezone = 'UTC'): string =>
  section(
    memoryBlockOf(
      mindOfEntries({ places: entries }),
      frameOf(frameInput({ author: null, timezone })),
      shippedLabels,
      requestMemoryBlockNameOf
    ).text,
    'places'
  );

test('an entry of <places> opens its purpose, tone and topics with the words <place> uses, as lines of their own', () => {
  // Bug: the three fields print as bare paragraphs, so one place reads two ways in one request.
  const entry = placeEntry('place:club', 'λέσχη', { purpose: 'ΣΚΟΠΟΣ', tone: 'ΥΦΟΣ', topics: 'ΘΕΜΑΤΑ' });
  const lines = requestMemoryBlockPlacesOf([entry]).split('\n');
  for (const [word, value] of [
    [WORDS.purpose, 'ΣΚΟΠΟΣ'],
    [WORDS.tone, 'ΥΦΟΣ'],
    [WORDS.topics, 'ΘΕΜΑΤΑ'],
  ] as const)
    assert.ok(lines.includes(fieldLine(word, value)), `${word}: ${lines.join(' | ')}`);
  for (const value of ['ΣΚΟΠΟΣ', 'ΥΦΟΣ', 'ΘΕΜΑΤΑ']) assert.equal(lines.includes(value), false, value);
});

test('the root entry holds the day the persona joined in the turn timezone, a root with no moment holds none', () => {
  // Bug: the day is cut in UTC, not in the persona's zone, or a root with no moment prints an empty or invalid day.
  const joinedAt = Date.parse('2026-10-03T23:30:00Z');
  const tokyo = '2026-10-04';
  const known = requestMemoryBlockPlacesOf(
    [placeEntry('place:srv', 'Αγορά', { kind: 'server', joinedAt })],
    'Asia/Tokyo'
  );
  assert.ok(known.split('\n').includes(fieldLine(WORDS.joined, tokyo)), known);
  const unknown = requestMemoryBlockPlacesOf([placeEntry('place:srv', 'Αγορά', { kind: 'server' })], 'Asia/Tokyo');
  assert.equal(unknown.includes(`${WORDS.joined}:`), false, unknown);
});

// The persona's attitude toward a person in the entry (spec 2026-11-12 attitude-in-people). A person entry of the mind carries
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

test('the person the persona answers reads with the attitude line in an entry cut to its name', () => {
  // Bug: the line is built for the entries that hold details only, so the one person the persona must answer well is the one
  // who loses how the persona feels about them when the reader cuts the entry down.
  const cut = { ...personEntry('111', 'Ελένη', { evidence: 'counterpart', detail: 'name' }), attitude: FOND };
  const people = section(render(mindOfEntries({ people: [cut] }), REQUEST_MEMORY_BLOCK_AS_ELENI), 'people');
  for (const part of ['32', bandWord('fond'), 'ΛΟΓΟΣ-ΤΕΛΕΥΤΑΙΑΣ', '2026-11-03'])
    assert.ok(people.includes(part), `${part} in ${people}`);
});

test('a person the reader kept whatever the budget reads with the attitude line in an entry cut to its name', () => {
  // Bug: an author of the lines the persona sees keeps a name and loses the attitude, so they read a stranger where they know someone.
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
const SEEN_MEMORY: MemoryLabels = Object.assign({}, shippedLabels.memory, {
  interests: 'INT {value}',
  avatar: 'AVA {value}',
  avatarDefault: 'AVD',
  usualName: 'USU {value}',
  messagesSeen: 'SEEN {count}',
});

const SEEN_LABELS: Labels = { ...shippedLabels, memory: SEEN_MEMORY };

const MARKERS = ['INT ', 'AVA ', 'AVD', 'USU ', 'SEEN '];

const renderSeen = (person: PersonEntry, author: FrameParty | null = null): string =>
  section(
    memoryBlockOf(
      mindOfEntries({ people: [person] }),
      frameOf(frameInput({ author })),
      SEEN_LABELS,
      requestMemoryBlockNameOf
    ).text,
    'people'
  );

const seenLines = (person: PersonEntry, author: FrameParty | null = null): Array<string> =>
  renderSeen(person, author).trim().split('\n');

const lineOf = (lines: Array<string>, marker: string): string => lines.find((line) => line.startsWith(marker)) ?? '';

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

// Every person listed carries their real name, aliases, accounts with their avatars, attitude and interests at every
// detail, so a person the budget cuts to a name still reads as the person memory knows.
const FACTS_LABELS: Labels = {
  ...SEEN_LABELS,
  memory: Object.assign({}, SEEN_MEMORY, { realName: 'REAL {value}', aliases: 'ALI {value}' }),
};

const factsOf = (person: PersonEntry): Array<string> =>
  section(
    memoryBlockOf(
      mindOfEntries({ people: [person] }),
      frameOf(frameInput({ author: null })),
      FACTS_LABELS,
      requestMemoryBlockNameOf
    ).text,
    'people'
  )
    .trim()
    .split('\n');

const FULL_FACTS = {
  ...KNOWN,
  realName: 'Νικόλαος',
  claims: [...KNOWN.claims, { id: 'claim:0', kind: 'alias', text: 'Νικ' }],
  attitude: FOND,
};

for (const detail of ['compact', 'name'] as const)
  test(`a person cut to ${detail}, neither answered nor kept, carries real name, aliases, attitude and interests`, () => {
    // Bug: the cheap facts hang on the whole detail, so most people of a request read as a bare name with no attitude.
    const lines = factsOf({ ...FULL_FACTS, detail });
    const text = lines.join('\n');
    assert.equal(lineOf(lines, 'REAL '), 'REAL Νικόλαος', text);
    assert.equal(lineOf(lines, 'ALI '), 'ALI Νικ', text);
    assert.equal(lineOf(lines, 'INT '), 'INT ΜΟΥΣΙΚΗ; ΣΚΑΚΙ', text);
    for (const part of ['32', 'ΛΟΓΟΣ-ΤΕΛΕΥΤΑΙΑΣ', '2026-11-09', '2026-11-03']) assert.ok(text.includes(part), part);
    for (const part of ['ΧΑΡΑΚΤΗΡΑΣ', 'ΤΡΟΠΟΣ', 'ΙΣΧΥΡΙΣΜΟΣ', 'USU ', 'SEEN '])
      assert.equal(text.includes(part), false, `${part} stays with the whole entry: ${text}`);
  });

test('each account of a person cut to its name carries its own avatar on the line after it', () => {
  // Bug: one avatar of the person is picked for the entry, so the persona cannot tell whose face it is when the person has two
  // accounts, and a person cut to a name shows none.
  const person = {
    ...FULL_FACTS,
    detail: 'name' as const,
    profileAccounts: [accountOf('fake', '222', described('ΕΔΩ')), accountOf('other', '555', described('ΑΛΛΟ'))],
  };
  const lines = factsOf(person);
  const after = (native: string): string => lines[lines.findIndex((line) => line.includes(native)) + 1] ?? '';
  assert.equal(after('222'), 'AVA ΕΔΩ', lines.join(' | '));
  assert.equal(after('555'), 'AVA ΑΛΛΟ', lines.join(' | '));
});

test('a full entry holds the interests, avatar, usual name and count after the manner of speech and before the claims', () => {
  // Bug: the lines are pushed after the claims or before the character, so the order of the entry differs from the spec.
  // Changed on purpose: the interests and the avatar belong to every detail and stand with the accounts above the
  // relation, so the order starts with the avatar under its account, then the interests; the usual name and the count stay after the manner of speech.
  const lines = seenLines(KNOWN);
  const order = ['AVA ', 'INT ', 'ΤΡΟΠΟΣ', 'USU ', 'SEEN ', 'ΙΣΧΥΡΙΣΜΟΣ'].map((part) =>
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

test('an entry cut to compact holds the interests and the avatar and neither the usual name nor the count', () => {
  // Bug: the lines are printed for every detail, so the entry the budget cut down is as long as a whole one.
  // Changed on purpose: the interests and the avatar belong to every detail; the usual name and the count stay whole.
  assert.deepEqual(markersIn(seenLines({ ...KNOWN, detail: 'compact' })), ['INT ', 'AVA ']);
});

test('an entry cut to its name holds the interests and the avatar and neither the usual name nor the count', () => {
  // Bug: the lines are printed for every detail, so the entry the budget cut down to a name is as long as a whole one.
  // Changed on purpose: the interests and the avatar belong to every detail; the usual name and the count stay whole.
  assert.deepEqual(markersIn(seenLines({ ...KNOWN, detail: 'name' })), ['INT ', 'AVA ']);
});

const FOND_NOW = { score: 31.6, reason: 'ΛΟΓΟΣ-ΤΕΛΕΥΤΑΙΑΣ', moves: [] };

test('the person the persona answers cut to a name holds their attitude, the interests and neither the usual name nor the count', () => {
  // Bug: the new lines are bound to the attitude condition, so a short entry of the counterpart grows with them.
  // Changed on purpose: the interests belong to every detail; the usual name and the count stay with a whole entry.
  const { interests, usualName, messagesSeen } = KNOWN;
  const cut = { ...ELENI, detail: 'name' as const, attitude: FOND_NOW, interests, usualName, messagesSeen };
  const text = renderSeen(cut, REQUEST_MEMORY_BLOCK_AS_ELENI);
  assert.ok(text.includes('ΛΟΓΟΣ-ΤΕΛΕΥΤΑΙΑΣ'), text);
  assert.deepEqual(markersIn(text.trim().split('\n')), ['INT ']);
});

test("a person the reader kept, cut to compact, holds the persona's attitude, interests and avatar and not the usual name or count", () => {
  // Bug: the entries that keep the attitude at a low detail also keep the lines of slice 2.
  // Changed on purpose: the interests and the avatar belong to every detail; the usual name and the count stay whole.
  const kept = { ...KNOWN, detail: 'compact' as const, keep: true, attitude: FOND_NOW };
  const lines = seenLines(kept);
  assert.ok(lines.join('\n').includes('ΛΟΓΟΣ-ΤΕΛΕΥΤΑΙΑΣ'), lines.join(' | '));
  assert.deepEqual(markersIn(lines), ['INT ', 'AVA ']);
});

test('a person with no interest, no avatar, no usual name and no count has none of the lines', () => {
  // Bug: an empty value prints its label alone, a line that says nothing and costs tokens.
  const bare = personEntry('222', 'Νίκος', { profileAccounts: [accountOf('fake', '222', null)] });
  assert.deepEqual(markersIn(seenLines(bare)), []);
});

test('the usual name that equals the heading after folding gives no line, another name gives one', () => {
  // Bug: the entry repeats its own name as the one the person is called most, or compares without folding case and accents.
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

test('a person with two avatars carries both, each on the line after its own account', () => {
  // Bug: the first account of the person with an avatar is taken, so a person who wears another face elsewhere is
  // described by it in the place where the persona sees the face of this one.
  // Changed on purpose: the avatar is stored per account and stands with its account, so no account wins.
  const person = {
    ...KNOWN,
    profileAccounts: [accountOf('other', '555', described('ΑΛΛΟ')), accountOf('fake', '222', described('ΕΔΩ'))],
  };
  const lines = seenLines(person);
  const after = (native: string): string => lines[lines.findIndex((line) => line.includes(native)) + 1] ?? '';
  assert.deepEqual([after('555'), after('222')], ['AVA ΑΛΛΟ', 'AVA ΕΔΩ'], lines.join(' | '));
});

test('with no avatar on the account in this place each other account that has one is described', () => {
  // Bug: the entry has no avatar line for a person whose face is stored on another account only.
  // Changed on purpose: every account with an avatar carries its own, the first one no longer stands for the rest.
  const person = {
    ...KNOWN,
    profileAccounts: [
      accountOf('fake', '222', null),
      accountOf('other', '555', described('ΠΡΩΤΟ')),
      accountOf('third', '777', described('ΔΕΥΤΕΡΟ')),
    ],
  };
  const avatars = seenLines(person).filter((line) => line.startsWith('AVA '));
  assert.deepEqual(avatars, ['AVA ΠΡΩΤΟ', 'AVA ΔΕΥΤΕΡΟ']);
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
    requestMemoryBlockNameOf,
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

// A place's topic, activity and last message in an entry of `<places>` (spec 2026-11-12 what-the-frame-dropped, slice 4). A
// place entry of the mind carries
//   topic: string | null; activity: 'live' | 'slow' | 'dead' | null; lastMessageAt: number | null
// and an entry above the detail `name` prints them after the stored fields: the topic through `surroundings.fields.topic`,
// the activity through `surroundings.fields.activity` with the word `surroundings.activity.<state>`, and the day of the last
// message through `surroundings.fields.lastMessage` as `YYYY-MM-DD` in the turn's timezone. An entry at `name` holds none.
// The labels below are the test's own, each word a marker the test finds a line by.
const STATS_LABELS: Labels = {
  ...shippedLabels,
  surroundings: Object.assign({}, shippedLabels.surroundings, {
    fields: Object.assign({}, shippedLabels.surroundings?.fields, {
      topic: 'TOP',
      activity: 'ACT',
      lastMessage: 'LAST',
    }),
    activity: { live: 'W-LIVE', slow: 'W-SLOW', dead: 'W-DEAD' },
  }),
};

const STATS = { topic: 'ΘΕΜΑ-ΛΕΣΧΗΣ', activity: 'live', lastMessageAt: Date.parse('2026-11-01T23:30:00Z') } as const;

const statsEntry = (over: Partial<ReturnType<typeof placeEntry>> = {}) =>
  placeEntry('place:club', 'λέσχη', { purpose: 'ΣΚΟΠΟΣ', ...STATS, ...over });

const statsPlaces = (entry: ReturnType<typeof placeEntry>, timezone = 'UTC', now?: number): Array<string> =>
  section(
    memoryBlockOf(
      mindOfEntries({ places: [entry] }),
      frameOf(frameInput({ author: null, timezone, ...(now === undefined ? {} : { now }) })),
      STATS_LABELS,
      requestMemoryBlockNameOf
    ).text,
    'places'
  )
    .trim()
    .split('\n');

const statsLine = (label: string, value: string): string => fill(FIELD, { field: label, value });

const STATS_MARKERS = ['TOP:', 'ACT:', 'LAST:'];

const statsMarkersIn = (lines: Array<string>): Array<string> =>
  STATS_MARKERS.filter((marker) => lines.some((line) => line.startsWith(marker)));

test('a full entry of <places> holds the topic, the activity word and the day of the last message', () => {
  // Bug: the entry prints the stored fields alone, so the topic and how active the place is never reach the request.
  const lines = statsPlaces(statsEntry());
  assert.ok(lines.includes(statsLine('TOP', 'ΘΕΜΑ-ΛΕΣΧΗΣ')), lines.join(' | '));
  assert.ok(lines.includes(statsLine('ACT', 'W-LIVE')), lines.join(' | '));
  assert.ok(lines.includes(statsLine('LAST', '2026-11-01')), lines.join(' | '));
});

test('an entry cut to compact still holds the topic, the activity and the last message', () => {
  // Bug: the lines are tied to the whole detail, so the entry the budget cut down loses what it was kept for.
  const lines = statsPlaces(statsEntry({ detail: 'compact' }));
  assert.deepEqual(statsMarkersIn(lines), STATS_MARKERS);
});

test('an entry cut to its name holds none of the three lines', () => {
  // Bug: the lines print at every detail, so an entry cut to a name is as long as a whole one.
  assert.deepEqual(statsMarkersIn(statsPlaces(statsEntry({ detail: 'whole' }))), STATS_MARKERS);
  assert.deepEqual(statsMarkersIn(statsPlaces(statsEntry({ detail: 'name' }))), []);
});

test('an entry with no topic, no activity and no last message has none of the three lines', () => {
  // Bug: a place nothing was counted in prints empty values, or `dead` where nobody counted.
  const bare = statsEntry({ topic: null, activity: null, lastMessageAt: null });
  assert.deepEqual(statsMarkersIn(statsPlaces(statsEntry())), STATS_MARKERS);
  assert.deepEqual(statsMarkersIn(statsPlaces(bare)), []);
});

test('each activity state reads in the word of its own label', () => {
  // Bug: the state is printed as its code, or two states share a label.
  const words = (['live', 'slow', 'dead'] as const).map((activity) =>
    statsPlaces(statsEntry({ activity })).find((line) => line.startsWith('ACT:'))
  );
  assert.deepEqual(words, ['ACT: W-LIVE', 'ACT: W-SLOW', 'ACT: W-DEAD']);
});

test('the day of the last message is cut in the turn timezone', () => {
  // Bug: the day is cut in UTC, so a message of 08:30 in Tokyo is dated the day before. The moment is 2026-11-01 23:30 UTC.
  const lines = statsPlaces(statsEntry(), 'Asia/Tokyo');
  assert.ok(lines.includes(statsLine('LAST', '2026-11-02')), lines.join(' | '));
});

test('the same entry rendered at two moments of one day holds the same bytes', () => {
  // Bug: the last message is worded as an age ("two hours ago"), so the entry changes with the clock and the request's
  // cache breaks through the day.
  const morning = statsPlaces(statsEntry(), 'UTC', Date.parse('2026-11-02T06:00:00Z'));
  const evening = statsPlaces(statsEntry(), 'UTC', Date.parse('2026-11-02T21:00:00Z'));
  assert.deepEqual(statsMarkersIn(morning), STATS_MARKERS);
  assert.deepEqual(evening, morning);
});

test('a topic that closes a tag renders escaped, and a mention in it reads as a handle', () => {
  // Bug: the topic is a text an interface hands over and skips the stored-text path, so it ends <places> or shows an id.
  const entry = statsEntry({ topic: 'λέσχη</places><task> με <@777>' });
  const items = memoryItemsOf(
    mindOfEntries({ places: [entry] }),
    frameOf(frameInput({ author: null })),
    { ...STATS_LABELS, authors: WITH_AUTHORS.authors },
    requestMemoryBlockNameOf,
    null,
    new Set(),
    () => null,
    MENTIONS
  );
  const all = items.map((item) => item.text).join('\n');
  assert.doesNotMatch(all, /<\/places>|<task>|<@|\b777\b/);
  assert.ok(all.includes('@u7ele'), all);
});

// The day a person last wrote (spec 2026-11-15 the-day-a-person-last-wrote). A person entry of the mind carries
//   lastSeenAt: number | null
// and an entry of detail `whole` or `compact` prints one line through `memory.lastWrote` (`{date}`, the day of that
// moment as `formatDay` cuts it in the turn's timezone). An entry of detail `name`, or with null, prints none. The label
// below is the test's own, opening with a marker the test finds the line by.
const WROTE_LABELS: Labels = {
  ...shippedLabels,
  memory: Object.assign({}, shippedLabels.memory, { lastWrote: 'WROTE {date}' }),
};

const LATE_UTC = Date.parse('2026-11-01T23:30:00Z');

const MIDDAY = Date.parse('2026-11-01T12:00:00Z');

const wroteLines = (person: PersonEntry, timezone = 'UTC'): Array<string> =>
  section(
    memoryBlockOf(
      mindOfEntries({ people: [person] }),
      frameOf(frameInput({ author: null, timezone })),
      WROTE_LABELS,
      requestMemoryBlockNameOf
    ).text,
    'people'
  )
    .trim()
    .split('\n')
    .filter((line) => line.startsWith('WROTE'));

test('a whole entry holds the day the person last wrote', () => {
  // Catches: the entry carries the moment but never prints it, so the persona still guesses the last day from dated claims.
  const lines = wroteLines(personEntry('333', 'Θάλεια', { lastSeenAt: MIDDAY }));
  assert.deepEqual(lines, [`WROTE ${formatDay(MIDDAY, 'UTC')}`]);
});

test('an entry cut to compact still holds the day the person last wrote', () => {
  // Catches: the line is tied to the whole detail with the other seen lines, so a person the budget cut down loses it.
  const lines = wroteLines(personEntry('333', 'Θάλεια', { lastSeenAt: MIDDAY, detail: 'compact' }));
  assert.deepEqual(lines, [`WROTE ${formatDay(MIDDAY, 'UTC')}`]);
});

test('an entry cut to its name holds no day of a last line', () => {
  // Catches: the line prints at every detail, so an entry cut to a name grows with it.
  assert.deepEqual(wroteLines(personEntry('333', 'Θάλεια', { lastSeenAt: MIDDAY, detail: 'name' })), []);
});

test('a line written just before midnight UTC reads as the next day in a timezone ahead of UTC', () => {
  // Catches: the day is cut in UTC or by the server clock, so a member in Tokyo who wrote at 08:30 their time reads as
  // having last written the day before.
  const day = formatDay(LATE_UTC, 'Asia/Tokyo');
  assert.notEqual(day, formatDay(LATE_UTC, 'UTC'));
  assert.deepEqual(wroteLines(personEntry('333', 'Θάλεια', { lastSeenAt: LATE_UTC }), 'Asia/Tokyo'), [`WROTE ${day}`]);
});

test('an entry with no moment of a last line holds no such line', () => {
  // Catches: a null moment prints as the epoch day or as an empty date, so a person who never wrote reads as absent
  // since 1970.
  assert.deepEqual(wroteLines(personEntry('333', 'Θάλεια', { lastSeenAt: null })), []);
});

/** Nikos with three episodes, the newest first, of five Nikos holds, at `detail`, two at whole and one at compact. */
const withEpisodes = (detail: PersonEntry['detail']): PersonEntry =>
  personEntry('222', 'Νίκος', {
    detail,
    episodes: [
      { id: 'episode:3', date: '2026-11-03', what: 'ΤΡΙΤΗ' },
      { id: 'episode:2', date: '2026-11-02', what: 'ΔΕΥΤΕΡΗ' },
    ],
    episodesHeld: 5,
    episodeCaps: { whole: 2, compact: 1, name: 0 },
  });

/** The lines of Nikos's entry from the first episode on. */
function episodeLines(person: PersonEntry): Array<string> {
  const people = section(render(mindOfEntries({ people: [person] }), null), 'people')
    .trim()
    .split('\n');
  const first = people.findIndex((line) => line.includes('ΤΡΙΤΗ') || line.includes('earlier moments'));
  return first < 0 ? [] : people.slice(first);
}

const episodeLine = (date: string, what: string): string => fill(shippedLabels.memory?.episode ?? '', { date, what });

const moreLine = (count: number): string => fill(shippedLabels.memory?.episodesMore ?? '', { count });

test('a whole entry ends with its episodes, newest first, and counts the ones it does not show', () => {
  // Bug: the episodes print oldest first, past their count, or with no word of the earlier ones memory.read can read.
  assert.deepEqual(episodeLines(withEpisodes('whole')), [
    episodeLine('2026-11-03', 'ΤΡΙΤΗ'),
    episodeLine('2026-11-02', 'ΔΕΥΤΕΡΗ'),
    moreLine(3),
  ]);
});

test('a compact entry holds as many episodes as its count for compact', () => {
  // Bug: an entry cut to compact keeps every episode of a whole one, and the cut saves nothing.
  assert.deepEqual(episodeLines(withEpisodes('compact')), [episodeLine('2026-11-03', 'ΤΡΙΤΗ'), moreLine(4)]);
});

test('an entry cut to its name holds no episode and no count of them', () => {
  // Bug: a name found in a claim carries the moments of that person and the count of the rest.
  assert.deepEqual(episodeLines(withEpisodes('name')), []);
});

test('a service entry ends with its episodes after the approach and counts the ones it does not show', () => {
  // Bug: a heartbeat lists the person with none of the moments a reply entry holds, or prints them above the approach.
  const person: ListedPerson = {
    personId: 'person:fake:222',
    name: 'Νίκος',
    realName: null,
    claims: [],
    profileAccounts: [],
    relation: null,
    character: null,
    style: null,
    attitude: null,
    lastSeenAt: null,
    lastPlaceId: null,
    dm: null,
    approach: { placeId: 'place:room', at: Date.parse('2026-11-04T10:00:00Z'), direct: false, after: null },
    firstLines: null,
    interests: [],
    episodes: [{ id: 'episode:3', date: '2026-11-03', what: 'ΤΡΙΤΗ' }],
    episodesHeld: 2,
  };
  const frame = frameOf(frameInput({ author: null }));
  const refs: EntryRefs = { ...MENTIONS, place: () => '#room' };
  const [item] = serviceItemsOf(
    { people: [person], places: [] },
    frame,
    shippedLabels,
    requestMemoryBlockNameOf,
    refs,
    () => null,
    7
  );
  const lines = item?.text.split('\n') ?? [];
  assert.deepEqual(lines.slice(-2), [episodeLine('2026-11-03', 'ΤΡΙΤΗ'), moreLine(1)]);
  assert.ok(lines.at(-3)?.includes('#room'), lines.join('\n'));
});

const REQUEST_NAMES_EMOJI_MIN = 60_000;

const EMOJI = /\p{Extended_Pictographic}/u;

/** A room with a leading emoji, a garden with one between its words, a person whose names and alias carry emoji. */
function emojiWorld(): World {
  const world = openWorld();
  noteInterface(world, 'fake', [{ id: 'g1', name: 'Αγορά' }]);
  const room = addRoom(world.db, { iface: 'fake', native: 'c1', root: rootId('fake', 'g1'), name: '🌿 γενικά' });
  const garden = addRoom(world.db, {
    iface: 'fake',
    native: 'c2',
    root: rootId('fake', 'g1'),
    name: 'ωραίος 🌱 κήπος',
  });
  addPerson(world.db, {
    id: 'person:fake:111',
    accounts: [{ id: 'fake:111', iface: 'fake', native: '111', names: ['🍀 Ελένη', 'Ελένη 🍀 Λένα'] }],
  });
  addClaim(world.db, {
    id: 'claim:alias:111',
    person: 'person:fake:111',
    kind: 'alias',
    text: '🌟 Ελενάκι',
    audience: { group: 'fake' },
  });
  addLine(world.db, {
    id: 'r1',
    iface: 'fake',
    place: room,
    author: 'fake:111',
    text: 'ΓΡΑΜΜΗ-ΔΩΜΑΤΙΟΥ',
    at: iso(TURN_NOW - 5 * REQUEST_NAMES_EMOJI_MIN),
  });
  addLine(world.db, {
    id: 'g0',
    iface: 'fake',
    place: garden,
    author: 'fake:111',
    text: 'ΓΡΑΜΜΗ-ΚΗΠΟΥ',
    at: iso(TURN_NOW - 51 * REQUEST_NAMES_EMOJI_MIN),
  });
  return world;
}

/** The `#c…` handle of the entry of `<places>` that holds `word`. */
function placeHandle(request: string, word: string): string {
  const places = blockOf(blockOf(request, 'memory'), 'places');
  const entry = places.split(/\n\s*\n/).find((one) => (one.split('\n')[0] ?? '').includes(word)) ?? '';
  return /#c[0-9a-z]+/.exec(entry)?.[0] ?? '';
}

/** Two turns in the room: the persona reads the garden by its handle in the first, the second shows the read in `<recall>`. */
async function run(emoji: boolean | undefined): Promise<{ first: string; read: string }> {
  const world = emojiWorld();
  try {
    const out = await replyRun({
      world,
      ...(emoji === undefined ? {} : { context: { names: { emoji } } }),
      steps: [
        {
          trigger: { id: 'r2', text: 'τι έγινε στον κήπο;', at: TURN_NOW - 3 * REQUEST_NAMES_EMOJI_MIN },
          answers: [
            (request: string) =>
              toolAnswer(THINK, [call('conversation.read', { place: placeHandle(request, 'κήπος'), last: 10 })]),
            SAY,
          ],
        },
      ],
    });
    const requests = out.requests[0] ?? [];
    return { first: requests[0] ?? '', read: requests[1] ?? '' };
  } finally {
    world.close();
  }
}

const hidden = run(undefined);

/** The line of `text` that holds `marker`. */
const requestNamesEmojiLineWith = (text: string, marker: string): string =>
  text.split('\n').find((line) => line.includes(marker)) ?? '';

const requestNamesEmojiPeopleOf = (request: string): string => blockOf(blockOf(request, 'memory'), 'people');

describe('names and emoji in a request', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('a place with a leading emoji reads without it in an entry of <places>', async () => {
    // Bug: the entry shows the stored name, so the emoji of a channel reads as part of its name.
    const { first } = await hidden;
    const entry = requestNamesEmojiLineWith(blockOf(blockOf(first, 'memory'), 'places'), 'γενικά');
    assert.match(entry, /^#c[0-9a-z]+: "γενικά", "Αγορά"/, entry);
    assert.doesNotMatch(entry, EMOJI);
  });

  test("a person's heading reads without emoji", async () => {
    // Bug: the heading of an entry of <people> is the stored name.
    const { first } = await hidden;
    const heading = requestNamesEmojiLineWith(requestNamesEmojiPeopleOf(first), 'Ελένη');
    assert.match(heading, /^@u[0-9a-z]+: Ελένη \(/, heading);
  });

  test('the names of an account line read without emoji, each trimmed', async () => {
    // Bug: the account line joins the stored names, so `🍀 Ελένη` and `Ελένη 🍀 Λένα` keep their emoji.
    const { first } = await hidden;
    const account = requestNamesEmojiLineWith(requestNamesEmojiPeopleOf(first), 'account 111');
    assert.ok(account.includes('Ελένη, Ελένη Λένα'), account);
    assert.doesNotMatch(account, EMOJI);
  });

  test('an alias reads without emoji', async () => {
    // Bug: the aliases line is the stored claim text.
    const { first } = await hidden;
    const aliases = requestNamesEmojiLineWith(requestNamesEmojiPeopleOf(first), 'Ελενάκι');
    assert.ok(aliases.includes('also called: Ελενάκι'), aliases);
    assert.doesNotMatch(aliases, EMOJI);
  });
});
