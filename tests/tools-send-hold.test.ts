// A restricted publication is rejected before a wake's hold accepts its content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveriesOf } from '../src/behavior/inner/deliveries.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { createSendHold, heldPort } from '../src/tools/send-hold.ts';
import { bindPublicationPort, type PublicationBoundary } from '../src/tools/publication.ts';

const publicationBoundary: PublicationBoundary = {
  kind: 'internal-turn',
  origin: { iface: 'fake', chatId: 'origin' },
};

test('a held port refuses a foreign publication before keeping it', async () => {
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self', now: () => 1000 });
  const hold = createSendHold();
  const held = heldPort(bindPublicationPort(port, publicationBoundary), { hold, publicationBoundary });
  const result = await held.send({ iface: 'fake', chatId: 'group' }, { text: 'restricted body' });
  assert.deepEqual([result.status, result.error?.code], ['failed', 'not-allowed']);
  assert.deepEqual(hold.sends, []);
  assert.deepEqual(port.messagesIn('group'), []);
});

test('a same-origin held send retains its restrictive descriptor in the durable delivery payload', async () => {
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self', now: () => 1000 });
  const hold = createSendHold();
  const held = heldPort(port, { hold, publicationBoundary });
  const result = await held.send(publicationBoundary.origin, { text: 'private held answer' });
  assert.equal(result.status, 'ok');
  assert.equal(hold.sends.length, 1);
  assert.deepEqual(hold.sends[0].publicationBoundary, publicationBoundary);
  const payload: unknown = deliveriesOf(hold, { turnId: 'turn:held', chainId: 'chain:held' })[0].payload;
  assert.ok(payload && typeof payload === 'object' && 'publicationBoundary' in payload);
  assert.deepEqual(payload.publicationBoundary, publicationBoundary);
  assert.equal('memoryContext' in payload, false);
});
