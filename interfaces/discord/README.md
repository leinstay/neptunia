# The Discord interface

The package `@neptunia/interface-discord` connects the persona's core to the Discord servers the bot is in, through discord.js 14. It is the only code of the engine that imports discord.js. [`interfaces/README.md`](../README.md) lists its modules, and [`docs/interfaces.md`](../../docs/interfaces.md) describes the protocol it speaks.

## Files

| File | What it is |
|---|---|
| `index.ts` | The entry. It exports `start(host)`, which the core or the interface runner calls, and `createDiscordInterface`. |
| `config.json` | The package's own settings, laid over the core's settings with `data/interfaces/discord/config.json` over both (`src/config/files.ts#readInterfaceConfig`): the privileged intents `discord.intents.presences` and `discord.intents.members` (default `false`), the longest URL a message text keeps, `context.maxUrlChars` (default `200`), the characters of an embed's title and text, `media.embedTextChars` (default `200`), and `discord.silent` (default `false`). With `discord.silent` on, a message notifies the channel like any other and pings only the people who chose `on` with `pings.set`. The port never adds the suppress-notifications flag (a voice message keeps its voice flag). The core hands the port `mentions.asked` (`src/turn/mentions.ts#mentionsUnderPings`): the named members whose own state is `on`, and whether the author a reply answers is `on`. The port pings exactly those. A member who chose nothing is not pinged, and a member with `off` never is. Content that carries `mentions.notify` and no `asked` (a stored mirror send) keeps its named users and reply ping, and any other content pings nobody. The reply reference and the mention text stay as written. With the switch off, every named member except those with `off` is pinged, and so is the replied author unless they have `off`. The key is read at each send, and edits are not covered. |
| `setup.json` | The setup contract: the secret `token`. |
| `package.json` | The package and its one dependency. |

## Servers

A server is a root of the engine, and only the owner can add the bot to one, so the session serves every server the bot is in: the ones it is in at its start, and each one it joins while it runs, with no restart. A server it joins or leaves is reported to the core as a `root.changed` event, and a server it leaves stops being served while her memory of it stays. An older settings file that still holds a `servers` list neither narrows the servers in `hello` nor stops the start. The server of the older `bot.guildId` setting, when the bot is in it, is the first root of `hello`. `/interfaces discord invite` prints the link that adds the bot to a server, built from the application id with the scope `bot` and the permissions the package needs, and `/interfaces discord list` lists the servers she serves. [Joining a root](../../docs/interfaces.md#joining-a-root) has the whole rule.

## Running it

The unit `neptunia-interface@discord` runs `neptunia interface run discord` as the user `neptunia-discord-interface`. The interface reads its token from `data/interfaces/discord/credentials.json` and its client token from `clients/discord.token` in the persona folder. [`deploy/README.md`](../../deploy/README.md) gives the steps.

The interface keeps its events in an outbox under its data folder until the core acknowledges them, and it has `reconnect()`. When its link to the core drops, the runner opens a new one with backoff, and the outbox sends again what the core did not take, so a core restart loses no event the interface saw.

The interface sends each `/nep` interaction to the core as a `command.requested` event and replies with the text of the answer. Its client needs the permission `commands` (`--permission commands` of `scripts/client-token.ts add`), or the core refuses the command. It registers the command tree itself when it opens.
