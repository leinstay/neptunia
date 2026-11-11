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
  const user = built.messages[1].content.map((part) => String(part.text ?? '')).join('');
  return new RegExp(`^<${tag}>\\n([\\s\\S]*?)\\n</${tag}>$`, 'm').exec(user)?.[1] ?? '';
}

/** The body of a subtag of `<memory>` in a request's user message, '' when absent. */
function subtagOf(built: Built, tag: string): string {
  return new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(rootOf(built, 'memory'))?.[1] ?? '';
}

test('the last part of a reply that carries a cache marker ends right before <chat>', () => {
  // Bug: the markers stop at <surroundings>, so a provider that caches by marker re-reads <memory> and <meanwhile> on
  // every turn although they repeat; or the split falls inside <chat> and the marker is written anew on every turn.
  const built = request([]);
  const sent = withCacheMarker(built.messages, '1h');
  const parts = (sent[1].content as Array<{ text?: string; cache_control?: unknown }>).filter(
    (part) => typeof part.text === 'string'
  );
  const lastMarked = parts.findLastIndex((part) => Object.hasOwn(part, 'cache_control'));
  assert.ok(lastMarked >= 0, 'the user message carries a marker');
  assert.match(String(parts[lastMarked]?.text), /<\/meanwhile>\n\n$/, 'the marked part ends with <meanwhile>');
  assert.match(String(parts[lastMarked + 1]?.text), /^<chat>\n/, 'the part after it opens with <chat>');
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
