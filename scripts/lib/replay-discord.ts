// The Discord side of the replay modes that read the platform: a REST-only connection with no gateway session, the
// channel and the chat up to a trigger, normalized as a live history is, and the refusal of every write.

import type { Untyped } from '../../src/tools/types.ts';
import { CliError } from './cli.ts';
import type { Rec } from './replay-types.ts';

/**
 * A REST-only Discord connection: no login, no gateway, no event handler.
 * Fetches the served guild (`bot.placeId`, else the only guild the bot is
 * in), its channels (so `#channel` mentions and categories resolve as in the
 * live cache), its custom emoji, the bot's own user and member. With
 * `everyGuild` it serves every guild the bot is in and resolves none, as the
 * core does for a turn that runs nowhere (`--inner`); `guild` is then the first.
 */
export async function connectDiscord({
  discord,
  token,
  configuredGuildId = '',
  resolveGuild = null,
  everyGuild = false,
  log,
}: Rec): Promise<{
  client: Untyped;
  guild: Untyped;
  guilds: Array<Untyped>;
  placeId: Untyped;
  self: { id: string; name: Untyped };
}> {
  const { Client, Routes } = discord;
  const client = new Client({ intents: [] });
  client.rest.setToken(token);
  try {
    const listed = await client.rest.get(Routes.userGuilds());
    const known = (Array.isArray(listed) ? listed : []).map((g) => ({ id: String(g.id), name: g.name }));
    let ids: Array<string>;
    if (everyGuild) {
      if (known.length === 0) throw new CliError('replay-cli: the bot is not in any server yet');
      ids = known.map((g) => g.id);
    } else {
      const resolved = resolveGuild(configuredGuildId, known);
      if (resolved.error) throw new CliError(`replay-cli: ${resolved.error}`);
      ids = [resolved.guildId];
    }
    const guilds: Array<Untyped> = [];
    let channelCount = 0;
    for (const id of ids) {
      const fetched = await client.guilds.fetch(id);
      channelCount += (await fetched.channels.fetch()).size;
      try {
        await fetched.emojis.fetch();
      } catch (err: Untyped) {
        log.warn('replay-cli: the custom emoji cannot be fetched', { errorName: err?.name, statusCode: err?.status });
      }
      guilds.push(fetched);
    }
    const guild = guilds[0];
    const placeId = guild.id;
    const me = await client.rest.get(Routes.user());
    try {
      client.user = new discord.ClientUser(client, me);
    } catch {
      // Only `guild.members.me` needs it; nothing here reads it.
    }
    // A reaction's emoji getter reads `client.application.emojis`; without a gateway login the application is null.
    try {
      if (!client.application) client.application = new discord.ClientApplication(client, { id: me.id });
    } catch (err: Untyped) {
      log.warn('replay-cli: the application object cannot be built', { errorName: err?.name });
    }
    let member = null;
    try {
      member = await guild.members.fetch(me.id);
    } catch (err: Untyped) {
      log.warn('replay-cli: the bot member cannot be fetched, using the user name', {
        errorName: err?.name,
        statusCode: err?.status,
      });
    }
    const self = { id: String(me.id), name: member?.displayName ?? me.username ?? 'bot' };
    log.info('replay-cli: discord over REST', {
      guilds: guilds.length,
      channels: channelCount,
      emoji: guilds.reduce((n, g) => n + (g.emojis.cache as Map<string, unknown>).size, 0),
      self: self.id,
    });
    return { client, guild, guilds, placeId, self };
  } catch (err) {
    await client.destroy().catch(() => {});
    throw err;
  }
}

/**
 * Discord over `client` with every write refused: the REST queue passes GET only, so a diary run reads the platform
 * and never posts, edits or types there.
 * @param given a discord.js client
 */
export function refuseDiscordWrites(given: unknown): void {
  // discord.js's client: its REST manager queues every request.
  const client = given as { rest: { queueRequest: (request: { method?: string }) => Promise<unknown> } };
  const { rest } = client;
  const queueRequest = rest.queueRequest.bind(rest);
  rest.queueRequest = (request) => {
    const method = String(request?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') return Promise.reject(new Error(`replay-cli: Discord ${method} refused (read-only tool)`));
    return queueRequest(request);
  };
}
