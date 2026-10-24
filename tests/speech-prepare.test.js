// Tests for src/speech/prepare.js: the pure word check and the preparation pass over a fake
// llm.complete. Non-ASCII test data is Greek or accented Latin, written as escapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareSpeech, sameWords } from '../src/speech/prepare.js';

const ACUTE = '́';

test('sameWords: added stress marks and restored diacritics are the same words', () => {
  assert.equal(sameWords('Hello Zoe', `Hello Zo${'ë'}`), true);
  assert.equal(sameWords('αγαπη', `αγάπη`), true);
  assert.equal(sameWords('cafe au lait', `cafe${ACUTE} au lait`), true);
});

test('sameWords: a changed, added, removed or reordered word is not', () => {
  assert.equal(sameWords('one two three', 'one two four'), false);
  assert.equal(sameWords('one two three', 'one two'), false);
  assert.equal(sameWords('one two', 'one two three'), false);
  assert.equal(sameWords('one two', 'two one'), false);
});

test('sameWords: a punctuation mark outside the brackets counts', () => {
  assert.equal(sameWords('well, yes', 'well yes'), false);
  assert.equal(sameWords('well yes.', 'well yes'), false);
});

test('sameWords: every bracketed direction is one token whatever it says', () => {
  assert.equal(sameWords('[αναστεναγμός] hello', '[sighs] hello'), true);
  assert.equal(sameWords('hello [a long direction here] there', 'hello [pause] there'), true);
  assert.equal(sameWords('hello [pause] there', 'hello there'), false);
  assert.equal(sameWords('hello [pause] there', 'hello [pause] [sighs] there'), false);
});

test('sameWords: whitespace is collapsed and trimmed', () => {
  assert.equal(sameWords('a  b\n c', ' a b c '), true);
});

const answering = (text) => async () => ({ text });

test('prepareSpeech: an answer that only adds marks and tags is used', async () => {
  const out = await prepareSpeech({ text: '[quietly] cafe', complete: answering(`[whispers] cafe${ACUTE}\n`), prompt: 'p' });
  assert.deepEqual(out, { text: `[whispers] cafe${ACUTE}`, prepared: true });
});

test('prepareSpeech: an answer that changes a word falls back to the original', async () => {
  const out = await prepareSpeech({ text: 'one two', complete: answering('one three'), prompt: 'p' });
  assert.deepEqual(out, { text: 'one two', prepared: false, reason: 'mismatch' });
});

test('prepareSpeech: an empty answer, an error and a timeout fall back with their reasons', async () => {
  assert.equal((await prepareSpeech({ text: 'x', complete: answering('  '), prompt: 'p' })).reason, 'empty');
  const boom = async () => { throw new Error('boom'); };
  assert.deepEqual(await prepareSpeech({ text: 'x', complete: boom, prompt: 'p' }), { text: 'x', prepared: false, reason: 'error' });
  const slow = async () => { throw Object.assign(new Error('late'), { name: 'TimeoutError' }); };
  assert.equal((await prepareSpeech({ text: 'x', complete: slow, prompt: 'p' })).reason, 'timeout');
});

test('prepareSpeech: no prompt means no pass; the request is the analyzer at temperature 0', async () => {
  assert.equal((await prepareSpeech({ text: 'x', complete: answering('x'), prompt: '' })).reason, 'no-prompt');
  let seen;
  await prepareSpeech({ text: 'x', complete: async (messages, options) => { seen = { messages, options }; return { text: 'x' }; }, prompt: 'SYS', maxOutputTokens: 77, timeoutMs: 5 });
  assert.deepEqual(seen.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'x' }]);
  assert.equal(seen.options.role, 'analyzer');
  assert.equal(seen.options.temperature, 0);
  assert.equal(seen.options.maxOutputTokens, 77);
  assert.equal(seen.options.timeoutMs, 5);
});
