// The server's custom emoji: `:name:` written by the persona becomes real
// Discord markup, reactions resolve to something discord.js can react with.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmojiIndex } from '../src/discord/emoji.js';
import { CUSTOM_EMOJI_MARKUP, matchEmojiName, renderCustomEmoji, resolveReactionEmoji } from '../src/behavior/emoji.js';

const EMOJIS = [
  { id: '111111111111111111', name: 'pepe_cry', animated: false },
  { id: '222222222222222222', name: 'dance', animated: true },
  { id: '333333333333333333', name: 'Kappa', animated: false },
  { id: '444444444444444444', name: 'kappa', animated: false },
  { id: '555555555555555555', name: 'Blush', animated: false },
];
const lookup = (name) => matchEmojiName(EMOJIS, name);

test('CUSTOM_EMOJI_MARKUP: groups are the animated flag, the name and the id; Discord bounds on both', () => {
  const whole = new RegExp(`^${CUSTOM_EMOJI_MARKUP}$`);
  assert.deepEqual(whole.exec('<a:dance:222222222222222222>').slice(1), ['a', 'dance', '222222222222222222']);
  assert.deepEqual(whole.exec('<:pepe_cry:111>').slice(1), ['', 'pepe_cry', '111']);
  assert.equal(whole.test('<:x:111>'), false, 'a one-character name');
  assert.equal(whole.test(`<:${'n'.repeat(33)}:111>`), false, 'a name over 32 characters');
  assert.equal(whole.test(`<:dance:${'1'.repeat(26)}>`), false, 'an id over 25 digits');
  assert.equal(whole.test('<:δέλτα:111>'), false, 'a non-ASCII name');
});

test('matchEmojiName: an exact case-sensitive match wins over a case-insensitive one', () => {
  assert.equal(matchEmojiName(EMOJIS, 'Kappa').id, '333333333333333333');
  assert.equal(matchEmojiName(EMOJIS, 'kappa').id, '444444444444444444');
});

test('matchEmojiName: a unique case-insensitive match is accepted', () => {
  assert.equal(matchEmojiName(EMOJIS, 'blush').id, '555555555555555555');
  assert.equal(matchEmojiName(EMOJIS, 'PEPE_CRY').id, '111111111111111111');
});

test('matchEmojiName: an ambiguous case-insensitive match resolves to nothing', () => {
  assert.equal(matchEmojiName(EMOJIS, 'KAPPA'), null);
});

test('matchEmojiName: an unknown name or an unavailable emoji resolves to nothing', () => {
  assert.equal(matchEmojiName(EMOJIS, 'nope'), null);
  assert.equal(matchEmojiName([{ id: '9', name: 'gone', animated: false, available: false }], 'gone'), null);
});

test('renderCustomEmoji: a known name becomes <:name:id>, an animated one <a:name:id>', () => {
  assert.equal(renderCustomEmoji('ok :pepe_cry:', lookup), 'ok <:pepe_cry:111111111111111111>');
  assert.equal(renderCustomEmoji(':dance: :dance:', lookup), '<a:dance:222222222222222222> <a:dance:222222222222222222>');
});

test('renderCustomEmoji: the emoji keeps its real name when matched case-insensitively', () => {
  assert.equal(renderCustomEmoji(':blush:', lookup), '<:Blush:555555555555555555>');
});

test('renderCustomEmoji: unknown and ambiguous names are left untouched', () => {
  assert.equal(renderCustomEmoji('so :unknown_one: and :KAPPA:', lookup), 'so :unknown_one: and :KAPPA:');
});

test('renderCustomEmoji: adjacent tokens both resolve, and an unknown one does not swallow the next', () => {
  assert.equal(renderCustomEmoji(':dance::pepe_cry:', lookup), '<a:dance:222222222222222222><:pepe_cry:111111111111111111>');
  assert.equal(renderCustomEmoji(':nope:dance:', lookup), ':nope<a:dance:222222222222222222>');
});

test('renderCustomEmoji: inline code and code blocks are not touched', () => {
  assert.equal(renderCustomEmoji('`:dance:` :dance:', lookup), '`:dance:` <a:dance:222222222222222222>');
  const block = '```\n:dance: :pepe_cry:\n```';
  assert.equal(renderCustomEmoji(block, lookup), block);
});

