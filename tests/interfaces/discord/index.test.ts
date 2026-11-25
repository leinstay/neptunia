// interfaces/discord/index.ts: the interface's port is the Discord adapter over the client it is given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordInterface } from '../../../interfaces/discord/index.ts';
import type { Untyped } from '../../../src/tools/types.ts';

const SELF = 'self-id';

test('createDiscordInterface: the port is the Discord adapter over the given client', async () => {
  const sent: Array<Untyped> = [];
  const channel = {
    id: 'c9',
    send: async (payload: Record<string, Untyped>) => (sent.push(payload), { id: 'x1', createdTimestamp: 42 }),
  };
  const client: Record<string, Untyped> = { user: { id: SELF }, channels: { cache: new Map([['c9', channel]]) } };
  const built = createDiscordInterface({ client });
  assert.deepEqual(Object.keys(built), ['port', 'capabilities', 'client']);
  assert.equal(built.client, client);
  assert.equal(built.port.iface, 'discord');
  const result = await built.port.send({ iface: 'discord', chatId: 'c9' }, { text: 'ναι' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.ref, { iface: 'discord', chatId: 'c9', messageId: 'x1', accountId: SELF });
  // The Discord port names nobody and no replied author in every send.
  assert.deepEqual(sent, [
    { content: 'ναι', reply: undefined, allowedMentions: { parse: [], users: [], repliedUser: false } },
  ]);
});
