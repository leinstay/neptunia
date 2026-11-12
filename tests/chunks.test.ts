// Tests for src/memory/chunks.ts: the text and provenance of one vector of the meaning index, from
// a record line with its preceding lines of the same channel, or from an archive entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextFor, embeddableLine, newestRevisions, recordChunk } from '../src/memory/chunks.ts';
import type { Untyped } from '../src/tools/types.ts';
import type { RecordLine } from '../src/memory/record.ts';

const ELENI = '411111111111111111';
const NIKOS = '422222222222222222';
const names = new Map([
  [ELENI, 'Ελένη'],
  [NIKOS, 'Nikós'],
]);
const nameOf = (id: string) => names.get(id) ?? null;
const opts = { nameOf, selfName: 'Persona' };

function seen(messageId: string, at: string, text: string, overrides: Record<string, Untyped> = {}): RecordLine {
  return {
    v: 1,
    id: `r-${messageId}`,
    kind: 'seen',
    messageId,
    revision: 1,
    occurredAt: at,
    scope: { channel: 'c1' },
    by: ELENI,
    replyTo: null,
    text,
    media: [],
    mentions: [],
    participants: [ELENI],
    ...overrides,
  };
}

test('embeddableLine: seen and said lines with text and a message id only', () => {
  assert.equal(embeddableLine(seen('m1', '2026-10-12T10:00:00Z', 'γεια')), true);
  assert.equal(embeddableLine(seen('m1', '2026-10-12T10:00:00Z', 'x', { kind: 'said', by: undefined })), true);
  assert.equal(embeddableLine(seen('m1', '2026-10-12T10:00:00Z', '   ')), false, 'blank text');
  // @ts-expect-error: the test passes a line the type refuses (a missing field), to check that it is skipped
  assert.equal(embeddableLine({ kind: 'deleted', messageId: 'm1' }), false);
  // @ts-expect-error: the test passes a line the type refuses (a missing field), to check that it is skipped
  assert.equal(embeddableLine({ kind: 'felt', text: 'x' }), false);
  // @ts-expect-error: the test passes a line the type refuses (a missing field), to check that it is skipped
  assert.equal(embeddableLine(seen(null, '2026-10-12T10:00:00Z', 'x')), false);
});

test('recordChunk: the line with its context as author lines, names resolved, the persona by her name', () => {
  const a = seen('m1', '2026-10-12T10:00:00Z', 'who\nbrought   the café?', { by: NIKOS, participants: [NIKOS] });
  const b = seen('m2', '2026-10-12T10:01:00Z', 'not me', { kind: 'said', by: undefined, participants: [NIKOS] });
  const c = seen('m3', '2026-10-12T10:02:00Z', '<@422222222222222222> did', {
    revision: 2,
    participants: [ELENI, NIKOS],
  });
  const { text, meta } = recordChunk(c, [a, b], opts);
  assert.equal(text, 'Nikós: who brought the café?\nPersona: not me\nΕλένη: Nikós did');
  assert.deepEqual(meta, {
    kind: 'record',
    id: 'm3',
    revision: 2,
    occurredAt: '2026-10-12T10:02:00.000Z',
    placeId: 'c1',
    by: ELENI,
    participants: [ELENI, NIKOS],
    sourceIds: ['m1', 'm2', 'm3'],
  });
});

test('recordChunk: an unknown author reads as their id; each line is cut at the line limit', () => {
  const long = 'α'.repeat(400);
  const { text } = recordChunk(seen('m1', '2026-10-12T10:00:00Z', long, { by: '433333333333333333' }), [], {
    ...opts,
    lineChars: 300,
  });
  assert.equal(text, `433333333333333333: ${'α'.repeat(300)}`);
});

test('recordChunk: a line with links carries their titles and descriptions; a line without is unchanged', () => {
  const links = [
    { url: 'https://video.example/1', title: 'Carrera épica', description: 'Δύο φίλοι τρέχουν', site: 'VideoSite' },
  ];
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
  assert.deepEqual(
    contextFor(lines[2], lines, 2).map((line) => line.messageId),
    ['m1', 'm2']
  );
  assert.deepEqual(
    contextFor(lines[1], lines, 2).map((line) => line.messageId),
    []
  );
  assert.deepEqual(
    contextFor(lines[0], lines, 1).map((line) => line.messageId),
    ['m3']
  );
});

test('newestRevisions: one line per message, its newest revision; deleted and felt lines left out', () => {
  // @ts-expect-error: the test passes a line the type refuses (a missing field), to check that it is skipped
  const out = newestRevisions([
    seen('m1', '2026-10-12T10:00:00Z', 'first'),
    seen('m1', '2026-10-12T10:00:00Z', 'edited', { revision: 2 }),
    { kind: 'deleted', messageId: 'm1', occurredAt: '2026-10-12T11:00:00Z' },
    seen('m2', '2026-10-12T10:01:00Z', 'b'),
  ]);
  assert.deepEqual(
    out.map((line) => [line.messageId, line.text]),
    [
      ['m1', 'edited'],
      ['m2', 'b'],
    ]
  );
});

const HER = 'cli:self';
const FIRST = '2026-11-12T01:01:00Z';
const EDITED = '2026-11-12T02:34:00Z';

/** Her line `m2` and the lines around it, her edit of it stored as production holds it: `seen`, at the moment of the edit. */
function editedChat(): Array<RecordLine> {
  return [
    seen('m1', '2026-11-12T01:00:00Z', 'first words'),
    seen('m2', FIRST, 'the kettle is on 🙂', { kind: 'said', by: undefined, participants: [] }),
    seen('m3', '2026-11-12T01:02:00Z', 'second words'),
    seen('m2', EDITED, 'the kettle is on', { revision: 2, by: HER, participants: [HER] }),
  ];
}

// Bug (production, 2026-11-12): the edit's line is `seen` by her account, so its chunk names the author by that
// account's name, or by the bare id, and the meaning index reads her words as another's.
test('newestRevisions and recordChunk: her edited line is written under her name', () => {
  const line = newestRevisions(editedChat()).find((one) => one.messageId === 'm2');
  assert.ok(line);
  assert.equal(recordChunk(line, [], opts).text, 'Persona: the kettle is on');
});

// Bug: the line sorts by the moment of its edit, so the lines said after it come before it and the context of a later
// line leaves it out.
test('newestRevisions: her edited line stays between the lines said before and after it', () => {
  assert.deepEqual(
    newestRevisions(editedChat()).map((line) => line.messageId),
    ['m1', 'm2', 'm3']
  );
});
