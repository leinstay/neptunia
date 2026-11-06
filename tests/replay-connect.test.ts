// Tests for scripts/replay.ts `connectDiscord`: the REST-only connection every replay mode (the inner
// heartbeat among them) opens, resolving the served community through the Discord interface's `resolveGuild`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectDiscord } from '../scripts/replay.ts';
import { resolveGuild } from '../interfaces/discord/index.ts';
import type { Untyped } from '../src/tools/types.ts';

// Like discord.js, `guilds.fetch(id)` returns the guild and `guilds.fetch()` with no id returns the
// collection of every guild the bot is in, which has no `channels`.
function fakeDiscord(botGuilds: Array<{ id: string; name: string }>): Untyped {
  class Client {
    rest = {
      setToken() {},
      get: async (route: string) => (route === 'guilds' ? botGuilds : { id: 'bot-1', username: 'bot' }),
    };
    guilds = {
      fetch: async (id?: string) => {
        if (id === undefined) return new Map(botGuilds.map((g) => [g.id, g]));
        const found = botGuilds.find((g) => g.id === id);
        if (!found) throw new Error(`Unknown Guild ${id}`);
        return {
          id,
          channels: { fetch: async () => new Map() },
          emojis: { fetch: async () => new Map(), cache: new Map() },
          members: { fetch: async () => ({ displayName: 'Bot' }) },
        };
      },
    };
    async destroy() {}
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
    discord: fakeDiscord([{ id: '4242', name: 'Home' }]),
    token: 't',
    configuredGuildId: '',
    resolveGuild,
    log: quietLog,
  });
  assert.equal(connection.placeId, '4242');
  assert.equal(connection.guild.id, '4242');
});
