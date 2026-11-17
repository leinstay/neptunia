// What a reply's request repeats from one turn of a place to the next (the cache layout of 2026-11-11, what still breaks
// the repeat): the last cached part of the user message ends right before `<chat>`, and the detail of the stable blocks
// of `<memory>` does not move with the size of `<found>`. Requests of buildRequest (src/behavior/prompt.ts) on a
// hand-written mind, the markers of withCacheMarker (src/llm/openrouter.ts). tests/prompt-reader.test.ts holds the rest
// of the reader's request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withCacheMarker } from '../src/llm/openrouter.ts';
import { frameOf } from '../src/turn/request/frame.ts';
import type { FrameParty } from '../src/turn/request/frame.ts';
import type { ExcerptEntry, PlaceEntry } from '../src/memory/db/mind-read.ts';
import { buildRequest } from './fixtures/built-request.ts';
import type { Built } from './fixtures/built-request.ts';
import { ROOM_CHAIN, frameInput } from './fixtures/frame-input.ts';
import { line, meanwhileReads } from './fixtures/meanwhile-reads.ts';
import { claimEntry, excerptEntry, mindOfEntries, personEntry, placeEntry } from './fixtures/mind-entries.ts';
import { MIN, NOW, baseInput, fakeConfig, fakePrompts, makeMessage } from './fixtures/prompt-rig.ts';
import { shippedLabels } from './fixtures/shipped-labels.ts';

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
 * A reply in the room with Eleni, the rooms and their lore in memory, her line in another room in `<meanwhile>`, and
 * `found` as the reader's excerpts. The memory budget is 1000 tokens: people 50, places 300, lore 50, recent none and
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
            shares: { people: 0.05, places: 0.3, lore: 0.05, recent: 0, found: 0.6 },
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

test('the first request of a reply carries three markers: the system message, the end of <self> and right before <chat>', () => {
  // The owner's decision of 2026-11-11: every request of a turn has its markers at the same places, none on <surroundings>.
  // Bug: the markers stop at <surroundings>, so a provider that caches by marker re-reads <memory> and <meanwhile> on
  // every turn although they repeat; or the split falls inside <chat> and the marker is written anew on every turn.
  const built = request([]);
  const sent = withCacheMarker(built.messages, '1h');
  const marked = sent.flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as Array<{ text?: string; cache_control?: unknown }>).filter((part) =>
          Object.hasOwn(part, 'cache_control')
        )
      : []
  );
  assert.equal(marked.length, 3, 'three markers');
  assert.match(String(marked[1]?.text), /<\/self>\n\n$/, 'the second ends with <self>');
  assert.match(
    String(marked[2]?.text),
    /^<surroundings>\n[\s\S]*<\/meanwhile>\n\n$/,
    'the third runs from <surroundings> to <meanwhile>'
  );
  const parts = (sent[1].content as Array<{ text?: string }>).filter((part) => typeof part.text === 'string');
  assert.match(String(parts[parts.indexOf(marked[2]) + 1]?.text), /^<chat>\n/, 'the part after it opens with <chat>');
});

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

// ---- the legend ----------------------------------------------------------------------------------------------------

// The owner on 2026-11-17: the legend `<interface>` stands in the tail, after `<meanwhile>` and before `<chat>`, and
// reads the custom emoji of the lines of `<chat>` and of `<meanwhile>`. The labels are the test's own.
const LEGEND_LABELS = {
  ...shippedLabels,
  transcript: { ...shippedLabels.transcript, stickerRef: '[sticker {name}]' },
  legend: {
    line: '{name} {platformName}: {text}',
    lineNoText: 'NOTEXT {name} {platformName}',
    unreadable: 'UNSEEN {name} {platformName}',
  },
};

type NameRow = {
  name: string;
  kind: 'emoji' | 'sticker';
  iface: string;
  nativeId: string;
  platformName: string;
  animated: boolean;
};

const NAME_ROWS: ReadonlyArray<NameRow> = [
  { name: 'e23', kind: 'emoji', iface: 'discord', nativeId: '901', platformName: 'pogcat', animated: false },
  { name: 'e24', kind: 'emoji', iface: 'discord', nativeId: '902', platformName: 'wavey', animated: false },
];

const rowOf = (name: string): NameRow | null => NAME_ROWS.find((row) => row.name === name) ?? null;

/** A reply whose trigger line reads `content` with `emojis`, and whose `<meanwhile>` holds her line `elsewhere`. */
function legendRequest(content: string, emojis: Array<{ id: string; name: string }>, elsewhere: string): Built {
  const trigger = makeMessage('m1', NOW - MIN, { authorId: '111', authorName: 'Ελένη', content, emojis });
  return buildRequest(
    baseInput({
      config: fakeConfig({ context: { meanwhile: { messages: 8, around: 2 } } }),
      prompts: fakePrompts({ labels: LEGEND_LABELS }),
      frame: FRAME,
      whereabouts: { kind: 'place', iface: 'fake', private: false, chain: ROOM_CHAIN },
      history: [trigger],
      trigger,
      triggerKind: 'mention',
      nameOf,
      mind: mindOfEntries({ people: [ELENI] }),
      descriptions: new Map([
        ['emoji:901', 'a surprised cat face'],
        ['emoji:902', 'a cat waving a paw'],
      ]),
      mediaNameOf: rowOf,
      meanwhileReads: meanwhileReads([
        {
          id: 'place:room1',
          path: ['fake', 'Αγορά', 'αίθουσα1'],
          dm: false,
          lines: [line('place:room1', 'c1', NOW - 40 * MIN, null, elsewhere)],
        },
      ]),
    })
  );
}

