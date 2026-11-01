import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gifWatchBlocker, gifWatchPrompt } from '../src/memory/gif-watch.js';

const VIDEO = { 'describe-video': 'video {{maxChars}}' };
const GIF = { 'describe-gif': 'gif {{maxChars}} {{seconds}}' };

// PR 7d: the describer, video vision and the watch switch are code, so the watch prompt is the one blocker left.
test('gifWatchBlocker: null when a watch prompt is there', () => {
  assert.equal(gifWatchBlocker(VIDEO), null);
  assert.equal(gifWatchBlocker(GIF), null, 'describe-gif alone is enough');
});

test('gifWatchBlocker: no-prompt without a watch prompt', () => {
  assert.equal(gifWatchBlocker({}), 'no-prompt');
  assert.equal(gifWatchBlocker({ 'describe-video': '', 'describe-gif': '' }), 'no-prompt');
  assert.equal(gifWatchBlocker(undefined), 'no-prompt');
});

test('gifWatchPrompt: describe-gif when present, else describe-video', () => {
  assert.deepEqual(gifWatchPrompt({ ...VIDEO, ...GIF }), { name: 'describe-gif', text: GIF['describe-gif'] });
  assert.deepEqual(gifWatchPrompt(VIDEO), { name: 'describe-video', text: VIDEO['describe-video'] });
  assert.deepEqual(gifWatchPrompt({ ...VIDEO, 'describe-gif': '' }), {
    name: 'describe-video',
    text: VIDEO['describe-video'],
  });
  assert.equal(gifWatchPrompt({}), null);
});
