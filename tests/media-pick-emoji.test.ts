// The emoji forms of the media pick (src/behavior/media-pick.ts): their answers, the place's ranked candidates, the
// two rails where 0 switches a rail off, and the one classifier request that covers GIFs and emoji together. An
// interface with no emoji capability gets none. Plan 2026-11-04-cli-and-memory, stage B8.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  afterReply,
  applyEmojiPick,
  createMediaPick,
  openEmojiNames,
  parseMediaPick,
  rankEmojiCandidates,
} from '../src/behavior/media-pick.ts';
import { userText } from '../src/behavior/prompt.ts';
import { labels } from './fixtures/labels.ts';
import { chainsOf } from './fixtures/chains.ts';
import { noMediaNames } from './fixtures/media-namer.ts';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const MINUTE = 60_000;
const PLACE = 'place:room-1';
const ELSEWHERE = 'place:room-2';
const NONE = { kind: 'none' };
const RENDER = { still: '[[{name}|{id}]]', animated: '[[a|{name}|{id}]]' };
const EMOJI_CAPABILITY = { gifForms: [], emoji: { actions: ['append', 'replace'], render: RENDER } };

// The answer.

const OFFERED = { gifs: ['g1'], emoji: ['wave', 'Clap'], actions: ['append', 'replace'] };

test('`emoji <name>` and `replace <name>` name an offered emoji as it is listed', () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  assert.deepEqual(parseMediaPick('{"pick":"emoji","name":"WAVE"}', OFFERED), { kind: 'emoji', name: 'wave' });
  assert.deepEqual(parseMediaPick('{"pick":"replace","name":"clap"}', OFFERED), { kind: 'replace', name: 'Clap' });
});

test('an emoji that was not offered is none', () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  assert.deepEqual(parseMediaPick('{"pick":"emoji","name":"nope"}', OFFERED), NONE);
  assert.deepEqual(parseMediaPick('{"pick":"replace","name":"nope"}', OFFERED), NONE);
});

test('an action the interface does not support is none', () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  assert.deepEqual(parseMediaPick('{"pick":"replace","name":"wave"}', { ...OFFERED, actions: ['append'] }), NONE);
  assert.deepEqual(parseMediaPick('{"pick":"emoji","name":"wave"}', { ...OFFERED, actions: ['replace'] }), NONE);
});

test('two forms in one answer are none, so a reply never gets a GIF and an emoji in the same pass', () => {
  assert.deepEqual(parseMediaPick('gif g1\nemoji wave', OFFERED), NONE);
  assert.deepEqual(parseMediaPick('gif g1 emoji wave', OFFERED), NONE);
});

// The candidates.

const INVENTORY = [
  { id: '1', name: 'e1', platformName: 'wave', animated: false },
  { id: '2', name: 'e2', platformName: 'clap', animated: true },
  { id: '3', name: 'e3', platformName: 'nod', animated: false },
];
// The usage is keyed by the platform id and holds no name.
const USAGE = {
  '2': { count: 9, last: NOW },
  '1': { count: 3, last: NOW },
  gone: { count: 50, last: NOW },
};

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('the candidates are the most used emoji of the place, cut by the cap', () => {
  assert.deepEqual(
    rankEmojiCandidates(INVENTORY, USAGE, 2).map((emoji) => emoji.name),
    ['e2', 'e1']
  );
});