/** The user message as one text. */
const userOf = (built: Built): string => {
  const [, message] = built.messages;
  return message.content.map((part) => String(part.text ?? '')).join('');
};

test('<interface> stands as a root block after </meanwhile> and before <chat>, in the uncached tail', () => {
  // Bug: the legend lands in the cached memory segment, so a new emoji in the chat rewrites the cache; or it stands
  // after <chat>, below the lines that refer to it.
  const built = legendRequest('δες :e23:', [{ id: '901', name: 'e23' }], 'εκεί');
  const user = userOf(built);
  const legendAt = user.indexOf('\n<interface>', user.indexOf('</meanwhile>'));
  assert.ok(user.indexOf('</meanwhile>') > 0, 'the request has <meanwhile>');
  assert.ok(legendAt > 0, user);
  assert.ok(legendAt < user.indexOf('<chat>'), '<interface> before <chat>');
  const sent = withCacheMarker(built.messages, '1h');
  const parts = (sent[1].content as Array<{ text?: string; cache_control?: unknown }>).filter(
    (part) => typeof part.text === 'string'
  );
  const lastMarked = parts.findLastIndex((part) => Object.hasOwn(part, 'cache_control'));
  const next = String(parts[lastMarked + 1]?.text);
  assert.match(String(parts[lastMarked]?.text), /<\/meanwhile>\n\n$/, 'the cached part still ends with <meanwhile>');
  assert.match(next, /^<interface>/, 'the tail opens with <interface>');
});

test('an emoji used only in a <meanwhile> window still stands in <interface>', () => {
  // Bug: the legend reads the chat alone, and her own line elsewhere names an emoji she cannot look up.
  const built = legendRequest('γεια σου', [], 'τέλεια :e24:');
  const user = userOf(built);
  const legend = user.slice(user.indexOf('</meanwhile>'), user.indexOf('<chat>'));
  assert.ok(legend.includes('<interface>'), user);
  assert.ok(legend.includes(':e24: wavey: a cat waving a paw'), legend);
  assert.ok(!legend.includes(':e23:'), 'only what occurs');
});

// ---- her appearance ------------------------------------------------------------------------------------------------

// The owner on 2026-11-17: she reads her appearance in every turn of hers, in the stable cached part beside the
// character card, and an empty or missing appearance gives no block. The appearance sentence is the test's own.
const LOOKS = 'ΕΜΦΑΝΙΣΗ a tall figure in a mustard raincoat with a crooked umbrella';

/** A request of `frame` whose prompts hold `appearance` (absent when undefined). */
function appearanceRequest(frame: ReturnType<typeof frameOf>, appearance?: string): Built {
  const extra = appearance === undefined ? {} : { appearance };
  return buildRequest(
    baseInput({
      config: fakeConfig({ context: { meanwhile: { messages: 8, around: 2 } } }),
      prompts: fakePrompts({ labels: shippedLabels, ...extra }),
      frame,
      whereabouts: { kind: 'place', iface: 'fake', private: false, chain: ROOM_CHAIN },
      history: HISTORY,
      trigger: HISTORY[0],
      triggerKind: 'mention',
      nameOf,
      mind: mindOfEntries({ people: [ELENI] }),
    })
  );
}

/** The text of the first cache-marked part of a request as it is sent. */
function firstMarkedOf(built: Built): string {
  const sent = withCacheMarker(built.messages, '1h');
  const [system] = sent;
  const parts = Array.isArray(system.content)
    ? (system.content as Array<{ text?: string; cache_control?: unknown }>)
    : [{ text: String(system.content) }];
  const marked = parts.filter((part) => Object.hasOwn(part, 'cache_control'));
  return marked.map((part) => String(part.text ?? '')).join('');
}

const HEARTBEAT = frameOf(
  frameInput({
    now: NOW,
    mode: 'inner',
    triggerKind: 'inner',
    wakeKind: 'heartbeat',
    chain: [],
    trigger: null,
    author: null,
  })
);

for (const [kind, frame] of [
  ['a reply', FRAME],
  ['a heartbeat', HEARTBEAT],
] as const) {
  test(`<appearance> follows the card in the cached system message of ${kind}`, () => {
    // Bug: the appearance reaches only the drawing prompt, so she does not know how she looks; or it lands in the user
    // message's per-turn part and rewrites the cache on every turn.
    const built = appearanceRequest(frame, LOOKS);
    const marked = firstMarkedOf(built);
    const block = `<appearance>\n${LOOKS}\n</appearance>`;
    assert.ok(marked.includes(block), marked);
    assert.ok(marked.indexOf('CARD_TEXT') < marked.indexOf(block), 'after the card');
    assert.ok(!userOf(built).includes(LOOKS), 'not in the user message');
  });
}

test('an empty or missing appearance gives no <appearance> block', () => {
  // Bug: an empty tag pair goes out, or a blank file prints a block of whitespace.
  for (const appearance of [undefined, '', '  \n ']) {
    const built = appearanceRequest(FRAME, appearance);
    const [first] = built.messages;
    const system = String(first.content);
    assert.ok(!system.includes('<appearance>'), JSON.stringify(appearance));
  }
});
