import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTextPreview, withTextPreviews } from '../src/media/text-preview.ts';

type Answer = { ok: boolean; headers: { get(name: string): string | null }; text(): Promise<string> };

function fakeFetch(body: string, { ok = true, headers = {} }: { ok?: boolean; headers?: Record<string, string> } = {}) {
  return (): Promise<Answer> =>
    Promise.resolve({
      ok,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      text: () => Promise.resolve(body),
    });
}

test('fetchTextPreview returns the first maxChars characters', async () => {
  const text = await fetchTextPreview('https://x/notes.txt', 5, fakeFetch('hello world'));
  assert.equal(text, 'hello');
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
  const messages = [
    { id: 'm1', attachments: [{ id: 't1', kind: 'text', name: 'a.txt', url: 'https://x/a.txt' }] },
    { id: 'm2', attachments: [{ id: 'i1', kind: 'image', name: 'b.png', url: 'https://x/b.png' }] },
  ];
  const result = await withTextPreviews(messages, 20, fakeFetch('line one\nline two'));
  assert.equal(result[0]?.attachments[0]?.previewText, 'line one\nline two'.slice(0, 20));
  assert.equal(result[1]?.attachments[0]?.previewText, undefined);
  assert.equal(messages[0]?.attachments[0]?.previewText, undefined);
});

test('withTextPreviews leaves the attachment without previewText when the fetch fails', async () => {
  const messages = [{ id: 'm1', attachments: [{ id: 't1', kind: 'text', name: 'a.txt', url: 'https://x/a.txt' }] }];
  const result = await withTextPreviews(messages, 20, () => Promise.reject(new Error('boom')));
  assert.equal(result[0]?.attachments[0]?.previewText, undefined);
});
