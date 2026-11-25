// The custom emoji in text (src/behavior/emoji.ts): the protocol's `<emoji:ID>` tokens of an incoming line become the
// engine's stable names `:e1:`, and the persona's `:e1:` becomes the platform's markup through a lookup by stable name. A
// reaction resolves to something the platform can react with by the same lookup.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as emoji from '../../../src/behavior/emoji.ts';
import { CUSTOM_EMOJI_MARKUP, renderCustomEmoji, resolveReactionEmoji } from '../../../src/behavior/emoji.ts';
import { userText } from '../../../src/behavior/prompt.ts';
import { labels } from '../../fixtures/labels.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import { createTurnRunner } from '../../fixtures/turn-runner.ts';
import { freshWorld, world } from '../../fixtures/turn-world.ts';
import {
  NOW,
  fakeClient,
  fakeHot,
  fakeStore,
  fakeTurnChannel,
  identityCalibrator,
  normalizedTrigger,
  rawMessage,
} from '../../fixtures/turn-kit.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { chainsOf } from '../../fixtures/chains.ts';

/** An emoji as the lookup answers it: the stable name, the current platform name and the id. */
type Named = { id: string; name: string; platformName: string; animated: boolean };

const NAMED: Array<Named> = [
  { id: '111111111111111111', name: 'e1', platformName: 'pepe_cry', animated: false },
  { id: '222222222222222222', name: 'e2', platformName: 'dance', animated: true },
];
const lookup = (name: string): Named | null => NAMED.find((one) => one.name === name) ?? null;

test('CUSTOM_EMOJI_MARKUP: groups are the animated flag, the name and the id; Discord bounds on both', () => {
  const whole = new RegExp(`^${CUSTOM_EMOJI_MARKUP}$`);
  assert.deepEqual(whole.exec('<a:dance:222222222222222222>')?.slice(1), ['a', 'dance', '222222222222222222']);
  assert.deepEqual(whole.exec('<:pepe_cry:111>')?.slice(1), ['', 'pepe_cry', '111']);
  assert.equal(whole.test('<:x:111>'), false, 'a one-character name');
  assert.equal(whole.test(`<:${'n'.repeat(33)}:111>`), false, 'a name over 32 characters');
  assert.equal(whole.test(`<:dance:${'1'.repeat(26)}>`), false, 'an id over 25 digits');
  assert.equal(whole.test('<:δέλτα:111>'), false, 'a non-ASCII name');
});

// An emoji and a sticker go by a stable name of the engine.
test('nameEmojiTokens maps two emoji that share a platform name each to its own stable name', () => {
  const names: Record<string, string> = { '900': 'e1', '901': 'e2' };
  assert.equal(
    emoji.nameEmojiTokens('ha <emoji:900> <emoji:901>', (id: string): string => names[id]),
    'ha :e1: :e2:'
  );
});

// An emoji and a sticker go by a stable name of the engine.
test('renderCustomEmoji turns :e1: into the markup with the current platform name and the id', () => {
  assert.equal(renderCustomEmoji('ok :e1:', lookup), 'ok <:pepe_cry:111111111111111111>');
  assert.equal(renderCustomEmoji(':e2: :e2:', lookup), '<a:dance:222222222222222222> <a:dance:222222222222222222>');
});

// An emoji and a sticker go by a stable name of the engine.
test('renderCustomEmoji leaves a platform name and an unknown stable name as text', () => {
  assert.equal(renderCustomEmoji('so :pepe_cry: and :e9:', lookup), 'so :pepe_cry: and :e9:');
});

// An emoji and a sticker go by a stable name of the engine.
test('renderCustomEmoji: adjacent tokens both resolve, and an unknown one does not swallow the next', () => {
  assert.equal(renderCustomEmoji(':e2::e1:', lookup), '<a:dance:222222222222222222><:pepe_cry:111111111111111111>');
  assert.equal(renderCustomEmoji(':nope:e2:', lookup), ':nope<a:dance:222222222222222222>');
});

// An emoji and a sticker go by a stable name of the engine.
test('renderCustomEmoji: inline code and code blocks are not touched', () => {
  assert.equal(renderCustomEmoji('`:e2:` :e2:', lookup), '`:e2:` <a:dance:222222222222222222>');
  const block = '```\n:e2: :e1:\n```';
  assert.equal(renderCustomEmoji(block, lookup), block);
});

