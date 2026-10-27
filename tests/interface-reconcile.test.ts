// Tests for the reconcile of an effect whose outcome was lost (src/interface/reconcile.ts). A send that may have
// reached the platform is `unknown`. When the adapter declares `capabilities().reconcile`, the core looks the send up
// by its idempotency key through the adapter's `fetchMessages`: found, it is `ok` with the posted message; absent, it
// is `failed`, known not to have happened. An adapter that cannot reconcile leaves the effect `unknown`. The core
// never sends again to find out. The adapter is the in-memory fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileUnknown } from '../src/interface/reconcile.ts';
import { createFakeAdapter } from '../src/interface/fake.js';

const CONVERSATION = { iface: 'fake', conversationId: 'c1' };
const KEY = 'turn-1:0:c1';

const callsOf = (fake: ReturnType<typeof createFakeAdapter>, op: string): number =>
  fake.calls.filter((call) => call.op === op).length;

test('a send the platform took under the key is reconciled ok with the message it posted', async () => {
  const fake = createFakeAdapter({ selfId: 'self-id', capabilities: { reconcile: true } });
  // The send went through, and its answer was lost on the way back.
  const lost = await fake.send(CONVERSATION, { text: 'did it arrive' }, { idempotencyKey: KEY });
  const delivery = await reconcileUnknown(fake, { conversation: CONVERSATION, idempotencyKey: KEY });
  assert.equal(delivery.status, 'ok');
  assert.equal(delivery.ref?.messageId, lost.ref?.messageId);
  assert.equal(delivery.idempotencyKey, KEY);
  assert.equal(callsOf(fake, 'send'), 1, 'reconcile never sends again');
});

test('a send the platform never took is reconciled failed, and nothing is sent', async () => {
  const fake = createFakeAdapter({ selfId: 'self-id', capabilities: { reconcile: true } });
  await fake.send(CONVERSATION, { text: 'another message' }, { idempotencyKey: 'turn-0:0:c1' });
  const delivery = await reconcileUnknown(fake, { conversation: CONVERSATION, idempotencyKey: KEY });
  assert.equal(delivery.status, 'failed');
  assert.equal(callsOf(fake, 'send'), 1);
});

test('an adapter that cannot reconcile leaves the send unknown, with no read and no send', async () => {
  const fake = createFakeAdapter({ selfId: 'self-id', capabilities: { reconcile: false } });
  await fake.send(CONVERSATION, { text: 'did it arrive' }, { idempotencyKey: KEY });
  const delivery = await reconcileUnknown(fake, { conversation: CONVERSATION, idempotencyKey: KEY });
  assert.equal(delivery.status, 'unknown');
  assert.equal(callsOf(fake, 'send'), 1);
  assert.equal(callsOf(fake, 'fetchMessages'), 0);
});
