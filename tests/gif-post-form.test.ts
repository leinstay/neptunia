// How a library GIF goes out (src/media/gif-post.ts#gifPostForm): every media she sends is a file by default, and an
// interface may post the native link when it declares that form. Plan 2026-11-04-cli-and-memory, stage B7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gifPostForm } from '../src/media/gif-post.ts';

const LINKED = { kind: 'link', file: 'media/gifs/h1.gif' } as const;
const ATTACHED = { kind: 'attachment', file: 'media/gifs/h2.gif' } as const;

test('an interface that posts files gets the cached file', () => {
  assert.equal(gifPostForm(LINKED, ['file']), 'file');
  assert.equal(gifPostForm(ATTACHED, ['file']), 'file');
});

test('an interface that declares links gets the native link of a link GIF', () => {
  assert.equal(gifPostForm(LINKED, ['file', 'link']), 'link');
});

test('an attached GIF goes as its file when the file is cached, since its link expires', () => {
  assert.equal(gifPostForm(ATTACHED, ['file', 'link']), 'file');
});

test('an attached GIF with no file yet goes through its link on an interface that declares links', () => {
  assert.equal(gifPostForm({ kind: 'attachment' }, ['file', 'link']), 'link');
});

test('a GIF the interface has no form for cannot be posted', () => {
  assert.equal(gifPostForm({ kind: 'link' }, ['file']), null);
  assert.equal(gifPostForm(LINKED, []), null);
});
