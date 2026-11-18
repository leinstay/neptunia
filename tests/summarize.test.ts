// The summarizer (src/behavior/summarize.ts): a text over its limit is shortened once by the analyzer model in place
// of being cut, and any failure keeps the original text whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSummarizer } from '../src/behavior/summarize.ts';
import type { SummaryKind } from '../src/behavior/summarize.ts';

const MEDIA_PROMPT = 'Shorten the {{kind}} to {{maxChars}}.';
const TEXT_PROMPT = 'Condense this {{kind}} under {{maxChars}} characters.';
const SUMMARY_MODEL = 'test/summarizer';

type Call = { messages: Array<{ role: string; content: string }>; options: Record<string, unknown> };

/** A summarizer over a fake model that records its calls and answers `answer`, or throws when `answer` is an Error. */
function setup(
  answer: unknown,
  prompts: Record<string, unknown> = { 'summarize/media': MEDIA_PROMPT, 'summarize/text': TEXT_PROMPT }
) {
  const calls: Array<Call> = [];
  const config = { models: { byPurpose: { summarize: SUMMARY_MODEL } } };
  const hot = { config, prompts };
  const llm = {
    complete: (messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) => {
      calls.push({ messages, options });
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({ text: answer });
    },
  };
  const { summarize } = createSummarizer({ hot, llm });
  return { summarize, calls };
}

const VIDEO: SummaryKind = 'video';

test('returns a text at exactly the limit unchanged and sends no request', async () => {
  const { summarize, calls } = setup('short');
  const result = await summarize('abcdefghij', { maxChars: 10, kind: 'picture' });
  assert.equal(result, 'abcdefghij');
  assert.equal(calls.length, 0);
});

test('sends one request and returns the trimmed answer when the text is one character over', async () => {
  const { summarize, calls } = setup('  a cat on a sofa \n');
  const result = await summarize('abcdefghijk', { maxChars: 10, kind: 'picture' });
  assert.equal(result, 'a cat on a sofa');
  assert.equal(calls.length, 1);
});

test('counts the limit in code points so ten emoji fit a limit of ten', async () => {
  const { summarize, calls } = setup('short');
  const text = '😀'.repeat(10);
  const result = await summarize(text, { maxChars: 10, kind: 'text' });
  assert.equal(result, text);
  assert.equal(calls.length, 0);
});

test('fills the media prompt with the limit and the kind and sends the text as the user message for a video', async () => {
  const { summarize, calls } = setup('a dog runs');
  const text = 'a dog runs across a long beach at sunset';
  await summarize(text, { maxChars: 20, kind: VIDEO });
  const [call] = calls;
  assert.deepEqual(call.messages, [
    { role: 'system', content: 'Shorten the video to 20.' },
    { role: 'user', content: text },
  ]);
});

test('takes the system message from summarize-text for the kind text', async () => {
  const { summarize, calls } = setup('gist');
  await summarize('a long paragraph of plain words', { maxChars: 5, kind: 'text' });
  const [call] = calls;
  const [system] = call.messages;
  assert.equal(system.content, 'Condense this text under 5 characters.');
});

test('returns an answer still over the limit whole after exactly one request', async () => {
  const long = 'this answer is still far longer than the limit';
  const { summarize, calls } = setup(long);
  const result = await summarize('the original description is long too', { maxChars: 10, kind: 'GIF' });
  assert.equal(result, long);
  assert.equal(calls.length, 1);
});

test('returns the original text whole when the request throws', async () => {
  const { summarize } = setup(new Error('provider down'));
  const text = 'a red bicycle leaning on a wall';
  assert.equal(await summarize(text, { maxChars: 10, kind: 'picture' }), text);
});

test('returns the original text whole when the answer is empty', async () => {
  const { summarize } = setup('   ');
  const text = 'a red bicycle leaning on a wall';
  assert.equal(await summarize(text, { maxChars: 10, kind: 'picture' }), text);
});

test('returns the original text whole and sends no request when the prompt is missing', async () => {
  const { summarize, calls } = setup('gist', { 'summarize/text': TEXT_PROMPT });
  const text = 'a red bicycle leaning on a wall';
  const result = await summarize(text, { maxChars: 10, kind: 'picture' });
  assert.equal(result, text);
  assert.equal(calls.length, 0);
});

test('sends the request with purpose summarize on the analyzer model', async () => {
  const { summarize, calls } = setup('gist');
  await summarize('a red bicycle leaning on a wall', { maxChars: 10, kind: 'picture' });
  const [call] = calls;
  assert.equal(call.options.purpose, 'summarize');
  assert.equal(call.options.model, SUMMARY_MODEL);
});
