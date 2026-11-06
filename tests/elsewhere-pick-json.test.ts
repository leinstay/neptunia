// Tests for the elsewhere pick's strict JSON answer (src/behavior/elsewhere-pick.ts): the request hands the client
// ELSEWHERE_FORMAT as `responseFormat`, and parseElsewhereAnswer reads the object text
// `{ "place": number | null, "earlier": boolean, "episodes": [number] }` (1-based, at most four episodes). Each field
// fails on its own to none, as a bad labelled line did, and an answer that is not the object (the old labelled lines
// included) gives none for both fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ELSEWHERE_FORMAT, createElsewherePicker, parseElsewhereAnswer } from '../src/behavior/elsewhere-pick.ts';
import type { ElsewhereEpisode, ElsewherePlace } from '../src/behavior/elsewhere-pick.ts';
import { labels } from './fixtures/labels.ts';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const MINUTE = 60_000;

function place(id: string, ageMinutes: number): ElsewherePlace {
  return {
    id,
    name: `room-${id}`,
    iface: 'alpha',
    kind: 'channel',
    lastActivityAt: NOW - ageMinutes * MINUTE,
    lastAttentionAt: null,
  };
}

function episode(id: string, placeId: string, ageMinutes: number): ElsewhereEpisode {
  return {
    id,
    placeId,
    ageMs: ageMinutes * MINUTE,
    memberName: 'Eleni',
    memberLines: 'πού είναι το βιβλίο',
    selfLines: 'στο ράφι είναι',
  };
}

/** Places c1 and c2 (listed by id), episodes e1 and e2 (listed oldest first): place 2 is c2, episode 2 is e2. */
const PLACES = [place('c1', 1), place('c2', 2)];
const TWO_EPISODES = [episode('e1', 'c1', 10), episode('e2', 'c2', 5)];
/** Five episodes, listed e1 to e5. */
const FIVE_EPISODES = [50, 40, 30, 20, 10].map((age, index) => episode(`e${index + 1}`, 'c1', age));

type Sent = { options: Record<string, unknown> };

/** One pick whose model answers `text`, with the options of each request. */
async function pickWith(text: string, episodes: Array<ElsewhereEpisode> = TWO_EPISODES) {
  const sent: Array<Sent> = [];
  const pick = createElsewherePicker({
    hot: {
      config: {
        bot: { timezone: 'UTC' },
        llm: {},
        models: {},
        elsewhere: { maxPlaces: 10, maxEpisodes: 10, maxOutputTokens: 60, pickTimeoutMs: 1000 },
      },
      prompts: { labels, 'elsewhere-pick': 'Pick for {{name}}.' },
    },
    llm: {
      complete: (_messages: Array<{ role: string; content: unknown }>, options: Record<string, unknown>) => {
        sent.push({ options });
        return Promise.resolve({ text });
      },
    },
    now: () => NOW,
    schedule: () => () => {},
    listPlaces: () => PLACES,
    listEpisodes: () => episodes,
  });
  const line = {
    id: 'm1',
    placeId: 'here',
    authorId: 'u1',
    authorName: 'Eleni',
    content: 'θυμάσαι τι είπες για το βιβλίο;',
    ts: NOW,
    self: false,
  };
  const result = await pick({
    channel: { id: 'here', rootId: 'g1' },
    history: [line],
    trigger: line,
    triggerKind: 'mention',
    mode: 'reply',
    selfName: 'Nova',
    audience: () => true,
  });
  return { result, sent };
}

/** The object text of an answer: none for every field, then `fields`. */
const answer = (fields: Record<string, unknown>) =>
  JSON.stringify({ place: null, earlier: false, episodes: [], ...fields });
const NOTHING = { place: null, episodes: [] };

type Schema = {
  type?: unknown;
  additionalProperties?: unknown;
  required?: Array<string>;
  properties?: Record<string, unknown>;
};

test('the elsewhere request hands the client ELSEWHERE_FORMAT as its responseFormat', async () => {
  // Bug: the schema is defined and never sent, so the model answers in prose and the pick is lost.
  const { sent } = await pickWith(answer({}));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.options.responseFormat, ELSEWHERE_FORMAT);
});

test('ELSEWHERE_FORMAT is a closed object that requires place, earlier and episodes', () => {
  // Bug: a field left out of `required` is dropped by a strict provider, and the parser then voids that field.
  const schema = ELSEWHERE_FORMAT.schema as Schema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...(schema.required ?? [])].sort(), ['earlier', 'episodes', 'place']);
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ['earlier', 'episodes', 'place']);
});

