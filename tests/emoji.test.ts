// The custom emoji in text (src/behavior/emoji.ts): the protocol's `<emoji:ID>` tokens of an incoming line become the
// engine's stable names `:e1:`, and her `:e1:` becomes the platform's markup through a lookup by stable name. A
// reaction resolves to something the platform can react with by the same lookup.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as emoji from '../src/behavior/emoji.ts';
import { CUSTOM_EMOJI_MARKUP, renderCustomEmoji, resolveReactionEmoji } from '../src/behavior/emoji.ts';

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

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('nameEmojiTokens maps two emoji that share a platform name each to its own stable name', () => {
  const names: Record<string, string> = { '900': 'e1', '901': 'e2' };
  const listed = [
    { id: '900', name: 'kekw' },
    { id: '901', name: 'kekw' },
  ];
  assert.equal(
    emoji.nameEmojiTokens('ha <emoji:900> <emoji:901>', (id) => names[id] ?? null, listed),
    'ha :e1: :e2:'
  );
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('nameEmojiTokens leaves a token with no stable name as its platform name between colons', () => {
  assert.equal(
    emoji.nameEmojiTokens('ha <emoji:900>', () => null, [{ id: '900', name: 'kekw' }]),
    'ha :kekw:'
  );
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('renderCustomEmoji turns :e1: into the markup with the current platform name and the id', () => {
  assert.equal(renderCustomEmoji('ok :e1:', lookup), 'ok <:pepe_cry:111111111111111111>');
  assert.equal(renderCustomEmoji(':e2: :e2:', lookup), '<a:dance:222222222222222222> <a:dance:222222222222222222>');
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('renderCustomEmoji leaves a platform name and an unknown stable name as text', () => {
  assert.equal(renderCustomEmoji('so :pepe_cry: and :e9:', lookup), 'so :pepe_cry: and :e9:');
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('renderCustomEmoji: adjacent tokens both resolve, and an unknown one does not swallow the next', () => {
  assert.equal(renderCustomEmoji(':e2::e1:', lookup), '<a:dance:222222222222222222><:pepe_cry:111111111111111111>');
  assert.equal(renderCustomEmoji(':nope:e2:', lookup), ':nope<a:dance:222222222222222222>');
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('renderCustomEmoji: inline code and code blocks are not touched', () => {
  assert.equal(renderCustomEmoji('`:e2:` :e2:', lookup), '`:e2:` <a:dance:222222222222222222>');
  const block = '```\n:e2: :e1:\n```';
  assert.equal(renderCustomEmoji(block, lookup), block);
});

test('renderCustomEmoji: well-formed markup, mentions and timestamps are not touched', () => {
  const text = '<:dance:999999999999999999> <@123456789012345678> <t:1700000000:R>';
  assert.equal(renderCustomEmoji(text, lookup), text);
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('renderCustomEmoji: URLs, "::" and single colons are not mangled', () => {
  const text = 'see https://example.com/:e2:/x and :https://example.com :: 12:30';
  assert.equal(renderCustomEmoji(text, lookup), text);
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('renderCustomEmoji: idempotent', () => {
  const once = renderCustomEmoji('a :e2: b :e1: `:e2:`', lookup);
  assert.equal(renderCustomEmoji(once, lookup), once);
});

test('resolveReactionEmoji: a unicode emoji passes through', () => {
  assert.equal(resolveReactionEmoji('💀', lookup), '💀');
  assert.equal(resolveReactionEmoji(' 🔥 ', null), '🔥');
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('resolveReactionEmoji: :e1: resolves to reactable markup, a platform name to nothing', () => {
  assert.equal(resolveReactionEmoji(':e1:', lookup), '<:pepe_cry:111111111111111111>');
  assert.equal(resolveReactionEmoji(':e2:', lookup), '<a:dance:222222222222222222>');
  assert.equal(resolveReactionEmoji(':pepe_cry:', lookup), null);
});

test('resolveReactionEmoji: <:name:id> with a name the lookup does not hold keeps its own id', () => {
  assert.equal(resolveReactionEmoji('<:other:777777777777777777>', lookup), '<:other:777777777777777777>');
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('resolveReactionEmoji: any custom form without a lookup is dropped', () => {
  assert.equal(resolveReactionEmoji(':e2:', null), null);
  assert.equal(resolveReactionEmoji('<a:dance:222222222222222222>', null), null);
});
