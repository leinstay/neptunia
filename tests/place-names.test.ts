// How a place named in a read call resolves: `matchPlace` (src/tools/place-names.ts), the list of choices it renders
// (`placeChoicesText`), and `resolveCall` for the two read skills, `memory.search` and `conversation.read`
// (src/tools/executors.ts). A turn in a DM or on the command line has no `<channel_directory>`, so she writes a name
// she guessed: it is compared after folding case and dropping emoji, punctuation and `#`, a loaded stemmer lets an
// inflected word find the channel, and an answer that cannot be one place lists the places she may read, as data, so
// she can call again. Synthetic names only. Which places she may read is decided in tests/readable-places.test.ts;
// here the list is given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/tools/impl/index.ts';
import { resolveCall } from '../src/tools/executors.ts';
import { PLACE_CHOICES_MAX, matchPlace, placeChoicesText, type PlaceCandidate } from '../src/tools/place-names.ts';
import { skillRegistry } from '../src/tools/registry.ts';

/** A tiny stemmer for the tests: drops a plural `s` or `ing`. */
const stem = (word: string): string => word.replace(/(?:ing|s)$/, '');

const GARDEN: PlaceCandidate = { id: '1001', name: '🌿┃Garden Notes', handle: 'cg1' };
const CELLAR: PlaceCandidate = { id: '1002', name: '🥕 root_cellar!', handle: null };
const PLACES: ReadonlyArray<PlaceCandidate> = [GARDEN, CELLAR, { id: '1003', name: '📺 film-club', handle: 'cg3' }];

function idOf(match: ReturnType<typeof matchPlace>): string | null {
  return match.kind === 'one' ? match.id : null;
}

test('takes a place named by its handle, with or without the hash', () => {
  assert.equal(idOf(matchPlace('#cg1', PLACES)), '1001');
  assert.equal(idOf(matchPlace('cg1', PLACES)), '1001');
});

test('takes a place named by its native id or its mention', () => {
  assert.equal(idOf(matchPlace('1002', PLACES)), '1002');
  assert.equal(idOf(matchPlace('<#1002>', PLACES)), '1002');
});

test('takes a place named by its name once case, emoji, punctuation and the hash are dropped', () => {
  assert.equal(idOf(matchPlace('#garden notes', PLACES)), '1001');
  assert.equal(idOf(matchPlace('GARDEN NOTES', PLACES)), '1001');
  assert.equal(idOf(matchPlace('🌱 Garden Notes', PLACES)), '1001');
  assert.equal(idOf(matchPlace('rootcellar', PLACES)), '1002');
});

test('takes an inflected name when a stemmer is loaded and lists the choices when none is', () => {
  const places: Array<PlaceCandidate> = [{ id: '2001', name: '🍲 recipes', handle: null }, GARDEN];
  assert.equal(idOf(matchPlace('recipe', places, { stem })), '2001');
  assert.equal(idOf(matchPlace('cooking recipe', places, { stem })), null, 'an extra word is no match');
  assert.equal(matchPlace('recipe', places).kind, 'none');
});

test('stems every word of a name, so a many-word name is found by its inflected form', () => {
  assert.equal(idOf(matchPlace('garden note', PLACES, { stem })), '1001');
});

test('takes the exact name with no list when a stem would also match another place', () => {
  const places: Array<PlaceCandidate> = [
    { id: '3001', name: 'rose', handle: null },
    { id: '3002', name: 'roses', handle: null },
  ];
  assert.equal(idOf(matchPlace('roses', places, { stem })), '3002');
  assert.equal(idOf(matchPlace('rose', places, { stem })), '3001');
});

test('answers the matches when several places share a folded name', () => {
  const places: Array<PlaceCandidate> = [
    { id: '4001', name: '🌿 herbs', handle: 'h1' },
    { id: '4002', name: '🌱 Herbs', handle: null },
    { id: '4003', name: 'stone', handle: null },
  ];
  const match = matchPlace('herbs', places);
  assert.equal(match.kind, 'several');
  assert.deepEqual(match.kind === 'several' ? match.choices.map((choice) => choice.id).sort() : [], ['4001', '4002']);
});

test('answers every place she may read when the name matches none', () => {
  const match = matchPlace('memes', PLACES);
  assert.equal(match.kind, 'none');
  assert.deepEqual(match.kind === 'none' ? match.choices.map((choice) => choice.id).sort() : [], [
    '1001',
    '1002',
    '1003',
  ]);
});

test('answers no choices and a total of zero when she may read no place at all', () => {
  const match = matchPlace('memes', []);
  assert.equal(match.kind, 'none');
  assert.equal(match.kind === 'none' ? match.choices.length : -1, 0);
  assert.equal(match.kind === 'none' ? match.total : -1, 0);
});

test('lists at most the bound of choices and reports how many places there are', () => {
  const many: Array<PlaceCandidate> = Array.from({ length: PLACE_CHOICES_MAX + 9 }, (_, i) => ({
    id: String(5000 + i),
    name: `room ${i}`,
    handle: null,
  }));
  const match = matchPlace('nothing like it', many);
  assert.equal(match.kind, 'none');
  assert.equal(match.kind === 'none' ? match.choices.length : -1, PLACE_CHOICES_MAX);
  assert.equal(match.kind === 'none' ? match.total : -1, PLACE_CHOICES_MAX + 9);
  const capped = matchPlace('nothing like it', many, { max: 3 });
  assert.equal(capped.kind === 'none' ? capped.choices.length : -1, 3);
});

test('a reference with nothing left after folding matches no place', () => {
  assert.equal(matchPlace('🌿 #!', PLACES).kind, 'none');
  assert.equal(matchPlace('', PLACES).kind, 'none');
});

