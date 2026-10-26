// postingConversation (src/tools/impl/shared.ts): where an operation that acts as the persona may post. The conversation
// comes from the interface's conversation info (`reads.conversationInfo`), and what she may do there from its
// `permissions` (read, send, attach, react). The current conversation passes as it is; any other must belong to the
// served community, must not be a private chat, and must grant the permissions the need names: `send` needs send,
// `reply` needs send and read, `attach` needs send and attach, `read` needs read, `react` needs react.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Permissions } from '../src/protocol/adapter.ts';
import type { Reads } from '../src/interface/reads.ts';
import { COMMUNITY, IFACE, channel, rig } from './fixtures/reads-rig.ts';

type Need = 'send' | 'reply' | 'attach' | 'read' | 'react';
type Posting = {
  postingConversation: (args: {
    reads: Reads | null;
    iface: string;
    guildId: string | null;
    channelId: string | null | undefined;
    context: { channelId?: string };
    need: Need;
  }) => Promise<string>;
};

const shared = (await import('../src/tools/impl/shared.ts')) as Posting;

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
  test(`lets a ${need} reach another conversation exactly when the permissions it needs are all true`, async () => {
    const outcome: Record<string, boolean> = {};
    for (const permissions of combinations()) {
      const { reads, fake } = rig();
      fake.seedConversation(channel('c2', { permissions }));
      const allowed = await shared
        .postingConversation({
          reads,
          iface: IFACE,
          guildId: COMMUNITY,
          channelId: 'c2',
          context: { channelId: 'c1' },
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

test('returns the id of the conversation it runs in without asking the interface', async () => {
  const { reads, asked } = rig();
  const id = await shared.postingConversation({
    reads,
    iface: IFACE,
    guildId: COMMUNITY,
    channelId: null,
    context: { channelId: 'c1' },
    need: 'attach',
  });
  assert.equal(id, 'c1');
  assert.deepEqual(asked('conversationInfo'), []);
});

test('refuses a conversation of another community even with every permission', async () => {
  const { reads, fake } = rig();
  fake.seedConversation(channel('c2', { communityId: 'g2' }));
  await assert.rejects(
    shared.postingConversation({
      reads,
      iface: IFACE,
      guildId: COMMUNITY,
      channelId: 'c2',
      context: { channelId: 'c1' },
      need: 'send',
    }),
    { status: 'denied', code: 'channel-no-permission' }
  );
});

test('refuses a private chat even with every permission', async () => {
  const { reads, fake } = rig();
  fake.seedConversation(channel('dm2', { kind: 'dm', communityId: COMMUNITY, chatType: 'dm', partnerId: 'u9' }));
  await assert.rejects(
    shared.postingConversation({
      reads,
      iface: IFACE,
      guildId: COMMUNITY,
      channelId: 'dm2',
      context: { channelId: 'c1' },
      need: 'send',
    }),
    { status: 'denied', code: 'channel-no-permission' }
  );
});

test('refuses a conversation the interface does not know', async () => {
  const { reads } = rig();
  await assert.rejects(
    shared.postingConversation({
      reads,
      iface: IFACE,
      guildId: COMMUNITY,
      channelId: 'gone',
      context: { channelId: 'c1' },
      need: 'send',
    }),
    { status: 'denied', code: 'channel-no-permission' }
  );
});

test('refuses another conversation when the interface cannot describe conversations', async () => {
  const { reads } = rig({ reads: ['messages.fetch'] });
  await assert.rejects(
    shared.postingConversation({
      reads,
      iface: IFACE,
      guildId: COMMUNITY,
      channelId: 'c2',
      context: { channelId: 'c1' },
      need: 'send',
    }),
    { status: 'denied', code: 'channel-no-permission' }
  );
});

test('refuses a call with neither a target nor a current conversation', async () => {
  const { reads } = rig();
  await assert.rejects(
    shared.postingConversation({
      reads,
      iface: IFACE,
      guildId: COMMUNITY,
      channelId: undefined,
      context: {},
      need: 'send',
    }),
    { status: 'invalid' }
  );
});
