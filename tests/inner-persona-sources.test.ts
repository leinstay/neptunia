// src/behavior/inner/persona-sources.ts: the record and the journal as the one persona reads them, over every place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personaJournal, personaRecord } from '../src/behavior/inner/persona-sources.ts';
import type { Journal } from '../src/memory/journal.ts';
import { wrongly } from './fixtures/loose-types.ts';

test('the record is read from every place and a line goes to the place of its chat', async () => {
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
  assert.deepEqual(await source.turnOperations?.({ turnId: 't', days: [], privateAccountId: null }), ['op']);
});

test('a cut-off private turn is looked for in the place of its direct message', async () => {
  // Bug: a DM's place is no server, so a restart found nothing of the DM turn it cut off and told her nothing it did.
  const journal = wrongly<Journal>({
    turnOperations: (placeId: string) => Promise.resolve(placeId === 'dm:u1' ? ['op'] : []),
  });
  const store = {
    placeOfChat: (chat: { partnerId?: string }) => `dm:${chat.partnerId}`,
  };
  const source = personaJournal(journal, () => ['p1'], store);
  assert.deepEqual(await source.turnOperations?.({ turnId: 't', days: [], privateAccountId: 'u1' }), ['op']);
  assert.deepEqual(await source.turnOperations?.({ turnId: 't', days: [], privateAccountId: null }), []);
});

// Stage T.5 of the master plan: `personaJournal.turnOperations` (src/behavior/inner/persona-sources.ts) looks for the
// operations of a cut-off DM turn in the DM's own place. A DM is keyed by its partner and the interface, so the query
// names the interface of the turn (`iface`, from the in-flight mark) and the place is resolved under it, not under the
// home interface. The store is a fake whose DM place depends on both; the journal answers only for the right place.

/** A store whose DM place is `<iface>:dm:<partner>`; an absent interface is the home interface, `discord`. */
const store = {
  placeOfChat: (chat: { kind?: string; partnerId?: string }, iface = 'discord') => `${iface}:dm:${chat.partnerId}`,
};

function journalHolding(place: string) {
  const asked: Array<string> = [];
  const journal = wrongly<Journal>({
    turnOperations: (placeId: string) => {
      asked.push(placeId);
      return Promise.resolve(placeId === place ? ['op'] : []);
    },
  });
  return { journal, asked };
}

test('a cut-off DM turn of the command line is looked for in the DM place of that interface', async () => {
  // Catches: the CLI turn is looked for under the home interface's DM place, so a restart finds nothing it did.
  const { journal } = journalHolding('cli:dm:owner');
  const source = personaJournal(journal, () => ['p1'], store);
  const found = await source.turnOperations?.({ turnId: 't', days: [], privateAccountId: 'owner', iface: 'cli' });
  assert.deepEqual(found, ['op']);
});

test('the home interface DM place is not searched for a turn of another interface', async () => {
  // Catches: the same partner id on two interfaces reads one DM's operations as the other's.
  const { journal, asked } = journalHolding('cli:dm:owner');
  const source = personaJournal(journal, () => ['p1'], store);
  await source.turnOperations?.({ turnId: 't', days: [], privateAccountId: 'owner', iface: 'cli' });
  assert.equal(asked.includes('discord:dm:owner'), false);
});

test('a turn with no interface in its mark is still looked for under the home interface', async () => {
  // Catches: a mark written before the interface was recorded stops being resolved at all.
  const { journal } = journalHolding('discord:dm:u1');
  const source = personaJournal(journal, () => ['p1'], store);
  assert.deepEqual(await source.turnOperations?.({ turnId: 't', days: [], privateAccountId: 'u1' }), ['op']);
});
