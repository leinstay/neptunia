// postingChat (src/tools/operations/shared.ts): where an operation that acts as the persona may post. The chat
// comes from the interface's chat info (`reads.chatInfo`), and what she may do there from its
// `permissions` (read, send, attach, react). The current chat passes as it is; any other, of any root,
// must not be a private chat while private chats are off, and must grant the permissions the need names: `send` needs send,
// `reply` needs send and read, `attach` needs send and attach, `read` needs read, `react` needs react. The call's place
// is `context.placeId` alone (plan 2026-11-05 T.4): a call made at the root passes the root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Permissions } from '../src/protocol/adapter.ts';
import { ROOT, IFACE, channel, rig } from './fixtures/reads-rig.ts';
import { postingChat } from '../src/tools/operations/shared.ts';

type Need = 'send' | 'reply' | 'attach' | 'read' | 'react';
/** The permissions each need requires, as the keys that must all be true. */
const REQUIRES: Record<Need, Array<keyof Permissions>> = {
  send: ['send'],
  reply: ['send', 'read'],
  attach: ['send', 'attach'],
  read: ['read'],
  react: ['react'],
};

const KEYS: Array<keyof Permissions> = ['read', 'send', 'attach', 'react'];

/** Every combination of the four permissions. */
function combinations(): Array<Permissions> {
  return Array.from({ length: 16 }, (_, bits) => ({
    read: (bits & 1) !== 0,
    send: (bits & 2) !== 0,
    attach: (bits & 4) !== 0,
    react: (bits & 8) !== 0,
  }));
}

const describe = (permissions: Permissions): string => KEYS.filter((key) => permissions[key]).join('+') || 'none';

for (const need of Object.keys(REQUIRES) as Array<Need>) {
  test(`lets a ${need} reach another chat exactly when the permissions it needs are all true`, async () => {
    const outcome: Record<string, boolean> = {};
    for (const permissions of combinations()) {
      const { reads, fake } = rig();
      fake.seedChat(channel('c2', { permissions }));
      const allowed = await postingChat({
        reads,
        store: null,
        iface: IFACE,
        chatId: 'c2',
        context: { placeId: ROOT },
        need,
      })
        .then(() => true)
        .catch((error: { status?: string; code?: string }) => {
          assert.deepEqual([error.status, error.code], ['denied', 'channel-no-permission']);
          return false;
        });
      outcome[describe(permissions)] = allowed;
    }
    const expected = Object.fromEntries(
      combinations().map((permissions) => [describe(permissions), REQUIRES[need].every((key) => permissions[key])])
    );
    assert.deepEqual(outcome, expected);
  });
}

test('returns the id of the chat it runs in without asking the interface', async () => {
  const { reads, asked } = rig();
  const id = await postingChat({
    reads,
    store: null,
    iface: IFACE,
    chatId: null,
    context: { placeId: 'c1' },
    need: 'attach',
  });
  assert.equal(id, 'c1');
  assert.deepEqual(asked('chatInfo'), []);
});

// Slice 5 (plan 5 (i)): the tree check is gone, so a chat of another root where she may send is a
// destination like any other.
test('accepts a chat of another root where she may send', async () => {
  const { reads, fake } = rig();
  fake.seedChat(channel('c2', { rootId: 'g2' }));
  const id = await postingChat({
    reads,
    store: null,
    iface: IFACE,
    chatId: 'c2',
    context: { placeId: ROOT },
    need: 'send',
  });
  assert.equal(id, 'c2');
});

test('refuses a private chat even with every permission', async () => {
  const { reads, fake } = rig();
  fake.seedChat(channel('dm2', { kind: 'dm', rootId: ROOT, chatType: 'dm', partnerId: 'u9' }));
  await assert.rejects(
    postingChat({
      reads,
      store: null,
      iface: IFACE,
      chatId: 'dm2',
      context: { placeId: ROOT },
      need: 'send',
    }),
    // Slice 7: a post to a direct chat while private chats are off is refused with its own code, dm-disabled.
    { status: 'denied', code: 'dm-disabled' }
  );
});

test('refuses a chat the interface does not know', async () => {
  const { reads } = rig();
  await assert.rejects(
    postingChat({
      reads,
      store: null,
      iface: IFACE,
      chatId: 'gone',
      context: { placeId: ROOT },
      need: 'send',
    }),
    { status: 'denied', code: 'channel-no-permission' }
  );
});

test('refuses another chat when the interface cannot describe chats', async () => {
  const { reads } = rig({ reads: ['messages.fetch'] });
  await assert.rejects(
    postingChat({
      reads,
      store: null,
      iface: IFACE,
      chatId: 'c2',
      context: { placeId: ROOT },
      need: 'send',
    }),
    { status: 'denied', code: 'channel-no-permission' }
  );
});

test('refuses a call with neither a target nor a current chat', async () => {
  const { reads } = rig();
  await assert.rejects(
    postingChat({
      reads,
      store: null,
      iface: IFACE,
      chatId: undefined,
      context: {},
      need: 'send',
    }),
    { status: 'invalid' }
  );
});
