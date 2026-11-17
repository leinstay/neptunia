import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTextPreview, withTextPreviews } from '../src/media/text-preview.ts';

type Attached = {
  id: string;
  attachments: Array<{
    id: string;
    kind: string;
    name: string;
    url: string;
    previewText?: string;
    previewRetold?: boolean;
  }>;
};
type Answer = { ok: boolean; headers: { get(name: string): string | null }; text(): Promise<string> };

function fakeFetch(body: string, { ok = true, headers = {} }: { ok?: boolean; headers?: Record<string, string> } = {}) {
  return (): Promise<Answer> =>
    Promise.resolve({
      ok,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      text: () => Promise.resolve(body),
    });
}

// The owner on 2026-11-17: a text over its bound is summarized or kept whole, never cut.
test('fetchTextPreview keeps a text over maxChars whole when no summarizer is given', async () => {
  // Catches: a file cut silently at maxChars.
  const text = await fetchTextPreview('https://x/notes.txt', 5, fakeFetch('hello world'));
  assert.equal(text, 'hello world');
});

/** A fake summarizer: its calls in order, and `answer` for a text over the bound; a text within it comes back as it is. */
function fakeSummarize(answer: string) {
  const calls: Array<{ text: string; options: { maxChars: number; kind: 'text' } }> = [];
  const summarize = (text: string, options: { maxChars: number; kind: 'text' }): Promise<string> => {
    calls.push({ text, options });
    return Promise.resolve(Array.from(text).length > options.maxChars ? answer : text);
  };
  return { calls, summarize };
}

const NOTES: Array<Attached> = [
  { id: 'm1', attachments: [{ id: 't1', kind: 'text', name: 'a.txt', url: 'https://x/a.txt' }] },
];

// The owner on 2026-11-17: a text over its bound is summarized or kept whole, never cut.
test('withTextPreviews: a file over maxChars goes to summarize once, its summary is the preview, marked previewRetold', async () => {
  // Catches: a long file cut at maxChars, or retold without the mark the transcript tells her by.
  const body = 'line one\nline two\nline three';
  const { calls, summarize } = fakeSummarize('three lines');
  const [message] = await withTextPreviews(NOTES, 10, fakeFetch(body), { summarize });
  const [attachment] = message?.attachments ?? [];
  assert.deepEqual(calls, [{ text: body, options: { maxChars: 10, kind: 'text' } }]);
  assert.equal(attachment?.previewText, 'three lines');
  assert.equal(attachment?.previewRetold, true);
});

// The owner on 2026-11-17: a text over its bound is summarized or kept whole, never cut.
test('withTextPreviews: a file within maxChars is the preview as it is, with no previewRetold', async () => {
  // Catches: a short file rewritten, or marked as a retelling.
  const { summarize } = fakeSummarize('never shown');
  const [message] = await withTextPreviews(NOTES, 100, fakeFetch('line one'), { summarize });
  const [attachment] = message?.attachments ?? [];
  assert.equal(attachment?.previewText, 'line one');
  assert.equal(attachment?.previewRetold, undefined);
});

// The owner on 2026-11-17: a text over its bound is summarized or kept whole, never cut.
test('withTextPreviews: a summary still over maxChars is the preview whole', async () => {
  // Catches: the summary cut at the bound.
  const { summarize } = fakeSummarize('a summary longer than ten');
  const [message] = await withTextPreviews(NOTES, 10, fakeFetch('line one\nline two\nline three'), { summarize });
  const [attachment] = message?.attachments ?? [];
  assert.equal(attachment?.previewText, 'a summary longer than ten');
});

test('fetchTextPreview never fetches fully a declared content-length over the 256 KB guard', async () => {
  const text = await fetchTextPreview(
    'https://x/big.txt',
    100,
    fakeFetch('x'.repeat(10), { headers: { 'content-length': String(300 * 1024) } })
  );
  assert.equal(text, null);
});

test('fetchTextPreview returns null for a non-ok response', async () => {
  const text = await fetchTextPreview('https://x/missing.txt', 100, fakeFetch('', { ok: false }));
  assert.equal(text, null);
});

test('fetchTextPreview falls back to null instead of throwing when the fetch fails', async () => {
  const text = await fetchTextPreview('https://x', 100, () => Promise.reject(new Error('network down')));
  assert.equal(text, null);
});

test('withTextPreviews fills previewText on text attachments only and leaves the input untouched', async () => {
  const messages: Array<Attached> = [
    { id: 'm1', attachments: [{ id: 't1', kind: 'text', name: 'a.txt', url: 'https://x/a.txt' }] },
    { id: 'm2', attachments: [{ id: 'i1', kind: 'image', name: 'b.png', url: 'https://x/b.png' }] },
  ];
  const result = await withTextPreviews(messages, 20, fakeFetch('line one\nline two'));
  assert.equal(result[0]?.attachments[0]?.previewText, 'line one\nline two');
  assert.equal(result[1]?.attachments[0]?.previewText, undefined);
  assert.equal(messages[0]?.attachments[0]?.previewText, undefined);
});

test('withTextPreviews leaves the attachment without previewText when the fetch fails', async () => {
  const messages: Array<Attached> = [
    { id: 'm1', attachments: [{ id: 't1', kind: 'text', name: 'a.txt', url: 'https://x/a.txt' }] },
  ];
  const result = await withTextPreviews(messages, 20, () => Promise.reject(new Error('boom')));
  assert.equal(result[0]?.attachments[0]?.previewText, undefined);
});
