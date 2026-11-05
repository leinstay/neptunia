// One `elsewhere-pick` classifier call replaces the route classifier and the participation pick: one prompt, one
// request per started turn and one answer of two fields, the other place to look at and the episodes the line refers to.
// Contract, plan 2026-11-04-cli-and-memory B3, module src/behavior/elsewhere-pick.ts:
//   `elsewhereCandidates(input)`: the group places other than the current one that pass `audience` (strictly true; a
//   throw counts as false), the newest `maxPlaces` by the later of `lastActivityAt` and `lastAttentionAt`, listed by id;
//   the episodes of those that pass `audience`, the newest `maxEpisodes`, listed oldest first
//   `buildElsewhereRequest(input)`: system = the prompt with `{{name}}`; user = a stable part with `<places>` and
//   `<episodes>`, then `<episode_ages>`, the transcript and the candidate; null for a blank prompt or no line at all
//   `parseElsewhereAnswer(raw, { places, episodes })`: two labelled lines, `place: <n>[ earlier] | none` and
//   `episodes: <n>, <n> | none`, in either order, any case, at most four episodes
//   `createElsewherePicker(deps)(args)` resolves `{ place: { id, direction } | null, episodes: Array<string> }` and never
//   rejects; settings `elsewhere.maxPlaces` and `elsewhere.maxEpisodes`, read at the moment of use
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildElsewhereRequest,
  createElsewherePicker,
  elsewhereCandidates,
  parseElsewhereAnswer,
} from '../src/behavior/elsewhere-pick.ts';
import type { ElsewhereEpisode, ElsewherePlace } from '../src/behavior/elsewhere-pick.ts';
import { DailyCapError } from '../src/llm/openrouter.ts';
import { PURPOSE_ROLES } from '../src/llm/roles.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { labels } from './fixtures/labels.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const MINUTE = 60_000;
const everyone = () => true;

