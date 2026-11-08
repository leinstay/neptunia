// Tests for scripts/replay.ts: the read-only store the message mode wraps around the real one, and the channel reads
// that look a chat up by its own id inside the served guild.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOnlyStore, readableChannel, readMoment } from '../scripts/replay.ts';
import { SANDBOX_STORE_READS } from '../src/behavior/sandbox.ts';
import { createStore } from '../src/memory/store.ts';
import { tempDir } from './fixtures/tmp.ts';

type Store = ReturnType<typeof createStore>;
type Reads = {
  placeOfRoot(id: string): string;
  placeOfChat(id: string): string;
  accountOf(id: string): string;
  personOfAccount(id: string): string;
  topPlaces(): Array<string>;
  setGifCaption(...args: Array<unknown>): unknown;
};

function stores() {
  const real: Store = createStore({ dataDir: tempDir('nep-replay-reads-') });
  const wrapped = readOnlyStore(real, SANDBOX_STORE_READS) as Reads;
  return { real: real as unknown as Reads, wrapped };
}

test('the read-only store answers the address reads as the real store does, instead of refusing them', () => {
  const { real, wrapped } = stores();
  assert.equal(wrapped.placeOfRoot('guild-7'), real.placeOfRoot('guild-7'));
  assert.equal(wrapped.placeOfChat('chan-9'), real.placeOfChat('chan-9'));
  assert.equal(wrapped.accountOf('user-3'), real.accountOf('user-3'));
  assert.equal(wrapped.personOfAccount('user-3'), real.personOfAccount('user-3'));
  assert.deepEqual(wrapped.topPlaces(), real.topPlaces());
});

test('the read-only store still refuses a write', () => {
  const { wrapped } = stores();
  assert.throws(() => wrapped.setGifCaption('gif-1', 'a cat'), /read-only here/);
});

function channelOf(id: string, guildId: string) {
  return { id, name: `name-${id}`, guild: { id: guildId }, messages: { fetch: () => Promise.resolve(new Map()) } };
}

function guildWith(id: string, channels: Array<ReturnType<typeof channelOf>>) {
  return { id, channels: { cache: new Map(channels.map((c) => [c.id, c])) } };
}

const noClient = { channels: { fetch: () => Promise.reject(new Error('Unknown Channel')) } };

test('readableChannel looks the channel up by the chat id, not the guild id', async () => {
  const chat = channelOf('chan-21', 'guild-5');
  const guild = guildWith('guild-5', [chat]);
  const found: unknown = await readableChannel({
    client: noClient,
    guild,
    placeId: 'guild-5',
    chatId: 'chan-21',
  });
  assert.equal(found, chat);
});

test('readableChannel refuses a channel of another guild', async () => {
  const foreign = channelOf('chan-22', 'guild-6');
  const client = { channels: { fetch: () => Promise.resolve(foreign) } };
  const guild = guildWith('guild-5', []);
  await assert.rejects(
    readableChannel({ client, guild, placeId: 'guild-5', chatId: 'chan-22' }),
    /not in the served guild/
  );
});

test('readMoment reads the chat of the chat it is handed, not of the guild', async () => {
  const chat = channelOf('chan-31', 'guild-8');
  const guild = guildWith('guild-8', [chat]);
  const fetched: Array<unknown> = [];
  await assert.rejects(
    readMoment({
      client: noClient,
      guild,
      placeId: 'guild-8',
      self: { id: 'bot-1' },
      chatId: 'chan-31',
      triggerId: 'msg-1',
      before: 5,
      config: {},
      fetchHistoryWindow: () => Promise.resolve([]),
      fetchMessage: (channel: unknown) => {
        fetched.push(channel);
        return Promise.resolve(null);
      },
      log: { info() {}, warn() {}, error() {} },
    }),
    /trigger message was not found/
  );
  assert.deepEqual(fetched, [chat]);
});
