// src/turn/request/text.ts: `shownName`, the name of a place or of a person as a request shows it (spec
// 2026-11-12 names-across-scripts, slice 2): the emoji of the name left out and the name trimmed, a name of nothing but
// emoji as it is, a custom emoji written `:name:` as text. `placeRefText` shows every link of a place through it. The
// stored name and the match of names are never touched, so this is the one place the shown form is made. Made-up names.
//
// Signatures these tests hold the code to (proposed):
//   export function shownName(name: string, keepEmoji?: boolean): string;   keepEmoji true: the name as stored, trimmed
//   export type PlaceWords = { ...; keepEmoji?: boolean };                  the setting `context.names.emoji`, read by the
//                                                                            caller at the moment of use, for every link
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeRefText, shownName } from '../src/turn/request/text.ts';
import type { PlaceWords } from '../src/turn/request/text.ts';
import { labels } from './fixtures/labels.ts';

const NAMES = { interface: 'Discord', nouns: { server: 'server', channel: 'channel' }, dm: 'direct chat' };
const link = (kind: string | null, name: string | null) => ({ id: `p:${kind}:${name}`, kind, name });
const inRoot = (channel: string, server: string): PlaceWords => ({
  iface: 'discord',
  chain: [link('channel', channel), link('server', server)],
  names: NAMES,
});

test('a leading emoji and the space after it are left out', () => {
  // Bug: the name reaches the model as `🌿 garden`, and the emoji of a channel reads as part of its name.
  assert.equal(shownName('🌿 garden'), 'garden');
  assert.equal(shownName('🌿garden'), 'garden');
});

test('a trailing emoji and the space before it are left out', () => {
  assert.equal(shownName('garden 🌿'), 'garden');
  assert.equal(shownName('garden🌿'), 'garden');
});

test('an emoji between two words leaves both words and one space', () => {
  // Bug: cutting the emoji alone joins the words (`ab`) or leaves two spaces.
  assert.equal(shownName('dark 🌿 room'), 'dark room');
  assert.equal(shownName('dark🌿room'), 'darkroom');
  assert.equal(shownName('dark  🌿  room'), 'dark room');
});

test('an emoji of several code points goes as one', () => {
  // Bug: a flag, a skin tone, a joined sequence or a keycap is cut by code point and leaves a regional letter, a
  // modifier, a joiner or a combining mark behind.
  assert.equal(shownName('🇬🇷 athens'), 'athens');
  assert.equal(shownName('wave 👋🏽 hello'), 'wave hello');
  assert.equal(shownName('family 👨‍👩‍👧 room'), 'family room');
  assert.equal(shownName('room 1️⃣'), 'room');
  assert.equal(shownName('❤️ love'), 'love');
});

test('a name of nothing but emoji is shown as it is', () => {
  // Bug: the name comes out empty and the place reads as `""`.
  assert.equal(shownName('🌿'), '🌿');
  assert.equal(shownName('🌿🌱'), '🌿🌱');
  assert.equal(shownName(' 👨‍👩‍👧 '), '👨‍👩‍👧');
});

test('a custom emoji written as :name: stays', () => {
  assert.equal(shownName(':leaf: garden'), ':leaf: garden');
  assert.equal(shownName('🌿 :leaf: garden'), ':leaf: garden');
});

test('digits and punctuation stay', () => {
  // Bug: a digit, `#` or `*` is an emoji base of the keycap sequence, and a plain one is cut with it.
  assert.equal(shownName('room 7 #2 *'), 'room 7 #2 *');
  assert.equal(shownName('2024 (notes), a-b!'), '2024 (notes), a-b!');
});

test('a name with no emoji is returned byte for byte', () => {
  assert.equal(shownName('garden'), 'garden');
  assert.equal(shownName('Ελένη Κήπος'), 'Ελένη Κήπος');
  assert.equal(shownName('a  b'), 'a  b');
  assert.equal(shownName(''), '');
});

test('keepEmoji true shows the name as stored, trimmed', () => {
  assert.equal(shownName('🌿 garden ', true), '🌿 garden');
  assert.equal(shownName('dark 🌿 room', true), 'dark 🌿 room');
});

test('a place reference leaves out the emoji of every link, in the quotes of the name', () => {
  // Bug: only the innermost link is cleaned and the server keeps its emoji, or the name is cleaned inside the quotes.
  assert.equal(
    placeRefText(labels, 'cab12', inRoot('🌿 alpha', '🌱 Beta')),
    '#cab12: channel "alpha", server "Beta", interface "Discord"'
  );
});

test('a place reference with keepEmoji true shows the names as stored', () => {
  assert.equal(
    placeRefText(labels, 'cab12', { ...inRoot('🌿 alpha', '🌱 Beta'), keepEmoji: true }),
    '#cab12: channel "🌿 alpha", server "🌱 Beta", interface "Discord"'
  );
});

test('a place named by one emoji reads as that emoji in its reference', () => {
  assert.equal(
    placeRefText(labels, 'c1', inRoot('🌿', 'Beta')),
    '#c1: channel "🌿", server "Beta", interface "Discord"'
  );
});
