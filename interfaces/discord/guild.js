// A running instance of this engine serves exactly one Discord server: one
// bot account, one personality. This module resolves which single guild that
// is from `config.bot.guildId` and the list of guilds the client is actually
// in, without touching discord.js itself, so it is unit-tested directly with
// plain `{ id, name }` objects. The caller (src/index.js) turns an error into
// a startup failure and logs the "pin it in config.local.json" hint for the
// single-guild-with-no-config case.

/**
 * Resolve the single guild this instance should serve.
 * @param {string} configuredId  config.bot.guildId, possibly '' when unset
 * @param {{ id: string, name: string }[]} guilds  every guild the bot's client is currently in
 * @returns {{ guildId: string } | { error: string }}
 */
export function resolveGuild(configuredId, guilds) {
  const list = guilds ?? [];
  const describe = (guild) => `${guild.name} (${guild.id})`;

  if (configuredId) {
    const found = list.find((guild) => guild.id === configuredId);
    if (found) return { guildId: found.id };

    const known = list.length > 0 ? list.map(describe).join(', ') : '(the bot is in no guild at all)';
    return {
      error: `Configured bot.guildId ${configuredId} is not among the guilds this bot is in: ${known}.`,
    };
  }

  if (list.length === 1) return { guildId: list[0].id };

  if (list.length === 0) {
    return {
      error: 'bot.guildId is not set and the bot is not in any guild yet — invite it to your server first.',
    };
  }

  const known = list.map(describe).join(', ');
  return {
    error: `bot.guildId is not set and the bot is in multiple guilds: ${known}. Set bot.guildId in config.local.json.`,
  };
}
