// src/behavior/inner/persona-sources.ts: the record and the journal as the one persona reads them, over every place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personaJournal, personaRecord } from '../src/behavior/inner/persona-sources.ts';
import type { Journal } from '../src/memory/journal.ts';
import { wrongly } from './fixtures/loose-types.ts';

test('the record is read from every place and a line goes to the place of its conversation', async () => {
  // Bug: the inner life sees one server, or her own line lands under no place anyone reads.
  const appended: Array<[string, unknown]> = [];
  const record = {
    async *iterate(placeId: string) {
      await Promise.resolve();
      yield { placeId };
    },
    append(placeId: string, lines: ReadonlyArray<unknown>) {
      appended.push([placeId, lines.length]);
    },
  };
  const source = personaRecord(record, { rootPlaceOf: (id) => (id === 'c1' ? 'top' : null) }, () => ['p1', 'p2']);
  const read: Array<unknown> = [];
  for await (const line of source.iterate?.({ from: '2026-01-01' }) ?? []) read.push(line);
  assert.deepEqual(read, [{ placeId: 'p1' }, { placeId: 'p2' }]);
  source.append?.([{ scope: { channel: 'c1' } }]);
  assert.deepEqual(appended, [['top', 1]]);
});

test('her own journal lines go to the persona, and a cut-off turn is looked for in every place', async () => {
  // Bug: a restart looks for the turn in one server, and repeats what a DM's turn already did.
  const written: Array<unknown> = [];
  const journal = wrongly<Journal>({
    inner: (placeId: string) => written.push(placeId),
    turnOperations: (placeId: string) => Promise.resolve(placeId === 'p2' ? ['op'] : []),
  });
  const source = personaJournal(journal, () => ['p1', 'p2']);
  source.inner?.({ event: 'x' });
  assert.deepEqual(written, ['persona:local']);
  assert.deepEqual(await source.turnOperations?.({ turnId: 't', days: [], privateUserId: null }), ['op']);
});

test('a cut-off private turn is looked for in the place of its direct message', async () => {
  // Bug: a DM's place is no server, so a restart found nothing of the DM turn it cut off and told her nothing it did.
  const journal = wrongly<Journal>({
    turnOperations: (placeId: string) => Promise.resolve(placeId === 'dm:u1' ? ['op'] : []),
  });
  const store = {
    placeOfConversation: (conversation: { partnerId?: string }) => `dm:${conversation.partnerId}`,
  };
  const source = personaJournal(journal, () => ['p1'], store);
  assert.deepEqual(await source.turnOperations?.({ turnId: 't', days: [], privateUserId: 'u1' }), ['op']);
  assert.deepEqual(await source.turnOperations?.({ turnId: 't', days: [], privateUserId: null }), []);
});
