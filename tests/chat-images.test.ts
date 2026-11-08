// bin/chat-images.ts: what the owner's chat makes of the core's answer about the files of a numbered line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { lineFilesOf } from '../bin/chat-images.ts';

const answerOf = (files: Array<{ name: string; kind: string; path: string | null; description: string | null }>) => ({
  text: JSON.stringify({ number: 7, files }),
  status: 'ok',
});

test('a kept path of a line becomes its path in the data folder, and a path outside the kept folder none', () => {
  // Bug: the opener gets a path relative to wherever the chat started, or a stored path that climbs out of `media/cli/`.
  const read = lineFilesOf(
    '/srv/data',
    answerOf([
      { name: 'clip.mp4', kind: 'video', path: 'media/cli/v1.mp4', description: 'A cat' },
      { name: 'odd', kind: 'file', path: '../etc/passwd', description: null },
      { name: 'lost.pdf', kind: 'file', path: null, description: null },
    ]),
    7
  );
  assert.equal(read.ok, true);
  assert.deepEqual(read.ok ? read.files.map((file) => file.path) : [], [
    path.join('/srv/data', 'media', 'cli', 'v1.mp4'),
    null,
    null,
  ]);
  const first = read.ok ? read.files[0] : undefined;
  assert.equal(first?.description, 'A cat');
});

test('an unknown line reads as a refusal that names its number', () => {
  // Bug: an unknown number reads as a line without files, or as a failure of the link.
  const read = lineFilesOf(
    '/srv/data',
    { text: 'refused: unknown-line', status: 'invalid', code: 'unknown-line' },
    9999
  );
  assert.deepEqual(read, { ok: false, reason: 'No line #9999 in this chat.' });
});
