// A Russian query reaches an English text form through the vectors alone (src/memory/chunks.ts, the embedding queue of
// src/memory/db/media-backfill.ts, the meaning stream of src/memory/db/recall.ts), for every media kind and for a kind that
// has no text of its own. Audience holds: a DM's text form never reaches a group's chunk or a group's search. A fake embedder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embeddableLine, recordChunk } from '../src/memory/chunks.ts';
import type { RecordLine } from '../src/memory/record.ts';
import { chunkLinesOf } from '../src/memory/db/index-policy.ts';
import { search } from '../src/memory/db/recall.ts';
import { dmContext } from '../src/memory/db/scope.ts';
import {
  AT,
  BOB_PERSON,
  BOB_SCOPE,
  GENERAL,
  KINDS,
  PRESENCES,
  fixture,
  group,
  itemsOf,
  observeDmLine,
  observeLine,
  tell,
} from './fixtures/media-memory.ts';
import { byMeaning, embedLines } from './fixtures/media-memory-embed.ts';
import type { Env, Kind, Presence } from './fixtures/media-memory.ts';

const meaningHits = (env: Env, query: string, ctx: unknown = group) =>
  search(env.db, { ctx, ...byMeaning(query) }).hits.filter((hit) => hit.streams.includes('meaning'));

async function withLine(kind: Kind, presence: Presence, body: (env: Env) => void | Promise<void>) {
  const env = fixture();
  try {
    observeLine(env, kind, presence);
    env.stem();
    await body(env);
  } finally {
    env.done();
  }
}

for (const kind of KINDS) {
  for (const presence of PRESENCES) {
    const told = presence !== 'absent';
    test(`meaning: a Russian query ${told ? 'reaches' : 'does not reach'} a ${kind.name} with its English text form ${presence}`, () =>
      withLine(kind, presence, async (env) => {
        await embedLines(env);
        assert.equal(
          meaningHits(env, kind.first.query).some((hit) => hit.messageId === 'pic'),
          told
        );
      }));
  }

  test(`meaning: a DM's ${kind.name} text form reaches its partner and never a group`, async () => {
    const env = fixture();
    try {
      observeDmLine(env, kind);
      env.stem();
      await embedLines(env);
      assert.deepEqual(
        meaningHits(env, kind.first.query, dmContext(BOB_PERSON, 'discord')).map((hit) => hit.messageId),
        ['secret']
      );
      assert.deepEqual(meaningHits(env, kind.first.query), []);
    } finally {
      env.done();
    }
  });
}

test('a group line never carries into its chunk a text form only a DM may read', async () => {
  const env = fixture();
  try {
    const kind = KINDS[0];
    observeLine(env, kind, 'absent');
    tell(env, kind, itemsOf(kind, 'pic')[0], { scope: BOB_SCOPE });
    env.stem();
    const { asked } = await embedLines(env);
    assert.ok(!asked.join('\n').includes(kind.first.word));
    assert.deepEqual(meaningHits(env, kind.first.query), []);
  } finally {
    env.done();
  }
});

test('the embedding queue asks once for a described line and again when its text form changes', async () => {
  const env = fixture();
  try {
    const kind = KINDS[0];
    observeLine(env, kind, 'part');
    env.stem();
    assert.equal((await embedLines(env)).embedded, 1);
    assert.equal((await embedLines(env)).embedded, 0, 'nothing changed: no request');
    tell(env, kind, itemsOf(kind, 'pic')[1]);
    const second = await embedLines(env);
    assert.equal(second.embedded, 1);
    assert.ok(second.asked[0].includes(kind.second.word));
    assert.equal(
      env.db.prepare('SELECT COUNT(*) AS n FROM vectors').get()?.n,
      1,
      'the vector is replaced, not added to'
    );
  } finally {
    env.done();
  }
});

test('the embedding queue leaves a bare line without a vector', async () => {
  const env = fixture();
  try {
    observeLine(env, KINDS[0], 'absent');
    assert.deepEqual((await embedLines(env)).asked, []);
  } finally {
    env.done();
  }
});

test('the two lines after a described line are embedded with its text form, so a short answer carries it', async () => {
  const env = fixture();
  try {
    const kind = KINDS[0];
    observeLine(env, kind, 'full');
    env.say({ native: 'answer', at: AT + 60_000, text: 'ναι', place: GENERAL });
    env.stem();
    const { asked } = await embedLines(env);
    assert.ok(asked.some((chunk) => chunk.includes('ναι') && chunk.includes(kind.first.word)));
  } finally {
    env.done();
  }
});

// ---------- the chunk, pure ----------

const line = (over: Partial<RecordLine> & { mediaText?: string }): RecordLine =>
  ({
    kind: 'seen',
    messageId: 'm1',
    occurredAt: '2026-11-01T10:00:00.000Z',
    by: 'u1',
    text: '',
    media: ['image'],
    ...over,
  }) as RecordLine;

test('a line with no text and a text form can be embedded; a bare one cannot', () => {
  assert.equal(embeddableLine(line({ mediaText: 'a lighthouse' })), true);
  assert.equal(embeddableLine(line({})), false);
});

test('a chunk line carries the text form after its text, cut like a line', () => {
  const chunk = recordChunk(line({ text: 'look', mediaText: 'a lighthouse' }), [], { selfName: 'Self' });
  assert.match(chunk.text, /look.*a lighthouse/);
  const long = recordChunk(line({ mediaText: 'x'.repeat(2000) }), [], { selfName: 'Self', lineChars: 100 });
  assert.ok(long.text.length < 200);
});

test('a context line of a chunk carries its text form too', () => {
  const chunk = recordChunk(line({ messageId: 'm2', text: 'yes' }), [line({ mediaText: 'a lighthouse' })], {
    selfName: 'Self',
  });
  assert.match(chunk.text, /a lighthouse/);
});

test('the stored line of a vector carries its text form, so a re-embed of an evicted picture has an input', () => {
  const env = fixture();
  try {
    const kind = KINDS[0];
    const source = observeLine(env, kind, 'full');
    const found = chunkLinesOf(env.db, { source_id: source, context: '{}' });
    assert.ok(found, 'a line with no text still has a chunk');
    assert.match(String(found.line.mediaText), new RegExp(kind.first.word));
  } finally {
    env.done();
  }
});
