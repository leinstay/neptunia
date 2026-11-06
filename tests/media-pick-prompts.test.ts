// The shipped prompts against the contract of the media pick (prompts/, config/labels.json): the parser's words are in
// the pick's prompt, the persona's turn tells her of no tag the parser left behind, and `<skip/>` stays hers. A test of
// the protocol strings the code reads, never of the wording around them. Plan 2026-11-04-cli-and-memory, stages B7 and B9.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const shipped = (name: string): string => fs.readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8');
const labelsText = (): string => fs.readFileSync(new URL('../config/labels.json', import.meta.url), 'utf8');

test('prompts/gif-pick.md is gone and prompts/media-pick.md fills {{name}}', () => {
  assert.equal(fs.existsSync(new URL('../prompts/gif-pick.md', import.meta.url)), false);
  assert.match(shipped('media-pick'), /\{\{name\}\}/);
});

test('the pick prompt names its blocks and its answers', () => {
  const prompt = shipped('media-pick');
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  for (const word of ['<context>', '<reply>', '<gifs>', '`none`', '`gif`']) {
    assert.ok(prompt.includes(word), word);
  }
});

test('the pick prompt never hands the classifier the word of her turn or of a platform', () => {
  const prompt = shipped('media-pick');
  assert.ok(!prompt.includes('<skip'), '<skip/> is only hers');
  assert.doesNotMatch(prompt, /\bdiscord\b|\bserver\b/i);
});

test('the turn tells her of no <gif> tag and no GIF list', () => {
  for (const name of ['format', 'system-prompt']) {
    const prompt = shipped(name);
    assert.ok(!prompt.includes('<gif'), `${name}: <gif or <gifs`);
  }
  assert.ok(!labelsText().includes('<gifs_recent>'), 'labels.json: <gifs_recent>');
});