function place(id: string, ageMinutes: number | null, extra: Partial<ElsewherePlace> = {}): ElsewherePlace {
  return {
    id,
    name: `room-${id}`,
    iface: 'alpha',
    kind: 'channel',
    lastActivityAt: ageMinutes === null ? null : NOW - ageMinutes * MINUTE,
    lastAttentionAt: null,
    ...extra,
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

const candidates = (input: Partial<Parameters<typeof elsewhereCandidates>[0]>) =>
  elsewhereCandidates({
    places: [],
    episodes: [],
    currentPlaceId: 'here',
    audience: everyone,
    maxPlaces: 10,
    maxEpisodes: 10,
    ...input,
  });

const ids = (list: Array<{ id: string }>) => list.map((item) => item.id);

test('a place list over the cap keeps the most recently active, listed by id', () => {
  // Bug: a server of sixty channels overruns the prompt, or the kept order changes each turn and breaks the cache.
  const { places } = candidates({
    places: [place('c3', 300), place('c1', 10), place('c4', 5), place('c2', 200)],
    maxPlaces: 2,
  });
  assert.deepEqual(ids(places), ['c1', 'c4']);
});

test('recent attention keeps a place the talk has left', () => {
  // Bug: only activity ranks, so the place she just spoke in falls out behind noisier ones.
  const { places } = candidates({
    places: [
      place('quiet', 500, { lastAttentionAt: NOW - MINUTE }),
      place('noisy', 2),
      place('stale', 400, { lastAttentionAt: NOW - 300 * MINUTE }),
    ],
    maxPlaces: 2,
  });
  assert.deepEqual(ids(places), ['noisy', 'quiet']);
});

test('a place with no known time goes last', () => {
  // Bug: a null time sorts first and pushes out every place with a real one.
  const { places } = candidates({ places: [place('never', null), place('seen', 900)], maxPlaces: 1 });
  assert.deepEqual(ids(places), ['seen']);
});

test('an episode list over the cap keeps the newest, listed oldest first', () => {
  // Bug: the oldest survive the cut, or the order flips and the cached prefix is lost.
  const { episodes } = candidates({
    places: [place('c1', 1)],
    episodes: [episode('e1', 'c1', 900), episode('e2', 'c1', 10), episode('e3', 'c1', 100)],
    maxEpisodes: 2,
  });
  assert.deepEqual(ids(episodes), ['e3', 'e2']);
});

test('a place whose audience cannot be proved is absent and takes no slot', () => {
  // Bug: the filter runs after the cut, so a refused place eats the budget of a permitted one.
  const { places } = candidates({
    places: [place('secret', 1), place('open', 50)],
    audience: (id) => id === 'open',
    maxPlaces: 1,
  });
  assert.deepEqual(ids(places), ['open']);
});

test('an audience check that throws or answers no boolean leaves the place out', () => {
  // Bug: an unknown audience counts as allowed, and a private room reaches a wider one.
  const { places } = candidates({
    places: [place('throws', 1), place('vague', 2)],
    audience: (id) => {
      if (id === 'throws') throw new Error('no audience');
      return 'yes' as unknown as boolean;
    },
  });
  assert.deepEqual(places, []);
});

test('the audience is asked per place, whatever the interface', () => {
  // Bug: one answer for an interface lets a private thread through beside a public channel of the same platform.
  const { places } = candidates({
    places: [
      place('open-a', 1, { iface: 'alpha' }),
      place('closed-a', 2, { iface: 'alpha' }),
      place('open-b', 3, { iface: 'beta' }),
      place('closed-b', 4, { iface: 'beta' }),
    ],
    audience: (id) => id.startsWith('open'),
  });
  assert.deepEqual(ids(places), ['open-a', 'open-b']);
});

test('an episode of a refused place is absent', () => {
  // Bug: episodes are filtered apart from places, so a private exchange reaches the prompt by the other field.
  const { episodes } = candidates({
    places: [place('open', 1), place('secret', 2)],
    episodes: [episode('e1', 'open', 5), episode('e2', 'secret', 5)],
    audience: (id) => id === 'open',
  });
  assert.deepEqual(ids(episodes), ['e1']);
});

test('the current place is neither a place nor an episode candidate', () => {
  // Bug: a pick of the place she is in costs a read and shows the same lines twice.
  const { places, episodes } = candidates({
    places: [place('here', 1), place('c1', 2)],
    episodes: [episode('e1', 'here', 1), episode('e2', 'c1', 1)],
  });
  assert.deepEqual(ids(places), ['c1']);
  assert.deepEqual(ids(episodes), ['e2']);
});

test('a DM is never a place candidate, whatever its audience answers', () => {
  // Bug: one person's private chat is offered as a place to read in a group turn.
  const { places } = candidates({ places: [place('d1', 1, { kind: 'dm' }), place('c1', 2)] });
  assert.deepEqual(ids(places), ['c1']);
});

test('caps of zero and empty inputs yield empty lists', () => {
  // Bug: `slice(-0)` or a missing guard returns the whole list when the setting says none.
  const zero = candidates({
    places: [place('c1', 1)],
    episodes: [episode('e1', 'c1', 1)],
    maxPlaces: 0,
    maxEpisodes: 0,
  });
  assert.deepEqual([zero.places, zero.episodes], [[], []]);
  const empty = candidates({});
  assert.deepEqual([empty.places, empty.episodes], [[], []]);
});

test('a full answer yields both fields', () => {
  // Bug: the parser reads only the first line, so one of the two merged classifiers goes unanswered.
  assert.deepEqual(parseElsewhereAnswer('place: 2\nepisodes: 3, 1', { places: 4, episodes: 4 }), {
    place: { index: 2, direction: null, reason: 'pick' },
    episodes: { indices: [3, 1], reason: 'pick' },
  });
});

test('the labels may come in either order and any case', () => {
  // Bug: a fixed line order drops a good answer on a model's whim.
  const parsed = parseElsewhereAnswer('Episodes: 1\nPLACE: 1', { places: 1, episodes: 1 });
  assert.equal(parsed.place.index, 1);
  assert.deepEqual(parsed.episodes.indices, [1]);
});

test('a place may ask for the page before her last view', () => {
  // Bug: the `earlier` of the route classifier is lost in the merge.
  const parsed = parseElsewhereAnswer('place: 1 earlier\nepisodes: none', { places: 1, episodes: 1 });
  assert.deepEqual(parsed.place, { index: 1, direction: 'earlier', reason: 'pick' });
});

test('none in one field leaves the other standing', () => {
  // Bug: the first `none` of the old parsers ends the whole answer.
  const parsed = parseElsewhereAnswer('place: none\nepisodes: 2', { places: 3, episodes: 3 });
  assert.equal(parsed.place.index, null);
  assert.equal(parsed.place.reason, 'none');
  assert.deepEqual(parsed.episodes.indices, [2]);
});

test('a malformed place line yields none for the place, the episodes still parse', () => {
  // Bug: the two fields fail together, so a slip in one costs the other.
  const parsed = parseElsewhereAnswer('place: the second one\nepisodes: 1', { places: 2, episodes: 2 });
  assert.equal(parsed.place.index, null);
  assert.equal(parsed.place.reason, 'unparsed');
  assert.deepEqual(parsed.episodes.indices, [1]);
});

test('a malformed episodes line yields none for the episodes, the place still parses', () => {
  // Bug: as above, from the other side.
  const parsed = parseElsewhereAnswer('place: 1\nepisodes: 1 and then 2', { places: 2, episodes: 2 });
  assert.equal(parsed.place.index, 1);
  assert.deepEqual(parsed.episodes.indices, []);
  assert.equal(parsed.episodes.reason, 'unparsed');
});

test('an answer with no label yields none for both', () => {
  // Bug: a bare number from an old prompt is read as a place or an episode by guess.
  const parsed = parseElsewhereAnswer('2', { places: 3, episodes: 3 });
  assert.equal(parsed.place.index, null);
  assert.deepEqual(parsed.episodes.indices, []);
});

test('an empty answer yields none for both', () => {
  // Bug: a model that spent its output cap thinking throws here.
  for (const raw of ['', null, undefined]) {
    const parsed = parseElsewhereAnswer(raw, { places: 1, episodes: 1 });
    assert.equal(parsed.place.index, null);
    assert.equal(parsed.place.reason, 'empty');
    assert.deepEqual(parsed.episodes.indices, []);
  }
});

test('a number outside the list is unknown, and only the known episodes are kept', () => {
  // Bug: an out-of-range number indexes past the list and the turn gets `undefined` for an id.
  const parsed = parseElsewhereAnswer('place: 9\nepisodes: 9, 2', { places: 2, episodes: 2 });
  assert.equal(parsed.place.index, null);
  assert.equal(parsed.place.reason, 'unknown-id');
  assert.deepEqual(parsed.episodes.indices, [2]);
});

test('at most four episodes are taken, each once, in the answer order', () => {
  // Bug: a long or repeated answer floods the turn's block.
  const parsed = parseElsewhereAnswer('episodes: 5, 5, 4, 3, 2, 1', { places: 0, episodes: 5 });
  assert.deepEqual(parsed.episodes.indices, [5, 4, 3, 2]);
});

test('the request keeps its stable lists first and the per-turn blocks after them', () => {
  // Bug: the ages or the chat move into the cached part, so every turn misses the provider cache.
  const messages = buildElsewhereRequest({
    prompt: 'Pick for {{name}}.',
    selfName: 'Nova',
    placeLines: ['1 | room-a'],
    episodeLines: ['1 | room-a | Eleni: ερώτηση | Nova: απάντηση'],
    episodeAges: ['1 | 2 h'],
    transcriptBlock: '<transcript>\nchat\n</transcript>',
    candidateBlock: '<candidate>\nEleni: τι έγινε\n</candidate>',
  });
  assert.equal(messages?.[0]?.content, 'Pick for Nova.');
  const parts = messages?.[1]?.content as Array<{ text: string; cacheSegment?: string }>;
  const stable = parts
    .filter((part) => part.cacheSegment === 'stable')
    .map((part) => part.text)
    .join('');
  const tail = parts
    .filter((part) => part.cacheSegment !== 'stable')
    .map((part) => part.text)
    .join('');
  assert.ok(stable.includes('<places>') && stable.includes('<episodes>'));
  assert.ok(tail.includes('<episode_ages>') && tail.includes('<transcript>') && tail.includes('<candidate>'));
  assert.ok(!stable.includes('<episode_ages>') && !stable.includes('<candidate>'));
});

test('a list with no line leaves out its block and the other still goes', () => {
  // Bug: an empty `<places>` tells the model there is a list and invites a number.
  const messages = buildElsewhereRequest({
    prompt: 'Pick.',
    selfName: 'Nova',
    placeLines: [],
    episodeLines: ['1 | room-a | | Nova: απάντηση'],
    episodeAges: ['1 | 2 h'],
  });
  const text = JSON.stringify(messages?.[1]?.content);
  assert.equal(text.includes('<places>'), false);
  assert.equal(text.includes('<episodes>'), true);
});

test('no request is built for a blank prompt or with nothing to pick from', () => {
  // Bug: the call is paid for with nothing to choose.
  const given = { selfName: 'Nova', episodeAges: [] };
  assert.equal(buildElsewhereRequest({ ...given, prompt: '  ', placeLines: ['1 | a'], episodeLines: [] }), null);
  assert.equal(buildElsewhereRequest({ ...given, prompt: 'Pick.', placeLines: [], episodeLines: [] }), null);
});

/** One picker over fake reads and a fake model. */
function picker(
  options: {
    answer?: string | Error;
    places?: Array<ElsewherePlace>;
    episodes?: Array<ElsewhereEpisode>;
    prompt?: string | null;
    config?: Record<string, unknown>;
  } = {}
) {
  const calls: Array<{ user: string; options: Record<string, unknown>; signal?: AbortSignal }> = [];
  const scheduled: Array<() => void> = [];
  let release: (() => void) | null = null;
  const hot = {
    config: {
      bot: { timezone: 'UTC' },
      llm: {},
      models: {},
      elsewhere: { maxPlaces: 10, maxEpisodes: 10, maxOutputTokens: 60, pickTimeoutMs: 1000 },
      ...options.config,
    },
    prompts: {
      labels,
      ...(options.prompt === null ? {} : { 'elsewhere-pick': options.prompt ?? 'Pick for {{name}}.' }),
    },
  };
  const pick = createElsewherePicker({
    hot,
    llm: {
      complete: async (messages: Array<{ content: unknown }>, request: Record<string, unknown>) => {
        calls.push({ user: JSON.stringify(messages[1]?.content), options: request });
        if (options.answer instanceof Error) throw options.answer;
        if (options.answer === 'hang') {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        return { text: options.answer ?? 'place: none\nepisodes: none' };
      },
    },
    now: () => NOW,
    schedule: (fn) => {
      scheduled.push(fn);
      return () => {};
    },
    listPlaces: () => options.places ?? [place('c1', 1), place('c2', 2)],
    listEpisodes: () => options.episodes ?? [episode('e1', 'c1', 10), episode('e2', 'c2', 5)],
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
  const args = {
    channel: { id: 'here', rootId: 'g1' },
    history: [line],
    trigger: line,
    triggerKind: 'mention',
    mode: 'reply',
    selfName: 'Nova',
    audience: everyone,
  };
  return { pick, args, calls, scheduled, hot, release: () => release?.() };
}

test('one pick is one request, and it answers both fields with the ids of the listed candidates', async () => {
  // Bug: the merge still sends two calls, or a number is mapped against the list before the cut.
  const scene = picker({ answer: 'place: 2 earlier\nepisodes: 2, 1' });
  const result = await scene.pick(scene.args);
  assert.equal(scene.calls.length, 1);
  assert.deepEqual(result, { place: { id: 'c2', direction: 'earlier' }, episodes: ['e2', 'e1'] });
});

test('the request goes out on the analyzer under the purpose elsewhere-pick', async () => {
  // Bug: the new purpose has no role, so it bills the core key.
  const scene = picker();
  await scene.pick(scene.args);
  assert.equal(scene.calls[0]?.options.purpose, 'elsewhere-pick');
  assert.equal(PURPOSE_ROLES['elsewhere-pick'], 'analyzer');
});

test('the caps are read at the moment of use', async () => {
  // Bug: a setting changed by the owner takes effect only after a restart.
  const scene = picker({ places: [place('c1', 1), place('c2', 2), place('c3', 3)], episodes: [] });
  await scene.pick(scene.args);
  const before = scene.calls[0]?.user ?? '';
  assert.ok(before.includes('room-c3'));
  scene.hot.config.elsewhere.maxPlaces = 1;
  await scene.pick(scene.args);
  const after = scene.calls[1]?.user ?? '';
  assert.ok(after.includes('room-c1') && !after.includes('room-c2'));
});

test('a place and an episode the audience refuses never reach the request', async () => {
  // Bug: the picker lists first and judges afterwards, so a private room's lines leave the process.
  const scene = picker({ places: [place('c1', 1), place('secret', 2)], episodes: [episode('e2', 'secret', 1)] });
  await scene.pick({ ...scene.args, audience: (id: string) => id === 'c1' });
  assert.equal(scene.calls[0]?.user.includes('room-secret'), false);
  assert.equal(scene.calls[0]?.user.includes('στο ράφι είναι'), false);
});

test('nothing to pick from costs no request', async () => {
  // Bug: every quiet turn pays a classifier call for an empty list.
  const scene = picker({ places: [], episodes: [] });
  assert.deepEqual(await scene.pick(scene.args), { place: null, episodes: [] });
  assert.equal(scene.calls.length, 0);
});

test('a missing prompt costs no request and says why', async () => {
  // Bug: a deployment without the file fails each turn with no trace, or sends a blank system message.
  const scene = picker({ prompt: null });
  const { result, logs } = await withCapturedLogs(() => scene.pick(scene.args));
  assert.deepEqual(result, { place: null, episodes: [] });
  assert.equal(scene.calls.length, 0);
  assert.equal(logs.find((entry) => entry.msg === 'elsewhere: skipped')?.reason, 'no-prompt');
});

test('a turn with no line to judge costs no request', async () => {
  // Bug: an unprompted turn in an empty place asks about nothing.
  const scene = picker();
  assert.deepEqual(await scene.pick({ ...scene.args, history: [], trigger: null }), { place: null, episodes: [] });
  assert.equal(scene.calls.length, 0);
});

test('a diary post never asks', async () => {
  // Bug: the merged hook runs for a mode neither old classifier served.
  const scene = picker();
  await scene.pick({ ...scene.args, mode: 'selfreflection' });
  assert.equal(scene.calls.length, 0);
});

test('a malformed answer resolves none for both and logs the two parse codes', async () => {
  // Bug: garbage from the model throws into the turn, or the log carries the answer's text.
  const scene = picker({ answer: 'μάλλον το δεύτερο' });
  const { result, logs } = await withCapturedLogs(() => scene.pick(scene.args));
  assert.deepEqual(result, { place: null, episodes: [] });
  const classified = logs.find((entry) => entry.msg === 'elsewhere: classified');
  assert.equal(classified?.placeParse, 'unparsed');
  assert.equal(classified?.episodesParse, 'unparsed');
  assert.equal(JSON.stringify(classified).includes('μάλλον'), false);
});

test('a failed request resolves none for both and logs its rail code', async () => {
  // Bug: the daily cap's error reaches the turn and costs her reply.
  const scene = picker({ answer: new DailyCapError() });
  const { result, logs } = await withCapturedLogs(() => scene.pick(scene.args));
  assert.deepEqual(result, { place: null, episodes: [] });
  assert.equal(logs.find((entry) => entry.msg === 'elsewhere: failed')?.reason, 'daily-cap');
});

test('a pick past its time limit is aborted, told to the turn and worth nothing', async () => {
  // Bug: the turn waits on a slow classifier, or takes its late answer after going on without it.
  const scene = picker({ answer: 'hang' });
  const told: Array<Record<string, unknown>> = [];
  const pending = scene.pick({ ...scene.args, limits: { add: (entry: Record<string, unknown>) => told.push(entry) } });
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scene.scheduled.length, 1);
  scene.scheduled[0]?.();
  scene.release();
  assert.deepEqual(await pending, { place: null, episodes: [] });
  assert.deepEqual(told, [{ kind: 'helper-timeout', where: 'elsewhere-pick' }]);
});

test('the purposes of the two old classifiers are gone', () => {
  // Bug: a leftover caller still sends `route-channel` or `participation-pick`, and pays the second call again.
  assert.equal(Object.hasOwn(PURPOSE_ROLES, 'route-channel'), false);
  assert.equal(Object.hasOwn(PURPOSE_ROLES, 'participation-pick'), false);
});
