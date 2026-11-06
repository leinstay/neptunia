// Which Discord servers one bot account serves: the `servers` the owner listed in the interface config, `data/interfaces/discord/config.json`, or
// the one server of an older `bot.guildId` setting (read for compatibility), or the only server the bot is in. This module works on the list of guilds the
// client is actually in, without touching discord.js itself, so it is unit-tested directly with plain `{ id, name }`
// objects. The caller (interfaces/discord/session.ts) turns an error into a startup failure.

/**
 * Resolve the single guild this instance should serve.
 * @param configuredId config.bot.guildId, possibly '' when unset
 * @param guilds every guild the bot's client is currently in
 */
export function resolveGuild(
  configuredId: string,
  guilds: Array<{ id: string; name: string }>
): { guildId: string } | { error: string } {
  const list = guilds ?? [];
  const describe = (guild: { id: string; name: string }): string => `${guild.name} (${guild.id})`;

  if (configuredId) {
    const found = list.find((guild) => guild.id === configuredId);
    if (found) return { guildId: found.id };

    const known = list.length > 0 ? list.map(describe).join(', ') : '(the bot is in no server at all)';
    return {
      error: `The configured server ${configuredId} is not among the servers this bot is in: ${known}. Check \`servers\` in data/interfaces/discord/config.json.`,
    };
  }

  if (list.length === 1) return { guildId: list[0].id };

  if (list.length === 0) {
    return {
      error: 'No server is chosen and the bot is not in any server yet. Invite it to your server first.',
    };
  }

  const known = list.map(describe).join(', ');
  return {
    error: `No server is chosen and the bot is in several: ${known}. List the ones to serve under \`servers\` in data/interfaces/discord/config.json.`,
  };
}

/**
 * Every guild this bot serves: each listed server the bot is in. A listed server it is not in is reported, so an invite
 * still to come does not stop the others. With no list, the single guild of `resolveGuild`.
 */
export function resolveGuilds(
  servers: ReadonlyArray<string>,
  configuredId: string,
  guilds: Array<{ id: string; name: string }>
): { guildIds: Array<string>; missing: Array<string> } | { error: string } {
  if (servers.length === 0) {
    const one = resolveGuild(configuredId, guilds);
    return 'error' in one ? one : { guildIds: [one.guildId], missing: [] };
  }
  const known = new Set(guilds.map((guild) => guild.id));
  const guildIds = servers.filter((id) => known.has(id));
  if (guildIds.length === 0)
    return { error: `The bot is in none of the listed servers: ${servers.join(', ')}. Invite it first.` };
  return { guildIds, missing: servers.filter((id) => !known.has(id)) };
}
