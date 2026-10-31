# The Discord interface

The package `@neptunia/interface-discord` connects the persona's core to one Discord server through discord.js 14. It is the only code of the engine that imports discord.js. [`interfaces/README.md`](../README.md) lists its modules, and [`docs/interfaces.md`](../../docs/interfaces.md) describes the protocol it speaks.

## Files

| File | What it is |
|---|---|
| `index.js` | The entry. It exports `start(host)`, which the core or the interface runner calls, and `createDiscordInterface`. |
| `config.json` | The package's own settings, laid between the core's `config.json` and `config.local.json` when the interface runs as a unit. It holds none yet: the Discord keys (`discord.intents`, `bot.guildId` and the rest) are in the core's `config.json`. |
| `setup.ts` | The setup of the interface. It refuses until the `neptunia` CLI brings `neptunia interface setup discord`. |
| `package.json` | The package and its one dependency. |

## Running it

With `interfaces.mode: inprocess`, `src/index.js` loads `index.js` and the core starts the interface in its own process with `DISCORD_TOKEN` from the private directory's `.env`.

With `interfaces.mode: units`, the unit `neptunia-interface@discord` runs `neptunia interface run discord` as the user `neptunia-discord-interface`. The interface reads `DISCORD_TOKEN` from the unit's environment file and its client token from `clients/discord.token` in the private directory. [`deploy/README.md`](../../deploy/README.md) gives the steps.

The Discord interface keeps no outbox and has no `reconnect()`. When its link to the core drops, the runner exits and the unit starts it again. The gateway events of that gap never reach the core: the offline catch-up (`features.offlineCatchUp`) reads history only when the core itself starts.
