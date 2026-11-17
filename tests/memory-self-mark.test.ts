// Tests for src/memory/self-mark.ts: the marker a stored media description names the persona by, and its
// substitution with her name in the place where a model reads the description. Fixed strings, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SELF_MARK, fillSelfMark } from '../src/memory/self-mark.ts';

test('fillSelfMark: every marker in a description becomes the name', () => {
  // Bug: only the first marker is replaced, and a second mention reaches the model as the raw marker.
  const text = `${SELF_MARK} waves at the camera, and behind ${SELF_MARK} a cat sleeps.`;
  assert.equal(fillSelfMark(text, 'Mira'), 'Mira waves at the camera, and behind Mira a cat sleeps.');
});

test('fillSelfMark: a marker followed by punctuation is replaced', () => {
  // Bug: a token match that demands a trailing space leaves `@self,` in the text.
  assert.equal(
    fillSelfMark(`By the window, ${SELF_MARK}, in a green scarf.`, 'Mira'),
    'By the window, Mira, in a green scarf.'
  );
});

test('fillSelfMark: a description without the marker is returned unchanged', () => {
  const text = 'A street at night, a man in a red coat.';
  assert.equal(fillSelfMark(text, 'Mira'), text);
});

test('fillSelfMark: a word that only contains the marker is left as written', () => {
  // Bug: a plain substring replace turns an address or a longer handle into her name.
  const text = 'A sign reads x@selfish.example and @selfie_club.';
  assert.equal(fillSelfMark(text, 'Mira'), text);
});
