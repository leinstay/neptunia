// A GIF of the library seen in a transcript carries its handle
// (src/memory/gifs.js#gifHandleMap/gifHandleOf, src/media/classify.js#mediaLabelFor,
// src/format.js#formatTranscript).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gifHandleMap, gifHandleOf, matchGifKey, mergeGifs } from '../src/memory/gifs.js';
import { mediaLabelFor } from '../src/media/classify.js';
import { formatTranscript } from '../src/format.js';
import { labels } from './fixtures/labels.js';

const T0 = Date.UTC(2026, 8, 1);
const TENOR = 'https://tenor.com/view/cat-dance-123';

function msg(id, overrides = {}) {
  return {
    id,
    ts: T0,
    channelId: 'c1',
    authorId: 'a',
    authorName: 'Zoé',
    self: false,
    content: '',
    attachments: [],
    links: [],
    ...overrides,
  };
}

function libraryOf(messages) {
  return mergeGifs(undefined, messages).gifs;
}

const LINK_MSG = msg('m1', {
  links: [{ id: 'm1#e0', kind: 'gif', url: TENOR, site: 'Tenor', title: 'Chat qui danse' }],
});
const FILE_MSG = msg('m2', {
  attachments: [
    { id: 'att9', kind: 'gif', url: 'https://cdn.discordapp.com/a/att9/réaction.gif', name: 'réaction.gif' },
  ],
});

test('matchGifKey: own key first, then a link by url, never an attachment by url', () => {
  const has = (key) => key === 'k1';
  const byUrl = (url) => (url === TENOR ? 'k1' : null);
  assert.equal(matchGifKey({ key: 'k1', kind: 'attachment', url: 'x' }, has, byUrl), 'k1');
  assert.equal(matchGifKey({ key: 'k2', kind: 'link', url: TENOR }, has, byUrl), 'k1');
  assert.equal(matchGifKey({ key: 'k2', kind: 'attachment', url: TENOR }, has, byUrl), null);
  assert.equal(matchGifKey({ key: 'k2', kind: 'link', url: 'https://tenor.com/other' }, has, byUrl), null);
});

test('gifHandleMap / gifHandleOf: keys and link urls lead to the handle', () => {
  const handles = gifHandleMap(libraryOf([LINK_MSG, FILE_MSG]));
  assert.equal(gifHandleOf(handles, { id: 'm1#e0', url: TENOR }, 'link'), 'g1');
  assert.equal(gifHandleOf(handles, { id: 'm7#e0', url: TENOR }, 'link'), 'g1', 'a repost counts on the first entry');
  assert.equal(gifHandleOf(handles, { id: 'att9', url: 'https://cdn.discordapp.com/fresh' }, 'attachment'), 'g2');
  assert.equal(gifHandleOf(handles, { id: 'other', url: TENOR }, 'attachment'), null);
  assert.equal(gifHandleOf(handles, { id: TENOR }, 'attachment'), null, 'a url is never taken for a key');
  assert.equal(gifHandleOf(new Map(), { id: 'm1#e0', url: TENOR }, 'link'), null);
  assert.equal(gifHandleOf(undefined, { id: 'm1#e0', url: TENOR }, 'link'), null);
});

test('mediaLabelFor: a gif with a handle -> gifKnown with a caption, gifKnownNoText without', () => {
  const gif = { kind: 'gif', name: 'réaction.gif' };
  assert.deepEqual(mediaLabelFor(gif, { gifHandle: 'g4', description: 'a wave' }), {
    key: 'gifKnown',
    values: { id: 'g4', text: 'a wave' },
  });
  assert.deepEqual(mediaLabelFor(gif, { gifHandle: 'g4' }), {
    key: 'gifKnownNoText',
    values: { id: 'g4', name: 'réaction.gif' },
  });
  assert.deepEqual(mediaLabelFor(gif, { description: 'a wave' }), { key: 'gifDescribed', values: { text: 'a wave' } });
  assert.deepEqual(
    mediaLabelFor({ kind: 'image' }, { gifHandle: 'g4' }),
    { key: 'image', values: {} },
    'other kinds ignore it'
  );
});

function render(messages, extra = {}, labelSet = labels) {
  return formatTranscript(messages, {
    timezone: 'UTC',
    gapMinutes: 20,
    maxChars: 800,
    selfName: 'Nept',
    labels: labelSet,
    ...extra,
  })
    .map((item) => item.text)
    .join('\n');
}

test('formatTranscript: library gifs (embed and attachment) render with their handle, captioned or named', () => {
  const gifHandles = gifHandleMap(libraryOf([LINK_MSG, FILE_MSG]));
  const descriptions = new Map([['m1#e0', 'a cat dancing']]);
  const text = render([LINK_MSG, FILE_MSG], { gifHandles, descriptions });
  assert.ok(text.includes('[gif g1: a cat dancing]'));
  assert.ok(text.includes('[gif g2: réaction.gif]'));
});

test("formatTranscript: a gif the library does not know keeps today's form", () => {
  const gifHandles = gifHandleMap(libraryOf([LINK_MSG]));
  const text = render([FILE_MSG], { gifHandles });
  assert.ok(text.includes('[gif: réaction.gif]'));
});

test('formatTranscript: a forwarded library gif carries its handle too', () => {
  const gifHandles = gifHandleMap(libraryOf([FILE_MSG]));
  const outer = msg('m3', { forwarded: [{ content: '', attachments: FILE_MSG.attachments, links: [] }] });
  assert.ok(render([outer], { gifHandles }).includes('[gif g1: réaction.gif]'));
});

test('formatTranscript: an older labels.json without the gifKnown keys falls back to gifDescribed / gif', () => {
  const gifHandles = gifHandleMap(libraryOf([LINK_MSG, FILE_MSG]));
  const descriptions = new Map([['m1#e0', 'a cat dancing']]);
  const { gifKnown, gifKnownNoText, ...transcript } = labels.transcript;
  const text = render([LINK_MSG, FILE_MSG], { gifHandles, descriptions }, { ...labels, transcript });
  assert.ok(text.includes('[gif: a cat dancing]'));
  assert.ok(text.includes('[gif: réaction.gif]'));
  assert.ok(!text.includes('g1') && !text.includes('g2'));
});
