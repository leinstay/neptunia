// Tests for scripts/replay.ts `connectDiscord`: the REST-only connection every replay mode (the inner
// heartbeat among them) opens, resolving the served root through the Discord interface's `resolveGuild`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectDiscord, refuseDiscordWrites } from '../../../scripts/lib/replay-discord.ts';
import { resolveGuild } from '../../../interfaces/discord/index.ts';
import type { Untyped } from '../../../src/tools/types.ts';

// Like discord.js, `guilds.fetch(id)` returns the guild and `guilds.fetch()` with no id returns the
// collection of every guild the bot is in, which has no `channels`.
function fakeDiscord(botGuilds: Array<{ id: string; name: string }>): unknown {
  class Client {
    rest = {
      setToken() {},
      get: (route: string) => Promise.resolve(route === 'guilds' ? botGuilds : { id: 'bot-1', username: 'bot' }),
    };
    guilds = {
      // The lead: plain promises instead of async bodies with no await, for the lint.
      fetch: (id?: string) => {
        if (id === undefined) return Promise.resolve(new Map(botGuilds.map((g) => [g.id, g])));
        const found = botGuilds.find((g) => g.id === id);
        if (!found) return Promise.reject(new Error(`Unknown Guild ${id}`));
        return Promise.resolve({
          id,
          channels: { fetch: () => Promise.resolve(new Map()) },
          emojis: { fetch: () => Promise.resolve(new Map()), cache: new Map() },
          members: { fetch: () => Promise.resolve({ displayName: 'Bot' }) },
        });
      },
    };
    destroy() {
      return Promise.resolve();
    }
  }
  class ClientUser {}
  class ClientApplication {}
  return {
    Client,
    ClientUser,
    ClientApplication,
    Routes: { userGuilds: () => 'guilds', user: () => 'user' },
  };
}

const quietLog = { info() {}, warn() {}, error() {} };

test('connectDiscord reaches the only guild the bot is in by its native id when none is configured', async () => {
  const connection = await connectDiscord({
    // The lead: the fake module is `unknown`, so no `any` is assigned, for the lint.
    discord: fakeDiscord([{ id: '4242', name: 'Home' }]),
    token: 't',
    configuredGuildId: '',
    resolveGuild,
    log: quietLog,
  });
  assert.equal(connection.placeId, '4242');
  const { guild } = connection as { guild: { id: string } };
  assert.equal(guild.id, '4242');
});

test('connectDiscord with every guild serves both servers when none is configured, with no error', async () => {
  // Bug: `--inner` resolved one server and stopped on a bot in two, though a heartbeat runs nowhere.
  const connection = await connectDiscord({
    discord: fakeDiscord([
      { id: '4242', name: 'Home' },
      { id: '4343', name: 'Other' },
    ]),
    token: 't',
    everyGuild: true,
    log: quietLog,
  });
  const { guilds } = connection as { guilds: Array<{ id: string }> };
  assert.deepEqual(
    guilds.map((guild) => guild.id),
    ['4242', '4343']
  );
});

test('refuseDiscordWrites: a GET passes to the REST queue and every write is refused, so a diary replay posts nothing', async () => {
  // PR 7d: the dry-run switch is gone from the engine, so this refusal is what keeps a diary replay from posting.
  const queued: Array<Untyped> = [];
  const client = {
    rest: { queueRequest: (request: Untyped) => Promise.resolve(queued.push(request.method ?? 'GET')) },
  };
  refuseDiscordWrites(client);
  await client.rest.queueRequest({ method: 'GET' });
  await client.rest.queueRequest({});
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
    await assert.rejects(client.rest.queueRequest({ method }), /refused \(read-only tool\)/);
  }
  assert.deepEqual(queued, ['GET', 'GET']);
});
