// Tests for src/memory/chunks.js: the text and provenance of one vector of the meaning index, from
// a record line with its preceding lines of the same channel, or from an archive entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveChunk, chunkKey, contextFor, embeddableLine, isEmbeddableArchive, layerChannelKey, newestRevisions, recordChunk, recordChunks,
} from '../src/memory/chunks.js';

const ELENI = '411111111111111111';
const NIKOS = '422222222222222222';
const names = new Map([[ELENI, 'Ελένη'], [NIKOS, 'Nikós']]);
const nameOf = (id) => names.get(id) ?? null;
const opts = { nameOf, selfName: 'Persona' };

function seen(messageId, at, text, overrides = {}) {
  return {
    v: 1, id: `r-${messageId}`, kind: 'seen', messageId, revision: 1, occurredAt: at, scope: { channel: 'c1' },
    by: ELENI, replyTo: null, text, media: [], mentions: [], participants: [ELENI], ...overrides,
  };
}

test('embeddableLine: seen and said lines with text and a message id only', () => {
  assert.equal(embeddableLine(seen('m1', '2026-10-12T10:00:00Z', 'γεια')), true);
  assert.equal(embeddableLine(seen('m1', '2026-10-12T10:00:00Z', 'x', { kind: 'said', by: undefined })), true);
  assert.equal(embeddableLine(seen('m1', '2026-10-12T10:00:00Z', '   ')), false, 'blank text');
  assert.equal(embeddableLine({ kind: 'deleted', messageId: 'm1' }), false);
  assert.equal(embeddableLine({ kind: 'felt', text: 'x' }), false);
  assert.equal(embeddableLine(seen(null, '2026-10-12T10:00:00Z', 'x')), false);
});

test('recordChunk: the line with its context as author lines, names resolved, the persona by her name', () => {
  const a = seen('m1', '2026-10-12T10:00:00Z', 'who\nbrought   the café?', { by: NIKOS, participants: [NIKOS] });
  const b = seen('m2', '2026-10-12T10:01:00Z', 'not me', { kind: 'said', by: undefined, participants: [NIKOS] });
  const c = seen('m3', '2026-10-12T10:02:00Z', '<@422222222222222222> did', { revision: 2, participants: [ELENI, NIKOS] });
  const { text, meta } = recordChunk(c, [a, b], opts);
  assert.equal(text, 'Nikós: who brought the café?\nPersona: not me\nΕλένη: Nikós did');
  assert.deepEqual(meta, {
    kind: 'record', id: 'm3', revision: 2, occurredAt: '2026-10-12T10:02:00.000Z', channelId: 'c1', by: ELENI,
    participants: [ELENI, NIKOS], sourceIds: ['m1', 'm2', 'm3'],
  });
});

test('recordChunk: an unknown author reads as their id; each line is cut at the line limit', () => {
  const long = 'α'.repeat(400);
  const { text } = recordChunk(seen('m1', '2026-10-12T10:00:00Z', long, { by: '433333333333333333' }), [], { ...opts, lineChars: 300 });
  assert.equal(text, `433333333333333333: ${'α'.repeat(300)}`);
});

test('recordChunk: a line with links carries their titles and descriptions; a line without is unchanged', () => {
  const links = [{ url: 'https://video.example/1', title: 'Carrera épica', description: 'Δύο φίλοι τρέχουν', site: 'VideoSite' }];
  const line = seen('m1', '2026-10-12T10:00:00Z', 'https://video.example/1', { links });
  assert.equal(recordChunk(line, [], opts).text, 'Ελένη: https://video.example/1 Carrera épica Δύο φίλοι τρέχουν');
  assert.equal(recordChunk(seen('m2', '2026-10-12T10:00:00Z', 'γεια'), [], opts).text, 'Ελένη: γεια');
});

