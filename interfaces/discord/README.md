# The Discord interface

The package `@neptunia/interface-discord` connects the persona's core to one Discord server through discord.js 14. It is the only code of the engine that imports discord.js. [`interfaces/README.md`](../README.md) lists its modules, and [`docs/interfaces.md`](../../docs/interfaces.md) describes the protocol it speaks.

## Files

| File | What it is |
|---|---|
| `index.ts` | The entry. It exports `start(host)`, which the core or the interface runner calls, and `createDiscordInterface`. |
| `config.json` | The package's own settings, laid over the core's settings with `data/interfaces/discord/config.json` over both (`src/config/files.ts#readInterfaceConfig`): the privileged intents `discord.intents.presences` and `discord.intents.members` (default `false`), the longest URL a message text keeps, `context.maxUrlChars` (default `200`), the characters of an embed's title and text, `media.embedTextChars` (default `200`), and `discord.silent` (default `false`). With `discord.silent` on, every message the port sends carries the suppress-notifications flag (beside the voice flag of a voice message) and never pings the author a reply answers, while the reply reference and the named users stay. A person's own ping state wins over the switch. The core sets `mentions.notify` when everyone a message concerns (the author it replies to and the members it names) chose `on` with `pings.set` (`src/turn/mentions.ts#mentionsUnderPings`), and the port sends such a message without the flag and with its reply ping. A member with `off` is never among the allowed users and never gets a reply ping, with the switch on or off. A member who chose nothing follows the switch. The key is read at each send, and edits are not covered. `bot.guildId` stays in the core's settings. |
| `setup.ts` | The setup of the interface. It refuses until the `neptunia` CLI brings `neptunia interfaces setup discord`. |
| `package.json` | The package and its one dependency. |

## Running it

With `interfaces.mode: inprocess`, `src/index.ts` loads `index.ts` and the core starts the interface in its own process with the token from `data/interfaces/discord/credentials.json`.

With `interfaces.mode: units`, the unit `neptunia-interface@discord` runs `neptunia interface run discord` as the user `neptunia-discord-interface`. The interface reads its token from `data/interfaces/discord/credentials.json` and its client token from `clients/discord.token` in the persona folder. [`deploy/README.md`](../../deploy/README.md) gives the steps.

The interface keeps its events in an outbox under its data folder until the core acknowledges them, and it has `reconnect()`. When its link to the core drops, the runner opens a new one with backoff, and the outbox sends again what the core did not take, so a core restart loses no event the interface saw.

Under `interfaces.mode: units` the interface sends each `/nep` interaction to the core as a `command.requested` event and replies with the text of the answer. Its client needs the permission `commands` (`--permission commands` of `scripts/client-token.ts add`), or the core refuses the command. It registers the command tree itself when it opens.
