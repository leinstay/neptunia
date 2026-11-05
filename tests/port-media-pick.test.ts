// What an interface declares for the media pick, read without trusting its shape
// (src/interface/capabilities.ts#portMediaPick). The emoji half belongs to stage B8 and is here because one
// declaration carries both. Plan 2026-11-04-cli-and-memory, stages B7 and B8.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portMediaPick } from '../src/interface/capabilities.ts';

const port = (mediaPick: unknown) => ({ capabilities: () => ({ mediaPick }) });

test('a port that declares nothing has no media pick', () => {
  assert.equal(portMediaPick(null), null);
  assert.equal(portMediaPick({}), null);
  assert.equal(portMediaPick({ capabilities: () => ({}) }), null);
});

test('a declaration with no form to use is no media pick', () => {
  assert.equal(portMediaPick(port(true)), null);
  assert.equal(portMediaPick(port({ gifForms: [] })), null);
  assert.equal(portMediaPick(port({ gifForms: ['papyrus'] })), null);
});

test('GIF forms are read and an unknown one is dropped', () => {
  assert.deepEqual(portMediaPick(port({ gifForms: ['file', 'papyrus'] }))?.gifForms, ['file']);
});

test('an emoji declaration needs actions and a rendering, or the interface has no emoji form', () => {
  const render = { still: '[[{name}|{id}]]' };
  const full = portMediaPick(port({ gifForms: [], emoji: { actions: ['append', 'replace', 'dance'], render } }));
  assert.deepEqual(full?.emoji?.actions, ['append', 'replace']);
  assert.equal(portMediaPick(port({ gifForms: [], emoji: { actions: [], render } })), null);
  assert.equal(portMediaPick(port({ gifForms: ['file'], emoji: { actions: ['append'] } }))?.emoji, undefined);
});

test("the capability text is the interface's string, and anything else is no text", () => {
  assert.equal(portMediaPick(port({ gifForms: ['file'], text: 'μικρά αυτοκόλλητα' }))?.text, 'μικρά αυτοκόλλητα');
  assert.equal(portMediaPick(port({ gifForms: ['file'], text: 7 }))?.text, undefined);
});