test('contextFor: the preceding lines of the channel by time, never the line itself or a later one', () => {
  const lines = [
    seen('m4', '2026-10-12T10:04:00Z', 'd'),
    seen('m1', '2026-10-12T10:01:00Z', 'a'),
    seen('m3', '2026-10-12T10:03:00Z', 'c'),
    seen('m2', '2026-10-12T10:02:00Z', 'b'),
  ];
  assert.deepEqual(contextFor(lines[2], lines, 2).map((line) => line.messageId), ['m1', 'm2']);
  assert.deepEqual(contextFor(lines[1], lines, 2).map((line) => line.messageId), []);
  assert.deepEqual(contextFor(lines[0], lines, 1).map((line) => line.messageId), ['m3']);
});

test('newestRevisions: one line per message, its newest revision; deleted and felt lines left out', () => {
  const out = newestRevisions([
    seen('m1', '2026-10-12T10:00:00Z', 'first'),
    seen('m1', '2026-10-12T10:00:00Z', 'edited', { revision: 2 }),
    { kind: 'deleted', messageId: 'm1', occurredAt: '2026-10-12T11:00:00Z' },
    seen('m2', '2026-10-12T10:01:00Z', 'b'),
  ]);
  assert.deepEqual(out.map((line) => [line.messageId, line.text]), [['m1', 'edited'], ['m2', 'b']]);
});

test('recordChunks: context stays inside one channel and one layer; targets pick the lines to chunk', () => {
  const lines = [
    seen('m1', '2026-10-12T10:00:00Z', 'a'),
    seen('m2', '2026-10-12T10:01:00Z', 'other channel', { scope: { channel: 'c2' } }),
    seen('m3', '2026-10-12T10:02:00Z', 'private', { scope: { user: ELENI, private: true, channel: 'c1' } }),
    seen('m4', '2026-10-12T10:03:00Z', 'b'),
  ];
  assert.deepEqual(recordChunks(lines, opts).map((chunk) => chunk.meta.sourceIds), [['m1'], ['m2'], ['m3'], ['m1', 'm4']]);
  const picked = recordChunks(lines, { ...opts, targets: new Set(['m4:1']) });
  assert.deepEqual(picked.map((chunk) => chunk.meta.id), ['m4']);
  assert.equal(chunkKey(picked[0].meta), 'record:m4:1');
});

test('layerChannelKey: the guild and each private layer keep apart', () => {
  assert.notEqual(layerChannelKey(null, 'c1'), layerChannelKey(ELENI, 'c1'));
  assert.equal(layerChannelKey(null, 'c1'), layerChannelKey('', 'c1'));
});

test('archiveChunk: what (or text) and the quote; provenance from the entry', () => {
  const entry = {
    kind: 'archive', event: 'backfill', itemKind: 'episode', itemId: 'ep-1', revisionId: 'rv-abc',
    scope: { user: ELENI }, participants: [NIKOS], observedAt: { date: '2026-10-01', precision: 'day' },
    sourceRefs: [{ channelId: 'c1', messageId: 'm9' }], text: { what: 'sang by the <@422222222222222222> harbour', quote: 'λα λα', feeling: 'warm' },
  };
  const { text, meta } = archiveChunk(entry, opts);
  assert.equal(text, 'sang by the Nikós harbour "λα λα"');
  assert.deepEqual(meta, {
    kind: 'archive', id: 'ep-1', revision: 'rv-abc', occurredAt: '2026-10-01T00:00:00.000Z', channelId: null, by: null,
    participants: [NIKOS, ELENI], sourceIds: ['m9'],
  });
  assert.equal(chunkKey(meta), 'archive:ep-1:rv-abc');
  const lesson = archiveChunk({ ...entry, itemKind: 'lesson', text: { text: 'say less' }, sourceRefs: [] }, opts);
  assert.equal(lesson.text, 'say less');
});

test('isEmbeddableArchive: a restored event or an entry without text is not embedded', () => {
  const base = { kind: 'archive', event: 'evicted', itemKind: 'lesson', itemId: 'ln-1', revisionId: 'rv-1', text: { text: 'x' } };
  assert.equal(isEmbeddableArchive(base), true);
  assert.equal(isEmbeddableArchive({ ...base, event: 'restored' }), false);
  assert.equal(isEmbeddableArchive({ ...base, text: {} }), false);
  assert.equal(isEmbeddableArchive({ ...base, itemKind: 'participation', text: { messages: [{ id: 'm1' }] } }), false);
});