test('a well-formed object picks the place, its direction and the episodes by their listed numbers', async () => {
  const { result } = await pickWith(answer({ place: 2, earlier: true, episodes: [2, 1] }));
  assert.deepEqual(result, { place: { id: 'c2', direction: 'earlier' }, episodes: ['e2', 'e1'] });
});

test('earlier false is a place with no direction', async () => {
  const { result } = await pickWith(answer({ place: 1, earlier: false, episodes: [] }));
  assert.deepEqual(result, { place: { id: 'c1', direction: null }, episodes: [] });
});

test('at most four episodes are taken, in the order answered', async () => {
  // Bug: a model that lists every episode floods the reply request with stored exchanges.
  const { result } = await pickWith(answer({ episodes: [5, 4, 3, 2, 1] }), FIVE_EPISODES);
  assert.deepEqual(result.episodes, ['e5', 'e4', 'e3', 'e2']);
});

test('an episode number past the list is dropped and the known ones stay, as with the lines', async () => {
  const { result } = await pickWith(answer({ episodes: [9, 1] }));
  assert.deepEqual(result.episodes, ['e1']);
});

test('a place outside the list is no place and the episodes still stand', async () => {
  // Bug: a bad place number voids the whole answer, so a good episode pick is lost with it.
  for (const bad of [0, 3, -1, 1.5]) {
    const { result } = await pickWith(answer({ place: bad, episodes: [1] }));
    assert.deepEqual(result, { place: null, episodes: ['e1'] }, String(bad));
  }
});

test('a place of the wrong type, or a missing place, is no place and the episodes still stand', async () => {
  const texts = [
    answer({ place: '2', episodes: [1] }),
    answer({ place: [2], episodes: [1] }),
    JSON.stringify({ earlier: false, episodes: [1] }),
  ];
  for (const text of texts) {
    const { result } = await pickWith(text);
    assert.deepEqual(result, { place: null, episodes: ['e1'] }, text);
  }
});

test('an earlier that is not a boolean voids the place and leaves the episodes', async () => {
  // Bug: the string "false" is truthy, so a place the model wanted as it is now is read back in time.
  const texts = [
    answer({ place: 2, earlier: 'false', episodes: [1] }),
    answer({ place: 2, earlier: null, episodes: [1] }),
  ];
  for (const text of texts) {
    const { result } = await pickWith(text);
    assert.deepEqual(result, { place: null, episodes: ['e1'] }, text);
  }
});

test('episodes of the wrong type, or missing, are no episodes and the place still stands', async () => {
  const texts = [
    answer({ place: 2, episodes: '1' }),
    answer({ place: 2, episodes: [1, '2'] }),
    answer({ place: 2, episodes: null }),
    JSON.stringify({ place: 2, earlier: false }),
  ];
  for (const text of texts) {
    const { result } = await pickWith(text);
    assert.deepEqual(result, { place: { id: 'c2', direction: null }, episodes: [] }, text);
  }
});

/** Answers that are not the object at all: each gives none for both fields. */
const UNREADABLE = [
  'place: 2 earlier\nepisodes: 2, 1',
  'place: none\nepisodes: none',
  'I would pick the second place.',
  '```json\n{"place":2,"earlier":false,"episodes":[1]}\n```',
  '{"place":2,"earlier":false,"episodes":[1]',
  '[2, 1]',
  '2',
  'null',
];

test('an answer that is not the object, the old labelled lines included, picks nothing', async () => {
  for (const text of UNREADABLE) {
    const { result } = await pickWith(text);
    assert.deepEqual(result, NOTHING, JSON.stringify(text));
  }
});

test('parseElsewhereAnswer tells an explicit none from an unreadable answer and a blank one', () => {
  // Bug: the `elsewhere: classified` line reports every broken answer as the model's choice of none.
  const counts = { places: 2, episodes: 2 };
  const chose = parseElsewhereAnswer(answer({}), counts);
  assert.deepEqual([chose.place.reason, chose.episodes.reason], ['none', 'none']);
  const old = parseElsewhereAnswer('place: 1\nepisodes: 1', counts);
  assert.deepEqual([old.place.reason, old.episodes.reason], ['unparsed', 'unparsed']);
  const blank = parseElsewhereAnswer('  ', counts);
  assert.deepEqual([blank.place.reason, blank.episodes.reason], ['empty', 'empty']);
});
