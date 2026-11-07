// src/turn/request/refs.ts: a line's identity in a stored text (`src:<iface>:<message id>:<revision>`, written by
// src/turn/handles.ts) rendered when the text comes back into a request, and turned into the interface's form when her
// posted words go out (plan 2026-11-06-turn-frame, "References that survive the turn", items 3, slice 4 (a)). Contract:
//   RefLine = { placeId; messageId; path: Array<string>; at: number; text; revision: number; deleted: boolean }
//   refResolverOf({ window: Map<string, number>, lineOf: (key: string) => RefLine | null, labels: Labels,
//     timezone: string }): (text: string) => string
//   outgoingRefs(text, { placeId, lineOf, linkOf: (line: RefLine) => string | null, labels, timezone }):
//     { text: string; replyTo: string | null }
// `key` is the identity without its revision, `src:<iface>:<message id>`. `window` maps the key of each line of
// `<chat>` to its `#n`. `lineOf` reads the stored line under the frame's scope, null when unknown or not readable.
// A line in the window renders as its handle, one elsewhere as a quote under its path and time, a deleted one as
// unavailable, an edited one as its current text with a note. On the way out a line of another place becomes the
// interface's link, one of this place the reply target, and with no link form the quote with path and time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outgoingRefs, refResolverOf } from '../src/turn/request/refs.ts';
import type { RefLine } from '../src/turn/request/refs.ts';
import { shippedLabels } from './fixtures/shipped-labels.ts';

const AT = Date.parse('2026-11-05T09:41:00.000Z');

const CLUB_LINE: RefLine = {
  placeId: 'place:club',
  messageId: 'm77',
  path: ['fake', 'Αγορά', 'λέσχη'],
  at: AT,
  text: 'ΚΕΙΜΕΝΟ-ΓΡΑΜΜΗΣ',
  revision: 1,
  deleted: false,
};

const resolverOver = (lines: Record<string, RefLine>, window = new Map<string, number>()) =>
  refResolverOf({ window, lineOf: (key) => lines[key] ?? null, labels: shippedLabels, timezone: 'UTC' });

test("an identity of a line in the window renders as that line's current handle", () => {
  // Bug: the stored identity reaches the model raw, or as a quote of a line she can see a few rows below.
  const resolve = resolverOver({ 'src:fake:m77': CLUB_LINE }, new Map([['src:fake:m77', 12]]));
  const text = resolve('όπως στο src:fake:m77:1 είπαν');
  assert.match(text, /#12(?!\d)/);
  assert.doesNotMatch(text, /src:fake/);
});

test('an identity of a line elsewhere renders as a quote under its path and time', () => {
  // Bug: a line of another place is lost, or quoted with no place and no time to read it by.
  const text = resolverOver({ 'src:fake:m77': CLUB_LINE })('όπως στο src:fake:m77:1 είπαν');
  assert.ok(text.includes('ΚΕΙΜΕΝΟ-ΓΡΑΜΜΗΣ'));
  assert.ok(text.includes('λέσχη'));
  assert.ok(text.includes('09:41'));
  assert.doesNotMatch(text, /src:fake/);
});

test('an identity of a deleted line renders as unavailable, without its old text', () => {
  // Bug: a message its author deleted keeps being quoted.
  const text = resolverOver({ 'src:fake:m77': { ...CLUB_LINE, deleted: true } })('όπως στο src:fake:m77:1 είπαν');
  assert.ok(!text.includes('ΚΕΙΜΕΝΟ-ΓΡΑΜΜΗΣ'));
  assert.doesNotMatch(text, /src:fake/);
  assert.ok(text.includes('όπως στο'));
});

test('an identity of an edited line renders the current text with a note that it changed', () => {
  // Bug: an edit goes unnoticed and she reads the new words as the ones she referred to.
  const edited = resolverOver({ 'src:fake:m77': { ...CLUB_LINE, revision: 2 } })('δες src:fake:m77:1');
  const same = resolverOver({ 'src:fake:m77': CLUB_LINE })('δες src:fake:m77:1');
  assert.ok(edited.includes('ΚΕΙΜΕΝΟ-ΓΡΑΜΜΗΣ'));
  assert.notEqual(edited, same);
});

test('an identity of a line the scope cannot read renders without its text', () => {
  // Bug: a reference stored in a private chat opens the line in a group.
  const text = resolverOver({})('δες src:fake:m77:1');
  assert.doesNotMatch(text, /src:fake/);
  assert.ok(text.includes('δες'));
});

const OUT = {
  lineOf: (key: string) => (key === 'src:fake:m77' ? CLUB_LINE : null),
  labels: shippedLabels,
  timezone: 'UTC',
};

test('a posted identity of another place goes out as the interface link for it', () => {
  // Bug: the platform shows the raw identity, or the link of the wrong line.
  const out = outgoingRefs('δες src:fake:m77:1', {
    ...OUT,
    placeId: 'place:room',
    linkOf: (one) => `https://fake.example/${one.placeId}/${one.messageId}`,
  });
  assert.ok(out.text.includes('https://fake.example/place:club/m77'));
  assert.doesNotMatch(out.text, /src:fake/);
  assert.equal(out.replyTo, null);
});

test('a posted identity of this place goes out as a reply to that line', () => {
  // Bug: a line a few messages up gets a link to itself instead of the platform's reply.
  const out = outgoingRefs('δες src:fake:m77:1', {
    ...OUT,
    placeId: 'place:club',
    linkOf: (one) => `https://fake.example/${one.placeId}/${one.messageId}`,
  });
  assert.equal(out.replyTo, 'm77');
  assert.doesNotMatch(out.text, /src:fake/);
});

test('with no link form, as at the command line, a posted identity goes out as the quote with path and time', () => {
  // Bug: the owner reads an identity he cannot open.
  const out = outgoingRefs('δες src:fake:m77:1', { ...OUT, placeId: 'cli:dm:owner', linkOf: () => null });
  assert.ok(out.text.includes('ΚΕΙΜΕΝΟ-ΓΡΑΜΜΗΣ'));
  assert.ok(out.text.includes('λέσχη'));
  assert.ok(out.text.includes('09:41'));
  assert.doesNotMatch(out.text, /src:fake/);
});
