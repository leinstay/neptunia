// The event pipeline (src/behavior/pipeline.ts) over the fake interface: a throwing dependency stays inside the handler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeMemory, fakeMessage, makeHandler } from '../../fixtures/events-rig.ts';
import { useIface, useSelf } from '../../fixtures/turn-world.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';

useIface('fake');

useSelf('self1');

test('events: a throwing dependency does not escape the handler', async () => {
  const memory = fakeMemory({
    observe: () => {
      throw new Error('boom');
    },
  });
  const handler = makeHandler({ memory });

  const message = fakeMessage({ cleanContent: 'οτιδήποτε' });
  await assert.doesNotReject(() => handler(message));
});

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['owner1']);
