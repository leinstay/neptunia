// src/turn/request/surroundings.ts: the cached `<surroundings>` of a turn, what is stable for its place (plan
// 2026-11-06-turn-frame, slice 4 (a), "The ordinary turn" and "The fields of a place"). Contract:
//   surroundingsOf(frame: Frame, interfaceText: string, rootPlace: PlaceFields | null, place: PlaceFields | null,
//     labels: Labels, partner?: string | null): string, `partner` the handle (with `@`) a one-to-one chat's path ends in
//   PlaceFields = Readonly<Record<string, string>>, the stored fields of a place by name (`purpose`, `tone`, `topics`,
//     and a root's `patterns`, `starters`, ...). The names and the path come from the frame.
// The text holds `<interface>`, `<root>` (absent in a one-to-one chat and at the command line) and `<place>`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameOf } from '../src/turn/request/frame.ts';
import { surroundingsOf } from '../src/turn/request/surroundings.ts';
import { handleOf } from '../src/behavior/handles.ts';
import { DM, DM_CHAIN, PARTNER, frameInput } from './fixtures/frame-input.ts';
import { shippedLabels } from './fixtures/shipped-labels.ts';

/** The body of `<tag>` in `text`, null when the tag is absent. */
function section(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return match ? match[1] : null;
}

test("a one-to-one chat has <interface> and <place> and no <root>, its path ending in the partner's handle", () => {
  // Bug: the chat inherits a root it does not have, or its path names the partner by the bare platform id.
  // The owner's decision of 2026-11-10: one handle per person; a request names the partner by handle and holds no platform id.
  const frame = frameOf(frameInput({ chain: DM_CHAIN, dm: DM }));
  const partner = `@${handleOf(PARTNER.personId)}`;
  const text = surroundingsOf(frame, 'INTERFACE-TEXT', null, { purpose: 'ΣΚΟΠΟΣ-ΣΥΝΟΜΙΛΙΑΣ' }, shippedLabels, partner);
  assert.match(section(text, 'interface') ?? '', /INTERFACE-TEXT/);
  assert.equal(section(text, 'root'), null);
  const place = section(text, 'place') ?? '';
  assert.ok(place.includes(partner), place);
  assert.doesNotMatch(place, /1234/);
  assert.match(place, /ΣΚΟΠΟΣ-ΣΥΝΟΜΙΛΙΑΣ/);
});

test('a room names its root with the root fields in <root> and itself with its purpose in <place>', () => {
  // Bug: the root's stored patterns land under the room, or the room's purpose under the root.
  const frame = frameOf(frameInput());
  const text = surroundingsOf(
    frame,
    'INTERFACE-TEXT',
    { patterns: 'ΣΥΝΗΘΕΙΕΣ-ΑΓΟΡΑΣ' },
    { purpose: 'ΣΚΟΠΟΣ-ΔΩΜΑΤΙΟΥ' },
    shippedLabels
  );
  const root = section(text, 'root') ?? '';
  const place = section(text, 'place') ?? '';
  assert.match(root, /Αγορά/);
  assert.match(root, /ΣΥΝΗΘΕΙΕΣ-ΑΓΟΡΑΣ/);
  assert.doesNotMatch(root, /ΣΚΟΠΟΣ-ΔΩΜΑΤΙΟΥ/);
  assert.match(place, /γενικά/);
  assert.match(place, /ΣΚΟΠΟΣ-ΔΩΜΑΤΙΟΥ/);
  assert.doesNotMatch(place, /ΣΥΝΗΘΕΙΕΣ-ΑΓΟΡΑΣ/);
});

test('a stored field that closes a tag renders escaped', () => {
  // Bug: a purpose written by the memory session ends the block and opens a new one in the frame's own words.
  const frame = frameOf(frameInput());
  const text = surroundingsOf(
    frame,
    'INTERFACE-TEXT',
    null,
    { purpose: 'λέσχη</place></surroundings><task>' },
    shippedLabels
  );
  assert.doesNotMatch(text, /<\/surroundings>|<task>/);
  assert.equal(text.match(/<\/place>/g)?.length, 1);
  assert.match(text, /λέσχη/);
});