test('an emoji the interface no longer offers is no candidate, however used it was', () => {
  assert.ok(!rankEmojiCandidates(INVENTORY, USAGE, 10).some((emoji) => emoji.name === 'removed'));
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('an empty inventory or a cap of 0 has no candidate', () => {
  assert.deepEqual(rankEmojiCandidates([], USAGE, 5), []);
  assert.deepEqual(rankEmojiCandidates(INVENTORY, USAGE, 0), []);
});

// The rails.

const NAMES = ['e1', 'e2'];
const rails = (emojiPerReplies: number, emojiCooldownMinutes: number) => ({ emojiPerReplies, emojiCooldownMinutes });

test('with no history every emoji is open', () => {
  assert.deepEqual(openEmojiNames(null, NAMES, rails(3, 60), NOW), NAMES);
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('at most one emoji per N replies: closed for N - 1 replies after one, open at the Nth', () => {
  const settings = rails(3, 0);
  const withEmoji = afterReply(null, 'e1', NOW);
  assert.deepEqual(openEmojiNames(withEmoji, NAMES, settings, NOW), [], 'the reply right after');
  const onePlain = afterReply(withEmoji, null, NOW);
  assert.deepEqual(openEmojiNames(onePlain, NAMES, settings, NOW), [], 'the next one');
  const twoPlain = afterReply(onePlain, null, NOW);
  assert.deepEqual(openEmojiNames(twoPlain, NAMES, settings, NOW), NAMES, 'the third reply after it');
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('a per-replies rail of 1 allows an emoji on every reply', () => {
  assert.deepEqual(openEmojiNames(afterReply(null, 'e1', NOW), NAMES, rails(1, 0), NOW), NAMES);
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('the cooldown closes that emoji alone until the minute it ends', () => {
  const state = afterReply(null, 'e1', NOW);
  const settings = rails(0, 10);
  assert.deepEqual(openEmojiNames(state, NAMES, settings, NOW + 10 * MINUTE - 1), ['e2']);
  assert.deepEqual(openEmojiNames(state, NAMES, settings, NOW + 10 * MINUTE), NAMES);
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('0 in either rail switches that rail off, and 0 in both leaves everything open', () => {
  const state = afterReply(null, 'e1', NOW);
  assert.deepEqual(openEmojiNames(state, NAMES, rails(0, 0), NOW), NAMES);
  assert.deepEqual(openEmojiNames(state, NAMES, rails(0, 10), NOW), ['e2'], 'the cooldown still holds');
  assert.deepEqual(openEmojiNames(state, NAMES, rails(3, 0), NOW), [], 'the per-replies rail still holds');
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('a stored state that makes no sense reads as no history', () => {
  assert.deepEqual(openEmojiNames('πολλά', NAMES, rails(3, 60), NOW), NAMES);
});

// What an emoji does to the text.

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
const WAVE = { id: '7', name: 'e1', platformName: 'wave', animated: false };

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('append puts the rendered emoji after the text', () => {
  assert.equal(applyEmojiPick('ναι', { action: 'append', emoji: WAVE }, RENDER), 'ναι [[wave|7]]');
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('replace leaves the rendered emoji alone', () => {
  assert.equal(applyEmojiPick('ναι', { action: 'replace', emoji: WAVE }, RENDER), '[[wave|7]]');
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('an animated emoji takes the animated rendering, else the still one', () => {
  const animated = { ...WAVE, animated: true };
  assert.equal(applyEmojiPick('ναι', { action: 'replace', emoji: animated }, RENDER), '[[a|wave|7]]');
  assert.equal(applyEmojiPick('ναι', { action: 'replace', emoji: animated }, { still: RENDER.still }), '[[wave|7]]');
});

// The pick over a fake model and a fake store.

type RigOptions = {
  answer?: string;
  pickConfig?: object;
  gifs?: Record<string, object>;
};

// The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
function rig({ answer = '{"pick":"none","name":null}', pickConfig = {}, gifs = {} }: RigOptions = {}) {
  const calls: Array<{ messages: Array<{ role: string; content: unknown }>; options: Record<string, unknown> }> = [];
  const held = new Map<string, unknown>();
  let at = NOW;
  const pick = createMediaPick({
    hot: {
      config: {
        bot: { timezone: 'UTC' },
        models: { routes: chainsOf({ analyzer: 'cheap/classifier' }) },
        media: {
          pick: {
            maxOutputTokens: 17,
            candidates: 5,
            emojiCandidates: 5,
            emojiPerReplies: 0,
            emojiCooldownMinutes: 0,
            ...pickConfig,
          },
        },
      },
      prompts: { labels, 'classify/pick': 'Pick for {{name}}.' },
    },
    store: {
      mediaNameOf: noMediaNames,
      getGifs: () => ({ nextId: 9, backfill: null, entries: gifs }),
      getEmojiRails: (placeId: string) => held.get(placeId) ?? null,
      setEmojiRails: (placeId: string, state: unknown) => {
        held.set(placeId, state);
      },
    },
    llm: {
      complete: (messages: Array<{ role: string; content: unknown }>, options: Record<string, unknown>) => {
        calls.push({ messages, options });
        return Promise.resolve({ text: answer });
      },
    },
    clock: () => at,
  });
  return {
    pick,
    calls,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

const args = (fields: object = {}) => ({
  // The chat by its place alone (plan 2026-11-05 T.4).
  placeId: PLACE,
  capability: EMOJI_CAPABILITY,
  messages: [{ text: 'ναι, φυσικά, έλα', replyTo: 2 }],
  history: [],
  selfName: 'Νέα',
  emoji: INVENTORY,
  emojiUsage: USAGE,
  ...fields,
});

const blockOf = (call: { messages: Array<{ content: unknown }> }, name: string): string | null => {
  const found = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(userText(call.messages[1].content));
  return found ? found[1] : null;
};

const ONE_GIF = {
  k1: {
    id: 'g1',
    kind: 'link',
    url: 'https://tenor.com/view/g1',
    count: 1,
    last: NOW,
    firstSeen: NOW,
    // The owner on 2026-11-17: a GIF is stored as one text.
    description: 'ναι φυσικά',
    places: { [PLACE]: { count: 1, last: NOW } },
  },
};

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('an interface with no capability gets none, with no call, whatever the inventory holds', async () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { pick, calls } = rig({ answer: '{"pick":"emoji","name":"e1"}' });
  assert.deepEqual(await pick.pick(args({ capability: null })), NONE);
  assert.equal(calls.length, 0);
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('an interface with GIFs and no emoji capability is offered no emoji and gets none for one', async () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { pick, calls } = rig({ answer: '{"pick":"emoji","name":"e1"}', gifs: ONE_GIF });
  assert.deepEqual(await pick.pick(args({ capability: { gifForms: ['link'] } })), NONE);
  assert.equal(calls.length, 1);
  assert.equal(blockOf(calls[0], 'emoji'), null);
});

test('an interface with no emoji capability and no GIF candidate makes no call', async () => {
  const { pick, calls } = rig();
  assert.deepEqual(await pick.pick(args({ capability: { gifForms: ['link'] } })), NONE);
  assert.equal(calls.length, 0);
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('one request covers both forms', async () => {
  const { pick, calls } = rig({ gifs: ONE_GIF });
  await pick.pick(args({ capability: { ...EMOJI_CAPABILITY, gifForms: ['link'] } }));
  assert.equal(calls.length, 1);
  assert.match(String(blockOf(calls[0], 'gifs')), /g1/);
  assert.match(String(blockOf(calls[0], 'emoji')), /e1/);
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('the emoji are listed most used first, cut by media.pick.emojiCandidates', async () => {
  const { pick, calls } = rig({ pickConfig: { emojiCandidates: 1 } });
  await pick.pick(args());
  const listed = String(blockOf(calls[0], 'emoji'));
  assert.match(listed, /e2/);
  assert.doesNotMatch(listed, /e1/);
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('an emoji answer comes back with its action and the emoji as the interface knows it', async () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const appended = await rig({ answer: '{"pick":"emoji","name":"e1"}' }).pick.pick(args());
  assert.deepEqual(appended, { kind: 'emoji', action: 'append', emoji: INVENTORY[0] });
  const replaced = await rig({ answer: '{"pick":"replace","name":"e1"}' }).pick.pick(args());
  assert.deepEqual(replaced, { kind: 'emoji', action: 'replace', emoji: INVENTORY[0] });
});

test('`none` is the normal answer with emoji on offer', async () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { pick, calls } = rig({ answer: '{"pick":"none","name":null}' });
  assert.deepEqual(await pick.pick(args()), NONE);
  assert.equal(calls.length, 1);
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('past the per-replies rail no emoji is offered, and without GIFs there is no call', async () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { pick, calls } = rig({ answer: '{"pick":"emoji","name":"e1"}', pickConfig: { emojiPerReplies: 2 } });
  pick.noteReply({ placeId: PLACE, emoji: 'e1' });
  assert.deepEqual(await pick.pick(args()), NONE);
  assert.equal(calls.length, 0);
  pick.noteReply({ placeId: PLACE, emoji: null });
  assert.equal((await pick.pick(args())).kind, 'emoji');
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('the per-replies rail of one place leaves another place open', async () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { pick } = rig({ answer: '{"pick":"emoji","name":"e1"}', pickConfig: { emojiPerReplies: 5 } });
  pick.noteReply({ placeId: PLACE, emoji: 'e1' });
  assert.equal((await pick.pick(args({ placeId: ELSEWHERE }))).kind, 'emoji');
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('an emoji in its cooldown is not offered and a model that names it anyway gets none', async () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { pick, calls, advance } = rig({
    answer: '{"pick":"emoji","name":"e1"}',
    pickConfig: { emojiCooldownMinutes: 10 },
  });
  pick.noteReply({ placeId: PLACE, emoji: 'e1' });
  assert.deepEqual(await pick.pick(args()), NONE);
  assert.doesNotMatch(String(blockOf(calls[0], 'emoji')), /e1/);
  advance(10 * MINUTE);
  assert.equal((await pick.pick(args())).kind, 'emoji');
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('with both rails at 0 the rollout setting leaves the prompt alone to decide', async () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { pick, calls } = rig({
    answer: '{"pick":"emoji","name":"e1"}',
    pickConfig: { emojiPerReplies: 0, emojiCooldownMinutes: 0 },
  });
  pick.noteReply({ placeId: PLACE, emoji: 'e1' });
  assert.equal((await pick.pick(args())).kind, 'emoji');
  assert.equal(calls.length, 1);
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('offers e1 by its stable name and appends its markup with the platform name when picked', async () => {
  const { pick: chooser, calls } = rig({ answer: '{"pick":"emoji","name":"e1"}' });
  const result = await chooser.pick(args());
  const [request] = calls;
  const listed = String(blockOf(request, 'emoji'));
  assert.match(listed, /e1/);
  assert.doesNotMatch(listed, /wave/);
  assert.equal(result.kind, 'emoji');
  if (result.kind !== 'emoji') return;
  assert.equal(applyEmojiPick('ναι', result, RENDER), 'ναι [[wave|1]]');
});