test('renderCustomEmoji: well-formed markup, mentions and timestamps are not touched', () => {
  const text = '<:dance:999999999999999999> <@123456789012345678> <t:1700000000:R>';
  assert.equal(renderCustomEmoji(text, lookup), text);
});

// An emoji and a sticker go by a stable name of the engine.
test('renderCustomEmoji: URLs, "::" and single colons are not mangled', () => {
  const text = 'see https://example.com/:e2:/x and :https://example.com :: 12:30';
  assert.equal(renderCustomEmoji(text, lookup), text);
});

// An emoji and a sticker go by a stable name of the engine.
test('renderCustomEmoji: idempotent', () => {
  const once = renderCustomEmoji('a :e2: b :e1: `:e2:`', lookup);
  assert.equal(renderCustomEmoji(once, lookup), once);
});

test('resolveReactionEmoji: a unicode emoji passes through', () => {
  assert.equal(resolveReactionEmoji('💀', lookup), '💀');
  assert.equal(resolveReactionEmoji(' 🔥 ', null), '🔥');
});

// An emoji and a sticker go by a stable name of the engine.
test('resolveReactionEmoji: :e1: resolves to reactable markup, a platform name to nothing', () => {
  assert.equal(resolveReactionEmoji(':e1:', lookup), '<:pepe_cry:111111111111111111>');
  assert.equal(resolveReactionEmoji(':e2:', lookup), '<a:dance:222222222222222222>');
  assert.equal(resolveReactionEmoji(':pepe_cry:', lookup), null);
});

test('resolveReactionEmoji: <:name:id> with a name the lookup does not hold keeps its own id', () => {
  assert.equal(resolveReactionEmoji('<:other:777777777777777777>', lookup), '<:other:777777777777777777>');
});

// An emoji and a sticker go by a stable name of the engine.
test('resolveReactionEmoji: any custom form without a lookup is dropped', () => {
  assert.equal(resolveReactionEmoji(':e2:', null), null);
  assert.equal(resolveReactionEmoji('<a:dance:222222222222222222>', null), null);
});

const URL_G1 = 'https://tenor.com/view/g1';

const CAPABILITY_TEXT = 'Εδώ ένα αυτοκόλλητο μιλά δυνατά.';

const CAPABLE = {
  gifForms: ['file', 'link'],
  emoji: { actions: ['append', 'replace'], render: { still: '[[{name}|{id}]]' } },
  text: CAPABILITY_TEXT,
};

const WAVE = { id: '7', name: 'e1', platformName: 'wave', animated: false };

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
        // A GIF is stored as one text.
        description: 'ναι φυσικά γνέφει',
        nativeIds: ['item-1'],
        links: [URL_G1],
        places: { c1: { count: 3, last: NOW - 3_600_000 } },
      },
    },
  };
}

async function runScene({
  reply = '<msg reply="#2">ναι, φυσικά, έλα</msg>',
  // The elsewhere pick, the media pick, the query builder and the diary planner answer in strict JSON.
  pick = '{"pick":"none","name":null}',
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
      models: { routes: chainsOf({ analyzer: 'cheap/classifier' }) },
    }
  );
  Object.assign(hot.prompts, { 'classify/pick': 'Pick for {{name}}.', labels });
  const library = sharedLibrary();
  const known = { key: 'k1', ...library.entries.k1 };
  const rails: Array<{ placeId: string; state: { lastUsed?: Record<string, number> } }> = [];
  const store = Object.assign(fakeStore({ placeMemory: { emojiUsage: { '7': { count: 4, last: NOW - 1000 } } } }), {
    getGifs: () => library,
    findGif: (...given: Array<string>) => (given.at(-1) === 'g1' ? known : null),
    getEmojiRails: () => null,
    setEmojiRails: (placeId: string, state: { lastUsed?: Record<string, number> }) => {
      rails.push({ placeId, state });
    },
    recordOwnGif: () => {},
  });
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

test('a `:name:` the place does not have stays text', async () => {
  const { picks, sent } = await runScene({ reply: '<msg>ναι :nope:</msg>' });
  assert.equal(picks.length, 1);
  assert.deepEqual(sent, ['ναι :nope:']);
});