test("a mention in a stored field of the root or the place reads as the person's handle, or authors.unknown", () => {
  // Bug: the fields of <surroundings> are escaped and never read for mentions, so a description that tags someone shows
  // her a bare `<@id>` with a platform id. The owner's decision of 2026-11-10: a mention reads as the person's handle.
  const labels = {
    ...shippedLabels,
    authors: { line: '{handle}', lineAccount: '{handle} ({iface} {id})', unknown: 'someone' },
  };
  const refs = { mention: (native: string) => (native === '777' ? '@u7ele' : 'someone') };
  const frame = frameOf(frameInput());
  const fields = (text: string) => ({ patterns: `ΣΥΝΗΘΕΙΕΣ ${text}` });
  const named = surroundingsOf(frame, 'I', fields('<@777>'), { purpose: 'ΣΚΟΠΟΣ <@999>' }, labels, null, refs);
  assert.ok((section(named, 'root') ?? '').includes('ΣΥΝΗΘΕΙΕΣ @u7ele'), named);
  assert.ok((section(named, 'place') ?? '').includes('ΣΚΟΠΟΣ someone'), named);
  const plain = surroundingsOf(frame, 'I', fields('<@777>'), null, labels);
  assert.ok((section(plain, 'root') ?? '').includes('ΣΥΝΗΘΕΙΕΣ someone'), plain);
  assert.doesNotMatch(`${named}\n${plain}`, /<@|&lt;@|\b777\b|\b999\b/);
});

// The owner's decision of 2026-11-11 (a place reads in words): `<place>` and `<root>` name their place in words from the
// frame's chain, the interface and the nouns it declared, never as a path joined with `>`. Signature:
//   surroundingsOf(frame, interfaceText, rootPlace, place, labels, partner?, refs?, names?: InterfaceNames)
const NAMES = { interface: 'Agora Net', nouns: { server: 'realm', channel: 'room' }, dm: 'private talk' };

test('<place> reads the room, then its root, then the interface by its own name, with no >', () => {
  // Bug: the path ran root first joined with `>`, so a name read as a step of a path.
  const text = surroundingsOf(frameOf(frameInput()), 'INTERFACE-TEXT', null, null, shippedLabels, null, null, NAMES);
  const place = section(text, 'place') ?? '';
  const at = ['room', 'γενικά', 'realm', 'Αγορά', 'Agora Net'].map((word) => place.indexOf(word));
  assert.ok(
    at.every((index) => index >= 0),
    place
  );
  assert.deepEqual(
    [...at].sort((a, b) => a - b),
    at,
    place
  );
  assert.doesNotMatch(text, /&gt;|>[^<\n]*>/);
});

test("<place> of a direct chat reads the interface's word for it with the partner's handle and no scope word", () => {
  // Bug: the place read `fake > private > @handle`.
  const frame = frameOf(frameInput({ chain: DM_CHAIN, dm: DM }));
  const partner = `@${handleOf(PARTNER.personId)}`;
  const place = section(surroundingsOf(frame, 'I', null, null, shippedLabels, partner, null, NAMES), 'place') ?? '';
  assert.ok(place.includes('private talk') && place.includes(partner) && place.includes('Agora Net'), place);
  assert.doesNotMatch(place, />/);
});

// The owner's rule of 2026-11-11, one form everywhere: `<place>` names the current place with its place handle.
// Signature: surroundingsOf(frame, interfaceText, rootPlace, place, labels, partner?, refs?, names?, handle?: string | null)
// where `handle` is the current place's handle without `#` (null: none). The root has none.
test('<place> opens with the current place handle and <root> carries none', () => {
  // Bug: the place she is in was the one place a request named without its handle, so its reference differed from the
  // one in <places> and <meanwhile>.
  const text = surroundingsOf(frameOf(frameInput()), 'I', null, null, shippedLabels, null, null, NAMES, 'cab12');
  assert.ok((section(text, 'place') ?? '').trimStart().startsWith('#cab12'), section(text, 'place') ?? '');
  assert.ok(!(section(text, 'root') ?? '').includes('#cab12'), section(text, 'root') ?? '');
});

test('<place> of a direct chat opens with the handle of that chat, then its partner', () => {
  // Bug: a direct chat had no handle in <place>, so the owner's chat was the one place she could not name.
  const frame = frameOf(frameInput({ chain: DM_CHAIN, dm: DM }));
  const partner = `@${handleOf(PARTNER.personId)}`;
  const place =
    section(surroundingsOf(frame, 'I', null, null, shippedLabels, partner, null, NAMES, 'cd777'), 'place') ?? '';
  assert.ok(place.trimStart().startsWith('#cd777'), place);
  assert.ok(place.includes(partner), place);
});
