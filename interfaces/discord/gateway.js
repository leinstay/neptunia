// The gateway connection of the Discord interface: the discord.js client the composition root
// (src/index.js) logs in, built here so nothing of the core imports discord.js, and `Events`, the
// names of the gateway events the root listens to. Settings are the caller's: which privileged
// intents the instance asked for (`discord.intents`).

import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';

export { Events };

/**
 * A discord.js client with the intents and partials the persona needs. Partials: an edit or a
 * deletion of an uncached message arrives partial, and is recorded or skipped as such.
 * @param {{ presences?: boolean, members?: boolean }} [intents]  The privileged intents asked for.
 */
export function createDiscordClient({ presences = false, members = false } = {}) {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildExpressions,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessageReactions,
      ...(presences ? [GatewayIntentBits.GuildPresences] : []),
      ...(members ? [GatewayIntentBits.GuildMembers] : []),
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
  });
}
