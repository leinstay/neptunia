// Custom emoji inside a turn (src/behavior/turn.ts over the fake interface): they belong to the interface, so her
// request carries no `<emoji>` block and no rule of its own, the text comes from the capability, and an emoji the pick
// chose goes out as the interface renders it. Plan 2026-11-04-cli-and-memory, stage B8.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { userText } from '../src/behavior/prompt.ts';
import { labels } from './fixtures/labels.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { createTurnRunner } from './fixtures/turn-runner.ts';
import { freshWorld, world } from './fixtures/turn-world.ts';
import {
  NOW,
  fakeClient,
  fakeHot,
  fakeStore,
  fakeTurnChannel,
  identityCalibrator,
  normalizedTrigger,
  rawMessage,
} from './fixtures/turn-kit.ts';
import type { Untyped } from '../src/tools/types.ts';

const URL_G1 = 'https://tenor.com/view/g1';
const CAPABILITY_TEXT = 'Εδώ ένα αυτοκόλλητο μιλά δυνατά.';
const CAPABLE = {
  gifForms: ['file', 'link'],
  emoji: { actions: ['append', 'replace'], render: { still: '[[{name}|{id}]]' } },
  text: CAPABILITY_TEXT,
};
const WAVE = { id: '7', name: 'wave', animated: false };

beforeEach(() => {
  freshWorld();
});

function sharedLibrary() {
  return {
    nextId: 2,
    backfill: null,
    entries: {
      k1: {
        id: 'g1',
        kind: 'link',
        url: URL_G1,
        itemId: 'item-1',
        messageId: 'm-1',
        placeId: 'c1',
        count: 3,
        last: NOW - 3_600_000,
        firstSeen: NOW - 7_200_000,
        caption: 'ναι φυσικά γνέφει',
        nativeIds: ['item-1'],
        links: [URL_G1],
        places: { c1: { count: 3, last: NOW - 3_600_000 } },
      },
    },
  };
}

async function runScene({
  reply = '<msg reply="#2">ναι, φυσικά, έλα</msg>',
  pick = 'none',
  mediaPick = CAPABLE,
}: { reply?: string; pick?: string; mediaPick?: object | null } = {}) {
  if (mediaPick) {
    const port = world().port as unknown as { capabilities: () => object };
    const declared = port.capabilities.bind(port);
    port.capabilities = () => ({ ...declared(), mediaPick });
  }
  const raws = [
    rawMessage({ id: 'm0', ts: NOW - 5000, content: 'καλημέρα' }),
    rawMessage({ id: 'm1', ts: NOW - 1000, content: 'θα έρθεις απόψε;' }),
  ];
  const channel = fakeTurnChannel({ historyMessages: raws });
  const calls: Array<{ messages: Array<{ content: unknown }>; options: Record<string, Untyped> }> = [];
  const hot = fakeHot(
    {},
    {},
    {
      media: {
        maxPerTurn: 6,
        filePreviewChars: 500,
        pick: { maxOutputTokens: 17, candidates: 5, emojiCandidates: 5, emojiPerReplies: 0, emojiCooldownMinutes: 0 },
      },
      models: { base: { analyzer: 'cheap/classifier' } },
    }
  );
  Object.assign(hot.prompts, { 'media-pick': 'Pick for {{name}}.', labels });
  const library = sharedLibrary();
  const known = { key: 'k1', ...library.entries.k1 };
  const rails: Array<{ placeId: string; state: { lastUsed?: Record<string, number> } }> = [];
  const store = Object.assign(
    fakeStore({ placeMemory: { emojiUsage: { '7': { name: 'wave', count: 4, last: NOW - 1000 } } } }),
    {
      getGifs: () => library,
      findGif: (...given: Array<string>) => (given.at(-1) === 'g1' ? known : null),
      getEmojiRails: () => null,
      setEmojiRails: (placeId: string, state: { lastUsed?: Record<string, number> }) => {
        rails.push({ placeId, state });
      },
      recordOwnGif: () => {},
    }
  );
  const emoji = {
    refresh: () => Promise.resolve(),
    byName: (name: string) => (name === WAVE.name ? WAVE : null),
    list: () => [WAVE],
    urlOf: () => null,
  };
  const turns = createTurnRunner({
    hot,
    store,
    emoji,
    llm: {
      complete: (messages: Array<{ content: unknown }>, options: Record<string, Untyped>) => {
        calls.push({ messages, options });
        return Promise.resolve({
          text: options?.purpose === 'media-pick' ? pick : reply,
          usage: {},
          estimated: 10,
        });
      },
    },
    calibrator: identityCalibrator(),
    client: fakeClient(),
    now: () => NOW,
  });
  const trigger = normalizedTrigger(raws[1]);
  await turns.runTurn(wrongly({ channel, mode: 'reply', trigger, triggerKind: 'mention' }));
  const own = calls.find((call) => call.options?.purpose !== 'media-pick');
  assert.ok(own);
  return {
    rails,
    picks: calls.filter((call) => call.options?.purpose === 'media-pick'),
    request: own.messages.map((message) => userText(message.content) || String(message.content)).join('\n'),
    sent: channel.sent.map((payload: { content: unknown }) => payload.content),
  };
}

