# The Discord interface

The package `@neptunia/interface-discord` connects the persona's core to one Discord server through discord.js 14. It is the only code of the engine that imports discord.js. [`interfaces/README.md`](../README.md) lists its modules, and [`docs/interfaces.md`](../../docs/interfaces.md) describes the protocol it speaks.

## Files

| File | What it is |
|---|---|
| `index.js` | The entry. It exports `start(host)`, which the core or the interface runner calls, and `createDiscordInterface`. |
| `config.json` | The package's own settings, laid between the core's `config/config.json` and the private `config.local/config.json` when the interface runs as a unit, with `config.local/interfaces/discord.json` last. It holds none yet: the Discord keys (`discord.intents`, `bot.guildId` and the rest) are in the core's `config/config.json`. |
| `setup.ts` | The setup of the interface. It refuses until the `neptunia` CLI brings `neptunia interface setup discord`. |
| `package.json` | The package and its one dependency. |

## Running it

With `interfaces.mode: inprocess`, `src/index.js` loads `index.js` and the core starts the interface in its own process with `DISCORD_TOKEN` from the private directory's `.env`.

With `interfaces.mode: units`, the unit `neptunia-interface@discord` runs `neptunia interface run discord` as the user `neptunia-discord-interface`. The interface reads `DISCORD_TOKEN` from the unit's environment file and its client token from `clients/discord.token` in the private directory. [`deploy/README.md`](../../deploy/README.md) gives the steps.

The interface keeps its events in an outbox under its data folder until the core acknowledges them, and it has `reconnect()`. When its link to the core drops, the runner opens a new one with backoff, and the outbox sends again what the core did not take, so a core restart loses no event the interface saw.

Under `interfaces.mode: units` the interface sends each `/nep` interaction to the core as a `command.requested` event and replies with the text of the answer. Its client needs the permission `commands` (`--permission commands` of `tools/client-token.mjs add`), or the core refuses the command. It registers the command tree itself when it opens.
