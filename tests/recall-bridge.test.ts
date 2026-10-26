import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeRecall } from '../src/interface/recall-bridge.ts';

type Call = Record<string, unknown>;

function recallThatRecords() {
  const calls: Array<{ method: string; args: Call }> = [];
  const method = (name: string) => (args: Call) => {
    calls.push({ method: name, args });
    return Promise.resolve(name);
  };
  return {
    calls,
    recall: { run: method('run'), prefetch: method('prefetch'), window: method('window'), other: method('other') },
  };
}

function platform() {
  const guild = {
    id: 'g1',
    members: { cache: new Map([['u9', { id: 'u9', fetched: false }]]), fetch: () => Promise.resolve(null) },
  };
  const channel = { id: 'c1', platform: true };
  return {
    guild,
    channel,
    client: {
      guilds: { cache: new Map([['g1', guild]]) },
      channels: { cache: new Map([['c1', channel]]), fetch: () => Promise.resolve(null) },
    },
  };
}

test('bridgeRecall hands the runner the platform guild and channel of the ids a turn names', async () => {
  const { calls, recall } = recallThatRecords();
  const { client, guild, channel } = platform();
  const bridged = bridgeRecall(recall, client);
  await bridged.run({ guildId: 'g1', channel: { id: 'c1' }, question: 'q' });
  assert.equal(calls[0]?.args.guild, guild);
  assert.equal(calls[0]?.args.channel, channel);
  assert.equal(calls[0]?.args.question, 'q');
});

test('bridgeRecall resolves the partner of a private chat from the guild members', async () => {
  const { calls, recall } = recallThatRecords();
  const { client } = platform();
  await bridgeRecall(recall, client).window({ guildId: 'g1', channel: { id: 'c1' }, partner: { id: 'u9' } });
  assert.deepEqual(calls[0]?.args.partner, { id: 'u9', fetched: false });
});

test('bridgeRecall keeps the info it was given for a channel the platform does not know', async () => {
  const { calls, recall } = recallThatRecords();
  const { client } = platform();
  const info = { id: 'c404' };
  await bridgeRecall(recall, client).prefetch({ guildId: 'g1', channel: info });
  assert.equal(calls[0]?.args.channel, info);
});

test('bridgeRecall leaves the other methods of the runner alone and returns the runner itself without a client', async () => {
  const { calls, recall } = recallThatRecords();
  const { client } = platform();
  await bridgeRecall(recall, client).other({ guildId: 'g1', channel: { id: 'c1' } });
  assert.deepEqual(calls[0]?.args, { guildId: 'g1', channel: { id: 'c1' } });
  assert.equal(bridgeRecall(recall, undefined), recall);
});