test('`emoji <name>` appends the emoji as the interface renders it', async () => {
  const { sent } = await runScene({ pick: 'emoji wave' });
  assert.deepEqual(sent, ['ναι, φυσικά, έλα [[wave|7]]']);
});

test('`replace <name>` posts the emoji in place of the first message and the rest follow', async () => {
  const { sent } = await runScene({ reply: '<msg>ναι, φυσικά, έλα</msg><msg>στις οκτώ</msg>', pick: 'replace wave' });
  assert.deepEqual(sent, ['[[wave|7]]', 'στις οκτώ']);
});

test('a reply that got a GIF carries no emoji', async () => {
  const { picks, sent } = await runScene({ pick: 'gif g1' });
  assert.equal(picks.length, 1);
  assert.deepEqual(sent, [URL_G1]);
});

test('an emoji the model made up leaves the reply as written', async () => {
  const { picks, sent } = await runScene({ pick: 'emoji nope' });
  assert.equal(picks.length, 1);
  assert.deepEqual(sent, ['ναι, φυσικά, έλα']);
});

test('a `:name:` the place does not have stays text', async () => {
  const { picks, sent } = await runScene({ reply: '<msg>ναι :nope:</msg>' });
  assert.equal(picks.length, 1);
  assert.deepEqual(sent, ['ναι :nope:']);
});

test('a posted emoji is counted for the place, and so is a reply without one', async () => {
  const withEmoji = await runScene({ pick: 'emoji wave' });
  assert.equal(withEmoji.rails.length, 1);
  assert.equal(withEmoji.rails[0].state.lastUsed?.wave, NOW);
  freshWorld();
  const plain = await runScene({ pick: 'none' });
  assert.equal(plain.rails.length, 1);
  assert.equal(plain.rails[0].state.lastUsed?.wave, undefined);
});

test('a turn on an interface with the capability carries its text and no emoji block', async () => {
  const { request } = await runScene();
  assert.ok(request.includes(CAPABILITY_TEXT), 'the capability text');
  assert.ok(!request.includes('<emoji>'), 'no <emoji>');
  assert.ok(!request.includes(labels.senses.customEmoji), 'no rule of the core');
});

test('a turn on an interface without the capability carries no emoji block, no rule and no text', async () => {
  const { picks, request, sent } = await runScene({ mediaPick: null, pick: 'emoji wave' });
  assert.equal(picks.length, 0);
  assert.deepEqual(sent, ['ναι, φυσικά, έλα']);
  assert.ok(!request.includes('<emoji>'), 'no <emoji>');
  assert.ok(!request.includes(labels.senses.customEmoji), 'no rule of the core');
  assert.ok(!request.includes(CAPABILITY_TEXT), 'no text');
});
