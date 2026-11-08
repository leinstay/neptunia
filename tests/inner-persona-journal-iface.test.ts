// Stage T.5 of the master plan: `personaJournal.turnOperations` (src/behavior/inner/persona-sources.ts) looks for the
// operations of a cut-off DM turn in the DM's own place. A DM is keyed by its partner and the interface, so the query
// names the interface of the turn (`iface`, from the in-flight mark) and the place is resolved under it, not under the
// home interface. The store is a fake whose DM place depends on both; the journal answers only for the right place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personaJournal } from '../src/behavior/inner/persona-sources.ts';
import type { Journal } from '../src/memory/journal.ts';
import { wrongly } from './fixtures/loose-types.ts';

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