// ---- the rendered list --------------------------------------------------------------------------------------------

/** Labels with a marker per key, so the test checks that the list is rendered from them, never their wording. */
const marked = {
  tools: {
    tools: {
      place: {
        several: 'SEVERAL-MARK {given} {count}',
        none: 'NONE-MARK {given}',
        line: 'LINE-MARK {ref} {name}',
        more: 'MORE-MARK {count}',
      },
    },
  },
};

test('renders the choices under the lead of the label for the case, one line each with the token to write', () => {
  const text = placeChoicesText(matchPlace('memes', PLACES), marked, 'memes');
  assert.ok(text.includes('NONE-MARK memes'), text);
  assert.equal(text.includes('SEVERAL-MARK'), false);
  assert.ok(text.includes('LINE-MARK #cg1 🌿┃Garden Notes'), 'a place with a handle is written by its handle');
  assert.ok(text.includes('LINE-MARK 1002 🥕 root_cellar!'), 'a place without a handle is written by its id');
  assert.equal(text.includes('MORE-MARK'), false, 'no tail while every place is listed');
});

test('renders the several-lead with the number of matches and the tail when matches were left out', () => {
  const places: Array<PlaceCandidate> = Array.from({ length: 5 }, (_, i) => ({
    id: String(6000 + i),
    name: 'herbs',
    handle: null,
  }));
  const text = placeChoicesText(matchPlace('herbs', places, { max: 2 }), marked, 'herbs');
  assert.ok(text.includes('SEVERAL-MARK herbs 5'), text);
  assert.ok(text.includes('MORE-MARK 3'), text);
  assert.equal(text.split('LINE-MARK').length - 1, 2);
});

test('the token written for a choice resolves back to its own place', () => {
  const view = { skills: skillRegistry(), places: PLACES, conversations: [] };
  for (const place of PLACES) {
    const ref = place.handle ? `#${place.handle}` : place.id;
    const resolved = resolveCall({ skill: 'conversation.read', args: { channel: ref } }, view);
    assert.equal(resolved.ok, true, ref);
    assert.equal('args' in resolved ? resolved.args.channel : null, place.id);
  }
});

// ---- resolveCall for the read skills ------------------------------------------------------------------------------

const READ_SKILLS = [
  ['memory.search', { question: 'what was posted' }],
  ['conversation.read', {}],
] as const;

for (const [skill, extra] of READ_SKILLS) {
  const resolve = (channel: string, view: object) =>
    resolveCall({ skill, args: { ...extra, channel } }, { skills: skillRegistry(), ...view });
  const choiceIds = (refusal: object): Array<string> =>
    'choices' in refusal ? (refusal.choices as ReadonlyArray<{ id: string }>).map((choice) => choice.id).sort() : [];

  test(`${skill}: resolves a channel written by its folded name from the places she may read`, () => {
    const resolved = resolve('#garden notes', { places: PLACES, conversations: [] });
    assert.equal(resolved.ok, true);
    assert.equal('args' in resolved ? resolved.args.channel : null, '1001');
  });

  test(`${skill}: resolves an inflected name with the stemmer of the view`, () => {
    const view = { places: [{ id: '2001', name: '🍲 recipes', handle: null }], conversations: [], stem };
    const resolved = resolve('recipe', view);
    assert.equal(resolved.ok, true);
    assert.equal('args' in resolved ? resolved.args.channel : null, '2001');
  });

  test(`${skill}: refuses an unknown name with the places she may read as choices`, () => {
    const refusal = resolve('#memes', { places: PLACES, conversations: [] });
    assert.equal(refusal.ok, false);
    assert.equal('reason' in refusal ? refusal.reason : null, 'args.channel:unknown-channel');
    assert.deepEqual(choiceIds(refusal), ['1001', '1002', '1003']);
  });

  test(`${skill}: refuses a name that fits several places with the matches as choices`, () => {
    const places: Array<PlaceCandidate> = [
      { id: '4001', name: '🌿 herbs', handle: 'h1' },
      { id: '4002', name: '🌱 Herbs', handle: null },
      { id: '4003', name: 'stone', handle: null },
    ];
    const refusal = resolve('herbs', { places, conversations: [] });
    assert.equal(refusal.ok, false);
    assert.equal('code' in refusal ? refusal.code : null, 'target-ambiguous');
    assert.deepEqual(choiceIds(refusal), ['4001', '4002']);
  });

  // The adversary: the community holds a channel she may not read here, and the name is exactly its name.
  test(`${skill}: never matches or lists a channel that is not among the places she may read`, () => {
    const refusal = resolve('staff room', { places: PLACES, conversations: [{ id: '9999', name: 'staff room' }] });
    assert.equal(refusal.ok, false);
    assert.deepEqual(choiceIds(refusal), ['1001', '1002', '1003']);
  });

  test(`${skill}: an unknown name with no place to read is refused with an empty list`, () => {
    const refusal = resolve('#memes', { places: [], conversations: [] });
    assert.equal(refusal.ok, false);
    assert.deepEqual('choices' in refusal ? refusal.choices : null, []);
  });
}

// Green before the change: the write path keeps naming channels by `conversations`, whatever she may read.
test('message.create still resolves a destination from the conversations of the view, not the places to read', () => {
  const view = { skills: skillRegistry(), places: [], conversations: [{ id: '9999', name: 'staff room' }] };
  const resolved = resolveCall({ skill: 'message.create', args: { text: 'hello', channel: 'staff room' } }, view);
  assert.equal(resolved.ok, true);
  assert.equal('args' in resolved ? resolved.args.channel : null, '9999');
});
