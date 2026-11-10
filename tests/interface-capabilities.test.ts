// Tests for src/interface/capabilities.ts: what the core reads of a port's name and declared capabilities, with a
// default for a port that declares nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portLimit, portMessageUrl, portMediaPick } from '../src/interface/capabilities.ts';

const TEMPLATE = {
  root: 'https://chat.example/{root}/{chat}/{message}',
  direct: 'https://chat.example/me/{chat}/{message}',
};

test('reads the limit a port declares in its capabilities', () => {
  const port = { iface: 'fake', capabilities: () => ({ maxFiles: 2, maxChars: 250 }) };
  assert.equal(portLimit(port, 'maxFiles', 10), 2);
  assert.equal(portLimit(port, 'maxChars', 2000), 250);
});

test('answers the fallback for a limit the port does not declare, declares as zero or declares as no number', () => {
  const port = { capabilities: () => ({ maxFiles: 0, maxChars: '250' }) };
  assert.equal(portLimit(port, 'maxFiles', 10), 10);
  assert.equal(portLimit(port, 'maxChars', 2000), 2000);
  assert.equal(portLimit(port, 'maxFileBytes', 7), 7);
});

test('answers the fallback for a port with no capabilities or none at all', () => {
  assert.equal(portLimit({ iface: 'cli' }, 'maxFiles', 10), 10);
  assert.equal(portLimit(null, 'maxFiles', 10), 10);
  assert.equal(portLimit({ capabilities: () => null }, 'maxFiles', 10), 10);
});

test('reads the message address form of a port and answers null for a port that declares none or half of one', () => {
  assert.deepEqual(portMessageUrl({ capabilities: () => ({ messageUrl: TEMPLATE }) }), TEMPLATE);
  assert.equal(portMessageUrl({ capabilities: () => ({}) }), null);
  assert.equal(portMessageUrl({ capabilities: () => ({ messageUrl: { root: 'x' } }) }), null);
  assert.equal(portMessageUrl({ capabilities: () => ({ messageUrl: null }) }), null);
});

// What an interface declares for the media pick, read without trusting its shape
// (src/interface/capabilities.ts#portMediaPick). The emoji half belongs to stage B8 and is here because one
// declaration carries both. Plan 2026-11-04-cli-and-memory, stages B7 and B8.

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