test('renderCustomEmoji: well-formed markup, mentions and timestamps are not touched', () => {
  const text = '<:dance:999999999999999999> <@123456789012345678> <t:1700000000:R>';
  assert.equal(renderCustomEmoji(text, lookup), text);
});

test('renderCustomEmoji: URLs, "::" and single colons are not mangled', () => {
  const dance = [{ id: '1', name: 'https', animated: false }, ...EMOJIS];
  const withHttps = (name) => matchEmojiName(dance, name);
  const text = 'see https://example.com/:dance:/x and :https://example.com :: 12:30';
  assert.equal(renderCustomEmoji(text, withHttps), text);
});

test('renderCustomEmoji: idempotent', () => {
  const once = renderCustomEmoji('a :dance: b :pepe_cry: `:dance:`', lookup);
  assert.equal(renderCustomEmoji(once, lookup), once);
});

test('resolveReactionEmoji: a unicode emoji passes through', () => {
  assert.equal(resolveReactionEmoji('💀', lookup), '💀');
  assert.equal(resolveReactionEmoji(' 🔥 ', null), '🔥');
});

test('resolveReactionEmoji: :name: resolves to reactable markup, unknown -> null', () => {
  assert.equal(resolveReactionEmoji(':pepe_cry:', lookup), '<:pepe_cry:111111111111111111>');
  assert.equal(resolveReactionEmoji(':dance:', lookup), '<a:dance:222222222222222222>');
  assert.equal(resolveReactionEmoji(':nope:', lookup), null);
});

test('resolveReactionEmoji: <:name:id> resolves through the index by name, falls back to the given id', () => {
  assert.equal(resolveReactionEmoji('<:dance:999>', lookup), '<a:dance:222222222222222222>');
  assert.equal(resolveReactionEmoji('<:other:777777777777777777>', lookup), '<:other:777777777777777777>');
});

test('resolveReactionEmoji: any custom form without a lookup is dropped', () => {
  assert.equal(resolveReactionEmoji(':dance:', null), null);
  assert.equal(resolveReactionEmoji('<a:dance:222222222222222222>', null), null);
});

function fakeClient(guildId, emojis) {
  const cache = new Map(emojis.map((e) => [e.id, { ...e }]));
  return { cache, client: { guilds: { cache: new Map([[guildId, { emojis: { cache } }]]) } } };
}

test('createEmojiIndex: reads the guild cache on demand, so later changes are seen', () => {
  const { cache, client } = fakeClient('g1', EMOJIS.slice(0, 2));
  const index = createEmojiIndex(client, 'g1');
  assert.deepEqual(index.list(), [
    { id: '111111111111111111', name: 'pepe_cry', animated: false },
    { id: '222222222222222222', name: 'dance', animated: true },
  ]);
  assert.deepEqual(index.byName('dance'), { id: '222222222222222222', name: 'dance', animated: true });
  cache.set('6', { id: '6', name: 'fresh', animated: false });
  cache.delete('222222222222222222');
  assert.equal(index.byName('dance'), null);
  assert.equal(index.byName('fresh').id, '6');
  assert.deepEqual(index.list().map((e) => e.name), ['pepe_cry', 'fresh']);
});

test('createEmojiIndex: the guild id may be a getter read at use; no guild -> empty', () => {
  const { client } = fakeClient('g1', EMOJIS);
  let current = null;
  const index = createEmojiIndex(client, () => current);
  assert.deepEqual(index.list(), []);
  assert.equal(index.byName('dance'), null);
  current = 'g1';
  assert.equal(index.list().length, EMOJIS.length);
});

test('createEmojiIndex: list leaves out unavailable emoji', () => {
  const { client } = fakeClient('g1', [...EMOJIS.slice(0, 2), { id: '9', name: 'gone', animated: false, available: false }]);
  const index = createEmojiIndex(client, 'g1');
  assert.deepEqual(index.list().map((e) => e.name), ['pepe_cry', 'dance']);
});
