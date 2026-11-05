// The read of a DM partner's conversation across the port: its wire shape, the Discord method over a stub client (it opens the
// channel and sends nothing), the fake's answer, the router, and `createReads.answer`, which keeps the code `createReads`'s
// plain reads turn into null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordAdapter } from '../interfaces/discord/index.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { createIfaceRouter, openAdapterLink } from '../src/interface/link.ts';
import { notOk } from '../src/interface/port.ts';
import { createReads } from '../src/interface/reads.ts';
import { createLoopback, portAction, validateAction } from '../src/protocol/index.ts';
import { serveAdapter } from '../src/protocol/serve.ts';
import { createEventDoor } from '../src/interface/door.ts';

const PARTNER = { iface: 'discord', accountId: 'u1' };
const quiet = { info() {}, warn() {}, error() {} };

test('the read crosses as dm.conversation and is refused without its account', () => {
  const action = portAction('dmConversationOf', [PARTNER]);
  assert.deepEqual(action, { action: 'dm.conversation', iface: 'discord', accountId: 'u1' });
  assert.equal(validateAction(action).ok, true);
  assert.equal(validateAction({ action: 'dm.conversation', iface: 'discord' }).ok, false);
  assert.equal(validateAction({ action: 'dm.conversation', accountId: 'u1' }).ok, false);
});

/** An adapter over a stub client whose `users.createDM` runs `create`, and the ids it was asked for. */
function discordOver(create: (id: string) => Promise<unknown>) {
  const asked: Array<string> = [];
  const client = {
    user: { id: 'self' },
    users: {
      createDM: (id: string) => {
        asked.push(id);
        return create(id);
      },
    },
  };
  return { adapter: createDiscordAdapter({ client: client, config: () => ({}) }), asked };
}

test('Discord opens the DM channel of the partner and answers its id', async () => {
  const send = () => assert.fail('opening a conversation sends nothing');
  const { adapter, asked } = discordOver(() => Promise.resolve({ id: 'dm-1', send }));
  assert.deepEqual(await adapter.dmConversationOf(PARTNER), { status: 'ok', conversationId: 'dm-1' });
  assert.deepEqual(asked, ['u1']);
});

test('Discord answers a partner it refuses as forbidden, and an unknown one as failed for good', async () => {
  const forbids = discordOver(() => Promise.reject(Object.assign(new Error('no'), { status: 403 })));
  const refused = await forbids.adapter.dmConversationOf(PARTNER);
  assert.equal(refused.status, 'forbidden');
  const unknown = discordOver(() => Promise.reject(Object.assign(new Error('no'), { status: 404 })));
  const failed = await unknown.adapter.dmConversationOf(PARTNER);
  assert.deepEqual([failed.status, failed.status !== 'ok' && failed.error.retryable], ['failed', false]);
});

test('Discord answers a server fault as failed and worth another try', async () => {
  const { adapter } = discordOver(() => Promise.reject(Object.assign(new Error('no'), { status: 503 })));
  const failed = await adapter.dmConversationOf(PARTNER);
  assert.equal(failed.status !== 'ok' && failed.error.retryable, true);
});

test('the fake answers a seeded partner and fails an unknown one', async () => {
  const fake = createFakeAdapter({ iface: 'discord', selfId: 'self' });
  fake.seedDmConversation('u1', 'dm-1');
  assert.deepEqual(await fake.dmConversationOf(PARTNER), { status: 'ok', conversationId: 'dm-1' });
  const unknown = await fake.dmConversationOf({ iface: 'discord', accountId: 'u9' });
  assert.equal(unknown.status, 'failed');
});

test('the read goes over the link and comes back with the conversation', async () => {
  const fake = createFakeAdapter({ iface: 'fake', selfId: 'self' });
  fake.seedDmConversation('u1', 'dm-1');
  const door = createEventDoor({ handlers: {}, log: quiet });
  const { core, client } = createLoopback();
  const link = openAdapterLink({ transport: core, door, token: 'tok', log: quiet });
  const hello = {
    iface: 'fake',
    self: { id: 'self', name: 'Self' },
    community: { id: 'g1', name: 'Alpha' },
    capabilities: fake.capabilities(),
    resume: null,
  };
  serveAdapter({ transport: client, hello, token: 'tok', adapter: fake, log: quiet });
  await link.hello;
  assert.deepEqual(await link.adapter.dmConversationOf({ iface: 'fake', accountId: 'u1' }), {
    status: 'ok',
    conversationId: 'dm-1',
  });
  link.close();
});

test('the router sends the read to the interface the partner is on', async () => {
  const served = createFakeAdapter({ iface: 'discord', selfId: 'self' });
  const other = createFakeAdapter({ iface: 'other', selfId: 'self' });
  other.seedDmConversation('u1', 'dm-other');
  const router = createIfaceRouter(
    served,
    (iface) => (iface === 'other' ? other : null),
    () => [other]
  );
  assert.deepEqual(await router.dmConversationOf({ iface: 'other', accountId: 'u1' }), {
    status: 'ok',
    conversationId: 'dm-other',
  });
});

test('answer keeps the code and the plain read stays null', async () => {
  const fake = createFakeAdapter({ iface: 'discord', selfId: 'self' });
  const reads = createReads(fake, quiet);
  fake.failNext('dmConversationOf', notOk('forbidden', 'http-403'));
  const refused = await reads.answer('dmConversationOf', PARTNER);
  assert.deepEqual([refused.status, refused.status !== 'ok' && refused.code], ['forbidden', 'http-403']);
  fake.failNext('dmConversationOf', notOk('forbidden', 'http-403'));
  assert.equal(await reads.dmConversationOf(PARTNER), null);
});

test('answer tells whether a failure is worth another try', async () => {
  const fake = createFakeAdapter({ iface: 'discord', selfId: 'self' });
  const reads = createReads(fake, quiet);
  fake.failNext('dmConversationOf', notOk('failed', 'http-500', { retryable: true }));
  const failed = await reads.answer('dmConversationOf', PARTNER);
  assert.equal(failed.status !== 'ok' && failed.retryable, true);
});

test('answer gives the status and the body of an ok read', async () => {
  const fake = createFakeAdapter({ iface: 'discord', selfId: 'self' });
  fake.seedDmConversation('u1', 'dm-1');
  assert.deepEqual(await createReads(fake, quiet).answer('dmConversationOf', PARTNER), {
    status: 'ok',
    conversationId: 'dm-1',
  });
});

test('answer says unsupported of a read the interface does not declare, with no round trip', async () => {
  const fake = createFakeAdapter({ iface: 'discord', selfId: 'self', reads: [] });
  const answer = await createReads(fake, quiet).answer('dmConversationOf', PARTNER);
  assert.equal(answer.status, 'unsupported');
  assert.equal(
    fake.calls.some((call) => call.op === 'dmConversationOf'),
    false
  );
});
